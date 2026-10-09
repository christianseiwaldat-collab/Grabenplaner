'use strict';
const C = require('./data-import-contract'), M = require('./sales-bwl-simulation-model');
function registerSalesBwlSimulationRoutes(app, { sessionFor, assertFresh, assertCsrf, privateHeaders, loadSimulation, variants, preferences = null, pdf = null }) {
  const route = work => async (request, response) => {
    response.set({ 'Cache-Control': 'private, no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    privateHeaders?.(response);
    try {
      const original = await sessionFor(request), identity = M.authority(original).identity;
      if (request.method !== 'GET') assertCsrf(request);
      const fresh = async tx => { const session = await assertFresh(request, original, tx); if (M.authority(session).identity !== identity) C.fail('BWL_SIMULATION_FORBIDDEN', 403); return session; };
      const session = await fresh(); const result = await work(fresh, request, session); await fresh();
      if (result?.buffer) {
        response.set({ 'Content-Type': 'application/pdf', 'X-PDF-Pages': String(result.pages), 'X-Report-Rows': String(result.rows),
          'Content-Disposition': `${request.path.endsWith('/pdf-preview') ? 'inline' : 'attachment'}; filename="Abverkaufs-Simulation.pdf"; filename*=UTF-8''${encodeURIComponent(result.name)}`,
          'Content-Security-Policy': "default-src 'none'; sandbox allow-downloads" }); response.send(result.buffer);
      } else response.json(result);
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      response.status(status).json({ code: status === 500 ? 'BWL_SIMULATION_FAILED' : error.code,
        error: status === 403 ? 'Die persönliche Berechtigung fehlt oder wurde verändert.' : status === 409 ? 'Die Variante, Berechtigung oder Datenquelle wurde verändert. Bitte neu laden oder das Szenario ausdrücklich neu berechnen.'
          : status === 503 ? 'Die geschützte Datenquelle oder Variante ist noch nicht verfügbar.' : status === 413 ? 'Die Auswahl ist zu groß. Bitte Artikel oder Filialen einschränken.'
            : status === 404 ? 'Die persönliche Variante wurde nicht gefunden.' : status === 422 ? 'Bitte Auswahl, Annahmen und Einstellungen prüfen.' : 'Die Simulation konnte nicht verarbeitet werden.' });
    }
  };
  const cleanQuery = request => C.exact(request.query, []);
  const name = value => { C.text(value, 120); if (!value.trim()) C.fail('BWL_SIMULATION_VARIANT_INVALID'); return value.trim(); };
  const uuid = value => { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) C.fail('BWL_SIMULATION_VARIANT_INVALID'); return value.toLowerCase(); };
  app.get('/api/sales/bwl/simulation/context', route((fresh, request) => { cleanQuery(request); return loadSimulation(fresh, 'context', {}); }));
  if (preferences) {
    app.get('/api/sales/bwl/simulation/preferences', route((fresh, request) => { cleanQuery(request); return preferences.read(fresh); }));
    app.put('/api/sales/bwl/simulation/preferences', route((fresh, request) => { cleanQuery(request); return preferences.write(fresh, request.body); }));
  }
  app.post('/api/sales/bwl/simulation/calculate', route((fresh, request, session) => { cleanQuery(request); return loadSimulation(fresh, 'calculate', M.normalize(request.body, M.authority(session).caps)); }));
  app.get('/api/sales/bwl/simulation/variants', route((fresh, request) => { cleanQuery(request); return variants.list(fresh); }));
  app.get('/api/sales/bwl/simulation/variants/:id', route((fresh, request) => { cleanQuery(request); return variants.get(fresh, uuid(request.params.id)); }));
  app.post('/api/sales/bwl/simulation/variants', route(async (fresh, request) => {
    cleanQuery(request); C.exact(request.body, ['id', 'name', 'snapshotToken']);
    const input = { id: uuid(request.body.id), name: name(request.body.name) }, token = C.text(request.body.snapshotToken, 16384);
    const snapshot = await loadSimulation(fresh, 'snapshot', { snapshotToken: token }); await fresh(); return variants.create(fresh, input, snapshot);
  }));
  app.put('/api/sales/bwl/simulation/variants/:id', route(async (fresh, request) => {
    cleanQuery(request); C.exact(request.body, ['version', 'name', 'snapshotToken']);
    const id = uuid(request.params.id), input = { version: C.integer(request.body.version, 1, Number.MAX_SAFE_INTEGER - 1), name: name(request.body.name) };
    const token = request.body.snapshotToken === undefined ? null : C.text(request.body.snapshotToken, 16384);
    const snapshot = token ? await loadSimulation(fresh, 'snapshot', { snapshotToken: token }) : null;
    await fresh(); return variants.update(fresh, id, input, snapshot);
  }));
  app.delete('/api/sales/bwl/simulation/variants/:id', route((fresh, request) => {
    cleanQuery(request); C.exact(request.body, ['version']); return variants.remove(fresh, uuid(request.params.id), { version: C.integer(request.body.version, 1, Number.MAX_SAFE_INTEGER - 1) });
  }));
  if (pdf) {
    const exportPdf = route(async (fresh, request, session) => {
      cleanQuery(request); let spec = pdf.normalize(request.body, M.authority(session).caps);
      const pinnedVariant = async (id, version) => {
        const record = await variants.get(fresh, id); if (record.version !== version) C.fail('BWL_SIMULATION_VARIANT_STALE', 409); return record;
      };
      const variant = spec.variantId ? await pinnedVariant(spec.variantId, spec.version) : null;
      const snapshot = variant ? variant.snapshot : await loadSimulation(fresh, 'snapshot', { snapshotToken: spec.snapshotToken });
      const comparison = spec.comparisonVariantId ? await pinnedVariant(spec.comparisonVariantId, spec.comparisonVersion) : null;
      // Old variants may have been captured without today's financial grants.
      // Their saved capability intersection governs the exported columns too.
      spec = pdf.normalize(request.body, snapshot.capabilities); await fresh();
      const result = await pdf.render({ spec, snapshot, variant, comparison });
      if (variant) await pinnedVariant(spec.variantId, spec.version);
      else await loadSimulation(fresh, 'snapshot', { snapshotToken: spec.snapshotToken });
      if (comparison) await pinnedVariant(spec.comparisonVariantId, spec.comparisonVersion);
      return result;
    });
    app.post('/api/sales/bwl/simulation/pdf-preview', exportPdf); app.post('/api/sales/bwl/simulation/pdf', exportPdf);
  }
}
module.exports = { registerSalesBwlSimulationRoutes };
