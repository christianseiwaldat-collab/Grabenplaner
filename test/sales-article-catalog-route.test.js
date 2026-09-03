"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-article-search-route-"));
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

const EMPLOYEE_NUMBER = "article-search-manager";
let httpServer;
let baseUrl;

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    EMPLOYEE_NUMBER,
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return `grabenplaner_session=${encodeURIComponent(token)}`;
}

async function requestJson(route, cookie) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { Accept: "application/json", Cookie: cookie },
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

test.before(async () => {
  const location = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get();
  const position = db.prepare("SELECT id FROM positions ORDER BY id LIMIT 1").get();
  assert.ok(location);
  assert.ok(position);
  let department = db.prepare(`
    SELECT id FROM departments
    WHERE location_id = ? AND active = 1
    ORDER BY id LIMIT 1
  `).get(location.id);
  if (!department) {
    department = db.prepare(`
      INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, 'Artikelstamm Route', 0, 1, 9292)
      RETURNING id
    `).get(location.id);
  }
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, color, contracted_hours,
      target_workdays_per_week, fixed_workdays, home_location_id,
      preferred_department_id, position_id, active
    ) VALUES (?, 'Artikelstamm Manager', 'Artikel', '#26785f', 38.5, 5, '', ?, ?, ?, 1)
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
  const grant = db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, ?, ?)
  `);
  grant.run(EMPLOYEE_NUMBER, SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS, EMPLOYEE_NUMBER);
  grant.run(EMPLOYEE_NUMBER, SALES_ARTICLE_CATALOG_PERMISSIONS.READ, EMPLOYEE_NUMBER);
  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, 'schedule:read', ?)
  `).run(EMPLOYEE_NUMBER, EMPLOYEE_NUMBER);

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

test("Artikelsuche funktioniert mit Artikelrechten und explizit entzogenem Dienstplanrecht", async () => {
  const result = await requestJson(
    "/api/sales/articles?status=all&limit=10&offset=0",
    createSession(),
  );
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.match(result.response.headers.get("cache-control") || "", /private/);
  assert.equal(Array.isArray(result.payload?.items), true);
  assert.equal(Number.isInteger(result.payload?.total), true);
  assert.equal(JSON.stringify(result.payload).includes("price"), false);
});

test("Artikelsuche bleibt ohne das gekoppelte Leserecht geschlossen", async () => {
  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, ?, ?)
  `).run(EMPLOYEE_NUMBER, SALES_ARTICLE_CATALOG_PERMISSIONS.READ, EMPLOYEE_NUMBER);
  const result = await requestJson(
    "/api/sales/articles?status=all&limit=10&offset=0",
    createSession(),
  );
  assert.equal(result.response.status, 403, JSON.stringify(result.payload));
  assert.equal(result.payload?.code, "PORTAL_PERMISSION_DENIED");
});
