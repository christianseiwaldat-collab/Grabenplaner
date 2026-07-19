"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function main() {
  const [databasePath, amuBackupDirectory, amuModule, commitMarkerPath] = process.argv.slice(2);
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
  if (commitMarkerPath) {
    const markerPath = path.resolve(commitMarkerPath);
    const markerStat = fs.lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("Der Sicherungsmarker ist unzulaessig.");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8").replace(/^\uFEFF/, ""));
    const snapshot = path.basename(databasePath, path.extname(databasePath));
    if (marker?.format !== "grabenplaner-backup-commit" || marker?.schemaVersion !== 1
      || marker?.snapshot !== snapshot || !Number.isFinite(Date.parse(String(marker?.committedAt || "")))
      || marker?.database?.fileName !== path.basename(databasePath)
      || String(marker?.database?.sha256 || "").toLowerCase() !== actualSha256
      || marker?.protectedDocuments?.directoryName !== path.basename(amuBackupDirectory)) {
      throw new Error("Der Sicherungsmarker passt nicht zum DB-/Dokumentpaar.");
    }
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
