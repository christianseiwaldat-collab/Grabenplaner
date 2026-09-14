'use strict';
const { definePersistenceStatement } = require('../contract');
const articleStock = definePersistenceStatement({ id: 'branch-article.stock', operation: 'queryAll',
  parameters: { scopeId: 'text', sourceInstance: 'text', snapshot: 'text', articleHash: 'text', masterRecordId: 'text', limit: 'safe_integer' },
  columns: { id: 'text' } });
module.exports = { articleStock };
