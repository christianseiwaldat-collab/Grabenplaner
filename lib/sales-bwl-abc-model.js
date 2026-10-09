'use strict';
const C = require('./data-import-contract');
const R = require('./sales-report-model');
const LIMITS = Object.freeze({ groups: 5000, batch: 200, maxDays: 366 });
const COVERAGE = Object.freeze({ basis: 'verified-import', periodCompleteness: 'not-established',
  label: 'Geprüfte importierte Kassenpositionen; die Vollständigkeit des Kalenderzeitraums ist nicht nachgewiesen.' });
const COLUMNS = Object.freeze([
  ['rank', 'Rang', 80], ['class', 'ABC', 80], ['articleNumber', 'Artikelnummer', 140], ['description', 'Bezeichnung', 320],
  ['location', 'Filiale', 160], ['quantity', 'Menge inkl. Retouren', 140], ['netRevenue', 'Umsatz netto', 150],
  ['grossMargin', 'Rohertrag', 150], ['sharePercent', 'Anteil %', 110], ['cumulativePercent', 'Kumuliert %', 120],
  ['rankingStatus', 'Prüfung / Rangfolge', 200],
].map(([id, label, width]) => Object.freeze({ id, label, width, ...(id === 'grossMargin' ? { permission: 'margin' } : {}) })));
function authority(session) {
  const projection = R.reportAuthority(session);
  if (!projection.read || session?.active === false || session?.employeeActive === false || session?.isEmployee === false
    || session?.sessionKind === 'organization' || session?.mustChangePassword || !session?.employeeNumber) C.fail('IMPORT_FORBIDDEN', 403);
  const ownerId = String(session.employeeNumber), accountId = String(session.accountId || '');
  const permissions = [...new Set(session.permissions || [])].sort();
  const scopes = (session.scopes || []).map(s => ({ locationId: String(s.locationId ?? s.location_id ?? ''),
    departmentId: s.departmentId ?? s.department_id ?? null })).sort((a, b) => C.canonical(a).localeCompare(C.canonical(b)));
  const identity = C.canonical({ id: String(session.id || ''), ownerId, accountId, sessionKind: session.sessionKind || 'employee',
    role: session.role || '', permissions, scopes, active: session.active !== false, employeeActive: session.employeeActive !== false,
    isEmployee: session.isEmployee !== false, mustChangePassword: !!session.mustChangePassword, projection });
  return Object.freeze({ projection, identity, ownerId, accountId });
}
function availableColumns(projection) { return COLUMNS.filter(c => !c.permission || projection[c.permission]); }
function normalizePreferences(value, projection, { reduce = false } = {}) {
  C.exact(value, ['columns', 'columnWidths', 'sort', 'direction']);
  const allowed = availableColumns(projection).map(c => c.id), known = COLUMNS.map(c => c.id);
  const defaults = ['rank', 'class', 'articleNumber', 'description', 'location', 'quantity', 'netRevenue', 'sharePercent', 'cumulativePercent', 'rankingStatus'];
  const columns = value.columns === undefined ? defaults : value.columns;
  if (!Array.isArray(columns) || !columns.length || columns.length > known.length || new Set(columns).size !== columns.length
    || columns.some(id => !known.includes(id))) C.fail('BWL_ABC_PREFERENCES_INVALID');
  const widths = value.columnWidths === undefined ? {} : value.columnWidths;
  if (!C.plain(widths) || Object.entries(widths).some(([id, width]) => !known.includes(id) || !Number.isInteger(width) || width < 80 || width > 800)) C.fail('BWL_ABC_PREFERENCES_INVALID');
  const sort = value.sort === undefined ? 'rank' : value.sort, direction = value.direction === undefined ? 'asc' : value.direction;
  if (!known.includes(sort) || !['asc', 'desc'].includes(direction)) C.fail('BWL_ABC_PREFERENCES_INVALID');
  if (!reduce && (columns.some(id => !allowed.includes(id)) || Object.keys(widths).some(id => !allowed.includes(id)) || !allowed.includes(sort))) C.fail('IMPORT_FORBIDDEN', 403);
  const filtered = columns.filter(id => allowed.includes(id));
  // A revoked optional margin column cannot leave a saved table with no useful data.
  if (!filtered.length) filtered.push('articleNumber');
  return { columns: filtered, columnWidths: Object.fromEntries(Object.entries(widths).filter(([id]) => allowed.includes(id))),
    sort: allowed.includes(sort) ? sort : 'rank', direction };
}
function unavailableContext(session, today) {
  const { projection } = authority(session);
  return { available: false, today, locations: [], metrics: [{ id: 'netRevenue', label: 'Umsatz netto' }],
    columns: availableColumns(projection), defaultColumns: normalizePreferences({}, projection).columns,
    defaults: { aLimit: 80, bLimit: 95 }, limits: LIMITS, coverage: COVERAGE, sourceAt: null, marginStatus: 'unconfirmed' };
}
function normalizeQuery(input = {}, { today, projection, locations, marginPolicy = null }) {
  C.exact(input, ['dateFrom', 'dateTo', 'locationIds', 'metric', 'aLimit', 'bLimit']);
  const date = v => { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v))
    || new Date(v).toISOString().slice(0, 10) !== v) C.fail('IMPORT_HISTORY_DATE_RANGE'); return v; };
  const dateFrom = date(input.dateFrom ?? today.slice(0, 4) + '-01-01'), dateTo = date(input.dateTo ?? today);
  if (dateFrom > dateTo || dateTo > today || (Date.parse(dateTo) - Date.parse(dateFrom)) / 86400000 >= LIMITS.maxDays) C.fail('IMPORT_HISTORY_DATE_RANGE');
  const available = locations.map(l => l.id), ids = input.locationIds === undefined ? available : input.locationIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string' || !available.includes(id))) C.fail('IMPORT_FORBIDDEN', 403);
  const metric = input.metric || 'netRevenue';
  if (!['netRevenue', 'grossMargin'].includes(metric)) C.fail('BWL_ABC_SELECTION_INVALID');
  if (metric === 'grossMargin' && (!projection.margin || !marginPolicy)) C.fail('IMPORT_FORBIDDEN', 403);
  const aLimit = input.aLimit ?? 80, bLimit = input.bLimit ?? 95;
  if (!Number.isInteger(aLimit) || !Number.isInteger(bLimit) || aLimit < 1 || aLimit >= bLimit || bLimit > 100) C.fail('BWL_ABC_SELECTION_INVALID');
  return { dateFrom, dateTo, locationIds: [...new Set(ids)].sort(), metric, aLimit, bLimit };
}
function emptyBucket(id) { return { id, positions: 0, net: '0', quantity: '0', amountMissing: 0, issues: {} }; }
function accumulator() { return { processed: 0, groups: {}, buckets: {} }; }
function addUnits(target, field, value, scale) {
  const units = R.scaled(value, scale);
  if (units !== null) target[field] = String(BigInt(target[field]) + units);
  return units;
}
function accumulate(state, line) {
  state.processed++;
  const article = line.articleNumber, location = line.locationId;
  // Exact protected source keys: no numeric conversion, trimming or zero aliases.
  const identified = typeof article === 'string' && article.length > 0 && typeof location === 'string' && location.length > 0;
  const key = identified ? JSON.stringify([article, location]) : null;
  const metric = line.metric;
  const ordinary = metric && ['sale', 'return'].includes(metric.status);
  const net = ordinary ? R.scaled(metric.net) : null, quantity = ordinary ? R.scaled(line.quantity, 6) : null;
  const reviewed = !metric || ordinary && (net === null || quantity === null);
  if (!ordinary || !identified || reviewed) {
    const id = reviewed ? 'review' : ordinary ? 'unidentified-article' : ['adjustment', 'deposit', 'excluded', 'payment', 'voucher_issue', 'uid_clearing'].includes(metric?.status) ? metric.status : 'review';
    const bucket = state.buckets[id] ||= emptyBucket(id); bucket.positions++;
    if (addUnits(bucket, 'net', metric?.net, 2) === null) bucket.amountMissing++;
    addUnits(bucket, 'quantity', line.quantity, 6);
    for (const issue of line.reviewIssues || []) bucket.issues[String(issue)] = (bucket.issues[String(issue)] || 0) + 1;
    if (!reviewed || !identified) return;
  }
  if (!identified) return;
  if (!state.groups[key]) {
    if (Object.keys(state.groups).length >= LIMITS.groups) C.fail('BWL_ABC_DATA_LIMIT', 413);
    state.groups[key] = { articleNumber: article, description: reviewed ? '' : typeof line.description === 'string' ? line.description : '',
      locationId: location, location: line.location || location, net: '0', quantity: '0', margin: '0', marginMissing: 0,
      checkedPositions: 0, reviewPositions: 0, labelChanged: false, labelVerified: !reviewed,
      reviewedLabel: reviewed && typeof line.description === 'string' ? line.description : null };
  }
  const group = state.groups[key];
  if (!reviewed && !group.labelVerified) {
    group.description = typeof line.description === 'string' ? line.description : ''; group.labelVerified = true;
    if (group.reviewedLabel !== null && group.reviewedLabel !== group.description) group.labelChanged = true;
  } else if (typeof line.description === 'string' && group.description !== line.description) group.labelChanged = true;
  if (reviewed) { group.reviewPositions++; return; }
  group.checkedPositions++; group.net = String(BigInt(group.net) + net); group.quantity = String(BigInt(group.quantity) + quantity);
  if (addUnits(group, 'margin', line.margin, 2) === null) group.marginMissing++;
}
function finish(state, query, { margin = false } = {}) {
  const rows = Object.values(state.groups).map(g => ({ ...g, id: JSON.stringify([g.articleNumber, g.locationId]),
    quantity: g.reviewPositions && !g.checkedPositions ? null : R.decimal(BigInt(g.quantity), 6),
    netRevenue: g.reviewPositions && !g.checkedPositions ? null : R.decimal(BigInt(g.net)),
    ...(margin ? { grossMargin: g.marginMissing || g.reviewPositions ? null : R.decimal(BigInt(g.margin)), marginMissing: g.marginMissing } : {}),
    rank: null, class: null, sharePercent: null, cumulativePercent: null,
    rankingStatus: g.reviewPositions ? 'review' : query.metric === 'grossMargin' && g.marginMissing ? 'margin-missing'
      : BigInt(query.metric === 'grossMargin' ? g.margin : g.net) <= 0n ? 'nonpositive' : 'ranked' }));
  rows.sort((a, b) => {
    const rankedA = a.rankingStatus === 'ranked', rankedB = b.rankingStatus === 'ranked';
    if (rankedA !== rankedB) return rankedA ? -1 : 1;
    if (rankedA) { const delta = BigInt(query.metric === 'grossMargin' ? b.margin : b.net) - BigInt(query.metric === 'grossMargin' ? a.margin : a.net); if (delta) return delta > 0n ? 1 : -1; }
    return a.articleNumber < b.articleNumber ? -1 : a.articleNumber > b.articleNumber ? 1 : a.locationId < b.locationId ? -1 : a.locationId > b.locationId ? 1 : 0;
  });
  const ranked = rows.filter(r => r.rankingStatus === 'ranked'), total = ranked.reduce((sum, r) => sum + BigInt(query.metric === 'grossMargin' ? r.margin : r.net), 0n);
  let cumulative = 0n;
  const classes = Object.fromEntries(['A', 'B', 'C'].map(id => [id, { count: 0, basis: 0n }]));
  ranked.forEach((r, index) => {
    const basis = BigInt(query.metric === 'grossMargin' ? r.margin : r.net);
    r.rank = index + 1; r.class = cumulative * 100n < total * BigInt(query.aLimit) ? 'A' : cumulative * 100n < total * BigInt(query.bLimit) ? 'B' : 'C';
    cumulative += basis; r.sharePercent = R.decimal(R.divide(basis * 10000n, total)); r.cumulativePercent = R.decimal(R.divide(cumulative * 10000n, total));
    classes[r.class].count++; classes[r.class].basis += basis;
  });
  const cleanRows = rows.map(({ net, margin: rawMargin, labelVerified, reviewedLabel, ...row }) => { if (!margin) delete row.marginMissing; return row; });
  return { rows: cleanRows, buckets: Object.values(state.buckets).map(b => ({ id: b.id, positions: b.positions,
    netRevenue: b.amountMissing ? null : R.decimal(BigInt(b.net)), knownNetRevenue: R.decimal(BigInt(b.net)),
    quantity: R.decimal(BigInt(b.quantity), 6), amountMissing: b.amountMissing, issues: b.issues })),
    summary: { processed: state.processed, groups: rows.length, ranked: ranked.length, unranked: rows.length - ranked.length,
      positiveBasis: R.decimal(total), classes: Object.fromEntries(Object.entries(classes).map(([id, c]) => [id, { count: c.count,
        basis: R.decimal(c.basis), sharePercent: total ? R.decimal(R.divide(c.basis * 10000n, total)) : null }])) } };
}
module.exports = { authority, COLUMNS, LIMITS, COVERAGE, availableColumns, normalizePreferences, unavailableContext, normalizeQuery, accumulator, accumulate, finish };
