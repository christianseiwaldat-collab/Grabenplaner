"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { markerPathFor } = require("../../../lib/backup-commit");
const { verifyBackup } = require("./verify-backup");

const TIMEOUT_MS = 1500 * 1000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const VAULT_AND_ARCHIVE_ENVIRONMENT = Object.freeze([
  "GRABENPLANER_LOCAL_BACKUP_ARCHIVE",
  "GRABENPLANER_LOCAL_BACKUP_RESTIC",
  "GRABENPLANER_LOCAL_BACKUP_RESTIC_SHA256",
  "GRABENPLANER_INTEGRATION_KEY_ID",
  "GRABENPLANER_INTEGRATION_KEY",
  "GRABENPLANER_INTEGRATION_KEYS",
  "GRABENPLANER_AMU_KEY_ID",
  "GRABENPLANER_AMU_KEY",
  "GRABENPLANER_AMU_KEYS",
]);

function areaParameters({ backupDirectory, keep }) {
  if (typeof backupDirectory !== "string" || !path.isAbsolute(backupDirectory)
    || /[\x00-\x1f\x7f]/.test(backupDirectory)
    || path.resolve(backupDirectory) === path.parse(path.resolve(backupDirectory)).root
    || String(keep) !== "20") throw new Error("Parameter fuer das lokale Sicherungsarchiv sind ungueltig.");
  return { backupDirectory: path.resolve(backupDirectory), keep: 20 };
}

function parameters(options) {
  const { backupDirectory, keep } = areaParameters(options), { snapshot } = options;
  const markerPath = markerPathFor(backupDirectory, snapshot);
  const directory = path.dirname(markerPath);
  const paths = { snapshot, markerPath, databasePath: path.join(directory, `${snapshot}.db`),
    protectedDirectory: path.join(directory, `${snapshot}.amu`) };
  return { backupDirectory: directory, snapshot, keep: 20, paths };
}

function preflightReceipt(value) {
  if (value?.ready !== true || value.retention !== 20 || !Number.isSafeInteger(value.retained)
    || value.retained < 0 || value.retained > 20 || value.stream !== "external") {
    throw new Error("Die lokale Archiv-Vorpruefung lieferte keinen gueltigen Beleg.");
  }
  return { ready: true, retained: value.retained, retention: 20, stream: "external" };
}

function preflightArchive(options, dependencies = {}) {
  const input = areaParameters(options);
  const openArchive = dependencies.openArchive || require("../../../lib/local-backup-environment").openLocalBackupArchiveFromEnvironment;
  const archive = openArchive({ backupDirectory: input.backupDirectory, expectedStream: "external", environment: options.environment || process.env });
  if (!archive || archive.configured() !== true) throw new Error("Das lokale Archiv muss vor der Verwendung ausdruecklich eingerichtet werden.");
  return preflightReceipt(archive.preflightBackup());
}

function scopedChildEnvironment(environment, backupDirectory) {
  const result = { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin", NODE_ENV: "production", TMPDIR: backupDirectory };
  for (const key of VAULT_AND_ARCHIVE_ENVIRONMENT) {
    if (environment[key] !== undefined) result[key] = String(environment[key]);
  }
  return result;
}

function receipt(value) {
  if (value?.ok !== true || value?.archived !== true || value?.rawRetained !== true
    || !Number.isSafeInteger(value?.retained) || value.retained < 1 || value.retained > 20
    || !Number.isSafeInteger(value?.removedArchives) || value.removedArchives < 0
    || !Number.isSafeInteger(value?.removedRaw) || value.removedRaw < 0) {
    throw new Error("Das lokale Archiv lieferte keinen gueltigen Sicherungsbeleg.");
  }
  return { ok: true, archived: true, rawRetained: true, retained: value.retained,
    removedArchives: value.removedArchives, removedRaw: value.removedRaw };
}

function archiveCommittedPair(options, dependencies = {}) {
  const input = parameters(options);
  const openArchive = dependencies.openArchive || require("../../../lib/local-backup-environment").openLocalBackupArchiveFromEnvironment;
  const verify = dependencies.verifyBackup || verifyBackup;
  const archive = openArchive({ backupDirectory: input.backupDirectory, expectedStream: "external", environment: options.environment || process.env });
  if (!archive || archive.configured() !== true) {
    throw new Error("Das lokale Archiv muss vor der Verwendung ausdruecklich eingerichtet werden.");
  }
  const verifyKeys = dependencies.verifyRecoveryKeys || require("../../../lib/backup-recovery-keys").verifyBackupRecoveryKeys;
  const verifyPair = (pair) => {
    const result = verify(pair.databasePath, pair.protectedDirectory,
      path.resolve(__dirname, "../../../lib/amu-storage.js"), pair.markerPath);
    verifyKeys({ databasePath: pair.databasePath, protectedDirectory: pair.protectedDirectory, environment: options.environment || process.env });
    return result;
  };
  archive.archivePair(input.snapshot, { verifyPair });
  const retention = archive.maintainRetention(input.snapshot, { verifyPair });
  // Updater, Offsite and legacy health checks require this exact raw pair.
  verifyPair(input.paths);
  return receipt({ ok: true, archived: true, rawRetained: true, ...retention });
}

function runAsServiceUser(options, dependencies = {}) {
  const action = options.action || "archive";
  if (!["archive", "preflight"].includes(action)) throw new Error("Die Archiv-Aktion ist ungueltig.");
  const input = action === "preflight" ? areaParameters(options) : parameters(options);
  const platform = dependencies.platform || process.platform;
  const uid = dependencies.uid === undefined ? process.getuid?.() : dependencies.uid;
  const user = String(options.user || "");
  if (platform !== "linux" || uid !== 0 || user === "root" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) {
    throw new Error("Der lokale Archiv-Launcher benoetigt root und einen eindeutigen Dienstbenutzer.");
  }
  const childEnvironment = scopedChildEnvironment(options.environment || process.env, input.backupDirectory);
  let result;
  try {
    result = (dependencies.spawnSync || spawnSync)("/usr/sbin/runuser", [
      "--user", user, "--", process.execPath, __filename, action,
      input.backupDirectory, ...(action === "archive" ? [input.snapshot] : []), String(input.keep),
    ], { env: childEnvironment, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT_BYTES, windowsHide: true });
  } finally {
    for (const key of VAULT_AND_ARCHIVE_ENVIRONMENT) delete childEnvironment[key];
  }
  // Never forward child stderr or malformed stdout: either may contain secrets.
  if (result?.error || result?.status !== 0) throw new Error("Das lokale Sicherungsarchiv konnte nicht verifiziert werden.");
  try { return (action === "preflight" ? preflightReceipt : receipt)(JSON.parse(result.stdout)); }
  catch { throw new Error("Das lokale Archiv lieferte keinen gueltigen Sicherungsbeleg."); }
}

function main(args = process.argv.slice(2)) {
  const [action, ...values] = args;
  if (action === "preflight" && values.length === 2) {
    const [backupDirectory, keep] = values;
    return preflightArchive({ backupDirectory, keep });
  }
  if (action === "preflight-as" && values.length === 3) {
    const [user, backupDirectory, keep] = values;
    return runAsServiceUser({ action: "preflight", user, backupDirectory, keep });
  }
  if (action === "archive" && values.length === 3) {
    const [backupDirectory, snapshot, keep] = values;
    return archiveCommittedPair({ backupDirectory, snapshot, keep });
  }
  if (action === "archive-as" && values.length === 4) {
    const [user, backupDirectory, snapshot, keep] = values;
    return runAsServiceUser({ user, backupDirectory, snapshot, keep });
  }
  throw new Error("Verwendung: local-backup-archive.js preflight-as DIENSTBENUTZER BACKUPORDNER 20 | archive-as DIENSTBENUTZER BACKUPORDNER SICHERUNGSNAME 20");
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main())}\n`); }
  catch {
    process.stderr.write("Das lokale Sicherungsarchiv konnte nicht sicher abgeschlossen werden. Der rohe Sicherungspunkt bleibt erhalten.\n");
    process.exitCode = 1;
  }
}

module.exports = { archiveCommittedPair, preflightArchive, main, parameters, runAsServiceUser, scopedChildEnvironment };
