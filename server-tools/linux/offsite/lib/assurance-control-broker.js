#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REQUEST_FORMAT = "grabenplaner-assurance-control-request";
const RESPONSE_FORMAT = "grabenplaner-assurance-control-response";
const STATE_FORMAT = "grabenplaner-assurance-control-state";
const SCHEMA_VERSION = 1;
const MAX_REQUEST_BYTES = 1024;
const RATE_LIMIT_SECONDS = 15 * 60;
const SYSTEMCTL = "/usr/bin/systemctl";
const ASSURANCE_UNIT = "grabenplaner-offsite-assurance@manual-admin-ui.service";
const STATE_PATH = "/run/grabenplaner-assurance-control/state.json";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_KEYS = new Set(["action", "format", "requestId", "schemaVersion"]);
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
  if (!exactKeys(value, REQUEST_KEYS) || value.format !== REQUEST_FORMAT || value.schemaVersion !== SCHEMA_VERSION
    || !["start-manual-assurance", "status"].includes(value.action)
    || !UUID_PATTERN.test(String(value.requestId || ""))) {
    fail("ASSURANCE_REQUEST_INVALID");
  }
  return value;
}

function response(requestId, code, options = {}) {
  const accepted = options.accepted === true;
  return {
    format: RESPONSE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    requestId: UUID_PATTERN.test(String(requestId || "")) ? requestId : crypto.randomUUID(),
    accepted,
    code,
    acceptedAt: accepted ? options.acceptedAt : null,
    retryAfterSeconds: code === "ASSURANCE_REQUEST_RATE_LIMITED" ? options.retryAfterSeconds : null,
  };
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
    if (!exactKeys(value, STATE_KEYS) || value.format !== STATE_FORMAT || value.schemaVersion !== SCHEMA_VERSION
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
  if (!exactKeys(value, STATE_KEYS) || value.format !== STATE_FORMAT || value.schemaVersion !== SCHEMA_VERSION
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
  if (systemctlValue("LoadState", options) !== "loaded") fail("ASSURANCE_CONTROL_FAILED");
  const activeState = systemctlValue("ActiveState", options);
  if (["active", "activating", "reloading", "deactivating"].includes(activeState)) return true;
  if (!["inactive", "failed"].includes(activeState)) fail("ASSURANCE_CONTROL_FAILED");
  return false;
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
  try {
    const busy = assuranceUnitBusy(options);
    if (request.action === "status") {
      return response(request.requestId, busy ? "ASSURANCE_REQUEST_BUSY" : "ASSURANCE_CONTROL_READY");
    }
    if (busy) return response(request.requestId, "ASSURANCE_REQUEST_BUSY");
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
      schemaVersion: SCHEMA_VERSION,
      lastAcceptedAt: acceptedAt,
      lastRequestId: request.requestId,
    }, options);
    startAssuranceUnit(options);
    return response(request.requestId, "ASSURANCE_REQUEST_ACCEPTED", { accepted: true, acceptedAt });
  } catch {
    return response(request.requestId, "ASSURANCE_CONTROL_FAILED");
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

async function main() {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0
    || process.argv.length !== 2) {
    process.exitCode = 1;
    return;
  }
  let result;
  try { result = handleRequest(await readStandardInput()); }
  catch { result = response(null, "ASSURANCE_REQUEST_INVALID"); }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) main().catch(() => { process.exitCode = 1; });

module.exports = {
  ASSURANCE_UNIT,
  MAX_REQUEST_BYTES,
  RATE_LIMIT_SECONDS,
  REQUEST_FORMAT,
  RESPONSE_FORMAT,
  SCHEMA_VERSION,
  STATE_FORMAT,
  AssuranceControlBrokerError,
  assuranceUnitBusy,
  handleRequest,
  parseRequest,
  readRateLimitState,
  response,
  startAssuranceUnit,
  writeRateLimitState,
};
