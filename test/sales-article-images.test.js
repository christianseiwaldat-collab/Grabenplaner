'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const sharp = require('sharp'), express = require('express');
const { prepareSalesArticleImage, fetchSalesArticleImage, MAX_INPUT_BYTES } = require('../lib/sales-article-image');
const { registerSalesArticleImageRoutes } = require('../lib/sales-article-image-routes');
const { createSalesArticleImagesRepository } = require('../lib/persistence/repositories/sales-article-images');
const { createSalesArticleCatalogRepository } = require('../lib/persistence/repositories/sales-article-catalog');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { ensureSqliteSalesArticleCatalogSchema } = require('../lib/persistence/sqlite/operations/sales-article-catalog-schema');
const { SQLITE_SALES_ARTICLE_CATALOG } = require('../lib/persistence/sqlite/sales-article-catalog-catalog');
const { SQLITE_SALES_ARTICLE_IMAGES_CATALOG } = require('../lib/persistence/sqlite/sales-article-images-catalog');
const { salesArticleImportContentSha256 } = require('../lib/sales-article-catalog');

const raster = () => sharp({ create: { width: 1900, height: 1000, channels: 4, background: '#256c48' } }).png().toBuffer();

test('Hinterlegte Produktlinks bleiben klickbar, ohne Medienabruf oder ausführbare URL-Schemata', () => {
  const { projectSalesArticleSourceField } = require('../lib/sales-article-detail-source');
  const link = projectSalesArticleSourceField('HerstellerLink', 'Produktlink', 'https://geizhals.at/test-produkt-a123.html');
  assert.equal(link.label, 'Geizhals'); assert.equal(link.href, link.value);
  const vm = require('node:vm'), source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const start = source.indexOf('function renderSalesArticleSourceFieldValue('), end = source.indexOf('\nfunction renderSalesArticleCatalogDetail(', start);
  const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const render = vm.runInNewContext(source.slice(start, end) + '\nrenderSalesArticleSourceFieldValue', { URL, escapeHtml: escape, escapeHtmlAttribute: escape });
  assert.match(render(link), /href="https:\/\/geizhals.at\//); assert.match(render(link), /rel="noopener noreferrer"/);
  assert.doesNotMatch(render({ ...link, value: '<img src=x onerror=alert(1)>' }), /<img/);
  for (const value of ['javascript:alert(1)', 'data:text/html,hi', 'file:///C:/private', 'https://name:secret@example.org/a', 'kein Link']) {
    assert.equal(projectSalesArticleSourceField('HerstellerLink', 'Produktlink', value).href, undefined);
    assert.doesNotMatch(render({ value, href: value }), /<a /);
  }
  assert.equal(projectSalesArticleSourceField('ABild', 'Bild', 'https://example.org/image.png').href, undefined);
});
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-article-images-'));
  const catalogEntries = [...SQLITE_SALES_ARTICLE_CATALOG, ...SQLITE_SALES_ARTICLE_IMAGES_CATALOG];
  const opened = openSqliteApplicationPersistence({ databasePath: path.join(dir, 'test.db'), catalog: catalogEntries });
  const { database, provider } = opened;
  database.exec('CREATE TABLE audit_log(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity_type TEXT,entity_id TEXT,detail TEXT,created_at TEXT)');
  ensureSqliteSalesArticleCatalogSchema(database);
  const catalog = createSalesArticleCatalogRepository(provider), images = createSalesArticleImagesRepository(provider);
  async function importVersion(number) {
    const articles = ['001234', '1234'].map(articleNumber => ({ sourceArticleKey: 'ean-' + articleNumber, articleNumber,
      description: 'Testkamera ' + number, active: number !== 3, sourceUpdatedAt: null, identifiers: [], prices: [] }));
    return catalog.importSnapshot({ snapshot: { sourceSystem: 'tradefoto.artikel_stamm', sourceProfileVersion: 'images-test-v1',
      sourceSchemaSha256: 'a'.repeat(64), sourceFileSha256: String(number).repeat(64), contentSha256: salesArticleImportContentSha256(articles),
      snapshotAt: `2026-09-09T10:0${number}:00.000Z`, articles }, actor: 'tester', timestamp: new Date().toISOString() });
  }
  await importVersion(1);
  return { ...opened, dir, catalogEntries, catalog, images, importVersion,
    async close() { await provider.close(); database.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
function fakeNetwork(replies) {
  const calls = [];
  return { calls, requestFactory(options, callback) {
    calls.push(options); const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const spec = replies.shift(), response = new PassThrough();
      response.statusCode = spec.status || 200; response.headers = spec.headers || { 'content-type': 'image/png' };
      callback(response); if (!response.destroyed && !spec.hang) response.end(spec.body || Buffer.from('image'));
    });
    return req;
  } };
}

test('Bildaufbereitung skaliert ohne Zuschnitt, entfernt Metadaten und weist Dokumente/beschädigte Dateien ab', async () => {
  const buffer = await sharp(await raster()).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const image = await prepareSalesArticleImage(buffer), metadata = await sharp(image.buffer).metadata();
  assert.equal(image.mime, 'image/webp'); assert.equal(image.height, 1280); assert.equal(image.width, 674);
  assert.ok(image.buffer.length <= 524288); assert.equal(metadata.exif, undefined); assert.equal(metadata.orientation, undefined);
  for (const input of [Buffer.alloc(0), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('%PDF-1.7'), Buffer.from([255, 216, 255, 0])]) {
    await assert.rejects(prepareSalesArticleImage(input));
  }
  await assert.rejects(prepareSalesArticleImage(Buffer.alloc(MAX_INPUT_BYTES + 1)), { code: 'ARTICLE_IMAGE_TOO_LARGE' });
});

test('Webbilder verwenden geprüfte DNS-Adressen, keine Cookies, begrenzte sichere Weiterleitungen', async () => {
  const input = await raster(), network = fakeNetwork([
    { status: 302, headers: { location: 'https://cdn.example.com/product.png' } }, { body: input },
  ]);
  const hosts = [];
  const result = await fetchSalesArticleImage('https://images.example.com/item', { ...network, dnsResolver: async host => { hosts.push(host); return [{ address: '93.184.216.34', family: 4 }]; } });
  assert.deepEqual(result, input); assert.deepEqual(hosts, ['images.example.com', 'cdn.example.com']);
  for (const call of network.calls) {
    assert.equal(call.agent, false); assert.equal(call.rejectUnauthorized, true); assert.equal(call.headers.cookie, undefined); assert.equal(call.headers.authorization, undefined);
    let pinned; call.lookup(call.hostname, { all: true }, (_error, addresses) => { pinned = addresses; });
    assert.deepEqual(pinned, [{ address: '93.184.216.34', family: 4 }]);
  }
});

test('Webbilder sperren interne Ziele, DNS-Mischungen, Weiterleitungsumgehungen und übergroße/langsame Antworten', async () => {
  for (const url of ['http://example.com/a', 'https://127.0.0.1/a', 'https://2130706433/a', 'https://[::1]/a', 'https://169.254.169.254/a', 'https://u:p@example.com/a', 'https://example.com:8443/a', 'file:///C:/secret']) {
    let called = false;
    await assert.rejects(fetchSalesArticleImage(url, { requestFactory() { called = true; }, dnsResolver: async () => [{ address: '127.0.0.1', family: 4 }] }), { code: 'ARTICLE_IMAGE_URL' });
    assert.equal(called, false);
  }
  await assert.rejects(fetchSalesArticleImage('https://images.example.com/a', { dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] }), { code: 'ARTICLE_IMAGE_URL' });
  const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
  for (const location of ['https://127.0.0.1/a', 'http://example.com/a', 'https://[::ffff:127.0.0.1]/a']) {
    const network = fakeNetwork([{ status: 302, headers: { location } }]);
    await assert.rejects(fetchSalesArticleImage('https://images.example.com/a', { ...network, dnsResolver: publicDns }));
    assert.equal(network.calls.length, 1);
  }
  for (const spec of [{ headers: { 'content-type': 'text/html' } }, { body: Buffer.alloc(MAX_INPUT_BYTES + 1) }, { headers: { 'content-type': 'image/png', 'content-length': String(MAX_INPUT_BYTES + 1) } }]) {
    await assert.rejects(fetchSalesArticleImage('https://images.example.com/a', { ...fakeNetwork([spec]), dnsResolver: publicDns }));
  }
  await assert.rejects(fetchSalesArticleImage('https://images.example.com/a', { dnsResolver: () => new Promise(() => {}), timeoutMs: 10 }), { code: 'ARTICLE_IMAGE_TIMEOUT' });
  await assert.rejects(fetchSalesArticleImage('https://images.example.com/a', { ...fakeNetwork([{ hang: true }]), dnsResolver: publicDns, timeoutMs: 10 }), { code: 'ARTICLE_IMAGE_TIMEOUT' });
});

test('Eigenes Bild überlebt Trade-Update, Archivierung, Schema-Wiederanlauf und echte Datenbankkopie', async () => {
  const f = await fixture();
  try {
    const article = await f.catalog.getByArticleNumber('001234'), image = await prepareSalesArticleImage(await raster());
    const saved = await f.images.save({ articleNumber: '001234', productId: article.productId, expectedRevision: null, image, actor: 'tester' });
    assert.equal(saved.present, true); assert.equal((await f.images.metadata('1234')).present, false);
    const revision = article.currentRevision;
    assert.equal((await f.catalog.getByArticleNumber('001234')).currentRevision, revision, 'Image changes do not modify imported article revisions');
    await f.importVersion(2);
    const current = await f.catalog.getByArticleNumber('001234');
    await f.catalog.archiveManual({ input: { articleNumber: '001234', expectedRevision: current.currentRevision }, actor: 'tester', timestamp: new Date().toISOString(), mutationId: crypto.randomUUID() });
    await f.importVersion(3); ensureSqliteSalesArticleCatalogSchema(f.database);
    assert.equal((await f.catalog.getByArticleNumber('001234')).description, 'Testkamera 2');
    assert.equal((await f.catalog.getByArticleNumber('001234')).active, false);
    assert.deepEqual(await f.images.metadata('001234'), saved);
    assert.deepEqual((await f.images.content('001234')).buffer, image.buffer);
    const copyPath = path.join(f.dir, 'restored.db'); f.database.prepare('VACUUM INTO ?').run(copyPath);
    const copy = openSqliteApplicationPersistence({ databasePath: copyPath, catalog: f.catalogEntries });
    try { assert.deepEqual((await createSalesArticleImagesRepository(copy.provider).content('001234')).buffer, image.buffer); }
    finally { await copy.provider.close(); copy.database.close(); }
    const before = f.database.prepare('SELECT count(*) AS n FROM audit_log').get().n;
    await assert.rejects(f.images.save({ articleNumber: '001234', productId: article.productId, expectedRevision: null, image, actor: 'tester' }), { code: 'ARTICLE_IMAGE_CONFLICT' });
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM audit_log').get().n, before);
    const removed = await f.images.save({ articleNumber: '001234', productId: article.productId, expectedRevision: saved.revision, image: null, actor: 'tester' });
    assert.equal(removed.present, false); assert.notEqual(removed.revision, saved.revision);
    await assert.rejects(f.images.save({ articleNumber: '001234', productId: article.productId, expectedRevision: saved.revision, image, actor: 'tester' }), { code: 'ARTICLE_IMAGE_CONFLICT' });
    await f.images.save({ articleNumber: '001234', productId: article.productId, expectedRevision: removed.revision, image, actor: 'tester' });
    f.database.prepare("UPDATE sales_article_own_images SET sha256=? WHERE article_number='001234'").run('0'.repeat(64));
    await assert.rejects(f.images.content('001234'), { code: 'ARTICLE_IMAGE_INTEGRITY' });
  } finally { await f.close(); }
});

test('Bild-API schützt Lesen/Schreiben, CSRF, Änderungen während Downloads und hält Inhalte aus Metadaten fern', async () => {
  const f = await fixture(), app = express(), input = await raster(); let allowed = true, downloadCalls = 0, changeDuringDownload = false;
  app.use(express.json({ limit: '1mb' }));
  registerSalesArticleImageRoutes(app, { catalog: f.catalog, images: f.images,
    sessionFor(req, write) { if (!req.get('X-Reader') || write && req.get('X-Writer') !== 'yes') throw Object.assign(Error('Forbidden'), { status: 403 }); return { employeeNumber: 'tester' }; },
    assertCsrf(req) { if (req.get('X-CSRF-Token') !== 'test') throw Object.assign(Error('CSRF'), { status: 403 }); },
    async assertFresh() { if (!allowed) throw Object.assign(Error('Revoked'), { status: 403 }); },
    privateHeaders(res) { res.set('Cache-Control', 'private, no-store'); },
    async fetchImage() { downloadCalls += 1; if (changeDuringDownload) allowed = false; return input; },
  });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const endpoint = `http://127.0.0.1:${server.address().port}/api/sales/articles/image`, headers = { 'X-Reader': 'yes', 'X-Writer': 'yes', 'X-CSRF-Token': 'test' };
  const put = (revision = 'none', extra = {}) => fetch(endpoint + '?articleNumber=001234', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Article-Image-Revision': revision, ...extra }, body: input });
  try {
    assert.equal((await fetch(endpoint + '?articleNumber=001234')).status, 403);
    assert.equal((await put('none', { 'X-Writer': 'no' })).status, 403);
    assert.equal((await put('none', { 'X-CSRF-Token': '' })).status, 403);
    const savedResponse = await put(), saved = await savedResponse.json(); assert.equal(savedResponse.status, 200, JSON.stringify(saved));
    const binary = await fetch(endpoint + '?articleNumber=001234', { headers }); assert.equal(binary.status, 200); assert.equal(binary.headers.get('content-type'), 'image/webp');
    assert.match(binary.headers.get('cache-control'), /no-store/); assert.equal(binary.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((await binary.arrayBuffer()).byteLength > 0); assert.equal(saved.image.content, undefined); assert.equal(saved.image.buffer, undefined);
    assert.equal((await put()).status, 409);
    const post = () => fetch(endpoint + '/from-url', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ articleNumber: '001234', expectedRevision: saved.image.revision, url: 'https://images.example.com/product.png' }) });
    changeDuringDownload = true; assert.equal((await post()).status, 403);
    assert.equal((await f.images.metadata('001234')).revision, saved.image.revision);
    allowed = true; changeDuringDownload = false; const fromUrl = await post(); assert.equal(fromUrl.status, 200, await fromUrl.text()); assert.equal(downloadCalls, 2);
  } finally { await new Promise(resolve => server.close(resolve)); await f.close(); }
});
