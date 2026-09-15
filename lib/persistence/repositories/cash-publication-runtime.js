'use strict';
const C = require('../../data-import-contract');
const { buildDataImportProjection } = require('../../data-import-access');
const { buildDataImportMappingProjection } = require('../../data-import-mapping-access');
const { loadManagedDataImportProtection } = require('../../data-import-managed-protection');
const { createCashPublications } = require('./cash-publications');
function createCashPublicationRuntime({ access, vault, enabled = false, policies = [], scopeId = 'grabenplaner-main', clock }) {
  return Object.freeze({ async operation(getSession, action, input = {}) {
    let session = await getSession();
    const identity = s => C.canonical([String(s?.employeeNumber || ''), s?.accountId || null, buildDataImportProjection(s), buildDataImportMappingProjection(s)]);
    const signature = identity(session), p = buildDataImportProjection(session), mappings = buildDataImportMappingProjection(session);
    if (!p.read) C.fail('IMPORT_FORBIDDEN', 403);
    const actor = { scopeId, ownerId: C.id(String(session.employeeNumber)) };
    if (!['context', 'references', 'preview', 'activate', 'rollback-preview', 'rollback'].includes(action)) C.fail('IMPORT_ACTION_INVALID');
    if (['preview', 'activate'].includes(action) && !(p.prepare && p.apply)) C.fail('IMPORT_FORBIDDEN', 403);
    if (['rollback-preview', 'rollback'].includes(action) && !p.undo) C.fail('IMPORT_FORBIDDEN', 403);
    if (['activate', 'rollback'].includes(action) && enabled !== true) C.fail('IMPORT_NOT_ACTIVATED', 409);
    const protection = await loadManagedDataImportProtection({ access, vault, create: false });
    if (!protection) C.fail('IMPORT_SOURCE_NOT_FOUND', 404);
    try {
      if (identity(await getSession()) !== signature) C.fail('IMPORT_FORBIDDEN', 403);
      const store = createCashPublications({ access, protection, scopeId, policies, clock });
      const result = await access.transaction(async tx => {
        if (action === 'context') {
          C.exact(input, ['sourceId']);
          const { dataset } = await store.candidate(tx, input.sourceId, actor.ownerId), state = await store.state(tx);
          const summary = async id => { if (!id) return null; const value = await store.load(tx, id); return { id, label: value.data.label, createdAt: value.row.createdAt }; };
          return { available: enabled === true, projection: p, mappingProjection: mappings, sourceId: input.sourceId,
            state: { revision: state.row.revision, active: await summary(state.data.active), previous: await summary(state.data.previous) },
            policies: policies.filter(v => v.appliesTo === 'matching_cash_schema' || v.fileSha256 === dataset.data.fileSha256).map(v => ({ id: v.id, label: v.label })),
            source: { createdAt: dataset.row.createdAt, fileSha256: dataset.data.fileSha256, verifiedRows: dataset.data.tables.reduce((n, t) => n + t.verifiedRows, 0) } };
        }
        if (action === 'references') {
          C.exact(input, ['sourceId', 'kind', 'after', 'limit']);
          if (!mappings.tables.some(t => t.table === input.kind)) C.fail('IMPORT_FORBIDDEN', 403);
          const { dataset, reader } = await store.candidate(tx, input.sourceId, actor.ownerId);
          const page = await store.references(tx, dataset, reader, input.kind, input.after || '', input.limit || 100);
          return { items: page.items.map(r => ({ sourceId: r.sourceId })), next: page.next };
        }
        if (action === 'preview' || action === 'activate') {
          C.exact(input, ['request', ...(action === 'activate' ? ['planHash'] : [])]);
          if (action === 'activate') return store.activate(tx, actor, input.request, mappings, signature, input.planHash);
          const plan = await store.plan(tx, actor, input.request, mappings, signature);
          return { planHash: plan.planHash, revision: plan.current.row.revision, label: plan.data.label, bindings: plan.bindings.length,
            locations: plan.data.locations, previousAvailable: !!plan.current.data.active,
            message: 'Dieser Datenstand ersetzt die Auswahl für neue Auswertungen. Der bisherige Stand und seine Zuordnungen bleiben erhalten.' };
        }
        C.exact(input, ['expectedRevision', ...(action === 'rollback' ? ['planHash'] : [])]);
        return store.rollback(tx, actor, input.expectedRevision, input.planHash, signature, action === 'rollback');
      }, { isolation: 'serializable', readOnly: !['activate','rollback'].includes(action) });
      session = await getSession(); if (identity(session) !== signature) C.fail('IMPORT_FORBIDDEN', 403);
      return result;
    } finally { protection.destroy(); }
  } });
}
module.exports = { createCashPublicationRuntime };
