"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const helper = path.join(root, "server-tools", "linux", "lib", "hold-database-lock.js");
const lockModule = path.join(root, "lib", "database-lock.js");

function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("Zeitueberschreitung beim Wartungslock-Test."));
      setTimeout(poll, 25);
    };
    poll();
  });
}

test("Linux-Wartungslock bleibt auch mit geschlossenem stdin aktiv", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-lock-helper-"));
  const database = path.join(temporary, "dienstplan.db");
  const ready = path.join(temporary, "ready");
  let stderr = "";
  const child = spawn(process.execPath, [helper, lockModule, database, ready], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await waitFor(() => fs.existsSync(ready) || child.exitCode !== null);
    assert.equal(child.exitCode, null, stderr || "Der Wartungslock wurde vorzeitig beendet.");
    assert.equal(Number(fs.readFileSync(ready, "utf8").trim()), child.pid);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(child.exitCode, null, "Geschlossenes stdin darf den Wartungslock nicht beenden.");

    const exitResult = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    const { code, signal } = await exitResult;
    if (process.platform === "win32") assert.equal(signal, "SIGTERM", stderr);
    else assert.equal(code, 0, stderr);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
