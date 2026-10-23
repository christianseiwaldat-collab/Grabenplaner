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
test.after(() => { closeCurrentTestFixture(); fs.rmSync(testRoot, { recursive: true, force: true }); });

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

async function waitForJson(url, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastHttpStatus = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Serverprozess wurde vorzeitig mit Code ${child.exitCode} beendet.`);
    try {
      const response = await fetch(url);
      lastHttpStatus = response.status;
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server war nach ${timeoutMs} ms nicht erreichbar; letzter HTTP-Status: ${lastHttpStatus ?? "keine Antwort"}.`);
}

async function waitForExit(child, timeoutMs = 8000) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Serverprozess wurde nach ${timeoutMs} ms nicht beendet.`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("HTTPS-Serverfundament erzwingt Proxy-Sicherheit und verhindert eine zweite Instanz", async () => {
  const childRoot = path.join(testRoot, "server-foundation");
  fs.mkdirSync(childRoot, { recursive: true });
  const childDatabase = path.join(childRoot, "dienstplan.db");
  const initPort = await getFreePort();
  const initChild = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."), windowsHide: true,
    env: { ...process.env, PORT: String(initPort), DB_PATH: childDatabase, BACKUP_DIR: path.join(childRoot, "backups"), GRABENPLANER_HOST: "127.0.0.1", GRABENPLANER_SEED_DEMO: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let initError = "";
  initChild.stderr.on("data", (chunk) => { initError += chunk.toString(); });
  try {
    await waitForJson(`http://127.0.0.1:${initPort}/api/health`, initChild);
    const exitResponse = await fetch(`http://127.0.0.1:${initPort}/api/system/exit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(exitResponse.status, 200, await exitResponse.clone().text());
    assert.equal((await waitForExit(initChild)).code, 0, initError);
  } finally {
    if (initChild.exitCode === null) { initChild.kill(); await waitForExit(initChild); }
  }

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
    const health = await waitForJson(`${url}/api/health`, child);
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
    const windowsUsbHost = process.platform === "win32";
    assert.equal(status.usbProvisioning.hostCapable, windowsUsbHost);
    assert.equal(status.usbProvisioning.available, false);
    assert.equal(status.usbProvisioning.reasonCode, windowsUsbHost ? "USB_HOST_CONSOLE_REQUIRED" : "USB_WINDOWS_REQUIRED");

    const hostSecureHeaders = { ...secureHeaders, "X-Forwarded-For": "127.0.0.1" };
    const hostStatusResponse = await fetch(`${url}/api/portal/v1/status`, { headers: hostSecureHeaders });
    assert.equal(hostStatusResponse.status, 200, await hostStatusResponse.clone().text());
    assert.equal((await hostStatusResponse.json()).usbProvisioning.available, windowsUsbHost);
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

    if (windowsUsbHost) {
      const usbStatusResponse = await fetch(`${url}/api/usb-provisioning/status`, {
        headers: {
          ...hostSecureHeaders,
          Cookie: cookie,
          "X-Grabenplaner-USB-Action": "provisioning",
        },
      });
      assert.equal(usbStatusResponse.status, 200, await usbStatusResponse.clone().text());
      const usbStatus = await usbStatusResponse.json();
      assert.ok(Array.isArray(usbStatus.creators));
      assert.ok(usbStatus.creators.some((creator) => creator.employeeNumber === "101"));

      const usbStatusWithoutActionHeader = await fetch(`${url}/api/usb-provisioning/status`, {
        headers: { ...hostSecureHeaders, Cookie: cookie },
      });
      assert.equal(usbStatusWithoutActionHeader.status, 403, await usbStatusWithoutActionHeader.clone().text());
      assert.equal((await usbStatusWithoutActionHeader.json()).code, "USB_ACTION_HEADER_REQUIRED");
      const usbStatusCrossSite = await fetch(`${url}/api/usb-provisioning/status`, {
        headers: {
          ...hostSecureHeaders,
          Cookie: cookie,
          "Sec-Fetch-Site": "cross-site",
          "X-Grabenplaner-USB-Action": "provisioning",
        },
      });
      assert.equal(usbStatusCrossSite.status, 403, await usbStatusCrossSite.clone().text());
      assert.equal((await usbStatusCrossSite.json()).code, "USB_ORIGIN_REQUIRED");

      const usbGuideResponse = await fetch(`${url}/api/usb-provisioning/first-steps.pdf`, {
        method: "POST",
        headers: {
          ...hostSecureHeaders,
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          "X-Grabenplaner-USB-Action": "provisioning",
        },
        body: JSON.stringify({ profile: "planning-vacation", primaryBrandingKitId: "neutral" }),
      });
      assert.equal(usbGuideResponse.status, 200, await usbGuideResponse.clone().text());
      assert.equal(usbGuideResponse.headers.get("content-type"), "application/pdf");
      assert.ok((await usbGuideResponse.arrayBuffer()).byteLength > 1000);

      const usbGuideWithoutActionHeader = await fetch(`${url}/api/usb-provisioning/first-steps.pdf`, {
        method: "POST",
        headers: { ...hostSecureHeaders, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
        body: JSON.stringify({ profile: "planning-vacation", primaryBrandingKitId: "neutral" }),
      });
      assert.equal(usbGuideWithoutActionHeader.status, 403, await usbGuideWithoutActionHeader.clone().text());
      assert.equal((await usbGuideWithoutActionHeader.json()).code, "USB_ACTION_HEADER_REQUIRED");

      const usbGuideWithoutCsrf = await fetch(`${url}/api/usb-provisioning/first-steps.pdf`, {
        method: "POST",
        headers: {
          ...hostSecureHeaders,
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-Grabenplaner-USB-Action": "provisioning",
        },
        body: JSON.stringify({ profile: "planning-vacation", primaryBrandingKitId: "neutral" }),
      });
      assert.equal(usbGuideWithoutCsrf.status, 403, await usbGuideWithoutCsrf.clone().text());
      assert.equal((await usbGuideWithoutCsrf.json()).code, "PORTAL_CSRF_INVALID");

      const usbGuideWithoutOrigin = await fetch(`${url}/api/usb-provisioning/first-steps.pdf`, {
        method: "POST",
        headers: {
          "X-Forwarded-Proto": "https",
          "X-Forwarded-For": "127.0.0.1",
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          "X-Grabenplaner-USB-Action": "provisioning",
        },
        body: JSON.stringify({ profile: "planning-vacation", primaryBrandingKitId: "neutral" }),
      });
      assert.equal(usbGuideWithoutOrigin.status, 403, await usbGuideWithoutOrigin.clone().text());
      assert.equal((await usbGuideWithoutOrigin.json()).code, "USB_ORIGIN_REQUIRED");

      const usbGuideCrossSite = await fetch(`${url}/api/usb-provisioning/first-steps.pdf`, {
        method: "POST",
        headers: {
          ...hostSecureHeaders,
          "Sec-Fetch-Site": "cross-site",
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          "X-Grabenplaner-USB-Action": "provisioning",
        },
        body: JSON.stringify({ profile: "planning-vacation", primaryBrandingKitId: "neutral" }),
      });
      assert.equal(usbGuideCrossSite.status, 403, await usbGuideCrossSite.clone().text());
      assert.equal((await usbGuideCrossSite.json()).code, "USB_ORIGIN_REQUIRED");

      const remoteUsbGuideResponse = await fetch(`${url}/api/usb-provisioning/first-steps.pdf`, {
        method: "POST",
        headers: {
          ...secureHeaders,
          "X-Forwarded-For": "203.0.113.44",
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          "X-Grabenplaner-USB-Action": "provisioning",
        },
        body: JSON.stringify({ profile: "planning-vacation", primaryBrandingKitId: "neutral" }),
      });
      assert.equal(remoteUsbGuideResponse.status, 403, await remoteUsbGuideResponse.clone().text());
      assert.equal((await remoteUsbGuideResponse.json()).code, "USB_HOST_CONSOLE_REQUIRED");
    } else {
      const linuxUsbResponse = await fetch(`${url}/api/usb-provisioning/status`, {
        headers: { ...hostSecureHeaders, Cookie: cookie, "X-Grabenplaner-USB-Action": "provisioning" },
      });
      assert.equal(linuxUsbResponse.status, 403, await linuxUsbResponse.clone().text());
      assert.equal((await linuxUsbResponse.json()).code, "USB_WINDOWS_REQUIRED");
    }

    const diagnosticsResponse = await fetch(`${url}/api/server-diagnostics`, { headers: { ...secureHeaders, Cookie: cookie } });
    assert.equal(diagnosticsResponse.status, 200, await diagnosticsResponse.clone().text());
    const diagnostics = await diagnosticsResponse.json();
    assert.equal(diagnostics.ready, true);
    assert.equal(diagnostics.database.journalMode, "wal");
    assert.equal(diagnostics.database.busyTimeoutMs, 5000);
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
    const secondExit = await waitForExit(second);
    assert.notEqual(secondExit.code, 0);
    assert.match(secondError, /zweite Serverinstanz|bereits in Prozess/i);

    const foreignOriginResponse = await fetch(`${url}/api/portal/v1/auth/logout`, {
      method: "POST", headers: { "X-Forwarded-Proto": "https", Origin: "https://evil.example", "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf }, body: "{}",
    });
    assert.equal(foreignOriginResponse.status, 403);

    const exitResponse = await fetch(`${url}/api/system/exit`, {
      method: "POST", headers: { ...secureHeaders, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf }, body: "{}",
    });
    assert.equal(exitResponse.status, 200, await exitResponse.clone().text());
    assert.equal((await exitResponse.json()).ok, true);
    assert.equal((await waitForExit(child)).code, 0, stderr);
    assert.equal(fs.existsSync(`${path.resolve(childDatabase)}.server.lock`), false);
    const { acquireDatabaseLock, releaseDatabaseLock } = require("../lib/database-lock");
    const afterExitLock = acquireDatabaseLock({ databasePath: childDatabase, kind: "post-shutdown-test", appVersion: "synthetic" });
    assert.equal(releaseDatabaseLock(afterExitLock), true);
    assert.equal(fs.lstatSync(`${path.resolve(childDatabase)}.server-lock`).isFile(), true);
  } finally {
    if (child.exitCode === null) { child.kill(); await waitForExit(child); }
  }
});
