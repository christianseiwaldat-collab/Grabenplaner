"use strict";
const { buildDataImportProjection } = require('./data-import-access');
const KINDS = Object.freeze({
  FILIALEN: { label: 'Filialen', kind: 'location', dataClass: 'internal_business', read: ['locations:write'], write: ['locations:write'] },
  MITARBEITER: { label: 'Mitarbeitende / Verkäufer', kind: 'employee', dataClass: 'personnel_restricted', read: ['personnel:central:read'], write: ['personnel:central:write'] },
  ARTIKEL_STAMM: { label: 'Artikel', kind: 'sales_article', dataClass: 'internal_business', read: ['sales:articles:access', 'sales:articles:read'], write: ['sales:articles:import'] },
  KUNDEN: { label: 'Kunden / CRM', kind: 'crm_customer', dataClass: 'customer_restricted', read: ['crm:access', 'crm:customers:read'], write: ['crm:customers:write'] },
});
function buildDataImportMappingProjection(session) {
  const base = buildDataImportProjection(session), permissions = new Set(session?.permissions || []);
  const tables = Object.entries(KINDS).filter(([, kind]) => base.read && kind.read.every(p => permissions.has(p)))
    .map(([table, kind]) => ({ table, label: kind.label, write: base.apply && base.prepare && kind.write.every(p => permissions.has(p)),
      undo: base.undo && kind.write.every(p => permissions.has(p)) }));
  return { read: tables.length > 0, tables };
}
module.exports = { KINDS, buildDataImportMappingProjection };
