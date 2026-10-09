'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const M = require('../lib/sales-bwl-actions-model');
const permissions = ['sales:history:read', 'sales:analytics:access', 'sales:analytics:location:read', 'sales:analytics:inventory:read', 'sales:articles:access', 'sales:articles:read'];
const session = (extras = {}) => ({ employeeNumber: '42', accountId: 'a', role: 'manager', permissions: [...permissions, M.WRITE_PERMISSION], scopes: [{ locationId: '18', departmentId: 0 }], ...extras });
test('action authority separates organizational write grants, full branch scopes and personal account gates', () => {
  const auth = M.authority(session()); assert.equal(auth.caps.write, true); assert.equal(M.assertLocation(auth, '18', { write: true }), '18');
  assert.throws(() => M.assertLocation(auth, '19'), { status: 403 }); assert.throws(() => M.assertLocation(auth, 'trade-source:18'), { status: 403 });
  for (const departmentId of [null, undefined, '', 0, '0', '00']) assert.deepEqual(M.authority(session({ scopes: [{ locationId: '18', departmentId }] })).locationIds, ['18']);
  assert.throws(() => M.authority(session({ scopes: [{ locationId: '18', departmentId: 4 }] })), { status: 403 });
  for (const role of ['employee', 'seller']) assert.equal(M.authority(session({ role })).caps.write, false);
  for (const role of ['manager', 'department_manager', 'admin', 'developer']) assert.equal(M.authority(session({ role })).caps.write, true);
  assert.equal(M.authority(session({ permissions })).caps.write, false);
  for (const extra of [{ active: false }, { employeeActive: false }, { mustChangePassword: true }, { sessionKind: 'organization' }, { employeeNumber: '' }]) assert.throws(() => M.authority(session(extra)), { status: 403 });
  assert.notEqual(M.authority(session({ accountId: 'b' })).identity, auth.identity);
});
test('company analytics cannot expand FL/AL organizational team scopes; central global catalog roles remain explicit', () => {
  const companyPermissions = [...permissions, 'sales:analytics:company:read', M.WRITE_PERMISSION];
  for (const role of ['manager', 'department_manager']) {
    assert.throws(() => M.authority(session({ role, permissions: companyPermissions, scopes: [{ locationId: '18', departmentId: 3 }] })), { status: 403 });
    const auth = M.authority(session({ role, permissions: companyPermissions })); assert.equal(auth.company, false); assert.deepEqual(auth.locationIds, ['18']);
    assert.throws(() => M.assertLocation(auth, '19', { write: true }), { status: 403 });
  }
  for (const role of ['manager', 'admin', 'developer']) {
    const auth = M.authority(session({ role, permissions: companyPermissions, scopes: [] })); assert.equal(auth.company, true); assert.equal(M.assertLocation(auth, '19', { write: true }), '19');
  }
  assert.throws(() => M.authority(session({ role: 'department_manager', permissions: companyPermissions, scopes: [] })), { status: 403 });
});
test('manual create and partial update validate bounded text, exact identities, dates and explicit result transitions', () => {
  const input = { id: crypto.randomUUID(), locationId: '18', title: ' BEISPIEL Aktion ', articleNumber: '000042' }, today = '2026-10-09';
  const r = M.normalizeCreate(input, { today }); assert.equal(r.title, 'BEISPIEL Aktion'); assert.equal(r.articleNumber, '000042'); assert.equal(r.sourceHint, null);
  assert.equal(M.normalizeCreate({ ...input, dueDate: '2027-10-09' }, { today }).dueDate, '2027-10-09');
  for (const dueDate of ['2026-10-08', '2027-10-10', '2026-02-30']) assert.throws(() => M.normalizeCreate({ ...input, dueDate }, { today }), { status: 422 });
  for (const extra of [{ source: {} }, { ownerId: 'other' }, { rows: [] }, { title: 'x\u0000' }, { title: 'x'.repeat(121) }, { status: 'done' }]) assert.throws(() => M.normalizeCreate({ ...input, ...extra }, { today }), { status: 422 });
  const update = M.normalizeUpdate({ version: 1, note: 'BEISPIEL\nErgebnis', status: 'done' }, { today });
  assert.equal(M.transition({ status: 'open' }, update).status, 'done');
  assert.throws(() => M.transition({ status: 'open' }, { status: 'done' }), { code: 'BWL_ACTIONS_RESULT_REQUIRED' });
  assert.throws(() => M.transition({ status: 'open', note: 'Bestehende Planung' }, { status: 'done', note: 'Bestehende Planung' }), { code: 'BWL_ACTIONS_RESULT_REQUIRED' });
  assert.throws(() => M.transition({ status: 'done', note: 'Bestehendes Ergebnis' }, { status: 'open', note: 'Bestehendes Ergebnis' }), { code: 'BWL_ACTIONS_RESULT_REQUIRED' });
  assert.throws(() => M.transition({ status: 'done' }, { status: 'open' }), { code: 'BWL_ACTIONS_RESULT_REQUIRED' });
  assert.equal(M.transition({ status: 'done' }, { status: 'open', note: 'Erneut prüfen' }).completedAt, null);
  assert.deepEqual(M.transition({ status: 'done' }, { title: 'Umbenannt' }), { title: 'Umbenannt' });
  assert.throws(() => M.normalizeUpdate({ version: 1 }), { status: 422 }); assert.throws(() => M.normalizeUpdate({ version: '1', title: 'x' }), { status: 422 });
  assert.equal(M.normalizeUpdate({ version: 1, dueDate: '2026-09-01' }, { today }).dueDate, '2026-09-01');
});
test('HTTP source selectors never accept a persisted proof or client financial values', () => {
  const inventory = { kind: 'inventory', rowId: '["00042","18"]', sourceFingerprint: 'a'.repeat(64) }, abc = { kind: 'abc', rowId: '["00042","18"]', exportToken: 'server-token' };
  assert.deepEqual(M.normalizeSource(inventory), inventory); assert.deepEqual(M.normalizeSource(abc), abc);
  for (const extra of [{ label: 'forged' }, { reason: 'forged' }, { margin: '99' }, { sourceAt: '2026-10-09T00:00:00.000Z' }]) assert.throws(() => M.normalizeSource({ ...inventory, ...extra }), { status: 422 });
  const proof = { ...inventory, articleNumber: '000042', label: 'BEISPIEL', sourceAt: '2026-10-09T00:00:00.000Z', reason: 'Bestand prüfen', type: 'catalog-stock-review' };
  assert.deepEqual(M.validateSourceRecord(proof), proof); assert.throws(() => M.validateSourceRecord({ ...proof, financialTotal: '99' }), { status: 422 });
});
test('queries require one filial and bound pagination, status and sort fields', () => {
  const q = M.normalizeQuery({ locationId: '18', limit: '200', offset: '500' }); assert.equal(q.limit, 200); assert.equal(q.offset, 500);
  for (const extra of [{ locationId: undefined }, { limit: '201' }, { limit: ['1'] }, { direction: 'unsafe' }, { status: 'anything' }, { sort: 'margin' }, { offset: '-1' }]) assert.throws(() => M.normalizeQuery({ locationId: '18', ...extra }), { status: 422 });
});
