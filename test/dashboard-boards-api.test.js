'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const start = require('../public/start-dashboard-workspace-preferences');
const personnel = require('../public/personnel-dashboard-workspace-preferences');
const temporaryParent = path.resolve(os.tmpdir());
const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, 'gp-dashboard-boards-api-'));
Object.assign(process.env, {DB_PROVIDER:'sqlite', DATABASE_URL:'', DB_PATH:path.join(temporaryRoot, 'fixture.db'),
  BACKUP_DIR:path.join(temporaryRoot, 'backups'), GRABENPLANER_DATA_DIR:path.join(temporaryRoot, 'data'),
  GRABENPLANER_HOST:'127.0.0.1', GRABENPLANER_FORCE_PORTAL:'1', GRABENPLANER_SEED_DEMO:'1', NODE_ENV:'test', TZ:'Europe/Vienna'});
const {app, db, releaseInstanceLockForTests} = require('../server');
const route = '/api/portal/v1/ui-preferences';
let httpServer, baseUrl, accountA, accountB;
function session(employeeNumber) {
  const token = 'dashboard-' + crypto.randomBytes(24).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO portal_users (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', 'admin', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET active=1, must_change_password=0`).run(employeeNumber);
  db.prepare(`INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')`).run(crypto.randomUUID(), employeeNumber, crypto.createHash('sha256').update(token).digest('hex'));
  return {cookie:`grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf};
}
async function request({method='GET', session:actor, body, csrf=true}={}) {
  const response = await fetch(baseUrl + route, {method, headers:{Accept:'application/json',
    ...(actor ? {Cookie:actor.cookie} : {}), ...(actor && csrf && method !== 'GET' ? {'X-CSRF-Token':actor.csrf} : {}),
    ...(body === undefined ? {} : {'Content-Type':'application/json'})},
    ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  return {status:response.status, payload:await response.json()};
}
function pair() {
  let startDocument = start.toDocument(start.empty()), personalDocument = personnel.toDocument(personnel.empty());
  startDocument = start.renameDashboard(start.selectDashboard(startDocument, 'dashboard-2'), 'dashboard-2', 'Meine Übersicht');
  let board = start.addCustomField(start.getBoard(startDocument), {id:'custom:shared-note', title:'Meine Notiz', text:'Zeile 1\nZeile 2'});
  board.fields['group:branch'] = {hidden:true};
  board.fields['custom:shared-note'] = {color:'blue', geometry:{x:25, y:35, width:300, height:220}};
  startDocument = start.setBoard(startDocument, board);
  personalDocument = personnel.renameDashboard(personnel.selectDashboard(personalDocument, 'dashboard-3'), 'dashboard-3', 'Nur ZA');
  board = personnel.addCustomField(personnel.getBoard(personalDocument), {id:'custom:personal-note', title:'Personalnotiz', text:'Nur mein Konto'});
  board.fields['card:requests'] = {content:['absence.timeOff'], color:'sage'};
  board.fields['card:collectiveAgreements'] = {hidden:true, geometry:{x:10, y:40, width:280, height:160}};
  personalDocument = personnel.setBoard(personalDocument, board);
  return {startDashboardWorkspace:startDocument, personnelDashboardWorkspace:personalDocument,
    personnelDashboardLayout:personnel.layout(personalDocument)};
}
test.before(async () => {
  await new Promise((resolve, reject) => {httpServer = app.listen(0, '127.0.0.1', resolve); httpServer.once('error', reject);});
  baseUrl = 'http://127.0.0.1:' + httpServer.address().port;
});
test.beforeEach(() => {
  for (const table of ['portal_sessions', 'portal_user_preferences', 'portal_users']) {
    db.prepare(`DELETE FROM ${table} WHERE employee_number LIKE 'dashboard-api-%'`).run();
  }
  db.prepare("DELETE FROM employees WHERE personnel_number LIKE 'dashboard-api-%'").run();
  const locationId = db.prepare('SELECT id FROM locations WHERE active=1 ORDER BY id LIMIT 1').get().id;
  for (const id of ['dashboard-api-a', 'dashboard-api-b']) {
    db.prepare('INSERT INTO employees (personnel_number, full_name, nickname, home_location_id, active) VALUES (?, ?, ?, ?, 1)')
      .run(id, 'Synthetic ' + id, 'Synthetic', locationId);
  }
  accountA = session('dashboard-api-a'); accountB = session('dashboard-api-b');
});
test.after(async () => {
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  db.close(); releaseInstanceLockForTests();
  assert.equal(path.dirname(path.resolve(temporaryRoot)), temporaryParent);
  assert.ok(path.basename(temporaryRoot).startsWith('gp-dashboard-boards-api-'));
  fs.rmSync(temporaryRoot, {recursive:true, force:true, maxRetries:8, retryDelay:100});
});

test('real HTTP round trip keeps all three Start/Personal dashboards, notes, geometry and content per account', async () => {
  const expected = pair(), saved = await request({method:'PUT', session:accountA, body:expected});
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  for (const [property, value] of Object.entries(expected)) assert.deepEqual(saved.payload[property], value);
  const fresh = await request({session:session('dashboard-api-a')});
  for (const [property, value] of Object.entries(expected)) assert.deepEqual(fresh.payload[property], value);
  const other = await request({session:accountB});
  assert.deepEqual(other.payload.startDashboardWorkspace, start.empty());
  assert.equal(other.payload.personnelDashboardWorkspace, null);
  for (const [model, property] of [[start, 'startDashboardWorkspace'], [personnel, 'personnelDashboardWorkspace']]) {
    const row = db.prepare('SELECT value FROM portal_user_preferences WHERE employee_number=? AND preference_key=?').get('dashboard-api-a', model.KEY);
    assert.deepEqual(JSON.parse(row.value), expected[property]);
  }
  const otherNote = start.addCustomField(start.getBoard(start.toDocument(start.empty())), {id:'custom:shared-note', title:'Account B', text:'Independent'});
  const otherSaved = await request({method:'PUT', session:accountB, body:{startDashboardWorkspace:start.setBoard(start.toDocument(start.empty()), otherNote)}});
  assert.equal(otherSaved.status, 200);
  assert.deepEqual((await request({session:accountA})).payload.startDashboardWorkspace, expected.startDashboardWorkspace);
});

test('real HTTP legacy migration preserves board one while edits in boards two and three stay independent', async () => {
  const legacy = {version:1, fields:{'group:personnel':{title:'Alte Beschriftung', color:'rose', geometry:{x:40, y:20, width:320, height:300}}}};
  assert.equal((await request({method:'PUT', session:accountA, body:{startDashboardWorkspace:legacy}})).status, 200);
  const read = await request({session:accountA}); assert.deepEqual(read.payload.startDashboardWorkspace, legacy);
  const upgraded = start.toDocument(read.payload.startDashboardWorkspace);
  let next = start.selectDashboard(upgraded, 'dashboard-2'), board = start.getBoard(next);
  board.fields['group:personnel'] = {title:'Zweite Ansicht', hidden:true}; next = start.setBoard(next, board);
  assert.equal((await request({method:'PUT', session:accountA, body:{startDashboardWorkspace:next}})).status, 200);
  next = start.renameDashboard(start.selectDashboard(next, 'dashboard-3'), 'dashboard-3', 'Verkauf');
  assert.equal((await request({method:'PUT', session:accountA, body:{startDashboardWorkspace:next}})).status, 200);
  const final = (await request({session:accountA})).payload.startDashboardWorkspace;
  assert.deepEqual(final.dashboards[0].fields, legacy.fields);
  assert.equal(final.dashboards[1].fields['group:personnel'].hidden, true);
  assert.deepEqual(final.dashboards[2].fields, {});
  assert.equal(final.dashboards[2].name, 'Verkauf');
});

test('real HTTP validation rejects malformed tabs and unregistered/injected own fields without changing stored values', async () => {
  const expected = pair(); assert.equal((await request({method:'PUT', session:accountA, body:expected})).status, 200);
  for (const property of ['startDashboardWorkspace', 'personnelDashboardWorkspace']) {
    const cases = [], malformed = edit => {const value = structuredClone(expected[property]); edit(value); cases.push(value);};
    malformed(value => {value.dashboards[1].id = value.dashboards[0].id;});
    malformed(value => {value.dashboards.pop();});
    malformed(value => {value.activeDashboard = 'dashboard-4';});
    malformed(value => {value.dashboards[0].name = 'x'.repeat(61);});
    malformed(value => {value.dashboards[0].fields['custom:unknown'] = {title:'Unregistered'};});
    malformed(value => {value.dashboards[0].customFields = [{id:'custom:injected', title:'Embed', text:'Text', html:'<script>bad()</script>'}];});
    malformed(value => {value.dashboards[0].customFields = Array.from({length:21}, (_, index) => ({id:'custom:item-' + index, title:'Note', text:''}));});
    malformed(value => {value.owner = 'dashboard-api-b';});
    for (const value of cases) {
      const result = await request({method:'PUT', session:accountA, body:{[property]:value}});
      assert.equal(result.status, 400, JSON.stringify(result.payload)); assert.equal(result.payload.code, 'UI_PREFERENCES_INVALID');
    }
  }
  const read = await request({session:accountA});
  assert.deepEqual(read.payload.startDashboardWorkspace, expected.startDashboardWorkspace);
  assert.deepEqual(read.payload.personnelDashboardWorkspace, expected.personnelDashboardWorkspace);
});

test('real HTTP authentication, CSRF and password gates protect v2 dashboard mutations', async () => {
  const expected = pair(); assert.equal((await request({method:'PUT', session:accountA, body:expected})).status, 200);
  assert.equal((await request({method:'PUT', body:expected})).status, 401);
  assert.equal((await request({method:'PUT', session:accountA, body:expected, csrf:false})).status, 403);
  db.prepare('UPDATE portal_users SET must_change_password=1 WHERE employee_number=?').run('dashboard-api-a');
  for (const property of ['startDashboardWorkspace', 'personnelDashboardWorkspace']) {
    const result = await request({method:'PUT', session:accountA, body:{[property]:expected[property]}});
    assert.equal(result.status, 428, JSON.stringify(result.payload));
    assert.equal(result.payload.code, 'PORTAL_PASSWORD_CHANGE_REQUIRED');
  }
  db.prepare('UPDATE portal_users SET must_change_password=0 WHERE employee_number=?').run('dashboard-api-a');
  const read = await request({session:accountA});
  assert.deepEqual(read.payload.startDashboardWorkspace, expected.startDashboardWorkspace);
  assert.deepEqual(read.payload.personnelDashboardWorkspace, expected.personnelDashboardWorkspace);
});
