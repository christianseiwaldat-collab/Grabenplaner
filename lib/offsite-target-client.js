"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_SOCKET_PATH = "/run/grabenplaner-offsite-target-control/request.sock";
const REQUEST_FORMAT = "grabenplaner-offsite-target-control-request";
const RESPONSE_FORMAT = "grabenplaner-offsite-target-control-response";
const SCHEMA_VERSION = 1;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_FOLDER_COUNT = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
const DEFAULT_ACTIVATION_TIMEOUT_MS = 31 * 60 * 1000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_ACTIVATION_TIMEOUT_MS = 32 * 60 * 1000;
const REQUEST_KEYS = new Set(["action", "format", "parameters", "requestId", "schemaVersion"]);
const RESPONSE_KEYS = new Set([
  "activeFolder",
  "code",
  "createdFolder",
  "fallbackPreserved",
  "folders",
  "format",
  "generatedAt",
  "migrationMode",
  "ok",
  "recoverySetState",
  "requestId",
  "retryAfterSeconds",
  "schemaVersion",
]);
const EMPTY_PARAMETER_KEYS = new Set();
const FOLDER_PARAMETER_KEYS = new Set(["folderLabel"]);
const ACTIONS = new Set([
  "status",
  "list-managed-folders",
  "create-managed-folder",
  "activate-managed-folder",
]);
const RESPONSE_CODES = new Set([
  "TARGET_CONTROL_READY",
  "TARGET_FOLDERS_LISTED",
  "TARGET_FOLDER_CREATED",
  "TARGET_FOLDER_ACTIVATED",
  "TARGET_FOLDER_EXISTS",
  "TARGET_FOLDER_NOT_FOUND",
  "TARGET_FOLDER_ALREADY_ACTIVE",
  "TARGET_FOLDER_LIMIT_REACHED",
  "TARGET_REQUEST_RATE_LIMITED",
  "TARGET_REQUEST_INVALID",
  "TARGET_CONTROL_FAILED",
]);
const SUCCESS_CODES = new Set([
  "TARGET_CONTROL_READY",
  "TARGET_FOLDERS_LISTED",
  "TARGET_FOLDER_CREATED",
  "TARGET_FOLDER_ACTIVATED",
]);
const TARGET_SWITCH_MIGRATION_MODES = new Set(["copied", "verified-existing"]);
const TARGET_SWITCH_RECOVERY_SET_STATE = "pending-offline-transfer-and-verification";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FOLDER_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,46}[A-Za-z0-9])?$/;

class OffsiteTargetControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OffsiteTargetControlError";
    this.code = code;
  }
}

function controlError(code, message) {
  return new OffsiteTargetControlError(code, message);
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

function validFolderLabel(value) {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= 48
    && FOLDER_LABEL_PATTERN.test(value);
}

function buildRequest(requestId, action, parameters = {}) {
  if (!UUID_PATTERN.test(String(requestId || "")) || !ACTIONS.has(action)) {
    throw controlError("TARGET_CONTROL_REQUEST_INVALID", "Die interne Offsite-Zielanforderung ist ungueltig.");
  }
  const needsFolder = action === "create-managed-folder" || action === "activate-managed-folder";
  const expectedParameters = needsFolder ? FOLDER_PARAMETER_KEYS : EMPTY_PARAMETER_KEYS;
  if (!exactKeys(parameters, expectedParameters)
    || (needsFolder && !validFolderLabel(parameters.folderLabel))) {
    throw controlError("TARGET_CONTROL_REQUEST_INVALID", "Die interne Offsite-Zielanforderung ist ungueltig.");
  }
  const request = {
    format: REQUEST_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    action,
    requestId,
    parameters: needsFolder ? { folderLabel: parameters.folderLabel } : {},
  };
  if (!exactKeys(request, REQUEST_KEYS)) {
    throw controlError("TARGET_CONTROL_REQUEST_INVALID", "Die interne Offsite-Zielanforderung ist ungueltig.");
  }
  return `${JSON.stringify(request)}\n`;
}

function sortedUniqueFolders(value) {
  if (!Array.isArray(value) || value.length > MAX_FOLDER_COUNT
    || value.some((folder) => !validFolderLabel(folder))) {
    throw controlError("TARGET_CONTROL_RESPONSE_INVALID", "Die Offsite-Zielantwort enthaelt ungueltige Ordner.");
  }
  const seen = new Set();
  for (const folder of value) {
    const key = folder.toLowerCase();
    if (seen.has(key)) {
      throw controlError("TARGET_CONTROL_RESPONSE_INVALID", "Die Offsite-Zielantwort enthaelt mehrdeutige Ordner.");
    }
    seen.add(key);
  }
  const sorted = [...value].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (sorted.some((folder, index) => folder !== value[index])) {
    throw controlError("TARGET_CONTROL_RESPONSE_INVALID", "Die Offsite-Zielantwort ist nicht kanonisch sortiert.");
  }
  return sorted;
}

function parseResponse(buffer, expectedRequestId) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer.length > MAX_RESPONSE_BYTES || buffer.includes(0)) {
    throw controlError("TARGET_CONTROL_RESPONSE_INVALID", "Die Offsite-Zielsteuerung hat keine gueltige Antwort geliefert.");
  }
  const text = buffer.toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r")) {
    throw controlError("TARGET_CONTROL_RESPONSE_INVALID", "Die Offsite-Zielantwort ist ungueltig formatiert.");
  }
  let value;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    throw controlError("TARGET_CONTROL_RESPONSE_INVALID", "Die Offsite-Zielantwort ist kein gueltiges JSON.");
  }
  if (!exactKeys(value, RESPONSE_KEYS)
    || value.format !== RESPONSE_FORMAT
    || value.schemaVersion !== SCHEMA_VERSION
    || value.requestId !== expectedRequestId
    || !UUID_PATTERN.test(String(value.requestId || ""))
    || typeof value.ok !== "boolean"
    || !RESPONSE_CODES.has(value.code)
    || !canonicalUtcTimestamp(value.generatedAt)
    || (value.activeFolder !== null && !validFolderLabel(value.activeFolder))
    || (value.createdFolder !== null && !validFolderLabel(value.createdFolder))
    || (value.migrationMode !== null && !TARGET_SWITCH_MIGRATION_MODES.has(value.migrationMode))
    || (value.recoverySetState !== null && value.recoverySetState !== TARGET_SWITCH_RECOVERY_SET_STATE)
    || typeof value.fallbackPreserved !== "boolean"
    || (value.retryAfterSeconds !== null
      && (!Number.isSafeInteger(value.retryAfterSeconds)
        || value.retryAfterSeconds < 1
        || value.retryAfterSeconds > 900))) {
    throw controlError("TARGET_CONTROL_RESPONSE_INVALID", "Die Offsite-Zielantwort entspricht nicht dem freigegebenen Schema.");
  }

  value.folders = sortedUniqueFolders(value.folders);
  const activated = value.code === "TARGET_FOLDER_ACTIVATED";
  if (value.ok !== SUCCESS_CODES.has(value.code)
    || (value.code === "TARGET_REQUEST_RATE_LIMITED") !== (value.retryAfterSeconds !== null)
    || (value.code !== "TARGET_REQUEST_RATE_LIMITED" && value.retryAfterSeconds !== null)
    || (value.code === "TARGET_FOLDER_CREATED") !== (value.createdFolder !== null)
    || (value.code !== "TARGET_FOLDER_CREATED" && value.createdFolder !== null)
    || (value.code === "TARGET_CONTROL_READY" && value.folders.length !== 0)
    || (value.code === "TARGET_FOLDERS_LISTED" && value.createdFolder !== null)
    || activated !== (value.migrationMode !== null
      && value.recoverySetState !== null
      && value.fallbackPreserved === true
      && value.activeFolder !== null
      && value.folders.length > 0
      && value.folders.includes(value.activeFolder))
    || (!activated && (value.migrationMode !== null
      || value.recoverySetState !== null
      || value.fallbackPreserved !== false))
    || (!value.ok && (value.activeFolder !== null || value.folders.length !== 0))) {
    throw controlError("TARGET_CONTROL_RESPONSE_INVALID", "Die Offsite-Zielantwort ist widerspruechlich.");
  }
  if (value.activeFolder !== null && value.folders.length > 0
    && !value.folders.some((folder) => folder === value.activeFolder)) {
    throw controlError("TARGET_CONTROL_RESPONSE_INVALID", "Der aktive Offsite-Ordner fehlt in der Ordnerliste.");
  }
  return value;
}

function assertSafeSocket(socketPath, options = {}) {
  const resolved = path.resolve(String(socketPath || ""));
  const parent = path.dirname(resolved);
  if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root
    || path.basename(resolved) !== "request.sock") {
    throw controlError("TARGET_CONTROL_SOCKET_UNSAFE", "Der Offsite-Zielsteuerungssocket ist ungueltig.");
  }
  let parentStat;
  let socketStat;
  try {
    parentStat = fs.lstatSync(parent);
    socketStat = fs.lstatSync(resolved);
  } catch {
    throw controlError("TARGET_CONTROL_UNAVAILABLE", "Die Offsite-Zielsteuerung ist nicht verfuegbar.");
  }
  const requireRootOwner = options.requireRootOwner !== false;
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.nlink < 2
    || (process.platform !== "win32" && ((parentStat.mode & 0o7777) !== 0o755 || (parentStat.mode & 0o022) !== 0))
    || (requireRootOwner && typeof parentStat.uid === "number" && (parentStat.uid !== 0 || parentStat.gid !== 0))) {
    throw controlError("TARGET_CONTROL_SOCKET_UNSAFE", "Der Offsite-Zielsteuerungspfad ist nicht sicher.");
  }
  const expectedGid = Number.isSafeInteger(options.expectedGid) ? options.expectedGid : null;
  const processGroups = process.platform === "win32" || typeof process.getgroups !== "function" ? [] : process.getgroups();
  if (!socketStat.isSocket() || socketStat.isSymbolicLink() || socketStat.nlink !== 1
    || (process.platform !== "win32" && (socketStat.mode & 0o7777) !== 0o660)
    || (requireRootOwner && typeof socketStat.uid === "number" && socketStat.uid !== 0)
    || (process.platform !== "win32" && typeof socketStat.gid === "number"
      && (socketStat.gid === 0 || (expectedGid !== null ? socketStat.gid !== expectedGid : !processGroups.includes(socketStat.gid))))) {
    throw controlError("TARGET_CONTROL_SOCKET_UNSAFE", "Der Offsite-Zielsteuerungssocket besitzt unsichere Rechte.");
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
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.end(payload));
    socket.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        finish(controlError("TARGET_CONTROL_RESPONSE_INVALID", "Die Offsite-Zielantwort ist zu gross."));
        return;
      }
      chunks.push(chunk);
    });
    socket.on("timeout", () => finish(controlError("TARGET_CONTROL_TIMEOUT", "Die Offsite-Zielsteuerung hat nicht rechtzeitig geantwortet.")));
    socket.on("error", () => finish(controlError("TARGET_CONTROL_UNAVAILABLE", "Die Offsite-Zielsteuerung ist nicht erreichbar.")));
    socket.on("end", () => {
      try {
        finish(null, parseResponse(Buffer.concat(chunks), expectedRequestId));
      } catch (error) {
        finish(error);
      }
    });
  });
}

function publicError(result) {
  let code = "UNAVAILABLE";
  if (result.code === "TARGET_REQUEST_RATE_LIMITED") code = "RATE_LIMITED";
  else if (result.code === "TARGET_FOLDER_EXISTS") code = "ALREADY_EXISTS";
  else if (result.code === "TARGET_FOLDER_NOT_FOUND") code = "NOT_FOUND";
  else if (result.code === "TARGET_FOLDER_ALREADY_ACTIVE") code = "ALREADY_ACTIVE";
  else if (result.code === "TARGET_FOLDER_LIMIT_REACHED") code = "LIMIT_REACHED";
  const error = controlError(code, "Die Offsite-Zielanforderung konnte nicht ausgefuehrt werden.");
  if (result.retryAfterSeconds !== null) error.retryAfterSeconds = result.retryAfterSeconds;
  return error;
}

async function requestOffsiteTargetControl(action, parameters = {}, options = {}) {
  if (process.platform !== "linux" && options.allowNonLinux !== true) {
    throw controlError("TARGET_CONTROL_UNAVAILABLE", "Die Offsite-Zielsteuerung ist nur im Linux-Serverbetrieb verfuegbar.");
  }
  const requestId = String(options.requestId || crypto.randomUUID());
  const socketPath = assertSafeSocket(options.socketPath || DEFAULT_SOCKET_PATH, options);
  const activation = action === "activate-managed-folder";
  const timeoutMaximum = activation ? MAX_ACTIVATION_TIMEOUT_MS : MAX_REQUEST_TIMEOUT_MS;
  const timeoutDefault = activation ? DEFAULT_ACTIVATION_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs)
    ? Math.max(500, Math.min(options.timeoutMs, timeoutMaximum))
    : timeoutDefault;
  const result = await exchange(socketPath, buildRequest(requestId, action, parameters), requestId, timeoutMs);
  if (!result.ok) throw publicError(result);
  return result;
}

async function offsiteTargetControlStatus(options = {}) {
  try {
    const result = await requestOffsiteTargetControl("status", {}, options);
    return {
      available: true,
      activeFolder: result.activeFolder,
      reason: null,
    };
  } catch (error) {
    return {
      available: false,
      activeFolder: null,
      reason: String(error?.code || "TARGET_CONTROL_UNAVAILABLE"),
    };
  }
}

async function listManagedOffsiteFolders(options = {}) {
  return requestOffsiteTargetControl("list-managed-folders", {}, options);
}

async function createManagedOffsiteFolder(folderLabel, options = {}) {
  return requestOffsiteTargetControl("create-managed-folder", { folderLabel }, options);
}

async function activateManagedOffsiteFolder(folderLabel, options = {}) {
  return requestOffsiteTargetControl("activate-managed-folder", { folderLabel }, options);
}

module.exports = {
  ACTIONS,
  DEFAULT_ACTIVATION_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SOCKET_PATH,
  FOLDER_LABEL_PATTERN,
  MAX_FOLDER_COUNT,
  MAX_ACTIVATION_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  OffsiteTargetControlError,
  REQUEST_FORMAT,
  RESPONSE_FORMAT,
  SCHEMA_VERSION,
  TARGET_SWITCH_MIGRATION_MODES,
  TARGET_SWITCH_RECOVERY_SET_STATE,
  activateManagedOffsiteFolder,
  assertSafeSocket,
  buildRequest,
  createManagedOffsiteFolder,
  listManagedOffsiteFolders,
  offsiteTargetControlStatus,
  parseResponse,
  requestOffsiteTargetControl,
  validFolderLabel,
};
