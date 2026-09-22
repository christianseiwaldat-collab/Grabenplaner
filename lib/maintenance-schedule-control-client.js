"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_SOCKET_PATH = "/run/grabenplaner-assurance-control/request.sock";
const REQUEST_FORMAT = "grabenplaner-assurance-control-request";
const RESPONSE_FORMAT = "grabenplaner-assurance-control-response";
const SCHEMA_VERSION = 3;
const MAX_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 280_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const WEEKDAYS = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
const TASK_IDS = Object.freeze(["server-monitor", "complete-backup", "repository-check", "restore-test", "security-audit"]);
const RESPONSE_CODES = new Set([
  "MAINTENANCE_SCHEDULES_READY", "MAINTENANCE_SCHEDULES_UPDATED", "MAINTENANCE_SCHEDULES_BUSY",
  "MAINTENANCE_SCHEDULES_INVALID", "MAINTENANCE_SCHEDULES_UNAVAILABLE", "MAINTENANCE_SCHEDULES_FAILED",
  "MAINTENANCE_SCHEDULES_STALE",
  "ASSURANCE_REQUEST_INVALID",
]);
const RESPONSE_KEYS = new Set([
  "accepted", "acceptedAt", "code", "format", "maintenanceSchedules", "requestId", "retryAfterSeconds", "schemaVersion",
]);
const STATUS_KEYS = new Set(["available", "checkedAt", "revision", "tasks"]);
const TASK_KEYS = new Set([
  "active", "cadence", "enabled", "id", "installed", "intervalMinutes", "monthDay", "nextRunAt", "running", "time", "weekdays", "unsupportedReason",
]);

class MaintenanceScheduleControlError extends Error {
  constructor(code, message) { super(message); this.name = "MaintenanceScheduleControlError"; this.code = code; }
}
function controlError(code, message) { return new MaintenanceScheduleControlError(code, message); }
function exactKeys(value, expected) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}
function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function parseTask(value) {
  if (!exactKeys(value, TASK_KEYS) || !/^[a-z][a-z0-9-]{2,40}$/.test(String(value.id || ""))
    || typeof value.enabled !== "boolean" || typeof value.installed !== "boolean"
    || typeof value.active !== "boolean" || typeof value.running !== "boolean"
    || !["interval", "hours", "weekly", "monthly", "quarterly", "unsupported"].includes(value.cadence)
    || ![null, "not-installed", "different-target", "additional-triggers", "calendar-not-supported", "nonpersistent-timer"].includes(value.unsupportedReason)
    || !Array.isArray(value.weekdays) || new Set(value.weekdays).size !== value.weekdays.length
    || value.weekdays.some((day) => !WEEKDAYS.has(day))
    || (value.time !== null && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time))
    || (value.intervalMinutes !== null && ![5, 10, 15, 20, 30, 60, 360, 720].includes(value.intervalMinutes))
    || (value.monthDay !== null && (!Number.isSafeInteger(value.monthDay) || value.monthDay < 1 || value.monthDay > 28))
    || (value.nextRunAt !== null && !timestamp(value.nextRunAt))
    || (!value.installed && (value.enabled || value.active || value.running || value.nextRunAt !== null))
    || (value.nextRunAt !== null && (!value.enabled || !value.active))) {
    throw controlError("MAINTENANCE_SCHEDULE_RESPONSE_INVALID", "Die Wartungszeitplan-Antwort ist ungueltig.");
  }
  const intervalValid = value.cadence === "interval" && value.weekdays.length === 0 && value.time === null
    && [5, 10, 15, 20, 30, 60].includes(value.intervalMinutes) && value.monthDay === null;
  const hoursValid = value.id === "complete-backup" && value.cadence === "hours" && value.weekdays.length === 0
    && value.time !== null && [360, 720].includes(value.intervalMinutes) && value.monthDay === null;
  const weeklyValid = value.cadence === "weekly" && value.weekdays.length > 0 && value.time !== null
    && value.intervalMinutes === null && value.monthDay === null;
  const calendarValid = ["monthly", "quarterly"].includes(value.cadence) && value.weekdays.length === 0
    && value.time !== null && value.intervalMinutes === null && value.monthDay !== null;
  const unsupportedValid = value.cadence === "unsupported" && value.unsupportedReason !== null
    && value.weekdays.length === 0 && value.time === null && value.intervalMinutes === null && value.monthDay === null;
  if ((!intervalValid && !hoursValid && !weeklyValid && !calendarValid && !unsupportedValid)
    || (value.cadence !== "unsupported" && value.unsupportedReason !== null)) {
    throw controlError("MAINTENANCE_SCHEDULE_RESPONSE_INVALID", "Die Wartungszeitplan-Antwort ist widerspruechlich.");
  }
  return { ...value, weekdays: [...value.weekdays] };
}
function parseStatus(value) {
  if (!exactKeys(value, STATUS_KEYS) || typeof value.available !== "boolean" || !Array.isArray(value.tasks)
    || (value.checkedAt !== null && !timestamp(value.checkedAt))
    || (value.revision !== null && !HASH_PATTERN.test(String(value.revision)))) {
    throw controlError("MAINTENANCE_SCHEDULE_RESPONSE_INVALID", "Der Wartungszeitplan-Status ist ungueltig.");
  }
  if (!value.available && (value.checkedAt !== null || value.revision !== null || value.tasks.length)) {
    throw controlError("MAINTENANCE_SCHEDULE_RESPONSE_INVALID", "Der Wartungszeitplan-Status ist widerspruechlich.");
  }
  const tasks = value.tasks.map(parseTask);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length
    || (value.available && (tasks.length !== TASK_IDS.length
      || tasks.some((task, index) => task.id !== TASK_IDS[index])))) {
    throw controlError("MAINTENANCE_SCHEDULE_RESPONSE_INVALID", "Der Wartungszeitplan enthaelt doppelte Vorgaenge.");
  }
  return { ...value, tasks };
}
function buildRequest(requestId, action, schedules, expectedRevision) {
  if (!UUID_PATTERN.test(String(requestId || ""))
    || !["maintenance-schedules-status", "maintenance-schedules-update"].includes(action)) {
    throw controlError("MAINTENANCE_SCHEDULE_REQUEST_INVALID", "Die Wartungszeitplan-Anforderung ist ungueltig.");
  }
  const value = { format: REQUEST_FORMAT, schemaVersion: SCHEMA_VERSION, action, requestId };
  if (action === "maintenance-schedules-update") {
    if (!HASH_PATTERN.test(String(expectedRevision || ""))) throw controlError("MAINTENANCE_SCHEDULE_REQUEST_INVALID", "Der geladene Zeitplanstand fehlt.");
    value.schedules = schedules;
    value.expectedRevision = expectedRevision;
  }
  return `${JSON.stringify(value)}\n`;
}
function parseResponse(buffer, requestId) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer.length > MAX_RESPONSE_BYTES || buffer.includes(0)) {
    throw controlError("MAINTENANCE_SCHEDULE_RESPONSE_INVALID", "Die Wartungszeitplan-Steuerung hat keine gueltige Antwort geliefert.");
  }
  const text = buffer.toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r")) {
    throw controlError("MAINTENANCE_SCHEDULE_RESPONSE_INVALID", "Die Wartungszeitplan-Antwort ist ungueltig formatiert.");
  }
  let value;
  try { value = JSON.parse(text.slice(0, -1)); } catch {
    throw controlError("MAINTENANCE_SCHEDULE_RESPONSE_INVALID", "Die Wartungszeitplan-Antwort ist kein gueltiges JSON.");
  }
  if (!exactKeys(value, RESPONSE_KEYS) || value.format !== RESPONSE_FORMAT || value.schemaVersion !== SCHEMA_VERSION
    || value.requestId !== requestId || !RESPONSE_CODES.has(value.code) || typeof value.accepted !== "boolean"
    || (value.acceptedAt !== null && !timestamp(value.acceptedAt)) || value.retryAfterSeconds !== null) {
    throw controlError("MAINTENANCE_SCHEDULE_RESPONSE_INVALID", "Die Wartungszeitplan-Antwort entspricht nicht dem freigegebenen Schema.");
  }
  const maintenanceSchedules = parseStatus(value.maintenanceSchedules);
  if ((value.code === "MAINTENANCE_SCHEDULES_UPDATED") !== value.accepted
    || (value.accepted && value.acceptedAt === null) || (!value.accepted && value.acceptedAt !== null)) {
    throw controlError("MAINTENANCE_SCHEDULE_RESPONSE_INVALID", "Die Wartungszeitplan-Antwort ist widerspruechlich.");
  }
  return { ...value, maintenanceSchedules };
}
function assertSafeSocket(socketPath = DEFAULT_SOCKET_PATH, options = {}) {
  const resolved = path.resolve(String(socketPath || ""));
  const parent = path.dirname(resolved);
  if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root || path.basename(resolved) !== "request.sock") {
    throw controlError("MAINTENANCE_SCHEDULE_CONTROL_UNSAFE", "Der Wartungszeitplan-Socket ist ungueltig.");
  }
  let parentStat; let socketStat;
  try { parentStat = fs.lstatSync(parent); socketStat = fs.lstatSync(resolved); } catch {
    throw controlError("MAINTENANCE_SCHEDULE_CONTROL_UNAVAILABLE", "Die Wartungszeitplan-Steuerung ist nicht verfuegbar.");
  }
  const requireRootOwner = options.requireRootOwner !== false;
  const groups = process.platform === "win32" || typeof process.getgroups !== "function" ? [] : process.getgroups();
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.nlink < 2
    || (process.platform !== "win32" && ((parentStat.mode & 0o7777) !== 0o755 || (parentStat.mode & 0o022)))
    || (requireRootOwner && typeof parentStat.uid === "number" && (parentStat.uid !== 0 || parentStat.gid !== 0))
    || !socketStat.isSocket() || socketStat.isSymbolicLink() || socketStat.nlink !== 1
    || (process.platform !== "win32" && (socketStat.mode & 0o7777) !== 0o660)
    || (requireRootOwner && typeof socketStat.uid === "number" && socketStat.uid !== 0)
    || (process.platform !== "win32" && typeof socketStat.gid === "number"
      && (socketStat.gid === 0 || !groups.includes(socketStat.gid)))) {
    throw controlError("MAINTENANCE_SCHEDULE_CONTROL_UNSAFE", "Der Wartungszeitplan-Socket besitzt unsichere Rechte.");
  }
  return resolved;
}
function exchange(socketPath, payload, requestId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath, allowHalfOpen: true });
    const chunks = []; let bytes = 0; let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; socket.destroy(); if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.end(payload));
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) finish(controlError("MAINTENANCE_SCHEDULE_RESPONSE_INVALID", "Die Wartungszeitplan-Antwort ist zu gross."));
      else chunks.push(chunk);
    });
    socket.on("timeout", () => finish(controlError("MAINTENANCE_SCHEDULE_CONTROL_TIMEOUT", "Die Wartungszeitplan-Steuerung hat nicht rechtzeitig geantwortet.")));
    socket.on("error", () => finish(controlError("MAINTENANCE_SCHEDULE_CONTROL_UNAVAILABLE", "Die Wartungszeitplan-Steuerung ist nicht erreichbar.")));
    socket.on("end", () => { try { finish(null, parseResponse(Buffer.concat(chunks), requestId)); } catch (error) { finish(error); } });
  });
}
async function request(action, schedules, options = {}) {
  if (process.platform !== "linux" && options.allowNonLinux !== true) {
    throw controlError("MAINTENANCE_SCHEDULE_CONTROL_UNAVAILABLE", "Die Wartungszeitplan-Steuerung ist nur im Linux-Serverbetrieb verfuegbar.");
  }
  const requestId = String(options.requestId || crypto.randomUUID());
  const socketPath = assertSafeSocket(options.socketPath || DEFAULT_SOCKET_PATH, options);
  const response = await exchange(socketPath, buildRequest(requestId, action, schedules, options.expectedRevision), requestId,
    Number.isSafeInteger(options.timeoutMs) ? Math.max(500, Math.min(options.timeoutMs, 300_000)) : DEFAULT_TIMEOUT_MS);
  if (!["MAINTENANCE_SCHEDULES_READY", "MAINTENANCE_SCHEDULES_UPDATED"].includes(response.code)) {
    const code = response.code === "MAINTENANCE_SCHEDULES_STALE" ? "STALE"
      : response.code === "MAINTENANCE_SCHEDULES_BUSY" ? "BUSY"
      : response.code === "MAINTENANCE_SCHEDULES_INVALID" ? "INVALID"
        : response.code === "MAINTENANCE_SCHEDULES_UNAVAILABLE" ? "UNAVAILABLE" : "FAILED";
    throw controlError(code, "Der Wartungszeitplan konnte nicht gelesen oder gespeichert werden.");
  }
  return response.maintenanceSchedules;
}
async function readMaintenanceSchedules(options = {}) { return request("maintenance-schedules-status", undefined, options); }
async function updateMaintenanceSchedules(schedules, options = {}) { return request("maintenance-schedules-update", schedules, options); }

module.exports = {
  DEFAULT_SOCKET_PATH, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES, REQUEST_FORMAT, RESPONSE_FORMAT, SCHEMA_VERSION, TASK_IDS,
  MaintenanceScheduleControlError, assertSafeSocket, buildRequest, parseResponse, parseStatus,
  readMaintenanceSchedules, updateMaintenanceSchedules,
};
