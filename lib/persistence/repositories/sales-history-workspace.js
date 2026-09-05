"use strict";
const C = require('../../data-import-contract');
const { assertPersistenceAccess } = require('../contract');
const { IMPORT_HISTORY_STATEMENTS: S } = require('../statements/import-history');
const { createImportHistoryService } = require('./import-history');
const { buildSalesHistoryProjection } = require('../../sales-history-access');
const { normalizeSalesHistoryQuery, ANALYSIS_LIMIT } = require('../../sales-history-query');
const linked = ref => !!ref?.targetId && ['linked', 'historical_mapping'].includes(ref.status);
const primaryRole = table => table === 'KassenJournal_Details' ? 'location.filiale' : 'location.filialid';
const order = (a, b) => b.businessDate.localeCompare(a.businessDate) || b.id.localeCompare(a.id);
const minor = value => BigInt(value.replace('.', ''));
function amount(value, places) {
  const digits = (value < 0n ? -value : value).toString().padStart(places + 1, '0');
  return (value < 0n ? '-' : '') + (places ? digits.slice(0, -places) + '.' + digits.slice(-places) : digits);
}
// Only trusted composition may supply sources, keys, policies and independently
// verified receipt membership. No HTTP input creates a source or approves rules.
function createSalesHistoryWorkspace({ access, protection, sources, getSession, getActor, getPolicy = () => null,
  getCoverage = () => null, today, now = () => Date.now(), analysisLimit = ANALYSIS_LIMIT }) {
  assertPersistenceAccess(access);
  C.integer(analysisLimit, 1, ANALYSIS_LIMIT);
  if (typeof access.transaction !== 'function' || !Array.isArray(sources) || sources.length > 50
    || typeof getSession !== 'function' || typeof getActor !== 'function' || typeof today !== 'function') C.fail('IMPORT_COMPOSITION_INVALID');
  const registry = sources.map(source => {
    C.exact(source, ['id', 'label', 'scopeId', 'sourceInstance', 'locations', 'snapshots', 'coverageLabel']);
    for (const key of ['id', 'scopeId', 'sourceInstance']) C.id(source[key]);
    C.text(source.label, 160); C.text(source.coverageLabel, 500);
    if (!Array.isArray(source.locations) || source.locations.length > 100 || !Array.isArray(source.snapshots) || source.snapshots.length > 100) C.fail('IMPORT_COMPOSITION_INVALID');
    for (const location of source.locations) { C.exact(location, ['id', 'label']); C.id(location.id); C.text(location.label, 160); }
    for (const snapshot of source.snapshots) { C.exact(snapshot, ['id', 'label']); C.sha(snapshot.id); C.text(snapshot.label, 160); }
    if (new Set(source.locations.map(l => l.id)).size !== source.locations.length || source.locations.some(l => l.id === 'unassigned')) C.fail('IMPORT_COMPOSITION_INVALID');
    return C.freeze(JSON.parse(C.canonical(source)));
  });
  if (new Set(registry.map(s => s.id)).size !== registry.length) C.fail('IMPORT_COMPOSITION_INVALID');
  function state() {
    const session = getSession(), actor = getActor(); C.exact(actor, ['scopeId', 'ownerId']); C.id(actor.scopeId); C.id(actor.ownerId);
    const projection = buildSalesHistoryProjection(session);
    if (!projection.read) C.fail('IMPORT_FORBIDDEN', 403);
    return { actor, projection, signature: protection.digest([actor, projection, String(session.employeeNumber)]) };
  }
  const locations = (source, p) => source.locations.filter(l => p.company || p.locationIds.includes(l.id));
  function context() {
    const { actor, projection } = state();
    const visible = registry.filter(s => s.scopeId === actor.scopeId).map(s => ({ id: s.id, label: s.label,
      locations: locations(s, projection), snapshots: projection.finance ? s.snapshots : [], coverageLabel: s.coverageLabel }));
    return { available: visible.length > 0, projection, sources: visible, analysisLimit, today: today() };
  }
  async function search(input, { customerId = null } = {}) {
    const initial = state(), { actor, projection: p } = initial;
    const query = normalizeSalesHistoryQuery(input, { today: today(), projection: p, customerId });
    const source = registry.find(s => s.id === query.sourceId && s.scopeId === actor.scopeId);
    if (!source) C.fail('IMPORT_HISTORY_SOURCE_NOT_FOUND', 404);
    if (query.snapshot && !source.snapshots.some(s => s.id === query.snapshot)) C.fail('IMPORT_HISTORY_SNAPSHOT_UNKNOWN');
    const allowedLocations = locations(source, p), locationIds = allowedLocations.map(l => l.id);
    if (query.locationId && query.locationId !== 'unassigned' && !locationIds.includes(query.locationId)) C.fail('IMPORT_FORBIDDEN', 403);
    const selectedLocations = query.locationId ? [query.locationId] : [...locationIds, ...(p.unassigned ? ['unassigned'] : [])];
    const querySignature = protection.digest([initial.signature, { ...query, cursor: '' }]);
    const cursorContext = ['sales-history-cursor', actor.scopeId, actor.ownerId];
    let cursor = null;
    if (query.cursor) {
      try { cursor = protection.open(query.cursor, cursorContext); C.exact(cursor, ['signature', 'dataset', 'offset', 'expires']);
        C.sha(cursor.dataset); C.integer(cursor.offset, 1, analysisLimit); C.integer(cursor.expires, 0, Number.MAX_SAFE_INTEGER);
        if (cursor.signature !== querySignature || cursor.expires < now()) C.fail('IMPORT_HISTORY_CURSOR');
      } catch { C.fail('IMPORT_HISTORY_CURSOR'); }
    }
    const result = await access.transaction(async tx => {
      const digest = (kind, id) => id ? protection.digest(['history-reference', actor.scopeId, kind, id]) : null;
      let records = [];
      for (const location of selectedLocations) {
        records.push(...await tx.queryAll(S.search, {
        scopeId: actor.scopeId, sourceInstance: source.sourceInstance, sourceTable: query.table,
        dateFrom: query.dateFrom, dateTo: query.dateTo, locationRole: primaryRole(query.table),
        locationHash: location === 'unassigned' ? null : digest('location', location), unassigned: location === 'unassigned',
        sellerMode: !query.sellerId ? 'none' : query.sellerId === 'unassigned' ? 'unassigned' : 'target',
        sellerRole: query.sellerRole, sellerHash: digest('employee', query.sellerId), customerHash: digest('crm_customer', customerId),
        snapshot: query.snapshot, afterDate: '9999-12-31', afterId: '~', limit: analysisLimit + 1,
      }));
        records.sort(order); records = records.slice(0, analysisLimit + 1);
      }
      records.sort(order);
      const complete = records.length <= analysisLimit;
      records = records.slice(0, analysisLimit);
      const dataset = protection.digest(records.map(r => [r.id, r.revision, r.businessDate]));
      if (cursor && cursor.dataset !== dataset) C.fail('IMPORT_HISTORY_RESULTS_CHANGED', 409);
      const service = createImportHistoryService({ access, executor: tx, protection, getActor: () => actor,
        authorize: value => {
          if (value.sourceInstance && (value.sourceInstance !== source.sourceInstance || value.source !== 'cash')) return false;
          if (value.sourceTable && ![query.table, 'Umsatz_KASSE'].includes(value.sourceTable)) return false;
          if (value.action === 'history.scope') {
            const location = value.locations.find(l => l.role === primaryRole(value.sourceTable));
            return linked(location) ? locationIds.includes(location.targetId) : p.unassigned;
          }
          // Receipt verification reads protected keys inside the transaction only;
          // neither raw customer keys nor raw receipt objects leave this adapter.
          if (value.action === 'history.reconcile') return query.kind === 'sales';
          if (value.action === 'history.reference' && value.targetKind === 'crm_customer') return false;
          // Source receipt fields share the customer-restricted encrypted segment.
          // This adapter is the minimizing boundary: it selects business fields
          // individually below, never returns that segment or any customer key.
          return value.dataClasses.every(c => c === 'internal_business' || (c === 'customer_restricted' && query.kind === 'sales') || (c === 'personnel_restricted' && p.sellers)
            || (c === 'restricted_finance' && p.finance && query.kind !== 'sales'));
        } });
      const policy = query.kind === 'sales' ? await getPolicy(source.id) : null, receipts = new Map(), items = [], days = new Map();
      const unresolved = { article: 0, location: 0, ...(p.sellers ? { lineSeller: 0, headerSeller: 0 } : {}) };
      const issues = new Set(), counts = { records: records.length, checked: 0, review: 0, sales: 0, returns: 0, excluded: 0 };
      let gross = 0n, net = 0n;
      const safeRef = ref => ({ status: ref?.status || 'unassigned', targetId: linked(ref) ? ref.targetId : null });
      for (const record of records) {
        const detail = await service.detail(record.id), f = detail.fields, refs = Object.fromEntries(detail.references.map(r => [r.role, r]));
        const location = refs[primaryRole(query.table)];
        // Revalidate authenticated fields after the index-based preselection.
        if (detail.provenance.businessDate !== record.businessDate || detail.table !== query.table) C.fail('IMPORT_HISTORY_INTEGRITY');
        const row = { id: detail.id, revision: detail.revision, date: record.businessDate, location: safeRef(location),
          provenance: { importedAt: detail.provenance.importedAt, snapshotAt: detail.provenance.snapshotAt, fileSha256: detail.provenance.fileSha256 },
          metric: null, issues: [] };
        if (!linked(location)) unresolved.location++;
        if (query.kind === 'sales') {
          Object.assign(row, { receipt: f.Bonnr, article: f.EAN, description: f.Artikelbezeichnung, quantity: f.VKMenge,
            sourcePrice: f.VK_Preis, articleReference: safeRef(refs.article) });
          if (!linked(refs.article)) unresolved.article++;
          if (p.sellers) {
            row.sellers = { line: safeRef(refs.line_seller), header: safeRef(refs.header_seller) };
            if (!linked(refs.line_seller)) unresolved.lineSeller++;
            if (!linked(refs.header_seller)) unresolved.headerSeller++;
          }
          const parentId = detail.provenance.parentId;
          if (!receipts.has(parentId)) receipts.set(parentId, await service.receipt(parentId, policy, await getCoverage(source.id, parentId)));
          const receipt = receipts.get(parentId), position = receipt.canAggregate ? receipt.positions?.find(l => l.key === f.RepID) : null;
          if (position) {
            row.metric = { ...position, currency: receipt.totals.currency }; delete row.metric.key;
            counts.checked++; counts[position.status === 'sale' ? 'sales' : position.status === 'return' ? 'returns' : 'excluded']++;
            gross += minor(position.gross); net += minor(position.net);
          } else { row.issues = receipt.issues.length ? receipt.issues : ['POSITION_RECONCILIATION_MISSING']; counts.review++; }
        } else {
          Object.assign(row, query.kind === 'daily' ? { receipt: f.ZBon, description: f.KoBeschreibung, account: f.KontoNr,
            inflow: f.Einnahmen, outflow: f.Ausgaben } : { receipt: f.Beleg, description: f.Bezeichnung, account: f.Konto,
            inflow: f.Einzahlung, outflow: f.Auszahlung });
          row.issues = ['SEPARATE_CASH_DATA_NOT_SALES'];
        }
        for (const issue of row.issues) issues.add(issue);
        const day = days.get(row.date) || { date: row.date, records: 0, review: 0, gross: 0n };
        day.records++; if (row.metric) day.gross += minor(row.metric.gross); else day.review++;
        days.set(row.date, day); items.push(row);
      }
      const verified = complete && records.length > 0 && query.kind === 'sales' && !!policy && !counts.review;
      if (!complete) issues.add('ANALYSIS_LIMIT_NARROW_DATE_RANGE');
      const totals = verified ? { currency: policy.currency, gross: amount(gross, policy.minorUnits), net: amount(net, policy.minorUnits),
        tax: amount(gross - net, policy.minorUnits) } : null;
      const offset = cursor?.offset || 0, nextOffset = offset + query.limit;
      const next = nextOffset < items.length ? protection.seal({ signature: querySignature, dataset, offset: nextOffset, expires: now() + 900000 }, cursorContext) : null;
      return { items: items.slice(offset, nextOffset), next, query: { ...query, cursor: '' },
        coverage: { label: source.coverageLabel, complete, limit: analysisLimit, counts, unresolved,
          metricState: verified ? 'verified' : 'review_required', issues: [...issues].sort(),
          scope: complete ? 'matching_imported_records' : 'bounded_selection_not_period_total', missingDays: 'unknown_not_zero' },
        totals, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(day => ({ date: day.date, records: day.records,
          review: day.review, gross: verified ? amount(day.gross, policy.minorUnits) : null })) };
    }, { isolation: 'serializable' });
    if (state().signature !== initial.signature) C.fail('IMPORT_FORBIDDEN', 403);
    return result;
  }
  return Object.freeze({ context, search });
}
module.exports = { createSalesHistoryWorkspace };
