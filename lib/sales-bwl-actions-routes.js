'use strict';
const C = require('./data-import-contract'), M = require('./sales-bwl-actions-model');
function registerSalesBwlActionsRoutes(app, { sessionFor, assertFresh, assertCsrf, privateHeaders, loadLocations, loadAssignees, actions, preferences = null, pdf = null }) {
  const route = work => async (request, response) => {
    response.set({ 'Cache-Control': 'private, no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' }); privateHeaders?.(response);
    try {
      const original = await sessionFor(request), identity = M.authority(original).identity;
      if (request.method !== 'GET') assertCsrf(request);
      const fresh = async tx => { const session = await assertFresh(request, original, tx); if (M.authority(session).identity !== identity) C.fail('BWL_ACTIONS_FORBIDDEN', 403); return session; };
      const session = await fresh(), result = await work(fresh, request, M.authority(session)); await fresh();
      if (result?.buffer) {
        response.set({ 'Content-Type': 'application/pdf', 'X-PDF-Pages': String(result.pages), 'X-Report-Rows': String(result.rows),
          'Content-Disposition': `${request.path.endsWith('/pdf-preview') ? 'inline' : 'attachment'}; filename="Filialmassnahmen.pdf"; filename*=UTF-8''${encodeURIComponent(result.name)}`,
          'Content-Security-Policy': "default-src 'none'; sandbox allow-downloads" }); response.send(result.buffer);
      } else response.json(result);
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      response.status(status).json({ code: status === 500 ? 'BWL_ACTIONS_FAILED' : error.code,
        error: status === 403 ? 'Die persönliche Berechtigung oder vollständige Filialfreigabe fehlt oder wurde verändert.'
          : status === 409 ? 'Die Maßnahme oder ihre Datenquelle wurde verändert. Bitte neu laden.'
            : status === 503 ? 'Die geschützte Maßnahme oder Datenquelle ist derzeit nicht verfügbar.'
              : status === 413 ? 'Die begrenzte Maßnahmenliste ist voll.' : status === 404 ? 'Die Maßnahme oder Quellenposition wurde nicht gefunden.'
                : status === 422 ? 'Bitte Filiale, Maßnahme, Zuständigkeit und Ergebnis prüfen.' : 'Die Maßnahme konnte nicht verarbeitet werden.' });
    }
  };
  const prefix = '/api/sales/bwl/actions', cleanQuery = request => C.exact(request.query, []);
  const locationQuery = (request, auth, write = false) => { C.exact(request.query, ['locationId']); return M.assertLocation(auth, request.query.locationId, { write }); };
  app.get(prefix + '/context', route(async (fresh, request, auth) => {
    cleanQuery(request); const locations = await loadLocations(fresh);
    if (!Array.isArray(locations) || locations.length > 1000) C.fail('BWL_ACTIONS_INTEGRITY', 503);
    const visible = locations.map(l => { C.exact(l, ['id', 'label']); return { id: C.id(l.id), label: C.text(l.label, 200) }; });
    return M.context(auth, visible);
  }));
  app.get(prefix + '/assignees', route(async (fresh, request, auth) => {
    const locationId = locationQuery(request, auth, true), rows = await loadAssignees(fresh, locationId);
    if (!Array.isArray(rows) || rows.length > 5000) C.fail('BWL_ACTIONS_INTEGRITY', 503);
    const result = rows.map(row => { C.exact(row, ['employeeNumber', 'firstName']);
      if (typeof row.firstName !== 'string' || row.firstName.length > 120 || /[\u0000-\u001f\u007f]/.test(row.firstName)) C.fail('BWL_ACTIONS_INTEGRITY', 503);
      return { employeeNumber: C.text(row.employeeNumber, 120), firstName: row.firstName }; });
    if (new Set(result.map(row => row.employeeNumber)).size !== result.length) C.fail('BWL_ACTIONS_INTEGRITY', 503);
    return { rows: result };
  }));
  if (preferences) {
    app.get(prefix + '/preferences', route((fresh, request) => { cleanQuery(request); return preferences.read(fresh); }));
    app.put(prefix + '/preferences', route((fresh, request) => { cleanQuery(request); return preferences.write(fresh, request.body); }));
  }
  if (pdf) {
    async function readExport(fresh, spec, auth) {
      const locationId = M.assertLocation(auth, spec.query.locationId), locations = await loadLocations(fresh), location = locations.find(l => l.id === locationId);
      if (!location) C.fail('BWL_ACTIONS_SOURCE_CHANGED', 409);
      const rows = []; let total;
      for (let offset = 0; ; offset += M.LIMITS.page) {
        const page = await actions.list(fresh, { ...spec.query, limit: M.LIMITS.page, offset });
        C.integer(page.total, 0, M.LIMITS.perLocation);
        if (total !== undefined && total !== page.total || !Array.isArray(page.rows) || page.rows.length !== Math.min(M.LIMITS.page, page.total - offset)
          || page.hasMore !== (offset + page.rows.length < page.total)) C.fail('BWL_ACTIONS_SOURCE_CHANGED', 409);
        total = page.total; rows.push(...JSON.parse(C.canonical(page.rows)));
        if (!page.hasMore) break;
      }
      pdf.validateRows(rows, locationId); await fresh(); const result = { rows, location: JSON.parse(C.canonical(location)) };
      return { ...result, fingerprint: C.fingerprint([spec.query, result]) };
    }
    const exportPdf = route(async (fresh, request, auth) => {
      cleanQuery(request); const spec = pdf.normalize(request.body, auth.caps), snapshot = await readExport(fresh, spec, auth);
      const check = async () => { if ((await readExport(fresh, spec, auth)).fingerprint !== snapshot.fingerprint) C.fail('BWL_ACTIONS_SOURCE_CHANGED', 409); };
      await check(); const result = await pdf.render({ spec, rows: snapshot.rows, location: snapshot.location }); await check(); return result;
    });
    app.post(prefix + '/pdf-preview', exportPdf); app.post(prefix + '/pdf', exportPdf);
  }
  app.get(prefix, route((fresh, request, auth) => {
    const query = M.normalizeQuery(request.query); M.assertLocation(auth, query.locationId); return actions.list(fresh, query);
  }));
  app.get(prefix + '/:id', route((fresh, request, auth) => actions.get(fresh, locationQuery(request, auth), M.uuid(request.params.id))));
  app.post(prefix, route((fresh, request, auth) => {
    cleanQuery(request); const input = M.normalizeCreate(request.body); M.assertLocation(auth, input.locationId, { write: true }); return actions.create(fresh, input);
  }));
  app.put(prefix + '/:id', route((fresh, request, auth) => actions.update(fresh, locationQuery(request, auth, true), M.uuid(request.params.id), M.normalizeUpdate(request.body))));
}
module.exports = { registerSalesBwlActionsRoutes };
