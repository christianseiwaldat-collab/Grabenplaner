'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {fixture}=require('../test-support/trade-insights-sqlite');
const {createTradeInsightJobs}=require('../lib/persistence/repositories/trade-insight-jobs');
const {registerTradeInsightJobRoutes}=require('../lib/trade-insight-job-routes');
test('result HTTP API persists snapshots, exports sorted PDF and enforces CSRF, ownership and current permissions',async t=>{
 const f=await fixture(t),original=f.state.session;
 const jobs=createTradeInsightJobs({access:f.app.provider,vault:f.vault,runtime:f.runtime,resolvePrincipal:async()=>f.state.session});t.after(()=>jobs.stop());
 const app=express();app.use(express.json());
 registerTradeInsightJobRoutes(app,{jobs,requireSession:()=>original,refreshSession:async()=>f.state.session,assertCsrf:req=>{if(req.get('X-CSRF-Token')!=='synthetic')throw Object.assign(Error(),{status:403});}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const request=(path='',body,csrf='synthetic')=>fetch(`http://127.0.0.1:${server.address().port}/api/trade-insights/jobs${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},...(body?{body:JSON.stringify(body)}:{})});
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
 }finally{await loading.destroy();}
 require('node:fs').mkdirSync('tmp/trade-preview',{recursive:true});require('node:fs').writeFileSync('tmp/trade-preview/results-qa.pdf',buffer);
 assert.equal((await request('/'+job.id+'/pdf?sort=invalid')).status,422);
 f.state.session={...original,permissions:original.permissions.filter(p=>p!=='sales:analytics:margin:read')};
 assert.equal((await request('/'+job.id)).status,403);assert.equal((await request('/'+job.id+'/pdf')).status,403);
 f.state.session=original;assert.equal((await request('/'+job.id+'/rename',{title:'Archiv'})).status,200);
 assert.equal((await request('/'+job.id+'/remove',{},'wrong')).status,403);
 assert.equal((await request('/'+job.id+'/remove',{})).status,200);assert.equal((await request('/'+job.id)).status,404);
});
