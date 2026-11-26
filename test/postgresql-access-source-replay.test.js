'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), Module = require('node:module'), path = require('node:path');
const C = require('../lib/data-import-contract'), S = require('../lib/tradefoto-full-import-source');
const { SOURCE_KINDS } = require('../lib/data-import-source-catalog');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { withImportFixture, nativeImport } = require('../test-support/data-import-known-af-fixture');
const { validateImportSourceArchiveProof } = require('../lib/data-import-source-archive');
const real = require('../lib/persistence/postgresql/operations/access-source-replay');
const sha = value => crypto.createHash('sha256').update(value).digest('hex'), AT = '2026-11-16T12:00:00.000Z';
const actor = { scopeId: 'synthetic-replay', ownerId: '00001' };
const read = async (db, sql, params) => (await db.query(sql, params)).rows;
const first = async (db, sql, params) => (await read(db, sql, params))[0];
function isolatedModule(overrides = {}) {
  const file = path.resolve(__dirname, '../lib/persistence/postgresql/operations/access-source-replay.js'), subject = new Module(file, module); subject.filename = file; subject.paths = Module._nodeModulePaths(path.dirname(file));
  const original = subject.require.bind(subject); subject.require = name => name === 'node:os' ? { networkInterfaces: () => ({ lo: [{ internal: true }] }) } : Object.hasOwn(overrides, name) ? overrides[name] : original(name);
  subject._compile(fs.readFileSync(file, 'utf8'), file); return subject.exports;
}
function fixture({ kinds = SOURCE_KINDS, protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 4), indexKey: Buffer.alloc(32, 5), keyId: 'synthetic' }) } = {}) {
  const objects = kinds.map(kind => {
    const buffer = Buffer.alloc(4096); buffer.write('Standard ACE DB', 4); buffer[0x14] = 3; buffer.write(kind, 256); const fileSha256 = sha(buffer);
    const id = protection.digest(['source', actor, kind, fileSha256]), runs = [], tables = S.definitions(kind).map((def, index) => {
      const expectedRows = kind === 'trade' && index === 0 ? 4 : 0, manifest = { sourceInstance: 'tradefoto-' + kind, fileSha256, schemaSha256: def.profile.schemaSha256,
        expectedRows, declaredRows: expectedRows, snapshotAt: AT, gates: [] };
      const runId = protection.digest(['run', C.VERSION, actor, def.profile.fingerprint, manifest, 'default']);
      runs.push({ id: runId, ...actor, profileHash: def.profile.fingerprint, manifest, attemptId: 'default', status: 'applied', receivedCount: String(expectedRows) });
      return { name: def.name, profileHash: def.profile.fingerprint, declaredRows: expectedRows, run: { id: runId, expectedRows, receivedRows: expectedRows, status: 'applied' } };
    });
    const data = { kind, fileSha256, bytes: buffer.length, fileName: 'synthetic-' + kind + '.accdb', complete: true, status: kind === 'cash' ? 'ready' : 'applied', tables,
      ...(kind === 'cash' ? { storage: 'cash-compact-v1' } : {}), progress: { operation: 'apply', finishedAt: AT } };
    const row = { id, ...actor, revision: 5, createdAt: AT, updatedAt: AT, payload: protection.seal(data, ['source', actor.scopeId, actor.ownerId, id, 5]) };
    const entry = { kind, sourceId: id, fileSha256, bytes: buffer.length, fileName: data.fileName, capturedAt: 1, appliedAt: 2, revision: 5, requiresPassword: false, file: sha(kind + '-cipher') + '.source' };
    return { buffer, data, row, entry, runs };
  });
  const proof = { version: 1, available: !!objects.length, generation: 1, kinds: SOURCE_KINDS.map(kind => ({ kind, current: objects.find(o => o.entry.kind === kind)?.entry || null, previous: null })), candidates: [],
    files: [{ file: 'index.source-archive', bytes: 100, sha256: sha('sealed-index') }, ...objects.map(o => ({ file: o.entry.file, bytes: o.entry.bytes, sha256: sha(o.entry.file) }))] };
  proof.generationSha256 = sha(JSON.stringify({ generation: proof.generation, kinds: proof.kinds, candidates: proof.candidates, files: proof.files })); validateImportSourceArchiveProof(proof);
  const rows = objects.map(o => o.row), exceptions = new Map(objects.flatMap(o => o.runs.map((r, i) => [r.id, o.entry.kind === 'trade' && i === 0 ? [{ ordinal: '2' }, { ordinal: '3' }] : []]))), queries = [];
  const parameters = { host: '/tmp/gp-pg-recovery-unit', port: 55484 };
  const core = { connectionParameters: parameters, async query(sql, args) {
    queries.push({ domain: 'core', sql, args });
    if (sql.includes("current_setting('unix_socket_directories')")) return { rows: [{ socket: parameters.host, port: '55484', listen: '', domain: 'core' }] };
    if (sql.includes('FROM gp.data_import_sources')) return { rows: sql.includes('WHERE id=$1') ? rows.filter(row => row.id === args[0]) : rows };
    throw new Error('Unexpected synthetic Core query');
  } };
  let genericRuns = [], publications = [];
  const sales = { connectionParameters: parameters, async query(sql, args) {
    queries.push({ domain: 'sales', sql, args });
    if (sql.includes("current_setting('unix_socket_directories')")) return { rows: [{ socket: parameters.host, port: '55484', listen: '', domain: 'sales' }] };
    if (sql.includes('SELECT DISTINCT r.id')) return { rows: genericRuns };
    if (sql.includes('FROM integration.data_import_runs WHERE id=$1')) return { rows: objects.flatMap(o => o.runs).filter(run => run.id === args[0]) };
    if (sql.includes('FROM integration.data_import_rows WHERE run_id=$1')) return { rows: exceptions.get(args[0]) || [] };
    if (sql.includes('FROM trade.import_master_records')) return { rows: [] };
    if (sql.includes('FROM integration.import_history_records ORDER BY id')) return { rows: [] };
    if (sql.includes('FROM integration.import_history_snapshots')) return { rows: publications };
    throw new Error('Unexpected synthetic Sales query');
  } };
  const archive = { async verify() { return proof; }, async useFile(id, consume) { const source = objects.find(o => o.row.id === id), buffer = Buffer.from(source.buffer); try { return await consume({ buffer, password: '', source: source.entry }); } finally { buffer.fill(0); } } };
  return { objects, rows, proof, core, sales, archive, protection, exceptions, queries, setGenericRuns(value) { genericRuns = value; }, setPublications(value) { publications = value; } };
}

test('compact six-source plans bind original actors, profiles and counts, with only exception ranges', async () => {
  const f = fixture(); try {
    const plan = await real.createReplayPlan({ ...f, archiveProof: f.proof }); real.validateReplayPlan(plan, { archiveProof: f.proof });
    assert.equal(plan.sources.length, 6); assert.equal(plan.sources[0].kind, 'trade');
    assert.deepEqual(plan.sources[0].tables[0].exceptionRanges, [{ first: 2, last: 3 }]);
    assert.equal(plan.sources.find(s => s.kind === 'cash').strategy, 'cash-snapshot-plan');
    assert.ok(Buffer.byteLength(JSON.stringify(plan)) < 100000);
    for (const forbidden of ['payload', 'password', 'sourceValues', 'description']) assert.equal(JSON.stringify(plan).includes('"' + forbidden + '"'), false);
    assert.ok(f.queries.filter(q => q.sql.includes('data_import_rows')).every(q => q.sql.includes("state NOT IN ('applied','unchanged','duplicate')")));
  } finally { f.protection.destroy(); }
});

test('obsolete and pending nonarchived Core source headers stay opaque rather than becoming replay obligations', async () => {
  const f = fixture({ kinds: ['trade'] }); try {
    for (const status of ['ready', 'applied', 'reverted']) {
      const id = sha('obsolete-' + status), data = { kind: 'trade', complete: true, status };
      f.rows.push({ id, ...actor, revision: 1, createdAt: AT, updatedAt: AT, payload: f.protection.seal(data, ['source', actor.scopeId, actor.ownerId, id, 1]) });
    }
    const plan = await real.createReplayPlan({ ...f, archiveProof: f.proof }); assert.equal(plan.sources.length, 1);
  } finally { f.protection.destroy(); }
});

test('authentic retired sources are skipped before confirmed successors and never regain Apply time or active registry state', async () => {
  const f = fixture({ kinds: ['bestell'] });
  try {
    const next = f.objects[0], old = structuredClone(next); old.buffer = Buffer.from(next.buffer); old.buffer.write('retired', 512);
    const fileSha256 = sha(old.buffer), id = f.protection.digest(['source', actor, 'bestell', fileSha256]);
    old.data = { ...old.data, fileSha256, status: 'purged', progress: undefined,
      retirement: { successorId: next.row.id, startedAt: AT, complete: true, completedAt: AT } };
    delete old.data.progress;
    old.row = { ...old.row, id, updatedAt: '2026-11-17T12:00:00.000Z', payload: f.protection.seal(old.data, ['source', actor.scopeId, actor.ownerId, id, old.row.revision]) };
    old.entry = { ...old.entry, sourceId: id, fileSha256, file: sha('retired-cipher') + '.source' };
    f.objects.push(old); f.rows.push(old.row); f.proof.kinds.find(k => k.kind === 'bestell').previous = old.entry;
    f.proof.files.push({ file: old.entry.file, bytes: old.entry.bytes, sha256: sha(old.entry.file) });
    f.proof.generationSha256 = sha(JSON.stringify({ generation: f.proof.generation, kinds: f.proof.kinds, candidates: f.proof.candidates, files: f.proof.files }));
    const plan = await real.createReplayPlan({ ...f, archiveProof: f.proof });
    assert.equal(plan.sources[0].sourceId, id); assert.equal(plan.sources[0].strategy, 'skip-retired-obsolete');
    assert.equal(plan.sources[0].appliedAt, null); assert.equal(plan.sources[0].orderBasis, 'retirement-successor');
    assert.deepEqual(plan.sources[0].retirement, old.data.retirement);
    assert.equal(f.queries.filter(q => q.sql.includes('data_import_runs WHERE') && old.runs.some(run => run.id === q.args[0])).length, next.runs.length, 'only successor run evidence is queried');
    const originalOld = { ...old.row }, originalQuery = f.core.query.bind(f.core);
    f.core.query = async (sql, args) => {
      if (sql.startsWith('UPDATE gp.data_import_sources')) {
        assert.notEqual(args[0], id, 'retired Core provenance is not rewritten');
        const row = f.rows.find(row => row.id === args[0]); Object.assign(row, { revision: args[1], updatedAt: args[2], payload: args[3] }); return { rowCount: 1 };
      }
      return originalQuery(sql, args);
    };
    const subject = isolatedModule({ '../../../data-import-managed-protection': { loadManagedDataImportProtection: async () => f.protection },
      '../../repositories/data-import-runtime': { createDataImportRuntime: () => ({ sourceOperation: async () => ({ complete: true, status: 'applied', tables: [], catalogUpdatePending: false }), stop: async () => {} }) } });
    const result = await subject.replaySources({ ...f, plan, access: { transaction() {} }, vault: {}, isolatedRecovery: true });
    assert.deepEqual(result.sources[0], { sourceId: id, kind: 'bestell', strategy: 'skip-retired-obsolete', replayed: false, retirementPreserved: true });
    assert.deepEqual(old.row, originalOld);
  } finally { f.protection.destroy(); }
});

test('retirement without a confirmed complete successor cannot authorize source replay', async () => {
  const f = fixture({ kinds: ['bestell'] }); try {
    const old = f.objects[0]; old.data.status = 'purged'; old.data.retirement = { successorId: sha('absent-successor'), startedAt: AT, complete: true, completedAt: AT };
    old.row.payload = f.protection.seal(old.data, ['source', actor.scopeId, actor.ownerId, old.row.id, old.row.revision]);
    await assert.rejects(real.createReplayPlan({ ...f, archiveProof: f.proof }), { code: 'PG_SOURCE_REPLAY_RETIREMENT_SUCCESSOR' });
    old.data.retirement.complete = false; old.row.payload = f.protection.seal(old.data, ['source', actor.scopeId, actor.ownerId, old.row.id, old.row.revision]);
    await assert.rejects(real.createReplayPlan({ ...f, archiveProof: f.proof }), { code: 'PG_SOURCE_REPLAY_RETIREMENT_UNCONFIRMED' });
  } finally { f.protection.destroy(); }
});

test('confirmed archive/file/profile/run mismatches and plan tampering fail closed', async () => {
  const f = fixture({ kinds: ['trade'] }); try {
    const plan = await real.createReplayPlan({ ...f, archiveProof: f.proof });
    for (const patch of [{ planSha256: 'f'.repeat(64) }, { archiveGenerationSha256: 'f'.repeat(64) }, { sources: [] }]) assert.throws(() => real.validateReplayPlan({ ...plan, ...patch }, { archiveProof: f.proof }));
    f.objects[0].runs[0].manifest.fileSha256 = 'f'.repeat(64);
    await assert.rejects(real.createReplayPlan({ ...f, archiveProof: f.proof }), { code: 'PG_SOURCE_REPLAY_RUN_INTEGRITY' });
  } finally { f.protection.destroy(); }
});

test('a forged private runtime policy is rejected and live endpoints are refused before mutation', async () => {
  assert.throws(() => real.assertReplayRuntimePolicy({ namespace: real.FORMAT, isolatedRecovery: true }), { code: 'IMPORT_COMPOSITION_INVALID' });
  const f = fixture({ kinds: ['trade'] }); try {
    const subject = isolatedModule(); f.core.connectionParameters = { host: '127.0.0.1', port: 5432 };
    await assert.rejects(subject.replaySources({ ...f, access: { transaction() {} }, vault: {}, plan: {}, isolatedRecovery: true }), { code: 'PG_SOURCE_REPLAY_ISOLATION_REQUIRED' });
    assert.equal(f.queries.length, 0);
  } finally { f.protection.destroy(); }
});

test('legacy generic cash is planned independently of a compact Core dataset checkpoint', async () => {
  const f = fixture({ kinds: ['cash'] }); try {
    f.setGenericRuns(f.objects[0].runs.slice(0, 2));
    const plan = await real.createReplayPlan({ ...f, archiveProof: f.proof }), source = plan.sources[0];
    assert.equal(source.strategy, 'cash-snapshot-plan'); assert.equal(source.genericCash, true); assert.equal(source.genericCashBatches.length, 1);
    assert.deepEqual(source.genericCashBatches[0].tables.map(t => t.runId), f.objects[0].runs.slice(0, 2).map(r => r.id));
    real.validateReplayPlan(plan, { archiveProof: f.proof });
  } finally { f.protection.destroy(); }
});

test('a nonempty purged generic cash run cannot infer its lost original exceptions from an empty row query', async () => {
  const f = fixture({ kinds: ['cash'] }); try {
    const actual = structuredClone(f.objects[0].runs[0]); actual.status = 'purged'; actual.receivedCount = '1';
    actual.manifest.expectedRows = actual.manifest.declaredRows = 1;
    actual.id = f.protection.digest(['run', C.VERSION, actor, actual.profileHash, actual.manifest, actual.attemptId]);
    f.setGenericRuns([actual]);
    await assert.rejects(real.createReplayPlan({ ...f, archiveProof: f.proof }), { code: 'PG_SOURCE_REPLAY_EXCEPTIONS_REQUIRED' });
    assert.equal(f.queries.some(q => q.sql.includes('data_import_rows') && q.args[0] === actual.id), false);
  } finally { f.protection.destroy(); }
});

test('PostgreSQL replays generic cash histories without changing the compact Core source registry', nativeImport, () => withImportFixture(async ({provider, sales, vault, protection}) => {
  const f = fixture({ kinds: ['cash'], protection }), source = f.objects[0], date = '2026-11-16T12:00:00.000';
  const values = { KassenJournal: [{ Vorgang: 1, Filiale: 18, Datum: date }], Umsatz_KASSE: [{ Bonnr: 1, Filialid: 18, Kassenid: 1, Bondatum: date }],
    Umsatz_Kasse_Details: [{ RepID: '00000000-0000-0000-0000-000000000001', Bonnr: 1, Filialid: 18, Kassenid: 1, Bondatum: date, EAN: '0000000000042', VKMenge: 1, VK_Preis: 12 }] };
  const defs = S.definitions('cash');
  const generic = source.runs.filter(run => defs.some(def => def.profile.fingerprint === run.profileHash && values[def.name])).map(run => {
    const manifest = { ...run.manifest, expectedRows: 1, declaredRows: 1 };
    const originalActor = { ...actor, ownerId: '00009' };
    return { ...run, ...originalActor, manifest, receivedCount: '1', id: protection.digest(['run', C.VERSION, originalActor, run.profileHash, manifest, 'default']) };
  }); f.setGenericRuns(generic);
  const subject = isolatedModule({ '../../../tradefoto-full-import-source': { ...S, readTradeFotoFullSource: options => S.readTradeFotoFullSource({ ...options, readerFactory: () => ({
    getTableNames: () => defs.map(def => def.name), getTable(name) { const def = defs.find(def => def.name === name), rows = values[name] || [];
      return { rowCount: rows.length, getColumnNames: () => def.columns.map(c => c.name), getColumns: () => def.columns,
        getData: ({ columns, rowOffset = 0, rowLimit = Infinity }) => rows.slice(rowOffset, rowOffset + rowLimit).map(row => Object.fromEntries(columns.map(column => [column, row[column] ?? (def.columns.find(c => c.name === column).type === 'boolean' ? false : null)]))) }; },
  }) }) } });
  const plan = await subject.createReplayPlan({ ...f, archiveProof: f.proof }), before = source.row.payload;
  const result = await subject.replaySources({ ...f, access: provider, vault, plan, isolatedRecovery: true });
  assert.equal(result.verified, true); assert.equal(result.cashPending, true); assert.equal(result.sources[0].genericCashRuns.length, 3);
  assert.ok(result.sources[0].genericCashRuns.every(run => run.status === 'applied' && run.receivedRows === 1 && !generic.some(original => original.id === run.runId)));
  assert.equal((await first(sales, "SELECT count(*)::integer n FROM integration.import_history_records")).n, 3);
  assert.equal((await first(sales, "SELECT count(*)::integer n FROM integration.import_history_versions")).n, 3);
  assert.ok((await read(sales, "SELECT attempt_id FROM integration.data_import_runs")).every(row => row.attempt_id.startsWith('recovery-')));
  assert.ok((await read(sales, "SELECT owner_id FROM integration.data_import_runs")).every(row => row.owner_id === '00009'), 'an archived identical file does not change the original generic run owner');
  assert.equal(source.row.payload, before); assert.ok(f.queries.every(query => !query.sql.startsWith('UPDATE gp.data_import_sources')));
}));

async function ordinaryTradeReplayFixture({provider, core, sales, vault, protection}, differingStock) {
  const f = fixture({ kinds: ['trade'], protection }), source = f.objects[0], defs = S.definitions('trade'), M = require('../lib/tradefoto-master-profiles');
  const values = { ADANREDE: Array.from({ length: 4 }, (_, i) => ({ ANREDE: 'A' + (i + 1), ADR_ANREDE: 'Source label ' + (i + 1) })),
    FILIALEN: [{ FilialID: 18, FName: 'Incoming source branch' }],
    ARTIKEL_FILIALEN: [{ EAN: '0000000000042', FilialID: 18, FBestand: 5 }],
    ARTIKEL_STAMM: ['42', '43'].map(n => ({ EAN: n.padStart(13, '0'), Artikelbezeichnung: 'Source article ' + n, MWST: 1,
      'Änderungsdatum': new Date(AT), Verkaufspreis: 12, eNvk: 10 })) };
  for (let i = 0; i < source.runs.length; i++) {
    const def = defs[i], run = source.runs[i], count = values[def.name]?.length || 0;
    run.manifest = { ...run.manifest, expectedRows: count, declaredRows: count }; run.receivedCount = String(count);
    run.id = protection.digest(['run', C.VERSION, actor, run.profileHash, run.manifest, 'default']);
    source.data.tables[i] = { name: def.name, profileHash: def.profile.fingerprint, declaredRows: count, run: { id: run.id, expectedRows: count, receivedRows: count, status: 'applied' } };
    await sales.query("INSERT INTO integration.data_import_runs (id,scope_id,owner_id,attempt_id,profile_hash,profile,manifest,status,revision,received_count,created_at,updated_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [run.id, actor.scopeId, actor.ownerId, 'default', run.profileHash, JSON.stringify(def.profile), JSON.stringify(run.manifest), 'applied', 99, count, AT, AT, '2026-12-16T12:00:00.000Z']);
  }
  source.row.payload = protection.seal(source.data, ['source', actor.scopeId, actor.ownerId, source.row.id, source.row.revision]);
  await core.query("INSERT INTO gp.data_import_sources (id,scope_id,owner_id,revision,created_at,updated_at,payload) VALUES($1,$2,$3,$4,$5,$6,$7)", [source.row.id, actor.scopeId, actor.ownerId, source.row.revision, AT, AT, source.row.payload]);
  f.exceptions.clear(); f.exceptions.set(source.runs[0].id, [{ ordinal: '2' }, { ordinal: '3' }]);
  const catalog = require('../lib/persistence/repositories/sales-article-catalog').createSalesArticleCatalogRepository(provider);
  await catalog.createManual({ actor: actor.ownerId, timestamp: AT, mutationId: crypto.randomUUID(), input: { articleNumber: '000042', description: 'GP manual article', identifiers: [],
    prices: { sales: [{ priceType: 'sales', amount: '99.87', currency: 'EUR', priceBasis: 'gross' }] } } });
  const manual = await catalog.getByArticleNumber('000042'), imageBytes = Buffer.from('synthetic protected image bytes');
  const images = require('../lib/persistence/repositories/sales-article-images').createSalesArticleImagesRepository(provider);
  await images.save({ articleNumber: '000042', productId: manual.productId, expectedRevision: null, image: { buffer: imageBytes, mime: 'image/webp', width: 1, height: 1 }, actor: actor.ownerId });
  const article = { sourceArticleKey: '0000000000043', articleNumber: '000043', description: 'Old imported description', active: true, sourceUpdatedAt: null, identifiers: [], prices: [] };
  const domain = require('../lib/sales-article-catalog'), normalized = domain.normalizeSalesArticleImportRow(article), originalSnapshot = { sourceSystem: 'tradefoto.artikel_stamm', sourceProfileVersion: 'original-synthetic-v1',
    sourceSchemaSha256: 'a'.repeat(64), sourceFileSha256: source.entry.fileSha256, contentSha256: domain.salesArticleImportContentSha256([normalized]), snapshotAt: AT, articles: [normalized] };
  const imported = await catalog.importSnapshot({ snapshot: originalSnapshot, actor: actor.ownerId, timestamp: AT });
  const pureProduct = await catalog.getByArticleNumber('000043');
  const location = defs.find(def => def.name === 'FILIALEN'), rawAnchor = Object.fromEntries(location.columns.map(column => [column.name, column.name === 'FilialID' ? 18 : column.name === 'FName' ? 'GP owned branch label' : column.type === 'boolean' ? false : null]));
  const normalizedAnchor = C.normalizeDataImportRow(location.profile, M.prepareTradeFotoMasterRow(location.name, rawAnchor));
  const anchorId = crypto.randomUUID(), writer = require('../lib/persistence/repositories/import-master-data').createImportMasterWriters({ protection })[location.profile.entity];
  await provider.transaction(tx => writer.create(tx, { id: anchorId, data: normalizedAnchor.data }, { ...actor, sourceInstance: 'tradefoto-trade', sourceTable: location.name,
    sourceSystem: location.profile.sourceSystem, profileHash: location.profile.fingerprint, at: AT }), { isolation: 'serializable' });
  const mapping = require('../lib/persistence/repositories/import-master-data').createImportMasterService({ access: provider, protection, getActor: () => actor, authorize: () => true, sourceInstance: 'tradefoto-trade' });
  const mappingInput = { recordId: anchorId, expectedSourceRevision: 1, targetId: '18', historical: false, reason: 'Synthetic GP decision' }, preview = await mapping.previewBinding(mappingInput);
  await mapping.bind(mappingInput, preview.planHash);
  // A held AF head depends on the retained master identities too. Create its
  // exact source master and original published membership before sparse replay.
  const articleDef = defs.find(def => def.name === 'ARTIKEL_STAMM'), rawArticle = Object.fromEntries(articleDef.columns.map(column => [column.name, values.ARTIKEL_STAMM[0][column.name] ?? (column.type === 'boolean' ? false : null)]));
  const articleMasterData = C.normalizeDataImportRow(articleDef.profile, M.prepareTradeFotoMasterRow(articleDef.name, rawArticle)).data;
  await provider.transaction(tx => require('../lib/persistence/repositories/import-master-data').createImportMasterWriters({ protection })[articleDef.profile.entity].create(tx,
    { id: crypto.randomUUID(), data: articleMasterData }, { ...actor, sourceInstance: 'tradefoto-trade', sourceTable: articleDef.name, sourceSystem: articleDef.profile.sourceSystem, profileHash: articleDef.profile.fingerprint, at: AT }), { isolation: 'serializable' });
  const stockDef = defs.find(def => def.name === 'ARTIKEL_FILIALEN'), H = require('../lib/tradefoto-history-profiles'), stockRaw = Object.fromEntries(stockDef.columns.map(column => [column.name, values.ARTIKEL_FILIALEN[0][column.name] ?? (column.type === 'boolean' ? false : null)]));
  const stockData = C.normalizeDataImportRow(stockDef.profile, H.prepareTradeFotoHistoryRow('trade', stockDef.name, stockRaw, { fileSha256: source.entry.fileSha256, rowNumber: 1 })).data;
  const stockRun = source.runs.find(run => run.profileHash === stockDef.profile.fingerprint), stockContext = { ...actor, sourceInstance: 'tradefoto-trade', sourceTable: stockDef.name,
    sourceSystem: stockDef.profile.sourceSystem, profileHash: stockDef.profile.fingerprint, fileSha256: source.entry.fileSha256, snapshotAt: AT, at: AT, runId: stockRun.id, expectedRows: 1 };
  const stockWriter = require('../lib/persistence/repositories/import-history').createImportHistoryWriters({ protection, authorize: () => true, resolveMasterSourceInstance: () => 'tradefoto-trade' })[stockDef.profile.entity];
  const stockTarget = await provider.transaction(tx => stockWriter.create(tx, { id: crypto.randomUUID(), data: stockData }, stockContext), { isolation: 'serializable' });
  await provider.transaction(async tx => {
    const snapshots = require('../lib/persistence/repositories/import-history-snapshots').createHistorySnapshots({ protection });
    await snapshots.recordRows(tx, [{ rowNumber: 1, target: stockTarget }], stockContext); await snapshots.finish(tx, stockContext);
  }, { isolation: 'serializable' });
  if (differingStock) {
    const changed = { ...stockData, [stockDef.profile.fields.find(field => field.source === 'FBestand').target]: '999' };
    await provider.transaction(tx => stockWriter.update(tx, { id: stockTarget.id, expectedRevision: stockTarget.revision, data: changed }, stockContext), { isolation: 'serializable' });
  }
  const stockPublication = await first(sales, 'SELECT run_id AS "runId",scope_id AS "scopeId",source_instance AS "sourceInstance",profile_hash AS "profileHash",file_sha256 AS "fileSha256",snapshot_at AS "snapshotAt",owner_id AS "ownerId",expected_rows::integer AS "expectedRows",status,payload FROM integration.import_history_snapshots');
  f.setPublications([stockPublication]);
  const inheritedStock = () => first(sales, 'SELECT * FROM integration.import_history_records WHERE id=$1', [stockTarget.id]);
  const stockBefore = await inheritedStock();
  const ownRows = () => Promise.all(['import_master_records', 'import_master_segments', 'import_master_bindings', 'import_master_events'].map(table =>
    read(sales, 'SELECT * FROM trade.' + table + ' WHERE ' + (table === 'import_master_records' ? 'id' : 'record_id') + '=$1 ORDER BY to_jsonb(' + table + ')::text', [anchorId])));
  const before = await ownRows(), manualBefore = await catalog.getByArticleNumber('000042'), imageBefore = await images.metadata('000042');
  const oldCore = f.core.query.bind(f.core); f.core.query = async (sql, args) => {
    if (sql.includes('FROM gp.data_import_sources') || sql.startsWith('UPDATE gp.data_import_sources')) return core.query(sql, args);
    return oldCore(sql, args);
  };
  const oldSales = f.sales.query.bind(f.sales); f.sales.query = async (sql, args) =>
    sql.includes('FROM trade.import_master_records') || sql.includes('FROM integration.import_history_records ORDER BY id')
      ? sales.query(sql, args) : oldSales(sql, args);
  const reader = options => S.readTradeFotoFullSource({ ...options, readerFactory: () => ({ getTableNames: () => defs.map(def => def.name), getTable(name) {
    const def = defs.find(def => def.name === name), rows = values[name] || [];
    return { rowCount: rows.length, getColumnNames: () => def.columns.map(c => c.name), getColumns: () => def.columns,
      getData: ({ columns, rowOffset = 0, rowLimit = Infinity }) => rows.slice(rowOffset, rowOffset + rowLimit).map(row => Object.fromEntries(columns.map(column => [column, row[column] ?? (def.columns.find(c => c.name === column).type === 'boolean' ? false : null)]))) };
  } }) });
  let trustedRuntime;
  const subject = isolatedModule({ '../../../tradefoto-full-import-source': { ...S, readTradeFotoFullSource: reader },
    '../../repositories/data-import-runtime': { createDataImportRuntime: options => trustedRuntime.createDataImportRuntime(options) } });
  const runtimeFile = path.resolve(__dirname, '../lib/persistence/repositories/data-import-runtime.js'), runtimeModule = new Module(runtimeFile, module); runtimeModule.filename = runtimeFile; runtimeModule.paths = Module._nodeModulePaths(path.dirname(runtimeFile));
  const originalRequire = runtimeModule.require.bind(runtimeModule); runtimeModule.require = name => name === '../postgresql/operations/access-source-replay' ? subject : originalRequire(name);
  runtimeModule._compile(fs.readFileSync(runtimeFile, 'utf8'), runtimeFile); trustedRuntime = runtimeModule.exports;
  const plan = await subject.createReplayPlan({ ...f, archiveProof: f.proof });
  if (differingStock) {
    await assert.rejects(subject.replaySources({ ...f, access: provider, vault, plan, isolatedRecovery: true }), { code: 'PG_SOURCE_REPLAY_STOCK_PUBLICATION_REQUIRED' });
    assert.deepEqual((await first(sales, "SELECT * FROM integration.import_history_records WHERE id=$1", [stockTarget.id])), stockBefore);
    assert.deepEqual(await catalog.getByArticleNumber('000042'), manualBefore); return;
  }
  const result = await subject.replaySources({ ...f, access: provider, vault, plan, isolatedRecovery: true });
  assert.equal(result.verified, true); assert.equal(result.sources[0].catalog.complete, true); assert.equal(result.sources[0].catalog.blocked, 1);
  assert.equal(result.sources[0].exceptionIdentities, 2); assert.equal(result.sources[0].preservedAnchorIdentities, 1);
  assert.deepEqual(await ownRows(), before); assert.deepEqual(await catalog.getByArticleNumber('000042'), manualBefore); assert.deepEqual(await images.metadata('000042'), imageBefore);
  const image = await images.content('000042'); assert.deepEqual(image.buffer, imageBytes);
  const recovered = await catalog.getByArticleNumber('000043'); assert.equal(recovered.productId, pureProduct.productId); assert.equal(recovered.description, 'Source article 43'); assert.ok(recovered.prices.some(price => price.amount === '12.000000000000'));
  assert.ok((await read(sales, "SELECT source_profile_version FROM trade.sales_article_import_snapshots")).some(snapshot => snapshot.source_profile_version.startsWith('recovery-v1.')));
  assert.ok((await read(sales, "SELECT issue FROM integration.data_import_rows WHERE issue LIKE 'RECOVERY_%'")).some(row => row.issue === 'RECOVERY_PRESERVED_GP_ANCHOR'));
  assert.ok((await read(sales, "SELECT attempt_id FROM integration.data_import_runs")).some(run => run.attempt_id.startsWith('recovery-')));
  assert.equal(result.stockPublications.length, 1); assert.equal(result.stockPublications[0].verified, true); assert.equal(result.stockPublications[0].expectedRows, 1);
  assert.deepEqual((await first(sales, "SELECT * FROM integration.import_history_records WHERE id=$1", [stockTarget.id])), stockBefore);
  await assert.rejects(subject.replaySources({ ...f, access: provider, vault, plan, isolatedRecovery: true }), { code: 'PG_SOURCE_REPLAY_RESTART_FROM_BUNDLE' });
}
test('ordinary Trade replay preserves GP anchors/manual content and rebuilds an unchanged held AF publication', nativeImport, () => withImportFixture(pg => ordinaryTradeReplayFixture(pg, false)));
test('a differing held AF head cannot falsely complete replay with its latest stock publication missing', nativeImport, () => withImportFixture(pg => ordinaryTradeReplayFixture(pg, true)));
