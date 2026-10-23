"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Linux OFD locks belong to the inherited open file description. The helper
// exits after acquisition; Node keeps both descriptions open. Neither a helper
// crash nor a recycled PID can release another owner's lock. The kernel closes
// them on Node exit, including SIGKILL. Never unlink a lock file to reclaim it.
const owners = new WeakMap();
const helper = path.join(__dirname, "database-lock-linux.py");

function lockPathForDatabase(databasePath) {
  return databasePath === ":memory:" ? "" : `${path.resolve(databasePath)}.server-lock`;
}

function sqliteCompatibilityLockPathForDatabase(databasePath) {
  return `${path.resolve(databasePath)}.server-lock.sqlite`;
}

function legacyLockPathForDatabase(databasePath) {
  return databasePath === ":memory:" ? "" : `${path.resolve(databasePath)}.server.lock`;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function lockError(code = "DATABASE_IN_USE") {
  const error = new Error(code === "DATABASE_IN_USE"
    ? "Grabenplaner verwendet diese Datenbank bereits. Eine zweite Serverinstanz oder ein paralleles Backup wurde verhindert."
    : "Die Linux-Datenbanksperre konnte nicht sicher eingerichtet werden.");
  error.code = code;
  return error;
}

function protectedFile(file) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = fs.lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()
      || fs.realpathSync(directory) !== directory || (parent.mode & 0o022)
      || (process.getuid() !== 0 && ![0, process.getuid()].includes(parent.uid))) throw lockError("DATABASE_LOCK_PATH_UNSAFE");
  let descriptor, created = false;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    descriptor = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  }
  try {
    // A privileged maintenance process creates service-owned lock files in a
    // service-owned data directory. It never changes an existing file's owner.
    if (created && process.getuid() === 0 && parent.uid !== 0) {
      fs.fchownSync(descriptor, parent.uid, parent.gid);
    }
    const stat = fs.fstatSync(descriptor);
    const entry = fs.lstatSync(file);
    const owner = process.getuid() === 0 ? parent.uid : process.getuid();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== owner
        || (stat.mode & 0o022) || entry.isSymbolicLink()
        || entry.dev !== stat.dev || entry.ino !== stat.ino) throw lockError("DATABASE_LOCK_PATH_UNSAFE");
    return descriptor;
  } catch (error) { fs.closeSync(descriptor); throw error; }
}

function assertNoLiveLegacyLock(databasePath) {
  const file = legacyLockPathForDatabase(databasePath);
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) {
    throw lockError("DATABASE_LOCK_PATH_UNSAFE");
  }
  let record;
  try { record = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw lockError("DATABASE_LOCK_PATH_UNSAFE"); }
  if (!Number.isSafeInteger(Number(record?.pid)) || Number(record.pid) <= 0) {
    throw lockError("DATABASE_LOCK_PATH_UNSAFE");
  }
  // This check never deletes stale records. New locks use kernel ownership,
  // not the historical PID-file protocol.
  if (processIsAlive(Number(record?.pid))) throw lockError();
}

function acquireDatabaseLock({ databasePath, kind = "app", appVersion = "" }) {
  if (typeof databasePath !== "string" || !databasePath || databasePath === ":memory:") {
    throw lockError("DATABASE_LOCK_PATH_REQUIRED");
  }
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw lockError("DATABASE_LOCK_PLATFORM_UNSUPPORTED");
  }
  assertNoLiveLegacyLock(databasePath);
  const descriptors = [];
  try {
    descriptors.push(protectedFile(lockPathForDatabase(databasePath)));
    descriptors.push(protectedFile(sqliteCompatibilityLockPathForDatabase(databasePath)));
    const result = spawnSync("/usr/bin/python3", ["-I", helper], {
      encoding: "utf8", timeout: 10000, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", ...descriptors],
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    if (result.status !== 0 || result.stdout !== "GP_DATABASE_LOCK_V1\n") {
      throw lockError(result.status === 73 ? "DATABASE_IN_USE" : "DATABASE_LOCK_HELPER_UNAVAILABLE");
    }
    const handle = Object.freeze({ lockPath: lockPathForDatabase(databasePath),
      ownerToken: crypto.randomUUID(), pid: process.pid, kind, appVersion: String(appVersion) });
    owners.set(handle, descriptors);
    return handle;
  } catch (error) {
    for (const descriptor of descriptors) { try { fs.closeSync(descriptor); } catch {} }
    throw error;
  }
}

function releaseDatabaseLock(handle) {
  const descriptors = owners.get(handle);
  if (!descriptors) return false;
  owners.delete(handle);
  for (const descriptor of descriptors) fs.closeSync(descriptor);
  return true;
}

module.exports = { acquireDatabaseLock, legacyLockPathForDatabase, lockPathForDatabase,
  sqliteCompatibilityLockPathForDatabase, processIsAlive, releaseDatabaseLock };
