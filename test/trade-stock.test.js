'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,rights}=require('../test-support/trade-insights-sqlite');
const {inventoryMetrics}=require('../lib/persistence/repositories/trade-stock');
async function stock(f){
 await f.ingest('ARTIKEL_Warengruppen',[{Warengruppe:1,Bezeichnung:'Synthetic goods'}],{master:true});
 await f.ingest('ARTIKEL_Sortimente',[{Sortiment:10,Warengruppe:1,Bezeichnung:'Synthetic cameras'}],{master:true});
 await f.ingest('ARTIKEL_STAMM',[{EAN:'000042',Artikelbezeichnung:'Camera',Sortiment:10,DurchschnittEK:'123.45',Sachkonto:false,OhneBestand:false},{EAN:'000043',Artikelbezeichnung:'Service',Sortiment:10,DurchschnittEK:'0',Sachkonto:false,OhneBestand:true}],{master:true});
 await f.ingest('ARTIKEL_FILIALEN',[{EAN:'000042',FilialID:18,FBestand:'2'},{EAN:'000043',FilialID:18,FBestand:'4'},{EAN:'000042',FilialID:19,FBestand:'3'}],{sourceInstance:'tradefoto-trade'});
}
test('Physical classification follows groups and overrides, source flags win, imports preserve GP data and CAS rejects stale edits',async t=>{
 const f=await fixture(t);await stock(f);let rows=(await f.run('inventory',{dateFrom:'2026-06-01',dateTo:'2026-09-01'})).rows;
 assert.equal(rows.find(r=>r.articleNumber==='000042').classification.kind,'unknown');assert.equal(rows.find(r=>r.articleNumber==='000043').classification.kind,'excluded');
 let choice=await f.run('classification',{level:'wgr',key:'1'});assert.equal(choice.revision,0);
 choice=await f.run('classification-save',{level:'wgr',key:'1',kind:'goods',expectedRevision:0});assert.equal(choice.revision,1);
 await assert.rejects(f.run('classification-save',{level:'wgr',key:'1',kind:'service',expectedRevision:0}),e=>e.status===409);
 rows=(await f.run('inventory',{})).rows;assert.equal(rows.find(r=>r.articleNumber==='000042'&&r.sourceLocation==='18').stockValue,'246.9');assert.equal(rows.find(r=>r.articleNumber==='000042').noRecordedSale,null);
 await f.run('classification-save',{level:'article',key:'000042',kind:'service',expectedRevision:0});
 rows=(await f.run('inventory')).rows;assert.equal(rows.find(r=>r.articleNumber==='000042').classification.kind,'service');assert.equal(rows.find(r=>r.articleNumber==='000042').stockValue,null);
 await f.ingest('ARTIKEL_STAMM',[{EAN:'000042',Artikelbezeichnung:'Camera',Sortiment:10,DurchschnittEK:'200',Sachkonto:false,OhneBestand:false}],{master:true,snapshotAt:'2026-09-14T10:00:00.000Z'});
 assert.equal((await f.run('classification',{level:'article',key:'000042'})).value.kind,'service');
 assert.equal((await f.run('inventory')).rows.find(r=>r.articleNumber==='000042').classification.kind,'service');
 const metadata=await f.run('stock-metadata');assert.equal(metadata.wgr[0].id,'1');assert.equal(metadata.groups[0].id,'10');
 f.state.session={...f.state.session,permissions:rights.filter(v=>!['sales:inventory:classify','sales:analytics:gross-margin'].includes(v))};
 await assert.rejects(f.run('classification-save',{level:'wgr',key:'1',kind:'goods',expectedRevision:1}),e=>e.status===403);
 assert.doesNotMatch(f.app.database.prepare('SELECT payload FROM trade_annotations LIMIT 1').get().payload,/goods|service|Camera/);
});
test('Slow mover and reach require confirmed goods, full coverage and reconciled quantities; returns do not count as positive sales',()=>{
 const period={from:'2026-06-01',to:'2026-08-29',branch:'18',company:true},kind={kind:'goods',confirmed:true};
 const sales={complete:true,coverage:true,stats:{stock:{18:{net:'3',positive:'5',lastSale:'2026-08-10'}},unverified:0,denied:0,unknownStock:0}};
 assert.deepEqual(inventoryMetrics('2',kind,sales,period),{eligible:true,reason:'Geprüfter Kassenstand',noRecordedSale:false,coverageDays:'60',soldNet:'3',lastSale:'2026-08-10'});
 const unsold={...sales,stats:{...sales.stats,stock:{}}};assert.equal(inventoryMetrics('2',kind,unsold,period).noRecordedSale,true);
 for(const bad of [{...sales,complete:false},{...sales,coverage:false},...['denied','unverified','unknownStock'].map(k=>({...sales,stats:{...sales.stats,[k]:1}}))])assert.equal(inventoryMetrics('2',kind,bad,period).noRecordedSale,null);
 for(const k of ['unknown','excluded','account','service'])assert.equal(inventoryMetrics('2',{kind:k,confirmed:true},sales,period).eligible,false);
 assert.equal(inventoryMetrics('0',kind,sales,period).eligible,false);assert.equal(inventoryMetrics('2',kind,sales,{...period,company:false}).eligible,false);
});
test('Annotation Core SQL has a separate owner and parameterized compare-and-set',()=>{
 const entries=require('../lib/persistence/postgresql/core/trade-annotations').CATALOG;assert.equal(entries.length,4);
 for(const e of entries){assert.match(e.sql,/gp\.trade_annotations/);assert.doesNotMatch(e.sql,/gp\.gp\./);}
 assert.match(entries.find(e=>e.statement.id.endsWith('update')).sql,/revision\s*=\s*\(\s*\$/);
});

test('Cash projection uses reconciled sales, stock branch and weighted prices with exact branch filtering',async t=>{
 const f=await fixture(t);await stock(f);await require('../test-support/trade-insights-cash').insightCashFixture(f);
 await f.run('classification-save',{level:'wgr',key:'1',kind:'goods',expectedRevision:0});
 const prices=await f.run('prices',{query:'000042',dateFrom:'2026-06-01',dateTo:'2026-09-01',locationId:'18'});
 assert.equal(prices.rows.length,1);assert.equal(prices.rows[0].average,'120');assert.equal(prices.rows[0].quantity,'4');assert.equal(prices.rows[0].locationId,'18');
 const inventory=await f.run('inventory',{dateFrom:'2026-06-01',dateTo:'2026-09-01'}),own=inventory.rows.find(r=>r.articleNumber==='000042'&&r.sourceLocation==='18');
 assert.equal(own.soldNet,'3');assert.equal(own.noRecordedSale,false);assert.equal(own.coverageDays,'62');
 const noSale=await f.run('prices',{query:'000043',dateFrom:'2026-06-01',dateTo:'2026-09-01'});assert.equal(noSale.rows.length,0);
 f.state.session={...f.state.session,permissions:rights.filter(p=>p!=='sales:analytics:company:read'),scopes:[{locationId:'18'}]};
 await assert.rejects(f.run('prices',{query:'000042',locationId:'19'}),e=>e.status===403);
});

test('Duplicate stock rows never sum into an invented inventory value',async t=>{
 const f=await fixture(t);await stock(f);await f.run('classification-save',{level:'wgr',key:'1',kind:'goods',expectedRevision:0});
 await f.ingest('ARTIKEL_FILIALEN',[{EAN:'000042',FilialID:18,FBestand:'2'},{EAN:'000042',FilialID:18,FBestand:'3'}],{sourceInstance:'tradefoto-trade',snapshotAt:'2026-09-14T10:00:00.000Z'});
 const page=await f.run('inventory');assert.equal(page.rows.length,2);assert.ok(page.rows.every(r=>r.stock===null&&r.stockValue===null&&r.noRecordedSale===null));
});
