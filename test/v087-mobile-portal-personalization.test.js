"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const portalHtml = fs.readFileSync(path.join(projectRoot, "public", "portal.html"), "utf8");
const portalScript = fs.readFileSync(path.join(projectRoot, "public", "portal.js"), "utf8");
const portalStyles = fs.readFileSync(path.join(projectRoot, "public", "portal.css"), "utf8");

test("v0.87: Persönliche Einstellungen sind geschlossen, Empfänger verschoben und Passwort zuletzt", () => {
  const settingsView = portalHtml.match(
    /<section class="portal-view" id="settingsView"[\s\S]*?(?=<section class="portal-view active" id="scheduleView")/,
  )?.[0] || "";
  const moreView = portalHtml.match(
    /<section class="portal-view leadership-view" id="leadershipMoreView"[\s\S]*?(?=<section class="portal-view" id="timeOffView")/,
  )?.[0] || "";
  const detailTags = [...settingsView.matchAll(/<details\b[^>]*>/g)].map((match) => match[0]);

  assert.equal(detailTags.length, 6);
  assert.equal(detailTags.every((tag) => !/\sopen(?:\s|=|>)/.test(tag)), true);
  assert.equal((portalHtml.match(/Verifizierte Empfänger/g) || []).length, 1);
  assert.match(settingsView, /id="sicknessNotificationPreferencesCard"[\s\S]*Verifizierte Empfänger/);
  assert.doesNotMatch(moreView, /Verifizierte Empfänger|sicknessNotificationPreferencesCard/);

  const passwordSection = settingsView.indexOf('class="portal-card portal-settings-section portal-settings-password"');
  const lastDetailsStart = settingsView.lastIndexOf("<details");
  assert.ok(passwordSection > settingsView.indexOf('id="sicknessNotificationPreferencesCard"'));
  assert.ok(lastDetailsStart >= 0 && lastDetailsStart < passwordSection);
  assert.match(settingsView.slice(lastDetailsStart), /^<details class="portal-card portal-settings-section portal-settings-password"[\s\S]*Passwort ändern[\s\S]*id="settingsPasswordButton"/);
});

test("v0.87: Bottom-Menü bleibt auch bei 360px garantiert eine horizontale Zeile", () => {
  assert.match(
    portalStyles,
    /@media \(max-width:720px\) \{[\s\S]*?\.portal-tabs\.mobile-personal \{[^}]*display:flex;[^}]*flex-wrap:nowrap;[^}]*overflow-x:auto;[^}]*overflow-y:hidden;/,
  );
  assert.match(
    portalStyles,
    /\.portal-tabs\.mobile-personal button \{[^}]*flex:1 0 72px;[^}]*min-width:72px;[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap;/,
  );
  const mobileNavRule = portalStyles.match(/\.portal-tabs\.mobile-personal button \{[^}]*\}/)?.[0] || "";
  assert.doesNotMatch(mobileNavRule, /white-space:normal/);
  assert.ok((5 + 1) * 72 > 360 - 16, "Bei 360px muss horizontaler Overflow statt Umbruch entstehen");

  assert.match(portalScript, /\.filter\(\(id\) => available\.has\(id\) && draft\.selected\.includes\(id\)\)\s*\.slice\(0, 5\)/);
  assert.match(portalScript, /return \[\.\.\.direct, "more"\];/);
  assert.match(portalScript, /„Mehr“ bleibt fest am Ende/);
  assert.match(portalScript, /button\.classList\.add\("mobile-navigation-hidden"\)/);
  assert.match(portalScript, /button\?\.classList\.remove\("mobile-navigation-hidden"\)/);
  assert.match(
    portalStyles,
    /\.portal-tabs\.mobile-personal button\.mobile-navigation-hidden \{\s*display:none !important;\s*\}/,
  );
});

test("v0.87: Portaldesign verwendet nur kuratierte Varianten und kein freies CSS", () => {
  for (const palette of ["forest", "ocean", "plum", "sand"]) {
    assert.match(portalHtml, new RegExp(`name="mobilePortalPalette" value="${palette}"`));
    assert.match(portalStyles, new RegExp(`data-portal-palette="${palette}"`));
  }
  for (const surface of ["soft", "compact"]) {
    assert.match(portalHtml, new RegExp(`name="mobilePortalSurface" value="${surface}"`));
  }
  assert.doesNotMatch(portalHtml, /type="color"|customCss|customColor/i);
  assert.match(portalScript, /document\.documentElement\.dataset\.portalPalette = appearance\.palette/);
  assert.match(portalScript, /document\.documentElement\.dataset\.portalSurface = appearance\.surface/);
});

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v087-mobile-personal-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { app, db } = subject;
let httpServer;
let baseUrl;

function ensureEmployee(employeeNumber, fullName, locationId) {
  db.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname, home_location_id, active)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      active = 1
  `).run(employeeNumber, fullName, fullName.split(" ")[0], locationId);
}

function createPortalSession(employeeNumber) {
  const token = `v087-mobile-${employeeNumber}-${crypto.randomBytes(24).toString("hex")}`;
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', 'employee', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only', role = 'employee', active = 1,
      must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber);
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return {
    cookie: `grabenplaner_session=${encodeURIComponent(token)}; grabenplaner_csrf=${encodeURIComponent(csrf)}`,
    csrf,
  };
}

async function requestJson(route, { method = "GET", session = null, body } = {}) {
  const headers = { Accept: "application/json" };
  if (session) headers.Cookie = session.cookie;
  if (session && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

test.before(async () => {
  const locationId = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id;
  ensureEmployee("v087-mobile-a", "Mara Mobil", locationId);
  ensureEmployee("v087-mobile-b", "Berta Mobil", locationId);
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

test("v0.87: Navigation und Design werden ausschließlich pro Mitarbeiter gespeichert", async () => {
  const employeeA = createPortalSession("v087-mobile-a");
  const employeeB = createPortalSession("v087-mobile-b");
  const defaults = await requestJson("/api/portal/v1/ui-preferences", { session: employeeA });

  assert.equal(defaults.response.status, 200, JSON.stringify(defaults.payload));
  assert.deepEqual(defaults.payload.mobilePortalNavigation, {
    version: 1,
    order: ["time", "tasks", "team", "approvals", "schedule", "requests", "loan", "sickness"],
    hidden: [],
  });
  assert.deepEqual(defaults.payload.mobilePortalAppearance, {
    version: 1,
    palette: "forest",
    surface: "soft",
  });
  assert.equal(defaults.payload.mobilePortalNavigationCustomized, false);
  assert.equal(defaults.payload.mobilePortalAppearanceCustomized, false);

  const navigation = {
    version: 1,
    order: ["schedule", "tasks", "requests", "time", "sickness", "loan", "team", "approvals"],
    hidden: ["loan", "team", "approvals"],
  };
  const appearance = { version: 1, palette: "ocean", surface: "compact" };
  const changed = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: employeeA,
    body: { mobilePortalNavigation: navigation, mobilePortalAppearance: appearance },
  });

  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  assert.deepEqual(changed.payload.mobilePortalNavigation, navigation);
  assert.deepEqual(changed.payload.mobilePortalAppearance, appearance);
  assert.equal(changed.payload.mobilePortalNavigationCustomized, true);
  assert.equal(changed.payload.mobilePortalAppearanceCustomized, true);

  const storedRows = db.prepare(`
    SELECT preference_key, value
    FROM portal_user_preferences
    WHERE employee_number = ?
      AND preference_key IN ('mobile_portal_navigation_v1', 'mobile_portal_appearance_v1')
    ORDER BY preference_key
  `).all("v087-mobile-a");
  assert.deepEqual(storedRows.map((row) => row.preference_key), [
    "mobile_portal_appearance_v1",
    "mobile_portal_navigation_v1",
  ]);
  assert.deepEqual(JSON.parse(storedRows[0].value), appearance);
  assert.deepEqual(JSON.parse(storedRows[1].value), navigation);

  const untouched = await requestJson("/api/portal/v1/ui-preferences", { session: employeeB });
  assert.equal(untouched.response.status, 200, JSON.stringify(untouched.payload));
  assert.equal(untouched.payload.mobilePortalAppearance.palette, "forest");
  assert.equal(untouched.payload.mobilePortalNavigationCustomized, false);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM portal_user_preferences WHERE employee_number = ?").get("v087-mobile-b").count,
    0,
  );
});

test("v0.87: Freie Farben, CSS, Oberflächen und unbekannte Menü-IDs werden abgewiesen", async () => {
  const employee = createPortalSession("v087-mobile-a");
  const invalidBodies = [
    { mobilePortalAppearance: { version: 1, palette: "#0055ff", surface: "soft" } },
    { mobilePortalAppearance: { version: 1, palette: "forest", surface: "glass" } },
    { mobilePortalAppearance: { version: 1, palette: "forest", surface: "soft", customCss: "*{}" } },
    { mobilePortalNavigation: { version: 1, order: ["schedule", "secrets"], hidden: [] } },
    { mobilePortalNavigation: { version: 1, order: ["schedule"], hidden: ["loan", "loan"] } },
    { mobilePortalNavigation: { version: 1, order: ["schedule"], hidden: [], customTab: "/admin" } },
  ];

  for (const body of invalidBodies) {
    const result = await requestJson("/api/portal/v1/ui-preferences", {
      method: "PUT",
      session: employee,
      body,
    });
    assert.equal(result.response.status, 400, JSON.stringify({ body, payload: result.payload }));
    assert.equal(result.payload.code, "UI_PREFERENCES_INVALID");
  }
});
