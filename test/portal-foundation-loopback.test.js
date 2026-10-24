"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), crypto = require("node:crypto"), net = require("node:net"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
const { databaseForCurrentTest, closeCurrentTestFixture } = require("../test-support/postgresql-api/preload");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gp-portal-pg-loopback-"));
process.env.DB_PATH = path.join(testRoot, "child-start", "dienstplan.db");
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

test("PostgreSQL-Server bleibt auf Loopback und beendet sich kontrolliert auf SIGTERM", async () => {
  const childRoot = path.join(testRoot, "child-start");
  fs.mkdirSync(childRoot, { recursive: true, mode: 0o700 });
  const childDatabase = path.join(childRoot, "dienstplan.db");
  const prepared = databaseForCurrentTest(childDatabase);
  prepared.prepare(`
    INSERT INTO portal_users (employee_number, password_hash, role, active, must_change_password, password_changed_at)
    VALUES ('101', ?, 'admin', 1, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', active = 1, must_change_password = 0
  `).run(await hashPortalPassword("SicheresServerPasswort!"));
  prepared.close();
  const port = await getFreePort();
  const publicAddress = "https://loopback.example.test";
  const serverEnvironment = {
    ...process.env,
    PORT: String(port),
    DB_PATH: childDatabase,
    BACKUP_DIR: path.join(childRoot, "backups"),
    GRABENPLANER_DATA_DIR: path.join(childRoot, "server-data"),
    GRABENPLANER_HOST: "127.0.0.1",
    GRABENPLANER_OPERATION_MODE: "server",
    GRABENPLANER_PUBLIC_URL: publicAddress,
    GRABENPLANER_TRUST_PROXY: "loopback",
    GRABENPLANER_AMU_KEY_ID: "synthetic-loopback-v1",
    GRABENPLANER_AMU_KEY: Buffer.alloc(32, 7).toString("base64"),
    GRABENPLANER_INTEGRATION_KEY_ID: "synthetic-loopback-integration-v1",
    GRABENPLANER_INTEGRATION_KEY: Buffer.alloc(32, 11).toString("base64"),
    GRABENPLANER_SERVICE_CONTROL_TOKEN: "synthetic-service-control-0123456789abcdef",
    GRABENPLANER_TEST_AMU_SCANNER: "clean",
    NODE_ENV: "test",
  };
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    windowsHide: true,
    env: serverEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let failure = null;
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${port}`;
    assert.equal((await waitForJson(`${url}/api/health/ready`, child, 30000, () => stderr)).ok, true);
    const insecure = await fetch(`${url}/api/portal/v1/status`);
    assert.equal(insecure.status, 426);
    await insecure.text();
    const secure = await fetch(`${url}/api/portal/v1/status`, { headers: { "X-Forwarded-Proto": "https", Origin: publicAddress } });
    assert.equal(secure.status, 200);
    assert.equal(secure.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
    assert.equal(secure.headers.get("x-content-type-options"), "nosniff");
    assert.equal(secure.headers.get("cache-control"), "no-store");
    const status = await secure.json();
    assert.equal(status.localOnly, true);
    assert.equal(status.listenHost, "127.0.0.1");
    assert.equal(status.operationMode, "server");
    assert.equal(status.portalEnabled, true);
    assert.equal(status.httpsRequired, true);
    assert.equal(status.adminSetupState, "configured");
    // The current managed server stops through its service supervisor. The
    // retired unauthenticated local /system/exit contract remains on b2.
    assert.equal(child.kill("SIGTERM"), true);
    const exit = await waitForExit(child, 8000, () => stderr);
    assert.equal(exit.code, 0, stderr);
    assert.match(stdout, new RegExp(`http://localhost:${port}`));
  } catch (error) {
    failure = error;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      try { await waitForExit(child, 8000, () => stderr); }
      catch (error) {
        failure ||= error;
        // A failed graceful-stop assertion remains failed. Reap only this
        // owned synthetic child before its parent's fixture can be truncated.
        child.kill("SIGKILL");
        await waitForExit(child, 8000, () => stderr);
      }
    }
    if (failure) {
      throw new Error(`Abschließender Kindprozessnachweis:\n${stderr.slice(-16384)}`, { cause: failure });
    }
  }

  const blockedPort = await getFreePort();
  const blocked = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    windowsHide: true,
    env: {
      ...serverEnvironment,
      PORT: String(blockedPort),
      GRABENPLANER_HOST: "0.0.0.0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let blockedError = "";
  blocked.stderr.on("data", (chunk) => { blockedError += chunk.toString(); });
  let blockedFailure = null;
  try {
    const blockedExit = await waitForExit(blocked, 8000, () => blockedError);
    assert.notEqual(blockedExit.code, 0);
    assert.match(blockedError, /GRABENPLANER_HOST muss im Serverbetrieb/i);
  } catch (error) { blockedFailure = error; }
  finally {
    if (blocked.exitCode === null && blocked.signalCode === null) {
      blocked.kill("SIGTERM");
      try { await waitForExit(blocked, 8000, () => blockedError); }
      catch (error) {
        blockedFailure ||= error;
        blocked.kill("SIGKILL");
        await waitForExit(blocked, 8000, () => blockedError);
      }
    }
    if (blockedFailure) throw new Error(`Abschließender Bindungsnachweis:\n${blockedError.slice(-16384)}`, { cause: blockedFailure });
  }
});
