'use strict';
const { definePersistenceStatement } = require('../contract');
const { IMPORT_HISTORY_COLUMNS } = require('./import-history');
const ARTICLE_BRANCH_ORDER_STATEMENTS = Object.freeze({
  candidates: definePersistenceStatement({ id: 'sales-article-branch-orders.candidates', operation: 'queryAll',
    parameters: { scopeId: 'text', articleMaster: 'text', limit: 'safe_integer' },
    columns: { id: 'text', revision: 'safe_integer' } }),
  internalSegments: definePersistenceStatement({ id: 'sales-article-branch-orders.internal-segments', operation: 'queryAll',
    parameters: { requests: 'json' }, columns: { batchOrdinal: 'safe_integer', ...IMPORT_HISTORY_COLUMNS.SEGMENT } }),
});
module.exports = { ARTICLE_BRANCH_ORDER_STATEMENTS };
