"use strict";

// Root-owned, immutable due slot linked to existing signed history. This file
// neither signs a recovery success nor changes the original signed schema.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const history = require("../offsite/lib/assurance-history");
const queue = require("../../../lib/pending-recovery");
const TEST_POLICY = Object.freeze({ name: "deploy-recovery-queue-test-policy" });
function fail(code) { throw Object.assign(new Error(code), { code }); }
function authority(rootPath, policy) {
  const root = path.resolve(rootPath);
  if (policy === TEST_POLICY) {
    const temporary = fs.realpathSync(os.tmpdir());
    if (!root.startsWith(temporary + path.sep) || fs.realpathSync(root) !== root) fail("PENDING_RECOVERY_TEST_ROOT_INVALID");
  } else if (process.platform !== "linux" || process.getuid?.() !== 0 || root !== queue.DEFAULT_ROOT) fail("PENDING_RECOVERY_ROOT_REQUIRED");
  return root;
}
function recordQueueLocked({ scheduledForEpochMs, now = Date.now(), rootPath = queue.DEFAULT_ROOT, policy } = {}) {
  const root = authority(rootPath, policy), at = queue.nowMilliseconds(now), due = queue.nowMilliseconds(scheduledForEpochMs);
  const directory = fs.lstatSync(root), test = policy === TEST_POLICY;
  if (!directory.isDirectory() || directory.isSymbolicLink() || fs.realpathSync(root) !== root
    || !test && directory.uid !== 0 || process.platform !== "win32" && (directory.mode & 0o7777) !== 0o750) fail("PENDING_RECOVERY_PROTECTION_INVALID");
  const inspected = history.inspectHistory({ root, statusGid: directory.gid,
    ...(test ? { policy: history.__internalTestOnly.policy } : {}) });
  const events = queue.verifiedEvents(inspected.events, inspected.ok === true, at);
  const queued = queue.outstandingQueue(events);
  if (!queued || queued.payload.eventType !== "update-queued") fail("PENDING_RECOVERY_NO_UPDATE_QUEUE");
  let previous = null;
  try {
    previous = queue.validateQueueSchedule(queue.readPendingRecoveryDocument({ rootPath: root, requireRootOwner: !test, expectedGid: directory.gid }), events);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous && !queue.coveringPass(events, events[previous.queuedEventSequence - 1])) {
    if (previous.queuedEventSequence !== queued.sequence) fail("PENDING_RECOVERY_SCHEDULE_BINDING_INVALID");
    return { ok: true, preserved: true, queuedAt: previous.queuedAt, scheduledFor: previous.scheduledFor, deadlineAt: previous.deadlineAt };
  }
  const original = queue.originalFullPass(events, queued);
  const originalAt = Date.parse(original?.payload.occurredAt);
  const deadline = Math.min(originalAt + queue.MAX_AGE_MS, due + queue.SCHEDULER_GRACE_MS);
  // Capture may precede the app swap and its health checks. Keep that original
  // slot even when it has just fired; only its original bounded grace remains.
  if (!original || due < originalAt || Date.parse(queued.payload.occurredAt) > due + queue.SCHEDULER_GRACE_MS
    || at >= deadline || at - Date.parse(queued.payload.occurredAt) > queue.SCHEDULER_MAX_AGE_MS) fail("PENDING_RECOVERY_ANCHOR_OR_DUE_INVALID");
  const value = { format: queue.FORMAT, schemaVersion: 1, queuedEventSequence: queued.sequence,
    queuedEventHash: queued.eventHash, queuedAt: queued.payload.occurredAt, scheduledFor: new Date(due).toISOString(),
    deadlineAt: new Date(deadline).toISOString(),
    originalFullPassSequence: original.sequence, originalFullPassEventHash: original.eventHash,
    originalFullPassAt: original.payload.occurredAt, recordedAt: new Date(at).toISOString() };
  queue.validateQueueSchedule(value, events);
  const file = path.join(root, queue.QUEUE_FILE), temporary = path.join(root, `.${queue.QUEUE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o640);
    if (process.platform !== "win32") { fs.fchownSync(descriptor, test ? process.getuid() : 0, directory.gid); fs.fchmodSync(descriptor, 0o640); }
    fs.writeFileSync(descriptor, JSON.stringify(value) + "\n"); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file);
    if (process.platform !== "win32") {
      const parent = fs.openSync(root, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { ok: true, preserved: false, queuedAt: value.queuedAt, scheduledFor: value.scheduledFor, deadlineAt: value.deadlineAt };
}
function recordQueue(options = {}) {
  const root = authority(options.rootPath || queue.DEFAULT_ROOT, options.policy);
  // No stale-lock removal: interruption is a visible operational error, never
  // authority for a new due slot or a reset of an outstanding deadline.
  const lock = path.join(root, ".pending-recovery.record.lock");
  const descriptor = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { return recordQueueLocked(options); }
  finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}
function main(args = process.argv.slice(2)) {
  if (process.platform !== "linux" || process.getuid?.() !== 0) fail("PENDING_RECOVERY_ROOT_REQUIRED");
  if (args.length !== 2 || args[0] !== "record" || !/^[1-9]\d{12}$/.test(args[1])) fail("PENDING_RECOVERY_ARGUMENTS_INVALID");
  return recordQueue({ scheduledForEpochMs: Number(args[1]) });
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(main()) + "\n"); }
  catch (error) { process.stderr.write((error.code || "PENDING_RECOVERY_RECORD_FAILED") + "\n"); process.exitCode = 1; }
}
module.exports = { recordQueue, main, __internalTestOnly: Object.freeze({ policy: TEST_POLICY }) };
