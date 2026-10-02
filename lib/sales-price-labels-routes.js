'use strict';

const C = require('./data-import-contract');
const { normalizeSalesArticleNumber, normalizeDecimal12 } = require('./sales-article-catalog');
const { buildSalesArticleCatalogProjection } = require('./sales-article-catalog-access');
const Export = require('../public/trade-export-options');
const { resolveTemplateSessionContext, SalesPriceLabelTemplateError } = require('./sales-price-label-template-store');
const PRICE_TYPES = ['sales', 'internet_1', 'internet_3'];
const PREFERENCE = 'sales_price_labels_v1';

function normalizeSelection(input) {
  if (!Array.isArray(input) || !input.length || input.length > 100) C.fail('PRICE_LABEL_SELECTION', 400);
  const numbers = input.map(normalizeSalesArticleNumber);
  if (new Set(numbers).size !== numbers.length) C.fail('PRICE_LABEL_SELECTION', 400);
  return numbers;
}

function currentGrossPrice(article, data, priceType) {
  const matrix = data.priceMatrix?.sales?.find(price => price.id === priceType)?.gross;
  if (!matrix || matrix.sourceValue || matrix.currency && matrix.currency !== 'EUR') return null;
  const amount = value => {
    if (typeof value !== 'string' || value.startsWith('-')) return null;
    try { const normalized = normalizeDecimal12(value); return normalized?.startsWith('-') ? null : normalized; } catch { return null; }
  };
  const matrixAmount = amount(matrix.amount);
  if (matrixAmount === null) return null;
  // getByArticleNumber hydrates only the current revision's prices. The matrix
  // can also select by a source-field label, so its "gross" name alone does not
  // prove the persisted price basis or price type. Require one matching source.
  const current = Array.isArray(article.prices) ? article.prices : data.prices?.sales;
  const candidates = (Array.isArray(current) ? current : []).filter(price => price.priceType === priceType
    && price.priceBasis === 'gross' && price.currency === 'EUR'
    && ['confirmed', 'inferred'].includes(price.qualityStatus) && price.usable !== false
    && amount(price.amount) !== null);
  return candidates.length === 1 && amount(candidates[0].amount) === matrixAmount ? matrix.amount : null;
}

function registerSalesPriceLabelsRoutes(app, { catalog, preferences, sessionFor, assertFresh,
  refreshSession, assertCsrf, privateHeaders, loadDetail, images, templateStore, listBranchAccounts, getEmployeeHomeLocation, branding }) {
  const Pdf = require('./sales-price-labels-pdf');
  const route = (handler, pdf = false, image = false) => async (req, res, next) => {
    try {
      privateHeaders(res);
      const session = sessionFor(req, false);
      if (!session || session.mustChangePassword || !buildSalesArticleCatalogProjection(session).pricesRead) C.fail('IMPORT_FORBIDDEN', 403);
      if (req.method !== 'GET') assertCsrf(req, session);
      const signature = s => C.canonical([s.employeeNumber || '', s.accountId || null, s.permissions || [], s.scopes || [], s.sessionKind || '', s.isEmployee ?? null, s.accountType || '', s.homeLocationId || '']);
      const initialSignature = signature(session);
      const fresh = async () => {
        await assertFresh(req, session);
        const current = refreshSession ? await refreshSession(req, session) : session;
        if (!current || current.mustChangePassword || !buildSalesArticleCatalogProjection(current).pricesRead
          || signature(current) !== initialSignature) C.fail('IMPORT_FORBIDDEN', 403);
      };
      await fresh();
      const result = await handler(req, session, fresh);
      await fresh();
      if (pdf) {
        res.set('Content-Security-Policy', "default-src 'none'; sandbox allow-downloads")
          .type('application/pdf').attachment(result.filename);
        if (result.utf8Filename) {
          // Keep Unicode out of the legacy Latin-1 header parameter. Browsers
          // can safely recover the actual name from the RFC 5987 UTF-8 value.
          const encoded = encodeURIComponent(Buffer.from(result.filename, 'utf8').toString('utf8'))
            .replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
          res.set('Content-Disposition', `attachment; filename="Preisschild.pdf"; filename*=UTF-8''${encoded}`);
        }
        res.send(result.buffer);
      }
      else if (image) res.set({ 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline; filename="artikelbild.webp"' }).send(result.buffer);
      else res.json(result);
    } catch (error) {
      if (error.status >= 400 && error.status < 600 || error instanceof TypeError
        || error.name === 'SalesArticleCatalogError' || error instanceof SalesPriceLabelTemplateError) {
        const messages = { PRICE_LABEL_SELECTION: 'Bitte 1 bis 100 unterschiedliche Artikelnummern auswählen.',
          PRICE_LABEL_PRICE_TYPE: 'Bitte EH, Internet oder UCW als Preisart auswählen.',
          PRICE_LABEL_FILENAME: 'Bitte einen Dateinamen mit höchstens 110 Zeichen eingeben.' };
        const message = error.status === 403 ? 'Für Preisschilder fehlt die persönliche Freigabe zum Lesen der Verkaufspreise.'
          : messages[error.code] ||
          (String(error.code || '').startsWith('PRICE_LABEL_') ? error.message
          : error.status === 404 ? 'Ein ausgewählter Artikel wurde nicht gefunden.'
          : 'Bitte Artikelnummern und Exportoptionen prüfen.');
        res.status(error.status || 400).json({ code: error.code || 'PRICE_LABEL_INPUT', error: message });
      } else next(error);
    }
  };
  const protectedDefaultSession = session => session.sessionKind === 'organization' || session.isEmployee === false
    || session.localSystem === true || session.sessionKind === 'local';
  async function libraryAccess(session, fresh) {
    if (!templateStore) throw new SalesPriceLabelTemplateError('Die Vorlagenbibliothek ist noch nicht verfügbar.', 'PRICE_LABEL_LIBRARY_UNAVAILABLE', 503);
    await fresh();
    const context = await resolveTemplateSessionContext(session, { listBranchAccounts, getEmployeeHomeLocation });
    const signature = C.canonical(context);
    const contextFresh = async () => {
      await fresh();
      const current = await resolveTemplateSessionContext(session, { listBranchAccounts, getEmployeeHomeLocation });
      if (C.canonical(current) !== signature) C.fail('IMPORT_FORBIDDEN', 403);
      await fresh();
    };
    await contextFresh(); return { context, contextFresh };
  }
  app.get('/api/sales/price-labels/library', route(async (req, session, fresh) => {
    C.exact(req.query, []); const { context, contextFresh } = await libraryAccess(session, fresh);
    const result = await templateStore.list(context); await contextFresh(); return result;
  }));
  app.get('/api/sales/price-labels/library/:id', route(async (req, session, fresh) => {
    C.exact(req.query, []); const { context, contextFresh } = await libraryAccess(session, fresh);
    const result = await templateStore.get(context, req.params.id); await contextFresh(); return result;
  }));
  app.post('/api/sales/price-labels/library', route(async (req, session, fresh) => {
    C.exact(req.query, []); const { context, contextFresh } = await libraryAccess(session, fresh);
    const result = await templateStore.create(context, req.body, { assertFresh: contextFresh }); await contextFresh(); return result;
  }));
  app.patch('/api/sales/price-labels/library/:id', route(async (req, session, fresh) => {
    C.exact(req.query, []); const { context, contextFresh } = await libraryAccess(session, fresh);
    const result = await templateStore.update(context, req.params.id, req.body, { assertFresh: contextFresh }); await contextFresh(); return result;
  }));
  app.get('/api/sales/price-labels/branding', route(async (req) => {
    C.exact(req.query, []);
    if (!branding?.list) throw new SalesPriceLabelTemplateError('Die Drucklogos sind noch nicht verfügbar.', 'PRICE_LABEL_BRANDING_UNAVAILABLE', 503);
    return branding.list();
  }));
  app.get('/api/sales/price-labels/image', route(async (req, _session, fresh) => {
    C.exact(req.query, ['articleNumber']); const number = normalizeSalesArticleNumber(req.query.articleNumber);
    if (!await catalog.getByArticleNumber(number)) C.fail('IMPORT_NOT_FOUND', 404);
    await fresh(); const image = await images.content(number);
    if (!image) throw new SalesPriceLabelTemplateError('Für diesen Artikel ist kein Foto gespeichert.', 'PRICE_LABEL_IMAGE_NOT_FOUND', 404);
    if (!Buffer.isBuffer(image.buffer) || !image.buffer.length || image.buffer.length > 50 * 1024
      || image.mime && image.mime !== 'image/webp') throw new SalesPriceLabelTemplateError('Das Artikelfoto konnte nicht sicher gelesen werden.', 'PRICE_LABEL_IMAGE_INTEGRITY', 503);
    return image;
  }, false, true));
  const selected = body => {
    const numbers = normalizeSelection(body.articleNumbers);
    const type = body.priceType || 'sales';
    if (!PRICE_TYPES.includes(type)) C.fail('PRICE_LABEL_PRICE_TYPE', 400);
    return { numbers, type };
  };
  async function items(session, selection, fresh, photo = false) {
    const rows = [];
    for (const number of selection.numbers) {
      await fresh();
      const article = await catalog.getByArticleNumber(number);
      if (!article) C.fail('IMPORT_NOT_FOUND', 404);
      const detail = await loadDetail(article, session), data = detail.article;
      const item = {
        articleNumber: number, description: data.description,
        brand: data.sourceSections?.flatMap(s => s.fields || []).find(f => f.id === 'Marke')?.value || '',
        priceGross: currentGrossPrice(article, data, selection.type),
        taxRate: data.priceMatrix?.vatPercent ?? null,
        ean: data.identifiers?.find(i => i.isPrimary)?.identifierValue || data.identifiers?.[0]?.identifierValue || '',
        imageUrl: data.image?.present ? '/api/sales/price-labels/image?articleNumber=' + encodeURIComponent(number) : null,
      };
      if (photo && item.imageUrl) item.imageBuffer = (await images.content(number))?.buffer || null;
      rows.push(item);
    }
    return rows;
  }
  app.get('/api/sales/price-labels/templates', route(async (req, session, fresh) => {
    C.exact(req.query, []);
    if (protectedDefaultSession(session)) {
      const { context, contextFresh } = await libraryAccess(session, fresh);
      const result = await templateStore.getDefault(context); await contextFresh(); return result;
    }
    const stored = await preferences.get(session.employeeNumber, PREFERENCE);
    try {
      const value = JSON.parse(stored?.value || '{}');
      return { options: Pdf.normalizeOptions(value.options || {}), filenameOptions: Export.options(value.filenameOptions || {}) };
    } catch { return { options: Pdf.normalizeOptions({}), filenameOptions: { ...Export.defaults } }; }
  }));
  app.post('/api/sales/price-labels/templates', route(async (req, session, fresh) => {
    C.exact(req.query, []); C.exact(req.body, ['options', 'filenameOptions']);
    const result = { options: Pdf.normalizeOptions(req.body.options), filenameOptions: Export.options(req.body.filenameOptions) };
    if (protectedDefaultSession(session)) {
      const { context, contextFresh } = await libraryAccess(session, fresh);
      const saved = await templateStore.setDefault(context, result, { assertFresh: contextFresh }); await contextFresh(); return saved;
    }
    await preferences.upsert(session.employeeNumber, PREFERENCE, JSON.stringify(result));
    return result;
  }));
  app.post('/api/sales/price-labels/articles', route(async (req, session, fresh) => {
    C.exact(req.query, []); C.exact(req.body, ['articleNumbers', 'priceType']);
    return { items: await items(session, selected(req.body), fresh), updatedAt: new Date().toISOString(),
      note: 'Aktuelle freigegebene Brutto-Verkaufspreise aus dem Artikelstamm. Fehlende oder unklare Preise werden als „Preis prüfen“ angezeigt.' };
  }));
  async function exportSelection(session, selection, options, name, filenames, fresh) {
    const content = await items(session, selection, fresh, options.showPhoto);
    await fresh();
    const logoBuffer = options.logoKitId ? await branding?.content(options) : null;
    if (options.logoKitId && !logoBuffer) throw new SalesPriceLabelTemplateError('Das gewählte Drucklogo ist nicht verfügbar.', 'PRICE_LABEL_BRANDING_UNAVAILABLE', 503);
    await fresh();
    return { filename: Export.filename(name, filenames),
      buffer: await Pdf.createSalesPriceLabelsPdf({ items: content, options, logoBuffer }) };
  }
  app.post('/api/sales/price-labels/library/:id/article.pdf', route(async (req, session, fresh) => {
    C.exact(req.query, []); C.exact(req.body, ['articleNumber']);
    const articleNumber = normalizeSalesArticleNumber(req.body.articleNumber);
    const { context, contextFresh } = await libraryAccess(session, fresh);
    const template = await templateStore.get(context, req.params.id);
    const templateFresh = async () => {
      await contextFresh();
      const current = await templateStore.get(context, req.params.id);
      if (current.version !== template.version) throw new SalesPriceLabelTemplateError('Die Vorlage wurde inzwischen geändert. Bitte neu laden.', 'PRICE_LABEL_LIBRARY_CONFLICT', 409);
      await contextFresh();
    };
    const result = await exportSelection(session, { numbers: [articleNumber], type: 'sales' },
      Pdf.normalizeOptions(template.options), template.title + '-' + articleNumber,
      Export.options(template.filenameOptions), templateFresh);
    await templateFresh(); return { ...result, utf8Filename: true };
  }, true));
  app.post('/api/sales/price-labels/export.pdf', route(async (req, session, fresh) => {
    C.exact(req.query, []);
    C.exact(req.body, ['articleNumbers', 'priceType', 'options', 'name', 'stamp', 'position', 'separator', 'suffix']);
    const body = req.body, selection = selected(body), options = Pdf.normalizeOptions(body.options);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 110) C.fail('PRICE_LABEL_FILENAME', 400);
    const filenames = Export.options(Object.fromEntries(['stamp', 'position', 'separator', 'suffix']
      .filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]])));
    return exportSelection(session, selection, options, body.name, filenames, fresh);
  }, true));
}

module.exports = { registerSalesPriceLabelsRoutes, normalizeSelection };
