"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FORMAT = "grabenplaner-server-monitor-status";
const LEGACY_SCHEMA_VERSION = 1;
const SCHEMA_VERSION = 2;
const MAX_STATUS_BYTES = 64 * 1024;
const RESTART_COOLDOWN_MS = 30 * 60 * 1000;
const LEGACY_CHECK_IDS = Object.freeze([
  "appService",
  "proxyService",
  "monitorTimer",
  "live",
  "ready",
  "publicReady",
  "hsts",
  "contentSecurityPolicy",
  "contentTypeOptions",
  "referrerPolicy",
  "tlsCertificate",
  "sqlite",
  "backupFresh",
  "backupIntegrity",
  "amuScanner",
  "caddyConfiguration",
  "offsite",
  "diskSpace",
  "monitorStatusProtection",
]);
const CHECK_IDS = Object.freeze([
  ...LEGACY_CHECK_IDS.slice(0, 9),
  "frameOptions",
  ...LEGACY_CHECK_IDS.slice(9, 10),
  "permissionsPolicy",
  "crossOriginOpenerPolicy",
  "crossOriginResourcePolicy",
  "permittedCrossDomainPolicies",
  ...LEGACY_CHECK_IDS.slice(10),
]);
const CHECK_LABELS = new Map([
  ["Dienst grabenplaner.service", "appService"],
  ["Dienst caddy.service", "proxyService"],
  ["Dienst grabenplaner-monitor.timer", "monitorTimer"],
  ["Interne Liveness", "live"],
  ["Interne Readiness", "ready"],
  ["Oeffentliche HTTPS-Readiness", "publicReady"],
  ["HSTS", "hsts"],
  ["Content-Security-Policy", "contentSecurityPolicy"],
  ["X-Content-Type-Options", "contentTypeOptions"],
  ["X-Frame-Options", "frameOptions"],
  ["Referrer-Policy", "referrerPolicy"],
  ["Permissions-Policy", "permissionsPolicy"],
  ["Cross-Origin-Opener-Policy", "crossOriginOpenerPolicy"],
  ["Cross-Origin-Resource-Policy", "crossOriginResourcePolicy"],
  ["X-Permitted-Cross-Domain-Policies", "permittedCrossDomainPolicies"],
  ["TLS-Zertifikat", "tlsCertificate"],
  ["SQLite quick_check", "sqlite"],
  ["Backup-Aktualitaet", "backupFresh"],
  ["Backup DB-/Dokumentkopplung", "backupIntegrity"],
  ["AUM-Virenscanner", "amuScanner"],
  ["Caddy-Konfiguration", "caddyConfiguration"],
  ["Offsite-Sicherung", "offsite"],
  ["Freier Datenspeicher", "diskSpace"],
  ["Monitor-Statusschutz", "monitorStatusProtection"],
]);
const ERROR_CODES = new Set(["MONITOR_RUN_FAILED", "CHECK_OUTPUT_INVALID", "LIVE_RESTART_FAILED"]);
// Preserve established wire keys for compatible readers. The database slot
// describes the active provider; alternate labels cannot duplicate a check.
const ALTERNATIVE_CHECK_LABELS = new Map([
  ["SQLite Lesetest", "sqlite"], ["Backup DB-/Dokumentbeleg", "backupIntegrity"],
  ["PostgreSQL Core/Sales", "sqlite"],
  ["PostgreSQL-Sicherungspaar", "backupIntegrity"],
  ["PostgreSQL-Sicherungsbeleg", "backupIntegrity"],
]);
const STATES = new Set(["ok", "warning", "error"]);
const TOP_LEVEL_KEYS = new Set([
  "format", "schemaVersion", "generatedAt", "state", "complete", "consecutiveLiveFailures",
  "lastRestartAt", "checks", "recovery", "lastError",
]);

function usage() {
  process.stderr.write("Ungueltiger Aufruf des Grabenplaner-Monitorstatus.\n");
  process.exit(2);
}

function isoTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Ungueltiger Zeitstempel.");
  return date.toISOString();
}

function emptyChecks() {
  return Object.fromEntries(CHECK_IDS.map((id) => [id, false]));
}

function emptyStatus(now = new Date()) {
  return {
    format: FORMAT,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: isoTimestamp(now),
    state: "warning",
    complete: false,
    consecutiveLiveFailures: 0,
    lastRestartAt: null,
    checks: emptyChecks(),
    recovery: { attempted: false, successful: false, suppressed: false },
    lastError: null,
  };
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validateStatusSchema(value, schemaVersion, checkIds) {
  if (!exactKeys(value, TOP_LEVEL_KEYS) || value.format !== FORMAT || value.schemaVersion !== schemaVersion
    || !STATES.has(value.state) || typeof value.complete !== "boolean"
    || !Number.isSafeInteger(value.consecutiveLiveFailures) || value.consecutiveLiveFailures < 0
    || value.consecutiveLiveFailures > 3 || !validTimestamp(value.generatedAt)
    || (value.lastRestartAt !== null && !validTimestamp(value.lastRestartAt))) {
    throw new Error("Der Monitorstatus besitzt kein freigegebenes Schema.");
  }
  if (!exactKeys(value.checks, new Set(checkIds))
    || Object.values(value.checks).some((result) => typeof result !== "boolean")) {
    throw new Error("Der Monitorstatus enthaelt ungueltige Pruefergebnisse.");
  }
  if (!exactKeys(value.recovery, new Set(["attempted", "successful", "suppressed"]))
    || Object.values(value.recovery).some((result) => typeof result !== "boolean")
    || value.recovery.successful && !value.recovery.attempted
    || value.recovery.suppressed && value.recovery.attempted) {
    throw new Error("Der Monitorstatus enthaelt einen ungueltigen Wiederanlaufstatus.");
  }
  if (value.lastError !== null) {
    if (!exactKeys(value.lastError, new Set(["code", "at"])) || !ERROR_CODES.has(value.lastError.code)
      || !validTimestamp(value.lastError.at)) {
      throw new Error("Der Monitorstatus enthaelt einen ungueltigen Fehlercode.");
    }
  }
  return value;
}

function validateStatus(value) {
  return validateStatusSchema(value, SCHEMA_VERSION, CHECK_IDS);
}

function migrateLegacyStatus(value) {
  const legacy = validateStatusSchema(value, LEGACY_SCHEMA_VERSION, LEGACY_CHECK_IDS);
  return validateStatus({
    ...legacy,
    schemaVersion: SCHEMA_VERSION,
    state: legacy.state === "ok" ? "warning" : legacy.state,
    complete: false,
    checks: Object.fromEntries(CHECK_IDS.map((id) => [
      id,
      Object.hasOwn(legacy.checks, id) ? legacy.checks[id] : false,
    ])),
  });
}

function normalizeStoredStatus(value) {
  if (value?.schemaVersion === LEGACY_SCHEMA_VERSION) return migrateLegacyStatus(value);
  return validateStatus(value);
}

function parseTestOutput(text, exitCode) {
  if (exitCode !== 0 && exitCode !== 1) throw new Error("CHECK_OUTPUT_INVALID");
  const checks = {};
  const lines = String(text || "").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(OK|FEHLER)\t([^\t]+)\t/);
    if (!match) throw new Error("CHECK_OUTPUT_INVALID");
    const id = CHECK_LABELS.get(match[2]) || ALTERNATIVE_CHECK_LABELS.get(match[2]);
    if (!id || Object.hasOwn(checks, id)) throw new Error("CHECK_OUTPUT_INVALID");
    checks[id] = match[1] === "OK";
  }
  if (Object.keys(checks).length !== CHECK_IDS.length || CHECK_IDS.some((id) => typeof checks[id] !== "boolean")) {
    throw new Error("CHECK_OUTPUT_INVALID");
  }
  const hasFailure = Object.values(checks).some((result) => !result);
  if ((exitCode === 0 && hasFailure) || (exitCode === 1 && !hasFailure)) throw new Error("CHECK_OUTPUT_INVALID");
  return checks;
}

function statusState(checks) {
  if (!checks.appService || !checks.live) return "error";
  return Object.values(checks).every(Boolean) ? "ok" : "warning";
}

function evaluateStatus(previous, checks, now = new Date()) {
  validateStatus(previous);
  const generatedAt = isoTimestamp(now);
  const failures = checks.live ? 0 : Math.min(3, previous.consecutiveLiveFailures + 1);
  const previousRestartMs = previous.lastRestartAt ? Date.parse(previous.lastRestartAt) : Number.NEGATIVE_INFINITY;
  const restartDue = failures >= 3;
  const restartEligible = restartDue && now.getTime() - previousRestartMs >= RESTART_COOLDOWN_MS;
  const suppressed = restartDue && !restartEligible;
  return {
    status: {
      format: FORMAT,
      schemaVersion: SCHEMA_VERSION,
      generatedAt,
      state: statusState(checks),
      complete: true,
      consecutiveLiveFailures: failures,
      lastRestartAt: previous.lastRestartAt,
      checks: Object.fromEntries(CHECK_IDS.map((id) => [id, checks[id]])),
      recovery: { attempted: false, successful: false, suppressed },
      lastError: null,
    },
    restartEligible,
  };
}

function errorStatus(previous, code, now = new Date()) {
  if (!ERROR_CODES.has(code)) throw new Error("Nicht freigegebener Monitorfehler.");
  validateStatus(previous);
  const at = isoTimestamp(now);
  return {
    ...previous,
    generatedAt: at,
    state: "error",
    complete: false,
    recovery: { attempted: false, successful: false, suppressed: false },
    lastError: { code, at },
  };
}

function restartAttemptStatus(previous, now = new Date()) {
  validateStatus(previous);
  const at = isoTimestamp(now);
  if (previous.consecutiveLiveFailures < 3 || previous.checks.live) throw new Error("Kein freigegebener Live-Wiederanlauf.");
  if (previous.lastRestartAt && now.getTime() - Date.parse(previous.lastRestartAt) < RESTART_COOLDOWN_MS) {
    throw new Error("Der Wiederanlauf ist noch gesperrt.");
  }
  return {
    ...previous,
    generatedAt: at,
    lastRestartAt: at,
    recovery: { attempted: true, successful: false, suppressed: false },
    lastError: null,
  };
}

function restartResultStatus(previous, successful, now = new Date()) {
  validateStatus(previous);
  if (!previous.recovery.attempted || !previous.lastRestartAt) throw new Error("Es wurde kein Wiederanlauf begonnen.");
  const at = isoTimestamp(now);
  const checks = { ...previous.checks };
  if (successful) {
    checks.appService = true;
    checks.live = true;
  }
  return {
    ...previous,
    generatedAt: at,
    state: successful ? statusState(checks) : "error",
    complete: successful ? previous.complete : false,
    consecutiveLiveFailures: successful ? 0 : previous.consecutiveLiveFailures,
    checks,
    recovery: { attempted: true, successful, suppressed: false },
    lastError: successful ? null : { code: "LIVE_RESTART_FAILED", at },
  };
}

function parseCli(argv) {
  const args = [...argv];
  if (args.shift() !== "--status-file") usage();
  const statusFile = path.resolve(String(args.shift() || ""));
  if (args.shift() !== "--status-gid") usage();
  const gidText = String(args.shift() || "");
  if (!/^\d+$/.test(gidText)) usage();
  const statusGid = Number(gidText);
  const command = String(args.shift() || "");
  const options = {};
  while (args.length) {
    const key = String(args.shift() || "");
    if (!key.startsWith("--") || !args.length) usage();
    options[key.slice(2)] = String(args.shift());
  }
  if (!path.isAbsolute(statusFile) || statusFile !== "/var/lib/grabenplaner-monitor/status.json"
    || !Number.isSafeInteger(statusGid) || statusGid < 1) usage();
  return { statusFile, statusGid, command, options };
}

function assertStatusDirectory(statusFile, statusGid) {
  const directory = path.dirname(statusFile);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== statusGid
    || (stat.mode & 0o7777) !== 0o750 || stat.nlink < 2) {
    throw new Error("Der Monitorstatusordner ist unsicher.");
  }
}

function readStatus(statusFile, statusGid) {
  let descriptor;
  try {
    const before = fs.lstatSync(statusFile);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.gid !== statusGid
      || (before.mode & 0o7777) !== 0o640 || before.nlink !== 1 || before.size < 2 || before.size > MAX_STATUS_BYTES) {
      throw new Error("Der Monitorstatus ist unsicher.");
    }
    descriptor = fs.openSync(statusFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_CLOEXEC || 0));
    const after = fs.fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino) throw new Error("Der Monitorstatus wurde ausgetauscht.");
    return normalizeStoredStatus(JSON.parse(fs.readFileSync(descriptor, "utf8").replace(/^\uFEFF/, "")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStatus();
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function atomicWrite(statusFile, statusGid, value) {
  validateStatus(value);
  assertStatusDirectory(statusFile, statusGid);
  const directory = path.dirname(statusFile);
  const temporary = path.join(directory, `.status.${process.pid}.${Date.now()}.tmp`);
  const descriptor = fs.openSync(temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o640);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(temporary, 0o640);
  fs.chownSync(temporary, 0, statusGid);
  fs.renameSync(temporary, statusFile);
  const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
}

function readCheckOutput(file) {
  const resolved = path.resolve(String(file || ""));
  if (!resolved.startsWith("/run/grabenplaner-monitor/") || resolved === "/run/grabenplaner-monitor/") {
    throw new Error("CHECK_OUTPUT_INVALID");
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0
    || stat.nlink !== 1 || stat.size > MAX_STATUS_BYTES) throw new Error("CHECK_OUTPUT_INVALID");
  return fs.readFileSync(resolved, "utf8");
}

function main() {
  if (process.platform !== "linux" || typeof process.geteuid !== "function" || process.geteuid() !== 0) {
    throw new Error("Der Monitorstatus darf nur durch root auf Linux verwaltet werden.");
  }
  const { statusFile, statusGid, command, options } = parseCli(process.argv.slice(2));
  assertStatusDirectory(statusFile, statusGid);
  const current = readStatus(statusFile, statusGid);
  if (command === "initialize") {
    if (!fs.existsSync(statusFile)) atomicWrite(statusFile, statusGid, current);
    process.stdout.write("{\"ok\":true}\n");
    return;
  }
  if (command === "inspect") {
    process.stdout.write(`${JSON.stringify({ ok: true, state: current.state, complete: current.complete })}\n`);
    return;
  }
  if (command === "evaluate") {
    const exitCode = Number(options["test-exit"]);
    try {
      const checks = parseTestOutput(readCheckOutput(options["output-file"]), exitCode);
      const evaluated = evaluateStatus(current, checks);
      atomicWrite(statusFile, statusGid, evaluated.status);
      process.stdout.write(`${JSON.stringify({ restartEligible: evaluated.restartEligible, complete: true })}\n`);
    } catch (error) {
      const failed = errorStatus(current, "CHECK_OUTPUT_INVALID");
      atomicWrite(statusFile, statusGid, failed);
      process.stdout.write("{\"restartEligible\":false,\"complete\":false}\n");
    }
    return;
  }
  if (command === "error") {
    atomicWrite(statusFile, statusGid, errorStatus(current, String(options.code || "")));
    process.stdout.write("{\"ok\":true}\n");
    return;
  }
  if (command === "restart-attempt") {
    atomicWrite(statusFile, statusGid, restartAttemptStatus(current));
    process.stdout.write("{\"ok\":true}\n");
    return;
  }
  if (command === "restart-result") {
    if (options.successful !== "0" && options.successful !== "1") usage();
    atomicWrite(statusFile, statusGid, restartResultStatus(current, options.successful === "1"));
    process.stdout.write("{\"ok\":true}\n");
    return;
  }
  usage();
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write("Monitorstatus konnte nicht sicher verarbeitet werden.\n");
    process.exitCode = 1;
  }
}

module.exports = {
  CHECK_IDS,
  CHECK_LABELS,
  ERROR_CODES,
  FORMAT,
  LEGACY_CHECK_IDS,
  RESTART_COOLDOWN_MS,
  emptyStatus,
  errorStatus,
  evaluateStatus,
  migrateLegacyStatus,
  parseTestOutput,
  restartAttemptStatus,
  restartResultStatus,
  validateStatus,
};
