'use strict';
const C = require('./data-import-contract');
const { buildSalesHistoryProjection } = require('./sales-history-access');
const { buildSalesAnalyticsProjection } = require('./sales-analytics-access');
const METRICS = Object.freeze([
  { id: 'netRevenue', label: 'Umsatz netto', unit: 'EUR' },
  { id: 'grossRevenue', label: 'Umsatz brutto', unit: 'EUR' },
  { id: 'grossMargin', label: 'Rohertrag', unit: 'EUR', permission: 'margin' },
  { id: 'quantity', label: 'Verkaufte Menge (inkl. Retouren)', unit: 'quantity' },
  { id: 'receiptCount', label: 'Beleganzahl', unit: 'count' },
  { id: 'customerCount', label: 'Kundenanzahl (bekannte Konten)', unit: 'count', permission: 'customers' },
  { id: 'revenuePerCustomer', label: 'Umsatz netto / bekanntem Kunden', unit: 'EUR', permission: 'customers' },
  { id: 'marginPerCustomer', label: 'Rohertrag / bekanntem Kunden', unit: 'EUR', permission: 'marginCustomers' },
  { id: 'revenuePerReceipt', label: 'Umsatz netto / Beleg', unit: 'EUR' },
  { id: 'marginRate', label: 'Rohertrag in % vom Nettoumsatz', unit: '%', permission: 'margin' },
]);
const DIMENSIONS = Object.freeze([
  { id: 'merchandiseGroup', label: 'Warengruppe (WGR)' }, { id: 'productGroup', label: 'Sortimentsgruppe' }, { id: 'manufacturer', label: 'Hersteller / Marke' },
  { id: 'location', label: 'Filiale' }, { id: 'seller', label: 'MA (Positionsverkäufer)', permission: 'sellers' },
]);
function reportAuthority(session) {
  const history = buildSalesHistoryProjection(session);
  return { ...history, margin: history.read && buildSalesAnalyticsProjection(session).grossMargin,
    customers: history.customerPurchases, marginCustomers: history.customerPurchases && buildSalesAnalyticsProjection(session).grossMargin };
}
const clean = value => String(value ?? '').normalize('NFC').trim();
const manufacturerKey = value => clean(value).toLocaleLowerCase('de-AT') || 'unassigned';
const isPdfReportQuery = query => [2, 3, 4].includes(query?.reportVersion);
const isTimelineQuery = query => query?.reportVersion === 4 && query.chartType === 'timeline';
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) C.fail('IMPORT_HISTORY_DATE_RANGE');
  return value;
}
function previousYear(value) {
  validDate(value);
  const year = Number(value.slice(0, 4)) - 1, month = Number(value.slice(5, 7)), day = Number(value.slice(8));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}
function normalizeReportQuery(input = {}, { today, projection, locations }) {
  C.exact(input, ['reportVersion', 'sourceId', 'kind', 'dateFrom', 'dateTo', 'comparisonFrom', 'comparisonTo', 'locationId', 'locationIds',
    'manufacturerIds', 'productGroupIds', 'merchandiseGroupIds', 'sellerIds', 'groupBy', 'metrics', 'changes', 'chartMetric', 'orientation', 'chartType', 'timeGrain']);
  if (input.sourceId !== 'compact-cash' || input.kind && input.kind !== 'sales' || input.reportVersion && !isPdfReportQuery(input)) C.fail('IMPORT_HISTORY_KIND');
  const reportVersion = input.reportVersion || 2;
  if (reportVersion < 3 && (input.orientation !== undefined || input.chartType !== undefined)) C.fail('IMPORT_REPORT_SELECTION');
  if (reportVersion < 4 && (input.merchandiseGroupIds !== undefined || input.timeGrain !== undefined)) C.fail('IMPORT_REPORT_SELECTION');
  const orientation = input.orientation || 'portrait', chartType = input.chartType || 'auto';
  const timeline = reportVersion === 4 && chartType === 'timeline', timeGrain = input.timeGrain || 'month';
  if (!['portrait', 'landscape'].includes(orientation) || !['auto', 'bars', 'shares', 'none', ...(reportVersion === 4 ? ['timeline'] : [])].includes(chartType)
    || !['day', 'week', 'month'].includes(timeGrain) || input.timeGrain !== undefined && !timeline) C.fail('IMPORT_REPORT_SELECTION');
  if (!projection.read) C.fail('IMPORT_FORBIDDEN', 403);
  const dateFrom = validDate(input.dateFrom || today.slice(0, 4) + '-01-01'), dateTo = validDate(input.dateTo || today);
  const comparisonFrom = validDate(input.comparisonFrom || previousYear(dateFrom)), comparisonTo = validDate(input.comparisonTo || previousYear(dateTo));
  for (const [from, to] of [[dateFrom, dateTo], [comparisonFrom, comparisonTo]]) {
    if (from > to || to > today || (Date.parse(to) - Date.parse(from)) / 86400000 >= 366) C.fail('IMPORT_HISTORY_DATE_RANGE');
  }
  function selection(value, max = 100, normalize = clean) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || !clean(v) || clean(v).length > 160)) C.fail('IMPORT_REPORT_SELECTION');
    return [...new Set(value.map(normalize))];
  }
  const available = locations.map(l => l.id);
  const requested = selection(input.locationIds ?? (input.locationId ? [input.locationId] : []));
  if (requested.some(id => !available.includes(id))) C.fail('IMPORT_FORBIDDEN', 403);
  const locationIds = requested.length ? requested : available;
  if (!locationIds.length) C.fail('IMPORT_FORBIDDEN', 403);
  const groupBy = selection(input.groupBy ?? ['productGroup', 'manufacturer'], 3);
  if (!groupBy.length && !timeline || timeline && groupBy.length > 1 || groupBy.some(id => !DIMENSIONS.some(d => d.id === id))
    || reportVersion < 4 && groupBy.includes('merchandiseGroup')) C.fail('IMPORT_REPORT_SELECTION');
  const sellerIds = selection(input.sellerIds);
  if ((sellerIds.length || groupBy.includes('seller')) && !projection.sellers) C.fail('IMPORT_FORBIDDEN', 403);
  sellerIds.forEach(C.id);
  const metrics = selection(input.metrics ?? ['netRevenue', 'quantity', 'receiptCount'], METRICS.length);
  if (!metrics.length || metrics.some(id => !METRICS.some(m => m.id === id))) C.fail('IMPORT_REPORT_SELECTION');
  if (metrics.some(id => { const m = METRICS.find(m => m.id === id); return m.permission && !projection[m.permission]; })) C.fail('IMPORT_FORBIDDEN', 403);
  const changes = selection(input.changes ?? ['absolute', 'percent'], 2);
  if (changes.some(id => !['absolute', 'percent'].includes(id))) C.fail('IMPORT_REPORT_SELECTION');
  const chartMetric = input.chartMetric || metrics[0];
  if (!metrics.includes(chartMetric)) C.fail('IMPORT_REPORT_SELECTION');
  return { reportVersion, sourceId: 'compact-cash', dateFrom, dateTo, comparisonFrom, comparisonTo, locationIds,
    productGroupIds: selection(input.productGroupIds, reportVersion >= 3 ? 10 : 300), manufacturerIds: selection(input.manufacturerIds, reportVersion >= 3 ? 10 : 100, manufacturerKey),
    sellerIds, groupBy, metrics, changes, chartMetric, ...(reportVersion >= 3 ? { orientation, chartType } : {}),
    ...(reportVersion === 4 ? { merchandiseGroupIds: selection(input.merchandiseGroupIds, 10), ...(timeline ? { timeGrain } : {}) } : {}) };
}
// Decimal arithmetic stays exact until the explicit output rounding boundary.
function scaled(value, scale = 2) {
  if (typeof value !== 'string' || !/^-?\d{1,20}(?:\.\d{1,324})?$/.test(value)) return null;
  const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const units = BigInt(whole + fraction.slice(0, scale).padEnd(scale, '0')) + (Number(fraction[scale] || 0) >= 5 ? 1n : 0n);
  return negative ? -units : units;
}
function decimal(value, scale = 2) {
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, '0');
  return (value < 0n ? '-' : '') + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
}
function divide(value, divisor) {
  if (divisor === 0n) return null;
  const negative = (value < 0n) !== (divisor < 0n), a = value < 0n ? -value : value, b = divisor < 0n ? -divisor : divisor;
  return (a / b + (a % b * 2n >= b ? 1n : 0n)) * (negative ? -1n : 1n);
}
function comparison(current, previous, scale = 2) {
  if (current === null || previous === null) return { absolute: null, percent: null };
  const a = scaled(current, scale), b = scaled(previous, scale), delta = a - b;
  return { absolute: decimal(delta, scale), percent: b === 0n ? null : decimal(divide(delta * 10000n, b < 0n ? -b : b)) };
}
function positionMargin(unitAmount, quantity) {
  const parse = value => typeof value === 'string' ? /^(-?)(\d{1,20})(?:\.(\d{1,324}))?$/.exec(value) : null;
  const a = parse(unitAmount), b = parse(quantity); if (!a || !b) return null;
  const integer = parts => BigInt(parts[1] + parts[2] + (parts[3] || ''));
  const power = (a[3]?.length || 0) + (b[3]?.length || 0);
  return decimal(divide(integer(a) * integer(b) * 100n, 10n ** BigInt(power)));
}
function bucket() { return { records: 0, checked: 0, review: 0, reviewIssues: {}, excluded: 0, marginMissing: 0, quantityMissing: 0,
  gross: '0', net: '0', margin: '0', quantity: '0', customerNet: '0', customerMargin: '0', customerMarginMissing: 0,
  receipts: {}, customers: {}, anonymousReceipts: {} }; }
function accumulator() { return { processed: 0, current: { sourceRecords: 0, total: bucket(), groups: {} }, comparison: { sourceRecords: 0, total: bucket(), groups: {} } }; }
function add(bucket, line) {
  bucket.records++;
  if (!line.metric) {
    bucket.review++;
    bucket.reviewIssues ||= {};
    for (const issue of new Set(line.reviewIssues?.length ? line.reviewIssues : ['RECEIPT_REVIEW_REQUIRED'])) {
      bucket.reviewIssues[issue] = (bucket.reviewIssues[issue] || 0) + 1;
    }
    return;
  }
  if (['excluded', 'payment', 'voucher_issue', 'uid_clearing'].includes(line.metric.status)) { bucket.excluded++; return; }
  bucket.checked++;
  for (const [key, value] of [['gross', line.metric.gross], ['net', line.metric.net]]) bucket[key] = (BigInt(bucket[key]) + scaled(value)).toString();
  const quantity = ['adjustment', 'deposit'].includes(line.metric.status) ? 0n : scaled(line.quantity, 6);
  if (quantity === null) bucket.quantityMissing++; else bucket.quantity = (BigInt(bucket.quantity) + quantity).toString();
  // Deposits affect revenue on both booking dates, but never goods quantity or
  // margin. Even a missing/source-placeholder margin cannot change that rule.
  const margin = line.metric.status === 'deposit' ? 0n : line.margin === null ? null : scaled(line.margin);
  if (margin === null) bucket.marginMissing++; else bucket.margin = (BigInt(bucket.margin) + margin).toString();
  bucket.receipts[line.receiptKey] = true;
  if (line.customerKey) {
    bucket.customers[line.customerKey] = true;
    bucket.customerNet = (BigInt(bucket.customerNet) + scaled(line.metric.net)).toString();
    if (margin === null) bucket.customerMarginMissing++; else bucket.customerMargin = (BigInt(bucket.customerMargin) + margin).toString();
  } else bucket.anonymousReceipts[line.receiptKey] = true;
}
function accumulate(state, phase, query, line) {
  const period = state[phase]; period.sourceRecords++; state.processed++;
  const timeline = isTimelineQuery(query) && phase === 'current';
  const interval = timeline ? timelineBucket(line.date, query.timeGrain) : null;
  if (timeline) {
    period.timelineSources ||= {}; period.timelineSources[interval] = (period.timelineSources[interval] || 0) + 1;
    period.timelineLocationSources ||= {}; const key = C.canonical([line.location?.id || 'unassigned', interval]);
    period.timelineLocationSources[key] = (period.timelineLocationSources[key] || 0) + 1;
  }
  if (query.productGroupIds.length && !query.productGroupIds.includes(line.productGroup.id)
    || query.merchandiseGroupIds?.length && !query.merchandiseGroupIds.includes(line.merchandiseGroup?.id || 'unassigned')
    || query.manufacturerIds.length && !query.manufacturerIds.includes(line.manufacturer.id)
    || query.sellerIds.length && !query.sellerIds.includes(line.seller.id)) return;
  add(period.total, line);
  const dimensions = query.groupBy.map(id => ({ dimension: id, ...line[id] })), key = C.canonical(dimensions.map(d => [d.dimension, d.id]));
  if (!Object.hasOwn(period.groups, key)) {
    if (Object.keys(period.groups).length >= (timeline ? 50 : 5000)) C.fail('IMPORT_REPORT_GROUP_LIMIT', 413);
    Object.defineProperty(period.groups, key, { enumerable: true, writable: true, configurable: true, value: { dimensions, values: bucket() } });
  }
  add(period.groups[key].values, line);
  if (timeline) { const group = period.groups[key]; group.timeline ||= {}; group.timeline[interval] ||= bucket(); add(group.timeline[interval], line); }
}
function timelineBucket(date, grain) {
  validDate(date);
  if (grain === 'month') return date.slice(0, 7) + '-01';
  if (grain === 'week') { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); }
  return date;
}
function timelineIntervals(query) {
  const result = [], to = timelineBucket(query.dateTo, query.timeGrain);
  let current = timelineBucket(query.dateFrom, query.timeGrain);
  while (current <= to) {
    const next = new Date(current + 'T00:00:00Z');
    if (query.timeGrain === 'month') next.setUTCMonth(next.getUTCMonth() + 1); else next.setUTCDate(next.getUTCDate() + (query.timeGrain === 'week' ? 7 : 1));
    const end = new Date(next.getTime() - 86400000).toISOString().slice(0, 10);
    result.push({ id: current, from: current < query.dateFrom ? query.dateFrom : current, to: end > query.dateTo ? query.dateTo : end });
    if (result.length > 366) C.fail('IMPORT_REPORT_GROUP_LIMIT', 413);
    current = next.toISOString().slice(0, 10);
  }
  return result;
}
function finishTimeline(state, query) {
  const period = state.current, intervals = timelineIntervals(query), groups = Object.values(period.groups);
  if (!groups.length && !query.groupBy.length) groups.push({ dimensions: [], timeline: {} });
  return { metric: query.chartMetric, grain: query.timeGrain, intervals,
    series: groups.map(group => ({ dimensions: group.dimensions, points: intervals.map(interval => {
      const b = group.timeline?.[interval.id] || bucket(), location = group.dimensions.find(d => d.dimension === 'location');
      const sourceRecords = location ? period.timelineLocationSources?.[C.canonical([location.id, interval.id])] || 0 : period.timelineSources?.[interval.id] || 0;
      const value = values(b, { sourceRecords })[query.chartMetric];
      return { date: interval.id, value, checked: b.checked, review: b.review, excluded: b.excluded,
        missingMargin: b.marginMissing, hasSource: sourceRecords > 0 };
    }) })).sort((a, b) => a.dimensions.map(d => d.label).join(' / ').localeCompare(b.dimensions.map(d => d.label).join(' / '), 'de-AT', { numeric: true })) };
}
function values(b, period) {
  // An empty source period is unknown. An absent category within imported data
  // can be zero; it never proves that the imported calendar itself is complete.
  const usable = period.sourceRecords > 0 && b.review === 0;
  const receipts = Object.keys(b.receipts).length, customers = Object.keys(b.customers).length;
  const amount = key => usable ? decimal(BigInt(b[key])) : null;
  const ratio = (key, count, allowed = true) => usable && allowed && count ? decimal(divide(BigInt(b[key]), BigInt(count))) : null;
  return { netRevenue: amount('net'), grossRevenue: amount('gross'), grossMargin: b.marginMissing ? null : amount('margin'),
    quantity: usable && !b.quantityMissing ? decimal(BigInt(b.quantity), 6) : null,
    receiptCount: usable ? String(receipts) : null, customerCount: usable ? String(customers) : null,
    revenuePerCustomer: ratio('customerNet', customers), marginPerCustomer: ratio('customerMargin', customers, !b.customerMarginMissing),
    revenuePerReceipt: ratio('net', receipts), marginRate: usable && !b.marginMissing && BigInt(b.net) > 0n ? decimal(divide(BigInt(b.margin) * 10000n, BigInt(b.net))) : null };
}
function finishReport(state, query) {
  const item = (dimensions, current, previous) => {
    const a = values(current, state.current), b = values(previous, state.comparison);
    // A confirmed total remains unavailable when any selected receipt is open.
    // Publish the checked portion separately so the PDF can label it explicitly;
    // never use this portion to calculate changes against a different coverage.
    const partial = (bucket, period) => bucket.review > 0 && bucket.checked > 0 ? values({ ...bucket, review: 0 }, period) : null;
    const checkedA = partial(current, state.current), checkedB = partial(previous, state.comparison);
    const quality = bucket => ({ records: bucket.records, checked: bucket.checked, review: bucket.review,
      excluded: bucket.excluded, marginMissing: bucket.marginMissing, issues: { ...bucket.reviewIssues } });
    return { dimensions, metrics: Object.fromEntries(query.metrics.map(id => [id, { current: a[id], previous: b[id],
      ...comparison(a[id], b[id], id === 'quantity' ? 6 : ['receiptCount', 'customerCount'].includes(id) ? 0 : 2),
      ...(checkedA?.[id] != null ? { verifiedCurrent: checkedA[id] } : {}),
      ...(checkedB?.[id] != null ? { verifiedPrevious: checkedB[id] } : {}) }])),
      quality: { current: quality(current), previous: quality(previous) } };
  };
  const keys = [...new Set([...Object.keys(state.current.groups), ...Object.keys(state.comparison.groups)])];
  const rows = keys.map(key => item((state.current.groups[key] || state.comparison.groups[key]).dimensions,
    state.current.groups[key]?.values || bucket(), state.comparison.groups[key]?.values || bucket()));
  rows.sort((a, b) => a.dimensions.map(d => d.label).join(' / ').localeCompare(b.dimensions.map(d => d.label).join(' / '), 'de-AT', { numeric: true }));
  return { rows, total: item([], state.current.total, state.comparison.total), processed: state.processed,
    ...(isTimelineQuery(query) ? { timeline: finishTimeline(state, query) } : {}),
    coverage: Object.fromEntries(['current', 'comparison'].map(phase => [phase, { sourceRecords: state[phase].sourceRecords,
      selectedRecords: state[phase].total.records, checked: state[phase].total.checked, review: state[phase].total.review, excluded: state[phase].total.excluded,
      anonymousReceipts: Object.keys(state[phase].total.anonymousReceipts).length, marginMissing: state[phase].total.marginMissing }])) };
}
module.exports = { METRICS, DIMENSIONS, reportAuthority, previousYear, normalizeReportQuery, isPdfReportQuery, isTimelineQuery, timelineBucket, timelineIntervals, manufacturerKey, scaled, decimal, divide, comparison, positionMargin, accumulator, accumulate, finishReport };
