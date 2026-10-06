'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { create } = require('../public/form-draft-guard');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

// Execute the real application functions and guard. The small DOM below only
// supplies the renderer's element/HTML operations; no save or merge is mocked.
function sourceFunction(name) {
  const start = app.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name);
  const end = app.indexOf('\n}', start);
  assert.ok(end > start, name);
  return app.slice(start, end + 2);
}
function fixture() {
  const nodes = new Map(), listeners = {}, calls = [], toasts = [];
  const decode = value => String(value).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  class Node {
    constructor(id = '', tagName = 'DIV', parent = null) {
      Object.assign(this, { id, tagName, parent, children: [], value: '', checked: false, disabled: false, dataset: {}, textContent: '', type: 'text' });
      const classes = new Set(); this.classList = { contains: key => classes.has(key),
        toggle: (key, yes) => { if (yes ?? !classes.has(key)) classes.add(key); else classes.delete(key); }, add: key => classes.add(key) };
      if (parent) parent.children.push(this); if (id) nodes.set(id, this);
    }
    contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); }
    removeEventListener() {}
    get valueAsNumber() { return Number(this.value); }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    querySelectorAll(selector) {
      const attribute = /^\[data-([^\]]+)\]$/.exec(selector);
      const key = attribute?.[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return this.descendants().filter(node => selector.startsWith('#') ? node.id === selector.slice(1) : key && Object.hasOwn(node.dataset, key));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    set innerHTML(html) {
      for (const child of this.descendants()) if (child.id) nodes.delete(child.id);
      this.children = []; const stack = [this];
      for (const match of String(html).matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/giu)) {
        const tag = match[2].toUpperCase();
        if (match[1]) { if (stack.at(-1)?.tagName === tag) stack.pop(); continue; }
        const attributes = {};
        for (const attr of match[3].matchAll(/([^\s=\/]+)(?:="([^"]*)")?/gu)) attributes[attr[1]] = decode(attr[2] ?? '');
        const node = new Node(attributes.id || '', tag, stack.at(-1));
        node.type = attributes.type || (tag === 'SELECT' ? 'select-one' : 'text');
        node.value = attributes.value || ''; node.checked = Object.hasOwn(attributes, 'checked'); node.disabled = Object.hasOwn(attributes, 'disabled');
        if (attributes.class) attributes.class.split(/\s+/u).forEach(key => node.classList.add(key));
        for (const [key, value] of Object.entries(attributes)) if (key.startsWith('data-')) node.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
        if (tag === 'OPTION' && stack.at(-1).tagName === 'SELECT') {
          if (stack.at(-1).children.length === 1 || Object.hasOwn(attributes, 'selected')) stack.at(-1).value = node.value;
        }
        if (!['INPUT', 'IMG', 'BR', 'HR'].includes(tag) && !/\/\s*$/u.test(match[3])) stack.push(node);
      }
    }
  }
  const root = new Node('settingsView');
  root.ownerDocument = { getElementById: id => nodes.get(id) || null };
  const greetingCard = new Node('greetingSettingsCard', 'DIV', root), birthdayCard = new Node('birthdayPresentationSettingsCard', 'DIV', root);
  const controls = { settingsView: root, greetingSettingsCard: greetingCard, birthdayPresentationSettingsCard: birthdayCard };
  const checkbox = new Set(['personalizedGreetingsEnabled', 'birthdayPresentationEnabled', 'birthdayPresentationDeveloperPreviewEnabled']);
  function add(id, parent = root, tag = 'INPUT') {
    const node = new Node(id, tag, parent); node.type = checkbox.has(id) ? 'checkbox' : /Button$/u.test(id) ? 'button' : 'text'; controls[id] = node; return node;
  }
  for (const id of ['personalizedGreetingsEnabled', 'greetingVacationMinimumDays', 'greetingReturnWorkdays', 'greetingRecoveryWorkdays',
    'greetingMorningTemplates', 'greetingDaytimeTemplates', 'greetingEveningTemplates', 'greetingVacationTemplates',
    'greetingSicknessActiveTemplates', 'greetingSicknessReturnTemplates', 'greetingSettingsHint', 'saveGreetingSettingsButton']) add(id, greetingCard);
  for (const id of ['birthdayPresentationScope', 'birthdayPresentationDeveloperPreviewHint', 'birthdayPresentationGlobalSection',
    'birthdayPresentationEnabled', 'birthdayPresentationTeamSection', 'birthdayPresentationEmployeeSearch', 'birthdayPresentationLocationFilter',
    'birthdayPresentationDelegatesSection', 'birthdayPresentationSettingsHint', 'saveBirthdayPresentationSettingsButton',
    'saveBirthdayPresentationDeveloperPreviewButton']) add(id, birthdayCard);
  const previewSection = add('birthdayPresentationDeveloperPreviewSection', birthdayCard, 'DIV');
  add('birthdayPresentationDeveloperPreviewEnabled', previewSection);
  add('birthdayPresentationDeveloperPreviewDesign', previewSection, 'SELECT');
  add('birthdayPresentationEmployeeList', birthdayCard, 'DIV'); add('birthdayPresentationDelegateList', birthdayCard, 'DIV');
  const elements = new Proxy(controls, { get(target, name) { return target[name] || (typeof name === 'string' ? add(name) : undefined); } });
  const guard = create(root), state = { portalStatus: { portalEnabled: true }, portalSession: { authenticated: true,
    user: { employeeNumber: 'A', sessionKind: 'employee', isEmployee: true, role: 'developer', permissions: ['settings:write', 'branding:write', 'schedule:write', 'schedule:cross_location:settings:write'], scopes: [] } },
    locationId: '18', departmentId: '', schedulePdfDesignSelection: ['classic'], brandingFormDirty: true, scheduleDutyColorsDirty: true,
    allowPastWeekEditing: false, birthdayPresentationSettingsSavingContext: null };
  let handler = async route => { throw new Error('Unexpected request: ' + route); }, tab = 'general';
  const document = { querySelector(selector) {
    if (selector === '[data-settings-tab].active') return { dataset: { settingsTab: tab } };
    if (selector.startsWith('#')) return nodes.get(selector.slice(1)) || add(selector.slice(1));
    throw new Error('Unexpected selector: ' + selector);
  } };
  const invoke = (route, options = {}) => { const call = { route, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined }; calls.push(call); return handler(route, call); };
  const context = { state, elements, document, settingsDraftGuard: guard, api: invoke,
    showToast: (...args) => toasts.push(args), schedulePdfSettingsWritePermission: 'schedule:pdf:settings:write',
    schedulePdfDesignNamesForSave: () => ({ classic: 'Klassisch' }), canManageScheduleDutyColors: () => true,
    saveAppFontScalePercent: value => invoke('font', { body: JSON.stringify({ value }) }),
    saveCustomManagementBranding: () => invoke('branding'), saveScheduleDutyColors: () => invoke('duty'), loadAll: () => invoke('loadAll'),
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;') };
  vm.createContext(context);
  for (const name of ['isLocalStartDashboardWorkspace', 'startDashboardWorkspaceActorKey', 'greetingTemplateLines', 'renderGreetingSettings',
    'loadGreetingSettings', 'saveGreetingSettings', 'birthdayPresentationCatalog', 'renderBirthdayPresentationCatalog', 'birthdayPresentationOptions',
    'filterBirthdayPresentationEmployees', 'birthdayPresentationChanges', 'updateBirthdayPresentationSettingsState', 'renderBirthdayPresentationSettings',
    'loadBirthdayPresentationSettings', 'saveBirthdayPresentationSettings', 'saveBirthdayPresentationDeveloperPreview', 'saveSettings']) vm.runInContext(sourceFunction(name), context);
  function edit(id, value) { const node = nodes.get(id); assert.ok(node, id); if (node.type === 'checkbox') node.checked = value; else node.value = value;
    for (const listener of listeners.input || []) listener({ target: node }); return node; }
  return { context, state, elements, guard, calls, toasts, nodes, edit,
    respond(fn) { handler = fn; }, setTab(value) { tab = value; },
    changeActor() { state.portalSession.user = { ...state.portalSession.user, employeeNumber: 'B' }; guard.clear(); state.birthdayPresentationSettingsSavingContext = null; } };
}
function greeting(text = 'Servertext') { return { canChange: true, settings: { enabled: true, vacationMinimumCalendarDays: 14,
  vacationReturnWorkdays: 3, sicknessReturnWorkdays: 2, templates: { morning: [text], daytime: ['Tag'], evening: ['Abend'], vacationReturn: [], sicknessActive: [], sicknessReturn: [] } } }; }
function birthday() { return { capabilities: { canManageGlobal: true, canManageTeam: true, canDelegateTeam: true },
  scope: { label: 'Synthetische Filiale' }, policy: { enabled: false, revision: 'policy-0' },
  presentations: ['elegant', 'farbenfroh', 'fotowelt', 'technik', 'standard'].map(id => ({ id, label: id, description: 'Synthetic ' + id,
    previewUrl: '/assets/birthday-presentations/' + (id === 'standard' ? 'dezent' : id) + '.svg' })),
  employees: ['A', 'B', 'C'].map((employeeNumber, index) => ({ employeeNumber, displayName: 'Synthetic ' + employeeNumber,
    locationName: '18', presentationId: 'elegant', revision: 2 + index })), delegates: [{ employeeNumber: 'D', enabled: false }] }; }

test('greeting save acknowledges only submitted inputs and preserves later edits using the real guard', async () => {
  const f = fixture(), wait = deferred(); f.context.renderGreetingSettings(greeting());
  f.edit('greetingMorningTemplates', 'Gesendeter Text'); f.edit('greetingDaytimeTemplates', 'Gesendeter Tag');
  f.respond(() => wait.promise); const saving = f.context.saveGreetingSettings();
  assert.deepEqual(f.calls[0].body.templates.morning, ['Gesendeter Text']);
  f.edit('greetingMorningTemplates', 'Späterer Text');
  const response = greeting('Gesendeter Text'); response.settings.templates.daytime = ['Gesendeter Tag']; wait.resolve(response); await saving;
  assert.equal(f.elements.greetingMorningTemplates.value, 'Späterer Text');
  assert.deepEqual([...f.guard.snapshot().keys()], ['greetingMorningTemplates']);
  assert.equal(f.state.greetingSettings.settings.templates.morning[0], 'Gesendeter Text');
});

test('dirty greeting and birthday navigation does not refetch/rebase drafts; initial late greeting response preserves typed input', async () => {
  const f = fixture(); f.context.renderGreetingSettings(greeting()); f.context.renderBirthdayPresentationSettings(birthday());
  f.edit('greetingMorningTemplates', 'Entwurf'); f.edit('birthday-employee-B', 'technik');
  await f.context.loadGreetingSettings(); await f.context.loadBirthdayPresentationSettings(); assert.equal(f.calls.length, 0);
  assert.equal(f.nodes.get('birthday-employee-B').dataset.birthdayPresentationRevision, '3');
  const initial = fixture(), wait = deferred(); initial.respond(() => wait.promise);
  const loading = initial.context.loadGreetingSettings(); initial.edit('greetingMorningTemplates', 'Während Laden eingegeben'); wait.resolve(greeting()); await loading;
  assert.equal(initial.elements.greetingMorningTemplates.value, 'Während Laden eingegeben');
  assert.equal(initial.state.greetingSettings.settings.templates.morning[0], 'Servertext');
});

test('greeting and birthday loaders ignore old responses and errors after an actor change', async () => {
  for (const method of ['loadGreetingSettings', 'loadBirthdayPresentationSettings']) for (const reject of [false, true]) {
    const f = fixture(), wait = deferred(); f.respond(() => wait.promise); const loading = f.context[method](); f.changeActor();
    f.context.renderGreetingSettings(greeting('Konto B')); f.context.renderBirthdayPresentationSettings(birthday());
    const stateBefore = clone(f.state), hint = f.elements.birthdayPresentationSettingsHint.textContent;
    if (reject) wait.reject(Object.assign(new Error('Alter Fehler'), { status: 403 })); else wait.resolve(method.includes('Greeting') ? greeting('Konto A') : { ...birthday(), policy: { enabled: true, revision: 'old-response' } });
    await loading; assert.deepEqual(clone(f.state), stateBefore); assert.equal(f.elements.birthdayPresentationSettingsHint.textContent, hint);
    assert.equal(f.elements.greetingMorningTemplates.value, 'Konto B'); assert.equal(f.toasts.length, 0);
  }
});

test('birthday loader cannot silently rebase a row edited while its refresh was pending', async () => {
  const f = fixture(), wait = deferred(); f.context.renderBirthdayPresentationSettings(birthday());
  f.respond(() => wait.promise); const loading = f.context.loadBirthdayPresentationSettings();
  f.edit('birthday-employee-B', 'technik');
  const changedElsewhere = birthday(); changedElsewhere.employees[1].revision = 90; changedElsewhere.employees[1].presentationId = 'standard';
  wait.resolve(changedElsewhere); await loading;
  assert.equal(f.nodes.get('birthday-employee-B').value, 'technik');
  assert.equal(f.nodes.get('birthday-employee-B').dataset.birthdayPresentationRevision, '3');
  assert.deepEqual(clone(f.context.birthdayPresentationChanges()).employees, [{ employeeNumber: 'B', presentationId: 'technik', expectedRevision: 3 }]);
});

test('greeting save ignores an old actor response/error and cannot acknowledge the new actor draft', async () => {
  for (const reject of [false, true]) {
    const f = fixture(), wait = deferred(); f.context.renderGreetingSettings(greeting()); f.edit('greetingMorningTemplates', 'Konto A');
    f.respond(() => wait.promise); const saving = f.context.saveGreetingSettings(); f.changeActor(); f.context.renderGreetingSettings(greeting('Konto B'));
    f.edit('greetingMorningTemplates', 'Entwurf B'); const stateBefore = clone(f.state);
    if (reject) wait.reject(new Error('Alter Speicherfehler')); else wait.resolve(greeting('Konto A'));
    await saving; assert.deepEqual(clone(f.state), stateBefore); assert.equal(f.elements.greetingMorningTemplates.value, 'Entwurf B');
    assert.equal(f.guard.hasDraft(f.elements.greetingSettingsCard), true); assert.equal(f.toasts.length, 0);
  }
});

test('birthday global save updates only the written policy and preserves another newly edited row and its original revision', async () => {
  const f = fixture(), wait = deferred(), initial = birthday(); f.context.renderBirthdayPresentationSettings(initial);
  f.edit('birthdayPresentationEnabled', true); f.respond(() => wait.promise); const saving = f.context.saveBirthdayPresentationSettings();
  assert.equal(f.calls[0].body.expectedRevision, 'policy-0'); f.edit('birthday-employee-B', 'technik');
  const response = birthday(); response.policy = { enabled: true, revision: 'policy-1' }; response.employees.forEach(row => { row.revision += 80; row.presentationId = 'standard'; });
  wait.resolve(response); await saving;
  assert.equal(f.state.birthdayPresentationSettings.policy.revision, 'policy-1');
  assert.equal(f.nodes.get('birthday-employee-B').value, 'technik'); assert.equal(f.nodes.get('birthday-employee-B').dataset.birthdayPresentationRevision, '3');
  assert.deepEqual(clone(f.context.birthdayPresentationChanges()).employees, [{ employeeNumber: 'B', presentationId: 'technik', expectedRevision: 3 }]);
  assert.equal(f.calls.length, 1); assert.deepEqual([...f.guard.snapshot().keys()], ['birthday-employee-B']);
});

test('birthday saving context blocks duplicate saves across partial renders and releases after the final write', async () => {
  const f = fixture(), globalWrite = deferred(), rowWrite = deferred(); f.context.renderBirthdayPresentationSettings(birthday());
  f.edit('birthdayPresentationEnabled', true); f.edit('birthday-employee-A', 'technik');
  f.respond(route => route.endsWith('/global') ? globalWrite.promise : rowWrite.promise);
  const saving = f.context.saveBirthdayPresentationSettings(); await f.context.saveBirthdayPresentationSettings();
  assert.equal(f.calls.length, 1); assert.ok(f.state.birthdayPresentationSettingsSavingContext);
  f.edit('birthday-employee-B', 'fotowelt'); f.context.updateBirthdayPresentationSettingsState();
  assert.equal(f.elements.saveBirthdayPresentationSettingsButton.disabled, true);
  const savedGlobal = birthday(); savedGlobal.policy = { enabled: true, revision: 'policy-1' }; globalWrite.resolve(savedGlobal); await tick();
  assert.equal(f.calls.length, 2); assert.equal(f.elements.saveBirthdayPresentationSettingsButton.disabled, true);
  await f.context.saveBirthdayPresentationSettings(); assert.equal(f.calls.length, 2);
  const savedRow = clone(savedGlobal); savedRow.employees[0] = { ...savedRow.employees[0], presentationId: 'technik', revision: 3 };
  rowWrite.resolve(savedRow); await saving;
  assert.equal(f.state.birthdayPresentationSettingsSavingContext, null);
  assert.equal(f.nodes.get('birthday-employee-B').value, 'fotowelt');
  assert.equal(f.elements.saveBirthdayPresentationSettingsButton.disabled, false, 'A later unsaved row can be saved after this batch ends');
});

test('birthday staged row saves keep unrelated CAS anchors, later inputs and partial success after a second-row conflict', async () => {
  for (const conflict of [false, true]) {
    const f = fixture(), first = deferred(), second = deferred(); f.context.renderBirthdayPresentationSettings(birthday());
    f.edit('birthday-employee-A', 'technik'); f.edit('birthday-employee-B', 'farbenfroh');
    f.respond(route => route.endsWith('/A') ? first.promise : second.promise); const saving = f.context.saveBirthdayPresentationSettings();
    f.edit('birthday-employee-A', 'standard'); f.edit('birthday-employee-B', 'fotowelt'); f.edit('birthday-employee-C', 'technik'); f.edit('birthday-delegate-D', true);
    const response = birthday(); response.policy = { enabled: true, revision: 'unrelated-new-policy' }; response.employees.forEach(row => { row.revision += 90; row.presentationId = 'standard'; });
    response.employees[0] = { ...response.employees[0], presentationId: 'technik', revision: 3 }; response.delegates[0].enabled = true;
    first.resolve(response); await tick();
    assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1].body, { presentationId: 'farbenfroh', expectedRevision: 3 });
    assert.equal(f.state.birthdayPresentationSettings.employees[0].revision, 3);
    assert.equal(f.state.birthdayPresentationSettings.employees[1].revision, 3); assert.equal(f.state.birthdayPresentationSettings.employees[2].revision, 4);
    assert.equal(f.state.birthdayPresentationSettings.policy.revision, 'policy-0'); assert.equal(f.state.birthdayPresentationSettings.delegates[0].enabled, false);
    assert.equal(f.nodes.get('birthday-employee-C').value, 'technik'); assert.equal(f.nodes.get('birthday-delegate-D').checked, true);
    if (conflict) second.reject(Object.assign(new Error('CAS-Konflikt B'), { status: 409 }));
    else { const savedB = clone(response); savedB.employees[1] = { ...savedB.employees[1], presentationId: 'farbenfroh', revision: 4 }; second.resolve(savedB); }
    await saving;
    assert.equal(f.nodes.get('birthday-employee-A').value, 'standard'); assert.equal(f.nodes.get('birthday-employee-B').value, 'fotowelt');
    assert.equal(f.nodes.get('birthday-employee-B').dataset.birthdayPresentationRevision, conflict ? '3' : '4');
    assert.equal(f.nodes.get('birthday-employee-C').dataset.birthdayPresentationRevision, '4'); assert.equal(f.guard.snapshot().size, 4);
    if (conflict) assert.equal(f.toasts.at(-1)[0], 'CAS-Konflikt B');
  }
});

test('birthday save stops following writes and ignores old success/errors after an actor change', async () => {
  for (const reject of [false, true]) {
    const f = fixture(), wait = deferred(); f.context.renderBirthdayPresentationSettings(birthday());
    f.edit('birthdayPresentationEnabled', true); f.edit('birthday-employee-A', 'technik'); f.edit('birthday-employee-B', 'standard'); f.edit('birthday-delegate-D', true);
    f.respond(() => wait.promise); const saving = f.context.saveBirthdayPresentationSettings(); assert.equal(f.calls.length, 1);
    f.changeActor(); const b = birthday(); b.policy.revision = 'B-policy'; f.context.renderBirthdayPresentationSettings(b); f.edit('birthday-employee-C', 'fotowelt');
    const stateBefore = clone(f.state); if (reject) wait.reject(new Error('Alter Fehler')); else wait.resolve(birthday()); await saving;
    assert.equal(f.calls.length, 1); assert.deepEqual(clone(f.state), stateBefore); assert.equal(f.nodes.get('birthday-employee-C').value, 'fotowelt');
    assert.equal(f.guard.snapshot().size, 1); assert.equal(f.toasts.length, 0);
  }
});

test('birthday developer-preview save retains a newly enabled design while the submitted disable is pending', async () => {
  const f = fixture(), wait = deferred(), initial = birthday();
  initial.developerPreview = { available: true, enabled: true, presentationId: 'elegant' };
  f.context.renderBirthdayPresentationSettings(initial); f.edit('birthdayPresentationDeveloperPreviewEnabled', false);
  f.respond(() => wait.promise); const saving = f.context.saveBirthdayPresentationDeveloperPreview();
  assert.deepEqual(f.calls[0].body, { enabled: false, presentationId: null });
  f.edit('birthdayPresentationDeveloperPreviewEnabled', true);
  // The real checkbox change listener enables the design selector synchronously.
  f.elements.birthdayPresentationDeveloperPreviewDesign.disabled = false;
  f.edit('birthdayPresentationDeveloperPreviewDesign', 'fotowelt');
  wait.resolve({ developerPreview: { available: true, enabled: false, presentationId: null } }); await saving;
  assert.equal(f.elements.birthdayPresentationDeveloperPreviewEnabled.checked, true);
  assert.equal(f.elements.birthdayPresentationDeveloperPreviewDesign.disabled, false);
  assert.equal(f.elements.birthdayPresentationDeveloperPreviewDesign.value, 'fotowelt');
  assert.equal(f.guard.snapshot(f.elements.birthdayPresentationDeveloperPreviewSection).size, 2);
});

test('main settings save stops at every actor-bound async stage and cannot mutate/acknowledge the new account', async () => {
  for (const stage of ['/api/settings', '/api/portal/v1/ui-preferences', 'font', 'branding', 'duty']) {
    const f = fixture(), wait = deferred(), entered = deferred(); f.elements.appFontScalePercent.value = '100';
    f.respond(route => { if (route === stage) { entered.resolve(); return wait.promise; } return Promise.resolve({ allowPastWeekEditing: true }); });
    const saving = f.context.saveSettings(); await entered.promise; f.changeActor(); f.state.allowPastWeekEditing = false;
    f.edit('greetingMorningTemplates', 'Nicht gespeicherter Entwurf B'); const stateBefore = clone(f.state), count = f.calls.length;
    wait.resolve({ allowPastWeekEditing: true }); assert.equal(await saving, false);
    assert.deepEqual(clone(f.state), stateBefore); assert.equal(f.calls.length, count, stage); assert.equal(f.toasts.length, 0);
    assert.equal(f.guard.hasDraft(f.elements.greetingSettingsCard), true);
  }
});

test('main settings save acknowledges its own submitted fields only and keeps later/unrelated drafts', async () => {
  const f = fixture(), wait = deferred(); f.elements.appFontScalePercent.value = '100';
  f.elements.pdfTitleSetting.value = 'Gesendeter PDF-Titel'; f.edit('pdfTitleSetting', 'Gesendeter PDF-Titel'); f.edit('greetingMorningTemplates', 'Nicht Teil des Hauptspeicherns');
  f.respond(route => route === '/api/settings' ? wait.promise : Promise.resolve({ allowPastWeekEditing: false }));
  const saving = f.context.saveSettings(true); assert.equal(f.calls[0].body.pdfTitle, 'Gesendeter PDF-Titel');
  f.edit('pdfTitleSetting', 'Späterer PDF-Titel'); wait.resolve({}); assert.equal(await saving, true);
  assert.deepEqual([...f.guard.snapshot().keys()].sort(), ['greetingMorningTemplates', 'pdfTitleSetting']);
  assert.equal(f.elements.pdfTitleSetting.value, 'Späterer PDF-Titel');
});
