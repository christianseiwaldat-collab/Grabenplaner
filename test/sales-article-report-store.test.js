'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture,rights}=require('../test-support/trade-insights-sqlite');
const {SALES_ARTICLE_CATALOG_PERMISSION_IDS:catalogRights}=require('../lib/sales-article-catalog-access');
const {createSalesArticleReportStore,actorFor,specValue,LIMITS,CHUNK_BYTES}=require('../lib/sales-article-report-store');
const {createArticleReportPreviews,TTL}=require('../lib/sales-article-report-previews');
const Pdf=require('../lib/sales-article-report-pdf'),Model=require('../lib/sales-article-report-model');
const {annotations}=require('../lib/persistence/repositories/trade-annotations');
const full={read:true,prices:true,costs:true,margin:true};
const spec=()=>({filters:{locations:['18'],stock:'all',sort:'quantity',direction:'desc'},columns:['articleNumber','description','quantity','retailGross'],title:'BEISPIEL gespeicherte Artikelauswertung',name:'Artikel-Test.pdf',orientation:'landscape'});
const report=()=>({available:true,sourceAt:'2026-10-18T08:00:00.000Z',total:1,hasMore:false,rows:[{id:'synthetic-row',articleNumber:'000042',description:'BEISPIEL Artikel',quantity:'3',retailGross:'120',locationId:'18',location:'18 · BEISPIEL'}]});
async function setup(t){
 const f=await fixture(t);f.state.session.permissions=[...rights,...catalogRights];f.state.session.accountId='synthetic-account';
 const create=()=>createSalesArticleReportStore({access:f.app.provider,vault:f.vault});return {...f,store:create(),create,session:f.state.session};
}
async function snapshot(input=spec()){
 const normalized=Pdf.normalize(input,full),data=report();return {id:crypto.randomUUID(),spec:specValue(normalized),sourceAt:data.sourceAt,locationIds:['18'],pdf:await Pdf.render({spec:normalized,report:data})};
}
test('real SQLite persistence stores the exact PDF and settings across store recreation; deletion removes all PDF bytes',async t=>{
 const f=await setup(t),value=await snapshot(),saved=await f.store.create(f.session,value);
 assert.equal(saved.report.id,value.id);assert.equal(saved.report.bytes,value.pdf.buffer.length);
 const reopened=f.create(),list=await reopened.list(f.session);assert.equal(list.reports.length,1);assert.deepEqual(list.limits,LIMITS);
 assert.equal(JSON.stringify(list).includes('%PDF-'),false);assert.equal(JSON.stringify(list).includes('storageKey'),false);
 assert.deepEqual((await reopened.get(f.session,value.id)).report.spec,value.spec);
 assert.deepEqual((await reopened.content(f.session,value.id)).buffer,value.pdf.buffer);
 const raw=f.app.database.prepare("SELECT payload FROM trade_annotations WHERE scope_id='grabenplaner-main:article-report-documents'").all();
 assert.equal(raw.length,3);for(const row of raw){assert.match(row.payload,/^gp-import-v/);assert.doesNotMatch(row.payload,/BEISPIEL|Artikel-Test|%PDF/);}
 const copy=await snapshot({...spec(),title:'Geänderter Entwurf'});await reopened.create(f.session,copy);
 assert.deepEqual((await reopened.content(f.session,value.id)).buffer,value.pdf.buffer,'saving edited settings never overwrites the original');
 assert.deepEqual(await reopened.remove(f.session,value.id),{removed:true});
 assert.equal((await reopened.list(f.session)).reports.length,1);await assert.rejects(reopened.content(f.session,value.id),e=>e.status===404);
 await reopened.remove(f.session,copy.id);assert.equal((await reopened.list(f.session)).reports.length,0);
 assert.equal(f.app.database.prepare("SELECT COUNT(*) AS n FROM trade_annotations WHERE scope_id='grabenplaner-main:article-report-documents'").get().n,1,'only the empty concurrency-protected account index remains');
});
test('saved PDFs enforce account isolation, current column rights and current branch scope',async t=>{
 const f=await setup(t),value=await snapshot();await f.store.create(f.session,value);
 for(const other of [{...f.session,employeeNumber:'synthetic-other'},{...f.session,accountId:'other-account'}]){
  assert.equal((await f.store.list(other)).reports.length,0);for(const method of ['get','content','remove'])await assert.rejects(f.store[method](other,value.id),e=>e.status===404);
 }
 const noPrice={...f.session,permissions:f.session.permissions.filter(p=>p!=='sales:articles:prices:read')};
 assert.equal((await f.store.list(noPrice)).reports.length,0);await assert.rejects(f.store.content(noPrice,value.id),e=>e.status===403);
 const scoped={...f.session,permissions:f.session.permissions.filter(p=>p!=='sales:analytics:company:read'),scopes:[{locationId:'19'}]};
 assert.equal((await f.store.list(scoped)).reports.length,0);await assert.rejects(f.store.get(scoped,value.id),e=>e.status===403);
 await assert.rejects(f.store.get({...f.session,isEmployee:false},value.id),e=>e.status===403);
 await assert.rejects(f.store.get(f.session,'../../etc/passwd'),e=>e.status===404);
});
test('bounded encrypted PDF chunks are reconstructed exactly and authentication failure blocks content',async t=>{
 const f=await setup(t),value=await snapshot();value.pdf.buffer=Buffer.concat([Buffer.from('%PDF-1.7\n'),crypto.randomBytes(CHUNK_BYTES*2+23)]);
 await f.store.create(f.session,value);assert.deepEqual((await f.store.content(f.session,value.id)).buffer,value.pdf.buffer);
 assert.equal(f.app.database.prepare("SELECT COUNT(*) AS n FROM trade_annotations WHERE kind='article-report-pdf'").get().n,3);
 const secondChunk=f.protection.digest(['trade-annotation-id','grabenplaner-main:article-report-documents','article-report-pdf',actorFor(f.session).key+':'+value.id+':1']);
 f.app.database.prepare("UPDATE trade_annotations SET payload='invalid-envelope' WHERE id=?").run(secondChunk);
 await assert.rejects(f.store.content(f.session,value.id),e=>e.code==='ARTICLE_REPORT_STORAGE_INTEGRITY');
 await assert.rejects(f.store.remove(f.session,value.id),e=>e.code==='ARTICLE_REPORT_STORAGE_INTEGRITY');
 assert.equal(f.app.database.prepare("SELECT COUNT(*) AS n FROM trade_annotations WHERE kind='article-report-pdf'").get().n,3,'failed removal rolls back all earlier chunk deletions');
});
test('idempotent retries, concurrent account writes and storage limits preserve the account index',async t=>{
 const f=await setup(t),value=await snapshot();await f.store.create(f.session,value);const replay=await f.create().create(f.session,value);assert.equal(replay.report.id,value.id);
 const values=await Promise.all([snapshot(),snapshot()]);await Promise.all(values.map(v=>f.create().create(f.session,v)));assert.equal((await f.store.list(f.session)).reports.length,3);
 assert.throws(()=>f.store.create(f.session,{...value,id:crypto.randomUUID(),pdf:{...value.pdf,buffer:Buffer.alloc(LIMITS.pdfBytes+1)}}),e=>e.status===413);
 const owner=actorFor(f.session),store=annotations({protection:f.protection,scopeId:'grabenplaner-main:article-report-documents'});
 await f.app.provider.transaction(async tx=>{
  const row=await store.read(tx,'article-report-index',owner.key);
  await store.write(tx,'article-report-index',owner.key,{schemaVersion:1,reports:Array.from({length:10},()=>({id:crypto.randomUUID(),bytes:LIMITS.pdfBytes}))},row.revision,owner.employee);
 });
 await assert.rejects(f.store.create(f.session,await snapshot()),e=>e.code==='ARTICLE_REPORT_STORAGE_LIMIT');
});
test('preview tickets expire and remain bounded per actor without changing the rendered bytes',async t=>{
 let clock=0;const cache=createArticleReportPreviews({now:()=>clock});t.after(()=>cache.dispose());
 const session={employeeNumber:'synthetic',accountId:'account',isEmployee:true,permissions:[...rights,...catalogRights],scopes:[]},value=await snapshot(),normalized=Pdf.normalize(value.spec,full);
 const first=cache.put(session,normalized,report(),value.pdf);assert.deepEqual(cache.get(session,first).snapshot.pdf.buffer,value.pdf.buffer);
 assert.throws(()=>cache.get({...session,employeeNumber:'other'},first),e=>e.status===410);
 cache.put(session,normalized,report(),value.pdf);const last=cache.put(session,normalized,report(),value.pdf);
 assert.throws(()=>cache.get(session,first),e=>e.status===410);assert.equal(cache.get(session,last).snapshot.spec.title,value.spec.title);
 assert.throws(()=>cache.get({...session,permissions:session.permissions.filter(p=>p!=='sales:articles:prices:read')},last),e=>e.status===403);
 clock=TTL+1;assert.throws(()=>cache.get(session,last),e=>e.status===410);
});
test('HTTP save is CSRF-protected, persists exact preview bytes, reopens settings and checks source changes',async t=>{
 const f=await setup(t),express=require('express'),app=express();app.use(express.json());let data=report(),revoked=false;
 const cache=createArticleReportPreviews();t.after(()=>cache.dispose());
 require('../lib/sales-article-report-routes').register(app,{vault:f.vault,savedReports:f.store,previewCache:cache,preferences:{},
  sessionFor:req=>({...f.session,employeeNumber:req.get('x-employee')||f.session.employeeNumber}),
  privateHeaders:res=>res.set('Cache-Control','no-store'),assertFresh:async()=>{if(revoked)throw Object.assign(new Error('Revoked'),{status:403});},
  assertCsrf:req=>{if(req.get('x-csrf-token')!=='synthetic-csrf')throw Object.assign(new Error('CSRF'),{status:403});},
  loadReport:async(fresh,kind)=>{await fresh();return kind==='context'?{available:true,sourceAt:data.sourceAt,locations:[{id:'18'}]}:data;}
 });
 app.use((e,req,res,next)=>res.status(e.status||500).json({code:e.code||e.message}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}/api/sales/article-report`,headers={'Content-Type':'application/json','x-csrf-token':'synthetic-csrf'},call=(path,options={})=>fetch(base+path,options);
 const preview=await call('/pdf-preview',{method:'POST',headers,body:JSON.stringify(spec())});assert.equal(preview.status,200);
 const previewToken=preview.headers.get('x-report-preview-token'),bytes=Buffer.from(await preview.arrayBuffer());assert.match(previewToken,/^[a-f0-9]{64}$/);
 const save=()=>call('/reports',{method:'POST',headers,body:JSON.stringify({previewToken})});
 assert.equal((await call('/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({previewToken})})).status,403);
 assert.equal((await call('/reports',{method:'POST',headers:{...headers,'x-employee':'other'},body:JSON.stringify({previewToken})})).status,410);
 assert.equal((await call('/reports',{method:'POST',headers,body:JSON.stringify({previewToken,pdf:'client-forged'})})).status,400);
 const both=await Promise.all([save(),save()]),created=await both[0].json(),second=await both[1].json();assert.equal(both[0].status,200);assert.equal(second.report.id,created.report.id);
 const id=created.report.id;assert.equal((await (await call('/reports')).json()).reports.length,1);
 const opened=await (await call('/reports/'+id)).json();assert.equal(opened.report.spec.title,spec().title);assert.deepEqual(opened.report.spec.columns,spec().columns);
 for(const leaf of ['pdf-preview','pdf']){const r=await call('/reports/'+id+'/'+leaf);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);assert.match(r.headers.get('content-disposition'),leaf==='pdf'?/^attachment;/:/^inline;/);assert.equal(r.headers.get('cache-control'),'no-store');}
 assert.equal((await call('/reports/'+id+'/pdf',{headers:{'x-employee':'other'}})).status,404);
 assert.equal((await call('/reports/'+id,{method:'DELETE'})).status,403);
 const next=await call('/pdf-preview',{method:'POST',headers,body:JSON.stringify(spec())}),staleToken=next.headers.get('x-report-preview-token');await next.arrayBuffer();data={...data,sourceAt:'2026-10-19T08:00:00.000Z'};
 const changed=await call('/reports',{method:'POST',headers,body:JSON.stringify({previewToken:staleToken})});assert.equal(changed.status,409);assert.equal((await changed.json()).code,'ARTICLE_REPORT_SOURCE_CHANGED');
 assert.deepEqual(Buffer.from(await (await call('/reports/'+id+'/pdf')).arrayBuffer()),bytes,'later source changes never modify an existing PDF');
 revoked=true;assert.equal((await call('/reports/'+id+'/pdf')).status,403);revoked=false;
 assert.equal((await call('/reports/'+id,{method:'DELETE',headers})).status,200);assert.equal((await call('/reports/'+id+'/pdf')).status,404);
});
test('PostgreSQL uses the same parameterized revision-checked delete contract without schema changes',()=>{
 const {A}=require('../lib/persistence/statements/trade-annotations'),entry=require('../lib/persistence/postgresql/core/trade-annotations').CATALOG.find(row=>row.statement===A.remove);
 assert.ok(entry);assert.equal(entry.sql,'DELETE FROM gp.trade_annotations WHERE id = ( $2 :: text ) AND scope_id = ( $4 :: text ) AND kind = ( $3 :: text ) AND revision = ( $1 :: bigint )');
});
