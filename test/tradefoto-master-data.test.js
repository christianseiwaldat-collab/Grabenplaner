"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../lib/data-import-contract");
const M = require("../lib/tradefoto-master-profiles");
const { createDataImportEngine } = require("../lib/data-import-engine");
const { createDataImportProtection } = require("../lib/data-import-protection");
const { createDataImportRepository } = require("../lib/persistence/repositories/data-import");
const { createImportMasterWriters, createImportMasterService } = require("../lib/persistence/repositories/import-master-data");
const { openSqliteApplicationPersistence } = require("../lib/persistence/sqlite/provider");
const { ensureSqliteDataImportSchema } = require("../lib/persistence/sqlite/operations/data-import-schema");
const { ensureSqliteImportMasterSchema, IMPORT_MASTER_SCHEMA_SQL } = require("../lib/persistence/sqlite/operations/import-master-schema");
const { ensureSqliteCrmSchema } = require("../lib/persistence/sqlite/operations/crm-schema");
const { ensureSqliteSalesArticleCatalogSchema } = require("../lib/persistence/sqlite/operations/sales-article-catalog-schema");
const { SQLITE_DATA_IMPORT_CATALOG } = require("../lib/persistence/sqlite/data-import-catalog");
const { SQLITE_IMPORT_MASTER_CATALOG } = require("../lib/persistence/sqlite/import-master-catalog");
const { SQLITE_CRM_CUSTOMERS_CATALOG } = require("../lib/persistence/sqlite/crm-customers-catalog");
const { SQLITE_SALES_ARTICLE_CATALOG } = require("../lib/persistence/sqlite/sales-article-catalog-catalog");
const { IMPORT_MASTER_STATEMENTS: S } = require("../lib/persistence/statements/import-master-data");
const { CRM_CUSTOMER_STATEMENTS: CS } = require("../lib/persistence/statements/crm-customers");
const { compilePostgresqlDialectEntry } = require("../lib/persistence/postgresql/dialect-compiler");
const { createSalesArticleCatalogRepository } = require("../lib/persistence/repositories/sales-article-catalog");
const { salesArticleImportContentSha256 } = require("../lib/sales-article-catalog");
const { TRADEFOTO_ARTICLE_SOURCE_SYSTEM } = require("../lib/tradefoto-article-source-profile");
const SHA = "a".repeat(64), TIME = "2026-09-05T11:00:00.000Z";
const errorCode = code => error => error?.code === code;
const raw = (name, extra = {}) => Object.assign(Object.fromEntries(M.tableFor(name).columns.map(field => [field.name, null])), extra);
const customer = (extra = {}) => raw("KUNDEN", { KUND_NR: "000419", VORNAME: "Synthetisch", NACHNAME: "Testkunde", EMail: "synthetic@example.test", ...extra });
const decision = { customerType: "private" };
async function fixture(t) {
  const app = openSqliteApplicationPersistence({ databasePath: ":memory:", catalog: [
    ...SQLITE_DATA_IMPORT_CATALOG, ...SQLITE_IMPORT_MASTER_CATALOG, ...SQLITE_CRM_CUSTOMERS_CATALOG, ...SQLITE_SALES_ARTICLE_CATALOG,
  ] });
  app.database.exec(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity_type TEXT, entity_id TEXT, detail TEXT, created_at TEXT);
    CREATE TABLE employees (personnel_number TEXT PRIMARY KEY, active INTEGER NOT NULL, full_name TEXT, contracted_hours TEXT, role TEXT);
    CREATE TABLE locations (id TEXT PRIMARY KEY, active INTEGER NOT NULL, name TEXT);`);
  ensureSqliteDataImportSchema(app.database); ensureSqliteImportMasterSchema(app.database); ensureSqliteImportMasterSchema(app.database);
  ensureSqliteCrmSchema(app.database); ensureSqliteSalesArticleCatalogSchema(app.database);
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 1), indexKey: Buffer.alloc(32, 2), keyId: "synthetic" });
  const context = { who: { scopeId: "synthetic-scope", ownerId: "synthetic-owner" }, denied: new Set(), deniedClasses: new Set(), targets: new Set() };
  const composition = { protection, getActor: () => context.who, clock: () => TIME,
    authorize: ({ action, dataClasses, targetId }) => !context.denied.has(action) && !dataClasses.some(name => context.deniedClasses.has(name)) && !context.targets.has(targetId) };
  const writers = createImportMasterWriters({ protection });
  const engine = createDataImportEngine({ ...composition, repository: createDataImportRepository(app.provider), profiles: M.TRADEFOTO_MASTER_PROFILES, writers });
  const service = createImportMasterService({ ...composition, access: app.provider });
  t.after(async () => { protection.destroy(); await app.provider.close(); app.database.close(); });
  let attempt = 0;
  async function ready(name, rows, extra = {}) {
    const profile = M.profileFor(name), fileSha256 = crypto.createHash("sha256").update("synthetic-file" + (++attempt)).digest("hex");
    let run = await engine.start({ profileHash: profile.fingerprint, manifest: { sourceInstance: "test-ledger", fileSha256,
      schemaSha256: profile.schemaSha256, expectedRows: rows.length, declaredRows: rows.length, snapshotAt: TIME, gates: [], ...extra } });
    const prepared = rows.map((row, index) => M.prepareTradeFotoMasterRow(name, row, { fileSha256, rowNumber: index + 1 }));
    for (let start = 0; start < rows.length; start += C.LIMITS.batch) run = await engine.stage(run.id, { expectedRevision: run.revision, startRow: start + 1, rows: prepared.slice(start, start + C.LIMITS.batch) });
    run = await engine.seal(run.id, run.revision);
    do { run = await engine.review(run.id, run.revision); } while (run.status === "reviewing");
    return run;
  }
  const records = name => app.database.prepare("SELECT id, revision FROM import_master_records WHERE source_table=? ORDER BY id").all(name);
  async function ingest(name, rows, extra = {}) {
    let run = await ready(name, rows, extra); assert.equal(run.status, "ready", JSON.stringify(await engine.preview(run.id)));
    do { run = await engine.apply(run.id, run.revision); } while (run.status === "applying");
    return { run, records: records(name) };
  }
  const crm = id => app.provider.queryOne(S.crmGet, { id });
  async function sync(recordId, expectedSourceRevision = 1, options = {}) {
    const input = { recordId, expectedSourceRevision, decision, ...options }, preview = await service.previewCustomer(input);
    return service.syncCustomer(input, preview.planHash);
  }
  async function manual(id, change) {
    const before = await crm(id), { revision, ...data } = before;
    await app.provider.execute(S.crmUpdate, { ...data, ...change, expectedRevision: revision, actor: "manual", timestamp: TIME });
  }
  return { ...app, context, protection, engine, service, writers, ready, ingest, records, crm, sync, manual };
}

test("Block 3: complete pinned master profiles cover 66 tables / 761 fields and exclude both credential fields", () => {
  const metadata = M.TRADEFOTO_MASTER_METADATA;
  assert.equal(metadata.coverage.tables, 66); assert.equal(metadata.coverage.fields, 761);
  assert.equal(M.TRADEFOTO_MASTER_PROFILES.length, 66);
  assert.equal(M.TRADEFOTO_MASTER_PROFILES.reduce((n, p) => n + p.excludedFields.length, 0), 2);
  for (const table of metadata.tables) {
    const profile = M.profileFor(table.name);
    assert.equal(profile.fields.filter(f => !f.source.startsWith("_source_")).length + profile.excludedFields.length, table.columns.length);
    assert.ok(Object.isFrozen(profile));
  }
  assert.deepEqual(M.profileFor("LIEFERANTEN").keyFields, ["Suchname"]);
  assert.deepEqual(M.profileFor("Kunden_Bemerkungen").keyFields, ["_source_snapshot_sha256", "_source_row"]);
});

test("Block 3: reader boundary keeps civil components / zeros / exact decimals and never copies passwords", () => {
  const row = M.prepareTradeFotoMasterRow("KUNDEN", customer({ Kennwort: "NEVER", Geburtstag: new Date("2000-02-29T00:00:00.000Z"), Punkte: 1e-7 }));
  assert.equal(row.Geburtstag, "2000-02-29T00:00:00.000"); assert.equal(row.KUND_NR, "000419"); assert.equal(row.Punkte, "0.0000001");
  assert.ok(!JSON.stringify(row).includes("NEVER"));
  const normalized = C.normalizeDataImportRow(M.profileFor("KUNDEN"), row); assert.ok(normalized.key.includes("000419"));
  assert.throws(() => M.prepareTradeFotoMasterRow("KUNDEN", customer({ KUND_NR: Number.MAX_SAFE_INTEGER + 1 })), errorCode("IMPORT_IDENTIFIER_PRECISION"));
  assert.throws(() => M.prepareTradeFotoMasterRow("KUNDEN", { ...customer(), extra: 1 }), errorCode("IMPORT_SHAPE_INVALID"));
  assert.throws(() => C.normalizeDataImportRow(M.profileFor("KUNDEN"), { ...row, Geburtstag: "2000-02-30T00:00:00.000" }));
  assert.throws(() => C.normalizeDataImportRow(M.profileFor("KUNDEN"), { ...row, Geburtstag: "2000-02-29T00:00:00.000Z" }));
});

test("Block 6: long legacy memos round-trip encrypted and verbatim without widening business text or row limits", async t => {
  const f = await fixture(t), memo = 'Synthetic source only: <script>never execute</script>\u001f' + 'x'.repeat(89000);
  const { records: [record] } = await f.ingest('ARTIKEL_STAMM', [raw('ARTIKEL_STAMM', { EAN: 'memo-test', AKurzbeschreibung: memo })]);
  assert.equal((await f.service.inspect(record.id)).segments.attributes.AKurzbeschreibung, memo);
  const tooLong = M.prepareTradeFotoMasterRow('ARTIKEL_STAMM', raw('ARTIKEL_STAMM', { EAN: 'too-long', AKurzbeschreibung: 'x'.repeat(C.LIMITS.rowBytes / 2 + 1) }));
  assert.throws(() => C.normalizeDataImportRow(M.profileFor('ARTIKEL_STAMM'), tooLong), errorCode('IMPORT_SOURCE_TEXT_INVALID'));
  const businessText = M.prepareTradeFotoMasterRow('KUNDEN', customer({ VORNAME: '\u001funsafe' }));
  assert.throws(() => C.normalizeDataImportRow(M.profileFor('KUNDEN'), businessText), errorCode('IMPORT_FIELD_INVALID'));
});

test("Block 3: isolated source store keeps 97 customer columns, privacy segments and unchanged live CRM", async t => {
  const f = await fixture(t);
  const { records: [record] } = await f.ingest("KUNDEN", [customer({ Kennwort: "NEVER", BankKntNr: "PRIVATE-ACCOUNT", INFO: "Synthetische Notiz", EMailRechnung: "billing@example.test", Internet: true })]);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM crm_customers").get().n, 0);
  const preview = await f.service.inspect(record.id);
  assert.ok(!JSON.stringify(preview).includes("PRIVATE-ACCOUNT")); assert.ok(!JSON.stringify(preview).includes("NEVER"));
  assert.equal(preview.segments.contacts.EMailRechnung, "billing@example.test"); assert.equal(preview.segments.attributes.Internet, true);
  assert.equal((await f.service.inspect(record.id, { include: ["financial"] })).segments.financial.BankKntNr, "PRIVATE-ACCOUNT");
  f.context.deniedClasses.add("restricted_finance");
  await assert.rejects(f.service.inspect(record.id, { include: ["financial"] }), errorCode("IMPORT_FORBIDDEN"));
  assert.ok(await f.service.inspect(record.id));
  const stored = f.database.prepare("SELECT payload FROM import_master_segments").all();
  assert.ok(!JSON.stringify(stored).includes("PRIVATE-ACCOUNT")); assert.ok(!JSON.stringify(stored).includes("Synthetisch"));
});

test("Block 3: every master profile writes and reads a synthetic complete row", async t => {
  const f = await fixture(t);
  for (const table of M.TRADEFOTO_MASTER_METADATA.tables) {
    const values = raw(table.name);
    for (const key of table.keys || []) values[key] = "synthetic-key";
    const { records: [record] } = await f.ingest(table.name, [values]);
    assert.equal((await f.service.inspect(record.id, { include: ["attributes", "contacts", "addresses", "notes", "conditions", "media_references", "loyalty_snapshot", "provenance", "financial", "legacy_personnel", "prices", "costs"] })).revision, 1, table.name);
  }
});

test("Block 3: duplicate note occurrences and uncertain supplier IDs are not merged", async t => {
  const f = await fixture(t);
  await f.ingest("LIEFERANTEN", [raw("LIEFERANTEN", { Suchname: "supplier-A", Lieferant_ID: 17 }), raw("LIEFERANTEN", { Suchname: "supplier-B", Lieferant_ID: 17 })]);
  const note = raw("Kunden_Bemerkungen", { Kund_Nr: 123, Text: "Identische synthetische Notiz" });
  await f.ingest("Kunden_Bemerkungen", [note, note]);
  assert.equal(f.records("LIEFERANTEN").length, 2); assert.equal(f.records("Kunden_Bemerkungen").length, 2);
  await f.ingest("Kunden_Bemerkungen", [note]); assert.equal(f.records("Kunden_Bemerkungen").length, 3);
});

test("Block 3: customer address uses KID, not zero KUND_NR; missing supplier stays unresolved", async t => {
  const f = await fixture(t);
  const { records: [parent] } = await f.ingest("KUNDEN", [customer({ KUND_NR: 123 })]);
  const { run, records: [address] } = await f.ingest("Kunden_Lieferadresse", [raw("Kunden_Lieferadresse", { LID: 1, KID: 123, KUND_NR: 0, Firma: "Synthetic" })]);
  const view = await f.service.inspect(address.id);
  assert.ok(view.relations.some(r => r.parentTable === "KUNDEN" && r.targetId === parent.id && r.status === "resolved"));
  const { records: [article] } = await f.ingest("ARTIKEL_STAMM", [raw("ARTIKEL_STAMM", { EAN: "0000000000123", Suchname: "missing-supplier" })]);
  assert.ok((await f.service.inspect(article.id)).relations.some(r => r.parentTable === "LIEFERANTEN" && r.status === "unresolved"));
  const customerRun = f.database.prepare("SELECT id, revision FROM data_import_runs WHERE profile_hash=?").get(M.profileFor("KUNDEN").fingerprint);
  await assert.rejects(f.engine.undo(customerRun.id, customerRun.revision), errorCode("IMPORT_UNDO_DEPENDENCIES"));
  await f.engine.undo(run.id, run.revision);
  await f.engine.undo(customerRun.id, customerRun.revision);
});

test("CRM import uses KUND_NR as the account and allows an unspecified customer type", async t => {
  const f = await fixture(t), { records: [record] } = await f.ingest("KUNDEN", [customer({ Internet: true, "Großhandelskunde": true })]);
  const preview = await f.service.previewCustomer({ recordId: record.id, expectedSourceRevision: 1 });
  assert.equal(preview.proposed.customerType, 'unknown');
  const result = await f.sync(record.id), target = await f.crm(result.targetId);
  assert.equal(target.accountNumber, "000419"); assert.equal(target.customerNumber, null); assert.equal(target.customerType, "private"); assert.equal(target.website, "");
  assert.notEqual(target.id, "000419");
  assert.equal((await f.service.resolve("KUNDEN", ["000419"], "test-ledger")).targetId, target.id);
  assert.equal((await f.service.resolve("KUNDEN", ["419"], "test-ledger")).status, "missing_source");
});

test('CRM übernimmt namenlose Konten, trennt doppelte TradeFoto-KontoNr und bewahrt Kontakte bei fehlenden Folgeangaben', async t => {
  const f = await fixture(t);
  const { records } = await f.ingest('KUNDEN', [customer({ KUND_NR: '419', KontoNr: 900, VORNAME: null, NACHNAME: null, TELEFON: null, EMail: null }),
    customer({ KUND_NR: '420', KontoNr: 900, VORNAME: null, NACHNAME: null, TELEFON: '111', EMail: null })]);
  const targets = [];
  for (const record of records) {
    const input = { recordId: record.id, expectedSourceRevision: 1 };
    const preview = await f.service.previewCustomer(input), result = await f.service.syncCustomer(input, preview.planHash);
    targets.push(await f.crm(result.targetId));
  }
  assert.deepEqual(targets.map(c => c.accountNumber).sort(), ['419', '420']);
  assert.ok(targets.every(c => !c.firstName && !c.lastName && c.customerNumber === null && c.customerType === 'unknown'));
  const target = targets.find(c => c.accountNumber === '420'); await f.manual(target.id, { phone: 'Manuell 222' });
  await f.ingest('KUNDEN', [customer({ KUND_NR: '419', KontoNr: 900, VORNAME: null, NACHNAME: null, TELEFON: null, EMail: null }),
    customer({ KUND_NR: '420', KontoNr: 900, VORNAME: null, NACHNAME: null, TELEFON: null, EMail: null })]);
  const record = records.find(r => targets[records.indexOf(r)].accountNumber === '420');
  await f.sync(record.id, 2, { decision: {} });
  assert.equal((await f.crm(target.id)).phone, 'Manuell 222');
});

for (const [name, values, code] of [
  ["zero", { KUND_NR: 0 }, "IMPORT_CUSTOMER_UNASSIGNED_ZERO"],
  ["invalid email", { EMail: "broken-email" }, "IMPORT_CRM_EMAIL_INVALID"],
  ["invalid VAT", { UStID: "?invalid?" }, "IMPORT_CRM_VAT_ID_INVALID"],
]) test(`Block 3: ${name} remains in protected source review without inventing a CRM customer`, async t => {
  const f = await fixture(t), { records: [record] } = await f.ingest("KUNDEN", [customer(values)]);
  await assert.rejects(f.sync(record.id), errorCode(code));
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM crm_customers").get().n, 0);
  assert.ok(await f.service.inspect(record.id));
});

test("Block 3: explicit corrections keep the original source and normalize UID without silent data loss", async t => {
  const f = await fixture(t), { records: [record] } = await f.ingest("KUNDEN", [customer({ EMail: "broken-email", UStID: "ATU 12345678" })]);
  const result = await f.sync(record.id, 1, { decision: { customerType: "business", companyName: "Synthetische Firma", corrections: { email: "corrected@example.test" } } });
  assert.equal((await f.crm(result.targetId)).vatId, "ATU12345678");
  assert.equal((await f.service.inspect(record.id)).segments.contacts.EMail, "broken-email");
});

test("Block 3: existing CRM needs confirmed linking, keeps manual fields and does not match by email", async t => {
  const f = await fixture(t);
  const { records: [one] } = await f.ingest("KUNDEN", [customer()]); const first = await f.sync(one.id);
  await f.manual(first.targetId, { lastName: "Manual", website: "https://manual.example.test" });
  // Another source namespace contains the same number. No implicit cross-source merge.
  let run = await f.ready("KUNDEN", [customer()], { sourceInstance: "other-ledger" }); run = await f.engine.apply(run.id, run.revision);
  const secondRecord = f.database.prepare("SELECT id FROM import_master_records WHERE source_instance='other-ledger'").get();
  await assert.rejects(f.sync(secondRecord.id), errorCode("IMPORT_CUSTOMER_MATCH_CONFIRMATION_REQUIRED"));
  const linked = await f.sync(secondRecord.id, 1, { targetId: first.targetId, expectedTargetRevision: 2 });
  assert.equal(linked.action, "link"); assert.equal(linked.changed, false); assert.equal((await f.crm(first.targetId)).lastName, "Manual");
  const { records } = await f.ingest("KUNDEN", [customer({ KUND_NR: "another-number" })]);
  const third = records.find(record => record.id !== one.id && record.id !== secondRecord.id);
  const separate = await f.sync(third.id); assert.notEqual(separate.targetId, first.targetId);
});

test("Block 3: source follow-up preserves manual website, notes, photo metadata and unchanged imported fields", async t => {
  const f = await fixture(t), { records: [record] } = await f.ingest("KUNDEN", [customer({ TELEFON: "111" })]);
  const initial = await f.sync(record.id); await f.manual(initial.targetId, { phone: "manual", website: "https://manual.example.test" });
  await f.provider.execute(CS.insertCustomField, { id: "own-note", customerId: initial.targetId, title: "Ausrüstung", value: "GP-only", sortOrder: 0, revision: 1, actor: "manual", timestamp: TIME });
  await f.provider.execute(CS.upsertPhoto, { customerId: initial.targetId, storageKey: "ab/11111111-1111-4111-8111-111111111111.amu", contentSha256: SHA, byteSize: 100, mediaType: "image/jpeg", originalFilename: "synthetic.jpg", actor: "manual", timestamp: TIME });
  const beforePhoto = f.database.prepare("SELECT * FROM crm_customer_photos").get(), beforeNote = f.database.prepare("SELECT * FROM crm_customer_custom_fields").get();
  await f.ingest("KUNDEN", [customer({ TELEFON: "111", ORT: "Neue Stadt" })]);
  await f.sync(record.id, 2, { decision: undefined });
  const current = await f.crm(initial.targetId);
  assert.equal(current.city, "Neue Stadt"); assert.equal(current.phone, "manual"); assert.equal(current.website, "https://manual.example.test");
  assert.deepEqual(f.database.prepare("SELECT * FROM crm_customer_photos").get(), beforePhoto);
  assert.deepEqual(f.database.prepare("SELECT * FROM crm_customer_custom_fields").get(), beforeNote);
});

test("Block 3: competing source/manual changes block CRM sync; stale previews and source revisions are rejected", async t => {
  const f = await fixture(t), { records: [record] } = await f.ingest("KUNDEN", [customer({ TELEFON: "111" })]);
  const first = await f.sync(record.id); await f.manual(first.targetId, { phone: "manual" });
  const input = { recordId: record.id, expectedSourceRevision: 1, decision }, preview = await f.service.previewCustomer(input);
  await f.manual(first.targetId, { city: "Manual" });
  await assert.rejects(f.service.syncCustomer(input, preview.planHash), errorCode("IMPORT_PREVIEW_CHANGED"));
  await f.ingest("KUNDEN", [customer({ TELEFON: "222" })]);
  await assert.rejects(f.sync(record.id, 1), errorCode("IMPORT_SOURCE_CHANGED"));
  await assert.rejects(f.sync(record.id, 2), errorCode("IMPORT_MANUAL_FIELD_CONFLICT"));
  assert.equal((await f.crm(first.targetId)).phone, "manual");
});

test("Block 3: CRM sync and undo are transactional, audited and allow a preceding undo at fresh revisions", async t => {
  const f = await fixture(t), { run: sourceRun, records: [record] } = await f.ingest("KUNDEN", [customer()]);
  const one = await f.sync(record.id);
  await f.ingest("KUNDEN", [customer({ ORT: "Other" })]); const two = await f.sync(record.id, 2);
  await assert.rejects(f.service.undo(one.eventId), errorCode("IMPORT_UNDO_LATER_IMPORT"));
  await f.service.undo(two.eventId); assert.equal((await f.crm(one.targetId)).city, "");
  await f.service.undo(one.eventId); assert.equal(await f.crm(one.targetId), null);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM import_master_bindings").get().n, 0);
  assert.ok(f.database.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='import.master.undo'").get().n >= 2);
  await assert.rejects(f.engine.undo(sourceRun.id, sourceRun.revision), errorCode("IMPORT_UNDO_LATER_IMPORT"));
});

test("Block 3: manual edits, GP photos/notes and later consumer holds prevent destructive CRM undo", async t => {
  const f = await fixture(t), { records: [record] } = await f.ingest("KUNDEN", [customer()]);
  const result = await f.sync(record.id);
  await f.provider.execute(S.insertHold, { recordId: record.id, consumerId: "synthetic-later-sale" });
  await assert.rejects(f.service.undo(result.eventId), errorCode("IMPORT_UNDO_DEPENDENCIES"));
  await f.provider.execute(S.removeHold, { recordId: record.id, consumerId: "synthetic-later-sale" });
  await f.provider.execute(CS.insertCustomField, { id: "note", customerId: result.targetId, title: "Manuell", value: "Preserve", sortOrder: 0, revision: 1, actor: "manual", timestamp: TIME });
  await assert.rejects(f.service.undo(result.eventId), errorCode("IMPORT_UNDO_DEPENDENCIES"));
  await f.manual(result.targetId, { phone: "manual" });
  await assert.rejects(f.service.undo(result.eventId), errorCode("IMPORT_UNDO_MANUAL_CHANGE"));
});

test("Block 3: failed central audit rolls back CRM, binding and protected event together", async t => {
  const f = await fixture(t), { records: [record] } = await f.ingest("KUNDEN", [customer()]);
  const input = { recordId: record.id, expectedSourceRevision: 1, decision }, preview = await f.service.previewCustomer(input);
  f.database.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
  await assert.rejects(f.service.syncCustomer(input, preview.planHash), errorCode("IMPORT_OPERATION_FAILED"));
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM crm_customers").get().n, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM import_master_bindings").get().n, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM import_master_events").get().n, 0);
});

test("Block 3: employee mapping is explicit, historical/inactive-aware and never changes roles or hours", async t => {
  const f = await fixture(t);
  f.database.exec("INSERT INTO employees VALUES('00419',1,'Synthetic','38.5','developer'); INSERT INTO employees VALUES('old',0,'Historic','20','employee')");
  const { records: [record] } = await f.ingest("MITARBEITER", [raw("MITARBEITER", { "Verkäufer_ID": 419, VORNAME: "Synthetic", Urlaub: 99, Montag: 99, Kennwort: "NEVER" })]);
  assert.equal((await f.service.resolve("MITARBEITER", ["419"], "test-ledger")).status, "unlinked");
  const input = { recordId: record.id, expectedSourceRevision: 1, targetId: "00419", historical: false, reason: "Explizit synthetisch bestätigt" };
  const preview = await f.service.previewBinding(input), result = await f.service.bind(input, preview.planHash);
  assert.equal(result.targetId, "00419"); assert.equal(f.database.prepare("SELECT role FROM employees WHERE personnel_number='00419'").get().role, "developer");
  assert.equal(f.database.prepare("SELECT contracted_hours FROM employees WHERE personnel_number='00419'").get().contracted_hours, "38.5");
  await f.service.undo(result.eventId);
  await assert.rejects(f.service.previewBinding({ ...input, targetId: "old" }), errorCode("IMPORT_MAPPING_INACTIVE_TARGET"));
  const historical = { ...input, targetId: "old", historical: true }, approved = await f.service.previewBinding(historical);
  await f.service.bind(historical, approved.planHash);
  assert.equal((await f.service.resolve("MITARBEITER", ["419"], "test-ledger")).status, "historical_mapping");
});

test("Block 3: location mapping rejects a preview after activation changes and zero sellers remain unassigned", async t => {
  const f = await fixture(t); f.database.exec("INSERT INTO locations VALUES('branch',1,'Synthetic')");
  const { records: [record] } = await f.ingest("FILIALEN", [raw("FILIALEN", { FilialID: 7 })]);
  const input = { recordId: record.id, expectedSourceRevision: 1, targetId: "branch", historical: false, reason: "Synthetic" }, preview = await f.service.previewBinding(input);
  f.database.exec("UPDATE locations SET active=0 WHERE id='branch'");
  await assert.rejects(f.service.bind(input, preview.planHash), errorCode("IMPORT_MAPPING_INACTIVE_TARGET"));
  assert.equal((await f.service.resolve("MITARBEITER", ["0"], "test-ledger")).status, "unassigned");
  const { records: [zero] } = await f.ingest("MITARBEITER", [raw("MITARBEITER", { "Verkäufer_ID": 0 })]);
  await assert.rejects(f.service.previewBinding({ ...input, recordId: zero.id }), errorCode("IMPORT_EMPLOYEE_UNASSIGNED_ZERO"));
});

test("Block 3: article extensions reuse the existing authoritative source binding, prices and internal identity", async t => {
  const f = await fixture(t);
  const article = { sourceArticleKey: "0000000093757", articleNumber: "093757", description: "Synthetic central article", active: true, sourceUpdatedAt: null, identifiers: [],
    prices: [{ priceType: "sales", amount: "12.50", currency: "EUR", priceBasis: "gross", qualityStatus: "confirmed", sourceField: "Verkaufspreis" }] };
  const repository = createSalesArticleCatalogRepository(f.provider);
  await repository.importSnapshot({ snapshot: { sourceSystem: TRADEFOTO_ARTICLE_SOURCE_SYSTEM, sourceProfileVersion: "synthetic.v1", sourceSchemaSha256: SHA,
    sourceFileSha256: SHA, snapshotAt: TIME, articles: [article], contentSha256: salesArticleImportContentSha256([article]) }, actor: "synthetic", timestamp: TIME });
  const before = await repository.getByArticleNumber("093757");
  const { records: [record] } = await f.ingest("ARTIKEL_STAMM", [raw("ARTIKEL_STAMM", { EAN: article.sourceArticleKey, Artikelbezeichnung: "Different source text", Verkaufspreis: 999, ABild: "\\\\not-opened\\synthetic.jpg" })]);
  const input = { recordId: record.id, expectedSourceRevision: 1, historical: false, reason: "Existing Trade source binding" };
  const preview = await f.service.previewBinding(input); await f.service.bind(input, preview.planHash);
  assert.equal(preview.targetId, before.productId); assert.deepEqual(await repository.getByArticleNumber("093757"), before);
  assert.equal((await f.service.resolve("ARTIKEL_STAMM", [article.sourceArticleKey], "test-ledger")).targetId, before.productId);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM sales_articles").get().n, 1);
});

test("Block 3: scope, capability revocation and target authorization cover reads, plans, apply and undo", async t => {
  const f = await fixture(t), { records: [record] } = await f.ingest("KUNDEN", [customer()]);
  const input = { recordId: record.id, expectedSourceRevision: 1, decision }, preview = await f.service.previewCustomer(input);
  f.context.denied.add("customer.sync"); await assert.rejects(f.service.syncCustomer(input, preview.planHash), errorCode("IMPORT_FORBIDDEN")); f.context.denied.clear();
  const result = await f.service.syncCustomer(input, preview.planHash);
  f.context.targets.add(result.targetId); await assert.rejects(f.service.previewCustomer(input), errorCode("IMPORT_FORBIDDEN")); await assert.rejects(f.service.undo(result.eventId), errorCode("IMPORT_FORBIDDEN")); f.context.targets.clear();
  f.context.who.scopeId = "different-scope"; await assert.rejects(f.service.inspect(record.id), errorCode("IMPORT_MASTER_NOT_FOUND"));
  assert.equal((await f.service.resolve("KUNDEN", ["000419"], "test-ledger")).status, "missing_source");
});

test("Block 3: source encryption detects segment and binding substitution", async t => {
  const f = await fixture(t), { records: [record] } = await f.ingest("KUNDEN", [customer()]); const result = await f.sync(record.id);
  f.database.prepare("UPDATE import_master_bindings SET target_id=? WHERE record_id=?").run("forged-id", record.id);
  await assert.rejects(f.service.undo(result.eventId), errorCode("IMPORT_PROTECTED_PAYLOAD_INVALID"));
  f.database.prepare("UPDATE import_master_segments SET data_class='internal_business' WHERE record_id=? AND kind='contacts'").run(record.id);
  await assert.rejects(f.service.inspect(record.id), errorCode("IMPORT_PROTECTED_PAYLOAD_INVALID"));
});

test("Block 3/6: bound records block unsafe undo; source floating decimals retain all reader digits", async t => {
  const f = await fixture(t), { records: [record], run } = await f.ingest("KUNDEN", [customer()]); await f.sync(record.id);
  await assert.rejects(f.engine.undo(run.id, run.revision), errorCode("IMPORT_UNDO_DEPENDENCIES"));
  const precise = await f.ready("KUNDEN", [customer({ KUND_NR: "precision", Punkte: 0.123456789012345 })]);
  assert.equal(precise.status, "ready"); assert.equal(precise.counts.invalid || 0, 0);
  assert.equal((await f.engine.detail(precise.id, 1)).source.Punkte, "0.123456789012345");
});

test("Productive Block 1: master statements compile portably and registration does not activate an import", () => {
  assert.equal(SQLITE_IMPORT_MASTER_CATALOG.length, Object.keys(S).length);
  for (const entry of SQLITE_IMPORT_MASTER_CATALOG) assert.equal(compilePostgresqlDialectEntry(entry).strategy, "portable-generated", entry.statement.id);
  assert.ok(!/AUTOINCREMENT|PRAGMA|GLOB|json_|rowid|RAISE\(/iu.test(IMPORT_MASTER_SCHEMA_SQL));
  const catalog=require('../lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG;
  assert.ok(SQLITE_IMPORT_MASTER_CATALOG.every(e=>catalog.some(c=>c.statement===e.statement)));
  assert.match(fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),/createDataImportRuntime\(\{[^}]*allowApply: false/);
});

test('Productive Block 2: mapping directory is bounded, exact-keyed, class-protected and preserves leading zeros', async t => {
  const f = await fixture(t);
  await f.ingest('KUNDEN', [customer(), customer({ KUND_NR: '419', VORNAME: 'Anderer', NACHNAME: 'Kunde' })]);
  const query = { table: 'KUNDEN', sourceInstance: 'test-ledger', limit: 1 };
  const first = await f.service.mappings(query), second = await f.service.mappings({ ...query, after: first.next });
  assert.equal(first.items.length, 1); assert.ok(first.next); assert.equal(second.items.length, 1); assert.equal(second.next, null);
  assert.notEqual(first.items[0].id, second.items[0].id);
  const exact = await f.service.mappings({ ...query, key: '000419' });
  assert.equal(exact.items[0].number, '000419'); assert.equal(exact.items[0].customer.email, 'synthetic@example.test');
  assert.doesNotMatch(JSON.stringify(exact), /Kennwort|Passwort|Bank|Konto|conditions|Umsatz/);
  const linked = await f.sync(exact.items[0].id);
  const bound = await f.service.mappings({ ...query, key: '000419', status: 'linked' });
  assert.equal(bound.items[0].binding.targetId, linked.targetId); assert.equal(bound.items[0].undoEventId, linked.eventId);
  assert.equal((await f.service.mappings({ ...query, key: '000419', status: 'unlinked' })).items.length, 0);
  f.context.deniedClasses.add('customer_restricted'); await assert.rejects(f.service.mappings(query), errorCode('IMPORT_FORBIDDEN'));
});

test('Productive Block 2: target choices contain only IDs, names and activation; no matching by similar name', async t => {
  const f = await fixture(t);
  f.database.exec("INSERT INTO employees VALUES ('419',1,'Synthetic Person','38.5','developer'),('0419',0,'Synthetic Historical','0','employee'); INSERT INTO locations VALUES ('gp-18',1,'Synthetischer Standort');");
  const exact = await f.service.mappingTargets({ table: 'MITARBEITER', query: '419' });
  assert.deepEqual(exact.items, [{ id: '419', label: 'Synthetic Person', active: true }]);
  const first = await f.service.mappingTargets({ table: 'MITARBEITER', limit: 1 }); assert.equal(first.items[0].active, false); assert.ok(first.next);
  const second = await f.service.mappingTargets({ table: 'MITARBEITER', limit: 1, after: first.next }); assert.equal(second.items[0].id, '419');
  assert.equal((await f.service.mappingTargets({ table: 'MITARBEITER', query: 'Synthetic%' })).items.length, 0);
  assert.equal((await f.service.mappingTargets({ table: 'FILIALEN' })).items[0].label, 'Synthetischer Standort');
  assert.doesNotMatch(JSON.stringify(second), /developer|38.5|contracted_hours/);
  f.context.deniedClasses.add('personnel_restricted'); await assert.rejects(f.service.mappingTargets({ table: 'MITARBEITER' }), errorCode('IMPORT_FORBIDDEN'));
});

test('Productive Block 2: trusted source namespace rejects a record transplanted from another import', async t => {
  const f = await fixture(t), { records: [record] } = await f.ingest('KUNDEN', [customer()]);
  const service = createImportMasterService({ access: f.provider, protection: f.protection, getActor: () => f.context.who, authorize: () => true, sourceInstance: 'different-source' });
  await assert.rejects(service.previewCustomer({ recordId: record.id, expectedSourceRevision: 1, decision }), errorCode('IMPORT_MASTER_NOT_FOUND'));
});

test("Block 3: sales/cost source fields cannot bypass the existing split price permissions", async t => {
  const f = await fixture(t), { records: [record] } = await f.ingest("ARTIKEL_STAMM", [raw("ARTIKEL_STAMM", {
    EAN: "0000000000123", Verkaufspreis: "99", DurchschnittEK: "49", WKZ: "7.5",
  })]);
  const ordinary = await f.service.inspect(record.id);
  assert.ok(!Object.hasOwn(ordinary.segments, "prices")); assert.ok(!Object.hasOwn(ordinary.segments, "costs"));
  f.context.deniedClasses.add("catalog_costs");
  assert.equal((await f.service.inspect(record.id, { include: ["prices"] })).segments.prices.Verkaufspreis, "99");
  await assert.rejects(f.service.inspect(record.id, { include: ["costs"] }), errorCode("IMPORT_FORBIDDEN"));
  f.context.deniedClasses.add("catalog_prices");
  await assert.rejects(f.service.inspect(record.id, { include: ["prices"] }), errorCode("IMPORT_FORBIDDEN"));
  const profile = M.profileFor("LIEFERANTEN_Konditionen"); assert.ok(profile.dataClasses.includes("catalog_costs"));
});

test("Block 3: business views separate contacts, supplier conditions, addresses and unverified media/consent", async t => {
  const f = await fixture(t), { records: [record] } = await f.ingest("KUNDEN", [customer({ Handy: "synthetic-phone", Internet: true, Newsletter: true, SkontoT1: 10, SkontoP1: "2.5" })]);
  const view = await f.service.view(record.id);
  assert.equal(view.website, null); assert.equal(view.consent.grantsConsent, false);
  assert.ok(view.contacts.some(contact => contact.purpose === "mobile" && !contact.verified));
  assert.equal(view.conditions.cashDiscounts[0].percent, null); assert.ok(view.omittedSegments.includes("financial"));
  const finance = await f.service.view(record.id, { include: ["attributes", "contacts", "financial"] });
  assert.equal(finance.conditions.cashDiscounts[0].percent, "2.5"); assert.equal(view.conditions.operationallyApplied, false);
  const { records: [address] } = await f.ingest("Kunden_Lieferadresse", [raw("Kunden_Lieferadresse", { KID: 419, KUND_NR: 0, Adresse1: "Synthetic" })]);
  assert.equal((await f.service.view(address.id)).address.sourceCustomerNumber, "419");
  const { records: [supplier] } = await f.ingest("LIEFERANTEN", [raw("LIEFERANTEN", { Suchname: "Supplier", Firma: "Synthetisch", FHomepage: "https://not-fetched.invalid/" })]);
  assert.equal((await f.service.view(supplier.id)).supplier.sourceCode, "Supplier");
  const { records: [terms] } = await f.ingest("LIEFERANTEN_Konditionen", [raw("LIEFERANTEN_Konditionen", { Suchname: "Supplier", Kondition: "A", Rabatt1: "4" })]);
  const supplierTerms = await f.service.view(terms.id, { include: ["costs"] });
  assert.equal(supplierTerms.conditions.invoiceDiscounts[0].value, "4"); assert.equal(supplierTerms.conditions.arithmeticRequiresReview, true);
});

test("Block 3: declared taxonomy links use checked candidate keys while unproven references stay review-only", async t => {
  const f = await fixture(t), { records: [assortment] } = await f.ingest("ARTIKEL_Sortimente", [raw("ARTIKEL_Sortimente", { Sortiment: 123 })]);
  const { records: [article] } = await f.ingest("ARTIKEL_STAMM", [raw("ARTIKEL_STAMM", { EAN: "0000000000123", Sortiment: 123 })]);
  assert.ok((await f.service.inspect(article.id)).relations.some(relation => relation.parentTable === "ARTIKEL_Sortimente" && relation.targetId === assortment.id));
  const relationship = M.TRADEFOTO_MASTER_METADATA.relations.find(relation => relation.from === "Kunden_Lieferadresse" && relation.fields[0] === "KUND_NR");
  assert.equal(relationship.reviewOnly, true);
});

test('Report and article metadata read only explicit source fields and reject missing encrypted segments', async t => {
  const f = await fixture(t);
  const { records: [record] } = await f.ingest('ARTIKEL_STAMM', [raw('ARTIKEL_STAMM', {
    EAN: '0000000000123', Marke: 'Canon', Sortiment: 130, Suchname: 'Testlieferant', DurchschnittEK: '49', ABild: 'not-opened.jpg',
  })]);
  const { createSalesMasterReader } = require('../lib/persistence/repositories/sales-master-data');
  const reader = createSalesMasterReader({ protection: f.protection, scopeId: f.context.who.scopeId, sourceInstance: 'test-ledger' });
  const read = () => f.provider.transaction(tx => reader.byKey(tx, 'ARTIKEL_STAMM', ['0000000000123'], ['Marke','Sortiment','Suchname']), { readOnly: true });
  assert.deepEqual(await read(), { Marke: 'Canon', Sortiment: '130', Suchname: 'Testlieferant' });
  assert.equal(await f.provider.transaction(tx => reader.byKey(tx, 'ARTIKEL_STAMM', ['not-present'], ['Marke'])), null);
  f.database.prepare('DELETE FROM import_master_segments WHERE record_id=? AND data_class=?').run(record.id, 'catalog_costs');
  await assert.rejects(read(), errorCode('IMPORT_MASTER_INTEGRITY'));
});

test('report dictionaries read reviewed labels without applying master rows and reject source tampering', async t => {
  const f = await fixture(t), run = await f.ready('ARTIKEL_Sortimente', [raw('ARTIKEL_Sortimente', { Sortiment: 130, Bezeichnung: 'Systemkameras', Warengruppe: 13 })]);
  const { createSalesMasterReader } = require('../lib/persistence/repositories/sales-master-data');
  const reader = createSalesMasterReader({ protection: f.protection, scopeId: f.context.who.scopeId, sourceInstance: 'test-ledger' });
  const read = () => f.provider.transaction(tx => reader.dictionary(tx, 'ARTIKEL_Sortimente', ['Sortiment', 'Bezeichnung', 'Warengruppe']), { readOnly: true });
  assert.deepEqual(await read(), [{ Sortiment: '130', Bezeichnung: 'Systemkameras', Warengruppe: '13' }]);
  assert.equal(f.records('ARTIKEL_Sortimente').length, 0);
  await assert.rejects(f.provider.transaction(tx => reader.dictionary(tx, 'KUNDEN', ['NACHNAME']), { readOnly: true }), errorCode('IMPORT_FORBIDDEN'));
  f.database.prepare("UPDATE data_import_rows SET content_hash=? WHERE run_id=?").run('0'.repeat(64), run.id);
  await assert.rejects(read());
});

test("Block 3: resolving a mapped target rechecks scope permissions and current activation", async t => {
  const f = await fixture(t); f.database.exec("INSERT INTO employees VALUES('gp-person',1,'Synthetic','38.5','employee')");
  const { records: [record] } = await f.ingest("MITARBEITER", [raw("MITARBEITER", { "Verkäufer_ID": 123 })]);
  const input = { recordId: record.id, expectedSourceRevision: 1, targetId: "gp-person", historical: false, reason: "Synthetic mapping" };
  const preview = await f.service.previewBinding(input), result = await f.service.bind(input, preview.planHash);
  f.context.targets.add("gp-person"); await assert.rejects(f.service.resolve("MITARBEITER", ["123"], "test-ledger"), errorCode("IMPORT_FORBIDDEN")); f.context.targets.clear();
  f.database.exec("UPDATE employees SET active=0 WHERE personnel_number='gp-person'");
  assert.equal((await f.service.resolve("MITARBEITER", ["123"], "test-ledger")).status, "target_inactive");
  f.context.who.ownerId = "other-owner";
  await assert.rejects(f.service.undo(result.eventId), errorCode("IMPORT_UNDO_EVENT_UNAVAILABLE"));
});

test("Block 3: changing source namespace metadata cannot transplant an encrypted master record", async t => {
  const f = await fixture(t), { records: [record] } = await f.ingest("KUNDEN", [customer()]);
  f.database.prepare("UPDATE import_master_records SET source_instance='forged-namespace' WHERE id=?").run(record.id);
  await assert.rejects(f.service.inspect(record.id), errorCode("IMPORT_PROTECTED_PAYLOAD_INVALID"));
});
