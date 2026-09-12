"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sha256File } = require("../../../lib/file-integrity");
const { markerPathFor } = require("../../../lib/backup-commit");
const FORMAT = "grabenplaner-deferred-backup";
const MAX_PENDING = 10;

function regular(file, maxBytes = 65536) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) throw new Error("DEFERRED_FILE_INVALID");
  return stat;
}
function queueDirectory(dataRoot, { create = false, requireRoot = true } = {}) {
  const maintenance = path.join(dataRoot, "maintenance"), queue = path.join(maintenance, "deferred-backups");
  for (const directory of [maintenance, queue]) {
    if (!fs.existsSync(directory) && create) fs.mkdirSync(directory, { mode: 0o700 });
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink() || requireRoot && (stat.uid !== 0 || (stat.mode & 0o022))) throw new Error("DEFERRED_DIRECTORY_INVALID");
  }
  return queue;
}
function syncDirectory(directory) {
  if (process.platform !== "linux") return;
  const fd = fs.openSync(directory, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function pendingRecords(dataRoot, backupDirectory, options = {}) {
  const queue = queueDirectory(dataRoot, options);
  if (!queue) return [];
  const names = fs.readdirSync(queue);
  if (names.length > MAX_PENDING) throw new Error("DEFERRED_QUEUE_LIMIT");
  return names.map(name => {
    const file = path.join(queue, name), stat = regular(file);
    if (options.requireRoot !== false && (stat.uid !== 0 || (stat.mode & 0o077))) throw new Error("DEFERRED_RECEIPT_INVALID");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.format !== FORMAT || value.schemaVersion !== 1 || name !== `${value.snapshot}.json`
      || value.backupDirectory !== path.resolve(backupDirectory) || !/^[a-f0-9]{64}$/.test(value.markerSha256 || "")
      || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("DEFERRED_RECEIPT_INVALID");
    const marker = markerPathFor(backupDirectory, value.snapshot);
    regular(marker);
    if (sha256File(marker) !== value.markerSha256) throw new Error("DEFERRED_MARKER_CHANGED");
    return { ...value, file, marker };
  }).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.snapshot.localeCompare(b.snapshot));
}
function register({ dataRoot, backupDirectory, snapshot }, options = {}) {
  const queue = queueDirectory(dataRoot, { ...options, create: true });
  const records = pendingRecords(dataRoot, backupDirectory, options);
  const marker = markerPathFor(backupDirectory, snapshot);
  const stat = regular(marker), value = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (options.requireRoot !== false && stat.uid !== 0 || value.format !== "grabenplaner-backup-commit"
    || value.schemaVersion !== 1 || value.snapshot !== snapshot || value.verification?.status !== "verified"
    || !Number.isFinite(Date.parse(value.committedAt))) throw new Error("DEFERRED_MARKER_INVALID");
  const markerSha256 = sha256File(marker), existing = records.find(record => record.snapshot === snapshot);
  if (existing) {
    if (existing.markerSha256 !== markerSha256) throw new Error("DEFERRED_MARKER_CHANGED");
    return { queued: true, pending: records.length };
  }
  if (records.length >= MAX_PENDING) throw new Error("DEFERRED_QUEUE_LIMIT");
  const file = path.join(queue, `${snapshot}.json`);
  const receipt = { format: FORMAT, schemaVersion: 1, snapshot, backupDirectory: path.resolve(backupDirectory),
    markerSha256, createdAt: value.committedAt };
  // The maintenance lock serializes producers. An interrupted receipt fails
  // closed and is never interpreted as permission to delete its raw backup.
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(receipt)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(queue);
  return { queued: true, pending: records.length + 1 };
}
function drain({ dataRoot, backupDirectory, user, archiveEnabled }, options = {}) {
  const records = pendingRecords(dataRoot, backupDirectory, options);
  const verify = options.verify || require("./verify-backup").verifyBackup;
  const archive = options.archive || ((snapshot) => require("./local-backup-archive").runAsServiceUser({ user, backupDirectory, snapshot, keep: 20 }));
  for (const record of records) {
    if (archiveEnabled) archive(record.snapshot);
    else verify(path.join(backupDirectory, `${record.snapshot}.db`), path.join(backupDirectory, `${record.snapshot}.amu`),
      path.resolve(__dirname, "../../../lib/amu-storage.js"), record.marker);
    if (sha256File(record.marker) !== record.markerSha256) throw new Error("DEFERRED_MARKER_CHANGED");
    fs.unlinkSync(record.file); syncDirectory(path.dirname(record.file));
  }
  return { ok: true, processed: records.length, pending: 0 };
}
function main(args = process.argv.slice(2)) {
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("DEFERRED_ROOT_REQUIRED");
  const [action, dataRoot, backupDirectory, ...values] = args;
  if (![dataRoot, backupDirectory].every(value => typeof value === "string" && path.isAbsolute(value))) throw new Error("DEFERRED_ARGUMENTS_INVALID");
  if (action === "preflight" && values.length === 0) {
    const pending = pendingRecords(dataRoot, backupDirectory).length;
    if (pending >= MAX_PENDING) throw new Error("DEFERRED_QUEUE_LIMIT");
    return { ok: true, pending };
  }
  if (action === "register" && values.length === 1) return register({ dataRoot, backupDirectory, snapshot: values[0] });
  if (action === "drain" && values.length === 2 && ["0", "1"].includes(values[1])) return drain({ dataRoot, backupDirectory, user: values[0], archiveEnabled: values[1] === "1" });
  throw new Error("DEFERRED_ARGUMENTS_INVALID");
}
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main())}\n`); }
  catch { process.stderr.write("Der aufgeschobene Archivabschluss benoetigt eine Pruefung; rohe Sicherungen bleiben erhalten.\n"); process.exitCode = 1; }
}
module.exports = { register, drain, pendingRecords, MAX_PENDING };
