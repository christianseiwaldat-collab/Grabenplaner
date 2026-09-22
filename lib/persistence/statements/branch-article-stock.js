'use strict';
const { definePersistenceStatement } = require('../contract');
const articleStock = definePersistenceStatement({ id: 'branch-article.stock', operation: 'queryAll',
  parameters: { scopeId: 'text', sourceInstance: 'text', snapshot: 'text', articleHash: 'text', masterRecordId: 'text', limit: 'safe_integer' },
  columns: { id: 'text' } });
const branchStock = definePersistenceStatement({ id: 'branch-article.stock-location', operation: 'queryAll',
  parameters: { scopeId:'text', snapshot:'text', locationHash:'text', after:'text', limit:'safe_integer',
    ...Object.fromEntries(Array.from({length:32},(_,i)=>['master'+i,'text'])) }, columns:{id:'text',revision:'safe_integer'} });
const articleBranchStock = definePersistenceStatement({id:'branch-article.stock-pair',operation:'queryAll',
 parameters:{scopeId:'text',snapshot:'text',articleMaster:'text',locationMaster:'text'},columns:{id:'text',revision:'safe_integer'}});
module.exports = { articleStock, branchStock, articleBranchStock };
