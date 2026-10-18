'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const childProvider = process.env.GP_LOGIN_CONCURRENCY_HTTP_CHILD;
const GOOD_PASSWORD = 'Synthetic-Login-Concurrency-2026!';
const BAD_PASSWORD = 'Synthetic-Wrong-Concurrent-2026!';

if (!childProvider) {
  for (const provider of ['sqlite', 'postgresql']) {
    test(`Login concurrency HTTP: ${provider} real password verification, account locks and sessions`, {
      skip: provider === 'postgresql' && !process.env.GP_CORE_MIGRATOR_URL,
      timeout: 180000,
    }, async t => {
      const environment = { ...process.env, GP_LOGIN_CONCURRENCY_HTTP_CHILD: provider };
      delete environment.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, ['--test', '--test-concurrency=1', __filename], {
        cwd: path.resolve(__dirname, '..'),
        env: environment,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      t.after(() => { if (child.exitCode === null) child.kill(); });
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.equal(code, 0, output);
      assert.match(output, /HTTP_CONCURRENCY_VERIFIED/);
      t.diagnostic(output.trim());
    });
  }
} else {
  assert.ok(['sqlite', 'postgresql'].includes(childProvider));
  const gates = new Map();
  const realScrypt = crypto.scrypt;
  // Keep native scrypt and timingSafeEqual intact. Only callback delivery is
  // held, after the real computation, so every request has read its login row.
  crypto.scrypt = function gatedScrypt(password, ...args) {
    const callback = args.pop();
    return realScrypt(password, ...args, (error, key) => {
      const gate = gates.get(String(password));
      if (!gate) return callback(error, key);
      gate.callbacks.push(() => callback(error, key));
      if (gate.callbacks.length === gate.count) gate.ready();
    });
  };
  function barrier(password, count) {
    assert.equal(gates.has(password), false);
    let ready, reject;
    const pending = new Promise((resolve, fail) => { ready = resolve; reject = fail; });
    const gate = { count, callbacks: [], ready };
    const timer = setTimeout(() => reject(new Error(`Only ${gate.callbacks.length}/${count} real scrypt results reached the barrier`)), 15000);
    gates.set(password, gate);
    return {
      pending,
      release() { clearTimeout(timer); gates.delete(password); for (const callback of gate.callbacks.splice(0)) callback(); },
    };
  }

  test(`${childProvider}: HTTP account-wide atomic lock and stale-success rejection`, { timeout: 150000 }, async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-login-concurrency-http-'));
    const configuration = require('../lib/persistence/configuration');
    const originalConfiguration = configuration.resolvePersistenceConfiguration;
    let subject, server;
    Object.assign(process.env, {
      NODE_ENV: 'test', TZ: 'Europe/Vienna', DB_PROVIDER: 'sqlite', DATABASE_URL: '',
      DB_PATH: path.join(temporaryRoot, 'fixture.db'), BACKUP_DIR: path.join(temporaryRoot, 'backups'),
      GRABENPLANER_DATA_DIR: path.join(temporaryRoot, 'data'), GRABENPLANER_HOST: '127.0.0.1',
      GRABENPLANER_FORCE_PORTAL: '1', GRABENPLANER_SEED_DEMO: '1',
      GRABENPLANER_OPERATION_MODE: 'server', GRABENPLANER_PUBLIC_URL: 'https://plan.example.test',
      GRABENPLANER_TRUST_PROXY: 'loopback', GRABENPLANER_DEPLOYMENT_KIND: 'codespaces-test',
      GRABENPLANER_AMU_KEY_ID: 'synthetic-concurrency', GRABENPLANER_AMU_KEY: Buffer.alloc(32, 71).toString('base64'),
      GRABENPLANER_INTEGRATION_KEY_ID: 'synthetic-migration', GRABENPLANER_INTEGRATION_KEY: Buffer.alloc(32, 78).toString('base64'),
      GRABENPLANER_WIFI_WEBHOOK_SECRET: 'synthetic-concurrency-wifi-secret-2026',
      GRABENPLANER_SERVICE_CONTROL_TOKEN: 'synthetic-concurrency-service-secret-2026',
      GRABENPLANER_TEST_AMU_SCANNER: 'clean',
    });
    async function exercise(fixture) {
      if (fixture) {
        configuration.resolvePersistenceConfiguration = () => Object.freeze({
          providerId: 'postgresql', databasePath: path.join(temporaryRoot, 'core.postgresql'), databaseUrlConfigured: true,
          coreUrl: process.env.GP_CORE_APP_URL, salesUrl: process.env.GP_SALES_APP_URL,
          readers: { coreUrl: process.env.GP_CORE_READER_URL, salesUrl: process.env.GP_SALES_READER_URL },
          rehearsal: true, productActivation: false,
        });
      }
      subject = require('../server');
      await subject.initializeApplicationPersistence();
      const query = fixture ? async (sql, values = []) => {
        let parameter = 0;
        return (await fixture.core.migrator.query(sql.replace(/\?/g, () => '$' + (++parameter)), values)).rows;
      } : async (sql, values = []) => /^\s*SELECT\b/i.test(sql)
        ? subject.db.prepare(sql).all(...values) : (subject.db.prepare(sql).run(...values), []);
      if (fixture) await fixture.core.migrator.query('SET ROLE gp_core_owner; SET search_path=pg_catalog,gp');
      await query("UPDATE settings SET value='5' WHERE key='max_failed_login_attempts'");
      server = await new Promise(resolve => { const listener = subject.app.listen(0, '127.0.0.1', () => resolve(listener)); });
      const base = 'http://127.0.0.1:' + server.address().port;
      const salt = Buffer.alloc(16, 81);
      const hash = 'scrypt-v1$' + salt.toString('base64url') + '$' + crypto.scryptSync(GOOD_PASSWORD, salt, 64).toString('base64url');
      const location = (await query('SELECT id FROM locations ORDER BY id LIMIT 1'))[0].id;
      async function seed(id, organization = false) {
        if (organization) {
          await query("INSERT INTO portal_organization_accounts(id,login_name,display_name,account_type,password_hash,active,must_change_password) VALUES(?,?,?,'branch',?,1,0)", [id, id, 'Synthetic concurrency branch', hash]);
          await query('INSERT INTO portal_organization_account_scopes(account_id,location_id) VALUES(?,?)', [id, location]);
        } else {
          await query('INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,active) VALUES(?,?,?,?,1)', [id, 'Synthetic concurrency employee', 'Synthetic', location]);
          await query("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password) VALUES(?,?,'employee',1,0)", [id, hash]);
        }
      }
      async function login(id, password, channel, ip) {
        const mobile = channel === 'mobile';
        const response = await fetch(base + (mobile ? '/api/mobile/v1/auth/login' : '/api/portal/v1/auth/login'), {
          method: 'POST', signal: AbortSignal.timeout(30000),
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': ip },
          body: JSON.stringify({ employeeNumber: id, password, ...(mobile ? { device: {
            installationId: 'synthetic-' + crypto.randomUUID(), platform: 'android', label: 'Synthetic device', appVersion: '1.0.0',
          } } : {}) }),
        });
        return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() };
      }
      async function state(id, organization) {
        const table = organization ? 'portal_organization_accounts' : 'portal_users';
        const column = organization ? 'id' : 'employee_number';
        const row = (await query(`SELECT failed_login_attempts,locked_until FROM ${table} WHERE ${column}=?`, [id]))[0];
        return { ...row, failed_login_attempts: Number(row.failed_login_attempts) };
      }
      const cases = [
        { id: 'syn-http-personal', channels: ['browser'], organization: false },
        { id: 'syn-http-organization', channels: ['browser'], organization: true },
        { id: 'syn-http-mobile', channels: ['mobile'], organization: false },
        { id: 'syn-http-mixed', channels: ['browser', 'mobile'], organization: false },
      ];
      let verifiedCases = 0, verifiedSuccesses = 0;
      for (let index = 0; index < cases.length; index++) {
        const scenario = cases[index], ip = '198.51.100.' + (20 + index);
        await t.test(scenario.id + ': eight failures lock at five across simultaneous scrypt results', async () => {
          await seed(scenario.id, scenario.organization);
          const successGate = barrier(GOOD_PASSWORD, 1);
          const staleSuccess = login(scenario.id, GOOD_PASSWORD, scenario.channels[0], ip);
          let failureGate, failed = [];
          try {
            await successGate.pending;
            failureGate = barrier(BAD_PASSWORD, 8);
            failed = Array.from({ length: 8 }, (_, attempt) => login(scenario.id, BAD_PASSWORD, scenario.channels[attempt % scenario.channels.length], ip));
            await failureGate.pending;
            assert.equal((await state(scenario.id, scenario.organization)).failed_login_attempts, 0, 'No verifier has been allowed to update its stale account snapshot yet');
            failureGate.release();
            for (const result of await Promise.all(failed)) assert.equal(result.status, 401, JSON.stringify(result.body));
            const locked = await state(scenario.id, scenario.organization);
            assert.equal(locked.failed_login_attempts, 5);
            assert.ok(new Date(locked.locked_until).getTime() > Date.now(), 'Account must be locked by the database threshold');
            successGate.release();
            const stale = await staleSuccess;
            assert.equal(stale.status, 429, JSON.stringify(stale.body));
            assert.match(stale.body.code || stale.body.error?.code, /^(PORTAL|MOBILE)_ACCOUNT_LOCKED$/);
            assert.equal(stale.cookies.some(cookie => /^grabenplaner_session=/.test(cookie)), false);
            assert.equal(stale.body.tokenSet, undefined);
            for (const channel of scenario.channels) {
              const blocked = await login(scenario.id, GOOD_PASSWORD, channel, ip);
              assert.equal(blocked.status, 429, JSON.stringify(blocked.body));
              assert.match(blocked.body.code || blocked.body.error?.code, /^(PORTAL|MOBILE)_ACCOUNT_LOCKED$/);
            }
            const sessionTable = scenario.organization ? 'portal_organization_sessions' : 'portal_sessions';
            const accountColumn = scenario.organization ? 'account_id' : 'employee_number';
            assert.equal(Number((await query(`SELECT count(*) count FROM ${sessionTable} WHERE ${accountColumn}=?`, [scenario.id]))[0].count), 0);
            if (!scenario.organization) assert.equal(Number((await query('SELECT count(*) count FROM mobile_sessions WHERE employee_number=?', [scenario.id]))[0].count), 0);
            verifiedCases++;
          } finally { failureGate?.release(); successGate.release(); await Promise.allSettled([...failed, staleSuccess]); }
        });
      }
      assert.equal(verifiedCases, cases.length, 'Every account/channel race must pass before reporting verification');
      await t.test('valid personal/organization/mobile logins clear failures and browser password change remains usable', async () => {
        for (const [index, channel] of ['browser', 'mobile', 'organization'].entries()) {
          const id = 'syn-http-success-' + channel, ip = '198.51.100.' + (40 + index);
          const organization = channel === 'organization';
          await seed(id, organization);
          for (let i = 0; i < 2; i++) assert.equal((await login(id, BAD_PASSWORD, channel, ip)).status, 401);
          assert.equal((await state(id, organization)).failed_login_attempts, 2);
          const result = await login(id, GOOD_PASSWORD, channel, ip);
          assert.equal(result.status, channel === 'mobile' ? 201 : 200, JSON.stringify(result.body));
          assert.equal((await state(id, organization)).failed_login_attempts, 0);
          assert.equal((await state(id, organization)).locked_until, null);
          if (channel === 'mobile') { assert.ok(result.body.tokenSet?.accessToken); verifiedSuccesses++; continue; }
          assert.equal(result.body.authenticated, true);
          if (organization) { verifiedSuccesses++; continue; }
          const cookie = result.cookies.map(value => value.split(';')[0]).join('; ');
          const csrf = decodeURIComponent(result.cookies.find(value => value.startsWith('grabenplaner_csrf=')).split(';')[0].split('=').slice(1).join('='));
          const changed = await fetch(base + '/api/portal/v1/me/password', { method: 'PUT', headers: {
            'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': ip,
            Cookie: cookie, 'X-CSRF-Token': csrf,
          }, body: JSON.stringify({ currentPassword: GOOD_PASSWORD, newPassword: GOOD_PASSWORD + '-changed' }) });
          assert.equal(changed.status, 200, await changed.text());
          assert.equal((await login(id, GOOD_PASSWORD, channel, ip)).status, 401);
          assert.equal((await login(id, GOOD_PASSWORD + '-changed', channel, ip)).status, 200);
          assert.equal((await state(id)).failed_login_attempts, 0);
          verifiedSuccesses++;
        }
      });
      assert.equal(verifiedSuccesses, 3);
      console.log('HTTP_CONCURRENCY_VERIFIED ' + JSON.stringify({ provider: childProvider, channels: ['personal-browser', 'organization-browser', 'mobile', 'shared-browser-mobile'], simultaneousFailures: 8, lockThreshold: 5, staleSuccessDenied: true, passwordChangeRegression: true }));
    }
    try {
      if (childProvider === 'postgresql') {
        for (const domain of ['CORE', 'SALES']) for (const purpose of ['APP', 'READER', 'MIGRATOR']) {
          const connection = new URL(process.env[`GP_${domain}_${purpose}_URL`]);
          assert.equal(connection.hostname, '127.0.0.1');
          assert.equal(connection.pathname, '/gp_migration_' + domain.toLowerCase());
        }
        await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async fixture => {
          try { await exercise(fixture); }
          finally { if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); server = null; await subject?.closePersistenceForTests(); subject?.releaseInstanceLockForTests(); subject = null; }
        }, { warmWorkers: false });
      } else await exercise();
    } finally {
      crypto.scrypt = realScrypt;
      if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await subject?.closePersistenceForTests(); subject?.releaseInstanceLockForTests();
      configuration.resolvePersistenceConfiguration = originalConfiguration;
      assert.equal(path.dirname(fs.realpathSync(temporaryRoot)), fs.realpathSync(os.tmpdir()));
      fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
