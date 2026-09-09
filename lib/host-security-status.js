"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STATUS_FORMAT = "grabenplaner-host-security-status";
const STATUS_SCHEMA_VERSION = 1;
const DEFAULT_STATUS_PATH = "/var/lib/grabenplaner-host-security/status.json";
const MAX_STATUS_BYTES = 16 * 1024;
const DEFAULT_MAXIMUM_AGE_HOURS = 36;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const STATES = new Set(["ok", "warning", "error"]);
const CHECK_IDS = Object.freeze([
  "ssh",
  "firewall",
  "publicPorts",
  "automaticUpdates",
  "sysctl",
  "journald",
  "accountProtection",
  "secretFiles",
  "failedUnits",
  "timeSync",
]);
const CHECK_LABELS = Object.freeze({
  ssh: "SSH-Schlüsselzugang",
  firewall: "UFW-Firewall",
  publicPorts: "Trennung öffentlicher und interner Ports",
  automaticUpdates: "Sicherheitsaktualisierungen",
  sysctl: "Kernel-Schutzwerte",
  journald: "Systemprotokolle",
  accountProtection: "Dienstkonten",
  secretFiles: "Geheimnisdateien",
  failedUnits: "Systemdienste",
  timeSync: "Zeitsynchronisierung",
});
const TOP_LEVEL_KEYS = new Set([
  "format",
  "schemaVersion",
  "checkedAt",
  "state",
  "configured",
  "pendingConfirmation",
  "rebootRequired",
  "checks",
]);

class HostSecurityStatusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostSecurityStatusError";
    this.code = code;
  }
}

function statusError(code, message) {
  return new HostSecurityStatusError(code, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw statusError("HOST_SECURITY_STATUS_SCHEMA_INVALID", `${label} ist kein gueltiges Objekt.`);
  const keys = Object.keys(value);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw statusError("HOST_SECURITY_STATUS_SCHEMA_INVALID", `${label} entspricht nicht dem freigegebenen Schema.`);
  }
}

function normalizeTimestamp(value) {
  if (typeof value !== "string") throw statusError("HOST_SECURITY_STATUS_SCHEMA_INVALID", "Der Pruefzeitpunkt fehlt.");
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/);
  if (!match) throw statusError("HOST_SECURITY_STATUS_SCHEMA_INVALID", "Der Pruefzeitpunkt ist ungueltig.");
  const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${String(match[7] || "").padEnd(3, "0").slice(0, 3)}Z`;
  const milliseconds = Date.parse(canonical);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== canonical) {
    throw statusError("HOST_SECURITY_STATUS_SCHEMA_INVALID", "Der Pruefzeitpunkt ist ungueltig.");
  }
  return canonical;
}

function parseHostSecurityStatus(value) {
  assertExactKeys(value, TOP_LEVEL_KEYS, "Der Host-Sicherheitsstatus");
  if (value.format !== STATUS_FORMAT || value.schemaVersion !== STATUS_SCHEMA_VERSION || !STATES.has(value.state)) {
    throw statusError("HOST_SECURITY_STATUS_SCHEMA_INVALID", "Format, Schemaversion oder Zustand ist ungueltig.");
  }
  if (![value.configured, value.pendingConfirmation, value.rebootRequired].every((item) => typeof item === "boolean")) {
    throw statusError("HOST_SECURITY_STATUS_SCHEMA_INVALID", "Eine Sicherheitsstatus-Angabe ist ungueltig.");
  }
  assertExactKeys(value.checks, new Set(CHECK_IDS), "Die Host-Sicherheitspruefungen");
  const checks = {};
  for (const id of CHECK_IDS) {
    if (typeof value.checks[id] !== "boolean" && value.checks[id] !== null) {
      throw statusError("HOST_SECURITY_STATUS_SCHEMA_INVALID", "Eine Host-Sicherheitspruefung ist ungueltig.");
    }
    checks[id] = value.checks[id];
  }
  const failedChecks = CHECK_IDS.filter((id) => checks[id] === false);
  if (value.state === "ok" && (!value.configured || value.pendingConfirmation || value.rebootRequired
    || failedChecks.length || CHECK_IDS.some((id) => checks[id] !== true))) {
    throw statusError("HOST_SECURITY_STATUS_SCHEMA_INVALID", "Der erfolgreiche Host-Sicherheitsstatus ist widerspruechlich.");
  }
  if (value.pendingConfirmation && !value.configured) {
    throw statusError("HOST_SECURITY_STATUS_SCHEMA_INVALID", "Eine offene Bestaetigung benoetigt eine konfigurierte Absicherung.");
  }
  return {
    format: STATUS_FORMAT,
    schemaVersion: STATUS_SCHEMA_VERSION,
    checkedAt: normalizeTimestamp(value.checkedAt),
    state: value.state,
    configured: value.configured,
    pendingConfirmation: value.pendingConfirmation,
    rebootRequired: value.rebootRequired,
    checks,
  };
}

function resolveStatusPath(candidate) {
  const value = String(candidate || process.env.GRABENPLANER_HOST_SECURITY_STATUS_FILE || DEFAULT_STATUS_PATH);
  if (!value || value.includes("\0") || !path.isAbsolute(value)) {
    throw statusError("HOST_SECURITY_STATUS_PATH_INVALID", "Der Host-Sicherheitsstatuspfad ist ungueltig.");
  }
  return path.resolve(value);
}

function readStatusFile(statusPath, { maximumBytes, requireRootOwner }) {
  let descriptor;
  try {
    const before = fs.lstatSync(statusPath);
    if (!before.isFile() || before.isSymbolicLink()) throw statusError("HOST_SECURITY_STATUS_FILE_UNSAFE", "Der Host-Sicherheitsstatus ist keine regulaere Datei.");
    descriptor = fs.openSync(statusPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_CLOEXEC || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > maximumBytes
      || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw statusError("HOST_SECURITY_STATUS_FILE_UNSAFE", "Der Host-Sicherheitsstatus ist unvollstaendig oder wurde ausgetauscht.");
    }
    if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
      throw statusError("HOST_SECURITY_STATUS_FILE_PERMISSIONS_INVALID", "Der Host-Sicherheitsstatus darf nicht durch Gruppe oder andere Benutzer beschreibbar sein.");
    }
    if (requireRootOwner && typeof stat.uid === "number" && stat.uid !== 0) {
      throw statusError("HOST_SECURITY_STATUS_FILE_OWNER_INVALID", "Der Host-Sicherheitsstatus muss root gehoeren.");
    }
    return fs.readFileSync(descriptor, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if (error instanceof HostSecurityStatusError) throw error;
    if (error?.code === "ENOENT") throw statusError("HOST_SECURITY_STATUS_FILE_MISSING", "Der Host-Sicherheitsstatus fehlt.");
    throw statusError("HOST_SECURITY_STATUS_FILE_UNREADABLE", "Der Host-Sicherheitsstatus ist nicht sicher lesbar.");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fallbackStatus(configured, code = null) {
  return {
    configured: configured === true,
    statusAvailable: false,
    state: configured === true ? "error" : "unconfigured",
    checkedAt: null,
    ageHours: null,
    pendingConfirmation: false,
    rebootRequired: false,
    checks: null,
    failedChecks: [],
    unknownChecks: [],
    lastErrorCode: configured === true ? (code || "HOST_SECURITY_STATUS_UNAVAILABLE") : null,
  };
}

function readHostSecurityStatus(options = {}) {
  let statusPath;
  try { statusPath = resolveStatusPath(options.statusPath); }
  catch (error) { return fallbackStatus(options.configured === true, error.code); }
  const configured = options.configured === true
    || (options.configured === undefined && (String(process.env.GRABENPLANER_HOST_SECURITY_CONFIGURED || "").trim() === "1" || fs.existsSync(statusPath)));
  if (!configured) return fallbackStatus(false);
  const requireRootOwner = options.requireRootOwner === undefined
    ? process.platform === "linux" && process.env.NODE_ENV === "production"
    : options.requireRootOwner === true;
  try {
    const raw = readStatusFile(statusPath, { maximumBytes: MAX_STATUS_BYTES, requireRootOwner });
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw statusError("HOST_SECURITY_STATUS_JSON_INVALID", "Der Host-Sicherheitsstatus enthaelt kein gueltiges JSON."); }
    const status = parseHostSecurityStatus(parsed);
    const now = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
    const ageMs = (Number.isFinite(now) ? now : Date.now()) - Date.parse(status.checkedAt);
    const future = ageMs < -FUTURE_TOLERANCE_MS;
    const ageHours = future ? null : Math.round(Math.max(0, ageMs) / 36000) / 100;
    const maximumAgeHours = Number.isFinite(Number(options.maximumAgeHours))
      ? Math.min(168, Math.max(1, Number(options.maximumAgeHours))) : DEFAULT_MAXIMUM_AGE_HOURS;
    const stale = future || ageMs > maximumAgeHours * 60 * 60 * 1000;
    return {
      ...status,
      statusAvailable: true,
      state: status.state === "ok" && (future || stale) ? "warning" : status.state,
      ageHours,
      failedChecks: CHECK_IDS.filter((id) => status.checks[id] === false),
      unknownChecks: CHECK_IDS.filter((id) => status.checks[id] === null),
      lastErrorCode: future ? "HOST_SECURITY_STATUS_TIMESTAMP_FUTURE"
        : stale ? "HOST_SECURITY_STATUS_STALE" : null,
    };
  } catch (error) {
    return fallbackStatus(true, error?.code || "HOST_SECURITY_STATUS_UNAVAILABLE");
  }
}

function buildHostSecurityAlerts(status = {}) {
  if (!status.configured) return [];
  const alerts = [];
  const add = (id, severity, title, message) => alerts.push({ id, severity, title, message, category: "security" });
  if (status.statusAvailable !== true) {
    add("HOST_SECURITY_ATTENTION", "critical", "Ubuntu-Host-Prüfung nicht verfügbar",
      "Der geschützte Ubuntu-Host-Status ist nicht verfügbar. Sicherheitszustand und Neustartbedarf sind nicht bestätigt.");
    return alerts;
  }
  const failed = CHECK_IDS.filter((id) => status.failedChecks?.includes(id));
  const unknown = CHECK_IDS.filter((id) => status.unknownChecks?.includes(id));
  const securityFailures = failed.filter((id) => id !== "failedUnits");
  if (securityFailures.length) {
    add("HOST_SECURITY_ATTENTION", status.state === "error" ? "critical" : "warning", "Ubuntu-Host-Sicherheit prüfen",
      `Der letzte Audit meldet Abweichungen: ${securityFailures.map((id) => CHECK_LABELS[id]).join(", ")}. Diese Prüfpunkte müssen gesondert geklärt werden.`);
  }
  if (failed.includes("failedUnits")) {
    add("HOST_SERVICES_ATTENTION", "warning", "Fehlgeschlagene Ubuntu-Dienste prüfen",
      "Der letzte Audit meldet fehlgeschlagene Systemdienste. Zeitpunkt, Ursache und einen erfolgreichen Folgelauf prüfen; gespeicherte Fehlerzustände werden nicht automatisch gelöscht.");
  }
  if (unknown.length) {
    add("HOST_SECURITY_CHECK_INCOMPLETE", "warning", "Ubuntu-Host-Prüfung unvollständig",
      `Noch nicht bestätigt: ${unknown.map((id) => CHECK_LABELS[id]).join(", ")}. Nach Klärung des Dienstzustands erneut prüfen.`);
  }
  if (status.pendingConfirmation) {
    add("HOST_SECURITY_CONFIRMATION_PENDING", "warning", "Ubuntu-Sicherheitsänderung bestätigen",
      "Eine Host-Sicherheitstransaktion wartet auf die Bestätigung aus einer zweiten SSH-Sitzung oder wird automatisch zurückgesetzt.");
  }
  if (status.lastErrorCode) {
    add("HOST_SECURITY_STATUS_UNVERIFIED", "warning", "Ubuntu-Host-Prüfung aktualisieren",
      "Der gespeicherte Audit ist veraltet oder sein Zeitstempel ist unplausibel. Die Befunde beziehen sich auf die letzte Prüfung; vor einer Wartung ist ein aktueller Audit erforderlich.");
  }
  // An unexplained audit error must remain visible, even alongside a reboot hint.
  if ((status.state === "error" && securityFailures.length === 0)
    || (status.state !== "ok" && alerts.length === 0 && !status.rebootRequired)) {
    add("HOST_SECURITY_ATTENTION", status.state === "error" ? "critical" : "warning", "Ubuntu-Host-Sicherheit prüfen",
      "Der letzte Ubuntu-Host-Audit benötigt Aufmerksamkeit. Die Ursache ist anhand des geschützten Auditprotokolls zu klären.");
  }
  if (status.rebootRequired) {
    add("HOST_REBOOT_REQUIRED", "warning", "Ubuntu-Wartungsneustart erforderlich",
      "Für eingespielte Ubuntu-Sicherheitsaktualisierungen ist ein vollständiger kontrollierter Neustart des Ubuntu-VPS im Wartungsfenster erforderlich. Ein Neustart des Grabenplaner-Dienstes genügt nicht.");
  }
  return alerts;
}

module.exports = {
  CHECK_IDS,
  DEFAULT_MAXIMUM_AGE_HOURS,
  DEFAULT_STATUS_PATH,
  HostSecurityStatusError,
  buildHostSecurityAlerts,
  parseHostSecurityStatus,
  readHostSecurityStatus,
};
