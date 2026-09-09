"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("Linux OS lease is visible to the service user and expires when its owner exits", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0 ? "isolated Linux root fixture" : false,
}, t => {
  // /run is root-owned and not world-writable. Never touch the real GP paths.
  const root = fs.mkdtempSync("/run/gp-backup-maintenance-test-"); fs.chmodSync(root, 0o755);
  const database = path.join(root, "synthetic.db"), lease = path.join(root, "owner.json"), maintenance = path.join(root, "maintenance.lock");
  const moduleFile = path.join(root, "backup-maintenance.js");
  fs.copyFileSync(path.join(__dirname, "../lib/backup-maintenance.js"), moduleFile); fs.chmodSync(moduleFile, 0o644);
  fs.writeFileSync(database, "synthetic fixture", { mode: 0o600 });
  fs.writeFileSync(maintenance, "", { mode: 0o600 });
  let ownerFd, maintenanceFd = fs.openSync(maintenance, "r+");
  t.after(() => {
    if (ownerFd !== undefined) fs.closeSync(ownerFd);
    if (maintenanceFd !== undefined) fs.closeSync(maintenanceFd);
    assert.equal(path.dirname(fs.realpathSync(root)), "/run");
    assert.match(path.basename(root), /^gp-backup-maintenance-test-/);
    fs.rmSync(root, { recursive: true });
  });
  function child(source, { asUser = false, passOwner = true } = {}) {
    const args = ["-e", source, moduleFile, database, lease, maintenance];
    const stdio = Array(10).fill("ignore"); stdio[1] = "pipe"; stdio[2] = "pipe";
    if (!asUser) { stdio[9] = maintenanceFd; if (passOwner && ownerFd !== undefined) stdio[8] = ownerFd; }
    const result = spawnSync(asUser ? "/usr/sbin/runuser" : process.execPath,
      asUser ? ["--user", "nobody", "--", process.execPath, ...args] : args,
      { stdio, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  const prelude = "const [file, databasePath, leasePath, maintenancePath] = process.argv.slice(1); const api = require(file);";
  const locked = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", maintenanceFd] });
  assert.equal(locked.status, 0);
  child(prelude + "api.prepareOwnerFile({ leasePath, maintenancePath });");
  ownerFd = fs.openSync(lease, "r+");
  const ownerLocked = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", ownerFd] });
  assert.equal(ownerLocked.status, 0);
  child(prelude + "api.publishOwner(databasePath, { leasePath, maintenancePath });");
  const read = prelude + "console.log(api.ownsLifecycleBackup(databasePath, { leasePath }));";
  assert.equal(child(read, { asUser: true }), "true");
  assert.equal(child(prelude + "console.log(api.ownsLifecycleBackup(databasePath + '-other', { leasePath }));", { asUser: true }), "false");
  fs.closeSync(ownerFd); ownerFd = undefined;
  assert.equal(child(read, { asUser: true }), "false", "stale receipt must not suppress a backup after owner exit");
  fs.chmodSync(lease, 0o666);
  assert.equal(child(read, { asUser: true }), "false");
});
