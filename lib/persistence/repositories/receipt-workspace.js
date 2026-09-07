'use strict';
const C = require('../../data-import-contract');
const Search = require('../../flexible-search');
const Model = require('../../receipt-search');
const { createReceiptResultStore, sortedSearch } = require('../../receipt-result-store');
const { IMPORT_MASTER_STATEMENTS: CRM } = require('../statements/import-master-data');
const { createImportMasterReferenceReader } = require('./import-master-data');
const { buildSalesHistoryProjection } = require('../../sales-history-access');
const linked = ref => !!ref?.targetId && ['linked', 'historical_mapping'].includes(ref.status);
const primary = table => table === 'KassenJournal_Details' ? 'location.filiale' : 'location.filialid';
const START = { afterDate: '9999-12-31', afterId: '~' };
const BATCH = 100;
function createReceiptWorkspace({ access, protection, backend, getSession, getActor, today, now = () => Date.now(), resultStore = createReceiptResultStore() }) {
  function state() {
    const actor = getActor(), session = getSession(), p = buildSalesHistoryProjection(session);
    if (!p.read || actor.scopeId !== backend.source.scopeId) C.fail('IMPORT_FORBIDDEN', 403);
    const locations = backend.source.locations.filter(l => p.company || p.locationIds.includes(l.id));
    return { p, locations, actor, customers: new Map(), signature: protection.digest([actor, session.employeeNumber, session.accountId || '', p]) };
  }
  function service(tx, s) {
    return backend.service(tx, value => {
      if (value.source !== 'cash' || value.sourceInstance !== 'tradefoto-cash') return false;
      if (!Object.values(Model.KINDS).includes(value.sourceTable) && value.sourceTable !== 'Umsatz_Kasse_Details') return false;
      const finance = ['Tagesbericht', 'KassenJournal_Details'].includes(value.sourceTable);
      if (finance && !s.p.finance) return false;
      if (value.action === 'history.scope') {
        const ref = value.locations.find(l => l.role === primary(value.sourceTable));
        return linked(ref) ? s.locations.some(l => l.id === ref.targetId) : s.p.unassigned;
      }
      if (value.action === 'history.reference' && value.targetKind === 'crm_customer') return s.p.customerPurchases;
      return value.dataClasses.every(k => k === 'internal_business' || k === 'customer_restricted' || (k === 'personnel_restricted' && s.p.sellers) || (k === 'restricted_finance' && s.p.finance));
    });
  }
  const personnel = (ref, raw) => linked(ref) ? ref.targetId : raw == null ? '' : String(raw);
  async function document(reader, id, s, tx, headFilter = null) {
    const head = await reader.detail(id), h = head.fields, refs = Object.fromEntries(head.references.map(r => [r.role, r]));
    const kind = Object.keys(Model.KINDS).find(k => Model.KINDS[k] === head.table);
    if (!kind) C.fail('IMPORT_HISTORY_NOT_FOUND', 404);
    const loc = refs[primary(head.table)];
    const row = { id, kind, date: head.provenance.businessDate, receipt: h.Bonnr ?? h.ZBon ?? h.Beleg ?? '', invoice: h.RechnungsNr ?? h.Rechnungsnr ?? '',
      locationId: linked(loc) ? loc.targetId : 'unassigned', location: linked(loc) ? s.locations.find(l => l.id === loc.targetId)?.label || loc.targetId : 'Filialzuordnung offen',
      register: h.Kassenid ?? '', provenance: { ...head.provenance, sourceLabel: backend.source.label }, lines: [], gross: null, state: 'Quellbuchung', currency: backend.policy?.currency || '' };
    if (kind !== 'receipts') {
      Object.assign(row, { description: h.KoBeschreibung ?? h.Bezeichnung ?? '', account: h.KontoNr ?? h.Konto ?? '', inflow: h.Einnahmen ?? h.Einzahlung, outflow: h.Ausgaben ?? h.Auszahlung });
      if (headFilter && !headFilter(row)) row.filtered = true;
      return row;
    }
    if (s.p.sellers) row.personnel = personnel(refs.header_seller, h['VerkäuferID']);
    if (s.p.customerPurchases) {
      // Zero is an anonymous sale, never a shared customer identity. Only an
      // authenticated source binding may contribute a CRM name or contact.
      const assigned = h.KUND_NR != null && String(h.KUND_NR) !== '0';
      const number = assigned ? String(h.KUND_NR) : '';
      if (assigned && !s.customers.has(number)) {
        let ref = refs.customer;
        if (!linked(ref)) {
          const readReference = createImportMasterReferenceReader({ protection, authorize: () => s.p.customerPurchases });
          ref = await readReference(tx, { ...s.actor, sourceInstance: 'tradefoto-trade' }, 'KUNDEN', [number]);
        }
        s.customers.set(number, linked(ref) ? await tx.queryOne(CRM.crmGet, { id: ref.targetId }) : null);
      }
      const customer = s.customers.get(number);
      Object.assign(row, { customerAccount: number, customerNumber: customer?.customerNumber || '',
        customerSourceAccount: assigned && h.KontoNr != null && String(h.KontoNr) !== '0' ? String(h.KontoNr) : '',
        customerName: customer ? [customer.firstName, customer.lastName, customer.companyName].filter(Boolean).join(' ') : '',
        customerAddress: customer ? [customer.street, customer.addressSupplement, customer.postalCode, customer.city, customer.country].filter(Boolean).join(' · ') : h.KPLZ || '',
        customerPhone: customer?.phone || '', customerEmail: customer?.email || '',
        customerStatus: customer ? 'Kundenstamm verknüpft' : assigned ? 'Kundenstamm noch nicht verknüpft' : 'Kein Kundenkonto am Beleg' });
    }
    if (headFilter && !headFilter(row)) return { ...row, filtered: true };
    const children = await reader.children(id);
    const checked = await reader.receipt(id);
    const metrics = new Map((checked.canAggregate ? checked.positions || [] : []).map(l => [l.key, l]));
    for (const childId of children) {
      const line = await reader.detail(childId), f = line.fields;
      if (line.provenance.parentId !== id || line.provenance.businessDate !== row.date) C.fail('IMPORT_HISTORY_INTEGRITY');
      const ref = line.references.find(r => r.role === 'location.filialid');
      if ((linked(ref) ? ref.targetId : 'unassigned') !== row.locationId) C.fail('IMPORT_HISTORY_INTEGRITY');
      const metric = metrics.get(f.RepID);
      row.lines.push({ article: f.EAN, description: f.Artikelbezeichnung, quantity: f.VKMenge, sourcePrice: f.VK_Preis,
        gross: metric?.gross ?? null, status: metric?.status ?? 'review',
        ...(s.p.sellers ? { personnel: personnel(line.references.find(r => r.role === 'line_seller'), f['Verkäuferid']) } : {}) });
    }
    Object.assign(row, { positions: row.lines.length, description: row.lines.map(l => l.description).filter(Boolean).slice(0, 3).join(' · '),
      sourceAmount: h.RechnungsBetrag, gross: checked.canAggregate ? checked.totals.gross : null,
      state: checked.canAggregate ? 'Geprüft' : 'Prüfung offen', issues: checked.issues });
    return row;
  }
  async function scan(input) {
    const s = state(), q = Model.query(input, { today: today(), projection: s.p });
    if (q.sourceId !== backend.source.id) C.fail('IMPORT_HISTORY_SOURCE_NOT_FOUND', 404);
    const locations = s.locations.map(l => l.id).concat(s.p.unassigned ? ['unassigned'] : []);
    if (q.locationId && !locations.includes(q.locationId)) C.fail('IMPORT_FORBIDDEN', 403);
    // Page size may change; the cursor still binds every business filter.
    const context = ['receipt-search-v1', s.signature], signature = protection.digest({ ...q, cursor: '', limit: 0 });
    const result = await access.transaction(async tx => {
      const epoch = protection.digest(await backend.epoch(tx));
      let position = START;
      if (q.cursor) {
        try {
          position = protection.open(q.cursor, context);
          if (position.signature !== signature || position.epoch !== epoch || position.expires < now()) C.fail('IMPORT_HISTORY_CURSOR');
        } catch { C.fail('IMPORT_HISTORY_RESULTS_CHANGED', 409); }
      }
      let candidates = [];
      const order = (a, b) => b.businessDate.localeCompare(a.businessDate) || b.id.localeCompare(a.id);
      for (const locationId of q.locationId ? [q.locationId] : locations) {
        candidates.push(...await backend.search(tx, { sourceTable: Model.KINDS[q.kind], dateFrom: q.dateFrom, dateTo: q.dateTo,
          ...position, locationId, unassigned: locationId === 'unassigned', sellerMode: 'none', sellerRole: 'header_seller', limit: BATCH + 1 }));
        candidates.sort(order); candidates = candidates.slice(0, BATCH + 1);
      }
      const reader = service(tx, s), items = [];
      const matchesHead = row => Search.matches([row.receipt, row.invoice], q.receipt)
        && Search.matches(Model.CUSTOMER_COLUMNS.map(k => row[k]), q.customer)
        && (q.sellerRole === 'line_seller' || Search.matches([row.personnel], q.seller));
      let processed = 0, processedLines = 0, last = null;
      for (const candidate of candidates.slice(0, BATCH)) {
        const row = await document(reader, candidate.id, s, tx, matchesHead); processed++; processedLines += row.lines.length; last = candidate;
        if (row.date !== candidate.businessDate || row.kind !== q.kind || (q.locationId && row.locationId !== q.locationId)) C.fail('IMPORT_HISTORY_INTEGRITY');
        if (row.filtered) continue;
        const sellerValues = q.sellerRole === 'line_seller' ? row.lines.map(l => l.personnel) : [row.personnel];
        if (Search.matches([row.receipt, row.invoice], q.receipt) && Search.matches(sellerValues, q.seller)
          && Search.matches(Model.CUSTOMER_COLUMNS.map(k => row[k]), q.customer)
          && Search.matches([row.receipt, row.invoice, row.description, row.account, ...row.lines.flatMap(l => [l.article, l.description])], q.query)) {
          const { lines, ...summary } = row; items.push(summary);
        }
        if (items.length >= q.limit || processedLines >= 2000) break;
      }
      const more = candidates.length > processed;
      return { items, processed, complete: !more, next: more && last ? protection.seal({ signature, epoch, expires: now() + 1800000, afterDate: last.businessDate, afterId: last.id }, context) : null,
        sourceLabel: backend.source.label, order: 'date_desc', epoch, query: { ...q, cursor: '' } };
    }, { isolation: 'serializable' });
    if (state().signature !== s.signature) C.fail('IMPORT_FORBIDDEN', 403);
    return result;
  }
  async function search(input) {
    const s = state(), q = Model.query(input, { today: today(), projection: s.p });
    if (q.sourceId !== backend.source.id) C.fail('IMPORT_HISTORY_SOURCE_NOT_FOUND', 404);
    if (q.locationId && !s.locations.some(l => l.id === q.locationId) && !(q.locationId === 'unassigned' && s.p.unassigned)) C.fail('IMPORT_FORBIDDEN', 403);
    if (q.sort === 'date' && q.direction === 'desc' && !q.resultSet) {
      const { epoch, ...result } = await scan(q); return result;
    }
    const epoch = await access.transaction(async tx => protection.digest(await backend.epoch(tx)), { isolation: 'serializable' });
    const result = await sortedSearch({ store: resultStore, protection, owner: s.signature, query: q, epoch, scan, now });
    if (state().signature !== s.signature) C.fail('IMPORT_FORBIDDEN', 403);
    return { ...result, sourceLabel: backend.source.label, query: { ...q, cursor: '', resultSet: '' } };
  }
  async function documents(input) {
    C.exact(input, ['ids']);
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 50 || new Set(input.ids).size !== input.ids.length) C.fail('IMPORT_RECEIPT_SELECTION');
    input.ids.forEach(id => C.id(id));
    const s = state();
    const result = await access.transaction(async tx => {
      await backend.epoch(tx); const reader = service(tx, s), items = []; let lines = 0;
      for (const id of input.ids) { const row = await document(reader, id, s, tx); lines += Math.max(1, row.lines.length); if (lines > 2000) C.fail('IMPORT_RECEIPT_EXPORT_LIMIT', 413); items.push(row); }
      return { items, sourceLabel: backend.source.label };
    }, { isolation: 'serializable' });
    if (state().signature !== s.signature) C.fail('IMPORT_FORBIDDEN', 403);
    return result;
  }
  return Object.freeze({ search, documents });
}
module.exports = { createReceiptWorkspace };
