'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {fixture} = require('../test-support/trade-insights-sqlite');
const {seedWorkspace} = require('../test-support/sales-article-workspace-fixture');
const {loadSalesArticleDetailData} = require('../lib/sales-article-detail-source');
const UI = require('../public/sales-article-layout');
test('Ordinary article readers see current notes, with exact article isolation and no price rights', async t => {
  const f = await fixture(t), {article} = await seedWorkspace({access:f.app.provider,source:f});
  await f.ingest('Artikel_Bemerkungen', [
    {EAN:'005479',Datum:'2026-09-20T00:00:00.000',Text:'Synthetische Kundenbestellung\nAbholung am Freitag.',LBAe:42},
    {EAN:'005479',Datum:'2026-09-19T00:00:00.000',Text:'Zweite Notiz',LBAe:11},
    {EAN:'005480',Datum:'2026-09-21T00:00:00.000',Text:'FREMDER-ARTIKEL',LBAe:99},
  ], {master:true,snapshotAt:'2026-09-21T10:00:00.000Z'});
  const load = projection => loadSalesArticleDetailData({access:f.app.provider,vault:f.vault,article,projection});
  const data = await load({read:true});
  assert.equal(data.notes.available,true); assert.equal(data.notes.items.length,2);
  assert.equal(data.notes.items[0].person,42); assert.match(data.notes.items[0].text,/Abholung/);
  assert.equal(data.priceMatrix.sales,null); assert.equal(data.priceMatrix.purchase,null);
  assert.doesNotMatch(JSON.stringify(data.notes),/FREMDER-ARTIKEL/);
  assert.deepEqual((await load({read:false})).notes.items,[]);
  await f.ingest('Artikel_Bemerkungen',[{EAN:'005479',Datum:'2026-09-22T00:00:00.000',Text:'Neuer Stand',LBAe:12}],{master:true,snapshotAt:'2026-09-22T10:00:00.000Z'});
  assert.deepEqual((await load({read:true})).notes.items.map(n=>n.text),['Neuer Stand']);
  await f.ingest('Artikel_Bemerkungen',[{EAN:'005479',Text:'Noch nicht übernommen'}],{master:true,apply:false,snapshotAt:'2026-09-23T10:00:00.000Z'});
  assert.deepEqual((await load({read:true})).notes.items.map(n=>n.text),['Neuer Stand']);
  await f.ingest('Artikel_Bemerkungen',[],{master:true,snapshotAt:'2026-09-24T10:00:00.000Z'});
  const empty = (await load({read:true})).notes;
  assert.equal(empty.available,true); assert.deepEqual(empty.items,[]);
});
test('Note content is rendered as plain text with date filters and sortable headers', () => {
  const html = UI.notes({available:true,sourceAt:'2026-09-20',items:[{date:'2026-09-19',text:'<script>alert(1)</script>\nKundenbestellung',person:1}]},{date:x=>x,timestamp:x=>x});
  assert.doesNotMatch(html,/<script>/); assert.match(html,/&lt;script&gt;/);
  assert.match(html,/data-note-from/); assert.match(html,/data-note-to/); assert.match(html,/data-note-sort="date"/);
  assert.match(html,/data-note-sort="text"/); assert.match(html,/data-note-sort="person"/);
});
test('Article note lookup compiles into the native PostgreSQL reporting catalog', () => {
  const W = require('../lib/persistence/statements/sales-article-workspace');
  const entry = require('../lib/persistence/postgresql/reporting/sales-article-workspace-catalog').CATALOG.find(e=>e.statement===W.notes);
  assert.ok(entry); assert.match(entry.sql,/Artikel_Bemerkungen/); assert.match(entry.sql,/identity_hash\s*=/);
  assert.ok(entry.parameterOrder.includes('articleIdentity'));
});
