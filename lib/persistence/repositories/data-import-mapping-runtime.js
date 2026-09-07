"use strict";
const C = require('../../data-import-contract');
const { loadManagedDataImportProtection } = require('../../data-import-managed-protection');
const { KINDS, buildDataImportMappingProjection } = require('../../data-import-mapping-access');
const { createImportMasterService } = require('./import-master-data');

function createDataImportMappingRuntime({ access, vault, scopeId = 'grabenplaner-main', sourceInstance = 'tradefoto-trade', allowMapping = false }) {
  C.id(scopeId); C.id(sourceInstance);
  async function operation(getSession, action, input = {}) {
    const original = await getSession();
    const who = { scopeId, ownerId: C.id(String(original?.employeeNumber || '')) };
    const projection = buildDataImportMappingProjection(original), signature = C.canonical([who, original.accountId || null, projection]);
    if (!projection.read) C.fail('IMPORT_FORBIDDEN', 403);
    const check = async () => {
      const current = await getSession();
      if (!current || C.canonical([{ scopeId, ownerId: String(current.employeeNumber) }, current.accountId || null, buildDataImportMappingProjection(current)]) !== signature) C.fail('IMPORT_FORBIDDEN', 403);
    };
    if (action === 'context') { C.exact(input, []); return { projection, activationEnabled: allowMapping === true,
      message: 'Quellzuordnungen werden vor der Übernahme der Verkaufshistorie geprüft. Bestehende Historie behält den damaligen Zuordnungsstand; Änderungen benötigen einen erneuten geprüften Referenzlauf.' }; }
    if (!['search', 'targets', 'preview', 'apply', 'undo'].includes(action)) C.fail('IMPORT_MAPPING_ACTION_INVALID');
    C.exact(input, ['table', ...(action === 'search' ? ['key', 'status', 'after', 'limit'] : action === 'targets' ? ['query', 'after', 'limit'] : action === 'undo' ? ['eventId'] : ['request', ...(action === 'apply' ? ['planHash'] : [])])]);
    const grant = projection.tables.find(t => t.table === input.table), kind = KINDS[input.table];
    if (!grant || !kind) C.fail('IMPORT_FORBIDDEN', 403);
    if (['preview', 'apply'].includes(action) && !grant.write || action === 'undo' && !grant.undo) C.fail('IMPORT_FORBIDDEN', 403);
    if (['apply', 'undo'].includes(action) && allowMapping !== true) C.fail('IMPORT_NOT_ACTIVATED', 503);
    const protection = await loadManagedDataImportProtection({ access, vault, create: false });
    if (!protection) {
      if (action === 'search') return { items: [], next: null, table: input.table, available: false };
      C.fail('IMPORT_MAPPING_SOURCE_UNAVAILABLE', 409);
    }
    try {
      await check();
      const service = createImportMasterService({ access, protection, sourceInstance, getActor: () => who,
        authorize: value => value.scopeId === who.scopeId && value.ownerId === who.ownerId
          && value.dataClasses.every(c => c === kind.dataClass) && (!value.targetKind || value.targetKind === kind.kind)
          && (value.action === 'master.undo' ? grant.undo : ['master.link', 'customer.sync'].includes(value.action) ? grant.write : true) });
      const { table, ...filters } = input;
      const result = action === 'search' ? await service.mappings({ ...filters, table, sourceInstance })
        : action === 'targets' ? await service.mappingTargets({ ...filters, table })
          : action === 'preview' ? await service[table === 'KUNDEN' ? 'previewCustomer' : 'previewBinding'](input.request)
            : action === 'apply' ? await service[table === 'KUNDEN' ? 'syncCustomer' : 'bind'](input.request, input.planHash)
              : await service.undo(input.eventId);
      await check(); return result;
    } finally { protection.destroy(); }
  }
  return Object.freeze({ operation });
}
module.exports = { createDataImportMappingRuntime };
