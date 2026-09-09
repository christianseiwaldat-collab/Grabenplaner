'use strict';
const express = require('express');
const { normalizeSalesArticleNumber } = require('./sales-article-catalog');
const { MAX_INPUT_BYTES, SalesArticleImageError, prepareSalesArticleImage, fetchSalesArticleImage } = require('./sales-article-image');

function registerSalesArticleImageRoutes(app, { catalog, images, sessionFor, assertFresh, assertCsrf, privateHeaders, fetchImage = fetchSalesArticleImage }) {
  let active = 0;
  const owners = new Set();
  const fail = (message, code, status = 400) => { throw new SalesArticleImageError(message, code, status); };
  const route = handler => async (req, res, next) => {
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof SalesArticleImageError || error?.name === 'SalesArticleCatalogError') {
        res.status(error.status || 400).json({ error: error.message, code: error.code });
      } else next(error);
    }
  };
  async function context(req, res, write, number) {
    privateHeaders(res);
    const session = sessionFor(req, write);
    if (write) assertCsrf(req, session);
    const articleNumber = normalizeSalesArticleNumber(number);
    const article = await catalog.getByArticleNumber(articleNumber);
    if (!article) fail('Der Artikel wurde nicht gefunden.', 'SALES_ARTICLE_NOT_FOUND', 404);
    return { session, articleNumber, productId: article.productId };
  }
  function exact(value, keys) {
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !keys.includes(k))) {
      fail('Die Bildangaben sind ungültig.', 'ARTICLE_IMAGE_INPUT');
    }
  }
  function revision(value) {
    if (value !== null && (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value))) fail('Bitte die Artikelansicht neu laden.', 'ARTICLE_IMAGE_REVISION');
    return value;
  }
  async function save(req, res, ctx, expectedRevision, source) {
    const owner = String(ctx.session.accountId || ctx.session.employeeNumber || 'local');
    if (active >= 2 || owners.has(owner)) fail('Ein Bild wird bereits verarbeitet. Bitte kurz warten.', 'ARTICLE_IMAGE_BUSY', 429);
    // Check before starting a download and again atomically when saving.
    const prior = await images.metadata(ctx.articleNumber);
    if (prior.revision !== expectedRevision) fail('Das Artikelbild wurde zwischenzeitlich geändert. Bitte neu laden.', 'ARTICLE_IMAGE_CONFLICT', 409);
    if (active >= 2 || owners.has(owner)) fail('Ein Bild wird bereits verarbeitet. Bitte kurz warten.', 'ARTICLE_IMAGE_BUSY', 429);
    active += 1; owners.add(owner);
    try {
      const image = source ? await prepareSalesArticleImage(await source()) : null;
      if (req.aborted || res.destroyed) return;
      await assertFresh(req, ctx.session);
      const result = await images.save({ ...ctx, expectedRevision, image, actor: ctx.session.employeeNumber || 'local' });
      await assertFresh(req, ctx.session);
      res.json({ articleNumber: ctx.articleNumber, image: result });
    } finally { active -= 1; owners.delete(owner); }
  }
  app.get('/api/sales/articles/image', route(async (req, res) => {
    exact(req.query, ['articleNumber', 'v']);
    const ctx = await context(req, res, false, req.query.articleNumber);
    const image = await images.content(ctx.articleNumber);
    await assertFresh(req, ctx.session);
    if (!image) fail('Für diesen Artikel ist noch kein eigenes Bild gespeichert.', 'ARTICLE_IMAGE_NOT_FOUND', 404);
    res.set('Content-Type', 'image/webp'); res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('Content-Disposition', 'inline; filename="artikelbild.webp"');
    res.send(image.buffer);
  }));
  const authorizeUpload = (req, res, next) => {
    try { privateHeaders(res); const session = sessionFor(req, true); assertCsrf(req, session); next(); } catch (error) { next(error); }
  };
  app.put('/api/sales/articles/image', authorizeUpload,
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'], limit: MAX_INPUT_BYTES, inflate: false }),
    route(async (req, res) => {
      exact(req.query, ['articleNumber']);
      const ctx = await context(req, res, true, req.query.articleNumber);
      const value = req.get('X-Article-Image-Revision');
      const expectedRevision = revision(value === 'none' ? null : value);
      await save(req, res, ctx, expectedRevision, async () => req.body);
    }));
  app.post('/api/sales/articles/image/from-url', route(async (req, res) => {
    exact(req.body, ['articleNumber', 'expectedRevision', 'url']);
    const ctx = await context(req, res, true, req.body.articleNumber);
    await save(req, res, ctx, revision(req.body.expectedRevision), () => fetchImage(req.body.url));
  }));
  app.delete('/api/sales/articles/image', route(async (req, res) => {
    exact(req.body, ['articleNumber', 'expectedRevision']);
    const ctx = await context(req, res, true, req.body.articleNumber);
    await save(req, res, ctx, revision(req.body.expectedRevision), null);
  }));
}
module.exports = { registerSalesArticleImageRoutes };
