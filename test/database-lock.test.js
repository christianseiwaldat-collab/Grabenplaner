"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const {
  acquireDatabaseLock,
  legacyLockPathForDatabase,
  lockPathForDatabase,
  releaseDatabaseLock,
} = require("../lib/database-lock");

const roots = [];

function testDatabase(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `grabenplaner-lock-${label}-`));
  roots.push(root);
  return path.join(root, "dienstplan.db");
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test("Datenbanksperre verhindert einen zweiten laufenden Besitzer", () => {
  const databasePath = testDatabase("live");
  const first = acquireDatabaseLock({ databasePath, kind: "app", appVersion: "test" });
  assert.throws(
    () => acquireDatabaseLock({ databasePath, kind: "backup", appVersion: "test" }),
    { code: "DATABASE_IN_USE" },
  );
  assert.equal(fs.existsSync(lockPathForDatabase(databasePath)), true);
  assert.equal(releaseDatabaseLock(first), true);
  const next = acquireDatabaseLock({ databasePath, kind: "backup", appVersion: "test" });
  assert.equal(releaseDatabaseLock(next), true);
});

test("der separate Backup-Befehl respektiert die laufende App-Sperre", () => {
  const databasePath = testDatabase("backup-command");
  new DatabaseSync(databasePath).close();
  const appLock = acquireDatabaseLock({ databasePath, kind: "app", appVersion: "test" });
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "backup.js")], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, DB_PATH: databasePath, GRABENPLANER_DATA_ROOT: path.dirname(databasePath) },
      timeout: 15_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /verwendet diese Datenbank bereits/i);
  } finally {
    releaseDatabaseLock(appLock);
  }
});

test("nur der tatsächliche Besitzer darf die Sperre lösen", () => {
  const databasePath = testDatabase("owner");
  const handle = acquireDatabaseLock({ databasePath, kind: "backup", appVersion: "test" });
  assert.equal(releaseDatabaseLock({ ...handle, ownerToken: "wrong-owner" }), false);
  assert.throws(() => acquireDatabaseLock({ databasePath, kind: "app", appVersion: "test" }), { code: "DATABASE_IN_USE" });
  assert.equal(releaseDatabaseLock(handle), true);
});

test("ein Prozessabbruch gibt die SQLite-Sperre ohne Lockdatei-Löschung frei", () => {
  const databasePath = testDatabase("crash-recovery");
  const modulePath = path.join(__dirname, "..", "lib", "database-lock.js");
  const script = `
    const { acquireDatabaseLock } = require(${JSON.stringify(modulePath)});
    acquireDatabaseLock({ databasePath: ${JSON.stringify(databasePath)}, kind: "app", appVersion: "test" });
    process.stdout.write("locked");
  `;
  const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(child.stdout, "locked");
  const recovered = acquireDatabaseLock({ databasePath, kind: "backup", appVersion: "test" });
  assert.equal(releaseDatabaseLock(recovered), true);
});

test("eine aktive Sperre aus v0.57 bleibt beim Update geschützt", () => {
  const databasePath = testDatabase("legacy-live");
  const legacyPath = legacyLockPathForDatabase(databasePath);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify({ pid: process.pid, kind: "app" }));
  assert.throws(() => acquireDatabaseLock({ databasePath, kind: "app", appVersion: "test" }), { code: "DATABASE_IN_USE" });
});

test("eine veraltete v0.57-Sperrdatei wird ignoriert, aber nicht unsicher gelöscht", () => {
  const databasePath = testDatabase("legacy-stale");
  const legacyPath = legacyLockPathForDatabase(databasePath);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  const legacy = JSON.stringify({ pid: 2147483647, kind: "app" });
  fs.writeFileSync(legacyPath, legacy);
  const handle = acquireDatabaseLock({ databasePath, kind: "app", appVersion: "test" });
  assert.equal(releaseDatabaseLock(handle), true);
  assert.equal(fs.readFileSync(legacyPath, "utf8"), legacy);
});
