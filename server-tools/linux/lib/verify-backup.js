"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function main() {
  const [databasePath, amuBackupDirectory, amuModule] = process.argv.slice(2);
  if (![databasePath, amuBackupDirectory, amuModule].every(Boolean)) throw new Error("Pruefparameter fehlen.");
  const { verifyBackupReferences } = require(path.resolve(amuModule));
  const database = new DatabaseSync(path.resolve(databasePath), { readOnly: true });
  const requiredStorageKeys = [];
  try {
    const quickCheck = database.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
    if (quickCheck.length !== 1 || quickCheck[0] !== "ok") throw new Error(`SQLite quick_check: ${quickCheck.join("; ")}`);
    const hasTable = (name) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    if (hasTable("amu_documents")) {
      requiredStorageKeys.push(...database.prepare("SELECT storage_key FROM amu_documents WHERE status = 'active'").all().map((row) => row.storage_key));
    }
    if (hasTable("personnel_record_documents")) {
      requiredStorageKeys.push(...database.prepare("SELECT storage_key FROM personnel_record_documents WHERE status = 'active'").all().map((row) => row.storage_key));
    }
  } finally {
    database.close();
  }
  const verified = verifyBackupReferences({ backupDirectory: amuBackupDirectory, requiredStorageKeys });
  const expectedFileName = path.basename(databasePath);
  const actualSha256 = sha256File(databasePath);
  if (verified.manifest?.database?.fileName !== expectedFileName
    || String(verified.manifest?.database?.sha256 || "").toLowerCase() !== actualSha256) {
    throw new Error("Datenbank und geschuetzte Dateien gehoeren nicht zum selben Sicherungspunkt.");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    databaseSha256: actualSha256,
    protectedFiles: verified.verified.length,
    requiredStorageKeys: requiredStorageKeys.length,
  })}\n`);
}

try {
  main();
} catch (error) {
  console.error(error?.message || "Backup-Pruefung fehlgeschlagen.");
  process.exitCode = 1;
}
