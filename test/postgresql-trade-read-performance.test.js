'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {enableImportBatches}=require('../lib/persistence/repositories/import-batch-support');
function measuredAccess(base,legacyImportCapability=true){
 const {access,counts}=require('../test-support/measured-persistence').measuredPersistence(base);
 if(legacyImportCapability)enableImportBatches(access,{coreReferences:true});
 return {access,counts};
}
test('Trade reporting bounds article and document round trips without changing results or revocation',{skip:!process.env.GP_CORE_MIGRATOR_URL},async()=>{
 await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async f=>{
  const source=await require('../test-support/trade-insights-fixture').insightFixture({access:f.access,protection:f.protection,scopeId:'synthetic-migration',ownerId:'00001',seedBase:false});
  await source.ingest('FILIALEN',[{FilialID:'18',FName:'Synthetic performance branch'}],{master:true});
  const branch=(await source.masters.mappings({table:'FILIALEN',sourceInstance:'tradefoto-trade',key:'18'})).items[0];
  const binding={recordId:branch.id,expectedSourceRevision:branch.revision,targetId:'18',historical:false,reason:'Synthetic performance qualification'};
  await source.masters.bind(binding,(await source.masters.previewBinding(binding)).planHash);
  await source.ingest('ARTIKEL_STAMM',Array.from({length:80},(_,i)=>({EAN:'PERF-'+i,Artikelbezeichnung:'Synthetic current '+i,Anlagedatum:'2020-01-01T00:00:00.000'})),{master:true});
  await source.ingest('ARTIKEL_STAMMGelöscht',Array.from({length:80},(_,i)=>({EAN:'PERF-'+(i+80),Artikelbezeichnung:'Synthetic archive '+i,Anlagedatum:'2020-01-01T00:00:00.000',Löschdatum:'2026-09-11T00:00:00.000'})),{sourceInstance:'tradefoto-weum'});
  await source.ingest('BESTELLUNGEN',[{BestellNr:'1',Suchname:'Synthetic',LFilialID:18}]);
  await source.ingest('WE',Array.from({length:200},(_,i)=>({We_ID:String(i+1),We:true,Umlagerung:false,EAN:'PERF-'+i,Suchname:'Synthetic',FilialID:'18',Menge:'1',WEDatum:'2026-09-10T00:00:00.000',Bestellnr:1})),{sourceInstance:'tradefoto-weum'});
  const metrics=[];let previous;
  // Both rounds exercise current reporting packets; this varies only the
  // pre-existing import capability, not the measured pre-change baseline.
  for(const legacyImportCapability of [false,true]){
   const measured=measuredAccess(f.access,legacyImportCapability),runtime=require('../lib/persistence/repositories/trade-insights').createTradeInsightRuntime({...f.runtimeOptions,access:measured.access});
   const start=performance.now(),page=await runtime.run(()=>f.resolvePrincipal('00001'),'movements',{dateFrom:'2026-09-01'});
   assert.equal(page.rows.length,200);assert.equal(page.rows.filter(r=>r.articleReference.status==='current').length,80);
   assert.equal(page.rows.filter(r=>r.articleReference.status==='archived').length,80);assert.equal(page.rows.filter(r=>r.articleReference.status==='missing').length,40);
   if(previous)assert.deepEqual(page,previous);previous=page;
   const queries=[...measured.counts.values()].reduce((a,b)=>a+b,0);
   assert.ok(queries<=40,'A 200-row mixed current/archive page must use bounded batched reads, got '+queries);
   assert.ok((measured.counts.get('import-history.find')||0)<=1,'Related and archive identity lookups must not grow per movement');
   metrics.push({legacyImportCapability,rows:page.rows.length,milliseconds:Math.round(performance.now()-start),queries,statements:Object.fromEntries(measured.counts)});
   let calls=0;
   await assert.rejects(runtime.run(async()=>{const principal=await f.resolvePrincipal('00001');return ++calls===1?principal:{...principal,permissions:[]};},'movements',{dateFrom:'2026-09-01'}),e=>e.code==='IMPORT_FORBIDDEN');
   await measured.access.close();
  }
  console.log('TRADE_READ_PERFORMANCE '+JSON.stringify(metrics));
 },{warmWorkers:false});
});
