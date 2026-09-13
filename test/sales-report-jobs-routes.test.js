'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express');
const { registerSalesReportJobRoutes } = require('../lib/sales-report-jobs-routes');
test('report HTTP endpoints require personal rights and CSRF, protect downloads and suppress late revoked responses', async t => {
  const original = { employeeNumber: 'synthetic', accountId: null, isEmployee: true,
    permissions: ['sales:analytics:access', 'sales:analytics:company:read', 'sales:history:read'] };
  let session = original, calls = 0, revoke = false, fail = false, pdf = true;
  const app = express(); app.use(express.json());
  const work = async () => { calls++; if (fail) throw Error('SELECT private source'); if (revoke) session = { ...original, permissions: [] }; return { ok: true }; };
  registerSalesReportJobRoutes(app, { requireSession: () => original, refreshSession: async () => session,
    assertCsrf(req) { if (req.get('X-CSRF-Token') !== 'test') throw Object.assign(Error(), { status: 403, code: 'PORTAL_CSRF_INVALID' }); },
    jobs: { create: work, list: work, context: work, cancel: work, remove: work, download: async () => { await work(); return pdf ? Buffer.from('%PDF-1.7\nSynthetic test') : '<!doctype html><title>Bericht</title>'; } } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); t.after(() => new Promise(r => server.close(r)));
  const request = (path = '', method = 'GET', csrf = false) => fetch(`http://127.0.0.1:${server.address().port}/api/sales-report-jobs${path}`, { method, headers: csrf ? { 'X-CSRF-Token': 'test' } : {} });
  for (const [path, method] of [['', 'POST'], ['/id/cancel', 'POST'], ['/id', 'DELETE']]) {
    assert.equal((await request(path, method)).status, 403); assert.equal(calls, 0);
  }
  assert.equal((await request('', 'POST', true)).status, 200);
  assert.equal((await request('/context')).status, 200);
  const download = await request('/id/download'); assert.equal(download.status, 200);
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.match(download.headers.get('content-type'), /application\/pdf/);
  assert.match(download.headers.get('content-disposition'), /Verkaufsanalyse\.pdf/);
  assert.match(await download.text(), /^%PDF-/);
  assert.match(download.headers.get('content-disposition'), /^attachment;/); assert.match(download.headers.get('content-security-policy'), /sandbox/);
  assert.equal(download.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; sandbox allow-downloads");
  pdf = false; const legacy = await request('/id/download'); assert.match(legacy.headers.get('content-type'), /text\/html/);
  assert.equal(legacy.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  session = { ...original, isEmployee: false, sessionKind: 'organization' }; assert.equal((await request()).status, 403);
  session = original; revoke = true; assert.equal((await request('/id/download')).status, 403);
  session = original; revoke = false; fail = true; const failure = await request(); assert.equal(failure.status, 500); assert.doesNotMatch(await failure.text(), /SELECT|private source/);
});

test('template routes check CSRF and current personal rights for every action without starting report jobs', async t => {
  const original = { employeeNumber: 'synthetic', accountId: null, isEmployee: true,
    permissions: ['sales:analytics:access', 'sales:analytics:company:read', 'sales:history:read'] };
  let session = original, calls = [], revoke = false;
  const work = action => async (...args) => { calls.push([action, ...args]); if (revoke) session = { ...original, permissions: [] }; return { action }; };
  const app = express(); app.use(express.json());
  registerSalesReportJobRoutes(app, { requireSession: () => original, refreshSession: async () => session,
    assertCsrf(req) { if (req.get('X-CSRF-Token') !== 'test') throw Object.assign(Error(), { status: 403, code: 'PORTAL_CSRF_INVALID' }); },
    jobs: {}, templates: { list: work('list'), get: work('get'), save: work('save'), remove: work('remove') } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); t.after(() => new Promise(r => server.close(r)));
  const request = (suffix = '', method = 'GET', csrf = false) => fetch(`http://127.0.0.1:${server.address().port}/api/sales-report-templates${suffix}`,
    { method, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': 'test' } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify({ revision: 2 }) } : {}) });
  for (const [suffix, method] of [['', 'POST'], ['/a', 'PUT'], ['/a', 'DELETE']]) assert.equal((await request(suffix, method)).status, 403);
  assert.deepEqual(calls, []);
  for (const [suffix, method, action] of [['', 'GET', 'list'], ['/a', 'GET', 'get'], ['', 'POST', 'save'], ['/a', 'PUT', 'save'], ['/a', 'DELETE', 'remove']]) {
    const response = await request(suffix, method, true); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.json()).action, action); assert.equal(calls.at(-1)[1].employeeNumber, 'synthetic');
  }
  assert.deepEqual(calls.at(-2).slice(2), [{ revision: 2 }, 'a']);
  assert.deepEqual(calls.at(-1).slice(2), ['a', { revision: 2 }]);
  revoke = true; assert.equal((await request('/a')).status, 403);
  const count = calls.length; assert.equal((await request('/a', 'PUT', true)).status, 403); assert.equal(calls.length, count);
});
