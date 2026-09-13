"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { performCutover } = require("../lib/persistence/postgresql/operations/cutover");
const { performLifecycle } = require("../lib/persistence/postgresql/operations/lifecycle");
const { FORMAT } = require("../lib/persistence/postgresql/lifecycle-control");

function fixture(names, failure) {
  const events = [];
  const operations = Object.fromEntries(names.map(name => [name, async input => {
    events.push(name);
    if (name === "recordFailure") events.push(input.authoritativeProvider || (input.recoveryError ? "recovery-required" : "recovered"));
    if (name === failure) throw new Error("injected " + name);
    return { verified: true };
  }]));
  return { operations, events };
}

const cutoverSteps = ["preflight", "stopApplication", "captureReturnPoint", "transferAndVerify", "promotePair",
  "installConfiguration", "createFirstPairedBackup", "publishAuthority", "startApplication", "verifyApplication", "complete",
  "restoreSqliteConfiguration", "verifySqliteReadiness", "recordFailure"];

test("Every database cutover failure before publication restores SQLite; later failures never discard new writes", async () => {
  for (const failure of cutoverSteps.slice(0, 11)) {
    const f = fixture(cutoverSteps, failure);
    await assert.rejects(performCutover(f.operations), /injected/);
    const published = cutoverSteps.indexOf(failure) >= cutoverSteps.indexOf("publishAuthority");
    assert.equal(f.events.includes("restoreSqliteConfiguration"), !published && failure !== "preflight", failure);
    assert.equal(f.events.at(-1), published ? "postgresql" : "sqlite", failure);
    if (published) assert.ok(!f.events.includes("verifySqliteReadiness"));
  }
  const f = fixture(cutoverSteps);
  assert.equal((await performCutover(f.operations)).completed, true);
  assert.deepEqual(f.events, cutoverSteps.slice(0, 11));
});

const lifecycleSteps = ["preflight", "recordAccepted", "acknowledge", "stopApplication", "createBackup", "verifyBackup",
  "releaseLease", "requestHostReboot", "startApplication", "verifyReadiness", "complete", "recordFailure"];

test("Restart, backup, shutdown and host reboot require a verified pair before their final action", async () => {
  for (const action of ["restart", "backup", "shutdown", "vps-reboot"]) {
    const f = fixture(lifecycleSteps);
    await performLifecycle({ format: FORMAT, action, requestId: randomUUID() }, f.operations);
    assert.deepEqual(f.events.slice(0, 6), lifecycleSteps.slice(0, 6));
    assert.equal(f.events.includes("startApplication"), ["restart", "backup"].includes(action));
    assert.equal(f.events.includes("requestHostReboot"), action === "vps-reboot");
    assert.equal(f.events.at(-1), "complete");
    if (action === "vps-reboot") assert.ok(f.events.indexOf("releaseLease") < f.events.indexOf("requestHostReboot"));
  }
});

test("A failed or unverified backup restores the application and cannot trigger a host reboot", async () => {
  for (const failure of ["preflight", "stopApplication", "createBackup", "verifyBackup", "requestHostReboot"]) {
    const f = fixture(lifecycleSteps, failure);
    await assert.rejects(performLifecycle({ format: FORMAT, action: "vps-reboot", requestId: randomUUID() }, f.operations));
    assert.equal(f.events.includes("startApplication"), failure !== "preflight");
    assert.equal(f.events.includes("complete"), false);
    if (failure !== "requestHostReboot") assert.equal(f.events.includes("requestHostReboot"), false);
  }
});
