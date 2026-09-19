"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const schedules = require(path.join(root, "server-tools/linux/offsite/lib/maintenance-schedule-broker.js"));
const broker = require(path.join(root, "server-tools/linux/offsite/lib/assurance-control-broker.js"));
const client = require(path.join(root, "lib/maintenance-schedule-control-client.js"));

function fixture(t, { failOnce = "" } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-maintenance-schedules-"));
  const stateRoot = path.join(temporary, "state");
  const systemdRoot = path.join(temporary, "systemd");
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  fs.mkdirSync(systemdRoot, { mode: 0o755 });
  for (const task of schedules.TASKS) fs.mkdirSync(path.join(systemdRoot, `${task.timer}.d`), { mode: 0o755 });
  if (process.platform !== "win32") {
    fs.chmodSync(stateRoot, 0o700);
    fs.chmodSync(systemdRoot, 0o755);
    for (const task of schedules.TASKS) fs.chmodSync(path.join(systemdRoot, `${task.timer}.d`), 0o755);
  }
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const nowMs = Date.parse("2026-09-19T12:00:00.000Z");
  const state = new Map(schedules.TASKS.map((task) => [task.timer, { enabled: true, active: true, stamp: nowMs - 2 * 86400000 }]));
  const calendarValue = expression => `{ OnCalendar=${expression.startsWith("*:") ? "*-*-* " + expression.replace("*:0/", "*:00/") + ":00" : expression} ; next_elapse=Sun 2026-09-20 03:45:00 CEST }`;
  const properties = new Map(schedules.TASKS.map((task, index) => [task.timer, {
    TimersCalendar: calendarValue(schedules.calendarExpression(schedules.defaultSchedules()[index])), TimersMonotonic: "",
    Persistent: "yes", RandomizedDelayUSec: "15s", FixedRandomDelay: "yes", AccuracyUSec: "1min",
    OnClockChange: "no", OnTimezoneChange: "no", Unit: task.services[0],
  }]));
  const workerStarts = [];
  const calls = [];
  let failure = failOnce;
  const spawnSync = (executable, args) => {
    calls.push([executable, ...args]);
    const unit = args.at(-1);
    if (args[0] === "show" && args[1] === "--all") {
      const effective = { ...properties.get(unit) };
      const file = path.join(systemdRoot, `${unit}.d`, "20-grabenplaner-schedule.conf");
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, "utf8");
        const calendar = [...content.matchAll(/^OnCalendar=(.+)$/gm)].at(-1)?.[1];
        if (calendar) { effective.TimersCalendar = calendarValue(calendar); effective.TimersMonotonic = ""; }
        for (const [setting, key] of [["Persistent", "Persistent"], ["RandomizedDelaySec", "RandomizedDelayUSec"], ["FixedRandomDelay", "FixedRandomDelay"], ["AccuracySec", "AccuracyUSec"]]) {
          const value = content.match(new RegExp(`^${setting}=(.+)$`, "m"))?.[1];
          if (value) effective[key] = value;
        }
      }
      return { status: 0, stdout: Object.entries(effective).map(([key, value]) => `${key}=${value}`).join("\n") + "\n" };
    }
    if (args[0] === "show" && args[1] === "--property=LoadState") return { status: 0, stdout: "loaded\n" };
    if (args[0] === "show" && args[1] === "--property=ActiveState") return { status: 0, stdout: "inactive\n" };
    if (args[0] === "show" && args[1] === "--property=NextElapseUSecRealtime") {
      return { status: 0, stdout: "Sun 2026-09-20 03:45:00 CEST\n" };
    }
    if (args[0] === "is-enabled") {
      const current = state.get(unit);
      return current?.enabled ? { status: 0, stdout: "enabled\n" } : { status: 1, stdout: "disabled\n" };
    }
    if (args[0] === "is-active") {
      const current = state.get(unit);
      return current?.active ? { status: 0, stdout: "active\n" } : { status: 3, stdout: "inactive\n" };
    }
    if (args[0] === "daemon-reload") return { status: 0, stdout: "" };
    if (failure && args.join(" ").includes(failure)) {
      failure = "";
      return { status: 1, stdout: "" };
    }
    if (args[0] === "clean") {
      const current = state.get(unit);
      // Model documented systemd timer state: cleanup requires an inactive,
      // persistent timer and removes only that timer's last-trigger timestamp.
      if (current.active || properties.get(unit).Persistent !== "yes") return { status: 1, stdout: "" };
      assert.deepEqual(args, ["clean", "--what=state", unit]);
      current.stamp = null;
      return { status: 0, stdout: "" };
    }
    if (["enable", "disable", "start", "stop"].includes(args[0])) {
      const timer = args.at(-1);
      const current = state.get(timer) || { enabled: false, active: false };
      if (args[0] === "enable") current.enabled = true;
      if (args[0] === "disable") current.enabled = false;
      if (args.includes("--now")) current.active = args[0] === "enable";
      if (args[0] === "start" || args[0] === "enable" && args.includes("--now")) {
        // All fixtures have a missed calendar event after the old timestamp.
        // An unsafe enable/start is observable, not merely an active-bit flip.
        if (current.stamp !== null && properties.get(timer).Persistent === "yes") workerStarts.push(timer);
        current.stamp = nowMs;
        current.active = true;
      }
      if (args[0] === "stop") current.active = false;
      state.set(timer, current);
      return { status: 0, stdout: "" };
    }
    return { status: 1, stdout: "unexpected\n" };
  };
  return {
    calls, state, properties, workerStarts, calendarValue,
    options: {
      stateRoot,
      systemdRoot,
      spawnSync,
      dateSpawnSync: () => ({ status: 0, stdout: "2026-09-20T01:45:00.000Z\n" }),
      nowMs,
    },
  };
}

test("maintenance matrix exposes only fixed tasks and canonical systemd calendars", (t) => {
  const { options } = fixture(t);
  const snapshot = schedules.scheduleSnapshot(options);
  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.tasks.map((task) => task.id), client.TASK_IDS);
  assert.ok(snapshot.tasks.every((task) => task.installed && task.enabled && task.active && !task.running));
  const configured = schedules.defaultSchedules();
  assert.equal(schedules.calendarExpression(configured[0]), "*:0/5");
  assert.equal(schedules.calendarExpression(configured[1]), "Mon,Tue,Wed,Thu,Fri,Sat,Sun *-*-* 03:45:00");
  assert.equal(schedules.calendarExpression(configured[2]), "*-*-01 04:15:00");
  assert.equal(schedules.calendarExpression(configured[3]), "*-01,04,07,10-02 05:15:00");
});

test("maintenance matrix applies fixed drop-ins and persists one verified revision", (t) => {
  const { calls, options } = fixture(t);
  const input = schedules.defaultSchedules().map((task) => ({ ...task, weekdays: [...task.weekdays] }));
  input[0].intervalMinutes = 15;
  input[1].weekdays = ["monday", "wednesday", "friday"];
  input[1].time = "02:30";
  input[2] = { ...input[2], enabled: false, cadence: "weekly", weekdays: ["sunday"], time: "04:00", monthDay: null };
  const result = schedules.applySchedules(input, options);
  assert.equal(result.revision, schedules.revisionFor(input));
  assert.equal(result.tasks[2].enabled, false);
  assert.match(fs.readFileSync(path.join(options.systemdRoot, "grabenplaner-monitor.timer.d", "20-grabenplaner-schedule.conf"), "utf8"), /OnCalendar=\*:0\/15/);
  assert.doesNotMatch(fs.readFileSync(path.join(options.systemdRoot, "grabenplaner-monitor.timer.d", "20-grabenplaner-schedule.conf"), "utf8"), /OnBootSec=/);
  assert.match(fs.readFileSync(path.join(options.systemdRoot, "grabenplaner-offsite-assurance.timer.d", "20-grabenplaner-schedule.conf"), "utf8"), /OnCalendar=Mon,Wed,Fri \*-\*-\* 02:30:00/);
  assert.ok(calls.some((call) => call[1] === "disable" && call.at(-1) === "grabenplaner-offsite-check.timer"));
  const stored = schedules.readState(options);
  assert.equal(stored.revision, result.revision);
  assert.deepEqual(stored.schedules, input);
});

test("maintenance matrix rolls every drop-in back when systemd rejects the transaction", (t) => {
  const { options, workerStarts } = fixture(t, { failOnce: "start grabenplaner-offsite-restore-test.timer" });
  const input = schedules.defaultSchedules();
  input[0].intervalMinutes = 15;
  input[3].time = "06:00";
  assert.throws(() => schedules.applySchedules(input, options), { code: "MAINTENANCE_SCHEDULE_CONTROL_FAILED" });
  for (const task of schedules.TASKS) {
    assert.equal(fs.existsSync(path.join(options.systemdRoot, `${task.timer}.d`, "20-grabenplaner-schedule.conf")), false);
  }
  assert.equal(fs.existsSync(path.join(options.stateRoot, "schedules.json")), false);
  assert.deepEqual(workerStarts, [], "rollback also must not catch up a missed service run");
});

test("a multirow save permits measured slow reloads and does not reload once per enabled timer", t => {
  const { options, calls } = fixture(t);
  const originalSpawn = options.spawnSync, budgets = [], progress = [];
  options.onProgress = value => progress.push(value);
  options.spawnSync = (executable, args, commandOptions) => {
    budgets.push({ action: args[0], timeout: commandOptions.timeout });
    if (args[0] === "daemon-reload" && commandOptions.timeout <= 13_140) {
      return { status: null, error: Object.assign(new Error("simulated measured reload latency"), { code: "ETIMEDOUT" }), stdout: "" };
    }
    return originalSpawn(executable, args, commandOptions);
  };
  const input = schedules.defaultSchedules();
  input[0].intervalMinutes = 10;
  input[1].time = "04:00";
  input[2].monthDay = 2;
  input[3].monthDay = 3;
  input[4].time = "01:00";
  const after = schedules.applySchedules(input, options);
  assert.ok(after.tasks.every(task => task.enabled && task.active));
  assert.equal(calls.filter(call => call[1] === "daemon-reload").length, 1);
  const enableCalls = calls.filter(call => ["enable", "disable"].includes(call[1]));
  assert.equal(enableCalls.length, 5);
  assert.ok(enableCalls.every(call => call[2] === "--no-reload"));
  assert.equal(budgets.find(call => call.action === "daemon-reload").timeout, schedules.RELOAD_TIMEOUT_MS);
  assert.ok(progress.some(row => row.action === "daemon-reload" && row.phase === "finished" && row.ok));
  const unit = fs.readFileSync(path.join(root, "server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance-control@.service.in"), "utf8");
  const startMs = Number(unit.match(/^TimeoutStartSec=(\d+)s$/m)[1]) * 1000;
  const runtimeMs = Number(unit.match(/^RuntimeMaxSec=(\d+)s$/m)[1]) * 1000;
  assert.ok(startMs > 2 * schedules.TRANSACTION_BUDGET_MS + 6000, "Apply, rollback and both lock waits fit inside the unit budget.");
  assert.ok(runtimeMs > startMs && client.DEFAULT_TIMEOUT_MS > runtimeMs);
});

test("an exhausted control budget rejects before changing timers", t => {
  const { options, calls } = fixture(t);
  assert.throws(() => schedules.applySchedules(schedules.defaultSchedules(), { ...options, controlDeadlineMs: Date.now() - 1 }),
    { code: "MAINTENANCE_SCHEDULE_CONTROL_FAILED" });
  assert.equal(calls.length, 0);
});

test("schema 3 broker and app client preserve the bounded maintenance protocol", (t) => {
  const { options } = fixture(t);
  const requestId = crypto.randomUUID();
  const request = client.buildRequest(requestId, "maintenance-schedules-status");
  const result = broker.handleRequest(Buffer.from(request), { scheduleOptions: options });
  assert.equal(result.schemaVersion, 3);
  assert.equal(result.code, "MAINTENANCE_SCHEDULES_READY");
  assert.equal(result.accepted, false);
  const parsed = client.parseResponse(Buffer.from(`${JSON.stringify(result)}\n`), requestId);
  assert.deepEqual(parsed.maintenanceSchedules.tasks.map((task) => task.id), client.TASK_IDS);
  assert.throws(() => broker.parseRequest(Buffer.from(`${JSON.stringify({
    format: broker.REQUEST_FORMAT,
    schemaVersion: 3,
    action: "maintenance-schedules-update",
    requestId,
    schedules: [],
    unit: "attacker.timer",
  })}\n`)), { code: "ASSURANCE_REQUEST_INVALID" });
});

test("maintenance update is rejected while a fixed worker is active", (t) => {
  const { options } = fixture(t);
  const originalSpawn = options.spawnSync;
  options.spawnSync = (executable, args) => {
    if (args[0] === "show" && args[1] === "--property=ActiveState") {
      return { status: 0, stdout: args.at(-1) === "grabenplaner-offsite-check.service" ? "active\n" : "inactive\n" };
    }
    return originalSpawn(executable, args);
  };
  options.dateSpawnSync = () => ({ status: 0, stdout: "2026-09-20T01:45:00.000Z\n" });
  assert.throws(() => schedules.applySchedules(schedules.defaultSchedules(), options), { code: "MAINTENANCE_SCHEDULE_BUSY" });
});

const toSchedules = snapshot => snapshot.tasks.map(({ id, enabled, cadence, weekdays, time, intervalMinutes, monthDay }) => (
  { id, enabled, cadence, weekdays, time, intervalMinutes, monthDay }
));

test("first display imports customized effective calendars and an untouched save leaves all timers alone", t => {
  const { options, properties, calendarValue, calls, workerStarts } = fixture(t);
  properties.get("grabenplaner-offsite-assurance.timer").TimersCalendar = calendarValue("Mon,Wed,Fri *-*-* 04:10:00");
  const snapshot = schedules.scheduleSnapshot(options);
  assert.equal(snapshot.tasks[1].time, "04:10");
  assert.deepEqual(snapshot.tasks[1].weekdays, ["monday", "wednesday", "friday"]);
  schedules.applySchedules(toSchedules(snapshot), options);
  assert.equal(calls.filter(call => ["enable", "disable", "stop", "start", "clean", "daemon-reload"].includes(call[1])).length, 0);
  for (const task of schedules.TASKS) assert.equal(fs.existsSync(path.join(options.systemdRoot, `${task.timer}.d`, "20-grabenplaner-schedule.conf")), false);
  assert.deepEqual(workerStarts, []);
});

test("live timer configuration stays authoritative when the saved JSON differs", t => {
  const { options, properties, calendarValue } = fixture(t);
  schedules.writeState(schedules.defaultSchedules(), options);
  properties.get("grabenplaner-offsite-assurance.timer").TimersCalendar = calendarValue("*-*-* 04:10:00");
  const snapshot = schedules.scheduleSnapshot(options);
  assert.equal(snapshot.tasks[1].time, "04:10");
  assert.notEqual(snapshot.revision, schedules.readState(options).revision);
});

test("a concurrently changed server schedule rejects stale matrix input before any timer mutation", t => {
  const { options, properties, calendarValue, calls } = fixture(t);
  const loaded = schedules.scheduleSnapshot(options);
  const input = toSchedules(loaded);
  input[0].intervalMinutes = 15;
  properties.get("grabenplaner-offsite-assurance.timer").TimersCalendar = calendarValue("*-*-* 04:10:00");
  const requestId = crypto.randomUUID();
  const request = client.buildRequest(requestId, "maintenance-schedules-update", input, loaded.revision);
  const response = broker.handleRequest(Buffer.from(request), { scheduleOptions: options });
  const parsed = client.parseResponse(Buffer.from(JSON.stringify(response) + "\n"), requestId);
  assert.equal(parsed.code, "MAINTENANCE_SCHEDULES_STALE");
  assert.equal(parsed.accepted, false);
  assert.ok(!calls.some(call => ["stop", "start", "clean", "enable", "disable", "daemon-reload"].includes(call[1])));
});

test("the bounded socket protocol carries live schedule revisions and read-only rows end to end", t => {
  const { options, properties } = fixture(t);
  properties.get("grabenplaner-host-security-audit.timer").TimersMonotonic = "{ OnBootUSec=10min ; next_elapse=0 }";
  const requestId = crypto.randomUUID();
  const loaded = schedules.scheduleSnapshot(options);
  const input = toSchedules(loaded);
  input[1].time = "04:10";
  const request = client.buildRequest(requestId, "maintenance-schedules-update", input, loaded.revision);
  const response = broker.handleRequest(Buffer.from(request), { scheduleOptions: options });
  const parsed = client.parseResponse(Buffer.from(JSON.stringify(response) + "\n"), requestId);
  assert.equal(parsed.code, "MAINTENANCE_SCHEDULES_UPDATED");
  assert.equal(parsed.maintenanceSchedules.tasks[1].time, "04:10");
  assert.equal(parsed.maintenanceSchedules.tasks[4].unsupportedReason, "additional-triggers");
  assert.throws(() => client.buildRequest(requestId, "maintenance-schedules-update", input), { code: "MAINTENANCE_SCHEDULE_REQUEST_INVALID" });
});

test("unrepresentable schedules are explicit read-only rows and survive changes to another row", t => {
  const { options, properties, calls, workerStarts } = fixture(t);
  properties.get("grabenplaner-host-security-audit.timer").TimersMonotonic = "{ OnBootUSec=10min ; next_elapse=0 }";
  const snapshot = schedules.scheduleSnapshot(options);
  assert.equal(snapshot.tasks[4].cadence, "unsupported");
  assert.equal(snapshot.tasks[4].time, null);
  assert.equal(snapshot.tasks[4].unsupportedReason, "additional-triggers");
  const input = toSchedules(snapshot);
  input[1].time = "04:10";
  const result = schedules.applySchedules(input, options);
  assert.equal(result.tasks[1].time, "04:10");
  assert.equal(result.tasks[4].unsupportedReason, "additional-triggers");
  assert.ok(!calls.some(call => ["stop", "start", "clean", "enable", "disable"].includes(call[1]) && call.at(-1) !== "grabenplaner-offsite-assurance.timer"));
  assert.equal(fs.existsSync(path.join(options.systemdRoot, "grabenplaner-host-security-audit.timer.d", "20-grabenplaner-schedule.conf")), false);
  assert.deepEqual(workerStarts, []);
  input[4].enabled = false;
  assert.throws(() => schedules.applySchedules(input, options), { code: "MAINTENANCE_SCHEDULE_UNAVAILABLE" });
});

test("re-enabling a timer clears only its missed-run timestamp before starting and preserves its policy", t => {
  const { options, state, properties, calls, workerStarts } = fixture(t);
  const timer = "grabenplaner-offsite-assurance.timer";
  Object.assign(state.get(timer), { enabled: false, active: false });
  properties.get(timer).RandomizedDelayUSec = "1h 30min";
  const input = toSchedules(schedules.scheduleSnapshot(options));
  input[1].enabled = true;
  schedules.applySchedules(input, options);
  const actions = calls.filter(call => ["stop", "clean", "start"].includes(call[1])).map(call => call.slice(1).join(" "));
  assert.deepEqual(actions, [`stop ${timer}`, `clean --what=state ${timer}`, `start ${timer}`]);
  assert.deepEqual(workerStarts, [], "the missed run must not be queued on save");
  const body = fs.readFileSync(path.join(options.systemdRoot, `${timer}.d`, "20-grabenplaner-schedule.conf"), "utf8");
  assert.match(body, /Persistent=yes\n/);
  assert.match(body, /RandomizedDelaySec=1h 30min\n/);
  assert.match(body, /FixedRandomDelay=yes\n/);
  assert.match(body, /AccuracySec=1min\n/);
  assert.equal(state.get("grabenplaner-monitor.timer").stamp, options.nowMs - 2 * 86400000);
});

test("failed persistent-state cleanup never starts that timer or a worker", t => {
  const { options, state, workerStarts, calls } = fixture(t, { failOnce: "clean --what=state grabenplaner-offsite-assurance.timer" });
  const timer = "grabenplaner-offsite-assurance.timer";
  Object.assign(state.get(timer), { enabled: false, active: false });
  const input = toSchedules(schedules.scheduleSnapshot(options));
  input[1].enabled = true;
  assert.throws(() => schedules.applySchedules(input, options), { code: "MAINTENANCE_SCHEDULE_CONTROL_FAILED" });
  assert.equal(state.get(timer).active, false);
  assert.ok(!calls.some(call => call[1] === "start"));
  assert.deepEqual(workerStarts, []);
});

test("nonpersistent timers keep that policy and never use persistent cleanup", t => {
  const { options, properties, calls, workerStarts } = fixture(t);
  const timer = "grabenplaner-monitor.timer";
  properties.get(timer).Persistent = "no";
  const input = toSchedules(schedules.scheduleSnapshot(options));
  input[0].intervalMinutes = 15;
  schedules.applySchedules(input, options);
  assert.ok(!calls.some(call => call[1] === "clean"));
  assert.match(fs.readFileSync(path.join(options.systemdRoot, `${timer}.d`, "20-grabenplaner-schedule.conf"), "utf8"), /Persistent=no\n/);
  assert.deepEqual(workerStarts, []);
});

test("a new worker detected after timer stop aborts before timer configuration changes", t => {
  const { options, calls, workerStarts } = fixture(t);
  const originalSpawn = options.spawnSync;
  options.spawnSync = (executable, args) => {
    if (args[1] === "--property=ActiveState" && args.at(-1) === "grabenplaner-offsite-assurance@scheduled-nightly.service"
      && calls.some(call => call[1] === "stop")) return { status: 0, stdout: "activating\n" };
    return originalSpawn(executable, args);
  };
  const input = toSchedules(schedules.scheduleSnapshot(options));
  input[1].time = "04:10";
  assert.throws(() => schedules.applySchedules(input, options), { code: "MAINTENANCE_SCHEDULE_BUSY" });
  assert.equal(fs.existsSync(path.join(options.systemdRoot, "grabenplaner-offsite-assurance.timer.d", "20-grabenplaner-schedule.conf")), false);
  assert.deepEqual(workerStarts, []);
});

test("real systemctl output with an omitted empty monotonic array loads the effective monitor calendar", t => {
  const { options, calls } = fixture(t);
  const originalSpawn = options.spawnSync;
  const realOutput = "Unit=grabenplaner-monitor.service\n"
    + "TimersCalendar={ OnCalendar=*-*-* *:00/5:00 ; next_elapse=Sat 2026-09-19 04:10:00 CEST }\n"
    + "OnClockChange=no\nOnTimezoneChange=no\nAccuracyUSec=15s\nRandomizedDelayUSec=15s\nFixedRandomDelay=no\nPersistent=yes\n";
  options.spawnSync = (executable, args, commandOptions) => args[0] === "show" && args[1] === "--all"
    && args.at(-1) === "grabenplaner-monitor.timer"
    ? { status: 0, stdout: realOutput } : originalSpawn(executable, args, commandOptions);
  const snapshot = schedules.scheduleSnapshot(options);
  assert.equal(snapshot.tasks[0].cadence, "interval");
  assert.equal(snapshot.tasks[0].intervalMinutes, 5);
  assert.equal(snapshot.tasks[0].unsupportedReason, null);
  calls.length = 0;
  schedules.applySchedules(toSchedules(snapshot), { ...options, expectedRevision: snapshot.revision });
  assert.ok(!calls.some(call => ["stop", "start", "clean", "enable", "disable", "daemon-reload"].includes(call[1])));
});

test("omitted calendar arrays never make monotonic-only or empty timers editable", t => {
  const { options, properties } = fixture(t);
  const monitor = properties.get("grabenplaner-monitor.timer");
  delete monitor.TimersCalendar;
  for (const monotonic of ["{ OnBootUSec=10min ; next_elapse=10min }", null]) {
    if (monotonic === null) delete monitor.TimersMonotonic;
    else monitor.TimersMonotonic = monotonic;
    const snapshot = schedules.scheduleSnapshot(options);
    assert.equal(snapshot.tasks[0].cadence, "unsupported");
    assert.equal(snapshot.tasks[0].unsupportedReason, monotonic === null ? "calendar-not-supported" : "additional-triggers");
    const input = toSchedules(snapshot);
    input[0] = { ...schedules.defaultSchedules()[0], intervalMinutes: 10 };
    assert.throws(() => schedules.applySchedules(input, options), { code: "MAINTENANCE_SCHEDULE_UNAVAILABLE" });
  }
});

test("a missing timer scalar still fails closed when systemctl omits empty arrays", t => {
  const { options, properties } = fixture(t);
  const monitor = properties.get("grabenplaner-monitor.timer");
  delete monitor.TimersMonotonic;
  for (const key of ["Unit", "Persistent", "RandomizedDelayUSec", "FixedRandomDelay", "AccuracyUSec", "OnClockChange", "OnTimezoneChange"]) {
    const previous = monitor[key];
    delete monitor[key];
    assert.throws(() => schedules.scheduleSnapshot(options), { code: "MAINTENANCE_SCHEDULE_CONTROL_FAILED" }, key);
    monitor[key] = previous;
  }
});

test("calendar forms outside the matrix are never silently coerced to defaults", t => {
  const { options, properties, calendarValue } = fixture(t);
  const timer = properties.get("grabenplaner-offsite-assurance.timer");
  for (const expression of ["*-*-* 04:10:00 Europe/Vienna", "*-*-* 04:10:30", "Mon *-*-15 04:10:00"]) {
    timer.TimersCalendar = calendarValue(expression);
    assert.equal(schedules.scheduleSnapshot(options).tasks[1].unsupportedReason, "calendar-not-supported");
  }
  timer.TimersCalendar = calendarValue("*-*-* 04:10:00") + " " + calendarValue("*-*-* 05:00:00");
  assert.equal(schedules.scheduleSnapshot(options).tasks[1].unsupportedReason, "calendar-not-supported");
});

test("module v11 binds schedule control to the maintenance lock and fixed writable paths", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, "server-tools/linux/offsite/module-schema.json"), "utf8"));
  const service = fs.readFileSync(path.join(root, "server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance-control@.service.in"), "utf8");
  assert.equal(schema.moduleVersion, 11);
  assert.ok(schema.managedArtifacts.includes("server-tools/linux/offsite/lib/maintenance-schedule-broker.js"));
  assert.match(service, /ExecStart=\/usr\/bin\/flock --exclusive --wait 3 \/run\/grabenplaner\/maintenance\.lock/);
  assert.match(service, /ReadWritePaths=.*\/var\/lib\/grabenplaner-maintenance-schedules/);
  assert.match(service, /ReadWritePaths=.*grabenplaner-offsite-assurance\.timer\.d/);
  assert.doesNotMatch(service, /^ReadWritePaths=\/$/m, "the broker must not receive a blanket root filesystem write grant");
});
