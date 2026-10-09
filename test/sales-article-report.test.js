'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Model=require('../lib/sales-article-report-model'),Pdf=require('../lib/sales-article-report-pdf');
const {fixture,rights}=require('../test-support/trade-insights-sqlite');
const {SALES_ARTICLE_CATALOG_PERMISSION_IDS:catalogRights}=require('../lib/sales-article-catalog-access');
const full={prices:true,costs:true,margin:true};
const catalog=()=>({articleNumber:'000042',description:'BEISPIEL Kamera',retailGross:'120',retailNet:'100',internetGross:'114',sourceSystem:'tradefoto.artikel_stamm'});
const row=(overrides={},caps=full)=>Model.projectRow({key:'a',source:{EAN:'0000000000042',Artikelbezeichnung:'Quellbezeichnung',Abverkauf:true,DurchschnittEK:'70',MWST:1},stock:{EAN:'0000000000042',FilialID:18,FBestand:'2',Bestellt:'3'},location:{id:'18',label:'18 · BEISPIEL'},catalog:catalog(),...overrides},caps);
test('report calculation uses exact decimal net margin, source VAT, and distinguishes unavailable values',()=>{
 const a=row();assert.equal(a.marginPercent,'30');assert.equal(a.stockValue,'140');assert.equal(a.quantity,'2');assert.equal(a.articleNumber,'000042');assert.equal(a.assortment,'Abverkauf');
 const vat=row({catalog:{...catalog(),retailNet:null}});assert.equal(vat.marginPercent,'30');
 const missingVat=row({source:{EAN:'0000000000042',DurchschnittEK:'70',MWST:9},catalog:{...catalog(),retailNet:null}});assert.equal(missingVat.marginPercent,null);
 const zero=row({catalog:{...catalog(),retailNet:'0',retailGross:'0'}});assert.equal(zero.marginPercent,null);
 const missingCost=row({source:{EAN:'0000000000042',MWST:1}});assert.equal(missingCost.averageCost,null);assert.equal(missingCost.marginPercent,null);assert.equal(missingCost.stockValue,null);
 const zeroStock=row({stock:{EAN:'0000000000042',FilialID:18,FBestand:'0',Bestellt:'0'}});assert.equal(zeroStock.stockValue,'0','a confirmed zero quantity is zero value, not an unknown');
 const ambiguous=row({ambiguous:true});assert.equal(ambiguous.quantity,null);assert.equal(ambiguous.ordered,null);assert.equal(ambiguous.stockValue,null);
 const manual=row({catalog:{...catalog(),sourceSystem:'manual.article-catalog',purchaseNet:'50'}});assert.equal(manual.averageCost,'50');assert.equal(manual.marginPercent,'50');
 const manualMissing=row({catalog:{...catalog(),sourceSystem:'manual.article-catalog',purchaseNet:null}});assert.equal(manualMissing.averageCost,null,'manual revision never substitutes a newer source EK');
 const omitted=row({},{});for(const key of ['retailGross','internetGross','averageCost','marginPercent','stockValue'])assert.equal(Object.hasOwn(omitted,key),false,key);
});
test('global sort, null placement, totals and pagination are independent of the selected page',()=>{
 const rows=[row({key:'a'}),row({key:'b',stock:{FilialID:19,FBestand:'10',Bestellt:'0'},location:{id:'19',label:'19 · BEISPIEL'}}),row({key:'c',ambiguous:true})];
 const q=Model.normalizeFilters({stock:'all',sort:'quantity',direction:'desc',limit:1,offset:0},full),r=Model.resultFor(rows,q,'2026-10-08',full);
 assert.equal(r.rows[0].quantity,'10');assert.equal(r.total,3);assert.equal(r.hasMore,true);assert.equal(r.summary.quantity,'12');assert.equal(r.summary.missingQuantity,1);assert.equal(r.summary.stockValue,'840');
 const last=Model.resultFor(rows,{...q,offset:2},null,full);assert.equal(last.rows[0].quantity,null);assert.equal(last.hasMore,false);
 assert.deepEqual(Model.normalizeFilters({locations:'19,18,19'},full).locations,['18','19']);
 assert.throws(()=>Model.normalizeFilters({sort:'marginPercent'},{}),e=>e.status===403);assert.throws(()=>Model.normalizeFilters({limit:201},full));
 assert.throws(()=>Model.normalizeFilters({sql:'DROP TABLE'},full));assert.throws(()=>Model.normalizeFilters({assortment:'made-up'},full));
});
test('report preferences and PDF columns cannot restore withdrawn price or cost rights',()=>{
 assert.throws(()=>Model.normalizePreferences({columns:['articleNumber','marginPercent']},{}));
 assert.throws(()=>Pdf.normalize({filters:{},columns:['stockValue']},{}));
 assert.throws(()=>Model.normalizePreferences({columns:['articleNumber'],columnWidths:{articleNumber:900}},full));
 assert.equal(Pdf.filename('../../Stock<bad>.pdf'),'Stock.pdf');
 assert.equal(Model.articleNumber('0000000000042'),'000042');
});
async function setup(t,{duplicates=false,count=2}={}){
 const f=await fixture(t);f.state.session.permissions=[...rights,...catalogRights];
 const source=Array.from({length:count},(_,i)=>({EAN:String(i+42).padStart(13,'0'),Artikelbezeichnung:`BEISPIEL Kamera ${i}`,Sortimentsart:i?'Lagerware':'Abverkauf',Abverkauf:i===0,DurchschnittEK:'70',MWST:1,Sachkonto:false,OhneBestand:false}));
 await f.ingest('ARTIKEL_STAMM',source,{master:true});
 const stocks=source.flatMap((a,i)=>[{EAN:a.EAN,FilialID:18,FBestand:String(i+2),Bestellt:'3'},{EAN:a.EAN,FilialID:19,FBestand:'0',Bestellt:'0'}]);
 if(duplicates)stocks.push({...stocks[0],FBestand:'7'});await f.ingest('ARTIKEL_FILIALEN',stocks,{sourceInstance:'tradefoto-trade'});
 const repo=require('../lib/persistence/repositories/sales-article-catalog').createSalesArticleCatalogRepository(f.app.provider);
 const price=(type,basis,amount,field)=>({priceType:type,priceBasis:basis,amount,currency:'EUR',qualityStatus:'confirmed',sourceField:field});
 const articles=source.map(a=>({sourceArticleKey:a.EAN,articleNumber:Model.articleNumber(a.EAN),description:a.Artikelbezeichnung,active:true,sourceUpdatedAt:null,identifiers:[],prices:[price('sales','gross','120','Verkaufspreis'),price('sales','net','100','eNvk'),price('internet_1','gross','114','Internet_VK'),price('average_purchase','net','70','DurchschnittEK')]}));
 const snapshot={sourceSystem:'tradefoto.artikel_stamm',sourceProfileVersion:'report-test-v1',sourceSchemaSha256:'a'.repeat(64),sourceFileSha256:'b'.repeat(64),snapshotAt:'2026-09-14T09:00:00.000Z',articles,contentSha256:require('../lib/sales-article-catalog').salesArticleImportContentSha256(articles)};
 await repo.importSnapshot({snapshot,actor:'synthetic-owner',timestamp:'2026-09-14T09:01:00.000Z'});
 return {...f,repo,articles};
}
test('real protected SQLite source gives per-branch rows and exact globally paginated filters',async t=>{
 const f=await setup(t),context=await f.run('article-report-context');assert.equal(context.capabilities.read,true);assert.deepEqual(context.locations.map(l=>l.id),['18','19']);
 let result=await f.run('article-report-query',{assortment:'sellout',locations:['18'],stock:'positive'});assert.equal(result.total,1);assert.equal(result.rows[0].articleNumber,'000042');assert.equal(require('../lib/tradefoto-bestell/decimal').compare(result.rows[0].retailGross,'120'),0);assert.equal(result.rows[0].marginPercent,'30');
 result=await f.run('article-report-query',{locations:['18'],sort:'quantity',direction:'desc',limit:1});assert.equal(result.total,2);assert.equal(result.rows[0].quantity,'3');assert.equal(result.hasMore,true);
 const second=await f.run('article-report-query',{locations:['18'],sort:'quantity',direction:'desc',limit:1,offset:1});assert.equal(second.rows[0].quantity,'2');assert.equal(second.hasMore,false);
 const all=await f.run('article-report-export',{stock:'all'});assert.equal(all.rows.length,4);assert.equal(all.hasMore,false);assert.equal(all.summary.quantity,'5');
 await assert.rejects(f.run('article-report-query',{locations:['other']}),e=>e.status===403);
});
test('scopes, catalog prices and cost capabilities protect rows, summaries, sort and exports',async t=>{
 const f=await setup(t);f.state.session.permissions=f.state.session.permissions.filter(p=>!['sales:analytics:company:read','sales:articles:prices:read','sales:articles:costs:read'].includes(p));f.state.session.scopes=[{locationId:'18'}];
 const result=await f.run('article-report-export',{stock:'all'});assert.equal(result.total,2);assert.ok(result.rows.every(r=>r.locationId==='18'));
 assert.doesNotMatch(JSON.stringify(result),/retailGross|internetGross|averageCost|marginPercent|stockValue/);
 await assert.rejects(f.run('article-report-query',{locations:['19']}),e=>e.status===403);
 await assert.rejects(f.run('article-report-query',{sort:'retailGross'}),e=>e.status===403);
 f.state.session.permissions=f.state.session.permissions.filter(p=>p!=='sales:analytics:inventory:read');await assert.rejects(f.run('article-report-query',{}),e=>e.status===403);
});
test('duplicate stock pairs are explicit unknowns and cannot inflate counts or valuation',async t=>{
 const f=await setup(t,{duplicates:true}),result=await f.run('article-report-query',{assortment:'sellout',locations:['18'],stock:'all'});
 assert.equal(result.total,1);assert.equal(result.rows[0].ambiguous,true);assert.equal(result.rows[0].quantity,null);assert.equal(result.rows[0].ordered,null);assert.equal(result.summary.stockValue,'0');
 assert.equal((await f.run('article-report-query',{assortment:'sellout',locations:['18'],stock:'positive'})).total,0);
});
test('cached source stock preserves accepted current prices and source membership after manual renumbering',async t=>{
 const f=await setup(t);await f.run('article-report-query',{locations:['18']});
 const current=await f.repo.getByArticleNumber('000042');
 const updated=await f.repo.updateManual({input:{currentArticleNumber:'000042',expectedRevision:current.currentRevision,articleNumber:'009999',description:'BEISPIEL neue Nummer',identifiers:[],prices:{costs:[{priceType:'average_purchase',priceBasis:'net',amount:'80',currency:'EUR'}]}},actor:'synthetic-owner',timestamp:'2026-09-14T10:00:00.000Z',mutationId:require('node:crypto').randomUUID()});
 let result=await f.run('article-report-query',{assortment:'sellout',locations:['18']});assert.equal(result.rows[0].articleNumber,'009999');assert.equal(require('../lib/tradefoto-bestell/decimal').compare(result.rows[0].averageCost,'80'),0);assert.equal(result.rows[0].marginPercent,'20');
 await f.repo.updateManual({input:{currentArticleNumber:'009999',expectedRevision:updated.revision,articleNumber:'009999',description:'BEISPIEL neue Nummer',identifiers:[],prices:{sales:[{priceType:'sales',priceBasis:'gross',amount:'240',currency:'EUR'}]}},actor:'synthetic-owner',timestamp:'2026-09-14T10:01:00.000Z',mutationId:require('node:crypto').randomUUID()});
 result=await f.run('article-report-query',{assortment:'sellout',locations:['18']});assert.equal(require('../lib/tradefoto-bestell/decimal').compare(result.rows[0].retailGross,'240'),0);assert.equal(result.rows[0].marginPercent,null,'manual gross price without a confirmed current VAT basis has no fabricated net RE');
});
test('PostgreSQL and SQLite reporting packets share a typed current-revision contract',()=>{
 const S=require('../lib/sales-article-report-statements'),entries=S.postgresql(),entry=entries[0];assert.equal(entry.statement,S.catalog);assert.equal(entry.returning,false);assert.deepEqual(new Set(entry.parameterBindings.map(b=>b.parameter)),new Set(['keys','limit']));
 assert.match(entry.sql,/source_article_key/);assert.match(entry.sql,/sales_article_search_projection/);assert.match(entry.sql,/jsonb/);assert.match(entry.sql,/tradefoto\.artikel_stamm/);
 const registered=require('../lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG.find(e=>e.statement===S.catalog);assert.ok(registered);
 const stock=entries.find(e=>e.statement===S.stockCandidates);assert.match(stock.sql,/jsonb_array_elements_text\(\$1::jsonb\)/);assert.match(stock.sql,/jsonb_array_elements_text\(\$2::jsonb\)/);assert.doesNotMatch(stock.sql,/gp\s*\.\s*json_each/);assert.equal(stock.statement.operation,'queryAll');assert.equal(stock.returning,false);
});
test('real PDF has exact page metadata, selected columns, row text and correct A4 orientation',async()=>{
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const rows=Array.from({length:73},(_,i)=>row({key:String(i),catalog:{...catalog(),articleNumber:String(i+42).padStart(6,'0'),description:'BEISPIEL Kamera mit sehr langer eindeutiger Beschreibung '+i}}));
 for(const orientation of ['portrait','landscape']){const spec=Pdf.normalize({filters:{assortment:'sellout'},columns:['articleNumber','description','location','quantity','retailGross','marginPercent'],title:'BEISPIEL Abverkauf',orientation},full),report={available:true,rows,total:rows.length,hasMore:false,sourceAt:'2026-10-08T03:00:00Z'},pdf=await Pdf.render({spec,report,generatedAt:'2026-10-08T12:00:00Z'});
  const doc=await getDocument({data:new Uint8Array(pdf.buffer),disableFontFace:true}).promise;assert.equal(doc.numPages,pdf.pages);assert.ok(pdf.pages>1);assert.equal(pdf.rows,73);
  const first=await doc.getPage(1),viewport=first.getViewport({scale:1});assert.equal(viewport.width>viewport.height,orientation==='landscape');let text='';for(let i=1;i<=doc.numPages;i++)text+=(await (await doc.getPage(i)).getTextContent()).items.map(v=>v.str).join(' ')+' ';
  assert.match(text,/000042/);assert.match(text,/000114/);assert.match(text,/BEISPIEL Abverkauf/);assert.match(text,/EH-VK brutto/);assert.doesNotMatch(text,/Ø EK netto\s+Bestandswert/);assert.match(text,new RegExp(`${pdf.pages} / ${pdf.pages}`));await doc.cleanup();
 }
});
test('HTTP report routes enforce fresh personal rights, CSRF and isolated revisioned table preferences',async t=>{
 const f=await fixture(t),express=require('express'),app=express(),saved=new Map(),session={...f.state.session,permissions:[...rights,...catalogRights]};
 app.use(express.json());let revoked=false,loads=[];
 require('../lib/sales-article-report-routes').register(app,{vault:f.vault,
  preferences:{get:async(employee,key)=>saved.get(employee+':'+key)||null,upsert:async(employee,key,value)=>saved.set(employee+':'+key,{value})},
  sessionFor:req=>({...session,employeeNumber:req.get('x-employee')||session.employeeNumber,isEmployee:req.get('x-branch-account')!=='true'}),
  privateHeaders:res=>res.set('Cache-Control','no-store'),assertFresh:async()=>{if(revoked)throw Object.assign(new Error('Session revoked'),{status:403});},
  assertCsrf:req=>{if(req.get('x-csrf-token')!=='synthetic-csrf')throw Object.assign(new Error('CSRF'),{status:403});},
  loadReport:async(fresh,kind,input)=>{await fresh();loads.push({kind,input});return kind==='context'?{columns:Model.columnsFor(full),available:true}:{available:true,rows:[row()],total:1,hasMore:false,sourceAt:'2026-10-08T03:00:00Z'};}
 });
 app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.code||error.message}));
 const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}/api/sales/article-report`,call=(route,options={})=>fetch(base+route,options),headers={'Content-Type':'application/json','x-csrf-token':'synthetic-csrf'};
 const firstResponse=await call('/preferences'),first=await firstResponse.json();assert.equal(firstResponse.headers.get('cache-control'),'no-store');assert.match(first.revision,/^[a-f0-9]{64}$/);
 const update={preferences:{columns:['articleNumber','description','retailGross'],columnWidths:{description:330},sort:'description',direction:'desc'},revision:first.revision};
 assert.equal((await call('/preferences',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(update)})).status,403);
 const changed=await call('/preferences',{method:'PUT',headers,body:JSON.stringify(update)});assert.equal(changed.status,200);assert.equal((await changed.json()).preferences.columnWidths.description,330);
 assert.equal((await call('/preferences',{method:'PUT',headers,body:JSON.stringify(update)})).status,409,'an outdated revision cannot overwrite an earlier tab');
 const own=await (await call('/preferences')).json(),other=await (await call('/preferences',{headers:{'x-employee':'synthetic-other'}})).json();assert.notEqual(own.revision,other.revision);assert.equal(other.preferences.columnWidths.description,undefined);
 assert.equal((await call('/query?sort=rawSql')).status,403);assert.equal((await call('/context?unknown=1')).status,400);
 assert.equal((await call('/query',{headers:{'x-branch-account':'true'}})).status,403);
 const spec={filters:{assortment:'sellout',locations:['18']},columns:['articleNumber','description','retailGross'],title:'BEISPIEL Abverkauf',name:'Beispiel',orientation:'landscape'};
 const pdf=await call('/pdf-preview',{method:'POST',headers,body:JSON.stringify(spec)});assert.equal(pdf.status,200);assert.equal(pdf.headers.get('content-type'),'application/pdf');assert.equal(pdf.headers.get('x-pdf-pages'),'1');assert.equal(pdf.headers.get('x-report-rows'),'1');assert.match(pdf.headers.get('content-disposition'),/^inline;/);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');assert.equal(loads.at(-1).kind,'export');
 const download=await call('/pdf',{method:'POST',headers,body:JSON.stringify(spec)});assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/^attachment;/);await download.arrayBuffer();
 session.permissions=session.permissions.filter(p=>!['sales:articles:prices:read','sales:articles:costs:read'].includes(p));
 const reduced=await (await call('/preferences')).json();assert.deepEqual(reduced.preferences.columns,['articleNumber','description']);assert.equal((await call('/pdf',{method:'POST',headers,body:JSON.stringify(spec)})).status,400);
 revoked=true;assert.equal((await call('/query')).status,403);
});
test('protected stock scanning keeps global ordering beyond its packet boundary',async t=>{
 const f=await setup(t,{count:205}),result=await f.run('article-report-query',{locations:['18'],sort:'quantity',direction:'desc',limit:2});
 assert.equal(result.total,205);assert.equal(result.rows[0].quantity,'206');assert.equal(result.rows[1].quantity,'205');assert.equal(result.hasMore,true);
 const tail=await f.run('article-report-query',{locations:['18'],sort:'quantity',direction:'desc',limit:2,offset:204});assert.equal(tail.rows[0].quantity,'2');assert.equal(tail.hasMore,false);
 const all=await f.run('article-report-export',{locations:['18'],stock:'all'});assert.equal(all.rows.length,205);assert.equal(all.hasMore,false);
});
test('three-branch sellout report never reads 51,000 irrelevant stock payloads and preserves current search names',async t=>{
 const f=await setup(t,{count:8}),db=f.app.database,M=require('../lib/tradefoto-master-profiles'),MS=require('../lib/persistence/statements/import-master-data').IMPORT_MASTER_STATEMENTS,S=require('../lib/sales-article-report-statements');
 db.exec("INSERT INTO locations VALUES('20',1,'Synthetic 20')");
 await f.ingest('FILIALEN',['18','19','20'].map(FilialID=>({FilialID,FName:'Synthetic branch '+FilialID})),{master:true});
 const branch=(await f.masters.mappings({table:'FILIALEN',sourceInstance:'tradefoto-trade',key:'20'})).items[0],input={recordId:branch.id,expectedSourceRevision:branch.revision,targetId:'20',historical:false,reason:'Synthetic qualification'};
 await f.masters.bind(input,(await f.masters.previewBinding(input)).planHash);
 const stocks=f.articles.flatMap((article,i)=>['18','19','20'].map(FilialID=>({EAN:article.sourceArticleKey,FilialID,FBestand:i===0?'2':'0',Bestellt:'0'})));
 const snapshotAt='2026-09-14T09:30:00.000Z';await f.ingest('ARTIKEL_FILIALEN',stocks,{sourceInstance:'tradefoto-trade',snapshotAt});const snapshot=require('../lib/data-import-contract').fingerprint(['ARTIKEL_FILIALEN',stocks,snapshotAt]);
 const lookup=async(table,key)=>f.app.provider.queryOne(MS.find,{scopeId:'grabenplaner-main',identityHash:M.masterIdentity(f.protection,{scopeId:'grabenplaner-main',sourceInstance:'tradefoto-trade'},table,[key])});
 const article=await lookup('ARTIKEL_STAMM','0000000000042'),other=await lookup('ARTIKEL_STAMM','0000000000043'),locations=await Promise.all(['18','19','20'].map(id=>lookup('FILIALEN',id)));
 const template=db.prepare("SELECT id FROM import_history_records WHERE source_table='ARTIKEL_FILIALEN' LIMIT 1").get().id;
 // Deliberately unreadable unselected ciphertext proves that the report never
 // authenticates/decrypts non-candidates. Only selected rows use real imports.
 const addRecord=db.prepare('INSERT INTO import_history_records SELECT $id,scope_id,source_instance,source,source_table,profile_hash,$identity,revision FROM import_history_records WHERE id=$template');
 const addVersion=db.prepare('INSERT INTO import_history_versions SELECT $id,revision,$snapshot,snapshot_at,imported_by,imported_at,run_id,master_source_instance,business_date,parent_id,parent_revision,payload FROM import_history_versions WHERE record_id=$template ORDER BY revision DESC LIMIT 1');
 const addRef=db.prepare("INSERT INTO import_history_references VALUES($id,1,$role,'internal_business',$master,NULL)");
 db.exec('BEGIN');try{for(let i=0;i<51000;i++){const id='synthetic-unselected-'+String(i).padStart(7,'0'),identity=require('node:crypto').createHash('sha256').update(id).digest('hex');addRecord.run({id,identity,template});addVersion.run({id,snapshot,template});addRef.run({id,role:'article',master:other.id});addRef.run({id,role:'location.filialid',master:locations[i%3].id});}db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
 const result=await f.run('article-report-query',{assortment:'sellout',locations:['18','19','20']});assert.equal(result.total,3);assert.equal(result.scanned,3,'only three matching stock documents are read');assert.equal(result.candidateScanned,8);assert.deepEqual(new Set(result.rows.map(r=>r.locationId)),new Set(['18','19','20']));
 const sql=S.sqlite.find(e=>e.statement===S.stockCandidates).sql,plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all({articles:JSON.stringify([article.id]),locations:JSON.stringify(locations.map(l=>l.id)),scopeId:'grabenplaner-main',snapshot,after:'',limit:201});assert.ok(plan.some(p=>/SEARCH a USING (?:COVERING )?INDEX import_history_reference_master/.test(p.detail)),JSON.stringify(plan));
 const current=await f.repo.getByArticleNumber('000042');await f.repo.updateManual({input:{currentArticleNumber:'000042',expectedRevision:current.currentRevision,articleNumber:'009999',description:'BEISPIEL aktueller Suchname',identifiers:[]},actor:'synthetic-owner',timestamp:'2026-09-14T10:00:00.000Z',mutationId:require('node:crypto').randomUUID()});
 const searched=await f.run('article-report-query',{assortment:'sellout',query:'aktueller Suchname',locations:['18','19','20']});assert.equal(searched.total,3);assert.equal(searched.scanned,3);assert.ok(searched.rows.every(r=>r.articleNumber==='009999'));
 assert.equal((await f.run('article-report-query',{assortment:'sellout',query:'Kamera 0',locations:['18','19','20']})).total,0,'the imported obsolete name never overrides the accepted search name');
});
test('the unchanged 10,000 output cap is applied after search and positive-stock criteria',()=>{
 const base=row(),many=Array.from({length:10001},(_,i)=>({...base,id:String(i),quantity:i?'0':'2'})),q=Model.normalizeFilters({},full);
 assert.equal(Model.resultFor(many,q,null,full).total,1);
 assert.equal(Model.resultFor(many.map((r,i)=>({...r,quantity:'2',description:i?'Unpassend':'BEISPIEL passend'})),{...q,query:'passend BEISPIEL'},null,full).total,1);
 assert.throws(()=>Model.resultFor(many,{...q,stock:'all'},null,full),e=>e.status===413&&e.code==='ARTICLE_REPORT_LIMIT');
});
