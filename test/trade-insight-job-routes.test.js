'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {fixture}=require('../test-support/trade-insights-sqlite');
const {createTradeInsightJobs}=require('../lib/persistence/repositories/trade-insight-jobs');
const {registerTradeInsightJobRoutes}=require('../lib/trade-insight-job-routes');
test('result HTTP API persists snapshots, exports sorted PDF and enforces CSRF, ownership and current permissions',async t=>{
 const f=await fixture(t),original=f.state.session;
 const jobs=createTradeInsightJobs({access:f.app.provider,vault:f.vault,runtime:f.runtime,resolvePrincipal:async()=>f.state.session});t.after(()=>jobs.stop());
 const app=express();app.use(express.json());
 const stored=new Map(),preferences={get:async(owner,key)=>({value:stored.get(owner+':'+key)}),upsert:async(owner,key,value)=>stored.set(owner+':'+key,value)};
 registerTradeInsightJobRoutes(app,{jobs,preferences,requireSession:()=>original,refreshSession:async()=>f.state.session,assertCsrf:req=>{if(req.get('X-CSRF-Token')!=='synthetic')throw Object.assign(Error(),{status:403});}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const request=(path='',body,csrf='synthetic')=>fetch(`http://127.0.0.1:${server.address().port}/api/trade-insights/jobs${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},...(body?{body:JSON.stringify(body)}:{})});
 const pref=(path,body,csrf='synthetic')=>fetch(`http://127.0.0.1:${server.address().port}/api/trade-insights/${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},...(body?{body:JSON.stringify(body)}:{})});
 const exportConfig={stamp:'date-suffix',suffix:'Fil18',position:'after',separator:'_'};assert.equal((await pref('export-options',exportConfig,'wrong')).status,403);
 assert.equal((await pref('export-options',exportConfig)).status,200);assert.deepEqual(await(await pref('export-options')).json(),exportConfig);
 assert.equal((await pref('table-options/purchasing',{columns:[],widths:{}})).status,422);
 assert.equal((await pref('table-options/purchasing',{columns:['date','label'],widths:{label:320}})).status,200);assert.deepEqual(await(await pref('table-options/purchasing')).json(),{columns:['date','label'],widths:{label:320}});
 const input={title:'Prüfauswertung September',kind:'purchasing',query:{}};
 assert.equal((await request('',input,'wrong')).status,403);assert.equal((await jobs.list(original)).length,0);
 const response=await request('',input);assert.equal(response.status,200);const job=await response.json();
 assert.equal((await request('/'+job.id)).status,409);
 for(let n=0;n<3;n++)await jobs.tick();
 const saved=await request('/'+job.id);assert.equal(saved.status,200);assert.equal((await saved.json()).result.rows.length,65);
 const pdf=await request('/'+job.id+'/pdf?sort=ordered&direction=desc');assert.equal(pdf.status,200);assert.match(pdf.headers.get('content-type'),/application\/pdf/);assert.equal(pdf.headers.get('cache-control'),'private, no-store');
 const buffer=Buffer.from(await pdf.arrayBuffer());assert.equal(buffer.subarray(0,5).toString(),'%PDF-');
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const loading=getDocument({data:new Uint8Array(buffer),isEvalSupported:false}),document=await loading.promise;
 try{
  assert.ok(document.numPages>1);const pages=[];
  for(let n=1;n<=document.numPages;n++){
   const page=await document.getPage(n),content=await page.getTextContent();pages.push(content.items.map(i=>i.str).join(' '));
   assert.match(pages.at(-1),new RegExp(`Seite ${n} / ${document.numPages}`));
   for(const item of content.items.filter(i=>i.str?.trim())){assert.ok(item.transform[4]>=31&&item.transform[4]+item.width<=812,`horizontal overflow: ${item.str}`);assert.ok(item.transform[5]>=20&&item.transform[5]<=573,`vertical overflow: ${item.str}`);}
  }
  const text=pages.join('\n');assert.match(text,/Prüfauswertung September/);assert.match(text,/Bestellt absteigend/);assert.match(text,/camera 64/);assert.match(text,/camera 0/);
  assert.match(pages.at(-1),/Abfragedauer:/);assert.ok(pages.slice(0,-1).every(page=>!page.includes('Abfragedauer:')));
 }finally{await loading.destroy();}
 require('node:fs').mkdirSync('tmp/trade-preview',{recursive:true});require('node:fs').writeFileSync('tmp/trade-preview/results-qa.pdf',buffer);
 assert.equal((await request('/'+job.id+'/pdf?sort=invalid')).status,422);
 const named=await request('/'+job.id+'/pdf?name=Fil18-Bestand&stamp=date-suffix&suffix=Pruefung&position=after&separator=_');assert.equal(named.status,200);assert.match(named.headers.get('content-disposition'),/Fil18-Bestand_\d{6}-Pruefung\.pdf/);
 assert.equal((await request('/'+job.id+'/pdf?position=invalid')).status,422);
 f.state.session={...original,permissions:original.permissions.filter(p=>p!=='sales:analytics:margin:read')};
 assert.equal((await request('/'+job.id)).status,403);assert.equal((await request('/'+job.id+'/pdf')).status,403);
 f.state.session=original;assert.equal((await request('/'+job.id+'/rename',{title:'Archiv'})).status,200);
 assert.equal((await request('/'+job.id+'/remove',{},'wrong')).status,403);
 assert.equal((await request('/'+job.id+'/remove',{})).status,200);assert.equal((await request('/'+job.id)).status,404);
});

test('PDFs use understandable filters and do not expose supplier costs without permission',async()=>{
 const {createTradeInsightPdf}=require('../lib/trade-insight-pdf'),{getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const base={title:'Synthetische PDF-Prüfung',created:'2026-10-01T09:00:00Z',completedAt:'2026-10-01T09:00:02Z',durationMs:2000};
 const cases=[{...base,kind:'purchasing',projection:{costs:false},query:{locationId:'18',dateFrom:'2026-08-01',dateTo:'2026-09-17'},result:{rows:[]}},
 {...base,kind:'supplier-invoices',projection:{costs:false},query:{articleNumber:'42',dateField:'booked'},result:{article:{number:'42',label:'Synthetischer Artikel',saleGross:'399',averageNet:'123456.78'},rows:[{created:'2026-09-10',booked:'2026-09-08',number:'RE-001',supplier:'Demo',quantity:'2',priceMin:'98765.43',priceMax:'98765.43'}]}},
 {...base,kind:'article-history',projection:{costs:false},query:{query:'42',searchMode:'exact',status:'all'},result:{rows:[{articleNumber:'42',label:'Kamera',group:'10102',status:'current',candidates:[{source:'Trade_Daten.accdb'}]}]}}];
 for(const snapshot of cases){
  const buffer=await createTradeInsightPdf(snapshot),loading=getDocument({data:new Uint8Array(buffer),isEvalSupported:false}),pdf=await loading.promise;
  try{const parts=[];for(let n=1;n<=pdf.numPages;n++)parts.push((await (await pdf.getPage(n)).getTextContent()).items.map(v=>v.str).join(' '));const content=parts.join(' ');assert.match(parts.at(-1),/Abfragedauer: 2 s/);
   if(snapshot.kind==='purchasing'){assert.match(content,/Lieferfiliale der Bestellung: 18/);assert.match(content,/Bestelldatum von: 2026-08-01/);assert.match(content,/Diese Suche betrifft Lieferantenbestellungen/);}
   if(snapshot.kind==='supplier-invoices'){assert.match(content,/Zeitraum bezieht sich auf: Buchdatum/);assert.match(content,/Synthetischer Artikel/);assert.doesNotMatch(content,/123456|98765|Durchschnitts-EK|EK netto/);}
   if(snapshot.kind==='article-history'){assert.match(content,/Suchart: Artikelnummer exakt/);assert.match(content,/Referenzen: Alle Referenzen/);assert.doesNotMatch(content,/searchMode|status:|Filialauswahl/);}
  }finally{await loading.destroy();}
 }
});
