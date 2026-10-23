"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function lockPathForDatabase(databasePath) {
  return databasePath === ":memory:" ? "" : `${path.resolve(databasePath)}.server-lock.sqlite`;
}

function legacyLockPathForDatabase(databasePath) {
  return databasePath === ":memory:" ? "" : `${path.resolve(databasePath)}.server.lock`;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function lockError(record = null) {
  const owner = record?.kind === "backup" ? "Ein Backup" : "Grabenplaner";
  const detail = record?.pid ? ` in Prozess ${record.pid}` : "";
  const error = new Error(`${owner} verwendet diese Datenbank bereits${detail}. Eine zweite Serverinstanz oder ein paralleles Backup wurde verhindert.`);
  error.code = "DATABASE_IN_USE";
  return error;
}

function assertNoLiveLegacyLock(databasePath) {
  const legacyPath = legacyLockPathForDatabase(databasePath);
  if (!legacyPath || !fs.existsSync(legacyPath)) return;
  let record = null;
  try { record = JSON.parse(fs.readFileSync(legacyPath, "utf8")); } catch {}
  if (processIsAlive(Number(record?.pid))) throw lockError({ ...record, kind: "app" });
}

function isBusyError(error) {
  return String(error?.code || "").startsWith("SQLITE_BUSY")
    || /database is locked|database table is locked/i.test(String(error?.message || ""));
}

function acquireDatabaseLock({ databasePath, kind = "app", appVersion = "" }) {
  const lockPath = lockPathForDatabase(databasePath);
  if (!lockPath) return null;
  assertNoLiveLegacyLock(databasePath);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  let lockDatabase;
  try {
    lockDatabase = new DatabaseSync(lockPath);
    lockDatabase.exec("PRAGMA busy_timeout = 0");
    lockDatabase.exec("BEGIN EXCLUSIVE");
    lockDatabase.exec(`
      CREATE TABLE IF NOT EXISTS active_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner_token TEXT NOT NULL,
        pid INTEGER NOT NULL,
        kind TEXT NOT NULL,
        started_at TEXT NOT NULL,
        app_version TEXT NOT NULL,
        database_path TEXT NOT NULL
      )
    `);
    const ownerToken = crypto.randomUUID();
    lockDatabase.prepare(`
      INSERT INTO active_lock (id, owner_token, pid, kind, started_at, app_version, database_path)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner_token = excluded.owner_token,
        pid = excluded.pid,
        kind = excluded.kind,
        started_at = excluded.started_at,
        app_version = excluded.app_version,
        database_path = excluded.database_path
    `).run(
      ownerToken,
      process.pid,
      kind === "backup" ? "backup" : "app",
      new Date().toISOString(),
      String(appVersion || ""),
      path.resolve(databasePath),
    );
    try { fs.chmodSync(lockPath, 0o600); } catch {}
    return { lockPath, ownerToken, pid: process.pid, kind, lockDatabase };
  } catch (error) {
    try { lockDatabase?.close(); } catch {}
    if (isBusyError(error)) throw lockError();
    throw error;
  }
}

function releaseDatabaseLock(handle) {
  if (!handle?.lockDatabase || !handle.ownerToken) return false;
  let current;
  try { current = handle.lockDatabase.prepare("SELECT owner_token FROM active_lock WHERE id = 1").get(); }
  catch { return false; }
  if (current?.owner_token !== handle.ownerToken) return false;
  let released = false;
  try {
    handle.lockDatabase.prepare("DELETE FROM active_lock WHERE id = 1").run();
    handle.lockDatabase.exec("COMMIT");
    released = true;
    return true;
  } finally {
    if (!released) {
      try { handle.lockDatabase.exec("ROLLBACK"); } catch {}
    }
    try { handle.lockDatabase.close(); } catch {}
  }
}

module.exports = {
  acquireDatabaseLock,
  legacyLockPathForDatabase,
  lockPathForDatabase,
  processIsAlive,
  releaseDatabaseLock,
};
