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

test("v0.87: Persönliche Einstellungen sind geschlossen, Benachrichtigungen ergänzt und Passwort zuletzt", () => {
  const settingsView = portalHtml.match(
    /<section class="portal-view" id="settingsView"[\s\S]*?(?=<section class="portal-view active" id="scheduleView")/,
  )?.[0] || "";
  const moreView = portalHtml.match(
    /<section class="portal-view leadership-view" id="leadershipMoreView"[\s\S]*?(?=<section class="portal-view" id="timeOffView")/,
  )?.[0] || "";
  const detailTags = [...settingsView.matchAll(/<details\b[^>]*>/g)].map((match) => match[0]);

  assert.equal(detailTags.length, 9);
  assert.equal(detailTags.every((tag) => !/\sopen(?:\s|=|>)/.test(tag)), true);
  assert.doesNotMatch(portalHtml, /Verifizierte Empfänger|sicknessNotificationPreferencesCard/);
  assert.doesNotMatch(moreView, /Externe Benachrichtigungen|emailSettingsCard/);
  assert.match(settingsView, /id="emailSettingsCard"[\s\S]*Externe Benachrichtigungen/);
  assert.doesNotMatch(settingsView.match(/<details[^>]+id="emailSettingsCard"[^>]*>/)?.[0] || "", /\bhidden\b/);
  assert.match(settingsView, /<details class="portal-card portal-settings-section hidden" id="branchOrderSettingsCard"/);

  const passwordSection = settingsView.indexOf('class="portal-card portal-settings-section portal-settings-password"');
  const emailSection = settingsView.indexOf('id="emailSettingsCard"');
  const lastDetailsStart = settingsView.lastIndexOf("<details");
  assert.ok(emailSection >= 0);
  assert.ok(passwordSection > emailSection);
  assert.ok(lastDetailsStart >= 0 && lastDetailsStart < passwordSection);
  assert.match(settingsView.slice(lastDetailsStart), /^<details class="portal-card portal-settings-section portal-settings-password"[\s\S]*Passwort ändern[\s\S]*id="settingsPasswordButton"/);
});

test("v0.87: Persönliche Kanäle bleiben Self-Service, Stammdaten read-only und Fachereignisse inaktiv", () => {
  assert.match(portalScript, /api\("\/api\/portal\/v1\/me\/email-settings"\)/);
  assert.match(portalScript, /api\("\/api\/portal\/v1\/me\/email-settings\/categories"/);
  assert.match(portalScript, /Object\.freeze\(\["email", "sms", "whatsapp"\]\)/);
  assert.match(portalScript, /return String\(target\?\.masked \|\| ""\)\.trim\(\)/);
  assert.doesNotMatch(portalScript, /email-settings\/address|data-channel-destination|preference\.destination/);
  assert.match(portalScript, /<span>Noch nicht aktiviert<\/span>/);
  assert.match(portalHtml, /Einsatzanfragen können bei ausgewähltem, bestätigtem E-Mail-Kanal automatisch versendet werden\./);
  assert.match(portalScript, /if \(tab === "settings"\)[\s\S]*loadEmailSettings\(\)/);
  assert.doesNotMatch(portalScript, /if \(hasPortalPermission\([^)]*\)\)\s*loadEmailSettings\(\)/);
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

test("v0.92.3: Portaldesign bietet acht kuratierte Farbwelten und eine begrenzte RGB-Kachelauswahl", () => {
  for (const palette of ["forest", "ocean", "plum", "sand", "berry", "amber", "slate", "teal"]) {
    assert.match(portalHtml, new RegExp(`name="mobilePortalPalette" value="${palette}"`));
    assert.match(portalStyles, new RegExp(`data-portal-palette="${palette}"`));
  }
  for (const surface of ["soft", "compact"]) {
    assert.match(portalHtml, new RegExp(`name="mobilePortalSurface" value="${surface}"`));
  }
  assert.match(portalHtml, /id="mobileHomeSettingsCard"/);
  assert.match(portalScript, /type="color" data-mobile-home-color-picker[\s\S]*?data-mobile-home-rgb="r"/);
  assert.doesNotMatch(portalHtml, /customCss|customColor/i);
  assert.match(portalScript, /document\.documentElement\.dataset\.portalPalette = appearance\.palette/);
  assert.match(portalScript, /document\.documentElement\.dataset\.portalSurface = appearance\.surface/);
  assert.match(portalScript, /function normalizedMobilePortalHome/);
  assert.match(portalStyles, /\.mobile-home-tiles button/);
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

test("v0.92.3: Navigation, Design und Startseite werden ausschließlich pro Mitarbeiter gespeichert", async () => {
  const employeeA = createPortalSession("v087-mobile-a");
  const employeeB = createPortalSession("v087-mobile-b");
  const defaults = await requestJson("/api/portal/v1/ui-preferences", { session: employeeA });

  assert.equal(defaults.response.status, 200, JSON.stringify(defaults.payload));
  assert.deepEqual(defaults.payload.mobilePortalNavigation, {
    version: 1,
    order: ["time", "tasks", "team", "approvals", "schedule", "requests", "loan", "sickness", "learning"],
    hidden: [],
  });
  assert.deepEqual(defaults.payload.mobilePortalAppearance, {
    version: 1,
    palette: "forest",
    surface: "soft",
  });
  assert.deepEqual(defaults.payload.mobilePortalHome, {
    version: 1,
    order: ["time", "tasks", "team", "approvals", "schedule", "requests", "loan", "sickness", "learning", "branchOrders", "branchVacation"],
    colors: {
      time: [39, 110, 85], tasks: [41, 107, 145], team: [98, 84, 151], approvals: [156, 104, 28],
      schedule: [38, 112, 104], requests: [128, 82, 108], loan: [129, 91, 48], sickness: [173, 75, 66],
      learning: [55, 118, 93],
      branchOrders: [42, 122, 99], branchVacation: [76, 112, 167],
    },
  });
  assert.equal(defaults.payload.mobilePortalNavigationCustomized, false);
  assert.equal(defaults.payload.mobilePortalAppearanceCustomized, false);

  const navigation = {
    version: 1,
    order: ["schedule", "tasks", "requests", "time", "sickness", "learning", "loan", "team", "approvals"],
    hidden: ["loan", "team", "approvals"],
  };
  const appearance = { version: 1, palette: "ocean", surface: "compact" };
  const home = {
    version: 1,
    order: ["loan", "schedule", "time", "tasks", "requests", "sickness", "learning", "team", "approvals", "branchOrders", "branchVacation"],
    colors: {
      time: [10, 20, 30], tasks: [40, 50, 60], team: [70, 80, 90], approvals: [100, 110, 120],
      schedule: [130, 140, 150], requests: [160, 170, 180], loan: [190, 200, 210], sickness: [220, 230, 240],
      learning: [55, 118, 93],
      branchOrders: [24, 122, 99], branchVacation: [76, 112, 167],
    },
  };
  const changed = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: employeeA,
    body: { mobilePortalNavigation: navigation, mobilePortalAppearance: appearance, mobilePortalHome: home },
  });

  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  assert.deepEqual(changed.payload.mobilePortalNavigation, navigation);
  assert.deepEqual(changed.payload.mobilePortalAppearance, appearance);
  assert.deepEqual(changed.payload.mobilePortalHome, home);
  assert.equal(changed.payload.mobilePortalNavigationCustomized, true);
  assert.equal(changed.payload.mobilePortalAppearanceCustomized, true);

  const storedRows = db.prepare(`
    SELECT preference_key, value
    FROM portal_user_preferences
    WHERE employee_number = ?
      AND preference_key IN ('mobile_portal_navigation_v1', 'mobile_portal_appearance_v1', 'mobile_portal_home_v1')
    ORDER BY preference_key
  `).all("v087-mobile-a");
  assert.deepEqual(storedRows.map((row) => row.preference_key), [
    "mobile_portal_appearance_v1",
    "mobile_portal_home_v1",
    "mobile_portal_navigation_v1",
  ]);
  assert.deepEqual(JSON.parse(storedRows[0].value), appearance);
  assert.deepEqual(JSON.parse(storedRows[1].value), home);
  assert.deepEqual(JSON.parse(storedRows[2].value), navigation);

  const untouched = await requestJson("/api/portal/v1/ui-preferences", { session: employeeB });
  assert.equal(untouched.response.status, 200, JSON.stringify(untouched.payload));
  assert.equal(untouched.payload.mobilePortalAppearance.palette, "forest");
  assert.deepEqual(untouched.payload.mobilePortalHome.colors.schedule, [38, 112, 104]);
  assert.equal(untouched.payload.mobilePortalNavigationCustomized, false);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM portal_user_preferences WHERE employee_number = ?").get("v087-mobile-b").count,
    0,
  );
});

test("v0.92.3: Ungültige RGB-Werte, CSS, Oberflächen und unbekannte Menü-IDs werden abgewiesen", async () => {
  const employee = createPortalSession("v087-mobile-a");
  const invalidBodies = [
    { mobilePortalAppearance: { version: 1, palette: "#0055ff", surface: "soft" } },
    { mobilePortalAppearance: { version: 1, palette: "forest", surface: "glass" } },
    { mobilePortalAppearance: { version: 1, palette: "forest", surface: "soft", customCss: "*{}" } },
    { mobilePortalHome: { version: 1, order: ["schedule"], colors: { schedule: [256, 0, 0] } } },
    { mobilePortalHome: { version: 1, order: ["schedule"], colors: { schedule: "rgb(1,2,3)" } } },
    { mobilePortalHome: { version: 1, order: ["schedule", "secrets"], colors: { schedule: [1, 2, 3] } } },
    { mobilePortalHome: { version: 1, order: ["schedule"], colors: { schedule: [1, 2, 3], secrets: [4, 5, 6] } } },
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
