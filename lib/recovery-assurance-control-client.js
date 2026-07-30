"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_SOCKET_PATH = "/run/grabenplaner-assurance-control/request.sock";
const REQUEST_FORMAT = "grabenplaner-assurance-control-request";
const RESPONSE_FORMAT = "grabenplaner-assurance-control-response";
const SCHEMA_VERSION = 2;
const MAX_RESPONSE_BYTES = 4 * 1024;
const REQUEST_KEYS = new Set(["action", "format", "requestId", "schemaVersion"]);
const RESPONSE_KEYS = new Set([
  "accepted", "acceptedAt", "code", "format", "requestId", "retryAfterSeconds", "scheduler", "schemaVersion",
]);
const SCHEDULER_KEYS = new Set([
  "checkedAt", "evidenceTrusted", "nextElapse", "timerEnabled", "timerInstalled",
]);
const RESPONSE_CODES = new Set([
  "ASSURANCE_CONTROL_READY",
  "ASSURANCE_REQUEST_ACCEPTED",
  "ASSURANCE_REQUEST_BUSY",
  "ASSURANCE_REQUEST_RATE_LIMITED",
  "ASSURANCE_REQUEST_INVALID",
  "ASSURANCE_CONTROL_FAILED",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class RecoveryAssuranceControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RecoveryAssuranceControlError";
    this.code = code;
  }
}

function controlError(code, message) {
  return new RecoveryAssuranceControlError(code, message);
}

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function canonicalUtcTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function buildRequest(requestId, action = "start-manual-assurance") {
  if (!UUID_PATTERN.test(String(requestId || ""))) {
    throw controlError("ASSURANCE_CONTROL_REQUEST_INVALID", "Die interne RAS-Anforderungskennung ist ungueltig.");
  }
  if (!["start-manual-assurance", "status"].includes(action)) {
    throw controlError("ASSURANCE_CONTROL_REQUEST_INVALID", "Die interne RAS-Aktion ist ungueltig.");
  }
  const request = {
    format: REQUEST_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    action,
    requestId,
  };
  if (!exactKeys(request, REQUEST_KEYS)) throw controlError("ASSURANCE_CONTROL_REQUEST_INVALID", "Die interne RAS-Anforderung ist ungueltig.");
  return `${JSON.stringify(request)}\n`;
}

function untrustedScheduler() {
  return {
    evidenceTrusted: false,
    timerInstalled: false,
    timerEnabled: false,
    nextElapse: null,
    checkedAt: null,
  };
}

function parseScheduler(value) {
  if (!exactKeys(value, SCHEDULER_KEYS)
    || typeof value.evidenceTrusted !== "boolean"
    || typeof value.timerInstalled !== "boolean"
    || typeof value.timerEnabled !== "boolean"
    || (value.nextElapse !== null && !canonicalUtcTimestamp(value.nextElapse))
    || (value.checkedAt !== null && !canonicalUtcTimestamp(value.checkedAt))) {
    throw controlError("ASSURANCE_CONTROL_RESPONSE_INVALID", "Der RAS-Scheduler-Nachweis ist ungueltig.");
  }
  if ((!value.evidenceTrusted && (value.timerInstalled || value.timerEnabled
      || value.nextElapse !== null || value.checkedAt !== null))
    || (value.timerEnabled && !value.timerInstalled)
    || (value.evidenceTrusted && value.checkedAt === null)
    || (value.timerInstalled && value.timerEnabled && value.nextElapse === null)
    || (!value.timerInstalled && (value.timerEnabled || value.nextElapse !== null))) {
    throw controlError("ASSURANCE_CONTROL_RESPONSE_INVALID", "Der RAS-Scheduler-Nachweis ist widerspruechlich.");
  }
  return {
    evidenceTrusted: value.evidenceTrusted,
    timerInstalled: value.timerInstalled,
    timerEnabled: value.timerEnabled,
    nextElapse: value.nextElapse,
    checkedAt: value.checkedAt,
  };
}

function parseResponse(buffer, expectedRequestId) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer.length > MAX_RESPONSE_BYTES || buffer.includes(0)) {
    throw controlError("ASSURANCE_CONTROL_RESPONSE_INVALID", "Die RAS-Steuerung hat keine gueltige Antwort geliefert.");
  }
  const text = buffer.toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r")) {
    throw controlError("ASSURANCE_CONTROL_RESPONSE_INVALID", "Die RAS-Steuerungsantwort ist ungueltig formatiert.");
  }
  let value;
  try { value = JSON.parse(text.slice(0, -1)); }
  catch { throw controlError("ASSURANCE_CONTROL_RESPONSE_INVALID", "Die RAS-Steuerungsantwort ist kein gueltiges JSON."); }
  if (!exactKeys(value, RESPONSE_KEYS)
    || value.format !== RESPONSE_FORMAT || value.schemaVersion !== SCHEMA_VERSION
    || value.requestId !== expectedRequestId || !UUID_PATTERN.test(String(value.requestId || ""))
    || typeof value.accepted !== "boolean" || !RESPONSE_CODES.has(value.code)
    || (value.acceptedAt !== null && !canonicalUtcTimestamp(value.acceptedAt))
    || (value.retryAfterSeconds !== null
      && (!Number.isSafeInteger(value.retryAfterSeconds) || value.retryAfterSeconds < 1 || value.retryAfterSeconds > 900))) {
    throw controlError("ASSURANCE_CONTROL_RESPONSE_INVALID", "Die RAS-Steuerungsantwort entspricht nicht dem freigegebenen Schema.");
  }
  value.scheduler = parseScheduler(value.scheduler);
  if ((value.accepted && (value.code !== "ASSURANCE_REQUEST_ACCEPTED" || value.acceptedAt === null || value.retryAfterSeconds !== null))
    || (!value.accepted && value.code === "ASSURANCE_REQUEST_ACCEPTED")
    || (value.code === "ASSURANCE_REQUEST_RATE_LIMITED") !== (value.retryAfterSeconds !== null)
    || (!value.accepted && value.acceptedAt !== null)) {
    throw controlError("ASSURANCE_CONTROL_RESPONSE_INVALID", "Die RAS-Steuerungsantwort ist widerspruechlich.");
  }
  return value;
}

function assertSafeSocket(socketPath, options = {}) {
  const resolved = path.resolve(String(socketPath || ""));
  const parent = path.dirname(resolved);
  if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root
    || path.basename(resolved) !== "request.sock") {
    throw controlError("ASSURANCE_CONTROL_SOCKET_UNSAFE", "Der RAS-Steuerungssocket ist ungueltig.");
  }
  let parentStat;
  let socketStat;
  try {
    parentStat = fs.lstatSync(parent);
    socketStat = fs.lstatSync(resolved);
  } catch {
    throw controlError("ASSURANCE_CONTROL_UNAVAILABLE", "Die RAS-Steuerung ist nicht verfuegbar.");
  }
  const requireRootOwner = options.requireRootOwner !== false;
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.nlink < 2
    || (process.platform !== "win32" && ((parentStat.mode & 0o7777) !== 0o755 || (parentStat.mode & 0o022) !== 0))
    || (requireRootOwner && typeof parentStat.uid === "number" && (parentStat.uid !== 0 || parentStat.gid !== 0))) {
    throw controlError("ASSURANCE_CONTROL_SOCKET_UNSAFE", "Der RAS-Steuerungspfad ist nicht sicher.");
  }
  const expectedGid = Number.isSafeInteger(options.expectedGid) ? options.expectedGid : null;
  const processGroups = process.platform === "win32" || typeof process.getgroups !== "function" ? [] : process.getgroups();
  if (!socketStat.isSocket() || socketStat.isSymbolicLink() || socketStat.nlink !== 1
    || (process.platform !== "win32" && (socketStat.mode & 0o7777) !== 0o660)
    || (requireRootOwner && typeof socketStat.uid === "number" && socketStat.uid !== 0)
    || (process.platform !== "win32" && typeof socketStat.gid === "number"
      && (socketStat.gid === 0 || (expectedGid !== null ? socketStat.gid !== expectedGid : !processGroups.includes(socketStat.gid))))) {
    throw controlError("ASSURANCE_CONTROL_SOCKET_UNSAFE", "Der RAS-Steuerungssocket besitzt unsichere Rechte.");
  }
  return resolved;
}

function exchange(socketPath, payload, expectedRequestId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath, allowHalfOpen: true });
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.end(payload));
    socket.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        finish(controlError("ASSURANCE_CONTROL_RESPONSE_INVALID", "Die RAS-Steuerungsantwort ist zu gross."));
        return;
      }
      chunks.push(chunk);
    });
    socket.on("timeout", () => finish(controlError("ASSURANCE_CONTROL_TIMEOUT", "Die RAS-Steuerung hat nicht rechtzeitig geantwortet.")));
    socket.on("error", () => finish(controlError("ASSURANCE_CONTROL_UNAVAILABLE", "Die RAS-Steuerung ist nicht erreichbar.")));
    socket.on("end", () => {
      try { finish(null, parseResponse(Buffer.concat(chunks), expectedRequestId)); }
      catch (error) { finish(error); }
    });
  });
}

async function requestRecoveryAssuranceRun(options = {}) {
  if (process.platform !== "linux" && options.allowNonLinux !== true) {
    throw controlError("ASSURANCE_CONTROL_UNAVAILABLE", "Die RAS-Steuerung ist nur im Linux-Serverbetrieb verfuegbar.");
  }
  const requestId = String(options.requestId || "");
  const socketPath = assertSafeSocket(options.socketPath || DEFAULT_SOCKET_PATH, options);
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? Math.max(500, Math.min(options.timeoutMs, 10_000)) : 5_000;
  const result = await exchange(socketPath, buildRequest(requestId), requestId, timeoutMs);
  if (!result.accepted) {
    const publicCode = result.code === "ASSURANCE_REQUEST_BUSY"
      ? "BUSY"
      : result.code === "ASSURANCE_REQUEST_RATE_LIMITED" ? "RATE_LIMITED" : "UNAVAILABLE";
    const error = controlError(publicCode, "Der manuelle Recovery-Assurance-Lauf konnte nicht gestartet werden.");
    if (result.retryAfterSeconds !== null) error.retryAfterSeconds = result.retryAfterSeconds;
    throw error;
  }
  return result;
}

async function recoveryAssuranceControlStatus(options = {}) {
  const requestId = String(options.requestId || crypto.randomUUID());
  try {
    if (process.platform !== "linux" && options.allowNonLinux !== true) {
      return { available: false, busy: false, reason: "ASSURANCE_CONTROL_UNAVAILABLE", scheduler: untrustedScheduler() };
    }
    const socketPath = assertSafeSocket(options.socketPath || DEFAULT_SOCKET_PATH, options);
    const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? Math.max(500, Math.min(options.timeoutMs, 10_000)) : 3_000;
    const result = await exchange(socketPath, buildRequest(requestId, "status"), requestId, timeoutMs);
    if (result.code === "ASSURANCE_CONTROL_READY") {
      return { available: true, busy: false, reason: null, scheduler: result.scheduler };
    }
    if (result.code === "ASSURANCE_REQUEST_BUSY") {
      return { available: true, busy: true, reason: "ASSURANCE_REQUEST_BUSY", scheduler: result.scheduler };
    }
    return { available: false, busy: false, reason: result.code, scheduler: result.scheduler };
  } catch (error) {
    return {
      available: false,
      busy: false,
      reason: String(error?.code || "ASSURANCE_CONTROL_UNAVAILABLE"),
      scheduler: untrustedScheduler(),
    };
  }
}

module.exports = {
  DEFAULT_SOCKET_PATH,
  MAX_RESPONSE_BYTES,
  REQUEST_FORMAT,
  RESPONSE_FORMAT,
  SCHEMA_VERSION,
  RecoveryAssuranceControlError,
  assertSafeSocket,
  buildRequest,
  parseResponse,
  parseScheduler,
  recoveryAssuranceControlStatus,
  requestRecoveryAssuranceRun,
  untrustedScheduler,
};
