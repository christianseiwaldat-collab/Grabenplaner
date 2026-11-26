'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {seedWorkspace} = require('../test-support/sales-article-workspace-fixture');
const {loadSalesArticleDetailData} = require('../lib/sales-article-detail-source');
const UI = require('../public/sales-article-layout');
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
