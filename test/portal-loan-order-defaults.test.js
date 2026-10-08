"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-portal-loan-order-defaults-"));
Object.assign(process.env, {
  DB_PATH: path.join(root, "test.db"), BACKUP_DIR: path.join(root, "backups"),
  GRABENPLANER_DATA_DIR: path.join(root, "data"), GRABENPLANER_HOST: "127.0.0.1",
  GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1", NODE_ENV: "test", TZ: "Europe/Vienna",
  GRABENPLANER_TEST_AMU_SCANNER: "clean", GRABENPLANER_AMU_KEY_ID: "loan-order-defaults-test-v1",
  GRABENPLANER_AMU_KEY: Buffer.alloc(32, 37).toString("base64"), GRABENPLANER_EMAIL_DISPATCH_ENABLED: "0",
});
const subject = require("../server");
const { app, db } = subject;
const { LOAN_RETURN_POLICY_PERMISSION: POLICY } = require("../lib/loan-return-policy");
const MA = "policy-ma", WITNESS = "policy-witness", FL = "policy-fl", AL = "policy-al", ADMIN = "policy-admin", FOREIGN = "policy-foreign";
let server, base, locationId;
function auth(number) {
  const token = crypto.randomBytes(32).toString("hex"), csrf = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO portal_sessions (id,employee_number,token_hash,expires_at) VALUES (?,?,?,'2099-01-01T00:00:00.000Z')")
    .run(crypto.randomUUID(), number, crypto.createHash("sha256").update(token).digest("hex"));
  return { csrf, cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}` };
}
async function request(route, number, method = "GET", body) {
  const session = auth(number);
  const response = await fetch(base + route, { method, headers: { Cookie: session.cookie, Accept: "application/json",
    ...(method !== "GET" ? { "Content-Type": "application/json", "X-CSRF-Token": session.csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function issue(number = MA) {
  const result = await request("/api/portal/v1/loans", number, "POST", { locationId, items: [{ articleNumber: "991876", conditionOut: "good" }] });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.loan;
}
function returnBody(extra = {}) {
  return { expectedRevision: 1, items: [{ position: 1, conditionReturn: "good", note: "BEISPIEL Rückgabe" }], ...extra };
}
async function policy(value, number = FL) {
  const result = await request(`/api/portal/v1/loans/settings/locations/${locationId}/return-policy`, number, "PUT", { returnPolicy: { requiresWitness: value } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.location.returnPolicy.requiresWitness, value);
  return result;
}
test.before(async () => {
  locationId = db.prepare("SELECT id FROM locations WHERE active=1 ORDER BY id LIMIT 1").get().id;
  db.prepare("INSERT INTO locations (id,name,min_staff,day_settings_json,active) VALUES ('98','BEISPIEL Fremdfiliale',1,'{}',1)").run();
  for (const [number, role] of [[MA, "employee"], [WITNESS, "employee"], [FL, "manager"], [AL, "department_manager"], [ADMIN, "admin"], [FOREIGN, "employee"]]) {
    db.prepare("INSERT INTO employees (personnel_number,full_name,nickname,home_location_id,active) VALUES (?,?,?,?,1)")
      .run(number, `BEISPIEL ${number}`, number, number === FOREIGN ? "98" : locationId);
    db.prepare("INSERT INTO portal_users (employee_number,password_hash,role,active,must_change_password,password_changed_at) VALUES (?,'test-only',?,1,0,CURRENT_TIMESTAMP)").run(number, role);
  }
  for (const number of [FL, AL]) db.prepare("INSERT INTO portal_access_scopes (employee_number,location_id,department_id,assigned_by) VALUES (?,?,0,?)").run(number, locationId, ADMIN);
  for (const id of [locationId, "98"]) db.prepare("INSERT INTO loan_location_settings (location_id,enabled) VALUES (?,1)").run(id);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close(); subject.releaseInstanceLockForTests();
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("gp-portal-loan-order-defaults-"));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Normaler MA hat persönliche Leihe und Filialbestellung; Bestellidentität bleibt sein eigener Account", async () => {
  const status = await request("/api/portal/v1/loans/status", MA);
  assert.equal(status.status, 200);
  for (const right of ["ownRead", "ownCreate", "ownReturn", "overviewRead"]) assert.equal(status.body.permissions[right], true, right);
  assert.equal(status.body.location.returnPolicy.requiresWitness, false);
  const catalog = await request(`/api/portal/v1/branch-orders/catalog?employeeNumber=${FOREIGN}&locationId=98`, MA);
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  assert.equal(catalog.body.submissionMode, "self");
  assert.deepEqual(catalog.body.employees.map((entry) => entry.employeeNumber), [MA]);
  assert.equal(catalog.body.location.id, locationId);
});

test("Leihe verwendet den zentralen Artikelstamm und speichert eine manuelle Bezeichnung nur für fehlende Artikel", async () => {
  const missing = await request("/api/portal/v1/loans/articles/resolve", MA, "POST", { locationId, identifier: "991876" });
  assert.equal(missing.status, 409, JSON.stringify(missing.body));
  assert.equal(missing.body.code, "ARTICLE_DESCRIPTION_REQUIRED");
  const manual = await request("/api/portal/v1/loans/articles/resolve", MA, "POST", { locationId, identifier: "991876", manualDescription: "BEISPIEL Fernglas" });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.equal(manual.body.article.description, "BEISPIEL Fernglas");
  assert.ok(db.prepare("SELECT product_id FROM sales_articles WHERE article_number='991876'").get());
  const existing = await request("/api/portal/v1/loans/articles/resolve", MA, "POST", { locationId, identifier: "991876", manualDescription: "Unzulässiges Überschreiben" });
  assert.equal(existing.status, 200);
  assert.equal(existing.body.article.description, "BEISPIEL Fernglas");
  assert.equal(existing.body.preservedManualDescription, true);
  const search = await request("/api/portal/v1/loans/articles?query=Fernglas", MA);
  assert.equal(search.status, 200);
  assert.equal(search.body.articles.some((entry) => entry.articleNumber === "991876"), true);
  const foreign = await request("/api/portal/v1/loans/articles?locationId=98&query=Fernglas", MA);
  assert.equal(foreign.status, 403);
});

test("Ein vorhandener GP-Artikel braucht keine funktionierende externe Shopware-Konfiguration", async () => {
  db.prepare("UPDATE loan_location_settings SET article_lookup_enabled=1,article_lookup_provider='shopware_storefront',article_lookup_base_url='' WHERE location_id=?").run(locationId);
  try {
    const result = await request("/api/portal/v1/loans/articles/resolve", MA, "POST", { locationId, articleNumber: "991876" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.cacheHit, true);
    assert.equal(result.body.lookupWarning, null);
    assert.equal(result.body.article.description, "BEISPIEL Fernglas");
  } finally {
    db.prepare("UPDATE loan_location_settings SET article_lookup_enabled=0,article_lookup_provider='none' WHERE location_id=?").run(locationId);
  }
});

test("Eigene Rücknahme schließt standardmäßig direkt, revisionssicher und ohne erfundene Gegenprüfung ab", async () => {
  const loan = await issue();
  const foreign = await request(`/api/portal/v1/loans/${loan.id}/return`, FOREIGN, "POST", returnBody());
  assert.equal(foreign.status, 403);
  const returned = await request(`/api/portal/v1/loans/${loan.id}/return`, MA, "POST", returnBody());
  assert.equal(returned.status, 200, JSON.stringify(returned.body));
  assert.equal(returned.body.direct, true);
  assert.equal(returned.body.loan.status, "returned");
  assert.equal(returned.body.loan.revision, 2);
  assert.equal(returned.body.loan.returnWitness, null);
  const event = db.prepare("SELECT payload_json FROM loan_events WHERE loan_id=? AND event_type='returned'").get(loan.id);
  assert.equal(JSON.parse(event.payload_json).completionMode, "single_employee");
  assert.deepEqual(returned.body.loan.documents.map((entry) => entry.type), ["issue", "return"]);
});

test("FL und AL mit Zusatzrecht regeln nur die eigene Filiale ohne globale Einstellungen freizuschalten", async () => {
  const settings = await request("/api/portal/v1/loans/return-policy-settings", FL);
  assert.equal(settings.status, 200, JSON.stringify(settings.body));
  assert.deepEqual(settings.body.locations.map((entry) => entry.locationId), [locationId]);
  for (const entry of settings.body.locations) for (const privateField of ["emailDelivery", "photoPdf", "articleLookup"]) assert.equal(Object.hasOwn(entry, privateField), false);
  assert.equal((await request("/api/portal/v1/loans/settings", FL)).status, 403);
  assert.equal((await request("/api/portal/v1/loans/return-policy-settings", AL)).status, 403);
  assert.equal((await request("/api/portal/v1/loans/return-policy-settings", MA)).status, 403);
  const foreign = await request("/api/portal/v1/loans/settings/locations/98/return-policy", FL, "PUT", { returnPolicy: { requiresWitness: true } });
  assert.equal(foreign.status, 403);
  db.prepare("INSERT INTO portal_permission_grants (employee_number,permission,granted_by) VALUES (?,?,?)").run(AL, POLICY, ADMIN);
  await policy(true, AL);
  assert.equal((await request("/api/portal/v1/loans/settings", AL)).status, 403);
  const before = db.prepare("SELECT * FROM loan_location_settings WHERE location_id=?").get(locationId);
  await policy(false);
  assert.deepEqual(db.prepare("SELECT * FROM loan_location_settings WHERE location_id=?").get(locationId), before);
  await policy(true);
});

test("Verpflichtende Zweitperson kann weder vom MA noch von der FL beim normalen Rücknahmeweg umgangen werden", async () => {
  const loan = await issue();
  for (const number of [MA, FL]) {
    const denied = await request(`/api/portal/v1/loans/${loan.id}/return`, number, "POST", returnBody());
    assert.equal(denied.status, 409, JSON.stringify(denied.body));
    assert.equal(denied.body.code, "LOAN_RETURN_WITNESS_REQUIRED");
    assert.equal(db.prepare("SELECT status FROM loans WHERE id=?").get(loan.id).status, "issued");
  }
  const requested = await request(`/api/portal/v1/loans/${loan.id}/return`, MA, "POST", returnBody({ witnessEmployeeNumber: WITNESS }));
  assert.equal(requested.status, 202, JSON.stringify(requested.body));
  const wrong = await request(`/api/portal/v1/loans/return-confirmations/${requested.body.confirmation.id}/respond`, MA, "POST", { decision: "confirm" });
  assert.equal(wrong.status, 403);
  const returned = await request(`/api/portal/v1/loans/return-confirmations/${requested.body.confirmation.id}/respond`, WITNESS, "POST", { decision: "confirm" });
  assert.equal(returned.status, 200, JSON.stringify(returned.body));
  assert.equal(returned.body.loan.status, "returned");
  assert.equal(returned.body.loan.returnWitness.employeeNumber, WITNESS);
});

test("Individuelle Entzüge sperren persönliche Leihe, Filialbestellung und lokale Regelverwaltung", async () => {
  for (const [number, right] of [[MA, "loans:self:use"], [MA, "branch_orders:submit"], [FL, POLICY]]) {
    db.prepare("INSERT INTO portal_permission_denials (employee_number,permission,denied_by) VALUES (?,?,?)").run(number, right, ADMIN);
  }
  assert.equal((await request("/api/portal/v1/loans/articles?query=Fernglas", MA)).status, 403);
  assert.equal((await request("/api/portal/v1/branch-orders/catalog", MA)).status, 403);
  assert.equal((await request("/api/portal/v1/loans/return-policy-settings", FL)).status, 403);
});

test("Ein individuell entzogener Regelzugriff kann nicht über die vollständigen Leiheinstellungen umgangen werden", async () => {
  db.prepare("INSERT INTO portal_permission_denials (employee_number,permission,denied_by) VALUES (?,?,?)").run(ADMIN, POLICY, ADMIN);
  const route = `/api/portal/v1/loans/settings/locations/${locationId}`;
  const scopedDenied = await request(`${route}/return-policy`, ADMIN, "PUT", { returnPolicy: { requiresWitness: false } });
  assert.equal(scopedDenied.status, 403, JSON.stringify(scopedDenied.body));
  const denied = await request(route, ADMIN, "PUT", { enabled: true, returnPolicy: { requiresWitness: false } });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  const stored = db.prepare("SELECT value FROM portal_settings WHERE key=?").get(`loan_return_requires_witness:${locationId}`);
  assert.equal(stored.value, "true");
  const ordinarySettings = await request(route, ADMIN, "PUT", { enabled: true });
  assert.equal(ordinarySettings.status, 200, JSON.stringify(ordinarySettings.body));
  assert.equal(ordinarySettings.body.location.returnPolicy.requiresWitness, true);
});

test("SQLite- und PostgreSQL-Start aktualisieren nur unveränderte Standardrollen und erhalten persönliche Entzüge", async (t) => {
  const definitions = db.prepare("SELECT id,name,description,permissions,sort_order FROM portal_roles").all()
    .map((row) => ({ ...row, permissions: JSON.parse(row.permissions), sortOrder: row.sort_order }));
  const denials = db.prepare("SELECT * FROM portal_permission_denials ORDER BY employee_number,permission").all();
  const grants = db.prepare("SELECT * FROM portal_permission_grants ORDER BY employee_number,permission").all();
  db.prepare("INSERT INTO portal_position_permission_defaults (position_id,permissions,revision,updated_by) VALUES ('lehrling','[\"own_schedule:read\"]',3,?)").run(ADMIN);
  const position = db.prepare("SELECT * FROM portal_position_permission_defaults WHERE position_id='lehrling'").get();
  const sqliteSeeding = require("../lib/persistence/sqlite/operations/application-seeding").createSqliteApplicationSeedingOperations(db);
  const postgresAdapter = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return { run: async (...args) => statement.run(...args), get: async (...args) => statement.get(...args),
        all: async (...args) => statement.all(...args) };
    },
    async transaction(callback) {
      db.exec("BEGIN");
      try { const result = await callback(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  const postgresSeeding = require("../lib/persistence/postgresql/application-operations/startup").createPostgresqlStartupOperations(postgresAdapter, {});
  for (const [label, seed] of [
    ["SQLite", () => sqliteSeeding.seedApplicationDefaults({ defaultSettings: {}, planningDays: [], builtinPortalRoles: definitions })],
    ["PostgreSQL startup statements", () => postgresSeeding.seedDefaults({ defaultSettings: {}, builtinPortalRoles: definitions })],
  ]) await t.test(label, async () => {
    const employeeDefault = definitions.find((entry) => entry.id === "employee");
    const managerDefault = definitions.find((entry) => entry.id === "manager");
    db.prepare("UPDATE portal_roles SET permissions=?,permissions_customized=0 WHERE id='employee'")
      .run(JSON.stringify(employeeDefault.permissions.filter((right) => right !== "branch_orders:submit")));
    db.prepare("UPDATE portal_roles SET permissions=?,permissions_customized=0 WHERE id='manager'")
      .run(JSON.stringify(managerDefault.permissions.filter((right) => right !== POLICY)));
    db.prepare("UPDATE portal_roles SET permissions='[\"own_schedule:read\"]',permissions_customized=1 WHERE id='department_manager'").run();
    await seed();
    assert.deepEqual(JSON.parse(db.prepare("SELECT permissions FROM portal_roles WHERE id='employee'").get().permissions), employeeDefault.permissions);
    assert.deepEqual(JSON.parse(db.prepare("SELECT permissions FROM portal_roles WHERE id='manager'").get().permissions), managerDefault.permissions);
    assert.deepEqual(JSON.parse(db.prepare("SELECT permissions FROM portal_roles WHERE id='department_manager'").get().permissions), ["own_schedule:read"]);
    assert.deepEqual(db.prepare("SELECT * FROM portal_permission_denials ORDER BY employee_number,permission").all(), denials);
    assert.deepEqual(db.prepare("SELECT * FROM portal_permission_grants ORDER BY employee_number,permission").all(), grants);
    assert.deepEqual(db.prepare("SELECT * FROM portal_position_permission_defaults WHERE position_id='lehrling'").get(), position);
    assert.equal((await request("/api/portal/v1/branch-orders/catalog", MA)).status, 403);
    assert.equal((await request("/api/portal/v1/loans/return-policy-settings", FL)).status, 403);
  });
});
