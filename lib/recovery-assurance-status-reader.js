"use strict";

const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { serialize } = require("node:v8");
const { Worker } = require("node:worker_threads");
const {
  DEFAULT_MAXIMUM_RUN_AGE_HOURS,
  MAX_RETURNED_EVENTS,
  MAX_RETURNED_RUNS,
  readRecoveryAssuranceStatus,
} = require("./recovery-assurance-status");
const { MAX_RECOVERY_TREND_RUNS } = require("./system-center-metrics");

const OPTION_KEYS = [
  "configured", "rootPath", "eventDirectory", "headPath", "publicKeyPath",
  "requireRootOwner", "expectedGid", "maximumReturnedEvents", "maximumRunAgeHours", "now", "reportId",
];
const RESULT_KEYS = new Set([
  "configured", "state", "statusAvailable", "integrityVerified", "severity", "lastErrorCode", "summary",
  "checkedAt", "generatedAt", "ageHours", "maximumAgeHours", "stale", "eventCount", "lastSequence",
  "lastEventHashPrefix", "events", "recentRuns", "trendRuns",
]);

function unavailable(code, options = {}) {
  const value = readRecoveryAssuranceStatus({ configured: false });
  const requestedAge = Number(options.maximumRunAgeHours ?? DEFAULT_MAXIMUM_RUN_AGE_HOURS);
  return {
    ...value,
    configured: true,
    state: "error",
    severity: "critical",
    stale: true,
    lastErrorCode: code,
    maximumAgeHours: Number.isFinite(requestedAge)
      ? Math.max(24, Math.min(24 * 400, requestedAge)) : DEFAULT_MAXIMUM_RUN_AGE_HOURS,
    summary: "Die signierte Recovery-Pruefhistorie konnte nicht sicher bestaetigt werden.",
  };
}

function preparedOptions(input) {
  const options = {};
  for (const key of OPTION_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (value !== null && value !== undefined && !(value instanceof Date)
      && !["string", "number", "boolean"].includes(typeof value)) throw new TypeError("Invalid assurance option");
    options[key] = value instanceof Date ? new Date(value.getTime()) : value;
  }
  return options;
}

function validTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validResult(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === RESULT_KEYS.size && Object.keys(value).every(key => RESULT_KEYS.has(key))
    && value.configured === true && ["ok", "warning", "error"].includes(value.state)
    && typeof value.statusAvailable === "boolean" && typeof value.integrityVerified === "boolean"
    && (!value.integrityVerified || value.statusAvailable)
    && (value.state !== "ok" || (value.integrityVerified && value.statusAvailable && value.stale === false))
    && ["info", "warning", "critical"].includes(value.severity)
    && (value.lastErrorCode === null || (typeof value.lastErrorCode === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.lastErrorCode)))
    && typeof value.summary === "string" && value.summary.length <= 2_048
    && validTimestamp(value.checkedAt) && (value.generatedAt === null || validTimestamp(value.generatedAt))
    && (value.ageHours === null || (Number.isFinite(value.ageHours) && value.ageHours >= 0))
    && Number.isFinite(value.maximumAgeHours) && value.maximumAgeHours >= 24 && value.maximumAgeHours <= 24 * 400
    && typeof value.stale === "boolean"
    && Number.isSafeInteger(value.eventCount) && value.eventCount >= 0 && value.eventCount <= 10_000
    && Number.isSafeInteger(value.lastSequence) && value.lastSequence === value.eventCount
    && (value.lastEventHashPrefix === null || /^[a-f0-9]{12}$/.test(value.lastEventHashPrefix))
    && Array.isArray(value.events) && value.events.length <= MAX_RETURNED_EVENTS
    && Array.isArray(value.recentRuns) && value.recentRuns.length <= MAX_RETURNED_RUNS
    && Array.isArray(value.trendRuns) && value.trendRuns.length <= MAX_RECOVERY_TREND_RUNS;
}

// Only the worker reads files or verifies signatures. Completed results are not
// cached: a later read must detect changes to old events even if head.json has
// not changed. Concurrent identical reads share only the current verification.
function createRecoveryAssuranceStatusReader({
  timeoutMs = 15_000,
  maximumPending = 8,
  WorkerConstructor = Worker,
  workerPath = path.join(__dirname, "recovery-assurance-status-worker.js"),
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || !Number.isSafeInteger(maximumPending) || maximumPending < 1 || maximumPending > 64
    || typeof WorkerConstructor !== "function") throw new TypeError("Invalid assurance reader configuration");
  let worker = null;
  let active = null;
  let sequence = 0;
  let closed = false;
  let closing = null;
  const queue = [];
  const jobs = new Map();
  const retiring = new Set();

  function settle(job, result) {
    clearTimeout(job.timeout);
    jobs.delete(job.key);
    if (active === job) active = null;
    job.resolve(result);
  }

  function retire(next) {
    let termination;
    try { termination = Promise.resolve(next.terminate()).catch(() => {}); }
    catch { termination = Promise.resolve(); }
    retiring.add(termination);
    void termination.finally(() => {
      retiring.delete(termination);
      pump();
    });
    return termination;
  }

  function fail(next, code) {
    if (worker !== next) return;
    worker = null;
    if (active) settle(active, unavailable(code, active.options));
    retire(next);
  }

  function expire(job) {
    if (jobs.get(job.key) !== job) return;
    if (active === job) {
      fail(worker, "RAS_HISTORY_WORKER_TIMEOUT");
      return;
    }
    const index = queue.indexOf(job);
    if (index !== -1) queue.splice(index, 1);
    settle(job, unavailable("RAS_HISTORY_WORKER_TIMEOUT", job.options));
    pump();
  }

  function getWorker() {
    if (worker) return worker;
    const next = new WorkerConstructor(workerPath, {
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
    worker = next;
    // Keep captured output private and unread. Reading worker stdio references
    // Node's separate stdio port, which Worker.unref() does not release; an idle
    // verifier would then keep the server/test process alive indefinitely.
    next.on("error", () => fail(next, "RAS_HISTORY_WORKER_FAILED"));
    next.on("exit", () => fail(next, "RAS_HISTORY_WORKER_FAILED"));
    next.on("message", message => {
      if (worker !== next || closed || !active) return;
      if (!message || typeof message !== "object" || Array.isArray(message)
        || !Number.isSafeInteger(message.id)) {
        fail(next, "RAS_HISTORY_WORKER_PROTOCOL");
        return;
      }
      if (message.id !== active.id) return;
      if (performance.now() >= active.deadline) {
        fail(next, "RAS_HISTORY_WORKER_TIMEOUT");
        return;
      }
      if (Object.keys(message).length !== 2 || !Object.hasOwn(message, "result") || !validResult(message.result)) {
        fail(next, "RAS_HISTORY_WORKER_PROTOCOL");
        return;
      }
      settle(active, message.result);
      pump();
    });
    return next;
  }

  function pump() {
    if (closed || active || retiring.size) return;
    if (!queue.length) {
      worker?.unref();
      return;
    }
    const job = queue.shift();
    if (performance.now() >= job.deadline) {
      settle(job, unavailable("RAS_HISTORY_WORKER_TIMEOUT", job.options));
      pump();
      return;
    }
    let next;
    try { next = getWorker(); }
    catch {
      settle(job, unavailable("RAS_HISTORY_WORKER_FAILED", job.options));
      pump();
      return;
    }
    active = job;
    next.ref();
    try { next.postMessage({ id: job.id, options: job.options }); }
    catch { fail(next, "RAS_HISTORY_WORKER_FAILED"); }
  }

  function read(input = {}) {
    let options;
    try {
      if (!input || typeof input !== "object" || Array.isArray(input) || input.configured !== true) {
        return Promise.resolve(readRecoveryAssuranceStatus({ configured: false }));
      }
      options = preparedOptions(input);
    } catch {
      return Promise.resolve(unavailable("RAS_HISTORY_WORKER_OPTIONS_INVALID"));
    }
    if (closed) return Promise.resolve(unavailable("RAS_HISTORY_WORKER_CLOSED", options));
    const key = serialize(options).toString("base64");
    if (jobs.has(key)) return jobs.get(key).promise;
    if (jobs.size >= maximumPending) return Promise.resolve(unavailable("RAS_HISTORY_WORKER_BUSY", options));
    const job = { id: ++sequence, key, options, deadline: performance.now() + timeoutMs,
      timeout: null, resolve: null, promise: null };
    job.promise = new Promise(resolve => { job.resolve = resolve; });
    jobs.set(key, job);
    // Waiting for another report uses the same total budget as verification;
    // eight different requests must not multiply a 15-second deadline.
    job.timeout = setTimeout(() => expire(job), timeoutMs);
    queue.push(job);
    pump();
    return job.promise;
  }

  function close() {
    if (closing) return closing;
    closed = true;
    const next = worker;
    worker = null;
    if (active) settle(active, unavailable("RAS_HISTORY_WORKER_CLOSED", active.options));
    for (const job of queue.splice(0)) settle(job, unavailable("RAS_HISTORY_WORKER_CLOSED", job.options));
    if (next) retire(next);
    closing = Promise.all([...retiring]).then(() => {});
    return closing;
  }

  return Object.freeze({ read, close });
}

module.exports = { createRecoveryAssuranceStatusReader };
