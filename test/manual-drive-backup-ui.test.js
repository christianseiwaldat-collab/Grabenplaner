'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const names = ['canManageMaintenanceSchedules', 'canManageManualDriveBackups', 'syncManualDriveBackupsActor', 'normalizedManualDriveBackups', 'manualDriveBackupsVisible', 'scheduleManualDriveBackupsRefresh', 'manualDriveBackupTablePreferences', 'renderManualDriveBackupTable', 'renderManualDriveBackups', 'loadManualDriveBackups', 'requestManualDriveBackup', 'mutateManualDriveBackup', 'openManualDriveBackupDelete'];
function fn(name) { const start = app.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm')), end = app.indexOf('\n}', start); assert.ok(start >= 0 && end > start, name); return app.slice(start, end + 2); }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const now = '2026-11-17T11:00:00.000Z', id = 'a'.repeat(64), oldId = 'b'.repeat(64), requestId = '33ec8846-557c-4f22-a3ac-367efb4c99b3';
const row = (overrides = {}) => ({ snapshotId: oldId, createdAt: now, sizeBytes: 14000000000, scope: 'full', status: 'confirmed', manual: true, deletable: true, blockedDeleteReason: null, ...overrides });
const model = (overrides = {}) => ({ available: true, providerId: 'google_drive', generatedAt: now, verifiedAt: now, stale: false, backups: [row({ snapshotId: id, deletable: false, blockedDeleteReason: 'NEWEST_BACKUP' }), row()], operation: null, busy: false, ...overrides });
const operation = (overrides = {}) => ({ requestId, action: 'create', state: 'queued', phase: 'queued', requestedAt: now, startedAt: null, finishedAt: null, snapshotId: null, errorCode: null, ...overrides });
function fixture() {
  const elements = {}, calls = [], timers = new Map(), storage = new Map(); let nextTimer = 0, respond = async () => model();
  for (const name of ['manualDriveBackupCard', 'manualDriveBackupForm', 'manualDriveBackupCreateButton', 'manualDriveBackupReloadButton', 'manualDriveBackupStatus', 'manualDriveBackupJobStatus', 'manualDriveBackupTableContainer', 'manualDriveBackupDeleteDialog', 'manualDriveBackupDeleteForm', 'manualDriveBackupDeletePassword', 'manualDriveBackupDeleteDescription', 'manualDriveBackupDeleteStatus', 'manualDriveBackupDeleteConfirmButton', 'backupSettings']) {
    const classes = new Set(name === 'backupSettings' ? ['active'] : []);
    elements[name] = { value: '', disabled: false, innerHTML: '', textContent: '', dataset: {}, listeners: {}, open: false,
      classList: { toggle(key, on) { if (on) classes.add(key); else classes.delete(key); }, contains: key => classes.has(key) },
      addEventListener(event, handler) { this.listeners[event] = handler; }, setAttribute(key, value) { this[key] = value; },
      close() { this.open = false; this.listeners.close?.(); }, showModal() { this.open = true; }, focus() {} };
  }
  const state = { currentView: 'settings', portalStatus: { operationMode: 'server' }, portalSession: { user: { employeeNumber: 'A', role: 'developer', permissions: ['backup:write'] } }, serverStatus: { backups: { offsite: { provider: { selectedProviderId: 'google_drive' } } } } };
  const document = { visibilityState: 'visible', listeners: {}, addEventListener(event, handler) { this.listeners[event] = handler; } };
  const window = { crypto: { randomUUID: () => requestId } };
  const context = vm.createContext({ state, elements, document, window,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    setTimeout(callback) { const token = ++nextTimer; timers.set(token, callback); return token; }, clearTimeout(token) { timers.delete(token); },
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    diagnosticTimestamp: value => value || 'Nicht verfügbar', systemCenterByteLabel: bytes => String(bytes) + ' B',
    resetAdminCredentialVisibility() {}, withAdminReauthentication: action => action(),
    api: (route, options = {}) => { const call = { route, method: options.method || 'GET', ...(options.body ? { body: JSON.parse(options.body) } : {}) }; calls.push(call); return respond(call); },
  });
  for (const name of names) vm.runInContext(fn(name), context);
  context.renderManualDriveBackups();
  return { state, elements, calls, timers, storage, context, document, window,
    respond(callback) { respond = callback; }, load: options => context.loadManualDriveBackups(options),
    create: () => context.requestManualDriveBackup({ preventDefault() {} }), delete: () => context.mutateManualDriveBackup('delete'),
    actor(value) { state.portalSession.user.employeeNumber = value; context.renderManualDriveBackups(); } };
}

test('only authorized Google Drive server administrators can fetch or create', async () => {
  for (const change of [f => { f.state.portalSession.user.role = 'employee'; }, f => { f.state.portalSession.user.permissions = []; }, f => { f.state.portalStatus.operationMode = 'local'; }, f => { f.state.serverStatus.backups.offsite.provider.selectedProviderId = 'backblaze_b2'; }]) {
    const f = fixture(); change(f); f.context.renderManualDriveBackups(); assert.equal(await f.load(), false); assert.equal(await f.create(), false); assert.equal(f.calls.length, 0); assert.equal(f.elements.manualDriveBackupCard.classList.contains('hidden'), true);
  }
  for (const role of ['developer', 'admin', 'it_admin']) { const f = fixture(); f.state.portalSession.user.role = role; assert.equal(await f.load(), true); }
});

test('creation is single flight and only a matched acknowledgement becomes queued', async () => {
  const f = fixture(); assert.equal(f.elements.manualDriveBackupCreateButton.disabled, true); await f.load();
  const wait = deferred(); f.respond(() => wait.promise); const created = f.create();
  assert.equal(await f.create(), false); assert.equal(await f.load({ force: true }), false); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1], { route: '/api/backup/drive', method: 'POST', body: { requestId } });
  wait.resolve(model({ operation: operation(), busy: true })); assert.equal(await created, true);
  assert.match(f.elements.manualDriveBackupJobStatus.textContent, /beauftragt/); assert.doesNotMatch(f.elements.manualDriveBackupJobStatus.textContent, /abgeschlossen/);
  f.respond(() => model({ operation: operation({ state: 'succeeded', phase: 'complete', snapshotId: id, startedAt: now, finishedAt: now }) })); await f.load({ force: true });
  assert.match(f.elements.manualDriveBackupJobStatus.textContent, /abgeschlossen und auf Google Drive bestätigt/); assert.equal(f.timers.size, 0);
});

test('uncertain transport never retries a write or announces failure of the background job', async () => {
  const f = fixture(); await f.load(); f.respond(() => { throw new Error('Verbindung unterbrochen'); });
  assert.equal(await f.create(), false); assert.equal(await f.create(), false); assert.equal(f.calls.length, 2);
  assert.equal(f.elements.manualDriveBackupCreateButton.disabled, true); assert.match(f.elements.manualDriveBackupStatus.textContent, /Auftragsstatus ist unklar/); assert.doesNotMatch(f.elements.manualDriveBackupJobStatus.textContent, /fehlgeschlagen/);
  f.respond(() => model({ operation: operation({ state: 'running', phase: 'upload', startedAt: now }), busy: true })); await f.load({ force: true });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1); assert.match(f.elements.manualDriveBackupJobStatus.textContent, /Upload laufen/);
});

test('stale inventory is read only, malformed confirmed rows cannot enable actions', async () => {
  const stale = fixture(); stale.respond(() => model({ stale: true, busy: true })); await stale.load(); assert.equal(await stale.create(), false); stale.context.openManualDriveBackupDelete(oldId); assert.equal(stale.elements.manualDriveBackupDeleteDialog.open, false); assert.match(stale.elements.manualDriveBackupStatus.textContent, /Letzter bestätigter Listenstand/);
  for (const invalid of [model({ backups: [row({ scope: 'core' })] }), model({ backups: [row({ status: 'pending' })] }), model({ backups: [row(), row()] }), model({ verifiedAt: null }), model({ operation: operation({ state: 'succeeded', snapshotId: null }) })]) {
    const f = fixture(); f.respond(() => invalid); assert.equal(await f.load(), false); assert.equal(f.state.manualDriveBackups, null); assert.equal(await f.create(), false);
  }
});

test('concrete deletion protects the newest and automatic rows and clears credentials', async () => {
  const f = fixture(); await f.load(); f.context.openManualDriveBackupDelete(id); assert.equal(f.elements.manualDriveBackupDeleteDialog.open, false);
  f.context.openManualDriveBackupDelete(oldId); assert.equal(f.elements.manualDriveBackupDeleteDialog.open, true); assert.match(f.elements.manualDriveBackupDeleteDescription.textContent, new RegExp(oldId.slice(0, 12))); assert.match(f.elements.manualDriveBackupDeleteDescription.textContent, /2026-11-17/);
  assert.equal(await f.delete(), false); f.elements.manualDriveBackupDeletePassword.value = 'temporary-password';
  f.respond(call => { assert.deepEqual(call, { route: '/api/backup/drive/' + oldId, method: 'DELETE', body: { requestId, currentPassword: 'temporary-password', confirmation: 'DELETE_BACKUP' } }); return model({ busy: true, operation: operation({ action: 'delete', snapshotId: oldId }) }); });
  assert.equal(await f.delete(), true); assert.equal(f.elements.manualDriveBackupDeletePassword.value, ''); assert.match(f.elements.manualDriveBackupJobStatus.textContent, /Löschung ist beauftragt/);
  assert.equal(JSON.stringify(f.state).includes('temporary-password'), false); assert.equal([...f.storage.values()].some(value => value.includes('temporary-password')), false);
});

test('409 and mismatched acknowledgements require a read and never blind retry', async () => {
  for (const answer of [() => { throw Object.assign(new Error('Busy'), { status: 409 }); }, () => model({ busy: true, operation: operation({ requestId: '20c3efbc-c6cf-4ce7-967a-d06b4f584a80' }) })]) {
    const f = fixture(); await f.load(); f.respond(answer); assert.equal(await f.create(), false); assert.equal(await f.create(), false); assert.equal(f.calls.length, 2); assert.equal(f.state.manualDriveBackups, null);
  }
});

test('late load and mutation acknowledgements from another actor never replace the view', async () => {
  for (const action of ['load', 'create']) {
    const f = fixture(); if (action === 'create') await f.load(); const wait = deferred(); f.respond(() => wait.promise); const old = action === 'load' ? f.load() : f.create();
    f.actor('B'); f.respond(() => model({ backups: [] })); await f.load(); wait.resolve(model({ operation: operation(), busy: true })); assert.equal(await old, false); assert.equal(f.state.manualDriveBackups.backups.length, 0); assert.equal(f.state.manualDriveBackups.operation, null);
  }
});

test('polling reads only active visible jobs and stops after completion or leaving the view', async () => {
  const f = fixture(); f.respond(() => model({ busy: true, operation: operation() })); await f.load(); assert.equal(f.timers.size, 1);
  f.document.visibilityState = 'hidden'; const callback = [...f.timers.values()][0]; f.timers.clear(); callback(); await Promise.resolve(); assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0);
  f.document.visibilityState = 'visible'; f.state.currentView = 'startDashboard'; f.context.scheduleManualDriveBackupsRefresh(); assert.equal(f.timers.size, 0);
  f.state.currentView = 'settings'; f.elements.backupSettings.classList.toggle('active', false); f.context.scheduleManualDriveBackupsRefresh(); assert.equal(f.timers.size, 0);
});

test('table preferences use existing layout and account scoped browser storage without Drive writes', async () => {
  const f = fixture(); const tableCalls = [];
  f.window.GrabenplanerTradeTables = { mount(options) { tableCalls.push(options); return { attach() {}, clear() {}, destroy() {} }; } };
  await f.load(); const tableApi = tableCalls[0].api; assert.equal(await tableApi('table-options/manual-drive-backups'), null);
  await tableApi('table-options/manual-drive-backups', { columns: ['createdAt'], widths: { createdAt: 200 }, sort: 'createdAt', direction: 'desc' });
  assert.equal(f.storage.size, 1); assert.equal(f.calls.length, 1); f.actor('B'); await assert.rejects(tableApi('table-options/manual-drive-backups'), { name: 'AbortError' }); await f.load(); assert.equal(await tableCalls[1].api('table-options/manual-drive-backups'), null);
});

test('the settings surface describes full scope, temporary downtime, no restore and exact deletion', () => {
  const card = html.slice(html.indexOf('id="manualDriveBackupCard"'), html.indexOf('id="backupRestoreGuidanceCard"'));
  assert.match(card, /GP Core, Sales und eigenen GP-Dateien/); assert.match(card, /vorübergehend nicht erreichbar/); assert.match(card, /Wiederherstellungstest wird dabei nicht gestartet/);
  assert.match(html, /id="manualDriveBackupDeleteDialog"/); assert.match(html, /Diese Sicherung löschen/); assert.match(app, /void loadManualDriveBackups\(\{ force: true \}\)/); assert.match(app, /state\.manualDriveBackupsTable\?\.setSort\("manual-drive-backups"/);
});