'use strict';

const test = require('node:test'), assert = require('node:assert/strict'), express = require('express'), sharp = require('sharp');
const { registerSalesArticleToolsRoutes } = require('../lib/sales-article-tools-routes');
const Article = require('../lib/sales-article-catalog-access');
const History = require('../lib/sales-history-access');
const Analytics = require('../lib/sales-analytics-access');
const Crm = require('../lib/crm-access');
const Bestell = require('../lib/tradefoto-bestell/access');
const Sales = require('../lib/sales-article-sales-model');
const allRights = [...new Set([Article.SALES_ARTICLE_CATALOG_PERMISSIONS, History.SALES_HISTORY_PERMISSIONS,
  Analytics.SALES_ANALYTICS_PERMISSIONS, Crm.CRM_PERMISSIONS, Bestell.BESTELL_PERMISSIONS].flatMap(Object.values))];
const basicRights = [Article.SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS, Article.SALES_ARTICLE_CATALOG_PERMISSIONS.READ];
const principal = (employeeNumber = '42', permissions = allRights) => ({ employeeNumber, accountId: 'account-' + employeeNumber,
  permissions: [...permissions], scopes: [], isEmployee: true, sessionKind: 'employee', mustChangePassword: false });
async function fixture(t) {
  const app = express(), stored = new Map(), state = { principals: { '42': principal(), '43': principal('43') },
    detailHook: null, notesHook: null, imageHook: null, salesHook: null, movementHook: null, preferencesHook: null, referenceSession: false,
    counts: { catalog: 0, detail: 0, notes: 0, images: 0, sales: 0, movements: 0 }, requests: [] };
  const imageBuffer = await sharp({ create: { width: 220, height: 160, channels: 3, background: '#26725f' } }).webp().toBuffer();
  app.use(express.json({ limit: '1mb' }));
  registerSalesArticleToolsRoutes(app, {
    today:()=> '2026-10-03',
    async loadHistoryContext(session,fresh){await fresh();return {salesLocations:[{id:'branch-a',label:'18 · Branch A'}],movementLocations:[{id:'branch-a',label:'18 · Branch A'},{id:'trade-source:0',label:'0 · Zentrallager'}]};},
    preferences: { async get(owner, key) { const value = stored.get(owner + ':' + key); await state.preferencesHook?.(); return { value }; }, async upsert(owner, key, value) { stored.set(owner + ':' + key, value); } },
    sessionFor(req) {
      const current = state.principals[req.get('X-Employee') || '42'];
      if (!current || !Article.buildSalesArticleCatalogProjection(current).read) throw Object.assign(Error('Forbidden'), { status: 403 });
      return state.referenceSession ? current : structuredClone(current);
    },
    async assertFresh() {}, async refreshSession(req) { return state.principals[req.get('X-Employee') || '42']; },
    assertCsrf(req) { if (req.get('X-CSRF-Token') !== 'synthetic') throw Object.assign(Error('CSRF'), { status: 403 }); },
    privateHeaders(res) { res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); },
    catalog: { async getByArticleNumber(number) { state.counts.catalog++; return number === '001234' ? { articleNumber: number, description: 'SERVER-TRUSTED-ARTICLE' } : null; } },
    async loadDetail(article, session) {
      state.counts.detail++; const grants = Article.buildSalesArticleCatalogProjection(session);
      const result = { article: { articleNumber: article.articleNumber, description: article.description, active: true, currentRevision: 3,
        sourceSections: [{ title: 'Beschreibung & Lieferumfang', fields: [{ label: 'Hinweis', value: 'SERVER-TRUSTED-MASTER' }] }],
        priceMatrix: { costsRead: grants.costsRead, sales: grants.pricesRead ? [{ label: 'EH', gross: { amount: '1499' } }] : null, purchase: null },
        notes: { available: true, items: [{ date: '2026-09-19', person: '42', text: 'SERVER-TRUSTED-TRADE-NOTE' }] }, identifiers: [], provenance: {} }, revisions: [] };
      await state.detailHook?.(); return result;
    },
    notes: { async list(number) { state.counts.notes++; assert.equal(number, '001234'); await state.notesHook?.(); return { revision: 1,
      items: [{ text: 'SERVER-TRUSTED-OWN-NOTE', author: '42', createdAt: '2026-10-01T12:00:00.000Z' }] }; } },
    images: { async content(number) { state.counts.images++; assert.equal(number, '001234'); await state.imageHook?.(); return { buffer: imageBuffer }; } },
    async loadSales(session, query, fresh) {
      state.counts.sales++; state.requests.push({ kind: 'sales', query }); await fresh();
      if (state.salesHook) return state.salesHook(session, query, fresh);
      return { capabilities: Sales.capabilities(session), complete: true, next: null, available: true, durationMs: 4321, rows: [{
        id: 'sale-1', date: '2026-09-20', articleNumber: '001234', quantity: '1', description: 'SERVER-SALE', sourceLocationId: '18', personnel: '252',
        personnelSurname: 'SERVER-SELLER', customerNumber: 'CUSTOMER-NUMBER', customerName: 'SERVER-CUSTOMER', deviceNumber: 'SERVER-DEVICE', receipt: 'BELEG123',
        listSourcePrice: '1499', listGross: null, actualGross: '1399', actualMargin: '55.12', actualMarginPercent: '4.73', status: 'sale', issues: [] }] };
    },
    async loadMovements(session, query, fresh) {
      state.counts.movements++; state.requests.push({ kind: 'movements', query }); await fresh();
      if (state.movementHook) return state.movementHook(session, query, fresh);
      return { available: true, next: null, durationMs: 1234, rows: [{ id: 'movement-1', date: '2026-09-19', articleNumber: '001234',
        quantity: '2', label: 'SERVER-MOVEMENT', from: 'Filiale 0', to: 'Filiale 18', documentRefs: 'Korb123', issueLabel: 'Keine Auffälligkeit' }] };
    },
  });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code || 'UNEXPECTED', error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/sales/articles/';
  const request = (suffix, body, { employee = '42', csrf = 'synthetic' } = {}) => fetch(url + suffix, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Employee': employee, 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { state, stored, request };
}
const pdfBody = extra => ({ articleNumber: '001234', sections: ['master'], includeImage: false, name: 'Artikel-001234', stamp: 'none', ...extra });
async function readPdf(response) {
  assert.equal(response.status, 200, response.status === 200 ? '' : await response.text());
  assert.match(response.headers.get('content-type'), /application\/pdf/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const buffer = Buffer.from(await response.arrayBuffer()); assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs'), task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }), document = await task.promise;
  try {
    const pages = []; let images = 0;
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index), content = await page.getTextContent(), operators = await page.getOperatorList();
      pages.push(content.items.map(item => item.str).join(' ')); images += operators.fnArray.filter(id => [OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(id)).length;
    }
    return { buffer, text: pages.join(' '), pages, images };
  } finally { await task.destroy(); }
}

test('Article table preferences require one known column and valid widths, persist per reader and filter revoked columns', async t => {
  const f = await fixture(t), path = 'tools/table-options/article-sales';
  const saved = { columns: ['date', 'personnel', 'actualMargin'], widths: { date: 180, personnel: 210, actualMargin: 220 } };
  assert.equal((await f.request(path, saved, { csrf: '' })).status, 403);
  assert.equal(f.stored.size, 0);
  assert.equal((await f.request(path, saved)).status, 200); assert.deepEqual(await (await f.request(path)).json(), saved);
  assert.notDeepEqual(await (await f.request(path, undefined, { employee: '43' })).json(), saved);
  for (const invalid of [{ columns: [] }, { columns: ['date', 'date'] }, { columns: ['foreignColumn'] },
    { columns: ['date'], widths: { date: 79 } }, { columns: ['date'], widths: { date: 801 } },
    { columns: ['date'], widths: { date: 150.5 } }, { columns: ['date'], widths: { foreignColumn: 150 } },
    { columns: ['date'], widths: [] }, { columns: ['date'], extra: true }]) {
    assert.equal((await f.request(path, invalid)).status, 400, JSON.stringify(invalid));
  }
  const limited = allRights.filter(permission => ![History.SALES_HISTORY_PERMISSIONS.SELLERS, History.SALES_HISTORY_PERMISSIONS.CUSTOMER_PURCHASES,
    Analytics.SALES_ANALYTICS_PERMISSIONS.MARGIN_READ, Article.SALES_ARTICLE_CATALOG_PERMISSIONS.COSTS_READ].includes(permission));
  f.state.principals['42'] = principal('42', limited);
  assert.deepEqual(await (await f.request(path)).json(), { columns: ['date'], widths: { date: 180 } });
  for (const hidden of ['personnel', 'customerNumber', 'customerName', 'listMargin', 'actualMargin', 'actualMarginPercent']) {
    assert.equal((await f.request(path, { columns: [hidden], widths: {} })).status, 400, hidden);
  }
  const allowed = await (await f.request(path)).json(); assert.ok(allowed.columns.length >= 1);
  f.stored.set('42:article_table_v1_article-sales', JSON.stringify({ columns: ['personnel'], widths: { personnel: 210 } }));
  const fallback = await (await f.request(path)).json();
  assert.ok(fallback.columns.length >= 1); assert.equal(fallback.columns.includes('personnel'), false);
  assert.equal(fallback.columns.includes('actualMargin'), false); assert.deepEqual(fallback.widths, {});
  assert.equal((await f.request(path + '?employeeNumber=43')).status, 422);
  assert.equal((await f.request('tools/table-options/unknown')).status, 403);
  f.state.principals['42'] = principal('42', basicRights);
  assert.equal((await f.request(path)).status, 403);
  assert.equal((await f.request('tools/table-options/article-movements')).status, 403);
  assert.equal((await f.request('tools/table-options/article-notes', { columns: ['text'], widths: { text: 420 } })).status, 200);
  assert.deepEqual(await (await f.request('tools/table-options/article-notes')).json(), { columns: ['text'], widths: { text: 420 } });
});

test('Article PDF rejects invalid selections, unapproved histories, forged contents and missing CSRF before loading data', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('sheet.pdf', pdfBody(), { csrf: '' })).status, 403);
  assert.equal(f.state.counts.catalog, 0);
  for (const invalid of [pdfBody({ sections: [] }), pdfBody({ sections: ['master', 'master'] }), pdfBody({ sections: ['unknown'] }),
    pdfBody({ includeImage: 'true' }), pdfBody({ articleNumber: 'unknown' }), pdfBody({ sections: ['master'], article: { description: 'CLIENT-FORGED' } }),
    pdfBody({ localNotes: { items: [{ text: 'CLIENT-FORGED-NOTE' }] } }), pdfBody({ imageBuffer: 'CLIENT-FORGED-IMAGE' }),
    pdfBody({ stamp: 'arbitrary' }), pdfBody({ movements: { dateFrom: '2026-09-01', rows: [{ label: 'FORGED-MOVEMENT' }] }, sections: ['movements'] })]) {
    const response = await f.request('sheet.pdf', invalid);
    assert.ok([400, 404, 422].includes(response.status), JSON.stringify(invalid) + ':' + response.status);
    assert.doesNotMatch(response.headers.get('content-type') || '', /application\/pdf/);
  }
  f.state.principals['42'] = principal('42', basicRights);
  assert.deepEqual(await (await f.request('tools/context')).json(), { sales: false, movements: false, write: false,today:'2026-10-03',sellers:false,salesLocations:[],movementLocations:[] });
  for (const section of ['sales', 'movements']) assert.equal((await f.request('sheet.pdf', pdfBody({ sections: [section] }))).status, 403);
  assert.equal(f.state.counts.sales, 0); assert.equal(f.state.counts.movements, 0);
  const result = await readPdf(await f.request('sheet.pdf', pdfBody({ sections: ['master', 'notes'] })));
  assert.match(result.text, /SERVER-TRUSTED-ARTICLE/); assert.match(result.text, /SERVER-TRUSTED-OWN-NOTE/);
  assert.doesNotMatch(result.text, /SERVER-SALE|SERVER-MOVEMENT/);
});

test('Article PDF uses only trusted server content, honors tabs/photo/filename and suppresses historical fields without grants', async t => {
  const f = await fixture(t);
  const master = await readPdf(await f.request('sheet.pdf', pdfBody()));
  assert.match(master.text, /SERVER-TRUSTED-MASTER/); assert.doesNotMatch(master.text, /SERVER-TRUSTED-OWN-NOTE|SERVER-TRUSTED-TRADE-NOTE|SERVER-SALE/);
  assert.equal(master.images, 0); assert.equal(f.state.counts.notes, 0); assert.equal(f.state.counts.images, 0);
  const response = await f.request('sheet.pdf', pdfBody({ sections: ['notes', 'sales', 'movements'], includeImage: true,
    name: 'Test:Artikel?.pdf', stamp: 'date-suffix', suffix: 'Fil18', position: 'after', separator: '_',
    sales: { dateFrom: '2026-09-01', dateTo: '2026-09-30' }, movements: { dateFrom: '2026-09-02', dateTo: '2026-09-29' } }));
  assert.match(response.headers.get('content-disposition') || '', /TestArtikel_\d{6}-Fil18\.pdf/);
  const full = await readPdf(response); assert.equal(full.images, 1);
  for (const marker of ['SERVER-TRUSTED-OWN-NOTE', 'SERVER-TRUSTED-TRADE-NOTE', 'SERVER-SALE', 'SERVER-MOVEMENT', 'SERVER-SELLER', 'SERVER-CUSTOMER', 'SERVER-DEVICE']) assert.match(full.text, new RegExp(marker));
  assert.match(full.pages.at(-1), /Abfragedauer - Umlagerungen: 1,23 s.*Verkäufe: 4,32 s/);
  assert.equal(f.state.requests.find(item => item.kind === 'sales').query.articleNumber, '001234');
  assert.equal(f.state.requests.find(item => item.kind === 'sales').query.dateFrom, '2026-09-01');
  assert.equal(f.state.requests.find(item => item.kind === 'movements').query.dateFrom, '2026-09-02');
  const limited = allRights.filter(permission => ![History.SALES_HISTORY_PERMISSIONS.SELLERS, History.SALES_HISTORY_PERMISSIONS.CUSTOMER_PURCHASES,
    Analytics.SALES_ANALYTICS_PERMISSIONS.MARGIN_READ, Article.SALES_ARTICLE_CATALOG_PERMISSIONS.COSTS_READ].includes(permission));
  f.state.principals['42'] = principal('42', limited);
  const safe = await readPdf(await f.request('sheet.pdf', pdfBody({ sections: ['sales'] })));
  assert.match(safe.text, /SERVER-SALE/); assert.match(safe.text, /1\.399,00/);
  assert.doesNotMatch(safe.text, /SERVER-SELLER|SERVER-CUSTOMER|CUSTOMER-NUMBER|55,12|4,73/);
});

test('Late grant or account/scope changes prevent PDF and preference responses from being delivered', async t => {
  const f = await fixture(t), original = f.state.principals['42'];
  f.state.notesHook = async () => { f.state.principals['42'] = principal('42', basicRights); };
  const revoked = await f.request('sheet.pdf', pdfBody({ sections: ['notes'] }));
  assert.equal(revoked.status, 403); assert.doesNotMatch(revoked.headers.get('content-type') || '', /application\/pdf/);
  assert.doesNotMatch(await revoked.text(), /SERVER-TRUSTED/);
  f.state.notesHook = null; f.state.principals['42'] = original;
  f.state.imageHook = async () => { f.state.principals['42'] = { ...original, accountId: 'other-account' }; };
  assert.equal((await f.request('sheet.pdf', pdfBody({ includeImage: true }))).status, 403);
  f.state.imageHook = null; f.state.principals['42'] = original;
  f.state.detailHook = async () => { f.state.principals['42'] = { ...original, scopes: [{ locationId: 'other-branch' }] }; };
  assert.equal((await f.request('sheet.pdf', pdfBody())).status, 403);
  f.state.detailHook = null; f.state.principals['42'] = original;
  f.state.preferencesHook = async () => { f.state.principals['42'] = { ...original, accountId: 'changed-account' }; };
  assert.equal((await f.request('tools/table-options/article-sales')).status, 403);
  f.state.principals['42'] = original;
  assert.equal((await f.request('tools/pdf-options')).status, 403);
});

test('Real local sessions without accountId or isEmployee can read preferences and article PDF', async t => {
  const f = await fixture(t);
  f.state.principals['42'] = { employeeNumber: 'local', sessionKind: 'local', localSystem: true,
    permissions: [...basicRights], scopes: [], mustChangePassword: false };
  assert.equal(Object.hasOwn(f.state.principals['42'], 'accountId'), false);
  assert.equal(Object.hasOwn(f.state.principals['42'], 'isEmployee'), false);
  assert.deepEqual(await (await f.request('tools/context')).json(), { sales: false, movements: false, write: false,today:'2026-10-03',sellers:false,salesLocations:[],movementLocations:[] });
  assert.equal((await f.request('tools/pdf-options')).status, 200);
  const saved = { columns: ['text'], widths: { text: 420 } };
  assert.equal((await f.request('tools/table-options/article-notes', saved)).status, 200);
  assert.deepEqual(await (await f.request('tools/table-options/article-notes')).json(), saved);
  assert.equal(f.stored.has('local:article_table_v1_article-notes'), true);
  const result = await readPdf(await f.request('sheet.pdf', pdfBody({ sections: ['master', 'notes'] })));
  assert.match(result.text, /SERVER-TRUSTED-MASTER/);
  assert.match(result.text, /SERVER-TRUSTED-OWN-NOTE/);
});

test('Required password changes fail closed before work and when introduced during PDF generation', async t => {
  const f = await fixture(t), original = principal();
  f.state.principals['42'] = { ...original, mustChangePassword: true };
  assert.equal((await f.request('tools/context')).status, 403);
  assert.equal((await f.request('sheet.pdf', pdfBody())).status, 403);
  assert.equal(f.state.counts.catalog, 0); assert.equal(f.state.counts.detail, 0);
  f.state.principals['42'] = original;
  f.state.detailHook = async () => { f.state.principals['42'] = { ...original, mustChangePassword: true }; };
  const changed = await f.request('sheet.pdf', pdfBody());
  assert.equal(changed.status, 403);
  assert.doesNotMatch(changed.headers.get('content-type') || '', /application\/pdf/);
  assert.doesNotMatch(await changed.text(), /SERVER-TRUSTED/);
  f.state.detailHook = null; f.state.principals['42'] = original;
  f.state.preferencesHook = async () => { f.state.principals['42'] = { ...original, mustChangePassword: true }; };
  assert.equal((await f.request('tools/pdf-options')).status, 403);
});

test('Fresh authorization compares the frozen initial identity even when sessions mutate in place', async t => {
  const f = await fixture(t); f.state.referenceSession = true;
  f.state.detailHook = async () => { f.state.principals['42'].accountId = 'other-account'; };
  assert.equal((await f.request('sheet.pdf', pdfBody())).status, 403);
  f.state.principals['42'] = principal();
  f.state.detailHook = async () => { f.state.principals['42'].permissions = [...basicRights]; };
  assert.equal((await f.request('sheet.pdf', pdfBody())).status, 403);
  f.state.principals['42'] = principal();
  f.state.detailHook = async () => { f.state.principals['42'].sessionKind = 'organization'; f.state.principals['42'].isEmployee = false; };
  const changedKind = await f.request('sheet.pdf', pdfBody());
  assert.equal(changedKind.status, 403); assert.doesNotMatch(await changedKind.text(), /SERVER-TRUSTED/);
  f.state.principals['42'] = principal();
  f.state.detailHook = async () => { f.state.principals['42'].mustChangePassword = true; };
  assert.equal((await f.request('sheet.pdf', pdfBody())).status, 403);
});

test('Article PDF history pages retain server identity and cap the export visibly; filenames/options persist per account', async t => {
  const f = await fixture(t), options = { stamp: 'date', position: 'after', separator: '_', suffix: '' };
  assert.equal((await f.request('tools/pdf-options', options, { csrf: '' })).status, 403);
  assert.equal((await f.request('tools/pdf-options', options)).status, 200);
  assert.deepEqual(await (await f.request('tools/pdf-options')).json(), options);
  assert.notDeepEqual(await (await f.request('tools/pdf-options', undefined, { employee: '43' })).json(), options);
  assert.equal((await f.request('tools/pdf-options', { ...options, position: 'middle' })).status, 400);
  f.state.movementHook = async (_session, query) => ({ available: true, next: query.cursor ? null : 'trusted-cursor', durationMs: 500,
    rows: Array.from({ length: 510 }, (_, index) => ({ id: (query.cursor ? 'B' : 'A') + index, date: '2026-09-19', articleNumber: query.articleNumber,
      quantity: '1', label: (query.cursor ? 'B-MOVE-' : 'A-MOVE-') + index, from: '0', to: '18', issueLabel: 'Keine Auffälligkeit' })) });
  const result = await readPdf(await f.request('sheet.pdf', pdfBody({ sections: ['movements'] })));
  assert.equal(f.state.counts.movements, 2); assert.deepEqual(f.state.requests.map(item => item.query.articleNumber), ['001234', '001234']);
  assert.equal(f.state.requests[1].query.cursor, 'trusted-cursor'); assert.match(result.text, /Auszug: 1000 Positionen/);
  assert.match(result.pages.at(-1), /Abfragedauer - Umlagerungen: 1 s/);
});

test('History context and article PDF retain submitted location/personnel filters and server-date defaults',async t=>{
 const f=await fixture(t),context=await(await f.request('tools/context')).json();
 assert.equal(context.today,'2026-10-03');assert.equal(context.sellers,true);assert.equal(context.salesLocations[0].id,'branch-a');
 const defaults=await readPdf(await f.request('sheet.pdf',pdfBody({sections:['sales','movements']})));
 assert.match(defaults.text,/03\.10\.2025.*03\.10\.2026/);
 assert.deepEqual(f.state.requests.find(r=>r.kind==='sales').query,{articleNumber:'001234',dateFrom:'2025-10-03',dateTo:'2026-10-03',locationId:'',personnel:'',limit:100,sort:'date',direction:'desc'});
 const movementDefault=f.state.requests.find(r=>r.kind==='movements').query;
 assert.equal((Date.parse(movementDefault.dateTo)-Date.parse(movementDefault.dateFrom))/86400000,89);
 f.state.requests=[];
 const result=await readPdf(await f.request('sheet.pdf',pdfBody({sections:['sales','movements'],
  sales:{dateFrom:'2026-09-01',dateTo:'2026-09-30',locationId:'branch-a',personnel:'007'},
  movements:{dateFrom:'2026-09-02',dateTo:'2026-09-29',fromLocationId:'trade-source:0',toLocationId:'branch-a'}})));
 assert.equal(f.state.requests.find(r=>r.kind==='sales').query.personnel,'007');assert.equal(f.state.requests.find(r=>r.kind==='sales').query.locationId,'branch-a');
 assert.equal(f.state.requests.find(r=>r.kind==='movements').query.fromLocationId,'trade-source:0');assert.equal(f.state.requests.find(r=>r.kind==='movements').query.toLocationId,'branch-a');
 assert.match(result.text,/Personalnummer: 007/);assert.match(result.text,/Von Filiale: 0.*Zentrallager/);assert.match(result.text,/Zu Filiale: 18.*Branch A/);
 f.state.principals['42'].permissions=f.state.principals['42'].permissions.filter(p=>p!==History.SALES_HISTORY_PERMISSIONS.SELLERS);
 const count=f.state.counts.sales;
 assert.equal((await f.request('sheet.pdf',pdfBody({sections:['sales'],sales:{personnel:'007'}}))).status,403);assert.equal(f.state.counts.sales,count);
});
