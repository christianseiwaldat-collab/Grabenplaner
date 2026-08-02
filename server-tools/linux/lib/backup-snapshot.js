"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  protectedStorageReferencesFromDatabase,
} = require("../../../lib/persistence/sqlite/operations/maintenance");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function quoteSqlitePath(filePath) {
  return path.resolve(filePath).replaceAll("'", "''");
}

function main() {
  const [databasePath, targetDatabase, databaseLockModule, amuModule, amuSource, amuTarget, finalDatabaseName] = process.argv.slice(2);
  if (![databasePath, targetDatabase, databaseLockModule, amuModule, amuSource, amuTarget, finalDatabaseName].every(Boolean)) {
    throw new Error("Backup-Parameter fehlen.");
  }
  const { acquireDatabaseLock, releaseDatabaseLock } = require(path.resolve(databaseLockModule));
  const { syncEncryptedFilesBackup, verifyBackupReferences } = require(path.resolve(amuModule));
  const lock = acquireDatabaseLock({ databasePath, kind: "backup", appVersion: "linux-server-maintenance" });
  try {
    const source = new DatabaseSync(path.resolve(databasePath));
    try {
      source.exec(`VACUUM INTO '${quoteSqlitePath(targetDatabase)}'`);
    } finally {
      source.close();
    }

    const snapshot = new DatabaseSync(path.resolve(targetDatabase), { readOnly: true });
    let requiredKeys;
    try {
      const quickCheck = snapshot.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
      if (quickCheck.length !== 1 || quickCheck[0] !== "ok") throw new Error(`SQLite quick_check: ${quickCheck.join("; ")}`);
      requiredKeys = protectedStorageReferencesFromDatabase(snapshot);
    } finally {
      snapshot.close();
    }

    const databaseSha256 = sha256File(targetDatabase);
    const amu = syncEncryptedFilesBackup({
      sourceDirectory: amuSource,
      targetDirectory: amuTarget,
      manifestMetadata: { database: { fileName: finalDatabaseName, sha256: databaseSha256 } },
    });
    verifyBackupReferences({ backupDirectory: amuTarget, requiredStorageKeys: requiredKeys });
    fs.chmodSync(targetDatabase, 0o640);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      databaseSha256,
      fileCount: amu.fileCount,
      requiredStorageKeys: requiredKeys.length,
    })}\n`);
  } finally {
    releaseDatabaseLock(lock);
  }
}

try {
  main();
} catch (error) {
  console.error(error?.message || "Backup fehlgeschlagen.");
  process.exitCode = 1;
}
