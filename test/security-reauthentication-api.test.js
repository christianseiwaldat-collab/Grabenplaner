'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const provider = process.env.GP_REAUTH_HTTP_CHILD;
const PASSWORD = 'Synthetic reauthentication orbit spruce 2026!';
const ORIGIN = 'https://reauth.example.test';
const ACCEPTED = 'backup.admin.reauthentication.accepted';

if (!provider) {
  for (const database of ['postgresql']) test(`reauthentication HTTP: ${database}`, {
    skip: database === 'postgresql' && !process.env.GP_CORE_MIGRATOR_URL,
    timeout: 240000,
  }, async t => {
    const env = { ...process.env, GP_REAUTH_HTTP_CHILD: database };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', __filename], {
      cwd: path.resolve(__dirname, '..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(exit, 0, output);
    assert.match(output, /REAUTH_HTTP_VERIFIED/);
    t.diagnostic(output.trim());
  });
} else {
  assert.ok(['postgresql'].includes(provider));
  const gates = new Map(), originalScrypt = crypto.scrypt;
  // Run native scrypt unchanged; hold only delivery of its completed callback.
  // This forces races after the actual server has read the credential snapshot.
  crypto.scrypt = function gatedScrypt(password, ...args) {
    const callback = args.pop();
    return originalScrypt(password, ...args, (error, key) => {
      const gate = gates.get(String(password));
      if (!gate) return callback(error, key);
      gate.callbacks.push(() => callback(error, key));
      if (gate.callbacks.length === gate.count) gate.ready();
    });
  };
  function barrier(count = 1) {
    assert.equal(gates.has(PASSWORD), false);
    let ready, reject;
    const pending = new Promise((resolve, fail) => { ready = resolve; reject = fail; });
    const gate = { count, callbacks: [], ready };
    const timer = setTimeout(() => reject(new Error(`scrypt barrier ${gate.callbacks.length}/${count}`)), 20000);
    gates.set(PASSWORD, gate);
    return { pending, release() { clearTimeout(timer); gates.delete(PASSWORD); for (const callback of gate.callbacks.splice(0)) callback(); } };
  }

  test(`${provider}: native authentication, rotation, all callers and transaction races`, { timeout: 210000 }, async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-reauth-http-'));
    const configuration = require('../lib/persistence/configuration');
    const originalConfiguration = configuration.resolvePersistenceConfiguration;
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const restorers = [];
    let subject, server, fixture, groups = 0, operationFailure = false;
    const effects = { create: 0, activate: 0, reboot: 0, export: 0 };
    function replace(modulePath, replacements) {
      const module = require(modulePath);
      for (const [key, replacement] of Object.entries(replacements)) {
        const before = module[key]; module[key] = replacement;
        restorers.push(() => { module[key] = before; });
      }
    }
    // Only external operating effects are replaced. Authentication, authorization,
    // CSRF, persistence guards, transactions, audits and HTTP serialization remain real.
    // These tests do not qualify a real offsite provider, export format or host reboot.
    replace('../lib/offsite-target-client', {
      createManagedOffsiteFolder: async label => {
        effects.create++;
        if (operationFailure) throw Object.assign(new Error('synthetic unavailable'), { code: 'UNAVAILABLE' });
        return { createdFolder: label, activeFolder: null };
      },
      activateManagedOffsiteFolder: async label => { effects.activate++; return { activeFolder: label, migrationMode: 'synthetic', recoverySetState: 'ready', fallbackPreserved: true }; },
      listManagedOffsiteFolders: async () => ({ folders: [], activeFolder: null }),
    });
    replace('../lib/host-reboot-control-client', {
      readHostBootGeneration: () => '11111111-2222-4333-8444-555555555555',
      assertSafeSocket: () => true,
      requestHostReboot: async () => { throw new Error('unexpected direct reboot dispatch'); },
    });
    replace('../lib/host-security-status', { readHostSecurityStatus: () => ({ configured: true, statusAvailable: true, rebootRequired: true, pendingConfirmation: false, lastErrorCode: null }) });
    replace('../lib/controlled-host-reboot', { prepareControlledHostReboot: async options => {
      await options.recordRequest(); effects.reboot++;
      return { acceptedAt: new Date().toISOString() };
    } });
    replace('../lib/persistence/postgresql/lifecycle-control', {
      available: () => true,
      requestControl: async ({ action }) => { assert.equal(action, 'vps-reboot'); effects.reboot++; return { acceptedAt: new Date().toISOString() }; },
    });
    replace('../lib/persistence/postgresql/operations/application-export', { createApplicationDatabaseExport: async () => {
      effects.export++;
      const directory = fs.mkdtempSync(path.join(temporaryRoot, 'synthetic-export-'));
      const filename = path.join(directory, 'synthetic-export.bin'), bytes = Buffer.from('synthetic export boundary only\n');
      fs.writeFileSync(filename, bytes);
      return { temporaryRoot: directory, path: filename, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), extension: 'bin', contentType: 'application/octet-stream', releaseWorkspace() {} };
    } });
    Object.assign(process.env, {
      NODE_ENV: 'test', TZ: 'Europe/Vienna', DB_PROVIDER: 'postgresql', DATABASE_URL: '',
      DB_PATH: path.join(temporaryRoot, 'fixture.db'), BACKUP_DIR: path.join(temporaryRoot, 'backups'),
      GRABENPLANER_DATA_DIR: path.join(temporaryRoot, 'data'), GRABENPLANER_HOST: '127.0.0.1',
      GRABENPLANER_FORCE_PORTAL: '1', GRABENPLANER_SEED_DEMO: '1', GRABENPLANER_OPERATION_MODE: 'server',
      GRABENPLANER_PUBLIC_URL: ORIGIN, GRABENPLANER_TRUST_PROXY: 'loopback', GRABENPLANER_DEPLOYMENT_KIND: 'codespaces-test',
      GRABENPLANER_AMU_KEY_ID: 'synthetic-reauth', GRABENPLANER_AMU_KEY: Buffer.alloc(32, 71).toString('base64'),
      GRABENPLANER_INTEGRATION_KEY_ID: 'synthetic-reauth', GRABENPLANER_INTEGRATION_KEY: Buffer.alloc(32, 78).toString('base64'),
      GRABENPLANER_SERVICE_CONTROL_TOKEN: 'synthetic-reauth-service-secret-2026', GRABENPLANER_TEST_AMU_SCANNER: 'clean',
      GRABENPLANER_PRIVATE_WORKSPACE_MODULE: '',
    });
    async function exercise(activeFixture) {
      fixture = activeFixture;
      configuration.resolvePersistenceConfiguration = () => Object.freeze({
        providerId: 'postgresql', databasePath: path.join(temporaryRoot, 'core.postgresql'), databaseUrlConfigured: true,
        coreUrl: process.env.GP_CORE_APP_URL, salesUrl: process.env.GP_SALES_APP_URL,
        readers: { coreUrl: process.env.GP_CORE_READER_URL, salesUrl: process.env.GP_SALES_READER_URL }, rehearsal: true, productActivation: false,
      });
      subject = require('../server');
      await subject.initializeApplicationPersistence();
      await fixture.core.migrator.query('SET ROLE gp_core_owner; SET search_path=pg_catalog,gp');
      const query = (async (sql, values = []) => {
        let index = 0; return (await fixture.core.migrator.query(sql.replace(/\?/g, () => '$' + (++index)), values)).rows;
      });
      const ddl = sql => (fixture.core.migrator.query(sql));
      const salt = Buffer.alloc(16, 81);
      const passwordHash = password => 'scrypt-v1$' + salt.toString('base64url') + '$' + crypto.scryptSync(password, salt, 64).toString('base64url');
      const location = (await query('SELECT id FROM locations ORDER BY id LIMIT 1'))[0].id;
      server = await new Promise(resolve => { const listener = subject.app.listen(0, '127.0.0.1', () => resolve(listener)); });
      const base = 'http://127.0.0.1:' + server.address().port;
      async function request(route, { method = 'GET', auth, body, csrf } = {}) {
        const response = await fetch(base + route, { method, signal: AbortSignal.timeout(30000), headers: {
          'Content-Type': 'application/json', Origin: ORIGIN, 'X-Forwarded-Proto': 'https',
          'Sec-Fetch-Site': 'same-origin', ...(auth ? { Cookie: auth.cookie, 'X-CSRF-Token': csrf ?? auth.csrf } : {}),
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const bytes = Buffer.from(await response.arrayBuffer());
        const json = response.headers.get('content-type')?.includes('application/json');
        let result;
        try { result = json ? JSON.parse(bytes.toString()) : { bytes: bytes.length }; }
        finally { bytes.fill(0); }
        return { status: response.status, body: result, cookies: response.headers.getSetCookie(), changed: response.headers.get('x-gp-session-changed') };
      }
      function credentials(result) {
        return { cookie: result.cookies.map(value => value.split(';')[0]).join('; '),
          csrf: decodeURIComponent(result.cookies.find(value => value.startsWith('grabenplaner_csrf='))?.split(';')[0].slice('grabenplaner_csrf='.length) || '') };
      }
      async function seed(id, role = 'developer') {
        await query('INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,active) VALUES(?,?,?,?,1)', [id, 'Synthetic reauthentication actor', 'Synthetic', location]);
        await query('INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_policy_version) VALUES(?,?,?,1,0,1)', [id, passwordHash(PASSWORD), role]);
        const entered = await request('/api/portal/v1/auth/login', { method: 'POST', body: { employeeNumber: id, password: PASSWORD } });
        assert.equal(entered.status, 200, JSON.stringify(entered.body)); return credentials(entered);
      }
      const info = auth => request('/api/portal/v1/session', { auth });
      const rows = id => query('SELECT id,token_hash,authenticated_at,absolute_expires_at,expires_at,revoked_at FROM portal_sessions WHERE employee_number=? ORDER BY id', [id]);
      const active = async id => (await rows(id)).filter(row => !row.revoked_at);
      const auditCount = async id => Number((await query('SELECT COUNT(*) count FROM audit_log WHERE actor=? AND action=?', [id, ACCEPTED]))[0].count);
      const create = (auth, password = PASSWORD, options = {}) => request('/api/backup/offsite-folders', {
        method: 'POST', auth, body: { confirmation: 'CREATE_MANAGED_OFFSITE_FOLDER', folderLabel: 'SyntheticFolder', currentPassword: password }, ...options,
      });
      const download = (auth, password = PASSWORD, options = {}) => request('/api/backup/database-download', {
        method: 'POST', auth, body: { confirmation: 'DATABASE_BACKUP_DOWNLOAD', currentPassword: password }, ...options,
      });
      async function assertRotated(id, before, oldAuth, result, expectedStatus = 201) {
        assert.equal(result.status, expectedStatus, JSON.stringify(result.body)); assert.equal(result.changed, '1');
        const replacement = credentials(result); assert.ok(replacement.cookie); assert.ok(replacement.csrf);
        assert.notEqual(replacement.cookie, oldAuth.cookie); assert.notEqual(replacement.csrf, oldAuth.csrf);
        assert.equal((await info(oldAuth)).body.authenticated, false);
        assert.equal((await info(replacement)).body.authenticated, true);
        const rawToken = decodeURIComponent(replacement.cookie.split('; ').find(value => value.startsWith('grabenplaner_session=')).slice('grabenplaner_session='.length));
        const after = (await active(id)).find(row => row.token_hash === crypto.createHash('sha256').update(rawToken).digest('hex'));
        assert.ok(after); assert.notEqual(after.token_hash, before.token_hash);
        assert.equal(after.authenticated_at, before.authenticated_at); assert.equal(after.absolute_expires_at, before.absolute_expires_at);
        assert.ok((await rows(id)).find(row => row.id === before.id).revoked_at);
        return replacement;
      }
      for (const caller of ['create', 'activate', 'download']) await t.test(`${caller}: real HTTP rotates session and CSRF while preserving authentication age`, async () => {
        const id = 'syn-reauth-' + caller, auth = await seed(id), before = (await active(id))[0];
        const result = caller === 'create' ? await create(auth) : caller === 'activate'
          ? await request('/api/backup/offsite-folders/active', { method: 'PUT', auth, body: { confirmation: 'ACTIVATE_MANAGED_OFFSITE_FOLDER', folderLabel: 'SyntheticFolder', currentPassword: PASSWORD } })
          : await request('/api/backup/database-download', { method: 'POST', auth, body: { confirmation: 'DATABASE_BACKUP_DOWNLOAD', currentPassword: PASSWORD } });
        const replacement = await assertRotated(id, before, auth, result, caller === 'create' ? 201 : 200);
        assert.equal(await auditCount(id), 1);
        assert.equal((await create(replacement, PASSWORD, { csrf: auth.csrf })).status, 403);
        assert.equal((await info(replacement)).body.authenticated, true);
        if (caller === 'download') assert.ok(result.body.bytes > 0);
        groups++;
      });
      await t.test('repeated reauthentication of an aged administrator clamps both idle deadline and cookie lifetime to the original absolute end', async () => {
        const id = 'syn-reauth-near-absolute-end';
        let auth = await seed(id, 'admin');
        const clock = Date.now(), absoluteEnd = new Date(clock + 60000).toISOString();
        const originalAuthentication = new Date(clock - 8 * 3600000 + 60000).toISOString();
        await query('UPDATE portal_sessions SET authenticated_at=?,absolute_expires_at=?,expires_at=? WHERE employee_number=?',
          [originalAuthentication, absoluteEnd, absoluteEnd, id]);
        for (let iteration = 0; iteration < 2; iteration++) {
          const before = (await active(id))[0], result = await download(auth);
          auth = await assertRotated(id, before, auth, result, 200);
          const current = (await active(id))[0];
          assert.equal(current.authenticated_at, originalAuthentication);
          assert.equal(current.absolute_expires_at, absoluteEnd);
          assert.ok(Date.parse(current.expires_at) <= Date.parse(absoluteEnd));
          assert.ok(Date.parse(current.expires_at) > Date.now());
          assert.equal(result.cookies.length, 2);
          for (const cookie of result.cookies) {
            const matched = /(?:^|;\s*)Max-Age=(\d+)(?:;|$)/.exec(cookie);
            assert.ok(matched, 'both credentials have an explicit lifetime');
            assert.ok(Number(matched[1]) > 0 && Number(matched[1]) <= 60, 'reauthentication does not restart an eight-hour or thirty-minute lifetime');
          }
        }
        assert.equal((await rows(id)).length, 3); assert.equal((await active(id)).length, 1);
        assert.equal(await auditCount(id), 2); groups++;
      });
      await t.test('rotation replaces only the invoking session and a later operating error retains the committed credential', async () => {
        const id = 'syn-reauth-effect-error', auth = await seed(id), before = (await active(id))[0];
        const otherId = crypto.randomUUID(), otherToken = crypto.randomBytes(32).toString('base64url');
        const otherAuth = { cookie: 'grabenplaner_session=' + otherToken, csrf: '' };
        await query('INSERT INTO portal_sessions(id,employee_number,token_hash,created_at,last_seen_at,expires_at,authenticated_at,absolute_expires_at) SELECT ?,employee_number,?,created_at,last_seen_at,expires_at,authenticated_at,absolute_expires_at FROM portal_sessions WHERE id=?', [otherId, crypto.createHash('sha256').update(otherToken).digest('hex'), before.id]);
        assert.equal((await info(otherAuth)).body.authenticated, true);
        operationFailure = true;
        try {
          const result = await create(auth);
          assert.ok(result.status >= 400); const replacement = await assertRotated(id, before, auth, result, result.status);
          assert.equal((await info(replacement)).body.authenticated, true);
          assert.equal((await rows(id)).find(row => row.id === otherId).revoked_at, null);
          assert.equal((await info(otherAuth)).body.authenticated, true);
          assert.equal((await active(id)).length, 2); assert.equal(await auditCount(id), 1);
        } finally { operationFailure = false; } groups++;
      });
      await t.test('incorrect password, CSRF, role and permission reject without rotation or operating action', async () => {
        const auth = await seed('syn-reauth-negative'), before = await rows('syn-reauth-negative'), count = effects.create;
        for (const result of [await create(auth, PASSWORD + '-wrong'), await create(auth, PASSWORD, { csrf: 'wrong' })]) {
          assert.equal(result.status, 403); assert.equal(result.cookies.length, 0); assert.equal(result.changed, null);
        }
        const ordinary = await seed('syn-reauth-role', 'employee');
        assert.equal((await create(ordinary)).status, 403);
        // Developers intentionally retain all permissions. Exercise an explicit
        // denial against an administrator on the administrator download route.
        const denied = await seed('syn-reauth-denied', 'admin'), deniedBefore = await rows('syn-reauth-denied');
        await query("INSERT INTO portal_permission_denials(employee_number,permission,denied_by) VALUES(?,'backup:write','synthetic')", ['syn-reauth-denied']);
        const rejected = await download(denied);
        assert.equal(rejected.status, 403); assert.equal(rejected.cookies.length, 0); assert.equal(rejected.changed, null);
        assert.deepEqual(await rows('syn-reauth-denied'), deniedBefore);
        assert.equal(effects.create, count); assert.deepEqual(await rows('syn-reauth-negative'), before); groups++;
      });
      await t.test('two real simultaneous reauthentications have one winner and no valid predecessor', async () => {
        const id = 'syn-reauth-parallel', auth = await seed(id), before = (await active(id))[0], gate = barrier(2);
        const pending = [create(auth), create(auth)];
        try {
          await gate.pending; gate.release(); const results = await Promise.all(pending);
          const won = results.filter(r => r.status === 201), lost = results.filter(r => r.status !== 201);
          assert.equal(won.length, 1, JSON.stringify(results)); assert.equal(lost.length, 1);
          assert.ok([401, 403, 409].includes(lost[0].status)); assert.equal(lost[0].cookies.length, 0);
          await assertRotated(id, before, auth, won[0]); assert.equal((await active(id)).length, 1); assert.equal(await auditCount(id), 1);
        } finally { gate.release(); await Promise.allSettled(pending); } groups++;
      });
      const manager = await seed('syn-reauth-reset-manager');
      for (const change of ['logout', 'reset', 'expiry', 'absolute-expiry', 'permission', 'role', 'inactive', 'employee-inactive', 'locked', 'must-change', 'password']) await t.test(`${change} during native password verification prevents stale reauthentication`, async () => {
        const id = 'syn-reauth-race-' + change, auth = await seed(id, 'admin'), gate = barrier(), count = effects.create;
        const pending = download(auth);
        try {
          await gate.pending;
          if (change === 'logout') assert.equal((await request('/api/portal/v1/auth/logout', { method: 'POST', auth, body: {} })).status, 200);
          else if (change === 'reset') assert.equal((await request('/api/portal/v1/users/' + id, { method: 'PUT', auth: manager,
            body: { role: 'admin', active: true, password: PASSWORD + '-admin-reset', mustChangePassword: true } })).status, 200);
          else if (change === 'expiry') await query('UPDATE portal_sessions SET expires_at=? WHERE employee_number=?', [new Date(Date.now() - 1000).toISOString(), id]);
          else if (change === 'absolute-expiry') await query('UPDATE portal_sessions SET absolute_expires_at=? WHERE employee_number=?', [new Date(Date.now() - 1000).toISOString(), id]);
          else if (change === 'permission') await query("INSERT INTO portal_permission_denials(employee_number,permission,denied_by) VALUES(?,'backup:write','synthetic')", [id]);
          else if (change === 'role') await query("UPDATE portal_users SET role='employee' WHERE employee_number=?", [id]);
          else if (change === 'inactive') await query('UPDATE portal_users SET active=0 WHERE employee_number=?', [id]);
          else if (change === 'employee-inactive') await query('UPDATE employees SET active=0 WHERE personnel_number=?', [id]);
          else if (change === 'locked') await query('UPDATE portal_users SET locked_until=? WHERE employee_number=?', [new Date(Date.now() + 3600000).toISOString(), id]);
          else if (change === 'must-change') await query('UPDATE portal_users SET must_change_password=1 WHERE employee_number=?', [id]);
          else await query('UPDATE portal_users SET password_hash=? WHERE employee_number=?', [passwordHash(PASSWORD + '-newer'), id]);
          gate.release(); const result = await pending;
          assert.ok([401, 403, 409, 428].includes(result.status), JSON.stringify(result.body));
          assert.equal(result.cookies.length, 0); assert.equal(result.changed, null); assert.equal(effects.create, count); assert.equal(await auditCount(id), 0);
          assert.equal((await rows(id)).length, 1, 'no replacement row is inserted');
        } finally { gate.release(); await Promise.allSettled([pending]); } groups++;
      });
      for (const stage of ['audit', 'commit']) await t.test(`${stage} failure rolls back revocation, replacement and accepted audit without cookies`, async () => {
        const id = 'syn-reauth-fault-' + stage, auth = await seed(id), before = await rows(id), count = effects.create, schema = ('gp.');
        try {
          if (stage === 'commit') {
            await ddl(`CREATE TABLE ${schema}gp_reauth_fault_parent(id INTEGER PRIMARY KEY)`);
            await ddl(`CREATE TABLE ${schema}gp_reauth_fault_child(id INTEGER REFERENCES ${schema}gp_reauth_fault_parent(id) DEFERRABLE INITIALLY DEFERRED)`);
            await ddl('GRANT INSERT ON gp.gp_reauth_fault_child TO gp_core_app');
          }
          {
            await ddl(`CREATE FUNCTION gp.gp_reauth_fault() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN IF NEW.actor='${id}' AND NEW.action='${ACCEPTED}' THEN ${stage === 'audit' ? "RAISE EXCEPTION 'synthetic reauthentication audit failure';" : 'INSERT INTO gp.gp_reauth_fault_child(id) VALUES(991);'} END IF; RETURN NEW; END $body$`);
            await ddl('CREATE TRIGGER gp_reauth_fault BEFORE INSERT ON gp.audit_log FOR EACH ROW EXECUTE FUNCTION gp.gp_reauth_fault()');
          }
          const result = await create(auth);
          assert.ok(result.status >= 400, JSON.stringify(result.body)); assert.equal(result.cookies.length, 0); assert.equal(result.changed, null);
          assert.deepEqual(await rows(id), before); assert.equal(await auditCount(id), 0); assert.equal(effects.create, count);
          assert.equal((await info(auth)).body.authenticated, true);
        } finally {
          await ddl(`DROP TRIGGER IF EXISTS gp_reauth_fault${(' ON gp.audit_log')}`);
          await ddl('DROP FUNCTION IF EXISTS gp.gp_reauth_fault()');
          if (stage === 'commit') { await ddl(`DROP TABLE IF EXISTS ${schema}gp_reauth_fault_child`); await ddl(`DROP TABLE IF EXISTS ${schema}gp_reauth_fault_parent`); }
        }
        await assertRotated(id, before[0], auth, await create(auth)); groups++;
      });
      await t.test('managed-host reboot caller rotates through real HTTP with isolated operating boundaries', async () => {
        const id = 'syn-reauth-reboot', auth = await seed(id), before = (await active(id))[0];
        // The host eligibility branch is explicitly simulated on Windows. All
        // host-status/control/export effects are already replaced above; this is
        // not evidence that a real Linux host or privileged broker was exercised.
        Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
        try {
          const result = await request('/api/portal/v1/server-monitor/vps-reboot', { method: 'POST', auth,
            body: { confirmation: 'VPS_REBOOT', currentPassword: PASSWORD } });
          await assertRotated(id, before, auth, result, 202); assert.equal(effects.reboot, 1); assert.equal(await auditCount(id), 1);
        } finally { Object.defineProperty(process, 'platform', platformDescriptor); } groups++;
      });
      assert.equal(groups, 21);
      console.log('REAUTH_HTTP_VERIFIED ' + JSON.stringify({ provider, groups, syntheticOnly: true, operatingEffectsStubbed: true }));
    }
    try {
      {
        for (const domain of ['CORE', 'SALES']) for (const purpose of ['APP', 'READER', 'MIGRATOR']) {
          const connection = new URL(process.env[`GP_${domain}_${purpose}_URL`]);
          assert.equal(connection.hostname, '127.0.0.1'); assert.equal(connection.pathname, '/gp_migration_' + domain.toLowerCase());
        }
        await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async activeFixture => {
          try { await exercise(activeFixture); }
          finally {
            if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); server = null;
            await subject?.closePersistenceForTests(); subject?.releaseInstanceLockForTests(); subject = null;
          }
        }, { warmWorkers: false });
      }
    } finally {
      crypto.scrypt = originalScrypt;
      for (const gate of gates.values()) for (const callback of gate.callbacks.splice(0)) callback(); gates.clear();
      Object.defineProperty(process, 'platform', platformDescriptor);
      if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await subject?.closePersistenceForTests(); subject?.releaseInstanceLockForTests();
      configuration.resolvePersistenceConfiguration = originalConfiguration;
      for (const restore of restorers.reverse()) restore();
      assert.equal(path.dirname(fs.realpathSync(temporaryRoot)), fs.realpathSync(os.tmpdir()));
      assert.ok(path.basename(temporaryRoot).startsWith('gp-reauth-http-'));
      fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
