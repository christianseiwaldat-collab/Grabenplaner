'use strict';

const C = require('./data-import-contract');
const { normalizeSalesArticleNumber, normalizeDecimal12 } = require('./sales-article-catalog');
const { buildSalesArticleCatalogProjection } = require('./sales-article-catalog-access');
const Export = require('../public/trade-export-options');
const { resolveTemplateSessionContext, SalesPriceLabelTemplateError } = require('./sales-price-label-template-store');
const { readImageUpload, imageIds } = require('./sales-price-label-image-store');
const { SECRET_PREFIX } = require('./integration-secret-vault');
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
  refreshSession, assertCsrf, privateHeaders, loadDetail, images, templateStore, listBranchAccounts, getEmployeeHomeLocation, branding,
  imageStore, draftVault, draftStore, projectStore, withImageWrite, defaultBranding }) {
  const Pdf = require('./sales-price-labels-pdf');
  const route = (handler, pdf = false, image = false) => async (req, res, next) => {
    try {
      privateHeaders(res);
      const session = sessionFor(req, false);
      if (!session || session.mustChangePassword || !buildSalesArticleCatalogProjection(session).pricesRead) C.fail('IMPORT_FORBIDDEN', 403);
      if (req.method !== 'GET') assertCsrf(req, session);
      const signature = s => C.canonical([s.employeeNumber || '', s.accountId || null, s.role || '', s.permissions || [], s.scopes || [], s.sessionKind || '', s.isEmployee ?? null, s.accountType || '', s.homeLocationId || '']);
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
      else if (image) res.set({ 'Content-Type': image === 'png' ? 'image/png' : 'image/webp', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': image === 'png' ? 'inline; filename="Preisschild-Bild.png"' : 'inline; filename="artikelbild.webp"' }).send(result.buffer);
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
  const requireImages = () => { if (!imageStore) throw new SalesPriceLabelTemplateError('Die geschützte Bildablage ist noch nicht verfügbar.', 'PRICE_LABEL_IMAGE_STORAGE', 503); return imageStore; };
  const draftContext = session => ({ namespace: 'sales-price-labels', connectorId: 'employee:' + session.employeeNumber, field: PREFERENCE, purpose: 'personal-layout' });
  async function readDraft(value, session) {
    if (!String(value || '').startsWith(SECRET_PREFIX)) return JSON.parse(value || '{}');
    try {
      if (!draftVault?.useSecret) throw new Error();
      let result; await draftVault.useSecret(value, draftContext(session), bytes => { result = JSON.parse(bytes.toString('utf8')); }); return result;
    } catch { throw new SalesPriceLabelTemplateError('Der geschützte Arbeitsentwurf konnte nicht gelesen werden.', 'PRICE_LABEL_DRAFT_INTEGRITY', 503); }
  }
  async function validateImages(session, options, fresh) {
    if (!imageIds(options).length) return;
    const { context, contextFresh } = await libraryAccess(session, fresh);
    await requireImages().validateOptions(context, options, { assertFresh: contextFresh }); await contextFresh();
  }
  const requireDrafts = () => { if (!draftStore) throw new SalesPriceLabelTemplateError('Die Arbeitsentwurfsablage ist noch nicht verfügbar.', 'PRICE_LABEL_DRAFT_UNAVAILABLE', 503); return draftStore; };
  app.get('/api/sales/price-labels/draft', route(async (req, session, fresh) => {
    C.exact(req.query, []); const { context, contextFresh } = await libraryAccess(session, fresh);
    const result = await requireDrafts().get(context, { assertFresh: contextFresh }); await contextFresh(); return result;
  }));
  app.put('/api/sales/price-labels/draft', route(async (req, session, fresh) => {
    C.exact(req.query, []); const { context, contextFresh } = await libraryAccess(session, fresh);
    const result = await requireDrafts().save(context, req.body, { assertFresh: contextFresh }); await contextFresh(); return result;
  }));
  app.get('/api/sales/price-labels/search/preferences',route(async(req,session,fresh)=>{C.exact(req.query,[]);const{context,contextFresh}=await libraryAccess(session,fresh);const result=await requireDrafts().getSearchPreferences(context,{assertFresh:contextFresh});await contextFresh();return result;}));
  app.put('/api/sales/price-labels/search/preferences',route(async(req,session,fresh)=>{C.exact(req.query,[]);const{context,contextFresh}=await libraryAccess(session,fresh);const result=await requireDrafts().saveSearchPreferences(context,req.body,{assertFresh:contextFresh});await contextFresh();return result;}));
  app.get('/api/sales/price-labels/images', route(async (req, session, fresh) => {
    C.exact(req.query, []); const { context, contextFresh } = await libraryAccess(session, fresh);
    const images = await requireImages().listOwned(context, { assertFresh: contextFresh }); await contextFresh(); return { images };
  }));
  const requireProjects=()=>{if(!projectStore)throw new SalesPriceLabelTemplateError('Die Projektablage ist noch nicht verfügbar.','PRICE_LABEL_PROJECT_UNAVAILABLE',503);return projectStore;};
  app.get('/api/sales/price-labels/projects',route(async(req,session,fresh)=>{C.exact(req.query,[]);const{context,contextFresh}=await libraryAccess(session,fresh);const result=await requireProjects().list(context,{assertFresh:contextFresh});await contextFresh();return result;}));
  app.get('/api/sales/price-labels/projects/:id',route(async(req,session,fresh)=>{C.exact(req.query,[]);const{context,contextFresh}=await libraryAccess(session,fresh);const result=await requireProjects().get(context,req.params.id,{assertFresh:contextFresh});await contextFresh();return result;}));
  app.post('/api/sales/price-labels/projects',route(async(req,session,fresh)=>{C.exact(req.query,[]);const{context,contextFresh}=await libraryAccess(session,fresh);const result=await requireProjects().create(context,req.body,{assertFresh:contextFresh});await contextFresh();return result;}));
  app.patch('/api/sales/price-labels/projects/:id',route(async(req,session,fresh)=>{C.exact(req.query,[]);const{context,contextFresh}=await libraryAccess(session,fresh);const result=await requireProjects().update(context,req.params.id,req.body,{assertFresh:contextFresh});await contextFresh();return result;}));
  app.delete('/api/sales/price-labels/projects/:id',route(async(req,session,fresh)=>{C.exact(req.query,[]);const{context,contextFresh}=await libraryAccess(session,fresh);const result=await requireProjects().remove(context,req.params.id,req.body,{assertFresh:contextFresh});await contextFresh();return result;}));
  app.post('/api/sales/price-labels/images', route(async (req, session, fresh) => {
    C.exact(req.query, []); requireImages();
    if (typeof withImageWrite !== 'function') throw new SalesPriceLabelTemplateError('Die geschützte Bildablage ist noch nicht verfügbar.', 'PRICE_LABEL_IMAGE_STORAGE', 503);
    const { context, contextFresh } = await libraryAccess(session, fresh), buffer = await readImageUpload(req);
    await contextFresh();
    const uploadId = req.get('X-Price-Label-Upload-Id');
    const image = await withImageWrite(() => imageStore.create(context, buffer, { assertFresh: contextFresh, ...(uploadId ? { uploadId } : {}) }));
    await contextFresh(); return { image };
  }));
  app.get('/api/sales/price-labels/images/:id', route(async (req, session, fresh) => {
    // This bounded display nonce only separates browser image caches across
    // account/draft contexts. Every request still performs current authorization.
    C.exact(req.query, ['preview']);
    if (req.query.preview !== undefined && (typeof req.query.preview !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,79}$/.test(req.query.preview))) C.fail('PRICE_LABEL_IMAGE_PREVIEW', 400);
    const { context, contextFresh } = await libraryAccess(session, fresh);
    return requireImages().content(context, req.params.id, { assertFresh: contextFresh });
  }, false, 'png'));
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
  app.get('/api/sales/price-labels/branding', route(async (req,session,fresh) => {
    C.exact(req.query, []);
    if (!branding?.list) throw new SalesPriceLabelTemplateError('Die Drucklogos sind noch nicht verfügbar.', 'PRICE_LABEL_BRANDING_UNAVAILABLE', 503);
    const result=await branding.list(),candidate=typeof defaultBranding==='function'?await defaultBranding(session):null;await fresh();
    const defaultLogo=candidate&&result.kits?.some(kit=>kit.id===candidate.logoKitId&&kit.logos?.some(logo=>logo.key===candidate.logoAssetKey))?{logoKitId:candidate.logoKitId,logoAssetKey:candidate.logoAssetKey}:null;
    return {...result,defaultLogo};
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
      const result = await templateStore.getDefault(context),hasSavedDefaults=templateStore.hasDefault?await templateStore.hasDefault(context):true; await contextFresh(); return {...result,hasSavedDefaults};
    }
    const stored = await preferences.get(session.employeeNumber, PREFERENCE);
    try {
      const value = await readDraft(stored?.value, session);
      const result = { options: Pdf.normalizeOptions(value.options || {}), filenameOptions: Export.options(value.filenameOptions || {}),hasSavedDefaults:Boolean(stored?.value) };
      await validateImages(session, result.options, fresh); return result;
    } catch (error) { if (error instanceof SalesPriceLabelTemplateError || error.status === 403) throw error;
      return { options: Pdf.normalizeOptions({}), filenameOptions: { ...Export.defaults },hasSavedDefaults:false }; }
  }));
  app.post('/api/sales/price-labels/templates', route(async (req, session, fresh) => {
    C.exact(req.query, []); C.exact(req.body, ['options', 'filenameOptions']);
    const result = { options: Pdf.normalizeOptions(req.body.options), filenameOptions: Export.options(req.body.filenameOptions) };
    await validateImages(session, result.options, fresh);
    if (protectedDefaultSession(session)) {
      const { context, contextFresh } = await libraryAccess(session, fresh);
      const saved = await templateStore.setDefault(context, result, { assertFresh: contextFresh }); await contextFresh(); return saved;
    }
    if (!draftVault?.seal) throw new SalesPriceLabelTemplateError('Der geschützte Arbeitsentwurf ist noch nicht verfügbar.', 'PRICE_LABEL_DRAFT_UNAVAILABLE', 503);
    const encrypted = draftVault.seal(JSON.stringify(result), draftContext(session));
    await fresh(); await preferences.upsert(session.employeeNumber, PREFERENCE, encrypted);
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
    let imageBuffers;
    if (imageIds(options).length) {
      const { context, contextFresh } = await libraryAccess(session, fresh);
      imageBuffers = await requireImages().resolve(context, options, { assertFresh: contextFresh }); await contextFresh();
    }
    return { filename: Export.filename(name, filenames),
      buffer: await Pdf.createSalesPriceLabelsPdf({ items: content, options, logoBuffer, imageBuffers }) };
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
  app.post('/api/sales/price-labels/projects/export.pdf',route(async(req,session,fresh)=>{
    C.exact(req.query,[]);C.exact(req.body,['project','name']);
    const Model=require('../public/sales-price-label-project'),Ui=require('../public/sales-price-labels'),project=Model.normalize(req.body.project,Ui.normalizeOptions);
    if(!project.labels.length||typeof req.body.name!=='string'||!req.body.name.trim()||req.body.name.length>110)C.fail('PRICE_LABEL_FILENAME',400);
    Model.paperLayout(project);const{context,contextFresh}=await libraryAccess(session,fresh),loaded=new Map(),imageBuffers=new Map(),instances=[],designs=[];
    for(const label of project.labels){await contextFresh();const options=Pdf.normalizeOptions(label.options),key=label.priceType+':'+label.articleNumber;designs.push(options);
      if(!loaded.has(key))loaded.set(key,(await items(session,{numbers:[label.articleNumber],type:label.priceType},contextFresh,options.showPhoto))[0]);
      let item=loaded.get(key);if(options.showPhoto&&item.imageUrl&&!item.imageBuffer)item={...item,imageBuffer:(await images.content(label.articleNumber))?.buffer||null};
      const logoBuffer=options.logoKitId?await branding?.content(options):null;if(options.logoKitId&&!logoBuffer)throw new SalesPriceLabelTemplateError('Ein gewähltes Drucklogo ist nicht verfügbar.','PRICE_LABEL_BRANDING_UNAVAILABLE',503);
      if(imageIds(options).length)for(const[asset,bytes]of await requireImages().resolve(context,options,{assertFresh:contextFresh}))imageBuffers.set(asset,bytes);
      instances.push({id:label.id,item,options,logoBuffer});
    }
    await contextFresh();const buffer=await Pdf.createSalesPriceLabelsPdf({instances,options:instances[0].options,imageBuffers});
    for(const options of designs)if(imageIds(options).length)await requireImages().validateOptions(context,options,{assertFresh:contextFresh});await contextFresh();
    return{buffer,filename:Export.filename(req.body.name,Export.options(project.filenameOptions))};
  },true));
}

module.exports = { registerSalesPriceLabelsRoutes, normalizeSelection };
