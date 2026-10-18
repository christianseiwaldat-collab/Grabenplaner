"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const brokerFile = path.resolve(__dirname, "../server-tools/linux/offsite/lib/assurance-control-broker.js");
const serviceFile = path.resolve(__dirname, "../server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance-control@.service.in");
const native = { skip: process.platform !== "linux" };
const requestId = "410d17bd-8eca-4f6a-9adf-9ab4ed897f63";
const nowMs = Date.parse("2032-03-15T12:00:00.000Z");
const flockArgs = ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"];

// Only the schedule domain's callbacks are substituted. The broker dispatch,
// filesystem metadata, opened descriptors and Linux flock calls remain real.
function loadBroker(scheduleCallbacks) {
  const localRequire = createRequire(brokerFile), module = { exports: {} };
  const actualSchedules = localRequire("./maintenance-schedule-broker");
  const execute = vm.compileFunction(fs.readFileSync(brokerFile, "utf8").replace(/^#![^\n]*\n/, ""),
    ["module", "exports", "require", "process"], { filename: brokerFile });
  execute(module, module.exports, name => name === "./maintenance-schedule-broker"
    ? { ...actualSchedules, ...scheduleCallbacks } : localRequire(name), process);
  return module.exports;
}

function request(broker, action) {
  const value = {
    format: broker.REQUEST_FORMAT,
    schemaVersion: action.startsWith("maintenance-schedules-") ? 3 : 2,
    action,
    requestId,
  };
  if (action === "maintenance-schedules-update") {
    value.schedules = [{ synthetic: true }];
    value.expectedRevision = "a".repeat(64);
  }
  return Buffer.from(JSON.stringify(value) + "\n");
}

function flock(fd) {
  const result = childProcess.spawnSync("/usr/bin/flock", flockArgs, {
    stdio: ["ignore", "pipe", "pipe", fd], encoding: "utf8", timeout: 2000,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.ok([0, 75].includes(result.status), `unexpected flock exit ${result.status}: ${result.stderr}`);
  return result.status;
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-assurance-control-lock-"));
  fs.chmodSync(directory, 0o755);
  const lockPaths = { maintenance: path.join(directory, "maintenance.lock"), broker: path.join(directory, "broker.lock") };
  for (const file of Object.values(lockPaths)) fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
  const owned = new Set();
  t.after(() => {
    for (const fd of owned) fs.closeSync(fd);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function probe(which) {
    const fd = fs.openSync(lockPaths[which], fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try { return flock(fd); } finally { fs.closeSync(fd); }
  }
  function hold(which) {
    const fd = fs.openSync(lockPaths[which], fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    owned.add(fd);
    assert.equal(flock(fd), 0);
    assert.equal(probe(which), 75, "parent retains the child's flock through its open file description");
    return () => { fs.closeSync(fd); owned.delete(fd); };
  }
  const calls = [], lockAttempts = [], snapshot = { available: true, checkedAt: new Date(nowMs).toISOString(), revision: "a".repeat(64), tasks: [] };
  let onSnapshot = () => {}, onApply = () => {}, onStart = () => {};
  const broker = loadBroker({
    scheduleSnapshot(options) {
      calls.push("snapshot"); onSnapshot(options); return snapshot;
    },
    applySchedules(schedules, options) {
      calls.push("apply"); onApply(schedules, options); return snapshot;
    },
  });
  const options = {
    lockPaths,
    requireRootOwner: false,
    globalLockBusy: false,
    nowMs,
    statePath: path.join(directory, "rate-limit.json"),
    scheduleOptions: { fixture: directory },
    lockSpawnSync(executable, args, spawnOptions) {
      assert.equal(executable, "/usr/bin/flock");
      assert.deepEqual(args, flockArgs);
      const fd = spawnOptions.stdio[3], file = fs.realpathSync(`/proc/self/fd/${fd}`);
      assert.ok(Object.values(lockPaths).includes(file), "only owned fixture locks may be opened");
      lockAttempts.push(path.basename(file));
      return childProcess.spawnSync(executable, args, spawnOptions);
    },
    spawnSync(executable, args) {
      assert.equal(executable, "/usr/bin/systemctl");
      calls.push(args[0]);
      if (args[0] === "show" && args[1] === "--property=LoadState") return { status: 0, stdout: "loaded\n" };
      if (args[0] === "show" && args[1] === "--property=ActiveState") return { status: 0, stdout: "inactive\n" };
      if (args[0] === "start") {
        assert.deepEqual(args, ["start", "--no-block", broker.ASSURANCE_UNIT]);
        onStart(); return { status: 0, stdout: "" };
      }
      throw new Error("unexpected synthetic systemctl operation");
    },
    schedulerSpawnSync(executable, args) {
      assert.equal(executable, "/usr/bin/systemctl");
      if (args[0] === "is-enabled") return { status: 0, stdout: "enabled\n" };
      if (args[0] === "is-active") return { status: 0, stdout: "active\n" };
      const values = { LoadState: "loaded", FragmentPath: "/etc/systemd/system/grabenplaner-offsite-assurance.timer", NextElapseUSecRealtime: "Tue 2032-03-16 03:00:00 UTC" };
      const property = args[1]?.replace("--property=", "");
      assert.ok(Object.hasOwn(values, property));
      return { status: 0, stdout: values[property] + "\n" };
    },
    dateSpawnSync: () => ({ status: 0, stdout: "2032-03-16T03:00:00.000Z\n" }),
  };
  return { directory, lockPaths, broker, options, calls, lockAttempts, snapshot, probe, hold,
    onSnapshot(fn) { onSnapshot = fn; }, onApply(fn) { onApply = fn; }, onStart(fn) { onStart = fn; } };
}

function assertFree(f) {
  assert.equal(f.probe("maintenance"), 0, "maintenance descriptor released");
  assert.equal(f.probe("broker"), 0, "broker descriptor released");
}

test("control unit enters Node directly so lock contention becomes a protocol response", () => {
  const unit = fs.readFileSync(serviceFile, "utf8");
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/grabenplaner-offsite\/module\/lib\/assurance-control-broker\.js$/m);
  assert.match(unit, /^StandardInput=socket$/m);
  assert.match(unit, /^StandardOutput=socket$/m);
});

test("Linux status requests remain responsive under an actual maintenance lock", native, t => {
  const f = fixture(t), release = f.hold("maintenance");
  f.onSnapshot(options => {
    assert.equal(options.fixture, f.directory);
    assert.equal(f.probe("broker"), 75, "snapshot is serialized against schedule writes");
  });
  const status = f.broker.dispatchRequest(request(f.broker, "status"), f.options);
  assert.equal(status.code, "ASSURANCE_REQUEST_BUSY");
  assert.equal(status.requestId, requestId);
  assert.equal(status.scheduler.evidenceTrusted, true);
  assert.equal(status.scheduler.timerEnabled, true);
  const schedules = f.broker.dispatchRequest(request(f.broker, "maintenance-schedules-status"), f.options);
  assert.equal(schedules.code, "MAINTENANCE_SCHEDULES_READY");
  assert.deepEqual(schedules.maintenanceSchedules, f.snapshot);
  assert.equal(f.calls.filter(x => x === "snapshot").length, 1);
  assert.equal(f.calls.includes("start") || f.calls.includes("apply"), false);
  assert.equal(fs.existsSync(f.options.statePath), false);
  assert.equal(f.probe("maintenance"), 75, "the external owner's lock was not released");
  release(); assertFree(f);
});

test("Linux writers return BUSY before callbacks when maintenance is held", native, t => {
  const f = fixture(t), release = f.hold("maintenance");
  for (const [action, code] of [["start-manual-assurance", "ASSURANCE_REQUEST_BUSY"], ["maintenance-schedules-update", "MAINTENANCE_SCHEDULES_BUSY"]]) {
    f.lockAttempts.length = 0;
    const result = f.broker.dispatchRequest(request(f.broker, action), f.options);
    assert.equal(result.code, code); assert.equal(result.accepted, false);
    assert.deepEqual(f.lockAttempts, ["maintenance.lock"], "maintenance must precede broker acquisition");
  }
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.options.statePath), false);
  release(); assertFree(f);
});

test("Linux broker contention never leaks the previously acquired maintenance lease", native, t => {
  const f = fixture(t), release = f.hold("broker");
  for (const [action, code] of [["status", "ASSURANCE_REQUEST_BUSY"], ["maintenance-schedules-status", "MAINTENANCE_SCHEDULES_BUSY"], ["start-manual-assurance", "ASSURANCE_REQUEST_BUSY"], ["maintenance-schedules-update", "MAINTENANCE_SCHEDULES_BUSY"]]) {
    f.lockAttempts.length = 0;
    const result = f.broker.dispatchRequest(request(f.broker, action), f.options);
    assert.equal(result.code, code); assert.equal(result.accepted, false);
    if (action === "start-manual-assurance" || action === "maintenance-schedules-update") {
      assert.deepEqual(f.lockAttempts, ["maintenance.lock", "broker.lock"]);
    }
    assert.equal(f.probe("maintenance"), 0);
    assert.equal(f.probe("broker"), 75);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.options.statePath), false);
  release(); assertFree(f);
});

test("Linux successful manual start retains both real locks throughout its mutation", native, t => {
  const f = fixture(t);
  f.onStart(() => {
    assert.equal(f.probe("maintenance"), 75);
    assert.equal(f.probe("broker"), 75);
  });
  const result = f.broker.dispatchRequest(request(f.broker, "start-manual-assurance"), f.options);
  assert.equal(result.code, "ASSURANCE_REQUEST_ACCEPTED");
  assert.equal(result.accepted, true);
  assert.deepEqual(f.lockAttempts, ["maintenance.lock", "broker.lock"]);
  assert.equal(f.calls.filter(x => x === "start").length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).lastRequestId, requestId);
  assertFree(f);
});

test("Linux schedule write holds both locks and releases them after success or failure", native, t => {
  const f = fixture(t);
  f.onApply((schedules, options) => {
    assert.deepEqual(schedules, [{ synthetic: true }]);
    assert.equal(options.expectedRevision, "a".repeat(64));
    assert.equal(options.fixture, f.directory);
    assert.equal(f.probe("maintenance"), 75); assert.equal(f.probe("broker"), 75);
  });
  const success = f.broker.dispatchRequest(request(f.broker, "maintenance-schedules-update"), f.options);
  assert.equal(success.code, "MAINTENANCE_SCHEDULES_UPDATED");
  assert.equal(success.accepted, true);
  assert.deepEqual(f.lockAttempts, ["maintenance.lock", "broker.lock"]);
  assertFree(f);
  f.onApply(() => { throw new Error("synthetic schedule failure"); });
  const failure = f.broker.dispatchRequest(request(f.broker, "maintenance-schedules-update"), f.options);
  assert.equal(failure.code, "MAINTENANCE_SCHEDULES_FAILED");
  assert.equal(failure.accepted, false);
  assert.equal(f.calls.filter(x => x === "apply").length, 2);
  assertFree(f);
});

test("Linux malformed and unsafe lock inputs fail before mutating callbacks", native, t => {
  const f = fixture(t);
  assert.equal(f.broker.dispatchRequest(Buffer.from("{}\n"), f.options).code, "ASSURANCE_REQUEST_INVALID");
  assert.deepEqual(f.lockAttempts, []);
  const original = f.lockPaths.maintenance;
  const alias = path.join(f.directory, "maintenance-link");
  fs.symlinkSync(original, alias);
  const result = f.broker.dispatchRequest(request(f.broker, "start-manual-assurance"), {
    ...f.options, lockPaths: { ...f.lockPaths, maintenance: alias },
  });
  assert.equal(result.code, "ASSURANCE_CONTROL_FAILED");
  assert.equal(result.accepted, false);
  assert.deepEqual(f.calls, []);
  assertFree(f);
});

test("Linux unsafe modes, hardlinks and FIFO locks fail before callbacks", native, t => {
  const f = fixture(t);
  const reject = maintenance => {
    const result = f.broker.dispatchRequest(request(f.broker, "start-manual-assurance"), {
      ...f.options, lockPaths: { ...f.lockPaths, maintenance },
    });
    assert.equal(result.code, "ASSURANCE_CONTROL_FAILED");
    assert.equal(result.accepted, false);
    assert.deepEqual(f.lockAttempts, [], "unsafe files must be rejected before flock");
  };
  fs.chmodSync(f.lockPaths.maintenance, 0o644);
  try { reject(f.lockPaths.maintenance); } finally { fs.chmodSync(f.lockPaths.maintenance, 0o600); }
  const hardlink = path.join(f.directory, "maintenance-hardlink");
  fs.linkSync(f.lockPaths.maintenance, hardlink);
  try { reject(f.lockPaths.maintenance); } finally { fs.unlinkSync(hardlink); }
  const fifo = path.join(f.directory, "maintenance-fifo");
  const mkfifo = childProcess.spawnSync("/usr/bin/mkfifo", ["--mode=600", fifo], { timeout: 2000 });
  assert.ifError(mkfifo.error);
  assert.equal(mkfifo.status, 0);
  reject(fifo);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.options.statePath), false);
  assertFree(f);
});

test("Linux non-conflict flock failures remain FAILED and release earlier acquisitions", native, t => {
  const f = fixture(t);
  const failures = [
    ["exit 1", { status: 1, signal: null }],
    ["ETIMEDOUT", { status: null, signal: null, error: Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" }) }],
    ["SIGTERM", { status: null, signal: "SIGTERM" }],
  ];
  for (const [label, failure] of failures) {
    for (const failAt of [1, 2]) {
      for (const [action, code] of [["start-manual-assurance", "ASSURANCE_CONTROL_FAILED"], ["maintenance-schedules-update", "MAINTENANCE_SCHEDULES_FAILED"]]) {
        let attempts = 0;
        const result = f.broker.dispatchRequest(request(f.broker, action), {
          ...f.options,
          lockSpawnSync(...args) {
            attempts += 1;
            return attempts === failAt ? failure : f.options.lockSpawnSync(...args);
          },
        });
        assert.equal(result.code, code, `${action}: ${label} at acquisition ${failAt}`);
        assert.equal(result.accepted, false);
        assert.equal(attempts, failAt);
        assert.deepEqual(f.calls, []);
        assert.equal(fs.existsSync(f.options.statePath), false);
        assertFree(f);
      }
    }
  }
});
