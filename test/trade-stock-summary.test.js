'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,rights}=require('../test-support/trade-insights-sqlite');
async function prepare(f){
 await f.ingest('ARTIKEL_Warengruppen',[{Warengruppe:1,Bezeichnung:'Synthetic goods'}],{master:true});
 await f.ingest('ARTIKEL_Sortimente',[{Sortiment:10,Warengruppe:1,Bezeichnung:'Cameras'},{Sortiment:20,Warengruppe:1,Bezeichnung:'Accessories'}],{master:true});
 await f.ingest('ARTIKEL_STAMM',[
  {EAN:'a',Artikelbezeichnung:'Camera',Sortiment:10,DurchschnittEK:'123.45',Sachkonto:false,OhneBestand:false},
  {EAN:'b',Artikelbezeichnung:'Accessory',Sortiment:20,DurchschnittEK:'0.1',Sachkonto:false,OhneBestand:false},
  {EAN:'c',Artikelbezeichnung:'Service',Sortiment:10,DurchschnittEK:'20',OhneBestand:true},
  {EAN:'d',Artikelbezeichnung:'Missing price',Sortiment:10,DurchschnittEK:null},
  {EAN:'e',Artikelbezeichnung:'Zero price',Sortiment:20,DurchschnittEK:'0'},
 ],{master:true});
 await f.ingest('ARTIKEL_FILIALEN',[
  {EAN:'a',FilialID:18,FBestand:'2'},{EAN:'a',FilialID:19,FBestand:'4'},
  {EAN:'b',FilialID:18,FBestand:'0.3'},{EAN:'c',FilialID:18,FBestand:'10'},
  {EAN:'d',FilialID:18,FBestand:'1'},{EAN:'e',FilialID:18,FBestand:'2'},
 ],{sourceInstance:'tradefoto-trade'});
}
test('branch stock totals are exact, grouped and distinguish provisional value from confirmed goods',async t=>{
 const f=await fixture(t);await prepare(f);
 let r=await f.run('stock-summary',{locationId:'18'});
 assert.equal(r.complete,true);assert.equal(r.totals.positions,5);assert.equal(r.totals.quantity,'5.3');
 assert.equal(r.totals.positiveQuantity,'5.3');assert.equal(r.totals.positivePositions,4);assert.equal(r.totals.confirmedQuantity,'0');
 assert.equal(r.totals.provisionalNet,'246.93');assert.equal(r.totals.confirmedNet,'0');
 assert.equal(r.totals.excluded,1);assert.equal(r.totals.missingCost,1);assert.equal(r.totals.zeroCost,1);
 assert.equal(r.rows.find(g=>g.id==='20').provisionalNet,'0.03');
 await f.run('classification-save',{level:'wgr',key:'1',kind:'goods',expectedRevision:0});
 r=await f.run('stock-summary',{locationId:'18'});assert.equal(r.totals.confirmedNet,'246.93');
 assert.equal(r.totals.unclassified,0);
});
test('scopes and cost permissions apply to totals and groups, not only visible rows',async t=>{
 const f=await fixture(t);await prepare(f);
 f.state.session={...f.state.session,permissions:rights.filter(p=>!['sales:analytics:company:read','sales:analytics:margin:read'].includes(p)),scopes:[{locationId:'18'}]};
 const r=await f.run('stock-summary',{locationId:'18'});assert.equal(r.totals.positions,5);
 assert.doesNotMatch(JSON.stringify(r),/provisionalNet|confirmedNet|246\.93|123\.45/);
 await assert.rejects(f.run('stock-summary',{locationId:'19'}),e=>e.status===403);
 await assert.rejects(f.run('stock-summary',{}),e=>e.status===422);
});
test('duplicates, negative quantities and orphan articles cannot inflate the valuation',async t=>{
 const f=await fixture(t);await prepare(f);
 await f.ingest('ARTIKEL_FILIALEN',[{EAN:'a',FilialID:18,FBestand:'2'},{EAN:'a',FilialID:18,FBestand:'3'},
 {EAN:'b',FilialID:18,FBestand:'-2'},{EAN:'missing',FilialID:18,FBestand:'100'}],{sourceInstance:'tradefoto-trade',snapshotAt:'2026-09-15T10:00:00.000Z'});
 const r=await f.run('stock-summary',{locationId:'18'});
 assert.equal(r.totals.provisionalNet,'0');assert.equal(r.totals.ambiguous,2);assert.equal(r.totals.negative,1);assert.equal(r.totals.missingArticle,1);
 assert.equal(r.totals.positiveQuantity,'0');assert.equal(r.totals.positivePositions,0);
});
test('continuation never presents an incomplete page as a total and rejects changed data or authority',async t=>{
 const f=await fixture(t);
 const articles=Array.from({length:105},(_,i)=>({EAN:String(i),Artikelbezeichnung:'Synthetic '+i,Sortiment:1,DurchschnittEK:'0.1'}));
 await f.ingest('ARTIKEL_STAMM',articles,{master:true});
 await f.ingest('ARTIKEL_FILIALEN',articles.map(a=>({EAN:a.EAN,FilialID:18,FBestand:'1'})),{sourceInstance:'tradefoto-trade'});
 const first=await f.run('stock-summary',{locationId:'18'});assert.equal(first.complete,false);assert.ok(first.next);assert.equal(first.totals.positions,100);
 const last=await f.run('stock-summary',{locationId:'18',cursor:first.next});assert.equal(last.complete,true);assert.equal(last.totals.positions,105);assert.equal(last.totals.provisionalNet,'10.5');
 await assert.rejects(f.run('stock-summary',{locationId:'19',cursor:first.next}),e=>e.status===409);
 const permissions=f.state.session.permissions;
 f.state.session.permissions=permissions.filter(p=>p!=='sales:analytics:margin:read');
 await assert.rejects(f.run('stock-summary',{locationId:'18',cursor:first.next}),e=>e.status===409);
 f.state.session.permissions=permissions;
 await f.ingest('ARTIKEL_STAMM',[{...articles[0],DurchschnittEK:'1'}],{master:true,snapshotAt:'2026-09-15T10:00:00.000Z'});
 await assert.rejects(f.run('stock-summary',{locationId:'18',cursor:first.next}),e=>e.status===409);
});

test('branch index includes a source branch linked after the stock import',async t=>{
 const f=await fixture(t);await prepare(f);
 await f.ingest('FILIALEN',[{FilialID:20,FName:'Synthetic newly linked branch'}],{master:true});
 await f.ingest('ARTIKEL_FILIALEN',[{EAN:'a',FilialID:19,FBestand:'4'},{EAN:'a',FilialID:20,FBestand:'2'}],{sourceInstance:'tradefoto-trade',snapshotAt:'2026-09-15T10:00:00.000Z'});
 f.app.database.exec("INSERT INTO locations VALUES('20',1,'Synthetic 20')");
 const before=await f.run('stock-summary',{locationId:'20'});assert.equal(before.totals.positions,0);
 const record=(await f.masters.mappings({table:'FILIALEN',sourceInstance:'tradefoto-trade',key:'20'})).items[0];
 const input={recordId:record.id,expectedSourceRevision:record.revision,targetId:'20',historical:false,reason:'Synthetic late mapping'};
 await f.masters.bind(input,(await f.masters.previewBinding(input)).planHash);
 const current=await f.run('stock-summary',{locationId:'20'});assert.equal(current.totals.positions,1);assert.equal(current.totals.provisionalNet,'246.9');
});

test('unmapped source branches require company and unassigned authority; mapped branches retain their scope',async t=>{
 const f=await fixture(t);await prepare(f);
 await f.ingest('FILIALEN',[{FilialID:20,FName:'Synthetic unassigned'}],{master:true});
 await f.ingest('ARTIKEL_FILIALEN',[{EAN:'a',FilialID:20,FBestand:'2'},{EAN:'a',FilialID:18,FBestand:'4'}],{sourceInstance:'tradefoto-trade',snapshotAt:'2026-09-15T10:00:00.000Z'});
 const r=await f.run('stock-summary',{locationId:'trade-source:20'});assert.equal(r.totals.provisionalNet,'246.9');
 f.state.session.permissions=rights.filter(p=>p!=='sales:history:unassigned:read');
 await assert.rejects(f.run('stock-summary',{locationId:'trade-source:20'}),e=>e.status===403);
 f.state.session={...f.state.session,permissions:rights.filter(p=>p!=='sales:analytics:company:read'),scopes:[{locationId:'18'}]};
 assert.equal((await f.run('stock-summary',{locationId:'trade-source:18'})).totals.provisionalNet,'493.8');
 await assert.rejects(f.run('stock-summary',{locationId:'trade-source:20'}),e=>e.status===403);
 const metadata=await f.run('stock-metadata',{});assert.deepEqual(metadata.stockLocations.map(l=>l.id),['trade-source:18']);
});
