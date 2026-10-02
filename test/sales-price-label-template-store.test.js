'use strict';

const test = require('node:test'), assert = require('node:assert/strict'), express = require('express');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fixture: persistenceFixture } = require('../test-support/trade-insights-sqlite');
const Store = require('../lib/sales-price-label-template-store');
const { registerSalesPriceLabelsRoutes } = require('../lib/sales-price-labels-routes');
const Article = require('../lib/sales-article-catalog-access'), Branch = require('../lib/branch-sales-access');
const rights = [Article.SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS, Article.SALES_ARTICLE_CATALOG_PERMISSIONS.READ, Article.SALES_ARTICLE_CATALOG_PERMISSIONS.PRICES_READ];
const employee = (number, home = '18') => ({ employeeNumber: number, accountId: 'user-' + number, sessionKind: 'employee',
  isEmployee: true, fullName: 'Synthetic ' + number, homeLocationId: home, permissions: [...rights], scopes: [], mustChangePassword: false });
const branch = (id, location) => ({ id: 'session-' + id, accountId: id, sessionKind: 'organization', accountType: 'branch',
  isEmployee: false, fullName: 'Synthetic ' + id, homeLocationId: location, permissions: [...rights, Branch.BRANCH_ARTICLES_PERMISSION],
  scopes: [{ locationId: location, departmentId: null }], mustChangePassword: false });
const account = (id, location, overrides = {}) => ({ id, active: true, account_type: 'branch', display_name: 'Synthetic ' + id,
  scopes_json: JSON.stringify([{ locationId: location, departmentId: null }]), locationActive: true, locationLabel: 'Filiale ' + location, ...overrides });
const input = extra => ({ title: 'Regal Kamera', options: { labelWidthMm: 90.5, gapMm: 3.5 },
  filenameOptions: { stamp: 'date', position: 'after', separator: '_', suffix: '' }, visibility: 'private', recipients: [], ...extra });
async function fixture(t) {
  const p = await persistenceFixture(t), store = Store.createSalesPriceLabelTemplateStore({ access: p.app.provider, vault: p.vault });
  const state = { sessions: { '42': employee('42'), '43': employee('43'), '44': employee('44', '19'),
    acc18: branch('acc18', '18'), acc19: branch('acc19', '19'), acc19b: branch('acc19b', '19'), acc20: branch('acc20', '20') },
    accounts: [account('acc18', '18'), account('acc19', '19'), account('acc19b', '19'), account('acc20', '20'),
      account('inactive', '21', { active: false }), account('wrong-kind', '22', { account_type: 'employee' }),
      account('department', '23', { scopes_json: JSON.stringify([{ locationId: '23', departmentId: 1 }]) }),
      account('inactive-location', '24', { locationActive: false })], home: { '42': '18', '43': '18', '44': '19' }, directoryCalls: 0, directoryHook: null, refreshHook: null };
  const deps = { async listBranchAccounts() { state.directoryCalls++; await state.directoryHook?.(); return state.accounts; },
    async getEmployeeHomeLocation(number) { return state.home[number] ? { id: state.home[number], label: 'Filiale ' + state.home[number], active: true } : null; } };
  const context = name => Store.resolveTemplateSessionContext(state.sessions[name], deps);
  return { p, store, state, deps, context };
}

// Native provider errors are injected through the registered PostgreSQL facade
// and its actual SQLSTATE mapper. SQLite supplies real commit/rollback storage;
// this is deterministic error-path coverage, not a live PostgreSQL test.
function postgresErrorAccess(base, { sqlState, statement, atCommit = false }) {
  const { createPersistenceProviderFacade } = require('../lib/persistence/contract');
  const { POSTGRESQL_CAPABILITIES, mapPostgresqlError } = require('../lib/persistence/postgresql/provider');
  const state = { injected: 0, error: null };
  const inject = () => {
    state.injected++; state.error = mapPostgresqlError(Object.assign(new Error('Synthetic PostgreSQL driver failure'), { code: sqlState }),
      { operation: atCommit ? 'transaction' : 'execute' }); throw state.error;
  };
  const query = async (tx, current, parameters) => {
    if (current.operation === 'queryOne') { const row = await tx.queryOne(current, parameters); return row ? [row] : []; }
    return tx.queryAll(current, parameters);
  };
  const access = createPersistenceProviderFacade({ providerId: 'postgresql', capabilities: POSTGRESQL_CAPABILITIES,
    query: (current, parameters) => query(base, current, parameters), execute: (current, parameters) => base.execute(current, parameters), close: async () => {},
    async beginTransaction(options) {
      let ready, finish, cancel, targetWritten = false;
      const opened = new Promise(resolve => { ready = resolve; }), ending = new Promise((resolve, reject) => { finish = resolve; cancel = reject; }); ending.catch(() => {});
      const done = base.transaction(async tx => { ready(tx); await ending; }, options); done.catch(() => {}); const tx = await opened;
      return { query: (current, parameters) => query(tx, current, parameters),
        async execute(current, parameters) {
          if (current === statement) { targetWritten = true; if (!atCommit) inject(); }
          return tx.execute(current, parameters);
        },
        async commit() { if (atCommit && targetWritten) inject(); finish(); await done; },
        async rollback() { cancel(new Error('Synthetic rollback')); try { await done; } catch {} },
      };
    },
  });
  return { access, state };
}

test('Native PostgreSQL serialization, deadlock and initial annotation uniqueness failures become scoped library conflicts without retry or lost writes', async t => {
  const f = await fixture(t), context = await f.context('42');
  const { A } = require('../lib/persistence/statements/trade-annotations');
  const { PersistenceError } = require('../lib/persistence/contract');
  for (const [sqlState, initial, atCommit] of [['40001', false, true], ['40P01', false, false], ['23505', true, false]]) {
    const scopeId = 'pg-library-error-' + sqlState;
    const clean = Store.createSalesPriceLabelTemplateStore({ access: f.p.app.provider, vault: f.p.vault, scopeId });
    const before = initial ? null : await clean.create(context, input({ title: 'Unchanged template ' + sqlState }));
    const injected = postgresErrorAccess(f.p.app.provider, { sqlState, statement: initial ? A.insert : A.update, atCommit });
    t.after(() => injected.access.close());
    const broken = Store.createSalesPriceLabelTemplateStore({ access: injected.access, vault: f.p.vault, scopeId });
    const operation = initial ? broken.create(context, input()) : broken.update(context, before.id, input({ version: 1, title: 'Must roll back' }));
    await assert.rejects(operation, { code: 'PRICE_LABEL_LIBRARY_CONFLICT', status: 409 });
    assert.ok(injected.state.error instanceof PersistenceError); assert.equal(injected.state.injected, 1, 'No implicit global retry');
    assert.equal(injected.state.error.code, sqlState === '23505' ? 'PERSISTENCE_UNIQUE_VIOLATION' : 'PERSISTENCE_RETRYABLE_TRANSACTION');
    if (before) assert.deepEqual(await clean.get(context, before.id), before, 'Failed write was rolled back');
    else assert.deepEqual((await clean.list(context)).templates, [], 'Initial insert failure created no library data');
  }
});

test('Non-collision native PostgreSQL errors and uniqueness failures on existing records keep their original classification', async t => {
  const f = await fixture(t), context = await f.context('42'), { A } = require('../lib/persistence/statements/trade-annotations');
  for (const [sqlState, initial, expectedCode] of [['23503', true, 'PERSISTENCE_FOREIGN_KEY_VIOLATION'], ['23505', false, 'PERSISTENCE_UNIQUE_VIOLATION']]) {
    const scopeId = 'pg-library-unrelated-' + sqlState + '-' + initial;
    const clean = Store.createSalesPriceLabelTemplateStore({ access: f.p.app.provider, vault: f.p.vault, scopeId });
    const before = initial ? null : await clean.create(context, input());
    const injected = postgresErrorAccess(f.p.app.provider, { sqlState, statement: initial ? A.insert : A.update });
    t.after(() => injected.access.close());
    const broken = Store.createSalesPriceLabelTemplateStore({ access: injected.access, vault: f.p.vault, scopeId });
    await assert.rejects(initial ? broken.create(context, input()) : broken.update(context, before.id, input({ version: 1 })), { code: expectedCode });
    assert.equal(injected.state.injected, 1);
    if (before) assert.deepEqual(await clean.get(context, before.id), before);
    else assert.equal((await clean.list(context)).templates.length, 0);
  }
});

test('Named private templates are encrypted, isolated by creator and preserve decimal print settings with per-template CAS', async t => {
  const f = await fixture(t), own = await f.context('42'), other = await f.context('43');
  const saved = await f.store.create(own, input({ title: '<script>Nur Text</script>' }));
  assert.match(saved.id, /^[a-f0-9-]{36}$/); assert.equal(saved.version, 1); assert.equal(saved.canEdit, true); assert.equal(saved.received, false);
  assert.equal(saved.options.labelWidthMm, 90.5); assert.equal(saved.options.gapMm, 3.5);
  assert.equal((await f.store.list(own)).templates.length, 1); assert.equal((await f.store.list(other)).templates.length, 0);
  await assert.rejects(f.store.get(other, saved.id), { status: 404 });
  await assert.rejects(f.store.update(own, saved.id, input({ version: 2 })), { code: 'PRICE_LABEL_LIBRARY_CONFLICT' });
  const updated = await f.store.update(own, saved.id, input({ version: 1, title: 'Neue Vorlage' }));
  assert.equal(updated.version, 2); assert.equal(updated.title, 'Neue Vorlage');
  await assert.rejects(f.store.update(own, saved.id, input({ version: 1 })), { status: 409 });
  const row = f.p.app.database.prepare("SELECT * FROM trade_annotations WHERE kind='price-label-library'").get();
  assert.equal(row.scope_id, 'grabenplaner-main:price-label-library');
  assert.doesNotMatch(JSON.stringify(row), /Neue Vorlage|Regal Kamera|employee:42|script/);
  const audits = f.p.app.database.prepare("SELECT * FROM audit_log WHERE action='trade.price-label-library.update'").all();
  assert.equal(audits.length, 2); assert.doesNotMatch(JSON.stringify(audits.map(row => row.detail)), /Neue Vorlage|script/);
  await assert.rejects(f.store.create({ owner: own.owner }, input()), { status: 403 }, 'Caller cannot forge a trusted context');
});

test('Own-branch templates are readable by normal colleagues, editable by creator or branch account, and can be revoked by creator', async t => {
  const f = await fixture(t), owner = await f.context('42'), colleague = await f.context('43'), ownAccount = await f.context('acc18');
  const saved = await f.store.create(owner, input({ visibility: 'branch' }));
  assert.equal((await f.store.get(colleague, saved.id)).canEdit, false);
  assert.equal((await f.store.get(ownAccount, saved.id)).canEdit, true);
  assert.equal((await f.store.list(await f.context('44'))).templates.length, 0);
  assert.equal((await f.store.list(await f.context('acc19'))).templates.length, 0);
  await assert.rejects(f.store.update(colleague, saved.id, input({ visibility: 'branch', version: 1 })), { status: 403 });
  const edited = await f.store.update(ownAccount, saved.id, input({ visibility: 'branch', title: 'Filialvorlage', version: 1 }));
  assert.equal(edited.version, 2); assert.equal(edited.creator.id, 'employee:42');
  await assert.rejects(f.store.update(ownAccount, saved.id, input({ visibility: 'private', version: 2 })), { status: 403 });
  const revoked = await f.store.update(owner, saved.id, input({ visibility: 'private', version: 2 }));
  assert.equal(revoked.version, 3); assert.equal((await f.store.list(ownAccount)).templates.length, 0);
  assert.equal((await f.store.list(colleague)).templates.length, 0);
  const ownBranchTemplate = await f.store.create(ownAccount, input({ visibility: 'branch' }));
  assert.equal(ownBranchTemplate.creator.id, 'account:acc18');
});

test('Concurrent named-template edits resolve to one revision without losing the winning content; defaults are account-isolated', async t => {
  const f = await fixture(t), owner = await f.context('42'), saved = await f.store.create(owner, input());
  const results = await Promise.allSettled(['Entwurf A', 'Entwurf B'].map(title => f.store.update(owner, saved.id, input({ title, version: 1 }))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'PRICE_LABEL_LIBRARY_CONFLICT');
  const current = await f.store.get(owner, saved.id); assert.equal(current.version, 2);
  assert.equal(current.title, results.find(result => result.status === 'fulfilled').value.title);
  const first = await f.context('acc18'), second = await f.context('acc19');
  const chosen = { options: { color: '#123456', labelWidthMm: 90.5 }, filenameOptions: { stamp: 'none' } };
  const persisted = await f.store.setDefault(first, chosen); assert.deepEqual(await f.store.getDefault(first), persisted);
  assert.notDeepEqual(await f.store.getDefault(second), persisted);
  assert.equal((await f.store.list(first)).templates.length, 0, 'Legacy defaults are not named templates');
  await assert.rejects(f.store.setDefault(owner, chosen), { status: 403 });
});

test('Concrete other branch accounts receive read-only shares; copies stay owned and revocation or scope changes remove original access', async t => {
  const f = await fixture(t), owner = await f.context('42'), recipient = await f.context('acc19');
  const shared = await f.store.create(owner, input({ visibility: 'selected', recipients: ['acc19', 'acc20'] }));
  const received = await f.store.get(recipient, shared.id); assert.equal(received.canEdit, false); assert.equal(received.received, true);
  assert.deepEqual(received.recipients, []);
  for (const name of ['44', 'acc19b', 'acc18']) assert.equal((await f.store.list(await f.context(name))).templates.length, 0, name);
  await assert.rejects(f.store.update(recipient, shared.id, input({ version: 1 })), { status: 403 });
  const copy = await f.store.create(recipient, input({ title: 'Eigene Kopie', options: received.options, filenameOptions: received.filenameOptions }));
  assert.equal(copy.creator.id, 'account:acc19'); assert.equal(copy.received, false); assert.equal(copy.canEdit, true);
  const moved = f.state.accounts.find(row => row.id === 'acc19'); moved.scopes_json = JSON.stringify([{ locationId: '20', departmentId: null }]);
  f.state.sessions.acc19 = branch('acc19', '20');
  assert.equal((await f.store.list(await f.context('acc19'))).templates.some(row => row.id === shared.id), false);
  const freshOwner = await f.context('42');
  const staleShare = await f.store.get(freshOwner, shared.id); assert.deepEqual(staleShare.recipients, ['acc20']); assert.equal(staleShare.unavailableRecipientCount, 1);
  await f.store.update(freshOwner, shared.id, input({ version: 1, visibility: 'private' }));
  await assert.rejects(f.store.get(await f.context('acc20'), shared.id), { status: 404 });
  assert.equal((await f.store.list(await f.context('acc19'))).templates.some(row => row.id === copy.id), true);
});

test('Share inputs reject inactive, own, employee, department and forged recipients; owner and branch are never accepted from HTTP data', async t => {
  const f = await fixture(t), context = await f.context('42');
  for (const recipients of [['acc18'], ['inactive'], ['wrong-kind'], ['department'], ['inactive-location'], ['employee:43'], ['missing'], ['acc19', 'acc19'], [42]]) {
    await assert.rejects(f.store.create(context, input({ visibility: 'selected', recipients })), { status: 400 });
  }
  for (const invalid of [input({ ownerId: 'employee:43' }), input({ branchId: '19' }), input({ title: 'x'.repeat(81) }),
    input({ visibility: 'selected', recipients: [] }), input({ recipients: ['acc19'] }), input({ visibility: 'public' }),
    input({ title: '\u0000bad' }), input({ options: { hidden: true } })]) await assert.rejects(f.store.create(context, invalid));
  f.state.home['42'] = null; const homeless = await f.context('42'); assert.equal(homeless.ownBranch, null);
  await assert.rejects(f.store.create(homeless, input({ visibility: 'branch' })), { status: 400 });
  const library = await f.store.list(context); assert.ok(library.recipients.every(row => row.locationId !== '18'));
  assert.ok(library.recipients.every(row => ['acc19', 'acc19b', 'acc20'].includes(row.id)));
});

test('Templates survive source refresh, database copy and repository recreation; tampering fails closed and existing PostgreSQL annotations are reused', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-price-label-library-')), cleanup = [];
  t.after(async () => { for (const close of cleanup) await close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('gp-price-label-library-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const f = await persistenceFixture({ after: callback => cleanup.push(callback) }, { databasePath: path.join(directory, 'templates.db') });
  const store = Store.createSalesPriceLabelTemplateStore({ access: f.app.provider, vault: f.vault });
  const context = await Store.resolveTemplateSessionContext(employee('42'), { listBranchAccounts: async () => [account('acc18', '18')] });
  const saved = await store.create(context, input());
  await f.ingest('Artikel_Bemerkungen', [{ EAN: '005479', Text: 'Neue Trade Daten' }], { master: true });
  assert.deepEqual(await store.get(context, saved.id), saved);
  const copy = path.join(directory, 'copy.db'); f.app.database.prepare('VACUUM INTO ?').run(copy);
  const restored = await persistenceFixture({ after: callback => cleanup.push(callback) }, { databasePath: copy, resume: true });
  assert.deepEqual(await Store.createSalesPriceLabelTemplateStore({ access: restored.app.provider, vault: restored.vault }).get(context, saved.id), saved);
  f.app.database.prepare("UPDATE trade_annotations SET payload='corrupted' WHERE kind='price-label-library'").run();
  await assert.rejects(store.list(context), { code: 'PRICE_LABEL_LIBRARY_INTEGRITY', status: 503 });
  const { A } = require('../lib/persistence/statements/trade-annotations'), catalog = require('../lib/persistence/postgresql/core/trade-annotations').CATALOG;
  for (const statement of [A.get, A.insert, A.update]) assert.ok(catalog.some(row => row.statement === statement && /gp\.trade_annotations/.test(row.sql)));
});

async function httpFixture(t) {
  const f = await fixture(t), app = express(), preferences = new Map(); app.use(express.json({ limit: '64kb' }));
  registerSalesPriceLabelsRoutes(app, { templateStore: f.store, ...f.deps,
    sessionFor(req) { return structuredClone(f.state.sessions[req.get('X-Principal') || '42']); }, async assertFresh() {},
    async refreshSession(req) { await f.state.refreshHook?.(); return f.state.sessions[req.get('X-Principal') || '42']; },
    assertCsrf(req) { if (req.get('X-CSRF-Token') !== 'synthetic') throw Object.assign(Error('CSRF'), { status: 403 }); },
    privateHeaders(res) { res.set('Cache-Control', 'private, no-store'); },
    preferences: { async get(owner, key) { return { value: preferences.get(owner + ':' + key) }; }, async upsert(owner, key, value) { preferences.set(owner + ':' + key, value); } },
    branding: { list: async () => ({ kits: [{ id: 'trusted', name: 'Trusted Logo', logos: [] }] }) },
  });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code || 'UNEXPECTED', error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/sales/price-labels/';
  const request = (suffix, body, { principal = '42', csrf = 'synthetic', method } = {}) => fetch(endpoint + suffix, {
    method: method || (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', 'X-Principal': principal, 'X-CSRF-Token': csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...f, preferences, request };
}

test('Library API keeps branch account private preferences isolated and enforces CSRF, server ownership and CAS', async t => {
  const f = await httpFixture(t);
  const response = await f.request('library', input()); assert.equal(response.status, 200); const saved = await response.json();
  assert.match(response.headers.get('cache-control'), /no-store/); assert.equal(saved.creator.id, 'employee:42');
  const list = await (await f.request('library')).json(); assert.equal(list.ownBranch.id, '18'); assert.equal(list.templates[0].id, saved.id);
  assert.equal((await f.request('library', input(), { csrf: '' })).status, 403);
  assert.equal((await f.request('library/' + saved.id, input({ version: 1 }), { method: 'PATCH', csrf: '' })).status, 403);
  assert.equal((await f.request('library/' + saved.id, input({ version: 9 }), { method: 'PATCH' })).status, 409);
  assert.equal((await f.request('library/' + saved.id, input({ version: 1 }), { method: 'PATCH' })).status, 200);
  assert.equal((await f.request('library', input({ ownerId: 'employee:43' }))).status, 422);
  assert.equal((await f.request('library/' + saved.id, undefined, { principal: '43' })).status, 404);
  const privateTemplate = { options: {}, filenameOptions: {} };
  assert.equal((await f.request('templates', privateTemplate, { principal: 'acc18' })).status, 200);
  assert.equal((await f.request('templates', privateTemplate, { principal: 'acc19' })).status, 200);
  assert.equal(f.preferences.size, 0, 'Branch settings never enter employee-FK preferences');
  const encrypted = f.p.app.database.prepare("SELECT * FROM trade_annotations WHERE kind='price-label-library'").get();
  assert.doesNotMatch(JSON.stringify(encrypted), /account:acc18|account:acc19|labelWidthMm/);
  const privateSaved = await f.store.getDefault(await f.context('acc18'));
  assert.equal(privateSaved.options.paper, 'A4');
  assert.equal(f.preferences.has('undefined:sales_price_labels_v1'), false);
  assert.equal((await f.request('library', input({ visibility: 'branch' }), { principal: 'acc18' })).status, 200);
  assert.equal((await f.request('branding')).status, 200); assert.equal((await f.request('branding?clientLogo=data:forged')).status, 422);
});

test('Late recipient, home-branch, identity and required-password changes block protected library work before persistence', async t => {
  const f = await httpFixture(t); f.state.directoryCalls = 0;
  f.state.directoryHook = async () => { if (f.state.directoryCalls === 3) f.state.accounts.find(row => row.id === 'acc19').active = false; };
  const response = await f.request('library', input({ visibility: 'selected', recipients: ['acc19'] }));
  assert.equal(response.status, 403); assert.equal((await f.store.list(await f.context('42'))).templates.length, 0);
  f.state.directoryHook = null; f.state.accounts.find(row => row.id === 'acc19').active = true;
  f.state.directoryCalls = 0; f.state.directoryHook = async () => { if (f.state.directoryCalls === 3) f.state.home['42'] = '19'; };
  assert.equal((await f.request('library', input({ visibility: 'branch' }))).status, 403);
  assert.equal((await f.store.list(await f.context('42'))).templates.length, 0);
  f.state.directoryHook = null; f.state.home['42'] = '18';
  f.state.sessions['42'].mustChangePassword = true; assert.equal((await f.request('library')).status, 403);
  f.state.sessions['42'].mustChangePassword = false;
  f.state.refreshHook = async () => { f.state.sessions['42'].homeLocationId = '19'; };
  assert.equal((await f.request('library')).status, 403);
  f.state.refreshHook = null; f.state.sessions.acc18.accountType = 'department';
  assert.equal((await f.request('library', undefined, { principal: 'acc18' })).status, 403);
});

test('Loopback localSystem defaults round-trip in protected annotations without inventing a portal user or violating employee preferences FK', async t => {
  const f = await httpFixture(t);
  f.state.sessions.local = { employeeNumber: 'local', sessionKind: 'local', localSystem: true, permissions: [...rights], scopes: [] };
  const get = await f.request('templates', undefined, { principal: 'local' }); assert.equal(get.status, 200);
  assert.equal((await get.json()).options.paper, 'A4');
  const chosen = { options: { color: '#765432', labelWidthMm: 91.5, gapMm: 3.5 }, filenameOptions: { stamp: 'date', position: 'after', separator: '_' } };
  const savedResponse = await f.request('templates', chosen, { principal: 'local' }); assert.equal(savedResponse.status, 200); const saved = await savedResponse.json();
  assert.equal(saved.options.labelWidthMm, 91.5); assert.equal(saved.options.color, '#765432');
  assert.deepEqual(await (await f.request('templates', undefined, { principal: 'local' })).json(), saved);
  assert.equal(f.preferences.size, 0, 'No FK-backed portal_user_preferences write for local');
  const restoredStore = Store.createSalesPriceLabelTemplateStore({ access: f.p.app.provider, vault: f.p.vault });
  assert.deepEqual(await restoredStore.getDefault(await f.context('local')), saved);
  assert.notDeepEqual(await f.store.getDefault(await f.context('acc18')), saved);
  const encrypted = f.p.app.database.prepare("SELECT * FROM trade_annotations WHERE kind='price-label-library'").get();
  assert.doesNotMatch(JSON.stringify(encrypted), /employee:local|765432|labelWidthMm/);
});
