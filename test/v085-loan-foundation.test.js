"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  normalizeArticleNumber,
  parseShopwareSuggestHtml,
  shopwareSuggestUrl,
} = require("../lib/article-catalog");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v085-loans-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.NODE_ENV = "test";

const {
  app,
  db,
  installationFeaturesForApiPath,
  releaseInstanceLockForTests,
  validateUsbFeatures,
} = require("../server");

const ADMIN = "v085-admin";
const EMPLOYEE = "v085-employee";
let baseUrl;
let httpServer;
let locationId;
let adminSession;
let employeeSession;

function ensureEmployee(employeeNumber, name, role) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      active = 1
  `).run(employeeNumber, name, name.split(" ")[0], locationId);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only', role = excluded.role, active = 1,
      must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
}

function createSession(employeeNumber) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(rawToken).digest("hex"),
  );
  return {
    cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

async function request(route, { method = "GET", session = employeeSession, body } = {}) {
  const headers = { Accept: "application/json" };
  if (session) headers.Cookie = session.cookie;
  if (session && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

test.before(() => {
  locationId = String(db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id);
  ensureEmployee(ADMIN, "Ada Administration", "admin");
  ensureEmployee(EMPLOYEE, "Erika Beispiel", "employee");
  adminSession = createSession(ADMIN);
  employeeSession = createSession(EMPLOYEE);
  return new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.85 Artikelnummern sind exakt sechsstellig und bleiben als Text erhalten", () => {
  assert.equal(normalizeArticleNumber("089319"), "089319");
  assert.throws(() => normalizeArticleNumber("89319"), { code: "ARTICLE_NUMBER_INVALID" });
  assert.throws(() => normalizeArticleNumber("08A319"), { code: "ARTICLE_NUMBER_INVALID" });
  assert.throws(
    () => db.prepare("INSERT INTO articles (article_number, description) VALUES ('12345', 'Ungültig')").run(),
    /CHECK constraint failed/,
  );
});

test("v0.85 Shopware-Suche gleicht die sechsstellige Nummer exakt mit der Shopnummer ab", () => {
  const html = `
    <ul>
      <li class="search-suggest-product js-result">
        <a href="https://shop.example/Panasonic-Test/0000000104405" title="Panasonic Lumix DC-TZ99 Schwarz">
          <img alt="0000000104405">
          <div class="col search-suggest-product-name">Panasonic Lumix DC-TZ99 Schwarz</div>
        </a>
      </li>
    </ul>`;
  assert.deepEqual(parseShopwareSuggestHtml(html, "104405", "https://shop.example"), {
    articleNumber: "104405",
    description: "Panasonic Lumix DC-TZ99 Schwarz",
    sourceProvider: "shopware_storefront",
    sourceProductNumber: "0000000104405",
    sourceUrl: "https://shop.example/Panasonic-Test/0000000104405",
  });
  assert.equal(parseShopwareSuggestHtml(html, "104404", "https://shop.example"), null);
  assert.equal(shopwareSuggestUrl("https://shop.example", "104405").href,
    "https://shop.example/suggest?search=104405");
});

test("v0.85 Datenmodell trennt zentralen Artikelstamm, Standortfreigabe und Leihhistorie", () => {
  for (const table of ["articles", "loan_location_settings", "loans", "loan_items", "loan_events"]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  }
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.85-loan-module-foundation'").get());
  db.prepare("INSERT INTO articles (article_number, description) VALUES ('654321', 'Testartikel')").run();
  const loanId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO loans (id, location_id, borrower_employee_number, created_by_employee_number)
    VALUES (?, ?, ?, ?)
  `).run(loanId, locationId, EMPLOYEE, ADMIN);
  db.prepare(`
    INSERT INTO loan_events (loan_id, actor_employee_number, event_type, revision)
    VALUES (?, ?, 'created', 1)
  `).run(loanId, ADMIN);
  assert.throws(
    () => db.prepare("UPDATE loan_events SET event_type = 'changed' WHERE loan_id = ?").run(loanId),
    /loan events are immutable/,
  );
});

test("v0.85 Funktionsprofil schaltet Leihe nur gemeinsam mit dem Mitarbeiterportal frei", () => {
  assert.deepEqual(
    new Set(installationFeaturesForApiPath("/portal/v1/loans/articles/resolve")),
    new Set(["loans", "employeePortal"]),
  );
  assert.deepEqual(
    new Set(validateUsbFeatures({ enabledFeatures: ["loans"] })),
    new Set(["schedule", "loans", "employeePortal"]),
  );
  const roles = new Map(db.prepare("SELECT id, permissions FROM portal_roles").all()
    .map((role) => [role.id, new Set(JSON.parse(role.permissions))]));
  assert.equal(roles.get("employee").has("loans:self:create"), true);
  assert.equal(roles.get("department_manager").has("loans:location:manage"), false);
  assert.equal(roles.get("manager").has("loans:location:manage"), true);
  assert.equal(roles.get("hr").has("loans:settings"), true);
});

test("v0.85 PL-plus konfiguriert den Standort, Mitarbeitende dürfen die Einstellungen nicht lesen", async () => {
  const denied = await request("/api/portal/v1/loans/settings");
  assert.equal(denied.response.status, 403);

  const configured = await request(`/api/portal/v1/loans/settings/locations/${locationId}`, {
    method: "PUT",
    session: adminSession,
    body: {
      enabled: true,
      articleLookup: {
        enabled: true,
        provider: "shopware_storefront",
        baseUrl: "https://shop.lamprechter.com",
      },
    },
  });
  assert.equal(configured.response.status, 200, JSON.stringify(configured.payload));
  assert.equal(configured.payload.location.enabled, true);
  assert.equal(configured.payload.location.articleLookup.baseUrl, "https://shop.lamprechter.com");

  const status = await request("/api/portal/v1/loans/status");
  assert.equal(status.response.status, 200, JSON.stringify(status.payload));
  assert.equal(status.payload.available, true);
  assert.equal(status.payload.permissions.ownCreate, true);
});

test("v0.85 manuelle Rückfalleingabe speichert einen wiederverwendbaren Artikel", async () => {
  db.prepare(`
    UPDATE loan_location_settings
    SET article_lookup_enabled = 0, article_lookup_provider = 'none',
        article_lookup_base_url = '', updated_at = CURRENT_TIMESTAMP
    WHERE location_id = ?
  `).run(locationId);
  const invalid = await request("/api/portal/v1/loans/articles/resolve", {
    method: "POST",
    body: { locationId, articleNumber: "12345", manualDescription: "Ungültig" },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.payload.code, "ARTICLE_NUMBER_INVALID");

  const resolved = await request("/api/portal/v1/loans/articles/resolve", {
    method: "POST",
    body: {
      locationId,
      articleNumber: "089319",
      manualDescription: "DÖRR Mini Octagon Softbox für Blitzgeräte",
    },
  });
  assert.equal(resolved.response.status, 200, JSON.stringify(resolved.payload));
  assert.equal(resolved.payload.article.articleNumber, "089319");
  assert.equal(resolved.payload.article.sourceProvider, "manual");

  const protectedExisting = await request("/api/portal/v1/loans/articles/resolve", {
    method: "POST",
    body: {
      locationId,
      articleNumber: "089319",
      manualDescription: "Unbeabsichtigtes Überschreiben",
    },
  });
  assert.equal(protectedExisting.response.status, 200, JSON.stringify(protectedExisting.payload));
  assert.equal(protectedExisting.payload.preservedManualDescription, true);
  assert.equal(protectedExisting.payload.article.description, "DÖRR Mini Octagon Softbox für Blitzgeräte");

  const cached = await request(`/api/portal/v1/loans/articles?locationId=${locationId}&query=089319`);
  assert.equal(cached.response.status, 200, JSON.stringify(cached.payload));
  assert.equal(cached.payload.articles[0].description, "DÖRR Mini Octagon Softbox für Blitzgeräte");

  db.prepare(`
    UPDATE loan_location_settings
    SET article_lookup_enabled = 1, article_lookup_provider = 'shopware_storefront',
        article_lookup_base_url = 'https://shop.example.test', updated_at = CURRENT_TIMESTAMP
    WHERE location_id = ?
  `).run(locationId);
  db.prepare(`
    UPDATE articles
    SET source_provider = 'shopware_storefront', source_fetched_at = CURRENT_TIMESTAMP
    WHERE article_number = '089319'
  `).run();
  const cachedResolution = await request("/api/portal/v1/loans/articles/resolve", {
    method: "POST",
    body: { locationId, articleNumber: "089319" },
  });
  assert.equal(cachedResolution.response.status, 200, JSON.stringify(cachedResolution.payload));
  assert.equal(cachedResolution.payload.cacheHit, true);
  assert.equal(cachedResolution.payload.lookupWarning, null);
});
