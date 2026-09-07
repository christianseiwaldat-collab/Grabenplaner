'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../lib/data-import-contract'), H = require('../lib/tradefoto-history-profiles');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { SQLITE_APPLICATION_CATALOG } = require('../lib/persistence/sqlite/application-catalog');
const { ensureSqliteDataImportRuntimeSchema } = require('../lib/persistence/sqlite/operations/data-import-runtime-schema');
const { createIntegrationSecretVault } = require('../lib/integration-secret-vault');
const { loadManagedDataImportProtection } = require('../lib/data-import-managed-protection');
const { createCashSnapshotStore } = require('../lib/persistence/repositories/cash-snapshots');
const { createCashPublicationRuntime } = require('../lib/persistence/repositories/cash-publication-runtime');
const { createManagedSalesHistoryRuntime } = require('../lib/persistence/repositories/sales-history-runtime');
const { CASH_SNAPSHOT_TABLES: TABLES } = require('../lib/persistence/statements/cash-snapshots');
const { CASH_SOURCE_POLICIES } = require('../lib/cash-source-policies');
const TIME = '2026-09-07T12:00:00.000Z';
const code = c => e => e.code === c;
const raw = (name, values) => ({ ...Object.fromEntries(H.tableFor('cash', name).columns.map(c => [c.name, null])), ...values });
function rows({ count = 1, price = '12', seller = '07', location = '018', unknown = false } = {}) {
  const flags = CASH_SOURCE_POLICIES[0].policy.statusRules[3].flags;
  const head = raw('Umsatz_KASSE', { Bonnr: '000001', Filialid: location, Kassenid: '01', Bondatum: '2010-01-02T00:00:00.000',
    VerkäuferID: '08', KUND_NR: '00031', RechnungsBetrag: String(count * Number(price)) });
  return { Umsatz_KASSE: [head], Umsatz_Kasse_Details: Array.from({ length: count }, (_, i) => raw('Umsatz_Kasse_Details', {
    Bonnr: head.Bonnr, Filialid: location, Kassenid: head.Kassenid, Bondatum: head.Bondatum,
    RepID: '00000000-0000-0000-0000-' + String(i + 1).padStart(12, '0'), EAN: '00042', VKMenge: '1', VK_Preis: price,
    MWST: '20', Verkäuferid: seller, Artikelbezeichnung: 'Synthetic article', ...flags, ...(unknown ? { Beratung: true } : {}) })) };
}
async function fixture(t, options = {}) {
  const app = openSqliteApplicationPersistence({ databasePath: ':memory:', catalog: SQLITE_APPLICATION_CATALOG });
  ensureSqliteDataImportRuntimeSchema(app.database); app.database.exec('PRAGMA foreign_keys=ON');
  app.database.exec("CREATE TABLE locations(id TEXT PRIMARY KEY,name TEXT,active INTEGER); INSERT INTO locations VALUES ('branch-a','Branch A',1),('branch-b','Branch B',1); CREATE TABLE employees(personnel_number TEXT PRIMARY KEY,full_name TEXT,active INTEGER); INSERT INTO employees VALUES ('person-a','Person A',1),('person-b','Person B',1);");
  const vault = createIntegrationSecretVault({ activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 12) } });
  const protection = await loadManagedDataImportProtection({ access: app.provider, vault, create: true, clock: () => TIME });
  const actor = { scopeId: 'synthetic-cash', ownerId: 'admin-1' }, policies = [];
  const session = { employeeNumber: actor.ownerId, accountId: 'synthetic-account', isEmployee: true,
    permissions: ['data:imports:read','data:imports:prepare','data:imports:apply','data:imports:undo','sales:analytics:access','sales:analytics:company:read',
      'sales:history:read','sales:history:sellers:read','sales:history:unassigned:read','locations:write','personnel:central:read','personnel:central:write'],
    locations: [], authorizedLocationIds: [] };
  const f = { app, vault, protection, actor, policies, session };
  f.get = async () => f.session;
  f.publish = createCashPublicationRuntime({ access: app.provider, vault, policies, scopeId: actor.scopeId, enabled: true, clock: () => TIME });
  f.history = () => createManagedSalesHistoryRuntime({ access: app.provider, vault, scopeId: actor.scopeId, cashEnabled: true, today: () => '2026-09-07' });
  f.build = async (data = rows(options), { ready = true } = {}) => {
    const fileSha256 = C.fingerprint(data), id = protection.digest(['source', actor, 'cash', fileSha256]);
    const store = createCashSnapshotStore({ access: app.provider, protection, actor, clock: () => TIME });
    await store.begin(id, { kind: 'cash', fileSha256, bytes: 4096, tables: TABLES.map(t => ({ name: t.name, profileHash: t.profile.fingerprint, declaredRows: data[t.name]?.length || 0 })) });
    for (const table of TABLES) {
      const source = data[table.name] || []; await store.startTable(id, table.name, source.length);
      for (let offset = 0; offset < source.length; offset += 200) await store.append(id, table.name, offset + 1,
        source.slice(offset, offset + 200).map((r, i) => H.prepareTradeFotoHistoryRow('cash', table.name, r, { fileSha256, rowNumber: offset + i + 1 })));
      await store.finishTable(id, table.name);
    }
    let result = await store.seal(id, { tables: TABLES.length, rows: Object.values(data).reduce((n, a) => n + a.length, 0) });
    if (ready) while (result.status === 'reviewing') result = await store.review(id);
    policies.push({ ...CASH_SOURCE_POLICIES[0], fileSha256 }); return id;
  };
  f.id = await f.build();
  f.request = (id = f.id, revision = 0) => ({ sourceId: id, expectedRevision: revision, label: 'Synthetic cash', policyId: policies[0].id, resolveArticles: false,
    mappings: [{ kind: 'FILIALEN', sourceId: '018', targetId: 'branch-a', historical: false },
      { kind: 'MITARBEITER', sourceId: '07', targetId: 'person-a', historical: false }, { kind: 'MITARBEITER', sourceId: '08', targetId: 'person-b', historical: false }] });
  f.activate = async (request = f.request()) => { const p = await f.publish.operation(f.get, 'preview', { request }); return f.publish.operation(f.get, 'activate', { request, planHash: p.planHash }); };
  f.query = (extra = {}) => ({ sourceId: 'compact-cash', dateFrom: '2010-01-01', dateTo: '2010-12-31', ...extra });
  t.after(async () => { protection.destroy(); await app.provider.close(); app.database.close(); });
  return f;
}
test('compact cash becomes usable through the normal history runtime with exact totals and no duplicate history', async t => {
  const f = await fixture(t); assert.equal(await f.history().run(f.get, w => w), null);
  const context = await f.publish.operation(f.get, 'context', { sourceId: f.id }); assert.equal(context.state.revision, 0);
  await f.activate();
  const runtime = f.history(), result = await runtime.run(f.get, w => w.search(f.query()));
  assert.deepEqual(result.totals, { currency: 'EUR', gross: '12.00', net: '10.00', tax: '2.00' });
  assert.equal(result.items[0].location.targetId, 'branch-a');
  assert.equal(result.items[0].sellers.line.targetId, 'person-a'); assert.equal(result.items[0].sellers.header.targetId, 'person-b');
  assert.doesNotMatch(JSON.stringify(result), /00031|KUND_NR/);
  assert.equal(f.app.database.prepare('SELECT COUNT(*) n FROM import_history_records').get().n, 0);
  assert.equal(f.app.database.prepare('SELECT COUNT(*) n FROM data_import_rows').get().n, 0);
  assert.equal(f.app.database.prepare('SELECT COUNT(*) n FROM cash_snapshot_6').get().n, 1);
});
test('compact cash completes a multi-batch period and paging never counts sales twice', async t => {
  const f = await fixture(t, { count: 205 }); await f.activate(); const runtime = f.history();
  let result = await runtime.run(f.get, w => w.search(f.query())); assert.equal(result.totals, null); assert.equal(result.analysis.processed, 200);
  const page = await runtime.run(f.get, w => w.search(f.query({ cursor: result.next })));
  assert.equal(page.analysis.processed, 200);
  result = await runtime.run(f.get, w => w.analyze({ query: f.query(), cursor: result.analysis.cursor }));
  assert.equal(result.analysis.processed, 205); assert.equal(result.totals.gross, '2460.00');
});
test('activation keeps prior data, invalidates old cursors and rollback restores the exact previous selection', async t => {
  const f = await fixture(t, { count: 205 }); await f.activate(); const runtime = f.history();
  const old = await runtime.run(f.get, w => w.search(f.query()));
  const id = await f.build(rows({ price: '24' })); await f.activate(f.request(id, 1));
  await assert.rejects(runtime.run(f.get, w => w.analyze({ query: f.query(), cursor: old.analysis.cursor })), code('IMPORT_HISTORY_RESULTS_CHANGED'));
  assert.equal((await runtime.run(f.get, w => w.search(f.query()))).totals.gross, '24.00');
  const preview = await f.publish.operation(f.get, 'rollback-preview', { expectedRevision: 2 });
  await f.publish.operation(f.get, 'rollback', { expectedRevision: 2, planHash: preview.planHash });
  assert.equal((await runtime.run(f.get, w => w.search(f.query()))).analysis.processed, 200);
  assert.equal(f.app.database.prepare('SELECT COUNT(*) n FROM cash_snapshot_6').get().n, 206);
});
test('activation rejects stale plans, unknown identifiers, wrong targets and unreviewed sources', async t => {
  const f = await fixture(t), request = f.request();
  const p = await f.publish.operation(f.get, 'preview', { request });
  f.app.database.exec("UPDATE locations SET name='Changed' WHERE id='branch-a'");
  await assert.rejects(f.publish.operation(f.get, 'activate', { request, planHash: p.planHash }), code('IMPORT_PREVIEW_CHANGED'));
  const invalid = f.request(); invalid.mappings[0].sourceId = '18';
  await assert.rejects(f.publish.operation(f.get, 'preview', { request: invalid }), code('IMPORT_MAPPING_SOURCE_UNAVAILABLE'));
  invalid.mappings[0].sourceId = '018'; invalid.mappings[0].targetId = 'missing';
  await assert.rejects(f.publish.operation(f.get, 'preview', { request: invalid }), code('IMPORT_MAPPING_TARGET_MISSING'));
  const id = await f.build(rows({ price: '13' }), { ready: false });
  await assert.rejects(f.publish.operation(f.get, 'preview', { request: f.request(id) }), code('IMPORT_SOURCE_INCOMPLETE'));
  await f.activate(); await assert.rejects(f.publish.operation(f.get, 'activate', { request, planHash: p.planHash }), code('IMPORT_REVISION_CONFLICT'));
});
test('seller and branch scopes are cumulative; finance and customer data stay protected', async t => {
  const f = await fixture(t); await f.activate(); const runtime = f.history();
  const result = await runtime.run(f.get, w => w.search(f.query({ sellerId: 'person-b', sellerRole: 'header_seller' })));
  assert.equal(result.items.length, 1);
  f.session.permissions = f.session.permissions.filter(p => p !== 'sales:history:sellers:read');
  assert.equal((await runtime.run(f.get, w => w.search(f.query()))).items[0].sellers, undefined);
  await assert.rejects(runtime.run(f.get, w => w.search(f.query({ sellerId: 'person-a' }))), code('IMPORT_FORBIDDEN'));
  await assert.rejects(runtime.run(f.get, w => w.search(f.query({ locationId: 'branch-b' }))), code('IMPORT_FORBIDDEN'));
  await assert.rejects(runtime.run(f.get, w => w.search(f.query({ kind: 'daily', snapshot: f.policies[0].fileSha256 }))), code('IMPORT_FORBIDDEN'));
  await assert.rejects(runtime.run(f.get, w => w.search(f.query(), { customerId: 'private-customer' })), code('IMPORT_FORBIDDEN'));
});
test('unknown status combinations retain rows but do not produce an approved revenue total', async t => {
  const f = await fixture(t, { unknown: true }); await f.activate();
  const result = await f.history().run(f.get, w => w.search(f.query()));
  assert.equal(result.items.length, 1); assert.equal(result.totals, null); assert.ok(result.coverage.issues.includes('STATUS_REVIEW_REQUIRED'));
});
test('deleted rows and modified binding indexes fail closed after activation', async t => {
  const f = await fixture(t); await f.activate();
  f.app.database.exec("UPDATE cash_publication_bindings SET target_id='branch-b' WHERE kind='FILIALEN'");
  await assert.rejects(f.history().run(f.get, w => w.search(f.query({ locationId: 'branch-a' }))), e => e.code?.startsWith('IMPORT_'));
  f.app.database.exec("UPDATE cash_publication_bindings SET target_id='branch-a' WHERE kind='FILIALEN'; DELETE FROM cash_snapshot_6");
  await assert.rejects(f.history().run(f.get, w => w.search(f.query())), code('IMPORT_HISTORY_INTEGRITY'));
});
test('only a personally authorized importer can activate and only the current actor may roll back', async t => {
  const f = await fixture(t); f.session.permissions = f.session.permissions.filter(p => p !== 'personnel:central:write');
  await assert.rejects(f.activate(), code('IMPORT_FORBIDDEN'));
  f.session.isEmployee = false; await assert.rejects(f.publish.operation(f.get, 'context', { sourceId: f.id }), code('IMPORT_FORBIDDEN'));
});
test('published cash survives a real database copy, a fresh vault and full re-verification without changing its selection', async t => {
  const fs = require('node:fs'), path = require('node:path');
  const f = await fixture(t); const active = await f.activate();
  const root = fs.realpathSync(path.resolve(__dirname, '../tmp')), directory = fs.mkdtempSync(path.join(root, 'cash-publication-restore-'));
  const file = path.join(directory, 'restored.db'); f.app.database.prepare('VACUUM INTO ?').run(file);
  const restored = openSqliteApplicationPersistence({ databasePath: file, catalog: SQLITE_APPLICATION_CATALOG });
  t.after(async () => { await restored.provider.close(); restored.database.close(); assert.equal(fs.realpathSync(path.dirname(directory)), root);
    fs.rmSync(directory, { recursive: true }); });
  ensureSqliteDataImportRuntimeSchema(restored.database);
  const vault = createIntegrationSecretVault({ activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 12) } });
  const protection = await loadManagedDataImportProtection({ access: restored.provider, vault, create: false });
  const store = createCashSnapshotStore({ access: restored.provider, protection, actor: f.actor });
  let checked = await store.reverify(f.id); while (checked.status === 'reviewing') checked = await store.review(f.id); protection.destroy();
  const history = createManagedSalesHistoryRuntime({ access: restored.provider, vault, scopeId: f.actor.scopeId, cashEnabled: true, today: () => '2026-09-07' });
  assert.equal((await history.run(f.get, w => w.search(f.query()))).totals.gross, '12.00');
  const publication = createCashPublicationRuntime({ access: restored.provider, vault, scopeId: f.actor.scopeId, policies: f.policies, enabled: true });
  assert.equal((await publication.operation(f.get, 'context', { sourceId: f.id })).state.active.id, active.active);
});
test('publication HTTP actions enforce CSRF and refreshed personal rights; body flags cannot grant activation', async t => {
  const express = require('express'), { registerDataImportRoutes } = require('../lib/data-import-routes');
  const f = await fixture(t), app = express(); app.use(express.json());
  registerDataImportRoutes(app, { runtime: {}, cashPublications: f.publish, requireSession: () => f.session, refreshSession: f.get,
    assertCsrf: req => { if (req.get('X-CSRF-Token') !== 'test') throw new C.DataImportError('PORTAL_CSRF_INVALID', 403); } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); t.after(() => new Promise(r => server.close(r)));
  const post = (action, body, csrf = true) => fetch(`http://127.0.0.1:${server.address().port}/api/data-import/cash/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': 'test' } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post('context', { sourceId: f.id }, false)).status, 403);
  const response = await post('context', { sourceId: f.id }); assert.match(response.headers.get('cache-control'), /no-store/); assert.equal(response.status, 200);
  assert.equal((await post('preview', { request: { ...f.request(), approved: true } })).status, 422);
  f.session.permissions = f.session.permissions.filter(p => p !== 'data:imports:apply');
  assert.equal((await post('activate', { request: f.request(), planHash: 'a'.repeat(64) })).status, 403);
});
test('zero-price tax evidence cannot approve a nonzero tax-code-zero position', async t => {
  const f = await fixture(t), data = rows(); data.Umsatz_Kasse_Details[0].MWST = '0';
  const id = await f.build(data); await f.activate(f.request(id));
  const result = await f.history().run(f.get, w => w.search(f.query()));
  assert.equal(result.totals, null); assert.ok(result.coverage.issues.includes('VAT_CODE_UNKNOWN'));
});
test('cash publication UI escapes identifiers and late replies cannot restore a closed view', async () => {
  const UI = require('../public/cash-publication'), handlers = {}; let resolve;
  assert.doesNotMatch(UI.renderMappings([{ kind: 'FILIALEN', sourceId: '<img src=x>', targetId: '<script>x</script>' }]), /<img|<script>/);
  const root = { textContent: '', querySelector: () => null, addEventListener: (n, h) => { handlers[n] = h; }, removeEventListener() {}, replaceChildren() { this.textContent = ''; } };
  let signal; const view = UI.mount(root, { source: { id: 'a'.repeat(64) }, api: (_url, options) => { signal = options.signal; return new Promise(r => { resolve = r; }); } });
  view.destroy(); assert.equal(signal.aborted, true); resolve({ private: true }); await new Promise(r => setImmediate(r)); assert.equal(root.textContent, '');
});
test('editing the form during preview never enables activation of a stale proposal', async () => {
  const UI = require('../public/cash-publication'), handlers = {};
  const fields = { label: { value: 'First label' }, policy: { value: 'test' }, articles: { checked: false }, activate: { disabled: true }, message: { textContent: '' } };
  const root = { textContent: '', innerHTML: '', querySelector: s => fields[/data-c="([^"]+)"/.exec(s)?.[1]],
    addEventListener: (n, h) => { handlers[n] = h; }, removeEventListener() {}, replaceChildren() {} };
  let resolve;
  const view = UI.mount(root, { source: { id: 'a'.repeat(64) }, api: async url => url.endsWith('/context')
    ? { available: true, projection: { apply: true }, mappingProjection: { tables: [] }, state: { revision: 0 }, policies: [{ id: 'test', label: 'Test' }] }
    : new Promise(r => { resolve = r; }) });
  await new Promise(r => setImmediate(r));
  const button = { hasAttribute: n => n === 'data-c-preview' };
  const pending = handlers.click({ target: { closest: () => button }, stopPropagation() {} });
  await new Promise(r => setImmediate(r)); fields.label.value = 'Changed label';
  handlers.input({ target: fields.label, stopPropagation() {} }); resolve({ planHash: 'b'.repeat(64), bindings: 1, message: 'Old preview' });
  await pending; assert.equal(fields.activate.disabled, true); assert.match(fields.message.textContent, /während der Prüfung geändert/); view.destroy();
});
test('explicit CRM binding enables customer purchases, while another personal reader receives only its branch scope', async t => {
  const f = await fixture(t), { IMPORT_MASTER_COLUMNS: columns } = require('../lib/persistence/statements/import-master-data');
  const snake = v => v.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
  const keys = Object.keys(columns.CRM); f.app.database.exec('CREATE TABLE crm_customers (' + keys.map(k => snake(k) + (k === 'revision' ? ' INTEGER' : ' TEXT')).join(',') + ')');
  f.app.database.prepare('INSERT INTO crm_customers VALUES (' + keys.map(() => '?').join(',') + ')').run(...keys.map(k => k === 'id' ? 'crm-31' : k === 'revision' ? 1 : k === 'birthDate' ? null : k === 'customerNumber' ? '00031' : 'Synthetic'));
  f.session.permissions.push('crm:access', 'crm:customers:read', 'crm:customers:write', 'crm:purchases:read');
  const request = f.request(); request.mappings.push({ kind: 'KUNDEN', sourceId: '00031', targetId: 'crm-31', historical: false }); await f.activate(request);
  assert.equal((await f.history().run(f.get, w => w.search(f.query(), { customerId: 'crm-31' }))).totals.gross, '12.00');
  f.session = { employeeNumber: 'reader-2', accountId: 'reader-account', isEmployee: true,
    permissions: ['sales:analytics:access', 'sales:analytics:location:read', 'sales:history:read'], scopes: [{ locationId: 'branch-a' }] };
  const result = await f.history().run(f.get, w => w.search(f.query())); assert.equal(result.totals.gross, '12.00'); assert.equal(result.items[0].sellers, undefined);
  f.session.scopes = [{ locationId: 'branch-b' }];
  const hidden = await f.history().run(f.get, w => w.search(f.query())); assert.equal(hidden.items.length, 0); assert.equal(hidden.totals, null);
});
test('daily reports and cash journal use the compact source and remain separate from revenue totals', async t => {
  const f = await fixture(t), data = rows();
  data.KassenJournal = [raw('KassenJournal', { Vorgang: '7', Filiale: '018', Datum: '2010-01-02T00:00:00.000' })];
  data.KassenJournal_Details = [raw('KassenJournal_Details', { Vorgang: '7', Filiale: '018', Datum: '2010-01-02T00:00:00.000', Beleg: '003', Bezeichnung: 'Synthetic journal', Einzahlung: '5', Auszahlung: '3' })];
  data.Tagesbericht = [raw('Tagesbericht', { ZBon: '001', KoBeschreibung: 'Synthetic daily', Bondatum: '2010-01-02T00:00:00.000', Filialid: '018', Einnahmen: '12', Ausgaben: '0' })];
  const id = await f.build(data); await f.activate(f.request(id)); f.session.permissions.push('sales:history:finance:read');
  for (const [kind, description] of [['daily', 'Synthetic daily'], ['journal', 'Synthetic journal']]) {
    const result = await f.history().run(f.get, w => w.search(f.query({ kind, snapshot: C.fingerprint(data) })));
    assert.equal(result.items.length, 1); assert.equal(result.items[0].description, description);
    assert.equal(result.totals, null); assert.ok(result.coverage.issues.includes('SEPARATE_CASH_DATA_NOT_SALES'));
    const documents = await f.history().run(f.get, async w => {
      const search = await w.receipts.search({ sourceId: 'compact-cash', kind, dateFrom: '2010-01-01', dateTo: '2010-12-31', query: 'Synthe*' });
      assert.equal(search.items.length, 1); assert.equal(search.items[0].description, description); assert.equal(search.items[0].gross, null);
      assert.equal(search.items[0].personnel, undefined);
      return w.receipts.documents({ ids: [search.items[0].id] });
    });
    assert.equal(documents.items[0].inflow, kind === 'daily' ? '12.000000000000' : '5');
    assert.equal(documents.items[0].outflow, kind === 'daily' ? '0.000000000000' : '3');
    f.session.permissions = f.session.permissions.filter(p => p !== 'sales:history:finance:read');
    await assert.rejects(f.history().run(f.get, w => w.receipts.documents({ ids: [documents.items[0].id] })), e => e.code.startsWith('IMPORT_'));
    f.session.permissions.push('sales:history:finance:read');
  }
});
test('existing verified article bindings are captured without creating or changing the article catalogue', async t => {
  const f = await fixture(t), { TRADEFOTO_ARTICLE_SOURCE_SYSTEM: system } = require('../lib/tradefoto-article-source-profile');
  f.app.database.exec("CREATE TABLE sales_articles(product_id TEXT,current_revision INTEGER,article_number TEXT); CREATE TABLE sales_article_revisions(product_id TEXT,revision INTEGER,active INTEGER); CREATE TABLE sales_article_source_links(product_id TEXT,source_system TEXT,source_article_key TEXT); INSERT INTO sales_articles VALUES('article-42',1,'00042'); INSERT INTO sales_article_revisions VALUES('article-42',1,1);");
  f.app.database.prepare('INSERT INTO sales_article_source_links VALUES(?,?,?)').run('article-42', system, '00042');
  f.session.permissions.push('sales:articles:access', 'sales:articles:read', 'sales:articles:import');
  const request = f.request(); request.resolveArticles = true; await f.activate(request);
  let result = await f.history().run(f.get, w => w.search(f.query())); assert.equal(result.items[0].articleReference.targetId, 'article-42');
  f.app.database.exec("UPDATE sales_article_source_links SET product_id='later-article'");
  result = await f.history().run(f.get, w => w.search(f.query())); assert.equal(result.items[0].articleReference.targetId, 'article-42');
  assert.equal(f.app.database.prepare('SELECT COUNT(*) n FROM sales_articles').get().n, 1);
});


test('receipt search groups complete receipts, tolerates wildcards and exports only authorized fields', async t => {
  const f = await fixture(t, { count: 3 }); await f.activate(); const runtime = f.history();
  const q = { sourceId: 'compact-cash', dateFrom: '2010-01-01', dateTo: '2010-12-31', query: 'Synthe*   arti?le', kind: 'receipts' };
  const result = await runtime.run(f.get, w => w.receipts.search(q));
  assert.equal(result.items.length, 1); assert.equal(result.items[0].positions, 3); assert.equal(result.items[0].gross, '36.00');
  assert.equal(result.items[0].personnel, 'person-b');
  const docs = await runtime.run(f.get, w => w.receipts.documents({ ids: [result.items[0].id] }));
  assert.equal(docs.items[0].lines.length, 3); assert.equal(docs.items[0].lines[0].personnel, 'person-a');
  assert.doesNotMatch(JSON.stringify(docs), /00031|KUND_NR|Rohertrag|Provision/);
  assert.equal((await runtime.run(f.get, w => w.receipts.search({ ...q, seller: 'person-a', sellerRole: 'line_seller' }))).items.length, 1);
  assert.equal((await runtime.run(f.get, w => w.receipts.search({ ...q, seller: 'person-a' }))).items.length, 0);
  const { createReceiptInfoPdf } = require('../lib/receipt-info-pdf'); const pdf = await createReceiptInfoPdf(docs);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  f.session.permissions = f.session.permissions.filter(p => p !== 'sales:history:sellers:read');
  const safe = await runtime.run(f.get, w => w.receipts.documents({ ids: [result.items[0].id] }));
  assert.doesNotMatch(JSON.stringify(safe), /personnel|person-a|person-b|Verkäufer/);
  await assert.rejects(runtime.run(f.get, w => w.receipts.search({ ...q, seller: 'person-a' })), code('IMPORT_FORBIDDEN'));
  f.session.permissions = f.session.permissions.filter(p => p !== 'sales:history:read');
  await assert.rejects(runtime.run(f.get, w => w.receipts.documents({ ids: [result.items[0].id] })), code('IMPORT_FORBIDDEN'));
});

test('receipt paging distinguishes same-number receipts and binds filters, active publication and personal scope', async t => {
  const f = await fixture(t), data = rows();
  data.Umsatz_KASSE.push({ ...data.Umsatz_KASSE[0], Kassenid: '02' });
  data.Umsatz_Kasse_Details.push({ ...data.Umsatz_Kasse_Details[0], Kassenid: '02', RepID: '00000000-0000-0000-0000-000000000099' });
  const source = await f.build(data); await f.activate(f.request(source)); const runtime = f.history();
  const q = { sourceId: 'compact-cash', dateFrom: '2010-01-01', dateTo: '2010-12-31', receipt: '*001', limit: 1 };
  const first = await runtime.run(f.get, w => w.receipts.search(q)); assert.equal(first.items.length, 1); assert.ok(first.next);
  const second = await runtime.run(f.get, w => w.receipts.search({ ...q, limit: 50, cursor: first.next }));
  assert.equal(second.items.length, 1); assert.notEqual(first.items[0].id, second.items[0].id); assert.equal(second.complete, true);
  await assert.rejects(runtime.run(f.get, w => w.receipts.search({ ...q, query: 'changed', cursor: first.next })), code('IMPORT_HISTORY_RESULTS_CHANGED'));
  await assert.rejects(runtime.run(f.get, w => w.receipts.search({ ...q, locationId: 'branch-b' })), code('IMPORT_FORBIDDEN'));
  const replacement = await f.build(rows({ price: '24' })); await f.activate(f.request(replacement, 1));
  await assert.rejects(runtime.run(f.get, w => w.receipts.documents({ ids: [first.items[0].id] })), e => e.code.startsWith('IMPORT_'));
  await assert.rejects(runtime.run(f.get, w => w.receipts.search({ ...q, cursor: first.next })), code('IMPORT_HISTORY_RESULTS_CHANGED'));
});

test('receipt customer search covers account, optional number, name, address, telephone and email with cumulative rights', async t => {
  const f = await fixture(t);
  const { ensureSqliteCrmSchema } = require('../lib/persistence/sqlite/operations/crm-schema');
  const { normalizeCrmCustomerInput } = require('../lib/crm-customers');
  const { IMPORT_MASTER_STATEMENTS: M, IMPORT_MASTER_COLUMNS: cols } = require('../lib/persistence/statements/import-master-data');
  ensureSqliteCrmSchema(f.app.database);
  const customer = normalizeCrmCustomerInput({ accountNumber: '00031', customerNumber: 'C-009', firstName: 'Änne', lastName: 'Müller',
    street: 'Testgasse 4', postalCode: '6020', city: 'Innsbruck', phone: '+43 512 123456', email: 'anne@example.test' });
  await f.app.provider.execute(M.crmInsert, { id: 'crm-31', ...Object.fromEntries(Object.keys(cols.CRM_DATA).map(k => [k, customer[k]])), actor: f.actor.ownerId, timestamp: TIME });
  f.session.permissions.push('crm:access', 'crm:customers:read', 'crm:customers:write', 'crm:purchases:read');
  await f.activate(); const runtime = f.history(), q = f.query();
  assert.equal((await runtime.run(f.get, w => w.receipts.search({ ...q, customer: '00031' }))).items.length, 1);
  // A matching text number alone does not merge two identities.
  assert.equal((await runtime.run(f.get, w => w.receipts.search({ ...q, customer: 'Muller' }))).items.length, 0);
  const request = f.request(f.id, 1); request.mappings.push({ kind: 'KUNDEN', sourceId: '00031', targetId: 'crm-31', historical: false }); await f.activate(request);
  for (const customer of ['00031', 'C009', 'Muller Ann*', '6020 Testgasse', '512 123*', 'anne@example.test']) {
    const result = await runtime.run(f.get, w => w.receipts.search({ ...q, customer }));
    assert.equal(result.items.length, 1, customer); assert.equal(result.items[0].customerAccount, '00031'); assert.equal(result.items[0].customerNumber, 'C-009');
  }
  const result = await runtime.run(f.get, w => w.receipts.search({ ...q, customer: 'anne', sort: 'customerEmail', direction: 'asc' }));
  const documents = await runtime.run(f.get, w => w.receipts.documents({ ids: [result.items[0].id] }));
  assert.equal(documents.items[0].customerName, 'Änne Müller');
  f.session.permissions = f.session.permissions.filter(p => p !== 'crm:purchases:read');
  await assert.rejects(runtime.run(f.get, w => w.receipts.search({ ...q, customer: '00031' })), code('IMPORT_FORBIDDEN'));
  await assert.rejects(runtime.run(f.get, w => w.receipts.search({ ...q, sort: 'customerName', direction: 'asc' })), code('IMPORT_FORBIDDEN'));
  const safe = await runtime.run(f.get, w => w.receipts.documents({ ids: [result.items[0].id] }));
  assert.doesNotMatch(JSON.stringify(safe), /customerAccount|customerName|anne@example|00031|C-009/);
});

test('global receipt sorting finds late matches, pages without rescanning and binds the result set to filters and permissions', async t => {
  const f = await fixture(t), data = { Umsatz_KASSE: [], Umsatz_Kasse_Details: [] };
  for (let i = 1; i <= 205; i++) {
    const source = rows({ price: String(i) });
    data.Umsatz_KASSE.push({ ...source.Umsatz_KASSE[0], Bonnr: String(i) });
    data.Umsatz_Kasse_Details.push({ ...source.Umsatz_Kasse_Details[0], Bonnr: String(i), RepID: '00000000-0000-0000-0000-' + String(i).padStart(12, '0') });
  }
  const id = await f.build(data); await f.activate(f.request(id)); const runtime = f.history();
  const q = { ...f.query(), sort: 'gross', direction: 'asc', limit: 10 };
  let result = await runtime.run(f.get, w => w.receipts.search(q));
  assert.equal(result.sorting, true); assert.equal(result.items.length, 0);
  while (result.sorting) result = await runtime.run(f.get, w => w.receipts.search({ ...q, cursor: result.next }));
  assert.equal(result.total, 205); assert.deepEqual(result.items.map(r => r.gross), Array.from({ length: 10 }, (_, i) => (i + 1) + '.00'));
  const second = await runtime.run(f.get, w => w.receipts.search({ ...q, cursor: result.next, resultSet: result.resultSet }));
  assert.equal(second.processed, 0); assert.equal(second.items[0].gross, '11.00');
  const descending = await runtime.run(f.get, w => w.receipts.search({ ...q, direction: 'desc', resultSet: result.resultSet }));
  assert.equal(descending.processed, 0); assert.equal(descending.items[0].gross, '205.00');
  await assert.rejects(runtime.run(f.get, w => w.receipts.search({ ...q, receipt: 'different', resultSet: result.resultSet })), code('IMPORT_HISTORY_RESULTS_CHANGED'));
  f.session.permissions = f.session.permissions.filter(p => p !== 'sales:history:sellers:read');
  await assert.rejects(runtime.run(f.get, w => w.receipts.search({ ...q, resultSet: result.resultSet })), code('IMPORT_HISTORY_RESULTS_CHANGED'));
});
