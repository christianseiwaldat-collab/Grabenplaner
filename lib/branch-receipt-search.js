'use strict';
const C = require('./data-import-contract'), Model = require('./receipt-search');
const F = require('../public/branch-receipt-filters');
const { createSalesMasterReader } = require('./persistence/repositories/sales-master-data');
const { CASH_SNAPSHOT_TABLES } = require('./persistence/statements/cash-snapshots');
const { sourceSearch } = require('./persistence/statements/branch-receipt');
const customerFields = ['KUND_NR', 'KontoNr', 'VORNAME', 'NACHNAME', 'STRaße', 'AdressZusatz', 'PLZ', 'ORT', 'Land', 'TELEFON', 'Handy', 'EMail'];

function query(input, options) {
  const { sourceLocationIds, sellerIds, ...rest } = input;
  const result = Model.query(rest, options), p = options.projection;
  const ids = sourceLocationIds ?? p.receiptDefaultIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 256 || ids.some(id => typeof id !== 'string' || F.location(id) !== id || !p.receiptSourceIds.includes(id))) C.fail('BRANCH_RECEIPT_LOCATIONS', 422);
  if (!Array.isArray(sellerIds || []) || (sellerIds || []).length > 20 || (sellerIds || []).some(id => F.seller(id) !== id)) C.fail('BRANCH_RECEIPT_SELLERS', 422);
  return { ...result, sourceLocationIds: [...new Set(ids)].sort(), sellerIds: [...new Set(sellerIds || [])].sort() };
}
async function inventory({ access, publication, publications }) {
  const rows = [], mapped = new Map();
  await access.transaction(async tx => {
    let after = '';
    do {
      const page = await publications.references(tx, publication.dataset, publication.reader, 'FILIALEN', after, 1000);
      rows.push(...page.items); after = page.next;
      if (rows.length > 1024) C.fail('IMPORT_COMPOSITION_INVALID');
    } while (after);
    for (const row of rows) mapped.set(row.sourceId, await publications.reference(tx, publication.row.id, 'FILIALEN', row.sourceId));
  }, { readOnly: true, isolation: 'serializable' });
  return { rows, mapped };
}
async function options({ access, publication, publications, context, metadata }) {
  const { rows, mapped } = metadata || await inventory({ access, publication, publications });
  const ownId = F.location(context.locationId), byId = new Map();
  for (const id of [...F.STOCK, ...F.INTERNET, ...(ownId ? [ownId] : [])]) byId.set(id, { id, rawIds: [], label: id });
  // Compact storage deliberately indexes the literal source zero as NULL.
  for (const raw of ['0', ...rows.map(row => row.sourceId)]) {
    const id = F.location(raw); if (!id) continue;
    if (!byId.has(id)) byId.set(id, { id, rawIds: [], label: id });
    const item = byId.get(id); if (!item.rawIds.includes(raw)) item.rawIds.push(raw);
    const ref = mapped.get(raw), label = publication.data.locations.find(l => l.id === ref?.targetId)?.label;
    if (label) item.label = `${id} · ${label}`;
    if (ref?.targetId === context.locationId) item.own = true;
  }
  const list = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const mappedOwn = list.filter(l => l.own).map(l => l.id);
  const defaultIds = ownId && mappedOwn.includes(ownId) ? [ownId] : mappedOwn.length ? mappedOwn : ownId ? [ownId] : [];
  if (!defaultIds.length) C.fail('BRANCH_RECEIPT_LOCATIONS', 422);
  return { list, defaultIds };
}
function backendFor({ base, publication, publications, choices }) {
  const table = CASH_SNAPSHOT_TABLES.find(t => t.name === 'Umsatz_KASSE'), prefix = 'c' + CASH_SNAPSHOT_TABLES.indexOf(table) + '-' + publication.row.id + '-';
  return Object.freeze({ ...base, source: { ...base.source, locations: choices.list.map(({ id, label }) => ({ id, label })) },
    async search(tx, p) {
      if (p.sourceTable !== 'Umsatz_KASSE') C.fail('IMPORT_FORBIDDEN', 403);
      const choice = choices.list.find(l => l.id === p.locationId); if (!choice) C.fail('IMPORT_FORBIDDEN', 403);
      if (p.afterId !== '~' && (!p.afterId.startsWith(prefix) || !/^\d{10}$/.test(p.afterId.slice(prefix.length)))) C.fail('IMPORT_HISTORY_CURSOR');
      const values = [];
      for (const raw of choice.rawIds) {
        const rows = await tx.queryAll(sourceSearch, { datasetSlot: publication.dataset.row.slot, locationKey: raw === '0' ? null : publications.referenceKey('FILIALEN', raw),
          dateFrom: p.dateFrom, dateTo: p.dateTo, afterDate: p.afterDate, afterRow: p.afterId === '~' ? C.LIMITS.rows + 1 : Number(p.afterId.slice(prefix.length)), limit: p.limit });
        for (const row of rows) {
          const source = publication.reader.decode(publication.dataset, table, row).normalized.source;
          values.push({ id: prefix + String(row.sourceRow).padStart(10, '0'), businessDate: row.businessDate,
            receiptScopeAllowed: F.location(source.Filialid) === choice.id });
        }
      }
      return values.sort((a, b) => b.businessDate.localeCompare(a.businessDate) || b.id.localeCompare(a.id)).slice(0, p.limit);
    } });
}
function customerReader({ protection, scopeId }) {
  const reader = createSalesMasterReader({ protection, scopeId });
  return async (tx, number, linkedCustomer = false) => {
    // Preserve CRM corrections; only add the source mobile number and account
    // field that the current CRM card does not model separately.
    const value = await reader.byKey(tx, 'KUNDEN', [number], linkedCustomer ? ['KUND_NR', 'KontoNr', 'Handy'] : customerFields);
    if (!value) return null;
    return { customerNumber: String(value.KUND_NR || ''), customerSourceAccount: String(value.KontoNr || ''), customerName: [value.VORNAME, value.NACHNAME].filter(Boolean).join(' '),
      customerAddress: [value['STRaße'], value.AdressZusatz, value.PLZ, value.ORT, value.Land].filter(Boolean).join(' · '),
      customerPhone: [value.TELEFON, value.Handy].filter(Boolean).join(' · '), customerEmail: value.EMail || '', customerStatus: 'Kundenstamm aus Import' };
  };
}
module.exports = { query, inventory, options, backendFor, customerReader, customerFields };
