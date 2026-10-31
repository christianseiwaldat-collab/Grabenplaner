"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const Q = require("../lib/pending-recovery");
const producer = require("../server-tools/linux/lib/deploy-recovery-queue");
const writer = require("../server-tools/linux/offsite/lib/assurance-history");
const { readRecoveryAssuranceStatus, canonicalHash, headUnsigned } = require("../lib/recovery-assurance-status");
const { createRecoveryAssuranceStatusReader } = require("../lib/recovery-assurance-status-reader");
const origin = Date.parse("2026-10-28T00:00:00.000Z");
const stamp = milliseconds => new Date(milliseconds).toISOString();
const scheduler = (now, due, extra = {}) => ({ observedAt: stamp(now), nextRunAt: stamp(due), active: true, enabled: true, evidenceTrusted: true, ...extra });
function fixture({ queueDelayMs = 60 * 60 * 1000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-pending-recovery-"));
  fs.chmodSync(root, 0o750);
  const statusGid = process.getgid?.() || 0, policy = writer.__internalTestOnly.policy;
  writer.initializeHistory({ root, statusGid, policy });
  const add = (eventType, at, runId = crypto.randomUUID(), extra = {}) => {
    const result = writer.appendEvent({ root, statusGid, policy, eventType, runId, trigger: "scheduled-nightly", now: new Date(at), ...extra });
    // The real writer deliberately stamps the head with wall-clock time. Only
    // this synthetic fixture signs a deterministic head for boundary tests.
    const headPath = path.join(root, "head.json"), head = JSON.parse(fs.readFileSync(headPath, "utf8"));
    head.generatedAt = stamp(at);
    head.signature = crypto.sign(null, Buffer.from(canonicalHash(headUnsigned(head)), "hex"),
      crypto.createPrivateKey(fs.readFileSync(path.join(root, "signing-private.pem")))).toString("base64");
    fs.writeFileSync(headPath, JSON.stringify(head));
    return result;
  };
  const pass = (at, runId = crypto.randomUUID()) => {
    add("full-assurance-started", at, runId);
    for (const [index, eventType] of ["oauth-policy-passed", "backup-passed", "repository-check-passed", "restore-test-passed", "application-smoke-passed"].entries()) {
      add(eventType, at + (index + 1) * 1000, runId);
    }
    add("full-assurance-passed", at + 6000, runId, { evidence: { snapshotIdPrefix: "a".repeat(12), receiptSha256: "b".repeat(64), appVersion: "0.92.94-beta" } });
    return at + 6000;
  };
  const inspect = () => writer.inspectHistory({ root, statusGid, policy });
  const queuedAt = origin + queueDelayMs;
  const passedAt = pass(origin);
  add("update-queued", queuedAt, crypto.randomUUID(), { trigger: "app-updated", evidence: { appVersion: "0.92.95-beta" } });
  const now = queuedAt + 1000, due = queuedAt + 60 * 60 * 1000;
  const record = (captured = due, at = now) => producer.recordQueue({ scheduledForEpochMs: captured, now: at, rootPath: root, policy: producer.__internalTestOnly.policy });
  const document = () => Q.readPendingRecoveryDocument({ rootPath: root, requireRootOwner: false, expectedGid: statusGid });
  const derive = (at = now, observation = scheduler(at, due), schedule = document()) => Q.derivePendingRecovery({
    events: inspect().events, integrityVerified: true, now: at, schedulerObservation: observation, queueSchedule: schedule });
  const options = at => ({ configured: true, rootPath: root, requireRootOwner: false, expectedGid: statusGid,
    now: new Date(at), schedulerObservation: scheduler(at, due) });
  const cleanup = () => {
    const absolute = fs.realpathSync(root), temporary = fs.realpathSync(os.tmpdir());
    assert.ok(absolute.startsWith(temporary + path.sep) && path.basename(absolute).startsWith("gp-pending-recovery-"));
    fs.rmSync(absolute, { recursive: true, force: true });
  };
  return { root, statusGid, add, pass, inspect, queuedAt, passedAt, now, due, record, document, derive, options, cleanup };
}
function withFixture(callback) {
  const value = fixture();
  try { return callback(value); } finally { value.cleanup(); }
}

test("root producer records an immutable queue bound to real signed events without inventing source identity", () => withFixture(f => {
  const result = f.record(), value = f.document();
  assert.equal(result.ok, true);
  assert.equal(result.preserved, false);
  assert.equal(value.queuedAt, stamp(f.queuedAt));
  assert.equal(value.originalFullPassAt, stamp(f.passedAt));
  assert.equal(value.deadlineAt, stamp(f.due + Q.SCHEDULER_GRACE_MS));
  assert.equal(value.queuedEventHash, f.inspect().events.at(-1).eventHash);
  assert.deepEqual(Object.keys(f.inspect().events.at(-1).payload.evidence).sort(), ["appVersion", "receiptSha256", "snapshotIdPrefix"]);
  const state = f.derive();
  assert.equal(state.state, "queued");
  assert.equal(state.evidenceVerified, true);
  assert.equal(state.appVersion, "0.92.95-beta");
  assert.equal(state.sourceSha256, null);
  assert.equal(state.packageSha256, null);
  assert.equal(state.sourceBindingVerified, false);
  assert.equal(Object.hasOwn(state, "appAvailable"), false);
  assert.doesNotMatch(JSON.stringify(state), /eventHash|receiptSha256|signature|keyId/);
}));

test("requeues and changed future scheduler slots cannot extend the original deadline", () => withFixture(f => {
  f.record();
  const original = f.document();
  f.add("update-queued", f.now + 1000, crypto.randomUUID(), { trigger: "app-updated" });
  assert.equal(f.record(f.due + 86400000, f.now + 2000).preserved, true);
  assert.deepEqual(f.document(), original);
  const later = f.derive(f.due + 1, scheduler(f.due + 1, f.due + 86400000));
  assert.equal(later.state, "pending");
  assert.equal(later.deadlineAt, original.deadlineAt);
  const expired = f.derive(Date.parse(original.deadlineAt), scheduler(Date.parse(original.deadlineAt), f.due + 86400000));
  assert.equal(expired.state, "overdue");
  assert.equal(expired.severity, "critical");
  const schedulerLost = f.derive(Date.parse(original.deadlineAt), null);
  assert.equal(schedulerLost.state, "overdue");
  assert.equal(schedulerLost.evidenceVerified, false);
  assert.equal(schedulerLost.severity, "critical");
  assert.equal(f.record(f.due + 172800000, Date.parse(original.deadlineAt)).preserved, true);
  assert.deepEqual(f.document(), original);
}));

test("36-hour original full-Assurance expiry is the other hard deadline", () => withFixture(f => {
  f.record(f.queuedAt + Q.MAX_AGE_MS);
  assert.equal(f.document().deadlineAt, stamp(f.passedAt + Q.MAX_AGE_MS));
  assert.equal(f.derive(f.passedAt + Q.MAX_AGE_MS, scheduler(f.passedAt + Q.MAX_AGE_MS, f.queuedAt + Q.MAX_AGE_MS)).state, "overdue");
}));

test("a captured original timer slot remains valid two minutes after due without extending its grace", () => withFixture(f => {
  const originalDue = f.queuedAt - 120000;
  const result = f.record(originalDue);
  assert.equal(result.preserved, false);
  assert.equal(f.document().scheduledFor, stamp(originalDue));
  assert.equal(f.document().deadlineAt, stamp(originalDue + Q.SCHEDULER_GRACE_MS));
  assert.doesNotThrow(() => Q.validateQueueSchedule(f.document(), f.inspect().events));
  assert.equal(f.derive().state, "pending");
  assert.equal(f.record(f.due + 86400000).preserved, true);
  assert.equal(f.document().scheduledFor, stamp(originalDue));
  assert.equal(f.document().deadlineAt, stamp(originalDue + Q.SCHEDULER_GRACE_MS));
}));

test("a first queue record at or beyond the original three-hour limit is rejected", () => {
  const f = fixture({ queueDelayMs: 4 * 60 * 60 * 1000 });
  try {
    assert.throws(() => f.record(f.queuedAt - Q.SCHEDULER_GRACE_MS, f.queuedAt), { code: "PENDING_RECOVERY_ANCHOR_OR_DUE_INVALID" });
    assert.throws(() => f.record(f.queuedAt - Q.SCHEDULER_GRACE_MS - 1, f.now), { code: "PENDING_RECOVERY_ANCHOR_OR_DUE_INVALID" });
    assert.equal(fs.existsSync(path.join(f.root, Q.QUEUE_FILE)), false);
  } finally { f.cleanup(); }
});

test("queued, due, running, failed and completed states remain separate from application availability", () => withFixture(f => {
  f.record();
  assert.equal(f.derive(f.due, scheduler(f.due, f.due)).state, "pending");
  const runId = crypto.randomUUID();
  f.add("full-assurance-started", f.due + 1000, runId);
  assert.equal(f.derive(f.due + 2000).state, "running");
  f.add("full-assurance-failed", f.due + 3000, runId, { errorCode: "RESTORE_TEST_FAILED" });
  assert.equal(f.derive(f.due + 4000).state, "failed");
  assert.equal(f.derive(f.due + 4000).reasonCode, "RESTORE_TEST_FAILED");
  const completed = f.pass(f.due + 5000);
  const final = f.derive(completed + 1000);
  assert.equal(final.state, "completed");
  assert.equal(final.completedAt, stamp(completed));
  assert.equal(final.severity, "info");
  assert.equal(final.deadlineAt, f.document().deadlineAt);
}));

test("a run started before an update cannot satisfy its pending recovery", () => withFixture(f => {
  const runId = crypto.randomUUID();
  f.add("full-assurance-started", f.now, runId);
  f.add("update-queued", f.now + 1000, crypto.randomUUID(), { trigger: "app-updated" });
  for (const [index, kind] of ["oauth-policy-passed", "backup-passed", "repository-check-passed", "restore-test-passed", "application-smoke-passed"].entries()) f.add(kind, f.now + 2000 + index * 1000, runId);
  f.add("full-assurance-passed", f.now + 7000, runId);
  f.record(f.due, f.now + 8000);
  assert.equal(f.document().queuedAt, stamp(f.now + 1000));
  assert.notEqual(f.derive(f.now + 9000).state, "completed");
}));

test("a completed old slot cannot hide a later update, which may receive a new independently bounded slot", () => withFixture(f => {
  f.record();
  const completed = f.pass(f.now + 1000);
  f.add("update-queued", completed + 1000, crypto.randomUUID(), { trigger: "app-updated" });
  const outdated = f.derive(completed + 2000);
  assert.equal(outdated.evidenceVerified, false);
  assert.equal(outdated.reasonCode, "PENDING_RECOVERY_SCHEDULE_OUTDATED");
  assert.equal(f.record(f.due, completed + 2000).preserved, false);
  assert.equal(f.document().originalFullPassAt, stamp(completed));
  assert.equal(f.derive(completed + 3000).state, "queued");
}));

test("freshness, canonical time and scheduler authority have exact positive and negative boundaries", async t => {
  const now = origin + 100000, due = now + 1000;
  assert.doesNotThrow(() => Q.validateSchedulerObservation(scheduler(now - 25000, due), now));
  assert.doesNotThrow(() => Q.validateSchedulerObservation(scheduler(now + 5000, due), new Date(now)));
  for (const [name, value] of [
    ["absent", undefined], ["untrusted", scheduler(now, due, { evidenceTrusted: false })],
    ["inactive", scheduler(now, due, { active: false })], ["disabled", scheduler(now, due, { enabled: false })],
    ["stale", scheduler(now - 25001, due)], ["future", scheduler(now + 5001, due)],
    ["invalid date", scheduler(now, due, { observedAt: "2026-02-30T00:00:00.000Z" })],
    ["noncanonical", scheduler(now, due, { nextRunAt: "2026-10-28T01:00:00Z" })],
    ["string flags", scheduler(now, due, { enabled: "true" })], ["extra fields", { ...scheduler(now, due), green: true }],
  ]) await t.test(name, () => assert.throws(() => Q.validateSchedulerObservation(value, now)));
  for (const invalidNow of [NaN, Infinity, -1, "2026-10-28", new Date("invalid")]) {
    assert.throws(() => Q.validateSchedulerObservation(scheduler(now, due), invalidNow));
  }
});

test("missing, stale or disabled scheduler observations cannot make a signed completed queue green", () => withFixture(f => {
  f.record();
  const completed = f.pass(f.now + 1000), now = completed + 1000;
  for (const observation of [null, scheduler(now - 25001, f.due), scheduler(now, f.due, { enabled: false })]) {
    const state = f.derive(now, observation);
    assert.equal(state.state, "unverified");
    assert.equal(state.evidenceVerified, false);
    assert.notEqual(state.severity, "info");
  }
}));

test("completion after the original deadline preserves the missed-deadline evidence", () => withFixture(f => {
  f.record();
  const deadline = Date.parse(f.document().deadlineAt), completed = f.pass(deadline + 1000);
  const state = f.derive(completed + 1000);
  assert.equal(state.state, "completed");
  assert.equal(state.overdue, true);
  assert.equal(state.severity, "warning");
  assert.equal(state.reasonCode, "PENDING_RECOVERY_COMPLETED_LATE");
  assert.equal(state.deadlineAt, stamp(deadline));
}));

test("producer cannot invent a prior Assurance or queue event, or reset a malformed durable schedule", () => withFixture(f => {
  f.record();
  const file = path.join(f.root, Q.QUEUE_FILE), value = f.document();
  fs.writeFileSync(file, JSON.stringify({ ...value, queuedEventHash: "d".repeat(64) }));
  assert.throws(() => f.record(), { code: "PENDING_RECOVERY_SCHEDULE_BINDING_INVALID" });
  fs.writeFileSync(file, "{malformed");
  assert.throws(() => f.record(), SyntaxError);
  fs.unlinkSync(file);
  assert.equal(Q.derivePendingRecovery({ events: [], integrityVerified: true, now: f.now,
    schedulerObservation: scheduler(f.now, f.due) }).evidenceVerified, false);
  const history = f.inspect().events.filter(event => event.sequence > 7).map((event, index) => ({ ...event, sequence: index + 1 }));
  assert.equal(Q.outstandingQueue(history).payload.eventType, "update-queued");
  assert.equal(Q.originalFullPass(history, history[0]), null);
}));

test("invalid history, clock, queue binding and deadline tampering fail closed", () => withFixture(f => {
  f.record();
  const value = f.document(), events = f.inspect().events;
  const derive = extra => Q.derivePendingRecovery({ events, integrityVerified: true, now: f.now,
    schedulerObservation: scheduler(f.now, f.due), queueSchedule: value, ...extra });
  for (const extra of [{ integrityVerified: false }, { now: NaN }, { now: f.queuedAt - 5001 },
    { events: events.slice(1) }, { events: [...events].reverse() },
    ...[{ queuedEventHash: "c".repeat(64) }, { originalFullPassEventHash: "c".repeat(64) },
      { queuedAt: stamp(f.queuedAt + 1) }, { deadlineAt: stamp(Date.parse(value.deadlineAt) + 1) },
      { originalFullPassAt: stamp(f.passedAt + 1) }, { recordedAt: stamp(f.now + 5001) },
      { scheduledFor: stamp(f.passedAt - 1) }, { packageSha256: "c".repeat(64) }]
      .map(patch => ({ queueSchedule: { ...value, ...patch } }))]) {
    const state = derive(extra);
    assert.equal(state.evidenceVerified, false, JSON.stringify(extra));
    assert.notEqual(state.severity, "info");
    assert.notEqual(state.state, "completed");
  }
}));

test("missing durable schedule exposes queued evidence but no inferred due or signed source binding", () => withFixture(f => {
  const state = Q.derivePendingRecovery({ events: f.inspect().events, integrityVerified: true, now: f.now,
    schedulerObservation: scheduler(f.now, f.due) });
  assert.equal(state.state, "queued");
  assert.equal(state.evidenceVerified, false);
  assert.equal(state.deadlineAt, null);
  assert.equal(state.sourceBindingVerified, false);
}));

test("producer rejects stale queue capture, expired assurance, invalid due and a held recording lock", () => withFixture(f => {
  assert.throws(() => f.record(f.due, f.queuedAt + 25001), { code: "PENDING_RECOVERY_ANCHOR_OR_DUE_INVALID" });
  assert.throws(() => f.record(f.passedAt - 1), { code: "PENDING_RECOVERY_ANCHOR_OR_DUE_INVALID" });
  assert.throws(() => f.record(NaN), { code: "PENDING_RECOVERY_TIME_INVALID" });
  assert.throws(() => f.record(f.passedAt + Q.MAX_AGE_MS + 1000, f.passedAt + Q.MAX_AGE_MS), { code: "PENDING_RECOVERY_ANCHOR_OR_DUE_INVALID" });
  const lock = path.join(f.root, ".pending-recovery.record.lock");
  fs.writeFileSync(lock, "held", { mode: 0o600 });
  assert.throws(() => f.record(), { code: "EEXIST" });
  assert.equal(fs.readFileSync(lock, "utf8"), "held");
}));

test("producer and status reader detect tampered signed history and cannot repair it through queue writes", () => withFixture(f => {
  f.record();
  const file = fs.readdirSync(path.join(f.root, "history")).at(-1), location = path.join(f.root, "history", file);
  const event = JSON.parse(fs.readFileSync(location, "utf8"));
  event.payload.evidence.appVersion = "9.9.9";
  fs.writeFileSync(location, JSON.stringify(event));
  assert.throws(() => f.record());
  const state = readRecoveryAssuranceStatus(f.options(f.now));
  assert.equal(state.integrityVerified, false);
  assert.equal(state.pendingRecovery.evidenceVerified, false);
}));

test("reader rejects hard links, symlinks and insecure Unix permissions without altering legacy history status", () => withFixture(f => {
  f.record();
  const file = path.join(f.root, Q.QUEUE_FILE), hardlink = path.join(f.root, "extra-link");
  fs.linkSync(file, hardlink);
  assert.throws(() => f.document(), { code: "PENDING_RECOVERY_PROTECTION_INVALID" });
  assert.equal(readRecoveryAssuranceStatus(f.options(f.now)).integrityVerified, true);
  assert.equal(readRecoveryAssuranceStatus(f.options(f.now)).pendingRecovery.evidenceVerified, false);
  fs.unlinkSync(hardlink);
  if (process.platform !== "win32") {
    const saved = file + ".saved";
    fs.renameSync(file, saved); fs.symlinkSync(saved, file);
    assert.throws(() => f.document(), { code: "PENDING_RECOVERY_PROTECTION_INVALID" });
    fs.unlinkSync(file); fs.renameSync(saved, file);
    fs.chmodSync(file, 0o660);
    assert.throws(() => f.document(), { code: "PENDING_RECOVERY_PROTECTION_INVALID" });
    fs.chmodSync(file, 0o640);
    assert.equal(fs.statSync(file).uid, process.getuid());
    assert.equal(fs.statSync(file).gid, f.statusGid);
    assert.equal(fs.statSync(file).mode & 0o7777, 0o640);
    fs.chmodSync(f.root, 0o770);
    assert.throws(() => f.document(), { code: "PENDING_RECOVERY_PROTECTION_INVALID" });
    fs.chmodSync(f.root, 0o750);
    if (process.getuid() === 0) {
      fs.chownSync(file, 65534, f.statusGid);
      assert.throws(() => Q.readPendingRecoveryDocument({ rootPath: f.root, requireRootOwner: true, expectedGid: f.statusGid }), { code: "PENDING_RECOVERY_PROTECTION_INVALID" });
      fs.chownSync(file, 0, f.statusGid);
    } else {
      assert.throws(() => Q.readPendingRecoveryDocument({ rootPath: f.root, requireRootOwner: true, expectedGid: f.statusGid }), { code: "PENDING_RECOVERY_PROTECTION_INVALID" });
    }
  }
}));

test("async status reader carries fresh scheduler observations off-thread and never caches completed queue state", async () => {
  const f = fixture(), reader = createRecoveryAssuranceStatusReader();
  try {
    f.record();
    const first = await reader.read(f.options(f.now));
    assert.equal(first.integrityVerified, true, JSON.stringify(first));
    assert.equal(first.pendingRecovery.state, "queued");
    const completed = f.pass(f.now + 1000);
    const final = await reader.read(f.options(completed + 1000));
    assert.equal(final.pendingRecovery.state, "completed", JSON.stringify(final));
    const stale = await reader.read({ ...f.options(completed + 1000), schedulerObservation: scheduler(f.now - 25001, f.due) });
    assert.equal(stale.state, "ok");
    assert.equal(stale.pendingRecovery.state, "unverified");
    assert.equal(stale.pendingRecovery.evidenceVerified, false);
  } finally { await reader.close(); f.cleanup(); }
});
