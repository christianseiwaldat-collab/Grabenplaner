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
    if (!['status', 'apply', 'context', 'references', 'preview', 'activate', 'rollback-preview', 'rollback'].includes(action)) C.fail('IMPORT_ACTION_INVALID');
    if (['apply', 'preview', 'activate'].includes(action) && !(p.prepare && p.apply)) C.fail('IMPORT_FORBIDDEN', 403);
    if (['rollback-preview', 'rollback'].includes(action) && !p.undo) C.fail('IMPORT_FORBIDDEN', 403);
    if (['apply', 'activate', 'rollback'].includes(action) && enabled !== true) C.fail('IMPORT_NOT_ACTIVATED', 409);
    const protection = await loadManagedDataImportProtection({ access, vault, create: false });
    if (!protection) C.fail('IMPORT_SOURCE_NOT_FOUND', 404);
    try {
      if (identity(await getSession()) !== signature) C.fail('IMPORT_FORBIDDEN', 403);
      const store = createCashPublications({ access, protection, scopeId, policies, clock });
      const result = await access.transaction(async tx => {
        if (action === 'status') {
          C.exact(input, []);
          const state = await store.state(tx), active = state.data.active ? await store.load(tx, state.data.active) : null;
          return { revision: state.row.revision, sourceId: active?.row.ownerId === actor.ownerId ? active.row.datasetId : null, available: enabled === true };
        }
        if (action === 'apply') {
          C.exact(input, ['sourceId', 'expectedRevision']);
          C.sha(input.sourceId); C.integer(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER);
          const state = await store.state(tx), active = state.data.active ? await store.load(tx, state.data.active) : null;
          // A repeated click or response lost in transit must not replace the
          // previous publication with a duplicate of the same source.
          if (active?.row.datasetId === input.sourceId && active.row.ownerId === actor.ownerId)
            return { revision: state.row.revision, active: active.row.id, label: active.data.label, alreadyApplied: true };
          const request = await store.automaticRequest(tx, actor, input.sourceId, mappings, input.expectedRevision);
          return store.apply(tx, actor, request, mappings, signature);
        }
        if (action === 'context') {
          C.exact(input, ['sourceId']);
          const { dataset, reader } = await store.candidate(tx, input.sourceId, actor.ownerId), state = await store.state(tx);
          const summary = async id => { if (!id) return null; const value = await store.load(tx, id); return { id, label: value.data.label, createdAt: value.row.createdAt }; };
          return { available: enabled === true, projection: p, mappingProjection: mappings, sourceId: input.sourceId,
            mappingSetup: await store.mappingSetup(tx, dataset, reader, state, mappings),
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
      }, { isolation: 'serializable', readOnly: !['apply','activate','rollback'].includes(action) });
      session = await getSession(); if (identity(session) !== signature) C.fail('IMPORT_FORBIDDEN', 403);
      return result;
    } finally { protection.destroy(); }
  } });
}
module.exports = { createCashPublicationRuntime };
