'use strict';
// Synthetic end-to-end runtime benchmark, restricted to the dedicated local
// PostgreSQL migration databases. Reports contain timings/counts, never fields.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Client}=require('pg');
const {withCoreFixture}=require('../test-support/postgresql-migration/core-fixture');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
const {openTwoDatabaseDevelopmentApplication}=require('../lib/persistence/postgresql/boundary/application');
const {createIntegrationSecretVault}=require('../lib/integration-secret-vault');
const {createDataImportRuntime}=require('../lib/persistence/repositories/data-import-runtime');
const {DATA_IMPORT_PERMISSIONS}=require('../lib/data-import-access');
const {readTradeFotoFullSource,definitions}=require('../lib/tradefoto-full-import-source');
const kinds=['trade','bestell','cash'];
async function main(){
 const [configPath,kind,countText='1000']=process.argv.slice(2),count=Number(countText);
 if(!kinds.includes(kind)||!Number.isSafeInteger(count)||count<100||count>100000)throw new Error('Usage: benchmark-data-import.cjs <local-credentials.json> trade|bestell|cash [100..100000]');
 const config=JSON.parse(fs.readFileSync(path.resolve(configPath),'utf8'));
 if(config.host!=='127.0.0.1'||config.port!==55486||config.format!=='grabenplaner-postgresql-staging-v1')throw new Error('Dedicated local benchmark required');
 for(const domain of ['core','sales'])for(const purpose of ['app','migrator']){
  const role=`gp_${domain}_${purpose}`;
  process.env[`GP_${domain.toUpperCase()}_${purpose.toUpperCase()}_URL`]=`postgresql://${role}:${encodeURIComponent(config.accounts[role])}@127.0.0.1:55486/gp_migration_${domain}`;
 }
 const defs=definitions(kind),tableName={trade:'KUNDEN',bestell:'Reparatur',cash:'Umsatz_KASSE'}[kind],def=defs.find(d=>d.name===tableName);
 const raw=extra=>({...Object.fromEntries(def.columns.map(c=>[c.name,null])),...extra});
 const values=Array.from({length:count},(_,i)=>kind==='trade'?raw({KUND_NR:String(i+1),NACHNAME:'Synthetic '+i}):kind==='bestell'?
  raw({ReparaturNr:i+1,FilialId:'18',AName:'Synthetic '+i,erledigt:false}):
  raw({Bonnr:i+1,Filialid:'18',Kassenid:1,Bondatum:new Date('2026-09-01T12:00:00Z')}));
 let metrics=null;
 const original=Client.prototype.query;
 Client.prototype.query=function(...args){
  const sample=metrics,started=performance.now();if(sample)sample.queries++;
  const result=original.apply(this,args);
  if(sample&&result?.then)return result.then(value=>{sample.queryMs+=performance.now()-started;return value;});
  return result;
 };
 await withCoreFixture(core=>withSalesFixture(8,async sales=>{
  const app=await openTwoDatabaseDevelopmentApplication({coreUrl:process.env.GP_CORE_APP_URL,salesUrl:process.env.GP_SALES_APP_URL,stage:8,authorize:async()=>true});
  await core.application.close();await sales.application.close();
  const session={employeeNumber:'00001',accountId:'synthetic-benchmark',isEmployee:true,role:'developer',permissions:[...Object.values(DATA_IMPORT_PERMISSIONS),'sales:analytics:access','sales:analytics:company:read']};
  const readSource=options=>readTradeFotoFullSource({...options,send:options.onMessage,readerFactory:()=>({getTableNames:()=>defs.map(d=>d.name),getTable:name=>{
   const d=defs.find(t=>t.name===name),rows=name===tableName?values:[];
   return {rowCount:rows.length,getColumnNames:()=>d.columns.map(c=>c.name),getColumns:()=>d.columns.map(c=>({name:c.name,type:c.type})),
    getData:({columns,rowOffset=0,rowLimit=Infinity})=>rows.slice(rowOffset,rowOffset+rowLimit).map(row=>Object.fromEntries(columns.map(key=>[key,row[key]??null])))};
  }})});
  const runtime=createDataImportRuntime({access:app.provider,vault:createIntegrationSecretVault({activeKeyId:'synthetic-benchmark',keys:{'synthetic-benchmark':Buffer.alloc(32,19)}}),allowApply:true,sharedPayloads:true,compactCash:true,readSource});
  const phases=[];
  async function phase(label,work){
   const start=performance.now(),cpu=process.cpuUsage();metrics={queries:0,queryMs:0};
   try{const result=await work(),usage=process.cpuUsage(cpu);phases.push({label,wallMs:Math.round(performance.now()-start),cpuMs:Math.round((usage.user+usage.system)/1000),queries:metrics.queries,queryMs:Math.round(metrics.queryMs)});return result;}
   finally{metrics=null;}
  }
  const buffer=marker=>{const b=Buffer.alloc(4096);b.write('Standard ACE DB',4);b[0x14]=3;b[4095]=marker;return b;};
  async function finish(source,action){let calls=0;do{source=await runtime.sourceOperation(async()=>session,source.id,action,{expectedRevision:source.revision});if(++calls>20000)throw new Error('Import did not finish');}
   while(source.status===({review:'reviewing',apply:'applying'}[action]));
   assert.equal(source.status,action==='review'?'ready':'applied');return source;
  }
  try{
   let source=await phase('first.stage',()=>runtime.upload(async()=>session,{kind,buffer:buffer(1)}));
   source=await phase('first.review',()=>finish(source,'review'));
   if(kind!=='cash')source=await phase('first.apply',()=>finish(source,'apply'));
   const repeated=await phase('identical-file',()=>runtime.upload(async()=>session,{kind,buffer:buffer(1)}));assert.equal(repeated.id,source.id);
   for(let i=0;i<Math.ceil(count/100);i++){
    if(kind==='trade')values[i].NACHNAME+=' changed';else if(kind==='bestell')values[i].erledigt=true;else values[i].Bondatum=new Date('2026-09-02T12:00:00Z');
   }
   source=await phase('one-percent.stage',()=>runtime.upload(async()=>session,{kind,buffer:buffer(2)}));
   source=await phase('one-percent.review',()=>finish(source,'review'));
   const deltaCounts=source.tables.find(t=>t.name===tableName).run.counts;
   if(kind!=='cash')source=await phase('one-percent.apply',()=>finish(source,'apply'));
   console.log(JSON.stringify({measuredAt:new Date().toISOString(),node:process.version,kind,table:tableName,rows:count,platform:process.platform,
    measurement:'synthetic-runtime-local-postgresql-no-upload-network-no-cash-publication',phases,deltaCounts},null,2));
  }finally{await app.close();}
 }));
}
main().catch(e=>{console.error(e.code||e.name,e.message);process.exitCode=1;});
