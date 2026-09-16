'use strict';
// Full copied ACCDB -> encrypted local PostgreSQL -> normal review/application.
// Cash normally stops at its verified candidate. --publish-cash additionally
// exercises publication with an explicit synthetic fixture location mapping.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {withCoreFixture}=require('../test-support/postgresql-migration/core-fixture');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
const {openTwoDatabaseDevelopmentApplication}=require('../lib/persistence/postgresql/boundary/application');
const {createIntegrationSecretVault}=require('../lib/integration-secret-vault');
const {createDataImportRuntime}=require('../lib/persistence/repositories/data-import-runtime');
const {streamTradeFotoFullSource}=require('../lib/tradefoto-full-import-reader');
const {DATA_IMPORT_PERMISSIONS:P}=require('../lib/data-import-access');
async function main(){
 const [configPath,sourceInput,selection='cash']=process.argv.slice(2),config=JSON.parse(fs.readFileSync(path.resolve(configPath),'utf8'));
 const publishCash=process.argv.includes('--publish-cash');
 const syncArticleCatalog=process.argv.includes('--sync-catalog');
 if(!['trade','bestell','cash','all'].includes(selection))throw new Error('Known source kind required');
 const files=selection==='all' ? [['trade','Trade_Daten.accdb'],['bestell','Trade_DatenBestell.accdb'],['cash','Kassen_Umsätze.accdb']]
  .map(([kind,name])=>({kind,sourcePath:path.join(sourceInput,name)})) : [{kind:selection,sourcePath:sourceInput}];
 if(config.host!=='127.0.0.1'||config.port!==55486||config.format!=='grabenplaner-postgresql-staging-v1')throw new Error('Dedicated local cluster required');
 const stat=fs.statfsSync(path.dirname(path.resolve(configPath)));if(stat.bavail*stat.bsize<10*1024**3)throw new Error('Local disk reserve required');
 for(const domain of ['core','sales'])for(const purpose of ['app','migrator']){
  const role=`gp_${domain}_${purpose}`;
  process.env[`GP_${domain.toUpperCase()}_${purpose.toUpperCase()}_URL`]=`postgresql://${role}:${encodeURIComponent(config.accounts[role])}@127.0.0.1:55486/gp_migration_${domain}`;
 }
 await withCoreFixture(core=>withSalesFixture(8,async f=>{
  const app=await openTwoDatabaseDevelopmentApplication({coreUrl:process.env.GP_CORE_APP_URL,salesUrl:process.env.GP_SALES_APP_URL,stage:8,authorize:async()=>true});
  await core.application.close();await f.application.close();
  const session={employeeNumber:'00001',isEmployee:true,permissions:[...Object.values(P),'sales:analytics:access','sales:analytics:company:read',
   ...(publishCash?['locations:write']:[]),...(publishCash||syncArticleCatalog?['sales:articles:access','sales:articles:read','sales:articles:import']:[])]};
  const vault=createIntegrationSecretVault({activeKeyId:'ephemeral-import-benchmark',keys:{'ephemeral-import-benchmark':crypto.randomBytes(32)}}),reports=[];
  try{for(const {kind,sourcePath} of files){
  const buffer=fs.readFileSync(path.resolve(sourcePath)),sha256=crypto.createHash('sha256').update(buffer).digest('hex'),bytes=buffer.length;
  let rows=0,last=performance.now(),maxPacketMs=0;
  const runtime=createDataImportRuntime({access:app.provider,vault,sharedPayloads:true,compactCash:true,allowApply:kind!=='cash',syncArticleCatalog,
   readSource:options=>streamTradeFotoFullSource({...options,onMessage:async message=>{
    const start=performance.now(),result=await options.onMessage(message);
    maxPacketMs=Math.max(maxPacketMs,performance.now()-start);
    if(message.type==='rows')rows+=message.rows.length;
    if(performance.now()-last>20000){process.stderr.write(JSON.stringify({kind,phase:'stage',table:message.name,rows,seconds:Math.round((performance.now()-started)/1000)})+'\n');last=performance.now();}
    return result;
   }})});
  const started=performance.now();
  const phaseTimes={};let maxOperationMs=0;
  const operation=async(source,action)=>{
   if(fs.existsSync(path.join(path.dirname(path.resolve(configPath)),'stop-full-benchmark')))throw new Error('Local benchmark stopped at a saved checkpoint');
   const key=source.currentStep?.phase||action,start=performance.now();
   const result=await runtime.sourceOperation(async()=>session,source.id,action,{expectedRevision:source.revision});
   const elapsed=performance.now()-start;phaseTimes[key]=(phaseTimes[key]||0)+elapsed;maxOperationMs=Math.max(maxOperationMs,elapsed);return result;
  };
   let source=await runtime.upload(async()=>session,{kind,buffer});const stageMs=Math.round(performance.now()-started),reviewStart=performance.now();
   do{source=await operation(source,'review');
    if(performance.now()-last>20000){process.stderr.write(JSON.stringify({kind,phase:'review',rows:source.verifiedRows??source.tables.reduce((n,t)=>n+t.run.receivedRows-(t.run.counts.staged||0),0),seconds:Math.round((performance.now()-started)/1000)})+'\n');last=performance.now();}
   }while(source.status==='reviewing');
   if(!['ready','needs_review'].includes(source.status)||kind==='cash'&&source.verifiedRows!==rows)throw new Error('Full verification failed');
   const reviewMs=Math.round(performance.now()-reviewStart),applyStart=performance.now();let applyMs=null;
   if(kind!=='cash'){
    do{source=await operation(source,'apply');
     if(performance.now()-last>20000){process.stderr.write(JSON.stringify({kind,phase:'apply',step:source.currentStep,rows:source.tables.reduce((n,t)=>n+(t.run.counts.applied||0)+(t.run.counts.unchanged||0),0),seconds:Math.round((performance.now()-started)/1000)})+'\n');last=performance.now();}
    }while(source.status==='applying');
    if(source.status!=='applied')throw new Error('Full application failed');applyMs=Math.round(performance.now()-applyStart);
   }
   let publication=null;
   if(kind==='cash'&&publishCash){
    const {createCashPublicationRuntime}=require('../lib/persistence/repositories/cash-publication-runtime');
    const {CASH_SOURCE_POLICIES}=require('../lib/cash-source-policies');
    const publisher=createCashPublicationRuntime({access:app.provider,vault,enabled:true,policies:CASH_SOURCE_POLICIES});
    const publicationStart=performance.now(),get=async()=>session;
    const refs=await publisher.operation(get,'references',{sourceId:source.id,kind:'FILIALEN',limit:1000});
    const branch=refs.items.find(item=>item.sourceId==='18')||refs.items.find(item=>item.sourceId!=='0');
    if(!branch)throw new Error('Cash publication requires a source location');
    const request={sourceId:source.id,expectedRevision:0,label:'Local synthetic publication benchmark',policyId:CASH_SOURCE_POLICIES[0].id,
     resolveArticles:true,mappings:[{kind:'FILIALEN',sourceId:branch.sourceId,targetId:'18',historical:false}]};
    let phaseStart=performance.now();const preview=await publisher.operation(get,'preview',{request});const previewMs=Math.round(performance.now()-phaseStart);
    phaseStart=performance.now();const active=await publisher.operation(get,'activate',{request,planHash:preview.planHash});const activateMs=Math.round(performance.now()-phaseStart);
    const checked=await publisher.operation(get,'context',{sourceId:source.id});
    if(checked.state.active?.id!==active.active||checked.source.verifiedRows!==rows)throw new Error('Cash publication verification failed');
    publication={previewMs,activateMs,totalMs:Math.round(performance.now()-publicationStart),bindings:preview.bindings,active:true,
     fixture:'one synthetic location mapping; automatic article resolution against the empty operational article catalog'};
   }
   const dbBytes=(await f.client.query('SELECT pg_database_size(current_database())::text bytes')).rows[0].bytes;
   const repeated=performance.now();const again=await runtime.upload(async()=>session,{kind,buffer:fs.readFileSync(path.resolve(sourcePath))});
   if(again.id!==source.id)throw new Error('Identical source was not reused');
   const report={measuredAt:new Date().toISOString(),node:process.version,postgresql:'18.6',platform:process.platform,
    kind,sourceFile:path.basename(sourcePath),sha256,bytes,rows,status:source.status,verifiedRows:source.verifiedRows??rows,stageMs,reviewMs,applyMs,
    totalMs:Math.round(repeated-started),identicalFileMs:Math.round(performance.now()-repeated),maxPacketMs:Math.round(maxPacketMs),maxOperationMs:Math.round(maxOperationMs),
    phaseTimesMs:Object.fromEntries(Object.entries(phaseTimes).map(([key,value])=>[key,Math.round(value)])),databaseBytes:Number(dbBytes),
    ...(publication?{publication}:{}),
    contentDate:source.contentDate, ...(source.catalog?{catalog:{total:source.catalog.total,changed:source.catalog.changed,unchanged:source.catalog.unchanged,blocked:source.catalog.blocked,complete:source.catalog.complete}}:{}),
    includes:['worker-reader','encrypted-staging','full-source-verification','checkpoints',...(kind==='cash'?[]:['local-application']),...(syncArticleCatalog&&kind==='trade'?['article-catalog-sync']:[]),...(publication?['local-cash-publication']:[])],
    excludes:['network-upload','background-job-loop','encrypted-upload-spool','production-principal-resolution','existing-production-targets',...(publication?[]:['cash-publication']),'VPS-qualification']};
   reports.push(report);process.stderr.write(JSON.stringify({kind,completed:true,rows,totalMs:report.totalMs})+'\n');
   fs.writeFileSync(path.join(path.dirname(path.resolve(configPath)),kind+'-full-source-'+(syncArticleCatalog?'unified-catalog':publication?'published':'final')+'.json'),JSON.stringify(report,null,2));
  }
  console.log(JSON.stringify(reports.length===1?reports[0]:reports,null,2));
  }finally{await app.close();}
 }));
}
main().catch(e=>{console.error(e.code||e.name,e.message);process.exitCode=1;});
