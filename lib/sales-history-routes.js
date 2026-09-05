"use strict";
const C = require('./data-import-contract');
const { SALES_HISTORY_PERMISSIONS: P, buildSalesHistoryProjection } = require('./sales-history-access');
function registerSalesHistoryRoutes(app, { requireSession, assertCsrf, getWorkspace = () => null, customerExists }) {
  if (typeof requireSession !== 'function' || typeof assertCsrf !== 'function' || typeof customerExists !== 'function') throw new TypeError('Sales history route composition required');
  const route = (purchase, work) => async (request, response) => {
    response.set({ 'Cache-Control': 'private, no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    try {
      const session = requireSession(request, P.READ), projection = buildSalesHistoryProjection(session);
      if (!projection.read || (purchase && !projection.customerPurchases)) C.fail('IMPORT_FORBIDDEN', 403);
      if (request.method !== 'GET') assertCsrf(request);
      const workspace = getWorkspace(session);
      if (request.method === 'GET') return response.json(workspace ? workspace.context() : { available: false, projection,
        sources: [], reason: 'not_activated', message: 'Die Einzelverkaufs- und Kassenhistorie ist vorbereitet. Eine geprüfte Datenquelle wurde noch nicht für den Produktivbetrieb freigegeben.' });
      if (!workspace) C.fail('IMPORT_HISTORY_NOT_ACTIVATED', 503);
      const customerId = purchase ? C.id(request.params.id) : null;
      if (purchase && !await customerExists(customerId, session)) C.fail('IMPORT_HISTORY_NOT_FOUND', 404);
      response.json(await work(workspace, request.body, customerId));
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      const code = typeof error?.code === 'string' && /^(IMPORT_|PORTAL_|CRM_)[A-Z0-9_]+$/u.test(error.code) ? error.code : 'IMPORT_OPERATION_FAILED';
      const message = status === 403 || status === 401 ? 'Für diese Ansicht fehlt eine persönliche Anmeldung oder Berechtigung.'
        : code === 'IMPORT_HISTORY_NOT_ACTIVATED' ? 'Die geprüfte Datenquelle ist noch nicht für den Produktivbetrieb freigegeben.'
          : code === 'IMPORT_HISTORY_RESULTS_CHANGED' ? 'Die Daten wurden inzwischen geändert. Bitte die Suche erneut starten.'
            : status >= 500 ? 'Die Verkaufsdaten konnten nicht sicher gelesen werden.' : 'Die Anfrage ist ungültig oder die angeforderten Daten sind nicht verfügbar.';
      response.status(status).json({ error: message, code });
    }
  };
  app.get('/api/sales-history/context', route(false));
  app.post('/api/sales-history/search', route(false, (workspace, body) => workspace.search(body)));
  app.post('/api/crm/customers/:id/purchases/search', route(true, (workspace, body, customerId) => workspace.search(body, { customerId })));
}
module.exports = { registerSalesHistoryRoutes };
