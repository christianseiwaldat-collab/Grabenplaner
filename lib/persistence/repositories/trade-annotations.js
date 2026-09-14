'use strict';
const C=require('../../data-import-contract'),{A}=require('../statements/trade-annotations');
const {CRM_CUSTOMER_STATEMENTS:Audit}=require('../statements/crm-customers');
function annotations({protection,scopeId}){
 const context=row=>['trade-annotation-v1',row.scopeId,row.kind,row.id,row.revision];
 const id=(kind,key)=>protection.digest(['trade-annotation-id',scopeId,kind,key]);
 async function read(tx,kind,key){const row=await tx.queryOne(A.get,{scopeId,kind,id:id(kind,key)});return row?{revision:row.revision,value:protection.open(row.payload,context(row))}:{revision:0,value:null};}
 async function write(tx,kind,key,value,expectedRevision,actor){
  C.integer(expectedRevision,0,Number.MAX_SAFE_INTEGER-1);const before=await read(tx,kind,key);
  if(before.revision!==expectedRevision)C.fail('IMPORT_CONCURRENT_CHANGE',409);
  const row={id:id(kind,key),scopeId,kind,revision:expectedRevision+1};const payload=protection.seal(value,context(row));
  const result=await tx.execute(expectedRevision?A.update:A.insert,{...row,payload,...(expectedRevision?{expectedRevision}:{})});
  if(result.rowsAffected!==1)C.fail('IMPORT_CONCURRENT_CHANGE',409);
  await tx.execute(Audit.insertAudit,{actor,action:'trade.'+kind+'.update',entityType:'trade_annotation',entityId:row.id,detail:JSON.stringify({revision:row.revision}),timestamp:new Date().toISOString()});
  return {revision:row.revision,value};
 }
 return {read,write};
}
module.exports={annotations};
