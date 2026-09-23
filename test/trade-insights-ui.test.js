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
  focus() { this.focused = true; }
}
function fixture() {
  const nodes = new Map(), all = [];
  function node(key) { if (!nodes.has(key)) { const e = new Element(); nodes.set(key, e); all.push(e); } return nodes.get(key); }
  const buttons = tabs.map(kind => { const b = node(kind); b.dataset = { kind }; b.id = 'tradeInsightsTab-' + kind; b.disabled = true; return b; });
  const root = node('root'); root.ownerDocument = { createElement: () => new Element() };
  root.querySelector = selector => node(selector.match(/^\[data-ti="(.+)"\]$/)?.[1] || selector);
  root.querySelectorAll = selector => selector === '[data-kind]' ? buttons : [node(selector)];
  for (const [key, fields] of Object.entries({ filters: ['days', 'dateFrom', 'dateTo', 'customer', 'serial', 'supplier', 'query', 'locationId', 'group', 'wgr'], 'class-form': ['level', 'articleKey', 'groupKey'], 'class-save': ['kind'], 'repair-status-form': ['state'] })) {
    const form = node(key); form.elements = Object.fromEntries(fields.map(field => [field, node(key + '-' + field)]));
    form.querySelector = () => node(key + '-button'); form.parentElement = node(key + '-panel');
  }
  node('class-form').elements.level.value = 'wgr';
  const requests = [], changes = [], routeOptions = [];
  const workspace = mount(root, { onTabChange: (tab, options) => { changes.push(tab); routeOptions.push(options); }, api: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) });
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
  for (const tab of tabs) assert.equal(legacyUrl('?tab=' + tab), '/?view=tradeInsights&section=' + tab);
  assert.equal(legacyUrl('?tab=https://elsewhere.example/&view=outside'), '/?view=tradeInsights&section=purchasing');
});

test('stock summary requires a branch, omits period filters and replaces partial totals on continuation', async t=>{
 const SavedFormData=globalThis.FormData;
 globalThis.FormData=class { constructor(form){this.entries=Object.entries(form.elements).map(([k,v])=>[k,v.value]);} [Symbol.iterator](){return this.entries[Symbol.iterator]();} };
 t.after(()=>{globalThis.FormData=SavedFormData;});
 const f=fixture(),pending=f.workspace.activate('stock-summary');
 f.requests[0].resolve({...context,projection:{...context.projection,costs:true}});await tick();
 f.requests[1].resolve({groups:[],wgr:[]});await pending;
 const form=f.node('filters');assert.equal(form.elements.locationId.required,true);assert.equal(f.node('[data-period]').hidden,true);
 form.elements.locationId.value='93';form.elements.dateFrom.value='2026-01-01';
 form.emit('submit',{preventDefault(){}});await tick();
 const first=f.requests.at(-1),query=JSON.parse(first.options.body);
 assert.equal(query.locationId,'93');assert.equal(query.dateFrom,undefined);assert.equal(query.dateTo,undefined);assert.equal(query.days,undefined);
 const total={positions:1,quantity:'1',positivePositions:1,positiveQuantity:'1',confirmedQuantity:'0',provisionalNet:'10',confirmedNet:'0',excluded:0,ambiguous:0,missingArticle:0,missingQuantity:0,negative:0,unclassified:1,missingCost:0,zeroCost:0};
 first.resolve({available:true,cumulative:true,complete:false,scanned:100,next:'continuation',rows:[],totals:total});await tick();
 assert.match(f.node('results').innerHTML,/Zwischenstand/);
 assert.match(f.node('results').innerHTML,/Erfasster Bestand \(vorläufig\).*?<strong>1<\/strong>/);
 assert.match(f.node('note').textContent,/Importiert am:/);
 assert.equal(JSON.parse(f.requests.at(-1).options.body).cursor,'continuation');
 f.requests.at(-1).resolve({available:true,cumulative:true,complete:true,scanned:105,next:null,rows:[],totals:{...total,positions:2,provisionalNet:'20'}});await tick();
 assert.match(f.node('results').innerHTML,/Alle Quellenpositionen geprüft/);assert.doesNotMatch(f.node('results').innerHTML,/Zwischenstand/);
 assert.equal(f.node('more').hidden,true);f.workspace.destroy();
});
