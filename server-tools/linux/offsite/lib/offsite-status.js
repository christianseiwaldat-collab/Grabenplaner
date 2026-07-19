"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FORMAT = "grabenplaner-offsite-backup-status";
const RETENTION = Object.freeze({ daily: 14, weekly: 8, monthly: 12 });
const STATES = new Set(["ok", "warning", "error", "unconfigured"]);
const STATUS_KEYS = new Set([
  "format", "schemaVersion", "configured", "state", "generatedAt", "lastAttemptAt", "lastSuccessAt",
  "lastSnapshotId", "lastRepositoryCheckAt", "lastFullCheckAt", "lastRestoreTestAt", "lastFailureAt",
  "lastError", "unresolvedFailures", "retention",
]);
const ERROR_SUMMARIES = new Map([
  ["PREPARE_FAILED", "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."],
  ["UPLOAD_FAILED", "Die verschluesselte Offsite-Sicherung konnte nicht uebertragen werden."],
  ["SNAPSHOT_VERIFY_FAILED", "Der uebertragene Offsite-Sicherungspunkt konnte nicht eindeutig bestaetigt werden."],
  ["REPOSITORY_CHECK_FAILED", "Die Offsite-Repository-Pruefung ist fehlgeschlagen."],
  ["RETENTION_FAILED", "Die Offsite-Aufbewahrung konnte nicht sicher angewendet werden."],
  ["FULL_CHECK_FAILED", "Die vollstaendige Offsite-Datenpruefung ist fehlgeschlagen."],
  ["RESTORE_TEST_FAILED", "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."],
  ["REPOSITORY_ID_MISMATCH", "Das Offsite-Repository stimmt nicht mit der eingerichteten Identitaet ueberein."],
  ["FULL_CHECK_REPOSITORY_ID_MISMATCH", "Die Identitaet des Offsite-Repositorys konnte fuer die Vollpruefung nicht bestaetigt werden."],
  ["RESTORE_TEST_REPOSITORY_ID_MISMATCH", "Die Identitaet des Offsite-Repositorys konnte fuer den Restore-Test nicht bestaetigt werden."],
  ["MODULE_INTEGRITY_FAILED", "Das installierte Offsite-Modul hat die Integritaetspruefung nicht bestanden."],
]);

function usage() {
  process.stderr.write("Verwendung: offsite-status.js --status-file PFAD --status-gid GID <inspect|configured|unconfigured|attempt|success|failure|full-check|restore-test> [Optionen]\n");
  process.exit(2);
}

function parseArguments(argv) {
  const args = [...argv];
  let statusFile = "";
  if (args.shift() !== "--status-file") usage();
  statusFile = String(args.shift() || "");
  if (args.shift() !== "--status-gid") usage();
  const statusGidText = String(args.shift() || "");
  if (!/^\d+$/.test(statusGidText)) usage();
  const statusGid = Number(statusGidText);
  if (!Number.isSafeInteger(statusGid) || statusGid < 1) usage();
  const command = String(args.shift() || "");
  const options = {};
  while (args.length) {
    const name = String(args.shift() || "");
    if (!name.startsWith("--") || !args.length) usage();
    options[name.slice(2)] = String(args.shift());
  }
  if (!path.isAbsolute(statusFile) || path.resolve(statusFile) === path.parse(statusFile).root) usage();
  return { statusFile: path.resolve(statusFile), statusGid, command, options };
}

function emptyStatus(configured) {
  const now = new Date().toISOString();
  return {
    format: FORMAT,
    schemaVersion: 1,
    configured,
    state: configured ? "warning" : "unconfigured",
    generatedAt: now,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastSnapshotId: null,
    lastRepositoryCheckAt: null,
    lastFullCheckAt: null,
    lastRestoreTestAt: null,
    lastFailureAt: null,
    lastError: null,
    unresolvedFailures: { backup: false, fullCheck: false, restoreTest: false },
    retention: { ...RETENTION },
  };
}

function readCurrent(statusFile, statusGid) {
  let descriptor;
  try {
    const before = fs.lstatSync(statusFile);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > 64 * 1024 || before.nlink !== 1) throw new Error("unsafe");
    descriptor = fs.openSync(statusFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_CLOEXEC || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.uid !== 0 || stat.gid !== statusGid
      || (stat.mode & 0o7777) !== 0o640 || stat.nlink !== 1) throw new Error("unsafe");
    const value = JSON.parse(fs.readFileSync(descriptor, "utf8").replace(/^\uFEFF/, ""));
    if (Object.keys(value).length !== STATUS_KEYS.size || Object.keys(value).some((key) => !STATUS_KEYS.has(key))
      || [...STATUS_KEYS].some((key) => !Object.hasOwn(value, key))) throw new Error("schema");
    if (value.format !== FORMAT || value.schemaVersion !== 1 || typeof value.configured !== "boolean") throw new Error("schema");
    if (!STATES.has(value.state) || JSON.stringify(value.retention) !== JSON.stringify(RETENTION)
      || JSON.stringify(value.unresolvedFailures) !== JSON.stringify({ backup: false, fullCheck: false, restoreTest: false })
        && (!value.unresolvedFailures || Object.keys(value.unresolvedFailures).sort().join(",") !== "backup,fullCheck,restoreTest"
          || Object.values(value.unresolvedFailures).some((item) => typeof item !== "boolean"))) throw new Error("schema");
    const hasUnresolvedFailure = Object.values(value.unresolvedFailures).some(Boolean);
    if ((value.state === "error") !== hasUnresolvedFailure || (value.state === "unconfigured") !== !value.configured) {
      throw new Error("schema");
    }
    return { ...emptyStatus(value.configured), ...value, retention: { ...RETENTION } };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStatus(true);
    throw new Error("Der bisherige Status ist nicht sicher lesbar.");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function atomicWrite(statusFile, statusGid, value) {
  const directory = path.dirname(statusFile);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== statusGid
    || (stat.mode & 0o7777) !== 0o750 || stat.nlink < 2) throw new Error("Der Statusordner ist unsicher.");
  const temporary = path.join(directory, `.status.${process.pid}.${Date.now()}.tmp`);
  const handle = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o640);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.chmodSync(temporary, 0o640);
  fs.chownSync(temporary, 0, statusGid);
  fs.renameSync(temporary, statusFile);
  const directoryHandle = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
}

function main() {
  if (process.platform !== "linux" || typeof process.geteuid !== "function" || process.geteuid() !== 0) {
    throw new Error("Der Status darf nur durch root auf Linux geschrieben werden.");
  }
  const { statusFile, statusGid, command, options } = parseArguments(process.argv.slice(2));
  const current = readCurrent(statusFile, statusGid);
  const now = new Date().toISOString();
  let next = { ...current, generatedAt: now, retention: { ...RETENTION } };
  switch (command) {
    case "inspect":
      process.stdout.write(`${JSON.stringify({ ok: true, configured: current.configured, state: current.state })}\n`);
      return;
    case "configured":
      next = emptyStatus(true);
      break;
    case "unconfigured":
      next = emptyStatus(false);
      break;
    case "attempt":
      next.configured = true;
      next.state = Object.values(next.unresolvedFailures).some(Boolean) ? "error" : "warning";
      next.lastAttemptAt = now;
      break;
    case "success": {
      const snapshot = String(options.snapshot || "").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(snapshot)) usage();
      next.configured = true;
      next.state = "ok";
      next.lastAttemptAt = now;
      next.lastSuccessAt = now;
      next.lastSnapshotId = snapshot.slice(0, 12);
      next.lastRepositoryCheckAt = now;
      next.unresolvedFailures.backup = false;
      next.state = Object.values(next.unresolvedFailures).some(Boolean) ? "error" : "ok";
      break;
    }
    case "failure": {
      const code = String(options.code || "");
      const summary = ERROR_SUMMARIES.get(code);
      if (!summary || (options.summary && options.summary !== summary)) usage();
      next.configured = true;
      next.state = "error";
      next.lastAttemptAt = now;
      next.lastFailureAt = now;
      next.lastError = { code, summary };
      const area = code === "FULL_CHECK_FAILED" || code === "FULL_CHECK_REPOSITORY_ID_MISMATCH"
        ? "fullCheck" : code === "RESTORE_TEST_FAILED" || code === "RESTORE_TEST_REPOSITORY_ID_MISMATCH"
          ? "restoreTest" : "backup";
      next.unresolvedFailures[area] = true;
      break;
    }
    case "full-check":
      next.configured = true;
      next.lastFullCheckAt = now;
      next.lastRepositoryCheckAt = now;
      next.unresolvedFailures.fullCheck = false;
      next.state = Object.values(next.unresolvedFailures).some(Boolean) ? "error" : next.lastSuccessAt ? "ok" : "warning";
      break;
    case "restore-test":
      next.configured = true;
      next.lastRestoreTestAt = now;
      next.unresolvedFailures.restoreTest = false;
      next.state = Object.values(next.unresolvedFailures).some(Boolean) ? "error" : next.lastSuccessAt ? "ok" : "warning";
      break;
    default:
      usage();
  }
  atomicWrite(statusFile, statusGid, next);
  process.stdout.write(`${JSON.stringify({ ok: true, state: next.state })}\n`);
}

try { main(); }
catch (error) {
  process.stderr.write(`${error?.message || "Statusaktualisierung fehlgeschlagen."}\n`);
  process.exitCode = 1;
}
