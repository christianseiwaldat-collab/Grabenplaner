"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_SOCKET_PATH = "/run/grabenplaner-host-control/request.sock";
const REQUEST_FORMAT = "grabenplaner-host-reboot-request";
const RESPONSE_FORMAT = "grabenplaner-host-reboot-response";
const SCHEMA_VERSION = 1;
const MAX_RESPONSE_BYTES = 2 * 1024;
const REQUEST_KEYS = new Set([
  "action",
  "backupMarkerFileName",
  "format",
  "requestId",
  "schemaVersion",
]);
const RESPONSE_KEYS = new Set([
  "accepted",
  "acceptedAt",
  "code",
  "format",
  "requestId",
  "retryAfterSeconds",
  "schemaVersion",
]);
const RESPONSE_CODES = new Set([
  "HOST_REBOOT_ACCEPTED",
  "HOST_REBOOT_BUSY",
  "HOST_REBOOT_BACKUP_REQUIRED",
  "HOST_REBOOT_CONTROL_FAILED",
  "HOST_REBOOT_MAINTENANCE_BUSY",
  "HOST_REBOOT_NOT_REQUIRED",
  "HOST_REBOOT_RATE_LIMITED",
  "HOST_REBOOT_REQUEST_INVALID",
  "HOST_REBOOT_SECURITY_PENDING",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BACKUP_MARKER_PATTERN = /^dienstplan-[0-9A-Za-z._-]+\.complete\.json$/;

class HostRebootControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostRebootControlError";
    this.code = code;
  }
}

function controlError(code, message) {
  return new HostRebootControlError(code, message);
}

function exactKeys(value, expected) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
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

function buildRequest(requestId, backupMarkerFileName) {
  if (!UUID_PATTERN.test(String(requestId || ""))) {
    throw controlError("HOST_REBOOT_CONTROL_REQUEST_INVALID", "Die interne Host-Reboot-Kennung ist ungueltig.");
  }
  if (!BACKUP_MARKER_PATTERN.test(String(backupMarkerFileName || ""))) {
    throw controlError(
      "HOST_REBOOT_CONTROL_REQUEST_INVALID",
      "Der interne Sicherungsbeleg fuer den VPS-Neustart ist ungueltig.",
    );
  }
  const request = {
    format: REQUEST_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    action: "host-reboot",
    backupMarkerFileName,
    requestId,
  };
  if (!exactKeys(request, REQUEST_KEYS)) {
    throw controlError("HOST_REBOOT_CONTROL_REQUEST_INVALID", "Die interne Host-Reboot-Anforderung ist ungueltig.");
  }
  return `${JSON.stringify(request)}\n`;
}

function parseResponse(buffer, expectedRequestId) {
  if (!Buffer.isBuffer(buffer)
    || buffer.length < 2
    || buffer.length > MAX_RESPONSE_BYTES
    || buffer.includes(0)) {
    throw controlError(
      "HOST_REBOOT_CONTROL_RESPONSE_INVALID",
      "Die geschuetzte Host-Reboot-Steuerung hat keine gueltige Antwort geliefert.",
    );
  }
  const text = buffer.toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r")) {
    throw controlError(
      "HOST_REBOOT_CONTROL_RESPONSE_INVALID",
      "Die Antwort der Host-Reboot-Steuerung ist ungueltig formatiert.",
    );
  }
  let value;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    throw controlError(
      "HOST_REBOOT_CONTROL_RESPONSE_INVALID",
      "Die Antwort der Host-Reboot-Steuerung ist kein gueltiges JSON.",
    );
  }
  if (!exactKeys(value, RESPONSE_KEYS)
    || value.format !== RESPONSE_FORMAT
    || value.schemaVersion !== SCHEMA_VERSION
    || value.requestId !== expectedRequestId
    || !UUID_PATTERN.test(String(value.requestId || ""))
    || typeof value.accepted !== "boolean"
    || !RESPONSE_CODES.has(value.code)
    || (value.acceptedAt !== null && !canonicalUtcTimestamp(value.acceptedAt))
    || (value.retryAfterSeconds !== null
      && (!Number.isSafeInteger(value.retryAfterSeconds)
        || value.retryAfterSeconds < 1
        || value.retryAfterSeconds > 900))) {
    throw controlError(
      "HOST_REBOOT_CONTROL_RESPONSE_INVALID",
      "Die Host-Reboot-Antwort entspricht nicht dem freigegebenen Schema.",
    );
  }
  if ((value.accepted
      && (value.code !== "HOST_REBOOT_ACCEPTED"
        || value.acceptedAt === null
        || value.retryAfterSeconds !== null))
    || (!value.accepted && value.code === "HOST_REBOOT_ACCEPTED")
    || (value.code === "HOST_REBOOT_RATE_LIMITED") !== (value.retryAfterSeconds !== null)
    || (!value.accepted && value.acceptedAt !== null)) {
    throw controlError(
      "HOST_REBOOT_CONTROL_RESPONSE_INVALID",
      "Die Host-Reboot-Antwort ist widerspruechlich.",
    );
  }
  return value;
}

function assertSafeSocket(socketPath, options = {}) {
  const resolved = path.resolve(String(socketPath || ""));
  const parent = path.dirname(resolved);
  if (!path.isAbsolute(resolved)
    || resolved === path.parse(resolved).root
    || path.basename(resolved) !== "request.sock") {
    throw controlError("HOST_REBOOT_CONTROL_SOCKET_UNSAFE", "Der Host-Reboot-Socket ist ungueltig.");
  }

  let parentStat;
  let socketStat;
  try {
    parentStat = fs.lstatSync(parent);
    socketStat = fs.lstatSync(resolved);
  } catch {
    throw controlError("HOST_REBOOT_CONTROL_UNAVAILABLE", "Die Host-Reboot-Steuerung ist nicht verfuegbar.");
  }

  const requireRootOwner = options.requireRootOwner !== false;
  if (!parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || parentStat.nlink < 2
    || (process.platform !== "win32"
      && ((parentStat.mode & 0o7777) !== 0o755 || (parentStat.mode & 0o022) !== 0))
    || (requireRootOwner
      && typeof parentStat.uid === "number"
      && (parentStat.uid !== 0 || parentStat.gid !== 0))) {
    throw controlError("HOST_REBOOT_CONTROL_SOCKET_UNSAFE", "Der Host-Reboot-Socketpfad ist nicht sicher.");
  }

  const expectedGid = Number.isSafeInteger(options.expectedGid) ? options.expectedGid : null;
  const processGroups = process.platform === "win32" || typeof process.getgroups !== "function"
    ? []
    : process.getgroups();
  if (!socketStat.isSocket()
    || socketStat.isSymbolicLink()
    || socketStat.nlink !== 1
    || (process.platform !== "win32" && (socketStat.mode & 0o7777) !== 0o660)
    || (requireRootOwner && typeof socketStat.uid === "number" && socketStat.uid !== 0)
    || (process.platform !== "win32"
      && typeof socketStat.gid === "number"
      && (socketStat.gid === 0
        || (expectedGid !== null
          ? socketStat.gid !== expectedGid
          : !processGroups.includes(socketStat.gid))))) {
    throw controlError("HOST_REBOOT_CONTROL_SOCKET_UNSAFE", "Der Host-Reboot-Socket besitzt unsichere Rechte.");
  }
  return resolved;
}

function exchange(socketPath, payload, expectedRequestId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.end(payload));
    socket.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        finish(controlError("HOST_REBOOT_CONTROL_RESPONSE_INVALID", "Die Host-Reboot-Antwort ist zu gross."));
        return;
      }
      chunks.push(chunk);
    });
    socket.on("timeout", () => finish(
      controlError("HOST_REBOOT_CONTROL_TIMEOUT", "Die Host-Reboot-Steuerung hat nicht rechtzeitig geantwortet."),
    ));
    socket.on("error", () => finish(
      controlError("HOST_REBOOT_CONTROL_UNAVAILABLE", "Die Host-Reboot-Steuerung ist nicht erreichbar."),
    ));
    socket.on("end", () => {
      try {
        finish(null, parseResponse(Buffer.concat(chunks), expectedRequestId));
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function requestHostReboot(options = {}) {
  if (process.platform !== "linux" && options.allowNonLinux !== true) {
    throw controlError(
      "HOST_REBOOT_CONTROL_UNAVAILABLE",
      "Die Host-Reboot-Steuerung ist nur im Linux-Serverbetrieb verfuegbar.",
    );
  }
  const requestId = String(options.requestId || crypto.randomUUID());
  const backupMarkerFileName = String(options.backupMarkerFileName || "");
  const socketPath = assertSafeSocket(options.socketPath || DEFAULT_SOCKET_PATH, options);
  const timeoutMs = Number.isSafeInteger(options.timeoutMs)
    ? Math.max(500, Math.min(options.timeoutMs, 25_000))
    : 20_000;
  const result = await exchange(
    socketPath,
    buildRequest(requestId, backupMarkerFileName),
    requestId,
    timeoutMs,
  );
  if (!result.accepted) {
    const publicCode = result.code === "HOST_REBOOT_BUSY"
      ? "BUSY"
      : result.code === "HOST_REBOOT_BACKUP_REQUIRED"
        ? "BACKUP_REQUIRED"
      : result.code === "HOST_REBOOT_MAINTENANCE_BUSY"
        ? "MAINTENANCE_BUSY"
      : result.code === "HOST_REBOOT_SECURITY_PENDING"
        ? "SECURITY_PENDING"
      : result.code === "HOST_REBOOT_RATE_LIMITED"
        ? "RATE_LIMITED"
        : result.code === "HOST_REBOOT_NOT_REQUIRED"
          ? "NOT_REQUIRED"
          : "UNAVAILABLE";
    const error = controlError(publicCode, "Der kontrollierte VPS-Reboot konnte nicht gestartet werden.");
    if (result.retryAfterSeconds !== null) error.retryAfterSeconds = result.retryAfterSeconds;
    throw error;
  }
  return result;
}

module.exports = {
  DEFAULT_SOCKET_PATH,
  MAX_RESPONSE_BYTES,
  REQUEST_FORMAT,
  RESPONSE_FORMAT,
  SCHEMA_VERSION,
  HostRebootControlError,
  assertSafeSocket,
  buildRequest,
  parseResponse,
  requestHostReboot,
};
