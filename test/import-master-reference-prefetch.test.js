'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../lib/data-import-contract'), M = require('../lib/tradefoto-master-profiles');
const Q = require('../lib/persistence/repositories/import-reader-cache');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { createImportMasterWriters, createImportMasterService, createImportMasterReferenceReader } = require('../lib/persistence/repositories/import-master-data');
const { IMPORT_MASTER_STATEMENTS: S } = require('../lib/persistence/statements/import-master-data');
const { IMPORT_READER_BATCHES: B } = require('../lib/persistence/statements/import-reader-batches');
const { createSalesArticleCatalogRepository } = require('../lib/persistence/repositories/sales-article-catalog');
const { salesArticleImportContentSha256 } = require('../lib/sales-article-catalog');
const { TRADEFOTO_ARTICLE_SOURCE_SYSTEM } = require('../lib/tradefoto-article-source-profile');
const TIME = '2026-10-15T00:00:00.000Z', SHA = 'a'.repeat(64);
const batch = statement => B.find(entry => entry.source === statement).batch;
const code = expected => error => error?.code === expected;

// SQLite executes each registered source query to emulate packet transport.
// The native case below measures actual PostgreSQL packets with the same assertions.
function traced(tx, { native = false, references = true, transform = row => row } = {}) {
  const counts = new Map(), sizes = new Map();
  const count = statement => counts.set(statement.id, (counts.get(statement.id) || 0) + 1);
  const read = async (statement, parameters) => {
    const value = await tx[statement.operation](statement, parameters);
    return statement === S.articleBySource ? transform(value, parameters) : value;
  };
  const measured = {
    async queryOne(statement, parameters) { count(statement); return read(statement, parameters); },
    async queryAll(statement, parameters) {
      count(statement);
      const entry = B.find(item => item.batch === statement);
      if (!entry || native) return tx.queryAll(statement, parameters);
      sizes.set(statement.id, parameters.requests.length);
      const rows = [];
      for (const [index, request] of parameters.requests.entries()) {
        const result = await read(entry.source, request);
        for (const row of entry.source.operation === 'queryOne' ? result ? [result] : [] : result)
          rows.push({ batchOrdinal: index + 1, ...row });
      }
      return rows;
    },
  };
  Q.start(measured, references);
  return { tx: measured, counts, sizes };
}

async function seed(access, protection, count) {
  const context = { scopeId: 'synthetic-refs', ownerId: '00001', sourceInstance: 'tradefoto-trade' };
  const profile = M.profileFor('ARTIKEL_STAMM');
  const writer = createImportMasterWriters({ protection })[profile.entity];
  const service = createImportMasterService({ access, protection, authorize: () => true,
    getActor: () => ({ scopeId: context.scopeId, ownerId: context.ownerId }), clock: () => TIME });
  const articles = Array.from({ length: count }, (_, i) => ({ sourceArticleKey: String(i + 1).padStart(13, '0'),
    articleNumber: String(i + 1).padStart(6, '0'), description: 'Synthetic reference ' + i,
    active: true, sourceUpdatedAt: null, identifiers: [], prices: [] }));
  await createSalesArticleCatalogRepository(access).importSnapshot({ snapshot: {
    sourceSystem: TRADEFOTO_ARTICLE_SOURCE_SYSTEM, sourceProfileVersion: 'synthetic.v1', sourceSchemaSha256: SHA,
    sourceFileSha256: SHA, snapshotAt: TIME, articles, contentSha256: salesArticleImportContentSha256(articles),
  }, actor: context.ownerId, timestamp: TIME });
  const bindings = [], requests = [];
  for (const [index, article] of articles.entries()) {
    const id = 'synthetic-reference-' + index;
    const data = C.normalizeDataImportRow(profile, M.prepareTradeFotoMasterRow('ARTIKEL_STAMM', {
      ...Object.fromEntries(M.tableFor('ARTIKEL_STAMM').columns.map(column => [column.name, null])),
      EAN: article.sourceArticleKey, Artikelbezeichnung: article.description,
    })).data;
    await access.transaction(tx => writer.create(tx, { id, data }, { ...context, at: TIME,
      profileHash: profile.fingerprint, sourceTable: profile.sourceTable, sourceSystem: profile.sourceSystem }));
    const input = { recordId: id, expectedSourceRevision: 1, historical: false, reason: 'Synthetic qualification' };
    await service.bind(input, (await service.previewBinding(input)).planHash);
    bindings.push(await access.queryOne(S.getBinding, { recordId: id }));
    requests.push({ table: 'ARTIKEL_STAMM', key: [article.sourceArticleKey] });
  }
  return { context, bindings, requests, protection, access };
}

async function fixture(t, count = 3) {
  const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
  const { SQLITE_IMPORT_MASTER_CATALOG } = require('../lib/persistence/sqlite/import-master-catalog');
  const { SQLITE_SALES_ARTICLE_CATALOG } = require('../lib/persistence/sqlite/sales-article-catalog-catalog');
  const { SQLITE_CRM_CUSTOMERS_CATALOG } = require('../lib/persistence/sqlite/crm-customers-catalog');
  const app = openSqliteApplicationPersistence({ databasePath: ':memory:', catalog: [...SQLITE_IMPORT_MASTER_CATALOG, ...SQLITE_SALES_ARTICLE_CATALOG, ...SQLITE_CRM_CUSTOMERS_CATALOG] });
  app.database.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity_type TEXT,entity_id TEXT,detail TEXT,created_at TEXT)');
  require('../lib/persistence/sqlite/operations/import-master-schema').ensureSqliteImportMasterSchema(app.database);
  require('../lib/persistence/sqlite/operations/sales-article-catalog-schema').ensureSqliteSalesArticleCatalogSchema(app.database);
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 8), indexKey: Buffer.alloc(32, 9), keyId: 'synthetic' });
  t.after(async () => { protection.destroy(); await app.provider.close(); app.database.close(); });
  return { ...app, ...await seed(app.provider, protection, count) };
}

async function assertPackets(f, native = false) {
  const reader = createImportMasterReferenceReader({ protection: f.protection, authorize: () => true });
  await f.access.transaction(async base => {
    const { tx, counts, sizes } = traced(base, { native });
    const repeated = [...f.requests, ...f.requests, ...f.requests];
    await reader.prefetch(tx, f.context, repeated);
    for (const request of repeated) {
      const result = await reader(tx, f.context, request.table, request.key);
      assert.equal(result.status, 'linked'); assert.equal(result.targetRevision, 1);
    }
    assert.equal(counts.get(batch(S.articleBySource).id), 1, 'One packet replaces every per-article target read');
    assert.equal(counts.get(S.articleBySource.id) || 0, 0);
    assert.equal(counts.get(batch(S.getBinding).id), 1);
    if (!native) assert.equal(sizes.get(batch(S.articleBySource).id), f.requests.length, 'Repeated keys are read only once');
  }, { readOnly: true });
}

test('Article reference prefetch deduplicates authenticated targets and retains source/binding revisions', async t => {
  await assertPackets(await fixture(t, 24));
});

test('Reference target permission must pass before any target packet and is rechecked after prefetch', async t => {
  const f = await fixture(t); let denied = f.bindings[1].targetId;
  const reader = createImportMasterReferenceReader({ protection: f.protection, authorize: value => value.targetId !== denied });
  await f.access.transaction(async base => {
    const { tx, counts } = traced(base);
    await assert.rejects(reader.prefetch(tx, f.context, f.requests), code('IMPORT_FORBIDDEN'));
    assert.equal(counts.get(batch(S.articleBySource).id) || 0, 0);
    assert.equal(counts.get(S.articleBySource.id) || 0, 0);
  }, { readOnly: true });
  denied = null;
  await f.access.transaction(async base => {
    const { tx } = traced(base); await reader.prefetch(tx, f.context, f.requests);
    denied = f.bindings[0].targetId;
    await assert.rejects(reader(tx, f.context, 'ARTIKEL_STAMM', f.requests[0].key), code('IMPORT_FORBIDDEN'));
  }, { readOnly: true });
});

for (const [title, sql, error] of [
  ['binding target', "UPDATE import_master_bindings SET target_id='forged' WHERE record_id=?", 'IMPORT_PROTECTED_PAYLOAD_INVALID'],
  ['binding namespace', "UPDATE import_master_bindings SET source_instance='forged' WHERE record_id=?", 'IMPORT_MASTER_INTEGRITY'],
  ['source namespace', "UPDATE import_master_records SET source_instance='forged' WHERE id=?", 'IMPORT_MASTER_INTEGRITY'],
  ['encrypted source', "UPDATE import_master_segments SET payload='forged' WHERE record_id=?", 'IMPORT_PROTECTED_PAYLOAD_INVALID'],
]) test('Article target prefetch rejects tampered ' + title + ' before reading targets', async t => {
  const f = await fixture(t, 1); f.database.prepare(sql).run(f.bindings[0].recordId);
  const reader = createImportMasterReferenceReader({ protection: f.protection, authorize: () => true });
  await f.access.transaction(async base => {
    const { tx, counts } = traced(base);
    await assert.rejects(reader.prefetch(tx, f.context, f.requests), code(error));
    assert.equal(counts.get(batch(S.articleBySource).id) || 0, 0);
  }, { readOnly: true });
});

test('Missing/inactive/reassigned article targets keep their blocking status; fresh transactions cannot reuse a target snapshot', async t => {
  const f = await fixture(t, 1), reader = createImportMasterReferenceReader({ protection: f.protection, authorize: () => true });
  for (const [transform, expected] of [
    [row => row, 'linked'], [() => null, 'target_missing'], [row => ({ ...row, active: false }), 'target_inactive'],
    [row => ({ ...row, id: 'different-product' }), 'target_missing'], [row => ({ ...row, revision: 2 }), 'linked'],
  ]) await f.access.transaction(async base => {
    const { tx, counts } = traced(base, { transform }); await reader.prefetch(tx, f.context, f.requests);
    const result = await reader(tx, f.context, 'ARTIKEL_STAMM', f.requests[0].key);
    assert.equal(result.status, expected); assert.equal(counts.get(batch(S.articleBySource).id), 1);
    if (result.targetRevision === 2) assert.equal(result.status, 'linked');
  }, { readOnly: true });
});

test('Legacy executors keep direct target lookup; missing sources and another scope never gain a binding', async t => {
  const f = await fixture(t), reader = createImportMasterReferenceReader({ protection: f.protection, authorize: () => true });
  await f.access.transaction(async base => {
    const { tx, counts } = traced(base, { references: false });
    await reader.prefetch(tx, f.context, f.requests);
    for (const request of f.requests) assert.equal((await reader(tx, f.context, request.table, request.key)).status, 'linked');
    assert.equal(counts.get(batch(S.articleBySource).id) || 0, 0); assert.equal(counts.get(S.articleBySource.id), 3);
  }, { readOnly: true });
  await f.access.transaction(async base => {
    const { tx, counts } = traced(base), other = { ...f.context, scopeId: 'other-scope' };
    await reader.prefetch(tx, other, f.requests);
    assert.equal((await reader(tx, other, 'ARTIKEL_STAMM', f.requests[0].key)).status, 'missing_source');
    assert.equal((await reader(tx, f.context, 'ARTIKEL_STAMM', ['missing-key'])).status, 'missing_source');
    assert.equal((await reader(tx, f.context, 'ARTIKEL_STAMM', null)).status, 'unassigned');
    assert.equal(counts.get(batch(S.articleBySource).id) || 0, 0);
  }, { readOnly: true });
});

test('Article reference packet is read-only Sales SQL; Core packet registration remains binding-only', () => {
  const sales = require('../lib/persistence/postgresql/sales/import-reader-batches').IMPORT_READER_BATCH_CATALOG;
  const core = require('../lib/persistence/postgresql/core/import-reader-batches').CORE_IMPORT_READER_BATCH_CATALOG;
  assert.deepEqual(core.map(entry => entry.statement), [batch(S.getBinding)]);
  const target = sales.find(entry => entry.statement === batch(S.articleBySource));
  assert.match(target.sql, /jsonb_array_elements\(\$1::jsonb\)/);
  assert.match(target.sql, /CROSS JOIN LATERAL/); assert.match(target.sql, /trade\."?sales_articles/);
  assert.doesNotMatch(target.sql, /\b(?:INSERT|UPDATE|DELETE)\b/i);
});

test('Native PostgreSQL: bound article references use a single real target packet in the production two-database facade', {
  skip: process.env.GP_PG_MIGRATION_LIVE !== '1',
}, async () => {
  const { withCoreFixture } = require('../test-support/postgresql-migration/core-fixture');
  const { withSalesFixture } = require('../test-support/postgresql-migration/sales-fixture');
  const { openTwoDatabaseDevelopmentApplication } = require('../lib/persistence/postgresql/boundary/application');
  await withCoreFixture(core => withSalesFixture(8, async sales => {
    await core.application.close(); await sales.application.close();
    const app = await openTwoDatabaseDevelopmentApplication({ coreUrl: process.env.GP_CORE_APP_URL,
      salesUrl: process.env.GP_SALES_APP_URL, stage: 8, authorize: () => true });
    try { await assertPackets(await seed(app.provider, sales.protection, 24), true); }
    finally { await app.provider.close(); }
  }));
});
