"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tmp = path.resolve(__dirname, '../tmp');
const root = fs.mkdtempSync(path.join(tmp, 'saturday-api-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'fixture.db'), BACKUP_DIR: path.join(root, 'backups'),
  GRABENPLANER_DATA_DIR: path.join(root, 'data'), GRABENPLANER_FORCE_PORTAL: '1', GRABENPLANER_SEED_DEMO: '1',
  GRABENPLANER_TEST_AMU_SCANNER: 'clean', NODE_ENV: 'test', TZ: 'Europe/Vienna' });
const subject = require('../server'), { db, app } = subject;
let server, base;
function session(number, role, permissions = [], location) {
  db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,home_location_id,active) VALUES(?,?,?,'#336699',38.5,?,1)").run(number, `Synthetic ${number}`, number, location || '91');
  db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_changed_at) VALUES(?,'test-only',?,1,0,CURRENT_TIMESTAMP)").run(number, role);
  for (const permission of permissions) db.prepare("INSERT INTO portal_permission_grants(employee_number,permission,granted_by) VALUES(?,?,'synthetic')").run(number, permission);
  if (location) db.prepare("INSERT INTO portal_access_scopes(employee_number,location_id,department_id,assigned_by) VALUES(?,?,0,'synthetic')").run(number, location);
  const token = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
  db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES(?,?,?,'2099-12-31T23:59:59.000Z')").run(crypto.randomUUID(), number, crypto.createHash('sha256').update(token).digest('hex'));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}
async function request(actor, route, body, csrf = true, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + route, { method,
    headers: { Cookie: actor.cookie, 'Content-Type': 'application/json', ...(body && csrf ? { 'X-CSRF-Token': actor.csrf } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
const actors = {};
test.before(async () => {
  const day = { open: true, start: '09:00', end: '18:00', lunchEnabled: true, lunchStart: '12:30', lunchEnd: '13:00', minStaff: 0, minFrom: '09:00', minTo: '18:00' };
  for (const id of ['91', '92']) db.prepare('INSERT INTO locations(id,name,day_settings_json,active) VALUES(?,?,?,1)').run(id, id, JSON.stringify(Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(name => [name, day]))));
  actors.admin = session('S901', 'admin');
  actors.manager = session('S902', 'manager', ['employees:write', 'work_rules:assign'], '91');
  actors.hr = session('S905', 'hr', ['employees:write', 'work_rules:assign'], '91');
  actors.employee = session('S903', 'employee');
  session('S904', 'employee', [], '92');
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  db.close(); subject.releaseInstanceLockForTests();
  assert.equal(path.dirname(fs.realpathSync(root)), tmp); fs.rmSync(root, { recursive: true });
});
test('employee API requires live personnel rights, scope and CSRF; cutover is fixed and assignments are explicit', async () => {
  const route = '/api/employees/S903/saturday-credit';
  assert.equal((await request(actors.employee, route)).status, 403);
  const setup = await request(actors.admin, '/api/saturday-credit/cutover', { effectiveDate: '2026-08-01' });
  assert.equal(setup.status, 201, JSON.stringify(setup.data));
  assert.equal((await request(actors.admin, '/api/saturday-credit/cutover', { effectiveDate: '2026-08-02' })).status, 409);
  const input = { activity: 'retail_sales', effectiveDate: '2026-08-01', reason: 'Synthetic sales assignment', expectedPreviousId: '' };
  assert.equal((await request(actors.manager, route, input, false)).status, 403);
  assert.equal((await request(actors.manager, '/api/employees/S904/saturday-credit', input)).status, 403);
  assert.equal((await request(actors.manager, route, input)).status, 403);
  const saved = await request(actors.hr, route, input);
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.equal((await request(actors.hr, route, input)).status, 409);
  const read = await request(actors.manager, route);
  assert.equal(read.data.assignment.activity, 'retail_sales');
  assert.equal(read.data.cutoverDate, '2026-08-01');
  assert.equal(JSON.stringify(read.data).includes('legacySettings'), false);
});
function shift(date, from, to, location = '91') {
  const id = Number(db.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time,area) VALUES('S903',?,?,?,?, 'Synthetic')").run(location, date, from, to).lastInsertRowid);
  return { id, employee_number: 'S903', location_id: location, shift_date: date, start_time: from, end_time: to };
}
function entries(date, values) {
  for (const [type, time, location = '91'] of values) db.prepare("INSERT INTO time_entries(employee_number,location_id,work_date,entry_type,entry_timestamp,source,created_by) VALUES('S903',?,?,?,?,'test','S903')")
    .run(location, date, type, new Date(`${date}T${time}:00+02:00`).toISOString());
}
test('actual time, planned time and time accounts use the same 120-minute company credit', async () => {
  const date = '2026-08-22'; shift(date, '10:00', '17:00');
  entries(date, [['clock_in','10:00'],['break_start','12:30'],['break_end','13:00'],['clock_out','17:00']]);
  const result = await subject.evaluateTimeDay('S903', date, new Date('2026-08-23T12:00:00Z'), null, null, { locationId: '91', persistSaturdayCredit: true });
  assert.equal(result.actualMinutes, 390); assert.equal(result.saturdayBonusMinutes, 120);
  assert.equal(result.actualValuedMinutes, 510); assert.equal(result.plannedValuedMinutes, 510);
  assert.equal(result.planned.saturdayEligibleMinutes, 240); assert.ok(result.actual.saturdayCreditRecordId);
  assert.ok(!result.issues.some(issue => issue.code === 'saturday_credit_review_required'));
});
test('two locations and two odd-minute shifts round once over the complete employee day', async () => {
  db.prepare(`INSERT INTO employee_location_lendings(id,employee_number,home_location_id,destination_location_id,
    date_from,date_to,all_day,start_time,end_time,created_by,created_at,updated_by,updated_at)
    VALUES('saturday-synthetic-lending','S903','91','92','2026-08-29','2026-08-29',0,'14:00','15:00','synthetic',CURRENT_TIMESTAMP,'synthetic',CURRENT_TIMESTAMP)`).run();
  const date = '2026-08-29'; shift(date, '13:00', '13:01'); shift(date, '14:00', '14:01', '92');
  entries(date, [['clock_in','13:00'],['clock_out','13:01'],['clock_in','14:00','92'],['clock_out','14:01','92']]);
  const whole = await subject.evaluateTimeDay('S903', date, new Date('2026-08-30T12:00:00Z'), null, null, { locationId: '91' });
  assert.equal(whole.saturdayBonusMinutes, 1); assert.equal(whole.planned.saturdayBonusMinutes, 1);
  const parts = [];
  for (const locationId of ['91', '92']) parts.push(await subject.evaluateTimeDay('S903', date, new Date('2026-08-30T12:00:00Z'), null, null, { locationId, filterLocation: true }));
  assert.equal(parts.reduce((sum, item) => sum + item.saturdayBonusMinutes, 0), 1);
  assert.equal(parts.reduce((sum, item) => sum + item.planned.saturdayBonusMinutes, 0), 1);
});

test('imported actual intervals use the new credit and retain their immutable original values', async () => {
  const date = '2026-08-08', importId = crypto.randomUUID();
  db.prepare(`INSERT INTO xoffi_time_imports(id,location_id,department_key,week_start,week_end,source_sha256,source_file_name,ocr_engine_version,use_as_actual,imported_by)
    VALUES(?,'91',0,'2026-08-03','2026-08-09',?,'synthetic.png','test',1,'S901')`).run(importId, 'a'.repeat(64));
  const row = db.prepare(`INSERT INTO xoffi_time_employee_rows(import_id,employee_number,source_name,match_confidence,weekly_actual_minutes,weekly_valued_minutes,weekly_surcharge_minutes)
    VALUES(?,'S903','Synthetic',100,390,420,30) RETURNING id`).get(importId);
  db.prepare(`INSERT INTO xoffi_time_days(employee_row_id,work_date,actual_minutes,valued_minutes,surcharge_minutes,intervals_json,absence_code,ocr_confidence)
    VALUES(?,?,390,420,30,'["10:00-12:30","13:00-17:00"]','',99)`).run(row.id, date);
  const result = await subject.evaluateTimeDay('S903', date, new Date('2026-08-09T12:00:00Z'), null, null, { locationId: '91', persistSaturdayCredit: true });
  assert.equal(result.actualMinutes, 390); assert.equal(result.saturdayBonusMinutes, 120); assert.equal(result.actualValuedMinutes, 510);
  assert.equal(db.prepare('SELECT valued_minutes FROM xoffi_time_days WHERE employee_row_id=?').get(row.id).valued_minutes, 420);
});

test('reviewed payroll exports the same Saturday credit; a later assignment change requires a fresh review', async () => {
  db.prepare("UPDATE locations SET time_tracking_enabled=1 WHERE id='91'").run();
  const date = '2026-08-22';
  const body = { dateFrom: date, dateTo: date, locationId: '91', departmentId: null,
    configuration: { layout: 'daily_journal', sourceMode: 'actual_reviewed', format: 'csv', delimiter: ';' } };
  const before = await request(actors.admin, '/api/integrations/payroll-export/preflight', body);
  assert.equal(before.status, 200, JSON.stringify(before.data));
  assert.ok(before.data.blockers.some(b => b.code === 'MISSING_REVIEW'));
  const reviewed = await request(actors.admin, `/api/portal/v1/time-day-reviews/S903/${date}`, { locationId: '91', reviewed: true, note: 'Synthetic verified day' }, true, 'PUT');
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
  assert.equal(reviewed.data.evaluation.saturdayBonusMinutes, 120);
  const ready = await request(actors.admin, '/api/integrations/payroll-export/preflight', body);
  assert.equal(ready.status, 200, JSON.stringify(ready.data));
  assert.equal(ready.data.blockers.length, 0, JSON.stringify(ready.data.blockers));
  const response = await fetch(base + '/api/integrations/payroll-export/file', { method: 'POST',
    headers: { Cookie: actors.admin.cookie, 'X-CSRF-Token': actors.admin.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, fingerprint: ready.data.fingerprint }) });
  assert.equal(response.status, 200, await response.clone().text());
  const csv = await response.text(); assert.match(csv, /S903/); assert.match(csv, /Samstag/i);
  const values = csv.split(/\r?\n/).find(line => line.includes('S903')).split(';').map(value => value.replace(/^"|"$/g, ''));
  assert.equal(Number(values[8]), 120); assert.equal(Number(values[9]), 510);
  const current = await request(actors.admin, '/api/employees/S903/saturday-credit');
  const changed = await request(actors.admin, '/api/employees/S903/saturday-credit', { activity: 'other', effectiveDate: date, reason: 'Synthetic activity change', expectedPreviousId: current.data.history[0].id });
  assert.equal(changed.status, 201, JSON.stringify(changed.data));
  const stale = await request(actors.admin, '/api/integrations/payroll-export/preflight', body);
  assert.ok(stale.data.blockers.some(b => /REVIEW/.test(b.code)), JSON.stringify(stale.data.blockers));
});
