"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SYSTEMCTL = "/usr/bin/systemctl";
const DATE = "/usr/bin/date";
const STATE_ROOT = "/var/lib/grabenplaner-maintenance-schedules";
const STATE_PATH = `${STATE_ROOT}/schedules.json`;
const SYSTEMD_ROOT = "/etc/systemd/system";
const STATE_FORMAT = "grabenplaner-maintenance-schedules";
const STATE_SCHEMA_VERSION = 1;
// Measured daemon reloads under restore load take up to 13 seconds. Enable and
// disable deliberately avoid additional implicit reloads in the transaction.
const COMMAND_TIMEOUT_MS = 30_000;
const RELOAD_TIMEOUT_MS = 60_000;
const TRANSACTION_BUDGET_MS = 120_000;
const WEEKDAYS = Object.freeze(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
const SYSTEMD_WEEKDAYS = Object.freeze({
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
  friday: "Fri", saturday: "Sat", sunday: "Sun",
});
const INTERVALS = new Set([5, 10, 15, 20, 30, 60]);
const TASKS = Object.freeze([
  Object.freeze({
    id: "server-monitor",
    timer: "grabenplaner-monitor.timer",
    services: Object.freeze(["grabenplaner-monitor.service"]),
    cadences: Object.freeze(["interval"]),
    defaults: Object.freeze({ enabled: true, cadence: "interval", weekdays: [], time: null, intervalMinutes: 5, monthDay: null }),
  }),
  Object.freeze({
    id: "complete-backup",
    timer: "grabenplaner-offsite-assurance.timer",
    services: Object.freeze([
      "grabenplaner-offsite-assurance@scheduled-nightly.service",
      "grabenplaner-offsite-assurance@manual-admin-ui.service",
      "grabenplaner-offsite-assurance@app-updated.service",
      "grabenplaner-offsite-assurance@offsite-config-changed.service",
      "grabenplaner-offsite-assurance@offsite-module-changed.service",
    ]),
    cadences: Object.freeze(["weekly"]),
    defaults: Object.freeze({ enabled: true, cadence: "weekly", weekdays: WEEKDAYS, time: "03:45", intervalMinutes: null, monthDay: null }),
  }),
  Object.freeze({
    id: "repository-check",
    timer: "grabenplaner-offsite-check.timer",
    services: Object.freeze(["grabenplaner-offsite-check.service"]),
    cadences: Object.freeze(["weekly", "monthly"]),
    defaults: Object.freeze({ enabled: true, cadence: "monthly", weekdays: [], time: "04:15", intervalMinutes: null, monthDay: 1 }),
  }),
  Object.freeze({
    id: "restore-test",
    timer: "grabenplaner-offsite-restore-test.timer",
    services: Object.freeze(["grabenplaner-offsite-restore-test.service"]),
    cadences: Object.freeze(["weekly", "monthly", "quarterly"]),
    defaults: Object.freeze({ enabled: true, cadence: "quarterly", weekdays: [], time: "05:15", intervalMinutes: null, monthDay: 2 }),
  }),
  Object.freeze({
    id: "security-audit",
    timer: "grabenplaner-host-security-audit.timer",
    services: Object.freeze(["grabenplaner-host-security-audit.service"]),
    cadences: Object.freeze(["weekly"]),
    optional: true,
    defaults: Object.freeze({ enabled: true, cadence: "weekly", weekdays: WEEKDAYS, time: "00:00", intervalMinutes: null, monthDay: null }),
  }),
]);
const TASK_BY_ID = new Map(TASKS.map((task) => [task.id, task]));
const SCHEDULE_KEYS = new Set(["cadence", "enabled", "id", "intervalMinutes", "monthDay", "time", "weekdays"]);
const STATE_KEYS = new Set(["format", "revision", "schemaVersion", "schedules", "updatedAt"]);

class MaintenanceScheduleError extends Error {
  constructor(code) { super(code); this.name = "MaintenanceScheduleError"; this.code = code; }
}

function fail(code) { throw new MaintenanceScheduleError(code); }
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
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function revisionFor(schedules) {
  return crypto.createHash("sha256").update(canonical(schedules)).digest("hex");
}
function normalizeSchedule(value, task, { allowUnsupported = false } = {}) {
  if (!exactKeys(value, SCHEDULE_KEYS) || value.id !== task.id || typeof value.enabled !== "boolean"
    || (!task.cadences.includes(value.cadence) && !(allowUnsupported && value.cadence === "unsupported"))) fail("MAINTENANCE_SCHEDULE_INVALID");
  const weekdays = Array.isArray(value.weekdays) ? value.weekdays.map(String) : [];
  if (new Set(weekdays).size !== weekdays.length || weekdays.some((day) => !WEEKDAYS.includes(day))) {
    fail("MAINTENANCE_SCHEDULE_INVALID");
  }
  const orderedDays = WEEKDAYS.filter((day) => weekdays.includes(day));
  const time = value.time === null ? null : String(value.time || "");
  const intervalMinutes = value.intervalMinutes === null ? null : Number(value.intervalMinutes);
  const monthDay = value.monthDay === null ? null : Number(value.monthDay);
  if (value.cadence === "unsupported") {
    if (orderedDays.length || time !== null || intervalMinutes !== null || monthDay !== null) fail("MAINTENANCE_SCHEDULE_INVALID");
  } else if (value.cadence === "interval") {
    if (orderedDays.length || time !== null || !INTERVALS.has(intervalMinutes) || monthDay !== null) {
      fail("MAINTENANCE_SCHEDULE_INVALID");
    }
  } else {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || intervalMinutes !== null) {
      fail("MAINTENANCE_SCHEDULE_INVALID");
    }
    if (value.cadence === "weekly") {
      if (!orderedDays.length || monthDay !== null) fail("MAINTENANCE_SCHEDULE_INVALID");
    } else if (orderedDays.length || !Number.isSafeInteger(monthDay) || monthDay < 1 || monthDay > 28) {
      fail("MAINTENANCE_SCHEDULE_INVALID");
    }
  }
  return { id: task.id, enabled: value.enabled, cadence: value.cadence, weekdays: orderedDays, time, intervalMinutes, monthDay };
}
function normalizeSchedules(value, options = {}) {
  if (!Array.isArray(value) || value.length !== TASKS.length) fail("MAINTENANCE_SCHEDULE_INVALID");
  const submitted = new Map();
  for (const schedule of value) {
    const id = String(schedule?.id || "");
    if (!TASK_BY_ID.has(id) || submitted.has(id)) fail("MAINTENANCE_SCHEDULE_INVALID");
    submitted.set(id, schedule);
  }
  return TASKS.map((task) => normalizeSchedule(submitted.get(task.id), task, options));
}
function defaultSchedules() {
  return TASKS.map((task) => normalizeSchedule({ id: task.id, ...task.defaults }, task));
}
function calendarExpression(schedule) {
  if (schedule.cadence === "interval") return `*:0/${schedule.intervalMinutes}`;
  if (schedule.cadence === "weekly") {
    return `${schedule.weekdays.map((day) => SYSTEMD_WEEKDAYS[day]).join(",")} *-*-* ${schedule.time}:00`;
  }
  const day = String(schedule.monthDay).padStart(2, "0");
  if (schedule.cadence === "monthly") return `*-*-${day} ${schedule.time}:00`;
  return `*-01,04,07,10-${day} ${schedule.time}:00`;
}
function dropInBody(schedule, policy) {
  // Preserve the effective catch-up and delay policy for this timer. Other
  // timers are never rewritten merely because one matrix row changes.
  return `[Timer]\nOnCalendar=\nOnCalendar=${calendarExpression(schedule)}\nPersistent=${policy.Persistent}\nRandomizedDelaySec=${policy.RandomizedDelayUSec}\nFixedRandomDelay=${policy.FixedRandomDelay}\nAccuracySec=${policy.AccuracyUSec}\n`;
}
function command(runner, executable, args, accepted = new Set([0]), options = {}) {
  const remaining = options.controlDeadlineMs === undefined ? Infinity : options.controlDeadlineMs - Date.now();
  if (remaining <= 0) fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
  const timeout = Math.min(options.timeout || (executable === SYSTEMCTL
    ? args[0] === "daemon-reload" ? RELOAD_TIMEOUT_MS : COMMAND_TIMEOUT_MS : 5000), remaining);
  const report = executable === SYSTEMCTL && ["stop", "start", "clean", "enable", "disable", "daemon-reload"].includes(args[0]);
  const progress = value => {
    if (typeof options.onProgress === "function") options.onProgress(value);
    else if (!options.spawnSync) process.stderr.write(`${JSON.stringify(value)}\n`);
  };
  const started = Date.now();
  if (report) progress({ event: "maintenance-schedule-control", action: args[0], phase: "started" });
  const result = runner(executable, args, {
    encoding: "utf8", timeout, maxBuffer: options.maxBuffer || 4096,
    stdio: ["ignore", "pipe", "pipe"], env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
  });
  if (report) progress({ event: "maintenance-schedule-control", action: args[0], phase: "finished",
    elapsedMs: Date.now() - started, ok: Boolean(result && !result.error && accepted.has(result.status)) });
  if (!result || result.error || !accepted.has(result.status) || typeof result.stdout !== "string"
    || Buffer.byteLength(result.stdout, "utf8") > (options.maxBuffer || 4096) || result.stdout.includes("\0")) {
    fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
  }
  return { status: result.status, output: result.stdout.trim() };
}
function systemctl(args, options = {}, accepted) {
  return command(options.spawnSync || childProcess.spawnSync, SYSTEMCTL, args, accepted, options);
}
function unitState(unit, options = {}) {
  const load = systemctl(["show", "--property=LoadState", "--value", unit], options).output;
  if (load === "not-found") return { installed: false, enabled: false, active: false, running: false, nextRunAt: null };
  if (load !== "loaded") fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
  const enabledResult = systemctl(["is-enabled", unit], options, new Set([0, 1]));
  const activeResult = systemctl(["is-active", unit], options, new Set([0, 3]));
  const enabled = enabledResult.status === 0 && enabledResult.output === "enabled";
  const disabled = enabledResult.status === 1 && enabledResult.output === "disabled";
  const active = activeResult.status === 0 && activeResult.output === "active";
  const inactive = activeResult.status === 3 && ["inactive", "failed"].includes(activeResult.output);
  if ((!enabled && !disabled) || (!active && !inactive)) fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
  let nextRunAt = null;
  if (enabled && active) {
    const raw = systemctl(["show", "--property=NextElapseUSecRealtime", "--value", unit], options).output;
    const converted = command(options.dateSpawnSync || childProcess.spawnSync, DATE,
      ["--date", raw, "--utc", "+%Y-%m-%dT%H:%M:%S.000Z"], new Set([0]), options).output;
    if (!timestamp(converted)) fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
    nextRunAt = converted;
  }
  return { installed: true, enabled, active, running: false, nextRunAt };
}
const TIMER_PROPERTIES = Object.freeze([
  "TimersCalendar", "TimersMonotonic", "Persistent", "RandomizedDelayUSec", "FixedRandomDelay", "AccuracyUSec",
  "OnClockChange", "OnTimezoneChange", "Unit",
]);
function timerProperties(task, options = {}) {
  const output = systemctl(["show", "--all", `--property=${TIMER_PROPERTIES.join(",")}`, task.timer], {
    ...options, maxBuffer: 16384,
  }).output;
  const values = {};
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator), value = line.slice(separator + 1);
    if (separator < 0 || !TIMER_PROPERTIES.includes(key) || Object.hasOwn(values, key)) fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
    values[key] = value;
  }
  // systemctl may omit empty array properties even with --all. Only these two
  // arrays have an empty default; every scalar remains required below.
  for (const key of ["TimersCalendar", "TimersMonotonic"]) {
    if (!Object.hasOwn(values, key)) values[key] = "";
  }
  if (Object.keys(values).length !== TIMER_PROPERTIES.length
    || ["Persistent", "FixedRandomDelay", "OnClockChange", "OnTimezoneChange"].some(key => !["yes", "no"].includes(values[key]))
    || ["RandomizedDelayUSec", "AccuracyUSec"].some(key => !/^(?:0|\d+(?:\.\d+)?(?:us|ms|s|min|h|d|w)(?: \d+(?:\.\d+)?(?:us|ms|s|min|h|d|w))*)$/.test(values[key]))) {
    fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
  }
  return values;
}
function scheduleFromCalendar(expression, task, enabled) {
  const base = { id: task.id, enabled, weekdays: [], time: null, intervalMinutes: null, monthDay: null };
  const interval = /^(?:\*-\*-\* )?\*:(?:0?0\/([0-9]+)|00):00$/.exec(expression);
  if (interval) return normalizeSchedule({ ...base, cadence: "interval", intervalMinutes: Number(interval[1] || 60) }, task);
  const match = /^(?:(\S+) )?\*-([*\d,]+)-([*\d]+) ([0-2]\d:[0-5]\d):00$/.exec(expression);
  if (!match) return null;
  const [, dayExpression, months, day, time] = match;
  if (months === "*" && day === "*") {
    const shortDays = Object.values(SYSTEMD_WEEKDAYS);
    const days = new Set();
    for (const part of (dayExpression || "Mon..Sun").split(",")) {
      const range = part.split("..");
      const first = shortDays.indexOf(range[0]), last = shortDays.indexOf(range.at(-1));
      if (range.length > 2 || first < 0 || last < first) return null;
      for (let index = first; index <= last; index += 1) days.add(WEEKDAYS[index]);
    }
    return normalizeSchedule({ ...base, cadence: "weekly", weekdays: WEEKDAYS.filter(day => days.has(day)), time }, task);
  }
  if (dayExpression || !/^\d{2}$/.test(day) || !["*", "01,04,07,10"].includes(months)) return null;
  return normalizeSchedule({ ...base, cadence: months === "*" ? "monthly" : "quarterly", monthDay: Number(day), time }, task);
}
function effectiveSchedule(task, state, options = {}) {
  const unsupported = reason => ({
    schedule: { id: task.id, enabled: state.enabled, cadence: "unsupported", weekdays: [], time: null, intervalMinutes: null, monthDay: null },
    unsupportedReason: reason,
  });
  if (!state.installed) return unsupported("not-installed");
  const properties = timerProperties(task, options);
  if (properties.Unit !== task.services[0]) return { ...unsupported("different-target"), properties };
  if (properties.TimersMonotonic || properties.OnClockChange === "yes" || properties.OnTimezoneChange === "yes") {
    return { ...unsupported("additional-triggers"), properties };
  }
  // Read systemd's effective, merged calendar (including administrator drop-ins),
  // not the unit template or our previously saved JSON. Multiple events and
  // calendar/timezone forms outside the matrix are explicitly read-only.
  const calendar = /^\{ OnCalendar=([^;{}]+) ; next_elapse=[^{}]* \}$/.exec(properties.TimersCalendar);
  let schedule;
  try { schedule = calendar && scheduleFromCalendar(calendar[1].trim(), task, state.enabled); } catch { /* unrepresentable */ }
  return schedule ? { schedule, unsupportedReason: null, properties }
    : { ...unsupported("calendar-not-supported"), properties };
}
function startTimerWithoutCatchUp(task, properties, options = {}) {
  // systemd.timer documents clean --what=state for the Persistent timestamp.
  // timer_start() then uses the new activation time as its calendar baseline.
  // Only this deliberately changed timer loses its previous timestamp; its
  // Persistent policy remains intact for later outages and normal restarts.
  if (properties.Persistent === "yes") systemctl(["clean", "--what=state", task.timer], options);
  systemctl(["start", task.timer], options);
}
function serviceRunning(service, options = {}) {
  const load = systemctl(["show", "--property=LoadState", "--value", service], options).output;
  if (load === "not-found") return false;
  if (load !== "loaded") fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
  const state = systemctl(["show", "--property=ActiveState", "--value", service], options).output;
  if (["active", "activating", "reloading", "deactivating"].includes(state)) return true;
  if (!["inactive", "failed"].includes(state)) fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
  return false;
}
function safeDirectory(directory, { mode = 0o700, create = false } = {}) {
  if (create && !fs.existsSync(directory)) fs.mkdirSync(directory, { mode });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && stat.nlink < 2)
    || (process.platform !== "win32" && (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== mode))) {
    fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
  }
}
function readState(options = {}) {
  const stateRoot = options.stateRoot || STATE_ROOT;
  const statePath = options.statePath || path.join(stateRoot, "schedules.json");
  safeDirectory(stateRoot, { mode: 0o700, create: options.createStateRoot === true });
  if (!fs.existsSync(statePath)) return null;
  const stat = fs.lstatSync(statePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 2 || stat.size > 32 * 1024
    || (process.platform !== "win32" && (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o600))) {
    fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED"); }
  const schedules = normalizeSchedules(value?.schedules, { allowUnsupported: true });
  if (!exactKeys(value, STATE_KEYS) || value.format !== STATE_FORMAT || value.schemaVersion !== STATE_SCHEMA_VERSION
    || !timestamp(value.updatedAt) || value.revision !== revisionFor(schedules)) fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
  return { ...value, schedules };
}
function atomicWrite(file, body, mode = 0o600) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0), mode);
    fs.writeFileSync(descriptor, body, "utf8"); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file);
    if (process.platform !== "win32") {
      const parent = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}
function writeState(schedules, options = {}) {
  const stateRoot = options.stateRoot || STATE_ROOT;
  const statePath = options.statePath || path.join(stateRoot, "schedules.json");
  safeDirectory(stateRoot, { mode: 0o700 });
  const updatedAt = new Date(Number.isFinite(options.nowMs) ? options.nowMs : Date.now()).toISOString();
  const value = { format: STATE_FORMAT, schemaVersion: STATE_SCHEMA_VERSION, updatedAt, revision: revisionFor(schedules), schedules };
  atomicWrite(statePath, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}
function dropInPath(task, options = {}) {
  return path.join(options.systemdRoot || SYSTEMD_ROOT, `${task.timer}.d`, "20-grabenplaner-schedule.conf");
}
function scheduleSnapshot(options = {}) {
  options = { ...options, controlDeadlineMs: options.controlDeadlineMs ?? Date.now() + TRANSACTION_BUDGET_MS };
  readState(options); // Preserve the protected state-file integrity check.
  const configured = [];
  const tasks = TASKS.map(task => {
    const state = unitState(task.timer, options);
    const running = task.services.some((service) => serviceRunning(service, options));
    const effective = effectiveSchedule(task, state, options);
    configured.push(effective.schedule);
    return { ...effective.schedule, ...state, running, unsupportedReason: effective.unsupportedReason };
  });
  const checkedAt = new Date(Number.isFinite(options.nowMs) ? options.nowMs : Date.now()).toISOString();
  if (!timestamp(checkedAt)) fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
  return { available: true, checkedAt, revision: revisionFor(configured), tasks };
}
function applySchedules(input, options = {}) {
  options = { ...options, controlDeadlineMs: options.controlDeadlineMs ?? Date.now() + TRANSACTION_BUDGET_MS };
  const schedules = normalizeSchedules(input, { allowUnsupported: true });
  const beforeState = readState(options);
  const before = [];
  for (const task of TASKS) {
    const state = unitState(task.timer, options);
    if (!state.installed && !task.optional) fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
    if (task.services.some((service) => serviceRunning(service, options))) fail("MAINTENANCE_SCHEDULE_BUSY");
    const file = dropInPath(task, options);
    if (state.installed) safeDirectory(path.dirname(file), { mode: 0o755 });
    const effective = effectiveSchedule(task, state, options);
    const different = canonical(schedules[before.length]) !== canonical(effective.schedule);
    if (different && (effective.unsupportedReason || schedules[before.length].cadence === "unsupported")) fail("MAINTENANCE_SCHEDULE_UNAVAILABLE");
    before.push({ task, state, file, effective, different, body: state.installed && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null });
  }
  if (TASKS.some((task, index) => schedules[index].enabled && !before[index].state.installed)) {
    fail("MAINTENANCE_SCHEDULE_UNAVAILABLE");
  }
  if (options.expectedRevision !== undefined
    && options.expectedRevision !== revisionFor(before.map(item => item.effective.schedule))) fail("MAINTENANCE_SCHEDULE_STALE");
  const affected = before.filter(item => item.different);
  const stopped = [];
  let changed = false;
  try {
    for (const item of affected) {
      systemctl(["stop", item.task.timer], options);
      stopped.push(item);
    }
    // Timer stop is synchronous, and never stops its worker. Recheck after
    // stopping so a trigger queued during validation cannot be overlooked.
    if (affected.some(item => item.task.services.some(service => serviceRunning(service, options)))) fail("MAINTENANCE_SCHEDULE_BUSY");
    for (const item of affected) {
      changed = true;
      atomicWrite(item.file, dropInBody(schedules[TASKS.indexOf(item.task)], item.effective.properties), 0o644);
    }
    if (affected.length) systemctl(["daemon-reload"], options);
    for (const item of affected) {
      const schedule = schedules[TASKS.indexOf(item.task)];
      const effective = effectiveSchedule(item.task, { ...item.state, enabled: schedule.enabled }, options);
      if (canonical(effective.schedule) !== canonical(schedule)) fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
      systemctl([schedule.enabled ? "enable" : "disable", "--no-reload", item.task.timer], options);
      if (schedule.enabled) startTimerWithoutCatchUp(item.task, effective.properties, options);
      const current = unitState(item.task.timer, options);
      if (current.enabled !== schedule.enabled || current.active !== schedule.enabled) {
        fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
      }
    }
    writeState(schedules, options);
    return scheduleSnapshot(options);
  } catch (error) {
    if (changed || stopped.length) {
      // Reserve a separate bounded rollback window; an expired apply budget
      // must not prevent restoring the already-stopped timers and files.
      const rollbackOptions = { ...options, controlDeadlineMs: Date.now() + TRANSACTION_BUDGET_MS };
      try {
        for (const item of stopped) systemctl(["stop", item.task.timer], rollbackOptions);
        for (const item of affected) {
          if (!changed) continue;
          if (item.body === null) fs.rmSync(item.file, { force: true }); else atomicWrite(item.file, item.body, 0o644);
        }
        if (changed) systemctl(["daemon-reload"], rollbackOptions);
        for (const item of stopped) {
          systemctl([item.state.enabled ? "enable" : "disable", "--no-reload", item.task.timer], rollbackOptions);
          if (item.state.active) startTimerWithoutCatchUp(item.task, item.effective.properties, rollbackOptions);
        }
        const statePath = options.statePath || path.join(options.stateRoot || STATE_ROOT, "schedules.json");
        if (beforeState) atomicWrite(statePath, `${JSON.stringify(beforeState, null, 2)}\n`);
        else fs.rmSync(statePath, { force: true });
      } catch { /* fail closed; caller reports the control failure */ }
    }
    if (error instanceof MaintenanceScheduleError) throw error;
    fail("MAINTENANCE_SCHEDULE_CONTROL_FAILED");
  }
}

module.exports = {
  COMMAND_TIMEOUT_MS, RELOAD_TIMEOUT_MS, TRANSACTION_BUDGET_MS,
  INTERVALS, STATE_FORMAT, STATE_PATH, STATE_ROOT, STATE_SCHEMA_VERSION, SYSTEMD_ROOT, TASKS, WEEKDAYS,
  MaintenanceScheduleError, applySchedules, calendarExpression, defaultSchedules, dropInBody, normalizeSchedules,
  readState, revisionFor, scheduleSnapshot, writeState, scheduleFromCalendar,
};
