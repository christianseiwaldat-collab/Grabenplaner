'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express');
const { registerSalesReportJobRoutes } = require('../lib/sales-report-jobs-routes');
test('report HTTP endpoints require personal rights and CSRF, protect downloads and suppress late revoked responses', async t => {
  const original = { employeeNumber: 'synthetic', accountId: null, isEmployee: true,
    permissions: ['sales:analytics:access', 'sales:analytics:company:read', 'sales:history:read'] };
  let session = original, calls = 0, revoke = false, fail = false;
  const app = express(); app.use(express.json());
  const work = async () => { calls++; if (fail) throw Error('SELECT private source'); if (revoke) session = { ...original, permissions: [] }; return { ok: true }; };
  registerSalesReportJobRoutes(app, { requireSession: () => original, refreshSession: async () => session,
    assertCsrf(req) { if (req.get('X-CSRF-Token') !== 'test') throw Object.assign(Error(), { status: 403, code: 'PORTAL_CSRF_INVALID' }); },
    jobs: { create: work, list: work, cancel: work, remove: work, download: async () => { await work(); return '<!doctype html><title>Bericht</title>'; } } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); t.after(() => new Promise(r => server.close(r)));
  const request = (path = '', method = 'GET', csrf = false) => fetch(`http://127.0.0.1:${server.address().port}/api/sales-report-jobs${path}`, { method, headers: csrf ? { 'X-CSRF-Token': 'test' } : {} });
  for (const [path, method] of [['', 'POST'], ['/id/cancel', 'POST'], ['/id', 'DELETE']]) {
    assert.equal((await request(path, method)).status, 403); assert.equal(calls, 0);
  }
  assert.equal((await request('', 'POST', true)).status, 200);
  const download = await request('/id/download'); assert.equal(download.status, 200);
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.match(download.headers.get('content-disposition'), /^attachment;/); assert.match(download.headers.get('content-security-policy'), /sandbox/);
  session = { ...original, isEmployee: false, sessionKind: 'organization' }; assert.equal((await request()).status, 403);
  session = original; revoke = true; assert.equal((await request('/id/download')).status, 403);
  session = original; revoke = false; fail = true; const failure = await request(); assert.equal(failure.status, 500); assert.doesNotMatch(await failure.text(), /SELECT|private source/);
});
