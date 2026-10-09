'use strict';
const C = require('../../data-import-contract');
const Model = require('../../sales-report-model');
const { ONLINE_LOCATION, isOnlineSource } = require('../../sales-report-locations');
const START = Object.freeze({ afterDate: '9999-12-31', afterId: '~' });
const BATCH = 200;
const linked = ref => !!ref?.targetId && ['linked', 'historical_mapping'].includes(ref.status);
// Only checked receipt positions cross this internal composition boundary. The
// caller owns aggregation and never receives an unverified alternate scan.
async function readCheckedCashReportBatch({ tx, backend, query, cursor, projection, marginPolicy, onLine }) {
  let records = [];
  for (const locationId of query.locationIds) {
    if (locationId === ONLINE_LOCATION.id) records.push(...await backend.searchReportOnline(tx, { dateFrom: query.dateFrom, dateTo: query.dateTo, ...cursor, limit: BATCH + 1 }));
    else records.push(...(await backend.search(tx, { sourceTable: 'Umsatz_Kasse_Details', dateFrom: query.dateFrom, dateTo: query.dateTo, ...cursor,
      locationId, unassigned: false, sellerId: '', sellerMode: 'none', sellerRole: 'line_seller', customerId: null, snapshot: null, limit: BATCH + 1 }))
      .map(r => ({ ...r, physicalMatch: true })));
    const unique = new Map();
    for (const record of records) unique.set(record.id, { ...unique.get(record.id), ...record });
    records = [...unique.values()].sort((a, b) => b.businessDate.localeCompare(a.businessDate) || b.id.localeCompare(a.id)).slice(0, BATCH + 1);
  }
  const reader = backend.service(tx, value => {
    if (value.source !== 'cash' || value.sourceInstance !== 'tradefoto-cash' || !['Umsatz_Kasse_Details', 'Umsatz_KASSE'].includes(value.sourceTable)) return false;
    if (value.action === 'history.scope') {
      const loc = value.locations.find(l => l.role === 'location.filialid');
      return linked(loc) && query.locationIds.includes(loc.targetId)
        || projection.company && query.locationIds.includes(ONLINE_LOCATION.id) && isOnlineSource(value.sourceLocationId);
    }
    if (value.action === 'history.reference' && value.targetKind === 'crm_customer') return false;
    return value.dataClasses.every(k => ['internal_business', 'customer_restricted'].includes(k)
      || k === 'personnel_restricted' && projection.sellers || k === 'catalog_costs' && projection.margin && !!marginPolicy);
  });
  const receipts = new Map();
  for (const record of records.slice(0, BATCH)) {
    if (record.onlineCandidate && !record.physicalMatch && !await backend.isReportOnline(tx, record.id)) continue;
    const detail = await reader.detail(record.id), fields = detail.fields, refs = Object.fromEntries(detail.references.map(r => [r.role, r]));
    if (detail.table !== 'Umsatz_Kasse_Details' || detail.provenance.businessDate !== record.businessDate) C.fail('IMPORT_HISTORY_INTEGRITY');
    const parent = detail.provenance.parentId;
    if (!receipts.has(parent)) receipts.set(parent, { head: await reader.detail(parent), checked: await reader.receipt(parent) });
    const { head, checked } = receipts.get(parent);
    const metric = checked.canAggregate ? checked.positions.find(m => m.key === fields.RepID) : null;
    let margin = null;
    if (metric && !['excluded', 'payment', 'voucher_issue', 'uid_clearing', 'deposit'].includes(metric.status) && marginPolicy && projection.margin) {
      margin = Model.positionMargin(fields[marginPolicy.field], fields[marginPolicy.quantityField]);
    }
    const locationId = query.locationIds.includes(ONLINE_LOCATION.id) && isOnlineSource(fields.Filialid) ? ONLINE_LOCATION.id : refs['location.filialid']?.targetId;
    await onLine({ detail, fields, refs, parent, head, metric, margin, locationId, reviewIssues: metric ? [] : checked.issues });
  }
  return { more: records.length > BATCH, ...(records.length > BATCH
    ? { afterDate: records[BATCH - 1].businessDate, afterId: records[BATCH - 1].id } : {}) };
}
module.exports = { START, BATCH, readCheckedCashReportBatch };
