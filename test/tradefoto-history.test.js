"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../lib/data-import-contract');
const H = require('../lib/tradefoto-history-profiles');
const M = require('../lib/tradefoto-master-profiles');
const R = require('../lib/tradefoto-sales-rules');
const { createDataImportEngine } = require('../lib/data-import-engine');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { createDataImportRepository } = require('../lib/persistence/repositories/data-import');
const { createImportMasterWriters, createImportMasterService } = require('../lib/persistence/repositories/import-master-data');
const { createImportHistoryWriters, createImportHistoryService } = require('../lib/persistence/repositories/import-history');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { ensureSqliteDataImportSchema } = require('../lib/persistence/sqlite/operations/data-import-schema');
const { ensureSqliteImportMasterSchema } = require('../lib/persistence/sqlite/operations/import-master-schema');
const { ensureSqliteImportHistorySchema, IMPORT_HISTORY_SCHEMA_SQL } = require('../lib/persistence/sqlite/operations/import-history-schema');
const { ensureSqliteCrmSchema } = require('../lib/persistence/sqlite/operations/crm-schema');
const { ensureSqliteSalesArticleCatalogSchema } = require('../lib/persistence/sqlite/operations/sales-article-catalog-schema');
const { SQLITE_DATA_IMPORT_CATALOG } = require('../lib/persistence/sqlite/data-import-catalog');
const { SQLITE_IMPORT_MASTER_CATALOG } = require('../lib/persistence/sqlite/import-master-catalog');
const { SQLITE_IMPORT_HISTORY_CATALOG } = require('../lib/persistence/sqlite/import-history-catalog');
const { SQLITE_CRM_CUSTOMERS_CATALOG } = require('../lib/persistence/sqlite/crm-customers-catalog');
const { SQLITE_SALES_ARTICLE_CATALOG } = require('../lib/persistence/sqlite/sales-article-catalog-catalog');
const { IMPORT_HISTORY_STATEMENTS: S } = require('../lib/persistence/statements/import-history');
const { IMPORT_MASTER_STATEMENTS: MS } = require('../lib/persistence/statements/import-master-data');
const { compilePostgresqlDialectEntry } = require('../lib/persistence/postgresql/dialect-compiler');
const { createSalesArticleCatalogRepository } = require('../lib/persistence/repositories/sales-article-catalog');
const { salesArticleImportContentSha256 } = require('../lib/sales-article-catalog');
const { TRADEFOTO_ARTICLE_SOURCE_SYSTEM } = require('../lib/tradefoto-article-source-profile');
const { createSalesHistoryWorkspace } = require('../lib/persistence/repositories/sales-history-workspace');
const { SALES_HISTORY_PERMISSIONS: HP } = require('../lib/sales-history-access');
const { SALES_ANALYTICS_PERMISSIONS: AP } = require('../lib/sales-analytics-access');
const { CRM_PERMISSIONS: CP } = require('../lib/crm-access');
const TIME = '2026-09-05T11:00:00.000Z', DAY = '2026-09-04T00:00:00.000', SHA = 'a'.repeat(64);
const code = expected => error => error?.code === expected;
const raw = (source, name, extra = {}) => Object.assign(Object.fromEntries(H.tableFor(source, name).columns.map(f => [f.name, null])), extra);
const masterRaw = (name, extra) => Object.assign(Object.fromEntries(M.tableFor(name).columns.map(f => [f.name, null])), extra);
const head = (extra = {}) => raw('cash', 'Umsatz_KASSE', { Bonnr: '001', Filialid: '1', Kassenid: '1', Bondatum: DAY, Bonzeit: '1899-12-30T10:15:30.000',
  KUND_NR: '000419', VerkäuferID: '7', RechnungsBetrag: '12', ...extra });
const flags = Object.fromEntries(R.STATUS_FIELDS.map(f => [f, false]));
const line = (extra = {}) => raw('cash', 'Umsatz_Kasse_Details', { RepID: '00000000-0000-0000-0000-000000000001', Bonnr: '001', Filialid: '1', Kassenid: '1', Bondatum: DAY,
  EAN: '0000123', VKMenge: '1', VK_Preis: '12', MWST: '1', Verkäuferid: '8', Artikelbezeichnung: 'Synthetischer historischer Artikel', ...flags, ...extra });
function policy(extra = {}) {
  return R.defineTradeFotoSalesPolicy({ id: 'synthetic-confirmed-policy', version: 1, scopeId: 'scope', sourceInstance: 'cash-source',
    schemaSha256: H.profileFor('cash', 'Umsatz_KASSE').schemaSha256, evidenceSha256: SHA, approvedBy: 'synthetic-reviewer', approvedAt: TIME,
    currency: 'EUR', minorUnits: 2, priceBasis: 'gross', priceMeaning: 'final_unit', headerBasis: 'gross', rounding: 'half_away_from_zero',
    vatRates: { '1': '20' }, headerToleranceMinor: 0, statusRules: [
      { id: 'positive', status: 'sale', flags, quantitySign: 'positive' },
      { id: 'negative', status: 'return', flags, quantitySign: 'negative' },
      { id: 'void', status: 'excluded', flags: { ...flags, BStorno: true }, quantitySign: 'any' },
    ], ...extra });
}
const coverage = (header, lines, extra = {}) => R.defineTradeFotoReceiptCoverage({ scopeId: 'scope', sourceInstance: 'cash-source', fileSha256: SHA,
  schemaSha256: H.profileFor('cash', 'Umsatz_KASSE').schemaSha256, evidenceSha256: SHA, expectedSourceRows: lines.length, verifiedSourceRows: lines.length,
  head: header, lines, ...extra });
async function fixture(t) {
  const app = openSqliteApplicationPersistence({ databasePath: ':memory:', catalog: [
    ...SQLITE_DATA_IMPORT_CATALOG, ...SQLITE_IMPORT_MASTER_CATALOG, ...SQLITE_IMPORT_HISTORY_CATALOG, ...SQLITE_CRM_CUSTOMERS_CATALOG, ...SQLITE_SALES_ARTICLE_CATALOG,
  ] });
  app.database.exec(`CREATE TABLE audit_log(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity_type TEXT,entity_id TEXT,detail TEXT,created_at TEXT);
    CREATE TABLE employees(personnel_number TEXT PRIMARY KEY,active INTEGER NOT NULL);
    CREATE TABLE locations(id TEXT PRIMARY KEY,active INTEGER NOT NULL);`);
  for (const ensure of [ensureSqliteDataImportSchema, ensureSqliteImportMasterSchema, ensureSqliteImportHistorySchema, ensureSqliteImportHistorySchema, ensureSqliteCrmSchema, ensureSqliteSalesArticleCatalogSchema]) ensure(app.database);
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 7), indexKey: Buffer.alloc(32, 9), keyId: 'synthetic' });
  const context = { who: { scopeId: 'scope', ownerId: 'actor' }, denied: new Set(), deniedClasses: new Set(), deniedTargets: new Set(), paired: 'trade-source', rejectScope: false };
  const composition = { protection, getActor: () => context.who, clock: () => TIME,
    authorize: ({ action, dataClasses, targetId }) => !context.denied.has(action) && !dataClasses.some(c => context.deniedClasses.has(c)) && !context.deniedTargets.has(targetId) && !(action === 'history.scope' && context.rejectScope) };
  const writers = { ...createImportMasterWriters({ protection }), ...createImportHistoryWriters({ ...composition, resolveMasterSourceInstance: () => context.paired }) };
  const engine = createDataImportEngine({ ...composition, repository: createDataImportRepository(app.provider), profiles: [...M.TRADEFOTO_MASTER_PROFILES, ...H.TRADEFOTO_HISTORY_PROFILES], writers });
  const service = createImportHistoryService({ ...composition, access: app.provider });
  const masters = createImportMasterService({ ...composition, access: app.provider });
  t.after(async () => { protection.destroy(); await app.provider.close(); app.database.close(); });
  let attempt = 0;
  async function ready(source, name, rows, extra = {}) {
    const isMaster = source === 'master', profile = isMaster ? M.profileFor(name) : H.profileFor(source, name);
    const fileSha256 = crypto.createHash('sha256').update('synthetic-' + ++attempt).digest('hex');
    const manifest = { sourceInstance: source === 'cash' ? 'cash-source' : 'trade-source', fileSha256, schemaSha256: profile.schemaSha256,
      expectedRows: rows.length, declaredRows: rows.length, snapshotAt: TIME, gates: [], ...extra };
    let run = await engine.start({ profileHash: profile.fingerprint, manifest });
    if (run.status === 'applied') return { ...run, fileSha256: manifest.fileSha256 };
    const prepared = rows.map((row, index) => isMaster ? M.prepareTradeFotoMasterRow(name, row, { fileSha256: manifest.fileSha256, rowNumber: index + 1 })
      : H.prepareTradeFotoHistoryRow(source, name, row, { fileSha256: manifest.fileSha256, rowNumber: index + 1 }));
    for (let i = 0; i < rows.length; i += C.LIMITS.batch) run = await engine.stage(run.id, { expectedRevision: run.revision, startRow: i + 1, rows: prepared.slice(i, i + C.LIMITS.batch) });
    run = await engine.seal(run.id, run.revision);
    do { run = await engine.review(run.id, run.revision); } while (run.status === 'reviewing');
    return { ...run, fileSha256: manifest.fileSha256 };
  }
  const records = (source, name) => source === 'master' ? app.database.prepare('SELECT id,revision FROM import_master_records WHERE source_table=? ORDER BY id').all(name)
    : app.database.prepare('SELECT id,revision FROM import_history_records WHERE source=? AND source_table=? ORDER BY id').all(source, name);
  async function ingest(source, name, rows, extra = {}) {
    let run = await ready(source, name, rows, extra), fileSha256 = run.fileSha256;
    if (run.status === 'applied') return { run, records: records(source, name), fileSha256 };
    assert.equal(run.status, 'ready', JSON.stringify(await engine.preview(run.id)));
    do { run = await engine.apply(run.id, run.revision); } while (run.status === 'applying');
    return { run, records: records(source, name), fileSha256 };
  }
  async function seedMasters() {
    const { records: [customer] } = await ingest('master', 'KUNDEN', [masterRaw('KUNDEN', { KUND_NR: '000419', VORNAME: 'Synthetic', NACHNAME: 'Customer' })]);
    const { records: [article] } = await ingest('master', 'ARTIKEL_STAMM', [masterRaw('ARTIKEL_STAMM', { EAN: '0000123', Artikelbezeichnung: 'Synthetic' })]);
    await ingest('master', 'MITARBEITER', [masterRaw('MITARBEITER', { Verkäufer_ID: '7' }), masterRaw('MITARBEITER', { Verkäufer_ID: '8' })]);
    const { records: [location] } = await ingest('master', 'FILIALEN', [masterRaw('FILIALEN', { FilialID: '1' })]);
    return { customer, article, location };
  }
  async function bind(recordId, targetId, historical = false) {
    const input = { recordId, expectedSourceRevision: 1, targetId, historical, reason: 'Synthetic explicit mapping' };
    const preview = await masters.previewBinding(input); return masters.bind(input, preview.planHash);
  }
  return { ...app, protection, context, engine, service, masters, ready, ingest, records, seedMasters, bind };
}

async function workspaceFixture(t, workspaceOptions = {}) {
  const f = await fixture(t), masters = await f.seedMasters();
  f.database.exec("INSERT INTO locations VALUES ('gp-1',1),('gp-2',1); INSERT INTO employees VALUES ('419',1),('430',1);");
  await f.bind(masters.location.id, 'gp-1');
  const other = await f.ingest('master', 'FILIALEN', [masterRaw('FILIALEN', { FilialID: '2' })]);
  const otherLocation = other.records.find(r => r.id !== masters.location.id); await f.bind(otherLocation.id, 'gp-2');
  for (const [key, target] of [['7', '419'], ['8', '430']]) {
    const identityHash = M.masterIdentity(f.protection, { ...f.context.who, sourceInstance: 'trade-source' }, 'MITARBEITER', [key]);
    const record = await f.provider.queryOne(MS.find, { identityHash, scopeId: 'scope' });
    await f.bind(record.id, target);
  }
  const input = { recordId: masters.customer.id, expectedSourceRevision: 1, decision: { customerType: 'private' } };
  const plan = await f.masters.previewCustomer(input), customer = await f.masters.syncCustomer(input, plan.planHash);
  const session = { employeeNumber: 'viewer', isEmployee: true, permissions: [HP.READ, AP.ACCESS, AP.LOCATION_READ], scopes: [{ locationId: 'gp-1', departmentId: 0 }] };
  const proofs = new Map(); let activePolicy = null;
  const workspace = createSalesHistoryWorkspace({ access: f.provider, protection: f.protection, getSession: () => session,
    getActor: () => f.context.who, today: () => '2026-09-05', sources: [{ id: 'cash', label: 'Synthetische Kasse', scopeId: 'scope', sourceInstance: 'cash-source',
      locations: [{ id: 'gp-1', label: 'Filiale 1' }, { id: 'gp-2', label: 'Filiale 2' }], snapshots: [{ id: SHA, label: 'Synthetischer Quellstand' }], coverageLabel: 'Ausschließlich synthetische Testdaten; keine Produktivfreigabe' }],
    getPolicy: () => activePolicy, getCoverage: (_source, id) => proofs.get(id) || null, ...workspaceOptions });
  async function receipt(h, lines) {
    const headers = await f.ingest('cash', 'Umsatz_KASSE', [h]);
    const imported = await f.ingest('cash', 'Umsatz_Kasse_Details', lines);
    // Resolve by the exact composite identity, never by UUID insertion order.
    const identityHash = H.historyIdentity(f.protection, { ...f.context.who, sourceInstance: 'cash-source' }, 'cash', 'Umsatz_KASSE', C.normalizeDataImportRow(H.profileFor('cash', 'Umsatz_KASSE'), h).key);
    const record = f.database.prepare('SELECT id FROM import_history_records WHERE identity_hash=?').get(identityHash);
    proofs.set(record.id, coverage(h, lines)); return { headers, imported, target: record.id };
  }
  return { ...f, session, workspace, customer, proofs, receipt, approve: () => { activePolicy = policy(); } };
}

test('Block 5: location-scoped search excludes foreign sales, including a stock branch matching the viewer', async t => {
  const f = await workspaceFixture(t);
  await f.receipt(head(), [line()]);
  await f.receipt(head({ Bonnr: '002', Filialid: '2' }), [line({ RepID: '00000000-0000-0000-0000-000000000002', Bonnr: '002', Filialid: '2', Bestandsfilialid: '1' })]);
  assert.deepEqual(f.workspace.context().sources[0].locations.map(l => l.id), ['gp-1']);
  const result = await f.workspace.search({ sourceId: 'cash' });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].receipt, '001'); assert.equal(result.totals, null);
  assert.equal(result.items[0].sellers, undefined); assert.equal(result.items[0].fields, undefined);
  assert.doesNotMatch(JSON.stringify(result), /000419|KUND_NR|Provision|RohertragDM|Verkäuferid/);
  await assert.rejects(f.workspace.search({ sourceId: 'cash', locationId: 'gp-2' }), code('IMPORT_FORBIDDEN'));
  f.session.scopes = [{ locationId: 'gp-1', departmentId: 10 }];
  await assert.rejects(f.workspace.search({ sourceId: 'cash' }), code('IMPORT_FORBIDDEN'));
});

test('Block 5: exact day/employee amounts use only checked matching positions, not the whole receipt or a seller fallback', async t => {
  const f = await workspaceFixture(t);
  const second = line({ RepID: '00000000-0000-0000-0000-000000000002', VK_Preis: '24', Verkäuferid: '7' });
  await f.receipt(head({ RechnungsBetrag: '36' }), [line(), second]); f.approve();
  f.session.permissions.push(HP.SELLERS);
  const own = await f.workspace.search({ sourceId: 'cash', sellerId: '430', sellerRole: 'line_seller', dateFrom: '2026-09-04', dateTo: '2026-09-04' });
  assert.equal(own.totals.gross, '12.00'); assert.equal(own.totals.net, '10.00'); assert.equal(own.days[0].gross, '12.00');
  assert.equal(own.items[0].sellers.header.targetId, '419'); assert.equal(own.items[0].sellers.line.targetId, '430');
  const byHead = await f.workspace.search({ sourceId: 'cash', sellerId: '419', sellerRole: 'header_seller' });
  assert.equal(byHead.totals.gross, '36.00'); assert.equal(byHead.items.length, 2);
  const wrongRole = await f.workspace.search({ sourceId: 'cash', sellerId: '430', sellerRole: 'header_seller' });
  assert.equal(wrongRole.items.length, 0); assert.equal(wrongRole.totals, null);
  f.session.permissions = f.session.permissions.filter(p => p !== HP.SELLERS);
  await assert.rejects(f.workspace.search({ sourceId: 'cash', sellerId: '430' }), code('IMPORT_FORBIDDEN'));
});

test('Block 5: CRM purchases need both rights and confirmed target binding; customer zero never becomes a person', async t => {
  const f = await workspaceFixture(t); await f.receipt(head(), [line()]);
  await f.receipt(head({ Bonnr: '002', KUND_NR: '0' }), [line({ RepID: '00000000-0000-0000-0000-000000000002', Bonnr: '002' })]);
  await assert.rejects(f.workspace.search({ sourceId: 'cash' }, { customerId: f.customer.targetId }), code('IMPORT_FORBIDDEN'));
  f.session.permissions.push(HP.CUSTOMER_PURCHASES, CP.ACCESS, CP.CUSTOMERS_READ);
  const result = await f.workspace.search({ sourceId: 'cash' }, { customerId: f.customer.targetId });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].receipt, '001');
  assert.equal((await f.workspace.search({ sourceId: 'cash' }, { customerId: '0' })).items.length, 0);
  assert.doesNotMatch(JSON.stringify(result.items), /000419|KUND_NR|Synthetic|Customer/);
});

test('Block 5: opaque cursors bind account, permissions, filters and revisions; no hidden cross-account continuation', async t => {
  const f = await workspaceFixture(t); await f.receipt(head({ RechnungsBetrag: '24' }), [line(), line({ RepID: '00000000-0000-0000-0000-000000000002' })]);
  const query = { sourceId: 'cash', limit: 1 }, first = await f.workspace.search(query);
  assert.ok(first.next); const second = await f.workspace.search({ ...query, cursor: first.next });
  assert.notEqual(second.items[0].id, first.items[0].id); assert.equal(second.next, null);
  await assert.rejects(f.workspace.search({ ...query, cursor: first.next + 'x' }), code('IMPORT_HISTORY_CURSOR'));
  await assert.rejects(f.workspace.search({ ...query, cursor: first.next, dateFrom: '2026-09-04' }), code('IMPORT_HISTORY_CURSOR'));
  f.context.who.ownerId = 'other'; await assert.rejects(f.workspace.search({ ...query, cursor: first.next }), code('IMPORT_HISTORY_CURSOR')); f.context.who.ownerId = 'actor';
  await f.ingest('cash', 'Umsatz_Kasse_Details', [line({ Artikelbezeichnung: 'Synthetische Änderung' })]);
  await assert.rejects(f.workspace.search({ ...query, cursor: first.next }), code('IMPORT_HISTORY_RESULTS_CHANGED'));
});

test('Block 5: unknown locations are visible only with company plus dedicated unassigned permission', async t => {
  const f = await workspaceFixture(t); await f.receipt(head({ Filialid: '9' }), [line({ Filialid: '9' })]);
  assert.equal((await f.workspace.search({ sourceId: 'cash' })).items.length, 0);
  f.session.permissions.push(AP.COMPANY_READ);
  assert.equal((await f.workspace.search({ sourceId: 'cash' })).items.length, 0);
  f.session.permissions.push(HP.UNASSIGNED); const result = await f.workspace.search({ sourceId: 'cash', locationId: 'unassigned' });
  assert.equal(result.items.length, 1); assert.equal(result.coverage.unresolved.location, 1); assert.equal(result.items[0].location.status, 'missing_source');
});

test('Block 5: daily/cash snapshots remain separate from sales and require finance rights plus an explicit snapshot', async t => {
  const f = await workspaceFixture(t);
  await f.ingest('cash', 'Tagesbericht', [raw('cash', 'Tagesbericht', { ZBon: '1', Bondatum: DAY, Filialid: '1', Einnahmen: '50', Ausgaben: '10' })], { fileSha256: SHA });
  await assert.rejects(f.workspace.search({ sourceId: 'cash', kind: 'daily', snapshot: SHA }), code('IMPORT_FORBIDDEN'));
  f.session.permissions.push(HP.FINANCE);
  await assert.rejects(f.workspace.search({ sourceId: 'cash', kind: 'daily' }), code('IMPORT_HISTORY_SNAPSHOT_REQUIRED'));
  const result = await f.workspace.search({ sourceId: 'cash', kind: 'daily', snapshot: SHA });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].inflow.startsWith('50'), true); assert.equal(result.totals, null);
  assert.ok(result.coverage.issues.includes('SEPARATE_CASH_DATA_NOT_SALES'));
});

test('Productive Block 2: batches withhold partial totals and continue to the complete period', async t => {
  const f = await workspaceFixture(t, { analysisLimit: 1 });
  assert.throws(() => createSalesHistoryWorkspace({ access: f.provider, protection: f.protection, sources: [],
    getSession: () => f.session, getActor: () => f.context.who }), code('IMPORT_COMPOSITION_INVALID'));
  await f.receipt(head({ RechnungsBetrag: '24' }), [line(), line({ RepID: '00000000-0000-0000-0000-000000000002' })]); f.approve();
  const result = await f.workspace.search({ sourceId: 'cash' });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].metric.gross, '12.00'); assert.equal(result.totals, null);
  assert.equal(result.coverage.complete, false); assert.ok(result.analysis.cursor);
  assert.equal(result.days[0].gross, null);
  const complete = await f.workspace.analyze({ query: { sourceId: 'cash' }, cursor: result.analysis.cursor });
  assert.equal(complete.coverage.complete, true); assert.equal(complete.totals.gross, '24.00');
  assert.equal(complete.coverage.counts.records, 2); assert.equal(complete.analysis.cursor, null);
  await assert.rejects(f.workspace.analyze({ query: { sourceId: 'cash' }, cursor: result.analysis.cursor }), code('IMPORT_HISTORY_ANALYSIS_CHANGED'));
  const page = await f.workspace.search({ sourceId: 'cash', cursor: result.next });
  assert.equal(page.items.length, 1); assert.equal(page.totals.gross, '24.00');
});

test('Productive Block 2: full year and CRM analyses process 5001 verified sales without truncation or double-counted pages', async t => {
  const f = await workspaceFixture(t), headers = [], lines = [];
  f.session.permissions.push(HP.SELLERS, HP.CUSTOMER_PURCHASES, CP.ACCESS, CP.CUSTOMERS_READ);
  for (let i = 0; i < 5001; i++) {
    const Bonnr = String(i + 1).padStart(6, '0'), Bondatum = i % 2 ? DAY : '2026-01-02T00:00:00.000';
    headers.push(head({ Bonnr, Bondatum }));
    lines.push(line({ Bonnr, Bondatum, RepID: '00000000-0000-0000-0000-' + String(i + 1).padStart(12, '0') }));
  }
  await f.ingest('cash', 'Umsatz_KASSE', headers);
  await f.ingest('cash', 'Umsatz_Kasse_Details', lines);
  for (let i = 0; i < headers.length; i++) {
    const identityHash = H.historyIdentity(f.protection, { ...f.context.who, sourceInstance: 'cash-source' }, 'cash', 'Umsatz_KASSE', C.normalizeDataImportRow(H.profileFor('cash', 'Umsatz_KASSE'), headers[i]).key);
    const record = await f.provider.queryOne(S.find, { identityHash, scopeId: 'scope' });
    f.proofs.set(record.id, coverage(headers[i], [lines[i]], { expectedSourceRows: 5001, verifiedSourceRows: 5001 }));
  }
  f.approve();
  const query = { sourceId: 'cash', sellerId: '430', limit: 100 }, options = { customerId: f.customer.targetId };
  let result = await f.workspace.search(query, options), next = result.next;
  assert.equal(result.items.length, 100); assert.equal(result.coverage.counts.records, 200); assert.equal(result.totals, null);
  let steps = 1;
  while (result.analysis.cursor) { result = await f.workspace.analyze({ query, cursor: result.analysis.cursor }, options); steps++; assert.ok(steps <= 26); }
  assert.equal(steps, 26); assert.equal(result.coverage.counts.records, 5001); assert.equal(result.coverage.counts.checked, 5001);
  assert.deepEqual(result.totals, { currency: 'EUR', gross: '60012.00', net: '50010.00', tax: '10002.00' });
  assert.equal(result.days.length, 2); assert.equal(result.days.reduce((n, d) => n + d.records, 0), 5001);
  assert.equal(result.coverage.scope, 'matching_imported_records');
  const page = await f.workspace.search({ ...query, cursor: next }, options);
  assert.equal(page.items.length, 100); assert.equal(page.coverage.counts.records, 5001); assert.equal(page.totals.gross, '60012.00');
});

test('Productive Block 2: analysis tokens reject account, permission, query, source and expiry changes', async t => {
  let clock = 1000;
  const f = await workspaceFixture(t, { analysisLimit: 1, now: () => clock });
  await f.receipt(head({ RechnungsBetrag: '24' }), [line(), line({ RepID: '00000000-0000-0000-0000-000000000002' })]); f.approve();
  const query = { sourceId: 'cash' }, first = await f.workspace.search(query), input = { query, cursor: first.analysis.cursor };
  f.session.employeeNumber = 'other'; await assert.rejects(f.workspace.analyze(input), code('IMPORT_HISTORY_CURSOR')); f.session.employeeNumber = 'viewer';
  f.session.permissions.push(HP.SELLERS); await assert.rejects(f.workspace.analyze(input), code('IMPORT_HISTORY_CURSOR')); f.session.permissions.pop();
  await assert.rejects(f.workspace.analyze({ ...input, query: { ...query, dateFrom: '2026-09-04' } }), code('IMPORT_HISTORY_CURSOR'));
  clock += 900001; await assert.rejects(f.workspace.analyze(input), code('IMPORT_HISTORY_CURSOR'));
  clock = 1000; const changed = await f.workspace.search(query);
  await f.receipt(head({ Bonnr: '999' }), [line({ Bonnr: '999', RepID: '00000000-0000-0000-0000-000000000003' })]);
  await assert.rejects(f.workspace.analyze({ query, cursor: changed.analysis.cursor }), code('IMPORT_HISTORY_RESULTS_CHANGED'));
});

test('Productive Block 2: empty and partially unverified selections never become a zero or partial revenue total', async t => {
  const f = await workspaceFixture(t, { analysisLimit: 1 });
  f.approve(); const empty = await f.workspace.search({ sourceId: 'cash' });
  assert.equal(empty.coverage.complete, true); assert.equal(empty.totals, null);
  await f.receipt(head({ RechnungsBetrag: '24' }), [line(), line({ RepID: '00000000-0000-0000-0000-000000000002', AStorno: true })]);
  let result = await f.workspace.search({ sourceId: 'cash' });
  while (result.analysis.cursor) result = await f.workspace.analyze({ query: { sourceId: 'cash' }, cursor: result.analysis.cursor });
  assert.equal(result.coverage.complete, true); assert.equal(result.totals, null); assert.equal(result.coverage.counts.review, 2);
  assert.ok(result.days.every(day => day.gross === null));
});

test('Block 4: pinned history metadata covers 43 tables / 433 fields without legacy access activation', () => {
  assert.deepEqual(H.TRADEFOTO_HISTORY_METADATA.coverage, { tables: 43, fields: 433 });
  assert.equal(H.TRADEFOTO_HISTORY_PROFILES.length, 43);
  assert.deepEqual(H.profileFor('cash', 'Umsatz_KASSE').keyFields, ['Bonnr', 'Filialid', 'Kassenid', 'Bondatum']);
  assert.deepEqual(H.profileFor('cash', 'Umsatz_Kasse_Details').keyFields, ['RepID']);
  for (const name of ['Tagesbericht', 'KassenJournal_Details']) assert.deepEqual(H.profileFor('cash', name).keyFields, ['_source_snapshot_sha256', '_source_row']);
  assert.throws(() => H.profileFor('trade', 'MITARBEITER'));
});

test('Block 4: reader retains civil time, leading zeros and fractional decimals; GUID keys have a single canonical form', () => {
  const prepared = H.prepareTradeFotoHistoryRow('cash', 'Umsatz_Kasse_Details', line({ RepID: '{ABCDEFAB-0000-0000-0000-000000000001}', VKMenge: 1e-7, Bondatum: new Date(DAY + 'Z') }));
  const result = C.normalizeDataImportRow(H.profileFor('cash', 'Umsatz_Kasse_Details'), prepared);
  assert.equal(result.key[0], 'abcdefab-0000-0000-0000-000000000001'); assert.equal(result.source.VKMenge, '0.0000001');
  assert.equal(result.source.Bondatum, DAY); assert.equal(result.source.EAN, '0000123');
  assert.throws(() => C.normalizeDataImportRow(H.profileFor('cash', 'Umsatz_Kasse_Details'), { ...prepared, RepID: '{not-guid}' }), code('IMPORT_GUID_INVALID'));
  assert.throws(() => H.prepareTradeFotoHistoryRow('cash', 'Umsatz_KASSE', head({ Bonnr: 9007199254740992 })), code('IMPORT_IDENTIFIER_PRECISION'));
  assert.throws(() => H.prepareTradeFotoHistoryRow('cash', 'Umsatz_KASSE', { ...head(), NewColumn: 'x' }), code('IMPORT_SHAPE_INVALID'));
});

test('Block 4: detail rows are quarantined before their exact composite head exists', async t => {
  const f = await fixture(t), run = await f.ready('cash', 'Umsatz_Kasse_Details', [line()]);
  assert.equal(run.status, 'needs_review'); assert.equal((await f.engine.preview(run.id)).rows[0].issue, 'HISTORY_PARENT_REQUIRED');
  assert.equal(f.records('cash', 'Umsatz_Kasse_Details').length, 0);
  await f.ingest('cash', 'Umsatz_KASSE', [head({ Kassenid: '2' })]);
  assert.equal((await f.ready('cash', 'Umsatz_Kasse_Details', [line()])).status, 'needs_review');
  await f.ingest('cash', 'Umsatz_KASSE', [head()]);
  await f.ingest('cash', 'Umsatz_Kasse_Details', [line()]);
});

test('Block 4: current or missing historical masters stay explicit; no placeholder CRM/article/employee is invented', async t => {
  const f = await fixture(t); await f.seedMasters();
  const { records: [h] } = await f.ingest('cash', 'Umsatz_KASSE', [head()]);
  const { records: [l] } = await f.ingest('cash', 'Umsatz_Kasse_Details', [line({ EAN: 'missing-historical' })]);
  const detail = await f.service.detail(l.id), refs = Object.fromEntries(detail.references.map(ref => [ref.role, ref]));
  assert.equal(refs.customer.status, 'unlinked'); assert.equal(refs.customer.key[0], '000419');
  assert.equal(refs.header_seller.key[0], '7'); assert.equal(refs.line_seller.key[0], '8');
  assert.equal(refs.article.status, 'missing_source'); assert.equal(detail.fields.Artikelbezeichnung, 'Synthetischer historischer Artikel');
  assert.equal(detail.provenance.parentId, h.id);
  for (const table of ['crm_customers', 'sales_articles', 'employees']) assert.equal(f.database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
});

test('Block 4: zero customer/header/line seller remain separately unassigned, never a seller fallback', async t => {
  const f = await fixture(t); await f.ingest('cash', 'Umsatz_KASSE', [head({ KUND_NR: '0', VerkäuferID: '0' })]);
  const { records: [l] } = await f.ingest('cash', 'Umsatz_Kasse_Details', [line({ Verkäuferid: '8' })]);
  const refs = Object.fromEntries((await f.service.detail(l.id)).references.map(ref => [ref.role, ref]));
  assert.equal(refs.customer.status, 'unassigned'); assert.equal(refs.header_seller.status, 'unassigned');
  assert.equal(refs.line_seller.status, 'missing_source'); assert.equal(refs.line_seller.targetId, null);
});

test('Block 4: repeated receipt/RepID is idempotent across files; same snapshot preserves real duplicate daily/journal rows', async t => {
  const f = await fixture(t); await f.ingest('cash', 'Umsatz_KASSE', [head()]); await f.ingest('cash', 'Umsatz_Kasse_Details', [line()]);
  const repeated = await f.ingest('cash', 'Umsatz_Kasse_Details', [line()]);
  assert.equal(repeated.run.counts.unchanged, 1); assert.equal(repeated.records.length, 1); assert.equal(repeated.records[0].revision, 1);
  const daily = raw('cash', 'Tagesbericht', { ZBon: '1', Bondatum: DAY, Einnahmen: '12', Ausgaben: '0' });
  const first = await f.ingest('cash', 'Tagesbericht', [daily, daily], { fileSha256: SHA }); assert.equal(first.records.length, 2);
  const again = await f.ingest('cash', 'Tagesbericht', [daily, daily], { fileSha256: SHA }); assert.equal(again.records.length, 2);
  const later = await f.ingest('cash', 'Tagesbericht', [daily, daily]); assert.equal(later.records.length, 4);
  await assert.rejects(f.service.list({ source: 'cash', table: 'Tagesbericht', sourceInstance: 'cash-source' }), code('IMPORT_HISTORY_SNAPSHOT_REQUIRED'));
  const list = await f.service.list({ source: 'cash', table: 'Tagesbericht', sourceInstance: 'cash-source', snapshot: SHA });
  assert.equal(list.items.length, 2); assert.equal(list.scope, 'page_only_no_totals');
});

test('Block 4: journal head is separate from its entries and does not become a sales receipt', async t => {
  const f = await fixture(t), detail = raw('cash', 'KassenJournal_Details', { Vorgang: '7', Einzahlung: '10', Auszahlung: '3' });
  assert.equal((await f.ready('cash', 'KassenJournal_Details', [detail])).status, 'needs_review');
  const { records: [journal] } = await f.ingest('cash', 'KassenJournal', [raw('cash', 'KassenJournal', { Vorgang: '7' })]);
  const { records } = await f.ingest('cash', 'KassenJournal_Details', [detail, detail]); assert.equal(records.length, 2);
  assert.equal((await f.service.detail(records[0].id)).provenance.parentId, journal.id);
  await assert.rejects(f.service.receipt(journal.id), code('IMPORT_HISTORY_NOT_A_RECEIPT'));
});

test('Block 4: encrypted versions retain old source amounts and immutable head pins after corrections', async t => {
  const f = await fixture(t), { records: [h] } = await f.ingest('cash', 'Umsatz_KASSE', [head()]);
  const { records: [l] } = await f.ingest('cash', 'Umsatz_Kasse_Details', [line()]);
  await f.ingest('cash', 'Umsatz_KASSE', [head({ RechnungsBetrag: '24' })]);
  assert.equal((await f.service.detail(h.id, { revision: 1 })).fields.RechnungsBetrag, '12');
  assert.equal((await f.service.detail(l.id)).provenance.parentRevision, 1);
  const check = await f.service.receipt(h.id, policy()); assert.ok(check.issues.includes('STALE_RECEIPT_PARENT_REVISION')); assert.equal(check.totals, null);
  const updated = await f.ingest('cash', 'Umsatz_Kasse_Details', [line({ VKMenge: '2' })]);
  assert.equal(updated.records[0].revision, 2); assert.equal((await f.service.detail(l.id)).provenance.parentRevision, 2);
  assert.equal((await f.service.receipt(h.id, policy(), coverage(head({ RechnungsBetrag: '24' }), [line({ VKMenge: '2' })]))).totals.gross, '24.00');
  const stored = f.database.prepare('SELECT payload FROM import_history_segments').all();
  assert.ok(stored.every(row => !row.payload.includes('Synthetischer') && !row.payload.includes('000419')));
});

test('Block 4: preview locks dependencies and source pairing; a late head change cannot be silently applied', async t => {
  const f = await fixture(t); await f.ingest('cash', 'Umsatz_KASSE', [head()]);
  const prepared = await f.ready('cash', 'Umsatz_Kasse_Details', [line()]);
  await f.ingest('cash', 'Umsatz_KASSE', [head({ RechnungsBetrag: '13' })]);
  await assert.rejects(f.engine.apply(prepared.id, prepared.revision), code('IMPORT_DEPENDENCIES_CHANGED'));
  assert.equal(f.records('cash', 'Umsatz_Kasse_Details').length, 0);
  f.context.paired = 'another-trade-source';
  await assert.rejects(f.ready('cash', 'Umsatz_Kasse_Details', [line()]), code('IMPORT_HISTORY_SOURCE_PAIR_CHANGED'));
});

test('Block 4: master holds prevent destructive CRM/binding/head undo until dependent history is undone', async t => {
  const f = await fixture(t), { customer } = await f.seedMasters();
  const input = { recordId: customer.id, expectedSourceRevision: 1, decision: { customerType: 'private' } };
  const preview = await f.masters.previewCustomer(input), sync = await f.masters.syncCustomer(input, preview.planHash);
  const h = await f.ingest('cash', 'Umsatz_KASSE', [head()]), l = await f.ingest('cash', 'Umsatz_Kasse_Details', [line()]);
  await assert.rejects(f.masters.undo(sync.eventId), code('IMPORT_UNDO_DEPENDENCIES'));
  await assert.rejects(f.engine.undo(h.run.id, h.run.revision), code('IMPORT_UNDO_DEPENDENCIES'));
  await f.engine.undo(l.run.id, l.run.revision); await f.engine.undo(h.run.id, h.run.revision);
  assert.equal(f.database.prepare('SELECT count(*) n FROM import_master_holds').get().n, 0);
  await f.masters.undo(sync.eventId);
});

test('Block 4: history undo restores the prior version on a NEW revision and keeps prior reference snapshot', async t => {
  const f = await fixture(t), first = await f.ingest('cash', 'Umsatz_KASSE', [head()]);
  const second = await f.ingest('cash', 'Umsatz_KASSE', [head({ RechnungsBetrag: '13' })]);
  await f.engine.undo(second.run.id, second.run.revision);
  const result = await f.service.detail(first.records[0].id); assert.equal(result.revision, 3); assert.equal(result.fields.RechnungsBetrag, '12');
  assert.equal(result.provenance.restoredFromRevision, 1);
  await f.engine.undo(first.run.id, first.run.revision); assert.equal(f.records('cash', 'Umsatz_KASSE').length, 0);
});

test('Block 4: a failing dependency hold rolls back history, versions, source links and checkpoint together', async t => {
  const f = await fixture(t); await f.seedMasters(); const prepared = await f.ready('cash', 'Umsatz_KASSE', [head()]);
  f.database.exec("CREATE TRIGGER fail_history_hold BEFORE INSERT ON import_master_holds BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  await assert.rejects(f.engine.apply(prepared.id, prepared.revision), code('IMPORT_OPERATION_FAILED'));
  assert.equal(f.records('cash', 'Umsatz_KASSE').length, 0); assert.equal(f.database.prepare('SELECT count(*) n FROM import_history_versions').get().n, 0);
  assert.equal((await f.engine.preview(prepared.id)).revision, prepared.revision);
  f.database.exec('DROP TRIGGER fail_history_hold'); await f.engine.apply(prepared.id, prepared.revision);
});

test('Block 4: customer/personnel/cost/finance permissions and document scope apply to every protected view', async t => {
  const f = await fixture(t); await f.ingest('cash', 'Umsatz_KASSE', [head()]);
  const { records: [l] } = await f.ingest('cash', 'Umsatz_Kasse_Details', [line({ RohertragDM: '8', Provision: '1' })]);
  f.context.deniedClasses = new Set(['personnel_restricted', 'catalog_costs', 'customer_restricted']);
  const partial = await f.service.detail(l.id); assert.equal(partial.partial, true);
  assert.equal(partial.fields.Verkäuferid, undefined); assert.equal(partial.fields.Provision, undefined); assert.equal(partial.fields.RohertragDM, undefined);
  assert.ok(!partial.references.some(ref => ['customer', 'header_seller', 'line_seller'].includes(ref.role)));
  await assert.rejects(f.service.receipt(partial.provenance.parentId, policy()), code('IMPORT_FORBIDDEN'));
  f.context.deniedClasses.clear(); f.context.rejectScope = true;
  await assert.rejects(f.service.detail(l.id), code('IMPORT_FORBIDDEN'));
  await assert.rejects(f.ready('cash', 'Umsatz_KASSE', [head({ Bonnr: 'forbidden' })]), code('IMPORT_FORBIDDEN'));
  f.context.rejectScope = false; f.context.who.scopeId = 'different';
  await assert.rejects(f.service.detail(l.id), code('IMPORT_HISTORY_NOT_FOUND'));
});

test('Block 4: metadata, ciphertext and lookup-index substitutions are detected', async t => {
  const f = await fixture(t), { records: [h] } = await f.ingest('cash', 'Umsatz_KASSE', [head()]);
  f.database.prepare('UPDATE import_history_references SET lookup_hash=? WHERE record_id=? AND role=?').run(SHA, h.id, 'customer');
  await assert.rejects(f.service.detail(h.id), code('IMPORT_HISTORY_INTEGRITY'));
  f.database.prepare('UPDATE import_history_references SET lookup_hash=NULL WHERE record_id=? AND role=?').run(h.id, 'customer');
  f.database.prepare('UPDATE import_history_versions SET file_sha256=? WHERE record_id=?').run(SHA, h.id);
  await assert.rejects(f.service.detail(h.id), code('IMPORT_PROTECTED_PAYLOAD_INVALID'));
});

test('Block 4: a new explicit mapping refreshes dependency snapshots without duplicating a source receipt', async t => {
  const f = await fixture(t); await f.seedMasters();
  const { records: [h] } = await f.ingest('cash', 'Umsatz_KASSE', [head()]);
  const before = await f.service.detail(h.id), seller = before.references.find(ref => ref.role === 'header_seller');
  f.database.exec("INSERT INTO employees VALUES('GP-419',1)"); await f.bind(seller.recordId, 'GP-419');
  const repeated = await f.ingest('cash', 'Umsatz_KASSE', [head()]);
  assert.equal(repeated.records.length, 1); assert.equal(repeated.records[0].revision, 2);
  const mapped = (await f.service.detail(h.id)).references.find(ref => ref.role === 'header_seller');
  assert.equal(mapped.targetId, 'GP-419'); assert.equal(mapped.key[0], '7'); assert.equal(mapped.status, 'linked');
  assert.equal((await f.service.detail(h.id, { revision: 1 })).references.find(ref => ref.role === 'header_seller').targetId, null);
  f.context.deniedTargets.add('GP-419');
  await assert.rejects(f.ready('cash', 'Umsatz_KASSE', [head()]), code('IMPORT_FORBIDDEN'));
});

test('Block 4: every selected history profile writes and reads a complete synthetic row', async t => {
  const f = await fixture(t);
  await f.ingest('cash', 'Umsatz_KASSE', [head()]); await f.ingest('cash', 'KassenJournal', [raw('cash', 'KassenJournal', { Vorgang: '7' })]);
  for (const table of H.TRADEFOTO_HISTORY_METADATA.tables) {
    if (table.name === 'Umsatz_KASSE' || table.name === 'KassenJournal') continue;
    let value = raw(table.source, table.name);
    for (const key of table.keys || []) value[key] = H.profileFor(table.source, table.name).fields.find(f => f.source === key).type === 'guid' ? '00000000-0000-0000-0000-000000000001' : 'synthetic-key';
    if (table.name === 'Umsatz_Kasse_Details') value = line();
    if (table.name === 'KassenJournal_Details') value.Vorgang = '7';
    const { records: [record] } = await f.ingest(table.source, table.name, [value]);
    const detail = await f.service.detail(record.id); assert.equal(Object.keys(detail.fields).length, table.columns.length, table.name);
  }
  assert.equal(f.database.prepare('SELECT count(DISTINCT source_table) n FROM import_history_records').get().n, 43);
});

test('Productive Block 1: history statements compile portably and runtime is composed with apply disabled', () => {
  assert.equal(SQLITE_IMPORT_HISTORY_CATALOG.length, 23); assert.equal(Object.keys(S).length, 23);
  for (const entry of SQLITE_IMPORT_HISTORY_CATALOG) assert.equal(compilePostgresqlDialectEntry(entry).strategy, 'portable-generated', entry.statement.id);
  assert.ok(!/AUTOINCREMENT|PRAGMA|rowid|json_|RAISE\(/iu.test(IMPORT_HISTORY_SCHEMA_SQL));
  const catalog=require('../lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG;
  assert.ok(SQLITE_IMPORT_HISTORY_CATALOG.every(e=>catalog.some(c=>c.statement===e.statement)));
  assert.match(fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),/createDataImportRuntime\(\{[^}]*allowApply: false/);
});

const reconcile = (heads, lines, options = {}) => R.reconcileTradeFotoReceipt({ head: heads, lines: lines.map(source => ({ source, parentRevision: 1 })),
  headRevision: 1, snapshotDate: '2026-09-05', scopeId: 'scope', sourceInstance: 'cash-source', policy: policy(), coverage: coverage(heads, lines), ...options });

test('Productive Block 1: an explicitly verified placeholder head never erases signed final-price sales or zero lines',()=>{
  const header=head({RechnungsBetrag:'0'}),rows=[line({VK_Preis:'600.78',MWST:'20',AStorno:true,Ret:false,NachlaßDM:'10'}),
    line({RepID:'00000000-0000-0000-0000-000000000002',VK_Preis:'75',VKMenge:'-1',MWST:'20',AStorno:true,Ret:false})];
  const rules=[{id:'sale-a',status:'sale',quantitySign:'positive',flags:{...flags,AStorno:true}},
    {id:'return-a',status:'return',quantitySign:'negative',flags:{...flags,AStorno:true}}];
  const verified=policy({headerZeroMeaning:'unavailable',vatRates:{20:'20'},statusRules:rules});
  const result=reconcile(header,rows,{policy:verified});assert.equal(result.totals.gross,'525.78');assert.equal(result.totals.net,'438.15');
  assert.equal(result.reconciliation.headerStatus,'unavailable_zero_placeholder');assert.equal(result.reconciliation.difference,null);
  assert.equal(header.RechnungsBetrag,'0');assert.equal(rows[0].NachlaßDM,'10');
  assert.equal(reconcile(header,rows,{policy:policy({vatRates:{20:'20'},statusRules:rules})}).totals,null);
  assert.equal(reconcile(header,rows,{policy:verified,coverage:null}).totals,null);
  assert.equal(reconcile(head({RechnungsBetrag:'1'}),rows,{policy:verified}).totals,null);
  const zero=line({VK_Preis:'0',VKMenge:'5',MWST:'20',AStorno:true});const zeroResult=reconcile(header,[zero],{policy:verified});
  assert.equal(zeroResult.totals.gross,'0.00');assert.equal(zeroResult.counts.lines,1);assert.equal(zeroResult.positions.length,1);
  assert.throws(()=>policy({headerZeroMeaning:'ignore'}),code('IMPORT_SALES_POLICY_INVALID'));
});
test('Block 4: default sales gate stays closed, including heads without details', () => {
  const result = reconcile(head(), [], { policy: null }); assert.equal(result.canAggregate, false); assert.equal(result.totals, null);
  assert.ok(result.issues.includes('SALES_SEMANTICS_UNCONFIRMED')); assert.ok(result.issues.includes('RECEIPT_WITHOUT_LINES'));
  assert.throws(() => reconcile(head(), [line()], { policy: { ...policy() } }), code('IMPORT_SALES_POLICY_UNTRUSTED'));
  assert.throws(() => reconcile(head(), [line()], { sourceInstance: 'different' }), code('IMPORT_SALES_POLICY_SCOPE'));
});
test('Block 4: exact decimal arithmetic handles sales, fractional quantities, returns and discounts already in final price', () => {
  const result = reconcile(head({ RechnungsBetrag: '24.00' }), [line({ VKMenge: '2.5', Rabatt_DM: '3', Rabatt: '10' }), line({ RepID: '00000000-0000-0000-0000-000000000002', VKMenge: '-0.5' })]);
  assert.equal(result.canAggregate, true); assert.deepEqual(result.totals, { currency: 'EUR', gross: '24.00', net: '20.00', tax: '4.00' });
  assert.equal(result.counts.sales, 1); assert.equal(result.counts.returns, 1);
  const rounded = reconcile(head({ RechnungsBetrag: '0.01' }), [line({ VKMenge: '0.1', VK_Preis: '0.05' })]); assert.equal(rounded.totals.gross, '0.01');
  const negative = reconcile(head({ RechnungsBetrag: '-0.01' }), [line({ VKMenge: '-0.1', VK_Preis: '0.05' })]); assert.equal(negative.totals.gross, '-0.01');
});
test('Block 4: explicit net and line-final price meanings do not multiply or discount twice', () => {
  const net = reconcile(head(), [line({ VK_Preis: '10' })], { policy: policy({ priceBasis: 'net' }) }); assert.equal(net.totals.gross, '12.00');
  const final = reconcile(head(), [line({ VKMenge: '3', VK_Preis: '12', NachlaßDM: '4' })], { policy: policy({ priceMeaning: 'final_line' }) }); assert.equal(final.totals.gross, '12.00');
});
test('Block 4: unknown/ambiguous status, VAT, amounts and incomplete totals fail closed', () => {
  for (const [extra, issue] of [[{ AStorno: true }, 'STATUS_REVIEW_REQUIRED'], [{ MWST: '99' }, 'VAT_CODE_UNKNOWN'], [{ VK_Preis: '-12' }, 'NEGATIVE_UNIT_PRICE_REVIEW'], [{ VKMenge: null }, 'IMPORT_SALES_DECIMAL_INVALID']]) {
    const result = reconcile(head(), [line(extra)]); assert.equal(result.canAggregate, false); assert.equal(result.totals, null); assert.ok(result.issues.includes(issue));
  }
  const ambiguous = policy({ statusRules: [{ id: 'a', status: 'sale', quantitySign: 'positive', flags }, { id: 'b', status: 'sale', quantitySign: 'any', flags }] });
  assert.ok(reconcile(head(), [line()], { policy: ambiguous }).issues.includes('STATUS_RULE_AMBIGUOUS'));
  assert.ok(reconcile(head({ RechnungsBetrag: '13' }), [line()]).issues.includes('RECEIPT_AMOUNT_MISMATCH'));
  assert.ok(reconcile(head(), [line()], { lines: [{ source: line({ Filialid: '2' }), parentRevision: 1 }] }).issues.includes('RECEIPT_LINE_KEY_MISMATCH'));
  assert.ok(reconcile(head({ Bondatum: '2026-12-30T00:00:00.000' }), []).issues.includes('BUSINESS_DATE_REVIEW_REQUIRED'));
  const voided = reconcile(head({ RechnungsBetrag: '0' }), [line({ BStorno: true })]); assert.equal(voided.canAggregate, true); assert.equal(voided.counts.excluded, 1);
});

test('Block 4: a matching receipt amount cannot hide omitted zero/void lines or incomplete source coverage', () => {
  const missing = reconcile(head(), [line()], { coverage: null }); assert.equal(missing.canAggregate, false); assert.equal(missing.totals, null);
  const second = line({ RepID: '00000000-0000-0000-0000-000000000002', BStorno: true });
  const incomplete = reconcile(head(), [line()], { coverage: coverage(head(), [line(), second]) });
  assert.ok(incomplete.issues.includes('RECEIPT_SOURCE_COVERAGE_MISMATCH')); assert.equal(incomplete.totals, null);
  assert.throws(() => coverage(head(), [line()], { expectedSourceRows: 2 }), code('IMPORT_SALES_COVERAGE_INCOMPLETE'));
  assert.throws(() => coverage(head(), [line(), line()]), code('IMPORT_SALES_COVERAGE_LINES'));
  assert.throws(() => reconcile(head(), [line()], { coverage: { ...coverage(head(), [line()]) } }), code('IMPORT_SALES_COVERAGE_UNTRUSTED'));
});

test('Block 4: Access Float round-trip digits are retained, not rejected at twelve decimals or silently rounded', async t => {
  const f = await fixture(t), original = Math.fround(12.34);
  assert.equal(String(original), '12.34000015258789');
  const source = head({ RechnungsBetrag: original }), { records: [h] } = await f.ingest('cash', 'Umsatz_KASSE', [source]);
  assert.equal((await f.service.detail(h.id)).fields.RechnungsBetrag, String(original));
  await f.ingest('cash', 'Umsatz_Kasse_Details', [line({ VK_Preis: '12.34' })]);
  const prepared = H.prepareTradeFotoHistoryRow('cash', 'Umsatz_KASSE', source);
  assert.equal((await f.service.receipt(h.id, policy(), coverage(prepared, [line({ VK_Preis: '12.34' })]))).totals.gross, '12.34');
  const tiny = H.prepareTradeFotoHistoryRow('cash', 'Umsatz_Kasse_Details', line({ VKMenge: Number.MIN_VALUE }));
  assert.ok(C.normalizeDataImportRow(H.profileFor('cash', 'Umsatz_Kasse_Details'), tiny).source.VKMenge.endsWith('5'));
});

test('Block 4: a partially applied source cannot release receipt totals, even when this receipt is already present', async t => {
  const f = await fixture(t), { records: [h] } = await f.ingest('cash', 'Umsatz_KASSE', [head()]);
  const rows = Array.from({ length: 201 }, (_, i) => line({ RepID: '00000000-0000-0000-0000-' + String(i + 1).padStart(12, '0'), ...(i ? { BStorno: true } : {}) }));
  const run = await f.ready('cash', 'Umsatz_Kasse_Details', rows), part = await f.engine.apply(run.id, run.revision);
  assert.equal(part.status, 'applying');
  const checked = await f.service.receipt(h.id, policy(), coverage(head(), rows)); assert.equal(checked.canAggregate, false); assert.deepEqual(checked.issues, ['SOURCE_IMPORT_NOT_COMPLETE']);
  await f.engine.apply(run.id, part.revision);
  assert.equal((await f.service.receipt(h.id, policy(), coverage(head(), rows))).totals.gross, '12.00');
});

test('Block 4: branch revocation blocks undo as well as detail/apply and leaves all protected rows intact', async t => {
  const f = await fixture(t), { run } = await f.ingest('cash', 'Umsatz_KASSE', [head()]);
  f.context.rejectScope = true; await assert.rejects(f.engine.undo(run.id, run.revision), code('IMPORT_FORBIDDEN'));
  assert.equal(f.records('cash', 'Umsatz_KASSE').length, 1);
});

test('Block 4: article references use only the central source binding and never rewrite current article prices', async t => {
  const f = await fixture(t), { article: source } = await f.seedMasters();
  const article = { sourceArticleKey: '0000123', articleNumber: '00123', description: 'Synthetic central article', active: true, sourceUpdatedAt: null, identifiers: [],
    prices: [{ priceType: 'sales', amount: '99.00', currency: 'EUR', priceBasis: 'gross', qualityStatus: 'confirmed', sourceField: 'Verkaufspreis' }] };
  const repository = createSalesArticleCatalogRepository(f.provider);
  await repository.importSnapshot({ snapshot: { sourceSystem: TRADEFOTO_ARTICLE_SOURCE_SYSTEM, sourceProfileVersion: 'synthetic.v1', sourceSchemaSha256: SHA,
    sourceFileSha256: SHA, snapshotAt: TIME, articles: [article], contentSha256: salesArticleImportContentSha256([article]) }, actor: 'synthetic', timestamp: TIME });
  const before = await repository.getByArticleNumber('00123');
  const input = { recordId: source.id, expectedSourceRevision: 1, historical: false, reason: 'Synthetic source link' }, approved = await f.masters.previewBinding(input);
  await f.masters.bind(input, approved.planHash);
  await f.ingest('cash', 'Umsatz_KASSE', [head()]); const { records: [l] } = await f.ingest('cash', 'Umsatz_Kasse_Details', [line()]);
  const ref = (await f.service.detail(l.id)).references.find(ref => ref.role === 'article');
  assert.equal(ref.targetId, before.productId); assert.equal(ref.status, 'linked');
  assert.deepEqual(await repository.getByArticleNumber('00123'), before);
});

test('Block 4: stock and price protocols remain source-specific, limited history; no current stock or price changes', async t => {
  const f = await fixture(t), value = { ID: '00000000-0000-0000-0000-000000000099', Aenderung: DAY, FilialID: '1', EAN: '0000123', Bestand: '10', AlterBestand: 8 };
  const a = await f.ingest('trade', 'tblProtBestand', [raw('trade', 'tblProtBestand', value)]);
  const b = await f.ingest('trade', 'tblProtBestand_comp', [raw('trade', 'tblProtBestand_comp', value)]);
  assert.notEqual(a.records[0].id, b.records[0].id);
  const prices = await f.ingest('trade', 'tblProtPreis', [raw('trade', 'tblProtPreis', { Aenderung: DAY, EAN: '0000123', NVKPreis: '19.90' })]);
  const detail = await f.service.detail(prices.records[0].id); assert.equal(detail.fields.NVKPreis.startsWith('19.9'), true);
  assert.equal(f.database.prepare('SELECT count(*) n FROM sales_articles').get().n, 0);
  await assert.rejects(f.service.receipt(a.records[0].id), code('IMPORT_HISTORY_NOT_A_RECEIPT'));
});

test('Block 4: financial segments require finance permission and retained free text is never executed', async t => {
  const f = await fixture(t), { records: [j] } = await f.ingest('cash', 'KassenJournal', [raw('cash', 'KassenJournal', { Vorgang: '7' })]);
  const text = '<script>synthetic only</script> \\server\\not-opened.txt';
  const { records: [d] } = await f.ingest('cash', 'KassenJournal_Details', [raw('cash', 'KassenJournal_Details', { Vorgang: '7', Beschreibung: text, Einzahlung: '12', Auszahlung: '3' })]);
  assert.equal((await f.service.detail(d.id)).fields.Beschreibung, text);
  f.context.deniedClasses.add('restricted_finance');
  const hidden = await f.service.detail(d.id); assert.deepEqual(hidden.fields, {}); assert.ok(hidden.omittedClasses.includes('restricted_finance'));
  assert.equal(hidden.provenance.parentId, j.id);
});

test('Block 4: explicit inactive seller mapping stays historical and a revoked target is not silently reused', async t => {
  const f = await fixture(t); f.database.exec("INSERT INTO employees VALUES('GP-old',0)");
  const { records: [seller] } = await f.ingest('master', 'MITARBEITER', [masterRaw('MITARBEITER', { Verkäufer_ID: '7' })]);
  await f.bind(seller.id, 'GP-old', true);
  const { records: [h] } = await f.ingest('cash', 'Umsatz_KASSE', [head()]);
  assert.equal((await f.service.detail(h.id)).references.find(ref => ref.role === 'header_seller').status, 'historical_mapping');
  f.context.deniedTargets.add('GP-old');
  assert.ok(!(await f.service.detail(h.id)).references.some(ref => ref.role === 'header_seller'));
});

test('Block 4: history follow-up hold and row-level foreign keys block removal; earlier versions remain readable', async t => {
  const f = await fixture(t), { records: [h], run } = await f.ingest('cash', 'Umsatz_KASSE', [head()]);
  await f.provider.execute(S.insertHold, { recordId: h.id, consumerId: 'synthetic-report' });
  await assert.rejects(f.engine.undo(run.id, run.revision), code('IMPORT_UNDO_DEPENDENCIES'));
  await f.provider.execute(S.removeHold, { recordId: h.id, consumerId: 'synthetic-report' });
  const { records: [l] } = await f.ingest('cash', 'Umsatz_Kasse_Details', [line()]);
  assert.throws(() => f.database.prepare('DELETE FROM import_history_versions WHERE record_id=?').run(h.id));
  assert.throws(() => f.database.prepare('UPDATE import_history_versions SET parent_revision=999 WHERE record_id=?').run(l.id));
  assert.equal((await f.service.detail(h.id, { revision: 1 })).fields.Bonnr, '001');
});

test('Block 4: history pages are bounded and source/account scope is mandatory, not an implicit cross-branch report', async t => {
  const f = await fixture(t); await f.ingest('cash', 'Umsatz_KASSE', [head(), head({ Bonnr: '002' }), head({ Bonnr: '003' })]);
  const first = await f.service.list({ source: 'cash', table: 'Umsatz_KASSE', sourceInstance: 'cash-source', limit: 2 }); assert.equal(first.items.length, 2); assert.ok(first.next);
  const second = await f.service.list({ source: 'cash', table: 'Umsatz_KASSE', sourceInstance: 'cash-source', limit: 2, after: first.next }); assert.equal(second.items.length, 1); assert.equal(second.next, null);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 3);
  f.context.denied.add('history.list'); await assert.rejects(f.service.list({ source: 'cash', table: 'Umsatz_KASSE', sourceInstance: 'cash-source' }), code('IMPORT_FORBIDDEN'));
});
