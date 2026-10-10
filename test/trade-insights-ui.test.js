'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount, tabs, legacyUrl } = require('../public/trade-insights');

// Small DOM boundary for lifecycle races; the full GP shell is also checked in Chrome.
class Element {
  constructor() { this.listeners = new Map(); this.children = []; this.attributes = {}; this.value = ''; this.hidden = false; this.disabled = false; this.textContent = ''; this.innerHTML = ''; this.classList = { toggle() {} }; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event = {}) { for (const fn of this.listeners.get(type) || []) fn(event); }
  setAttribute(key, value) { this.attributes[key] = value; }
  replaceChildren(...children) { this.children = children; this.innerHTML = ''; }
  add(child) { this.children.push(child); }
  insertAdjacentHTML(where, html) { this.innerHTML=html+this.innerHTML; }
  close() { this.open = false; this.emit('close'); }
  showModal() { this.open = true; }
  focus() { this.focused = true; }
}
function fixture() {
  const nodes = new Map(), all = [];
  function node(key) { if (!nodes.has(key)) { const e = new Element(); nodes.set(key, e); all.push(e); } return nodes.get(key); }
  const buttons = tabs.map(kind => { const b = node(kind); b.dataset = { kind }; b.id = 'tradeInsightsTab-' + kind; b.disabled = true; return b; });
  const root = node('root'); root.ownerDocument = { createElement: () => new Element() };
  root.querySelector = selector => node(selector.match(/^\[data-ti="(.+)"\]$/)?.[1] || selector);
  root.querySelectorAll = selector => selector === '[data-kind]' ? buttons : [node(selector)];
  for (const [key, fields] of Object.entries({ filters: ['suggestionType','stocktakeId','stocktakeVersion','stocktakeSource','difference','articleNumber', 'movementType', 'review', 'days', 'dateFrom', 'dateTo', 'customer', 'serial', 'supplier', 'query', 'locationId', 'group', 'wgr', 'resultTitle'], snapshot: ['title'], 'class-form': ['level', 'articleKey', 'groupKey'], 'class-save': ['kind'], 'repair-status-form': ['state'] })) {
    const form = node(key); form.elements = Object.fromEntries(fields.map(field => [field, node(key + '-' + field)]));
    form.querySelector = () => node(key + '-button'); form.parentElement = node(key + '-panel');
  }
  node('class-form').elements.level.value = 'wgr';
  const requests = [], changes = [], routeOptions = [];
  const workspace = mount(root, { onTabChange: (tab, options) => { changes.push(tab); routeOptions.push(options); }, api: (url, options) => url.endsWith('/jobs')&&!options.method?Promise.resolve([]):new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) });
  return { root, node, all, buttons, requests, changes, routeOptions, workspace };
}
const context = { projection: { inventory: true, purchasing: true, customers: true, repairs: true, classify: true }, locations: [{ id: '93', label: 'Testfiliale' }], today: '2026-09-16' };
const tick = () => new Promise(setImmediate);

test('Mount is lazy; leaving during access loading rejects stale data and permits re-entry', async () => {
  const f = fixture(); assert.equal(f.requests.length, 0);
  const old = f.workspace.activate('purchasing'); assert.equal(f.requests.length, 1);
  f.workspace.suspend(); assert.equal(f.requests[0].options.signal.aborted, true);
  const current = f.workspace.activate('repairs'); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(context); await current;
  f.requests[0].resolve({ ...context, locations: [{ id: '98', label: 'Stale account' }] }); await old;
  assert.equal(f.workspace.getTab(), 'repairs'); assert.deepEqual(f.changes, ['repairs']);
  assert.deepEqual(f.node('filters').elements.locationId.children.map(n => n.value), ['', '93']);
  f.workspace.destroy();
});

test('Forbidden deep links fall back to an allowed tab with matching ARIA state', async () => {
  const f = fixture(), pending = f.workspace.activate('purchasing');
  f.requests[0].resolve({ ...context, projection: { customers: true } }); await pending;
  assert.equal(f.workspace.getTab(), 'customer-history');
  assert.deepEqual(f.changes, ['customer-history']);
  assert.equal(f.routeOptions[0].replace, true, 'An inaccessible tab must not remain as an extra Back entry');
  assert.equal(f.node('purchasing').disabled, true);
  assert.equal(f.node('customer-history').attributes['aria-selected'], 'true');
  assert.equal(f.node('customer-history').tabIndex, 0);
  assert.equal(f.node('filters').elements.customer.required, true);
  f.workspace.destroy();
});

test('Late stock metadata cannot replace a newer tab or update a destroyed account', async () => {
  const f = fixture(), first = f.workspace.activate('inventory');
  f.requests[0].resolve(context); await tick();
  assert.match(f.requests[1].url, /stock-metadata$/);
  await f.workspace.activate('repairs');
  assert.equal(f.requests[1].options.signal.aborted, true);
  f.requests[1].reject(new Error('Old metadata failure')); await first;
  assert.equal(f.node('status').textContent, 'Suchangaben wählen und Suche starten.');
  const next = f.workspace.activate('inventory'); await tick();
  const request = f.requests.at(-1); f.workspace.destroy();
  assert.equal(request.options.signal.aborted, true);
  request.resolve({ groups: [], wgr: [], cashPeriod: {} }); await next;
  assert.equal(f.root.innerHTML, '');
  assert.ok(f.all.every(n => [...n.listeners.values()].every(listeners => listeners.size === 0)));
  await f.workspace.activate('purchasing'); assert.equal(f.requests.length, 3);
});

test('Context loading follows the newest requested tab and refuses missing permissions', async () => {
  const f = fixture(), first = f.workspace.activate('purchasing'), latest = f.workspace.activate('device-history');
  f.requests[0].resolve(context); await Promise.all([first, latest]);
  assert.equal(f.workspace.getTab(), 'device-history');
  assert.equal(f.node('filters').elements.serial.required, true);
  f.workspace.destroy();
  const denied = fixture(), pending = denied.workspace.activate();
  denied.requests[0].resolve({ projection: {}, locations: [] }); await pending;
  assert.equal(denied.node('filters-button').disabled, true);
  assert.ok(denied.buttons.every(b => b.disabled));
  assert.deepEqual(denied.changes, []); denied.workspace.destroy();
});

test('Legacy URLs retain only known tabs and never redirect outside GP', () => {
  assert.equal(legacyUrl('?tab=prices'), '/?view=tradeInsights&section=purchasing');assert.ok(!tabs.includes('prices'));
  for (const tab of tabs) assert.equal(legacyUrl('?tab=' + tab), '/?view=tradeInsights&section=' + tab);
  assert.equal(legacyUrl('?tab=https://elsewhere.example/&view=outside'), '/?view=tradeInsights&section=purchasing');
});

test('Logistics uses authorized imported receiving choices while other views retain their branch list',async()=>{
 const f=fixture();f.workspace.setArea('logistics');
 const pending=f.workspace.activate('purchasing');
 f.requests[0].resolve({...context,purchasingLocations:[{id:'trade-source:0',label:'0 · Zentrallager'},{id:'3',label:'3 · Großhandel'},{id:'99',label:'99 · United Camera Wien'}]});
 await pending;
 const form=f.node('filters');
 assert.deepEqual(form.elements.locationId.children.map(n=>n.value),['','trade-source:0','3','99']);
 assert.equal(form.elements.locationId.children[0].textContent,'Alle freigegebenen Lieferstellen');
 assert.equal(f.node('purchasing-location-hint').hidden,false);
 f.workspace.setArea('stock');const returning=f.workspace.activate('repairs');f.requests.at(-1).resolve(context);await returning;
 assert.deepEqual(form.elements.locationId.children.map(n=>n.value),['','93']);
 assert.equal(f.node('purchasing-location-hint').hidden,true);
 f.workspace.destroy();
});


test('stock summary offers all IDs and submits a durable server job that survives leaving the view',async t=>{
 const SavedFormData=globalThis.FormData;
 globalThis.FormData=class {constructor(form){this.entries=Object.entries(form.elements).map(([k,v])=>[k,v.value]);}[Symbol.iterator](){return this.entries[Symbol.iterator]();}};
 t.after(()=>{globalThis.FormData=SavedFormData;});
 const f=fixture(),pending=f.workspace.activate('stock-summary');f.requests[0].resolve(context);await tick();
 f.requests[1].resolve({groups:[{id:'10',label:'Zehn'},{id:'2',label:'Zwei'}],wgr:[],stockLocations:[{id:'trade-source:19',label:'Filiale 19'},{id:'trade-source:2',label:'Filiale 2'}]});await pending;
 const form=f.node('filters');assert.equal(form.elements.locationId.required,false);assert.equal(f.node('[data-period]').hidden,true);
 assert.deepEqual(form.elements.group.children.map(n=>n.value),['','2','10']);
 assert.deepEqual(form.elements.locationId.children.map(n=>n.value),['','trade-source:2','trade-source:19']);
 form.elements.resultTitle.value='September';form.emit('submit',{preventDefault(){}});await tick();
 const first=f.requests.at(-1),body=JSON.parse(first.options.body);assert.match(first.url,/jobs$/);assert.equal(body.kind,'stock-summary');assert.equal(body.title,'September');
 assert.equal(body.query.locationId,'');assert.equal(body.query.dateFrom,undefined);assert.equal(body.query.days,undefined);
 first.resolve({id:'saved-job',status:'queued'});await tick();assert.match(f.node('status').textContent,/Server gestartet/);
 f.workspace.suspend();assert.ok(!f.requests.some(r=>r.url.endsWith('/cancel')));
 const returning=f.workspace.activate('stock-summary');f.requests.at(-1).resolve(context);await tick();
 f.requests.at(-1).resolve({groups:[{id:'10',label:'Zehn'},{id:'2',label:'Zwei'}],wgr:[],stockLocations:[{id:'trade-source:19',label:'Filiale 19'},{id:'trade-source:2',label:'Filiale 2'}]});await returning;
 assert.equal(f.workspace.getTab(),'stock-summary');f.workspace.destroy();
});

test('opening a saved result while metadata loads preserves the dropdowns and later selection',async()=>{
 const f=fixture(),pending=f.workspace.activate('stock-summary');f.requests[0].resolve(context);await tick();
 const metadata=f.requests[1];
 f.node('jobs').emit('click',{target:{closest:selector=>selector==='[data-job-open]'?{dataset:{jobOpen:'saved'}}:null}});await tick();
 const open=f.requests.at(-1);assert.match(open.url,/jobs\/saved$/);
 open.resolve({id:'saved',kind:'stock-summary',title:'Gespeichert',created:'2026-09-24T10:00:00Z',completedAt:'2026-09-24T10:01:00Z',processed:0,query:{},result:{rows:[],sourceDate:'2026-09-20T10:00:00Z'}});await tick();
 metadata.resolve({groups:[{id:'2',label:'Objektive'}],wgr:[],stockLocations:[]});await pending;
 assert.deepEqual(f.node('filters').elements.group.children.map(n=>n.value),['','2']);assert.equal(f.node('snapshot').hidden,false);assert.equal(f.node('snapshot').elements.title.value,'Gespeichert');f.workspace.destroy();
});
test('saved stock data quality retains its own source date and honors current cost visibility',async()=>{
 for(const costs of [true,false]){
  const f=fixture(),pending=f.workspace.activate('stock-summary');f.requests[0].resolve({...context,projection:{...context.projection,costs}});await tick();
  f.requests[1].resolve({groups:[],wgr:[],stockLocations:[]});await pending;
  f.node('jobs').emit('click',{target:{closest:selector=>selector==='[data-job-open]'?{dataset:{jobOpen:'saved'}}:null}});await tick();
  f.requests.at(-1).resolve({id:'saved',kind:'stock-summary',title:'BEISPIEL Bestand',created:'2026-10-09T10:00:00Z',completedAt:'2026-10-09T10:01:00Z',processed:5,query:{},result:{rows:[],complete:true,sourceDate:'2026-09-01T10:00:00Z',totals:{positions:5,positivePositions:2,positiveQuantity:'2',provisionalNet:'10',confirmedNet:'10',missingArticle:1,missingQuantity:0,missingCost:2,zeroCost:1}}});await tick();
  const html=f.node('results').innerHTML;assert.match(html,/class="gp-data-quality"/);assert.match(html,/datetime="2026-09-01T10:00:00Z"/);assert.doesNotMatch(html,/Hochgeladen am/);assert.match(html,/Ohne Artikelstamm/);
  if(costs){assert.match(html,/Ohne gültigen Einkaufspreis/);assert.match(html,/Einkaufspreis gleich 0/);}else assert.doesNotMatch(html,/Einkaufspreis/);
  f.workspace.destroy();assert.equal(f.node('results').innerHTML,'');
 }
});
test('late saved stock quality cannot reappear after the account workspace is destroyed',async()=>{
 const f=fixture(),pending=f.workspace.activate('stock-summary');f.requests[0].resolve({...context,projection:{...context.projection,costs:true}});await tick();f.requests[1].resolve({groups:[],wgr:[],stockLocations:[]});await pending;
 f.node('jobs').emit('click',{target:{closest:selector=>selector==='[data-job-open]'?{dataset:{jobOpen:'saved'}}:null}});await tick();const old=f.requests.at(-1);f.workspace.destroy();
 old.resolve({id:'saved',kind:'stock-summary',processed:9,query:{},result:{rows:[],sourceDate:'2026-09-01T10:00:00Z',totals:{positions:9,missingCost:4,zeroCost:3}}});await tick();
 assert.equal(f.node('results').innerHTML,'');assert.equal(f.node('snapshot').hidden,true);
});
test('movement filters exclude undated rows explicitly and article links submit exact keys without stale dates',async t=>{
 const SavedFormData=globalThis.FormData;globalThis.FormData=class{constructor(form){this.entries=Object.entries(form.elements).map(([k,v])=>[k,v.value]);}[Symbol.iterator](){return this.entries[Symbol.iterator]();}};t.after(()=>{globalThis.FormData=SavedFormData;});
 const f=fixture(),pending=f.workspace.activate('movements');f.requests[0].resolve(context);await pending;
 const form=f.node('filters');assert.equal(form.elements.dateFrom.value,'2026-08-18');
 form.elements.review.value='missing_date';form.elements.review.emit('change');assert.equal(form.elements.dateFrom.value,'');assert.equal(form.elements.dateTo.value,'');
 const opening=f.workspace.openMovements({articleNumber:'000042'});await tick();const request=f.requests.at(-1),body=JSON.parse(request.options.body);
 assert.equal(body.kind,'movements');assert.equal(body.query.articleNumber,'000042');assert.equal(body.query.query,'');assert.equal(body.query.dateFrom,'');assert.equal(body.query.review,'');assert.equal(body.query.days,undefined);
 request.resolve({id:'movement-job',status:'queued'});await opening;f.workspace.destroy();
});
test('saved movement results collapse filters and retain their own criteria when filters are reopened',async()=>{
 const f=fixture(),pending=f.workspace.activate('movements');f.requests[0].resolve(context);await pending;
 f.node('jobs').emit('click',{target:{closest:selector=>selector==='[data-job-open]'?{dataset:{jobOpen:'saved'}}:null}});await tick();
 f.requests.at(-1).resolve({id:'saved',kind:'movements',title:'Archiv',created:'2026-09-24T10:00:00Z',completedAt:'2026-09-24T10:01:00Z',processed:0,query:{articleNumber:'000042',review:'negative'},result:{rows:[],sourceDate:'2026-09-20T10:00:00Z'}});await tick();
 assert.equal(f.node('filters').hidden,true);assert.equal(f.node('archive').open,false);assert.match(f.node('snapshot-info').textContent,/000042.*Negative Mengen/);
 f.node('movement-filter-toggle').emit('click');assert.equal(f.node('filters').hidden,false);assert.equal(f.node('filters').elements.articleNumber.value,'000042');f.workspace.destroy();
});
test('saved stocktake details and suggestions use valid PDF sorts; opening an overview clears detail criteria',async()=>{
 const f=fixture(),pending=f.workspace.activate('stocktakes');f.requests[0].resolve(context);await pending;
 async function open(kind,query,result){f.node('jobs').emit('click',{target:{closest:selector=>selector==='[data-job-open]'?{dataset:{jobOpen:'saved'}}:null}});await tick();f.requests.at(-1).resolve({id:'saved',kind,title:'Gespeichert',created:'2026-09-25T10:00:00Z',completedAt:'2026-09-25T10:01:00Z',processed:0,query,result:{rows:[],...result}});await tick();const sort=new URL(f.node('pdf').href,'http://localhost').searchParams.get('sort');assert.ok(require('../public/trade-insight-results').columns(kind,context.projection,result).some(c=>c.key===sort));assert.equal(f.node('snapshot').hidden,false);}
 await open('stocktakes',{stocktakeId:'head',stocktakeVersion:'1',stocktakeSource:'hash',difference:'negative'},{stocktake:{number:'101',positions:20,unchanged:18,sourceLocation:'18',date:'2026-09-10'}});
 assert.equal(f.node('filters').elements.stocktakeId.value,'head');f.node('filters').elements.dateFrom.value='2026-09-07';f.node('filters').elements.query.value='alter Filter';await open('stocktakes',{},{});assert.equal(f.node('filters').elements.dateFrom.value,'');assert.equal(f.node('filters').elements.query.value,'');assert.equal(f.node('filters').elements.stocktakeId.value,'');assert.equal(f.node('filters').elements.difference.value,'');
 await open('suggestions',{}, {dateFrom:'2026-08-01',dateTo:'2026-09-10'});assert.equal(f.node('filters').elements.dateFrom.value,'2026-08-01');f.workspace.destroy();
});

test('suggestions retain an explicit exact article filter and hide it for stocktakes',async t=>{
 const previous=globalThis.FormData;globalThis.FormData=class{constructor(form){this.entries=Object.entries(form.elements).map(([k,v])=>[k,v.value]);}[Symbol.iterator](){return this.entries[Symbol.iterator]();}};t.after(()=>{globalThis.FormData=previous;});
 const f=fixture(),pending=f.workspace.activate('suggestions');f.requests[0].resolve(context);await pending;assert.equal(f.node('[data-article-exact]').hidden,false);const form=f.node('filters');form.elements.articleNumber.value='000042';form.emit('submit',{preventDefault(){}});await tick();const request=f.requests.at(-1),body=JSON.parse(request.options.body);assert.equal(body.query.articleNumber,'000042');assert.equal(body.query.movementType,undefined);request.resolve({id:'exact-hint',status:'queued'});await tick();await f.workspace.activate('stocktakes');assert.equal(f.node('[data-article-exact]').hidden,true);f.workspace.destroy();
});

test('specialized Trade results build their table only once and keep sortable headers',async()=>{
 for(const kind of ['movements','stocktakes','suggestions']){
  const f=fixture(),pending=f.workspace.activate(kind);f.requests[0].resolve(context);await pending;
  const result=f.node('results');let writes=0,markup='';
  Object.defineProperty(result,'innerHTML',{get(){return markup;},set(value){writes++;markup=value;},configurable:true});
  f.node('jobs').emit('click',{target:{closest:selector=>selector==='[data-job-open]'?{dataset:{jobOpen:'saved'}}:null}});await tick();
  f.requests.at(-1).resolve({id:'saved',kind,title:'Gespeichert',created:'2026-09-28T10:00:00Z',completedAt:'2026-09-28T10:01:00Z',processed:0,query:{},result:{rows:[]}});await tick();
  assert.equal(writes,1,kind+' must not build a throwaway generic table');
  assert.match(markup,/aria-sort="ascending"|aria-sort="descending"/);
  assert.match(markup,/data-sort=/);
  f.workspace.destroy();
 }
});

test('saved stock results reclaim filter space while Logistics keeps its search form visible',async()=>{
 for(const area of ['stock','logistics']){
  const f=fixture(),kind=area==='stock'?'repairs':'purchasing';
  f.workspace.setArea(area);
  const opening=f.workspace.activate(kind);f.requests[0].resolve(context);await opening;
  f.node('jobs').emit('click',{target:{closest:selector=>selector==='[data-job-open]'?{dataset:{jobOpen:'saved'}}:null}});await tick();
  f.requests.at(-1).resolve({id:'saved',kind,title:'Gespeichert',created:'2026-10-08T10:00:00Z',completedAt:'2026-10-08T10:00:01Z',processed:1,query:{query:'093510',locationId:'93'},result:{rows:[],sourceDate:'2026-10-08'}});await tick();
  assert.equal(f.node('filters').hidden,area==='stock');
  if(area==='stock'){
   assert.equal(f.node('movement-filter-toggle').attributes['aria-expanded'],'false');
   f.node('movement-filter-toggle').emit('click');
   assert.equal(f.node('filters').hidden,false);
   assert.equal(f.node('movement-filter-toggle').attributes['aria-expanded'],'true');
   assert.equal(f.node('filters').elements.query.value,'093510');
   assert.equal(f.node('filters').elements.locationId.value,'93');
  }
  f.workspace.destroy();
 }
});
