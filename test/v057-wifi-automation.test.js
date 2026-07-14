const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v057-wifi-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_WIFI_PROVIDER_ID = "generic-radius";
process.env.GRABENPLANER_WIFI_WEBHOOK_SECRET = "v057-test-webhook-secret-0123456789abcdef";
process.env.GRABENPLANER_WIFI_IDENTITY_KEY = "v057-test-identity-secret-0123456789abcdef";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const { app, db } = require("../server");
let httpServer;
let baseUrl;
let locationId;

function session(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET role = excluded.role, active = 1, must_change_password = 0, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare("INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at) VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')")
    .run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}

async function request(route, { method = "GET", auth = null, body, headers = {} } = {}) {
  const requestHeaders = { Accept: "application/json", ...headers };
  if (auth) requestHeaders.Cookie = auth.cookie;
  if (auth && !["GET", "HEAD"].includes(method)) requestHeaders["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

function event(eventId, eventType, occurredAt, extras = {}) {
  return request("/api/integrations/wifi/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GRABENPLANER_WIFI_WEBHOOK_SECRET}` },
    body: {
      providerId: "generic-radius",
      eventId,
      eventType,
      employeeReference: "102",
      locationReference: "Filiale-Controller-18",
      occurredAt: occurredAt.toISOString(),
      ...extras,
    },
  });
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000);
}

function isoDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function addDays(value, days) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monday(value) {
  const date = new Date(`${value}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function insertSuggestion(employeeNumber, workDate, level, dueAt, startHour = 8) {
  const presenceId = crypto.randomUUID();
  const suggestionId = crypto.randomUUID();
  const start = new Date(`${workDate}T${String(startHour).padStart(2, "0")}:00:00+02:00`);
  const end = new Date(start.getTime() + 2 * 60 * 60_000);
  db.prepare(`
    INSERT INTO wifi_presence_sessions
      (id, employee_number, location_id, provider_id, correlation_hash, observed_start_at, last_seen_at, observed_end_at, state)
    VALUES (?, ?, ?, 'generic-radius', ?, ?, ?, ?, 'closed')
  `).run(presenceId, employeeNumber, locationId, crypto.randomBytes(16).toString("hex"), start.toISOString(), end.toISOString(), end.toISOString());
  db.prepare(`
    INSERT INTO wifi_time_suggestions
      (id, presence_session_id, employee_number, location_id, work_date, suggested_start_at, suggested_end_at,
       confirmation_level_snapshot, confirmation_due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(suggestionId, presenceId, employeeNumber, locationId, workDate, start.toISOString(), end.toISOString(), level, dueAt);
  return suggestionId;
}

function reset() {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of ["wifi_time_suggestions", "wifi_event_inbox", "wifi_presence_sessions", "wifi_automation_preferences", "wifi_location_mappings", "portal_notifications", "portal_sessions", "audit_log", "time_entries"]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.prepare("UPDATE locations SET time_tracking_enabled = 1 WHERE id = ?").run(locationId);
    db.prepare("UPDATE employees SET home_location_id = ?, time_confirmation_level = 'C' WHERE personnel_number = '102'").run(locationId);
    const upsert = db.prepare("INSERT INTO portal_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    upsert.run("wifi_minimum_presence_minutes", "1");
    upsert.run("wifi_absence_grace_minutes", "5");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

test.before(async () => {
  locationId = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = '102'").get()?.home_location_id
    || db.prepare("SELECT id FROM locations ORDER BY id LIMIT 1").get().id;
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.beforeEach(reset);

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.57: Session liefert App-Rolle und Firmenposition getrennt", async () => {
  const position = db.prepare("SELECT id, name FROM positions ORDER BY id LIMIT 1").get();
  db.prepare("UPDATE employees SET position_id = ? WHERE personnel_number = '102'").run(position.id);
  const employee = session("102", "employee");
  const result = await request("/api/portal/v1/session", { auth: employee });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.user.role, "employee");
  assert.equal(result.payload.user.positionId, position.id);
  assert.equal(result.payload.user.positionName, position.name);
  assert.equal(result.payload.status.capabilities.wifiTimeSuggestions, true);
});

test("v0.57: Zuordnung und Opt-in speichern keine Klartext-Controllerkennung", async () => {
  const admin = session("101", "admin");
  const employee = session("102", "employee");
  const mapping = await request("/api/portal/v1/wifi-automation/location-mappings", {
    method: "PUT", auth: admin, body: { mappings: [{ locationId, externalReference: "Filiale-Controller-18" }] },
  });
  assert.equal(mapping.response.status, 200, JSON.stringify(mapping.payload));
  assert.equal(mapping.payload.locationMappings.find((item) => item.locationId === locationId).mapped, true);
  const storedMapping = db.prepare("SELECT * FROM wifi_location_mappings WHERE location_id = ?").get(locationId);
  assert.match(storedMapping.external_location_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(storedMapping).includes("Filiale-Controller-18"), false);

  const enabled = await request("/api/portal/v1/me/wifi-automation", { method: "PUT", auth: employee, body: { enabled: true } });
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.payload));
  assert.equal(enabled.payload.preference.enabled, true);
  assert.equal(enabled.payload.canEnable, true);
  const preference = db.prepare("SELECT external_subject_hash FROM wifi_automation_preferences WHERE employee_number = '102'").get();
  assert.match(preference.external_subject_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(preference.external_subject_hash, "102");
});

test("v0.57: Webhook ist geschützt, datensparsam, idempotent und erzeugt erst nach Toleranz einen Vorschlag", async () => {
  const admin = session("101", "admin");
  const employee = session("102", "employee");
  await request("/api/portal/v1/wifi-automation/location-mappings", { method: "PUT", auth: admin, body: { mappings: [{ locationId, externalReference: "Filiale-Controller-18" }] } });
  await request("/api/portal/v1/me/wifi-automation", { method: "PUT", auth: employee, body: { enabled: true } });

  const denied = await request("/api/integrations/wifi/events", { method: "POST", body: {} });
  assert.equal(denied.response.status, 403);
  const privacy = await event("privacy-1", "connected", minutesAgo(30), { mac: "00:11:22:33:44:55" });
  assert.equal(privacy.response.status, 400);
  assert.equal(privacy.payload.code, "WIFI_EVENT_PRIVACY_FIELD_REJECTED");

  const connected = await event("connect-1", "connected", minutesAgo(30));
  assert.equal(connected.response.status, 202, JSON.stringify(connected.payload));
  const duplicate = await event("connect-1", "connected", minutesAgo(30));
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.payload.duplicate, true);
  await event("disconnect-1", "disconnected", minutesAgo(20));
  const reconnect = await event("reconnect-1", "connected", minutesAgo(18));
  assert.equal(reconnect.payload.status, "reconnected_within_grace");
  await event("disconnect-2", "disconnected", minutesAgo(10));

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM wifi_time_suggestions").get().count, 0, "Während der Toleranz darf noch kein Vorschlag entstehen.");
  const payload = await request("/api/portal/v1/me/wifi-automation", { auth: employee });
  assert.equal(payload.response.status, 200, JSON.stringify(payload.payload));
  assert.equal(payload.payload.counts.pending, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM wifi_presence_sessions").get().count, 1, "Reconnect darf die Anwesenheit nicht teilen.");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM time_entries").get().count, 0, "Ohne Mitarbeiterbestätigung darf keine Zeitbuchung entstehen.");

  const suggestion = payload.payload.suggestions.find((item) => item.status === "pending");
  const confirmed = await request(`/api/portal/v1/me/wifi-suggestions/${suggestion.id}/confirm`, {
    method: "POST", auth: employee, body: { startTime: suggestion.startTime, endTime: suggestion.endTime },
  });
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.payload));
  assert.equal(confirmed.payload.suggestions.find((item) => item.id === suggestion.id).status, "confirmed");
  const entries = db.prepare("SELECT entry_type, source FROM time_entries ORDER BY entry_timestamp").all()
    .map((entry) => ({ entry_type: entry.entry_type, source: entry.source }));
  assert.deepEqual(entries, [{ entry_type: "clock_in", source: "wifi_confirmed" }, { entry_type: "clock_out", source: "wifi_confirmed" }]);
});

test("v0.57: A/B/C-Warnungen bleiben bearbeitbar und Stufe A schließt nur vollständige Wochen ab", async () => {
  const employee = session("102", "employee");
  const today = isoDate();
  insertSuggestion("102", addDays(today, -2), "C", new Date(Date.now() - 60_000).toISOString(), 7);
  insertSuggestion("102", addDays(today, -1), "B", new Date(Date.now() + 60 * 60_000).toISOString(), 11);
  let payload = await request("/api/portal/v1/me/wifi-automation", { auth: employee });
  assert.equal(payload.payload.counts.overdue, 1);
  assert.equal(payload.payload.counts.dueSoon, 1);

  db.prepare("DELETE FROM wifi_time_suggestions").run();
  db.prepare("DELETE FROM wifi_presence_sessions").run();
  db.prepare("DELETE FROM time_entries").run();
  db.prepare("UPDATE employees SET time_confirmation_level = 'A' WHERE personnel_number = '102'").run();
  const previousWeek = addDays(monday(today), -7);
  const first = insertSuggestion("102", previousWeek, "A", new Date(Date.now() - 60_000).toISOString(), 8);
  const second = insertSuggestion("102", addDays(previousWeek, 1), "A", new Date(Date.now() - 60_000).toISOString(), 12);
  const incomplete = await request("/api/portal/v1/me/wifi-suggestions/confirm-week", {
    method: "POST", auth: employee, body: { weekStart: previousWeek, suggestions: [{ id: first, startTime: "08:00", endTime: "10:00" }] },
  });
  assert.equal(incomplete.response.status, 409);
  assert.equal(incomplete.payload.code, "WIFI_SUGGESTION_WEEK_INCOMPLETE");
  const complete = await request("/api/portal/v1/me/wifi-suggestions/confirm-week", {
    method: "POST", auth: employee, body: { weekStart: previousWeek, suggestions: [
      { id: first, startTime: "08:00", endTime: "10:00" },
      { id: second, startTime: "12:00", endTime: "14:00" },
    ] },
  });
  assert.equal(complete.response.status, 200, JSON.stringify(complete.payload));
  assert.equal(complete.payload.suggestions.filter((item) => [first, second].includes(item.id)).every((item) => item.status === "confirmed"), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM time_entries WHERE source = 'wifi_confirmed'").get().count, 4);
});

test("v0.57: Ausschalten beendet offene Erkennung, löscht die Verknüpfung und bleibt revisionsfähig", async () => {
  const admin = session("101", "admin");
  const employee = session("102", "employee");
  await request("/api/portal/v1/wifi-automation/location-mappings", { method: "PUT", auth: admin, body: { mappings: [{ locationId, externalReference: "Filiale-Controller-18" }] } });
  await request("/api/portal/v1/me/wifi-automation", { method: "PUT", auth: employee, body: { enabled: true } });
  await event("optout-open", "connected", minutesAgo(4));
  const disabled = await request("/api/portal/v1/me/wifi-automation", { method: "PUT", auth: employee, body: { enabled: false } });
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.payload));
  const preference = db.prepare("SELECT enabled, external_subject_hash FROM wifi_automation_preferences WHERE employee_number = '102'").get();
  assert.equal(preference.enabled, 0);
  assert.equal(preference.external_subject_hash, null);
  assert.equal(db.prepare("SELECT state FROM wifi_presence_sessions WHERE employee_number = '102'").get().state, "cancelled");
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'wifi.preference.disable' AND actor = '102'").get());
});
