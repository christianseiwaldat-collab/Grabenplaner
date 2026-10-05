"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { createRecoveryAssuranceStatusReader } = require("../lib/recovery-assurance-status-reader");
const { readRecoveryAssuranceStatus } = require("../lib/recovery-assurance-status");

test("a real idle reader lets its process exit naturally and can reuse its worker after idle", async (t) => {
  for (const reads of [1, 3]) {
    await t.test(`${reads} completed read(s) without explicit close`, () => {
      const source = `
        const assert = require("node:assert/strict");
        const { Worker } = require("node:worker_threads");
        const { randomUUID } = require("node:crypto");
        const path = require("node:path");
        const os = require("node:os");
        const { createRecoveryAssuranceStatusReader } = require(${JSON.stringify(require.resolve("../lib/recovery-assurance-status-reader"))});
        let starts = 0;
        class TrackedWorker extends Worker {
          constructor(...args) { super(...args); starts += 1; }
        }
        const reader = createRecoveryAssuranceStatusReader({ WorkerConstructor: TrackedWorker });
        const options = { configured: true, requireRootOwner: false,
          rootPath: path.join(os.tmpdir(), "gp-assurance-absent-" + randomUUID()) };
        (async () => {
          for (let index = 0; index < ${reads}; index += 1) {
            if (index) await new Promise(resolve => setTimeout(resolve, 20));
            const result = await reader.read(options);
            assert.equal(result.lastErrorCode, "RAS_HISTORY_MISSING");
          }
          assert.equal(starts, 1, "successive reads must reuse the idle worker");
          process.stdout.write(JSON.stringify({ completed: ${reads}, starts }) + "\\n");
          // Deliberately neither close the reader nor force process.exit().
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `;
      const child = spawnSync(process.execPath, ["-e", source], {
        encoding: "utf8", timeout: 5_000, windowsHide: true,
      });
      assert.equal(child.error, undefined, `completed reader retained the process: ${child.error?.code}; ${child.stdout}`);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.signal, null);
      assert.equal(child.stderr, "");
      assert.deepEqual(JSON.parse(child.stdout), { completed: reads, starts: 1 });
    });
  }
});

function verifiedStatus() {
  return {
    ...readRecoveryAssuranceStatus({ configured: false }),
    configured: true,
    state: "ok",
    statusAvailable: true,
    integrityVerified: true,
    generatedAt: new Date().toISOString(),
    ageHours: 0,
    eventCount: 7,
    lastSequence: 7,
    lastEventHashPrefix: "a".repeat(12),
  };
}

function fixture(configuration = {}) {
  const instances = [];
  class FakeWorker extends EventEmitter {
    constructor(file, options) {
      super();
      this.file = file;
      this.options = options;
      this.sent = [];
      this.refCount = 0;
      this.unrefCount = 0;
      this.terminations = 0;
      instances.push(this);
    }
    postMessage(message) { this.sent.push(message); }
    ref() { this.refCount += 1; }
    unref() { this.unrefCount += 1; }
    terminate() { this.terminations += 1; return Promise.resolve(0); }
    reply(result = verifiedStatus(), id = this.sent.at(-1).id) { this.emit("message", { id, result }); }
  }
  return { instances, reader: createRecoveryAssuranceStatusReader({ WorkerConstructor: FakeWorker, ...configuration }) };
}

test("unconfigured reads never create a worker and retain the original unconfigured contract", async () => {
  const { reader, instances } = fixture();
  try {
    for (const options of [undefined, null, {}, { configured: false }, []]) {
      const result = await reader.read(options);
      assert.equal(result.configured, false);
      assert.equal(result.state, "unconfigured");
      assert.equal(result.integrityVerified, false);
    }
    assert.equal(instances.length, 0);
  } finally { await reader.close(); }
});

test("identical pending reads share verification, distinct reads queue, completed results are verified again", async () => {
  const { reader, instances } = fixture({ maximumPending: 2 });
  try {
    const now = new Date("2026-10-05T08:00:00.000Z");
    const options = { configured: true, rootPath: "first", now, ignoredSecret: "never transfer" };
    const first = reader.read(options);
    const duplicate = reader.read({ now: new Date(now), configured: true, rootPath: "first" });
    assert.equal(first, duplicate);
    const second = reader.read({ configured: true, rootPath: "second" });
    const busy = await reader.read({ configured: true, rootPath: "third" });
    assert.equal(busy.lastErrorCode, "RAS_HISTORY_WORKER_BUSY");
    assert.equal(busy.integrityVerified, false);
    assert.equal(instances.length, 1);
    const worker = instances[0];
    assert.equal(worker.sent.length, 1);
    assert.equal(Object.hasOwn(worker.sent[0].options, "ignoredSecret"), false);
    now.setUTCFullYear(2000);
    assert.equal(worker.sent[0].options.now.getUTCFullYear(), 2026);
    assert.deepEqual(worker.options.env, {});
    assert.deepEqual(worker.options.execArgv, []);
    worker.reply();
    assert.equal((await first).integrityVerified, true);
    assert.equal(worker.sent.length, 2);
    worker.reply();
    await second;
    assert.equal(worker.unrefCount, 1);
    const fresh = reader.read({ configured: true, rootPath: "first", now: new Date("2026-10-05T08:00:00.000Z") });
    assert.notEqual(fresh, first);
    assert.equal(worker.sent.length, 3);
    assert.equal(worker.refCount, 3);
    worker.reply();
    await fresh;
  } finally { await reader.close(); }
});

test("worker errors settle once, ignore late messages and restart queued verification", async () => {
  const { reader, instances } = fixture();
  try {
    const first = reader.read({ configured: true });
    const second = reader.read({ configured: true, reportId: "a".repeat(64) });
    const old = instances[0];
    old.emit("error", new Error("must not expose a path or secret"));
    old.reply();
    old.emit("exit", 1);
    assert.equal((await first).lastErrorCode, "RAS_HISTORY_WORKER_FAILED");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(instances.length, 2);
    assert.equal(old.terminations, 1);
    instances[1].reply();
    assert.equal((await second).integrityVerified, true);
  } finally { await reader.close(); }
});

test("malformed worker replies fail closed and a subsequent read uses a new worker", async () => {
  for (const reply of [null, { id: 1, result: { state: "ok", integrityVerified: true } }, { id: 1, result: { ...verifiedStatus(), privateKey: "forbidden" } }]) {
    const { reader, instances } = fixture();
    try {
      const first = reader.read({ configured: true });
      instances[0].emit("message", reply);
      const result = await first;
      assert.equal(result.lastErrorCode, "RAS_HISTORY_WORKER_PROTOCOL");
      assert.equal(result.integrityVerified, false);
      assert.equal(JSON.stringify(result).includes("privateKey"), false);
      await new Promise(resolve => setImmediate(resolve));
      const next = reader.read({ configured: true });
      assert.equal(instances.length, 2);
      instances[1].reply();
      assert.equal((await next).integrityVerified, true);
    } finally { await reader.close(); }
  }
});

test("timed-out verification terminates the worker and cannot be re-greened by its late reply", async () => {
  const { reader, instances } = fixture({ timeoutMs: 10 });
  try {
    const first = reader.read({ configured: true, maximumRunAgeHours: 30 });
    const old = instances[0];
    const result = await first;
    assert.equal(result.lastErrorCode, "RAS_HISTORY_WORKER_TIMEOUT");
    assert.equal(result.maximumAgeHours, 30);
    assert.equal(result.integrityVerified, false);
    old.reply();
    await new Promise(resolve => setImmediate(resolve));
    const next = reader.read({ configured: true });
    assert.equal(instances.length, 2);
    instances[1].reply();
    assert.equal((await next).integrityVerified, true);
  } finally { await reader.close(); }
});

test("queued verification keeps its original total deadline when it becomes active", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { reader, instances } = fixture({ timeoutMs: 100 });
  try {
    const first = reader.read({ configured: true });
    const queued = reader.read({ configured: true, reportId: "c".repeat(64) });
    const worker = instances[0];
    t.mock.timers.tick(60);
    worker.reply();
    assert.equal((await first).integrityVerified, true);
    assert.equal(worker.sent.length, 2);
    t.mock.timers.tick(39);
    assert.equal(worker.terminations, 0);
    t.mock.timers.tick(1);
    assert.equal((await queued).lastErrorCode, "RAS_HISTORY_WORKER_TIMEOUT");
    assert.equal(worker.terminations, 1);
  } finally {
    await reader.close();
    t.mock.timers.reset();
  }
});

test("requests which expire in the queue are removed instead of starting another verification", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { reader, instances } = fixture({ timeoutMs: 100 });
  try {
    const first = reader.read({ configured: true });
    const queued = reader.read({ configured: true, reportId: "d".repeat(64) });
    t.mock.timers.tick(100);
    for (const result of await Promise.all([first, queued])) {
      assert.equal(result.lastErrorCode, "RAS_HISTORY_WORKER_TIMEOUT");
      assert.equal(result.integrityVerified, false);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(instances.length, 1);
    assert.equal(instances[0].sent.length, 1);
    const fresh = reader.read({ configured: true, reportId: "d".repeat(64) });
    assert.equal(instances.length, 2);
    instances[1].reply();
    assert.equal((await fresh).integrityVerified, true);
  } finally {
    await reader.close();
    t.mock.timers.reset();
  }
});

test("close settles active and queued work, terminates once, and rejects future configured reads safely", async () => {
  const { reader, instances } = fixture();
  const first = reader.read({ configured: true });
  const second = reader.read({ configured: true, reportId: "b".repeat(64) });
  const closing = reader.close();
  assert.equal(reader.close(), closing);
  await closing;
  for (const result of await Promise.all([first, second, reader.read({ configured: true })])) {
    assert.equal(result.lastErrorCode, "RAS_HISTORY_WORKER_CLOSED");
    assert.equal(result.integrityVerified, false);
  }
  instances[0].reply();
  instances[0].emit("error", new Error("late"));
  assert.equal(instances[0].terminations, 1);
  assert.equal(instances.length, 1);
});

test("worker startup and option transfer failures return safe statuses without leaking exception text", async () => {
  const reader = createRecoveryAssuranceStatusReader({ WorkerConstructor: class { constructor() { throw new Error("secret startup location"); } } });
  try {
    const failed = await reader.read({ configured: true });
    assert.equal(failed.lastErrorCode, "RAS_HISTORY_WORKER_FAILED");
    assert.equal(JSON.stringify(failed).includes("secret"), false);
    const invalid = await reader.read({ configured: true, rootPath: { unexpected: "secret" } });
    assert.equal(invalid.lastErrorCode, "RAS_HISTORY_WORKER_OPTIONS_INVALID");
    assert.equal(invalid.integrityVerified, false);
  } finally { await reader.close(); }
});
