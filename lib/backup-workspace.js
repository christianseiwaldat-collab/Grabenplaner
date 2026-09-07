"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { acquireDatabaseLock, releaseDatabaseLock } = require("./database-lock");
const MAX_WAIT_MS = 1400000;

function failure(code) {
  const error = new Error("Der gemeinsame Arbeitsbereich fuer Sicherung und Wiederherstellung ist nicht verfuegbar.");
  error.code = `BACKUP_WORKSPACE_${code}`;
  return error;
}
function checkedDatabase(databasePath) {
  if (typeof databasePath !== "string" || !path.isAbsolute(databasePath) || /[\x00-\x1f\x7f]/.test(databasePath)) throw failure("PATH_INVALID");
  const resolved = path.resolve(databasePath), root = path.parse(resolved).root;
  if (resolved === root) throw failure("PATH_INVALID");
  let current = root;
  const parts = path.relative(root, resolved).split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw failure("PATH_INVALID");
  }
  return { path: resolved, stat: fs.lstatSync(resolved) };
}
function prepareLockFile(databasePath, platform = process.platform) {
  const database = checkedDatabase(databasePath);
  const lockPath = `${database.path}.backup-workspace${platform === "linux" ? ".lock" : ".server-lock.sqlite"}`;
  let fd, created = false;
  try {
    try { fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      try { fd = fs.openSync(lockPath, "wx+", 0o600); created = true; }
      catch (race) {
        if (race.code !== "EEXIST") throw race;
        fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      }
    }
    if (created && process.getuid?.() === 0) fs.fchownSync(fd, database.stat.uid, database.stat.gid);
    const opened = fs.fstatSync(fd), named = fs.lstatSync(lockPath);
    if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino
      || (platform === "linux" && (opened.size !== 0 || opened.uid !== database.stat.uid || (opened.mode & 0o777) !== 0o600))) {
      throw failure("LOCK_INVALID");
    }
    return { path: lockPath, fd, stat: opened };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    throw error.code?.startsWith("BACKUP_WORKSPACE_") ? error : failure("LOCK_INVALID");
  }
}
function acquireBackupWorkspace({ databasePath, waitMs = 0 } = {}) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) throw failure("WAIT_INVALID");
  const database = checkedDatabase(databasePath);
  const file = prepareLockFile(database.path);
  let portableLock;
  try {
    if (process.platform === "linux") {
      // flock acts on the inherited open file description. The parent keeps
      // its descriptor, hence the lock remains after this tiny child exits.
      const result = spawnSync("/usr/bin/flock", ["--exclusive", ...(waitMs ? ["--timeout", String(waitMs / 1000)] : ["--nonblock"]), "3"],
        { stdio: ["ignore", "ignore", "ignore", file.fd], timeout: waitMs + 5000, windowsHide: true });
      if (result.error || result.signal || result.status !== 0) throw failure(result.status === 1 ? "BUSY" : "LOCK_FAILED");
    } else {
      // Windows workers use the same OS-released SQLite lock independently
      // of the live application database lock. No timeout breaks a live lock.
      const deadline = Date.now() + waitMs;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      for (;;) {
        try {
          portableLock = acquireDatabaseLock({ databasePath: `${database.path}.backup-workspace`, kind: "backup", appVersion: "backup-workspace-v1" });
          break;
        } catch (error) {
          if (error.code !== "DATABASE_IN_USE") throw error;
          if (Date.now() >= deadline) throw failure("BUSY");
          Atomics.wait(sleeper, 0, 0, Math.min(50, deadline - Date.now()));
        }
      }
    }
    const named = fs.lstatSync(file.path);
    if (named.isSymbolicLink() || named.dev !== file.stat.dev || named.ino !== file.stat.ino || named.nlink !== 1) throw failure("LOCK_REPLACED");
    return reference({ file, portableLock });
  } catch (error) {
    try { if (portableLock) releaseDatabaseLock(portableLock); } finally { fs.closeSync(file.fd); }
    if (error.code?.startsWith("BACKUP_WORKSPACE_")) throw error;
    throw failure(/locked|busy/i.test(String(error.message)) ? "BUSY" : "LOCK_FAILED");
  }
}
function reference(lease) {
  let released = false;
  return Object.freeze({
    release() {
      if (released) return;
      released = true;
      try { if (lease.portableLock) releaseDatabaseLock(lease.portableLock); }
      finally { fs.closeSync(lease.file.fd); }
    },
  });
}
function withBackupWorkspace(databasePath, operation, options = {}) {
  const lease = acquireBackupWorkspace({ databasePath, ...options });
  try {
    const result = operation();
    if (result && typeof result.then === "function") return Promise.resolve(result).finally(() => lease.release());
    lease.release();
    return result;
  } catch (error) { lease.release(); throw error; }
}
if (require.main === module) {
  try {
    const [action, databasePath, ...extra] = process.argv.slice(2);
    if (process.platform !== "linux" || action !== "prepare-linux-file" || extra.length) throw failure("ARGUMENTS_INVALID");
    const file = prepareLockFile(databasePath);
    fs.closeSync(file.fd);
    process.stdout.write(`${file.path}\n`);
  } catch { process.stderr.write("Der Backup-Arbeitsbereich konnte nicht vorbereitet werden.\n"); process.exitCode = 1; }
}
function prepareBackupWorkspace(databasePath) {
  const file = prepareLockFile(databasePath);
  fs.closeSync(file.fd);
}
module.exports = { acquireBackupWorkspace, withBackupWorkspace, prepareBackupWorkspace, MAX_WAIT_MS };
