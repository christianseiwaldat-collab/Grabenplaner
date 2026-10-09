'use strict';
const C = require('../../data-import-contract');
const Model = require('../../sales-report-model');
const { createSalesMasterReader } = require('./sales-master-data');
const { createSalesReportCheckpointStore } = require('../../sales-report-checkpoints');
const { ONLINE_LOCATION } = require('../../sales-report-locations');
const { START, readCheckedCashReportBatch } = require('./checked-cash-report-batch');
const linked = ref => !!ref?.targetId && ['linked', 'historical_mapping'].includes(ref.status);
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
      const batch = await readCheckedCashReportBatch({ tx, backend, query: { ...query, dateFrom, dateTo }, cursor: saved,
        projection: s.projection, marginPolicy, onLine: ({ detail, fields: f, refs, parent, head, metric, margin, locationId, reviewIssues }) => {
        const customerNumber = s.projection.customers ? head.fields.KUND_NR : null;
        const customerKey = customerNumber && !/^0+$/.test(customerNumber) ? protection.digest(['report-customer', scopeId, String(customerNumber)]) : null;
        const productGroup = f.Sortiment == null ? 'unassigned' : String(f.Sortiment);
        const merchandiseGroup = groupCategories.get(productGroup) || 'unassigned';
        const seller = linked(refs.line_seller) ? refs.line_seller.targetId : 'unassigned';
        Model.accumulate(saved.state, saved.phase, query, { metric, margin, quantity: f.VKMenge, date: detail.provenance.businessDate,
          reviewIssues,
          receiptKey: protection.digest(['report-receipt', parent]), customerKey,
          productGroup: { id: productGroup, label: groupLabels.get(productGroup) || (productGroup === 'unassigned' ? 'Sortimentsgruppe nicht zugeordnet' : `Sortimentsgruppe ${productGroup}`) },
          merchandiseGroup: { id: merchandiseGroup, label: categoryLabels.get(merchandiseGroup) || (merchandiseGroup === 'unassigned' ? 'WGR nicht zugeordnet' : `WGR ${merchandiseGroup}`) },
          manufacturer: { id: Model.manufacturerKey(f.UMarke), label: String(f.UMarke || '').trim() || 'Hersteller nicht zugeordnet' },
          location: { id: locationId, label: s.locations.find(l => l.id === locationId)?.label || locationId },
          seller: { id: seller, label: seller === 'unassigned' ? 'MA nicht zugeordnet' : `MA ${seller}` } });
      } });
      if (batch.more) Object.assign(saved, { afterDate: batch.afterDate, afterId: batch.afterId });
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
