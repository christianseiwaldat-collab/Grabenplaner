"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), crypto = require("node:crypto"), net = require("node:net"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
const { createAmuStorage } = require("../lib/amu-storage");
const { PERSONNEL_LIFECYCLE_INTERFACE_PERMISSION_IDS } = require("../lib/personnel-lifecycle-interfaces-contract");
const { PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS } = require("../lib/personnel-lifecycle-automation-contract");
const { PERMISSION_IDS: PERSONNEL_LIFECYCLE_EDITOR_PERMISSION_IDS } = require("../lib/personnel-lifecycle-editor-contract");
const { PERSONNEL_LEARNING_PERMISSION_IDS } = require("../lib/personnel-learning-access");
const { databaseForCurrentTest, closeCurrentTestFixture } = require("../test-support/postgresql-api/preload");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gp-portal-pg-https-"));
process.env.DB_PATH = path.join(testRoot, "server-foundation", "dienstplan.db");
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_DATA_DIR = path.join(path.dirname(process.env.DB_PATH), "app-data");
// Synthetic credential setup is independent of a parent application instance.
async function hashPortalPassword(password) {
  const salt = crypto.randomBytes(16);
  return ["scrypt-v1", salt.toString("base64url"), crypto.scryptSync(password, salt, 64).toString("base64url")].join("$");
}
test.after(async () => { await closeCurrentTestFixture(); fs.rmSync(testRoot, { recursive: true, force: true }); });

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForJson(url, child, timeoutMs = 30000, diagnostics = () => "") {
  const deadline = Date.now() + timeoutMs;
  let lastHttpStatus = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Serverprozess wurde vorzeitig mit Code ${child.exitCode} beendet. ${diagnostics().slice(-16384)}`);
    try {
      const response = await fetch(url);
      lastHttpStatus = response.status;
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server war nach ${timeoutMs} ms nicht erreichbar; letzter HTTP-Status: ${lastHttpStatus ?? "keine Antwort"}. ${diagnostics().slice(-16384)}`);
}

async function waitForExit(child, timeoutMs = 8000, diagnostics = () => "") {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Serverprozess wurde nach ${timeoutMs} ms nicht beendet. ${diagnostics().slice(-16384)}`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("HTTPS-Serverfundament erzwingt Proxy-Sicherheit und verhindert eine zweite Instanz", async () => {
  const childRoot = path.join(testRoot, "server-foundation");
  // The kernel lock requires its immediate directory to stay private even
  // when the synthetic Linux SSH user has a group-writable default umask.
  fs.mkdirSync(childRoot, { recursive: true, mode: 0o700 });
  const childDatabase = path.join(childRoot, "dienstplan.db");
  // Schema and demo rows are created by the explicitly owned PostgreSQL
  // fixture. No SQLite/local application startup is required for provisioning.
  const adminPassword = "SicheresServerPasswort!";
  const prepared = databaseForCurrentTest(childDatabase);
  prepared.prepare(`
    INSERT INTO portal_users (employee_number, password_hash, role, active, must_change_password, password_changed_at)
    VALUES ('101', ?, 'admin', 1, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', active = 1, must_change_password = 0
  `).run(await hashPortalPassword(adminPassword));
  prepared.close();

  const port = await getFreePort();
  const publicAddress = "https://plan.example.test";
  const serviceControlToken = "test-service-control-token-0123456789abcdef";
  const serverEnvironment = {
    ...process.env,
    PORT: String(port),
    DB_PATH: childDatabase,
    BACKUP_DIR: path.join(childRoot, "backups"),
    GRABENPLANER_HOST: "127.0.0.1",
    GRABENPLANER_OPERATION_MODE: "server",
    GRABENPLANER_PUBLIC_URL: publicAddress,
    GRABENPLANER_TRUST_PROXY: "loopback",
    GRABENPLANER_DATA_DIR: path.join(childRoot, "server-data"),
    GRABENPLANER_AMU_KEY_ID: "test-v1",
    GRABENPLANER_AMU_KEY: Buffer.alloc(32, 7).toString("base64"),
    NODE_ENV: "test",
    GRABENPLANER_TEST_AMU_SCANNER: "clean",
    GRABENPLANER_SERVICE_CONTROL_TOKEN: serviceControlToken,
    GRABENPLANER_MONITOR_CONFIGURED: "1",
    GRABENPLANER_MONITOR_STATUS_FILE: path.join(childRoot, "missing-monitor-status.json"),
  };
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."), windowsHide: true, env: serverEnvironment, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const url = `http://127.0.0.1:${port}`;
  try {
    const health = await waitForJson(`${url}/api/health`, child, 30000, () => stderr);
    const expectedHostBootGeneration = process.platform === "linux"
      ? health.hostBootGeneration
      : null;
    if (process.platform === "linux") {
      assert.match(expectedHostBootGeneration, /^[0-9a-f]{32}$/);
    }
    assert.deepEqual(health, {
      ok: true,
      hostBootGeneration: expectedHostBootGeneration,
    });
    const livenessResponse = await fetch(`${url}/api/health/live`);
    assert.equal(livenessResponse.status, 200);
    assert.equal(livenessResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await livenessResponse.json(), { ok: true });
    const readinessResponse = await fetch(`${url}/api/health/ready`);
    assert.equal(readinessResponse.status, 200);
    assert.deepEqual(await readinessResponse.json(), {
      ok: true,
      hostBootGeneration: expectedHostBootGeneration,
    });

    const insecureStatus = await fetch(`${url}/api/portal/v1/status`);
    assert.equal(insecureStatus.status, 426);

    const secureHeaders = { "X-Forwarded-Proto": "https", Origin: publicAddress };
    const statusResponse = await fetch(`${url}/api/portal/v1/status`, { headers: secureHeaders });
    assert.equal(statusResponse.status, 200, await statusResponse.clone().text());
    assert.equal(statusResponse.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
    assert.equal(statusResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal(statusResponse.headers.get("x-frame-options"), "DENY");
    assert.equal(statusResponse.headers.get("referrer-policy"), "no-referrer");
    assert.equal(statusResponse.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
    assert.equal(statusResponse.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(statusResponse.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(statusResponse.headers.get("x-permitted-cross-domain-policies"), "none");
    const contentSecurityPolicy = statusResponse.headers.get("content-security-policy") || "";
    for (const directive of ["object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"]) {
      assert.match(contentSecurityPolicy, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(statusResponse.headers.get("x-request-id") || "", /^[a-f0-9-]{36}$/i);
    assert.equal(statusResponse.headers.get("cache-control"), "no-store");
    const status = await statusResponse.json();
    assert.equal(status.operationMode, "server");
    assert.equal(status.httpsRequired, true);
    assert.equal(status.publicUrl, publicAddress);
    assert.equal(status.passwordMinLength, 15);
    assert.equal(status.usbProvisioning.available, false);
    assert.equal(status.usbProvisioning.reasonCode, "POSTGRESQL_SERVER_ONLY");

    const hostSecureHeaders = { ...secureHeaders, "X-Forwarded-For": "127.0.0.1" };
    const hostStatusResponse = await fetch(`${url}/api/portal/v1/status`, { headers: hostSecureHeaders });
    assert.equal(hostStatusResponse.status, 200, await hostStatusResponse.clone().text());
    assert.equal((await hostStatusResponse.json()).usbProvisioning.available, false);
    const remoteStatusResponse = await fetch(`${url}/api/portal/v1/status`, {
      headers: { ...secureHeaders, "X-Forwarded-For": "203.0.113.44" },
    });
    assert.equal(remoteStatusResponse.status, 200, await remoteStatusResponse.clone().text());
    assert.equal((await remoteStatusResponse.json()).usbProvisioning.available, false);

    const loginResponse = await fetch(`${url}/api/portal/v1/auth/login`, {
      method: "POST",
      headers: { ...secureHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "101", password: adminPassword }),
    });
    assert.equal(loginResponse.status, 200, await loginResponse.clone().text());
    const setCookies = typeof loginResponse.headers.getSetCookie === "function" ? loginResponse.headers.getSetCookie() : [loginResponse.headers.get("set-cookie")].filter(Boolean);
    assert.ok(setCookies.every((cookie) => /; Secure/i.test(cookie)));
    const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
    const csrfCookie = setCookies.map((value) => value.split(";", 1)[0]).find((value) => value.startsWith("grabenplaner_csrf="));
    const csrf = decodeURIComponent(csrfCookie.split("=").slice(1).join("="));

    // Retired USB endpoints remain unavailable even to an authenticated admin
    // at the host console, with or without former action/origin headers.
    for (const headers of [
      { ...hostSecureHeaders, Cookie: cookie, "X-Grabenplaner-USB-Action": "provisioning" },
      { ...hostSecureHeaders, Cookie: cookie },
      { ...hostSecureHeaders, Cookie: cookie, "Sec-Fetch-Site": "cross-site", "X-Grabenplaner-USB-Action": "provisioning" },
    ]) {
      const retired = await fetch(`${url}/api/usb-provisioning/status`, { headers });
      assert.equal(retired.status, 403, await retired.clone().text());
      assert.equal((await retired.json()).code, "POSTGRESQL_SERVER_ONLY");
    }
    const retiredGuide = await fetch(`${url}/api/usb-provisioning/first-steps.pdf`, {
      method: "POST", headers: { ...hostSecureHeaders, "Content-Type": "application/json", Cookie: cookie,
        "X-CSRF-Token": csrf, "X-Grabenplaner-USB-Action": "provisioning" },
      body: JSON.stringify({ profile: "planning-vacation", primaryBrandingKitId: "neutral" }),
    });
    assert.equal(retiredGuide.status, 403, await retiredGuide.clone().text());
    assert.equal((await retiredGuide.json()).code, "POSTGRESQL_SERVER_ONLY");

    const diagnosticsResponse = await fetch(`${url}/api/server-diagnostics`, { headers: { ...secureHeaders, Cookie: cookie } });
    assert.equal(diagnosticsResponse.status, 200, await diagnosticsResponse.clone().text());
    const diagnostics = await diagnosticsResponse.json();
    assert.equal(diagnostics.ready, true);
    assert.equal(diagnostics.database.providerId, "postgresql");
    assert.equal(diagnostics.database.journalMode, null);
    assert.equal(diagnostics.database.synchronous, null);
    assert.equal(diagnostics.database.busyTimeoutMs, 0);
    assert.equal(diagnostics.database.integrity, "ok");
    assert.equal(diagnostics.database.foreignKeys, true);
    assert.ok(Number.isSafeInteger(diagnostics.database.bytes) && diagnostics.database.bytes > 0);
    assert.equal(diagnostics.instanceLock.held, true);
    const monitorCheck = diagnostics.productionChecks.find((check) => check.id === "monitor");
    const backupCheck = diagnostics.productionChecks.find((check) => check.id === "backup");
    const blockingChecks = diagnostics.productionChecks
      .filter((check) => !["backup", "monitor"].includes(check.id));
    assert.ok(blockingChecks.every((check) => check.ok), JSON.stringify(blockingChecks));
    assert.equal(backupCheck?.ok, false);
    assert.equal(monitorCheck?.ok, false);
    assert.equal(diagnostics.monitor.configured, true);
    assert.equal(diagnostics.monitor.blocksMainReadiness, false);
    assert.equal(diagnostics.monitor.lastErrorCode, "MONITOR_STATUS_FILE_MISSING");
    assert.ok(diagnostics.alerts.some((alert) => alert.id === "SERVER_MONITOR_ATTENTION"));
    assert.equal(diagnostics.backups.retentionCount, 20);
    assert.equal(diagnostics.backups.retentionUnit, 'calendar-days');
    assert.equal(typeof diagnostics.backups.offsite?.configured, "boolean");
    assert.equal("statusPath" in diagnostics.backups.offsite, false);
    assert.equal("repository" in diagnostics.backups.offsite, false);
    const adminSystemInfo = await fetch(`${url}/api/system-info`, { headers: { ...secureHeaders, Cookie: cookie } });
    assert.equal(adminSystemInfo.status, 200, await adminSystemInfo.clone().text());
    assert.equal(typeof (await adminSystemInfo.json()).serverDiagnostics?.backups?.offsite?.configured, "boolean");
    for (const endpoint of ["/api/health", "/api/health/ready"]) {
      const healthResponse = await fetch(`${url}${endpoint}`, { headers: secureHeaders });
      assert.equal(healthResponse.status, 200, await healthResponse.clone().text());
      assert.deepEqual(await healthResponse.json(), {
        ok: true,
        hostBootGeneration: expectedHostBootGeneration,
      });
    }

    const shortPasswordResponse = await fetch(`${url}/api/portal/v1/users/102`, {
      method: "PUT", headers: { ...secureHeaders, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
      body: JSON.stringify({ role: "employee", active: true, password: "123456" }),
    });
    assert.equal(shortPasswordResponse.status, 400);
    const employeePassword = "MitarbeiterPasswort!";
    const employeeAccessResponse = await fetch(`${url}/api/portal/v1/users/102`, {
      method: "PUT", headers: { ...secureHeaders, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
      body: JSON.stringify({ role: "employee", active: true, password: employeePassword, mustChangePassword: false }),
    });
    assert.equal(employeeAccessResponse.status, 200, await employeeAccessResponse.clone().text());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failedLogin = await fetch(`${url}/api/portal/v1/auth/login`, {
        method: "POST", headers: { ...secureHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ employeeNumber: "102", password: "falsch-falsch" }),
      });
      assert.equal(failedLogin.status, 401);
    }
    const lockedLogin = await fetch(`${url}/api/portal/v1/auth/login`, {
      method: "POST", headers: { ...secureHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "102", password: employeePassword }),
    });
    assert.equal(lockedLogin.status, 429);
    const unlockResponse = await fetch(`${url}/api/portal/v1/users/102/unlock`, {
      method: "POST", headers: { ...secureHeaders, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf }, body: "{}",
    });
    assert.equal(unlockResponse.status, 200, await unlockResponse.clone().text());
    const unlockedLogin = await fetch(`${url}/api/portal/v1/auth/login`, {
      method: "POST", headers: { ...secureHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "102", password: employeePassword }),
    });
    assert.equal(unlockedLogin.status, 200, await unlockedLogin.clone().text());
    const employeeCookies = typeof unlockedLogin.headers.getSetCookie === "function" ? unlockedLogin.headers.getSetCookie() : [unlockedLogin.headers.get("set-cookie")].filter(Boolean);
    let employeeCookie = employeeCookies.map((value) => value.split(";", 1)[0]).join("; ");
    const employeeCsrfCookie = employeeCookies.map((value) => value.split(";", 1)[0]).find((value) => value.startsWith("grabenplaner_csrf="));
    let employeeCsrf = decodeURIComponent(employeeCsrfCookie.split("=").slice(1).join("="));
    const deniedEmployeeUsbStatus = await fetch(`${url}/api/usb-provisioning/status`, {
      headers: { ...hostSecureHeaders, Cookie: employeeCookie },
    });
    assert.equal(deniedEmployeeUsbStatus.status, 403, await deniedEmployeeUsbStatus.clone().text());
    assert.equal((await deniedEmployeeUsbStatus.json()).code, "PORTAL_PERMISSION_DENIED");
    const employeePasswordChange = await fetch(`${url}/api/portal/v1/me/password`, {
      method: "PUT", headers: { ...secureHeaders, "Content-Type": "application/json", Cookie: employeeCookie, "X-CSRF-Token": employeeCsrf },
      body: JSON.stringify({ currentPassword: employeePassword, newPassword: "MitarbeiterPasswortNeu!" }),
    });
    assert.equal(employeePasswordChange.status, 200, await employeePasswordChange.clone().text());
    const rotatedEmployeeCookies = employeePasswordChange.headers.getSetCookie();
    employeeCookie = rotatedEmployeeCookies.map(value => value.split(";", 1)[0]).join("; ");
    employeeCsrf = decodeURIComponent(rotatedEmployeeCookies.map(value => value.split(";", 1)[0])
      .find(value => value.startsWith("grabenplaner_csrf=")).split("=").slice(1).join("="));
    const deniedEmployeeExit = await fetch(`${url}/api/system/exit`, {
      method: "POST", headers: { ...secureHeaders, "Content-Type": "application/json", Cookie: employeeCookie, "X-CSRF-Token": employeeCsrf }, body: "{}",
    });
    assert.equal(deniedEmployeeExit.status, 403, await deniedEmployeeExit.clone().text());
    const employeeLogout = await fetch(`${url}/api/portal/v1/auth/logout`, {
      method: "POST", headers: { ...secureHeaders, Cookie: employeeCookie, "X-CSRF-Token": employeeCsrf },
    });
    assert.equal(employeeLogout.status, 200, await employeeLogout.clone().text());
    assert.equal(employeeLogout.headers.get("clear-site-data"), '"cache", "cookies", "storage"');

    const secondPort = await getFreePort();
    const second = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      cwd: path.join(__dirname, ".."), windowsHide: true, env: { ...serverEnvironment, PORT: String(secondPort) }, stdio: ["ignore", "pipe", "pipe"],
    });
    let secondError = "";
    second.stderr.on("data", (chunk) => { secondError += chunk.toString(); });
    const secondExit = await waitForExit(second, 8000, () => secondError);
    assert.notEqual(secondExit.code, 0);
    assert.match(secondError, /zweite Serverinstanz|bereits in Prozess/i);

    const foreignOriginResponse = await fetch(`${url}/api/portal/v1/auth/logout`, {
      method: "POST", headers: { "X-Forwarded-Proto": "https", Origin: "https://evil.example", "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf }, body: "{}",
    });
    assert.equal(foreignOriginResponse.status, 403);

    const exitResponse = await fetch(`${url}/api/system/exit`, {
      method: "POST", headers: { ...secureHeaders, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf }, body: "{}",
    });
    assert.equal(exitResponse.status, 503, await exitResponse.clone().text());
    const refusedMaintenance = await exitResponse.json();
    assert.equal(refusedMaintenance.code, "INTERNAL_ERROR");
    assert.match(refusedMaintenance.requestId, /^[a-f0-9-]{36}$/i);
    const failureAudit = prepared.prepare("SELECT detail FROM audit_log WHERE actor = ? AND action = ? AND entity_id = ? ORDER BY id DESC LIMIT 1")
      .get("101", "system.postgresql.maintenance.failed", "shutdown");
    assert.equal(JSON.parse(failureAudit.detail).code, "PG_LIFECYCLE_CONTROL_UNAVAILABLE");
    // This fixture has no privileged native maintenance socket. A refused
    // maintenance request must keep the existing service and pair available.
    assert.equal(child.exitCode, null);
    assert.equal((await fetch(`${url}/api/health/live`)).status, 200);
    child.kill("SIGTERM");
    assert.equal((await waitForExit(child, 8000, () => stderr)).code, 0, stderr);
    assert.equal(fs.existsSync(`${path.resolve(childDatabase)}.server.lock`), false);
    const { acquireDatabaseLock, releaseDatabaseLock } = require("../lib/database-lock");
    const afterExitLock = acquireDatabaseLock({ databasePath: childDatabase, kind: "post-shutdown-test", appVersion: "synthetic" });
    assert.equal(releaseDatabaseLock(afterExitLock), true);
    assert.equal(fs.lstatSync(`${path.resolve(childDatabase)}.server-lock`).isFile(), true);
  } finally {
    if (child.exitCode === null) { child.kill(); await waitForExit(child, 8000, () => stderr); }
  }
});
