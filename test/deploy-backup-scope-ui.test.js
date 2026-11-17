'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
function sourceFunction(name) {
  const start = app.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name); const end = app.indexOf('\n}', start); assert.ok(end > start, name);
  return app.slice(start, end + 2);
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const preference = (scope = 'full', revision = '0') => ({ scope, revision, label: scope === 'full' ? 'Vollständig: GP Core und Sales' : 'GP Core und eigene Inhalte', appliesTo: 'deploy-auto', available: true, valid: true });
function fixture() {
  const elements = {}, calls = [], toasts = [];
  for (const name of ['deployBackupScopeCard', 'deployBackupScopeForm', 'deployBackupScopeSelect', 'deployBackupScopeDescription', 'deployBackupScopeStatus', 'reloadDeployBackupScopeButton', 'saveDeployBackupScopeButton']) {
    const classes = new Set(['hidden']); elements[name] = { value: 'full', disabled: false, textContent: '', dataset: {}, listeners: {},
      classList: { toggle(key, value) { if (value) classes.add(key); else classes.delete(key); }, contains: key => classes.has(key) },
      setAttribute(key, value) { this[key] = value; }, addEventListener(event, handler) { this.listeners[event] = handler; } };
  }
  const state = { portalStatus: { operationMode: 'server' }, portalSession: { user: { employeeNumber: 'A', role: 'developer', permissions: ['backup:write'] } } };
  let respond = async () => preference();
  const context = vm.createContext({ state, elements, showToast: (...args) => toasts.push(args), api: (route, options = {}) => {
    const call = { route, method: options.method || 'GET', ...(options.body ? { body: JSON.parse(options.body) } : {}) }; calls.push(call); return respond(call);
  } });
  for (const name of ['canManageMaintenanceSchedules', 'syncDeployBackupScopeActor', 'validDeployBackupScope', 'renderDeployBackupScope', 'updateDeployBackupScopeDraft', 'loadDeployBackupScope', 'saveDeployBackupScope']) vm.runInContext(sourceFunction(name), context);
  const wiring = app.split('\n').filter(line => /^elements\.(reloadDeployBackupScopeButton|deployBackupScopeSelect|deployBackupScopeForm)\?\.addEventListener/.test(line));
  assert.equal(wiring.length, 4); vm.runInContext(wiring.join('\n'), context);
  context.renderDeployBackupScope();
  return { state, elements, calls, toasts, context, respond(fn) { respond = fn; }, load: options => context.loadDeployBackupScope(options),
    select(scope) { elements.deployBackupScopeSelect.value = scope; let stopped = false; elements.deployBackupScopeSelect.listeners.change({ stopPropagation() { stopped = true; } }); assert.equal(stopped, true); },
    submit() { return elements.deployBackupScopeForm.listeners.submit({ preventDefault() {} }); },
    changeActor(employeeNumber) { state.portalSession.user.employeeNumber = employeeNumber; context.renderDeployBackupScope(); } };
}

test('server-confirmed default is loaded before editing; the form does not persist on change', async () => {
  const f = fixture(), wait = deferred(); f.respond(() => wait.promise);
  assert.equal(f.elements.deployBackupScopeSelect.value, 'full'); assert.equal(f.elements.deployBackupScopeSelect.disabled, true);
  const loading = f.load(); assert.equal(f.elements.saveDeployBackupScopeButton.disabled, true);
  wait.resolve(preference()); await loading;
  assert.equal(f.elements.deployBackupScopeSelect.disabled, false); assert.equal(f.elements.saveDeployBackupScopeButton.disabled, true);
  f.select('deploy-owned'); assert.equal(f.calls.length, 1); assert.equal(f.elements.saveDeployBackupScopeButton.disabled, false);
  assert.match(f.elements.deployBackupScopeStatus.textContent, /noch nicht gespeichert/);
  assert.match(f.elements.deployBackupScopeDescription.textContent, /sechs neuen Access-Dateien/);
  f.respond(call => { assert.deepEqual(call, { route: '/api/backup/deploy-scope', method: 'PUT', body: { scope: 'deploy-owned', expectedRevision: '0' } }); return preference('deploy-owned', 'saved-1'); });
  assert.equal(await f.submit(), true); assert.equal(f.state.deployBackupScope.revision, 'saved-1');
  assert.equal(f.elements.saveDeployBackupScopeButton.disabled, true); assert.match(f.elements.deployBackupScopeStatus.textContent, /^Gespeichert: GP Core und eigene Inhalte/);
});

test('saving is single-flight and success is shown only after the exact scope is acknowledged', async () => {
  const f = fixture(); await f.load(); f.select('deploy-owned'); const wait = deferred(); f.respond(() => wait.promise);
  const saving = f.submit(); assert.equal(f.elements.deployBackupScopeSelect.disabled, true);
  assert.equal(await f.submit(), false); assert.equal(await f.load({ announce: true }), false); assert.equal(f.calls.length, 2);
  wait.resolve(preference('full', 'other')); assert.equal(await saving, false);
  assert.equal(f.state.deployBackupScope, null); assert.equal(f.elements.saveDeployBackupScopeButton.disabled, true);
  assert.equal(f.toasts.some(([text]) => /gespeichert\./.test(text)), false);
});

test('concurrent modification requires reload and never overwrites with a stale revision', async () => {
  const f = fixture(); await f.load(); f.select('deploy-owned'); f.respond(() => { throw Object.assign(new Error('Conflict'), { status: 409 }); });
  assert.equal(await f.submit(), false); assert.match(f.elements.deployBackupScopeStatus.textContent, /inzwischen geändert/);
  assert.equal(f.elements.deployBackupScopeSelect.disabled, true); assert.equal(await f.submit(), false); assert.equal(f.calls.length, 2);
  f.respond(() => preference('deploy-owned', 'new-revision')); await f.elements.reloadDeployBackupScopeButton.listeners.click();
  assert.equal(f.state.deployBackupScope.revision, 'new-revision'); assert.equal(f.elements.deployBackupScopeSelect.disabled, false);
  f.select('full'); f.respond(call => { assert.equal(call.body.expectedRevision, 'new-revision'); return preference('full', 'saved-2'); });
  assert.equal(await f.submit(), true);
});

test('an automatic tab refresh preserves an unsaved choice without refetching', async () => {
  const f = fixture(); await f.load(); f.select('deploy-owned'); await f.load();
  assert.equal(f.calls.length, 1); assert.equal(f.elements.deployBackupScopeSelect.value, 'deploy-owned');
  let stopped = false; f.elements.deployBackupScopeForm.listeners.input({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true, 'the separate preference form does not enter the general settings draft/save flow');
});

test('unauthorized roles, missing backup permission and non-server mode cannot load or save', async () => {
  for (const change of [f => { f.state.portalSession.user.role = 'employee'; }, f => { f.state.portalSession.user.permissions = []; }, f => { f.state.portalStatus.operationMode = 'local'; }]) {
    const f = fixture(); change(f); f.context.renderDeployBackupScope();
    assert.equal(await f.load(), false); assert.equal(await f.submit(), false); assert.equal(f.calls.length, 0);
    assert.equal(f.elements.deployBackupScopeCard.classList.contains('hidden'), true);
  }
  for (const role of ['developer', 'it_admin', 'admin']) { const f = fixture(); f.state.portalSession.user.role = role; assert.equal(await f.load(), true); }
});

test('late load and save responses from a previous actor do not replace the new view or announce success', async () => {
  for (const operation of ['load', 'save']) {
    const f = fixture(); if (operation === 'save') { await f.load(); f.select('deploy-owned'); }
    const wait = deferred(); f.respond(() => wait.promise); const previous = operation === 'save' ? f.submit() : f.load();
    f.changeActor('B'); f.respond(() => preference('full', 'actor-B')); await f.load();
    wait.resolve(preference('deploy-owned', 'actor-A')); assert.equal(await previous, false);
    assert.equal(f.state.deployBackupScope.revision, 'actor-B'); assert.equal(f.elements.deployBackupScopeSelect.value, 'full'); assert.equal(f.toasts.length, 0);
  }
});

test('missing or invalid server configuration never becomes an editable or silently saved preference', async () => {
  for (const invalid of [{ ...preference(), scope: 'core-only' }, { ...preference(), revision: '' }, { ...preference(), available: false }, { ...preference(), appliesTo: 'all-backups' }]) {
    const f = fixture(); f.respond(() => invalid); assert.equal(await f.load(), false); assert.equal(f.state.deployBackupScope, null);
    assert.equal(f.elements.deployBackupScopeSelect.disabled, true); assert.equal(await f.submit(), false); assert.equal(f.calls.length, 1);
  }
});

test('a confirmed invalid stored value uses full scope and can be repaired using its opaque revision', async () => {
  const f = fixture(), revision = 'invalid-' + 'b'.repeat(64); f.respond(() => ({ ...preference('full', revision), valid: false }));
  assert.equal(await f.load(), true); assert.equal(f.elements.deployBackupScopeSelect.value, 'full');
  assert.match(f.elements.deployBackupScopeStatus.textContent, /Vollständig: GP Core und Sales wird verwendet/);
  assert.equal(f.elements.saveDeployBackupScopeButton.disabled, false);
  f.respond(call => { assert.deepEqual(call.body, { scope: 'full', expectedRevision: revision }); return preference('full', 'repaired'); });
  assert.equal(await f.submit(), true); assert.equal(f.state.deployBackupScope.valid, true); assert.equal(f.elements.saveDeployBackupScopeButton.disabled, true);
});

test('the settings card exposes the actual update-only preference and its full-backup priority', () => {
  const card = html.slice(html.indexOf('id="deployBackupScopeCard"'), html.indexOf('id="databaseBackupSettingsCard"'));
  assert.match(card, /Sicherungsumfang bei Updates/); assert.match(card, /Vollständig: GP Core und Sales/); assert.match(card, /GP Core und eigene Inhalte/);
  assert.match(card, /Erforderliche Vollprüfungen und nächtliche Vollsicherungen haben Vorrang/);
  assert.match(card, /id="deployBackupScopeForm"/); assert.match(card, /id="deployBackupScopeSelect" disabled/);
  assert.match(app, /loadMaintenanceSchedules\(\);\s+loadDeployBackupScope\(\);/);
});
