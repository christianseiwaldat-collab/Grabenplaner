'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { withCoreFixture } = require('../test-support/postgresql-migration/core-fixture');
const { withSalesFixture } = require('../test-support/postgresql-migration/sales-fixture');

// Opt-in only: both fixtures verify the development identity and refuse existing
// business rows. Never point these URLs at a production or another project DB.
test('native PostgreSQL: shift preview and mutations keep HTTP authority, fresh state and measured work', {
  skip: !process.env.GP_PG_MIGRATION_LIVE,
  timeout: process.env.GP_SCHEDULE_BROWSER_QA ? 600000 : 240000,
}, async () => withCoreFixture(async core => withSalesFixture(8, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-shift-mutation-native-'));
  const configuration = require('../lib/persistence/configuration');
  const application = require('../lib/persistence/postgresql/application');
  const originalConfiguration = configuration.resolvePersistenceConfiguration;
  const originalOpen = application.openDeferredPostgresqlApplication;
  const env = {
    NODE_ENV: 'test', DB_PROVIDER: 'postgresql', GRABENPLANER_DATA_DIR: root,
    DB_PATH: path.join(root, 'core.postgresql'), BACKUP_DIR: path.join(root, 'backups'),
    GRABENPLANER_HOST: '127.0.0.1', GRABENPLANER_FORCE_PORTAL: '1',
    GRABENPLANER_TEST_TODAY: '2032-01-01', TZ: 'Europe/Vienna',
    GRABENPLANER_AMU_KEY: Buffer.alloc(32, 42).toString('base64'),
    GRABENPLANER_AMU_KEY_ID: 'synthetic-schedule-mutation',
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let subject, server, operations = [], authorizations = 0, snapshots = 0, revoke = false;
  const httpRequestScope = new AsyncLocalStorage();
  const revocationMarker = crypto.randomBytes(24).toString('hex');
  const measurements = [];
  // A separately exported, unmodified historical server can run the same HTTP
  // and security cases; only the new read-snapshot implementation assertion is
  // inapplicable there. The normal candidate test always requires snapshots.
  const baseline = process.env.GP_SCHEDULE_MUTATION_BASELINE === '1';
  configuration.resolvePersistenceConfiguration = () => ({
    providerId: 'postgresql', databasePath: env.DB_PATH,
    coreUrl: process.env.GP_CORE_APP_URL, salesUrl: process.env.GP_SALES_APP_URL,
    readers: { coreUrl: process.env.GP_CORE_READER_URL, salesUrl: process.env.GP_SALES_READER_URL },
    rehearsal: true,
  });
  const ownerWrite = async work => {
    await core.migrator.query('BEGIN');
    try {
      await core.migrator.query('SET LOCAL ROLE gp_core_owner');
      await work();
      await core.migrator.query('COMMIT');
    } catch (error) { await core.migrator.query('ROLLBACK'); throw error; }
  };
  application.openDeferredPostgresqlApplication = options => {
    const app = originalOpen({
      ...options,
      onOperation: id => operations.push(id),
      authorize: async input => {
        authorizations++;
        // Revoke at the real read-transaction authority boundary, immediately
        // before its normal fresh authority check and before any shift commit.
        const request = httpRequestScope.getStore();
        if (revoke && request?.method === 'POST' && request.url === '/api/shifts'
          && request.headers['x-gp-native-revocation'] === revocationMarker
          && input.readOnly && input.statementIds.includes('planning-settings.schedule.employees')) {
          revoke = false;
          await ownerWrite(() => core.migrator.query("UPDATE gp.portal_users SET active=0 WHERE employee_number='00001'"));
        }
        return options.authorize(input);
      },
    });
    return Object.freeze({ ...app, readSnapshot: work => { snapshots++; return app.readSnapshot(work); } });
  };
  const tokens = Object.fromEntries(['00001', '00002', '00003'].map(id => [id, crypto.randomBytes(32).toString('hex')]));
  const csrf = crypto.randomBytes(24).toString('hex');
  const shift = {
    employeeNumber: 'perf-18', locationId: '18', departmentId: 1, dutyCode: 'department',
    date: '2032-01-05', startTime: '09:00', endTime: '13:00', area: 'Test', note: 'Synthetic mutation fixture',
  };
  try {
    await ownerWrite(async () => {
      await core.migrator.query("INSERT INTO gp.cost_centers(id,code,name,type,cost_center_type_id) VALUES('cc05','05','Synthetic second branch','branch','branch')");
      await core.migrator.query("INSERT INTO gp.locations(id,name,cost_center_id) VALUES('05','Synthetic second branch','cc05')");
      await core.migrator.query(`INSERT INTO gp.employees(personnel_number,full_name,nickname,home_location_id,position_id,contracted_hours)
        SELECT 'perf-'||n,'Synthetic '||n,'Test '||n,'18','verkaufsmitarbeiter',38.5 FROM generate_series(1,18) n`);
      await core.migrator.query(`INSERT INTO gp.shifts(employee_number,location_id,department_id,shift_date,start_time,end_time,area,note)
        SELECT 'perf-'||n,'18',1,to_char(d,'YYYY-MM-DD'),'09:00','15:00','Test','Synthetic performance fixture'
        FROM generate_series(1,18) n CROSS JOIN generate_series('2032-01-05'::date,'2032-01-10'::date,'1 day'::interval) d
        WHERE NOT(n=18 AND d='2032-01-05'::date)`);
      await core.migrator.query('UPDATE gp.portal_users SET must_change_password=0');
      for (const [employee, token] of Object.entries(tokens)) {
        await core.migrator.query(`INSERT INTO gp.portal_sessions(id,employee_number,token_hash,expires_at)
          VALUES($1,$2,$3,'2099-01-01T00:00:00.000Z')`,
        [crypto.randomUUID(), employee, crypto.createHash('sha256').update(token).digest('hex')]);
      }
    });
    subject = require('../server');
    await subject.initializeApplicationPersistence();
    // Deliberately use the embedded HTTP server. Its post-commit derived refresh
    // remains synchronous: timing is conservative, not a claim about the queued
    // production scheduler. No maintenance or external background jobs start.
    server = await new Promise(resolve => {
      const value = http.createServer((request, response) => httpRequestScope.run(request, () => subject.app(request, response)));
      value.listen(0, '127.0.0.1', () => resolve(value));
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    async function request(method, route, body, { actor = '00001', withCsrf = true, expected = 200, label = null, revokeAuthority = false } = {}) {
      operations = []; authorizations = 0; snapshots = 0;
      const headers = { 'Content-Type': 'application/json' };
      if (revokeAuthority) headers['X-GP-Native-Revocation'] = revocationMarker;
      if (actor) headers.Cookie = 'grabenplaner_session=' + tokens[actor];
      if (withCsrf) {
        headers.Cookie = (headers.Cookie ? headers.Cookie + '; ' : '') + 'grabenplaner_csrf=' + csrf;
        headers['X-CSRF-Token'] = csrf;
      }
      const started = performance.now();
      const response = await fetch(origin + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
      const text = await response.text(), payload = text ? JSON.parse(text) : null;
      const measurement = { label, method, status: response.status, milliseconds: Math.round((performance.now() - started) * 10) / 10,
        catalogOperations: operations.length, authorizations, readSnapshots: snapshots,
        topOperations: Object.entries(operations.reduce((counts, id) => { counts[id] = (counts[id] || 0) + 1; return counts; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8) };
      assert.equal(response.status, expected, JSON.stringify({ method, route, payload, measurement }));
      if (label) measurements.push(measurement);
      return { payload, measurement };
    }
    const route = '/api/schedule?location=18&week=2032-01-05&fast=1';
    const state = async () => ({
      shifts: (await core.migrator.query("SELECT id,employee_number,shift_date,start_time,end_time FROM gp.shifts ORDER BY id")).rows,
      receipts: (await core.migrator.query('SELECT id FROM gp.work_rule_evaluation_runs ORDER BY id')).rows,
    });
    const canonical = async (id, expectedEnd, label) => {
      const result = await request('GET', route, undefined, { label });
      assert.equal(result.payload.weekStart, '2032-01-05');
      assert.equal(result.payload.shifts.length, expectedEnd === null ? 107 : 108);
      const saved = result.payload.shifts.find(row => Number(row.id) === Number(id));
      if (expectedEnd === null) assert.equal(saved, undefined);
      else { assert.equal(saved.employee_number, shift.employeeNumber); assert.equal(saved.end_time, expectedEnd); }
      return result;
    };
    await canonical(-1, null, 'warm-week');
    const beforeDenied = await state();
    await request('POST', '/api/shifts', shift, { withCsrf: false, expected: 403 });
    await request('POST', '/api/shifts', shift, { actor: null, expected: 401 });
    await request('POST', '/api/shifts', shift, { actor: '00002', expected: 403 });
    await request('POST', '/api/shifts', { ...shift, locationId: '05', departmentId: null }, { actor: '00003', expected: 403 });
    assert.deepEqual(await state(), beforeDenied, 'CSRF, authentication, permission and branch denials must not commit shifts or rule receipts');
    const previewBefore = await state();
    const preview = await request('POST', '/api/work-rules/evaluate', { locationId: '18', departmentId: 1, weekStart: '2032-01-05', shift }, { label: 'preview' });
    assert.equal(preview.payload.candidate.employeeNumber, shift.employeeNumber);
    assert.equal(preview.payload.candidate.endTime, '13:00');
    assert.ok(preview.measurement.authorizations > 0);
    if (!baseline) assert.ok(preview.measurement.readSnapshots >= 1);
    assert.deepEqual(await state(), previewBefore, 'preview must not persist a shift or receipt');
    const cycles = Number(process.env.GP_SCHEDULE_MUTATION_CYCLES || 5);
    assert.ok(Number.isInteger(cycles) && cycles >= 1 && cycles <= 20);
    for (let cycle = 0; cycle < cycles; cycle++) {
      const created = await request('POST', '/api/shifts', shift, { expected: 201, label: 'create' });
      const id = created.payload.id;
      assert.ok(Number.isSafeInteger(id) && id > 0);
      assert.ok(created.measurement.authorizations > 0);
      if (!baseline) assert.ok(created.measurement.readSnapshots >= 1);
      await canonical(id, '13:00', 'create-refresh');
      if (cycle === 0) {
        const beforeConflict = await state();
        const conflict = await request('POST', '/api/shifts', shift, { expected: 409 });
        assert.equal(conflict.payload.code, 'SHIFT_TIME_CONFLICT');
        assert.deepEqual(await state(), beforeConflict, 'overlap rejection must not commit');
      }
      const updated = await request('PUT', '/api/shifts/' + id, { ...shift, endTime: '14:00' }, { label: 'update' });
      assert.equal(updated.payload.endTime, '14:00');
      assert.ok(updated.measurement.authorizations > 0);
      if (!baseline) assert.ok(updated.measurement.readSnapshots >= 1);
      await canonical(id, '14:00', 'update-refresh');
      const deleted = await request('DELETE', '/api/shifts/' + id, undefined, { expected: 204, label: 'delete' });
      assert.ok(deleted.measurement.authorizations > 0);
      if (!baseline) assert.ok(deleted.measurement.readSnapshots >= 1);
      await canonical(id, null, 'delete-refresh');
    }
    if (process.env.GP_SCHEDULE_BROWSER_QA) {
      const qa = path.resolve(process.env.GP_SCHEDULE_BROWSER_QA);
      const localTemporaryRoot = path.resolve(__dirname, '../tmp');
      assert.ok(qa.startsWith(localTemporaryRoot + path.sep), 'Browser evidence stays in this local test workspace');
      fs.mkdirSync(qa, { recursive: true });
      assert.equal(fs.realpathSync(qa), qa);
      assert.equal(fs.existsSync(path.join(qa, 'finished')), false, 'Do not reuse a finished browser fixture');
      const password = 'Synthetic-Speed-QA-2032!';
      await ownerWrite(async () => core.migrator.query("UPDATE gp.portal_users SET password_hash=$1 WHERE employee_number='00001'", [await subject.hashPortalPassword(password)]));
      fs.writeFileSync(path.join(qa, 'ready.json'), JSON.stringify({ url: origin, employeeNumber: '00001', password, synthetic: true,
        weekStart: '2032-01-05', date: shift.date, locationId: '18', departmentId: 1, mutationTarget: shift.employeeNumber }), { flag: 'wx' });
      const deadline = Date.now() + 300000;
      while (!fs.existsSync(path.join(qa, 'finished')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
      assert.ok(fs.existsSync(path.join(qa, 'finished')), 'The bounded browser measurement must signal completion');
      assert.ok(fs.lstatSync(path.join(qa, 'finished')).isFile());
      // Normal login replaces the previous fixture session. Use a new real
      // session so the remaining check still exercises mid-request revocation.
      tokens['00001'] = crypto.randomBytes(32).toString('hex');
      await ownerWrite(() => core.migrator.query(`INSERT INTO gp.portal_sessions(id,employee_number,token_hash,expires_at)
        VALUES($1,'00001',$2,'2099-01-01T00:00:00.000Z')`,
      [crypto.randomUUID(), crypto.createHash('sha256').update(tokens['00001']).digest('hex')]));
      await canonical(-1, null, 'browser-cleanup-refresh');
    }
    const beforeRevocation = await state();
    revoke = true;
    const rejected = await request('POST', '/api/shifts', shift, { expected: 500, revokeAuthority: true });
    assert.equal(revoke, false, 'revocation must hit the actual read authority boundary');
    assert.equal(rejected.payload.id, undefined);
    assert.deepEqual(await state(), beforeRevocation, 'authority revoked during evaluation must prevent both mutation and receipt commit');
    await request('POST', '/api/shifts', shift, { expected: 401 });
    const summary = {};
    for (const label of ['preview', 'create', 'update', 'delete', 'create-refresh', 'update-refresh', 'delete-refresh']) {
      const samples = measurements.filter(value => value.label === label).map(value => value.milliseconds).sort((a, b) => a - b);
      summary[label] = { samples: samples.length, medianMilliseconds: samples[Math.floor(samples.length / 2)],
        p95Milliseconds: samples[Math.ceil(samples.length * 0.95) - 1], belowOneSecond: samples.every(value => value < 1000) };
    }
    const mutationAndRefresh = {};
    for (const label of ['create', 'update', 'delete']) {
      const writes = measurements.filter(value => value.label === label);
      const reads = measurements.filter(value => value.label === label + '-refresh');
      const sums = writes.map((value, index) => Math.round((value.milliseconds + reads[index].milliseconds) * 10) / 10).sort((a, b) => a - b);
      mutationAndRefresh[label] = { samples: sums.length, medianMilliseconds: sums[Math.floor(sums.length / 2)],
        p95Milliseconds: sums[Math.ceil(sums.length * 0.95) - 1], maximumMilliseconds: sums.at(-1), belowOneSecond: sums.every(value => value < 1000) };
    }
    console.log('schedule-mutation-native-evidence ' + JSON.stringify({ synthetic: true, baseline, backgroundRefresh: 'synchronous-embedded',
      countsAre: 'application catalog operations and authorization callbacks, not PostgreSQL wire SQL statements',
      cycles, employees: 21, weekShiftsBefore: 107, summary, mutationAndRefresh, measurements }));
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await subject?.closePersistenceForTests();
    configuration.resolvePersistenceConfiguration = originalConfiguration;
    application.openDeferredPostgresqlApplication = originalOpen;
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    assert.equal(fs.realpathSync(root), root);
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('gp-shift-mutation-native-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
})));
