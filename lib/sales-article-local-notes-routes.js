'use strict';

const { normalizeSalesArticleNumber } = require('./sales-article-catalog');
const { SalesArticleLocalNotesError, exact } = require('./sales-article-local-notes');

function registerSalesArticleLocalNotesRoutes(app, { catalog, notes, sessionFor, assertFresh, assertCsrf, privateHeaders }) {
  const route = handler => async (req, res, next) => {
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof SalesArticleLocalNotesError || error?.name === 'SalesArticleCatalogError') {
        res.status(error.status || 400).json({ error: error.message, code: error.code });
      } else next(error);
    }
  };
  async function context(req, res, write, number) {
    privateHeaders(res);
    const session = sessionFor(req, write);
    if (write) assertCsrf(req, session);
    const articleNumber = normalizeSalesArticleNumber(number);
    await assertFresh(req, session);
    const article = await catalog.getByArticleNumber(articleNumber);
    if (!article) throw new SalesArticleLocalNotesError('Der Artikel wurde nicht gefunden.', 'SALES_ARTICLE_NOT_FOUND', 404);
    return { session, articleNumber };
  }
  app.get('/api/sales/articles/local-notes', route(async (req, res) => {
    exact(req.query, ['articleNumber']);
    const ctx = await context(req, res, false, req.query.articleNumber), result = await notes.list(ctx.articleNumber);
    await assertFresh(req, ctx.session);
    res.json(result);
  }));
  app.post('/api/sales/articles/local-notes', route(async (req, res) => {
    exact(req.query, []);
    exact(req.body, ['articleNumber', 'text', 'expectedRevision', 'mutationId']);
    const ctx = await context(req, res, true, req.body.articleNumber);
    const fresh = async () => {
      if (req.aborted || res.destroyed) throw new SalesArticleLocalNotesError('Die Anfrage wurde abgebrochen.', 'ARTICLE_NOTES_ABORTED', 409);
      await assertFresh(req, ctx.session);
    };
    const result = await notes.add({ ...req.body, articleNumber: ctx.articleNumber,
      actor: String(ctx.session.employeeNumber || 'local') }, { assertFresh: fresh });
    await fresh();
    res.status(201).json(result);
  }));
}
module.exports = { registerSalesArticleLocalNotesRoutes };
