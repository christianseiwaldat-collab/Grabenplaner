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

test("produktiver Start bleibt auf Loopback und blockiert externe Bindung", async () => {
  const childRoot = path.join(testRoot, "child-start");
  fs.mkdirSync(childRoot, { recursive: true, mode: 0o700 });
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(childRoot, "dienstplan.db"),
      BACKUP_DIR: path.join(childRoot, "backups"),
      GRABENPLANER_DATA_DIR: path.join(childRoot, "app-data"),
      GRABENPLANER_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let failure = null;
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    const status = await waitForJson(`http://127.0.0.1:${port}/api/portal/v1/status`, child, 30000, () => stderr);
    assert.equal(status.localOnly, true);
    assert.equal(status.portalEnabled, false);
    const exitResponse = await fetch(`http://127.0.0.1:${port}/api/system/exit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(exitResponse.status, 200);
    assert.equal((await exitResponse.json()).ok, true);
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
      failure.message += `\nAbschließender Kindprozessnachweis:\n${stderr.slice(-16384)}`;
      throw failure;
    }
  }

  const blockedPort = await getFreePort();
  const blocked = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(blockedPort),
      DB_PATH: path.join(childRoot, "blocked.db"),
      BACKUP_DIR: path.join(childRoot, "blocked-backups"),
      GRABENPLANER_HOST: "0.0.0.0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let blockedError = "";
  blocked.stderr.on("data", (chunk) => { blockedError += chunk.toString(); });
  const blockedExit = await waitForExit(blocked, 8000, () => blockedError);
  assert.notEqual(blockedExit.code, 0);
  assert.match(blockedError, /LAN-Bindung/i);
});
