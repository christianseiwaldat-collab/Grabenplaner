'use strict';
const C = require('./data-import-contract');
const { SALES_HISTORY_PERMISSIONS: P, buildSalesHistoryProjection } = require('./sales-history-access');
function registerSalesReportJobRoutes(app, { jobs, requireSession, refreshSession, assertCsrf }) {
  const route = (work, download = false) => async (request, response) => {
    response.set({ 'Cache-Control': 'private, no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    try {
      const original = requireSession(request, P.READ);
      if (request.method !== 'GET') assertCsrf(request);
      const fresh = async () => {
        const session = await refreshSession(request);
        if (!session || session.employeeNumber !== original.employeeNumber || session.accountId !== original.accountId || !buildSalesHistoryProjection(session).read) C.fail('IMPORT_FORBIDDEN', 403);
        return session;
      };
      const session = await fresh(), signature = C.canonical(buildSalesHistoryProjection(session));
      const result = await work(session, request);
      if (C.canonical(buildSalesHistoryProjection(await fresh())) !== signature) C.fail('IMPORT_FORBIDDEN', 403);
      if (download) {
        response.set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'attachment; filename="Umsatzauswertung.html"', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
        response.send(result);
      } else response.json(result ?? { ok: true });
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      response.status(status).json({ error: status === 403 ? 'Die persönliche Berechtigung für diesen Bericht fehlt oder wurde verändert.'
        : status === 409 ? 'Der Auftrag wurde geändert oder die Warteschlange ist voll. Bitte aktualisieren; abgeschlossene Berichte können entfernt werden.'
          : status === 503 ? 'Die geprüfte Datenquelle ist noch nicht verfügbar.' : 'Der Bericht konnte nicht verarbeitet werden.',
        code: status === 500 ? 'IMPORT_REPORT_FAILED' : error.code });
    }
  };
  app.get('/api/sales-report-jobs', route(session => jobs.list(session)));
  app.post('/api/sales-report-jobs', route((session, request) => jobs.create(session, request.body)));
  app.post('/api/sales-report-jobs/:id/cancel', route((session, request) => jobs.cancel(session, request.params.id)));
  app.delete('/api/sales-report-jobs/:id', route((session, request) => jobs.remove(session, request.params.id)));
  app.get('/api/sales-report-jobs/:id/download', route((session, request) => jobs.download(session, request.params.id), true));
}
module.exports = { registerSalesReportJobRoutes };
