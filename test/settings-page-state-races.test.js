'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { create } = require('../public/form-draft-guard');
const GpSaveStatus = require('../public/gp-save-status');
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
    setAttribute(name, value) { this[name] = value; }
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
  const amuCard = new Node('amuSettingsCard', 'DIV', root);
  const greetingCard = new Node('greetingSettingsCard', 'DIV', root), birthdayCard = new Node('birthdayPresentationSettingsCard', 'DIV', root);
  const controls = { settingsView: root, greetingSettingsCard: greetingCard, birthdayPresentationSettingsCard: birthdayCard, amuSettingsCard: amuCard };
  const checkbox = new Set(['currentWeekAutoLock','personalizedGreetingsEnabled', 'birthdayPresentationEnabled', 'birthdayPresentationDeveloperPreviewEnabled']);
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
  for (const id of ['settingsSaveStatus','greetingSaveStatus','amuSaveStatus']) add(id, root, 'SPAN');
  for (const id of ['amuUploadMaxMb','amuStoredMaxMb','amuConvertImagesToPdf','amuGrayscaleImages','amuOcrEnabled','sicknessLocalWarningDays','sicknessHrWarningDays','sicknessAumAllowanceEnabled','sicknessAumAllowanceMaxCases','sicknessAumAllowanceMaxDays','amuAutoReviewTrustA','amuSettingsHint','saveAmuSettingsButton']) add(id,amuCard);
  const elements = new Proxy(controls, { get(target, name) { return target[name] || (typeof name === 'string' ? add(name) : undefined); } });
  const guard = create(root), state = { portalStatus: { portalEnabled: true }, portalSession: { authenticated: true,
    user: { employeeNumber: 'A', sessionKind: 'employee', isEmployee: true, role: 'developer', permissions: ['settings:write', 'branding:write', 'schedule:write', 'schedule:cross_location:settings:write'], scopes: [] } },
    locationId: '18', departmentId: '', schedulePdfDesignSelection: ['classic'], schedulePdfDesignNames: {classic:'Klassisch'}, scheduleDutyColorDraft:{FL:'#010203'}, data:{settings:{}}, brandingFormDirty: true, scheduleDutyColorsDirty: true,
    allowPastWeekEditing: false, birthdayPresentationSettingsSavingContext: null };
  let handler = async route => { throw new Error('Unexpected request: ' + route); }, tab = 'general';
  const document = { getElementById: id => nodes.get(id) || null, querySelectorAll: selector => root.querySelectorAll(selector), querySelector(selector) {
    if (selector === '[data-settings-tab].active') return { dataset: { settingsTab: tab } };
    if (selector.startsWith('#')) return nodes.get(selector.slice(1)) || add(selector.slice(1));
    throw new Error('Unexpected selector: ' + selector);
  } };
  const invoke = (route, options = {}) => { const call = { route, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined }; calls.push(call); return handler(route, call); };
  const context = { state, elements, document, settingsDraftGuard: guard, api: invoke, GpSaveStatus,
    settingsSaveStatuses: new Map(), settingsSaveStatusHosts: new Map(), settingsSaveActor: null, settingsSavePrimary: null, settingsSaveCandidateSource: null, settingsSaveEpoch: 0, settingsSavePrimaryEpoch: 0, settingsConfirmedDraft: null, settingsConfirmedRevision: 0,
    showToast: (...args) => toasts.push(args), schedulePdfSettingsWritePermission: 'schedule:pdf:settings:write',
    schedulePdfDesignNamesForSave: () => ({ classic: 'Klassisch' }), canManageScheduleDutyColors: () => true,
    saveAppFontScalePercent: value => invoke('font', { body: JSON.stringify({ value }) }),
    saveCustomManagementBranding: () => invoke('branding'), saveScheduleDutyColors: () => invoke('duty'), loadAll: () => invoke('loadAll'),
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;') };
  vm.createContext(context);
  for (const name of ['settingsPdfDraftScope','syncSettingsSaveScopes','settingsSaveKey','settingsSaveAllowed','settingsSaveStatus','settingsWriteGuard','settingsSaveRemaining','rememberSettingsConfirmation','settingsConfirmationReadToken','acknowledgeSettingsRead','restoreSettingsConfirmation','restoreSettingsFormDrafts','trackSettingsSaveDraft','settingsBrandingInput','scheduleDutyDraftSignature','loadAmuSettings','saveAmuSettings','isLocalStartDashboardWorkspace', 'startDashboardWorkspaceActorKey', 'greetingTemplateLines', 'renderGreetingSettings',
    'loadGreetingSettings', 'saveGreetingSettings', 'birthdayPresentationCatalog', 'renderBirthdayPresentationCatalog', 'birthdayPresentationOptions',
    'filterBirthdayPresentationEmployees', 'birthdayPresentationChanges', 'updateBirthdayPresentationSettingsState', 'renderBirthdayPresentationSettings',
    'loadBirthdayPresentationSettings', 'saveBirthdayPresentationSettings', 'saveBirthdayPresentationDeveloperPreview', 'saveSettings']) vm.runInContext(sourceFunction(name), context);
  root.addEventListener('input', context.trackSettingsSaveDraft);
  context.syncSettingsSaveScopes();
  function edit(id, value) { const node = nodes.get(id) || elements[id]; assert.ok(node, id); if (node.type === 'checkbox') node.checked = value; else node.value = value;
    for (const listener of listeners.input || []) listener({ target: node }); return node; }
  return { context, state, elements, guard, calls, toasts, nodes, edit,
    respond(fn) { handler = fn; }, setTab(value) { tab = value; },
    changeActor() { state.portalSession.user = { ...state.portalSession.user, employeeNumber: 'B' }; context.syncSettingsSaveScopes(); guard.clear(); state.birthdayPresentationSettingsSavingContext = null; } };
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

test('main save acknowledges completed stages even if a following write fails and captures later stage inputs before awaiting',async()=>{
 const f=fixture(),first=deferred();f.elements.appFontScalePercent.value='100';f.elements.brandingCompanyName.value='Gesendet';f.edit('pdfTitleSetting','Gesendet');f.edit('appFontScalePercent','100');
 f.respond(route=>route==='/api/settings'?first.promise:route==='/api/portal/v1/ui-preferences'?Promise.reject(Error('Zweite Stufe fehlgeschlagen')):Promise.resolve({}));
 const saving=f.context.saveSettings();f.edit('appFontScalePercent','110');first.resolve({});assert.equal(await saving,false);
 assert.equal(f.guard.snapshot().has('pdfTitleSetting'),false);assert.equal(f.guard.snapshot().get('appFontScalePercent'),'110');assert.equal(f.context.settingsSaveStatuses.get('main').state.state,'error');assert.equal(f.calls.length,2);
 const good=fixture(),pending=deferred();good.elements.appFontScalePercent.value='100';good.respond(route=>route==='/api/settings'?pending.promise:Promise.resolve({}));
 const work=good.context.saveSettings();good.edit('appFontScalePercent','115');pending.resolve({});assert.equal(await work,true);assert.equal(good.calls.find(call=>call.route==='font').body.value,100);assert.equal(good.context.settingsSaveStatuses.get('main').state.state,'changed');
});

test('main business-scope change removes old plan drafts, retains company/greeting drafts and rejects equal-valued new-source acknowledgement',async()=>{
 const f=fixture(),wait=deferred();f.context.renderGreetingSettings(greeting());f.edit('greetingMorningTemplates','Firma');f.edit('pdfTitleSetting','Gleicher Titel');f.edit('brandingCompanyName','Unternehmen');
 f.respond(()=>wait.promise);const saving=f.context.saveSettings(true);f.state.locationId='19';f.context.syncSettingsSaveScopes();
 assert.equal(f.guard.snapshot().has('pdfTitleSetting'),false);assert.equal(f.guard.snapshot().get('brandingCompanyName'),'Unternehmen');assert.equal(f.guard.snapshot().get('greetingMorningTemplates'),'Firma');
 f.edit('pdfTitleSetting','Gleicher Titel');wait.resolve({});assert.equal(await saving,false);assert.equal(f.guard.snapshot().get('pdfTitleSetting'),'Gleicher Titel');assert.equal(f.calls.length,1);assert.equal(f.toasts.length,0);
});

test('account ABA and permission withdrawal reject pending main completions with the same visible account and source',async()=>{
 for(const mutate of [f=>{const user=f.state.portalSession.user;f.changeActor();f.state.portalSession.user=user;f.context.syncSettingsSaveScopes();},f=>{f.state.portalSession.user.permissions=[];f.context.syncSettingsSaveScopes();}]){
  const f=fixture(),wait=deferred();f.edit('pdfTitleSetting','A');f.respond(()=>wait.promise);const work=f.context.saveSettings(true);mutate(f);wait.resolve({});assert.equal(await work,false);assert.equal(f.calls.length,1);assert.equal(f.toasts.length,0);
 }
});

function installActualNested(f){
 const c=f.context,storage=new Map();c.APP_FONT_SCALE_DEFAULT=100;c.APP_FONT_SCALE_MIN=75;c.APP_FONT_SCALE_MAX=150;c.APP_FONT_SCALE_STEP=5;c.LEGACY_DASHBOARD_FONT_SCALE={compact:85,standard:100,large:115};
 c.localStorage={setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};c.appFontScaleStorageKey=()=> 'font:'+f.state.portalSession.user.employeeNumber;c.legacyDashboardFontSizeStorageKey=()=> 'legacy:'+f.state.portalSession.user.employeeNumber;
 c.applyAppFontScalePercent=value=>{f.state.appFontScalePercent=value;f.elements.appFontScalePercent.value=String(value);};c.updateManagementBrandingPreference=result=>{f.state.brandingPreference=result;};c.applyBranding=value=>{f.state.brandingPreview=clone(value);};
 c.window={GPScheduleDuty:require('../public/schedule-duty')};c.renderScheduleDutyColorSettings=()=>{f.state.scheduleDutyColorsDirty=false;};c.renderTimeline=()=>{};
 for(const name of ['normalizeAppFontScalePercent','saveAppFontScalePercent','saveCustomManagementBranding','saveScheduleDutyColors'])vm.runInContext(sourceFunction(name),c);
 return storage;
}

test('real nested font/branding/duty helpers reject old actor responses before state or storage mutation',async()=>{
 for(const kind of ['font','branding','duty'])for(const reject of [false,true]){
  const f=fixture(),wait=deferred(),storage=installActualNested(f);f.elements.appFontScalePercent.value='100';f.state.persistedAppFontScalePercent=95;f.state.scheduleDutyColorDraft={FL:'#010203',HW:'#040506',FO:'#070809',AG:'#101112'};
  f.respond(()=>wait.promise);const saving=kind==='font'?f.context.saveAppFontScalePercent(100):kind==='branding'?f.context.saveCustomManagementBranding():f.context.saveScheduleDutyColors();
  f.changeActor();f.state.appFontScalePercent=120;const before=clone(f.state);if(reject)wait.reject(Error('Alt'));else wait.resolve({appFontScalePercent:100,colors:{FL:'#010203',HW:'#040506',FO:'#070809',AG:'#101112'},branding:{companyName:'Alt'}});
  assert.equal(await saving,false);assert.deepEqual(clone(f.state),before);assert.equal(storage.size,0);assert.equal(f.toasts.length,0);
 }
});

test('real nested helpers preserve later field values and global preview after confirmed submission',async()=>{
 const f=fixture(),wait=deferred(),storage=installActualNested(f);f.elements.appFontScalePercent.value='100';f.state.persistedAppFontScalePercent=95;f.respond(()=>wait.promise);
 const saving=f.context.saveAppFontScalePercent(100);f.edit('appFontScalePercent','115');f.state.appFontScalePercent=115;wait.resolve({appFontScalePercent:100});assert.equal(await saving,true);assert.equal(f.elements.appFontScalePercent.value,'115');assert.equal(f.state.appFontScalePercent,115);assert.equal(storage.get('font:A'),'100');
 const b=fixture(),bw=deferred();installActualNested(b);b.elements.brandingCompanyName.value='Gesendet';b.respond(()=>bw.promise);const work=b.context.saveCustomManagementBranding();b.edit('brandingCompanyName','Später');bw.resolve({branding:{companyName:'Gesendet'}});assert.equal(await work,true);assert.equal(b.state.brandingFormDirty,true);assert.equal(b.state.brandingPreview.companyName,'Später');
 const d=fixture(),dw=deferred();installActualNested(d);d.state.scheduleDutyColorDraft={FL:'#010203',HW:'#040506',FO:'#070809',AG:'#101112'};d.respond(()=>dw.promise);const colors=clone(d.state.scheduleDutyColorDraft),ds=d.context.saveScheduleDutyColors();d.state.scheduleDutyColorDraft.FL='#999999';dw.resolve({colors});assert.equal(await ds,true);assert.equal(d.state.scheduleDutyColorDraft.FL,'#999999');assert.equal(d.state.scheduleDutyColorsDirty,true);assert.equal(JSON.parse(d.state.data.settings.schedule_duty_colors).FL,'#010203');
});

function candidateFixture(){
 const f=fixture(),c=f.context;c.canReadCandidatePreboarding=()=>true;f.state.personnelCandidateCapabilities={canReadCandidates:true};f.state.selectedPersonnelCandidateId='candidate-1';
 const defaults=app.slice(app.indexOf('const CANDIDATE_EVALUATION_PDF_DEFAULTS ='),app.indexOf('\nfunction normalizeCandidateEvaluationPdfPreferences'));
 vm.runInContext(defaults+'\n'+sourceFunction('normalizeCandidateEvaluationPdfPreferences')+'\n'+sourceFunction('candidateEvaluationPdfPreferencesFromForm')+'\n'+sourceFunction('saveCandidateEvaluationPdfPreferences'),c);
 const fields={};for(const [name,value] of Object.entries(c.normalizeCandidateEvaluationPdfPreferences()))fields[name]={value:String(value),checked:value===true};['colorRed','colorGreen','colorBlue'].forEach((name,index)=>fields[name]={value:String([35,95,77][index])});
 const button={disabled:false,textContent:'Exportoptionen speichern'},statusNode=f.elements.candidateStatus;const form={isConnected:true,dataset:{candidateId:'candidate-1',applicationId:'application-1'},elements:{namedItem:name=>fields[name]},querySelector:selector=>selector==='button[type="submit"]'?button:selector==='[data-candidate-pdf-save-status]'?statusNode:null};
 f.state.candidateEvaluationPdfPreferences=c.normalizeCandidateEvaluationPdfPreferences();return{...f,form,fields,button};
}

test('personal Candidate PDF defaults acknowledge normalized submitted values without rerendering a later form draft',async()=>{
 const f=candidateFixture(),wait=deferred();f.fields.filenameTemplate.value='Gesendete   Vorlage {Name}';f.respond(()=>wait.promise);const saving=f.context.saveCandidateEvaluationPdfPreferences(f.form);await f.context.saveCandidateEvaluationPdfPreferences(f.form);assert.equal(f.calls.length,1);
 f.fields.filenameTemplate.value='Neuere Vorlage {Name}';wait.resolve({candidateEvaluationPdfPreferences:f.calls[0].body.candidateEvaluationPdfPreferences});assert.equal(await saving,true);assert.equal(f.fields.filenameTemplate.value,'Neuere Vorlage {Name}');assert.equal(f.state.candidateEvaluationPdfPreferences.filenameTemplate,'Gesendete Vorlage {Name}');assert.equal(f.button.disabled,false);
 assert.equal(f.context.settingsSaveStatuses.get('candidate-pdf:candidate-1:application-1').state.state,'changed');assert.match(f.toasts.at(-1)[0],/Neuere Änderungen/);
});

test('personal Candidate defaults reject actor, rights, candidate and detached-form stale responses or errors',async()=>{
 for(const change of ['actor','rights','candidate','detached'])for(const reject of [false,true]){
  const f=candidateFixture(),wait=deferred();f.respond(()=>wait.promise);const saving=f.context.saveCandidateEvaluationPdfPreferences(f.form);const before=clone(f.state.candidateEvaluationPdfPreferences);
  if(change==='actor')f.changeActor();if(change==='rights'){f.state.personnelCandidateCapabilities.canReadCandidates=false;f.context.syncSettingsSaveScopes();}if(change==='candidate'){f.state.selectedPersonnelCandidateId='candidate-2';f.context.syncSettingsSaveScopes();}if(change==='detached')f.form.isConnected=false;
  if(reject)wait.reject(Error('Alter Fehler'));else wait.resolve({candidateEvaluationPdfPreferences:{filenameTemplate:'Alte Rückgabe'}});
  assert.equal(await saving,false);assert.deepEqual(clone(f.state.candidateEvaluationPdfPreferences),before);assert.equal(f.toasts.length,0);assert.equal(f.state.candidateEvaluationPdfPreferencesSaving,false);
 }
});

test('confirmed partial snapshots survive the real settings renderer until same-scope reads begun after acknowledgement',async()=>{
 const f=fixture(),first=deferred();f.state.brandingFormDirty=false;f.state.scheduleDutyColorsDirty=false;f.state.appFontScalePercent=100;f.edit('pdfTitleSetting','Bestätigt');f.edit('vacationPdfTitleSetting','Urlaub bestätigt');
 const oldRead=f.context.settingsConfirmationReadToken();f.respond(route=>route==='/api/settings'?first.promise:Promise.reject(Error('Teilfehler')));const work=f.context.saveSettings(true);first.resolve({});assert.equal(await work,false);
 assert.equal(f.guard.snapshot().has('pdfTitleSetting'),false);assert.equal(f.context.settingsConfirmedDraft.values.get('pdfTitleSetting'),'Bestätigt');
 const c=f.context;c.applyShellBranding=()=>({companyName:'Server',adminEmail:'',logoUrl:'',iconUrl:'',logoAlt:''});c.hasManagementBrandingAccess=()=>true;c.renderBrandingKits=()=>{};
 c.schedulePdfDesignIdsFromSettings=()=>['classic'];c.schedulePdfDesignCatalog=()=>[{id:'classic',label:'Alt'}];c.renderSchedulePdfDesignSettings=()=>{};c.renderScheduleDutyColorSettings=()=>{};
 for(const name of ['updateWeekLockSettings','updateBranchSupervisionSettings','renderPortalAccessState','renderMaintenanceSchedules','updatePdfPreview'])c[name]=()=>{};
 c.applyAppFontScalePercent=()=>{};c.localStorage={setItem(){}};c.rememberContextCacheKey=kind=>kind;c.applyBranding=()=>{};vm.runInContext(sourceFunction('renderSettings'),c);
 f.state.data.settings={pdf_title:'Alter Cache',vacation_pdf_title:'Alter Urlaub',branch_supervision_mode:'primary',branch_supervision_intensity:'standard'};c.renderSettings();assert.equal(f.elements.pdfTitleSetting.value,'Bestätigt');assert.equal(f.elements.vacationPdfTitleSetting.value,'Urlaub bestätigt');
 f.edit('pdfTitleSetting','Neuer Entwurf');assert.equal(c.acknowledgeSettingsRead(oldRead,{schedule:true,vacation:true}),false);c.renderSettings();assert.equal(f.elements.pdfTitleSetting.value,'Neuer Entwurf');assert.equal(f.elements.vacationPdfTitleSetting.value,'Urlaub bestätigt');
 const fresh=c.settingsConfirmationReadToken();f.state.data.settings.pdf_title='Bestätigt';c.acknowledgeSettingsRead(fresh,{schedule:true});c.renderSettings();assert.equal(f.elements.pdfTitleSetting.value,'Neuer Entwurf');assert.equal(f.elements.vacationPdfTitleSetting.value,'Urlaub bestätigt');
 assert.equal(c.settingsConfirmedDraft.values.has('pdfTitleSetting'),false);assert.equal(c.settingsConfirmedDraft.values.has('vacationPdfTitleSetting'),true);
 f.state.vacationData={settings:{vacation_pdf_title:'Urlaub bestätigt'}};assert.equal(c.acknowledgeSettingsRead(fresh,{vacation:true}),true);assert.equal(c.settingsConfirmedDraft,null);
});

test('confirmed settings overlay clears on actor or primary-scope withdrawal and rejects old read epochs even after returning',()=>{
 const f=fixture();f.edit('pdfTitleSetting','A');f.context.rememberSettingsConfirmation(f.guard.snapshot(),['pdfTitleSetting']);const old=f.context.settingsConfirmationReadToken();
 f.state.locationId='19';f.context.syncSettingsSaveScopes();assert.equal(f.context.settingsConfirmedDraft,null);f.state.locationId='18';f.context.syncSettingsSaveScopes();f.edit('pdfTitleSetting','B');f.context.rememberSettingsConfirmation(f.guard.snapshot(),['pdfTitleSetting']);
 assert.equal(f.context.acknowledgeSettingsRead(old,{schedule:true}),false);assert.equal(f.context.settingsConfirmedDraft.values.get('pdfTitleSetting'),'B');f.changeActor();assert.equal(f.context.settingsConfirmedDraft,null);
});

test('a detached Candidate form releases the matching connected replacement and permits an explicit retry with its own draft',async()=>{
 const f=candidateFixture(),wait=deferred();f.respond(()=>wait.promise);const work=f.context.saveCandidateEvaluationPdfPreferences(f.form);const old=f.form;
 const button={disabled:true,textContent:'Speichert …'},replacement={...old,querySelector:selector=>selector==='button[type="submit"]'?button:old.querySelector(selector)};
 f.context.document.querySelectorAll=selector=>selector==='[data-personnel-candidate-pdf-options-form]'?[replacement]:[];old.isConnected=false;
 assert.equal(await f.context.saveCandidateEvaluationPdfPreferences(replacement),false);assert.equal(f.calls.length,1,'A replacement form cannot send a concurrent PUT');
 f.fields.filenameTemplate.value='Ersatzformular {Name}';const status=f.context.settingsSaveStatuses.get('candidate-pdf:candidate-1:application-1');status.changed();wait.resolve({candidateEvaluationPdfPreferences:{filenameTemplate:'Alte Antwort'}});
 assert.equal(await work,false);assert.equal(button.disabled,false);assert.equal(status.state.busy,false);assert.equal(status.state.state,'changed');assert.equal(f.toasts.length,0);assert.equal(f.fields.filenameTemplate.value,'Ersatzformular {Name}');
 f.respond((_route,call)=>Promise.resolve({candidateEvaluationPdfPreferences:call.body.candidateEvaluationPdfPreferences}));assert.equal(await f.context.saveCandidateEvaluationPdfPreferences(replacement),true);
 assert.equal(f.state.candidateEvaluationPdfPreferences.filenameTemplate,'Ersatzformular {Name}');assert.equal(button.disabled,false);assert.equal(status.state.state,'saved');assert.equal(f.calls.length,2);
});

test('confirmed dependent settings restore parent/mode/children in order while revoked write rights keep all controls disabled',async()=>{
 const f=fixture(),c=f.context;c.applyShellBranding=()=>({companyName:'Server',adminEmail:'',logoUrl:'',iconUrl:'',logoAlt:''});c.hasManagementBrandingAccess=()=>true;c.renderBrandingKits=()=>{};c.schedulePdfDesignIdsFromSettings=()=>['classic'];c.schedulePdfDesignCatalog=()=>[{id:'classic',label:'Alt'}];c.renderSchedulePdfDesignSettings=()=>{};c.renderScheduleDutyColorSettings=()=>{};
 for(const name of ['renderPortalAccessState','renderMaintenanceSchedules','updatePdfPreview'])c[name]=()=>{};c.applyAppFontScalePercent=()=>{};c.localStorage={setItem(){}};c.rememberContextCacheKey=kind=>kind;c.applyBranding=()=>{};c.planningDayKeys=['friday'];c.fixedDayLabels={friday:'Freitag'};c.branchSupervisionIntensityPresets={standard:{primaryCoveragePercent:60,departmentGapMinutes:180}};
 for(const name of ['updateWeekLockSettings','updateBranchSupervisionSettings','renderSettings'])vm.runInContext(sourceFunction(name),c);
 f.state.data.settings={pdf_title:'Alt',current_week_auto_lock:'0',current_week_lock_mode:'closing',current_week_lock_day:'saturday',current_week_lock_time:'17:00',branch_supervision_mode:'off',branch_supervision_intensity:'standard'};f.state.appFontScalePercent=100;f.state.brandingFormDirty=false;f.state.scheduleDutyColorsDirty=false;c.renderSettings();
 f.edit('currentWeekAutoLock',true);f.edit('branchSupervisionMode','red');c.updateWeekLockSettings();c.updateBranchSupervisionSettings();f.edit('currentWeekLockMode','manual');f.edit('currentWeekLockDay','friday');f.edit('branchSupervisionIntensity','custom');c.updateWeekLockSettings();c.updateBranchSupervisionSettings();f.edit('currentWeekLockTime','19:00');f.edit('branchSupervisionPrimaryCoveragePercent','73');f.edit('branchSupervisionDepartmentGapMinutes','80');
 f.respond(route=>route==='/api/settings'?Promise.resolve({}):Promise.reject(Error('Folgestufe')));assert.equal(await c.saveSettings(true),false);assert.equal(f.guard.snapshot().size,0);c.renderSettings();
 assert.equal(f.elements.currentWeekAutoLock.checked,true);assert.equal(f.elements.currentWeekLockMode.value,'manual');assert.equal(f.elements.currentWeekLockMode.disabled,false);assert.equal(f.elements.manualWeekLockFields.classList.contains('hidden'),false);assert.equal(f.elements.currentWeekLockTime.value,'19:00');assert.equal(f.elements.currentWeekLockTime.min,'18:00');
 assert.equal(f.elements.branchSupervisionMode.value,'red');assert.equal(f.elements.branchSupervisionIntensity.value,'custom');assert.equal(f.elements.branchSupervisionPrimaryCoveragePercent.value,'73');assert.equal(f.elements.branchSupervisionDepartmentGapMinutes.value,'80');assert.equal(f.elements.branchSupervisionPrimaryCoveragePercent.disabled,false);assert.match(f.elements.branchSupervisionSettingsHint.textContent,/roter Hinweis/);
 f.state.portalSession.user.permissions=[];c.syncSettingsSaveScopes();c.renderSettings();assert.equal(f.elements.currentWeekAutoLock.disabled,true);assert.equal(f.elements.currentWeekLockMode.disabled,true);assert.equal(f.elements.branchSupervisionMode.disabled,true);assert.equal(f.elements.branchSupervisionPrimaryCoveragePercent.disabled,true);assert.equal(c.settingsConfirmedDraft,null);
});

test('settled Candidate global lock releases all connected applications of that candidate and leaves foreign forms untouched',async()=>{
 const f=candidateFixture(),wait=deferred();f.respond(()=>wait.promise);const work=f.context.saveCandidateEvaluationPdfPreferences(f.form);
 const a={disabled:true,textContent:'Speichert …'},b={disabled:true,textContent:'Speichert …'},foreign={disabled:true,textContent:'Speichert …'};
 const make=(candidateId,applicationId,button)=>({...f.form,dataset:{candidateId,applicationId},querySelector:selector=>selector==='button[type="submit"]'?button:null});
 const replacementA=make('candidate-1','application-1',a),replacementB=make('candidate-1','application-2',b),other=make('candidate-2','application-3',foreign);f.context.document.querySelectorAll=()=>[replacementA,replacementB,other];f.form.isConnected=false;
 assert.equal(await f.context.saveCandidateEvaluationPdfPreferences(replacementB),false);assert.equal(f.calls.length,1);wait.resolve({});assert.equal(await work,false);
 assert.equal(a.disabled,false);assert.equal(b.disabled,false);assert.equal(foreign.disabled,true);assert.equal(f.toasts.length,0);assert.equal(f.state.candidateEvaluationPdfPreferencesSaving,false);
});
