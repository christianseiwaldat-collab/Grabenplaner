'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { ARTICLE_BRANCH_ORDER_STATEMENTS: S } = require('../lib/persistence/statements/sales-article-branch-orders');
const { ARTICLE_BRANCH_ORDERS_CATALOG: sqliteCatalog } = require('../lib/persistence/sqlite/sales-article-branch-orders-catalog');
const { IMPORT_HISTORY_STATEMENTS: H } = require('../lib/persistence/statements/import-history');
const { IMPORT_MASTER_STATEMENTS: M } = require('../lib/persistence/statements/import-master-data');
const scopeId = 'synthetic-branch-orders', articleMaster = 'synthetic-article', at = '2026-10-05T00:00:00.000Z';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function seed(access) {
  await access.transaction(async tx => {
    for (const id of [articleMaster, 'other-article']) await tx.execute(M.insert, { id, scopeId,
      sourceInstance: 'tradefoto-trade', sourceTable: 'ARTIKEL_STAMM', profileHash: digest('profile'), identityHash: digest(id),
      revision: 1, updatedBy: 'synthetic-owner', updatedAt: at });
    for (const row of [
      { id: 'a-detail' }, { id: 'b-distribution', table: 'BestellVerteilung', snapshot: 'older-source' },
      { id: 'c-old-reference', revision: 2, refRevision: 1 }, { id: 'd-other-scope', scope: 'other-scope' },
      { id: 'e-other-instance', instance: 'tradefoto-trade' }, { id: 'f-other-table', table: 'BESTELLKORB' },
      { id: 'g-other-article', master: 'other-article' }, { id: 'h-unresolved', master: null },
      { id: 'i-wrong-role', role: 'set_article' }, { id: 'j-other-source', source: 'cash' },
    ]) {
      const revision = row.revision || 1;
      await tx.execute(H.insert, { id: row.id, scopeId: row.scope || scopeId,
        sourceInstance: row.instance || 'tradefoto-bestell', source: row.source || 'trade',
        sourceTable: row.table || 'BESTELLDETAILS', profileHash: digest('profile'), identityHash: digest(row.id), revision });
      for (let current = 1; current <= revision; current++) {
        await tx.execute(H.insertVersion, { recordId: row.id, revision: current, fileSha256: digest(row.snapshot || 'source'),
          snapshotAt: at, importedBy: 'synthetic-owner', importedAt: at, runId: 'synthetic-run',
          masterSourceInstance: 'tradefoto-trade', businessDate: null, parentId: null, parentRevision: null, payload: 'synthetic-version' });
        for (const dataClass of ['internal_business', 'customer_restricted', 'catalog_costs']) await tx.execute(H.insertSegment,
          { recordId: row.id, revision: current, dataClass, payload: dataClass + ':' + row.id + ':' + current });
      }
      await tx.execute(H.insertReference, { recordId: row.id, revision: row.refRevision || revision,
        role: row.role || 'article', dataClass: 'internal_business',
        masterRecordId: Object.hasOwn(row, 'master') ? row.master : articleMaster, lookupHash: null });
    }
  });
}

async function check(access) {
  const query = overrides => access.queryAll(S.candidates, { scopeId, articleMaster, limit: 401, ...overrides });
  assert.deepEqual(await query(), [{ id: 'a-detail', revision: 1 }, { id: 'b-distribution', revision: 1 }]);
  assert.deepEqual(await query({ limit: 1 }), [{ id: 'a-detail', revision: 1 }]);
  assert.deepEqual(await query({ articleMaster: 'absent' }), []);
  for (const limit of [-1, 0, 402, Number.MAX_SAFE_INTEGER]) assert.deepEqual(await query({ limit }), []);
  assert.deepEqual(await access.queryAll(S.internalSegments, { requests: [
    { recordId: 'c-old-reference', revision: 2 }, { recordId: 'missing', revision: 1 },
    { recordId: 'a-detail', revision: 1 }, { recordId: 'c-old-reference', revision: 1 },
  ] }), [
    { batchOrdinal: 1, recordId: 'c-old-reference', revision: 2, dataClass: 'internal_business', payload: 'internal_business:c-old-reference:2' },
    { batchOrdinal: 3, recordId: 'a-detail', revision: 1, dataClass: 'internal_business', payload: 'internal_business:a-detail:1' },
    { batchOrdinal: 4, recordId: 'c-old-reference', revision: 1, dataClass: 'internal_business', payload: 'internal_business:c-old-reference:1' },
  ]);
  assert.deepEqual(await access.queryAll(S.internalSegments, { requests: [] }), []);
}

test('article branch order SQL isolates source, article, current revision and internal segments in SQLite', async t => {
  const app = require('../lib/persistence/sqlite/provider').openSqliteApplicationPersistence({ databasePath: ':memory:',
    catalog: require('../lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG });
  require('../lib/persistence/sqlite/operations/import-master-schema').ensureSqliteImportMasterSchema(app.database);
  require('../lib/persistence/sqlite/operations/import-history-schema').ensureSqliteImportHistorySchema(app.database);
  t.after(async () => { await app.provider.close(); app.database.close(); });
  await seed(app.provider); await check(app.provider);
  const plan = app.database.prepare('EXPLAIN QUERY PLAN ' + sqliteCatalog[0].sql)
    .all({ scopeId, articleMaster, limit: 401 }).map(row => row.detail).join('\n');
  assert.match(plan, /SEARCH q USING COVERING INDEX import_history_reference_master \(master_record_id=\? AND role=\?\)/);
  assert.doesNotMatch(plan, /SCAN r\b/);
  const segmentPlan = app.database.prepare('EXPLAIN QUERY PLAN ' + sqliteCatalog[1].sql)
    .all({ requests: JSON.stringify([{ recordId: 'a-detail', revision: 1 }]) }).map(row => row.detail).join('\n');
  assert.match(segmentPlan, /SEARCH s USING INDEX [^\n]*\(record_id=\? AND revision=\? AND data_class=\?\)/);
});

test('article branch order reads register once and qualify wholly in Sales without changing pinned catalogs', () => {
  const pinned = require('../lib/persistence/postgresql/sales/catalog').createSalesCatalog(8);
  assert.equal(pinned.entries.length, 219);
  const sqlite = require('../lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG;
  const reporting = require('../lib/persistence/postgresql/reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG;
  const catalog = require('../lib/persistence/postgresql/reporting/sales-article-branch-orders-catalog').ARTICLE_BRANCH_ORDERS_CATALOG;
  assert.equal(catalog.length, 2);
  for (const statement of Object.values(S)) {
    assert.equal(sqlite.filter(entry => entry.statement === statement).length, 1);
    assert.equal(reporting.filter(entry => entry.statement === statement).length, 1);
    assert.equal(pinned.entries.some(entry => entry.statement.id === statement.id), false);
  }
  assert.match(catalog[0].sql, /integration\."import_history_references"/);
  assert.match(catalog[0].sql, /integration\."import_history_records"/);
  assert.match(catalog[1].sql, /integration\."import_history_segments"/);
  assert.match(catalog[1].sql, /WITH ORDINALITY/);
  assert.match(catalog[1].sql, /data_class='internal_business'/);
  assert.doesNotMatch(catalog.map(entry => entry.sql).join('\n'), /file_sha256|customer_restricted|INDEXED BY/);
});

test('native PostgreSQL article branch order SQL follows the same bounded selection and segment contract',
  { skip: process.env.GP_PG_MIGRATION_LIVE !== '1', timeout: 90000 }, async () => {
    // This qualification is restricted to the existing isolated local fixture.
    for (const name of ['GP_SALES_MIGRATOR_URL', 'GP_SALES_APP_URL']) {
      const url = new URL(process.env[name]);
      assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
      assert.equal(url.port, '25475'); assert.equal(url.pathname, '/gp_migration_sales');
    }
    await require('../test-support/postgresql-migration/sales-fixture').withSalesFixture(8, async fixture => {
      await seed(fixture.postgres); await check(fixture.postgres);
    });
  });
