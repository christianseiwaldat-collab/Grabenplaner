'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createPersistenceProviderFacade, PERSISTENCE_ERROR_CODES } = require('../lib/persistence/contract');
const { createSalesArticleCatalogRepository } = require('../lib/persistence/repositories/sales-article-catalog');
const { enableImportBatches } = require('../lib/persistence/repositories/import-batch-support');
const { IMPORT_READER_BATCHES } = require('../lib/persistence/statements/import-reader-batches');
const { SALES_ARTICLE_CATALOG_STATEMENTS: S } = require('../lib/persistence/statements/sales-article-catalog');
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
