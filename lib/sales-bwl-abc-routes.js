'use strict';
const C = require('./data-import-contract');
const M = require('./sales-bwl-abc-model');
function registerSalesBwlAbcRoutes(app, { sessionFor, assertFresh, assertCsrf, privateHeaders, loadAbc, preferences, pdf = null }) {
  const route = work => async (request, response) => {
    response.set({ 'Cache-Control': 'private, no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (privateHeaders) privateHeaders(response);
    try {
      const original = await sessionFor(request), identity = M.authority(original).identity;
      if (request.method !== 'GET') assertCsrf(request);
      const fresh = async tx => {
        const session = await assertFresh(request, original, tx);
        if (M.authority(session).identity !== identity) C.fail('IMPORT_FORBIDDEN', 403);
        return session;
      };
      const session = await fresh(); const result = await work(fresh, request, session); await fresh();
      if (result?.buffer) {
        response.set({ 'Content-Type': 'application/pdf', 'X-PDF-Pages': String(result.pages), 'X-Report-Rows': String(result.rows),
          'Content-Disposition': `${request.path.endsWith('/pdf-preview') ? 'inline' : 'attachment'}; filename="ABC-Analyse.pdf"; filename*=UTF-8''${encodeURIComponent(result.name)}`,
          'Content-Security-Policy': "default-src 'none'; sandbox allow-downloads" }); response.send(result.buffer);
      } else response.json(result);
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      response.status(status).json({ code: status === 500 ? 'BWL_ABC_FAILED' : error.code,
        error: status === 403 ? 'Die persönliche Berechtigung fehlt oder wurde verändert.'
          : status === 409 ? 'Die Auswertung ist abgelaufen, wurde abgebrochen oder ihre Daten wurden verändert. Bitte neu starten.'
            : status === 503 ? 'Die geprüfte Kassenquelle ist noch nicht verfügbar.'
              : status === 413 ? 'Die Auswertung ist zu groß. Bitte Zeitraum oder Filialen einschränken.'
                : status === 422 ? 'Bitte Auswahl und Einstellungen prüfen.' : 'Die ABC-Auswertung konnte nicht verarbeitet werden.' });
    }
  };
  app.get('/api/sales/bwl/abc/context', route((fresh, request) => { C.exact(request.query, []); return loadAbc(fresh, 'context', {}); }));
  app.post('/api/sales/bwl/abc/step', route((fresh, request) => {
    C.exact(request.body, ['query', 'cursor']);
    if (request.body.cursor !== undefined && request.body.cursor !== null) C.text(request.body.cursor, 16384);
    return loadAbc(fresh, 'step', { query: request.body.query, cursor: request.body.cursor ?? null });
  }));
  app.post('/api/sales/bwl/abc/snapshot', route((fresh, request) => {
    C.exact(request.body, ['exportToken']); C.text(request.body.exportToken, 16384);
    return loadAbc(fresh, 'snapshot', { exportToken: request.body.exportToken });
  }));
  app.post('/api/sales/bwl/abc/cancel', route((fresh, request) => {
    C.exact(request.body, ['cursor']); C.text(request.body.cursor, 16384);
    return loadAbc(fresh, 'cancel', { cursor: request.body.cursor });
  }));
  app.get('/api/sales/bwl/preferences/abc', route((fresh, request) => { C.exact(request.query, []); return preferences.get(fresh); }));
  app.put('/api/sales/bwl/preferences/abc', route((fresh, request) => preferences.save(fresh, request.body)));
  if (pdf) {
    const exportPdf = route(async (fresh, request, session) => {
      C.exact(request.query, []); const spec = pdf.normalize(request.body, M.authority(session).projection);
      const snapshot = await loadAbc(fresh, 'snapshot', { exportToken: spec.exportToken }); await fresh();
      const result = await pdf.render({ spec, snapshot });
      // Revalidate the pinned source epoch after asynchronous PDF rendering too.
      await loadAbc(fresh, 'snapshot', { exportToken: spec.exportToken }); return result;
    });
    app.post('/api/sales/bwl/abc/pdf-preview', exportPdf); app.post('/api/sales/bwl/abc/pdf', exportPdf);
  }
}
module.exports = { registerSalesBwlAbcRoutes };
