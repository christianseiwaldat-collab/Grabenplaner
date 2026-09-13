'use strict';
const C = require('../../data-import-contract');
const Model = require('../../sales-report-model');
const { createSalesMasterReader } = require('./sales-master-data');
const { createSalesReportCheckpointStore } = require('../../sales-report-checkpoints');
const { ONLINE_LOCATION, isOnlineSource } = require('../../sales-report-locations');
const linked = ref => !!ref?.targetId && ['linked', 'historical_mapping'].includes(ref.status);
const START = { afterDate: '9999-12-31', afterId: '~' }, BATCH = 200;
function createSalesReportWorkspace({ access, protection, backend, getSession, scopeId, today, marginPolicy = null,
  checkpointStore = createSalesReportCheckpointStore() }) {
  function state() {
    const session = getSession(), projection = Model.reportAuthority(session);
    if (!projection.read || backend.source.scopeId !== scopeId) C.fail('IMPORT_FORBIDDEN', 403);
    const locations = [...backend.source.locations.filter(l => projection.company || projection.locationIds.includes(l.id)), ...(projection.company ? [ONLINE_LOCATION] : [])];
    return { session, projection, locations, signature: protection.digest([scopeId, session.employeeNumber, session.accountId || '', projection]) };
  }
  function normalize(input) { const s = state(); return Model.normalizeReportQuery(input, { today: today(), ...s }); }
  async function metadata() {
    const s = state(), reader = createSalesMasterReader({ protection, scopeId });
    return access.transaction(async tx => {
      await backend.epoch(tx);
      const groups = await reader.dictionary(tx, 'ARTIKEL_Sortimente', ['Sortiment', 'Bezeichnung', 'Warengruppe']);
      const merchandiseGroups = await reader.dictionary(tx, 'ARTIKEL_Warengruppen', ['Warengruppe', 'Bezeichnung']);
      const brands = await reader.dictionary(tx, 'Marken', ['Marke']);
      // Company-wide principals can select authenticated personnel bindings.
      // Scoped readers may enter known personnel numbers without an unrelated
      // company's personnel directory being disclosed by this selector.
      const sellers = s.projection.sellers && s.projection.company ? await backend.reportSellerOptions(tx) : [];
      return { today: today(), source: { ...backend.source, locations: s.locations }, projection: s.projection, locations: s.locations,
        productGroups: groups.map(g => ({ id: String(g.Sortiment), label: `${g.Sortiment} · ${g.Bezeichnung || 'Ohne Bezeichnung'}`, category: g.Warengruppe == null ? '' : String(g.Warengruppe) }))
          .sort((a, b) => a.label.localeCompare(b.label, 'de-AT', { numeric: true })),
        merchandiseGroups: merchandiseGroups.map(g => ({ id: String(g.Warengruppe), label: `${g.Warengruppe} · ${g.Bezeichnung || 'Ohne Bezeichnung'}` }))
          .sort((a, b) => a.label.localeCompare(b.label, 'de-AT', { numeric: true })),
        manufacturers: [...new Map(brands.filter(b => b.Marke).map(b => [Model.manufacturerKey(b.Marke), { id: Model.manufacturerKey(b.Marke), label: b.Marke }])).values()]
          .sort((a, b) => a.label.localeCompare(b.label, 'de-AT', { numeric: true })),
        sellers, marginStatus: marginPolicy ? 'confirmed' : 'unconfirmed',
        metrics: Model.METRICS.filter(m => !m.permission || s.projection[m.permission]),
        dimensions: Model.DIMENSIONS.filter(d => !d.permission || s.projection[d.permission]) };
    }, { isolation: 'serializable', readOnly: true });
  }
  async function step(input, metadata, checkpoint = null) {
    const s = state(), query = normalize(input);
    const signature = protection.digest([s.signature, query, marginPolicy]);
    const context = ['sales-report-checkpoint-v2', scopeId, s.session.employeeNumber];
    const saved = checkpoint ? checkpointStore.take(protection, context, checkpoint) : { signature, phase: 'current', ...START, state: Model.accumulator(), epoch: null };
    if (saved.signature !== signature) C.fail('IMPORT_FORBIDDEN', 403);
    const groupLabels = new Map(metadata.productGroups.map(g => [g.id, g.label]));
    const groupCategories = new Map(metadata.productGroups.map(g => [g.id, String(g.category ?? '')]));
    const categoryLabels = new Map((metadata.merchandiseGroups || []).map(g => [g.id, g.label]));
    await access.transaction(async tx => {
      const epoch = C.fingerprint(await backend.epoch(tx));
      if (saved.epoch && saved.epoch !== epoch) C.fail('IMPORT_HISTORY_ANALYSIS_CHANGED', 409);
      saved.epoch = epoch;
      const current = saved.phase === 'current';
      const dateFrom = current ? query.dateFrom : query.comparisonFrom, dateTo = current ? query.dateTo : query.comparisonTo;
      let records = [];
      for (const locationId of query.locationIds) {
        if (locationId === ONLINE_LOCATION.id) records.push(...await backend.searchReportOnline(tx, { dateFrom, dateTo, ...saved, limit: BATCH + 1 }));
        else records.push(...(await backend.search(tx, { sourceTable: 'Umsatz_Kasse_Details', dateFrom, dateTo, ...saved,
          locationId, unassigned: false, sellerId: '', sellerMode: 'none', sellerRole: 'line_seller', customerId: null, snapshot: null, limit: BATCH + 1 }))
          .map(r => ({ ...r, physicalMatch: true })));
        const unique = new Map();
        for (const record of records) unique.set(record.id, { ...unique.get(record.id), ...record });
        records = [...unique.values()];
        records.sort((a, b) => b.businessDate.localeCompare(a.businessDate) || b.id.localeCompare(a.id));
        records = records.slice(0, BATCH + 1);
      }
      const more = records.length > BATCH;
      const reader = backend.service(tx, value => {
        if (value.source !== 'cash' || value.sourceInstance !== 'tradefoto-cash' || !['Umsatz_Kasse_Details', 'Umsatz_KASSE'].includes(value.sourceTable)) return false;
        if (value.action === 'history.scope') {
          const loc = value.locations.find(l => l.role === 'location.filialid');
          return linked(loc) && query.locationIds.includes(loc.targetId)
            || s.projection.company && query.locationIds.includes(ONLINE_LOCATION.id) && isOnlineSource(value.sourceLocationId);
        }
        if (value.action === 'history.reference' && value.targetKind === 'crm_customer') return false;
        return value.dataClasses.every(k => ['internal_business', 'customer_restricted'].includes(k)
          || k === 'personnel_restricted' && s.projection.sellers || k === 'catalog_costs' && s.projection.margin && !!marginPolicy);
      });
      const receipts = new Map();
      for (const record of records.slice(0, BATCH)) {
        if (record.onlineCandidate && !record.physicalMatch && !await backend.isReportOnline(tx, record.id)) continue;
        const detail = await reader.detail(record.id), f = detail.fields, refs = Object.fromEntries(detail.references.map(r => [r.role, r]));
        if (detail.table !== 'Umsatz_Kasse_Details' || detail.provenance.businessDate !== record.businessDate) C.fail('IMPORT_HISTORY_INTEGRITY');
        const parent = detail.provenance.parentId;
        if (!receipts.has(parent)) receipts.set(parent, { head: await reader.detail(parent), checked: await reader.receipt(parent) });
        const { head, checked } = receipts.get(parent);
        const metric = checked.canAggregate ? checked.positions.find(m => m.key === f.RepID) : null;
        let margin = null;
        if (metric && !['excluded', 'payment', 'voucher_issue', 'uid_clearing', 'deposit'].includes(metric.status) && marginPolicy && s.projection.margin) {
          margin = Model.positionMargin(f[marginPolicy.field], f[marginPolicy.quantityField]);
        }
        const customerNumber = s.projection.customers ? head.fields.KUND_NR : null;
        const customerKey = customerNumber && !/^0+$/.test(customerNumber) ? protection.digest(['report-customer', scopeId, String(customerNumber)]) : null;
        const locationId = query.locationIds.includes(ONLINE_LOCATION.id) && isOnlineSource(f.Filialid) ? ONLINE_LOCATION.id : refs['location.filialid']?.targetId;
        const productGroup = f.Sortiment == null ? 'unassigned' : String(f.Sortiment);
        const merchandiseGroup = groupCategories.get(productGroup) || 'unassigned';
        const seller = linked(refs.line_seller) ? refs.line_seller.targetId : 'unassigned';
        Model.accumulate(saved.state, saved.phase, query, { metric, margin, quantity: f.VKMenge, date: detail.provenance.businessDate,
          reviewIssues: metric ? [] : checked.issues,
          receiptKey: protection.digest(['report-receipt', parent]), customerKey,
          productGroup: { id: productGroup, label: groupLabels.get(productGroup) || (productGroup === 'unassigned' ? 'Sortimentsgruppe nicht zugeordnet' : `Sortimentsgruppe ${productGroup}`) },
          merchandiseGroup: { id: merchandiseGroup, label: categoryLabels.get(merchandiseGroup) || (merchandiseGroup === 'unassigned' ? 'WGR nicht zugeordnet' : `WGR ${merchandiseGroup}`) },
          manufacturer: { id: Model.manufacturerKey(f.UMarke), label: String(f.UMarke || '').trim() || 'Hersteller nicht zugeordnet' },
          location: { id: locationId, label: s.locations.find(l => l.id === locationId)?.label || locationId },
          seller: { id: seller, label: seller === 'unassigned' ? 'MA nicht zugeordnet' : `MA ${seller}` } });
      }
      if (more) Object.assign(saved, { afterDate: records[BATCH - 1].businessDate, afterId: records[BATCH - 1].id });
      else if (current && !Model.isTimelineQuery(query)) Object.assign(saved, { phase: 'comparison', ...START });
      else saved.phase = 'complete';
    }, { isolation: 'serializable', readOnly: true });
    if (state().signature !== s.signature) C.fail('IMPORT_FORBIDDEN', 403);
    const complete = saved.phase === 'complete';
    return { analysis: { complete, processed: saved.state.processed, phase: saved.phase,
      cursor: complete ? null : checkpointStore.put(protection, context, saved) },
      report: complete ? Model.finishReport(saved.state, query) : null };
  }
  return Object.freeze({ normalize, metadata, step });
}
module.exports = { createSalesReportWorkspace };
