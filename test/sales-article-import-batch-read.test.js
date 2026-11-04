'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createPersistenceProviderFacade, PERSISTENCE_ERROR_CODES } = require('../lib/persistence/contract');
const { createSalesArticleCatalogRepository } = require('../lib/persistence/repositories/sales-article-catalog');
const { enableImportBatches } = require('../lib/persistence/repositories/import-batch-support');
const { IMPORT_READER_BATCHES } = require('../lib/persistence/statements/import-reader-batches');
const { SALES_ARTICLE_CATALOG_STATEMENTS: S } = require('../lib/persistence/statements/sales-article-catalog');
const { openSqliteApplicationPersistence, SQLITE_CAPABILITIES } = require('../lib/persistence/sqlite/provider');
const { SQLITE_SALES_ARTICLE_CATALOG } = require('../lib/persistence/sqlite/sales-article-catalog-catalog');
const { ensureSqliteSalesArticleCatalogSchema } = require('../lib/persistence/sqlite/operations/sales-article-catalog-schema');
const { salesArticleImportContentSha256 } = require('../lib/sales-article-catalog');
const { withSalesFixture } = require('../test-support/postgresql-migration/sales-fixture');
const TIME = '2026-10-15T12:00:00.000Z';
const batchSources = new Map(IMPORT_READER_BATCHES.map(({ source, batch }) => [batch, source]));
function gtin(key) {
  const digits = String(900000000000 + key);
  const sum = [...digits].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
  return digits + ((10 - sum % 10) % 10);
}
function article(key, overrides = {}) {
  return { sourceArticleKey: String(key), articleNumber: String(key).padStart(6, '0'),
    description: 'Synthetic article ' + key, active: true, sourceUpdatedAt: null,
    identifiers: [{ identifierValue: gtin(key), isPrimary: true, sourceField: 'EAN' }],
    prices: [{ priceType: 'sales', amount: '12.50', currency: 'EUR', priceBasis: 'gross',
      qualityStatus: 'confirmed', sourceField: 'Verkaufspreis' }], ...overrides };
}
function snapshot(articles, file = 'a') {
  return { sourceSystem: 'tradefoto', sourceProfileVersion: 'synthetic.v1', sourceSchemaSha256: 'b'.repeat(64),
    sourceFileSha256: file.repeat(64), contentSha256: salesArticleImportContentSha256(articles), snapshotAt: TIME, articles };
}
const mutation = input => ({ input, actor: 'synthetic-manager', timestamp: TIME, mutationId: crypto.randomUUID() });
const importSnapshot = (repo, value, extra = {}) => repo.importSnapshot({ snapshot: value, actor: 'synthetic-importer', timestamp: TIME, ...extra });

async function fixture(work) {
  const app = openSqliteApplicationPersistence({ databasePath: ':memory:', catalog: SQLITE_SALES_ARTICLE_CATALOG });
  app.database.exec(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,
    action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL)`);
  ensureSqliteSalesArticleCatalogSchema(app.database);
  const calls = [], transactions = [];
  let access = app.provider;
  const scalarRead = async (statement, parameters) => {
    const result = await access[statement.operation](statement, parameters);
    return statement.operation === 'queryOne' ? result ? [result] : [] : result;
  };
  // Exercise the real SQLite statements and repository semantics while emulating
  // packet transport. Only the opt-in native test below measures PostgreSQL SQL.
  const query = async (statement, parameters) => {
    calls.push(statement);
    const source = batchSources.get(statement);
    if (!source) return scalarRead(statement, parameters);
    const rows = [];
    for (const [index, request] of parameters.requests.entries()) {
      rows.push(...(await scalarRead(source, request)).map(row => ({ batchOrdinal: index + 1, ...row })));
    }
    return rows;
  };
  const execute = (statement, parameters) => {
    calls.push(statement); return access.execute(statement, parameters);
  };
  const packetProvider = createPersistenceProviderFacade({ providerId: 'sqlite', capabilities: SQLITE_CAPABILITIES,
    query, execute, close: async () => {},
    beginTransaction: async options => {
      transactions.push(options);
      let ready, finish;
      const bound = new Promise(resolve => { ready = resolve; });
      const done = new Promise(resolve => { finish = resolve; });
      const rolledBack = new Error('synthetic packet transaction rollback');
      const transaction = app.provider.transaction(async tx => {
        ready(tx);
        if (!await done) throw rolledBack;
      }, options);
      access = await Promise.race([bound, transaction]);
      const settle = async commit => {
        finish(commit);
        try { await transaction; } catch (error) { if (error !== rolledBack) throw error; }
        finally { access = app.provider; }
      };
      return { query, execute, commit: () => settle(true), rollback: () => settle(false) };
    } });
  enableImportBatches(packetProvider);
  try {
    await work({ scalar: createSalesArticleCatalogRepository(app.provider), batch: createSalesArticleCatalogRepository(packetProvider),
      packetProvider, database: app.database, calls, transactions });
  } finally { await packetProvider.close(); await app.provider.close(); app.database.close(); }
}

test('Article inspection packets preserve scalar decisions and state hashes with five reads for 40 unchanged articles', () => fixture(async f => {
  const value = snapshot(Array.from({ length: 40 }, (_, i) => article(i + 1)));
  await importSnapshot(f.scalar, value);
  const scalar = await f.scalar.inspectImportSnapshot({ snapshot: value });
  f.calls.length = 0;
  assert.deepEqual(await f.batch.inspectImportSnapshot({ snapshot: value }), scalar);
  assert.ok(scalar.rows.every(row => row.action === 'unchanged'));
  assert.equal(f.calls.length, 5);
  assert.ok(f.calls.every(statement => batchSources.has(statement)));
  assert.deepEqual(f.transactions.at(-1), { isolation: 'serializable', readOnly: true });
  // The unified import creates its repository from a marked bound executor.
  f.calls.length = 0;
  const bound = await f.packetProvider.transaction(tx => {
    enableImportBatches(tx);
    return createSalesArticleCatalogRepository(tx).inspectImportSnapshot({ snapshot: value });
  }, { isolation: 'serializable' });
  assert.deepEqual(bound, scalar);
  assert.equal(f.calls.length, 5);
  // A subsequent call must see a changed revision, price and identifier state.
  await importSnapshot(f.scalar, snapshot([article(1, { description: 'Changed after first inspection',
    identifiers: [], prices: [{ ...article(1).prices[0], amount: '19' }] })], 'c'));
  const fresh = await f.batch.inspectImportSnapshot({ snapshot: value });
  assert.deepEqual(fresh, await f.scalar.inspectImportSnapshot({ snapshot: value }));
  assert.notEqual(fresh.stateSha256, scalar.stateSha256);
  assert.equal(fresh.rows[0].action, 'update');
}));

test('Article packets retain manual, archived, source/number, identifier and inactive conflicts', () => fixture(async f => {
  await importSnapshot(f.scalar, snapshot([1, 2, 4, 5, 6, 9].map(key => article(key))));
  await f.scalar.createManual(mutation({ articleNumber: article(3).articleNumber, description: 'Manual owner', identifiers: [] }));
  await f.scalar.archiveManual(mutation({ articleNumber: article(4).articleNumber, expectedRevision: 1 }));
  const value = snapshot([article(1), article(2, { description: 'Updated' }), article(3), article(4),
    article(5, { articleNumber: article(6).articleNumber }), article(7),
    article(8, { identifiers: article(9).identifiers }), article(10, { active: false })], 'c');
  const scalar = await f.scalar.inspectImportSnapshot({ snapshot: value });
  const batched = await f.batch.inspectImportSnapshot({ snapshot: value });
  assert.deepEqual(batched, scalar);
  assert.deepEqual(batched.rows.map(row => row.action), ['unchanged', 'update', 'blocked', 'blocked', 'blocked', 'create', 'blocked', 'blocked']);
  for (const [index, issue] of [[2, 'manual_head'], [3, 'archived_head'], [4, 'number_source_conflict'], [6, 'gtin_conflict'], [7, 'inactive_import']]) {
    assert.ok(batched.rows[index].issueCodes.includes(issue));
  }
}));

test('Article commit re-inspects fresh state and keeps write lookups outside the inspection cache', () => fixture(async f => {
  const value = snapshot([article(1)]);
  const preview = await f.batch.inspectImportSnapshot({ snapshot: value });
  f.calls.length = 0;
  await importSnapshot(f.batch, value, { expectedStateSha256: preview.stateSha256 });
  assert.ok(f.calls.includes(S.getArticleBySource) && f.calls.includes(S.getArticleByNumber), 'Persistence must perform its own current head reads');
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM sales_article_revisions').get().n, 1);
  const changed = snapshot([article(1, { description: 'Incoming update' })], 'c');
  const reviewed = await f.batch.inspectImportSnapshot({ snapshot: changed });
  assert.equal(reviewed.rows[0].action, 'update');
  await f.scalar.archiveManual(mutation({ articleNumber: article(1).articleNumber, expectedRevision: 1 }));
  const before = f.database.prepare('SELECT * FROM sales_article_revisions ORDER BY product_id,revision').all();
  await assert.rejects(importSnapshot(f.batch, changed, { expectedStateSha256: reviewed.stateSha256 }),
    error => error.code === PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION);
  assert.deepEqual(f.database.prepare('SELECT * FROM sales_article_revisions ORDER BY product_id,revision').all(), before);
  const fresh = await f.batch.inspectImportSnapshot({ snapshot: changed });
  assert.notEqual(fresh.stateSha256, reviewed.stateSha256);
  assert.ok(fresh.rows[0].issueCodes.includes('archived_head'));
}));

test('Native PostgreSQL article inspection uses five SQL packets and preserves scalar state',
  { skip: process.env.GP_PG_MIGRATION_LIVE !== '1' }, () => withSalesFixture(8, async f => {
    const repo = createSalesArticleCatalogRepository(f.postgres);
    const value = snapshot(Array.from({ length: 40 }, (_, i) => article(i + 1)));
    await importSnapshot(repo, value);
    const scalar = await f.postgres.transaction(tx => createSalesArticleCatalogRepository(tx).inspectImportSnapshot({ snapshot: value }),
      { isolation: 'serializable', readOnly: true });
    const { Client } = require('pg'), original = Client.prototype.query, queries = [];
    Client.prototype.query = function (...args) { queries.push(typeof args[0] === 'string' ? args[0] : args[0]?.text || ''); return original.apply(this, args); };
    let inspected;
    try { inspected = await repo.inspectImportSnapshot({ snapshot: value }); }
    finally { Client.prototype.query = original; }
    assert.deepEqual(inspected, scalar);
    assert.ok(inspected.rows.every(row => row.action === 'unchanged'));
    assert.equal(queries.filter(sql => sql.includes('AS "batchOrdinal"')).length, 5);
    await repo.archiveManual(mutation({ articleNumber: article(1).articleNumber, expectedRevision: 1 }));
    const fresh = await repo.inspectImportSnapshot({ snapshot: value });
    assert.notEqual(fresh.stateSha256, scalar.stateSha256);
    assert.ok(fresh.rows[0].issueCodes.includes('archived_head'));
  }));
