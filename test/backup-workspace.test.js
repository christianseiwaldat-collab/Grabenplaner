"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const { acquireBackupWorkspace, withBackupWorkspace } = require("../lib/backup-workspace");
const modulePath = path.resolve(__dirname, "../lib/backup-workspace.js");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-backup-workspace-"));
  const database = path.join(root, "live.db");
  fs.writeFileSync(database, "synthetic-source");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, database };
}
function attempt(database) {
  return spawnSync(process.execPath, ["-e", 'const m=require(process.argv[1]);try{m.acquireBackupWorkspace({databasePath:process.argv[2]}).release();process.stdout.write("acquired");}catch(e){process.stdout.write(e.code);process.exitCode=2;}', modulePath, database], { encoding: "utf8" });
}
test("independent processes cannot allocate the same backup workspace concurrently", t => {
  const f = fixture(t), lease = acquireBackupWorkspace({ databasePath: f.database });
  try {
    const child = attempt(f.database);
    assert.equal(child.status, 2, child.stderr);
    assert.equal(child.stdout, "BACKUP_WORKSPACE_BUSY");
    assert.throws(() => acquireBackupWorkspace({ databasePath: f.database }), { code: "BACKUP_WORKSPACE_BUSY" });
    assert.equal(attempt(f.database).status, 2);
  } finally { lease.release(); }
  assert.equal(attempt(f.database).status, 0);
  assert.equal(fs.readFileSync(f.database, "utf8"), "synthetic-source");
});
test("workspace is held until asynchronous cleanup finishes and released on errors", async t => {
  const f = fixture(t);
  await assert.rejects(withBackupWorkspace(f.database, async () => {
    assert.equal(attempt(f.database).status, 2);
    throw new Error("synthetic failure");
  }), /synthetic failure/);
  assert.equal(attempt(f.database).status, 0);
});
test("kernel releases a terminated worker's workspace without deleting or replacing its lock file", async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ["-e", 'require(process.argv[1]).acquireBackupWorkspace({databasePath:process.argv[2]});process.stdout.write("ready");process.stdin.resume();', modulePath, f.database],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const closed = once(child, "close");
  try {
    await once(child.stdout, "data");
    assert.equal(attempt(f.database).status, 2);
    child.kill("SIGKILL");
    await closed;
    assert.equal(attempt(f.database).status, 0);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
});
test("workspace rejects linked database and lock paths and invalid wait budgets", t => {
  const f = fixture(t);
  assert.throws(() => acquireBackupWorkspace({ databasePath: f.database, waitMs: -1 }), { code: "BACKUP_WORKSPACE_WAIT_INVALID" });
  const hardlink = path.join(f.root, "other.db");
  fs.linkSync(f.database, hardlink);
  assert.throws(() => acquireBackupWorkspace({ databasePath: f.database }), { code: "BACKUP_WORKSPACE_PATH_INVALID" });
  fs.unlinkSync(hardlink);
  const lock = `${f.database}.backup-workspace${process.platform === "linux" ? ".lock" : ".server-lock.sqlite"}`;
  fs.linkSync(f.database, lock);
  assert.throws(() => acquireBackupWorkspace({ databasePath: f.database }));
});

test("Linux shell and Node workers obey the identical kernel lock in both directions", { skip: process.platform !== "linux", timeout: 15000 }, async t => {
  const f = fixture(t), common = path.resolve(__dirname, "../server-tools/linux/lib/common.sh");
  const lease = acquireBackupWorkspace({ databasePath: f.database });
  try {
    const blocked = spawnSync("/bin/bash", ["-c", 'exec 5<"$1.backup-workspace.lock"; flock --exclusive --nonblock 5', "workspace-test", f.database]);
    assert.equal(blocked.status, 1);
  } finally { lease.release(); }
  const shell = spawn("/bin/bash", ["-c", 'source "$1"; gp_acquire_backup_workspace_lock "$2" "$3" "$4"; printf "ready\\n"; read -r done; gp_release_backup_workspace_lock',
    "workspace-test", common, f.database, process.execPath, modulePath], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(shell, "close");
  try {
    await once(shell.stdout, "data");
    assert.equal(attempt(f.database).status, 2);
    shell.stdin.end("done\n");
    const [code] = await closed;
    assert.equal(code, 0);
    assert.equal(attempt(f.database).status, 0);
  } finally { if (shell.exitCode === null && shell.signalCode === null) shell.kill("SIGKILL"); }
});
