"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../server-tools/linux/offsite/lib/maintenance-schedule-broker.js"), "utf8");
const stampRoot = "/var/lib/systemd/timers";

function fixture(t, fault = "", existing = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-timer-stamp-"));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const basename = "stamp-grabenplaner-offsite-assurance.timer", virtualFile = `${stampRoot}/${basename}`;
  const file = path.join(root, basename), old = new Date("2026-09-17T00:00:00.000Z");
  if (existing) { fs.writeFileSync(file, "", { mode: 0o600 }); fs.utimesSync(file, old, old); }
  const events = [];
  const mapped = value => typeof value === "string" && value === virtualFile ? file : value;
  const linuxStat = (value, directory = false) => {
    const real = directory ? fs.lstatSync(root) : typeof value === "number" ? fs.fstatSync(value) : fs.lstatSync(mapped(value));
    real.uid = 0; real.gid = 0; real.mode = directory ? 0o40755 : 0o100600;
    if (directory && fault === "parent-owner") real.uid = 1000;
    if (directory && fault === "parent-writable") real.mode = 0o40777;
    if (!directory) {
      if (fault === "owner") real.uid = 1000;
      if (fault === "group") real.gid = 1000;
      if (fault === "writable") real.mode = 0o100622;
      if (fault === "hardlink") real.nlink = 2;
      if (fault === "contents") real.size = 1;
      if (fault === "symlink") real.isSymbolicLink = () => true;
      if (fault === "special") real.isFile = () => false;
      if (fault === "fd-race" && typeof value === "number") real.ino = -1;
    }
    return real;
  };
  // Real files, descriptors and timestamps; model Linux identity/mode metadata on Windows.
  const fakeFs = { ...fs };
  fakeFs.constants = { ...fs.constants, O_NOFOLLOW: 0x20000, O_NONBLOCK: 0x800 };
  fakeFs.realpathSync = value => fault === "canonical-parent" ? "/different-parent" : value;
  fakeFs.lstatSync = value => linuxStat(value, value !== virtualFile);
  fakeFs.fstatSync = fd => linuxStat(fd);
  fakeFs.openSync = (value, flags, mode) => {
    assert.equal(value, virtualFile, "only the exact allowlisted filename may be opened");
    assert.ok(flags & fakeFs.constants.O_NOFOLLOW);
    assert.ok(flags & fakeFs.constants.O_NONBLOCK);
    assert.equal(Boolean(flags & fs.constants.O_EXCL), !existing);
    events.push("open");
    return fs.openSync(mapped(value), existing ? "r+" : "wx", mode);
  };
  fakeFs.futimesSync = (fd, atime, mtime) => { events.push("touch"); fs.futimesSync(fd, atime, mtime); };
  fakeFs.fsyncSync = fd => { events.push("sync"); fs.fsyncSync(fd); };
  fakeFs.closeSync = fd => { events.push("close"); fs.closeSync(fd); };
  const context = { module: { exports: {} }, process: { platform: "linux" },
    require: name => name === "node:fs" ? fakeFs : name === "node:path" ? path.posix : require(name) };
  vm.runInNewContext(source, context);
  const broker = context.module.exports;
  return { broker, task: broker.TASKS.find(task => task.id === "complete-backup"), file, events, old };
}

for (const existing of [true, false]) test(`timer stamp safely ${existing ? "updates" : "creates"} its exact empty file`, t => {
  const f = fixture(t, "", existing), nowMs = Date.parse("2026-09-19T12:00:00.000Z");
  f.broker.refreshTimerStamp(f.task, { nowMs });
  assert.deepEqual(f.events, ["open", "touch", "sync", "close"]);
  assert.equal(fs.readFileSync(f.file, "utf8"), "");
  assert.ok(Math.abs(fs.statSync(f.file).mtimeMs - nowMs) < 1);
});

for (const fault of ["parent-owner", "parent-writable", "canonical-parent", "owner", "group", "writable", "hardlink", "contents", "symlink", "special", "fd-race"]) {
  test("timer stamp rejects unsafe metadata before changing timestamps: " + fault, t => {
    const f = fixture(t, fault);
    assert.throws(() => f.broker.refreshTimerStamp(f.task), { code: "MAINTENANCE_SCHEDULE_CONTROL_FAILED" });
    assert.ok(!f.events.includes("touch"));
    assert.ok(Math.abs(fs.statSync(f.file).mtimeMs - f.old.getTime()) < 1);
    if (fault === "fd-race") assert.deepEqual(f.events, ["open", "close"]);
  });
}

test("timer stamp refuses caller-provided identities even when the task id looks valid", t => {
  const f = fixture(t);
  for (const task of [{ ...f.task }, { ...f.task, timer: "../../outside" }, { id: "foreign", timer: "foreign.timer" }]) {
    assert.throws(() => f.broker.refreshTimerStamp(task), { code: "MAINTENANCE_SCHEDULE_CONTROL_FAILED" });
  }
  assert.deepEqual(f.events, []);
});
