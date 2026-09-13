'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const persistenceAsyncCollections = require('../lib/persistence/postgresql/application-operations/async-collections');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const listRoute = section('app.get("/api/portal/v1/amu-reports",', 'app.get("/api/portal/v1/amu-reports/:id",');
const routingFunctions = section('async function localAmuReviewerRecipients(', 'function amuResponsibilityForActorWithRouting(');
const tick = () => new Promise(resolve => setImmediate(resolve));

function listFixture() {
  const rows = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, status: 'submitted', employee_number: 'worker', location_id: i % 2 ? '18' : '05' }));
  let rightsReads = 0, routingReads = 0, inFlight = 0, peak = 0, granted = true, fail = false, body, handler;
  const context = {
    app: { get(_route, fn) { handler = fn; } }, persistenceAsyncCollections,
    requirePortalReadOrLocal: () => ({ employeeNumber: 'reviewer' }),
    actorCanListAmuReports: () => true, actorCanReadAmuFiles: () => true,
    actorCanReviewAmuReports: () => true, actorCanReadAmuSensitiveMetadata: () => false,
    sessionHasLocalAmuAccess: () => false,
    sicknessAmuManagementRepository: { listAllAmuReports: async () => rows },
    sessionCanListAmuReport: (_session, row) => row.location_id === '18',
    portalUsersForAdmin: async () => { rightsReads++; return [{ employeeNumber: 'reviewer', granted }]; },
    managerProfileMatchesAmuReport: () => false,
    departmentManagerProfileMatchesAmuReport: async user => {
      routingReads++; inFlight++; peak = Math.max(peak, inFlight);
      try { await tick(); if (fail) throw Error('database unavailable'); return user.granted; }
      finally { inFlight--; }
    },
    locationPlannerProfileMatchesAmuReport: () => false,
    requestReviewerRecipients: async () => [],
    serializeAmuReports: async (selected, options) => {
      // Supplying a session here would recompute every capability/routing.
      assert.equal(options.session, undefined);
      assert.equal(options.includeIdentityCheck, false);
      return selected.map(row => ({ ...row }));
    },
    amuReportCapabilitiesWithRouting: (_session, _row, routing) => ({ review: routing.reviewerEmployeeNumbers.includes('reviewer') }),
    amuResponsibilityForActorWithRouting: (_row, _session, routing) => ({ assigned_to_me: routing.reviewerEmployeeNumbers.includes('reviewer'), stage: routing.stage }),
    redactAmuReportFileMetadata: row => row,
  };
  vm.runInNewContext(routingFunctions + listRoute, context);
  return {
    context, rows,
    run: async () => { body = undefined; await handler({}, { json(value) { body = value; } }); return body; },
    stats: () => ({ rightsReads, routingReads, peak, body }),
    revoke: () => { granted = false; }, fail: () => { fail = true; },
  };
}

test('AUM list scopes first, reads rights once, resolves each report once with bounded concurrency', async () => {
  const f = listFixture(), result = await f.run();
  assert.equal(result.reports.length, 60);
  assert.equal(result.pendingCount, 60);
  assert.ok(result.reports.every(row => row.location_id === '18' && row.capabilities.review));
  assert.equal(f.stats().rightsReads, 1);
  assert.equal(f.stats().routingReads, 60);
  assert.equal(f.stats().peak, 1);
  f.revoke();
  const revoked = await f.run();
  assert.equal(f.stats().rightsReads, 2, 'a later request must load current rights');
  assert.equal(revoked.pendingCount, 0);
  assert.ok(revoked.reports.every(row => !row.capabilities.review && row.responsibility.stage === 'hr'));
});

test('empty AUM list avoids rights reads; a failed routing read sends no partial response', async () => {
  const empty = listFixture(); empty.rows.length = 0;
  assert.equal((await empty.run()).reports.length, 0);
  assert.equal(empty.stats().rightsReads, 0);
  const failure = listFixture(); failure.fail();
  await assert.rejects(failure.run(), /database unavailable/);
  assert.equal(failure.stats().body, undefined);
  assert.equal(failure.stats().routingReads, 1);
});

test('single report and action routing still load fresh rights and exclude the report owner', async () => {
  const f = listFixture(), report = { employee_number: 'worker', location_id: '18' };
  assert.equal((await f.context.resolveAmuResponsibilityForReport(report)).stage, 'local');
  f.revoke();
  assert.equal((await f.context.resolveAmuResponsibilityForReport(report)).stage, 'hr');
  assert.equal(f.stats().rightsReads, 2);
  assert.equal((await f.context.localAmuReviewerRecipients({ ...report, employee_number: 'reviewer' }, [{ employeeNumber: 'reviewer', granted: true }])).length, 0);
});

test('user rights projection limits pending reads while preserving all users and private denial authority', async () => {
  let inFlight = 0, peak = 0, reads = 0;
  const read = async value => { reads++; inFlight++; peak = Math.max(peak, inFlight); await tick(); inFlight--; return value; };
  const context = {
    persistenceAsyncCollections,
    organizationPersonnelRepository: {
      listPortalUsersForAdmin: async () => Array.from({ length: 40 }, (_, i) => ({ personnel_number: String(i), role: i ? 'employee' : 'developer', role_permissions: '[]' })),
      listPortalAccessScopes: async () => read([{ location_id: '18' }]),
      listPortalPermissionScopeGrants: async () => read([]),
      getPersonnelLearningPermissionDenialAuthority: async () => read({ denied: true }),
    },
    portalPermissionGrantsForEmployee: async () => read(['sickness:read']),
    portalPermissionDenialsForEmployee: async () => read(['users:write']),
    PERSONNEL_LEARNING_PERMISSIONS: { CROSS_LOCATION_ASSIGN: 'learning:assign' },
    parsePortalPermissions: JSON.parse, normalizeTimeConfirmationLevel: () => 'A',
    normalizedManagerAmuAccessMode: () => 'inherit', parsePersonnelFieldPermissionProjection: () => ({}),
  };
  vm.runInNewContext(section('async function portalUsersForAdmin()', 'async function portalUsersForActor('), context);
  const users = await context.portalUsersForAdmin();
  assert.equal(users.length, 40); assert.equal(reads, 200); assert.equal(peak, 5);
  assert.equal(users[0].roleLocked, true);
  assert.ok(users.every(user => user.grantedPermissions[0] === 'sickness:read' && user.deniedPermissions[0] === 'users:write' && user.scopes[0].locationId === '18'));
  assert.equal(users[0].personnelLearningDenialAuthority.denied, true);
  assert.equal(Object.getOwnPropertyDescriptor(users[0], 'personnelLearningDenialAuthority').enumerable, false);
});
