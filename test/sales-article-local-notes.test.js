'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const express = require('express');
const { fixture } = require('../test-support/trade-insights-sqlite');
const { seedWorkspace } = require('../test-support/sales-article-workspace-fixture');
const { createSalesArticleCatalogRepository } = require('../lib/persistence/repositories/sales-article-catalog');
const { salesArticleImportContentSha256 } = require('../lib/sales-article-catalog');
const { createSalesArticleLocalNotesRepository } = require('../lib/persistence/repositories/sales-article-local-notes');
const { registerSalesArticleLocalNotesRoutes } = require('../lib/sales-article-local-notes-routes');
const N = require('../lib/sales-article-local-notes');
const makeRepository = f => createSalesArticleLocalNotesRepository({ access: f.app.provider, vault: f.vault });
const add = (repo, extra = {}) => repo.add({ articleNumber: '005479', text: 'Eigene dauerhafte Notiz',
  actor: '42', mutationId: crypto.randomUUID(), expectedRevision: 0, ...extra });

test('Shared encrypted own notes survive Trade updates, archive, copied database and restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-own-article-notes-'));
  const cleanup = [], fixtureOwner = { after: fn => cleanup.push(fn) };
  t.after(async () => { for (const close of cleanup) await close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const f = await fixture(fixtureOwner, { databasePath: path.join(directory, 'notes.db') });
  await seedWorkspace({ access: f.app.provider, source: f });
  const notes = makeRepository(f);
  const saved = await add(notes, { text: 'Kundenbestellung\nAbholung nach Rückruf.' });
  assert.equal(saved.revision, 1); assert.equal(saved.items[0].author, '42');
  assert.match(saved.items[0].createdAt, /Z$/);
  assert.deepEqual(await notes.list('005479'), saved);
  assert.deepEqual((await notes.list('005480')).items, []);
  assert.deepEqual((await notes.list('5479')).items, [], 'Leading zero keys stay distinct');
  const catalog = createSalesArticleCatalogRepository(f.app.provider);
  const articles = [{ sourceArticleKey: '005479', articleNumber: '005479', description: 'Neue Beschreibung',
    active: true, sourceUpdatedAt: null, identifiers: [], prices: [] }];
  await catalog.importSnapshot({ snapshot: { sourceSystem: 'tradefoto.artikel_stamm', sourceProfileVersion: 'workspace-test-v1',
    sourceSchemaSha256: 'a'.repeat(64), sourceFileSha256: 'b'.repeat(64), contentSha256: salesArticleImportContentSha256(articles),
    snapshotAt: '2026-10-01T10:00:00.000Z', articles }, actor: 'synthetic-owner', timestamp: '2026-10-01T10:00:00.000Z' });
  await f.ingest('Artikel_Bemerkungen', [{ EAN: '005479', Text: 'Neue Trade-Notiz' }], { master: true });
  const current = await catalog.getByArticleNumber('005479');
  await catalog.archiveManual({ input: { articleNumber: '005479', expectedRevision: current.currentRevision },
    actor: 'synthetic-owner', timestamp: '2026-10-01T11:00:00.000Z', mutationId: crypto.randomUUID() });
  assert.deepEqual(await notes.list('005479'), saved);
  const stored = f.app.database.prepare("SELECT * FROM trade_annotations WHERE kind='article-own-notes'").get();
  assert.equal(stored.scope_id, 'grabenplaner-main:article-own-notes');
  assert.doesNotMatch(JSON.stringify(stored), /Kundenbestellung|Abholung|005479/);
  const audits = f.app.database.prepare("SELECT detail FROM audit_log WHERE action='trade.article-own-notes.update'").all();
  assert.equal(audits.length, 1); assert.doesNotMatch(JSON.stringify(audits), /Kundenbestellung|Abholung/);
  // The shared annotation namespace does not affect the Trade search source epoch.
  assert.equal(f.app.database.prepare("SELECT COALESCE(SUM(revision),0) AS n FROM trade_annotations WHERE scope_id='grabenplaner-main'").get().n, 0);
  const copyPath = path.join(directory, 'copy.db'); f.app.database.prepare('VACUUM INTO ?').run(copyPath);
  const restored = await fixture(fixtureOwner, { databasePath: copyPath, resume: true });
  assert.deepEqual(await makeRepository(restored).list('005479'), saved);
});

test('Append is revision-safe and retries do not create duplicate notes; text is bounded and plaintext only', async t => {
  const f = await fixture(t), notes = makeRepository(f), mutationId = crypto.randomUUID();
  const saved = await add(notes, { mutationId, text: '  <script>alert(1)</script>\r\nNur Text.  ' });
  assert.equal(saved.items[0].text, '<script>alert(1)</script>\nNur Text.');
  assert.deepEqual(await add(notes, { mutationId, text: '<script>alert(1)</script>\nNur Text.' }), saved);
  await assert.rejects(add(notes), { code: 'ARTICLE_NOTES_CONFLICT' });
  await assert.rejects(add(notes, { mutationId, text: 'Andere Notiz', expectedRevision: 1 }), { code: 'ARTICLE_NOTES_CONFLICT' });
  await assert.rejects(add(notes, { mutationId, actor: '43', text: saved.items[0].text, expectedRevision: 1 }), { code: 'ARTICLE_NOTES_CONFLICT' });
  const second = await add(notes, { actor: '43', text: 'Andere Person', expectedRevision: 1 });
  assert.equal(second.revision, 2); assert.deepEqual(second.items.map(item => item.author), ['43', '42']);
  for (const text of ['', '   ', 'a'.repeat(N.MAX_TEXT_LENGTH + 1), 'Bad\u0000text', '\u000b', '\u007f']) {
    await assert.rejects(add(notes, { text, expectedRevision: 2 }), { code: 'ARTICLE_NOTES_INPUT' });
  }
  for (const expectedRevision of [-1, 1.5, '2', Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(add(notes, { expectedRevision }), { code: 'ARTICLE_NOTES_REVISION' });
  }
  await assert.rejects(add(notes, { mutationId: 'client-chosen-unsafe-id' }), { code: 'ARTICLE_NOTES_INPUT' });
  await assert.rejects(notes.add({ articleNumber: '005479', text: 'x', expectedRevision: 2, mutationId: crypto.randomUUID(), actor: '42', extra: true }), { code: 'ARTICLE_NOTES_INPUT' });
  assert.equal((await notes.list('005479')).revision, 2);
  f.app.database.prepare("UPDATE trade_annotations SET payload='corrupted' WHERE kind='article-own-notes'").run();
  await assert.rejects(notes.list('005479'), { code: 'ARTICLE_NOTES_INTEGRITY' });
});

test('Own note API requires fresh read/write rights, CSRF and known articles without client-spoofed provenance', async t => {
  const f = await fixture(t); await seedWorkspace({ access: f.app.provider, source: f });
  const notes = makeRepository(f), app = express(); let allowed = true, checks = 0, revokeOnCheck = Infinity;
  app.use(express.json({ limit: '64kb' }));
  registerSalesArticleLocalNotesRoutes(app, { notes, catalog: createSalesArticleCatalogRepository(f.app.provider),
    sessionFor(req, write) {
      if (req.get('X-Reader') !== 'yes' || write && req.get('X-Writer') !== 'yes') throw Object.assign(Error('Forbidden'), { status: 403 });
      return { employeeNumber: '42', accountId: 'account-42' };
    },
    assertCsrf(req) { if (req.get('X-CSRF-Token') !== 'test') throw Object.assign(Error('CSRF'), { status: 403 }); },
    async assertFresh() { checks += 1; if (!allowed || checks === revokeOnCheck) throw Object.assign(Error('Revoked'), { status: 403 }); },
    privateHeaders(res) { res.set('Cache-Control', 'private, no-store'); },
  });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/sales/articles/local-notes`;
  const headers = { 'X-Reader': 'yes', 'X-Writer': 'yes', 'X-CSRF-Token': 'test', 'Content-Type': 'application/json' };
  const post = (body = {}, override = {}) => fetch(endpoint, { method: 'POST', headers: { ...headers, ...override },
    body: JSON.stringify({ articleNumber: '005479', text: 'Notiz für alle berechtigten Leser', expectedRevision: 0, mutationId: crypto.randomUUID(), ...body }) });
  assert.equal((await fetch(endpoint + '?articleNumber=005479')).status, 403);
  assert.equal((await post({}, { 'X-Writer': 'no' })).status, 403);
  assert.equal((await post({}, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await post({ author: 'Spoofed author' })).status, 400);
  assert.equal((await post({ articleNumber: 'unknown' })).status, 404);
  checks = 0; revokeOnCheck = 2;
  assert.equal((await post()).status, 403); assert.equal((await notes.list('005479')).revision, 0, 'Revoked before append; no note persisted');
  revokeOnCheck = Infinity; const savedResponse = await post();
  assert.equal(savedResponse.status, 201); const saved = await savedResponse.json(); assert.equal(saved.items[0].author, '42');
  const get = await fetch(endpoint + '?articleNumber=005479', { headers: { 'X-Reader': 'yes' } });
  assert.equal(get.status, 200); assert.match(get.headers.get('cache-control'), /no-store/); assert.deepEqual(await get.json(), saved);
  assert.equal((await fetch(endpoint + '?articleNumber=005480', { headers })).status, 200);
  allowed = false; assert.equal((await fetch(endpoint + '?articleNumber=005479', { headers })).status, 403);
  assert.equal((await post({ expectedRevision: 1 })).status, 403); assert.equal((await notes.list('005479')).revision, 1);
});

test('Own notes use the existing native PostgreSQL encrypted business annotation catalog', () => {
  const { A } = require('../lib/persistence/statements/trade-annotations');
  const catalog = require('../lib/persistence/postgresql/core/trade-annotations').CATALOG;
  for (const statement of [A.get, A.insert, A.update]) {
    const entry = catalog.find(item => item.statement === statement);
    assert.ok(entry); assert.match(entry.sql, /gp\.trade_annotations/);
    assert.ok(entry.parameterOrder.includes('scopeId'));
  }
});
