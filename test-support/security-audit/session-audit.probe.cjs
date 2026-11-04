"use strict";

// Standalone, synthetic-only audit probe. Findings are observations, not failing
// assertions in the product test suite. Infrastructure errors exit nonzero.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath || !path.isAbsolute(outputPath)) throw new Error("Absolute JSON output path required");
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gp-security-audit-synthetic-"));
  const dataRoot = path.join(testRoot, "server-data");
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GRABENPLANER_") || ["DB_PATH", "DB_PROVIDER", "DATABASE_URL", "BACKUP_DIR"].includes(name)) delete process.env[name];
  }
  Object.assign(process.env, {
    DB_PROVIDER: "sqlite", DB_PATH: path.join(dataRoot, "data", "dienstplan.db"),
    BACKUP_DIR: path.join(testRoot, "backups"), GRABENPLANER_DATA_DIR: dataRoot,
    GRABENPLANER_HOST: "127.0.0.1", GRABENPLANER_OPERATION_MODE: "server",
    GRABENPLANER_PUBLIC_URL: "https://audit.example.test", GRABENPLANER_TRUST_PROXY: "loopback",
    GRABENPLANER_DEPLOYMENT_KIND: "codespaces-test", GRABENPLANER_AMU_KEY_ID: "synthetic-audit-v1",
    GRABENPLANER_AMU_KEY: crypto.randomBytes(32).toString("base64"),
    GRABENPLANER_WIFI_WEBHOOK_SECRET: crypto.randomBytes(32).toString("hex"),
    GRABENPLANER_SERVICE_CONTROL_TOKEN: crypto.randomBytes(32).toString("hex"),
    GRABENPLANER_TEST_AMU_SCANNER: "clean", GRABENPLANER_SEED_DEMO: "1", NODE_ENV: "test", TZ: "Europe/Vienna",
  });
  const results = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    scope: "Synthetic SQLite fixture, loopback HTTP with a trusted local HTTPS-proxy header; no TLS or production verification",
    observations: [] };
  let server, application;
  function observe(id, actual, expected, description) {
    results.observations.push({ id, outcome: actual === expected ? "observed_expected" : "observed_gap", actual, expected, description });
  }
  try {
    application = require("../../server");
    const { app, db, hashPortalPassword, verifyPortalPassword } = application;
    const employee = "AUDIT-SYNTHETIC-970", rateEmployee = "AUDIT-SYNTHETIC-971";
    const oldPassword = "SyntheticAuditPassword-Old!", newPassword = "SyntheticAuditPassword-New!";
    const locationId = db.prepare("SELECT id FROM locations ORDER BY id LIMIT 1").get().id;
    for (const id of [employee, rateEmployee]) {
      db.prepare("INSERT INTO employees (personnel_number,full_name,nickname,color,contracted_hours,home_location_id,active) VALUES (?, 'Synthetic Audit', 'Audit', '#287a67', 38.5, ?, 1)").run(id, locationId);
      db.prepare("INSERT INTO portal_users (employee_number,password_hash,role,active,must_change_password,password_changed_at) VALUES (?,?,'employee',1,0,CURRENT_TIMESTAMP)").run(id, await hashPortalPassword(oldPassword));
    }
    server = await new Promise((resolve, reject) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); instance.once("error", reject); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    async function request(route, { method = "GET", cookie, csrf, body, headers = {} } = {}) {
      const response = await fetch(origin + route, { method, headers: {
        "X-Forwarded-Proto": "https", Accept: "application/json", ...headers,
        ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      let payload; try { payload = JSON.parse(text); } catch { payload = null; }
      return { status: response.status, payload, cookies: response.headers.getSetCookie(), headers: response.headers };
    }
    function credentials(reply) {
      const pairs = reply.cookies.map(value => value.split(";")[0]);
      const parsed = Object.fromEntries(pairs.map(pair => { const split = pair.indexOf("="); return [pair.slice(0, split), decodeURIComponent(pair.slice(split + 1))]; }));
      assert.ok(parsed.grabenplaner_session && parsed.grabenplaner_csrf, "Login fixture must receive both cookies");
      return { cookie: pairs.join("; "), csrf: parsed.grabenplaner_csrf, tokenHash: crypto.createHash("sha256").update(parsed.grabenplaner_session).digest("hex") };
    }
    async function login(password = newPassword) {
      const reply = await request("/api/portal/v1/auth/login", { method: "POST", body: { employeeNumber: employee, password } });
      assert.equal(reply.status, 200, "Synthetic login fixture must succeed");
      return { ...credentials(reply), reply };
    }
    observe("anonymous_personal_endpoint", (await request("/api/portal/v1/me")).status, 401, "An unauthenticated personal endpoint request is rejected");
    const first = await login(oldPassword);
    const sessionCookie = first.reply.cookies.find(value => value.startsWith("grabenplaner_session="));
    observe("cookie_http_only", /;\s*HttpOnly(?:;|$)/i.test(sessionCookie), true, "Session cookie has HttpOnly");
    observe("cookie_secure", /;\s*Secure(?:;|$)/i.test(sessionCookie), true, "Session cookie has Secure in configured server mode");
    observe("cookie_same_site", /;\s*SameSite=Strict(?:;|$)/i.test(sessionCookie), true, "Session cookie explicitly has SameSite=Strict");
    const stored = db.prepare("SELECT token_hash FROM portal_sessions WHERE employee_number=? AND revoked_at IS NULL").get(employee);
    observe("session_token_hashed_at_rest", stored?.token_hash === first.tokenHash && /^[a-f0-9]{64}$/.test(stored.token_hash), true, "Persistence contains the SHA-256 of the issued token");
    const me = await request("/api/portal/v1/me", first);
    observe("authenticated_personal_endpoint", me.status, 200, "Authenticated session reaches the personal endpoint");
    observe("personal_response_no_store", /no-store/.test(me.headers.get("cache-control") || ""), true, "Personal API response disables storage");
    observe("password_change_missing_csrf", (await request("/api/portal/v1/me/password", { method: "PUT", cookie: first.cookie, body: { currentPassword: oldPassword, newPassword } })).status, 403, "Cookie-authenticated password change requires the CSRF header");
    observe("password_change_current_required", (await request("/api/portal/v1/me/password", { method: "PUT", ...first, body: { currentPassword: "SyntheticWrongPassword!", newPassword } })).status, 401, "Password change rejects an incorrect current password");
    observe("password_change_success", (await request("/api/portal/v1/me/password", { method: "PUT", ...first, body: { currentPassword: oldPassword, newPassword } })).status, 200, "Password change succeeds with current credentials and CSRF");
    observe("GP-SEC-01_old_browser_token_after_password_change", (await request("/api/portal/v1/me", first)).status, 401, "A copied old browser session should be invalid after password change; a 200 demonstrates retained session access");
    observe("logout_missing_csrf", (await request("/api/portal/v1/auth/logout", { method: "POST", cookie: first.cookie, body: {} })).status, 403, "Authenticated logout requires CSRF");
    observe("logout_success", (await request("/api/portal/v1/auth/logout", { method: "POST", ...first, body: {} })).status, 200, "Authenticated logout succeeds");
    observe("logout_invalidates_old_token", (await request("/api/portal/v1/me", first)).status, 401, "Logged-out token no longer authorizes access");
    const second = await login();
    const third = await login();
    observe("new_login_invalidates_previous_token", (await request("/api/portal/v1/me", second)).status, 401, "A new successful browser login replaces the previous account session");
    observe("new_login_changes_token", second.tokenHash !== third.tokenHash, true, "Separate successful logins produce different token values");
    const oldCreatedAt = new Date(Date.now() - 400 * 86400000).toISOString();
    const nearExpiry = new Date(Date.now() + 60000).toISOString();
    db.prepare("UPDATE portal_sessions SET created_at=?, last_seen_at=?, expires_at=? WHERE token_hash=?").run(oldCreatedAt, oldCreatedAt, nearExpiry, third.tokenHash);
    const aged = await request("/api/portal/v1/me", third);
    observe("GP-SEC-02_400_day_session_age", aged.status, 401, "Backdated synthetic issued-at plus valid idle expiry should hit an absolute lifetime cap; fixture uses database time mutation, not a 400-day runtime soak");
    const renewed = db.prepare("SELECT expires_at FROM portal_sessions WHERE token_hash=?").get(third.tokenHash);
    results.observations.push({ id: "aged_session_idle_expiry_extended", outcome: "observation", actual: Date.parse(renewed.expires_at) > Date.parse(nearExpiry), description: "Whether the old synthetic session's idle expiry is renewed" });
    db.prepare("UPDATE portal_sessions SET expires_at=? WHERE token_hash=?").run(new Date(Date.now() - 1000).toISOString(), third.tokenHash);
    observe("expired_session_rejected", (await request("/api/portal/v1/me", third)).status, 401, "An expired idle session is rejected");
    const fourth = await login();
    db.prepare("UPDATE portal_users SET active=0 WHERE employee_number=?").run(employee);
    observe("disabled_account_rejected", (await request("/api/portal/v1/me", fourth)).status, 401, "Disabling the account removes access on the next request");
    const longPassword = "S".repeat(80);
    observe("password_80_characters_supported", await verifyPortalPassword(longPassword, await hashPortalPassword(longPassword)), true, "Hashing accepts and verifies an 80-character synthetic password without truncation");
    const spacedUnicode = "  Synthetic äöü 🔐 password  ";
    const unicodeHash = await hashPortalPassword(spacedUnicode);
    observe("password_unicode_and_spaces_supported", await verifyPortalPassword(spacedUnicode, unicodeHash), true, "Unicode and leading/trailing spaces survive password hashing");
    observe("password_not_trimmed", await verifyPortalPassword(spacedUnicode.trim(), unicodeHash), false, "Trimming changes the password");
    const firstHash = await hashPortalPassword(longPassword), secondHash = await hashPortalPassword(longPassword);
    observe("password_unique_salt", firstHash !== secondHash, true, "Identical passwords receive different salted hashes");
    const parallelFailures = await Promise.all(Array.from({ length: 8 }, () => request("/api/portal/v1/auth/login", { method: "POST", body: { employeeNumber: rateEmployee, password: "SyntheticWrongPassword!" } })));
    const failedState = db.prepare("SELECT failed_login_attempts,locked_until FROM portal_users WHERE employee_number=?").get(rateEmployee);
    const correctAfterParallel = await request("/api/portal/v1/auth/login", { method: "POST", body: { employeeNumber: rateEmployee, password: oldPassword } });
    results.observations.push({ id: "parallel_failed_login_account_lock", outcome: correctAfterParallel.status === 429 ? "observed_expected" : "observed_gap", actual: correctAfterParallel.status, expected: 429, description: "Eight synthetic parallel failures should trigger default five-failure account lock; 200 means the correct login was still admitted", failureStatuses: parallelFailures.map(reply => reply.status), persistedFailureCount: failedState.failed_login_attempts, accountLocked: Boolean(failedState.locked_until) });
    results.completed = true;
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
    try { application?.db.close(); } catch {}
    application?.releaseInstanceLockForTests();
    const resolved = path.resolve(testRoot), allowed = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(allowed) || !path.basename(resolved).startsWith("gp-security-audit-synthetic-")) throw new Error("Synthetic cleanup path escaped its temp root");
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2) + "\n");
  }
  console.log(JSON.stringify({ completed: results.completed, observations: results.observations.length, observedGaps: results.observations.filter(row => row.outcome === "observed_gap").map(row => row.id) }));
}

if (require.main === module) main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
