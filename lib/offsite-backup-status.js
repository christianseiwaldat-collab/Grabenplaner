"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STATUS_FORMAT = "grabenplaner-offsite-backup-status";
const STATUS_SCHEMA_VERSION = 1;
const DEFAULT_STATUS_PATH = "/var/lib/grabenplaner-offsite/status.json";
const MAX_STATUS_BYTES = 64 * 1024;
const MAX_ERROR_SUMMARY_CHARACTERS = 320;
const DEFAULT_RETENTION = Object.freeze({ daily: 14, weekly: 8, monthly: 12 });
const STATUS_STATES = new Set(["ok", "warning", "error", "unconfigured"]);
const TOP_LEVEL_KEYS = new Set([
  "format",
  "schemaVersion",
  "configured",
  "state",
  "generatedAt",
  "lastAttemptAt",
  "lastSuccessAt",
  "lastSnapshotId",
  "lastRepositoryCheckAt",
  "lastFullCheckAt",
  "lastRestoreTestAt",
  "lastFailureAt",
  "lastError",
  "unresolvedFailures",
  "retention",
]);
const UNRESOLVED_FAILURE_KEYS = new Set(["backup", "fullCheck", "restoreTest"]);

class OffsiteBackupStatusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OffsiteBackupStatusError";
    this.code = code;
  }
}

function statusError(code, message) {
  return new OffsiteBackupStatusError(code, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw statusError("STATUS_SCHEMA_INVALID", `${label} ist kein gueltiges Objekt.`);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw statusError("STATUS_SCHEMA_INVALID", `${label} enthaelt ein unbekanntes Feld.`);
}

function normalizeTimestamp(value, label, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) throw statusError("STATUS_SCHEMA_INVALID", `${label} fehlt.`);
    return null;
  }
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/);
  if (!match) {
    throw statusError("STATUS_SCHEMA_INVALID", `${label} ist kein UTC-Zeitstempel.`);
  }
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw statusError("STATUS_SCHEMA_INVALID", `${label} ist ungueltig.`);
  const normalized = new Date(milliseconds).toISOString();
  const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${String(match[7] || "").padEnd(3, "0")}Z`;
  if (normalized !== canonical) throw statusError("STATUS_SCHEMA_INVALID", `${label} ist ungueltig.`);
  return normalized;
}

function redactStatusSummary(value) {
  const secretKey = "(?:authorization|oauth[_-]?token|access[_-]?token|refresh[_-]?token|token|password|passwort|secret|client[_-]?secret|credential|api[_-]?key|private[_-]?key)";
  let text = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\bauthorization\s*:\s*[^\r\n,;]+/gi, "Authorization: [entfernt]")
    .replace(/\b(?:authorization\s*:\s*bearer|bearer)\s+[^\s,;]+/gi, "Zugangsdaten entfernt")
    .replace(new RegExp(`(["']?${secretKey}["']?\\s*[:=]\\s*)["'][^"'\\r\\n]{0,4096}["']`, "gi"), "$1\"[entfernt]\"")
    .replace(new RegExp(`\\b(${secretKey}\\s*[:=]\\s*)(?!["'])[^,;\\r\\n]+`, "gi"), "$1[entfernt]")
    .replace(/\brclone:[^\s"'`]+/gi, "[Backupziel entfernt]")
    .replace(/\bhttps?:\/\/[^\s"'`]+/gi, "[Adresse entfernt]")
    .replace(/\b[A-Za-z][A-Za-z0-9._-]{1,31}:[^\s"'`]{4,}/g, "[Backupziel entfernt]")
    .replace(/(["'])(?:[A-Za-z]:\\|\\\\|\/)[^"'\r\n]+\1/g, "$1[Pfad entfernt]$1")
    .replace(/\\\\[^\s\\"'`]+\\[^\s"'`]+/g, "[Pfad entfernt]")
    .replace(/\b[A-Za-z]:\\[^,;\r\n]+/g, "[Pfad entfernt]")
    .replace(/(^|[\s(])\/(?!\/)[^,;\r\n]+/g, "$1[Pfad entfernt]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[Konto entfernt]")
    .replace(/\b(?:[a-f0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2})\b/gi, "[Kennung entfernt]")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) text = "Offsite-Vorgang fehlgeschlagen.";
  return text.slice(0, MAX_ERROR_SUMMARY_CHARACTERS);
}

function normalizeLastError(value) {
  if (value === null || value === undefined) return null;
  assertExactKeys(value, new Set(["code", "summary"]), "Der letzte Fehler");
  if (!Object.hasOwn(value, "code") || !Object.hasOwn(value, "summary")
    || typeof value.summary !== "string" || !value.summary.trim()
    || Buffer.byteLength(value.summary, "utf8") > 4096) {
    throw statusError("STATUS_SCHEMA_INVALID", "Die redigierbare Fehlerangabe ist ungueltig.");
  }
  const code = String(value.code || "");
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
    throw statusError("STATUS_SCHEMA_INVALID", "Der Fehlercode ist ungueltig.");
  }
  return { code, summary: redactStatusSummary(value.summary) };
}

function normalizeUnresolvedFailures(value) {
  assertExactKeys(value, UNRESOLVED_FAILURE_KEYS, "Die offenen Offsite-Fehlerbereiche");
  for (const key of UNRESOLVED_FAILURE_KEYS) {
    if (!Object.hasOwn(value, key) || typeof value[key] !== "boolean") {
      throw statusError("STATUS_SCHEMA_INVALID", "Die offenen Offsite-Fehlerbereiche sind unvollstaendig.");
    }
  }
  return { backup: value.backup, fullCheck: value.fullCheck, restoreTest: value.restoreTest };
}

function failureArea(code) {
  if (/^(?:FULL_CHECK_FAILED|FULL_CHECK_REPOSITORY_ID_MISMATCH)$/.test(String(code || ""))) return "fullCheck";
  if (/^(?:RESTORE_TEST_FAILED|RESTORE_TEST_REPOSITORY_ID_MISMATCH)$/.test(String(code || ""))) return "restoreTest";
  return "backup";
}

function normalizeRetention(value) {
  assertExactKeys(value, new Set(["daily", "weekly", "monthly"]), "Die Aufbewahrung");
  const retention = {
    daily: value.daily,
    weekly: value.weekly,
    monthly: value.monthly,
  };
  if (!Object.values(retention).every(Number.isSafeInteger)
    || retention.daily !== DEFAULT_RETENTION.daily
    || retention.weekly !== DEFAULT_RETENTION.weekly
    || retention.monthly !== DEFAULT_RETENTION.monthly) {
    throw statusError("STATUS_SCHEMA_INVALID", "Die Aufbewahrung entspricht nicht der freigegebenen 14/8/12-Regel.");
  }
  return retention;
}

function parseOffsiteBackupStatus(value) {
  assertExactKeys(value, TOP_LEVEL_KEYS, "Der Offsite-Backup-Status");
  for (const key of TOP_LEVEL_KEYS) {
    if (!Object.hasOwn(value, key)) throw statusError("STATUS_SCHEMA_INVALID", "Der Offsite-Backup-Status ist unvollstaendig.");
  }
  if (value.format !== STATUS_FORMAT || value.schemaVersion !== STATUS_SCHEMA_VERSION || typeof value.configured !== "boolean") {
    throw statusError("STATUS_SCHEMA_INVALID", "Format, Schemaversion oder Konfigurationsstatus ist ungueltig.");
  }
  if (!STATUS_STATES.has(value.state)
    || (value.configured && value.state === "unconfigured")
    || (!value.configured && value.state !== "unconfigured")) {
    throw statusError("STATUS_SCHEMA_INVALID", "Der Offsite-Backup-Zustand ist ungueltig.");
  }

  const normalized = {
    format: STATUS_FORMAT,
    schemaVersion: STATUS_SCHEMA_VERSION,
    configured: value.configured,
    state: value.state,
    generatedAt: normalizeTimestamp(value.generatedAt, "generatedAt", { required: true }),
    lastAttemptAt: normalizeTimestamp(value.lastAttemptAt, "lastAttemptAt"),
    lastSuccessAt: normalizeTimestamp(value.lastSuccessAt, "lastSuccessAt"),
    lastSnapshotId: value.lastSnapshotId === null || value.lastSnapshotId === undefined || value.lastSnapshotId === ""
      ? null
      : String(value.lastSnapshotId).toLowerCase(),
    lastRepositoryCheckAt: normalizeTimestamp(value.lastRepositoryCheckAt, "lastRepositoryCheckAt"),
    lastFullCheckAt: normalizeTimestamp(value.lastFullCheckAt, "lastFullCheckAt"),
    lastRestoreTestAt: normalizeTimestamp(value.lastRestoreTestAt, "lastRestoreTestAt"),
    lastFailureAt: normalizeTimestamp(value.lastFailureAt, "lastFailureAt"),
    lastError: normalizeLastError(value.lastError),
    unresolvedFailures: normalizeUnresolvedFailures(value.unresolvedFailures),
    retention: normalizeRetention(value.retention),
  };

  if (normalized.lastSnapshotId && !/^[a-f0-9]{8,64}$/.test(normalized.lastSnapshotId)) {
    throw statusError("STATUS_SCHEMA_INVALID", "Die Restic-Snapshot-Kennung ist ungueltig.");
  }
  if (Boolean(normalized.lastSuccessAt) !== Boolean(normalized.lastSnapshotId)) {
    throw statusError("STATUS_SCHEMA_INVALID", "Erfolgszeitpunkt und Snapshot-Kennung muessen gemeinsam vorliegen.");
  }
  if (Boolean(normalized.lastFailureAt) !== Boolean(normalized.lastError)) {
    throw statusError("STATUS_SCHEMA_INVALID", "Fehlerzeitpunkt und Fehlerangabe muessen gemeinsam vorliegen.");
  }
  if ((normalized.lastSuccessAt || normalized.lastFailureAt) && !normalized.lastAttemptAt) {
    throw statusError("STATUS_SCHEMA_INVALID", "Zu einem Ergebnis fehlt der letzte Versuch.");
  }
  if (normalized.state === "ok" && !normalized.lastSuccessAt) {
    throw statusError("STATUS_SCHEMA_INVALID", "Ein erfolgreicher Zustand benoetigt einen bestaetigten Snapshot.");
  }
  if (normalized.state === "error" && !normalized.lastFailureAt) {
    throw statusError("STATUS_SCHEMA_INVALID", "Ein Fehlerzustand benoetigt eine redigierbare Fehlerangabe.");
  }
  const hasUnresolvedFailure = Object.values(normalized.unresolvedFailures).some(Boolean);
  if ((normalized.state === "error") !== hasUnresolvedFailure) {
    throw statusError("STATUS_SCHEMA_INVALID", "Status und offene Offsite-Fehlerbereiche widersprechen einander.");
  }
  if (!normalized.configured && [
    normalized.lastAttemptAt,
    normalized.lastSuccessAt,
    normalized.lastSnapshotId,
    normalized.lastRepositoryCheckAt,
    normalized.lastFullCheckAt,
    normalized.lastRestoreTestAt,
    normalized.lastFailureAt,
    normalized.lastError,
    ...Object.values(normalized.unresolvedFailures),
  ].some(Boolean)) {
    throw statusError("STATUS_SCHEMA_INVALID", "Ein nicht eingerichteter Status darf keine Betriebsdaten enthalten.");
  }

  const generatedMs = Date.parse(normalized.generatedAt);
  const futureToleranceMs = 5 * 60 * 1000;
  for (const timestamp of [
    normalized.lastAttemptAt,
    normalized.lastSuccessAt,
    normalized.lastRepositoryCheckAt,
    normalized.lastFullCheckAt,
    normalized.lastRestoreTestAt,
    normalized.lastFailureAt,
  ].filter(Boolean)) {
    if (Date.parse(timestamp) > generatedMs + futureToleranceMs) {
      throw statusError("STATUS_SCHEMA_INVALID", "Ein Betriebszeitpunkt liegt unplausibel nach dem Statuszeitpunkt.");
    }
  }
  if (normalized.lastAttemptAt && normalized.lastSuccessAt
    && Date.parse(normalized.lastSuccessAt) > Date.parse(normalized.lastAttemptAt) + futureToleranceMs) {
    throw statusError("STATUS_SCHEMA_INVALID", "Der Erfolgszeitpunkt liegt nach dem letzten Versuch.");
  }
  if (normalized.lastAttemptAt && normalized.lastFailureAt
    && Date.parse(normalized.lastFailureAt) > Date.parse(normalized.lastAttemptAt) + futureToleranceMs) {
    throw statusError("STATUS_SCHEMA_INVALID", "Der Fehlerzeitpunkt liegt nach dem letzten Versuch.");
  }
  return normalized;
}

function configuredOption(value) {
  if (value === undefined) return undefined;
  return value === true;
}

function resolveStatusPath(statusPath) {
  const candidate = String(statusPath || process.env.GRABENPLANER_OFFSITE_STATUS_FILE || DEFAULT_STATUS_PATH);
  if (!candidate || candidate.includes("\0") || !path.isAbsolute(candidate)) {
    throw statusError("STATUS_PATH_INVALID", "Der Offsite-Statuspfad ist ungueltig.");
  }
  return path.resolve(candidate);
}

function readStatusFile(statusPath, { maximumBytes, requireRootOwner }) {
  let descriptor;
  try {
    const before = fs.lstatSync(statusPath);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw statusError("STATUS_FILE_UNSAFE", "Der Offsite-Status ist keine regulaere Datei.");
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_CLOEXEC || 0);
    descriptor = fs.openSync(statusPath, flags);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > maximumBytes || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw statusError("STATUS_FILE_SIZE_INVALID", "Der Offsite-Status hat eine unzulaessige Groesse oder wurde ausgetauscht.");
    }
    if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
      throw statusError("STATUS_FILE_PERMISSIONS_INVALID", "Der Offsite-Status darf nicht durch Gruppe oder andere Benutzer beschreibbar sein.");
    }
    if (requireRootOwner && typeof stat.uid === "number" && stat.uid !== 0) {
      throw statusError("STATUS_FILE_OWNER_INVALID", "Der Offsite-Status muss root gehoeren.");
    }
    const content = fs.readFileSync(descriptor);
    if (content.length <= 0 || content.length > maximumBytes) {
      throw statusError("STATUS_FILE_SIZE_INVALID", "Der Offsite-Status hat eine unzulaessige Groesse.");
    }
    return content.toString("utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if (error instanceof OffsiteBackupStatusError) throw error;
    if (error?.code === "ENOENT") throw statusError("STATUS_FILE_MISSING", "Der Offsite-Status fehlt.");
    throw statusError("STATUS_FILE_UNREADABLE", "Der Offsite-Status ist nicht sicher lesbar.");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ageHours(timestamp, nowMs) {
  if (!timestamp) return null;
  const difference = nowMs - Date.parse(timestamp);
  if (difference < -5 * 60 * 1000) return null;
  return Math.round(Math.max(0, difference) / 36000) / 100;
}

function safeRetention() {
  return { ...DEFAULT_RETENTION };
}

function fallbackDiagnostics({ configured, code = null, summary = null }) {
  const enabled = configured === true;
  return {
    configured: enabled,
    state: enabled ? "error" : "unconfigured",
    statusAvailable: false,
    blocksMainReadiness: false,
    lastSuccessAt: null,
    lastSnapshotId: null,
    lastRepositoryCheckAt: null,
    lastFullCheckAt: null,
    lastRestoreTestAt: null,
    lastAttemptAt: null,
    lastFailureAt: null,
    lastErrorCode: enabled ? (code || "OFFSITE_STATUS_UNAVAILABLE") : null,
    unresolvedFailures: { backup: false, fullCheck: false, restoreTest: false },
    summary: enabled
      ? redactStatusSummary(summary || "Der verschluesselte Offsite-Backup-Status ist nicht sicher lesbar.")
      : "Verschluesseltes Offsite-Backup ist nicht eingerichtet.",
    agesHours: { backup: null, repositoryCheck: null, fullCheck: null, restoreTest: null, attempt: null, failure: null },
    retention: safeRetention(),
  };
}

function diagnosticsFromStatus(status, options = {}) {
  const requestedConfiguration = configuredOption(options.configured);
  if (requestedConfiguration === false && status.configured === true) {
    return fallbackDiagnostics({
      configured: true,
      code: "STATUS_CONFIGURATION_MISMATCH",
      summary: "Der Offsite-Status meldet eine aktive Einrichtung, die Serverkonfiguration jedoch nicht.",
    });
  }
  const configured = requestedConfiguration ?? status.configured;
  if (!configured) return fallbackDiagnostics({ configured: false });
  if (requestedConfiguration === true && status.configured !== true) {
    return fallbackDiagnostics({
      configured: true,
      code: "STATUS_CONFIGURATION_MISMATCH",
      summary: "Der Offsite-Status passt nicht zur aktiven Serverkonfiguration.",
    });
  }

  const nowValue = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
  const nowMs = Number.isFinite(nowValue) ? nowValue : Date.now();
  const maximumBackupAgeHours = Number.isFinite(Number(options.maximumBackupAgeHours))
    ? Math.min(168, Math.max(1, Number(options.maximumBackupAgeHours)))
    : 36;
  const maximumRepositoryCheckAgeHours = Number.isFinite(Number(options.maximumRepositoryCheckAgeHours))
    ? Math.min(168, Math.max(1, Number(options.maximumRepositoryCheckAgeHours)))
    : 36;
  const maximumFullCheckAgeHours = Number.isFinite(Number(options.maximumFullCheckAgeHours))
    ? Math.min(24 * 120, Math.max(24, Number(options.maximumFullCheckAgeHours)))
    : 24 * 40;
  const maximumRestoreTestAgeHours = Number.isFinite(Number(options.maximumRestoreTestAgeHours))
    ? Math.min(24 * 400, Math.max(24, Number(options.maximumRestoreTestAgeHours)))
    : 24 * 100;
  const agesHours = {
    backup: ageHours(status.lastSuccessAt, nowMs),
    repositoryCheck: ageHours(status.lastRepositoryCheckAt, nowMs),
    fullCheck: ageHours(status.lastFullCheckAt, nowMs),
    restoreTest: ageHours(status.lastRestoreTestAt, nowMs),
    attempt: ageHours(status.lastAttemptAt, nowMs),
    failure: ageHours(status.lastFailureAt, nowMs),
  };
  const futureToleranceMs = 5 * 60 * 1000;
  const hasFutureTimestamp = [
    status.generatedAt,
    status.lastAttemptAt,
    status.lastSuccessAt,
    status.lastRepositoryCheckAt,
    status.lastFullCheckAt,
    status.lastRestoreTestAt,
    status.lastFailureAt,
  ].filter(Boolean).some((timestamp) => Date.parse(timestamp) > nowMs + futureToleranceMs);
  const stale = agesHours.backup === null || agesHours.backup > maximumBackupAgeHours
    || agesHours.repositoryCheck === null || agesHours.repositoryCheck > maximumRepositoryCheckAgeHours
    || agesHours.fullCheck === null || agesHours.fullCheck > maximumFullCheckAgeHours
    || agesHours.restoreTest === null || agesHours.restoreTest > maximumRestoreTestAgeHours;
  let state = status.state;
  const unresolvedFailures = { ...status.unresolvedFailures };
  const lastErrorIsUnresolved = Boolean(status.lastError && unresolvedFailures[failureArea(status.lastError.code)]);
  let summary = status.state === "ok"
    ? "Verschluesseltes Offsite-Backup ist aktuell."
    : (lastErrorIsUnresolved ? status.lastError.summary : "Mindestens ein Offsite-Pruefbereich erfordert eine erneute erfolgreiche Ausfuehrung.");
  if (state !== "error" && hasFutureTimestamp) {
    state = "warning";
    summary = "Mindestens ein Offsite-Zeitstempel liegt unplausibel in der Zukunft; Serverzeit und Sicherungsstatus muessen geprueft werden.";
  } else if (state === "ok" && stale) {
    state = "warning";
    summary = "Mindestens eine Offsite-Sicherung oder Wiederherstellungspruefung ist ausstaendig oder zu alt.";
  } else if (state === "warning" && !status.lastError) {
    summary = "Das verschluesselte Offsite-Backup erfordert eine Pruefung.";
  }
  return {
    configured: true,
    state,
    statusAvailable: true,
    blocksMainReadiness: false,
    lastSuccessAt: status.lastSuccessAt,
    lastSnapshotId: status.lastSnapshotId ? status.lastSnapshotId.slice(0, 12) : null,
    lastRepositoryCheckAt: status.lastRepositoryCheckAt,
    lastFullCheckAt: status.lastFullCheckAt,
    lastRestoreTestAt: status.lastRestoreTestAt,
    lastAttemptAt: status.lastAttemptAt,
    lastFailureAt: status.lastFailureAt,
    lastErrorCode: lastErrorIsUnresolved ? status.lastError.code : null,
    unresolvedFailures,
    summary: redactStatusSummary(summary),
    agesHours,
    retention: { ...status.retention },
  };
}

function readOffsiteBackupStatus(options = {}) {
  const configured = configuredOption(options.configured);
  let statusPath;
  try {
    statusPath = resolveStatusPath(options.statusPath);
  } catch (error) {
    return fallbackDiagnostics({ configured: configured ?? true, code: error.code, summary: error.message });
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
    catch { throw statusError("STATUS_JSON_INVALID", "Der Offsite-Status enthaelt kein gueltiges JSON."); }
    return diagnosticsFromStatus(parseOffsiteBackupStatus(parsed), { ...options, configured });
  } catch (error) {
    const missingAndNotConfigured = error?.code === "STATUS_FILE_MISSING" && configured !== true;
    return fallbackDiagnostics({
      configured: missingAndNotConfigured ? false : (configured ?? true),
      code: error?.code || "OFFSITE_STATUS_UNAVAILABLE",
      summary: error instanceof OffsiteBackupStatusError ? error.message : "Der Offsite-Status ist nicht sicher lesbar.",
    });
  }
}

module.exports = {
  DEFAULT_RETENTION,
  DEFAULT_STATUS_PATH,
  MAX_ERROR_SUMMARY_CHARACTERS,
  MAX_STATUS_BYTES,
  OffsiteBackupStatusError,
  STATUS_FORMAT,
  STATUS_SCHEMA_VERSION,
  diagnosticsFromStatus,
  parseOffsiteBackupStatus,
  readOffsiteBackupStatus,
  redactStatusSummary,
};
