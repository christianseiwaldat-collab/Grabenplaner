'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto'), Module = require('node:module'), fs = require('node:fs'), path = require('node:path');
const C = require('../lib/data-import-contract'), S = require('../lib/tradefoto-full-import-source');
const { createDataImportProtection } = require('../lib/data-import-protection');
const real = require('../lib/persistence/postgresql/operations/access-fresh-rebuild');
const AT = '2026-11-16T12:00:00.000Z', sha = value => crypto.createHash('sha256').update(value).digest('hex');
function subject(overrides = {}) {
  const file = path.resolve(__dirname, '../lib/persistence/postgresql/operations/access-fresh-rebuild.js'), mod = new Module(file, module); mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
  const original = mod.require.bind(mod); mod.require = name => name === './access-source-replay' ? { assertReplayIsolation: async (core, sales, isolated) => {
    if (isolated !== true || core.connectionParameters?.host !== '/tmp/gp-pg-recovery-unit' || sales.connectionParameters?.host !== '/tmp/gp-pg-recovery-unit') throw Object.assign(new Error('PG_SOURCE_REPLAY_ISOLATION_REQUIRED'), { code: 'PG_SOURCE_REPLAY_ISOLATION_REQUIRED' });
  } } : Object.hasOwn(overrides, name) ? overrides[name] : original(name);
  mod._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.testOnly={priorCashChoices,rebuildCash,verifyFreshOutcome,captureOriginalWork,applyFreshAnchors,prepareFinalHistoryStatistics};', file); return mod.exports;
}
function fixture({ empty = false } = {}) {
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 7), indexKey: Buffer.alloc(32, 8), keyId: 'synthetic-fresh' }), actor = { scopeId: 'synthetic-fresh', ownerId: '00001' };
  const sourceId = protection.digest(['source', actor, 'cash', sha('old-source')]);
  const sources = empty ? [] : [{ id: sourceId, ...actor, revision: '2', createdAt: AT, updatedAt: AT,
    payload: protection.seal({ kind: 'cash', fileSha256: sha('old-source'), bytes: 4096, complete: true, status: 'ready', tables: [] }, ['source', actor.scopeId, actor.ownerId, sourceId, 2]) }];
  const datasets = empty ? [] : [{ slot: '1', id: sourceId, ...actor, revision: '3', createdAt: AT, payload: '' }];
  if (datasets.length) datasets[0].payload = protection.seal({ format: 'cash-compact-v1', scope: 'full', fileSha256: sha('old-source'), bytes: 4096, complete: true, status: 'ready',
    tables: S.definitions('cash').map(def => ({ name: def.name, profileHash: def.profile.fingerprint, declaredRows: 1, expectedRows: 1, receivedRows: 1, verifiedRows: 1, complete: true, verified: true, sourceHash: sha('old-values'), verifiedHash: sha('old-values') })) },
  ['cash-compact-v1', 'dataset', 1, sourceId, actor.scopeId, actor.ownerId, 3, AT]);
  const states = empty ? [] : [{ scopeId: actor.scopeId, revision: '4', payload: protection.seal({ active: sha('old-publication'), previous: null, events: [] }, ['cash-publication-state-v1', actor.scopeId, 4]) }];
  const inventory = empty ? [] : S.definitions('cash').map((_, i) => ({ dataset_slot: '1', table_index: i, row_count: '1', generation: '1' }));
  const mutations = [], identity = { host: '/tmp/gp-pg-recovery-unit', port: 55484 }; let rawPresent = false, coreFail = false;
  const core = { connectionParameters: identity, async query(sql, params) {
    if (sql.startsWith('SELECT id,scope_id')) return { rows: sources };
    if (sql.startsWith('UPDATE gp.data_import_sources')) { if (coreFail) throw new Error('synthetic-core-write-failure'); mutations.push(sql); const row = sources.find(row => row.id === params[0]); row.revision = String(params[1]); row.payload = params[2]; return { rowCount: 1 }; }
    throw new Error('Unexpected synthetic Core SQL');
  } };
  const sales = { connectionParameters: identity, async query(sql, params) {
    if (sql.includes('row_to_json')) {
      const table = sql.match(/FROM kassa\.([a-z_]+)/)[1], rows = table === 'cash_snapshot_datasets' ? datasets : table === 'cash_publication_state' ? states : table === 'cash_snapshot_inventory' ? inventory : [];
      return { rows: rows.map(row => ({ value: JSON.stringify(row) })) };
    }
    if (sql.startsWith('SELECT slot::text')) return { rows: datasets };
    if (sql.startsWith('SELECT scope_id')) return { rows: states };
    if (sql.includes('SELECT EXISTS(SELECT 1 FROM kassa.cash_snapshot_')) return { rows: [{ present: rawPresent }] };
    if (sql.startsWith('UPDATE kassa.cash_snapshot_datasets')) { mutations.push(sql); const row = datasets.find(row => row.slot === params[0]); row.revision = String(params[1]); row.payload = params[2]; return { rowCount: 1 }; }
    if (sql.startsWith('UPDATE kassa.cash_publication_state')) { mutations.push(sql); const row = states.find(row => row.scopeId === params[0]); row.revision = String(params[1]); row.payload = params[2]; return { rowCount: 1 }; }
    if (sql.startsWith('UPDATE kassa.cash_snapshot_inventory')) { mutations.push(sql); inventory.forEach(row => { row.row_count = '0'; row.generation = '0'; }); return { rowCount: inventory.length }; }
    throw new Error('Unexpected synthetic Sales SQL');
  } };
  return { protection, actor, sources, datasets, states, inventory, mutations, core, sales, raw(value) { rawPresent = value; }, failCore(value) { coreFail = value; } };
}
test('a fresh point needs no old originals and binds only current six profiles, actors and small cash metadata', async () => {
  const f = fixture(); try {
    const plan = await real.createFreshPlan(f); real.validateFreshPlan(plan);
    assert.equal(plan.basis, 'fresh-source-rebuild'); assert.equal(plan.kinds.length, 6); assert.deepEqual(plan.actors, [f.actor]);
    assert.equal(Object.hasOwn(plan, 'archiveGenerationSha256'), false); assert.equal(Object.hasOwn(plan, 'sourceReplayPlan'), false);
    assert.equal(JSON.stringify(plan).includes('old-values'), false); assert.equal(plan.cashScopes[0].active, sha('old-publication'));
    const forged = structuredClone(plan); forged.kinds[0].tables[0].profileHash = 'f'.repeat(64); assert.throws(() => real.validateFreshPlan(forged));
    assert.throws(() => real.validateFreshPlan({ ...plan, planSha256: 'f'.repeat(64) }));
  } finally { f.protection.destroy(); }
});
test('a clean GP without any import history can still create a fresh recovery point', async () => {
  const f = fixture({ empty: true }); try { const plan = await real.createFreshPlan(f); assert.deepEqual(plan.actors, []); assert.deepEqual(plan.cashScopes, []); real.validateFreshPlan(plan); } finally { f.protection.destroy(); }
});
test('new fresh plans bind opaque original source headers while earlier v1 points remain readable without an invented digest', async () => {
  const f = fixture(); try {
    const plan = await real.createFreshPlan(f); assert.equal(plan.sourceHeaders.rows, 1); assert.match(plan.sourceHeaders.sha256, /^[a-f0-9]{64}$/);
    const legacy = structuredClone(plan); delete legacy.sourceHeaders; delete legacy.planSha256; legacy.planSha256 = sha(C.canonical(legacy)); real.validateFreshPlan(legacy);
    f.sources[0].updatedAt = '2026-11-17T12:00:00.000Z';
    await assert.rejects(subject().prepareFreshRestore({ ...f, plan, isolatedRecovery: true }), { code: 'PG_FRESH_SOURCE_RESTART_FROM_BUNDLE' }); assert.equal(f.mutations.length, 0);
  } finally { f.protection.destroy(); }
});
test('all recognized source headers lose omitted-staging readiness while their GP count decisions and metadata remain auditable', async () => {
  const f = fixture(); try {
    const id = f.protection.digest(['source', f.actor, 'trade', sha('unapplied-trade')]), row = { id, ...f.actor, revision: '9', createdAt: AT, updatedAt: AT };
    const choices = { version: 1, approvedBy: 'synthetic-owner', evidenceSha256: sha('original-count-proof') };
    const data = { kind: 'trade', fileSha256: sha('unapplied-trade'), bytes: 4096, complete: true, status: 'needs_review', independentCountProof: choices,
      excludedTableNames: ['original-user-choice'], tables: [{ name: 'source-table', profileHash: sha('profile'), run: { id: sha('original-run'), sourceToleranceReceipts: [{ actorId: f.actor.ownerId }] } }] };
    row.payload = f.protection.seal(data, ['source', f.actor.scopeId, f.actor.ownerId, id, 9]); f.sources.push(row);
    const plan = await real.createFreshPlan(f); await subject().prepareFreshRestore({ ...f, plan, isolatedRecovery: true });
    const after = f.protection.open(row.payload, ['source', f.actor.scopeId, f.actor.ownerId, id, 10]);
    assert.equal(after.complete, false); assert.equal(after.status, 'interrupted'); assert.equal(Object.hasOwn(after, 'independentCountProof'), false);
    assert.deepEqual(after.freshSourceRecovery.previousIndependentCountProof, choices); assert.deepEqual(after.freshSourceRecovery.previous, { status: 'needs_review', complete: true, revision: 9 });
    assert.deepEqual(after.tables, data.tables); assert.deepEqual(after.excludedTableNames, data.excludedTableNames);
    const changed = f.mutations.length; await subject().prepareFreshRestore({ ...f, plan, isolatedRecovery: true }); assert.equal(f.mutations.length, changed);
  } finally { f.protection.destroy(); }
});
test('fresh preparation invalidates omitted cash readiness before exposure and is idempotent only after Core is marked too', async () => {
  const f = fixture(); try {
    const plan = await real.createFreshPlan(f), module = subject();
    await module.prepareFreshRestore({ ...f, plan, isolatedRecovery: true }); const changed = f.mutations.length;
    const dataset = f.protection.open(f.datasets[0].payload, ['cash-compact-v1', 'dataset', 1, f.datasets[0].id, f.actor.scopeId, f.actor.ownerId, 4, AT]);
    assert.equal(dataset.complete, false); assert.equal(dataset.status, 'reading'); assert.ok(dataset.tables.every(t => t.receivedRows === 0 && t.expectedRows === null));
    const state = f.protection.open(f.states[0].payload, ['cash-publication-state-v1', f.actor.scopeId, 5]); assert.equal(state.active, null); assert.equal(state.previous, null);
    const source = f.protection.open(f.sources[0].payload, ['source', f.actor.scopeId, f.actor.ownerId, f.sources[0].id, 3]); assert.equal(source.complete, false); assert.equal(source.status, 'interrupted');
    await module.prepareFreshRestore({ ...f, plan, isolatedRecovery: true }); assert.equal(f.mutations.length, changed);
    assert.ok(f.mutations.every(sql => !sql.includes('DELETE') && !sql.includes('cash_publication_bindings SET')));
  } finally { f.protection.destroy(); }
});
test('nonempty raw data and a partial cross-domain preparation fail closed rather than accepting stale readiness', async () => {
  for (const partial of [false, true]) {
    const f = fixture(); try {
      const plan = await real.createFreshPlan(f), module = subject();
      if (!partial) { f.raw(true); await assert.rejects(module.prepareFreshRestore({ ...f, plan, isolatedRecovery: true }), { code: 'PG_FRESH_SOURCE_RAW_NOT_EMPTY' }); assert.equal(f.mutations.length, 0); }
      else {
        f.failCore(true); await assert.rejects(module.prepareFreshRestore({ ...f, plan, isolatedRecovery: true }), /synthetic-core-write-failure/); f.failCore(false);
        await assert.rejects(module.prepareFreshRestore({ ...f, plan, isolatedRecovery: true }), { code: 'PG_FRESH_SOURCE_RESTART_FROM_BUNDLE' });
      }
    } finally { f.protection.destroy(); }
  }
});
function cashFixture({ missing = false } = {}) {
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 9), indexKey: Buffer.alloc(32, 10), keyId: 'synthetic-cash-choices' });
  const actor = { scopeId: 'synthetic-fresh', ownerId: '00001' }, publication = { id: sha('publication'), ...actor, datasetId: sha('dataset'), createdAt: AT };
  const p = require('../lib/cash-source-policies').CASH_SOURCE_POLICIES[0], definition = { ...p.policy, scopeId: actor.scopeId, sourceInstance: 'tradefoto-cash' };
  const policyFingerprint = require('../lib/tradefoto-sales-rules').defineTradeFotoSalesPolicy(definition).fingerprint;
  publication.payload = protection.seal({ policy: definition, policyFingerprint, bindingCount: 50003, bindingCounts: { ARTIKEL_STAMM: 50001, FILIALEN: 1, MITARBEITER: 1, KUNDEN: 0 } },
    ['cash-publication-v1', publication.id, actor.scopeId, publication.datasetId, actor.ownerId, AT]);
  const fields = require('../lib/persistence/repositories/cash-publications').CASH_REFERENCE_FIELDS;
  const bindings = [{ kind: 'FILIALEN', sourceId: '18', targetId: 'gp-location-18', historical: false }, { kind: 'MITARBEITER', sourceId: '7', targetId: '00007', historical: false },
    { kind: 'ARTIKEL_STAMM', sourceId: '43', targetId: 'own-product-43', historical: true, targetActive: true }].map(value => {
    const sourceKey = protection.digest(['cash-compact-v1', 'source-reference', actor.scopeId, fields[value.kind], value.sourceId]), row = { publicationId: publication.id, ...value, sourceKey };
    row.payload = protection.seal({ ...value, sourceKey }, ['cash-publication-binding-v1', publication.id, value.kind, sourceKey, value.targetId, value.historical]); return row;
  });
  const sales = { async query(sql) {
    if (sql.includes('FROM kassa.cash_publications')) return { rows: [publication] };
    if (sql.startsWith('SELECT kind,count')) return { rows: [{ kind: 'ARTIKEL_STAMM', count: '50001' }, { kind: 'FILIALEN', count: '1' }, { kind: 'MITARBEITER', count: '1' }] };
    if (sql.includes('FROM kassa.cash_publication_bindings') && sql.includes("kind<>'ARTIKEL_STAMM'")) {
      assert.ok(sql.includes('(historical=1) AS historical')); assert.equal(sql.includes('IS TRUE'), false); return { rows: bindings };
    }
    throw new Error('Unexpected cash choice SQL');
  } };
  let activated = null;
  const module = subject({ '../../repositories/cash-publications': { CASH_REFERENCE_FIELDS: fields, createCashPublications: () => ({
    state: async () => ({ row: { revision: 8 }, data: { active: null } }), candidate: async () => ({ dataset: {}, reader: {} }),
    references: async (_tx, _dataset, _reader, kind) => ({ items: missing ? [] : [{ sourceId: kind === 'FILIALEN' ? '18' : kind === 'MITARBEITER' ? '7' : '43' }], next: null }),
    plan: async (_tx, _actor, request) => { activated = request; return { planHash: sha('preview') }; }, activate: async () => ({ active: sha('new-publication') }),
  }) } });
  return { protection, actor, sales, module, publication, bindings, access: { transaction: work => work({}) }, get request() { return activated; } };
}
test('fresh cash preserves explicit GP choices and regenerates large derived article bindings through the ordinary planner', async () => {
  const f = cashFixture(); try {
    const result = await f.module.testOnly.rebuildCash({ ...f, source: { id: sha('new-source'), fileSha256: sha('new-file') }, plan: { cashScopes: [{ scopeId: f.actor.scopeId, active: f.publication.id }] }, clock: () => AT });
    assert.equal(result.verified, true); assert.equal(result.mappings, 3); assert.equal(f.request.resolveArticles, true);
    assert.deepEqual(f.request.mappings.map(m => [m.sourceId, m.targetId]), [['18', 'gp-location-18'], ['7', '00007'], ['43', 'own-product-43']]); assert.equal(f.request.expectedRevision, 8);
    assert.equal(f.request.mappings.find(m => m.kind === 'ARTIKEL_STAMM').historical, true);
  } finally { f.protection.destroy(); }
});
test('a missing fresh cash source reference requires review and never fabricates a replacement GP mapping', async () => {
  const f = cashFixture({ missing: true }); try {
    await assert.rejects(f.module.testOnly.rebuildCash({ ...f, source: { id: sha('new-source'), fileSha256: sha('new-file') }, plan: { cashScopes: [{ scopeId: f.actor.scopeId, active: f.publication.id }] }, clock: () => AT }), { code: 'PG_FRESH_SOURCE_CASH_MAPPING_REVIEW' });
    assert.equal(f.request, null);
  } finally { f.protection.destroy(); }
});
test('fresh runtime capabilities cannot be manufactured outside the private rebuild', () => {
  assert.throws(() => real.assertFreshRuntimePolicy({ namespace: real.FORMAT, isolatedRecovery: true }), { code: 'IMPORT_COMPOSITION_INVALID' });
});
test('fresh completion rejects invalid or unexplained partial rows and counts only authenticated GP quarantines as preserved', async () => {
  const module = subject(), runId = sha('fresh-run'), identity = sha('owned-anchor'), excluded = new Map([[runId + ':' + identity, 'RECOVERY_PRESERVED_GP_ANCHOR']]);
  const source = { tables: [{ run: { id: runId, receivedRows: 2, counts: { applied: 1, conflict: 1 } } }] };
  const sales = { async query() { return { rows: [{ identityHash: identity, state: 'conflict', issue: 'RECOVERY_PRESERVED_GP_ANCHOR' }] }; } };
  assert.deepEqual(await module.testOnly.verifyFreshOutcome({ sales, source, excluded }), { applied: 1, unchanged: 0, duplicate: 0, preservedGpQuarantined: 1 });
  for (const bad of [{ state: 'invalid', issue: 'INVALID_VALUE' }, { state: 'conflict', issue: 'UNLINKED_TARGET_EXISTS' }, { state: 'conflict', issue: 'RECOVERY_PRESERVED_GP_ANCHOR', identityHash: sha('unowned') }]) {
    await assert.rejects(module.testOnly.verifyFreshOutcome({ source, excluded, sales: { async query() { return { rows: [{ identityHash: identity, ...bad }] }; } } }), { code: 'PG_FRESH_SOURCE_QUALITY_REVIEW' });
  }
});

function originalWorkPlan(rows, changes) {
  const columns = ['run_id', 'row_number', 'identity_hash'].map(name => ({ name, type: name === 'row_number' ? 'bigint' : 'text', notNull: true, identity: '', generated: '' }));
  const tables = [['data_import_rows', rows], ['data_import_changes', changes]].map(([table, rows]) => ({ schema: 'integration', table, columns,
    schemaSha256: sha(C.canonical({ schema: 'integration', table, columns })), rows, contentSha256: sha('synthetic-original-protected-rows') }));
  const body = { format: 'grabenplaner-access-owned-state-v4', basis: 'fresh-source-rebuild', file: 'access-owned-state.rows', bytes: 0,
    sha256: sha(''), rows: rows + changes, tables, stats: { completedAccessRuns: 0, retainedPendingOrUnknownRuns: 1, masterAnchors: 0, historyAnchors: 0, catalogRevisions: 0 } };
  return { ...body, planSha256: sha(C.canonical(body)) };
}
function anchorFixture({ kind = 'trade', table = 'FILIALEN', count = 1, links = true, retry = false } = {}) {
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 23), indexKey: Buffer.alloc(32, 24), keyId: 'synthetic-anchor-batches' });
  const M = require('../lib/tradefoto-master-profiles'), H = require('../lib/tradefoto-history-profiles'), def = S.definitions(kind).find(def => def.name === table), actor = { scopeId: 'synthetic-fresh', ownerId: '00001' };
  const sample = require('../test-support/postgresql-access-recovery-fixture.cjs').fixtureRows()[kind][table][0];
  const input = Array.from({ length: count }, (_, index) => Object.fromEntries(def.profile.fields.map(field => {
    let value = field.source === '_source_snapshot_sha256' ? sha('anchor-source') : field.source === '_source_row' ? index + 1
      : table === 'FILIALEN' && field.source === 'FilialID' ? 100 + index : sample[field.source] ?? null;
    if (value !== null) {
      if (['identifier', 'text', 'source_text', 'decimal', 'source_decimal'].includes(field.type)) value = String(value);
      if (field.type === 'civil_datetime' && value.length === 19) value += '.000';
      if (field.type === 'date') value = value.slice(0, 10);
    }
    return [field.source, value];
  })));
  const masterAnchors = new Map(), historyAnchors = new Map(), targets = new Map(), saved = new Map(), identities = [], records = [];
  input.forEach((raw, index) => {
    const record = C.normalizeDataImportRow(def.profile, raw), naturalContext = { scopeId: actor.scopeId, sourceInstance: 'tradefoto-' + kind };
    const natural = def.master ? M.masterIdentity(protection, naturalContext, def.name, record.key) : H.historyIdentity(protection, naturalContext, def.source, def.name, record.key);
    const anchor = { id: 'synthetic-anchor-' + index, revision: '3' }, identity = protection.digest(['identity', actor.scopeId, def.profile.sourceSystem, naturalContext.sourceInstance, def.name, def.profile.entity, def.profile.keyFields, record.key]);
    (def.master ? masterAnchors : historyAnchors).set(actor.scopeId + ':' + natural, anchor); targets.set(anchor.id, { id: anchor.id, revision: 3, data: record.data }); identities.push(identity); records.push(record);
    if (links) saved.set(identity, { id: identity, scopeId: actor.scopeId, entity: def.profile.entity, targetId: anchor.id, revision: 1, lastRunId: sha('original-run'),
      payload: protection.seal({ record, contentHash: protection.digest({ record }), targetRevision: 3 }, ['link', identity]) });
  });
  const batches = [], reads = [], writes = []; let transactions = 0, contextReads = 0;
  const access = { async transaction(work, options) {
    assert.equal(options.isolation, 'serializable'); transactions++; const attempts = retry ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const pending = new Map(saved), readIds = [];
      const tx = { attempt, async queryOne(statement, args) { assert.equal(statement, require('../lib/persistence/statements/data-import').DATA_IMPORT_STATEMENTS.getLink); return pending.get(args.id) || null; },
        async execute(statement, args) { assert.equal(statement, require('../lib/persistence/statements/data-import').DATA_IMPORT_STATEMENTS.insertLink); pending.set(args.id, structuredClone(args)); writes.push(args.id); return { rowsAffected: 1 }; } };
      tx.readIds = readIds; const result = await work(tx); if (attempt < attempts) continue;
      saved.clear(); for (const [key, value] of pending) saved.set(key, value); batches.push(readIds); return result;
    }
  } };
  const writer = { async read(tx, id) { tx.readIds.push(id); reads.push(id); return structuredClone(targets.get(id)); }, async review(tx) { return { issue: '', rewrite: retry && tx.attempt === 1 }; } };
  const context = { ...actor, sourceInstance: 'tradefoto-' + kind, sourceSystem: def.profile.sourceSystem, sourceTable: def.name, profileHash: def.profile.fingerprint,
    at: AT, fileSha256: sha('fresh-source'), snapshotAt: AT, runId: sha('fresh-run'), expectedRows: count };
  const excluded = new Map(), originalWork = new Set();
  return { protection, def, kind, actor, rows: input, identities, records, targets, saved, masterAnchors, historyAnchors, originalWork, excluded,
    batches, reads, writes, access, masterWriters: { [def.profile.entity]: writer }, historyWriters: { [def.profile.entity]: writer },
    resolveContext: async () => { contextReads++; return context; }, get transactions() { return transactions; }, get contextReads() { return contextReads; } };
}

test('original GP work is captured once before incoming staging, including protected before-images and undo identities', async () => {
  const module = subject(), f = anchorFixture({ count: 3 }); try {
    const work = [{ identityHash: f.identities[0], payload: f.protection.seal({ before: { ownChoice: 'GP-before-image' } }, ['synthetic-before-image']) },
      { identityHash: f.identities[1], revertedAt: AT, payload: f.protection.seal({ before: { ownChoice: 'GP-undo' } }, ['synthetic-undo']) }], before = structuredClone(work), queries = [];
    const sales = { async query(sql) { queries.push(sql); assert.match(sql, /UNION SELECT identity_hash/); return { rows: work.map(({ identityHash }) => ({ identityHash })) }; } };
    const originalWork = await module.testOnly.captureOriginalWork({ sales, ownedPlan: originalWorkPlan(1, 1) });
    // New staging after the snapshot is source-derived, including a new row
    // with the same identity as another preserved target. It is not GP work.
    work.push({ identityHash: f.identities[2], payload: 'new-incoming-source-row' });
    await module.testOnly.applyFreshAnchors({ ...f, originalWork });
    assert.equal(queries.length, 1); assert.equal(f.excluded.size, 2); assert.equal(f.excluded.has(sha('fresh-run') + ':' + f.identities[2]), false);
    assert.deepEqual(work.slice(0, 2), before); assert.equal(f.writes.length, 0);
  } finally { f.protection.destroy(); }
});

test('zero-count authenticated original work uses one empty sanity check and never scans later staging', async () => {
  const module = subject(), calls = [], plan = originalWorkPlan(0, 0);
  const sales = { async query(sql) { calls.push(sql); return { rows: [{ present: false }] }; } };
  assert.equal((await module.testOnly.captureOriginalWork({ sales, ownedPlan: plan })).size, 0); assert.equal(calls.length, 1); assert.match(calls[0], /SELECT EXISTS/);
  await assert.rejects(module.testOnly.captureOriginalWork({ sales: { async query() { return { rows: [{ present: true }] }; } }, ownedPlan: plan }), { code: 'PG_FRESH_SOURCE_ORIGINAL_WORK' });
  await assert.rejects(module.testOnly.captureOriginalWork({ sales, ownedPlan: { ...plan, planSha256: '0'.repeat(64) } }));
});

test('keyless invalid GP staging and unknown non-SHA identities remain untouched and cannot invalidate the work snapshot', async () => {
  const module = subject(), original = [{ identityHash: null, payload: 'retained-keyless-invalid-GP-row' },
    { identityHash: 'old-source-key', payload: 'retained-unknown-source' }, { identityHash: 'A'.repeat(64) }, { identityHash: 42 }, { identityHash: sha('real-original-GP-work') }], before = structuredClone(original);
  const identities = await module.testOnly.captureOriginalWork({ ownedPlan: originalWorkPlan(4, 1), sales: { async query(sql) {
    assert.equal(sql.match(/WHERE identity_hash IS NOT NULL/g).length, 2); return { rows: original };
  } } });
  assert.deepEqual([...identities], [sha('real-original-GP-work')]); assert.deepEqual(original, before);
});

test('205 original anchors share bounded serializable chunks and one event context, without rewriting old baselines', async () => {
  const module = subject(), f = anchorFixture({ count: 205 }); try {
    const baseline = structuredClone([...f.saved]); await module.testOnly.applyFreshAnchors(f);
    assert.deepEqual(f.batches.map(batch => batch.length), [100, 100, 5]); assert.equal(f.contextReads, 1); assert.equal(f.transactions, 3);
    assert.equal(f.reads.length, 205); assert.equal(f.writes.length, 0); assert.equal(f.excluded.size, 0); assert.deepEqual([...f.saved], baseline);
    await module.testOnly.applyFreshAnchors({ ...f, masterAnchors: new Map(), historyAnchors: new Map() }); assert.equal(f.contextReads, 1); assert.equal(f.transactions, 3);
  } finally { f.protection.destroy(); }
});

test('original GP work without a link and changed own targets remain quarantined', async () => {
  const module = subject(), f = anchorFixture({ count: 2, links: false }); try {
    f.originalWork.add(f.identities[0]); const second = f.targets.get('synthetic-anchor-1'); second.data = C.normalizeDataImportRow(f.def.profile, { ...f.rows[1], FName: 'Actual GP-owned branch name' }).data;
    await module.testOnly.applyFreshAnchors(f); assert.equal(f.excluded.size, 2); assert.equal(f.saved.size, 0); assert.equal(f.writes.length, 0);
  } finally { f.protection.destroy(); }
});

test('stale targets and corrupt link envelopes fail the whole chunk without committing preceding seeds or exclusions', async () => {
  for (const corrupt of [false, true]) {
    const module = subject(), f = anchorFixture({ count: 2, links: false }); try {
      if (corrupt) f.saved.set(f.identities[1], { scopeId: f.actor.scopeId, entity: f.def.profile.entity, targetId: 'synthetic-anchor-1', payload: 'not-an-authenticated-envelope' });
      else f.targets.get('synthetic-anchor-1').revision = 4;
      const before = structuredClone([...f.saved]); await assert.rejects(module.testOnly.applyFreshAnchors(f));
      assert.deepEqual([...f.saved], before); assert.equal(f.excluded.size, 0); assert.equal(f.batches.length, 0);
    } finally { f.protection.destroy(); }
  }
});

test('rolled-back callback quarantine decisions cannot leak into a successfully retried chunk', async () => {
  const module = subject(), f = anchorFixture({ kind: 'weum', table: 'WE', links: false, retry: true }); try {
    await module.testOnly.applyFreshAnchors(f); assert.equal(f.excluded.size, 0); assert.equal(f.saved.size, 1); assert.equal(f.batches.length, 1);
  } finally { f.protection.destroy(); }
});

test('cross-kind history anchors use their domain source and retain authentic existing links for normal changed input', async () => {
  for (const [kind, table] of [['trade', 'ARTIKEL_FILIALEN'], ['bestell', 'BESTELLUNGEN'], ['weum', 'WE'], ['inventur', 'Inventur'], ['lieferantenrechnungen', 'Rechnung_A']]) {
    const module = subject(), f = anchorFixture({ kind, table }); try {
      const before = structuredClone([...f.saved]);
      if (kind === 'weum') f.rows[0] = { ...f.rows[0], Menge: '5.5' };
      await module.testOnly.applyFreshAnchors(f); assert.equal(f.transactions, 1, kind); assert.equal(f.excluded.size, 0, kind); assert.deepEqual([...f.saved], before, kind);
    } finally { f.protection.destroy(); }
  }
});

function historyStatisticsFixture({ kind = 'trade', table = 'ARTIKEL_FILIALEN', counts = { create: 2 }, status = 'ready' } = {}) {
  const defs = S.definitions(kind), def = defs.find(def => def.name === table), id = sha('fresh-snapshot-run');
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 29), indexKey: Buffer.alloc(32, 30), keyId: 'synthetic-statistics-source' });
  const actor = { scopeId: 'synthetic-fresh', ownerId: '00001' }, input = { fileSha256: sha('fresh-statistics-source'), bytes: 4096 };
  const source = { id: protection.digest(['source', actor, kind, input.fileSha256]), revision: 7, kind, ...input, complete: true, status: 'applying',
    recheckedRun: id, tables: [{ name: table, profileHash: def.profile.fingerprint, run: { id, revision: 11, receivedRows: 2, status, gates: [], counts } }] };
  const privateData = { kind, ...input, complete: true, tables: structuredClone(source.tables) }, sourceReads = [];
  const core = { connectionParameters: { host: '/tmp/gp-pg-recovery-unit', port: 55484, user: 'gp_migration_admin', database: 'gp_migration_core' } };
  core.query = async (sql, parameters) => {
    sourceReads.push(sql); assert.match(sql, /WHERE id=\$1 AND scope_id=\$2 AND owner_id=\$3$/); assert.deepEqual(parameters, [source.id, actor.scopeId, actor.ownerId]);
    return { rows: [{ id: source.id, ...actor, revision: String(source.revision), payload: protection.seal(privateData, ['source', actor.scopeId, actor.ownerId, source.id, source.revision]) }] };
  };
  const calls = [], initialSettings = { statement: '0', lock: '0' }; let settings = { ...initialSettings }, transaction = false;
  const sales = { connectionParameters: { ...core.connectionParameters, database: 'gp_migration_sales' }, async query(sql) {
    calls.push(sql);
    if (sql === 'BEGIN') { assert.equal(transaction, false); transaction = true; }
    else if (sql.startsWith('SET LOCAL')) { assert.equal(transaction, true); settings = { statement: '10s', lock: '2s' }; }
    else if (sql.startsWith('SELECT current_user')) return { rows: [{ username: 'gp_migration_admin', sessionUser: 'gp_migration_admin', superuser: true }] };
    else if (sql.startsWith('ANALYZE ')) { assert.equal(transaction, true); assert.deepEqual(settings, { statement: '10s', lock: '2s' }); }
    else if (sql === 'COMMIT' || sql === 'ROLLBACK') { assert.equal(transaction, true); transaction = false; settings = { ...initialSettings }; }
    else assert.fail('Unexpected statistics SQL');
    return { rows: [] };
  } };
  return { core, sales, source, defs, prepared: new Set(), protection, actor, kind, input, privateData, sourceReads, isolatedRecovery: true, calls,
    get transaction() { return transaction; }, get settings() { return settings; } };
}

test('the last small AF packet receives three fixed transactional analyses once, with unchanged application settings', async () => {
  const module = subject(), f = historyStatisticsFixture(), original = structuredClone(f.source);
  assert.equal(await module.testOnly.prepareFinalHistoryStatistics(f), true);
  assert.deepEqual(f.calls, ['BEGIN', "SET LOCAL statement_timeout='10s';SET LOCAL lock_timeout='2s'",
    'SELECT current_user AS username,session_user AS "sessionUser",(SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS superuser',
    'ANALYZE integration.import_history_snapshot_members', 'ANALYZE integration.import_history_records', 'ANALYZE integration.import_history_versions', 'COMMIT']);
  assert.deepEqual(f.settings, { statement: '0', lock: '0' }); assert.equal(f.transaction, false); assert.deepEqual(f.source, original);
  assert.deepEqual([...f.prepared], [f.source.recheckedRun]); const count = f.calls.length;
  assert.equal(await module.testOnly.prepareFinalHistoryStatistics(f), false); assert.equal(f.calls.length, count);
  const next = sha('another-actor-snapshot-run'); f.source.tables[0].run.id = next; f.source.recheckedRun = next;
  assert.equal(await module.testOnly.prepareFinalHistoryStatistics(f), true); assert.equal(f.prepared.size, 2);
});

test('statistics wait for the actual next AF run and completed review, while zero-pending certification is protected', async () => {
  const module = subject();
  for (const scenario of ['earlier-table', 'unreviewed', 'large', 'staged', 'invalid', 'conflict', 'gated', 'applied', 'deferred', 'unknown-profile', 'non-af']) {
    const f = scenario === 'non-af' ? historyStatisticsFixture({ kind: 'weum', table: 'WE' }) : historyStatisticsFixture();
    const table = f.source.tables[0];
    if (scenario === 'earlier-table') f.source.tables.unshift({ name: 'FILIALEN', profileHash: sha('earlier-profile'), run: { status: 'ready' } });
    if (scenario === 'unreviewed') delete f.source.recheckedRun;
    if (scenario === 'large') table.run.counts = { create: 199, update: 1, refresh: 1 };
    if (['staged', 'invalid', 'conflict'].includes(scenario)) table.run.counts[scenario] = 1;
    if (scenario === 'gated') table.run.gates = ['SOURCE_ROW_COUNT_MISMATCH'];
    if (scenario === 'applied') table.run.status = 'applied';
    if (scenario === 'deferred') table.deferred = 'INCOMPLETE_STOCK_SNAPSHOT';
    if (scenario === 'unknown-profile') table.profileHash = sha('unknown-profile');
    assert.equal(await module.testOnly.prepareFinalHistoryStatistics(f), false, scenario); assert.equal(f.calls.length, 0, scenario);
  }
  for (const counts of [{ create: 198, update: 1, refresh: 1 }, { unchanged: 238947 }]) {
    const f = historyStatisticsFixture({ counts }); assert.equal(await module.testOnly.prepareFinalHistoryStatistics(f), true); assert.equal(f.prepared.size, 1);
  }
  const applying = historyStatisticsFixture({ status: 'applying', counts: { create: 27, applied: 238920 } }); delete applying.source.recheckedRun;
  assert.equal(await module.testOnly.prepareFinalHistoryStatistics(applying), true);
});

test('analysis errors and failed commits roll back and cannot suppress a later honest attempt', async () => {
  const module = subject();
  for (const failedSql of ['ANALYZE integration.import_history_records', 'COMMIT']) {
    const f = historyStatisticsFixture(), query = f.sales.query.bind(f.sales), failure = Object.assign(new Error('synthetic bounded timeout'), { code: '57014' }); let failOnce = true;
    f.sales.query = async sql => { if (failOnce && sql === failedSql) { failOnce = false; f.calls.push(sql); throw failure; } return query(sql); };
    await assert.rejects(module.testOnly.prepareFinalHistoryStatistics(f), error => error === failure);
    assert.equal(f.calls.at(-1), 'ROLLBACK'); assert.equal(f.transaction, false); assert.equal(f.prepared.size, 0); assert.deepEqual(f.settings, { statement: '0', lock: '0' });
    assert.equal(await module.testOnly.prepareFinalHistoryStatistics(f), true); assert.equal(f.prepared.size, 1);
  }
  const f = historyStatisticsFixture(); let checks = 0;
  await assert.rejects(module.testOnly.prepareFinalHistoryStatistics({ ...f, checkBudget: () => { if (++checks === 3) throw new Error('synthetic recovery budget'); } }), /synthetic recovery budget/);
  assert.equal(f.calls.at(-1), 'ROLLBACK'); assert.equal(f.transaction, false); assert.equal(f.prepared.size, 0);
});

test('statistics refuse non-isolated clients and switched server roles before any analysis', async () => {
  const module = subject();
  for (const scenario of ['not-isolated', 'wrong-socket', 'app-client', 'wrong-database', 'wrong-server-role']) {
    const f = historyStatisticsFixture();
    if (scenario === 'not-isolated') f.isolatedRecovery = false;
    if (scenario === 'wrong-socket') f.sales.connectionParameters.host = '/tmp/another-server';
    if (scenario === 'app-client') f.sales.connectionParameters.user = 'gp_sales_app';
    if (scenario === 'wrong-database') f.sales.connectionParameters.database = 'another_sales';
    if (scenario === 'wrong-server-role') {
      const query = f.sales.query.bind(f.sales); f.sales.query = async sql => sql.startsWith('SELECT current_user')
        ? { rows: [{ username: 'gp_sales_app', sessionUser: 'gp_migration_admin', superuser: false }] } : query(sql);
    }
    await assert.rejects(module.testOnly.prepareFinalHistoryStatistics(f)); assert.equal(f.prepared.size, 0, scenario);
    assert.equal(f.calls.some(sql => sql.startsWith('ANALYZE ')), false, scenario); assert.equal(f.transaction, false, scenario);
  }
});

test('the actual ready-validation coordinator receives statistics before its private-complete direct apply, including zero pending rows', async () => {
  const runtimeFile = path.resolve(__dirname, '../lib/persistence/repositories/data-import-runtime.js'), runtimeText = fs.readFileSync(runtimeFile, 'utf8');
  const start = runtimeText.indexOf('async function advanceReadyValidation('), end = runtimeText.indexOf('// One bounded reader per app process.', start);
  assert.ok(start > 0 && end > start); const compiled = new Module(runtimeFile, module); compiled.filename = runtimeFile; compiled.paths = Module._nodeModulePaths(path.dirname(runtimeFile));
  compiled._compile('const C=require("../../data-import-contract");\n' + runtimeText.slice(start, end) + '\nmodule.exports={advanceReadyValidation};', runtimeFile);
  const { advanceReadyValidation } = compiled.exports, moduleUnderTest = subject();
  for (const counts of [{ create: 2 }, { unchanged: 2 }]) {
    const f = historyStatisticsFixture({ counts }); try {
      delete f.source.recheckedRun; const table = f.source.tables[0], before = structuredClone(f.source); let applies = 0;
      const cursor = 'private-engine-cursor', engine = {
        async validateReadyPlans() { assert.equal(f.calls.length, 0); return { run: table.run, cursor, complete: true, verifiedRows: 2 }; },
        async apply(runId, revision, options) {
          assert.equal(f.calls.at(-1), 'COMMIT'); assert.equal(f.calls.filter(sql => sql.startsWith('ANALYZE ')).length, 3);
          assert.equal(f.prepared.has(runId), true); assert.equal(revision, table.run.revision); assert.equal(options.readyValidation.cursor, cursor); applies++;
          return { ...table.run, status: 'applied' };
        }, async recheck() { assert.fail('This is the normal direct cursor path'); }
      };
      assert.equal(await moduleUnderTest.testOnly.prepareFinalHistoryStatistics(f), false);
      const binding = { sourceId: f.source.id, sourceRevision: f.source.revision, fileSha256: f.input.fileSha256, sourceGuard: async () => {} };
      const first = await advanceReadyValidation(engine, table, null, binding);
      assert.equal(first.rechecked, false); assert.equal(first.progress.complete, true); assert.equal(applies, 0);
      f.source.revision++; f.privateData.readyPlanValidation = first.progress;
      assert.equal(Object.hasOwn(f.source, 'readyPlanValidation'), false);
      assert.equal(await moduleUnderTest.testOnly.prepareFinalHistoryStatistics(f), true);
      const second = await advanceReadyValidation(engine, table, f.privateData.readyPlanValidation, { ...binding, sourceRevision: f.source.revision });
      assert.equal(second.run.status, 'applied'); assert.equal(second.rechecked, true); assert.equal(applies, 1); assert.equal(f.sourceReads.length, 2);
      assert.equal(Object.hasOwn(f.source, 'readyPlanValidation'), false); assert.deepEqual(f.source.tables, before.tables);
    } finally { f.protection.destroy(); }
  }
});

test('only a bound authenticated complete private cursor permits the ready fast path', async () => {
  const module = subject();
  for (const scenario of ['incomplete', 'foreign-run', 'fusion', 'fallback', 'stale-revision', 'foreign-owner', 'foreign-file', 'foreign-table', 'corrupt-envelope']) {
    const f = historyStatisticsFixture(); try {
      delete f.source.recheckedRun;
      f.privateData.readyPlanValidation = { runId: f.source.tables[0].run.id, cursor: 'private', complete: true };
      if (scenario === 'incomplete') f.privateData.readyPlanValidation.complete = false;
      if (scenario === 'foreign-run') f.privateData.readyPlanValidation.runId = sha('foreign-run');
      if (scenario === 'fusion') f.privateData.readyPlanValidation.fusion = true;
      if (scenario === 'fallback') f.privateData.readyPlanValidation.fallback = true;
      if (scenario === 'foreign-file') f.privateData.fileSha256 = sha('different-original');
      if (scenario === 'foreign-table') f.privateData.tables[0].run.revision++;
      const query = f.core.query;
      f.core.query = async (...args) => {
        const result = await query(...args), row = result.rows[0];
        if (scenario === 'stale-revision') row.revision = String(f.source.revision - 1);
        if (scenario === 'foreign-owner') row.ownerId = '00002';
        if (scenario === 'corrupt-envelope') row.payload = 'unauthenticated';
        return result;
      };
      if (['incomplete', 'foreign-run', 'fusion', 'fallback'].includes(scenario)) assert.equal(await module.testOnly.prepareFinalHistoryStatistics(f), false, scenario);
      else await assert.rejects(module.testOnly.prepareFinalHistoryStatistics(f));
      assert.equal(f.calls.length, 0, scenario); assert.equal(f.prepared.size, 0, scenario);
    } finally { f.protection.destroy(); }
  }
});
