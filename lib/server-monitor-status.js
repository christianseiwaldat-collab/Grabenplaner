"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STATUS_FORMAT = "grabenplaner-server-monitor-status";
const STATUS_SCHEMA_VERSION = 1;
const DEFAULT_STATUS_PATH = "/var/lib/grabenplaner-monitor/status.json";
const MAX_STATUS_BYTES = 32 * 1024;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const DEFAULT_MAXIMUM_AGE_HOURS = 1;
const STATUS_STATES = new Set(["ok", "warning", "error"]);
const ERROR_CODES = new Set(["MONITOR_RUN_FAILED", "CHECK_OUTPUT_INVALID", "LIVE_RESTART_FAILED"]);
const CHECK_IDS = Object.freeze([
  "appService",
  "proxyService",
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
  "monitorTimer",
  "monitorStatusProtection",
]);
const TOP_LEVEL_KEYS = new Set([
  "format",
  "schemaVersion",
  "generatedAt",
  "state",
  "complete",
  "consecutiveLiveFailures",
  "lastRestartAt",
  "checks",
  "recovery",
  "lastError",
]);
const RECOVERY_KEYS = new Set(["attempted", "successful", "suppressed"]);
const LAST_ERROR_KEYS = new Set(["code", "at"]);

class ServerMonitorStatusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ServerMonitorStatusError";
    this.code = code;
  }
}

function statusError(code, message) {
  return new ServerMonitorStatusError(code, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw statusError("MONITOR_STATUS_SCHEMA_INVALID", `${label} ist kein gueltiges Objekt.`);
  const keys = Object.keys(value);
  const unexpected = keys.find((key) => !allowed.has(key));
  const missing = [...allowed].find((key) => !Object.hasOwn(value, key));
  if (unexpected || missing) throw statusError("MONITOR_STATUS_SCHEMA_INVALID", `${label} entspricht nicht dem freigegebenen Schema.`);
}

function normalizeTimestamp(value, label, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== "string") throw statusError("MONITOR_STATUS_SCHEMA_INVALID", `${label} ist kein UTC-Zeitstempel.`);
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/);
  if (!match) throw statusError("MONITOR_STATUS_SCHEMA_INVALID", `${label} ist kein UTC-Zeitstempel.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw statusError("MONITOR_STATUS_SCHEMA_INVALID", `${label} ist ungueltig.`);
  const normalized = new Date(milliseconds).toISOString();
  const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${String(match[7] || "").padEnd(3, "0")}Z`;
  if (normalized !== canonical) throw statusError("MONITOR_STATUS_SCHEMA_INVALID", `${label} ist ungueltig.`);
  return normalized;
}

function parseServerMonitorStatus(value) {
  assertExactKeys(value, TOP_LEVEL_KEYS, "Der Server-Monitorstatus");
  if (value.format !== STATUS_FORMAT || value.schemaVersion !== STATUS_SCHEMA_VERSION) {
    throw statusError("MONITOR_STATUS_SCHEMA_INVALID", "Format oder Schemaversion des Server-Monitorstatus ist ungueltig.");
  }
  if (!STATUS_STATES.has(value.state) || typeof value.complete !== "boolean") {
    throw statusError("MONITOR_STATUS_SCHEMA_INVALID", "Zustand oder Vollstaendigkeitsangabe ist ungueltig.");
  }
  if (!Number.isSafeInteger(value.consecutiveLiveFailures)
    || value.consecutiveLiveFailures < 0 || value.consecutiveLiveFailures > 3) {
    throw statusError("MONITOR_STATUS_SCHEMA_INVALID", "Die Anzahl aufeinanderfolgender Live-Fehler ist ungueltig.");
  }

  assertExactKeys(value.checks, new Set(CHECK_IDS), "Die Monitorpruefungen");
  const checks = {};
  for (const id of CHECK_IDS) {
    if (typeof value.checks[id] !== "boolean") {
      throw statusError("MONITOR_STATUS_SCHEMA_INVALID", "Die Monitorpruefungen enthalten einen ungueltigen Wert.");
    }
    checks[id] = value.checks[id];
  }

  assertExactKeys(value.recovery, RECOVERY_KEYS, "Die automatische Wiederanlaufangabe");
  if (![value.recovery.attempted, value.recovery.successful, value.recovery.suppressed].every((entry) => typeof entry === "boolean")) {
    throw statusError("MONITOR_STATUS_SCHEMA_INVALID", "Die automatische Wiederanlaufangabe ist ungueltig.");
  }
  if (value.recovery.successful && !value.recovery.attempted) {
    throw statusError("MONITOR_STATUS_SCHEMA_INVALID", "Ein erfolgreicher Wiederanlauf benoetigt einen vorherigen Versuch.");
  }
  if (value.recovery.successful && value.recovery.suppressed) {
    throw statusError("MONITOR_STATUS_SCHEMA_INVALID", "Ein unterdrueckter Wiederanlauf kann nicht erfolgreich sein.");
  }

  let lastError = null;
  if (value.lastError !== null) {
    assertExactKeys(value.lastError, LAST_ERROR_KEYS, "Der letzte Monitorfehler");
    if (!ERROR_CODES.has(value.lastError.code)) {
      throw statusError("MONITOR_STATUS_SCHEMA_INVALID", "Der letzte Monitorfehler enthaelt keinen freigegebenen Fehlercode.");
    }
    lastError = {
      code: value.lastError.code,
      at: normalizeTimestamp(value.lastError.at, "lastError.at"),
    };
  }

  const normalized = {
    format: STATUS_FORMAT,
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: normalizeTimestamp(value.generatedAt, "generatedAt"),
    state: value.state,
    complete: value.complete,
    consecutiveLiveFailures: value.consecutiveLiveFailures,
    lastRestartAt: normalizeTimestamp(value.lastRestartAt, "lastRestartAt", { nullable: true }),
    checks,
    recovery: {
      attempted: value.recovery.attempted,
      successful: value.recovery.successful,
      suppressed: value.recovery.suppressed,
    },
    lastError,
  };

  const generatedMs = Date.parse(normalized.generatedAt);
  for (const timestamp of [normalized.lastRestartAt, normalized.lastError?.at].filter(Boolean)) {
    if (Date.parse(timestamp) > generatedMs + FUTURE_TOLERANCE_MS) {
      throw statusError("MONITOR_STATUS_SCHEMA_INVALID", "Ein Monitorzeitpunkt liegt unplausibel nach dem Statuszeitpunkt.");
    }
  }
  if (normalized.state === "ok" && (!normalized.complete || normalized.lastError || Object.values(normalized.checks).some((ok) => !ok))) {
    throw statusError("MONITOR_STATUS_SCHEMA_INVALID", "Ein erfolgreicher Monitorstatus widerspricht seinen Pruefergebnissen.");
  }
  return normalized;
}

function configuredOption(value) {
  if (value === undefined) return undefined;
  return value === true;
}

function resolveStatusPath(statusPath) {
  const candidate = String(statusPath || process.env.GRABENPLANER_MONITOR_STATUS_FILE || DEFAULT_STATUS_PATH);
  if (!candidate || candidate.includes("\0") || !path.isAbsolute(candidate)) {
    throw statusError("MONITOR_STATUS_PATH_INVALID", "Der Server-Monitorstatuspfad ist ungueltig.");
  }
  return path.resolve(candidate);
}

function readStatusFile(statusPath, { maximumBytes, requireRootOwner }) {
  let descriptor;
  try {
    const before = fs.lstatSync(statusPath);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw statusError("MONITOR_STATUS_FILE_UNSAFE", "Der Server-Monitorstatus ist keine regulaere Datei.");
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_CLOEXEC || 0);
    descriptor = fs.openSync(statusPath, flags);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > maximumBytes
      || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw statusError("MONITOR_STATUS_FILE_SIZE_INVALID", "Der Server-Monitorstatus hat eine unzulaessige Groesse oder wurde ausgetauscht.");
    }
    if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
      throw statusError("MONITOR_STATUS_FILE_PERMISSIONS_INVALID", "Der Server-Monitorstatus darf nicht durch Gruppe oder andere Benutzer beschreibbar sein.");
    }
    if (requireRootOwner && typeof stat.uid === "number" && stat.uid !== 0) {
      throw statusError("MONITOR_STATUS_FILE_OWNER_INVALID", "Der Server-Monitorstatus muss root gehoeren.");
    }
    const content = fs.readFileSync(descriptor);
    if (content.length <= 0 || content.length > maximumBytes) {
      throw statusError("MONITOR_STATUS_FILE_SIZE_INVALID", "Der Server-Monitorstatus hat eine unzulaessige Groesse.");
    }
    return content.toString("utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if (error instanceof ServerMonitorStatusError) throw error;
    if (error?.code === "ENOENT") throw statusError("MONITOR_STATUS_FILE_MISSING", "Der Server-Monitorstatus fehlt.");
    throw statusError("MONITOR_STATUS_FILE_UNREADABLE", "Der Server-Monitorstatus ist nicht sicher lesbar.");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ageHours(timestamp, nowMs) {
  if (!timestamp) return null;
  const difference = nowMs - Date.parse(timestamp);
  if (difference < -FUTURE_TOLERANCE_MS) return null;
  return Math.round(Math.max(0, difference) / 36000) / 100;
}

function fallbackStatus({ configured, code = null }) {
  return {
    configured: configured === true,
    state: configured === true ? "error" : "unconfigured",
    statusAvailable: false,
    blocksMainReadiness: false,
    complete: false,
    generatedAt: null,
    ageHours: null,
    consecutiveLiveFailures: 0,
    lastRestartAt: null,
    checks: null,
    failedChecks: [],
    recovery: { attempted: false, successful: false, suppressed: false },
    lastErrorCode: configured === true ? (code || "MONITOR_STATUS_UNAVAILABLE") : null,
  };
}

function diagnosticsFromStatus(status, options = {}) {
  const nowValue = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
  const nowMs = Number.isFinite(nowValue) ? nowValue : Date.now();
  const maximumAgeHours = Number.isFinite(Number(options.maximumAgeHours))
    ? Math.min(24, Math.max(0.1, Number(options.maximumAgeHours)))
    : DEFAULT_MAXIMUM_AGE_HOURS;
  const generatedAgeHours = ageHours(status.generatedAt, nowMs);
  const futureTimestamp = [status.generatedAt, status.lastRestartAt, status.lastError?.at]
    .filter(Boolean).some((timestamp) => Date.parse(timestamp) > nowMs + FUTURE_TOLERANCE_MS);
  const stale = generatedAgeHours === null || generatedAgeHours > maximumAgeHours;
  const failedChecks = CHECK_IDS.filter((id) => !status.checks[id]);
  let state = status.state;
  let lastErrorCode = status.lastError?.code || null;
  if (futureTimestamp) {
    state = "error";
    lastErrorCode = "MONITOR_STATUS_TIMESTAMP_FUTURE";
  } else if (stale && state === "ok") {
    state = "warning";
    lastErrorCode = "MONITOR_STATUS_STALE";
  }
  return {
    configured: true,
    state,
    statusAvailable: true,
    blocksMainReadiness: false,
    complete: status.complete,
    generatedAt: status.generatedAt,
    ageHours: generatedAgeHours,
    consecutiveLiveFailures: status.consecutiveLiveFailures,
    lastRestartAt: status.lastRestartAt,
    checks: { ...status.checks },
    failedChecks,
    recovery: { ...status.recovery },
    lastErrorCode,
  };
}

function readServerMonitorStatus(options = {}) {
  const configured = configuredOption(options.configured)
    ?? (String(process.env.GRABENPLANER_MONITOR_CONFIGURED || "").trim() === "1");
  if (!configured) return fallbackStatus({ configured: false });

  let statusPath;
  try {
    statusPath = resolveStatusPath(options.statusPath);
  } catch (error) {
    return fallbackStatus({ configured: true, code: error.code });
  }
  const maximumBytes = Number.isSafeInteger(options.maximumBytes) && options.maximumBytes > 0
    ? Math.min(options.maximumBytes, MAX_STATUS_BYTES)
    : MAX_STATUS_BYTES;
  const requireRootOwner = options.requireRootOwner === undefined
    ? process.platform === "linux" && process.env.NODE_ENV === "production"
    : options.requireRootOwner === true;
  try {
    const raw = readStatusFile(statusPath, { maximumBytes, requireRootOwner });
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw statusError("MONITOR_STATUS_JSON_INVALID", "Der Server-Monitorstatus enthaelt kein gueltiges JSON."); }
    return diagnosticsFromStatus(parseServerMonitorStatus(parsed), options);
  } catch (error) {
    return fallbackStatus({
      configured: true,
      code: error?.code || "MONITOR_STATUS_UNAVAILABLE",
    });
  }
}

module.exports = {
  CHECK_IDS,
  DEFAULT_MAXIMUM_AGE_HOURS,
  DEFAULT_STATUS_PATH,
  ERROR_CODES,
  FUTURE_TOLERANCE_MS,
  MAX_STATUS_BYTES,
  STATUS_FORMAT,
  STATUS_SCHEMA_VERSION,
  ServerMonitorStatusError,
  diagnosticsFromStatus,
  parseServerMonitorStatus,
  readServerMonitorStatus,
};
