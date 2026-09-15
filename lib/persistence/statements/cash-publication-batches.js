'use strict';
const {definePersistenceStatement:define}=require('../contract');
const {CASH_SNAPSHOT_TABLES:TABLES,CASH_SNAPSHOT_COLUMNS}=require('./cash-snapshots');
const {IMPORT_MASTER_STATEMENTS:M}=require('./import-master-data');
const def=(id,operation,parameters,columns={})=>define({id:'cash-publication-batches.'+id,operation,parameters,columns});
const CASH_PUBLICATION_BATCHES=Object.freeze({
  articles:def('articles','queryAll',{sourceSystem:'text',keys:'json'},{sourceArticleKey:'text',...M.articleBySource.columns}),
  rows:Object.freeze(TABLES.map((_,i)=>def('rows.'+i,'queryAll',{datasetSlot:'safe_integer',rows:'json'},CASH_SNAPSHOT_COLUMNS.ROW))),
  bindings:def('bindings','execute',{rows:'json'}),
});
module.exports={CASH_PUBLICATION_BATCHES};
