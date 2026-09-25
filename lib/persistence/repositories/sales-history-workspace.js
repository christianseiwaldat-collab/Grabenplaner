"use strict";
const crypto = require('node:crypto');
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
const START = Object.freeze({ afterDate: '9999-12-31', afterId: '~' }), TTL = 900000;
function amount(value, places) {
  const digits = (value < 0n ? -value : value).toString().padStart(places + 1, '0');
  return (value < 0n ? '-' : '') + (places ? digits.slice(0, -places) + '.' + digits.slice(-places) : digits);
}
// Ephemeral, bounded, encrypted accumulators. Restart/expiry requires a new
// analysis, never a partial total. No source rows or personal fields are cached.
function createSalesHistoryAnalysisStore() { return { entries: new Map(), busy: new Set() }; }
// Only trusted composition supplies sources, keys, policies and independently
// verified receipt membership. No HTTP input approves a source or a sales rule.
function createSalesHistoryWorkspace({ access, protection, sources, getSession, getActor, getPolicy = () => null,
  getCoverage = () => null, today, now = () => Date.now(), analysisLimit = ANALYSIS_LIMIT, retainCompletedAnalyses = true,
  analysisStore = createSalesHistoryAnalysisStore(), backend = null, articleResolverFactory = null }) {
  assertPersistenceAccess(access); C.integer(analysisLimit, 1, ANALYSIS_LIMIT);
  if (typeof access.transaction !== 'function' || !Array.isArray(sources) || sources.length > 50
    || typeof getSession !== 'function' || typeof getActor !== 'function' || typeof today !== 'function'
    || !(analysisStore.entries instanceof Map) || !(analysisStore.busy instanceof Set)) C.fail('IMPORT_COMPOSITION_INVALID');
  const registry = sources.map(source => {
    C.exact(source, ['id', 'label', 'scopeId', 'sourceInstance', 'locations', 'snapshots', 'coverageLabel', 'coverageRevision']);
    for (const key of ['id', 'scopeId', 'sourceInstance']) C.id(source[key]);
    C.text(source.label, 160); C.text(source.coverageLabel, 500);
    if (source.coverageRevision) C.sha(source.coverageRevision);
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
    return { actor, projection, signature: protection.digest([actor, projection, String(session.employeeNumber), String(session.accountId || '')]) };
  }
  const locations = (source, p) => source.locations.filter(l => p.company || p.locationIds.includes(l.id));
  function context() {
    const { actor, projection } = state();
    const visible = registry.filter(s => s.scopeId === actor.scopeId).map(s => ({ id: s.id, label: s.label,
      locations: locations(s, projection), snapshots: projection.finance ? s.snapshots : [], coverageLabel: s.coverageLabel }));
    return { available: visible.length > 0, projection, sources: visible, analysisLimit, analysisMode: 'incremental_full_period', today: today() };
  }
  async function execute(input, { customerId = null } = {}, analysisCursor = null) {
    const initial = state(), { actor, projection: p } = initial;
    const query = normalizeSalesHistoryQuery(input, { today: today(), projection: p, customerId });
    const source = registry.find(s => s.id === query.sourceId && s.scopeId === actor.scopeId);
    if (!source) C.fail('IMPORT_HISTORY_SOURCE_NOT_FOUND', 404);
    if (query.snapshot && !source.snapshots.some(s => s.id === query.snapshot)) C.fail('IMPORT_HISTORY_SNAPSHOT_UNKNOWN');
    const locationIds = locations(source, p).map(l => l.id);
    if (query.locationId && query.locationId !== 'unassigned' && !locationIds.includes(query.locationId)) C.fail('IMPORT_FORBIDDEN', 403);
    const selectedLocations = query.locationId ? [query.locationId] : [...locationIds, ...(p.unassigned ? ['unassigned'] : [])];
    const signature = protection.digest([initial.signature, { ...query, cursor: '' }]);
    const ownerKey = protection.digest([actor, String(getSession()?.accountId || '')]);
    const cursorContext = ['sales-history-cursor-v2', actor.scopeId, actor.ownerId];
    const aggregateContext = id => ['sales-history-analysis-v1', actor.scopeId, actor.ownerId, id];
    for (const [id, entry] of analysisStore.entries) if (entry.expires < now() && !analysisStore.busy.has(id)) analysisStore.entries.delete(id);
    let token = null, analysisId = null;
    if (query.cursor || analysisCursor) {
      try {
        const encoded = analysisCursor || query.cursor;
        if (typeof encoded !== 'string' || encoded.length > 1400) C.fail('IMPORT_HISTORY_CURSOR');
        token = protection.open(encoded, cursorContext);
        C.exact(token, ['signature', 'dataset', 'analysisId', 'expires', 'afterDate', 'afterId', 'revision']);
        C.sha(token.dataset); C.id(token.analysisId); C.integer(token.expires, 0, Number.MAX_SAFE_INTEGER);
        if (token.signature !== signature || token.expires < now()) C.fail('IMPORT_HISTORY_CURSOR');
        if (analysisCursor) C.integer(token.revision, 1, Number.MAX_SAFE_INTEGER);
        else { C.text(token.afterDate, 10); C.id(token.afterId); }
        analysisId = token.analysisId;
      } catch { C.fail('IMPORT_HISTORY_CURSOR'); }
    } else {
      const own = [...analysisStore.entries].filter(([id, saved]) => saved.ownerKey === ownerKey && !analysisStore.busy.has(id)).sort((a, b) => a[1].expires - b[1].expires);
      while (own.length >= 8) analysisStore.entries.delete(own.shift()[0]);
      const pending = [...analysisStore.busy].filter(id => !analysisStore.entries.has(id)).length;
      if (analysisStore.entries.size + pending >= 64) C.fail('IMPORT_HISTORY_ANALYSIS_BUSY', 429);
      analysisId = crypto.randomUUID();
    }
    if (analysisStore.busy.has(analysisId)) C.fail('IMPORT_HISTORY_ANALYSIS_BUSY', 409);
    analysisStore.busy.add(analysisId);
    try {
      const work = await access.transaction(async tx => {
        const policy = query.kind === 'sales' ? await getPolicy(source.id) : null;
        // Every archive append/undo bumps an atomic random epoch; import status
        // revisions additionally invalidate analyses that started during apply.
        const dataset = protection.digest([backend ? await backend.epoch(tx) : await tx.queryOne(S.epoch, { scopeId: actor.scopeId }), policy, source]);
        if (token && token.dataset !== dataset) C.fail('IMPORT_HISTORY_RESULTS_CHANGED', 409);
        let aggregate;
        if (token) {
          const saved = analysisStore.entries.get(analysisId);
          if (!saved || saved.expires < now()) C.fail('IMPORT_HISTORY_ANALYSIS_EXPIRED', 409);
          aggregate = protection.open(saved.payload, aggregateContext(analysisId));
          if (aggregate.signature !== signature || aggregate.dataset !== dataset) C.fail('IMPORT_HISTORY_RESULTS_CHANGED', 409);
          if (analysisCursor && token.revision !== aggregate.revision) C.fail('IMPORT_HISTORY_ANALYSIS_CHANGED', 409);
        } else aggregate = { signature, dataset, revision: 0, ...START, complete: false,
          counts: { records: 0, checked: 0, review: 0, sales: 0, returns: 0, excluded: 0 },
          unresolved: { article: 0, location: 0, ...(p.sellers ? { lineSeller: 0, headerSeller: 0 } : {}) },
          issues: [], days: {}, gross: '0', net: '0' };
        const advancing = !query.cursor && !aggregate.complete;
        const position = query.cursor ? token : aggregate;
        const budget = advancing ? analysisLimit : Math.min(query.limit, analysisLimit);
        const digest = (kind, id) => id ? protection.digest(['history-reference', actor.scopeId, kind, id]) : null;
        let records = [];
        for (const location of selectedLocations) {
          const parameters = {
            scopeId: actor.scopeId, sourceInstance: source.sourceInstance, sourceTable: query.table,
            dateFrom: query.dateFrom, dateTo: query.dateTo, locationRole: primaryRole(query.table),
            locationHash: location === 'unassigned' ? null : digest('location', location), unassigned: location === 'unassigned',
            sellerMode: !query.sellerId ? 'none' : query.sellerId === 'unassigned' ? 'unassigned' : 'target',
            sellerRole: query.sellerRole, sellerHash: digest('employee', query.sellerId), customerHash: digest('crm_customer', customerId),
            snapshot: query.snapshot, afterDate: position.afterDate, afterId: position.afterId, limit: budget + 1,
          };
          records.push(...await (backend ? backend.search(tx, { ...parameters, locationId: location, sellerId: query.sellerId, customerId }) : tx.queryAll(S.search, parameters)));
          records.sort(order); records = records.slice(0, budget + 1);
        }
        const more = records.length > budget; records = records.slice(0, budget);
        const authorize = value => {
            if (value.sourceInstance && (value.sourceInstance !== source.sourceInstance || value.source !== 'cash')) return false;
            if (value.sourceTable && ![query.table, 'Umsatz_KASSE'].includes(value.sourceTable)) return false;
            if (value.action === 'history.scope') {
              const location = value.locations.find(l => l.role === primaryRole(value.sourceTable));
              return linked(location) ? locationIds.includes(location.targetId) : p.unassigned;
            }
            if (value.action === 'history.reconcile') return query.kind === 'sales';
            if (value.action === 'history.reference' && value.targetKind === 'crm_customer') return !!customerId;
            // The adapter minimizes shared source segments; no raw customer key
            // or receipt object leaves this transaction, even without CRM rights.
            return value.dataClasses.every(c => c === 'internal_business' || (c === 'customer_restricted' && query.kind === 'sales')
              || (c === 'personnel_restricted' && p.sellers) || (c === 'restricted_finance' && p.finance && query.kind !== 'sales'));
          };
        const service = backend ? backend.service(tx, authorize) : createImportHistoryService({ access, executor: tx, protection, getActor: () => actor, authorize });
        const receipts = new Map(), items = [];
        const safeRef = ref => ({ status: ref?.status || 'unassigned', targetId: linked(ref) ? ref.targetId : null });
        for (const record of records) {
          const detail = await service.detail(record.id), f = detail.fields, refs = Object.fromEntries(detail.references.map(r => [r.role, r]));
          const location = refs[primaryRole(query.table)];
          if (detail.provenance.businessDate !== record.businessDate || detail.table !== query.table) C.fail('IMPORT_HISTORY_INTEGRITY');
          // Authenticated references must agree with EVERY indexed filter, not
          // only the role/branch scope (including company-wide and CRM queries).
          if (query.locationId && (linked(location) ? location.targetId : 'unassigned') !== query.locationId) C.fail('IMPORT_HISTORY_INTEGRITY');
          if (query.sellerId && (linked(refs[query.sellerRole]) ? refs[query.sellerRole].targetId : 'unassigned') !== query.sellerId) C.fail('IMPORT_HISTORY_INTEGRITY');
          if (customerId && (!linked(refs.customer) || refs.customer.targetId !== customerId)) C.fail('IMPORT_HISTORY_INTEGRITY');
          const row = { id: detail.id, revision: detail.revision, date: record.businessDate, location: safeRef(location),
            provenance: { importedAt: detail.provenance.importedAt, snapshotAt: detail.provenance.snapshotAt, fileSha256: detail.provenance.fileSha256 },
            metric: null, issues: [] };
          if (query.kind === 'sales') {
            Object.assign(row, { receipt: f.Bonnr, article: f.EAN, description: f.Artikelbezeichnung, quantity: f.VKMenge,
              sourcePrice: f.VK_Preis, articleReference: safeRef(refs.article) });
            if(articleResolverFactory){row.articleDisplay=await articleResolverFactory(tx).resolve(f.EAN,row.date);row.displayDescription=row.description||row.articleDisplay.label||'';}
            if (p.sellers) row.sellers = { line: safeRef(refs.line_seller), header: safeRef(refs.header_seller) };
            const parentId = detail.provenance.parentId;
            if (!receipts.has(parentId)) receipts.set(parentId, await service.receipt(parentId, policy, await getCoverage(source.id, parentId)));
            const receipt = receipts.get(parentId), checked = receipt.canAggregate ? receipt.positions?.find(l => l.key === f.RepID) : null;
            if (checked) { row.metric = { ...checked, currency: receipt.totals.currency }; delete row.metric.key; }
            else row.issues = receipt.issues.length ? receipt.issues : ['POSITION_RECONCILIATION_MISSING'];
          } else {
            Object.assign(row, query.kind === 'daily' ? { receipt: f.ZBon, description: f.KoBeschreibung, account: f.KontoNr,
              inflow: f.Einnahmen, outflow: f.Ausgaben } : { receipt: f.Beleg, description: f.Bezeichnung, account: f.Konto,
              inflow: f.Einzahlung, outflow: f.Auszahlung });
            row.issues = ['SEPARATE_CASH_DATA_NOT_SALES'];
          }
          if (advancing) {
            const a = aggregate, counts = a.counts; counts.records++;
            if (!linked(location)) a.unresolved.location++;
            if (query.kind === 'sales') {
              if (!linked(refs.article)) a.unresolved.article++;
              if (p.sellers) { if (!linked(refs.line_seller)) a.unresolved.lineSeller++; if (!linked(refs.header_seller)) a.unresolved.headerSeller++; }
              if (row.metric) {
                counts.checked++;
                const countKey = row.metric.status === 'sale' ? 'sales' : row.metric.status === 'return' ? 'returns' : row.metric.status === 'adjustment' ? 'adjustments' : row.metric.status === 'deposit' ? 'deposits' : row.metric.status === 'payment' ? 'payments' : row.metric.status === 'voucher_issue' ? 'voucherIssues' : row.metric.status === 'uid_clearing' ? 'uidClearings' : 'excluded';
                counts[countKey] = (counts[countKey] || 0) + 1;
                a.gross = (BigInt(a.gross) + minor(row.metric.gross)).toString(); a.net = (BigInt(a.net) + minor(row.metric.net)).toString();
              } else counts.review++;
            } else counts.review++;
            a.issues = [...new Set([...a.issues, ...row.issues])].sort();
            const day = a.days[row.date] ||= { date: row.date, records: 0, review: 0, gross: '0' };
            day.records++; if (row.metric) day.gross = (BigInt(day.gross) + minor(row.metric.gross)).toString(); else day.review++;
          }
          items.push(row);
        }
        if (advancing) {
          aggregate.complete = !more; aggregate.revision++;
          if (records.length) Object.assign(aggregate, { afterDate: records.at(-1).businessDate, afterId: records.at(-1).id });
        }
        const verified = aggregate.complete && aggregate.counts.records > 0 && query.kind === 'sales' && !!policy && !aggregate.counts.review;
        const totals = verified ? { currency: policy.currency, gross: amount(BigInt(aggregate.gross), policy.minorUnits),
          net: amount(BigInt(aggregate.net), policy.minorUnits), tax: amount(BigInt(aggregate.gross) - BigInt(aggregate.net), policy.minorUnits) } : null;
        const page = analysisCursor ? [] : items.slice(0, query.limit), expires = now() + TTL;
        const baseToken = { signature, dataset, analysisId, expires };
        const next = !analysisCursor && page.length && (items.length > page.length || more)
          ? protection.seal({ ...baseToken, afterDate: page.at(-1).date, afterId: page.at(-1).id }, cursorContext) : null;
        return { aggregate, expires, result: { items: page, next, query: { ...query, cursor: '' }, totals,
          analysis: { complete: aggregate.complete, processed: aggregate.counts.records, batchSize: analysisLimit,
            cursor: aggregate.complete ? null : protection.seal({ ...baseToken, revision: aggregate.revision }, cursorContext) },
          coverage: { label: source.coverageLabel, complete: aggregate.complete, limit: analysisLimit,
            counts: aggregate.counts, unresolved: aggregate.unresolved, metricState: verified ? 'verified' : 'review_required',
            issues: aggregate.issues, scope: aggregate.complete ? 'matching_imported_records' : 'analysis_in_progress_not_period_total', missingDays: 'unknown_not_zero' },
          days: Object.values(aggregate.days).sort((a, b) => a.date.localeCompare(b.date)).map(day => ({ date: day.date, records: day.records,
            review: day.review, gross: verified ? amount(BigInt(day.gross), policy.minorUnits) : null })) } };
      }, { isolation: 'serializable', readOnly: true });
      if (state().signature !== initial.signature) C.fail('IMPORT_FORBIDDEN', 403);
      if (!retainCompletedAnalyses && work.aggregate.complete) analysisStore.entries.delete(analysisId);
      else analysisStore.entries.set(analysisId, { ownerKey, expires: work.expires, payload: protection.seal(work.aggregate, aggregateContext(analysisId)) });
      return work.result;
    } finally { analysisStore.busy.delete(analysisId); }
  }
  return Object.freeze({ context, search: (input, options) => execute(input, options),
    analyze(input, options) { C.exact(input, ['query', 'cursor']); if (!input.cursor || input.query?.cursor) C.fail('IMPORT_HISTORY_CURSOR');
      return execute(input.query, options, input.cursor); } });
}
module.exports = { createSalesHistoryWorkspace, createSalesHistoryAnalysisStore };
