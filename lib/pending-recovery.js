"use strict";

// Diagnostic queue state, never a substitute for a successful signed full run.
// Callers must verify the complete signed history before setting integrityVerified.
const fs = require("node:fs");
const path = require("node:path");
const DEFAULT_ROOT = "/var/lib/grabenplaner-assurance";
const QUEUE_FILE = "pending-recovery.json";
const FORMAT = "grabenplaner-pending-recovery";
const MAX_AGE_MS = 36 * 60 * 60 * 1000;
const SCHEDULER_GRACE_MS = 3 * 60 * 60 * 1000;
const SCHEDULER_MAX_AGE_MS = 25000;
const CLOCK_SKEW_MS = 5000;
const HASH = /^[a-f0-9]{64}$/;
const QUEUE_KEYS = ["format", "schemaVersion", "queuedEventSequence", "queuedEventHash", "queuedAt", "scheduledFor",
  "deadlineAt", "originalFullPassSequence", "originalFullPassEventHash", "originalFullPassAt", "recordedAt"];
const QUEUED_TYPES = new Set(["update-queued", "configuration-change-queued"]);
function fail(code) { throw Object.assign(new Error(code), { code }); }
function exact(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function nowMilliseconds(value) {
  const now = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(now) || now < 0) fail("PENDING_RECOVERY_TIME_INVALID");
  return now;
}
function validateSchedulerObservation(value, now = Date.now()) {
  const at = nowMilliseconds(now);
  if (!exact(value, ["observedAt", "nextRunAt", "active", "enabled", "evidenceTrusted"])
    || value.evidenceTrusted !== true || value.active !== true || value.enabled !== true
    || !timestamp(value.observedAt) || !timestamp(value.nextRunAt)) fail("PENDING_RECOVERY_SCHEDULER_UNTRUSTED");
  if (Date.parse(value.observedAt) > at + CLOCK_SKEW_MS
    || at - Date.parse(value.observedAt) > SCHEDULER_MAX_AGE_MS) fail("PENDING_RECOVERY_SCHEDULER_STALE");
  return { ...value };
}
function verifiedEvents(events, integrityVerified, now = Date.now()) {
  const at = nowMilliseconds(now);
  if (integrityVerified !== true || !Array.isArray(events) || events.length > 10000) fail("PENDING_RECOVERY_HISTORY_UNVERIFIED");
  let previous = -1;
  for (let index = 0; index < events.length; index++) {
    const event = events[index], payload = event?.payload;
    if (event?.sequence !== index + 1 || !HASH.test(event.eventHash || "") || !payload
      || !timestamp(payload.occurredAt) || Date.parse(payload.occurredAt) < previous
      || Date.parse(payload.occurredAt) > at + CLOCK_SKEW_MS) fail("PENDING_RECOVERY_HISTORY_INVALID");
    previous = Date.parse(payload.occurredAt);
  }
  return events;
}
function coveringPass(events, queued) {
  const starts = new Map(events.filter(event => event.payload.eventType === "full-assurance-started")
    .map(event => [event.payload.runId, event]));
  return events.find(event => event.payload.eventType === "full-assurance-passed"
    && starts.get(event.payload.runId)?.sequence > queued.sequence) || null;
}
function outstandingQueue(events) {
  const starts = new Map(), coveredBefore = events.reduce((latest, event) => {
    if (event.payload.eventType === "full-assurance-started") starts.set(event.payload.runId, event.sequence);
    return event.payload.eventType === "full-assurance-passed"
      ? Math.max(latest, starts.get(event.payload.runId) || 0) : latest;
  }, 0);
  return events.find(event => QUEUED_TYPES.has(event.payload.eventType) && event.sequence >= coveredBefore) || null;
}
function originalFullPass(events, queued) {
  return [...events].reverse().find(event => event.sequence < queued.sequence
    && event.payload.eventType === "full-assurance-passed") || null;
}
function validateQueueSchedule(value, events) {
  if (!exact(value, QUEUE_KEYS) || value.format !== FORMAT || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.queuedEventSequence) || value.queuedEventSequence < 1
    || !Number.isSafeInteger(value.originalFullPassSequence) || value.originalFullPassSequence < 1
    || !HASH.test(value.queuedEventHash || "") || !HASH.test(value.originalFullPassEventHash || "")
    || ![value.queuedAt, value.scheduledFor, value.deadlineAt, value.originalFullPassAt, value.recordedAt].every(timestamp)
    || Date.parse(value.scheduledFor) < Date.parse(value.originalFullPassAt)
    || Date.parse(value.queuedAt) > Date.parse(value.scheduledFor) + SCHEDULER_GRACE_MS
    || Date.parse(value.recordedAt) < Date.parse(value.queuedAt) - CLOCK_SKEW_MS
    || Date.parse(value.recordedAt) >= Date.parse(value.deadlineAt)
    || Date.parse(value.deadlineAt) !== Math.min(Date.parse(value.originalFullPassAt) + MAX_AGE_MS,
      Date.parse(value.scheduledFor) + SCHEDULER_GRACE_MS)) fail("PENDING_RECOVERY_SCHEDULE_INVALID");
  const queued = events.find(event => event.sequence === value.queuedEventSequence);
  const original = queued && originalFullPass(events, queued);
  if (!queued || !QUEUED_TYPES.has(queued.payload.eventType) || queued.eventHash !== value.queuedEventHash
    || queued.payload.occurredAt !== value.queuedAt || !original
    || original.sequence !== value.originalFullPassSequence || original.eventHash !== value.originalFullPassEventHash
    || original.payload.occurredAt !== value.originalFullPassAt) fail("PENDING_RECOVERY_SCHEDULE_BINDING_INVALID");
  return value;
}
function readPendingRecoveryDocument({ rootPath = DEFAULT_ROOT, requireRootOwner = process.platform === "linux", expectedGid = null } = {}) {
  const root = path.resolve(rootPath), file = path.join(root, QUEUE_FILE), directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || root === path.parse(root).root
    || fs.realpathSync(root) !== root || process.platform !== "win32" && (directory.mode & 0o7777) !== 0o750
    || requireRootOwner && directory.uid !== 0 || expectedGid !== null && directory.gid !== expectedGid) fail("PENDING_RECOVERY_PROTECTION_INVALID");
  const before = fs.lstatSync(file);
  const safe = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 1 && stat.size <= 4096
    && (process.platform === "win32" || (stat.mode & 0o7777) === 0o640)
    && (!requireRootOwner || stat.uid === 0) && stat.gid === directory.gid;
  if (!safe(before)) fail("PENDING_RECOVERY_PROTECTION_INVALID");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor), content = fs.readFileSync(descriptor), after = fs.lstatSync(file);
    if (!safe(opened) || !safe(after) || opened.ino !== before.ino || opened.dev !== before.dev
      || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || content.length !== before.size) fail("PENDING_RECOVERY_DOCUMENT_CHANGED");
    return JSON.parse(content.toString("utf8"));
  } finally { fs.closeSync(descriptor); }
}
function unavailablePendingRecovery(reasonCode = "PENDING_RECOVERY_UNAVAILABLE") {
  return { state: "unavailable", evidenceVerified: false, severity: "warning", reasonCode, queuedAt: null, scheduledFor: null,
    deadlineAt: null, originalFullPassAt: null, completedAt: null, queueSequence: null, appVersion: null,
    sourceSha256: null, packageSha256: null, sourceBindingVerified: false, overdue: false };
}
function derivePendingRecovery({ events, integrityVerified, now = Date.now(), schedulerObservation, queueSchedule } = {}) {
  let verified;
  try { verified = verifiedEvents(events, integrityVerified, now); }
  catch (error) { return unavailablePendingRecovery(error.code); }
  const pending = outstandingQueue(verified);
  if (!queueSchedule) {
    return { ...unavailablePendingRecovery(pending ? "PENDING_RECOVERY_SCHEDULE_MISSING" : "PENDING_RECOVERY_NO_QUEUE"),
      state: pending ? "queued" : "unavailable", queuedAt: pending?.payload.occurredAt || null,
      queueSequence: pending?.sequence || null, appVersion: pending?.payload.evidence?.appVersion || null };
  }
  let schedule;
  try {
    schedule = validateQueueSchedule(queueSchedule, verified);
    if (Date.parse(schedule.recordedAt) > nowMilliseconds(now) + CLOCK_SKEW_MS) fail("PENDING_RECOVERY_TIME_INVALID");
    if (pending && pending.sequence < schedule.queuedEventSequence) fail("PENDING_RECOVERY_SCHEDULE_BINDING_INVALID");
    // An old completed slot must not hide a subsequent independently queued update.
    if (pending && coveringPass(verified, verified[schedule.queuedEventSequence - 1])) fail("PENDING_RECOVERY_SCHEDULE_OUTDATED");
  } catch (error) { return unavailablePendingRecovery(error.code); }
  const queued = verified[schedule.queuedEventSequence - 1];
  const base = { ...unavailablePendingRecovery(), queuedAt: schedule.queuedAt, scheduledFor: schedule.scheduledFor,
    deadlineAt: schedule.deadlineAt, originalFullPassAt: schedule.originalFullPassAt, queueSequence: queued.sequence,
    appVersion: queued.payload.evidence?.appVersion || null };
  const passed = coveringPass(verified, queued);
  const at = nowMilliseconds(now), deadline = Date.parse(schedule.deadlineAt);
  const activity = [...verified].reverse().find(event => event.sequence > queued.sequence
    && ["full-assurance-started", "full-assurance-failed"].includes(event.payload.eventType));
  try { validateSchedulerObservation(schedulerObservation, now); }
  catch (error) {
    if (!passed && activity?.payload.eventType === "full-assurance-failed") return { ...base, state: "failed", severity: "critical",
      reasonCode: activity.payload.errorCode || "PENDING_RECOVERY_FAILED", overdue: at >= deadline };
    if (!passed && at >= deadline) return { ...base, state: "overdue", severity: "critical",
      reasonCode: "PENDING_RECOVERY_DEADLINE_EXCEEDED", overdue: true };
    return { ...base, state: "unverified", completedAt: passed?.payload.occurredAt || null, reasonCode: error.code };
  }
  // The original captured timer slot is authoritative. A fired timer's *next*
  // occurrence and repeated deployments must never renew this deadline.
  base.evidenceVerified = true;
  if (passed) {
    const late = Date.parse(passed.payload.occurredAt) >= deadline;
    return { ...base, state: "completed", severity: late ? "warning" : "info",
      reasonCode: late ? "PENDING_RECOVERY_COMPLETED_LATE" : "PENDING_RECOVERY_COMPLETED",
      completedAt: passed.payload.occurredAt, overdue: late };
  }
  if (activity?.payload.eventType === "full-assurance-failed") return { ...base, state: "failed", severity: "critical",
    reasonCode: activity.payload.errorCode || "PENDING_RECOVERY_FAILED", overdue: at >= deadline };
  if (at >= deadline) return { ...base, state: "overdue", severity: "critical", reasonCode: "PENDING_RECOVERY_DEADLINE_EXCEEDED", overdue: true };
  if (activity?.payload.eventType === "full-assurance-started") return { ...base, state: "running", reasonCode: "PENDING_RECOVERY_RUNNING" };
  if (at >= Date.parse(schedule.scheduledFor)) return { ...base, state: "pending", reasonCode: "PENDING_RECOVERY_DUE" };
  return { ...base, state: "queued", reasonCode: "PENDING_RECOVERY_QUEUED" };
}
module.exports = { DEFAULT_ROOT, QUEUE_FILE, FORMAT, MAX_AGE_MS, SCHEDULER_GRACE_MS, SCHEDULER_MAX_AGE_MS, CLOCK_SKEW_MS,
  timestamp, nowMilliseconds, validateSchedulerObservation, verifiedEvents, coveringPass, outstandingQueue, originalFullPass,
  validateQueueSchedule, readPendingRecoveryDocument, unavailablePendingRecovery, derivePendingRecovery };
