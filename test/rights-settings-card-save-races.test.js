"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');

function productionFunction(name) {
  const starts = [`function ${name}(`, `async function ${name}(`].map(marker => source.indexOf(marker)).filter(index => index >= 0);
  const start = Math.min(...starts), end = source.indexOf('\n}', start);
  assert.ok(Number.isFinite(start) && end > start, `Production function ${name} exists`);
  return source.slice(start, end + 2);
}

class Element {
  constructor() { this.dataset = {}; this.children = []; this.textContent = ''; this.value = ''; this.disabled = false; this.listeners = new Map(); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelectorAll() { throw new Error('Saving must use all model fields, not only rendered table controls.'); }
  change() { this.listeners.get('change')?.(); }
}

function mobilePayload() {
  const ids = ['timeTracking', 'team', 'approvals', 'schedule', 'requests', 'learning', 'more'];
  return { canChange: true, availableModules: ids.map(id => ({ id, label: id })), layouts: {
    location_planner: ['schedule', 'more'], department_manager: ['timeTracking', 'schedule', 'more'],
    manager: ['timeTracking', 'team', 'more'], hr: ['timeTracking', 'approvals', 'more'],
    admin: ['timeTracking', 'requests', 'more'], it_admin: ['timeTracking', 'learning', 'more'], developer: ['timeTracking', 'team', 'schedule', 'more'],
  } };
}
function personnelPayload() {
  return { canChange: true, roles: [{ id: 'manager', label: 'Filialleitung' }, { id: 'department_manager', label: 'Abteilungsleitung' }],
    fields: [{ key: 'contact.phone', label: 'Telefon', group: 'Kontakt', sensitive: true },
      { key: 'contact.address', label: 'Adresse', group: 'Kontakt' }, { key: 'identity.name', label: 'Name', group: 'Stammdaten' },
      { key: 'employment.protectionStatus', label: 'Schutzstatus', group: 'Beschäftigung', sensitive: true },
      { key: 'employment.retailKv', label: 'Handels-KV', group: 'Beschäftigung', sensitive: true }],
    accessLevels: [{id: 'hidden', label: 'Verborgen'}, {id: 'read', label: 'Nur lesen'}, {id: 'write', label: 'Bearbeiten'}],
    matrix: { manager: { 'contact.phone': 'read', 'contact.address': 'hidden', 'identity.name': 'write', 'employment.protectionStatus': 'hidden', 'employment.retailKv': 'hidden' },
      department_manager: { 'contact.phone': 'hidden', 'contact.address': 'read', 'identity.name': 'read' } },
  };
}
function fixture() {
  const requests = [], toasts = [], tables = [];
  const state = { portalStatus: { portalEnabled: true }, portalSession: { authenticated: true, user: { role: 'developer', employeeNumber: 'SYN-admin' } },
    mobileLeadershipSettings: mobilePayload(), mobileLeadershipSettingsDraft: null, mobileLeadershipSettingsSavingContext: null,
    personnelFieldRights: personnelPayload(), personnelFieldRightsSavingContext: null,
    selectedPersonnelFieldRightsRole: 'manager', personnelFieldRightsDirtyRoles: new Set(), personnelFieldRightsDrafts: {} };
  const elements = Object.fromEntries(['mobileLeadershipModuleSettings', 'mobileLeadershipSettingsHint', 'saveMobileLeadershipSettingsButton',
    'personnelFieldRightsMatrix', 'personnelFieldRightsRole', 'personnelFieldRightsHint', 'savePersonnelFieldRightsButton'].map(id => [id, new Element()]));
  elements.personnelFieldRightsRole.selectedOptions = [{textContent: 'Filialleitung'}];
  const context = { state, elements, AbortController, Set, Object, JSON, Boolean, String, Number,
    actor: 'SYN-actor-A', access: true, rightsWorkspaceActorKey: () => context.actor,
    canUseRightsWorkspace: () => context.access, rightsSettingsTableIdentity: () => state.portalSession.user.employeeNumber,
    escapeHtml: value => String(value), escapeHtmlAttribute: value => String(value), showToast: (...args) => toasts.push(args),
    window: { RightsSettingsTable: {mount(options) {
      const table = {options, rows: options.rows || [], destroyed: false, renders: 0,
        setRows(rows) { this.rows = rows; this.renders++; }, destroy() { this.destroyed = true; } };
      tables.push(table); return table;
    }}},
    api(url, options) { return new Promise((resolve, reject) => requests.push({url, options, resolve, reject})); },
  };
  const globals = source.slice(source.indexOf('let mobileLeadershipSettingsTable ='), source.indexOf('\n\nfunction canUseRightsSettingsCards()'));
  const names = ['canUseRightsSettingsCards', 'resetRightsSettingsCardState', 'mobileLeadershipLayoutsForSave', 'updateMobileLeadershipSetting',
    'renderMobileLeadershipSettings', 'personnelFieldLevelLabel', 'personnelFieldRightsForSave', 'updatePersonnelFieldRight',
    'renderPersonnelFieldRights', 'savePersonnelFieldRights', 'saveMobileLeadershipSettings'];
  vm.runInNewContext(`${globals}\n${names.map(productionFunction).join('\n')}\nthis.handlers={${names.join(',')}};`, context);
  const doc = {createElement: () => new Element()};
  const table = id => tables.findLast(entry => entry.options.tableId === id && !entry.destroyed);
  const field = key => {
    const entry = table('rights:personnel-fields');
    return entry.options.columns.find(column => column.id === 'access').cell(entry.rows.find(row => row.key === key), doc);
  };
  const module = (role, id) => {
    const entry = table('rights:mobile-leadership');
    return entry.options.columns.find(column => column.id === id).cell(entry.rows.find(row => row.role === role), doc);
  };
  return {state, elements, context, handlers: context.handlers, requests, toasts, tables, table, field, module,
    render() {context.handlers.renderMobileLeadershipSettings();context.handlers.renderPersonnelFieldRights();},
    sent(index = requests.length - 1) {return JSON.parse(requests[index].options.body);},
  };
}

test('Personalakt table starts with every field and keeps role drafts through table rerender and role switch', () => {
  const f = fixture();f.render();
  assert.equal(f.table('rights:personnel-fields').rows.length, 5);
  const select = f.field('contact.phone');select.value = 'write';select.change();
  f.handlers.renderPersonnelFieldRights();
  assert.equal(f.field('contact.phone').value, 'write');
  f.state.selectedPersonnelFieldRightsRole = 'department_manager';f.handlers.renderPersonnelFieldRights();
  assert.equal(f.field('contact.phone').value, 'hidden');
  f.state.selectedPersonnelFieldRightsRole = 'manager';f.handlers.renderPersonnelFieldRights();
  assert.equal(f.field('contact.phone').value, 'write');
  assert.equal(f.state.personnelFieldRightsDirtyRoles.has('manager'), true);
});

test('Personalakt save includes every hidden or filtered field, with protected MSchG and KV always hidden', async () => {
  const f = fixture();f.render();
  f.state.personnelFieldRightsDrafts.manager = {'contact.phone': 'write', 'identity.name': 'read', 'employment.protectionStatus': 'write', 'employment.retailKv': 'read'};
  f.table('rights:personnel-fields').rows = [f.table('rights:personnel-fields').rows[0]];
  const pending = f.handlers.savePersonnelFieldRights();
  assert.deepEqual(f.sent().fields, {'contact.phone': 'write', 'contact.address': 'hidden', 'identity.name': 'read', 'employment.protectionStatus': 'hidden', 'employment.retailKv': 'hidden'});
  f.requests[0].resolve(personnelPayload());await pending;
  assert.equal(f.state.personnelFieldRightsDrafts.manager, undefined);
});

test('Protected Personalakt cells cannot expose MSchG or KV through their controls', () => {
  const f = fixture();f.render();
  for (const key of ['employment.protectionStatus', 'employment.retailKv']) {
    const select = f.field(key);assert.equal(select.disabled, true);assert.equal(select.value, 'hidden');
    select.value = 'write';select.change();assert.equal(select.value, 'hidden');
    assert.equal(f.state.personnelFieldRightsDirtyRoles.size, 0);
  }
});

test('Personalakt late acknowledgment preserves changes made during save and another role draft', async () => {
  const f = fixture();f.render();
  const first = f.field('contact.phone');first.value = 'write';first.change();
  const pending = f.handlers.savePersonnelFieldRights();
  first.value = 'hidden';first.change();
  f.state.selectedPersonnelFieldRightsRole = 'department_manager';f.handlers.renderPersonnelFieldRights();
  const other = f.field('contact.address');other.value = 'write';other.change();
  f.requests[0].resolve(personnelPayload());await pending;
  assert.equal(f.state.personnelFieldRightsDrafts.manager['contact.phone'], 'hidden');
  assert.equal(f.state.personnelFieldRightsDrafts.department_manager['contact.address'], 'write');
  assert.equal(f.state.selectedPersonnelFieldRightsRole, 'department_manager');
  assert.equal(f.field('contact.address').value, 'write');
  assert.equal(f.state.personnelFieldRightsDirtyRoles.size, 2);
});

test('Personalakt repeated save is single flight and failure keeps draft available for retry', async () => {
  const f = fixture();f.render();const select = f.field('contact.phone');select.value = 'write';select.change();
  const pending = f.handlers.savePersonnelFieldRights();await f.handlers.savePersonnelFieldRights();
  assert.equal(f.requests.length, 1);assert.equal(f.elements.savePersonnelFieldRightsButton.disabled, true);
  f.requests[0].reject(new Error('Synthetic transport failure'));await pending;
  assert.equal(f.field('contact.phone').value, 'write');assert.equal(f.elements.savePersonnelFieldRightsButton.disabled, false);
  const retry = f.handlers.savePersonnelFieldRights();f.requests[1].resolve(personnelPayload());await retry;
  assert.equal(f.requests.length, 2);
});

test('Mobile table keeps required tracking and planner limits while editing other modules', () => {
  const f = fixture();f.render();
  assert.equal(f.table('rights:mobile-leadership').rows.length, 7);
  const tracking = f.module('manager', 'timeTracking');assert.equal(tracking.checked, true);assert.equal(tracking.disabled, true);
  const blocked = f.module('location_planner', 'requests');assert.equal(blocked.checked, false);assert.equal(blocked.disabled, true);
  const schedule = f.module('manager', 'schedule');schedule.checked = true;schedule.change();f.handlers.renderMobileLeadershipSettings();
  assert.equal(f.module('manager', 'schedule').checked, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.handlers.mobileLeadershipLayoutsForSave().location_planner)), ['schedule', 'more']);
});

test('Mobile save preserves full layouts including modules excluded from visible columns or current availableModules', async () => {
  const f = fixture();f.state.mobileLeadershipSettings.availableModules = [{id: 'timeTracking', label: 'Time'}, {id: 'more', label: 'More'}];f.render();
  const pending = f.handlers.saveMobileLeadershipSettings();
  assert.equal(Object.keys(f.sent().layouts).length, 7);
  assert.deepEqual(f.sent().layouts.admin, ['timeTracking', 'requests', 'more']);
  assert.deepEqual(f.sent().layouts.it_admin, ['timeTracking', 'learning', 'more']);
  f.requests[0].resolve(mobilePayload());await pending;
});

test('Mobile update rejects seventh module without silently losing an existing selection', () => {
  const f = fixture();f.state.mobileLeadershipSettings.layouts.manager = ['timeTracking', 'team', 'approvals', 'schedule', 'requests', 'more'];f.render();
  const learning = f.module('manager', 'learning');learning.checked = true;learning.change();
  assert.equal(learning.checked, false);assert.equal(f.state.mobileLeadershipSettingsDraft, null);
  assert.equal(f.handlers.mobileLeadershipLayoutsForSave().manager.length, 6);
  assert.match(f.toasts[0][0], /höchstens sechs/);
});

test('Mobile save is single flight and late edits remain as an unsaved complete draft', async () => {
  const f = fixture();f.render();
  const schedule = f.module('manager', 'schedule');schedule.checked = true;schedule.change();
  const pending = f.handlers.saveMobileLeadershipSettings();await f.handlers.saveMobileLeadershipSettings();
  assert.equal(f.requests.length, 1);
  const team = f.module('manager', 'team');team.checked = false;team.change();
  f.requests[0].resolve(mobilePayload());await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.mobileLeadershipSettingsDraft.manager)), ['timeTracking', 'more', 'schedule']);
  assert.equal(f.elements.saveMobileLeadershipSettingsButton.disabled, false);
});

test('Mobile transport failure keeps draft and releases only its own save lock', async () => {
  const f = fixture();f.render();const schedule = f.module('manager', 'schedule');schedule.checked = true;schedule.change();
  const pending = f.handlers.saveMobileLeadershipSettings();f.requests[0].reject(new Error('Synthetic timeout'));await pending;
  assert.equal(f.module('manager', 'schedule').checked, true);assert.equal(f.state.mobileLeadershipSettingsSavingContext, null);
  assert.equal(f.elements.saveMobileLeadershipSettingsButton.disabled, false);
});

test('Mobile module columns remount after catalog changes without losing the RAM draft', () => {
  const f = fixture();f.state.mobileLeadershipSettings.availableModules = [{id: 'timeTracking', label: 'Time'}];f.render();
  const first = f.table('rights:mobile-leadership');f.state.mobileLeadershipSettings.availableModules = mobilePayload().availableModules;
  f.handlers.renderMobileLeadershipSettings();assert.equal(first.destroyed, true);
  assert.ok(f.table('rights:mobile-leadership').options.columns.some(column => column.id === 'schedule'));
});

for (const type of ['personnel', 'mobile']) {
  test(`${type} old actor acknowledgment cannot replace a new actor payload or release its new save lock`, async () => {
    const f = fixture();f.render();const save = type === 'personnel' ? f.handlers.savePersonnelFieldRights : f.handlers.saveMobileLeadershipSettings;
    const key = type === 'personnel' ? 'personnelFieldRights' : 'mobileLeadershipSettings', contextKey = `${key}SavingContext`;
    const pending = save();f.context.actor = 'SYN-actor-B';f.state[key] = {syntheticNewActor: true, canChange: false};
    const next = {controller: new AbortController()};f.state[contextKey] = next;
    f.requests[0].resolve(type === 'personnel' ? personnelPayload() : mobilePayload());await pending;
    assert.equal(f.state[key].syntheticNewActor, true);assert.equal(f.state[contextKey], next);assert.equal(f.toasts.length, 0);
  });
  test(`${type} read-only and manager-only contexts cannot write`, async () => {
    const f = fixture();f.render();const save = type === 'personnel' ? f.handlers.savePersonnelFieldRights : f.handlers.saveMobileLeadershipSettings;
    f.state.portalSession.user.role = 'manager';await save();assert.equal(f.requests.length, 0);
    f.state.portalSession.user.role = 'developer';f.state[type === 'personnel' ? 'personnelFieldRights' : 'mobileLeadershipSettings'].canChange = false;
    await save();assert.equal(f.requests.length, 0);
    f.context.access = false;await save();assert.equal(f.requests.length, 0);
  });
}

test('Actor reset aborts both saves, clears sensitive rows and drafts, then ignores their acknowledgments', async () => {
  const f = fixture();f.render();const fieldSave = f.handlers.savePersonnelFieldRights(), mobileSave = f.handlers.saveMobileLeadershipSettings();
  const signals = f.requests.map(request => request.options.signal);f.handlers.resetRightsSettingsCardState();
  assert.equal(signals.every(signal => signal.aborted), true);assert.equal(f.state.personnelFieldRights, null);assert.equal(f.state.mobileLeadershipSettings, null);
  assert.equal(f.tables.every(table => table.destroyed), true);assert.equal(f.state.personnelFieldRightsDirtyRoles.size, 0);
  f.requests[0].resolve(personnelPayload());f.requests[1].resolve(mobilePayload());await Promise.all([fieldSave, mobileSave]);
  assert.equal(f.state.personnelFieldRights, null);assert.equal(f.state.mobileLeadershipSettings, null);assert.equal(f.toasts.length, 0);
});
