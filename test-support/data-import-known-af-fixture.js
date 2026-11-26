"use strict";
// Synthetic rows only. Uses the installed modules directly, without require hooks.
const assert=require('node:assert/strict');
const C=require('../lib/data-import-contract'),M=require('../lib/tradefoto-master-profiles');
const {withReportFixture}=require('./postgresql-migration/report-fixture');
const {createDataImportRuntime}=require('../lib/persistence/repositories/data-import-runtime');
const {readTradeFotoFullSource,definitions}=require('../lib/tradefoto-full-import-source');
const {DATA_IMPORT_PERMISSIONS:P}=require('../lib/data-import-access');
const TIME='2026-11-11T12:00:00.000Z';
function sourceBuffer(){const b=Buffer.alloc(4096);b.write('Standard ACE DB',4);b[0x14]=3;return b;}
const rawMaster=(name,extra={})=>({...Object.fromEntries(M.tableFor(name).columns.map(c=>[c.name,null])),...extra});
function readerFactory(kind,values={},counts={}) {
 const defs=definitions(kind);return ()=>({getTableNames:()=>defs.map(d=>d.name),getTable:name=>{
  const def=defs.find(d=>d.name===name),rows=values[name]||[];assert(def);
  return {rowCount:counts[name]??rows.length,getColumnNames:()=>def.columns.map(c=>c.name),getColumns:()=>def.columns.map(c=>({name:c.name,type:c.type})),
   getData:({columns,rowOffset=0,rowLimit=Infinity})=>rows.slice(rowOffset,rowOffset+rowLimit).map(row=>Object.fromEntries(columns.map(key=>[key,row[key]??null])))};
 }});
}
const nativeImport={skip:!process.env.GP_CORE_MIGRATOR_URL||!process.env.GP_SALES_MIGRATOR_URL};
async function withImportFixture(work){
 return withReportFixture(async ({access,core,client,vault,protection})=>{
  await core.migrator.query('SET ROLE gp_core_owner');
  await work({provider:access,core:core.migrator,sales:client,vault,protection});
 },{warmWorkers:false});
}
async function withFixture({kind='trade',values={},counts={},allowApply=true},work){
 return withImportFixture(async storage=>{
 const state={session:{employeeNumber:'synthetic-1',accountId:'personal-1',isEmployee:true,role:'developer',permissions:[...Object.values(P),'sales:analytics:access','sales:analytics:company:read']}};
 const getSession=async()=>state.session,keyVault=storage.vault;
 const readSource=options=>readTradeFotoFullSource({...options,send:options.onMessage,readerFactory:readerFactory(kind,values,counts)});
 const options={access:storage.provider,vault:keyVault,allowApply,readSource,clock:()=>TIME};
 let runtime=createDataImportRuntime(options);
 const upload=(buffer=sourceBuffer())=>runtime.upload(getSession,{buffer,kind});
 const reload=()=>{runtime=createDataImportRuntime(options);return runtime;};
 async function finish(source,action){let n=0;do{source=await runtime.sourceOperation(getSession,source.id,action,{expectedRevision:source.revision});
  if(++n>700)throw new Error('Synthetic source operation did not terminate');}while(source.status===({review:'reviewing',apply:'applying',undo:'reverting'}[action]));return source;}
 try{await work({...storage,state,getSession,keyVault,options,upload,reload,finish,get runtime(){return runtime;}});}
 finally{await runtime.stop();}
 });
}
module.exports={withFixture,withImportFixture,nativeImport,sourceBuffer,rawMaster,readerFactory,TIME};
