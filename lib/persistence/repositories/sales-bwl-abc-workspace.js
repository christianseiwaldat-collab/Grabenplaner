'use strict';
const C = require('../../data-import-contract');
const M = require('../../sales-bwl-abc-model');
const { createSalesBwlAbcStore } = require('../../sales-bwl-abc-store');
const { START, readCheckedCashReportBatch } = require('./checked-cash-report-batch');
function createSalesBwlAbcWorkspace({ access, protection, backend, getSession, scopeId, today,
  marginPolicy = null, sourceAt = null, store = createSalesBwlAbcStore() }) {
  async function state(tx) {
    const actor = M.authority(await getSession(tx));
    if (backend.source.scopeId !== scopeId) C.fail('IMPORT_FORBIDDEN', 403);
    // ABC is branch-based. Virtual online allocation remains an explicit report option elsewhere.
    const locations = backend.source.locations.filter(l => actor.projection.company || actor.projection.locationIds.includes(l.id));
    return { ...actor, locations, signature: protection.digest([scopeId, actor.identity]),
      context: ['sales-bwl-abc-v1', scopeId, actor.ownerId, actor.accountId, actor.identity] };
  }
  async function unchanged(original, tx) { if ((await state(tx)).signature !== original.signature) C.fail('IMPORT_FORBIDDEN', 403); }
  function normalized(input, s) { return M.normalizeQuery(input, { today: today(), projection: s.projection, locations: s.locations, marginPolicy }); }
  async function metadata() {
    const s = await state();
    await access.transaction(async tx => { await unchanged(s, tx); await backend.epoch(tx); await unchanged(s, tx); }, { isolation: 'serializable', readOnly: true });
    await unchanged(s);
    return { available: true, today: today(), locations: s.locations, metrics: [{ id: 'netRevenue', label: 'Umsatz netto' },
      ...(s.projection.margin && marginPolicy ? [{ id: 'grossMargin', label: 'Rohertrag' }] : [])],
      columns: M.availableColumns(s.projection), defaultColumns: M.normalizePreferences({}, s.projection).columns,
      defaults: { aLimit: 80, bLimit: 95 }, limits: M.LIMITS, coverage: M.COVERAGE, sourceAt,
      marginStatus: marginPolicy ? 'confirmed' : 'unconfirmed' };
  }
  async function normalize(input) { return normalized(input, await state()); }
  async function step(input, cursor = null) {
    const s = await state(), query = normalized(input, s), signature = protection.digest([s.signature, query, marginPolicy]);
    const resumed = cursor ? store.take(protection, s.context, cursor) : null;
    const analysisId = resumed?.analysisId || store.begin(s.context);
    const saved = resumed?.value || { signature, query, epoch: null, ...START, state: M.accumulator() };
    if (saved.signature !== signature || !C.equal(saved.query, query)) C.fail('IMPORT_FORBIDDEN', 403);
    let complete = false;
    await access.transaction(async tx => {
      await unchanged(s, tx); store.assertActive(analysisId, s.context);
      const epoch = C.fingerprint(await backend.epoch(tx));
      if (saved.epoch && saved.epoch !== epoch) C.fail('IMPORT_HISTORY_ANALYSIS_CHANGED', 409);
      saved.epoch = epoch;
      const projection = { ...s.projection, sellers: false, customers: false, customerPurchases: false, marginCustomers: false };
      const batch = await readCheckedCashReportBatch({ tx, backend, query, cursor: saved, projection, marginPolicy,
        onLine: ({ fields, metric, margin, locationId, reviewIssues }) => {
          // Missing/unconfirmed filial bindings never become a guessed ABC group.
          const confirmed = query.locationIds.includes(locationId);
          M.accumulate(saved.state, { articleNumber: fields.EAN, description: fields.Artikelbezeichnung,
            locationId: confirmed ? locationId : null, location: s.locations.find(l => l.id === locationId)?.label,
            quantity: fields.VKMenge, metric, margin, reviewIssues });
        } });
      if (batch.more) Object.assign(saved, { afterDate: batch.afterDate, afterId: batch.afterId });
      else complete = true;
      await unchanged(s, tx); store.assertActive(analysisId, s.context);
    }, { isolation: 'serializable', readOnly: true });
    await unchanged(s); store.assertActive(analysisId, s.context);
    const snapshot = complete ? { query, sourceAt, coverage: M.COVERAGE, ...M.finish(saved.state, query, { margin: s.projection.margin }) } : null;
    return { analysis: { complete, processed: saved.state.processed, phase: complete ? 'complete' : 'current',
      cursor: complete ? null : store.put(protection, s.context, analysisId, 'cursor', saved) }, snapshot,
      exportToken: complete ? store.put(protection, s.context, analysisId, 'snapshot', { signature, epoch: saved.epoch, snapshot }) : null };
  }
  async function readSnapshot(token, { executor = null } = {}) {
    if (executor) require('../contract').assertPersistenceExecutor(executor);
    const s = await state(executor), loaded = store.read(protection, s.context, token), saved = loaded.value;
    const query = normalized(saved.snapshot.query, s);
    if (saved.signature !== protection.digest([s.signature, query, marginPolicy])) C.fail('IMPORT_FORBIDDEN', 403);
    const read = async tx => {
      await unchanged(s, tx); if (C.fingerprint(await backend.epoch(tx)) !== saved.epoch) C.fail('IMPORT_HISTORY_ANALYSIS_CHANGED', 409);
      await unchanged(s, tx); store.assertActive(loaded.analysisId, s.context);
    };
    if (executor) await read(executor); else await access.transaction(read, { isolation: 'serializable', readOnly: true });
    await unchanged(s, executor); store.assertActive(loaded.analysisId, s.context); return { snapshot: saved.snapshot, epoch: saved.epoch };
  }
  async function snapshot(token, options) { return (await readSnapshot(token, options)).snapshot; }
  async function sourceHint(token, rowId, locationId, options = {}) {
    const Actions = require('../../sales-bwl-actions-model'), auth = Actions.authority(await getSession(options.executor));
    Actions.assertLocation(auth, locationId, { write: true }); C.text(rowId, 1024);
    const saved = await readSnapshot(token, options), row = saved.snapshot.rows.find(r => r.id === rowId && r.locationId === locationId);
    if (!row) C.fail('BWL_ACTIONS_SOURCE_MISSING', 404);
    const result = Actions.validateSourceRecord({ kind: 'abc', rowId, articleNumber: row.articleNumber, label: row.description || null,
      sourceFingerprint: saved.epoch, sourceAt: saved.snapshot.sourceAt, reason: ['A', 'B', 'C'].includes(row.class) ? `Artikel der ABC-Klasse ${row.class} prüfen.` : 'Artikelposition aus ABC-Auswertung fachlich prüfen.', type: 'checked-cash-review' });
    if (Actions.authority(await getSession(options.executor)).identity !== auth.identity) C.fail('BWL_ACTIONS_FORBIDDEN', 403);
    return result;
  }
  async function cancel(cursor) { const s = await state(); const result = store.cancel(protection, s.context, cursor); await unchanged(s); return result; }
  return Object.freeze({ metadata, normalize, step, snapshot, sourceHint, cancel });
}
module.exports = { createSalesBwlAbcWorkspace };
