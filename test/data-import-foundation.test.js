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
const { openSqliteApplicationPersistence } = require("../lib/persistence/sqlite/provider");
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
async function fixture(t, { databasePath = ":memory:", withWriter = true, profile = C.defineDataImportProfile(profileInput()), failOnNumber = null } = {}) {
  const application = openSqliteApplicationPersistence({ databasePath, catalog: [...SQLITE_DATA_IMPORT_CATALOG, ...TEST_CATALOG] });
  ensureSqliteDataImportSchema(application.database); ensureSqliteDataImportSchema(application.database);
  application.database.exec("CREATE TABLE IF NOT EXISTS import_fixture (id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS import_fixture_dependencies (target_id TEXT NOT NULL REFERENCES import_fixture(id));");
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 7), indexKey: Buffer.alloc(32, 9), keyId: "test-key" });
  const context = { who: { scopeId: "test-scope", ownerId: "test-owner" }, denied: new Set(), time: "2026-09-05T10:00:00.000Z" };
  const read = (tx, id) => tx.queryOne(TS.read, { id });
  const update = async (tx, parameters) => {
    assert.equal((await tx.execute(TS.update, parameters)).rowsAffected, 1); return read(tx, parameters.id);
  };
  const writer = {
    read, findExisting: (tx, record) => tx.queryAll(TS.find, { number: record.data.number }),
    async create(tx, { id, data }) {
      await tx.execute(TS.create, { id, number: data.number, data });
      if (data.number === failOnNumber) throw new Error("Injected synthetic transaction failure");
      return read(tx, id);
    },
    update, restore: update,
    async canRestore(tx, current) { return (await tx.queryOne(TS.dependencies, { id: current.id })).count === 0; },
    async canRemove(tx, id) { return (await tx.queryOne(TS.dependencies, { id })).count === 0; },
    async remove(tx, parameters) { return (await tx.execute(TS.remove, parameters)).rowsAffected === 1; },
  };
  const repository = createDataImportRepository(application.provider);
  const composition = { repository, protection, profiles: [profile], writers: withWriter ? { [profile.entity]: writer } : {}, getActor: () => context.who,
    authorize: ({ action }) => !context.denied.has(action), clock: () => context.time };
  const engine = createDataImportEngine(composition);
  let closed = false;
  async function close() { if (closed) return; closed = true; protection.destroy(); await application.provider.close(); application.database.close(); }
  t.after(close);
  const manifest = (count, extra = {}) => ({ sourceInstance: "synthetic-ledger", fileSha256: HASH, schemaSha256: profile.schemaSha256, expectedRows: count, declaredRows: count, snapshotAt: context.time, gates: [], ...extra });
  async function start(rows, extra = {}) { return engine.start({ profileHash: profile.fingerprint, manifest: manifest(rows.length, extra) }); }
  async function ready(rows, extra = {}) {
    let run = await start(rows, extra);
    for (let start = 0; start < rows.length; start += C.LIMITS.batch) run = await engine.stage(run.id, { expectedRevision: run.revision, startRow: start + 1, rows: rows.slice(start, start + C.LIMITS.batch) });
    run = await engine.seal(run.id, run.revision);
    do { run = await engine.review(run.id, run.revision); } while (run.status === "reviewing");
    return run;
  }
  const targets = () => application.database.prepare("SELECT id, number, revision, data FROM import_fixture ORDER BY number").all().map(row => ({ ...row, data: JSON.parse(row.data) }));
  return { ...application, engine, composition, profile, context, repository, protection, writer, start, ready, manifest, targets, close };
}

test('Q01: trusted exact snapshot tolerance preserves evidence, idempotence, restart, revocation and undo', async t => {
  const f = await fixture(t), manifest = f.manifest(1, { declaredRows: 2 });
  const input = { id: 'synthetic-count-approval', recordedAt: f.context.time, approvalReference: 'synthetic-user-approval', reason: 'Synthetic test, no source correction',
    evidenceReference: 'synthetic-evidence', sourceSystem: f.profile.sourceSystem, sourceTable: f.profile.sourceTable, profileHash: f.profile.fingerprint,
    sourceInstance: manifest.sourceInstance, schemaSha256: manifest.schemaSha256, fileSha256: manifest.fileSha256, declaredRows: 2, expectedRows: 1 };
  const proof = T.defineDataImportSourceTolerance(input), config = { ...f.composition, sourceTolerances: [proof] };
  assert.throws(() => createDataImportEngine({ ...config, sourceTolerances: [{ ...proof }] }), permissionError('IMPORT_TOLERANCE_UNTRUSTED'));
  const engine = createDataImportEngine(config), request = { profileHash: f.profile.fingerprint, manifest };
  await assert.rejects(engine.start({ ...request, manifest: { ...manifest, acceptedDeviations: [proof] } }), permissionError('IMPORT_SHAPE_INVALID'));
  let run = await engine.start(request);
  assert.equal(run.revision, 2); assert.deepEqual(run.gates, []); assert.deepEqual(run.originalGates, ['SOURCE_ROW_COUNT_MISMATCH']);
  assert.deepEqual(run.acceptedDeviations, [proof]); assert.equal(run.declaredRows, 2); assert.equal(run.expectedRows, 1);
  assert.deepEqual(await engine.start(request), run);
  assert.equal((await engine.events(run.id)).filter(e => e.action === 'import.source-tolerance.accepted').length, 1);
  const strict = await f.engine.start(request);
  assert.notEqual(strict.id, run.id);
  const resumedStrict = await engine.start({ ...request, existingRunId: strict.id });
  assert.deepEqual(resumedStrict.gates, ['SOURCE_ROW_COUNT_MISMATCH']); assert.equal(resumedStrict.acceptedDeviations, undefined);
  await assert.rejects(engine.start({ ...request, manifest: { ...manifest, expectedRows: 0 }, existingRunId: run.id }), permissionError('IMPORT_RUN_INTEGRITY'));
  for (const change of [{ fileSha256: 'b'.repeat(64) }, { expectedRows: 0 }, { declaredRows: 3 }, { sourceInstance: 'other' }, { schemaSha256: 'c'.repeat(64) }]) {
    const blocked = await engine.start({ ...request, manifest: { ...manifest, ...change } });
    assert.ok(blocked.gates.includes('SOURCE_ROW_COUNT_MISMATCH')); assert.equal(blocked.acceptedDeviations, undefined);
  }
  const otherGate = await engine.start({ ...request, manifest: { ...manifest, gates: ['OTHER_DECISION_REQUIRED'] } });
  assert.deepEqual(otherGate.gates, ['OTHER_DECISION_REQUIRED']);
  run = await engine.stage(run.id, { expectedRevision: run.revision, startRow: 1, rows: [sourceRow()] });
  run = await engine.seal(run.id, run.revision); run = await engine.review(run.id, run.revision);
  assert.equal(run.canApply, true);
  const revoked = await f.engine.preview(run.id);
  assert.deepEqual(revoked.acceptedDeviations, [proof]); assert.equal(revoked.canApply, false); assert.ok(revoked.gates.includes('SOURCE_TOLERANCE_UNAVAILABLE'));
  await assert.rejects(f.engine.apply(run.id, run.revision), permissionError('IMPORT_DECISION_GATE'));
  const restarted = createDataImportEngine(config);
  assert.equal((await restarted.start({ ...request, existingRunId: run.id })).id, run.id);
  run = await restarted.apply(run.id, run.revision); assert.deepEqual(run.counts, { applied: 1 });
  assert.equal(f.targets().length, 1);
  run = await f.engine.undo(run.id, run.revision); assert.equal(f.targets().length, 0);
  assert.deepEqual(run.acceptedDeviations, [proof]);
  const stored = JSON.parse(f.database.prepare('SELECT manifest FROM data_import_runs WHERE id=?').get(run.id).manifest);
  stored.acceptedDeviations[0].reason = 'Changed after approval';
  f.database.prepare('UPDATE data_import_runs SET manifest=? WHERE id=?').run(JSON.stringify(stored), run.id);
  await assert.rejects(engine.checkpoint(run.id), permissionError('IMPORT_RUN_INTEGRITY'));
});

test('Q01: approved TradeFoto registry matches only two exact profiles and exposes escaped evidence', () => {
  const { TRADEFOTO_SOURCE_TOLERANCES: proofs } = require('../lib/tradefoto-source-tolerances');
  const { definitions } = require('../lib/tradefoto-full-import-source');
  const registry = T.sourceToleranceRegistry(proofs);
  assert.equal(proofs.length, 2);
  for (const proof of proofs) {
    const p = definitions('trade').find(t => t.name === proof.sourceTable).profile;
    const raw = C.normalizeDataImportManifest({ sourceInstance: proof.sourceInstance, fileSha256: proof.fileSha256, schemaSha256: proof.schemaSha256,
      expectedRows: proof.expectedRows, declaredRows: proof.declaredRows, snapshotAt: proof.recordedAt, gates: [] }, p);
    assert.deepEqual(T.acceptSourceTolerances(raw, p, registry).acceptedDeviations, [proof]);
    assert.deepEqual(T.acceptSourceTolerances(raw, { ...p, fingerprint: 'd'.repeat(64) }, registry), raw);
    const html = require('../public/data-import').renderSource({ kind: 'trade', tables: [{ name: proof.sourceTable, declaredRows: proof.declaredRows,
      run: { counts: {}, acceptedDeviations: [{ ...proof, approvalReference: '<script>bad</script>' }] } }] });
    assert.match(html, /Bestätigte Quellzähler-Abweichung/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  }
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

test("Block 2: persistent staging, lost-response retry, duplicates, preview privacy and transactional apply", async t => {
  const f = await fixture(t), rows = [sourceRow(), sourceRow()];
  let run = await f.start(rows), start = { expectedRevision: run.revision, startRow: 1, rows };
  assert.deepEqual(await f.start(rows), run);
  run = await f.engine.stage(run.id, start);
  assert.deepEqual(await f.engine.stage(run.id, start), run);
  assert.equal(run.counts.duplicate, 1); assert.equal(f.targets().length, 0);
  const protectedRows = f.database.prepare("SELECT payload FROM data_import_rows").all();
  assert.ok(!JSON.stringify(protectedRows).includes("Synthetischer")); assert.ok(!JSON.stringify(protectedRows).includes("never-persist"));
  const preview = await f.engine.preview(run.id); assert.ok(!JSON.stringify(preview).includes("000152"));
  assert.equal((await f.engine.detail(run.id, 1)).source.Label, rows[0].Label);
  run = await f.engine.seal(run.id, run.revision); run = await f.engine.review(run.id, run.revision);
  assert.equal(run.status, "ready"); assert.equal(run.canApply, true);
  run = await f.engine.apply(run.id, run.revision); assert.equal(run.status, "applied"); assert.equal(f.targets().length, 1);
  assert.equal(f.targets()[0].data.amount, "12.5000");
  assert.deepEqual((await f.engine.events(run.id)).map(event => event.action), ["import.start", "import.stage", "import.seal", "import.review", "import.apply"]);
});

test("Block 2: unknown columns reject a batch; conflicting duplicate keys quarantine every occurrence", async t => {
  const f = await fixture(t); let run = await f.start([sourceRow(), sourceRow()]);
  await assert.rejects(f.engine.stage(run.id, { expectedRevision: run.revision, startRow: 1, rows: [sourceRow(), { ...sourceRow(), Unmapped: "value" }] }), permissionError("IMPORT_SHAPE_INVALID"));
  assert.equal((await f.engine.preview(run.id)).receivedRows, 0);
  run = await f.engine.stage(run.id, { expectedRevision: run.revision, startRow: 1, rows: [sourceRow()] });
  run = await f.engine.stage(run.id, { expectedRevision: run.revision, startRow: 2, rows: [sourceRow("000152", { Label: "Other value" })] });
  assert.equal(run.counts.conflict, 2);
  run = await f.engine.seal(run.id, run.revision); run = await f.engine.review(run.id, run.revision);
  assert.equal(run.status, "needs_review"); await assert.rejects(f.engine.apply(run.id, run.revision), permissionError("IMPORT_STATE_CONFLICT"));
});

test("Block 2: invalid field remains encrypted in review and missing source rows cannot be sealed", async t => {
  const f = await fixture(t); let run = await f.start([sourceRow(), sourceRow()]);
  run = await f.engine.stage(run.id, { expectedRevision: run.revision, startRow: 1, rows: [sourceRow("1", { Amount: "not-a-price" })] });
  assert.equal(run.counts.invalid, 1);
  assert.equal((await f.engine.detail(run.id, 1)).source.Amount, "not-a-price");
  await assert.rejects(f.engine.seal(run.id, run.revision), permissionError("IMPORT_SOURCE_INCOMPLETE"));
  await assert.rejects(f.engine.stage(run.id, { expectedRevision: run.revision, startRow: 3, rows: [sourceRow()] }), permissionError("IMPORT_BATCH_SEQUENCE"));
});

for (const [name, extra] of [["metadata row mismatch", { declaredRows: 2 }], ["schema mismatch", { schemaSha256: "b".repeat(64) }], ["open business decision", { gates: ["STORNO_UNRESOLVED"] }]]) {
  test(`Block 2: ${name} blocks apply`, async t => {
    const f = await fixture(t), run = await f.ready([sourceRow()], extra);
    assert.equal(run.status, "needs_review"); assert.ok(run.gates.length); assert.equal(run.canApply, false);
    await assert.rejects(f.engine.apply(run.id, run.revision)); assert.equal(f.targets().length, 0);
  });
}

test("Block 2: unavailable domain writer blocks import and the existing application is not activated", async t => {
  const f = await fixture(t, { withWriter: false }), run = await f.ready([sourceRow()]);
  assert.equal(run.status, "needs_review"); assert.equal((await f.engine.preview(run.id)).rows[0].issue, "TARGET_ADAPTER_PENDING");
  for (const file of ["../server.js", "../lib/persistence/sqlite/operations/application-schema.js"]) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, file), "utf8"), /createDataImportEngine|ensureSqliteDataImportSchema/u);
});

test("Block 2: account/scope isolation, separate detail permission, revoked write permission and revision guard", async t => {
  const f = await fixture(t); let run = await f.ready([sourceRow()]);
  f.context.denied.add("read_sensitive"); await assert.rejects(f.engine.detail(run.id, 1), permissionError("IMPORT_FORBIDDEN"));
  assert.equal((await f.engine.preview(run.id)).status, "ready");
  f.context.who = { ...f.context.who, ownerId: "different-account" }; await assert.rejects(f.engine.preview(run.id), permissionError("IMPORT_RUN_NOT_FOUND"));
  f.context.who = { scopeId: "different-scope", ownerId: "test-owner" }; await assert.rejects(f.engine.preview(run.id), permissionError("IMPORT_RUN_NOT_FOUND"));
  f.context.who = { scopeId: "test-scope", ownerId: "test-owner" }; f.context.denied.add("apply");
  await assert.rejects(f.engine.apply(run.id, run.revision), permissionError("IMPORT_FORBIDDEN"));
  f.context.denied.delete("apply"); await assert.rejects(f.engine.apply(run.id, run.revision - 1), permissionError("IMPORT_REVISION_CONFLICT"));
  assert.equal(f.targets().length, 0);
});

test("Block 2: write failure rolls back the entire batch, source links, audit and checkpoint", async t => {
  const f = await fixture(t, { failOnNumber: "bad" }); let run = await f.ready([sourceRow("good"), sourceRow("bad")]);
  await assert.rejects(f.engine.apply(run.id, run.revision), permissionError("IMPORT_OPERATION_FAILED"));
  assert.equal(f.targets().length, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM data_import_links").get().n, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM data_import_changes").get().n, 0);
  assert.equal((await f.engine.preview(run.id)).revision, run.revision);
  assert.equal((await f.engine.events(run.id)).at(-1).action, "import.review");
});

test("Block 2: repeated sources do not duplicate targets; three-way comparison preserves manual fields", async t => {
  const f = await fixture(t); let first = await f.ready([sourceRow()]); first = await f.engine.apply(first.id, first.revision);
  let target = f.targets()[0];
  await f.provider.execute(TS.update, { id: target.id, expectedRevision: target.revision, data: { ...target.data, label: "Manual label" } });
  let next = await f.ready([sourceRow("000152", { Amount: "18" })], { fileSha256: "b".repeat(64) });
  assert.equal(next.counts.update, 1); next = await f.engine.apply(next.id, next.revision);
  assert.equal(f.targets().length, 1); assert.equal(f.targets()[0].data.label, "Manual label"); assert.equal(f.targets()[0].data.amount, "18.0000");
  const repeat = await f.ready([sourceRow("000152", { Amount: "18" })], { fileSha256: "c".repeat(64) });
  assert.equal(repeat.counts.unchanged, 1);
  const conflict = await f.ready([sourceRow("000152", { Amount: "18", Label: "Changed in source too" })], { fileSha256: "d".repeat(64) });
  assert.equal(conflict.status, "needs_review"); assert.equal((await f.engine.preview(conflict.id)).rows[0].issue, "MANUAL_FIELD_CONFLICT");
});

test("Block 2: target changed after preview blocks apply without silently replanning", async t => {
  const f = await fixture(t); let first = await f.ready([sourceRow()]); await f.engine.apply(first.id, first.revision);
  let next = await f.ready([sourceRow("000152", { Amount: "99" })], { fileSha256: "b".repeat(64) });
  const target = f.targets()[0]; await f.provider.execute(TS.update, { id: target.id, expectedRevision: target.revision, data: { ...target.data, label: "After preview" } });
  await assert.rejects(f.engine.apply(next.id, next.revision), permissionError("IMPORT_TARGET_CHANGED"));
  assert.equal(f.targets()[0].data.amount, "12.5000");
});

test("Block 2: existing natural key requires explicit linking, not a second customer/article", async t => {
  const f = await fixture(t);
  await f.provider.execute(TS.create, { id: "already-present", number: "000152", data: { number: "000152", label: "Existing", amount: "1.0000" } });
  const run = await f.ready([sourceRow()]); assert.equal(run.status, "needs_review"); assert.equal((await f.engine.preview(run.id)).rows[0].issue, "UNLINKED_TARGET_EXISTS");
  assert.equal(f.targets().length, 1);
});

test("Block 2: controlled undo restores monotonic revisions, then permits undo of the preceding import", async t => {
  const f = await fixture(t); let first = await f.ready([sourceRow()]); first = await f.engine.apply(first.id, first.revision);
  let second = await f.ready([sourceRow("000152", { Amount: "22" })], { fileSha256: "b".repeat(64) }); second = await f.engine.apply(second.id, second.revision);
  await assert.rejects(f.engine.undo(first.id, first.revision), permissionError("IMPORT_UNDO_LATER_IMPORT"));
  second = await f.engine.undo(second.id, second.revision);
  assert.equal(second.status, "reverted"); assert.equal(f.targets()[0].revision, 3); assert.equal(f.targets()[0].data.amount, "12.5000");
  first = await f.engine.undo(first.id, first.revision); assert.equal(first.status, "reverted"); assert.equal(f.targets().length, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM data_import_links").get().n, 0);
});

test("Block 2: undo blocks manual changes and referenced targets, including an atomic multi-row rollback", async t => {
  const f = await fixture(t); let run = await f.ready([sourceRow("a"), sourceRow("b")]); run = await f.engine.apply(run.id, run.revision);
  let target = f.targets()[0];
  f.database.prepare("INSERT INTO import_fixture_dependencies(target_id) VALUES (?)").run(target.id);
  await assert.rejects(f.engine.undo(run.id, run.revision), permissionError("IMPORT_UNDO_DEPENDENCIES"));
  assert.equal(f.targets().length, 2); assert.equal((await f.engine.preview(run.id)).revision, run.revision);
  f.database.prepare("DELETE FROM import_fixture_dependencies WHERE target_id=?").run(target.id);
  await f.provider.execute(TS.update, { id: target.id, expectedRevision: target.revision, data: { ...target.data, label: "manual" } });
  await assert.rejects(f.engine.undo(run.id, run.revision), permissionError("IMPORT_UNDO_MANUAL_CHANGE")); assert.equal(f.targets().length, 2);
});

test("Import evidence: cancellation and expiry never authorize payload deletion", async t => {
  const f = await fixture(t); let run = await f.ready([sourceRow()]);
  const original = f.database.prepare("SELECT payload FROM data_import_rows").get().payload;
  run = await f.engine.cancel(run.id, run.revision);
  await assert.rejects(f.engine.purge(run.id, run.revision), permissionError("IMPORT_PURGE_DISABLED"));
  assert.equal((await f.engine.checkpoint(run.id)).status, "cancelled");
  assert.equal(f.database.prepare("SELECT payload FROM data_import_rows").get().payload, original);
  assert.equal((await f.engine.events(run.id)).at(-1).action, "import.cancel");
  await assert.rejects(f.engine.detail(run.id, 1), permissionError("IMPORT_STATE_CONFLICT"));
  let expired = await f.ready([sourceRow()], { fileSha256: "b".repeat(64) }); f.context.time = "2026-11-01T00:00:00.000Z";
  assert.equal((await f.engine.preview(expired.id)).canApply, false);
  await assert.rejects(f.engine.apply(expired.id, expired.revision), permissionError("IMPORT_RUN_EXPIRED"));
  await assert.rejects(f.engine.detail(expired.id, 1), permissionError("IMPORT_RUN_EXPIRED"));
});

test("Block 2: restart resumes sealed review/apply/undo across bounded transactions without duplicate data", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-import-foundation-"));
  const databasePath = path.join(directory, "synthetic.sqlite");
  t.after(() => { for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(databasePath + suffix)) fs.unlinkSync(databasePath + suffix); fs.rmdirSync(directory); });
  const first = await fixture(t, { databasePath });
  const rows = Array.from({ length: 205 }, (_, i) => sourceRow(String(i).padStart(6, "0")));
  let run = await first.ready(rows); run = await first.engine.apply(run.id, run.revision); assert.equal(run.status, "applying");
  assert.equal(first.targets().length, 200); await first.close();
  const second = await fixture(t, { databasePath });
  run = await second.engine.apply(run.id, run.revision); assert.equal(run.status, "applied"); assert.equal(second.targets().length, 205);
  run = await second.engine.undo(run.id, run.revision); assert.equal(run.status, "reverting"); assert.equal(second.targets().length, 5);
  run = await second.engine.undo(run.id, run.revision); assert.equal(run.status, "reverted"); assert.equal(second.targets().length, 0); await second.close();
});

test("Block 2: staging tampering and cross-row ciphertext swaps fail closed", async t => {
  const f = await fixture(t); let run = await f.start([sourceRow("a"), sourceRow("b")]);
  run = await f.engine.stage(run.id, { expectedRevision: run.revision, startRow: 1, rows: [sourceRow("a"), sourceRow("b")] });
  const rows = f.database.prepare("SELECT row_number,payload FROM data_import_rows ORDER BY row_number").all();
  f.database.prepare("UPDATE data_import_rows SET payload=? WHERE row_number=2").run(rows[0].payload);
  await assert.rejects(f.engine.detail(run.id, 2), permissionError("IMPORT_PROTECTED_PAYLOAD_INVALID"));
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
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../docs/tradefoto-gesamtimport-v0.1/catalog.json"), "utf8"));
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

test("Block 2: cryptographic record identity detects tampered row metadata before any target write", async t => {
  const f = await fixture(t); let run = await f.ready([sourceRow()]);
  f.database.prepare("UPDATE data_import_rows SET identity_hash=? WHERE run_id=?").run("e".repeat(64), run.id);
  await assert.rejects(f.engine.apply(run.id, run.revision), permissionError("IMPORT_ROW_INTEGRITY"));
  assert.equal(f.targets().length, 0);
});

test("Block 2: undo preview is read-only and catches dependencies for updates as well as deletes", async t => {
  const f = await fixture(t); let first = await f.ready([sourceRow()]); first = await f.engine.apply(first.id, first.revision);
  let second = await f.ready([sourceRow("000152", { Amount: "25" })], { fileSha256: "b".repeat(64) }); second = await f.engine.apply(second.id, second.revision);
  const before = f.targets(); let preview = await f.engine.undoPreview(second.id);
  assert.equal(preview.rows[0].canUndo, true); assert.equal(preview.revision, second.revision); assert.deepEqual(f.targets(), before);
  f.database.prepare("INSERT INTO import_fixture_dependencies(target_id) VALUES (?)").run(before[0].id);
  preview = await f.engine.undoPreview(second.id); assert.equal(preview.rows[0].canUndo, false); assert.equal(preview.rows[0].issue, "IMPORT_UNDO_DEPENDENCIES");
  await assert.rejects(f.engine.undo(second.id, second.revision), permissionError("IMPORT_UNDO_DEPENDENCIES"));
  assert.deepEqual(f.targets(), before); assert.equal((await f.engine.events(second.id)).at(-1).action, "import.apply");
});

test("Block 2: metadata-only source refresh can be undone without rewriting the target", async t => {
  const f = await fixture(t); let first = await f.ready([sourceRow()]); first = await f.engine.apply(first.id, first.revision);
  const original = f.targets();
  let next = await f.ready([sourceRow("000152", { Memo: "Synthetic source-only detail" })], { fileSha256: "b".repeat(64) });
  assert.equal(next.counts.refresh, 1); next = await f.engine.apply(next.id, next.revision); assert.deepEqual(f.targets(), original);
  next = await f.engine.undo(next.id, next.revision); assert.deepEqual(f.targets(), original);
  first = await f.engine.undo(first.id, first.revision); assert.equal(f.targets().length, 0);
});

test("Import evidence: applied rows and undo evidence survive expiry byte-identically", async t => {
  const f = await fixture(t); let run = await f.ready([sourceRow()]); run = await f.engine.apply(run.id, run.revision);
  const before = Object.fromEntries(["data_import_rows", "data_import_changes", "data_import_links"].map(table => [table, f.database.prepare(`SELECT * FROM ${table}`).all()]));
  const events = await f.engine.events(run.id);
  await assert.rejects(f.engine.purge(run.id, run.revision), permissionError("IMPORT_PURGE_DISABLED"));
  f.context.time = "2026-11-01T00:00:00.000Z";
  await assert.rejects(f.engine.purge(run.id, run.revision), permissionError("IMPORT_PURGE_DISABLED"));
  assert.equal((await f.engine.checkpoint(run.id)).status, "applied"); assert.equal(f.targets().length, 1);
  for (const [table, rows] of Object.entries(before)) assert.deepEqual(f.database.prepare(`SELECT * FROM ${table}`).all(), rows);
  assert.deepEqual(await f.engine.events(run.id), events);
});

test("Block 2: retry rejects altered payload and an explicit new attempt can follow cancellation", async t => {
  const f = await fixture(t); let run = await f.start([sourceRow()]);
  const stage = { expectedRevision: run.revision, startRow: 1, rows: [sourceRow()] }; run = await f.engine.stage(run.id, stage);
  await assert.rejects(f.engine.stage(run.id, { ...stage, rows: [sourceRow("different")] }), permissionError("IMPORT_REPLAY_CONFLICT"));
  run = await f.engine.cancel(run.id, run.revision);
  const next = await f.engine.start({ profileHash: f.profile.fingerprint, manifest: f.manifest(1), attemptId: "explicit-new-attempt" });
  assert.notEqual(next.id, run.id); assert.equal(next.receivedRows, 0);
});

test("Block 2: a competing importer changes the source-link revision and invalidates an older preview", async t => {
  const f = await fixture(t); let first = await f.ready([sourceRow()]); await f.engine.apply(first.id, first.revision);
  let pending = await f.ready([sourceRow("000152", { Amount: "21" })], { fileSha256: "b".repeat(64) });
  let competing = await f.ready([sourceRow("000152", { Amount: "22" })], { fileSha256: "c".repeat(64) });
  await f.engine.apply(competing.id, competing.revision);
  await assert.rejects(f.engine.apply(pending.id, pending.revision), permissionError("IMPORT_SOURCE_LINK_CHANGED"));
  assert.equal(f.targets()[0].data.amount, "22.0000");
});

test("Block 2: interrupted apply can be undone without applying the rest of its run", async t => {
  const f = await fixture(t); const rows = Array.from({ length: 203 }, (_, i) => sourceRow(String(i)));
  let run = await f.ready(rows); run = await f.engine.apply(run.id, run.revision); assert.equal(run.status, "applying");
  run = await f.engine.undo(run.id, run.revision); assert.equal(run.status, "reverted"); assert.equal(f.targets().length, 0);
  await assert.rejects(f.engine.apply(run.id, run.revision), permissionError("IMPORT_STATE_CONFLICT"));
});

test("Block 2: schema constraints reject broken run state and orphan staging rows", async t => {
  const f = await fixture(t); const run = await f.start([sourceRow()]);
  assert.throws(() => f.database.prepare("UPDATE data_import_runs SET status='unreviewed-apply' WHERE id=?").run(run.id));
  assert.throws(() => f.database.prepare("UPDATE data_import_runs SET revision=0 WHERE id=?").run(run.id));
  assert.throws(() => f.database.prepare("INSERT INTO data_import_rows(run_id,row_number,identity_hash,content_hash,state,issue,payload) VALUES('missing',1,NULL,?,'staged','','')").run(HASH));
});

test("Block 2: source-run list is account-filtered and keyset-paginated even for equal timestamps", async t => {
  const f = await fixture(t);
  const second = await f.start([], { fileSha256: "b".repeat(64) });
  const first = await f.start([]); assert.notEqual(first.id, second.id);
  const one = await f.engine.list({ limit: 1 }); assert.equal(one.items.length, 1);
  const two = await f.engine.list({ ...one.next, limit: 1 }); assert.equal(two.items.length, 1); assert.notEqual(one.items[0].id, two.items[0].id);
  assert.deepEqual((await f.engine.list({ ...two.next, limit: 1 })).items, []);
  f.context.who = { scopeId: "test-scope", ownerId: "other-owner" }; assert.deepEqual((await f.engine.list()).items, []);
});

test("Block 2: preview capability follows current permissions and whole-profile read revocation", async t => {
  const f = await fixture(t); const run = await f.ready([sourceRow()]);
  f.context.denied.add("apply"); assert.equal((await f.engine.preview(run.id)).canApply, false);
  f.context.denied.add("read"); await assert.rejects(f.engine.preview(run.id), permissionError("IMPORT_FORBIDDEN"));
  assert.deepEqual((await f.engine.list()).items, []);
});

test('Productive Block 1: dependency recheck never clears conflicting source keys or invalid fields',async t=>{
  const f=await fixture(t);let run=await f.ready([sourceRow('1'),sourceRow('1',{Label:'different'}),sourceRow('2',{Amount:'invalid'})]);
  assert.equal(run.status,'needs_review');assert.equal(run.counts.conflict,2);assert.equal(run.counts.invalid,1);
  run=await f.engine.recheck(run.id,run.revision);run=await f.engine.review(run.id,run.revision);
  assert.equal(run.status,'needs_review');assert.equal(run.counts.conflict,2);assert.equal(run.counts.invalid,1);
  assert.ok((await f.engine.preview(run.id)).rows.filter(row=>row.state==='conflict').every(row=>row.issue==='SOURCE_KEY_CONFLICT'));
  assert.equal(f.targets().length,0);
});

test("Block 2: stored source-manifest mutation cannot clear an import gate", async t => {
  const f = await fixture(t); const run = await f.ready([sourceRow()], { gates: ["SOURCE_REVIEW_REQUIRED"] });
  const stored = f.database.prepare("SELECT manifest FROM data_import_runs WHERE id=?").get(run.id);
  const altered = JSON.parse(stored.manifest); altered.gates = [];
  f.database.prepare("UPDATE data_import_runs SET manifest=?,status='ready' WHERE id=?").run(JSON.stringify(altered), run.id);
  await assert.rejects(f.engine.apply(run.id, run.revision), permissionError("IMPORT_RUN_INTEGRITY"));
  assert.equal(f.targets().length, 0);
});

test('Block 3 performance: pending apply uses an ordered partial index, independent of the completed prefix', async t => {
  const f = await fixture(t);
  const index = f.database.prepare("SELECT sql FROM sqlite_master WHERE name='idx_data_import_rows_pending_apply'").get();
  assert.match(index.sql, /WHERE state IN \('create','update','refresh'\)/);
  const statement = require('../lib/persistence/sqlite/data-import-catalog').SQLITE_DATA_IMPORT_CATALOG.find(e => e.statement.id === DATA_IMPORT_STATEMENTS.pendingApply.id);
  for (const limit of [1, 200]) {
    const plan = f.database.prepare('EXPLAIN QUERY PLAN ' + statement.sql).all({ runId: HASH, limit });
    assert.ok(plan.some(p => /idx_data_import_rows_pending_apply/.test(p.detail)), JSON.stringify(plan));
    assert.ok(plan.every(p => !/TEMP B-TREE|sqlite_autoindex_data_import_rows_1/.test(p.detail)));
  }
});

test("Block 2: corrupt ready state cannot bypass an incomplete or invalid preview", async t => {
  const f = await fixture(t); let run = await f.start([sourceRow()]);
  run = await f.engine.stage(run.id, { expectedRevision: run.revision, startRow: 1, rows: [sourceRow()] });
  f.database.prepare("UPDATE data_import_runs SET status='ready' WHERE id=?").run(run.id);
  await assert.rejects(f.engine.apply(run.id, run.revision), permissionError("IMPORT_PREVIEW_INCOMPLETE"));
  assert.equal(f.targets().length, 0);
});
