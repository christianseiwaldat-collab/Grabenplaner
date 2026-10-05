'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express'), sharp = require('sharp');
const { registerSalesPriceLabelsRoutes, normalizeSelection } = require('../lib/sales-price-labels-routes');
const Article = require('../lib/sales-article-catalog-access');
const Pdf = require('../lib/sales-price-labels-pdf');
const rights = Article.SALES_ARTICLE_CATALOG_PERMISSIONS;
const permissions = [rights.ACCESS, rights.READ, rights.PRICES_READ];
const principal = (employeeNumber = '42', grants = permissions) => ({ employeeNumber, accountId: 'account-' + employeeNumber,
  permissions: [...grants], scopes: [], isEmployee: true, sessionKind: 'employee', mustChangePassword: false });

async function fixture(t) {
  const app = express(), stored = new Map();
  const state = { principals: { '42': principal(), '43': principal('43') }, catalogHook: null, detailHook: null, imageHook: null, preferenceHook: null, brandingHook: null,
    counts: { catalog: 0, detail: 0, images: 0 }, loaded: [] };
  const photo = await sharp({ create: { width: 220, height: 160, channels: 3, background: '#26725f' } }).webp().toBuffer();
  app.use(express.json({ limit: '1mb' }));
  registerSalesPriceLabelsRoutes(app, {
    draftVault: require('../lib/integration-secret-vault').createIntegrationSecretVault({ activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 17) } }),
    catalog: { async getByArticleNumber(number) {
      state.counts.catalog++; state.loaded.push(number);
      if (!/^\d{6}$/.test(number) || number === '999999') return null;
      const article = { articleNumber: number, description: 'SERVER-ARTICLE-' + number,
        currentRevision: 7, stalePrice: '8888.88', prices: [
          { priceType: 'sales', amount: number === '001235' ? null : number === '001236' ? '88.88' : '1499.900000000000',
            currency: 'EUR', priceBasis: number === '001236' ? 'unknown' : 'gross', qualityStatus: number === '001236' ? 'unresolved' : 'confirmed', sourceField: 'Verkaufspreis' },
          { priceType: 'internet_1', amount: '1399.950000000000', currency: 'EUR', priceBasis: 'gross', qualityStatus: 'inferred', sourceField: 'Internet_VK' },
          { priceType: 'internet_3', amount: '1299.500000000000', currency: 'EUR', priceBasis: 'gross', qualityStatus: 'inferred', sourceField: 'InternetVK3' },
        ] };
      await state.catalogHook?.(article); return article;
    } },
    preferences: {
      async get(owner, key) { const value = stored.get(owner + ':' + key); await state.preferenceHook?.(); return { value }; },
      async upsert(owner, key, value) { stored.set(owner + ':' + key, value); await state.preferenceHook?.(); },
    },
    sessionFor(req) { return structuredClone(state.principals[req.get('X-Employee') || '42']); },
    async assertFresh() {},
    async refreshSession(req) { return state.principals[req.get('X-Employee') || '42']; },
    listBranchAccounts: async () => [], getEmployeeHomeLocation: async () => null,
    templateStore: { async getDefault() { return { options: Pdf.normalizeOptions({}), filenameOptions: { stamp: 'date-time', position: 'before', separator: '-', suffix: '' } }; } },
    assertCsrf(req) { if (req.get('X-CSRF-Token') !== 'synthetic') throw Object.assign(Error('CSRF'), { status: 403 }); },
    privateHeaders(res) { res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); },
    async loadDetail(article, session) {
      state.counts.detail++; assert.equal(Article.buildSalesArticleCatalogProjection(session).costsRead, false);
      const id = article.articleNumber;
      const gross = id === '001235' ? null : id === '001236' ? { amount: '88.88', sourceValue: true }
        : { amount: '1499.90', sourceValue: false };
      const detail = { article: { articleNumber: id, description: article.description, active: true,
        priceMatrix: { vatPercent: id === '001237' ? null : 20, sales: [
          { id: 'sales', gross, net: { amount: '8888.88' }, margin: { amount: '7777.77' } },
          { id: 'internet_1', gross: { amount: '1399.95' } },
          { id: 'internet_3', gross: { amount: '1299.50' } },
        ], purchase: [{ id: 'average_purchase', current: { amount: '6666.66' } }], costsRead: true },
        sourceSections: [{ fields: [{ id: 'Marke', value: 'SERVER-BRAND' }, { id: 'DurchschnittEK', value: '6666.66' }] }],
        identifiers: [{ identifierValue: 'FALLBACK-EAN', isPrimary: false, identifierType: 'ean13' },
          { identifierValue: 'SERVER-EAN-' + id, isPrimary: true, identifierType: 'ean13' }],
        image: { present: id !== '001238' }, prices: [{ amount: '8888.88', priceBasis: 'gross', validUntil: '2020-01-01' }],
      }, revisions: [{ prices: [{ amount: '9999.99' }] }] };
      await state.detailHook?.(); return detail;
    },
    images: { async content(number) { state.counts.images++; if (number === '001238') return null; await state.imageHook?.(); return { buffer: photo, mime: 'image/webp' }; } },
    branding: { async list() { await state.brandingHook?.(); return { kits: [{ id: 'trusted-logo', name: 'Trusted Kit', logos: [{ key: 'logo', label: 'Firmenlogo', url: '/assets/trusted-logo.png' }] }] }; },
      async content(options) { assert.equal(options.logoKitId, 'trusted-logo'); assert.equal(options.logoAssetKey, 'logo'); await state.brandingHook?.(); return photo; } },
  });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code || 'UNEXPECTED', error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/sales/price-labels/';
  const request = (suffix, body, { employee = '42', csrf = 'synthetic' } = {}) => fetch(url + suffix, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Employee': employee, 'X-CSRF-Token': csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { state, stored, request };
}
const exportBody = extra => ({ articleNumbers: ['001234'], priceType: 'sales', options: {}, name: 'Preisschild', stamp: 'none', ...extra });
async function readPdf(response) {
  assert.equal(response.status, 200, response.status === 200 ? '' : await response.text());
  assert.match(response.headers.get('content-type'), /application\/pdf/);
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox allow-downloads");
  const buffer = Buffer.from(await response.arrayBuffer()); assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }), document = await task.promise;
  try {
    const pages = []; let images = 0;
    for (let i = 1; i <= document.numPages; i++) {
      const page = await document.getPage(i), content = await page.getTextContent(), operators = await page.getOperatorList();
      pages.push(content.items.map(item => item.str).join(' '));
      images += operators.fnArray.filter(id => [OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(id)).length;
    }
    return { text: pages.join(' '), images, pageCount: document.numPages };
  } finally { await task.destroy(); }
}

test('Price label selections preserve exact IDs, reject normalized duplicates and cap the selection before reading data', async t => {
  assert.deepEqual(normalizeSelection([' 000042 ', '42']), ['000042', '42']);
  const f = await fixture(t);
  for (const input of [[], null, '001234', [''], [1234], ['001234', ' 001234 '], ['x\ny'], Array.from({ length: 101 }, (_, i) => String(i).padStart(6, '0'))]) {
    const response = await f.request('articles', { articleNumbers: input });
    assert.equal(response.status, 400, JSON.stringify(input));
  }
  assert.equal(f.state.counts.catalog, 0);
  const hundred = Array.from({ length: 100 }, (_, i) => String(i).padStart(6, '0'));
  const result = await f.request('articles', { articleNumbers: hundred });
  assert.equal(result.status, 200); assert.equal((await result.json()).items.length, 100);
  assert.deepEqual(f.state.loaded, hundred);
});

test('Price label operations require price-reading authority and CSRF, and reject client prices or hidden cost types', async t => {
  const f = await fixture(t);
  for (const grants of [[], [rights.PRICES_READ], [rights.ACCESS, rights.PRICES_READ], [rights.ACCESS, rights.READ]]) {
    f.state.principals['42'] = principal('42', grants);
    assert.equal((await f.request('templates')).status, 403);
    assert.equal((await f.request('articles', { articleNumbers: ['001234'] })).status, 403);
    assert.equal((await f.request('export.pdf', exportBody())).status, 403);
  }
  f.state.principals['42'] = principal();
  for (const [suffix, body] of [['templates', { options: {}, filenameOptions: {} }], ['articles', { articleNumbers: ['001234'] }], ['export.pdf', exportBody()]]) {
    assert.equal((await f.request(suffix, body, { csrf: '' })).status, 403);
  }
  assert.equal(f.state.counts.catalog, 0); assert.equal(f.stored.size, 0);
  for (const priceType of ['average_purchase', 'internet_5', 'old-sale', 'wholesale']) {
    assert.equal((await f.request('articles', { articleNumbers: ['001234'], priceType })).status, 400);
  }
  for (const extra of [{ priceGross: '0' }, { items: [{ articleNumber: '001234', priceGross: '0', description: 'FORGED' }] },
    { imageBuffer: 'FORGED' }, { prices: ['FORGED'] }, { employeeNumber: '43' }]) {
    assert.equal((await f.request('export.pdf', exportBody(extra))).status, 422);
  }
  assert.equal(f.state.counts.catalog, 0);
  assert.equal((await f.request('templates?employeeNumber=43')).status, 422);
  assert.equal((await f.request('articles', { articleNumbers: ['999999'] })).status, 404);
});

test('Price label preview uses the current trusted gross price and never substitutes historical, net or purchase prices', async t => {
  const f = await fixture(t), response = await f.request('articles', { articleNumbers: ['001234', '001235', '001236'] });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.items.map(item => item.priceGross), ['1499.90', null, null]);
  assert.equal(result.items[0].description, 'SERVER-ARTICLE-001234');
  assert.equal(result.items[0].ean, 'SERVER-EAN-001234'); assert.equal(result.items[0].brand, 'SERVER-BRAND');
  assert.equal(result.items[0].taxRate, 20); assert.match(result.items[0].imageUrl, /articleNumber=001234$/);
  assert.doesNotMatch(JSON.stringify(result), /8888\.88|7777\.77|6666\.66|9999\.99|88\.88/);
  assert.equal(f.state.counts.images, 0);
  for (const [priceType, expected] of [['internet_1', '1399.95'], ['internet_3', '1299.50']]) {
    const value = await (await f.request('articles', { articleNumbers: ['001234'], priceType })).json();
    assert.equal(value.items[0].priceGross, expected);
  }
  const noPhoto = await (await f.request('articles', { articleNumbers: ['001238'] })).json();
  assert.equal(noPhoto.items[0].imageUrl, null);
});

test('A matrix gross label cannot override persisted net/unknown/currency/type/quality evidence or an ambiguous current price', async t => {
  const f = await fixture(t);
  for (const change of [{ priceBasis: 'net' }, { priceBasis: 'unknown' }, { currency: 'USD' }, { priceType: 'average_purchase' },
    { qualityStatus: 'unresolved' }, { qualityStatus: 'quarantined' }, { amount: '100.00' }]) {
    f.state.catalogHook = async article => { Object.assign(article.prices[0], change); };
    const response = await f.request('articles', { articleNumbers: ['001234'] });
    assert.equal(response.status, 200); assert.equal((await response.json()).items[0].priceGross, null, JSON.stringify(change));
  }
  f.state.catalogHook = async article => { article.prices.push({ ...article.prices[0], sourceField: 'OtherCurrentGross' }); };
  assert.equal((await (await f.request('articles', { articleNumbers: ['001234'] })).json()).items[0].priceGross, null);
  // This was accepted by the general import contract and selected as gross by
  // the source-field-first matrix even though its actual stored basis is net.
  f.state.catalogHook = async article => { article.prices[0].priceBasis = 'net'; };
  const result = await readPdf(await f.request('export.pdf', exportBody()));
  assert.match(result.text, /Preis prüfen/); assert.doesNotMatch(result.text, /1\.499,90 €/);
});

test('Price label templates persist by account owner, validate options and recover safely from invalid stored preferences', async t => {
  const f = await fixture(t), initial = await (await f.request('templates')).json();
  assert.deepEqual(initial.options, Pdf.normalizeOptions({}));
  const saved = { options: { paper: 'A5', labelWidthMm: 80, labelHeightMm: 55, copies: 2, design: 'promo', shape: 'rounded', color: '#aabbcc',
    showPhoto: true, showEan: false, headline: 'Angebot', footer: 'Filiale 18' },
    filenameOptions: { stamp: 'date-suffix', position: 'after', separator: '_', suffix: 'Fil18' } };
  const response = await f.request('templates', saved); assert.equal(response.status, 200);
  const normalized = await response.json(); assert.deepEqual(normalized.options, Pdf.normalizeOptions(saved.options));
  assert.deepEqual(await (await f.request('templates')).json(), normalized);
  assert.deepEqual(await (await f.request('templates', undefined, { employee: '43' })).json(), initial);
  for (const invalid of [{ options: { copies: 0 }, filenameOptions: {} }, { options: { showPhoto: 'true' }, filenameOptions: {} },
    { options: { labelWidthMm: 500 }, filenameOptions: {} }, { options: {}, filenameOptions: { position: 'middle' } },
    { options: {}, filenameOptions: {}, articleNumbers: ['001234'] }]) {
    assert.ok([400, 422].includes((await f.request('templates', invalid)).status));
  }
  f.stored.set('42:sales_price_labels_v1', '{bad-json');
  assert.deepEqual(await (await f.request('templates')).json(), initial);
  f.stored.set('42:sales_price_labels_v1', JSON.stringify({ options: { unknown: 'FORGED' } }));
  assert.deepEqual(await (await f.request('templates')).json(), initial);
});

test('Price label PDF contains trusted selected prices, marks unknown prices, honors the filename model and optional photo', async t => {
  const f = await fixture(t);
  const response = await f.request('export.pdf', exportBody({ name: 'Preis:Liste?.pdf', priceType: 'internet_3',
    stamp: 'date-suffix', position: 'after', separator: '_', suffix: 'Fil18' }));
  assert.match(response.headers.get('content-disposition') || '', /PreisListe_\d{6}-Fil18\.pdf/);
  const plain = await readPdf(response);
  assert.match(plain.text, /SERVER-ARTICLE-001234/); assert.match(plain.text, /1\.299,50/);
  assert.match(plain.text, /Art\. 001234/); assert.match(plain.text, /SERVER-EAN-001234/); assert.match(plain.text, /inkl\. 20 % MwSt\./);
  assert.doesNotMatch(plain.text, /8888|8\.888|7777|7\.777|6666|6\.666|9999|9\.999/);
  assert.equal(plain.images, 0); assert.equal(f.state.counts.images, 0);
  const unknown = await readPdf(await f.request('export.pdf', exportBody({ articleNumbers: ['001235', '001236', '001237'], options: { showEan: false } })));
  assert.equal((unknown.text.match(/Preis prüfen/g) || []).length, 2); assert.match(unknown.text, /MwSt\. prüfen/);
  assert.doesNotMatch(unknown.text, /0,00 €|88,88 €|6\.666,66 €|8\.888,88 €/);
  const withPhoto = await readPdf(await f.request('export.pdf', exportBody({ options: { showPhoto: true, showEan: false, showTax: false } })));
  assert.equal(withPhoto.images, 1); assert.equal(f.state.counts.images, 1);
  assert.doesNotMatch(withPhoto.text, /SERVER-EAN|MwSt\./);
  const missingPhoto = await readPdf(await f.request('export.pdf', exportBody({ articleNumbers: ['001238'], options: { showPhoto: true } })));
  assert.equal(missingPhoto.images, 0); assert.equal(f.state.counts.images, 1);
});

test('Price label PDF rejects invalid file/export controls and excessive copies without sending PDF contents', async t => {
  const f = await fixture(t);
  for (const invalid of [exportBody({ name: '' }), exportBody({ name: 42 }), exportBody({ name: 'x'.repeat(111) }),
    exportBody({ stamp: 'yesterday' }), exportBody({ position: 'middle' }), exportBody({ options: { copies: 1.5 } }),
    exportBody({ options: { showPhoto: 1 } }), exportBody({ options: { arbitrary: true } }), exportBody({ articleNumbers: ['999999'] })]) {
    const response = await f.request('export.pdf', invalid);
    assert.ok([400, 404].includes(response.status), JSON.stringify(invalid));
    assert.doesNotMatch(response.headers.get('content-type') || '', /application\/pdf/);
  }
  const excess = await f.request('export.pdf', exportBody({ articleNumbers: Array.from({ length: 21 }, (_, i) => String(i).padStart(6, '0')), options: { copies: 50 } }));
  assert.equal(excess.status, 413); assert.equal((await excess.json()).code, 'PRICE_LABEL_LIMIT');
});

test('Price label responses stop after late price-right, account or scope changes during a protected read', async t => {
  const f = await fixture(t), original = f.state.principals['42'];
  f.state.detailHook = async () => { f.state.principals['42'] = principal('42', [rights.ACCESS, rights.READ]); };
  const preview = await f.request('articles', { articleNumbers: ['001234', '001235'] });
  assert.equal(preview.status, 403); assert.equal(f.state.counts.catalog, 1);
  assert.doesNotMatch(await preview.text(), /SERVER-ARTICLE|1499/);
  f.state.detailHook = async () => { f.state.principals['42'] = { ...original, scopes: [{ locationId: 'other-location' }] }; };
  f.state.principals['42'] = original;
  assert.equal((await f.request('export.pdf', exportBody())).status, 403);
  f.state.detailHook = null; f.state.principals['42'] = original;
  f.state.imageHook = async () => { f.state.principals['42'] = { ...original, accountId: 'replacement-account' }; };
  assert.equal((await f.request('export.pdf', exportBody({ options: { showPhoto: true } }))).status, 403);
  f.state.imageHook = null; f.state.principals['42'] = original;
  f.state.preferenceHook = async () => { f.state.principals['42'] = { ...original, accountId: 'replacement-account' }; };
  assert.equal((await f.request('templates')).status, 403);
});

test('Forced password changes and late employee-session changes stop protected results', async t => {
  const f = await fixture(t), original = f.state.principals['42'];
  f.state.principals['42'] = { ...original, mustChangePassword: true };
  assert.equal((await f.request('templates')).status, 403); assert.equal(f.state.counts.catalog, 0);
  f.state.principals['42'] = original;
  f.state.detailHook = async () => { f.state.principals['42'] = { ...original, mustChangePassword: true }; };
  const response = await f.request('export.pdf', exportBody()); assert.equal(response.status, 403);
  assert.doesNotMatch(response.headers.get('content-type') || '', /application\/pdf/);
  assert.doesNotMatch(await response.text(), /SERVER-ARTICLE|1499/);
  f.state.principals['42'] = original;
  f.state.detailHook = async () => { f.state.principals['42'] = { ...original, sessionKind: 'organization', isEmployee: false }; };
  assert.equal((await f.request('articles', { articleNumbers: ['001234'] })).status, 403);
});

test('Authorized local session fields can be absent without breaking canonical freshness checks', async t => {
  const f = await fixture(t);
  f.state.principals['42'] = { employeeNumber: 'local', sessionKind: 'local', localSystem: true,
    permissions: [...permissions], scopes: [] };
  assert.equal((await f.request('templates')).status, 200);
  const response = await f.request('articles', { articleNumbers: ['001234'] });
  assert.equal(response.status, 200); assert.equal((await response.json()).items[0].priceGross, '1499.90');
});

test('Price-specific image previews use trusted stored WEBP, private headers and fresh price authority without opening global article routes', async t => {
  const f = await fixture(t), original = f.state.principals['42'];
  const preview = await (await f.request('articles', { articleNumbers: ['001234'] })).json();
  assert.equal(preview.items[0].imageUrl, '/api/sales/price-labels/image?articleNumber=001234');
  const image = await f.request('image?articleNumber=001234');
  assert.equal(image.status, 200); assert.match(image.headers.get('content-type'), /image\/webp/); assert.match(image.headers.get('cache-control'), /no-store/);
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff'); assert.match(image.headers.get('content-security-policy'), /sandbox/);
  const bytes = Buffer.from(await image.arrayBuffer()); assert.equal(bytes.subarray(0, 4).toString(), 'RIFF'); assert.equal(bytes.subarray(8, 12).toString(), 'WEBP');
  const before = f.state.counts.images;
  assert.equal((await f.request('image?articleNumber=999999')).status, 404); assert.equal(f.state.counts.images, before);
  assert.equal((await f.request('image?articleNumber=001234&url=https://untrusted.invalid/image')).status, 422);
  assert.equal((await f.request('image?articleNumber=001238')).status, 404);
  f.state.imageHook = async () => { f.state.principals['42'] = { ...original, mustChangePassword: true }; };
  const revoked = await f.request('image?articleNumber=001234'); assert.equal(revoked.status, 403);
  assert.doesNotMatch(revoked.headers.get('content-type'), /image\/webp/);
});

test('Branding selection exports only trusted logo bytes and suppresses lists/PDF after late identity changes', async t => {
  const f = await fixture(t), original = f.state.principals['42'];
  const result = await f.request('branding'); assert.equal(result.status, 200);
  assert.equal((await result.json()).kits[0].id, 'trusted-logo');
  assert.equal((await f.request('branding?url=https://untrusted.invalid/logo')).status, 422);
  const chosen = exportBody({ options: { logoKitId: 'trusted-logo', logoAssetKey: 'logo', logoPosition: 'top-center', logoWidthMm: 15, logoHeightMm: 8 } });
  const pdf = await readPdf(await f.request('export.pdf', chosen)); assert.equal(pdf.images, 1); assert.match(pdf.text, /1\.499,90/);
  assert.equal((await f.request('export.pdf', { ...chosen, logoBuffer: 'CLIENT-FORGED-BYTES' })).status, 422);
  f.state.brandingHook = async () => { f.state.principals['42'] = { ...original, accountId: 'changed-account' }; };
  const lateList = await f.request('branding'); assert.equal(lateList.status, 403); assert.doesNotMatch(await lateList.text(), /Trusted Kit/);
  f.state.principals['42'] = original;
  const latePdf = await f.request('export.pdf', chosen); assert.equal(latePdf.status, 403); assert.doesNotMatch(latePdf.headers.get('content-type'), /application\/pdf/);
});
