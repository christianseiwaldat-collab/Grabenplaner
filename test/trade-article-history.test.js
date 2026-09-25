'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('../test-support/trade-insights-sqlite');
const {resolveArticleReference:resolve}=require('../lib/trade-article-reference');
const {createTradeArticleReader}=require('../lib/persistence/repositories/trade-article-history');
const current={articleNumber:'000042',label:'Neue Kamera',origin:'current',createdAt:'2021-01-01T00:00:00.000',deletedAt:null};
const archived={articleNumber:'000042',label:'Alte Kamera',origin:'archive',createdAt:'2000-01-01T00:00:00.000',deletedAt:'2020-12-31T00:00:00.000'};
const grant=f=>{f.state.session={...f.state.session,permissions:[...f.state.session.permissions,'sales:articles:access','sales:articles:read']};};
const lookup=(f,key,day)=>f.app.provider.transaction(tx=>createTradeArticleReader({access:f.app.provider,tx,protection:f.protection,scopeId:'grabenplaner-main',ownerId:'synthetic-owner'}).resolve(key,day),{readOnly:true,isolation:'serializable'});
test('Exact article identity and historical periods never guess a target or a price',()=>{
 assert.equal(resolve('42',[current,archived]).status,'missing');
 assert.equal(resolve('000042',[current,archived]).status,'ambiguous');
 assert.equal(resolve('000042',[current,archived],{businessDate:'2019-06-30'}).label,'Alte Kamera');
 assert.equal(resolve('000042',[current,archived],{businessDate:'2022-06-30'}).label,'Neue Kamera');
 assert.equal(resolve('000042',[archived],{businessDate:'1999-12-31'}).status,'outside_period');
 assert.equal(resolve('000042',[archived],{businessDate:'2020-12-31'}).status,'archived');
 assert.equal(resolve('000042',[{...archived,deletedAt:null}],{businessDate:'2019-01-01'}).status,'period_unknown');
 assert.equal(resolve('000042',[{...archived,createdAt:'2020-02-30'}],{businessDate:'2019-01-01'}).label,null);
 assert.equal(resolve('000042',[current,archived],{businessDate:'2020-02-30'}).status,'period_unknown');
 assert.equal(resolve('000042',[current,{...archived,deletedAt:'2022-12-31'}],{businessDate:'2022-01-01'}).status,'ambiguous');
 assert.deepEqual(Object.keys(resolve('000042',[archived])).sort(),['articleNumber','businessDate','candidates','label','status']);
});
test('Encrypted current and WEUM imports provide bounded search, provenance and date-aware references',async t=>{
 const f=await fixture(t);grant(f);
 assert.equal((await f.run('article-history')).available,false);
 await f.ingest('ARTIKEL_STAMM',[{EAN:'000042',Artikelbezeichnung:'Neue Kamera',Sortiment:'Digital',Anlagedatum:current.createdAt},{EAN:'42',Artikelbezeichnung:'Eigene Kennung',Anlagedatum:current.createdAt}],{master:true});
 await f.ingest('ARTIKEL_STAMMGelöscht',[{EAN:'000042',Artikelbezeichnung:'Alte Kamera',Sortiment:'Analog',Anlagedatum:archived.createdAt,Löschdatum:archived.deletedAt},...Array.from({length:102},(_,i)=>({EAN:'ARCH-'+i,Artikelbezeichnung:'Archivobjektiv '+i,Anlagedatum:archived.createdAt,Löschdatum:archived.deletedAt}))],{sourceInstance:'tradefoto-weum'});
 let page=await f.run('article-history',{status:'all'}),rows=[...page.rows];assert.equal(page.scanned,100);assert.ok(page.next);
 const first=page;
 while(page.next){page=await f.run('article-history',{status:'all',cursor:page.next});rows.push(...page.rows);}
 assert.equal(rows.length,104);assert.equal(new Set(rows.map(r=>r.articleNumber)).size,104);
 const match=rows.find(r=>r.articleNumber==='000042');assert.equal(match.status,'ambiguous');assert.equal(match.candidates.length,2);
 assert.equal(match.candidates.find(r=>r.origin==='archive').snapshotAt,'2026-09-14T09:00:00.000Z');
 const exact=await f.run('article-history',{status:'all',query:'000042',searchMode:'exact'});assert.equal(exact.scanned,2);assert.equal(exact.next,null);assert.deepEqual(exact.rows,[match]);
 assert.equal((await f.run('article-history',{status:'current',query:'42',searchMode:'exact'})).rows[0].articleNumber,'42');
 assert.deepEqual((await f.run('article-history',{status:'archived',query:'42',searchMode:'exact'})).rows,[]);
 await assert.rejects(f.run('article-history',{status:'all',query:'000042',searchMode:'exact',cursor:first.next}),e=>e.code==='IMPORT_BESTELL_CURSOR');
 await assert.rejects(f.run('article-history',{searchMode:'exact'}));

 assert.equal((await lookup(f,'000042','2019-06-30')).label,'Alte Kamera');assert.equal((await lookup(f,'42','2022-01-01')).label,'Eigene Kennung');
 assert.equal((await lookup(f,'ARCH-0','2022-01-01')).label,null);
 page=await f.run('article-history',{status:'all',query:'Neue Kamera'});rows=[...page.rows];while(page.next){page=await f.run('article-history',{status:'all',query:'Neue Kamera',cursor:page.next});rows.push(...page.rows);}assert.equal(rows.length,1);assert.equal(rows[0].status,'ambiguous');
 assert.doesNotMatch(JSON.stringify(rows),/EK_|VK_|targetId|KUND_NR/);
 assert.equal(f.app.database.prepare('SELECT COUNT(*) AS n FROM sales_articles').get().n,0,'display enrichment must not create active articles');
 await assert.rejects(f.run('article-history',{status:'current',cursor:first.next}),e=>e.code==='IMPORT_BESTELL_CURSOR');
 await f.ingest('ARTIKEL_STAMM',[{EAN:'42',Artikelbezeichnung:'Geänderter Name',Anlagedatum:current.createdAt}],{master:true,snapshotAt:'2026-09-15T09:00:00.000Z'});
 await assert.rejects(f.run('article-history',{status:'all',cursor:first.next}),e=>e.code==='IMPORT_BESTELL_CURSOR');
 f.state.session={...f.state.session,permissions:f.state.session.permissions.filter(p=>p!=='sales:articles:read')};
 await assert.rejects(f.run('article-history'),e=>e.status===403);
});
test('Archive updates and undo retain authenticated provenance and incomplete imports are withheld',async t=>{
 const f=await fixture(t);grant(f);
 const data={EAN:'000042',Artikelbezeichnung:'Originalarchiv',Anlagedatum:archived.createdAt,Löschdatum:archived.deletedAt};
 const first=await f.ingest('ARTIKEL_STAMMGelöscht',[data],{sourceInstance:'tradefoto-weum'});
 let second=await f.ingest('ARTIKEL_STAMMGelöscht',[{...data,Artikelbezeichnung:'Korrigiertes Archiv'}],{sourceInstance:'tradefoto-weum',snapshotAt:'2026-09-15T09:00:00.000Z'});
 assert.equal((await lookup(f,'000042','2010-01-01')).label,'Korrigiertes Archiv');
 second=await f.engine.undo(second.id,second.revision);assert.equal(second.status,'reverted');
 assert.equal((await lookup(f,'000042','2010-01-01')).label,'Originalarchiv');
 let pending=await f.ingest('ARTIKEL_STAMMGelöscht',Array.from({length:450},(_,i)=>({...data,EAN:'WAIT-'+i})),{sourceInstance:'tradefoto-weum',apply:false});
 pending=await f.engine.apply(pending.id,pending.revision);assert.equal(pending.status,'applying');
 assert.equal((await lookup(f,'000042','2010-01-01')).status,'source_pending');
 await assert.rejects(f.run('article-history'),e=>e.code==='IMPORT_BESTELL_SOURCE_INCOMPLETE');
 do{pending=await f.engine.apply(pending.id,pending.revision);}while(pending.status==='applying');
 assert.equal((await lookup(f,'000042','2010-01-01')).label,'Originalarchiv');
 assert.equal(first.status,'applied');
});
test('Reference markup retains original receipt text and escapes all supplemental source values',()=>{
 const UI=require('../public/trade-article-history'),Sales=require('../public/sales-history'),Receipt=require('../public/receipt-search');
 const display=resolve('000042',[{...archived,label:'<img src=x> Archiv'}],{businessDate:'2019-06-30'});
 const row={date:'2019-06-30',article:'000042',description:'Originalbezeichnung',displayDescription:'Originalbezeichnung',articleDisplay:display,quantity:'2',sourcePrice:'12.34',issues:[],kind:'receipts',positions:1,provenance:{},lines:[]};
 row.lines=[{...row}];
 for(const html of [UI.referenceMarkup(display,row.description),Sales.renderTable([row],'sales'),Receipt.renderDetail(row)]){
  assert.match(html,/Originalbezeichnung/);assert.match(html,/Archiviert/);assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img/);
 }
 assert.match(Receipt.renderDetail(row),/24,68/);
});
test('Article-source read statement also compiles for PostgreSQL',()=>{
 const entry=require('../lib/persistence/postgresql/reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG.find(e=>e.statement.id==='trade-insights.article-source-state');
 assert.ok(entry);assert.match(entry.sql,/data_import_runs/);assert.doesNotMatch(entry.sql,/\$scopeId|\$currentHash|\$archiveHash/);
});
