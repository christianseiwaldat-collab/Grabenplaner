"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  SALES_IMPORT_CONTRACT_VERSION,
  createSalesImportPreview,
  salesImportProfileFingerprint,
  salesSourceSchemaSha256,
} = require("../lib/sales-analytics-import");
const {
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/contract");
const {
  createSalesAnalyticsPersistenceRepository,
} = require("../lib/persistence/repositories/sales-analytics");
const {
  createPostgresqlSalesAnalyticsPersistenceSlice,
} = require("../lib/persistence/postgresql/sales-analytics-catalog");
const {
  createPostgresqlSalesAnalyticsSchemaContract,
} = require("../lib/persistence/postgresql/sales-analytics-schema");
const {
  createPostgresqlPersistenceProvider,
} = require("../lib/persistence/postgresql/provider");
const {
  SALES_ANALYTICS_PERSISTENCE_STATEMENTS,
} = require("../lib/persistence/statements/sales-analytics");
const {
  SQLITE_APPLICATION_CATALOG,
  createSqliteApplicationCatalog,
} = require("../lib/persistence/sqlite/application-catalog");
const {
  SQLITE_SALES_ANALYTICS_CATALOG,
} = require("../lib/persistence/sqlite/sales-analytics-catalog");
const {
  ensureSqliteSalesAnalyticsSchema,
} = require("../lib/persistence/sqlite/operations/sales-analytics-schema");

const root = path.resolve(__dirname, "..");
const contract = fs.readFileSync(
  path.join(root, "SERVERBETRIEB.md"),
  "utf8",
);
const applicationSchemaSource = fs.readFileSync(
  path.join(root, "lib", "persistence", "sqlite", "operations", "application-schema.js"),
  "utf8",
);
const applicationRepositoriesSource = fs.readFileSync(
  path.join(root, "lib", "persistence", "application-repositories.js"),
  "utf8",
);

function receiptMapping() {
  return {
    sourceKey: {
      sources: ["Bonnr", "Filialid", "Kassenid", "Bondatum"],
      transform: "sha256_key",
    },
    locationId: { sources: ["Filialid"], transform: "branch_map" },
    registerId: { sources: ["Kassenid"], transform: "identifier_text" },
    saleDate: { sources: ["Bondatum"], transform: "date_dmy" },
    saleTime: { sources: ["Bonzeit"], transform: "time_hms" },
    sourceHeaderAmount: { sources: ["RechnungsBetrag"], transform: "decimal4_de" },
  };
}

function profileInput({
  id = "receipt-profile-v1",
  name = "Synthetisches Belegprofil",
  branchMappings = { 1: "location-01" },
  resolvedDecisions = [],
} = {}) {
  const mapping = receiptMapping();
  const sourceFields = [...new Set(Object.values(mapping).flatMap((entry) => entry.sources))];
  return {
    contractVersion: SALES_IMPORT_CONTRACT_VERSION,
    id,
    name,
    entityId: "sales_receipt",
    sourceSchemaSha256: salesSourceSchemaSha256(sourceFields),
    mapping,
    branchMappings,
    resolvedDecisions,
  };
}

function sourceInput(sourceSchemaSha256, content = "b") {
  return {
    adapterId: "structured_rows",
    contentSha256: content.repeat(64),
    sourceSchemaSha256,
    snapshotAt: "2026-08-03T10:00:00.000Z",
    timeZone: "Europe/Vienna",
  };
}

function receiptRow(overrides = {}) {
  return {
    Bonnr: "100",
    Filialid: "1",
    Kassenid: "01",
    Bondatum: "02.01.2020",
    Bonzeit: "09:05",
    RechnungsBetrag: "",
    ...overrides,
  };
}

function persistenceCode(code) {
  return (error) => error?.code === code;
}


test("Block 5: Sales-Persistenz bleibt ein vollständiger, aber nicht aktivierter Teilslice", () => {
  const statements = Object.values(SALES_ANALYTICS_PERSISTENCE_STATEMENTS);
  assert.equal(statements.length, 29);
  assert.equal(SQLITE_SALES_ANALYTICS_CATALOG.length, statements.length);
  assert.equal(new Set(statements.map(({ id }) => id)).size, statements.length);
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_SALES_ANALYTICS_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
  assert.equal(createSqliteApplicationCatalog(SQLITE_SALES_ANALYTICS_CATALOG).length, 29);
  assert.equal(
    SQLITE_APPLICATION_CATALOG.some(({ statement }) => statement.id.startsWith("sales-analytics.")),
    true,
  );
  assert.match(applicationSchemaSource, /ensureSqliteSalesAnalyticsSchema/);
  assert.match(applicationRepositoriesSource, /createSalesAnalyticsPersistenceRepository/);
});

test("Block 5: Profilfingerprint trennt semantisch unterschiedliche Vorschau-Läufe", () => {
  const firstProfile = profileInput();
  const secondProfile = profileInput({ branchMappings: { 1: "location-01", 99: "location-02" } });
  const rows = [receiptRow()];
  const first = createSalesImportPreview({
    profile: firstProfile,
    source: sourceInput(firstProfile.sourceSchemaSha256),
    rows,
  });
  const second = createSalesImportPreview({
    profile: secondProfile,
    source: sourceInput(secondProfile.sourceSchemaSha256),
    rows,
  });
  assert.notEqual(first.profile.fingerprintSha256, second.profile.fingerprintSha256);
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);
});


test("Block 5: PostgreSQL-Schema und Statements sind reproduzierbar, qualifiziert und inaktiv", async () => {
  const first = createPostgresqlSalesAnalyticsPersistenceSlice({
    schemaName: "gp_sales_contract",
  });
  const second = createPostgresqlSalesAnalyticsPersistenceSlice({
    schemaName: "gp_sales_contract",
  });
  assert.equal(first.sliceId, "sales-analytics-persistence");
  assert.equal(first.status, "development-contract");
  assert.equal(first.executable, true);
  assert.equal(first.applicationExecutable, false);
  assert.equal(first.fullApplicationCatalog, false);
  assert.equal(first.productActivation, false);
  assert.equal(first.entries.length, 29);
  assert.equal(first.provenance.length, 29);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.provenance, second.provenance);
  assert.equal(first.entries.every(({ sql }) => sql.includes('"gp_sales_contract".')), true);
  assert.equal(first.entries.some(({ sql }) => /\$[A-Za-z_]/.test(sql)), false);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.entries), true);
  assert.equal(Object.isFrozen(first.entries[0]), true);

  const provider = createPostgresqlPersistenceProvider({
    pool: {
      connect() {
        throw new Error("not-used");
      },
      async end() {},
    },
    catalog: first.entries,
  });
  await provider.close();

  const schema = createPostgresqlSalesAnalyticsSchemaContract({
    schemaName: "gp_sales_contract",
  });
  const schemaAgain = createPostgresqlSalesAnalyticsSchemaContract({
    schemaName: "gp_sales_contract",
  });
  assert.equal(schema.status, "development-contract");
  assert.equal(schema.executable, true);
  assert.equal(schema.applicationExecutable, false);
  assert.equal(schema.productActivation, false);
  assert.equal(schema.contractVersion, 3);
  assert.equal(schema.statements.length, 24);
  assert.equal(schema.fingerprint, schemaAgain.fingerprint);
  assert.equal(Object.isFrozen(schema.statements), true);
  const ddl = schema.statements.map(({ sql }) => sql).join("\n");
  assert.match(ddl, /JSONB/);
  assert.match(ddl, /TIMESTAMPTZ/);
  assert.match(ddl, /sales_reject_immutable_mutation/);
  assert.match(ddl, /local_ocr_coordinates/);
  assert.match(ddl, /ocr_human_confirmed/);
  assert.match(ddl, /"gp_sales_contract"\."locations"/);
  assert.doesNotMatch(ddl, /CREATE SCHEMA/i);

  for (const invalid of ["", "Public", "has-dash", "public;drop", "a".repeat(64)]) {
    assert.throws(
      () => createPostgresqlSalesAnalyticsPersistenceSlice({ schemaName: invalid }),
      TypeError,
    );
    assert.throws(
      () => createPostgresqlSalesAnalyticsSchemaContract({ schemaName: invalid }),
      TypeError,
    );
  }
});

test("Betriebsdokumentation verhindert unkontrollierte Provideraktivierung und Testdatenübernahme", () => {
  assert.match(contract, /Eine alleinige Änderung von `DB_PROVIDER` aktiviert keine Migration/);
  assert.match(contract, /Das Live-System darf niemals mit einer Testkopie oder Testdatenbank aktiviert werden/);
  assert.match(contract, /Produktive Daten, Schlüssel und Sicherungen sind kein austauschbarer Teil des App-Pakets/);
});
