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
async function fixture(t, { databasePath = ":memory:", withWriter = true, profile = C.defineDataImportProfile(profileInput()), failOnNumber = null, allowPartialApply = false } = {}) {
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
  const composition = { repository, protection, profiles: [profile], writers: withWriter ? { [profile.entity]: writer } : {}, allowPartialApply, getActor: () => context.who,
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

test('Small import transactions retain every checkpoint and resume to the identical result', async t => {
 const f=await fixture(t),engine=createDataImportEngine({...f.composition,operationBatchSize:2,operationBudgetMs:1000});
 const rows=Array.from({length:7},(_,i)=>sourceRow(String(i+1)));
 let run=await engine.start({profileHash:f.profile.fingerprint,manifest:f.manifest(rows.length)});
 run=await engine.stage(run.id,{expectedRevision:run.revision,startRow:1,rows});run=await engine.seal(run.id,run.revision);
 run=await engine.review(run.id,run.revision);assert.equal(run.status,'reviewing');
 do{run=await engine.review(run.id,run.revision);}while(run.status==='reviewing');
 run=await engine.apply(run.id,run.revision);assert.equal(f.targets().length,2);assert.equal(run.status,'applying');
 const resumed=createDataImportEngine({...f.composition,operationBatchSize:2,operationBudgetMs:1});
 do{run=await resumed.apply(run.id,run.revision);}while(run.status==='applying');
 assert.equal(f.targets().length,7);
 do{run=await resumed.undo(run.id,run.revision);}while(run.status==='reverting');
 assert.deepEqual(f.targets(),[]);
});

test('adaptive review packets retain authenticated plans and resume after engine reconstruction',async t=>{
 const f=await fixture(t),{createReviewBatchPolicy}=require('../lib/data-import-review-batching');
 const options={...f.composition,operationBudgetMs:750,reviewBatchPolicy:createReviewBatchPolicy()};
 let engine=createDataImportEngine(options),run=await engine.start({profileHash:f.profile.fingerprint,manifest:f.manifest(35)});
 run=await engine.stage(run.id,{expectedRevision:run.revision,startRow:1,rows:Array.from({length:35},(_,i)=>sourceRow(String(i+1)))});
 run=await engine.seal(run.id,run.revision);run=await engine.review(run.id,run.revision);
 assert.equal(run.counts.create,16);assert.equal(run.counts.staged,19);
 engine=createDataImportEngine({...options,reviewBatchPolicy:createReviewBatchPolicy()});
 f.context.denied.add('review');await assert.rejects(engine.review(run.id,run.revision),permissionError('IMPORT_FORBIDDEN'));f.context.denied.clear();
 do{run=await engine.review(run.id,run.revision);}while(run.status==='reviewing');
 assert.equal(run.counts.create,35);do{run=await engine.apply(run.id,run.revision);}while(run.status==='applying');assert.equal(run.status,'applied');assert.equal(f.targets().length,35);
 run=await engine.undo(run.id,run.revision);assert.equal(run.status,'reverted');assert.deepEqual(f.targets(),[]);
});

test('adaptive apply feedback is not accepted after a rolled-back writer failure',async t=>{
 const f=await fixture(t,{failOnNumber:'2'}),{createReviewBatchPolicy}=require('../lib/data-import-review-batching');
 const policy=createReviewBatchPolicy(),observed=[];
 const engine=createDataImportEngine({...f.composition,operationBudgetMs:750,reviewBatchPolicy:{limit:key=>policy.limit(key),observe(key,data){observed.push(key);policy.observe(key,data);}}});
 let run=await engine.start({profileHash:f.profile.fingerprint,manifest:f.manifest(3)});
 run=await engine.stage(run.id,{expectedRevision:run.revision,startRow:1,rows:['1','2','3'].map(number=>sourceRow(number))});
 run=await engine.seal(run.id,run.revision);run=await engine.review(run.id,run.revision);
 assert.equal(observed.length,1);
 await assert.rejects(engine.apply(run.id,run.revision));
 assert.equal(observed.length,1);assert.equal(policy.limit('apply:'+f.profile.fingerprint),16);
 assert.deepEqual(f.targets(),[]);assert.equal((await engine.checkpoint(run.id)).revision,run.revision);
});

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
for (const declaredRows of [0,2]) test(`late count approval (${declaredRows} declared, 1 read) preserves immutable identity, audit, restart and revocation`,async t=>{
  const f=await fixture(t);let run=await f.ready([sourceRow()],{declaredRows});
  const id=run.id,before=f.database.prepare('SELECT manifest FROM data_import_runs WHERE id=?').get(id).manifest;
  const proof=countProof(f,declaredRows,1),config={...f.composition,sourceTolerances:[proof]};
  let engine=createDataImportEngine(config),view=await engine.preview(id);
  assert.deepEqual(view.gates,['SOURCE_ROW_COUNT_MISMATCH']);assert.deepEqual(view.availableSourceTolerances,[proof]);
  await assert.rejects(engine.apply(id,view.revision),permissionError('IMPORT_STATE_CONFLICT'));
  for(const permission of ['apply','review']) {
    f.context.denied.add(permission);await assert.rejects(engine.acceptSourceTolerance(id,view.revision),permissionError('IMPORT_FORBIDDEN'));
    f.context.denied.delete(permission);
  }
  await assert.rejects(engine.acceptSourceTolerance(id,view.revision+1),permissionError('IMPORT_REVISION_CONFLICT'));
  run=await engine.acceptSourceTolerance(id,view.revision);
  assert.equal(run.id,id);assert.deepEqual(run.gates,[]);assert.deepEqual(run.acceptedDeviations,[proof]);
  assert.deepEqual(run.sourceToleranceReceipts,[{fingerprint:proof.fingerprint,recordedAt:f.context.time,actorId:f.context.who.ownerId,revision:run.revision}]);
  assert.equal(f.database.prepare('SELECT manifest FROM data_import_runs WHERE id=?').get(id).manifest,before);
  const revision=run.revision;
  run=await engine.acceptSourceTolerance(id,revision);assert.equal(run.revision,revision);
  assert.equal((await engine.events(id)).filter(e=>e.action===T.SOURCE_TOLERANCE_EVENT_PREFIX+proof.fingerprint).length,1);
  engine=createDataImportEngine(config);assert.deepEqual((await engine.preview(id)).sourceToleranceReceipts,run.sourceToleranceReceipts);
  run=await engine.recheck(id,run.revision);run=await engine.review(id,run.revision);assert.equal(run.status,'ready');
  const revoked=await f.engine.preview(id);assert.ok(revoked.gates.includes('SOURCE_TOLERANCE_UNAVAILABLE'));assert.equal(revoked.canApply,false);
  await assert.rejects(f.engine.apply(id,run.revision),permissionError('IMPORT_DECISION_GATE'));
  const replacement=countProof(f,declaredRows,1,{reason:'Changed proof is not the recorded approval'});
  const changed=createDataImportEngine({...config,sourceTolerances:[replacement]});
  assert.ok((await changed.preview(id)).gates.includes('SOURCE_TOLERANCE_UNAVAILABLE'));
  run=await engine.apply(id,run.revision);assert.equal(f.targets().length,1);
  run=await f.engine.undo(id,run.revision);assert.equal(f.targets().length,0);
  assert.equal(f.database.prepare('SELECT manifest FROM data_import_runs WHERE id=?').get(id).manifest,before);
});

test('count approval requires exact evidence and never approves equal counts, source errors or other gates',async t=>{
  const f=await fixture(t);assert.throws(()=>countProof(f,1,1),permissionError('IMPORT_TOLERANCE_INVALID'));
  let run=await f.ready([sourceRow()],{declaredRows:2,gates:['OTHER_DECISION_REQUIRED']});
  for(const change of [{fileSha256:'b'.repeat(64)},{schemaSha256:'b'.repeat(64)},{profileHash:'b'.repeat(64)},
    {sourceInstance:'other'},{sourceTable:'Other'},{declaredRows:3},{expectedRows:0}]) {
    const engine=createDataImportEngine({...f.composition,sourceTolerances:[countProof(f,2,1,change)]});
    await assert.rejects(engine.acceptSourceTolerance(run.id,run.revision),permissionError('IMPORT_TOLERANCE_UNAVAILABLE'));
  }
  const engine=createDataImportEngine({...f.composition,sourceTolerances:[countProof(f,2,1)]});
  run=await engine.acceptSourceTolerance(run.id,run.revision);assert.deepEqual(run.gates,['OTHER_DECISION_REQUIRED']);assert.equal(f.targets().length,0);
  for(const rows of [[sourceRow('1',{Amount:'not-decimal'})],[sourceRow('2'),sourceRow('2',{Label:'Different'})]]) {
    const g=await fixture(t),proof=countProof(g,rows.length+1,rows.length),e=createDataImportEngine({...g.composition,sourceTolerances:[proof]});
    let blocked=await g.ready(rows,{declaredRows:rows.length+1});blocked=await e.acceptSourceTolerance(blocked.id,blocked.revision);
    blocked=await e.recheck(blocked.id,blocked.revision);blocked=await e.review(blocked.id,blocked.revision);
    assert.equal(blocked.status,'needs_review');assert.ok(blocked.counts.invalid||blocked.counts.conflict);assert.equal(blocked.canApply,false);
    await assert.rejects(e.apply(blocked.id,blocked.revision),permissionError('IMPORT_STATE_CONFLICT'));assert.equal(g.targets().length,0);
  }
});

test('count approval receipt must belong to the authenticated owner and run revision',async t=>{
  const f=await fixture(t),proof=countProof(f,2,1),e=createDataImportEngine({...f.composition,sourceTolerances:[proof]});
  let run=await f.ready([sourceRow()],{declaredRows:2});run=await e.acceptSourceTolerance(run.id,run.revision);
  f.database.prepare('UPDATE data_import_events SET actor_id=? WHERE run_id=? AND action=?').run('another-owner',run.id,T.SOURCE_TOLERANCE_EVENT_PREFIX+proof.fingerprint);
  await assert.rejects(e.checkpoint(run.id),permissionError('IMPORT_RUN_INTEGRITY'));
});

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

test('large recheck commits bounded resets, survives reconstruction and never applies a partial preview',async t=>{
  const f=await fixture(t);let run=await f.ready(Array.from({length:405},(_,i)=>sourceRow(String(i+1))));
  run=await f.engine.recheck(run.id,run.revision);
  assert.equal(run.status,'ready');assert.equal(run.counts.staged,200);assert.equal(run.counts.create,205);
  await assert.rejects(f.engine.apply(run.id,run.revision),permissionError('IMPORT_PREVIEW_INCOMPLETE'));
  const resumed=createDataImportEngine(f.composition);
  run=await resumed.recheck(run.id,run.revision);assert.equal(run.counts.staged,400);
  run=await resumed.recheck(run.id,run.revision);assert.equal(run.status,'reviewing');assert.equal(run.counts.staged,405);
  do{run=await resumed.review(run.id,run.revision);}while(run.status==='reviewing');
  do{run=await resumed.apply(run.id,run.revision);}while(run.status==='applying');
  assert.equal(run.status,'applied');assert.equal(f.targets().length,405);
  const counts=f.database.prepare('SELECT state,count(*) count FROM data_import_rows WHERE run_id=? GROUP BY state ORDER BY state').all(run.id);
  assert.deepEqual(counts,f.database.prepare('SELECT state,count FROM data_import_run_state_counts WHERE run_id=? ORDER BY state').all(run.id));
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

test('partial apply is a trusted boolean opt-in and retains the strict default', async t => {
  const f = await fixture(t);
  for (const allowPartialApply of [null, 0, 1, 'true', {}]) {
    assert.throws(() => createDataImportEngine({ ...f.composition, allowPartialApply }), permissionError('IMPORT_COMPOSITION_INVALID'));
  }
  const run = await f.ready([sourceRow('good'), sourceRow('bad', { Amount: 'invalid' })]);
  assert.equal(run.partialApplyEnabled, false); assert.equal(run.canApply, false);
  await assert.rejects(f.engine.apply(run.id, run.revision), permissionError('IMPORT_STATE_CONFLICT'));
  assert.deepEqual(f.targets(), []);
  const absentWriter = createDataImportEngine({ ...f.composition, allowPartialApply: true, writers: {} });
  assert.equal((await absentWriter.checkpoint(run.id)).partialApplyEnabled, false);
});

test('partial apply preserves encrypted invalid/conflict rows through bounded resume, replay and undo', async t => {
  const f = await fixture(t, { allowPartialApply: true });
  const rows = [sourceRow('good-1'), sourceRow('bad', { Amount: 'invalid' }),
    sourceRow('conflict', { Label: 'First' }), sourceRow('conflict', { Label: 'Second' }), sourceRow('good-2')];
  let run = await f.ready(rows);
  assert.equal(run.status, 'needs_review'); assert.equal(run.partialApplyEnabled, true); assert.equal(run.canApply, true);
  assert.deepEqual(run.counts, { conflict: 2, create: 2, invalid: 1 });
  const heldRows = () => f.database.prepare("SELECT row_number,state,issue,payload FROM data_import_rows WHERE run_id=? AND state IN ('invalid','conflict') ORDER BY row_number").all(run.id);
  const originalHeld = heldRows();
  const oneAtATime = createDataImportEngine({ ...f.composition, operationBatchSize: 1 });
  run = await oneAtATime.apply(run.id, run.revision);
  assert.equal(run.status, 'applying'); assert.equal(f.targets().length, 1); assert.deepEqual(heldRows(), originalHeld);
  const resumed = createDataImportEngine({ ...f.composition, operationBatchSize: 1 });
  run = await resumed.apply(run.id, run.revision);
  assert.equal(run.status, 'applied'); assert.deepEqual(f.targets().map(row => row.number), ['good-1', 'good-2']);
  assert.deepEqual(run.counts, { applied: 2, conflict: 2, invalid: 1 }); assert.deepEqual(heldRows(), originalHeld);
  assert.deepEqual(f.database.prepare('SELECT row_number FROM data_import_changes WHERE run_id=? ORDER BY row_number').all(run.id).map(row => row.row_number), [1, 5]);
  const replay = await resumed.start({ profileHash: f.profile.fingerprint, manifest: f.manifest(rows.length) });
  assert.deepEqual(replay, run);
  await assert.rejects(resumed.apply(run.id, run.revision), permissionError('IMPORT_STATE_CONFLICT'));
  assert.equal(f.targets().length, 2); assert.deepEqual(heldRows(), originalHeld);
  do { run = await resumed.undo(run.id, run.revision); } while (run.status === 'reverting');
  assert.equal(run.status, 'reverted'); assert.deepEqual(f.targets(), []); assert.deepEqual(heldRows(), originalHeld);
});

test('partial apply never relaxes source gates, permissions, expiry or unfinished rechecks', async t => {
  const gated = await fixture(t, { allowPartialApply: true });
  let blocked = await gated.ready([sourceRow('good'), sourceRow('bad', { Amount: 'invalid' })], { declaredRows: 3 });
  assert.equal(blocked.canApply, false); assert.ok(blocked.gates.includes('SOURCE_ROW_COUNT_MISMATCH'));
  await assert.rejects(gated.engine.apply(blocked.id, blocked.revision), permissionError('IMPORT_DECISION_GATE'));
  assert.deepEqual(gated.targets(), []);
  const f = await fixture(t, { allowPartialApply: true });
  let run = await f.ready([sourceRow('good'), sourceRow('bad', { Amount: 'invalid' })]);
  f.context.denied.add('apply'); assert.equal((await f.engine.checkpoint(run.id)).canApply, false);
  await assert.rejects(f.engine.apply(run.id, run.revision), permissionError('IMPORT_FORBIDDEN')); f.context.denied.clear();
  const originalTime = f.context.time; f.context.time = '2026-11-05T10:00:00.000Z';
  assert.equal((await f.engine.checkpoint(run.id)).canApply, false);
  await assert.rejects(f.engine.apply(run.id, run.revision), permissionError('IMPORT_RUN_EXPIRED')); f.context.time = originalTime;
  run = await f.engine.recheck(run.id, run.revision);
  assert.equal(run.counts.staged, 1);
  // Even a corrupt ready status cannot admit plans still awaiting their recheck.
  f.database.prepare("UPDATE data_import_runs SET status='ready' WHERE id=?").run(run.id);
  await assert.rejects(f.engine.apply(run.id, run.revision), permissionError('IMPORT_PREVIEW_INCOMPLETE'));
  assert.deepEqual(f.targets(), []);
});

test('snapshot writers remain strict when partial apply is enabled by composition', async t => {
  const f = await fixture(t, { allowPartialApply: true }); let finished = 0;
  Object.assign(f.writer, { async recordSnapshotRows() {}, async finishSnapshot() { finished++; }, async withdrawSnapshot() {} });
  const engine = createDataImportEngine(f.composition);
  const run = await f.ready([sourceRow('good'), sourceRow('bad', { Amount: 'invalid' }), sourceRow('same'), sourceRow('same', { Label: 'Other' })]);
  assert.equal(run.partialApplyEnabled, false); assert.equal(run.canApply, false);
  await assert.rejects(engine.apply(run.id, run.revision), permissionError('IMPORT_STATE_CONFLICT'));
  f.database.prepare("UPDATE data_import_runs SET status='ready' WHERE id=?").run(run.id);
  await assert.rejects(engine.apply(run.id, run.revision), permissionError('IMPORT_PREVIEW_INCOMPLETE'));
  assert.equal(finished, 0); assert.deepEqual(f.targets(), []);
});

test('snapshot deferral removes only building memberships and retains the complete baseline and encrypted review', async t => {
  const f = await fixture(t, { allowPartialApply: true });
  let original = await f.ready([sourceRow('existing')]); original = await f.engine.apply(original.id, original.revision);
  const baseline = f.targets(), building = new Set(); let withdrawn = 0, finished = 0;
  Object.assign(f.writer, {
    async recordSnapshotRows(_tx, rows) { rows.forEach(row => building.add(row.rowNumber)); },
    async finishSnapshot() { finished++; },
    async withdrawSnapshot() { withdrawn++; building.clear(); },
  });
  const engine = createDataImportEngine(f.composition);
  let run = await f.ready([sourceRow('existing'), sourceRow('bad', { Amount: 'invalid' })], { fileSha256: 'b'.repeat(64) });
  assert.deepEqual([...building], [1]); assert.equal(run.counts.unchanged, 1); assert.equal(run.counts.invalid, 1);
  const evidence = () => f.database.prepare('SELECT row_number,state,issue,payload FROM data_import_rows WHERE run_id=? ORDER BY row_number').all(run.id);
  const before = evidence();
  const strict = createDataImportEngine({ ...f.composition, allowPartialApply: false });
  await assert.rejects(strict.deferSnapshot(run.id, run.revision), permissionError('IMPORT_STATE_CONFLICT'));
  assert.equal(withdrawn, 0);
  f.context.denied.add('apply');
  await assert.rejects(engine.deferSnapshot(run.id, run.revision), permissionError('IMPORT_FORBIDDEN')); f.context.denied.clear();
  await assert.rejects(engine.deferSnapshot(run.id, run.revision + 1), permissionError('IMPORT_REVISION_CONFLICT'));
  run = await engine.deferSnapshot(run.id, run.revision);
  assert.equal(run.status, 'needs_review'); assert.equal(run.canApply, false); assert.equal(run.partialApplyEnabled, false);
  assert.equal(withdrawn, 1); assert.equal(finished, 0); assert.equal(building.size, 0);
  assert.deepEqual(f.targets(), baseline); assert.deepEqual(evidence(), before);
  assert.ok((await engine.events(run.id)).some(event => event.action === 'import.deferSnapshot'));
});

test('snapshot deferral rejects source gates, complete snapshots and rows already written or pending review', async t => {
  for (const kind of ['gate', 'complete', 'staged', 'applied', 'reverted']) {
    const f = await fixture(t, { allowPartialApply: true }); let withdrawn = 0;
    Object.assign(f.writer, { async recordSnapshotRows() {}, async finishSnapshot() {}, async withdrawSnapshot() { withdrawn++; } });
    const engine = createDataImportEngine(f.composition);
    const rows = [sourceRow('good'), ...(kind === 'complete' ? [] : [sourceRow('bad', { Amount: 'invalid' })])];
    const run = await f.ready(rows, kind === 'gate' ? { gates: ['OTHER_DECISION_REQUIRED'] } : {});
    if (kind === 'complete') f.database.prepare("UPDATE data_import_runs SET status='needs_review' WHERE id=?").run(run.id);
    if (['staged', 'applied', 'reverted'].includes(kind)) f.database.prepare('UPDATE data_import_rows SET state=? WHERE run_id=? AND row_number=1').run(kind, run.id);
    await assert.rejects(engine.deferSnapshot(run.id, run.revision), permissionError(kind === 'gate' ? 'IMPORT_DECISION_GATE' : 'IMPORT_PREVIEW_INCOMPLETE'));
    assert.equal(withdrawn, 0); assert.deepEqual(f.targets(), []);
  }
});

test('partial article catalog projection excludes held and pending rows and advances by the raw page', async t => {
  const profile = C.defineDataImportProfile(profileInput({ sourceSystem: 'tradefoto.master-data', sourceTable: 'ARTIKEL_ZWEITEAN', keyFields: ['EAN'], excludedFields: [], fields: [
    { source: 'EAN', target: 'number', type: 'identifier', nullable: false },
    { source: 'ZweitEAN', target: 'label', type: 'text', nullable: false },
    { source: 'Rang', target: 'amount', type: 'decimal', scale: 4, nullable: false },
  ] }));
  const f = await fixture(t, { allowPartialApply: true, profile });
  const valid = { EAN: 'valid', ZweitEAN: '4006381333931', Rang: '1' };
  const rows = [...Array.from({ length: 200 }, (_, i) => ({ EAN: 'held-' + i, ZweitEAN: null, Rang: '1' })), valid];
  let run = await f.ready(rows);
  assert.equal(run.counts.invalid, 200); assert.equal(run.counts.create, 1);
  const first = await f.engine.articleCatalogRows(run.id);
  assert.deepEqual(first, { rows: [], after: 200, complete: false });
  assert.deepEqual(await f.engine.articleCatalogRows(run.id, { after: first.after }), { rows: [], after: 201, complete: true });
  run = await f.engine.apply(run.id, run.revision);
  assert.deepEqual(await f.engine.articleCatalogRows(run.id, { after: first.after }), { rows: [{ ...valid, Rang: '1.0000' }], after: 201, complete: true });
  const repeated = await f.ready([valid], { fileSha256: 'b'.repeat(64) });
  assert.equal(repeated.counts.unchanged, 1);
  assert.deepEqual((await f.engine.articleCatalogRows(repeated.id)).rows, [{ ...valid, Rang: '1.0000' }]);
});
