"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sqliteQuickCheck(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const result = database.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
    if (result.length !== 1 || result[0] !== "ok") throw new Error(`SQLite quick_check: ${result.join("; ")}`);
  } finally {
    database.close();
  }
}

function main() {
  const [backupDatabase, backupAmu, targetDatabase, targetAmu, databaseLockModule, amuModule] = process.argv.slice(2);
  if (![backupDatabase, backupAmu, targetDatabase, targetAmu, databaseLockModule, amuModule].every(Boolean)) {
    throw new Error("Rollback-Parameter fehlen.");
  }
  const { acquireDatabaseLock, releaseDatabaseLock } = require(path.resolve(databaseLockModule));
  const { readAndVerifyBackup, restoreEncryptedFilesBackup } = require(path.resolve(amuModule));
  const sourceDatabase = path.resolve(backupDatabase);
  const destinationDatabase = path.resolve(targetDatabase);
  const sourceAmu = path.resolve(backupAmu);
  const destinationAmu = path.resolve(targetAmu);
  const manifest = readAndVerifyBackup(sourceAmu).manifest;
  const backupSha256 = sha256File(sourceDatabase);
  if (manifest?.database?.fileName !== path.basename(sourceDatabase)
    || String(manifest?.database?.sha256 || "").toLowerCase() !== backupSha256) {
    throw new Error("Rollback-Datenbank und Dokumentbackup sind nicht gekoppelt.");
  }
  sqliteQuickCheck(sourceDatabase);

  fs.mkdirSync(path.dirname(destinationDatabase), { recursive: true });
  const suffix = crypto.randomUUID();
  const preparedDatabase = path.join(path.dirname(destinationDatabase), `.rollback-${suffix}.db`);
  const previousDatabase = path.join(path.dirname(destinationDatabase), `.failed-update-${suffix}.db`);
  fs.copyFileSync(sourceDatabase, preparedDatabase, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(preparedDatabase, 0o640);
  sqliteQuickCheck(preparedDatabase);

  const lock = acquireDatabaseLock({ databasePath: destinationDatabase, kind: "backup", appVersion: "linux-update-rollback" });
  let previousMoved = false;
  try {
    for (const suffixName of ["-wal", "-shm"]) fs.rmSync(`${destinationDatabase}${suffixName}`, { force: true });
    if (fs.existsSync(destinationDatabase)) {
      fs.renameSync(destinationDatabase, previousDatabase);
      previousMoved = true;
    }
    try {
      fs.renameSync(preparedDatabase, destinationDatabase);
    } catch (error) {
      if (previousMoved && !fs.existsSync(destinationDatabase)) fs.renameSync(previousDatabase, destinationDatabase);
      throw error;
    }
    try {
      restoreEncryptedFilesBackup({ backupDirectory: sourceAmu, targetDirectory: destinationAmu });
    } catch (error) {
      fs.rmSync(destinationDatabase, { force: true });
      if (previousMoved) fs.renameSync(previousDatabase, destinationDatabase);
      throw error;
    }
    if (previousMoved) {
      try { fs.rmSync(previousDatabase, { force: true }); } catch {}
    }
    process.stdout.write(`${JSON.stringify({ ok: true, databaseSha256: backupSha256 })}\n`);
  } finally {
    releaseDatabaseLock(lock);
    fs.rmSync(preparedDatabase, { force: true });
    if (fs.existsSync(previousDatabase) && fs.existsSync(destinationDatabase)) fs.rmSync(previousDatabase, { force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error?.message || "Automatischer Rollback fehlgeschlagen.");
  process.exitCode = 1;
}
