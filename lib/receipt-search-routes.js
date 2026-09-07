'use strict';
const C = require('./data-import-contract');
const M = require('./receipt-search');
const { SALES_HISTORY_PERMISSIONS: P, buildSalesHistoryProjection } = require('./sales-history-access');
const { createReceiptInfoPdf } = require('./receipt-info-pdf');
function registerReceiptSearchRoutes(app, { runtime, requireSession, refreshSession, assertCsrf, preferences }) {
  const route = (work, pdf = false) => async (request, response) => {
    response.set({ 'Cache-Control': 'private, no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    try {
      const session = requireSession(request, P.READ), projection = buildSalesHistoryProjection(session);
      if (!projection.read) C.fail('IMPORT_FORBIDDEN', 403);
      if (request.method !== 'GET') assertCsrf(request);
      const getSession = async () => {
        const current = await refreshSession(request);
        if (!current || current.employeeNumber !== session.employeeNumber || current.accountId !== session.accountId) C.fail('IMPORT_FORBIDDEN', 403);
        return current;
      };
      const result = await runtime.run(getSession, workspace => work({ workspace, session, projection, request }));
      if (pdf) response.type('application/pdf').attachment('Beleginformation-keine-Rechnung.pdf').send(result);
      else response.json(result);
    } catch (error) {
      const code = typeof error?.code === 'string' && /^(IMPORT_|PORTAL_)[A-Z0-9_]+$/.test(error.code) ? error.code : 'IMPORT_OPERATION_FAILED';
      const messages = { IMPORT_HISTORY_NOT_ACTIVATED: 'Der Kassenstand ist noch nicht aktiviert.', IMPORT_HISTORY_RESULTS_CHANGED: 'Datenstand oder Suchlauf geändert. Bitte erneut suchen.',
        IMPORT_HISTORY_CURSOR: 'Die Suche ist abgelaufen. Bitte erneut suchen.', IMPORT_HISTORY_DATE_RANGE: 'Bitte einen gültigen Zeitraum bis heute wählen.',
        IMPORT_RECEIPT_QUERY: 'Bitte höchstens zehn Suchbegriffe eingeben.', IMPORT_RECEIPT_EXPORT_LIMIT: 'Bitte die PDF-Auswahl verkleinern (höchstens 2.000 Positionen).',
        IMPORT_RECEIPT_SELECTION: 'Bitte 1 bis 50 unterschiedliche Belege oder Buchungen auswählen.' };
      Object.assign(messages, { IMPORT_RECEIPT_SORT: 'Diese Spalte lässt sich für die gewählte Datenart nicht sortieren.',
        IMPORT_RECEIPT_SEARCH_LIMIT: 'Für die Sortierung bitte die Suche eingrenzen: höchstens 10.000 Treffer oder 16 MB Suchergebnisse.',
        IMPORT_RECEIPT_SEARCH_BUSY: 'Eine umfangreiche Suche läuft bereits. Bitte kurz warten und erneut suchen.' });
      response.status(error.status >= 400 && error.status < 600 ? error.status : 500).json({ code,
        error: messages[code] || (error.status === 403 ? 'Für diese Daten fehlt die persönliche Berechtigung.' : 'Die Belegdaten konnten nicht sicher gelesen werden.') });
    }
  };
  const receipts = workspace => { if (!workspace?.receipts) C.fail('IMPORT_HISTORY_NOT_ACTIVATED', 503); return workspace.receipts; };
  app.get('/api/receipt-search/context', route(async ({ workspace, session, projection }) => {
    const preferencesByKind = {};
    for (const kind of projection.finance ? Object.keys(M.KINDS) : ['receipts']) {
      const stored = await preferences.get(session.employeeNumber, M.PREFERENCE_KEY + (kind === 'receipts' ? '' : '_' + kind));
      let saved; try { saved = M.preferences(JSON.parse(stored?.value || 'null')); } catch { saved = { columns: [...(kind === 'receipts' ? M.DEFAULT_COLUMNS : M.FINANCE_COLUMNS)] }; }
      preferencesByKind[kind] = { columns: saved.columns.filter(k => (k !== 'personnel' || projection.sellers) && (!M.CUSTOMER_COLUMNS.includes(k) || projection.customerPurchases) && (!['account', 'inflow', 'outflow'].includes(k) || projection.finance)) };
    }
    return { ...(workspace?.context() || { available: false, sources: [], projection }), columns: M.COLUMNS,
      preferences: preferencesByKind.receipts, preferencesByKind };
  }));
  app.put('/api/receipt-search/preferences', route(async ({ session, request, projection }) => {
    const value = M.preferences(request.body);
    if (value.kind !== 'receipts' && !projection.finance) C.fail('IMPORT_FORBIDDEN', 403);
    if (value.columns.some(k => M.CUSTOMER_COLUMNS.includes(k)) && !projection.customerPurchases) C.fail('IMPORT_FORBIDDEN', 403);
    await preferences.upsert(session.employeeNumber, M.PREFERENCE_KEY + (value.kind === 'receipts' ? '' : '_' + value.kind), JSON.stringify(value)); return value;
  }));
  app.post('/api/receipt-search/search', route(({ workspace, request }) => receipts(workspace).search(request.body)));
  app.post('/api/receipt-search/documents', route(({ workspace, request }) => receipts(workspace).documents(request.body)));
  app.post('/api/receipt-search/export.pdf', route(async ({ workspace, request }) => createReceiptInfoPdf(await receipts(workspace).documents(request.body)), true));
}
module.exports = { registerReceiptSearchRoutes };
