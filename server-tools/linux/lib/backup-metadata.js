"use strict";
// Periodic liveness checks inspect a committed pair's metadata. They do not
// claim to have read the database or document contents; the nightly test does.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function regular(file, maximum = Number.MAX_SAFE_INTEGER) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maximum) throw new Error("BACKUP_METADATA_FILE_INVALID");
  return info;
}
function inspectBackupMetadata(databasePath, documentsPath, markerPath, { now = Date.now() } = {}) {
  const database = regular(databasePath), markerStat = regular(markerPath, 65536);
  const directory = fs.lstatSync(documentsPath);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("BACKUP_METADATA_DIRECTORY_INVALID");
  const markerBytes = fs.readFileSync(markerPath), marker = JSON.parse(markerBytes);
  const manifestPath = path.join(documentsPath, "manifest.json"), manifestStat = regular(manifestPath, 32 * 1024 * 1024);
  const manifestBytes = fs.readFileSync(manifestPath), manifest = JSON.parse(manifestBytes);
  const expectedSnapshot = path.basename(databasePath, ".db");
  const when = Date.parse(marker.committedAt), verifiedAt = Date.parse(marker.verification?.verifiedAt);
  if (marker.format !== "grabenplaner-backup-commit" || marker.schemaVersion !== 1 || marker.snapshot !== expectedSnapshot
    || path.basename(markerPath) !== `${expectedSnapshot}.complete.json`
    || path.basename(documentsPath) !== `${expectedSnapshot}.amu`
    || path.dirname(path.resolve(databasePath)) !== path.dirname(path.resolve(markerPath))
    || path.dirname(path.resolve(databasePath)) !== path.dirname(path.resolve(documentsPath))
    || marker.database?.fileName !== path.basename(databasePath) || marker.database.bytes !== database.size
    || !/^[a-f0-9]{64}$/.test(marker.database.sha256 || "")
    || manifest.database?.fileName !== marker.database.fileName || manifest.database.sha256 !== marker.database.sha256
    || marker.protectedDocuments?.directoryName !== path.basename(documentsPath)
    || marker.protectedDocuments.manifestFileName !== "manifest.json"
    || marker.protectedDocuments.manifestBytes !== manifestStat.size
    || marker.protectedDocuments.manifestSha256 !== crypto.createHash("sha256").update(manifestBytes).digest("hex")
    || !Number.isSafeInteger(marker.protectedDocuments.files) || marker.protectedDocuments.files < 0
    || !Array.isArray(manifest.files) || manifest.files.length !== marker.protectedDocuments.files
    || marker.verification?.status !== "verified" || !Number.isFinite(when) || !Number.isFinite(verifiedAt)
    || when > now + 300000 || verifiedAt > now + 300000
    || markerBytes.length !== markerStat.size || manifestBytes.length !== manifestStat.size) throw new Error("BACKUP_METADATA_MISMATCH");
  return { ok: true, verification: "metadata-only", committedAt: marker.committedAt, databaseBytes: database.size };
}
if (require.main === module) {
  try {
    if (process.argv.length !== 5) throw new Error("BACKUP_METADATA_ARGUMENTS_INVALID");
    process.stdout.write(`${JSON.stringify(inspectBackupMetadata(...process.argv.slice(2)))}\n`);
  } catch { process.stderr.write("Der Sicherungsbeleg konnte nicht bestaetigt werden.\n"); process.exitCode = 1; }
}
module.exports = { inspectBackupMetadata };
