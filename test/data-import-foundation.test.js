"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const C = require("../lib/data-import-contract");
const { createDataImportProtection } = require("../lib/data-import-protection");
const { createDataImportEngine } = require("../lib/data-import-engine");
const T = require('../lib/data-import-source-tolerance');
const { inspectTradeFotoImportInventory } = require("../lib/tradefoto-import-preflight");
const { createDataImportRepository } = require("../lib/persistence/repositories/data-import");
const { definePersistenceStatement } = require("../lib/persistence/contract");
const { SQLITE_DATA_IMPORT_CATALOG } = require("../lib/persistence/sqlite/data-import-catalog");
const { DATA_IMPORT_SCHEMA_SQL, ensureSqliteDataImportSchema } = require("../lib/persistence/sqlite/operations/data-import-schema");
const { compilePostgresqlDialectEntry } = require("../lib/persistence/postgresql/dialect-compiler");
const { DATA_IMPORT_STATEMENTS } = require("../lib/persistence/statements/data-import");

const HASH = "a".repeat(64);
const permissionError = code => error => error?.code === code;
function profileInput(overrides = {}) {
  return { id: "synthetic-import", version: 1, entity: "synthetic-item", sourceSystem: "synthetic-source", schemaSha256: HASH, sourceTable: "SyntheticRows",
    keyFields: ["Number"], excludedFields: ["Kennwort"], dataClasses: ["customer_restricted"],
    fields: [
      { source: "Number", target: "number", type: "identifier", nullable: false },
      { source: "Label", target: "label", type: "text", nullable: false },
      { source: "Amount", target: "amount", type: "decimal", scale: 4, nullable: false },
      { source: "Memo", target: null, type: "text", nullable: true },
    ], ...overrides };
}
function sourceRow(number = "000152", overrides = {}) { return { Number: number, Label: "Synthetischer Artikel", Amount: "12.5", Memo: null, Kennwort: "never-persist-this", ...overrides }; }
const targetColumns = { id: "text", revision: "safe_integer", data: "json" };
const TS = {
  read: definePersistenceStatement({ id: "import-fixture.read", operation: "queryOne", parameters: { id: "text" }, columns: targetColumns }),
  find: definePersistenceStatement({ id: "import-fixture.find", operation: "queryAll", parameters: { number: "text" }, columns: targetColumns }),
  create: definePersistenceStatement({ id: "import-fixture.create", operation: "execute", parameters: { id: "text", number: "text", data: "json" } }),
  update: definePersistenceStatement({ id: "import-fixture.update", operation: "execute", parameters: { id: "text", expectedRevision: "safe_integer", data: "json" } }),
  remove: definePersistenceStatement({ id: "import-fixture.remove", operation: "execute", parameters: { id: "text", expectedRevision: "safe_integer" } }),
  dependencies: definePersistenceStatement({ id: "import-fixture.dependencies", operation: "queryOne", parameters: { id: "text" }, columns: { count: "safe_integer" } }),
};
const TEST_CATALOG = [
  { statement: TS.read, sql: "SELECT id, revision, data FROM import_fixture WHERE id=$id", returning: false },
  { statement: TS.find, sql: "SELECT id, revision, data FROM import_fixture WHERE number=$number", returning: false },
  { statement: TS.create, sql: "INSERT INTO import_fixture(id,number,revision,data) VALUES($id,$number,1,$data)", returning: false },
  { statement: TS.update, sql: "UPDATE import_fixture SET data=$data, revision=revision+1 WHERE id=$id AND revision=$expectedRevision", returning: false },
  { statement: TS.remove, sql: "DELETE FROM import_fixture WHERE id=$id AND revision=$expectedRevision", returning: false },
  { statement: TS.dependencies, sql: "SELECT COUNT(*) AS count FROM import_fixture_dependencies WHERE target_id=$id", returning: false },
];

test('approved TradeFoto registry matches only its five exact snapshot proofs and exposes escaped evidence', () => {
  const { TRADEFOTO_SOURCE_TOLERANCES: proofs } = require('../lib/tradefoto-source-tolerances');
  const { definitions } = require('../lib/tradefoto-full-import-source');
  const registry = T.sourceToleranceRegistry(proofs);
  assert.equal(proofs.length, 5);
  for (const proof of proofs) {
    const definition = definitions('trade').find(t => t.name === proof.sourceTable);
    const p = definition.master ? definition.profile : require('../lib/tradefoto-history-profiles').profileFor('trade',proof.sourceTable,proof.profileHash);
    const raw = C.normalizeDataImportManifest({ sourceInstance: proof.sourceInstance, fileSha256: proof.fileSha256, schemaSha256: proof.schemaSha256,
      expectedRows: proof.expectedRows, declaredRows: proof.declaredRows, snapshotAt: proof.recordedAt, gates: [] }, p);
    assert.deepEqual(T.acceptSourceTolerances(raw, p, registry).acceptedDeviations, [proof]);
    if (definition.profile.fingerprint !== p.fingerprint)
      assert.deepEqual(T.acceptSourceTolerances(raw, definition.profile, registry), raw);
    assert.deepEqual(T.acceptSourceTolerances(raw, { ...p, fingerprint: 'd'.repeat(64) }, registry), raw);
    const html = require('../public/data-import').renderSource({ kind: 'trade', tables: [{ name: proof.sourceTable, declaredRows: proof.declaredRows,
      run: { counts: {}, acceptedDeviations: [{ ...proof, approvalReference: '<script>bad</script>' }] } }] });
    assert.match(html, /Bestätigte Quellzähler-Abweichung/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  }
});

function countProof(f, declaredRows, expectedRows, overrides = {}) {
  return T.defineDataImportSourceTolerance({id:'synthetic-late-count-approval',recordedAt:f.context.time,
    approvalReference:'synthetic-explicit-approval',reason:'Independent synthetic count verification',evidenceReference:'synthetic-count-evidence',
    sourceSystem:f.profile.sourceSystem,sourceTable:f.profile.sourceTable,profileHash:f.profile.fingerprint,
    sourceInstance:'synthetic-ledger',schemaSha256:f.profile.schemaSha256,fileSha256:HASH,declaredRows,expectedRows,...overrides});
}

test('count approval query is registered for qualified PostgreSQL Sales runtime without migration changes',()=>{
  const {CATALOG}=require('../lib/persistence/postgresql/sales/import-source-tolerance-catalog');
  assert.equal(CATALOG.length,1);assert.match(CATALOG[0].sql,/integration\s*\.\s*"?data_import_events/);
  assert.deepEqual(CATALOG[0].parameterOrder,['runId']);
});

test("Block 2: contract preserves string IDs, exact decimals, civil dates, nulls and source-only values", () => {
  const profile = C.defineDataImportProfile(profileInput());
  const row = C.normalizeDataImportRow(profile, sourceRow());
  assert.deepEqual(row.key, ["000152"]); assert.equal(row.data.amount, "12.5000"); assert.equal(row.source.Memo, null);
  assert.ok(!JSON.stringify(row).includes("Kennwort")); assert.ok(!Object.hasOwn(row.data, "Memo"));
  assert.throws(() => C.normalizeDataImportRow(profile, sourceRow("1", { Amount: 0.1 })), permissionError("IMPORT_DECIMAL_INVALID"));
  assert.throws(() => C.normalizeDataImportRow(profile, sourceRow("1", { Amount: "0.12345" })), permissionError("IMPORT_DECIMAL_PRECISION"));
  assert.throws(() => C.normalizeDataImportRow(profile, sourceRow("1", { Extra: "unknown" })), permissionError("IMPORT_SHAPE_INVALID"));
  assert.throws(() => C.defineDataImportProfile(profileInput({ fields: [{ source: "Kennwort", target: "pass", type: "text", nullable: false }] })), permissionError("IMPORT_CREDENTIAL_FIELD_EXCLUDED"));
  assert.throws(() => C.assertProfile(JSON.parse(JSON.stringify(profile))), permissionError("IMPORT_PROFILE_UNTRUSTED"));
  const dated = C.defineDataImportProfile(profileInput({ fields: [{ source: "Number", target: "date", type: "date", nullable: false }] }));
  assert.equal(C.normalizeDataImportRow(dated, { Number: "2026-09-05" }).data.date, "2026-09-05");
  assert.throws(() => C.normalizeDataImportRow(dated, { Number: "2026-02-30" }), permissionError("IMPORT_DATE_INVALID"));
});

test("Block 2: protected payload is context-bound and identities stay stable across encryption rotation", () => {
  const one = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 1), indexKey: Buffer.alloc(32, 3), keyId: "one" });
  const two = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 2), indexKey: Buffer.alloc(32, 3), keyId: "two" });
  const envelope = one.seal({ value: "Synthetic private text" }, ["row", 1]);
  assert.ok(!envelope.includes("Synthetic")); assert.deepEqual(one.open(envelope, ["row", 1]), { value: "Synthetic private text" });
  assert.throws(() => one.open(envelope, ["row", 2]), permissionError("IMPORT_PROTECTED_PAYLOAD_INVALID"));
  assert.throws(() => two.open(envelope, ["row", 1]), permissionError("IMPORT_PROTECTED_PAYLOAD_INVALID"));
  assert.equal(one.digest(["identity", "000001"]), two.digest(["identity", "000001"]));
  assert.notEqual(one.digest(["identity", "000001"]), one.digest(["identity", "1"]));
  one.destroy(); two.destroy(); assert.throws(() => one.digest("x"), permissionError("IMPORT_PROTECTION_UNAVAILABLE"));
});

test("Block 2: every named persistence statement compiles through the PostgreSQL dialect boundary", () => {
  assert.equal(SQLITE_DATA_IMPORT_CATALOG.length, Object.keys(DATA_IMPORT_STATEMENTS).length);
  for (const entry of SQLITE_DATA_IMPORT_CATALOG) {
    const compiled = compilePostgresqlDialectEntry(entry);
    assert.equal(compiled.strategy, "portable-generated", entry.statement.id + ": " + JSON.stringify(compiled.blockingFeatures));
    assert.ok(!/\$[a-z]/iu.test(compiled.compiledSql));
  }
  assert.doesNotMatch(DATA_IMPORT_SCHEMA_SQL, /AUTOINCREMENT|rowid|json_extract|GLOB|PRAGMA|COLLATE NOCASE/iu);
});

test("Block 2: current full inventory remains diagnostic-only; differences and manifest tampering block acceptance", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../test-support/access-db-import/catalog.json"), "utf8"));
  const result = inspectTradeFotoImportInventory(catalog);
  assert.equal(result.canImport, false); assert.equal(result.coverage.tables, 135); assert.equal(result.coverage.fields, 1363);
  assert.deepEqual(result.gates, ["BUSINESS_ADAPTERS_PENDING", "SOURCE_ROW_COUNT_MISMATCH"]);
  catalog.sources[0].tables[0].columns[0].name += "_drift"; catalog.coverage.fields--;
  assert.ok(inspectTradeFotoImportInventory(catalog).gates.includes("SOURCE_SCHEMA_FINGERPRINT_MISMATCH"));
  assert.ok(inspectTradeFotoImportInventory(catalog).gates.includes("SOURCE_COVERAGE_MISMATCH"));
});

test("Block 2: profile and encryption context reject unsafe field names and ambiguous key IDs", () => {
  for (const name of ["__proto__", "prototype", "constructor"]) assert.throws(() => C.defineDataImportProfile(profileInput({
    keyFields: [name], fields: [{ source: name, target: "label", type: "text", nullable: false }],
  })), permissionError("IMPORT_FIELD_INVALID"));
  assert.throws(() => createDataImportProtection({ encryptionKey: Buffer.alloc(32), indexKey: Buffer.alloc(32), keyId: "invalid:envelope" }), permissionError("IMPORT_PROTECTION_KEY_INVALID"));
});
