#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  MaintenanceScheduleError,
  applySchedules,
  scheduleSnapshot,
} = require("./maintenance-schedule-broker");

const REQUEST_FORMAT = "grabenplaner-assurance-control-request";
const RESPONSE_FORMAT = "grabenplaner-assurance-control-response";
const STATE_FORMAT = "grabenplaner-assurance-control-state";
const SCHEMA_VERSION = 2;
const STATE_SCHEMA_VERSION = 1;
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2, 3]);
const MAX_REQUEST_BYTES = 16 * 1024;
const RATE_LIMIT_SECONDS = 15 * 60;
const SYSTEMCTL = "/usr/bin/systemctl";
const DATE = "/usr/bin/date";
const FLOCK = "/usr/bin/flock";
const ASSURANCE_UNIT = "grabenplaner-offsite-assurance@manual-admin-ui.service";
const ASSURANCE_TIMER = "grabenplaner-offsite-assurance.timer";
const ASSURANCE_TIMER_FRAGMENT = "/etc/systemd/system/grabenplaner-offsite-assurance.timer";
const ASSURANCE_LOCK = "/run/grabenplaner-offsite/assurance.lock";
const STATE_PATH = "/run/grabenplaner-assurance-control/state.json";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_KEYS = new Set(["action", "format", "requestId", "schemaVersion"]);
const SCHEDULE_REQUEST_KEYS = new Set(["action", "format", "requestId", "schedules", "schemaVersion", "expectedRevision"]);
const STATE_KEYS = new Set(["format", "lastAcceptedAt", "lastRequestId", "schemaVersion"]);

class AssuranceControlBrokerError extends Error {
  constructor(code) {
    super(code);
    this.name = "AssuranceControlBrokerError";
    this.code = code;
  }
}

function fail(code) {
  throw new AssuranceControlBrokerError(code);
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

function parseRequest(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer.length > MAX_REQUEST_BYTES || buffer.includes(0)) {
    fail("ASSURANCE_REQUEST_INVALID");
  }
  const text = buffer.toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r")) {
    fail("ASSURANCE_REQUEST_INVALID");
  }
  let value;
  try { value = JSON.parse(text.slice(0, -1)); }
  catch { fail("ASSURANCE_REQUEST_INVALID"); }
  const assuranceAction = ["start-manual-assurance", "status"].includes(value.action);
  const scheduleAction = ["maintenance-schedules-status", "maintenance-schedules-update"].includes(value.action);
  const keysValid = value.action === "maintenance-schedules-update"
    ? exactKeys(value, SCHEDULE_REQUEST_KEYS)
    : exactKeys(value, REQUEST_KEYS);
  if (!keysValid || value.format !== REQUEST_FORMAT || !SUPPORTED_SCHEMA_VERSIONS.has(value.schemaVersion)
    || (!assuranceAction && !(value.schemaVersion === 3 && scheduleAction))
    || (scheduleAction && value.schemaVersion !== 3)
    || !UUID_PATTERN.test(String(value.requestId || ""))
    || (value.action === "maintenance-schedules-update" && !/^[a-f0-9]{64}$/.test(String(value.expectedRevision || "")))) {
    fail("ASSURANCE_REQUEST_INVALID");
  }
  return value;
}

function response(requestId, code, options = {}) {
  const accepted = options.accepted === true;
  const schemaVersion = SUPPORTED_SCHEMA_VERSIONS.has(options.schemaVersion)
    ? options.schemaVersion
    : SCHEMA_VERSION;
  const value = {
    format: RESPONSE_FORMAT,
    schemaVersion,
    requestId: UUID_PATTERN.test(String(requestId || "")) ? requestId : crypto.randomUUID(),
    accepted,
    code,
    acceptedAt: accepted ? options.acceptedAt : null,
    retryAfterSeconds: code === "ASSURANCE_REQUEST_RATE_LIMITED" ? options.retryAfterSeconds : null,
  };
  if (schemaVersion === 2) value.scheduler = normalizeSchedulerEvidence(options.scheduler);
  if (schemaVersion === 3) value.maintenanceSchedules = options.maintenanceSchedules || {
    available: false,
    checkedAt: null,
    revision: null,
    tasks: [],
  };
  return value;
}

function untrustedSchedulerEvidence() {
  return {
    evidenceTrusted: false,
    timerInstalled: false,
    timerEnabled: false,
    nextElapse: null,
    checkedAt: null,
  };
}

function normalizeSchedulerEvidence(value) {
  const keys = new Set(["evidenceTrusted", "timerInstalled", "timerEnabled", "nextElapse", "checkedAt"]);
  if (!exactKeys(value, keys) || typeof value.evidenceTrusted !== "boolean"
    || typeof value.timerInstalled !== "boolean" || typeof value.timerEnabled !== "boolean"
    || (value.nextElapse !== null && !canonicalUtcTimestamp(value.nextElapse))
    || (value.checkedAt !== null && !canonicalUtcTimestamp(value.checkedAt))) {
    return untrustedSchedulerEvidence();
  }
  if (!value.evidenceTrusted) return untrustedSchedulerEvidence();
  if (!value.timerInstalled && (value.timerEnabled || value.nextElapse !== null)) return untrustedSchedulerEvidence();
  if (value.timerEnabled && (!value.timerInstalled || value.nextElapse === null)) return untrustedSchedulerEvidence();
  if (value.checkedAt === null) return untrustedSchedulerEvidence();
  return { ...value };
}

function strictCommandLine(result, acceptedStatuses = new Set([0])) {
  if (!result || result.error || !acceptedStatuses.has(result.status) || typeof result.stdout !== "string"
    || Buffer.byteLength(result.stdout, "utf8") > 128 || result.stdout.includes("\0") || result.stdout.includes("\r")) {
    fail("ASSURANCE_CONTROL_FAILED");
  }
  const text = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  if (!text || text.includes("\n")) fail("ASSURANCE_CONTROL_FAILED");
  return text;
}

function schedulerSystemctlValue(property, options = {}) {
  const runner = options.schedulerSpawnSync || childProcess.spawnSync;
  const result = runner(SYSTEMCTL, ["show", `--property=${property}`, "--value", ASSURANCE_TIMER], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 256,
    stdio: ["ignore", "pipe", "ignore"],
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
  });
  return strictCommandLine(result);
}

function canonicalizeSystemdTimestamp(value, options = {}) {
  const runner = options.dateSpawnSync || childProcess.spawnSync;
  const result = runner(DATE, ["--date", value, "--utc", "+%Y-%m-%dT%H:%M:%S.000Z"], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 256,
    stdio: ["ignore", "pipe", "ignore"],
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
  });
  const canonical = strictCommandLine(result);
  if (!canonicalUtcTimestamp(canonical)) fail("ASSURANCE_CONTROL_FAILED");
  return canonical;
}

function schedulerEvidence(options = {}) {
  try {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const checkedAt = new Date(nowMs).toISOString();
    if (!canonicalUtcTimestamp(checkedAt)) fail("ASSURANCE_CONTROL_FAILED");
    const loadState = schedulerSystemctlValue("LoadState", options);
    if (loadState === "not-found") {
      return normalizeSchedulerEvidence({
        evidenceTrusted: true,
        timerInstalled: false,
        timerEnabled: false,
        nextElapse: null,
        checkedAt,
      });
    }
    if (loadState !== "loaded") fail("ASSURANCE_CONTROL_FAILED");
    if (schedulerSystemctlValue("FragmentPath", options) !== ASSURANCE_TIMER_FRAGMENT) {
      fail("ASSURANCE_CONTROL_FAILED");
    }

    const runner = options.schedulerSpawnSync || childProcess.spawnSync;
    const enabledResult = runner(SYSTEMCTL, ["is-enabled", ASSURANCE_TIMER], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 256,
      stdio: ["ignore", "pipe", "ignore"],
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    });
    const enabledState = strictCommandLine(enabledResult, new Set([0, 1]));
    const enabled = enabledResult.status === 0 && enabledState === "enabled";
    const disabled = enabledResult.status === 1 && enabledState === "disabled";
    if (!enabled && !disabled) fail("ASSURANCE_CONTROL_FAILED");

    const activeResult = runner(SYSTEMCTL, ["is-active", ASSURANCE_TIMER], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 256,
      stdio: ["ignore", "pipe", "ignore"],
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    });
    const activeState = strictCommandLine(activeResult, new Set([0, 3]));
    const active = activeResult.status === 0 && activeState === "active";
    const inactive = activeResult.status === 3 && activeState === "inactive";
    if (!active && !inactive) fail("ASSURANCE_CONTROL_FAILED");

    const operational = enabled && active;
    const nextElapse = operational
      ? canonicalizeSystemdTimestamp(schedulerSystemctlValue("NextElapseUSecRealtime", options), options)
      : null;
    return normalizeSchedulerEvidence({
      evidenceTrusted: true,
      timerInstalled: true,
      timerEnabled: operational,
      nextElapse,
      checkedAt,
    });
  } catch {
    return untrustedSchedulerEvidence();
  }
}

function assertStateDirectory(statePath, options = {}) {
  const directory = path.dirname(path.resolve(statePath));
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch { fail("ASSURANCE_CONTROL_FAILED"); }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.platform !== "win32" && (stat.nlink < 2 || (stat.mode & 0o7777) !== 0o755 || (stat.mode & 0o022) !== 0))
    || (options.requireRootOwner !== false && typeof stat.uid === "number" && (stat.uid !== 0 || stat.gid !== 0))) {
    fail("ASSURANCE_CONTROL_FAILED");
  }
  return directory;
}

function readRateLimitState(statePath = STATE_PATH, options = {}) {
  assertStateDirectory(statePath, options);
  if (!fs.existsSync(statePath)) return null;
  let descriptor;
  try {
    const before = fs.lstatSync(statePath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 || before.size > 4096
      || (process.platform !== "win32" && (before.mode & 0o7777) !== 0o600)
      || (options.requireRootOwner !== false && typeof before.uid === "number" && (before.uid !== 0 || before.gid !== 0))) {
      fail("ASSURANCE_CONTROL_FAILED");
    }
    descriptor = fs.openSync(statePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_CLOEXEC || 0));
    const after = fs.fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1 || after.size !== before.size) {
      fail("ASSURANCE_CONTROL_FAILED");
    }
    const value = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (!exactKeys(value, STATE_KEYS) || value.format !== STATE_FORMAT || value.schemaVersion !== STATE_SCHEMA_VERSION
      || !UUID_PATTERN.test(String(value.lastRequestId || "")) || !canonicalUtcTimestamp(value.lastAcceptedAt)) {
      fail("ASSURANCE_CONTROL_FAILED");
    }
    return value;
  } catch (error) {
    if (error instanceof AssuranceControlBrokerError) throw error;
    fail("ASSURANCE_CONTROL_FAILED");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeRateLimitState(statePath, value, options = {}) {
  const directory = assertStateDirectory(statePath, options);
  if (!exactKeys(value, STATE_KEYS) || value.format !== STATE_FORMAT || value.schemaVersion !== STATE_SCHEMA_VERSION
    || !UUID_PATTERN.test(String(value.lastRequestId || "")) || !canonicalUtcTimestamp(value.lastAcceptedAt)) {
    fail("ASSURANCE_CONTROL_FAILED");
  }
  const temporary = path.join(directory, `.state.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_CLOEXEC || 0), 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, statePath);
    if (process.platform !== "win32") {
      const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    if (error instanceof AssuranceControlBrokerError) throw error;
    fail("ASSURANCE_CONTROL_FAILED");
  }
}

function systemctlValue(property, options = {}) {
  const runner = options.spawnSync || childProcess.spawnSync;
  const result = runner(SYSTEMCTL, ["show", `--property=${property}`, "--value", ASSURANCE_UNIT], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 1024,
    stdio: ["ignore", "pipe", "ignore"],
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string" || result.stdout.length > 128) {
    fail("ASSURANCE_CONTROL_FAILED");
  }
  return result.stdout.trim();
}

function assuranceUnitBusy(options = {}) {
  if ((typeof options.globalLockBusy === "boolean" || !options.spawnSync) && globalAssuranceBusy(options)) return true;
  if (systemctlValue("LoadState", options) !== "loaded") fail("ASSURANCE_CONTROL_FAILED");
  const activeState = systemctlValue("ActiveState", options);
  if (["active", "activating", "reloading", "deactivating"].includes(activeState)) return true;
  if (!["inactive", "failed"].includes(activeState)) fail("ASSURANCE_CONTROL_FAILED");
  return false;
}

function assertAssuranceLockBoundary(lockPath = ASSURANCE_LOCK, options = {}) {
  const directory = path.dirname(path.resolve(lockPath));
  let directoryStat;
  try { directoryStat = fs.lstatSync(directory); }
  catch { fail("ASSURANCE_CONTROL_FAILED"); }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || (process.platform !== "win32" && ((directoryStat.mode & 0o7777) !== 0o755 || directoryStat.uid !== 0 || directoryStat.gid !== 0))) {
    fail("ASSURANCE_CONTROL_FAILED");
  }
  if (!fs.existsSync(lockPath)) return;
  let lockStat;
  try { lockStat = fs.lstatSync(lockPath); }
  catch { fail("ASSURANCE_CONTROL_FAILED"); }
  if (!lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.nlink !== 1
    || (process.platform !== "win32" && ((lockStat.mode & 0o7777) !== 0o600 || lockStat.uid !== 0 || lockStat.gid !== 0))) {
    fail("ASSURANCE_CONTROL_FAILED");
  }
}

function globalAssuranceBusy(options = {}) {
  if (typeof options.globalLockBusy === "boolean") return options.globalLockBusy;
  assertAssuranceLockBoundary(options.assuranceLock || ASSURANCE_LOCK, options);
  const runner = options.lockSpawnSync || childProcess.spawnSync;
  const result = runner(FLOCK, ["--nonblock", "--close", options.assuranceLock || ASSURANCE_LOCK, "/usr/bin/true"], {
    timeout: 3000,
    stdio: "ignore",
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
  });
  if (result.error) fail("ASSURANCE_CONTROL_FAILED");
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  fail("ASSURANCE_CONTROL_FAILED");
}

function startAssuranceUnit(options = {}) {
  const runner = options.spawnSync || childProcess.spawnSync;
  const result = runner(SYSTEMCTL, ["start", "--no-block", ASSURANCE_UNIT], {
    timeout: 5000,
    stdio: "ignore",
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
  });
  if (result.error || result.status !== 0) fail("ASSURANCE_CONTROL_FAILED");
}

function handleRequest(buffer, options = {}) {
  let request;
  try { request = parseRequest(buffer); }
  catch (error) {
    return response(null, error?.code === "ASSURANCE_REQUEST_INVALID" ? error.code : "ASSURANCE_CONTROL_FAILED");
  }
  const responseOptions = {
    schemaVersion: request.schemaVersion,
    scheduler: request.schemaVersion === 2 ? schedulerEvidence(options) : undefined,
  };
  try {
    if (request.action === "maintenance-schedules-status") {
      return response(request.requestId, "MAINTENANCE_SCHEDULES_READY", {
        ...responseOptions,
        maintenanceSchedules: scheduleSnapshot(options.scheduleOptions || options),
      });
    }
    if (request.action === "maintenance-schedules-update") {
      return response(request.requestId, "MAINTENANCE_SCHEDULES_UPDATED", {
        ...responseOptions,
        accepted: true,
        acceptedAt: new Date(Number.isFinite(options.nowMs) ? options.nowMs : Date.now()).toISOString(),
        maintenanceSchedules: applySchedules(request.schedules, { ...(options.scheduleOptions || options), expectedRevision: request.expectedRevision }),
      });
    }
    const busy = assuranceUnitBusy(options);
    if (request.action === "status") {
      return response(request.requestId, busy ? "ASSURANCE_REQUEST_BUSY" : "ASSURANCE_CONTROL_READY", responseOptions);
    }
    if (busy) return response(request.requestId, "ASSURANCE_REQUEST_BUSY", responseOptions);
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const now = new Date(nowMs);
    if (!Number.isFinite(now.getTime())) fail("ASSURANCE_CONTROL_FAILED");
    const statePath = options.statePath || STATE_PATH;
    const state = readRateLimitState(statePath, options);
    if (state) {
      const elapsedSeconds = Math.floor((nowMs - Date.parse(state.lastAcceptedAt)) / 1000);
      if (!Number.isSafeInteger(elapsedSeconds) || elapsedSeconds < 0) fail("ASSURANCE_CONTROL_FAILED");
      if (elapsedSeconds < RATE_LIMIT_SECONDS) {
        return response(request.requestId, "ASSURANCE_REQUEST_RATE_LIMITED", {
          ...responseOptions,
          retryAfterSeconds: RATE_LIMIT_SECONDS - elapsedSeconds,
        });
      }
    }
    const acceptedAt = now.toISOString();
    // Reserve the root-side rate-limit slot before starting the fixed unit. If
    // systemd rejects the start, failing closed is safer than allowing an
    // unbounded retry storm against the privileged broker.
    writeRateLimitState(statePath, {
      format: STATE_FORMAT,
      schemaVersion: STATE_SCHEMA_VERSION,
      lastAcceptedAt: acceptedAt,
      lastRequestId: request.requestId,
    }, options);
    startAssuranceUnit(options);
    return response(request.requestId, "ASSURANCE_REQUEST_ACCEPTED", {
      ...responseOptions,
      accepted: true,
      acceptedAt,
    });
  } catch (error) {
    if (request.action.startsWith("maintenance-schedules-")) {
      const code = error instanceof MaintenanceScheduleError && error.code === "MAINTENANCE_SCHEDULE_BUSY"
        ? "MAINTENANCE_SCHEDULES_BUSY"
        : error instanceof MaintenanceScheduleError && error.code === "MAINTENANCE_SCHEDULE_INVALID"
          ? "MAINTENANCE_SCHEDULES_INVALID"
          : error instanceof MaintenanceScheduleError && error.code === "MAINTENANCE_SCHEDULE_STALE"
            ? "MAINTENANCE_SCHEDULES_STALE"
          : error instanceof MaintenanceScheduleError && error.code === "MAINTENANCE_SCHEDULE_UNAVAILABLE"
            ? "MAINTENANCE_SCHEDULES_UNAVAILABLE"
            : "MAINTENANCE_SCHEDULES_FAILED";
      return response(request.requestId, code, responseOptions);
    }
    return response(request.requestId, "ASSURANCE_CONTROL_FAILED", responseOptions);
  }
}

function readStandardInput() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => reject(new AssuranceControlBrokerError("ASSURANCE_REQUEST_INVALID")), 2000);
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        clearTimeout(timer);
        process.stdin.destroy();
        reject(new AssuranceControlBrokerError("ASSURANCE_REQUEST_INVALID"));
      } else chunks.push(chunk);
    });
    process.stdin.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    process.stdin.on("error", () => { clearTimeout(timer); reject(new AssuranceControlBrokerError("ASSURANCE_REQUEST_INVALID")); });
  });
}

function writeResponse(output, result) {
  return new Promise((resolve, reject) => {
    // A timed-out/disconnected caller cannot receive the completed result.
    // Do not crash or repeat a privileged operation when its reply is lost.
    // Keep the listener through the asynchronous error event after write's
    // callback; only EPIPE is an expected transport disconnect.
    const onError = (error) => {
      if (error?.code === "EPIPE") resolve(false);
      else reject(error);
    };
    output.once("error", onError);
    try {
      output.write(`${JSON.stringify(result)}\n`, (error) => {
        if (error) onError(error);
        else { output.removeListener("error", onError); resolve(true); }
      });
    } catch (error) {
      output.removeListener("error", onError);
      onError(error);
    }
  });
}

async function main() {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0
    || process.argv.length !== 2) {
    process.exitCode = 1;
    return;
  }
  let result;
  try { result = handleRequest(await readStandardInput()); }
  catch { result = response(null, "ASSURANCE_REQUEST_INVALID"); }
  if (!await writeResponse(process.stdout, result)) {
    process.stderr.write("ASSURANCE_RESPONSE_DISCONNECTED\n");
  }
}

if (require.main === module) main().catch(() => { process.exitCode = 1; });

module.exports = {
  ASSURANCE_UNIT,
  ASSURANCE_TIMER,
  ASSURANCE_TIMER_FRAGMENT,
  MAX_REQUEST_BYTES,
  RATE_LIMIT_SECONDS,
  REQUEST_FORMAT,
  RESPONSE_FORMAT,
  SCHEMA_VERSION,
  STATE_FORMAT,
  STATE_SCHEMA_VERSION,
  AssuranceControlBrokerError,
  assertAssuranceLockBoundary,
  assuranceUnitBusy,
  globalAssuranceBusy,
  handleRequest,
  parseRequest,
  readRateLimitState,
  response,
  schedulerEvidence,
  startAssuranceUnit,
  writeRateLimitState,
  writeResponse,
};
