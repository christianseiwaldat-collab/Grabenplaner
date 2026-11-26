'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {seedWorkspace} = require('../test-support/sales-article-workspace-fixture');
const {loadSalesArticleDetailData} = require('../lib/sales-article-detail-source');
const W = require('../lib/persistence/statements/sales-article-workspace');
const {CATALOG} = require('../lib/persistence/sqlite/sales-article-workspace-catalog');

test('Portable article reader batches have native PostgreSQL counterparts', () => {
  const postgres=require('../lib/persistence/postgresql/reporting/sales-article-workspace-catalog').CATALOG;
  for(const {batch} of W.readerBatches) {
    const entry=postgres.find(candidate=>candidate.statement===batch);
    assert.ok(entry,batch.id);assert.match(entry.sql,/jsonb_array_elements/);assert.deepEqual(entry.parameterOrder,['requests']);
  }
});
