'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const M = require('../lib/sales-bwl-abc-model');
const session = extra => ({ employeeNumber: '42', accountId: 'account-42', active: true,
  permissions: ['sales:analytics:access', 'sales:analytics:location:read', 'sales:history:read', 'sales:analytics:margin:read'],
  scopes: [{ locationId: 'a', departmentId: null }], ...extra });
const context = { today: '2026-10-09', projection: { read: true, margin: true }, marginPolicy: {}, locations: [{ id: 'a' }, { id: 'b' }] };
const query = extra => M.normalizeQuery({ dateFrom: '2026-01-01', dateTo: '2026-10-09', locationIds: ['a', 'b'], ...extra }, context);
const line = extra => ({ articleNumber: '001', description: 'Newest checked description', locationId: 'a', location: 'A',
  metric: { status: 'sale', net: '100.00' }, quantity: '1', margin: '20.00', ...extra });
test('ABC authority is personal, active and branch-scoped; every permission/account/scope change changes its identity', () => {
  const actor = M.authority(session()); assert.equal(actor.ownerId, '42'); assert.equal(actor.accountId, 'account-42');
  for (const change of [{ active: false }, { employeeActive: false }, { mustChangePassword: true }, { isEmployee: false },
    { sessionKind: 'organization' }, { permissions: [] }, { scopes: [{ locationId: 'a', departmentId: 3 }] }]) assert.throws(() => M.authority(session(change)), { status: 403 });
  for (const change of [{ id: 'new-session' }, { accountId: 'another-account' }, { role: 'admin' },
    { permissions: [...session().permissions, 'unrelated:grant'] }, { scopes: [{ locationId: 'b', departmentId: null }] }]) assert.notEqual(M.authority(session(change)).identity, actor.identity);
});
test('ABC query validates current-only dates, scoped locations, confirmed historical margin and integer boundaries', () => {
  assert.deepEqual(query(query()), query()); assert.equal(query().metric, 'netRevenue');
  for (const bad of [{ dateTo: '2026-10-10' }, { dateFrom: '2026-02-30' }, { dateFrom: '2025-01-01' }, { dateFrom: '2026-10-10' }]) assert.throws(() => query(bad), { code: 'IMPORT_HISTORY_DATE_RANGE' });
  for (const bad of [{ locationIds: [] }, { locationIds: ['forbidden'] }]) assert.throws(() => query(bad), { status: 403 });
  for (const bad of [{ comparisonFrom: '2025-01-01' }, { aLimit: 95, bLimit: 95 }, { aLimit: 0 }, { aLimit: 79.5 }, { bLimit: 101 }, { metric: 'currentCost' }]) assert.throws(() => query(bad));
  assert.throws(() => M.normalizeQuery({ metric: 'grossMargin' }, { ...context, marginPolicy: null }), { status: 403 });
  assert.throws(() => M.normalizeQuery({ metric: 'grossMargin' }, { ...context, projection: { margin: false } }), { status: 403 });
});
test('exact article x branch groups preserve leading zeroes, historical name changes and signed returns', () => {
  const state = M.accumulator();
  M.accumulate(state, line()); M.accumulate(state, line({ description: 'Older checked name', metric: { status: 'return', net: '-10.00' }, quantity: '-0.5', margin: '-2.00' }));
  M.accumulate(state, line({ articleNumber: '1' })); M.accumulate(state, line({ locationId: 'b' }));
  const result = M.finish(state, query(), { margin: true }); assert.equal(result.rows.length, 3);
  const row = result.rows.find(r => r.articleNumber === '001' && r.locationId === 'a');
  assert.equal(row.description, 'Newest checked description'); assert.equal(row.labelChanged, true);
  assert.equal(row.quantity, '0.500000'); assert.equal(row.netRevenue, '90.00'); assert.equal(row.grossMargin, '18.00');
  assert.equal(result.summary.positiveBasis, '290.00'); assert.equal(result.summary.processed, 4);
});
test('rank shares use only positive checked bases; threshold-crossing rows stay in the earlier class', () => {
  const state = M.accumulator();
  for (const [article, net] of [['a', '60.00'], ['b', '25.00'], ['c', '10.00'], ['d', '5.00'], ['z', '0.00'], ['n', '-20.00']]) M.accumulate(state, line({ articleNumber: article, metric: { status: Number(net) < 0 ? 'return' : 'sale', net } }));
  const result = M.finish(state, query()); assert.deepEqual(result.rows.slice(0, 4).map(r => r.class), ['A', 'A', 'B', 'C']);
  assert.deepEqual(result.rows.slice(0, 4).map(r => r.sharePercent), ['60.00', '25.00', '10.00', '5.00']);
  assert.equal(result.rows[3].cumulativePercent, '100.00'); assert.equal(result.summary.positiveBasis, '100.00');
  assert.equal(result.summary.classes.A.sharePercent, '85.00');
  assert.equal(result.rows.find(r => r.articleNumber === 'n').rank, null); assert.equal(result.rows.find(r => r.articleNumber === 'z').rankingStatus, 'nonpositive');
  assert.ok(result.rows.every(r => !Object.hasOwn(r, 'grossMargin') && !Object.hasOwn(r, 'marginMissing')));
});
test('latest checked label wins over newer reviewed labels; reviewed article groups never rank', () => {
  const state = M.accumulator();
  M.accumulate(state, line({ description: 'Newest unchecked name', metric: null, reviewIssues: ['BAD_RECEIPT'] }));
  M.accumulate(state, line({ description: 'Older verified name' }));
  const result = M.finish(state, query(), { margin: true });
  assert.equal(result.rows[0].description, 'Older verified name'); assert.equal(result.rows[0].labelChanged, true);
  assert.equal(result.rows[0].reviewPositions, 1); assert.equal(result.rows[0].rankingStatus, 'review'); assert.equal(result.rows[0].rank, null);
  assert.equal(result.buckets[0].id, 'review'); assert.equal(result.buckets[0].netRevenue, null); assert.equal(result.buckets[0].issues.BAD_RECEIPT, 1);
});
test('deposits/adjustments/excluded/payment/unidentified and unverified positions have separate buckets', () => {
  const state = M.accumulator();
  for (const status of ['adjustment', 'deposit', 'excluded', 'payment', 'voucher_issue', 'uid_clearing']) M.accumulate(state, line({ metric: { status, net: '5.00' } }));
  M.accumulate(state, line({ articleNumber: null })); M.accumulate(state, line({ metric: null, reviewIssues: ['STATUS_REVIEW_REQUIRED'] }));
  const result = M.finish(state, query()); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].checkedPositions, 0);
  assert.deepEqual(result.buckets.map(b => b.id).sort(), ['adjustment', 'deposit', 'excluded', 'payment', 'review', 'uid_clearing', 'unidentified-article', 'voucher_issue'].sort());
  assert.equal(result.summary.ranked, 0); assert.equal(result.rows[0].description, '');
});
test('missing historical margin stays unknown and unranked for margin but can rank on checked revenue', () => {
  const state = M.accumulator(); M.accumulate(state, line({ margin: null }));
  const byMargin = M.finish(state, query({ metric: 'grossMargin' }), { margin: true });
  assert.equal(byMargin.rows[0].grossMargin, null); assert.equal(byMargin.rows[0].rankingStatus, 'margin-missing'); assert.equal(byMargin.summary.positiveBasis, '0.00');
  assert.equal(M.finish(state, query(), { margin: true }).rows[0].rank, 1);
});
test('large decimal values retain integer precision and deterministic exact-key ties', () => {
  const state = M.accumulator();
  for (const articleNumber of ['02', '002', '2']) M.accumulate(state, line({ articleNumber, metric: { status: 'sale', net: '99999999999999999999.99' } }));
  const result = M.finish(state, query()); assert.deepEqual(result.rows.map(r => r.articleNumber), ['002', '02', '2']);
  assert.equal(result.summary.positiveBasis, '299999999999999999999.97'); assert.equal(result.rows[0].sharePercent, '33.33');
});
test('ABC group limit is enforced without increasing report or source batch budgets', () => {
  const state = M.accumulator(); for (let i = 0; i < M.LIMITS.groups; i++) M.accumulate(state, line({ articleNumber: String(i) }));
  assert.throws(() => M.accumulate(state, line({ articleNumber: 'overflow' })), { code: 'BWL_ABC_DATA_LIMIT', status: 413 });
  assert.equal(M.LIMITS.batch, 200); assert.equal(M.LIMITS.maxDays, 366);
});
test('table preferences are bounded, ordered and reduce only known revoked columns', () => {
  const projection = { margin: false }, defaults = M.normalizePreferences({}, projection);
  assert.ok(defaults.columns.includes('articleNumber')); assert.equal(defaults.sort, 'rank');
  for (const bad of [{ columns: [] }, { columns: ['rank', 'rank'] }, { columns: ['secret'] }, { columnWidths: { description: 801 } },
    { columnWidths: { description: 79 } }, { direction: 'reverse' }, { sort: 'unknown' }]) assert.throws(() => M.normalizePreferences(bad, projection));
  assert.throws(() => M.normalizePreferences({ columns: ['grossMargin'] }, projection), { status: 403 });
  const reduced = M.normalizePreferences({ columns: ['grossMargin'], sort: 'grossMargin', columnWidths: { grossMargin: 180 }, direction: 'desc' }, projection, { reduce: true });
  assert.deepEqual(reduced, { columns: ['articleNumber'], sort: 'rank', columnWidths: {}, direction: 'desc' });
  assert.throws(() => M.normalizePreferences({ columns: ['secret'] }, projection, { reduce: true }));
});
