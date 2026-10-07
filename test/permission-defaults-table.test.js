'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'permission-defaults.js'), 'utf8');

const clone = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture() {
  return {
    catalog: [
      { id: 'screen:open', label: 'Bereich öffnen', group: 'Verkauf', description: 'Nur freigegebene Ansicht' },
      { id: 'article:read', label: 'Artikel lesen', group: 'Verkauf', description: 'Artikeldaten lesen' },
      { id: 'article:write', label: 'Artikel bearbeiten', group: 'Verkauf', description: 'Artikeldaten ändern' },
      { id: 'own:read', label: 'Eigene Planung lesen', group: 'Personal', description: 'Eigene Daten' },
    ],
    entries: [
      { kind: 'role', id: 'employee', name: 'Mitarbeiter', revision: 3, permissions: ['own:read'], builtinPermissions: ['own:read'], affected: 4 },
      { kind: 'role', id: 'manager', name: 'Filialleitung', revision: 8, permissions: ['own:read', 'screen:open', 'article:read'], builtinPermissions: ['own:read', 'screen:open', 'article:read'], affected: 2 },
      { kind: 'role', id: 'developer', name: 'Developer', revision: 5, permissions: ['screen:open', 'article:read', 'article:write', 'own:read'], builtinPermissions: ['screen:open', 'article:read', 'article:write', 'own:read'], protected: true, affected: 1 },
      { kind: 'position', id: 'sales', name: 'Verkauf', revision: 0, permissions: null, affected: 4 },
    ],
  };
}

function harness({ apiHandler, payload = fixture() } = {}) {
  const ids = new Map(), calls = [], toasts = [], tables = [];
  const document = { activeElement: null, getElementById: id => ids.get(id), createElement: tag => new Element(tag) };
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = []; this.listeners = new Map();
      this.value = ''; this.checked = false; this.disabled = false; this.textContent = ''; this.dataset = {};
      this.attributes = new Map(); this.classes = new Set();
      this.classList = {
        toggle: (name, enabled = !this.classes.has(name)) => enabled ? this.classes.add(name) : this.classes.delete(name),
        add: name => this.classes.add(name), contains: name => this.classes.has(name),
      };
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = [...children]; if (this.tagName === 'SELECT' && !children.length) this.value = ''; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener(name, callback) { const listeners = this.listeners.get(name) || []; listeners.push(callback); this.listeners.set(name, listeners); }
    matches(selector) { return selector === 'input[type="checkbox"]' && this.tagName === 'INPUT' && this.type === 'checkbox'; }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]).filter(child => selector === 'input' ? child.tagName === 'INPUT' : child.matches(selector));
    }
    async fire(type) { for (const callback of this.listeners.get(type) || []) await callback({ target: this }); }
    focus() { document.activeElement = this; }
  }
  for (const id of ['permissionDefaultsCard', 'permissionDefaultsTarget', 'permissionDefaultsPermissions', 'permissionDefaultsHint',
    'permissionDefaultsInheritance', 'permissionDefaultsInheritanceRow', 'permissionDefaultsSave', 'permissionDefaultsReset', 'permissionDefaultsSearch']) {
    const tag = id === 'permissionDefaultsTarget' ? 'select' : id.includes('Save') || id.includes('Reset') ? 'button' : 'div';
    ids.set(id, new Element(tag));
  }
  let actor = 'account-A:developer', identity = 'account-A', permitted = true, refreshCount = 0;
  const window = {
    RightsSettingsTable: {
      mount(options) {
        const table = { options, rows: [], visibleIds: null, query: '', destroyed: false,
          setRows(rows) {
            this.rows = rows;
            const displayed = rows.filter(row => (!this.visibleIds || this.visibleIds.includes(row.id))
              && (!this.query || options.searchText(row).includes(this.query)));
            options.host.replaceChildren(...displayed.map(row => options.columns[0].cell(row, document)));
          },
          refresh() { this.setRows(this.rows); },
          destroy() { this.destroyed = true; this.rows = []; options.host.replaceChildren(); },
        };
        tables.push(table); return table;
      },
    },
  };
  const api = async (route, options = {}) => {
    calls.push({ route, options });
    if (apiHandler) return apiHandler(route, options, calls);
    if (options.method === 'PUT') {
      const result = clone(payload), [, kind, id] = route.match(/defaults\/(role|position)\/([^/]+)$/);
      const body = JSON.parse(options.body), entry = result.entries.find(value => value.kind === kind && value.id === id);
      entry.permissions = body.reset ? kind === 'position' ? null : entry.builtinPermissions : body.permissions;
      entry.revision += 1; result.affected = entry.affected; return result;
    }
    return clone(payload);
  };
  const context = vm.createContext({ document, window, AbortController });
  vm.runInContext(source, context);
  const controller = context.initializePermissionDefaults({ api, toast: (...args) => toasts.push(args),
    dependencyRules: [{ permissionId: 'article:write', requiredPermissionId: 'article:read' }, { permissionId: 'article:read', requiredPermissionId: 'screen:open' }],
    identity: () => identity, actorKey: () => actor, canUse: () => permitted, refreshRights: async () => { refreshCount += 1; },
  });
  const element = id => ids.get('permissionDefaults' + id);
  const box = id => element('Permissions').querySelectorAll('input').find(input => input.value === id);
  return { controller, calls, toasts, tables, document, element, box,
    async select(value) { element('Target').value = value; await element('Target').fire('change'); },
    async change(id, checked) { const input = box(id); assert.ok(input, id); input.checked = checked; await input.fire('change'); },
    actor(value) { actor = value; identity = value.split(':')[0]; },
    permit(value) { permitted = value; },
    get refreshCount() { return refreshCount; },
  };
}

test('catalog table keeps the permission model when search and displayed columns omit rows', async () => {
  const env = harness(); await env.controller.load(true);
  assert.equal(env.tables[0].options.tableId, 'rights:defaults:catalog');
  assert.equal(env.tables[0].options.columns.find(column => column.id === 'id').visible, false);
  env.tables[0].visibleIds = ['article:write']; env.tables[0].refresh();
  await env.change('article:write', true);
  assert.deepEqual(env.tables[0].rows.map(row => row.id), fixture().catalog.map(row => row.id));
  await env.element('Save').fire('click');
  const put = env.calls.find(call => call.options.method === 'PUT');
  assert.deepEqual(JSON.parse(put.options.body), { revision: 3, permissions: ['own:read', 'article:write', 'article:read', 'screen:open'], reset: false });
  assert.equal(env.refreshCount, 1); assert.equal(env.element('Save').disabled, true);
});

test('unchecking a prerequisite removes dependent rights even if its row is hidden', async () => {
  const env = harness(); await env.controller.load(true); await env.change('article:write', true);
  env.tables[0].visibleIds = ['screen:open']; env.tables[0].refresh(); await env.change('screen:open', false);
  await env.element('Save').fire('click');
  assert.deepEqual(JSON.parse(env.calls.find(call => call.options.method === 'PUT').options.body).permissions, ['own:read']);
});

test('role and position drafts survive switching targets and a repeated load', async () => {
  const env = harness(); await env.controller.load(true); await env.change('article:read', true);
  await env.select('role:manager'); await env.change('own:read', false);
  await env.select('role:employee'); assert.equal(env.box('article:read').checked, true);
  await env.controller.load(true); assert.equal(env.box('article:read').checked, true); assert.equal(env.element('Save').disabled, false);
  await env.select('role:manager'); assert.equal(env.box('own:read').checked, false);
});

test('the protected Developer and inherited position remain locked', async () => {
  const env = harness(); await env.controller.load(true); await env.select('role:developer');
  assert.ok(env.element('Permissions').querySelectorAll('input').every(input => input.disabled));
  await env.change('article:write', false); await env.element('Reset').fire('click'); await env.element('Save').fire('click');
  assert.equal(env.calls.filter(call => call.options.method === 'PUT').length, 0);
  assert.match(env.element('Hint').textContent, /garantierten Vollzugriff/);
  await env.select('position:sales'); assert.equal(env.element('Inheritance').checked, true);
  assert.ok(env.element('Permissions').querySelectorAll('input').every(input => input.disabled));
  await env.change('article:read', true); assert.equal(env.element('Save').disabled, true);
  env.element('Inheritance').checked = false; await env.element('Inheritance').fire('change');
  assert.ok(env.element('Permissions').querySelectorAll('input').every(input => !input.disabled));
  await env.change('article:read', true); await env.element('Save').fire('click');
  assert.deepEqual(JSON.parse(env.calls.find(call => call.options.method === 'PUT').options.body), { revision: 0, permissions: ['article:read', 'screen:open'], reset: false });
});

test('role reset and position inheritance keep the existing endpoint and body contract', async () => {
  const env = harness(); await env.controller.load(true); await env.change('article:read', true);
  await env.element('Reset').fire('click'); await env.element('Save').fire('click');
  const role = env.calls.find(call => call.options.method === 'PUT');
  assert.equal(role.route, '/api/portal/v1/rights/defaults/role/employee');
  assert.deepEqual(JSON.parse(role.options.body), { revision: 3, permissions: ['own:read'], reset: true });
  await env.select('position:sales'); await env.element('Reset').fire('click'); await env.element('Save').fire('click');
  const position = env.calls.filter(call => call.options.method === 'PUT')[1];
  assert.equal(position.route, '/api/portal/v1/rights/defaults/position/sales');
  assert.deepEqual(JSON.parse(position.options.body), { revision: 0, permissions: [], reset: true });
});

test('saving is single flight and disables controls while retaining a failed draft for retry', async () => {
  const write = deferred(); let writeCount = 0;
  const env = harness({ apiHandler: (route, options) => options.method === 'PUT' ? (++writeCount, write.promise) : clone(fixture()) });
  await env.controller.load(true); await env.change('article:write', true);
  const pending = env.element('Save').fire('click');
  assert.equal(env.element('Target').disabled, true); assert.ok(env.element('Permissions').querySelectorAll('input').every(input => input.disabled));
  await env.element('Save').fire('click'); await env.controller.load(true); assert.equal(writeCount, 1);
  assert.equal(env.calls.filter(call => call.options.method !== 'PUT').length, 1);
  write.reject(new Error('Synthetic write failure')); await pending;
  assert.equal(env.element('Save').disabled, false); assert.equal(env.box('article:write').checked, true);
  assert.equal(env.element('Target').disabled, false); assert.deepEqual(env.toasts.at(-1), ['Synthetic write failure', true]);
});

test('stale reads do not replace newer actor or newer request results', async () => {
  const first = deferred(), second = deferred(); let read = 0;
  const env = harness({ apiHandler: () => ++read === 1 ? first.promise : second.promise });
  const old = env.controller.load(true), fresh = env.controller.load(true);
  second.resolve(clone(fixture())); await fresh;
  const oldPayload = clone(fixture()); oldPayload.catalog[0].label = 'Stale'; first.resolve(oldPayload); await old;
  assert.equal(env.tables[0].rows[0].label, 'Bereich öffnen');
  assert.equal(env.calls[0].options.signal.aborted, true);
});

test('actor change purges draft/search and an old save cannot unlock or rewrite the new actor', async () => {
  const oldWrite = deferred(), newWrite = deferred(); let writes = 0;
  const env = harness({ apiHandler: (route, options) => options.method === 'PUT' ? ++writes === 1 ? oldWrite.promise : newWrite.promise : clone(fixture()) });
  await env.controller.load(true); await env.change('article:write', true); env.element('Search').value = 'private query';
  const old = env.element('Save').fire('click'); env.actor('account-B:developer'); await env.controller.load(true);
  assert.equal(env.tables[0].destroyed, true); assert.equal(env.element('Search').value, ''); assert.equal(env.box('article:write').checked, false);
  assert.equal(env.tables.at(-1).options.identity(), 'account-B');
  await env.change('article:read', true); const fresh = env.element('Save').fire('click');
  oldWrite.resolve({ ...clone(fixture()), affected: 99 }); await old;
  assert.equal(env.element('Save').disabled, true); assert.equal(env.element('Target').disabled, true);
  assert.equal(env.toasts.length, 0); assert.equal(env.refreshCount, 0);
  newWrite.resolve({ ...clone(fixture()), affected: 4 }); await fresh;
  assert.equal(env.element('Target').disabled, false); assert.equal(env.refreshCount, 1);
});

test('disabled access aborts a pending read and cannot initiate reads or writes', async () => {
  const read = deferred(); const env = harness({ apiHandler: () => read.promise });
  const pending = env.controller.load(true); env.permit(false); await env.controller.load(true);
  assert.equal(env.calls[0].options.signal.aborted, true); assert.equal(env.calls.length, 1);
  read.resolve(clone(fixture())); await pending; assert.equal(env.tables.length, 0);
  await env.element('Save').fire('click'); assert.equal(env.calls.length, 1); assert.equal(env.element('Save').disabled, true);
});

test('401 and 403 clear the catalog and draft; transient load failure retains the model for retry', async () => {
  for (const status of [401, 403, 500]) {
    let readCount = 0;
    const env = harness({ apiHandler: () => ++readCount === 1 ? clone(fixture()) : Promise.reject(Object.assign(new Error('Denied or unavailable'), { status })) });
    await env.controller.load(true); await env.change('article:read', true); await env.controller.load(true);
    assert.equal(env.element('Save').disabled, true);
    assert.equal(env.tables[0].destroyed, status !== 500);
    if (status !== 500) assert.equal(env.element('Permissions').children.length, 0);
    else assert.equal(env.box('article:read').checked, true);
  }
});

test('a permission conflict retains the draft and original revision instead of silently overwriting a fresh default', async () => {
  let reads = 0;
  const env = harness({ apiHandler: (route, options) => {
    if (options.method === 'PUT') return Promise.reject(new Error('Version conflict'));
    const result = clone(fixture()); if (++reads > 1) result.entries[0].revision = 4; return result;
  } });
  await env.controller.load(true); await env.change('article:read', true); await env.controller.load(true);
  assert.match(env.element('Hint').textContent, /Entwurf bleibt erhalten/);
  await env.element('Save').fire('click'); assert.equal(JSON.parse(env.calls.at(-1).options.body).revision, 3);
  assert.equal(env.box('article:read').checked, true);
  await env.element('Reset').fire('click'); await env.element('Save').fire('click');
  assert.equal(JSON.parse(env.calls.at(-1).options.body).revision, 4);
});

test('permission cells use textContent and retain checkbox focus across a model refresh', async () => {
  const payload = fixture(); payload.catalog[0].label = '<script>untrusted</script>';
  const env = harness({ payload }); await env.controller.load(true);
  const text = env.tables[0].options.columns.find(column => column.id === 'label').cell(payload.catalog[0], env.document);
  assert.equal(text.textContent, '<script>untrusted</script>'); assert.equal(text.children.length, 0);
  env.box('article:read').focus(); await env.change('article:read', true);
  assert.equal(env.document.activeElement, env.box('article:read'));
});
