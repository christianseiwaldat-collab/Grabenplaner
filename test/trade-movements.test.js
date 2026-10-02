'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('../test-support/trade-insights-sqlite');
const {interpret}=require('../lib/persistence/repositories/trade-movements');
const M=require('../public/trade-insight-results'),UI=require('../public/trade-movements');
const sourceInstance='tradefoto-weum';
const movement=(id,extra={})=>({We_ID:String(id),We:true,Umlagerung:false,EAN:'000042',Suchname:'Canon',FilialID:'18',Menge:'2',WEDatum:'2026-09-10T00:00:00.000',AkWeDatum:'2026-09-11T00:00:00.000',...extra});
async function seed(t,rows){const f=await fixture(t);await f.ingest('ARTIKEL_STAMM',[{EAN:'000042',Artikelbezeichnung:'Synthetic Camera',Anlagedatum:'2020-01-01T00:00:00.000'}],{master:true});await f.ingest('WE',rows,{sourceInstance});return f;}
test('signed source quantities, flags and precision retain their actual meaning',()=>{
 for(const [value,state] of [['-0.00000001','negative'],['0','zero'],[null,'missing'],['2.2','positive']])assert.equal(interpret(movement(1,{Menge:value})).quantityState,state);
 for(const flags of [[true,true],[false,false],[true,null],[null,true]])assert.equal(interpret(movement(1,{We:flags[0],Umlagerung:flags[1]})).kind,'unclear');
 assert.equal(UI.amount('-0.00000001'),'-0,00000001');assert.equal(M.format('-0.00000001','decimal'),'-0,00000001');
 assert.deepEqual(M.sortRows([{quantity:'-0.01'},{quantity:'-2'}],M.columns('movements'),'quantity').map(r=>r.quantity),['-2','-0.01']);
});
test('WEUM journal keeps dates, source keys, directions, negative quantities and reference evidence distinct',async t=>{
 const f=await seed(t,[movement(1,{Bestellnr:1,Lieferscheinnr:'LS-7',Rechnungsnr:'RE-3',NNPreis:'321.99'}),movement(2,{We:false,Umlagerung:true,FilialID:'19',Filialid2:'18',KorbId:1,Menge:'-2'}),movement(3,{WEDatum:null}),movement(4,{EAN:'42',We:true,Umlagerung:true})]);
 const result=await f.run('movements'),row=id=>result.rows.find(r=>r.movementNumber===String(id));assert.equal(result.rows.length,4);assert.equal(result.scanned,4);
 assert.equal(row(1).references.order.status,'matched');assert.match(row(1).references.order.label,/Position nicht abgeglichen/);assert.equal(row(1).references.delivery,'LS-7');
 assert.equal(row(2).from,'Filiale 19');assert.equal(row(2).to,'Filiale 18');assert.equal(row(2).references.basket.status,'matched');assert.equal(row(2).quantity,'-2');assert.equal(row(2).physicalReceiptConfirmed,false);
 assert.equal(row(3).date,null);assert.ok(row(3).secondaryDate);assert.equal(row(4).articleReference.status,'missing');assert.equal(row(4).kind,'unclear');
 assert.doesNotMatch(JSON.stringify(result),/NNPreis|321\.99|Rechnungspreis/);
 assert.equal((await f.run('movements',{articleNumber:'42'})).rows.length,1);
 assert.equal((await f.run('movements',{movementType:'transfer'})).rows.length,1);
 assert.equal((await f.run('movements',{review:'negative'})).rows.length,1);
 assert.deepEqual((await f.run('movements',{review:'missing_date'})).rows.map(r=>r.movementNumber),['3']);
 assert.equal((await f.run('movements',{dateFrom:'2026-09-10',dateTo:'2026-09-10'})).scanned,3);
 assert.equal((await f.run('movements',{dateFrom:'2026-09-11'})).scanned,0,'AkWeDatum is not used as a booking date');
 await assert.rejects(f.run('movements',{dateFrom:'2026-09-11',review:'missing_date'}));
});
test('branch grants redact the opposite transfer endpoint and prevent reference side channels',async t=>{
 const f=await seed(t,[movement(1,{We:false,Umlagerung:true,FilialID:'19',Filialid2:'18',KorbId:1}),movement(2,{FilialID:'19'}),movement(3,{FilialID:'98'})]);
 const base=f.state.session;
 f.state.session={...base,permissions:base.permissions.filter(v=>!v.includes('company')&&!v.includes('unassigned')),scopes:[{locationId:'18'}]};
 const p=(await f.run('context')).projection;assert.equal(p.company,false);assert.deepEqual(p.locationIds,['18']);
 const rows=(await f.run('movements')).rows;assert.equal(rows.length,1);assert.equal(rows[0].from,'Nicht freigegeben');assert.equal(rows[0].endpoints.from.sourceId,null);assert.equal(rows[0].references.basket.status,'unresolved');
 await assert.rejects(f.run('movements',{locationId:'19'}),e=>e.status===403);
 f.state.session={...base,permissions:base.permissions.filter(v=>v!=='sales:purchasing:read')};await assert.rejects(f.run('movements'),e=>e.status===403);
});
test('date-bounded pages and cursors reject source changes instead of mixing results',async t=>{
 const f=await seed(t,Array.from({length:240},(_,i)=>movement(i+1,{WEDatum:i<210?'2026-09-10T00:00:00.000':'2025-01-01T00:00:00.000'})));
 const q={dateFrom:'2026-09-01'},first=await f.run('movements',q);assert.equal(first.rows.length,200);assert.ok(first.next);
 const second=await f.run('movements',{...q,cursor:first.next});assert.equal(second.rows.length,10);assert.equal(second.next,null);assert.equal(new Set([...first.rows,...second.rows].map(r=>r.id)).size,210);
 await assert.rejects(f.run('movements',{...q,movementType:'transfer',cursor:first.next}),e=>e.code==='IMPORT_BESTELL_CURSOR');
 await f.ingest('WE',[movement(999)],{sourceInstance,snapshotAt:'2026-09-15T09:00:00.000Z'});
 const updated=await f.run('movements');assert.ok(updated.sourceDates.includes('2026-09-14T09:00:00.000Z'));
 let cursor='',newest=[];do{const page=await f.run('movements',{articleNumber:'000042',query:'999',...(cursor?{cursor}:{})});newest.push(...page.sourceDates);cursor=page.next;}while(cursor);assert.deepEqual([...new Set(newest)],['2026-09-15T09:00:00.000Z']);
 await assert.rejects(f.run('movements',{...q,cursor:first.next}),e=>e.code==='IMPORT_BESTELL_CURSOR');
});

test('article Umlagerungen use referenced keys, newest date paging, exact quantities, and scope on either endpoint',async t=>{
 const f=await fixture(t);
 await f.ingest('ARTIKEL_STAMM',[{EAN:'000042',Artikelbezeichnung:'Selected camera'},{EAN:'42',Artikelbezeichnung:'Different article'},{EAN:'000043',Artikelbezeichnung:'Other camera'}],{master:true});
 const rows=Array.from({length:240},(_,i)=>movement(i+1,{We:false,Umlagerung:true,FilialID:'19',Filialid2:'18',WEDatum:i<210?'2026-09-12T00:00:00.000':'2026-08-10T00:00:00.000'}));
 rows.push(...Array.from({length:240},(_,i)=>movement(i+500,{EAN:'000043',We:false,Umlagerung:true})),movement(999,{EAN:'42',We:false,Umlagerung:true}),movement(1000));
 await f.ingest('WE',rows,{sourceInstance});
 const query={articleNumber:'000042',dateFrom:'2026-08-01',dateTo:'2026-09-14'};
 const first=await f.run('article-movements',query);assert.equal(first.rows.length,200);assert.equal(first.scanned,200);assert.ok(first.next);assert.equal(first.order,'date-desc');assert.ok(first.rows.every(r=>r.date.startsWith('2026-09-12')));
 const second=await f.run('article-movements',{...query,cursor:first.next});assert.equal(second.rows.length,40);assert.equal(second.next,null);assert.equal(second.scanned,41,'only this article includes its one receipt candidate; other referenced articles are excluded in SQL');
 const all=[...first.rows,...second.rows];assert.equal(new Set(all.map(r=>r.id)).size,240);assert.ok(all.every(r=>r.kind==='transfer'&&r.articleNumber==='000042'));assert.equal(second.rows.at(-1).date.slice(0,10),'2026-08-10');
 await assert.rejects(f.run('article-movements',{...query,articleNumber:'000043',cursor:first.next}),e=>e.code==='IMPORT_BESTELL_CURSOR');
 const base=f.state.session;f.state.session={...base,permissions:base.permissions.filter(v=>!v.includes('company')&&!v.includes('unassigned')),scopes:[{locationId:'18'}]};
 const scoped=await f.run('article-movements',query);assert.equal(scoped.rows.length,200);assert.ok(scoped.rows.every(r=>r.endpoints.to.locationId==='18'&&r.endpoints.from.locationId===null));
 await assert.rejects(f.run('article-movements',{...query,locationId:'19'}),e=>e.status===403);
});

test('article Umlagerungen retain unresolved legacy references without scanning other bound articles',async t=>{
 const f=await fixture(t);await f.ingest('WE',[movement(1,{We:false,Umlagerung:true,Filialid2:'19'}),movement(2,{EAN:'missing-other',We:false,Umlagerung:true,Filialid2:'19'})],{sourceInstance});
 await f.ingest('ARTIKEL_STAMM',[{EAN:'000042',Artikelbezeichnung:'Imported later',Anlagedatum:'2020-01-01T00:00:00.000'}],{master:true});
 const result=await f.run('article-movements',{articleNumber:'000042'});assert.deepEqual(result.rows.map(r=>r.movementNumber),['1']);assert.equal(result.scanned,2);assert.equal(result.rows[0].label,'Imported later');
 f.state.session={...f.state.session,permissions:f.state.session.permissions.filter(v=>v!=='sales:purchasing:read')};await assert.rejects(f.run('article-movements',{articleNumber:'000042'}),e=>e.status===403);
});
test('Article transfer endpoint filters are directional, permission checked and bound to cursors',async t=>{
 const f=await seed(t,[movement(1,{We:false,Umlagerung:true,FilialID:'19',Filialid2:'18'}),movement(2,{We:false,Umlagerung:true,FilialID:'18',Filialid2:'19'}),movement(3,{We:false,Umlagerung:true,FilialID:'98',Filialid2:'18'})]);
 const query={articleNumber:'000042'};
 assert.deepEqual((await f.run('article-movements',{...query,fromLocationId:'19',toLocationId:'18'})).rows.map(r=>r.movementNumber),['1']);
 assert.deepEqual((await f.run('article-movements',{...query,fromLocationId:'18'})).rows.map(r=>r.movementNumber),['2']);
 assert.deepEqual((await f.run('article-movements',{...query,fromLocationId:'trade-source:98',toLocationId:'18'})).rows.map(r=>r.movementNumber),['3']);
 const base=f.state.session;f.state.session={...base,permissions:base.permissions.filter(v=>!v.includes('company')&&!v.includes('unassigned')),scopes:[{locationId:'18'}]};
 const own=await f.run('article-movements',{...query,toLocationId:'18'});assert.equal(own.rows.length,2);assert.ok(own.rows.every(r=>r.endpoints.from.sourceId===null));
 for(const filters of [{fromLocationId:'19'},{toLocationId:'19'},{fromLocationId:'trade-source:98'}])await assert.rejects(f.run('article-movements',{...query,...filters}),e=>e.status===403);
 f.state.session=base;
 await f.ingest('WE',Array.from({length:210},(_,i)=>movement(i+100,{We:false,Umlagerung:true,FilialID:'19',Filialid2:'18'})),{sourceInstance,snapshotAt:'2026-09-15T09:00:00.000Z'});
 const page=await f.run('article-movements',{...query,toLocationId:'18'});assert.ok(page.next);
 await assert.rejects(f.run('article-movements',{...query,toLocationId:'19',cursor:page.next}),e=>e.code==='IMPORT_BESTELL_CURSOR');
});

test('article display numbers resolve only explicit Trade source links, preserving different numeric identities',async t=>{
 const f=await fixture(t),C=require('../lib/data-import-contract'),sourceKey='0000000000042';
 const articles=[{sourceArticleKey:sourceKey,articleNumber:'000042',description:'Catalog camera',active:true,sourceUpdatedAt:null,identifiers:[],prices:[]}];
 await require('../lib/persistence/repositories/sales-article-catalog').createSalesArticleCatalogRepository(f.app.provider).importSnapshot({snapshot:{sourceSystem:'tradefoto.artikel_stamm',sourceProfileVersion:'workspace-test-v1',sourceSchemaSha256:C.fingerprint('test-schema'),sourceFileSha256:C.fingerprint(articles),contentSha256:require('../lib/sales-article-catalog').salesArticleImportContentSha256(articles),snapshotAt:'2026-09-14T09:00:00.000Z',articles},actor:'synthetic-owner',timestamp:'2026-09-14T09:00:00.000Z'});
 await f.ingest('ARTIKEL_STAMM',[{EAN:sourceKey,Artikelbezeichnung:'Matching source',Anlagedatum:'2020-01-01T00:00:00.000'},{EAN:'42',Artikelbezeichnung:'Other exact source'}],{master:true});
 await f.ingest('WE',[movement(1,{EAN:sourceKey,We:false,Umlagerung:true,Filialid2:'19'}),movement(2,{EAN:'42',We:false,Umlagerung:true,Filialid2:'19'})],{sourceInstance});
 const result=await f.run('article-movements',{articleNumber:'000042'});assert.equal(result.rows.length,1);assert.equal(result.rows[0].movementNumber,'1');assert.equal(result.rows[0].articleNumber,'000042');assert.equal(result.rows[0].sourceArticleNumber,sourceKey);assert.equal(result.articleIdentity,'catalog_source_link');
 assert.equal(result.rows[0].label,'Catalog camera');assert.equal(result.rows[0].labelSource,'catalog_current');assert.equal(result.rows[0].sourceLabel,'Matching source');
 // The selected current catalog label does not erase uncertain historical provenance.
 await f.ingest('WE',[movement(3,{EAN:sourceKey,We:false,Umlagerung:true,Filialid2:'19',WEDatum:'2019-09-10T00:00:00.000'})],{sourceInstance,snapshotAt:'2026-09-15T09:00:00.000Z'});
 const old=(await f.run('article-movements',{articleNumber:'000042'})).rows.find(row=>row.movementNumber==='3');
 assert.equal(old.label,'Catalog camera');assert.equal(old.sourceLabel,'Artikelreferenz ungeklärt');assert.equal(old.articleReference.status,'outside_period');assert.ok(old.issues.includes('Artikelreferenz prüfen'));
 const exact=await f.run('movements',{articleNumber:'42'});assert.deepEqual(exact.rows.map(r=>r.movementNumber),['2']);
});

test('article movements keyset statements compile for PostgreSQL with literal column contracts',()=>{
 const entries=require('../lib/persistence/postgresql/reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG.filter(e=>e.statement.id.startsWith('trade-insights.article-movements-'));assert.equal(entries.length,4);
 for(const entry of entries){assert.match(entry.sql,/integration\s*\.\s*"?import_history_references/);assert.doesNotMatch(entry.sql,/\$(scopeId|master1|afterDate|afterId)/);assert.ok(entry.parameterOrder.includes('master14'));assert.match(entry.sql,/ORDER BY.*DESC/);}
});

test('unlinked Trade branch imports use accepted cash bindings without widening a branch grant',async t=>{
 const f=await seed(t,[movement(1,{FilialID:'018'}),movement(2,{FilialID:'19'})]);
 f.app.database.prepare('DELETE FROM import_master_bindings').run();
 assert.equal((await f.run('movements',{locationId:'18'})).rows.length,0);
 const C=require('../lib/data-import-contract'),H=require('../lib/tradefoto-history-profiles'),tables=require('../lib/persistence/statements/cash-snapshots').CASH_SNAPSHOT_TABLES,policies=require('../lib/cash-source-policies').CASH_SOURCE_POLICIES;
 const raw=(name,extra)=>({...Object.fromEntries(H.tableFor('cash',name).columns.map(c=>[c.name,null])),...extra});
 const head=raw('Umsatz_KASSE',{Bonnr:'1',Filialid:'18',Kassenid:'1',Bondatum:'2026-09-10T00:00:00.000',RechnungsBetrag:'12',KUND_NR:'0'});
 const data={Umsatz_KASSE:[head],Umsatz_Kasse_Details:[raw('Umsatz_Kasse_Details',{Bonnr:'1',Filialid:'18',Kassenid:'1',Bondatum:head.Bondatum,RepID:'00000000-0000-0000-0000-000000000001',EAN:'000042',VKMenge:'1',VK_Preis:'12',MWST:'20',...policies[0].policy.statusRules[3].flags})]};
 const actor={scopeId:'grabenplaner-main',ownerId:'synthetic-owner'},fileSha256=C.fingerprint(data),id=f.protection.digest(['source',actor,'cash',fileSha256]),store=require('../lib/persistence/repositories/cash-snapshots').createCashSnapshotStore({access:f.app.provider,protection:f.protection,actor});
 await store.begin(id,{kind:'cash',fileSha256,bytes:4096,tables:tables.map(table=>({name:table.name,profileHash:table.profile.fingerprint,declaredRows:data[table.name]?.length||0}))});
 for(const table of tables){const values=data[table.name]||[];await store.startTable(id,table.name,values.length);if(values.length)await store.append(id,table.name,1,values.map((row,i)=>H.prepareTradeFotoHistoryRow('cash',table.name,row,{fileSha256,rowNumber:i+1})));await store.finishTable(id,table.name);}
 let result=await store.seal(id,{tables:tables.length,rows:2});while(result.status==='reviewing')result=await store.review(id);
 const publish=require('../lib/persistence/repositories/cash-publication-runtime').createCashPublicationRuntime({access:f.app.provider,vault:f.vault,scopeId:actor.scopeId,enabled:true,policies:[{...policies[0],fileSha256}]});
 const importSession={...f.state.session,permissions:[...f.state.session.permissions,'data:imports:read','data:imports:prepare','data:imports:apply','locations:write','personnel:central:read','personnel:central:write']},request={sourceId:id,expectedRevision:0,label:'Synthetic cash',policyId:policies[0].id,resolveArticles:false,mappings:[{kind:'FILIALEN',sourceId:'18',targetId:'18',historical:false}]};
 const plan=await publish.operation(async()=>importSession,'preview',{request});await publish.operation(async()=>importSession,'activate',{request,planHash:plan.planHash});
 const q={locationId:'18',dateFrom:'2026-09-01',dateTo:'2026-09-14'},visible=await f.run('movements',q);assert.deepEqual(visible.rows.map(r=>r.movementNumber),['1']);assert.equal(visible.rows[0].endpoints.to.locationId,'18');
 const base=f.state.session;f.state.session={...base,permissions:base.permissions.filter(v=>!v.includes('company')&&!v.includes('unassigned')),scopes:[{locationId:'18'}]};assert.deepEqual((await f.run('movements')).rows.map(r=>r.movementNumber),['1']);
 await assert.rejects(f.run('movements',{locationId:'19'}),e=>e.status===403);
});
test('saved journal and its PDF remain tied to the original rows after later imports',async t=>{
 const f=await seed(t,[movement(1,{Menge:'-2',Bestellnr:1,Lieferscheinnr:'LS-7'}),movement(2,{We:false,Umlagerung:true,FilialID:'19',Filialid2:'18',KorbId:1})]);
 const jobs=require('../lib/persistence/repositories/trade-insight-jobs').createTradeInsightJobs({access:f.app.provider,vault:f.vault,runtime:f.runtime,resolvePrincipal:async()=>({...f.state.session,id:undefined})});t.after(()=>jobs.stop());
 const job=await jobs.create(f.state.session,{kind:'movements',query:{},title:'Warenbewegungen · Synthetische Abnahme'});await jobs.tick();
 const before=await jobs.get(f.state.session,job.id);await f.ingest('WE',[movement(1,{Menge:'7'})],{sourceInstance});assert.deepEqual((await jobs.get(f.state.session,job.id)).result,before.result);
 const pdf=await require('../lib/trade-insight-pdf').createTradeInsightPdf(before,{sort:'date',direction:'desc'});assert.equal(pdf.subarray(0,4).toString(),'%PDF');
 if(process.env.MOVEMENT_PDF_OUTPUT)require('node:fs').writeFileSync(process.env.MOVEMENT_PDF_OUTPUT,pdf);
 const html=UI.detail({...before.result.rows[0],label:'<img onerror=evil()>'},require('../public/trade-article-history'));assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.match(html,/WEDatum/);assert.match(html,/AkWeDatum/);
});
test('partially applied WEUM imports are withheld, and undo restores authenticated source quantities',async t=>{
 const f=await seed(t,[movement(1)]);
 let update=await f.ingest('WE',[movement(1,{Menge:'8'})],{sourceInstance,snapshotAt:'2026-09-15T09:00:00.000Z'});
 assert.equal((await f.run('movements')).rows[0].quantity,'8');update=await f.engine.undo(update.id,update.revision);
 assert.equal(update.status,'reverted');assert.equal((await f.run('movements')).rows[0].quantity,'2');
 let pending=await f.ingest('WE',Array.from({length:450},(_,i)=>movement(i+20)),{sourceInstance,apply:false});
 pending=await f.engine.apply(pending.id,pending.revision);assert.equal(pending.status,'applying');
 await assert.rejects(f.run('movements'),e=>e.code==='IMPORT_BESTELL_SOURCE_INCOMPLETE');
});
test('mismatched references and unknown direction never become confirmed transfers',async t=>{
 const f=await seed(t,[movement(1,{We:false,Umlagerung:true,FilialID:'18',Filialid2:'19',KorbId:1}),movement(2,{Suchname:'Different supplier',Bestellnr:1}),movement(3,{We:true,Umlagerung:true,Filialid2:'19'})]);
 const rows=(await f.run('movements')).rows;
 assert.equal(rows.find(r=>r.movementNumber==='1').references.basket.status,'conflict');
 assert.equal(rows.find(r=>r.movementNumber==='2').references.order.status,'conflict');
 const uncertain=rows.find(r=>r.movementNumber==='3');assert.equal(M.columns('movements').find(c=>c.key==='from').value(uncertain),'Ungeklärt');
 assert.equal(rows.some(r=>r.physicalReceiptConfirmed),false);
});
test('all five bounded movement statements compile into the PostgreSQL reporting catalog',()=>{
 const entries=require('../lib/persistence/postgresql/reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG.filter(e=>e.statement.id.startsWith('trade-insights.movement'));
 assert.equal(entries.length,5);for(const e of entries){assert.doesNotMatch(e.sql,/\$(scopeId|dateFrom|dateTo|missingDate|weHash)/);assert.ok(e.parameterOrder.length);}
 assert.match(entries.find(e=>e.statement.id.endsWith('records')).sql,/LIMIT/);
});
test('multipage journal PDF keeps all rows, archive labels and printable page boundaries',async()=>{
 const rows=Array.from({length:28},(_,i)=>({movementNumber:String(i+1),date:'2026-09-10',typeLabel:'Wareneingang',kind:'receipt',articleNumber:'DEMO-'+i,label:'Lange synthetische Artikelbezeichnung zur Prüfung des Zeilenumbruchs',articleReference:{status:'archived'},quantity:i%2?'-0.25':'2',from:'Lieferant',to:'Filiale 18',supplier:'Demo Lieferant',documentRefs:'Best. 123 · LS DEMO-444 · RE DEMO-222',issueLabel:'Negative Menge · Grund ungeklärt'}));
 const pdf=await require('../lib/trade-insight-pdf').createTradeInsightPdf({kind:'movements',title:'PDF-Layoutprüfung',created:'2026-09-25T09:00:00.000Z',completedAt:'2026-09-25T09:00:00.000Z',query:{movementType:'receipt'},projection:{},result:{rows,note:'Synthetische Beispiele',sourceDate:'2026-09-24T09:00:00.000Z'}});
 const loading=(await import('pdfjs-dist/legacy/build/pdf.mjs')).getDocument({data:new Uint8Array(pdf),isEvalSupported:false}),doc=await loading.promise,text=[];
 try{assert.ok(doc.numPages>1);for(let i=1;i<=doc.numPages;i++){const content=await (await doc.getPage(i)).getTextContent();text.push(content.items.map(r=>r.str).join(' '));for(const item of content.items.filter(r=>r.str?.trim())){assert.ok(item.transform[4]>=31&&item.transform[4]+item.width<=812,item.str);assert.ok(item.transform[5]>=20&&item.transform[5]<=573,item.str);}}assert.match(text.join(' '),/Archiviert/);assert.match(text.join(' '),/DEMO-27/);assert.match(text.join(' '),/-0,25/);}finally{await loading.destroy();}
});
