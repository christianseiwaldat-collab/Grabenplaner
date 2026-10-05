'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('../test-support/trade-insights-sqlite');
const { seedBranchOrders } = require('../test-support/sales-article-branch-orders-fixture');
const { loadSalesArticleDetailData } = require('../lib/sales-article-detail-source');
const { loadSalesArticleBranchOrders, LIMIT, ITEM_LIMIT } = require('../lib/sales-article-branch-orders');
const UI = require('../public/sales-article-layout');
async function setup(t) {
  const f = await fixture(t), seed = await seedBranchOrders({ access:f.app.provider, source:f });
  const load = (session = f.state.session) => loadSalesArticleDetailData({ access:f.app.provider, vault:f.vault,
    article:seed.article, projection:{read:true}, session });
  return { ...f, ...seed, load };
}
test('Branch quantities use source stock and BE allocations use demand branches, exact remainders and grouped parents', async t => {
  const f = await setup(t), value = await f.load();
  const [a,b] = value.branchStock.rows;
  assert.deepEqual([a.id,a.quantity,a.ordered,a.orders.matched], ['18','3','4',true]);
  assert.deepEqual(a.orders.items.map(item => [item.number,item.remaining]), [['101','4']]);
  assert.deepEqual([b.id,b.ordered,b.orders.matched], ['19','6',true]);
  assert.deepEqual(b.orders.items.map(item => [item.number,item.remaining]), [['101','4'],['106','2']]);
  assert.equal(b.orders.state,'recorded');
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE/);
  assert.doesNotMatch(JSON.stringify(value.branchStock),/Suchname|Artikeltext|Text1/);
  const html = UI.overview({...f.article,...value,prices:{sales:null},provenance:{updatedAt:'2026-09-17'}},
    {money:v=>v,timestamp:v=>v,date:v=>v});
  assert.match(html,/<th scope="col" data-stock-cell="quantity"[^>]*><button type="button" data-stock-sort="quantity">Bestand/);
  assert.match(html,/<th scope="col" data-stock-cell="ordered"[^>]*><button type="button" data-stock-sort="ordered">Bestellt/);
  assert.match(html,/<details class="sales-article-branch-orders"><summary title=/);
  assert.match(html,/BE 101 · Rest 4/); assert.match(html,/Zuletzt belegte BE-Zuordnung/);
  assert.match(html,/kein gesicherter aktueller Offenstand/);
});
test('Purchase permission and authenticated branch scope restrict new quantities and BEs without restricting article stock', async t => {
  const f = await setup(t);
  for (const session of [undefined, {...f.state.session,permissions:f.state.session.permissions.filter(p=>p!=='sales:purchasing:read')},
    {...f.state.session,sessionKind:'organization',isEmployee:false}]) {
    const value = await f.load(session === undefined ? {} : session);
    assert.deepEqual(value.branchStock.rows.map(row=>[row.quantity,row.ordered,row.orders.state]), [['3',null,'restricted'],['0',null,'restricted']]);
    assert.equal(value.branchStock.rows.flatMap(row=>row.orders.items).length,0);
  }
  const scoped = {...f.state.session,permissions:f.state.session.permissions.filter(p=>p!=='sales:analytics:company:read'),scopes:[{locationId:'18'}]};
  const value = await f.load(scoped);
  assert.equal(value.branchStock.rows[0].ordered,'4');
  assert.equal(value.branchStock.rows[1].ordered,null);
  assert.deepEqual(value.branchStock.rows[1].orders.items,[]);
});
test('Minimal purchase reader never requests customer segments and still authenticates its own internal segment', async t => {
  const f = await setup(t);
  f.app.database.prepare("UPDATE import_history_segments SET payload='unreadable-private-segment' WHERE data_class='customer_restricted'").run();
  assert.equal((await f.load()).branchStock.rows[1].orders.matched,true);
  f.app.database.prepare("UPDATE import_history_segments SET payload='tampered' WHERE data_class='internal_business' AND record_id IN (SELECT id FROM import_history_records WHERE source_table='BestellVerteilung')").run();
  await assert.rejects(f.load());
});
test('Unchanged and removed export rows stay explicitly historical; imported ordered quantities are never overwritten', async t => {
  const f = await setup(t);
  await f.ingest('BestellVerteilung', [f.distributions[0]], {snapshotAt:'2026-09-20T09:00:00.000Z'});
  await f.ingest('ARTIKEL_FILIALEN', [{EAN:'005479',FilialID:'19',FBestand:0,Bestellt:2}],
    {sourceInstance:'tradefoto-trade',snapshotAt:'2026-09-20T09:00:00.000Z'});
  const row = (await f.load()).branchStock.rows[0];
  assert.equal(row.ordered,'2'); assert.equal(row.orders.state,'review'); assert.equal(row.orders.matched,false);
  assert.equal(row.orders.items.find(item=>item.number==='101').remaining,'4');
  assert.equal(row.orders.items[0].sourceAt,'2026-09-14T09:00:00.000Z');
});
test('Corrections, unknown completion, inconsistent parent references and closed orders never become asserted open remainders', async t => {
  const f = await setup(t);
  await f.ingest('BESTELLUNGEN', [{...f.heads[0],erledigt:null}, {...f.heads[1],erledigt:true}],{snapshotAt:'2026-09-21T09:00:00.000Z'});
  let row = (await f.load()).branchStock.rows[1];
  assert.equal(row.orders.state,'review');
  assert.deepEqual(row.orders.items.map(item=>[item.number,item.remaining]),[['101',null]]);
  await f.ingest('BESTELLUNGEN', f.heads,{snapshotAt:'2026-09-22T09:00:00.000Z'});
  await f.ingest('BestellVerteilung', f.distributions.map((item,index)=>index===1?{...item,Menge:'-5'}:item),{snapshotAt:'2026-09-22T09:00:00.000Z'});
  row = (await f.load()).branchStock.rows[1];
  assert.equal(row.orders.items.find(item=>item.number==='101').remaining,null);
  assert.equal(row.orders.state,'review');
  await f.ingest('BestellVerteilung', f.distributions.map((item,index)=>index===1?{...item,BestellNr:'106'}:item),{snapshotAt:'2026-09-23T09:00:00.000Z'});
  row = (await f.load()).branchStock.rows[1];
  assert.equal(row.orders.state,'review');
  assert.equal(row.orders.items.find(item=>item.number==='106').remaining,'2','A mismatched distribution cannot inflate the header fallback');
});
test('Candidate and tooltip bounds remain explicit and never substitute delivery branches after a truncated allocation lookup', async t => {
  const f = await setup(t);
  const details = Array.from({length:LIMIT+2},(_,index)=>({BestellId:String(20000+index),BestellNr:101,EAN:'005479',BMenge:'1',gMenge:'0',Verteiler:false}));
  await f.ingest('BESTELLDETAILS', details, {snapshotAt:'2026-09-23T09:00:00.000Z'});
  const {DatabaseSync} = require('node:sqlite'), original = DatabaseSync.prototype.prepare;
  let reads=0;
  DatabaseSync.prototype.prepare=function(sql) {
    const statement=original.call(this,sql);
    return new Proxy(statement,{get(target,key) { const value=target[key]; return typeof value!=='function' ? value : (...args)=>{
      if(key==='all' && /^\s*(SELECT|WITH)\b/i.test(sql)) reads++;
      return value.apply(target,args);
    }; }});
  };
  let rows;
  try { rows = (await f.load()).branchStock.rows; } finally { DatabaseSync.prototype.prepare=original; }
  assert.ok(reads<=55,`400 candidates must use batches, not per-position reads; observed ${reads}`);
  for (const row of rows) { assert.equal(row.orders.truncated,true); assert.equal(row.orders.state,'review'); assert.equal(row.orders.matched,null); assert.ok(row.orders.items.length<=ITEM_LIMIT); }
});
test('A missing or unqualified parent fails closed and never becomes a delivery-branch fallback', async t => {
  const f = await setup(t);
  // This is a synthetic corrupt import index; it must not silently look complete.
  f.app.database.prepare("UPDATE import_history_records SET identity_hash=? WHERE source_table='BESTELLUNGEN' AND identity_hash=?")
    .run('f'.repeat(64),require('../lib/tradefoto-history-profiles').historyIdentity(f.protection,{scopeId:'grabenplaner-main',sourceInstance:'tradefoto-bestell'},'trade','BESTELLUNGEN',['106']));
  const rows = (await f.load()).branchStock.rows;
  assert.ok(rows.every(row=>row.orders.state==='review'));
  assert.ok(rows.every(row=>row.orders.items.every(item=>item.number!=='106')));
});
test('Fresh article access rejects revoked purchasing authority or a changed branch scope', async () => {
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const start=source.indexOf('async function assertFreshSalesArticleRead('), end=source.indexOf("\napp.get('/api/sales/articles/preferences'",start);
  const permissions = require('../test-support/trade-insights-sqlite').rights;
  const original = {employeeNumber:'synthetic',accountId:'account',permissions,scopes:[]};
  const projection = {read:true};
  let fresh=original;
  const context={isLocalSystemSession:()=>false,loadPortalSessionFromRequest:async()=>fresh,salesArticleCatalogProjectionForSession:()=>projection,
    require:require('node:module').createRequire(path.join(__dirname,'../server.js')),
    httpError:(status,message,code)=>Object.assign(new Error(message),{status,code})};
  vm.runInNewContext(source.slice(start,end)+'\nglobalThis.check=assertFreshSalesArticleRead;',context);
  await context.check({},original,projection);
  fresh={...original,permissions:permissions.filter(p=>p!=='sales:purchasing:read')};
  await assert.rejects(context.check({},original,projection),{status:403});
  const scoped={...original,permissions:permissions.filter(p=>p!=='sales:analytics:company:read'),scopes:[{locationId:'18'}]};
  fresh={...scoped,scopes:[{locationId:'19'}]};
  await assert.rejects(context.check({},scoped,projection),{status:403});
});
test('Unauthorized branch order read returns before any source lookup', async () => {
  let calls=0;
  const result = await loadSalesArticleBranchOrders({tx:{queryAll(){calls++;throw Error('must not query');}},rows:[{id:'18',quantity:'3',ordered:'4'}],session:{}});
  assert.equal(calls,0); assert.equal(result[0].quantity,'3'); assert.equal(result[0].ordered,null);
});
test('Browser detail cache invalidates purchasing data for role, identity kind, inventory rights and scope changes', () => {
  const vm=require('node:vm'), fs=require('node:fs'), path=require('node:path');
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const start=source.indexOf('function currentSalesArticleCatalogDetailAccessKey()'), end=source.indexOf('\nfunction syncSalesArticleCatalogActorState()',start);
  const base={role:'developer',isEmployee:true,sessionKind:'employee',accountId:'one',permissions:['sales:purchasing:read'],scopes:[{locationId:'18'}],
    salesHistory:{read:true},salesAnalytics:{inventory:true},mustChangePassword:false};
  const state={portalSession:{user:base}};
  const context={state,currentSalesArticleCatalogActorKey:()=> 'person',canReadSalesArticles:()=>true,canReadSalesArticlePrices:()=>true,
    canReadSalesArticleCosts:()=>true,canWriteSalesArticles:()=>true,canImportSalesArticles:()=>true};
  vm.runInNewContext(source.slice(start,end)+'\nglobalThis.key=currentSalesArticleCatalogDetailAccessKey;',context);
  const before=context.key();
  for(const change of [{role:'employee'},{isEmployee:false},{sessionKind:'organization'},{accountId:'two'},
    {permissions:[]},{scopes:[{locationId:'19'}]},{salesAnalytics:{inventory:false}},{mustChangePassword:true}]) {
    state.portalSession.user={...base,...change}; assert.notEqual(context.key(),before,JSON.stringify(change));
  }
});
