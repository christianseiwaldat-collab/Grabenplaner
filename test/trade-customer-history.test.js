'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,rights}=require('../test-support/trade-insights-sqlite');
async function repairs(f){return f.ingest('Reparatur',Array.from({length:35},(_,i)=>({ReparaturNr:i+1,FilialId:i<30?'18':'19',KUND_NR:i===0?0:42,AName:'Synthetic camera '+i,ANr:i<2?'ABC/123':'SERIAL'+i,Anlegedatum:'2026-07-01T12:00:00.000',erledigt:i<2,Fehler:'Synthetic problem',AArbeit:'Synthetic work'})));}
test('Repairs survive source omission and keep separate, authorized GP collection state with revision conflict checks',async t=>{
 const f=await fixture(t);await repairs(f);let page=await f.run('repairs');assert.equal(page.rows.length,25);assert.ok(page.next);
 const second=await f.run('repairs',{cursor:page.next});assert.equal(second.rows.length,10);assert.equal(second.next,null);
 const rows=[...page.rows,...second.rows],r=rows.find(r=>r.documentNumber==='2');assert.equal(r.sourceStatus,'ready');assert.equal(r.gpStatus,'unassigned');assert.equal(r.paidInferred,false);
 let detail=await f.run('repair-save',{id:r.id,state:'collected',expectedRevision:0});assert.equal(detail.gpStatus,'collected');assert.equal(detail.revision,1);
 await assert.rejects(f.run('repair-save',{id:r.id,state:'ready',expectedRevision:0}),e=>e.status===409);
 await assert.rejects(f.run('repairs',{cursor:page.next}),e=>e.code==='IMPORT_BESTELL_CURSOR');
 await f.ingest('Reparatur',[{ReparaturNr:100,FilialId:'18',KUND_NR:42,AName:'New source case',erledigt:false}],{snapshotAt:'2026-09-14T10:00:00.000Z'});
 detail=await f.run('repair-detail',{id:r.id});assert.equal(detail.gpStatus,'collected');assert.equal(detail.sourceStatus,'ready');assert.equal(detail.description,'Synthetic problem');
 f.state.session={...f.state.session,permissions:rights.filter(p=>p!=='sales:analytics:company:read'),scopes:[{locationId:'18'}]};
 const foreign=rows.find(r=>r.sourceLocation==='19');await assert.rejects(f.run('repair-detail',{id:foreign.id}),e=>e.status===403);await assert.rejects(f.run('repair-save',{id:foreign.id,state:'collected',expectedRevision:0}),e=>e.status===403);
 f.state.session={...f.state.session,permissions:f.state.session.permissions.filter(p=>p!=='sales:repairs:write')};await assert.rejects(f.run('repair-save',{id:r.id,state:'ready',expectedRevision:1}),e=>e.status===403);
 const visible=await f.run('repair-detail',{id:r.id});assert.equal(visible.gpStatus,'collected');
});
test('Customer and device history follow exact identifiers, hide anonymous identities and separate invoices from revenue',async t=>{
 const f=await fixture(t);await repairs(f);
 await f.ingest('Rechnung_Z',[{Rechnungsnr:'7',KUND_NR:42,Filialid:18,Anlegedatum:'2026-06-01T10:00:00.000',Rechnungsbetrag:'120',FilRe:false}]);
 await f.ingest('ANGEBOTE',[{AngebotNr:8,Kund_Nr:42,Filialid:18,AngebotDatum:'2026-06-01T10:00:00.000'}]);
 let page=await f.run('customer-history',{customer:'00042'}),rows=[...page.rows];for(let n=0;page.next&&n<10;n++){page=await f.run('customer-history',{customer:'00042',cursor:page.next});rows.push(...page.rows);}
 assert.ok(rows.some(r=>r.kind==='invoice'));assert.ok(rows.some(r=>r.kind==='offer'));assert.ok(!rows.some(r=>r.customerNumber==='0'));assert.ok(rows.filter(r=>r.kind!=='repair').every(r=>r.revenueContribution===null));
 await assert.rejects(f.run('customer-history',{customer:'0'}),e=>e.code==='IMPORT_BESTELL_CUSTOMER_UNASSIGNED');
 page=await f.run('device-history',{serial:'ABC/123'});assert.ok(page.rows.every(r=>r.serialNumber==='ABC/123'&&r.identityConfirmed===false));
 const none=await f.run('device-history',{serial:'abc/123'});assert.equal(none.rows.length,0);
 f.state.session={...f.state.session,permissions:rights.filter(p=>p!=='crm:purchases:read')};await assert.rejects(f.run('customer-history',{customer:'42'}),e=>e.status===403);
});

test('Customer history includes Kassenbelege without turning source invoices into additional turnover',async t=>{
 const f=await fixture(t);await require('../test-support/trade-insights-cash').insightCashFixture(f,{customer:'00042'});
 let page=await f.run('customer-history',{customer:'42'});assert.equal(page.rows.length,4);assert.ok(page.rows.every(r=>r.kind==='cash'&&r.revenueContribution===null));assert.ok(page.rows.some(r=>r.amount==='240.00'));assert.ok(page.rows.some(r=>r.amount==='-120.00'));
 const another=await f.run('customer-history',{customer:'142'});assert.equal(another.rows.length,0);
});
