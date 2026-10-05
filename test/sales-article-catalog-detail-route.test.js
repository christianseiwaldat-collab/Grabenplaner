"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-article-detail-route-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const {
  SALES_ARTICLE_CATALOG_PERMISSIONS,
} = require("../lib/sales-article-catalog-access");
const subject = require("../server");
const { app, db } = subject;

const EMPLOYEE_NUMBER = "article-detail-manager";
const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "a".repeat(64);
const ARTICLE_NUMBER = "DETAIL-100";
const TIMESTAMP = "2026-09-03T12:00:00.000Z";
const WINDOW_READER_A = "article-window-reader-a";
const WINDOW_READER_B = "article-window-reader-b";
const WINDOW_ACCESS_ONLY = "article-window-access-only";
const WINDOW_READ_WITHOUT_ACCESS = "article-window-read-without-access";
let httpServer;
let baseUrl;

function createSession(employeeNumber = EMPLOYEE_NUMBER) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return `grabenplaner_session=${encodeURIComponent(token)}`;
}

function grant(permission, employeeNumber = EMPLOYEE_NUMBER) {
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, ?, ?)
  `).run(employeeNumber, permission, EMPLOYEE_NUMBER);
}

function seedPreferenceEmployee(employeeNumber, permissions) {
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, color, contracted_hours,
      target_workdays_per_week, fixed_workdays, home_location_id,
      preferred_department_id, position_id, active
    )
    SELECT ?, 'Synthetisches Suchfensterkonto', 'Fenster', '#26785f', 38.5, 5, '',
      home_location_id, preferred_department_id, position_id, 1
    FROM employees WHERE personnel_number = ?
  `).run(employeeNumber, EMPLOYEE_NUMBER);
  db.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password,
      password_changed_at, updated_at
    ) VALUES (?, 'test-only', 'employee', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber);
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    SELECT ?, location_id, department_id, ? FROM portal_access_scopes WHERE employee_number = ?
  `).run(employeeNumber, EMPLOYEE_NUMBER, EMPLOYEE_NUMBER);
  for (const permission of permissions) grant(permission, employeeNumber);
}

async function requestJson(route, employeeNumber = EMPLOYEE_NUMBER) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { Accept: "application/json", Cookie: createSession(employeeNumber) },
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload, text };
}

async function requestMutationJson(route, {
  method = "GET",
  body,
  includeCsrf = true,
  employeeNumber = EMPLOYEE_NUMBER,
  csrfHeader,
} = {}) {
  const csrf = crypto.randomBytes(24).toString("hex");
  const headers = {
    Accept: "application/json",
    Cookie: `${createSession(employeeNumber)}; grabenplaner_csrf=${encodeURIComponent(csrf)}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (includeCsrf && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = csrfHeader === undefined ? csrf : csrfHeader;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload, text };
}

function seedArticle() {
  const insertPrice = db.prepare(`
    INSERT INTO sales_article_price_snapshots (
      id, product_id, source_snapshot_id, price_type, amount, currency,
      price_basis, quality_status, source_field, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, 'EUR', ?, ?, ?, 'sensitive-importer', ?)
  `);
  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO sales_article_import_snapshots (
        id, idempotency_key, source_system, source_profile_version,
        source_schema_sha256, source_file_sha256, content_sha256, snapshot_at,
        article_count, identifier_count, price_count, imported_by, imported_at
      ) VALUES (?, ?, 'tradefoto.artikel_stamm', 'detail-test-v1', ?, ?, ?, ?, 1, 1, 9,
        'sensitive-importer', ?)
    `).run(SNAPSHOT_ID, "b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64), TIMESTAMP, TIMESTAMP);
    db.prepare(`
      INSERT INTO sales_articles (
        product_id, article_number, source_system, source_article_key,
        current_revision, created_by, created_at, updated_by, updated_at
      ) VALUES (?, ?, 'manual.loan', 'private-source-key', 1,
        'sensitive-creator', ?, 'sensitive-updater', ?)
    `).run(PRODUCT_ID, ARTICLE_NUMBER, TIMESTAMP, TIMESTAMP);
    db.prepare(`
      INSERT INTO sales_article_revisions (
        product_id, revision, article_number, description, active,
        source_snapshot_id, source_updated_at, created_by, created_at
      ) VALUES (?, 1, ?, 'Synthetischer Detailartikel', 1, ?, ?, 'sensitive-revision-actor', ?)
    `).run(PRODUCT_ID, ARTICLE_NUMBER, SNAPSHOT_ID, TIMESTAMP, TIMESTAMP);
    db.prepare(`
      INSERT INTO sales_article_identifiers (
        id, product_id, source_snapshot_id, identifier_type, identifier_value,
        canonical_gtin14, is_primary, source_field, source_rank,
        equivalent_identifiers_json, source_provider, verified_at,
        created_by, created_at, updated_by, updated_at
      ) VALUES (?, ?, ?, 'ean13', '4006381333931', '04006381333931', 1,
        'private-ean-field', 1, ?, 'private-provider', ?,
        'sensitive-identifier-creator', ?, 'sensitive-identifier-updater', ?)
    `).run(
      "22222222-2222-4222-8222-222222222222",
      PRODUCT_ID,
      SNAPSHOT_ID,
      JSON.stringify([{
        identifierType: "ean13",
        identifierValue: "4006381333931",
        canonicalGtin14: "04006381333931",
        isPrimary: true,
        sourceField: "private-equivalent-field",
        sourceRank: 1,
        sourceProvider: "private-provider",
        verifiedAt: TIMESTAMP,
        createdBy: "sensitive-equivalent-actor",
        updatedBy: "sensitive-equivalent-actor",
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      }]),
      TIMESTAMP,
      TIMESTAMP,
      TIMESTAMP,
    );
    insertPrice.run("33333333-3333-4333-8333-333333333331", PRODUCT_ID, SNAPSHOT_ID, "sales", "199.990000000000", "gross", "confirmed", "private-sales-field", TIMESTAMP);
    insertPrice.run("33333333-3333-4333-8333-333333333332", PRODUCT_ID, SNAPSHOT_ID, "internet_1", "189.000000000000", "gross", "inferred", "private-internet-field", TIMESTAMP);
    insertPrice.run("33333333-3333-4333-8333-333333333333", PRODUCT_ID, SNAPSHOT_ID, "average_purchase", "100.000000000000", "unknown", "confirmed", "private-cost-field", TIMESTAMP);
    insertPrice.run("33333333-3333-4333-8333-333333333334", PRODUCT_ID, SNAPSHOT_ID, "special", "88.000000000000", "unknown", "unresolved", "private-special-field", TIMESTAMP);
    insertPrice.run("33333333-3333-4333-8333-333333333335", PRODUCT_ID, SNAPSHOT_ID, "other", "-1.000000000000", "unknown", "quarantined", "private-other-field", TIMESTAMP);
    insertPrice.run("33333333-3333-4333-8333-333333333336", PRODUCT_ID, SNAPSHOT_ID, "future_purchase", "120.000000000000", "unknown", "unresolved", "ListeneckpreisZu", TIMESTAMP);
    insertPrice.run("33333333-3333-4333-8333-333333333337", PRODUCT_ID, SNAPSHOT_ID, "future_purchase", "110.000000000000", "unknown", "unresolved", "RechnungspreisZu", TIMESTAMP);
    insertPrice.run("33333333-3333-4333-8333-333333333338", PRODUCT_ID, SNAPSHOT_ID, "future_purchase", "100.000000000000", "unknown", "unresolved", "NNPreisZu", TIMESTAMP);
    insertPrice.run("33333333-3333-4333-8333-333333333339", PRODUCT_ID, SNAPSHOT_ID, "future_purchase", "90.000000000000", "unknown", "unresolved", "SonderPreisZu", TIMESTAMP);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test.before(async () => {
  const location = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get();
  const position = db.prepare("SELECT id FROM positions ORDER BY id LIMIT 1").get();
  let department = db.prepare(`
    SELECT id FROM departments
    WHERE location_id = ? AND active = 1
    ORDER BY id LIMIT 1
  `).get(location.id);
  if (!department) {
    department = db.prepare(`
      INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, 'Artikelstamm Detailroute', 0, 1, 9293)
      RETURNING id
    `).get(location.id);
  }
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, color, contracted_hours,
      target_workdays_per_week, fixed_workdays, home_location_id,
      preferred_department_id, position_id, active
    ) VALUES (?, 'Artikelstamm Detailmanager', 'Detail', '#26785f', 38.5, 5, '', ?, ?, ?, 1)
  `).run(EMPLOYEE_NUMBER, location.id, department.id, position.id);
  db.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password,
      password_changed_at, updated_at
    ) VALUES (?, 'test-only', 'manager', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(EMPLOYEE_NUMBER);
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, ?)
  `).run(EMPLOYEE_NUMBER, location.id, EMPLOYEE_NUMBER);
  grant(SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS);
  grant(SALES_ARTICLE_CATALOG_PERMISSIONS.READ);
  for (const employeeNumber of [WINDOW_READER_A, WINDOW_READER_B]) {
    seedPreferenceEmployee(employeeNumber, [SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS, SALES_ARTICLE_CATALOG_PERMISSIONS.READ]);
  }
  seedPreferenceEmployee(WINDOW_ACCESS_ONLY, [SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS]);
  seedPreferenceEmployee(WINDOW_READ_WITHOUT_ACCESS, [SALES_ARTICLE_CATALOG_PERMISSIONS.READ]);
  const denyPermission = db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, ?, ?)
  `);
  for (const permission of ["schedule:read", "schedule:write"]) {
    denyPermission.run(EMPLOYEE_NUMBER, permission, EMPLOYEE_NUMBER);
  }
  seedArticle();

  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test('Eigene Tabelleneinstellungen benötigen nur Leserecht, prüfen CSRF und filtern geschützte Spalten', async () => {
  const route = '/api/sales/articles/preferences';
  const initial = await requestJson(route); assert.equal(initial.response.status, 200);
  assert.equal(initial.payload.visibleRows, 10); assert.ok(!initial.payload.columnsAvailable.some(c => c.id === 'purchaseNet'));
  const body = { columns: ['description','articleNumber','purchaseNet'], columnWidths: {description:420, articleNumber:125}, visibleRows: 20, sort: 'purchaseNet', direction: 'desc' };
  assert.equal((await requestMutationJson(route, { method: 'PUT', body, includeCsrf: false })).response.status, 403);
  assert.equal((await requestMutationJson(route, { method: 'PUT', body })).response.status, 403);
  body.columns.pop(); body.sort = 'articleNumber';
  const saved = await requestMutationJson(route, { method: 'PUT', body }); assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.deepEqual(saved.payload.columns, ['description','articleNumber']); assert.equal(saved.payload.sort, 'articleNumber');
  const reloaded = await requestJson(route); assert.equal(reloaded.payload.visibleRows, 20); assert.deepEqual(reloaded.payload.columns, saved.payload.columns);
  assert.deepEqual(reloaded.payload.columnWidths, body.columnWidths);
  const legacy = {...body}; delete legacy.columnWidths;
  assert.deepEqual((await requestMutationJson(route, {method:'PUT', body:legacy})).payload.columnWidths, body.columnWidths, 'An older open GP tab must retain saved widths');
  assert.equal((await requestMutationJson(route, {method:'PUT', body:{...body, columnWidths:{purchaseNet:150}}})).response.status, 403);
  for (const invalid of [{ ...body, visibleRows: 4 }, { ...body, visibleRows: 21 }, { ...body, employeeNumber: 'another-user' }]) {
    assert.equal((await requestMutationJson(route, { method: 'PUT', body: invalid })).response.status, 400);
  }
  for (const columnWidths of [null, [], {description:79}, {description:801}, {description:'300'}, {unknown:120}, {description:120.5}]) {
    assert.equal((await requestMutationJson(route, {method:'PUT', body:{...body, columnWidths}})).response.status, 400);
  }
  assert.equal((await requestJson('/api/sales/articles?sort=purchaseNet')).response.status, 403);
});

test('Suchfenster speichern Geometrie und Minimierung mit echtem ACCESS+READ ohne WRITE oder IMPORT', async () => {
  const model = require('../lib/sales-article-search-window-preferences');
  const route = '/api/sales/articles/window-preferences';
  const owner = WINDOW_READER_A;
  const detail = await requestJson(`/api/sales/articles/detail?articleNumber=${ARTICLE_NUMBER}`, owner);
  assert.equal(detail.response.status, 200, detail.text);
  assert.deepEqual(detail.payload.capabilities, { pricesRead: false, costsRead: false, write: false, import: false });
  const grants = db.prepare('SELECT permission FROM portal_permission_grants WHERE employee_number = ? ORDER BY permission').all(owner);
  assert.deepEqual(grants.map(entry => entry.permission), [SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS, SALES_ARTICLE_CATALOG_PERMISSIONS.READ].sort());

  const initial = await requestJson(route, owner);
  assert.equal(initial.response.status, 200, initial.text);
  assert.deepEqual(initial.payload, { ...model.DEFAULT_PREFERENCES, configured: false });
  assert.match(initial.response.headers.get('cache-control'), /private.*no-store/);
  assert.equal(initial.response.headers.get('x-content-type-options'), 'nosniff');
  const tableBody = { columns: ['description', 'articleNumber'], columnWidths: { description: 420, articleNumber: 125 }, visibleRows: 20, sort: 'articleNumber', direction: 'desc' };
  const tableSaved = await requestMutationJson('/api/sales/articles/preferences', { method: 'PUT', body: tableBody, employeeNumber: owner });
  assert.equal(tableSaved.response.status, 200, tableSaved.text);
  const tableBefore = await requestJson('/api/sales/articles/preferences', owner);
  const storedTableBefore = db.prepare('SELECT value FROM portal_user_preferences WHERE employee_number = ? AND preference_key = ?').get(owner, 'sales_article_table_v1').value;

  const body = { version: 1, x: 355, y: 48, width: 720, height: 810, minimized: true };
  for (const csrfOptions of [{ includeCsrf: false }, { csrfHeader: 'wrong-csrf-token' }]) {
    const denied = await requestMutationJson(route, { method: 'PUT', body, employeeNumber: owner, ...csrfOptions });
    assert.equal(denied.response.status, 403, denied.text);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM portal_user_preferences WHERE employee_number = ? AND preference_key = ?').get(owner, model.PREFERENCE_KEY).count, 0);
  const saved = await requestMutationJson(route, { method: 'PUT', body, employeeNumber: owner });
  assert.equal(saved.response.status, 200, saved.text);
  assert.deepEqual(saved.payload, { ...body, configured: true });
  assert.match(saved.response.headers.get('cache-control'), /private.*no-store/);
  const reloaded = await requestJson(route, owner);
  assert.deepEqual(reloaded.payload, saved.payload);
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM portal_user_preferences WHERE employee_number = ? AND preference_key = ?').get(owner, model.PREFERENCE_KEY).value), body);
  const upgraded = { ...body, version: 2, x: 0, y: 0 };
  const migrated = await requestMutationJson(route, { method: 'PUT', body: upgraded, employeeNumber: owner });
  assert.equal(migrated.response.status, 200, migrated.text);
  assert.deepEqual((await requestJson(route, owner)).payload, { ...upgraded, configured: true });
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM portal_user_preferences WHERE employee_number = ? AND preference_key = ?').get(owner, model.PREFERENCE_KEY).value), upgraded);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM portal_user_preferences WHERE employee_number = ? AND preference_key = ?').get(owner, model.PREFERENCE_KEY).count, 1);
  assert.deepEqual((await requestJson('/api/sales/articles/preferences', owner)).payload, tableBefore.payload);
  assert.equal(db.prepare('SELECT value FROM portal_user_preferences WHERE employee_number = ? AND preference_key = ?').get(owner, 'sales_article_table_v1').value, storedTableBefore);

  const articleMutation = await requestMutationJson('/api/sales/articles', { method: 'POST', body: { articleNumber: 'WINDOW-FORBIDDEN', description: 'Darf nicht angelegt werden', identifiers: [] }, employeeNumber: owner });
  assert.equal(articleMutation.response.status, 403, articleMutation.text);
  const importMutation = await requestMutationJson('/api/sales/articles/import/previews/nonexistent', { method: 'DELETE', employeeNumber: owner });
  assert.equal(importMutation.response.status, 403, importMutation.text);
  for (const otherPath of [route + '/other', route + '-other']) {
    const exactGuard = await requestMutationJson(otherPath, { method: 'PUT', body, employeeNumber: owner });
    assert.equal(exactGuard.response.status, 403, exactGuard.text);
  }
});

test('Suchfensterpräferenzen bleiben kontogebunden und weisen fremde Inhaber sowie ungültige Eingaben ab', async () => {
  const model = require('../lib/sales-article-search-window-preferences');
  const route = '/api/sales/articles/window-preferences';
  const first = await requestJson(route, WINDOW_READER_A);
  const secondInitial = await requestJson(route, WINDOW_READER_B);
  assert.deepEqual(secondInitial.payload, { ...model.DEFAULT_PREFERENCES, configured: false });
  const body = { version: 2, x: 10, y: 20, width: 480, height: 390, minimized: false };
  const secondSaved = await requestMutationJson(route, { method: 'PUT', body, employeeNumber: WINDOW_READER_B });
  assert.equal(secondSaved.response.status, 200, secondSaved.text);
  assert.deepEqual((await requestJson(route, WINDOW_READER_A)).payload, first.payload);
  assert.deepEqual((await requestJson(route, WINDOW_READER_B)).payload, { ...body, configured: true });
  for (const invalid of [{ ...body, employeeNumber: WINDOW_READER_A }, { ...body, owner: WINDOW_READER_A },
    { ...body, configured: true }, { ...body, width: '480' }, { ...body, minimized: 0 }, { ...body, x: -1 },
    { ...body, y: 16385 }, { ...body, width: 279 }, { ...body, height: 4097 }, { ...body, x: 1.5 },
    { ...body, version: 3 }, {}, [], null]) {
    const rejected = await requestMutationJson(route, { method: 'PUT', body: invalid, employeeNumber: WINDOW_READER_B });
    assert.equal(rejected.response.status, 400, rejected.text);
    // Express rejects a JSON null body before the route's schema validator.
    if (invalid !== null) assert.equal(rejected.payload.code, 'SALES_ARTICLE_WINDOW_PREFERENCES_INVALID', rejected.text);
  }
  assert.deepEqual((await requestJson(route, WINDOW_READER_B)).payload, secondSaved.payload);
  assert.deepEqual((await requestJson(route, WINDOW_READER_A)).payload, first.payload);
});

test('Suchfensterpräferenzen prüfen aktuelle Artikelrechte und fallen bei kaputten gespeicherten Werten zurück', async () => {
  const model = require('../lib/sales-article-search-window-preferences');
  const route = '/api/sales/articles/window-preferences';
  for (const employeeNumber of [WINDOW_ACCESS_ONLY, WINDOW_READ_WITHOUT_ACCESS]) {
    const get = await requestJson(route, employeeNumber);
    assert.equal(get.response.status, 403, get.text);
    const put = await requestMutationJson(route, { method: 'PUT', body: model.DEFAULT_PREFERENCES, employeeNumber });
    assert.equal(put.response.status, 403, put.text);
  }
  const unauthenticated = await fetch(baseUrl + route);
  assert.equal(unauthenticated.status, 401);
  const sessionCookie = createSession(WINDOW_READER_B);
  db.prepare('INSERT INTO portal_permission_denials (employee_number, permission, denied_by) VALUES (?, ?, ?)')
    .run(WINDOW_READER_B, SALES_ARTICLE_CATALOG_PERMISSIONS.READ, EMPLOYEE_NUMBER);
  try {
    const existingSession = await fetch(baseUrl + route, { headers: { Cookie: sessionCookie } });
    assert.equal(existingSession.status, 403);
    const denied = await requestMutationJson(route, { method: 'PUT', body: model.DEFAULT_PREFERENCES, employeeNumber: WINDOW_READER_B });
    assert.equal(denied.response.status, 403, denied.text);
  } finally {
    db.prepare('DELETE FROM portal_permission_denials WHERE employee_number = ? AND permission = ?')
      .run(WINDOW_READER_B, SALES_ARTICLE_CATALOG_PERMISSIONS.READ);
  }
  for (const invalidStored of ['{broken-json', JSON.stringify({ ...model.DEFAULT_PREFERENCES, width: 279 }), JSON.stringify({ ...model.DEFAULT_PREFERENCES, employeeNumber: WINDOW_READER_A })]) {
    db.prepare(`
      INSERT INTO portal_user_preferences (employee_number, preference_key, value)
      VALUES (?, ?, ?)
      ON CONFLICT(employee_number, preference_key) DO UPDATE SET value = excluded.value
    `).run(WINDOW_READER_B, model.PREFERENCE_KEY, invalidStored);
    const fallback = await requestJson(route, WINDOW_READER_B);
    assert.equal(fallback.response.status, 200, fallback.text);
    assert.deepEqual(fallback.payload, { ...model.DEFAULT_PREFERENCES, configured: false });
  }
});

test('Filialansicht speichert pro persönlichem Lesekonto und hält andere Präferenzen und Konten getrennt', async () => {
  const model=require('../public/sales-article-detail-preferences'),route='/api/sales/articles/detail-preferences';
  const owner=WINDOW_READER_A, other=WINDOW_READER_B;
  const before=db.prepare('SELECT preference_key, value FROM portal_user_preferences WHERE employee_number = ? ORDER BY preference_key').all(owner);
  assert.deepEqual((await requestJson(route,owner)).payload,{...model.defaults(),configured:false});
  const value={...model.defaults(),hiddenBranchIds:['18','00'],columns:['branch','ordered'],columnWidths:{branch:145,quantity:90,ordered:120},sort:'ordered',direction:'desc'};
  for(const csrfOptions of [{includeCsrf:false},{csrfHeader:'wrong'}]) {
    const denied=await requestMutationJson(route,{method:'PUT',body:value,employeeNumber:owner,...csrfOptions});assert.equal(denied.response.status,403,denied.text);
  }
  const saved=await requestMutationJson(route,{method:'PUT',body:value,employeeNumber:owner});
  assert.equal(saved.response.status,200,saved.text);assert.deepEqual(saved.payload,{...value,configured:true});
  assert.match(saved.response.headers.get('cache-control'),/private.*no-store/);
  const reload=await requestJson(route,owner);assert.equal(reload.response.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(reload.payload,saved.payload);
  assert.deepEqual((await requestJson(route,other)).payload,{...model.defaults(),configured:false});
  const stored=db.prepare('SELECT preference_key, value FROM portal_user_preferences WHERE employee_number = ? ORDER BY preference_key').all(owner);
  assert.deepEqual(stored.filter(row=>row.preference_key!==model.PREFERENCE_KEY),before);
  assert.deepEqual(JSON.parse(stored.find(row=>row.preference_key===model.PREFERENCE_KEY).value),value);
  for(const body of [{...value,employeeNumber:other},{...value,columns:[]},{...value,columns:['secret']},
    {...value,columnWidths:{branch:801}},{...value,hiddenBranchIds:['18','18']},{...value,version:2}]) {
    const invalid=await requestMutationJson(route,{method:'PUT',body,employeeNumber:owner});assert.equal(invalid.response.status,400,invalid.text);
    assert.equal(invalid.payload.code,'SALES_ARTICLE_DETAIL_PREFERENCES_INVALID');
  }
  assert.deepEqual((await requestJson(route,owner)).payload,saved.payload);
  for(const suffix of ['/other','-other']) assert.equal((await requestMutationJson(route+suffix,{method:'PUT',body:value,employeeNumber:owner})).response.status,403);
});

test('Filialpräferenzen sperren fehlende, widerrufene und eingeschränkte Sitzungen und behandeln beschädigte Werte',async()=>{
  const model=require('../public/sales-article-detail-preferences'),route='/api/sales/articles/detail-preferences';
  assert.equal((await fetch(baseUrl+route)).status,401);
  const accountId=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO portal_organization_accounts (id, login_name, display_name, account_type, password_hash, active,
    must_change_password, created_by, updated_by) VALUES (?, ?, 'Synthetic branch preferences', 'branch', 'test-only', 1, 0, 'test', 'test')`)
    .run(accountId,'stock-pref-'+accountId.slice(0,8));
  db.prepare("INSERT INTO portal_organization_sessions (id, account_id, token_hash, expires_at) VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')")
    .run(crypto.randomUUID(),accountId,crypto.createHash('sha256').update(token).digest('hex'));
  const organizationHeaders={Cookie:`grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'};
  assert.equal((await fetch(baseUrl+route,{headers:organizationHeaders})).status,403);
  assert.equal((await fetch(baseUrl+route,{method:'PUT',headers:organizationHeaders,body:JSON.stringify(model.defaults())})).status,403);
  for(const employeeNumber of [WINDOW_ACCESS_ONLY,WINDOW_READ_WITHOUT_ACCESS]) {
    assert.equal((await requestJson(route,employeeNumber)).response.status,403);
    assert.equal((await requestMutationJson(route,{method:'PUT',body:model.defaults(),employeeNumber})).response.status,403);
  }
  const cookie=createSession(WINDOW_READER_B);
  db.prepare('UPDATE portal_users SET must_change_password = 1 WHERE employee_number = ?').run(WINDOW_READER_B);
  try {
    assert.equal((await fetch(baseUrl+route,{headers:{Cookie:cookie}})).status,428);
    assert.equal((await requestMutationJson(route,{method:'PUT',body:model.defaults(),employeeNumber:WINDOW_READER_B})).response.status,428);
  } finally {db.prepare('UPDATE portal_users SET must_change_password = 0 WHERE employee_number = ?').run(WINDOW_READER_B);}
  db.prepare('INSERT INTO portal_permission_denials (employee_number, permission, denied_by) VALUES (?, ?, ?)').run(WINDOW_READER_B,SALES_ARTICLE_CATALOG_PERMISSIONS.READ,EMPLOYEE_NUMBER);
  try {assert.equal((await fetch(baseUrl+route,{headers:{Cookie:cookie}})).status,403);}
  finally {db.prepare('DELETE FROM portal_permission_denials WHERE employee_number = ? AND permission = ?').run(WINDOW_READER_B,SALES_ARTICLE_CATALOG_PERMISSIONS.READ);}
  for(const stored of ['bad-json',JSON.stringify({...model.defaults(),columns:[]})]) {
    db.prepare('INSERT INTO portal_user_preferences (employee_number, preference_key, value) VALUES (?, ?, ?) ON CONFLICT(employee_number, preference_key) DO UPDATE SET value = excluded.value')
      .run(WINDOW_READER_B,model.PREFERENCE_KEY,stored);
    assert.deepEqual((await requestJson(route,WINDOW_READER_B)).payload,{...model.defaults(),configured:false});
  }
});

test("Mitarbeitende mit Artikel-Leserecht erhalten die Kartei einschließlich Notizen ohne Preis- oder Schreibrechte", async () => {
  db.prepare("UPDATE portal_users SET role = 'employee' WHERE employee_number = ?").run(EMPLOYEE_NUMBER);
  try {
    const result = await requestJson(`/api/sales/articles/detail?articleNumber=${ARTICLE_NUMBER}`);
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.deepEqual(result.payload.article.notes, { items: [], available: false, sourceAt: null });
    assert.deepEqual(result.payload.article.prices, { sales: null, costs: null });
    assert.deepEqual(result.payload.capabilities, { pricesRead: false, costsRead: false, write: false, import: false });
    const denied = await requestMutationJson('/api/sales/articles', { method: 'POST', body: {} });
    assert.equal(denied.response.status, 403);
  } finally {
    db.prepare("UPDATE portal_users SET role = 'manager' WHERE employee_number = ?").run(EMPLOYEE_NUMBER);
  }
});

test("Detailroute hält Stammdaten, Verkaufs- und Kostenpreise serverseitig getrennt", async () => {
  const base = await requestJson(`/api/sales/articles/detail?articleNumber=${ARTICLE_NUMBER}`);
  assert.equal(base.response.status, 200, JSON.stringify(base.payload));
  assert.match(base.response.headers.get("cache-control") || "", /private/);
  assert.deepEqual(Object.keys(base.payload).sort(), ["article", "capabilities", "revisions"]);
  assert.deepEqual(Object.keys(base.payload.article).sort(), [
    "active", "articleNumber", "branchStock", "currentRevision", "description", "identifiers", "image", "notes", "priceMatrix", "prices", "provenance", "sourceSections",
  ]);
  assert.equal(base.payload.article.articleNumber, ARTICLE_NUMBER);
  assert.deepEqual(base.payload.article.identifiers, [{
    identifierType: "ean13",
    identifierValue: "4006381333931",
    isPrimary: true,
    verifiedAt: TIMESTAMP,
  }]);
  assert.deepEqual(base.payload.article.prices, { sales: null, costs: null });
  assert.equal(base.payload.article.priceMatrix.sales, null);
  assert.equal(base.payload.article.priceMatrix.purchase, null);
  assert.deepEqual(base.payload.capabilities, {
    pricesRead: false,
    costsRead: false,
    write: false,
    import: false,
  });
  assert.deepEqual(base.payload.article.provenance, {
    originSourceSystem: "manual.loan",
    currentSourceSystem: "tradefoto.artikel_stamm",
    sourceUpdatedAt: TIMESTAMP,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });
  assert.equal(base.payload.revisions.length, 1);
  assert.deepEqual(Object.keys(base.payload.revisions[0]).sort(), [
    "active", "articleNumber", "createdAt", "description", "revision", "sourceUpdatedAt",
  ]);
  const serializedBase = JSON.stringify(base.payload);
  for (const privateValue of [
    PRODUCT_ID,
    SNAPSHOT_ID,
    "sensitive-",
    "private-source-key",
    "private-provider",
    "private-ean-field",
    "private-sales-field",
    "199.990000000000",
    "100.000000000000",
  ]) {
    assert.equal(serializedBase.includes(privateValue), false, privateValue);
  }

  grant(SALES_ARTICLE_CATALOG_PERMISSIONS.PRICES_READ);
  const withPrices = await requestJson(`/api/sales/articles/detail?articleNumber=${ARTICLE_NUMBER}`);
  assert.equal(withPrices.response.status, 200, JSON.stringify(withPrices.payload));
  assert.deepEqual(withPrices.payload.capabilities, {
    pricesRead: true,
    costsRead: false,
    write: false,
    import: false,
  });
  assert.equal(withPrices.payload.article.prices.sales.length, 2);
  assert.equal(withPrices.payload.article.prices.costs, null);
  assert.deepEqual(
    Object.fromEntries(withPrices.payload.article.prices.sales.map((price) => [price.priceType, price])),
    {
      internet_1: {
        priceType: "internet_1",
        displayLabel: null,
        amount: "189.000000000000",
        currency: "EUR",
        priceBasis: "gross",
        qualityStatus: "inferred",
        usable: true,
      },
      sales: {
        priceType: "sales",
        displayLabel: null,
        amount: "199.990000000000",
        currency: "EUR",
        priceBasis: "gross",
        qualityStatus: "confirmed",
        usable: true,
      },
    },
  );
  assert.equal(JSON.stringify(withPrices.payload).includes("100.000000000000"), false);

  grant(SALES_ARTICLE_CATALOG_PERMISSIONS.COSTS_READ);
  const withCosts = await requestJson(`/api/sales/articles/detail?articleNumber=${ARTICLE_NUMBER}`);
  assert.equal(withCosts.response.status, 200, JSON.stringify(withCosts.payload));
  assert.deepEqual(withCosts.payload.capabilities, {
    pricesRead: true,
    costsRead: true,
    write: false,
    import: false,
  });
  const costs = Object.fromEntries(
    withCosts.payload.article.prices.costs.map((price) => [price.priceType, price]),
  );
  assert.equal(costs.average_purchase.amount, "100.000000000000");
  assert.equal(costs.average_purchase.usable, true);
  assert.equal(costs.special.amount, null);
  assert.equal(costs.special.qualityStatus, "unresolved");
  assert.equal(costs.special.usable, false);
  assert.equal(costs.other.amount, null);
  assert.equal(costs.other.qualityStatus, "quarantined");
  assert.equal(costs.other.usable, false);
  assert.deepEqual(
    withCosts.payload.article.prices.costs
      .filter((price) => price.priceType === "future_purchase")
      .map((price) => price.displayLabel),
    [
      "Künftiger Listen-EK",
      "Künftiger Netto-Netto-EK",
      "Künftiger Rechnungs-EK",
      "Künftiger Sonder-EK",
    ],
  );
  assert.equal(JSON.stringify(withCosts.payload).includes("ListeneckpreisZu"), false);
  assert.equal(JSON.stringify(withCosts.payload).includes("RechnungspreisZu"), false);
  assert.equal(JSON.stringify(withCosts.payload).includes("88.000000000000"), false);
  assert.equal(JSON.stringify(withCosts.payload).includes("-1.000000000000"), false);
});

test("Detailroute validiert exakt und antwortet für unbekannte Artikel mit 404", async () => {
  const missingNumber = await requestJson("/api/sales/articles/detail");
  assert.equal(missingNumber.response.status, 400, JSON.stringify(missingNumber.payload));

  const extra = await requestJson(`/api/sales/articles/detail?articleNumber=${ARTICLE_NUMBER}&extra=1`);
  assert.equal(extra.response.status, 400, JSON.stringify(extra.payload));
  assert.equal(extra.payload?.code, "SALES_ARTICLE_DETAIL_INVALID");

  const missing = await requestJson("/api/sales/articles/detail?articleNumber=NICHT-VORHANDEN");
  assert.equal(missing.response.status, 404, JSON.stringify(missing.payload));
  assert.equal(missing.payload?.code, "SALES_ARTICLE_NOT_FOUND");
});

test("Artikelmutationen sind CSRF-, Rechte-, Revisions-, Audit- und Undo-gesichert", async () => {
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM portal_permission_denials
      WHERE employee_number = ? AND permission = 'schedule:write'
    `).get(EMPLOYEE_NUMBER).count,
    1,
  );
  const createBody = {
    articleNumber: "A/200",
    description: "Manuell gepflegter API-Artikel",
    identifiers: [],
    prices: {
      sales: [{ priceType: "sales", amount: "49.90", currency: "EUR", priceBasis: "gross" }],
    },
  };
  const denied = await requestMutationJson("/api/sales/articles", {
    method: "POST",
    body: createBody,
  });
  assert.equal(denied.response.status, 403, denied.text);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sales_articles WHERE article_number = 'A/200'").get().count, 0);

  grant(SALES_ARTICLE_CATALOG_PERMISSIONS.IMPORT);
  const importOnlyDenied = await requestMutationJson("/api/sales/articles", {
    method: "POST",
    body: createBody,
  });
  assert.equal(importOnlyDenied.response.status, 403, importOnlyDenied.text);
  db.prepare(`
    DELETE FROM portal_permission_grants
    WHERE employee_number = ? AND permission = ?
  `).run(EMPLOYEE_NUMBER, SALES_ARTICLE_CATALOG_PERMISSIONS.IMPORT);

  grant(SALES_ARTICLE_CATALOG_PERMISSIONS.WRITE);
  const csrfDenied = await requestMutationJson("/api/sales/articles", {
    method: "POST",
    body: createBody,
    includeCsrf: false,
  });
  assert.equal(csrfDenied.response.status, 403, csrfDenied.text);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sales_articles WHERE article_number = 'A/200'").get().count, 0);

  const rollbackCounts = Object.fromEntries([
    "sales_article_import_snapshots",
    "sales_articles",
    "sales_article_revisions",
    "sales_article_price_snapshots",
    "audit_log",
    "personal_action_receipts",
  ].map((table) => [
    table,
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
  ]));
  db.exec(`
    CREATE TRIGGER test_article_receipt_failure
    BEFORE INSERT ON personal_action_receipts
    WHEN NEW.action_type = 'sales.article-catalog.create'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic article receipt failure');
    END
  `);
  const receiptFailed = await requestMutationJson("/api/sales/articles", {
    method: "POST",
    body: {
      articleNumber: "A/ROLLBACK",
      description: "Muss vollständig zurückgerollt werden",
      identifiers: [],
    },
  });
  db.exec("DROP TRIGGER test_article_receipt_failure");
  assert.equal(receiptFailed.response.status, 400, receiptFailed.text);
  assert.equal(receiptFailed.payload.code, "SALES_ARTICLE_MUTATION_INVALID");
  for (const [table, before] of Object.entries(rollbackCounts)) {
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
      before,
      `${table} wurde nach Receipt-Fehler nicht atomar zurückgerollt`,
    );
  }

  const created = await requestMutationJson("/api/sales/articles", {
    method: "POST",
    body: createBody,
  });
  assert.equal(created.response.status, 201, created.text);
  assert.equal(created.payload.article.articleNumber, "A/200");
  assert.equal(created.payload.article.currentRevision, 1);
  assert.deepEqual(created.payload.capabilities, {
    pricesRead: true,
    costsRead: true,
    write: true,
    import: false,
  });
  const product = db.prepare(`
    SELECT product_id, current_revision FROM sales_articles WHERE article_number = 'A/200'
  `).get();
  assert.ok(product?.product_id);
  assert.equal(product.current_revision, 1);
  const createAudit = db.prepare(`
    SELECT id FROM audit_log
    WHERE actor = ? AND action = 'sales.article-catalog.create'
      AND entity_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(EMPLOYEE_NUMBER, product.product_id);
  const createReceipt = db.prepare(`
    SELECT source_audit_id, undo_payload FROM personal_action_receipts
    WHERE actor_id = ? AND action_type = 'sales.article-catalog.create'
      AND entity_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(EMPLOYEE_NUMBER, product.product_id);
  assert.equal(createReceipt.source_audit_id, createAudit.id);
  assert.deepEqual(JSON.parse(createReceipt.undo_payload), {
    productId: product.product_id,
    restoreRevision: null,
  });
  assert.equal(createReceipt.undo_payload.includes("49.90"), false);

  const updated = await requestMutationJson("/api/sales/articles", {
    method: "PUT",
    body: {
      currentArticleNumber: "A/200",
      expectedRevision: 1,
      articleNumber: "A/201",
      description: "Bearbeiteter API-Artikel",
      identifiers: [],
    },
  });
  assert.equal(updated.response.status, 200, updated.text);
  assert.equal(updated.payload.article.articleNumber, "A/201");
  assert.equal(updated.payload.article.currentRevision, 2);
  assert.equal(updated.payload.article.prices.sales[0].amount, "49.900000000000");

  const stale = await requestMutationJson("/api/sales/articles", {
    method: "PUT",
    body: {
      currentArticleNumber: "A/201",
      expectedRevision: 1,
      articleNumber: "A/201",
      description: "Veraltete Änderung",
      identifiers: [],
    },
  });
  assert.equal(stale.response.status, 409, stale.text);
  assert.equal(stale.payload.code, "SALES_ARTICLE_REVISION_CONFLICT");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sales_article_revisions WHERE product_id = ?").get(product.product_id).count, 2);

  const copied = await requestMutationJson("/api/sales/articles/copy", {
    method: "POST",
    body: {
      sourceArticleNumber: "A/201",
      expectedRevision: 2,
      articleNumber: "A/202",
    },
  });
  assert.equal(copied.response.status, 201, copied.text);
  assert.equal(copied.payload.article.description, "Bearbeiteter API-Artikel");
  assert.deepEqual(copied.payload.article.identifiers, []);
  assert.deepEqual(copied.payload.article.prices, { sales: [], costs: [] });

  const archived = await requestMutationJson("/api/sales/articles/archive", {
    method: "POST",
    body: { articleNumber: "A/202", expectedRevision: 1 },
  });
  assert.equal(archived.response.status, 200, archived.text);
  assert.equal(archived.payload.article.active, false);
  assert.equal(archived.payload.article.currentRevision, 2);
  const copiedProduct = db.prepare(`
    SELECT product_id FROM sales_articles WHERE article_number = 'A/202'
  `).get();

  const receiptCountBeforeArchivedEdit = db.prepare(`
    SELECT COUNT(*) AS count FROM personal_action_receipts WHERE actor_id = ?
  `).get(EMPLOYEE_NUMBER).count;
  const archivedEdit = await requestMutationJson("/api/sales/articles", {
    method: "PUT",
    body: {
      currentArticleNumber: "A/202",
      expectedRevision: 2,
      articleNumber: "A/202",
      description: "Darf nicht geändert werden",
      identifiers: [],
    },
  });
  assert.equal(archivedEdit.response.status, 409, archivedEdit.text);
  assert.equal(archivedEdit.payload.code, "SALES_ARTICLE_ALREADY_ARCHIVED");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_article_revisions WHERE product_id = ?")
      .get(copiedProduct.product_id).count,
    2,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM personal_action_receipts WHERE actor_id = ?")
      .get(EMPLOYEE_NUMBER).count,
    receiptCountBeforeArchivedEdit,
  );

  const actions = await requestMutationJson("/api/portal/v1/me/actions?limit=50");
  assert.equal(actions.response.status, 200, actions.text);
  const archiveAction = actions.payload.actions.find((entry) => (
    entry.actionType === "sales.article-catalog.archive"
      && entry.summary === "Artikel A/202"
  ));
  assert.ok(archiveAction, actions.text);
  assert.equal(archiveAction.title, "Artikel archiviert");
  assert.equal(archiveAction.canUndo, true);

  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, ?, ?)
  `).run(EMPLOYEE_NUMBER, SALES_ARTICLE_CATALOG_PERMISSIONS.WRITE, EMPLOYEE_NUMBER);
  const liveRightsList = await requestMutationJson("/api/portal/v1/me/actions?limit=50");
  const disabledArchiveAction = liveRightsList.payload.actions.find((entry) => (
    entry.id === archiveAction.id
  ));
  assert.equal(disabledArchiveAction.canUndo, false);
  assert.match(disabledArchiveAction.undo.reason, /Artikelstammrecht/);
  const permissionDeniedUndo = await requestMutationJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(archiveAction.id)}/undo`,
    { method: "POST", body: {} },
  );
  assert.equal(permissionDeniedUndo.response.status, 403, permissionDeniedUndo.text);
  assert.equal(permissionDeniedUndo.payload.code, "PERSONAL_ACTION_UNDO_PERMISSION_DENIED");
  db.prepare(`
    DELETE FROM portal_permission_denials
    WHERE employee_number = ? AND permission = ?
  `).run(EMPLOYEE_NUMBER, SALES_ARTICLE_CATALOG_PERMISSIONS.WRITE);

  const undone = await requestMutationJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(archiveAction.id)}/undo`,
    { method: "POST", body: {} },
  );
  assert.equal(undone.response.status, 200, undone.text);
  assert.equal(undone.payload.undone, true);
  assert.equal(undone.payload.alreadyUndone, false);
  assert.equal(undone.payload.salesArticle.article.active, true);
  assert.equal(undone.payload.salesArticle.article.currentRevision, 3);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_article_revisions WHERE product_id = ?")
      .get(copiedProduct.product_id).count,
    3,
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE actor = ? AND action = 'sales.article-catalog.undo' AND entity_id = ?
    `).get(EMPLOYEE_NUMBER, copiedProduct.product_id).count,
    1,
  );

  const duplicateUndo = await requestMutationJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(archiveAction.id)}/undo`,
    { method: "POST", body: {} },
  );
  assert.equal(duplicateUndo.response.status, 200, duplicateUndo.text);
  assert.equal(duplicateUndo.payload.alreadyUndone, true);
  assert.equal(duplicateUndo.payload.salesArticle.article.currentRevision, 3);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM personal_action_receipts
      WHERE actor_id = ? AND compensates_action_id IS NOT NULL
    `).get(EMPLOYEE_NUMBER).count,
    1,
  );

  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, ?, ?)
  `).run(EMPLOYEE_NUMBER, SALES_ARTICLE_CATALOG_PERMISSIONS.COSTS_READ, EMPLOYEE_NUMBER);
  const hiddenCostsUpdate = await requestMutationJson("/api/sales/articles", {
    method: "PUT",
    body: {
      currentArticleNumber: ARTICLE_NUMBER,
      expectedRevision: 1,
      articleNumber: ARTICLE_NUMBER,
      description: "Synthetischer Detailartikel ohne Kostenfreigabe bearbeitet",
      identifiers: [{ identifierValue: "4006381333931", isPrimary: true }],
    },
  });
  assert.equal(hiddenCostsUpdate.response.status, 200, hiddenCostsUpdate.text);
  assert.equal(hiddenCostsUpdate.payload.article.currentRevision, 2);
  assert.equal(hiddenCostsUpdate.payload.article.prices.costs, null);
  assert.equal(hiddenCostsUpdate.text.includes("100.000000000000"), false);
  const hiddenCostsSnapshotId = db.prepare(`
    SELECT source_snapshot_id FROM sales_article_revisions
    WHERE product_id = ? AND revision = 2
  `).get(PRODUCT_ID).source_snapshot_id;
  assert.equal(
    db.prepare(`
      SELECT amount FROM sales_article_price_snapshots
      WHERE product_id = ? AND source_snapshot_id = ? AND price_type = 'average_purchase'
    `).get(PRODUCT_ID, hiddenCostsSnapshotId).amount,
    "100.000000000000",
  );

  const forbiddenCostPatch = await requestMutationJson("/api/sales/articles", {
    method: "PUT",
    body: {
      currentArticleNumber: ARTICLE_NUMBER,
      expectedRevision: 2,
      articleNumber: ARTICLE_NUMBER,
      description: "Unzulässiger Kostenpatch",
      identifiers: [{ identifierValue: "4006381333931", isPrimary: true }],
      prices: {
        costs: [{ priceType: "average_purchase", amount: "1", currency: "EUR", priceBasis: "net" }],
      },
    },
  });
  assert.equal(forbiddenCostPatch.response.status, 403, forbiddenCostPatch.text);
  assert.equal(forbiddenCostPatch.payload.code, "SALES_ARTICLE_PRICE_GROUP_PERMISSION_DENIED");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_article_revisions WHERE product_id = ?")
      .get(PRODUCT_ID).count,
    2,
  );

  const hiddenCostActions = await requestMutationJson("/api/portal/v1/me/actions?limit=50");
  const hiddenCostUpdateAction = hiddenCostActions.payload.actions.find((entry) => (
    entry.actionType === "sales.article-catalog.update"
      && entry.summary === `Artikel ${ARTICLE_NUMBER}`
      && entry.canUndo === true
  ));
  assert.ok(hiddenCostUpdateAction, hiddenCostActions.text);
  const hiddenCostsUndo = await requestMutationJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(hiddenCostUpdateAction.id)}/undo`,
    { method: "POST", body: {} },
  );
  assert.equal(hiddenCostsUndo.response.status, 200, hiddenCostsUndo.text);
  assert.equal(hiddenCostsUndo.payload.salesArticle.article.currentRevision, 3);
  assert.equal(hiddenCostsUndo.payload.salesArticle.article.prices.costs, null);
  assert.equal(hiddenCostsUndo.text.includes("100.000000000000"), false);
  db.prepare(`
    DELETE FROM portal_permission_denials
    WHERE employee_number = ? AND permission = ?
  `).run(EMPLOYEE_NUMBER, SALES_ARTICLE_CATALOG_PERMISSIONS.COSTS_READ);
});

test('Eigene Bilder folgen echten Portalrechten und bleiben nach Artikelbearbeitung sowie Undo sichtbar', async () => {
  // Explicit grants keep this case independent of earlier permission changes.
  for (const permission of [SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS, SALES_ARTICLE_CATALOG_PERMISSIONS.READ, SALES_ARTICLE_CATALOG_PERMISSIONS.WRITE]) {
    db.prepare('INSERT OR IGNORE INTO portal_permission_grants (employee_number, permission, granted_by) VALUES (?, ?, ?)')
      .run(EMPLOYEE_NUMBER, permission, EMPLOYEE_NUMBER);
  }
  const articleNumber = 'IMAGE-007';
  const created = await requestMutationJson('/api/sales/articles', { method: 'POST', body: { articleNumber, description: 'Bildprüfung', identifiers: [] } });
  assert.equal(created.response.status, 201, created.text);
  assert.equal(created.payload.article.image.present, false);
  const input = await require('sharp')({ create: { width: 32, height: 16, channels: 3, background: '#287c64' } }).png().toBuffer();
  const upload = async (csrf = true) => {
    const token = crypto.randomBytes(24).toString('hex');
    return fetch(`${baseUrl}/api/sales/articles/image?articleNumber=${articleNumber}`, { method: 'PUT', body: input, headers: {
      'Content-Type': 'image/png', Cookie: `${createSession()}; grabenplaner_csrf=${token}`,
      'X-Article-Image-Revision': 'none', ...(csrf ? { 'X-CSRF-Token': token } : {}),
    } });
  };
  const deny = permission => db.prepare('INSERT INTO portal_permission_denials (employee_number, permission, denied_by) VALUES (?, ?, ?)').run(EMPLOYEE_NUMBER, permission, EMPLOYEE_NUMBER);
  const allow = permission => db.prepare('DELETE FROM portal_permission_denials WHERE employee_number=? AND permission=?').run(EMPLOYEE_NUMBER, permission);
  assert.equal((await upload(false)).status, 403);
  deny(SALES_ARTICLE_CATALOG_PERMISSIONS.WRITE);
  assert.equal((await upload()).status, 403);
  allow(SALES_ARTICLE_CATALOG_PERMISSIONS.WRITE);
  const saved = await upload(); const image = (await saved.json()).image;
  assert.equal(saved.status, 200); assert.equal(image.present, true);
  const route = `/api/sales/articles/image?articleNumber=${articleNumber}`;
  const download = await fetch(baseUrl + route, { headers: { Cookie: createSession() } });
  assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'image/webp');
  assert.match(download.headers.get('cache-control'), /private.*no-store/);
  assert.equal((await download.arrayBuffer()).byteLength, image.byteSize);
  assert.equal((await fetch(baseUrl + route)).status, 401);
  const detail = await requestJson(`/api/sales/articles/detail?articleNumber=${articleNumber}`);
  assert.deepEqual(detail.payload.article.image, image);
  assert.equal(JSON.stringify(detail.payload).includes('content'), false);
  const edited = await requestMutationJson('/api/sales/articles', { method: 'PUT', body: {
    currentArticleNumber: articleNumber, articleNumber, expectedRevision: 1, description: 'Bildprüfung geändert', identifiers: [],
  } });
  assert.equal(edited.response.status, 200, edited.text); assert.deepEqual(edited.payload.article.image, image);
  const archived = await requestMutationJson('/api/sales/articles/archive', { method: 'POST', body: { articleNumber, expectedRevision: 2 } });
  assert.equal(archived.response.status, 200, archived.text); assert.deepEqual(archived.payload.article.image, image);
  const actions = await requestMutationJson('/api/portal/v1/me/actions?limit=50');
  const action = actions.payload.actions.find(a => a.actionType === 'sales.article-catalog.archive' && a.summary === `Artikel ${articleNumber}`);
  assert.ok(action);
  const undone = await requestMutationJson(`/api/portal/v1/me/actions/${action.id}/undo`, { method: 'POST', body: {} });
  assert.equal(undone.response.status, 200, undone.text); assert.deepEqual(undone.payload.salesArticle.article.image, image);
  const copied = await requestMutationJson('/api/sales/articles/copy', { method: 'POST', body: { sourceArticleNumber: articleNumber, expectedRevision: 4, articleNumber: 'IMAGE-008' } });
  assert.equal(copied.response.status, 201, copied.text); assert.equal(copied.payload.article.image.present, false);
  const invalid = await requestMutationJson('/api/sales/articles/image/from-url', { method: 'POST', body: { articleNumber, expectedRevision: image.revision, url: 'https://127.0.0.1/secret.png' } });
  assert.equal(invalid.response.status, 400, invalid.text);
  assert.equal((await requestJson(`/api/sales/articles/detail?articleNumber=${articleNumber}`)).payload.article.image.revision, image.revision);
  deny(SALES_ARTICLE_CATALOG_PERMISSIONS.READ);
  assert.equal((await requestJson(route)).response.status, 403);
  allow(SALES_ARTICLE_CATALOG_PERMISSIONS.READ);
  // Restore the initial read-only grant baseline.
  db.prepare('DELETE FROM portal_permission_grants WHERE employee_number=? AND permission=?').run(EMPLOYEE_NUMBER, SALES_ARTICLE_CATALOG_PERMISSIONS.WRITE);
});
