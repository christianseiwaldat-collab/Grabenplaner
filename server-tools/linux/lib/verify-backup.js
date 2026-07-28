"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const MAX_MARKER_BYTES = 64 * 1024;

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function verifyBackup(databasePath, amuBackupDirectory, amuModule, commitMarkerPath) {
  if (![databasePath, amuBackupDirectory, amuModule].every(Boolean)) throw new Error("Pruefparameter fehlen.");
  const { verifyBackupReferences } = require(path.resolve(amuModule));
  const database = new DatabaseSync(path.resolve(databasePath), { readOnly: true });
  const requiredStorageKeys = [];
  try {
    const quickCheck = database.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
    if (quickCheck.length !== 1 || quickCheck[0] !== "ok") throw new Error(`SQLite quick_check: ${quickCheck.join("; ")}`);
    const hasTable = (name) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    const hasColumn = (table, column) => hasTable(table)
      && Boolean(database.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column));
    for (const reference of [
      { table: "amu_documents", where: "WHERE status = 'active'" },
      { table: "personnel_record_documents", where: "WHERE status = 'active'" },
      { table: "loan_documents", where: "" },
      { table: "loan_photo_attachments", where: "" },
      {
        table: "loan_photos",
        where: hasColumn("loan_photos", "original_retained")
          ? "WHERE original_retained = 1"
          : "",
      },
    ]) {
      if (!hasTable(reference.table)) continue;
      requiredStorageKeys.push(...database.prepare(
        `SELECT storage_key FROM ${reference.table} ${reference.where}`,
      ).all().map((row) => row.storage_key));
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
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size <= 0 || markerStat.size > MAX_MARKER_BYTES) {
      throw new Error("Der Sicherungsmarker ist unzulaessig.");
    }
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8").replace(/^\uFEFF/, ""));
    const snapshot = path.basename(databasePath, path.extname(databasePath));
    const databaseStat = fs.lstatSync(databasePath);
    const manifestPath = path.join(amuBackupDirectory, "manifest.json");
    const manifestStat = fs.lstatSync(manifestPath);
    if (marker?.format !== "grabenplaner-backup-commit" || marker?.schemaVersion !== 1
      || marker?.snapshot !== snapshot || !Number.isFinite(Date.parse(String(marker?.committedAt || "")))
      || marker?.database?.fileName !== path.basename(databasePath)
      || String(marker?.database?.sha256 || "").toLowerCase() !== actualSha256
      || marker?.database?.bytes !== databaseStat.size
      || marker?.protectedDocuments?.directoryName !== path.basename(amuBackupDirectory)
      || !Number.isSafeInteger(marker?.protectedDocuments?.files) || marker.protectedDocuments.files < 0
      || marker.protectedDocuments.files !== verified.verified.length
      || marker?.protectedDocuments?.manifestFileName !== "manifest.json"
      || String(marker?.protectedDocuments?.manifestSha256 || "").toLowerCase() !== sha256File(manifestPath)
      || marker?.protectedDocuments?.manifestBytes !== manifestStat.size
      || marker?.verification?.status !== "verified"
      || !Number.isFinite(Date.parse(String(marker?.verification?.verifiedAt || "")))) {
      throw new Error("Der Sicherungsmarker passt nicht zum DB-/Dokumentpaar.");
    }
  }
  return {
    ok: true,
    databaseSha256: actualSha256,
    protectedFiles: verified.verified.length,
    requiredStorageKeys: requiredStorageKeys.length,
  };
}

function main() {
  const result = verifyBackup(...process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || "Backup-Pruefung fehlgeschlagen.");
    process.exitCode = 1;
  }
}

module.exports = { verifyBackup };
