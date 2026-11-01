const { dropFixtureTrigger, installFixtureTrigger } = require("../test-support/postgresql-api/trigger-fixture");
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-security-audit-test-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'synthetic.db'), BACKUP_DIR: path.join(root, 'backups'),
  GRABENPLANER_DATA_DIR: path.join(root, 'data'), GRABENPLANER_HOST: '127.0.0.1', GRABENPLANER_FORCE_PORTAL: '1',
  GRABENPLANER_SEED_DEMO: '1', NODE_ENV: 'test', TZ: 'Europe/Vienna' });
const { app, db, initializeApplicationPersistence, releaseInstanceLockForTests } = require('../server');
const { KEY } = require('../lib/security-audit-store');
const { syntheticRun } = require('../test-support/security-audit-fixture');
const { browserSessionLifetime } = require('../lib/portal-session-security');
let server, url; const users = {};
async function request(route = '/api/security-audits', { method = 'GET', auth = users.developer, body, csrf = true } = {}) {
  const headers = { Accept: 'application/json' }; if (auth) headers.Cookie = auth.cookie;
  if (auth && csrf && method !== 'GET') headers['X-CSRF-Token'] = auth.csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
const importCommand = (revision = 0) => ({ action: 'import', expectedRevision: revision, run: syntheticRun() });
const post = (body, opts = {}) => request('/api/security-audits/commands', { method: 'POST', body, ...opts });
test('SAST metadata requires the same live personal audit permission and is never publicly cached', async () => {
  assert.equal((await request('/api/security-audits/sast', { auth: null })).status, 401);
  for (const role of ['hr', 'manager', 'employee']) assert.equal((await request('/api/security-audits/sast', { auth: users[role] })).status, 403);
  const result = await request('/api/security-audits/sast');
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.ok(result.body.reviews.length > 0); assert.equal(result.body.capabilities.managePolicy, false);
});
test.before(async () => {
  await initializeApplicationPersistence(); const location = db.prepare('SELECT id,cost_center_id FROM locations LIMIT 1').get();
  for (const role of ['developer', 'admin', 'it_admin', 'hr', 'manager', 'employee']) {
    const id = `audit-synthetic-${role}`, token = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.createHash('sha256').update(`gp-browser-csrf-v2\0${token}`).digest('hex');
    const lifetime = browserSessionLifetime({ now: new Date(), role });
    db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,target_workdays_per_week,home_location_id,cost_center_id,active) VALUES (?,?,?,'#25705d',38.5,5,?,?,1)").run(id, id, id, location.id, location.cost_center_id);
    db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_changed_at) VALUES (?,'synthetic',?,1,0,CURRENT_TIMESTAMP)").run(id, role);
    db.prepare('INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at,authenticated_at,absolute_expires_at,last_seen_at) VALUES (?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), id, crypto.createHash('sha256').update(token).digest('hex'), lifetime.expiresAt,
        lifetime.authenticatedAt, lifetime.absoluteExpiresAt, lifetime.authenticatedAt);
    users[role] = { id, cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
  }
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); url = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); try { await db.close(); } catch {} releaseInstanceLockForTests();
  assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('gp-security-audit-test-')); fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
test('anonymous and non-authorized roles cannot read even over loopback', async () => {
  assert.equal((await request(undefined, { auth: null })).status, 401);
  for (const role of ['admin', 'it_admin', 'hr', 'manager', 'employee']) assert.equal((await request(undefined, { auth: users[role] })).status, 403, role);
});
test('developer reads empty full catalogue with no writes and no-cache headers', async () => {
  const result = await request(); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.catalog.length, 345); assert.deepEqual(result.body.runs, []); assert.deepEqual(result.body.capabilities, { read: true, manage: true });
  assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(db.prepare('SELECT value FROM settings WHERE key=?').get(KEY), undefined);
});
test('explicit read grant admits IT admin but never permits import or HR access', async () => {
  for (const role of ['it_admin', 'hr']) db.prepare("INSERT INTO portal_permission_grants(employee_number,permission,granted_by) VALUES (?,'security_audits:read','synthetic')").run(users[role].id);
  const result = await request(undefined, { auth: users.it_admin }); assert.equal(result.status, 200); assert.equal(result.body.capabilities.manage, false);
  assert.equal((await post(importCommand(), { auth: users.it_admin })).status, 403);
  assert.equal((await request(undefined, { auth: users.hr })).status, 403);
});
test('missing CSRF and unchanged initial password cannot mutate the register', async () => {
  assert.equal((await post(importCommand(), { csrf: false })).status, 403);
  db.prepare('UPDATE portal_users SET must_change_password=1 WHERE employee_number=?').run(users.developer.id);
  try { assert.equal((await request()).status, 428); assert.equal((await post(importCommand())).status, 428); }
  finally { db.prepare('UPDATE portal_users SET must_change_password=0 WHERE employee_number=?').run(users.developer.id); }
});
test('import stores encrypted private data and a value-free audit receipt', async () => {
  const result = await post(importCommand()); assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.revision, 1); assert.equal(result.body.runs[0].summary.notTested, 251);
  const encrypted = db.prepare('SELECT value FROM settings WHERE key=?').get(KEY).value;
  assert.match(encrypted, /^enc:v2:/); assert.ok(!encrypted.includes('PRIVATE-SYNTHETIC'));
  const audit = db.prepare("SELECT * FROM audit_log WHERE action='security-audits.command'").all();
  assert.equal(audit.length, 1); assert.ok(!JSON.stringify(audit).includes('PRIVATE-SYNTHETIC'));
});
test('ordinary planning/settings data never includes audit findings or encrypted register', async () => {
  const { publicSettingsRows, publicSettingsObject } = require('../lib/privacy-organization-settings');
  const row = db.prepare('SELECT key,value FROM settings WHERE key=?').get(KEY);
  assert.deepEqual(publicSettingsRows([row]), []); assert.deepEqual(publicSettingsObject({ [KEY]: row.value }), {});
  for (const route of ['/api/settings', '/api/portal/v1/session']) {
    const result = await request(route); assert.ok(!JSON.stringify(result.body).includes('PRIVATE-SYNTHETIC'));
    assert.ok(!JSON.stringify(result.body).includes(KEY));
  }
});
test('stale revision, malformed requirement and duplicate import leave revision unchanged', async () => {
  assert.equal((await post(importCommand(0))).status, 409); assert.equal((await post(importCommand(1))).status, 409);
  const body = importCommand(1); body.run.id = 'new-synthetic'; body.run.checks[0].requirementId = 'v4.0.3-1.1.1';
  assert.equal((await post(body)).status, 400); assert.equal((await request()).body.revision, 1);
});
test('finding change preserves immutable audit, requires note and rejects closing without retest', async () => {
  const command = { action: 'update_finding', expectedRevision: 1, runId: 'synthetic-audit-001', findingId: 'SYN-001',
    changes: { status: 'fixed', owner: 'Synthetic owner', dueDate: '', note: 'Synthetic decision', retestEvidence: '' } };
  assert.equal((await post(command)).status, 400);
  command.changes.status = 'in_progress'; const result = await post(command); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.revision, 2); assert.equal(result.body.runs[0].findings[0].history.length, 1); assert.equal(result.body.runs[0].checks[0].status, 'failed');
});
test('live permission revocation and deactivation deny access to saved data', async () => {
  db.prepare("INSERT INTO portal_permission_denials(employee_number,permission,denied_by) VALUES (?,'security_audits:read','synthetic')").run(users.it_admin.id);
  assert.equal((await request(undefined, { auth: users.it_admin })).status, 403);
  db.prepare('UPDATE portal_users SET active=0 WHERE employee_number=?').run(users.developer.id);
  try { assert.equal((await request()).status, 401); }
  finally { db.prepare('UPDATE portal_users SET active=1 WHERE employee_number=?').run(users.developer.id); }
});
test('audit write failure rolls back register mutation', async () => {
  const before = db.prepare('SELECT value FROM settings WHERE key=?').get(KEY).value;
  installFixtureTrigger(db, "CREATE TRIGGER test_synthetic_audit_deny BEFORE INSERT ON audit_log WHEN NEW.action='security-audits.command' BEGIN SELECT RAISE(ABORT, 'synthetic audit denial'); END");
  try {
    const command = importCommand(2); command.run.id = 'synthetic-rollback'; const result = await post(command);
    assert.equal(result.status, 500); assert.equal(db.prepare('SELECT value FROM settings WHERE key=?').get(KEY).value, before);
  } finally { dropFixtureTrigger(db, "test_synthetic_audit_deny"); }
});
test('damaged protected register fails closed without leaking its contents', async () => {
  const before = db.prepare('SELECT value FROM settings WHERE key=?').get(KEY).value;
  db.prepare('UPDATE settings SET value=? WHERE key=?').run('enc:v2:corrupted-PRIVATE-SYNTHETIC', KEY);
  try { const result = await request(); assert.equal(result.status, 503); assert.ok(!JSON.stringify(result.body).includes('PRIVATE-SYNTHETIC')); }
  finally { db.prepare('UPDATE settings SET value=? WHERE key=?').run(before, KEY); }
});
