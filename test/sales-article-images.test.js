'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const sharp = require('sharp'), express = require('express');
const { prepareSalesArticleImage, fetchSalesArticleImage, MAX_INPUT_BYTES } = require('../lib/sales-article-image');
const { registerSalesArticleImageRoutes } = require('../lib/sales-article-image-routes');
const { createSalesArticleImagesRepository } = require('../lib/persistence/repositories/sales-article-images');
const { createSalesArticleCatalogRepository } = require('../lib/persistence/repositories/sales-article-catalog');
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
  assert.ok(image.buffer.length <= 50 * 1024); assert.equal(metadata.exif, undefined); assert.equal(metadata.orientation, undefined);
  for (const input of [Buffer.alloc(0), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('%PDF-1.7'), Buffer.from([255, 216, 255, 0])]) {
    await assert.rejects(prepareSalesArticleImage(input));
  }
  await assert.rejects(prepareSalesArticleImage(Buffer.alloc(MAX_INPUT_BYTES + 1)), { code: 'ARTICLE_IMAGE_TOO_LARGE' });
});

test('Even detailed noisy images are permanently reduced below 50 KB', async () => {
  const pixels = crypto.randomBytes(1400 * 1000 * 3);
  const input = await sharp(pixels,{raw:{width:1400,height:1000,channels:3}}).png().toBuffer();
  assert.ok(input.length > 50 * 1024);
  const image = await prepareSalesArticleImage(input);
  assert.ok(image.buffer.length <= 50 * 1024);
  assert.ok(image.width >= 240 && image.width <= 1280);
  assert.ok(Math.abs(image.width / image.height - 1.4) < .02, 'Aspect ratio preserved');
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
