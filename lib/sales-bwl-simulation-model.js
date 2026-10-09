'use strict';
const C = require('./data-import-contract');
const D = require('./tradefoto-bestell/decimal');
const Report = require('./sales-article-report-model');
const { projectionFor } = require('./tradefoto-bestell/access');
const LIMITS = Object.freeze({ rows: Report.MAX_ROWS, scanned: Report.MAX_SCANNED, variants: 20, snapshotBytes: 8 * 1024 * 1024, horizonDays: 365 });
const DEFAULTS = Object.freeze({ discountPercent: '10', sellThroughPercent: '50', horizonDays: 30, additionalCosts: '0' });
const NOTE = 'Szenario auf Basis des importierten Bestands und aktuell akzeptierter Artikelpreise. Die Abverkaufsquote ist eine Annahme für den gewählten Zeitraum, keine Nachfrageprognose. Erwartete Mengen dürfen anteilig sein; Artikelmengen können verschiedene Einheiten haben. Zusatzkosten werden einmal vom gesamten Szenario-Rohertrag abgezogen. Keine Preisänderung oder Liquiditätsprognose.';
const COLUMNS = Object.freeze([
  ['articleNumber', 'Artikelnummer', 130], ['description', 'Bezeichnung', 300], ['assortment', 'Sortimentsart', 140], ['location', 'Filiale', 160],
  ['quantity', 'Bestand', 100], ['scenarioQuantity', 'Szenariomenge', 130],
  ['retailGross', 'EH-VK brutto', 140, 'prices'], ['retailNet', 'EH-VK netto', 140, 'prices'],
  ['scenarioPriceGross', 'Szenariopreis brutto', 160, 'prices'], ['scenarioPriceNet', 'Szenariopreis netto', 160, 'prices'],
  ['scenarioGrossRevenue', 'Szenarioerlös brutto', 170, 'prices'], ['scenarioNetRevenue', 'Szenarioerlös netto', 170, 'prices'],
  ['averageCost', 'Ø EK netto', 130, 'costs'], ['scenarioCost', 'Szenariowareneinsatz', 170, 'costs'],
  ['scenarioGrossMargin', 'Szenario-Rohertrag', 170, 'margin'], ['scenarioMarginPercent', 'Szenario-RE %', 130, 'margin'], ['status', 'Prüfung', 240],
].map(([id, label, width, permission]) => Object.freeze({ id, label, width, type: ['quantity', 'scenarioQuantity'].includes(id) ? 'decimal' : id === 'scenarioMarginPercent' ? 'percent' : permission ? 'money' : 'text', ...(permission ? { permission } : {}) })));
function authority(session) {
  const caps = Report.capabilities(session), stock = projectionFor(session);
  if (!caps.read || session?.active === false || session?.employeeActive === false || session?.isEmployee === false || session?.sessionKind === 'organization'
    || session?.mustChangePassword || !session?.employeeNumber) C.fail('BWL_SIMULATION_FORBIDDEN', 403);
  const ownerId = String(session.employeeNumber), accountId = String(session.accountId || '');
  const permissions = [...new Set(session.permissions || [])].sort(), scopes = (session.scopes || []).map(s => ({ locationId: String(s.locationId ?? s.location_id ?? ''),
    departmentId: s.departmentId ?? s.department_id ?? null })).sort((a, b) => C.canonical(a).localeCompare(C.canonical(b)));
  const identity = C.canonical({ id: String(session.id || ''), ownerId, accountId, role: session.role || '', sessionKind: session.sessionKind || 'employee', permissions, scopes,
    active: session.active !== false, employeeActive: session.employeeActive !== false, isEmployee: session.isEmployee !== false, mustChangePassword: !!session.mustChangePassword, caps, stock });
  return Object.freeze({ identity, ownerId, accountId, caps, stock });
}
function columnsFor(caps) { return COLUMNS.filter(c => !c.permission || caps[c.permission]); }
function filters(input = {}, caps) {
  C.exact(input, ['query', 'assortment', 'locations', 'stock']);
  let q;
  try { q = Report.normalizeFilters(input, caps); }
  catch (error) { if (error.status === 400) C.fail('BWL_SIMULATION_FILTERS_INVALID'); throw error; }
  return { query: q.query, assortment: q.assortment, locations: q.locations, stock: q.stock };
}
function assumptions(input = {}) {
  C.exact(input, ['discountPercent', 'sellThroughPercent', 'horizonDays', 'additionalCosts']);
  const decimal = (v, fallback, max, places = 6) => {
    v ??= fallback;
    if (typeof v !== 'string' || !new RegExp('^(?:0|[1-9]\\d{0,11})(?:\\.\\d{1,' + places + '})?$').test(v)
      || D.compare(v, '0') < 0 || D.compare(v, max) > 0) C.fail('BWL_SIMULATION_ASSUMPTIONS_INVALID');
    return D.add(v, '0');
  };
  const horizonDays = input.horizonDays ?? DEFAULTS.horizonDays; C.integer(horizonDays, 1, LIMITS.horizonDays);
  return { discountPercent: decimal(input.discountPercent, DEFAULTS.discountPercent, '100'), sellThroughPercent: decimal(input.sellThroughPercent, DEFAULTS.sellThroughPercent, '100'),
    horizonDays, additionalCosts: decimal(input.additionalCosts, DEFAULTS.additionalCosts, '999999999999') };
}
function normalize(input, caps) { C.exact(input, ['filters', 'assumptions']); return { filters: filters(input.filters, caps), assumptions: assumptions(input.assumptions) }; }
function safeDecimal(v, nonnegative = true) {
  if (typeof v !== 'string' || !/^-?\d{1,60}(?:\.\d{1,24})?$/.test(v) || nonnegative && D.compare(v, '0') < 0) return null;
  return D.add(v, '0');
}
const yes = v => v === true || v === 1;
function currentRow(pair, caps) {
  const { source, stock, catalog, location, key, ambiguous = false } = pair;
  const base = Report.projectRow(pair, { prices: false, costs: false, margin: false });
  const quantity = ambiguous ? null : safeDecimal(stock.FBestand, false), physical = !yes(source.OhneBestand) && !yes(source.Sachkonto);
  const result = { id: key, articleNumber: base.articleNumber, description: base.description, assortment: base.assortment, location: location.label, locationId: location.id,
    quantity, eligible: physical && !ambiguous && quantity !== null && D.compare(quantity, '0') >= 0,
    status: ambiguous ? 'Mehrdeutiger Bestand' : !physical ? 'Keine physische Bestandsposition' : quantity === null ? 'Bestand fehlt' : D.compare(quantity, '0') < 0 ? 'Negativer Bestand' : 'Vollständig' };
  const currentTrade = !catalog || catalog.sourceSystem === 'tradefoto.artikel_stamm';
  if (caps.prices) {
    const gross = safeDecimal(catalog?.retailGross); let net = safeDecimal(catalog?.retailNet);
    const rate = new Map([['0', '0'], ['1', '20'], ['2', '10'], ['3', '19'], ['4', '7']]).get(String(source.MWST));
    // A manual revision never inherits an old import's tax basis.
    if (net === null && currentTrade && gross !== null && rate !== undefined) net = D.divide(gross, D.add('1', D.divide(rate, '100', 4)), 12);
    Object.assign(result, { retailGross: gross, retailNet: net });
  }
  if (caps.costs) result.averageCost = safeDecimal(currentTrade ? source.DurchschnittEK : catalog?.purchaseNet);
  return result;
}
function calculate(rows, input, caps, provenance) {
  if (rows.length > LIMITS.rows) C.fail('BWL_SIMULATION_LIMIT', 413);
  const a = input.assumptions, quota = D.divide(a.sellThroughPercent, '100', 8), priceFactor = D.subtract('1', D.divide(a.discountPercent, '100', 8));
  const keys = ['scenarioQuantity', ...(caps.prices ? ['scenarioGrossRevenue', 'scenarioNetRevenue'] : []), ...(caps.costs ? ['scenarioCost'] : []), ...(caps.margin ? ['scenarioGrossMargin'] : [])];
  const totals = Object.fromEntries(keys.map(k => [k, { value: '0', knownSubtotal: '0', missingRows: 0, complete: true }]));
  const output = rows.map(row => {
    const r = { ...row, scenarioQuantity: row.eligible ? D.multiply(row.quantity, quota) : null };
    const amount = (quantity, unit) => quantity === null || unit === null ? null : D.multiply(quantity, unit);
    if (caps.prices) Object.assign(r, { scenarioPriceGross: row.retailGross === null ? null : D.multiply(row.retailGross, priceFactor),
      scenarioPriceNet: row.retailNet === null ? null : D.multiply(row.retailNet, priceFactor) });
    if (caps.prices) Object.assign(r, { scenarioGrossRevenue: amount(r.scenarioQuantity, r.scenarioPriceGross), scenarioNetRevenue: amount(r.scenarioQuantity, r.scenarioPriceNet) });
    if (caps.costs) r.scenarioCost = amount(r.scenarioQuantity, row.averageCost);
    if (caps.margin) Object.assign(r, { scenarioGrossMargin: r.scenarioNetRevenue === null || r.scenarioCost === null ? null : D.subtract(r.scenarioNetRevenue, r.scenarioCost),
      scenarioMarginPercent: r.scenarioPriceNet === null || D.compare(r.scenarioPriceNet, '0') <= 0 || row.averageCost === null ? null : D.multiply(D.divide(D.subtract(r.scenarioPriceNet, row.averageCost), r.scenarioPriceNet, 8), '100') });
    const missing = []; if (caps.prices && row.retailGross === null) missing.push('Bruttopreis fehlt'); if (caps.prices && row.retailNet === null) missing.push('Nettopreis / Steuerbasis fehlt');
    if (caps.costs && row.averageCost === null) missing.push('Ø EK fehlt');
    if (missing.length) r.status = [r.status === 'Vollständig' ? '' : r.status, ...missing].filter(Boolean).join('; ');
    for (const k of keys) { if (r[k] === null) totals[k].missingRows++; else totals[k].knownSubtotal = D.add(totals[k].knownSubtotal, r[k]); }
    return r;
  });
  for (const t of Object.values(totals)) { t.complete = t.missingRows === 0; t.value = t.complete ? t.knownSubtotal : null; }
  if (caps.margin) { const margin = totals.scenarioGrossMargin; totals.scenarioResult = { ...margin, knownSubtotal: D.subtract(margin.knownSubtotal, a.additionalCosts), value: margin.complete ? D.subtract(margin.knownSubtotal, a.additionalCosts) : null }; }
  return { schemaVersion: 1, filters: input.filters, assumptions: a, ...provenance, capabilities: caps, rows: output,
    summary: { rows: output.length, articles: new Set(output.map(r => r.articleNumber)).size, mixedQuantityUnits: true, complete: Object.values(totals).every(t => t.complete), totals }, note: NOTE };
}
function filterHistorical(snapshot, auth) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.rows) || snapshot.rows.length > LIMITS.rows || Buffer.byteLength(C.canonical(snapshot)) > LIMITS.snapshotBytes) C.fail('BWL_SIMULATION_VARIANT_INTEGRITY', 503);
  if (snapshot.rows.some(r => !auth.stock.company && !auth.stock.locationIds.includes(r.locationId))) C.fail('BWL_SIMULATION_FORBIDDEN', 403);
  const caps = Object.fromEntries(Object.entries(auth.caps).map(([key, granted]) => [key, !!granted && !!snapshot.capabilities?.[key]]));
  const allowed = new Set(columnsFor(caps).map(c => c.id));
  const hidden = COLUMNS.filter(c => c.permission && !allowed.has(c.id)).map(c => c.id);
  const result = structuredClone(snapshot); result.capabilities = caps;
  for (const r of result.rows) for (const key of hidden) delete r[key];
  for (const key of Object.keys(result.summary.totals)) {
    const permission = key === 'scenarioResult' || key === 'scenarioGrossMargin' ? 'margin' : key === 'scenarioCost' ? 'costs' : ['scenarioGrossRevenue', 'scenarioNetRevenue'].includes(key) ? 'prices' : null;
    if (permission && !caps[permission]) delete result.summary.totals[key];
  }
  result.summary.complete = Object.values(result.summary.totals).every(t => t.complete); return result;
}
function normalizePreferences(value, caps, {reduce = false} = {}) {
  C.exact(value, ['columns', 'columnWidths', 'sort', 'direction']);
  const known = COLUMNS.map(c => c.id), allowed = columnsFor(caps).map(c => c.id);
  const defaults = ['articleNumber', 'description', 'location', 'quantity', 'scenarioQuantity', 'scenarioNetRevenue', 'scenarioGrossMargin', 'status'].filter(id => allowed.includes(id));
  const columns = value.columns ?? defaults, widths = value.columnWidths ?? {}, sort = value.sort ?? 'articleNumber', direction = value.direction ?? 'asc';
  if (!Array.isArray(columns) || !columns.length || columns.length > known.length || new Set(columns).size !== columns.length || columns.some(id => !known.includes(id))) C.fail('BWL_SIMULATION_PREFERENCES_INVALID');
  if (!C.plain(widths) || Object.entries(widths).some(([id, width]) => !known.includes(id) || !Number.isInteger(width) || width < 80 || width > 800)
    || !known.includes(sort) || !['asc', 'desc'].includes(direction)) C.fail('BWL_SIMULATION_PREFERENCES_INVALID');
  if (!reduce && (columns.some(id => !allowed.includes(id)) || Object.keys(widths).some(id => !allowed.includes(id)) || !allowed.includes(sort))) C.fail('BWL_SIMULATION_FORBIDDEN', 403);
  const filtered = columns.filter(id => allowed.includes(id));
  return {columns: filtered.length ? filtered : defaults, columnWidths: Object.fromEntries(Object.entries(widths).filter(([id]) => allowed.includes(id))), sort: allowed.includes(sort) ? sort : 'articleNumber', direction};
}
function unavailableContext(session) { const { caps } = authority(session); return { available: false, locations: [], sortiments: Report.SORTIMENTS, capabilities: caps, sourceAt: null,
  sourceFingerprint: null, defaults: DEFAULTS, columns: columnsFor(caps), defaultColumns: normalizePreferences({}, caps).columns, limits: LIMITS, note: NOTE }; }
module.exports = { LIMITS, DEFAULTS, NOTE, COLUMNS, authority, columnsFor, filters, assumptions, normalize, normalizePreferences, safeDecimal, currentRow, calculate, filterHistorical, unavailableContext };
