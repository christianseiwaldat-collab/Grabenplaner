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
  const app = openSqliteApplicationPersistence({ databasePath: options.databasePath || ':memory:', catalog: SQLITE_APPLICATION_CATALOG });
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
  f.history = (options = {}) => createManagedSalesHistoryRuntime({ access: app.provider, vault, scopeId: actor.scopeId, cashEnabled: true, today: () => '2026-09-07', ...options });
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
async function reportPdfText(buffer) {
  assert.ok(Buffer.isBuffer(buffer)); assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false });
  const document = await loading.promise;
  try {
    const pages = [];
    for (let i = 1; i <= document.numPages; i++) pages.push((await (await document.getPage(i)).getTextContent()).items.map(t => t.str).join(' '));
    return pages.join('\n');
  } finally { await loading.destroy(); }
}

test('durable report jobs complete both periods and encrypt PDF results, with personal ownership and fresh download rights', async t => {
  const f = await fixture(t, { count: 205 }); await f.activate();
  const { createSalesReportJobs } = require('../lib/persistence/repositories/sales-report-jobs');
  const jobs = createSalesReportJobs({ access: f.app.provider, vault: f.vault, runtime: f.history(), resolvePrincipal: f.get, scope: f.actor.scopeId });
  const job = await jobs.create(f.session, { title: '<Private report>', query: f.query() });
  assert.equal(job.status, 'queued'); await jobs.tick();
  assert.equal((await jobs.list(f.session))[0].processed, 200);
  await jobs.tick(); assert.equal((await jobs.list(f.session))[0].phase, 'comparison');
  await jobs.tick(); const done = (await jobs.list(f.session))[0];
  assert.equal(done.status, 'completed'); assert.equal(done.processed, 205);
  const text = await reportPdfText(await jobs.download(f.session, job.id));
  assert.match(text, /2[.\s]?050,00/); assert.match(text, /<Private report>/); assert.doesNotMatch(text, /KUND_NR|00031|Synthetic article/);
  assert.equal(done.format, 'pdf'); assert.match(text, /Nicht verfügbar/);
  assert.doesNotMatch(JSON.stringify(f.app.database.prepare('SELECT * FROM sales_report_jobs').all()), /Private report|2460.00|admin-1/);
  const other = { ...f.session, employeeNumber: 'admin-2' };
  assert.equal((await jobs.list(other)).length, 0);
  for (const action of ['download', 'cancel', 'remove']) await assert.rejects(jobs[action](other, job.id), code('IMPORT_HISTORY_NOT_FOUND'));
  const reduced = { ...f.session, permissions: f.session.permissions.filter(p => p !== 'sales:history:sellers:read') };
  await assert.rejects(jobs.download(reduced, job.id), code('IMPORT_FORBIDDEN'));
  await jobs.remove(f.session, job.id); assert.equal((await jobs.list(f.session)).length, 0);
});

test('the real background worker reads a separate file connection and produces the same PDF totals', async t => {
  const fs = require('node:fs'), path = require('node:path');
  const root = fs.realpathSync(path.resolve(__dirname, '../tmp')), dir = fs.mkdtempSync(path.join(root, 'report-worker-'));
  const databasePath = path.join(dir, 'source.db'), f = await fixture(t, { databasePath, count: 205 });
  await f.activate();
  const { createSalesReportBatchWorker } = require('../lib/sales-report-batch-worker');
  const batchWorker = createSalesReportBatchWorker({ databasePath, scopeId: f.actor.scopeId, today: '2026-09-07',
    keyConfiguration: { activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 12).toString('base64') } } });
  const { createSalesReportJobs } = require('../lib/persistence/repositories/sales-report-jobs');
  const jobs = createSalesReportJobs({ access: f.app.provider, vault: f.vault, runtime: f.history(), resolvePrincipal: f.get, scope: f.actor.scopeId, batchWorker });
  t.after(async () => { await jobs.stop(); assert.equal(fs.realpathSync(path.dirname(dir)), root); fs.rmSync(dir, { recursive: true }); });
  const before = f.app.database.prepare('SELECT * FROM cash_snapshot_inventory ORDER BY dataset_slot,table_index').all();
  const job = await jobs.create(f.session, { query: f.query({ reportVersion: 3, orientation: 'landscape', chartType: 'bars' }) });
  await jobs.tick(); assert.equal((await jobs.list(f.session))[0].processed, 200);
  await jobs.tick(); await jobs.tick();
  assert.equal((await jobs.list(f.session))[0].status, 'completed');
  assert.match(await reportPdfText(await jobs.download(f.session, job.id)), /2[.\s]?050,00/);
  assert.deepEqual(f.app.database.prepare('SELECT * FROM cash_snapshot_inventory ORDER BY dataset_slot,table_index').all(), before);
});

test('background results cannot survive mid-batch rights revocation or cancellation', async t => {
  const f = await fixture(t); await f.activate(); const original = f.session;
  const { createSalesReportJobs } = require('../lib/persistence/repositories/sales-report-jobs');
  let cancelId = null;
  const batchWorker = { async run() {
    if (cancelId) await jobs.cancel(original, cancelId); else f.session = { ...original, permissions: [] };
    return { analysis: { complete: true, processed: 1 }, artifact: Buffer.from('%PDF-Synthetic').toString('base64') };
  }, async stop() {} };
  const jobs = createSalesReportJobs({ access: f.app.provider, vault: f.vault, runtime: f.history(), resolvePrincipal: f.get, scope: f.actor.scopeId, batchWorker });
  const revoked = await jobs.create(original, { query: f.query() }); await jobs.tick(); f.session = original;
  assert.equal((await jobs.list(original))[0].error, 'IMPORT_FORBIDDEN');
  await assert.rejects(jobs.download(original, revoked.id), code('IMPORT_HISTORY_NOT_FOUND'));
  const cancelled = await jobs.create(original, { query: f.query() }); cancelId = cancelled.id; await jobs.tick();
  assert.equal((await jobs.list(original)).find(row => row.id === cancelled.id).status, 'cancelled');
  await assert.rejects(jobs.download(original, cancelled.id), code('IMPORT_HISTORY_NOT_FOUND'));
});

test('report job lease recovery restarts exactly once without duplicate totals and isolates concurrent workers', async t => {
  const f = await fixture(t, { count: 205 }); await f.activate(); let time = Date.parse(TIME);
  const { createSalesReportJobs } = require('../lib/persistence/repositories/sales-report-jobs');
  const make = () => createSalesReportJobs({ access: f.app.provider, vault: f.vault, runtime: f.history(), resolvePrincipal: f.get, scope: f.actor.scopeId, now: () => time });
  const first = make(), second = make(); const job = await first.create(f.session, { query: f.query() });
  await first.tick(); await second.tick(); assert.equal((await second.list(f.session))[0].restarts, 0);
  await first.stop(); time += 31000; await second.tick();
  assert.equal((await second.list(f.session))[0].restarts, 1); assert.equal((await second.list(f.session))[0].processed, 200);
  await second.tick(); await second.tick(); assert.match(await reportPdfText(await second.download(f.session, job.id)), /2[.\s]?050,00/);
});

test('an incident pause prevents background claims while retaining queued jobs, cancellation and completed downloads', async t => {
  const f = await fixture(t); await f.activate();
  const { createSalesReportJobs } = require('../lib/persistence/repositories/sales-report-jobs');
  const runtime = f.history(); let runs = 0;
  const jobs = createSalesReportJobs({ access: f.app.provider, vault: f.vault,
    runtime: { async run(get, work) { runs++; return runtime.run(get, work); } }, resolvePrincipal: f.get, scope: f.actor.scopeId });
  const completed = await jobs.create(f.session, { query: f.query() }); await jobs.tick(); await jobs.tick();
  const pdf = await jobs.download(f.session, completed.id);
  f.app.database.exec(`CREATE TRIGGER gp_incident_20260910_pause_sales_reports
    BEFORE UPDATE OF status ON sales_report_jobs WHEN NEW.status='running'
    BEGIN SELECT RAISE(IGNORE); END`);
  const queued = await jobs.create(f.session, { query: f.query() });
  const cancelled = await jobs.create(f.session, { query: f.query() });
  const before = f.app.database.prepare('SELECT id,status,revision,payload FROM sales_report_jobs WHERE id=?').get(queued.id);
  const beforeRuns = runs;
  for (let i = 0; i < 3; i++) await jobs.tick();
  assert.equal(runs, beforeRuns, 'paused claim must never reach report calculation');
  assert.deepEqual(f.app.database.prepare('SELECT id,status,revision,payload FROM sales_report_jobs WHERE id=?').get(queued.id), before);
  assert.deepEqual(await jobs.download(f.session, completed.id), pdf);
  await jobs.cancel(f.session, cancelled.id);
  assert.equal((await jobs.list(f.session)).find(row => row.id === cancelled.id).status, 'cancelled');
  f.app.database.exec('DROP TRIGGER gp_incident_20260910_pause_sales_reports');
  await jobs.tick(); await jobs.tick();
  assert.equal((await jobs.list(f.session)).find(row => row.id === queued.id).status, 'completed');
});

test('report jobs enforce queue bounds, cancellation, revoked rights and pinned publication', async t => {
  const f = await fixture(t, { count: 205 }); await f.activate();
  const { createSalesReportJobs } = require('../lib/persistence/repositories/sales-report-jobs');
  const jobs = createSalesReportJobs({ access: f.app.provider, vault: f.vault, runtime: f.history(), resolvePrincipal: f.get, scope: f.actor.scopeId });
  const a = await jobs.create(f.session, { query: f.query() }), b = await jobs.create(f.session, { query: f.query() }), c = await jobs.create(f.session, { query: f.query() });
  await assert.rejects(jobs.create(f.session, { query: f.query() }), code('IMPORT_HISTORY_ANALYSIS_BUSY'));
  await jobs.cancel(f.session, a.id); await jobs.cancel(f.session, b.id); await jobs.cancel(f.session, c.id);
  await jobs.tick(); assert.ok((await jobs.list(f.session)).every(r => r.status === 'cancelled'));
  const d = await jobs.create(f.session, { query: f.query() }); const original = f.session;
  f.session = { ...original, permissions: [] }; await jobs.tick(); f.session = original;
  assert.equal((await jobs.list(f.session)).find(r => r.id === d.id).error, 'IMPORT_FORBIDDEN');
  const e = await jobs.create(f.session, { query: f.query() });
  const id = await f.build(rows({ price: '24' })); await f.activate(f.request(id, 1)); await jobs.tick();
  assert.equal((await jobs.list(f.session)).find(r => r.id === e.id).error, 'IMPORT_HISTORY_ANALYSIS_CHANGED');
});

test('cancellation during report completion wins the revision race and corrupt jobs do not block the queue', async t => {
  const f = await fixture(t); await f.activate();
  const { createSalesReportJobs } = require('../lib/persistence/repositories/sales-report-jobs');
  const base = f.history(); let cancelId = null;
  const runtime = { async run(get, work) { const result = await base.run(get, work); if (cancelId) { const id = cancelId; cancelId = null; await jobs.cancel(f.session, id); } return result; } };
  const jobs = createSalesReportJobs({ access: f.app.provider, vault: f.vault, runtime, resolvePrincipal: f.get, scope: f.actor.scopeId });
  const job = await jobs.create(f.session, { query: f.query() }); cancelId = job.id; await jobs.tick();
  assert.equal((await jobs.list(f.session))[0].status, 'cancelled'); await assert.rejects(jobs.download(f.session, job.id), code('IMPORT_HISTORY_NOT_FOUND'));
  const bad = await jobs.create(f.session, { query: f.query() }), good = await jobs.create(f.session, { query: f.query() });
  f.app.database.prepare("UPDATE sales_report_jobs SET payload='invalid',updated='2000-01-01T00:00:00.000Z' WHERE id=?").run(bad.id);
  await jobs.tick(); await jobs.tick(); await jobs.tick(); const rows = await jobs.list(f.session);
  assert.equal(rows.find(r => r.id === bad.id).status, 'failed'); assert.equal(rows.find(r => r.id === good.id).status, 'completed');
});

test('completed background reports release checkpoints before the global analysis limit is reached', async t => {
  const f = await fixture(t); await f.activate();
  const { createSalesReportJobs } = require('../lib/persistence/repositories/sales-report-jobs');
  const jobs = createSalesReportJobs({ access: f.app.provider, vault: f.vault, runtime: f.history({ retainCompletedAnalyses: false }), resolvePrincipal: f.get, scope: f.actor.scopeId });
  for (let i = 0; i < 66; i++) {
    f.session = { ...f.session, employeeNumber: 'report-owner-' + i };
    const job = await jobs.create(f.session, { query: f.query() }); await jobs.tick(); await jobs.tick();
    assert.equal((await jobs.download(f.session, job.id)).subarray(0, 5).toString(), '%PDF-');
  }
});

test('legacy queued HTML reports retain their original authority and source contract', async t => {
  const f = await fixture(t); await f.activate();
  const { createSalesReportJobs } = require('../lib/persistence/repositories/sales-report-jobs');
  const { SALES_REPORT_JOB_STATEMENTS: S } = require('../lib/persistence/statements/sales-report-jobs');
  const { buildSalesHistoryProjection } = require('../lib/sales-history-access');
  const runtime = f.history(), jobs = createSalesReportJobs({ access: f.app.provider, vault: f.vault, runtime, resolvePrincipal: f.get, scope: f.actor.scopeId });
  const job = await jobs.create(f.session, { title: 'Früherer Bericht', query: f.query() });
  const row = await f.app.provider.queryOne(S.get, { id: job.id, scope: f.actor.scopeId }), context = ['sales-report-job-v1', row.scope, row.owner, row.id];
  const data = f.protection.open(row.payload, context);
  data.query = f.query(); data.format = 'html'; delete data.metadata;
  data.authority = f.protection.digest({ employeeNumber: f.session.employeeNumber, projection: buildSalesHistoryProjection(f.session) });
  data.sourceRevision = await runtime.run(f.get, w => w.legacyReportSourceRevision);
  f.app.database.prepare('UPDATE sales_report_jobs SET payload=? WHERE id=?').run(f.protection.seal(data, context), job.id);
  await jobs.tick(); const html = await jobs.download(f.session, job.id);
  assert.equal(typeof html, 'string'); assert.match(html, /12.00 EUR/);
});

test('confirmed cash unit margin is multiplied by the sold quantity and requires margin rights', async t => {
  const f = await fixture(t), data = rows({ price: '19.54' });
  data.Umsatz_KASSE[0].RechnungsBetrag = '39.08';
  Object.assign(data.Umsatz_Kasse_Details[0], { VKMenge: '2', RohertragDM: '8.141666666666667', KalkRohertrag: '16.283333333333335' });
  const id = await f.build(data); await f.activate(f.request(id)); f.session.permissions.push('sales:analytics:margin:read');
  const runtime = f.history(), input = f.query({ metrics: ['grossMargin','netRevenue','marginRate'] });
  const context = await runtime.run(f.get, w => w.reports.metadata()); assert.equal(context.marginStatus, 'confirmed');
  let result = await runtime.run(f.get, w => w.reports.step(input, context));
  result = await runtime.run(f.get, w => w.reports.step(input, context, result.analysis.cursor));
  assert.equal(result.report.total.metrics.grossMargin.current, '16.28');
  const { createSalesReportJobs } = require('../lib/persistence/repositories/sales-report-jobs');
  const jobs = createSalesReportJobs({ access: f.app.provider, vault: f.vault, runtime, resolvePrincipal: f.get, scope: f.actor.scopeId });
  const job = await jobs.create(f.session, { title: 'Bestätigter Kassenrohertrag (synthetischer Test)', query: input });
  await jobs.tick(); await jobs.tick();
  assert.equal((await jobs.list(f.session))[0].status, 'completed');
  const pdf = await jobs.download(f.session, job.id), pdfText = await reportPdfText(pdf);
  assert.match(pdfText, /16,28/); assert.match(pdfText, /historischer Kassen-Rohertrag je Stück/);
  assert.doesNotMatch(pdfText, /Bedeutung des historischen Kassenfelds ist noch nicht bestätigt/);
  if (process.env.SALES_REPORT_PDF_PREVIEW_DIR) {
    const fs = require('node:fs'), path = require('node:path');
    fs.mkdirSync(process.env.SALES_REPORT_PDF_PREVIEW_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.SALES_REPORT_PDF_PREVIEW_DIR, 'sales-analysis-confirmed-margin.pdf'), pdf);
  }
  f.session.permissions = f.session.permissions.filter(p => p !== 'sales:analytics:margin:read');
  await assert.rejects(runtime.run(f.get, w => w.reports.step(input, context)), code('IMPORT_FORBIDDEN'));
});

test('reviewed cash rules flow from an unchanged sealed publication through receipts and encrypted report PDFs', async t => {
  const f = await fixture(t), data = rows({ count: 5 });
  data.Umsatz_KASSE[0].RechnungsBetrag = '0';
  const [camera, discount, book, voucher, issue] = data.Umsatz_Kasse_Details;
  Object.assign(camera, { VK_Preis: '1369', Sortiment: 130, UMarke: 'Sony', RohertragDM: '137.94907831964053', DEK_A: null });
  Object.assign(discount, { VKMenge: '-1', VK_Preis: '95.82', Sortiment: 170201, UMarke: 'Separate discounts', SonderartikelS: true, RohertragDM: '0' });
  Object.assign(book, { VK_Preis: '0', MWST: '10', Sortiment: 50901, UMarke: 'Books', RohertragDM: '0' });
  Object.assign(voucher, { VKMenge: '-4', VK_Preis: '100', MWST: '0', Sortiment: 170101, UMarke: 'Vouchers', AStorno: true, RohertragDM: '0' });
  Object.assign(issue, { VKMenge: '2', VK_Preis: '10', MWST: '0', Sortiment: 170101, UMarke: 'Vouchers', RohertragDM: null, KalkRohertrag: '999', DEK_A: null });
  const id = await f.build(data); await f.activate(f.request(id));
  f.session.permissions.push('sales:analytics:margin:read');
  const { createCashPublications } = require('../lib/persistence/repositories/cash-publications');
  const publications = createCashPublications({ access: f.app.provider, protection: f.protection, scopeId: f.actor.scopeId });
  const publication = await f.app.provider.transaction(tx => publications.active(tx), { readOnly: true });
  assert.equal(publication.data.policy.version, 1); assert.equal(publication.policy.version, 9);
  const before = C.canonical(publication.row), runtime = f.history();
  const history = await runtime.run(f.get, w => w.search(f.query()));
  assert.equal(history.totals.gross, '1273.18'); assert.equal(history.coverage.counts.review, 0);
  assert.equal(history.coverage.counts.adjustments, 1); assert.equal(history.coverage.counts.payments, 1);
  assert.equal(history.coverage.counts.voucherIssues, 1);
  const search = await runtime.run(f.get, w => w.receipts.search({ ...f.query(), kind: 'receipts' }));
  assert.equal(search.items.length, 1); assert.equal(search.items[0].gross, '1273.18');
  const docs = await runtime.run(f.get, w => w.receipts.documents({ ids: [search.items[0].id] }));
  assert.equal(docs.items[0].lines.find(l => l.status === 'payment').sourcePrice, '100.000000000000');
  const issuance = docs.items[0].lines.find(l => l.status === 'voucher_issue');
  assert.equal(issuance.sourcePrice, '10.000000000000'); assert.equal(issuance.gross, '0.00');
  assert.match(require('../public/receipt-search').renderDetail(docs.items[0]), /Zahlungsmittel/);
  assert.match(require('../public/receipt-search').renderDetail(docs.items[0]), /Gutscheinausgabe · kein Warenumsatz/);
  const receiptPdf = await require('../lib/receipt-info-pdf').createReceiptInfoPdf(docs);
  assert.match(await reportPdfText(receiptPdf), /Zahlungsmittel/);
  assert.match(await reportPdfText(receiptPdf), /Gutscheinausgabe · kein Warenumsatz/);
  const input = f.query({ reportVersion: 3, orientation: 'landscape', groupBy: ['manufacturer'],
    metrics: ['grossRevenue', 'netRevenue', 'grossMargin', 'quantity', 'receiptCount'], chartType: 'bars' });
  const metadata = await runtime.run(f.get, w => w.reports.metadata());
  let result = await runtime.run(f.get, w => w.reports.step(input, metadata));
  result = await runtime.run(f.get, w => w.reports.step(input, metadata, result.analysis.cursor));
  for (const [metric, expected] of Object.entries({ grossRevenue: '1273.18', netRevenue: '1060.98', grossMargin: '137.95', quantity: '2.000000', receiptCount: '1' })) {
    assert.equal(result.report.total.metrics[metric].current, expected, metric);
  }
  const sony = result.report.rows.find(r => r.dimensions[0].id === 'sony');
  assert.equal(sony.metrics.grossMargin.current, '137.95'); assert.equal(sony.metrics.grossRevenue.current, '1369.00');
  assert.equal(result.report.coverage.current.review, 0); assert.equal(result.report.coverage.current.excluded, 2);
  assert.equal(result.report.rows.find(r => r.dimensions[0].id === 'vouchers').metrics.grossMargin.current, '0.00');
  const { createSalesReportJobs } = require('../lib/persistence/repositories/sales-report-jobs');
  const jobs = createSalesReportJobs({ access: f.app.provider, vault: f.vault, runtime, resolvePrincipal: f.get, scope: f.actor.scopeId });
  const job = await jobs.create(f.session, { title: 'Bestätigte Kassenregeln (synthetischer Test)', query: input });
  await jobs.tick(); await jobs.tick();
  const pdf = await jobs.download(f.session, job.id), text = await reportPdfText(pdf);
  assert.match(text, /1[.\s]?273,18/); assert.match(text, /137,95/); assert.match(text, /Gutscheineinlösungen/); assert.match(text, /Gutscheinausgaben/);
  assert.doesNotMatch(text, /Offene Belegprüfungen/);
  if (process.env.SALES_REPORT_PDF_PREVIEW_DIR) {
    const fs = require('node:fs'), path = require('node:path');
    fs.mkdirSync(process.env.SALES_REPORT_PDF_PREVIEW_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.SALES_REPORT_PDF_PREVIEW_DIR, 'sales-analysis-reviewed-cash.pdf'), pdf);
    fs.writeFileSync(path.join(process.env.SALES_REPORT_PDF_PREVIEW_DIR, 'receipt-reviewed-cash.pdf'), receiptPdf);
  }
  // A queued job pinned to the previous effective rules must not silently mix
  // old checkpoints/metadata with the newly confirmed cash interpretation.
  const oldPolicy = require('../lib/tradefoto-sales-rules').defineTradeFotoSalesPolicy(publication.data.policy);
  const backend = require('../lib/persistence/repositories/cash-history-backend').createCashHistoryBackend({ publication, publications, scopeId: f.actor.scopeId });
  const oldRevision = f.protection.digest([backend.source, oldPolicy, require('../lib/sales-report-margin').reportMarginPolicyFor(oldPolicy)]);
  assert.notEqual(await runtime.run(f.get, w => w.reportSourceRevision), oldRevision);
  const pending = await jobs.create(f.session, { query: input });
  const row = f.app.database.prepare('SELECT * FROM sales_report_jobs WHERE id=?').get(pending.id);
  const context = ['sales-report-job-v1', row.scope, row.owner, row.id], payload = f.protection.open(row.payload, context);
  f.app.database.prepare('UPDATE sales_report_jobs SET payload=? WHERE id=?').run(f.protection.seal({ ...payload, sourceRevision: oldRevision }, context), row.id);
  await jobs.tick();
  assert.equal((await jobs.list(f.session)).find(r => r.id === pending.id).error, 'IMPORT_HISTORY_ANALYSIS_CHANGED');
  assert.deepEqual(await jobs.download(f.session, job.id), pdf);
  const after = await f.app.provider.transaction(tx => publications.active(tx), { readOnly: true });
  assert.equal(C.canonical(after.row), before); assert.equal(after.data.policy.version, 1);
});

test('deposit receipt and later redemption preserve revenue across dates and source margins through encrypted PDFs', async t => {
  const f = await fixture(t), paid = rows(), redeemed = rows({ count: 2 });
  const deposit = { EAN: '0000000000098', Sortiment: 170102, SonderartikelS: true, VK_Preis: '300', RohertragDM: null, UMarke: 'Deposits' };
  paid.Umsatz_KASSE[0].RechnungsBetrag = '300'; Object.assign(paid.Umsatz_Kasse_Details[0], deposit);
  Object.assign(redeemed.Umsatz_KASSE[0], { Bonnr: '2', Bondatum: '2010-02-02T00:00:00.000', RechnungsBetrag: '300' });
  redeemed.Umsatz_Kasse_Details.forEach((item, i) => Object.assign(item, { Bonnr: '2', Bondatum: redeemed.Umsatz_KASSE[0].Bondatum,
    RepID: '00000000-0000-0000-0000-' + String(i + 2).padStart(12, '0') }));
  Object.assign(redeemed.Umsatz_Kasse_Details[0], { VK_Preis: '600', Sortiment: 130, UMarke: 'Sony', RohertragDM: '100', DEK_A: null });
  Object.assign(redeemed.Umsatz_Kasse_Details[1], deposit, { VKMenge: '-1', RohertragDM: '999.99' });
  const data = { Umsatz_KASSE: [paid, redeemed].flatMap(d => d.Umsatz_KASSE), Umsatz_Kasse_Details: [paid, redeemed].flatMap(d => d.Umsatz_Kasse_Details) };
  const before = C.canonical(data), id = await f.build(data); await f.activate(f.request(id)); f.session.permissions.push('sales:analytics:margin:read');
  const runtime = f.history(), metadata = await runtime.run(f.get, w => w.reports.metadata());
  const reportQuery = extra => f.query({ groupBy: ['productGroup'], metrics: ['grossRevenue', 'netRevenue', 'grossMargin', 'quantity', 'receiptCount'], ...extra });
  async function report(extra) {
    const input = reportQuery(extra); let result = await runtime.run(f.get, w => w.reports.step(input, metadata));
    while (result.analysis.cursor) result = await runtime.run(f.get, w => w.reports.step(input, metadata, result.analysis.cursor));
    return result.report;
  }
  const initial = await report({ dateTo: '2010-01-31' }), later = await report({ dateFrom: '2010-02-01' }), all = await report({});
  for (const [metric, first, second, total] of [['grossRevenue', '300.00', '300.00', '600.00'], ['netRevenue', '250.00', '250.00', '500.00'],
    ['grossMargin', '0.00', '100.00', '100.00'], ['quantity', '0.000000', '1.000000', '1.000000'], ['receiptCount', '1', '1', '2']]) {
    assert.equal(initial.total.metrics[metric].current, first, metric); assert.equal(later.total.metrics[metric].current, second, metric); assert.equal(all.total.metrics[metric].current, total, metric);
  }
  assert.equal(all.coverage.current.review, 0); assert.equal(all.coverage.current.marginMissing, 0);
  const sony = await report({ manufacturerIds: ['SONY'] });
  assert.equal(sony.total.metrics.grossRevenue.current, '600.00'); assert.equal(sony.total.metrics.grossMargin.current, '100.00');
  const search = await runtime.run(f.get, w => w.search(f.query())); assert.equal(search.coverage.counts.deposits, 2);
  const receipts = await runtime.run(f.get, w => w.receipts.search(f.query({ kind: 'receipts' })));
  const docs = await runtime.run(f.get, w => w.receipts.documents({ ids: receipts.items.map(item => item.id) }));
  assert.equal(docs.items.flatMap(item => item.lines).filter(item => item.status === 'deposit').length, 2);
  const receiptPdf = await require('../lib/receipt-info-pdf').createReceiptInfoPdf({ items: docs.items, sourceLabel: 'Synthetic deposits' });
  assert.match(await reportPdfText(receiptPdf), /Anzahlung \/ Verrechnung · ohne Rohertrag/);
  const jobs = require('../lib/persistence/repositories/sales-report-jobs').createSalesReportJobs({ access: f.app.provider, vault: f.vault, runtime, resolvePrincipal: f.get, scope: f.actor.scopeId });
  const job = await jobs.create(f.session, { title: 'Synthetische Anzahlungsprüfung', query: reportQuery({}) });
  await jobs.tick(); await jobs.tick(); const pdf = await jobs.download(f.session, job.id), text = await reportPdfText(pdf);
  assert.match(text, /600,00/); assert.match(text, /100,00/); assert.doesNotMatch(text, /Offene Belegprüfungen/);
  assert.equal(C.canonical(data), before);
  if (process.env.CASH_DEPOSIT_PDF_PREVIEW_DIR) {
    const fs = require('node:fs'), path = require('node:path'); fs.mkdirSync(process.env.CASH_DEPOSIT_PDF_PREVIEW_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.CASH_DEPOSIT_PDF_PREVIEW_DIR, 'receipt-deposit.pdf'), receiptPdf);
    fs.writeFileSync(path.join(process.env.CASH_DEPOSIT_PDF_PREVIEW_DIR, 'sales-analysis-deposit.pdf'), pdf);
  }
});

test('voucher issuance followed by a goods purchase and redemption counts the actual goods sale exactly once', async t => {
  const f = await fixture(t), issued = rows(), redeemed = rows({ count: 2 });
  Object.assign(issued.Umsatz_KASSE[0], { RechnungsBetrag: '0' });
  Object.assign(issued.Umsatz_Kasse_Details[0], { VKMenge: '2', VK_Preis: '10', MWST: '0', Sortiment: 170101, RohertragDM: '999', DEK_A: null });
  Object.assign(redeemed.Umsatz_KASSE[0], { Bonnr: '2', Bondatum: '2010-02-02T00:00:00.000', RechnungsBetrag: '0' });
  redeemed.Umsatz_Kasse_Details.forEach((line, i) => Object.assign(line, { Bonnr: '2', Bondatum: redeemed.Umsatz_KASSE[0].Bondatum,
    RepID: '00000000-0000-0000-0000-' + String(i + 2).padStart(12, '0') }));
  Object.assign(redeemed.Umsatz_Kasse_Details[0], { VK_Preis: '120', Sortiment: 130, RohertragDM: '25.55', DEK_A: null });
  Object.assign(redeemed.Umsatz_Kasse_Details[1], { VKMenge: '-2', VK_Preis: '10', MWST: '0', Sortiment: 170101, AStorno: true, RohertragDM: null });
  const data = { Umsatz_KASSE: [issued, redeemed].flatMap(d => d.Umsatz_KASSE), Umsatz_Kasse_Details: [issued, redeemed].flatMap(d => d.Umsatz_Kasse_Details) };
  const id = await f.build(data); await f.activate(f.request(id)); f.session.permissions.push('sales:analytics:margin:read');
  const runtime = f.history(), metadata = await runtime.run(f.get, w => w.reports.metadata());
  async function report(dateTo) {
    const input = f.query({ dateTo, groupBy: ['productGroup'], metrics: ['grossRevenue', 'netRevenue', 'grossMargin', 'quantity', 'receiptCount'] });
    let result = await runtime.run(f.get, w => w.reports.step(input, metadata));
    result = await runtime.run(f.get, w => w.reports.step(input, metadata, result.analysis.cursor));
    return result.report;
  }
  const initial = await report('2010-01-31'), complete = await report('2010-12-31');
  for (const [metric, zero, later] of [['grossRevenue', '0.00', '120.00'], ['netRevenue', '0.00', '100.00'],
    ['grossMargin', '0.00', '25.55'], ['quantity', '0.000000', '1.000000'], ['receiptCount', '0', '1']]) {
    assert.equal(initial.total.metrics[metric].current, zero, metric); assert.equal(complete.total.metrics[metric].current, later, metric);
  }
  assert.equal(initial.coverage.current.review, 0); assert.equal(initial.coverage.current.excluded, 1);
  assert.equal(complete.coverage.current.review, 0); assert.equal(complete.coverage.current.excluded, 2);
  assert.equal(complete.coverage.current.marginMissing, 0);
});

test('UID payment clearing stays separate from later goods sales and negative-quantity returns across receipt dates', async t => {
  const f = await fixture(t), clearing = { EAN: '0000000058204', Sortiment: 170102, MWST: '0', AStorno: true,
    SonderartikelS: true, VK_Preis: '100', RohertragDM: null, DEK_A: null };
  const specifications = [['0', clearing], ['0', { ...clearing, VKMenge: '-1', RohertragDM: '999' }],
    ['120', { VK_Preis: '120', Sortiment: 130, RohertragDM: '25.55', DEK_A: null }],
    ['-13.99', { VKMenge: '-1', VK_Preis: '13.99', Sortiment: 60303, AStorno: true, RohertragDM: '3.408333333333333', DEK_A: null }]];
  const data = { Umsatz_KASSE: [], Umsatz_Kasse_Details: [] };
  specifications.forEach(([amount, fields], i) => {
    const receipt = rows(), head = receipt.Umsatz_KASSE[0];
    Object.assign(head, { Bonnr: String(i + 1), Bondatum: '2010-01-0' + (i + 2) + 'T00:00:00.000', RechnungsBetrag: amount });
    Object.assign(receipt.Umsatz_Kasse_Details[0], fields, { Bonnr: head.Bonnr, Bondatum: head.Bondatum,
      RepID: '00000000-0000-0000-0000-' + String(i + 1).padStart(12, '0') });
    data.Umsatz_KASSE.push(head); data.Umsatz_Kasse_Details.push(...receipt.Umsatz_Kasse_Details);
  });
  const id = await f.build(data); await f.activate(f.request(id)); f.session.permissions.push('sales:analytics:margin:read');
  const runtime = f.history(), metadata = await runtime.run(f.get, w => w.reports.metadata());
  const search = await runtime.run(f.get, w => w.search(f.query()));
  assert.equal(search.totals.gross, '106.01'); assert.equal(search.coverage.counts.uidClearings, 2);
  assert.equal(search.coverage.counts.returns, 1); assert.equal(search.coverage.counts.review, 0);
  for (const [dateTo, gross, net, margin, quantity, receipts] of [
    ['2010-01-02', '0.00', '0.00', '0.00', '0.000000', '0'],
    ['2010-01-03', '0.00', '0.00', '0.00', '0.000000', '0'],
    ['2010-01-04', '120.00', '100.00', '25.55', '1.000000', '1'],
    ['2010-01-05', '106.01', '88.34', '22.14', '0.000000', '2']
  ]) {
    const input = f.query({ dateTo, groupBy: ['productGroup'], metrics: ['grossRevenue', 'netRevenue', 'grossMargin', 'quantity', 'receiptCount'] });
    let result = await runtime.run(f.get, w => w.reports.step(input, metadata));
    result = await runtime.run(f.get, w => w.reports.step(input, metadata, result.analysis.cursor));
    for (const [metric, expected] of Object.entries({ grossRevenue: gross, netRevenue: net, grossMargin: margin, quantity, receiptCount: receipts })) {
      assert.equal(result.report.total.metrics[metric].current, expected, dateTo + ' ' + metric);
    }
    assert.equal(result.report.coverage.current.review, 0); assert.equal(result.report.coverage.current.marginMissing, 0);
  }
  const receipts = await runtime.run(f.get, w => w.receipts.search({ ...f.query(), kind: 'receipts' }));
  const docs = await runtime.run(f.get, w => w.receipts.documents({ ids: receipts.items.map(item => item.id) }));
  const payments = docs.items.filter(item => item.lines[0].status === 'uid_clearing');
  assert.equal(payments.length, 2);
  const UI = require('../public/receipt-search');
  for (const item of payments) { assert.equal(item.gross, '0.00'); assert.match(UI.renderDetail(item), /UID-Zwischenbuchung · kein Warenumsatz/); }
  assert.match(UI.renderDetail(payments.find(item => item.lines[0].quantity.startsWith('-'))), /-100,00/);
  const pdf = await require('../lib/receipt-info-pdf').createReceiptInfoPdf(docs);
  const text = await reportPdfText(pdf); assert.match(text, /UID-Zwischenbuchung · kein Warenumsatz/); assert.match(text, /-100,00/); assert.match(text, /Rückgabe/);
  if (process.env.SALES_REPORT_PDF_PREVIEW_DIR) {
    const fs = require('node:fs'), path = require('node:path');
    fs.mkdirSync(process.env.SALES_REPORT_PDF_PREVIEW_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.SALES_REPORT_PDF_PREVIEW_DIR, 'receipt-uid-clearing.pdf'), pdf);
  }
});

test('used goods retain the stored zero VAT and per-position cash margin in receipts, reports and encrypted PDFs', async t => {
  const f = await fixture(t), data = { Umsatz_KASSE: [], Umsatz_Kasse_Details: [] };
  [['149', '39.485'], ['349', '92.485'], ['159', '42.135']].forEach(([price, margin], i) => {
    const receipt = rows(), head = receipt.Umsatz_KASSE[0];
    Object.assign(head, { Bonnr: String(i + 1), Bondatum: '2010-01-0' + (i + 2) + 'T00:00:00.000', RechnungsBetrag: '0' });
    Object.assign(receipt.Umsatz_Kasse_Details[0], { Bonnr: head.Bonnr, Bondatum: head.Bondatum,
      RepID: '00000000-0000-0000-0000-' + String(i + 1).padStart(12, '0'), EAN: '0000000069877', Sortiment: 130101,
      Artikelbezeichnung: 'Gebrauchtware (synthetischer Test)', UMarke: 'Second Hand', MWST: '0', AStorno: true, SonderartikelS: true,
      VK_Preis: price, RohertragDM: margin, KalkRohertrag: '9999', DEK_A: null });
    data.Umsatz_KASSE.push(head); data.Umsatz_Kasse_Details.push(...receipt.Umsatz_Kasse_Details);
  });
  const id = await f.build(data); await f.activate(f.request(id)); f.session.permissions.push('sales:analytics:margin:read');
  const publications = require('../lib/persistence/repositories/cash-publications').createCashPublications({ access: f.app.provider, protection: f.protection, scopeId: f.actor.scopeId });
  const before = await f.app.provider.transaction(tx => publications.active(tx), { readOnly: true });
  const runtime = f.history(), history = await runtime.run(f.get, w => w.search(f.query()));
  assert.equal(history.totals.gross, '657.00'); assert.equal(history.totals.net, '657.00');
  assert.equal(history.coverage.counts.sales, 3); assert.equal(history.coverage.counts.review, 0);
  const receipts = await runtime.run(f.get, w => w.receipts.search({ ...f.query(), kind: 'receipts' }));
  const docs = await runtime.run(f.get, w => w.receipts.documents({ ids: receipts.items.map(item => item.id) }));
  assert.equal(docs.items.length, 3); assert.ok(docs.items.every(item => item.state === 'Geprüft' && item.lines[0].status === 'sale'));
  const input = f.query({ reportVersion: 3, groupBy: ['manufacturer'], metrics: ['grossRevenue', 'netRevenue', 'grossMargin', 'quantity', 'receiptCount'], chartType: 'bars' });
  const metadata = await runtime.run(f.get, w => w.reports.metadata());
  let result = await runtime.run(f.get, w => w.reports.step(input, metadata));
  result = await runtime.run(f.get, w => w.reports.step(input, metadata, result.analysis.cursor));
  for (const [metric, expected] of Object.entries({ grossRevenue: '657.00', netRevenue: '657.00', grossMargin: '174.12', quantity: '3.000000', receiptCount: '3' })) {
    assert.equal(result.report.total.metrics[metric].current, expected, metric);
    assert.equal(result.report.rows[0].metrics[metric].current, expected, metric + ' group');
  }
  assert.equal(result.report.coverage.current.review, 0); assert.equal(result.report.coverage.current.marginMissing, 0);
  const jobs = require('../lib/persistence/repositories/sales-report-jobs').createSalesReportJobs({ access: f.app.provider, vault: f.vault, runtime, resolvePrincipal: f.get, scope: f.actor.scopeId });
  const job = await jobs.create(f.session, { title: 'Gebrauchtware mit 0 % MwSt. (synthetischer Test)', query: input });
  await jobs.tick(); await jobs.tick();
  const pdf = await jobs.download(f.session, job.id), text = await reportPdfText(pdf);
  assert.match(text, /657,00/); assert.match(text, /174,12/); assert.doesNotMatch(text, /Offene Belegprüfungen/);
  if (process.env.SALES_REPORT_PDF_PREVIEW_DIR) {
    const fs = require('node:fs'), path = require('node:path'); fs.mkdirSync(process.env.SALES_REPORT_PDF_PREVIEW_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.SALES_REPORT_PDF_PREVIEW_DIR, 'sales-analysis-used-goods.pdf'), pdf);
  }
  const after = await f.app.provider.transaction(tx => publications.active(tx), { readOnly: true });
  assert.equal(C.canonical(after.row), C.canonical(before.row)); assert.equal(after.data.policy.version, 1);
});

test('confirmed prints, HD processing and repair estimate charges flow through receipts and reports without invented offsets', async t => {
  const f = await fixture(t);
  const fee = { EAN: '0000000049742', Sortiment: 110201, SonderartikelS: true, VK_Preis: '75', RohertragDM: '18.75', DEK_A: null };
  const specifications = [
    ['75', [fee]],
    ['37.79', [{ EAN: '0000000000022', Sortiment: 110201, VK_Preis: '112.79', RohertragDM: '23.25' }, { ...fee, VKMenge: '-1' }]],
    ['38.06', [
      { EAN: '0000000081619', Sortiment: 60401, SonderartikelS: true, VKMenge: '4', VK_Preis: '0.89', RohertragDM: '0.5191666666666667' },
      { EAN: '0000000081619', Sortiment: 60401, SonderartikelS: true, VKMenge: '50', VK_Preis: '0.69', RohertragDM: '0.3191666666666667', Rabatt: '20', Rabatt_DM: '1' }
    ]],
    ['75', [fee]], // Repair not performed: this fee has no offset and remains charged.
    ['86.99', [{ EAN: '0000000000011', Sortiment: 60203, SonderartikelS: true, VK_Preis: '86.99', RohertragDM: '36.24583333333333', DEK_A: null }]]
  ];
  const data = { Umsatz_KASSE: [], Umsatz_Kasse_Details: [] };
  specifications.forEach(([amount, lines], index) => {
    const receipt = rows({ count: lines.length }), head = receipt.Umsatz_KASSE[0];
    Object.assign(head, { Bonnr: String(index + 1), Bondatum: '2010-01-0' + (index + 2) + 'T00:00:00.000', RechnungsBetrag: amount });
    receipt.Umsatz_Kasse_Details.forEach((row, i) => Object.assign(row, lines[i], { Bonnr: head.Bonnr, Bondatum: head.Bondatum,
      RepID: '00000000-0000-0000-0000-' + String(index * 10 + i + 1).padStart(12, '0') }));
    data.Umsatz_KASSE.push(head); data.Umsatz_Kasse_Details.push(...receipt.Umsatz_Kasse_Details);
  });
  const id = await f.build(data); await f.activate(f.request(id)); f.session.permissions.push('sales:analytics:margin:read');
  const publications = require('../lib/persistence/repositories/cash-publications').createCashPublications({ access: f.app.provider, protection: f.protection, scopeId: f.actor.scopeId });
  const before = await f.app.provider.transaction(tx => publications.active(tx), { readOnly: true });
  const runtime = f.history(), history = await runtime.run(f.get, w => w.search(f.query()));
  assert.equal(history.totals.gross, '312.84'); assert.equal(history.coverage.counts.review, 0);
  const receipts = await runtime.run(f.get, w => w.receipts.search({ ...f.query(), kind: 'receipts' }));
  assert.equal(receipts.items.length, 5);
  const docs = await runtime.run(f.get, w => w.receipts.documents({ ids: receipts.items.map(r => r.id) }));
  assert.equal(docs.items.reduce((sum, r) => sum + r.lines.length, 0), 7);
  assert.equal(docs.items.flatMap(r => r.lines).filter(l => l.status === 'return').length, 1);
  const input = f.query({ reportVersion: 3, groupBy: ['productGroup'], metrics: ['grossRevenue', 'netRevenue', 'grossMargin', 'quantity', 'receiptCount'] });
  const metadata = await runtime.run(f.get, w => w.reports.metadata());
  let result = await runtime.run(f.get, w => w.reports.step(input, metadata));
  result = await runtime.run(f.get, w => w.reports.step(input, metadata, result.analysis.cursor));
  for (const [metric, expected] of Object.entries({ grossRevenue: '312.84', netRevenue: '260.70', grossMargin: '96.29', quantity: '57.000000', receiptCount: '5' })) {
    assert.equal(result.report.total.metrics[metric].current, expected, metric);
  }
  const jobs = require('../lib/persistence/repositories/sales-report-jobs').createSalesReportJobs({ access: f.app.provider, vault: f.vault, runtime, resolvePrincipal: f.get, scope: f.actor.scopeId });
  const job = await jobs.create(f.session, { title: 'Sofortdruck, HD und Reparaturpauschale (synthetisch)', query: input });
  await jobs.tick(); await jobs.tick();
  const text = await reportPdfText(await jobs.download(f.session, job.id));
  assert.match(text, /312,84/); assert.match(text, /96,29/); assert.doesNotMatch(text, /Offene Belegprüfungen/);
  const after = await f.app.provider.transaction(tx => publications.active(tx), { readOnly: true });
  assert.equal(C.canonical(after.row), C.canonical(before.row)); assert.equal(after.data.policy.version, 1);
});

test('report aggregation uses historical WGR and manufacturers, complete receipts and cumulative branch/MA filters in both periods', async t => {
  const f = await fixture(t), current = rows({ count: 2 }), previous = rows({ count: 2, price: '9.6' }), other = rows({ price: '24', location: '019' });
  for (const [dataset, suffix, date] of [[current, '1', '2010-01-02'], [previous, '2', '2009-01-02'], [other, '3', '2010-01-02']]) {
    dataset.Umsatz_KASSE[0].Bonnr = suffix; dataset.Umsatz_KASSE[0].Bondatum = date + 'T00:00:00.000';
    dataset.Umsatz_Kasse_Details.forEach((line, i) => Object.assign(line, { Bonnr: suffix, Bondatum: dataset.Umsatz_KASSE[0].Bondatum,
      RepID: `00000000-0000-0000-0000-${String(Number(suffix) * 100 + i).padStart(12, '0')}`, Sortiment: 130, UMarke: i ? 'Sony' : 'Canon' }));
  }
  const combined = { Umsatz_KASSE: [current, previous, other].flatMap(d => d.Umsatz_KASSE), Umsatz_Kasse_Details: [current, previous, other].flatMap(d => d.Umsatz_Kasse_Details) };
  const id = await f.build(combined), request = f.request(id); request.mappings.push({ kind: 'FILIALEN', sourceId: '019', targetId: 'branch-b', historical: false }); await f.activate(request);
  f.session.permissions.push('sales:analytics:margin:read');
  const input = f.query({ locationIds: ['branch-a'], manufacturerIds: ['CANON'], productGroupIds: ['130'], sellerIds: ['person-a'], metrics: ['netRevenue','receiptCount','grossMargin'] });
  const runtime = f.history(), context = await runtime.run(f.get, w => w.reports.metadata());
  let result = await runtime.run(f.get, w => w.reports.step(input, context));
  assert.equal(result.analysis.complete, false);
  result = await runtime.run(f.get, w => w.reports.step(input, context, result.analysis.cursor));
  assert.equal(result.analysis.complete, true);
  assert.deepEqual(result.report.total.metrics.netRevenue, { current: '10.00', previous: '8.00', absolute: '2.00', percent: '25.00' });
  assert.equal(result.report.total.metrics.receiptCount.current, '1'); assert.equal(result.report.total.metrics.grossMargin.current, null);
  assert.equal(result.report.rows.length, 1); assert.equal(result.report.rows[0].dimensions[1].label, 'Canon');
  f.session = { ...f.session, permissions: f.session.permissions.filter(p => p !== 'sales:analytics:company:read').concat('sales:analytics:location:read'), scopes: [{ locationId: 'branch-a', departmentId: 0 }] };
  const scoped = await runtime.run(f.get, w => w.reports.metadata()); assert.deepEqual(scoped.locations.map(l => l.id), ['branch-a']); assert.deepEqual(scoped.source.locations, scoped.locations);
  await assert.rejects(runtime.run(f.get, w => w.reports.step({ ...input, locationIds: ['branch-b'] }, scoped)), code('IMPORT_FORBIDDEN'));
});

test('an open companion line preserves Sony revenue and confirmed cash margin without purchase prices or a false comparison', async t => {
  const f = await fixture(t), good = rows({ price: '120' }), open = rows({ count: 2, price: '120' }), previous = rows({ price: '60' });
  for (const [dataset, number, date] of [[good, '1', '2010-01-02'], [open, '2', '2010-01-02'], [previous, '3', '2009-01-02']]) {
    dataset.Umsatz_KASSE[0].Bonnr = number; dataset.Umsatz_KASSE[0].Bondatum = date + 'T00:00:00.000';
    dataset.Umsatz_Kasse_Details.forEach((line, i) => Object.assign(line, { Bonnr: number, Bondatum: dataset.Umsatz_KASSE[0].Bondatum,
      RepID: `00000000-0000-0000-0000-${String(Number(number) * 100 + i).padStart(12, '0')}`, Sortiment: 130, UMarke: 'Sony' }));
  }
  open.Umsatz_KASSE[0].RechnungsBetrag = '0';
  Object.assign(open.Umsatz_Kasse_Details[1], { UMarke: 'Companion line', MWST: '0' });
  Object.assign(good.Umsatz_Kasse_Details[0], { RohertragDM: '20.123456789', KalkRohertrag: '20.123456789', DEK_A: null });
  Object.assign(open.Umsatz_Kasse_Details[0], { RohertragDM: '60', KalkRohertrag: '60', DEK_A: null });
  Object.assign(previous.Umsatz_Kasse_Details[0], { RohertragDM: '10', KalkRohertrag: '10', DEK_A: null });
  const data = { Umsatz_KASSE: [good, open, previous].flatMap(d => d.Umsatz_KASSE), Umsatz_Kasse_Details: [good, open, previous].flatMap(d => d.Umsatz_Kasse_Details) };
  const id = await f.build(data); await f.activate(f.request(id));
  f.session.permissions.push('sales:analytics:margin:read');
  const input = f.query({ reportVersion: 3, manufacturerIds: ['SONY'], sellerIds: ['person-a'], groupBy: ['manufacturer'], metrics: ['netRevenue', 'quantity', 'receiptCount', 'grossMargin', 'marginRate'], chartType: 'shares' });
  const runtime = f.history(), metadata = await runtime.run(f.get, w => w.reports.metadata());
  assert.equal(metadata.marginStatus, 'confirmed');
  let result = await runtime.run(f.get, w => w.reports.step(input, metadata));
  result = await runtime.run(f.get, w => w.reports.step(input, metadata, result.analysis.cursor));
  const sony = result.report.rows[0]; assert.equal(result.report.rows.length, 1); assert.equal(sony.dimensions[0].id, 'sony');
  assert.deepEqual(sony.metrics.netRevenue, { current: null, previous: '50.00', absolute: null, percent: null, verifiedCurrent: '100.00' });
  assert.deepEqual(sony.metrics.grossMargin, { current: null, previous: '10.00', absolute: null, percent: null, verifiedCurrent: '20.12' });
  assert.deepEqual(sony.metrics.marginRate, { current: null, previous: '20.00', absolute: null, percent: null, verifiedCurrent: '20.12' });
  assert.equal(sony.quality.current.records, 2); assert.equal(sony.quality.current.checked, 1); assert.equal(sony.quality.current.review, 1);
  assert.deepEqual(sony.quality.current.issues, { VAT_CODE_UNKNOWN: 1 });
  const { createSalesReportJobs } = require('../lib/persistence/repositories/sales-report-jobs');
  const jobs = createSalesReportJobs({ access: f.app.provider, vault: f.vault, runtime, resolvePrincipal: f.get, scope: f.actor.scopeId });
  const job = await jobs.create(f.session, { title: 'Sony mit offener Belegprüfung (synthetisch)', query: input });
  await jobs.tick(); await jobs.tick(); assert.equal((await jobs.list(f.session))[0].status, 'completed');
  const pdf = await jobs.download(f.session, job.id), text = await reportPdfText(pdf);
  assert.match(text, /100,00\s*€\s*\*/); assert.match(text, /Sony · aktuell \*/);
  assert.match(text, /20,12\s*€\s*\*/); assert.match(text, /20,12\s*%\s*\*/);
  assert.match(text, /historischer Kassen-Rohertrag je Stück/);
  assert.doesNotMatch(text, /Bedeutung des historischen Kassenfelds ist noch nicht bestätigt/);
  assert.match(text, /Offene Belegprüfungen/); assert.match(text, /MwSt.-Zuordnung/);
  assert.doesNotMatch(text, /Anteile im Auswertungszeitraum|100,00\s*%/);
});

test('Online includes 0/00/70/90 across batches once, excludes unassigned sources and remains restricted to company readers', async t => {
  const f = await fixture(t);
  const datasets = ['0', '00', '70', '90', '018', '99'].map((location, index) => {
    const data = rows({ count: location === '70' ? 205 : 1, location });
    const number = String(index + 10);
    data.Umsatz_KASSE[0].Bonnr = number;
    data.Umsatz_Kasse_Details.forEach((line, i) => Object.assign(line, { Bonnr: number,
      RepID: `00000000-0000-0000-0000-${String(index * 1000 + i + 1).padStart(12, '0')}` }));
    return data;
  });
  const data = { Umsatz_KASSE: datasets.flatMap(d => d.Umsatz_KASSE), Umsatz_Kasse_Details: datasets.flatMap(d => d.Umsatz_Kasse_Details) };
  const id = await f.build(data), request = f.request(id);
  request.mappings.push({ kind: 'FILIALEN', sourceId: '70', targetId: 'branch-a', historical: false }); await f.activate(request);
  const runtime = f.history(), context = await runtime.run(f.get, w => w.reports.metadata());
  assert.ok(context.locations.some(l => l.id === 'tradefoto-online'));
  async function calculate(locationIds) {
    const input = f.query({ reportVersion: 3, locationIds, groupBy: ['location'], metrics: ['netRevenue', 'receiptCount'] });
    let result, batches = 0;
    do { result = await runtime.run(f.get, w => w.reports.step(input, context, result?.analysis.cursor)); assert.ok(++batches <= 5); } while (!result.analysis.complete);
    return result.report;
  }
  const online = await calculate(['tradefoto-online']);
  assert.equal(online.total.metrics.netRevenue.current, '2080.00'); assert.equal(online.total.metrics.receiptCount.current, '4');
  assert.equal(online.rows[0].dimensions[0].id, 'tradefoto-online');
  for (const locationIds of [context.locations.map(l => l.id), context.locations.map(l => l.id).reverse()]) {
    const all = await calculate(locationIds);
    assert.equal(all.total.metrics.netRevenue.current, '2090.00'); assert.equal(all.total.metrics.receiptCount.current, '5');
    assert.equal(all.rows.find(r => r.dimensions[0].id === 'tradefoto-online').metrics.netRevenue.current, '2080.00');
  }
  const physical = await calculate(['branch-a']); assert.equal(physical.total.metrics.netRevenue.current, '2060.00');
  f.session = { ...f.session, permissions: f.session.permissions.filter(p => p !== 'sales:analytics:company:read').concat('sales:analytics:location:read'), scopes: [{ locationId: 'branch-a', departmentId: 0 }] };
  const scoped = await runtime.run(f.get, w => w.reports.metadata());
  assert.equal(scoped.locations.some(l => l.id === 'tradefoto-online'), false);
  await assert.rejects(calculate(['tradefoto-online']), code('IMPORT_FORBIDDEN'));
});

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
  f.app.database.exec("UPDATE crm_customers SET email='fresh@example.test',revision=revision+1 WHERE id='crm-31'");
  assert.equal((await runtime.run(f.get, w => w.receipts.search({ ...q, customer: 'fresh@example.test' }))).items.length, 1);
  assert.equal((await runtime.run(f.get, w => w.receipts.search({ ...q, customer: 'anne@example.test' }))).items.length, 0);
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

function observeSqlite(t) {
  const { DatabaseSync, StatementSync } = require('node:sqlite'), calls = [];
  for (const method of ['all', 'get', 'run']) {
    const original = StatementSync.prototype[method];
    t.mock.method(StatementSync.prototype, method, function (...args) {
      calls.push({ method, sql: this.sourceSQL }); return original.apply(this, args);
    });
  }
  const original = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) { calls.push({ method: 'exec', sql }); return original.call(this, sql); });
  return calls;
}

test('assigned cash search has an indexed binding lookup and equals the general path', async t => {
  const f = await fixture(t, { count: 60 }), active = await f.activate();
  const { SQLITE_CASH_PUBLICATIONS_CATALOG: catalog } = require('../lib/persistence/sqlite/cash-publications-catalog');
  const { CASH_PUBLICATION_STATEMENTS: S } = require('../lib/persistence/statements/cash-publications');
  const p = { publicationId: active.active, datasetSlot: 1, dateFrom: '2010-01-01', dateTo: '2010-12-31', afterDate: '9999-12-31', afterRow: 2000001,
    locationId: 'branch-a', unassigned: 0, sellerId: null, sellerMode: 'none', sellerRole: 'line_seller', customerId: null, limit: 50 };
  for (const name of Object.keys(S.search)) {
    const general = catalog.find(e => e.statement === S.search[name]).sql, assigned = catalog.find(e => e.statement === S.searchAssigned[name]).sql;
    assert.deepEqual(f.app.database.prepare(assigned).all(p), f.app.database.prepare(general).all(p));
    const plan = f.app.database.prepare('EXPLAIN QUERY PLAN ' + assigned).all(p).map(r => r.detail);
    assert.ok(plan.some(s => s.includes('cash_publication_binding_target')), JSON.stringify(plan));
    assert.ok(plan.some(s => /SEARCH r USING INDEX cash_snapshot_\d+_(date|location_key)/.test(s)), JSON.stringify(plan));
  }
});

test('optimized cash reads work beside an uncommitted writer and survive file restore with fresh runtime', async t => {
  const fs = require('node:fs'), path = require('node:path'), { DatabaseSync } = require('node:sqlite');
  const root = fs.realpathSync(path.resolve(__dirname, '../tmp')), dir = fs.mkdtempSync(path.join(root, 'cash-block5-'));
  const databasePath = path.join(dir, 'source.db'), f = await fixture(t, { databasePath, count: 205 });
  await f.activate(); const writer = new DatabaseSync(databasePath); let restored;
  t.after(async () => { writer.close(); if (restored) { await restored.provider.close(); restored.database.close(); }
    assert.equal(fs.realpathSync(path.dirname(dir)), root); fs.rmSync(dir, { recursive: true }); });
  writer.exec("BEGIN IMMEDIATE; UPDATE locations SET name='Pending synthetic label' WHERE id='branch-a'");
  const runtime = f.history();
  let result;
  try { result = await runtime.run(f.get, w => w.search(f.query())); assert.equal(result.analysis.processed, 200); }
  finally { writer.exec('ROLLBACK'); }
  result = await runtime.run(f.get, w => w.analyze({ query: f.query(), cursor: result.analysis.cursor }));
  assert.equal(result.totals.gross, '2460.00');
  const { createSalesReportJobs } = require('../lib/persistence/repositories/sales-report-jobs');
  const queue = createSalesReportJobs({ access: f.app.provider, vault: f.vault, runtime, resolvePrincipal: f.get, scope: f.actor.scopeId });
  const queued = await queue.create(f.session, { query: f.query() });
  const restoredPath = path.join(dir, 'restored.db'); f.app.database.prepare('VACUUM INTO ?').run(restoredPath);
  restored = openSqliteApplicationPersistence({ databasePath: restoredPath, catalog: SQLITE_APPLICATION_CATALOG });
  ensureSqliteDataImportRuntimeSchema(restored.database);
  assert.equal(restored.database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(restored.database.prepare('PRAGMA foreign_key_check').all().length, 0);
  const fresh = createManagedSalesHistoryRuntime({ access: restored.provider, vault: f.vault, scopeId: f.actor.scopeId, cashEnabled: true, today: () => '2026-09-07' });
  const page = await fresh.run(f.get, w => w.receipts.search(f.query()));
  assert.equal(page.items[0].gross, '2460.00'); assert.equal(page.items[0].positions, 205);
  const recovered = createSalesReportJobs({ access: restored.provider, vault: f.vault, runtime: fresh, resolvePrincipal: f.get, scope: f.actor.scopeId });
  await recovered.tick(); await recovered.tick(); await recovered.tick();
  assert.match(await reportPdfText(await recovered.download(f.session, queued.id)), /2[.\s]?050,00/);
  assert.equal((await queue.list(f.session))[0].status, 'queued');
});

test('cash reads take no writer reservation or full-table count, and a receipt reads each source segment once', async t => {
  const f = await fixture(t, { count: 60 }), active = await f.activate(), runtime = f.history();
  const headIndex = TABLES.findIndex(t => t.name === 'Umsatz_KASSE');
  const calls = observeSqlite(t);
  const result = await runtime.run(f.get, w => w.receipts.documents({ ids: [`c${headIndex}-${active.active}-0000000001`] }));
  assert.equal(result.items[0].positions, 60); assert.equal(result.items[0].gross, '720.00');
  assert.ok(calls.some(c => c.sql === 'BEGIN'));
  assert.equal(calls.filter(c => /BEGIN\s+(IMMEDIATE|EXCLUSIVE)/i.test(c.sql)).length, 0);
  assert.equal(calls.filter(c => /COUNT\(\*\).*FROM cash_(snapshot_\d|publication_bindings)/i.test(c.sql)).length, 0);
  assert.equal(calls.filter(c => /FROM cash_snapshot_6(?: INDEXED BY \w+)? WHERE.*parent_row=/.test(c.sql)).length, 1);
  assert.equal(calls.filter(c => new RegExp(`FROM cash_snapshot_${headIndex} WHERE.*source_row=`).test(c.sql)).length, 1);
  assert.ok(calls.filter(c => /FROM cash_publication_bindings WHERE.*source_key=/.test(c.sql)).length <= 5);
  calls.length = 0;
  await runtime.run(f.get, w => w.receipts.search(f.query()));
  const candidates = calls.find(c => c.sql.includes(`FROM cash_snapshot_${headIndex} r`));
  assert.ok(candidates); assert.doesNotMatch(candidates.sql.split('FROM')[0], /payload|source_key|seller_key|customer_key/);
});

test('receipt positions use the parent index without requiring pre-existing planner statistics', async t => {
  const f = await fixture(t); await f.activate();
  const { SQLITE_CASH_SNAPSHOTS_CATALOG } = require('../lib/persistence/sqlite/cash-snapshots-catalog');
  for (const table of TABLES.filter(row => ['Umsatz_Kasse_Details', 'KassenJournal_Details'].includes(row.name))) {
    const sql = SQLITE_CASH_SNAPSHOTS_CATALOG.find(entry => entry.statement === table.statements.children).sql;
    const args = { datasetSlot: 1, parentRow: 1, limit: 1001 };
    const plan = f.app.database.prepare('EXPLAIN QUERY PLAN ' + sql).all(args).map(row => row.detail).join(' ');
    assert.match(plan, new RegExp(`USING INDEX ${table.sqlName}_parent \\(dataset_slot=\\? AND parent_row=\\?\\)`));
    assert.deepEqual(f.app.database.prepare(sql).all(args), f.app.database.prepare(sql.replace(` INDEXED BY ${table.sqlName}_parent`, '')).all(args));
  }
});

test('cash verification generations reject same-count changes, survive schema reopen, and roll back atomically', async t => {
  const f = await fixture(t); await f.activate(); const runtime = f.history();
  assert.equal((await runtime.run(f.get, w => w.search(f.query()))).totals.gross, '12.00');
  f.app.database.exec("BEGIN; UPDATE cash_snapshot_6 SET business_date='2020-01-01'; ROLLBACK;");
  assert.equal((await runtime.run(f.get, w => w.search(f.query()))).totals.gross, '12.00');
  f.app.database.exec("UPDATE cash_snapshot_6 SET business_date='2010-01-02'");
  ensureSqliteDataImportRuntimeSchema(f.app.database);
  await assert.rejects(f.history().run(f.get, w => w.search(f.query())), code('IMPORT_HISTORY_INTEGRITY'));
  const store = createCashSnapshotStore({ access: f.app.provider, protection: f.protection, actor: f.actor });
  let state = await store.reverify(f.id); while (state.status === 'reviewing') state = await store.review(f.id);
  assert.equal((await f.history().run(f.get, w => w.search(f.query()))).totals.gross, '12.00');
  f.app.database.exec('DELETE FROM cash_snapshot_inventory WHERE table_index=6');
  ensureSqliteDataImportRuntimeSchema(f.app.database);
  await assert.rejects(f.history().run(f.get, w => w.search(f.query())), code('IMPORT_HISTORY_INTEGRITY'));
});

test('legacy verified cash receives one migration baseline and cannot silently regain trust after mutation', async t => {
  const f = await fixture(t); await f.activate();
  // Construct the previous encrypted metadata format and schema on this tiny
  // synthetic database; no source values are reimported or re-normalized.
  const dataset = f.app.database.prepare('SELECT * FROM cash_snapshot_datasets').get();
  const context = ['cash-compact-v1', 'dataset', dataset.slot, dataset.id, dataset.scope_id, dataset.owner_id, dataset.revision, dataset.created_at];
  const source = f.protection.open(dataset.payload, context);
  for (const table of source.tables) delete table.verifiedGeneration;
  f.app.database.prepare('UPDATE cash_snapshot_datasets SET payload=? WHERE slot=?').run(f.protection.seal(source, context), dataset.slot);
  const publication = f.app.database.prepare('SELECT * FROM cash_publications').get();
  const publicationContext = ['cash-publication-v1', publication.id, publication.scope_id, publication.dataset_id, publication.owner_id, publication.created_at];
  const data = f.protection.open(publication.payload, publicationContext); delete data.bindingGeneration;
  f.app.database.prepare('UPDATE cash_publications SET payload=? WHERE id=?').run(f.protection.seal(data, publicationContext), publication.id);
  const triggers = f.app.database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%inventory%'").all();
  for (const { name } of triggers) { assert.match(name, /^[a-z0-9_]+$/); f.app.database.exec(`DROP TRIGGER ${name}`); }
  f.app.database.exec('DROP TABLE cash_snapshot_inventory; DROP TABLE cash_binding_inventory;');
  ensureSqliteDataImportRuntimeSchema(f.app.database);
  assert.deepEqual(f.app.database.prepare('SELECT DISTINCT generation FROM cash_snapshot_inventory').all().map(r => r.generation), [0]);
  assert.equal((await f.history().run(f.get, w => w.search(f.query()))).totals.gross, '12.00');
  ensureSqliteDataImportRuntimeSchema(f.app.database);
  assert.equal((await f.history().run(f.get, w => w.search(f.query()))).totals.gross, '12.00');
  f.app.database.exec("UPDATE cash_publication_bindings SET target_id=target_id WHERE kind='FILIALEN'");
  ensureSqliteDataImportRuntimeSchema(f.app.database);
  await assert.rejects(f.history().run(f.get, w => w.search(f.query())), code('IMPORT_HISTORY_INTEGRITY'));
});

test('a source changed between runtime activation and the query is rejected in the query snapshot', async t => {
  const f = await fixture(t); await f.activate();
  await assert.rejects(f.history().run(f.get, async w => {
    f.app.database.exec('DELETE FROM cash_snapshot_6');
    return w.receipts.search(f.query());
  }), code('IMPORT_HISTORY_INTEGRITY'));
});

test('verified receipt summaries preserve every line filter, lazy details and rights with bounded cold/warm measurements', async t => {
  const f = await fixture(t), data = { Umsatz_KASSE: [], Umsatz_Kasse_Details: [] };
  const receiptCount = 30, positionsPerReceipt = 20;
  for (let i = 1; i <= receiptCount; i++) {
    const source = rows({ count: positionsPerReceipt }), number = String(i).padStart(6, '0');
    data.Umsatz_KASSE.push({ ...source.Umsatz_KASSE[0], Bonnr: number });
    source.Umsatz_Kasse_Details.forEach((line, j) => data.Umsatz_Kasse_Details.push({ ...line, Bonnr: number,
      RepID: '00000000-0000-0000-0000-' + String(i * positionsPerReceipt + j).padStart(12, '0'),
      ...(j === positionsPerReceipt - 1 ? { EAN: 'BOUNDARYLEFT', Artikelbezeichnung: 'BoundaryRight Ärmeltasche Ösen letzte Position' } : {}) }));
  }
  const source = await f.build(data); await f.activate(f.request(source));
  const calls = observeSqlite(t), cold = [], warm = [], q = { ...f.query(), limit: 50 };
  let runtime, result;
  const stats = () => ({ queries: calls.filter(c => c.method !== 'exec').length,
    childReads: calls.filter(c => /FROM cash_snapshot_6(?: INDEXED BY \w+)? WHERE.*parent_row=/.test(c.sql)).length,
    fullCounts: calls.filter(c => /COUNT\(\*\).*FROM cash_(snapshot_\d|publication_bindings)/i.test(c.sql)).length });
  for (let i = 0; i < 3; i++) {
    runtime = f.history(); calls.length = 0; const start = performance.now();
    result = await runtime.run(f.get, w => w.receipts.search(q)); cold.push({ milliseconds: performance.now() - start, ...stats() });
    assert.equal(result.items.length, receiptCount); assert.equal(result.complete, true);
    assert.equal(cold[i].childReads, receiptCount);
  }
  const expected = result.items;
  for (let i = 0; i < 3; i++) {
    calls.length = 0; const start = performance.now();
    result = await runtime.run(f.get, w => w.receipts.search(q)); warm.push({ milliseconds: performance.now() - start, ...stats() });
    assert.deepEqual(result.items, expected); assert.equal(warm[i].childReads, 0); assert.equal(warm[i].fullCounts, 0);
  }
  assert.ok(warm[0].queries < cold[0].queries);
  assert.doesNotMatch(JSON.stringify(result), /sourcePrice|linePersonnel|lineSearch|"lines"|BOUNDARYLEFT|BoundaryRight/);
  for (const query of ['Ärmeltasche Ösen', 'letz* Posit?on', 'BOUNDARYLEFT', 'BoundaryRight']) {
    calls.length = 0;
    const found = await runtime.run(f.get, w => w.receipts.search({ ...q, query }));
    assert.equal(found.items.length, receiptCount, query); assert.equal(stats().childReads, 0);
  }
  // Separate fields must not turn into a new joined identifier in the cache.
  assert.equal((await runtime.run(f.get, w => w.receipts.search({ ...q, query: 'boundaryleftboundaryright' }))).items.length, 0);
  assert.equal((await runtime.run(f.get, w => w.receipts.search({ ...q, seller: 'person-a', sellerRole: 'line_seller' }))).items.length, receiptCount);
  calls.length = 0;
  const opened = await runtime.run(f.get, w => w.receipts.documents({ ids: [result.items[0].id] }));
  assert.equal(opened.items[0].lines.length, positionsPerReceipt); assert.equal(opened.items[0].gross, result.items[0].gross);
  assert.equal(stats().childReads, 1);
  f.session.permissions = f.session.permissions.filter(p => p !== 'sales:history:sellers:read'); calls.length = 0;
  const safe = await runtime.run(f.get, w => w.receipts.search(q));
  assert.doesNotMatch(JSON.stringify(safe), /personnel|person-a|person-b|linePersonnel/);
  assert.equal(stats().childReads, receiptCount);
  f.app.database.exec('UPDATE cash_snapshot_6 SET payload=payload WHERE source_row=1');
  await assert.rejects(runtime.run(f.get, w => w.receipts.search(q)), code('IMPORT_HISTORY_INTEGRITY'));
  const median = values => +[...values].sort((a, b) => a - b)[1].toFixed(3);
  t.diagnostic('CASH_BLOCK3_MEASUREMENT ' + JSON.stringify({ receipts: receiptCount, positionsPerReceipt, sourcePositions: receiptCount * positionsPerReceipt,
    node: process.version, sqlite: f.app.database.prepare('SELECT sqlite_version() version').get().version,
    runs: 3, synthetic: true, coldMedianMs: median(cold.map(r => r.milliseconds)), warmMedianMs: median(warm.map(r => r.milliseconds)),
    coldQueries: cold[0].queries, warmQueries: warm[0].queries, coldChildReads: cold[0].childReads, warmChildReads: warm[0].childReads,
    fullTableCounts: 0, equalResults: true }));
});
