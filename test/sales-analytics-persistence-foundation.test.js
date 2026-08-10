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
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");

const root = path.resolve(__dirname, "..");
const contract = fs.readFileSync(
  path.join(root, "docs", "VERKAUFSANALYSEN-PERSISTENZ-REVISIONEN-v0.1.md"),
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

async function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_SALES_ANALYTICS_CATALOG,
  });
  application.database.exec(`
    CREATE TABLE locations (
      id TEXT PRIMARY KEY
    );
    INSERT INTO locations (id) VALUES ('location-01'), ('location-02');
  `);
  ensureSqliteSalesAnalyticsSchema(application.database);
  ensureSqliteSalesAnalyticsSchema(application.database);
  return {
    ...application,
    repository: createSalesAnalyticsPersistenceRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
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

test("Block 5: Profilrevisionen sind atomar, fingerprintgebunden und unveränderlich", async () => {
  const context = await fixture();
  try {
    const firstProfile = profileInput();
    const first = await context.repository.createProfile({
      profile: firstProfile,
      actor: "admin",
      timestamp: "2026-08-03T10:00:00.000Z",
    });
    assert.equal(first.profile.activeRevision, 1);
    assert.equal(first.revision.revision, 1);
    assert.equal(first.revision.profileSha256, salesImportProfileFingerprint(firstProfile));
    assert.equal(first.revision.profile.sourceFields.includes("Bonnr"), true);
    assert.equal(Object.hasOwn(first.revision.profile, "password"), false);

    const secondProfile = profileInput({
      name: "Synthetisches Belegprofil v2",
      branchMappings: { 1: "location-01", 99: "location-02" },
    });
    const second = await context.repository.appendProfileRevision({
      profile: secondProfile,
      expectedRevision: 1,
      actor: "admin",
      timestamp: "2026-08-03T10:05:00.000Z",
    });
    assert.equal(second.profile.activeRevision, 2);
    assert.equal(second.profile.name, "Synthetisches Belegprofil v2");
    assert.equal(second.revision.revision, 2);
    assert.notEqual(second.revision.profileSha256, first.revision.profileSha256);
    assert.deepEqual(
      (await context.repository.listProfileRevisions(firstProfile.id)).map(({ revision }) => revision),
      [2, 1],
    );
    assert.deepEqual(
      (await context.repository.getProfileRevision(firstProfile.id, 1)).profile.branchMappings,
      { 1: "location-01" },
    );

    await assert.rejects(
      context.repository.appendProfileRevision({
        profile: profileInput({ branchMappings: { 1: "location-02" } }),
        expectedRevision: 1,
        actor: "admin",
        timestamp: "2026-08-03T10:06:00.000Z",
      }),
      persistenceCode(PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION),
    );
    assert.equal((await context.repository.listProfileRevisions(firstProfile.id)).length, 2);

    assert.throws(
      () => context.database.prepare(`
        UPDATE sales_import_profile_revisions
        SET profile_sha256 = ?
        WHERE profile_id = ? AND revision = 1
      `).run("c".repeat(64), firstProfile.id),
      /immutable/,
    );

    await assert.rejects(
      context.repository.transaction(async (repository) => {
        await repository.createProfile({
          profile: profileInput({ id: "rolled-back-profile" }),
          actor: "admin",
          timestamp: "2026-08-03T10:07:00.000Z",
        });
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal(await context.repository.getProfile("rolled-back-profile"), null);
  } finally {
    await context.close();
  }
});

test("Block 5: echter Trockenlauf wird idempotent und datenminimiert gestaged", async () => {
  const context = await fixture();
  try {
    const profile = profileInput();
    await context.repository.createProfile({
      profile,
      actor: "admin",
      timestamp: "2026-08-03T10:00:00.000Z",
    });
    const preview = createSalesImportPreview({
      profile,
      source: sourceInput(profile.sourceSchemaSha256),
      rows: [
        receiptRow(),
        receiptRow({ Bonnr: "200", Filialid: "99" }),
        receiptRow({ Bonnr: "300", RechnungsBetrag: 2.5 }),
        receiptRow(),
      ],
    });
    const input = {
      preview,
      profileRevision: 1,
      actor: "admin",
      startedAt: "2026-08-03T10:01:00.000Z",
      completedAt: "2026-08-03T10:01:01.000Z",
      expiresAt: "2026-08-04T10:01:01.000Z",
    };
    const first = await context.repository.recordPreview(input);
    assert.equal(first.created, true);
    assert.equal(first.run.status, "needs_review");
    assert.deepEqual({
      total: first.run.totalCount,
      accepted: first.run.acceptedCount,
      needsReview: first.run.needsReviewCount,
      rejected: first.run.rejectedCount,
      duplicate: first.run.duplicateCount,
    }, preview.summary);
    assert.deepEqual(first.run.unresolvedDecisionIds, preview.unresolvedDecisionIds);

    const staging = await context.repository.listStagingRecords(first.run.id);
    assert.deepEqual(staging.map(({ status }) => status), [
      "accepted",
      "needs_review",
      "rejected",
      "duplicate",
    ]);
    assert.deepEqual(staging[2].canonicalData, {});
    assert.equal(staging[2].recordFingerprint, null);
    assert.deepEqual(staging[3].canonicalData, {});
    assert.equal(staging[3].recordFingerprint, null);
    assert.equal(JSON.stringify(staging).includes("2.5"), false);
    assert.equal(JSON.stringify(staging).includes("KUND_NR"), false);

    const repeated = await context.repository.recordPreview(input);
    assert.equal(repeated.created, false);
    assert.equal(repeated.run.id, first.run.id);
    assert.equal((await context.repository.listRuns()).length, 1);
    assert.equal((await context.repository.listStagingRecords(first.run.id)).length, 4);

    await assert.rejects(
      context.repository.recordPreview({
        ...input,
        preview: JSON.parse(JSON.stringify(preview)),
      }),
      persistenceCode(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID),
    );

    const secondProfile = profileInput({ branchMappings: { 1: "location-01", 99: "location-02" } });
    await context.repository.appendProfileRevision({
      profile: secondProfile,
      expectedRevision: 1,
      actor: "admin",
      timestamp: "2026-08-03T10:02:00.000Z",
    });
    await assert.rejects(
      context.repository.recordPreview({ ...input, profileRevision: 2 }),
      persistenceCode(PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION),
    );

    assert.equal(
      (await context.repository.purgeExpiredStaging("2026-08-04T10:01:00.000Z")).rowsAffected,
      0,
    );
    assert.equal(
      (await context.repository.purgeExpiredStaging("2026-08-04T10:01:01.000Z")).rowsAffected,
      4,
    );
    assert.deepEqual(await context.repository.listStagingRecords(first.run.id), []);
    assert.equal((await context.repository.getRun(first.run.id)).id, first.run.id);
    assert.throws(
      () => context.database.prepare("UPDATE sales_import_runs SET status = status WHERE id = ?").run(first.run.id),
      /immutable/,
    );
    assert.throws(
      () => context.database.prepare("DELETE FROM sales_import_runs WHERE id = ?").run(first.run.id),
      /immutable/,
    );
  } finally {
    await context.close();
  }
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

test("Block 5: Sonderfilialen besitzen append-only Revisionen statt stiller Zuordnung", async () => {
  const context = await fixture();
  try {
    const first = await context.repository.appendBranchMappingRevision({
      sourceSystem: "trade_photo",
      externalBranchId: "0",
      locationId: "location-01",
      status: "approved",
      validFrom: "2026-01-01",
      validTo: null,
      evidenceId: "branch-review-001",
      expectedRevision: null,
      actor: "admin",
      timestamp: "2026-08-03T11:00:00.000Z",
    });
    assert.equal(first.revision, 1);
    assert.equal(first.locationId, "location-01");
    assert.match(first.mappingSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual((await context.repository.listActiveBranchMappings("trade_photo"))
      .map(({ externalBranchId }) => externalBranchId), ["0"]);

    const rejected = await context.repository.appendBranchMappingRevision({
      sourceSystem: "trade_photo",
      externalBranchId: "0",
      locationId: null,
      status: "rejected",
      validFrom: "2026-01-01",
      validTo: null,
      evidenceId: "branch-review-002",
      expectedRevision: 1,
      actor: "admin",
      timestamp: "2026-08-03T11:05:00.000Z",
    });
    assert.equal(rejected.revision, 2);
    assert.equal(rejected.locationId, null);
    assert.deepEqual(await context.repository.listActiveBranchMappings("trade_photo"), []);

    const approvedAgain = await context.repository.appendBranchMappingRevision({
      sourceSystem: "trade_photo",
      externalBranchId: "0",
      locationId: "location-02",
      status: "approved",
      validFrom: "2026-07-01",
      validTo: null,
      evidenceId: "branch-review-003",
      expectedRevision: 2,
      actor: "admin",
      timestamp: "2026-08-03T11:10:00.000Z",
    });
    assert.equal(approvedAgain.revision, 3);
    assert.equal((await context.repository.listActiveBranchMappings("trade_photo"))[0].locationId, "location-02");
    assert.deepEqual(
      (await context.repository.listBranchMappingRevisions("trade_photo", "0"))
        .map(({ revision, status }) => ({ revision, status })),
      [
        { revision: 3, status: "approved" },
        { revision: 2, status: "rejected" },
        { revision: 1, status: "approved" },
      ],
    );

    await assert.rejects(
      context.repository.appendBranchMappingRevision({
        sourceSystem: "trade_photo",
        externalBranchId: "0",
        locationId: "location-01",
        status: "approved",
        validFrom: "2026-08-01",
        validTo: null,
        evidenceId: "branch-review-stale",
        expectedRevision: 2,
        actor: "admin",
        timestamp: "2026-08-03T11:11:00.000Z",
      }),
      persistenceCode(PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION),
    );
    assert.equal((await context.repository.listBranchMappingRevisions("trade_photo", "0")).length, 3);

    await assert.rejects(
      context.repository.appendBranchMappingRevision({
        sourceSystem: "trade_photo",
        externalBranchId: "99",
        locationId: "missing-location",
        status: "approved",
        validFrom: "2026-01-01",
        validTo: null,
        evidenceId: "branch-review-invalid",
        expectedRevision: null,
        actor: "admin",
        timestamp: "2026-08-03T11:12:00.000Z",
      }),
      persistenceCode(PERSISTENCE_ERROR_CODES.FOREIGN_KEY_VIOLATION),
    );
    assert.equal(context.database.prepare(`
      SELECT 1 FROM sales_branch_mapping_heads
      WHERE source_system = 'trade_photo' AND external_branch_id = '99'
    `).get(), undefined);

    assert.throws(
      () => context.database.prepare(`
        UPDATE sales_branch_mapping_revisions
        SET evidence_id = evidence_id
        WHERE source_system = 'trade_photo' AND external_branch_id = '0' AND revision = 1
      `).run(),
      /immutable/,
    );
  } finally {
    await context.close();
  }
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

test("Block-5-Dokument trennt Prüfpersistenz, Produktaktivierung und Echtdaten", () => {
  assert.match(contract, /^# Verkaufsanalysen · Persistenz- und Revisionsfundament v0\.1/m);
  assert.match(contract, /\| Block \| 5 · Persistenz und Revisionen \|/);
  assert.match(contract, /nicht aktivierter Dual-Provider-Entwicklungsslice/);
  assert.match(contract, /weder in den SQLite-Anwendungsstart noch in den vollständigen Anwendungskatalog/);
  assert.match(contract, /Noch nicht angelegt werden produktive Beleg-, Positions-, Artikel-, Bestands-/);
  assert.match(contract, /Für `rejected` und `duplicate`/);
  assert.match(contract, /`applicationExecutable: false`/);
  assert.match(contract, /21\/21 Providerstatements, 16\/16 PostgreSQL-DDL-Schritte/);
  assert.match(contract, /geschlossener Freigabe 0\/950/);
  assert.match(contract, /kein Importverwaltungsrecht und keinen Serverendpunkt/);
  assert.match(contract, /keine Echtdaten verarbeitet, keine Quelldatei geöffnet/);
});
