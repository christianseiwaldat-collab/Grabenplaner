'use strict';
const { ARTICLE_BRANCH_ORDER_STATEMENTS: S } = require('../../statements/sales-article-branch-orders');
const { ARTICLE_BRANCH_ORDERS_CATALOG: source } = require('../../sqlite/sales-article-branch-orders-catalog');
const { compileSalesEntry } = require('../sales/catalog');
const { relation } = require('../sales/layout');
const ARTICLE_BRANCH_ORDERS_CATALOG = Object.freeze([
  compileSalesEntry(source.find(entry => entry.statement === S.candidates), 8).providerEntry,
  { statement: S.internalSegments, returning: false, parameterOrder: ['requests'],
    sql: `SELECT request.ordinality::bigint AS "batchOrdinal",s.record_id AS "recordId",
      s.revision,s.data_class AS "dataClass",s.payload
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS request(value,ordinality)
      JOIN ${relation('import_history_segments')} s ON s.record_id=request.value->>'recordId'
        AND s.revision=(request.value->>'revision')::bigint
      WHERE s.data_class='internal_business' ORDER BY request.ordinality` },
]);
module.exports = { ARTICLE_BRANCH_ORDERS_CATALOG };
