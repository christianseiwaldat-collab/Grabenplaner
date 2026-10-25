"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { HOURS, HOST_CPU_STAT_PATH, createHostCpuSampler, createSystemUtilizationRecorder, readCpuCounters, readLinuxCpuStat } = require("../lib/system-utilization");

const counters = (user, idle, processors = 2) => ({ values: [user, 0, 0, idle, 0, 0, 0, 0], idle, logicalProcessors: processors });
const memory = () => ({ totalBytes: 1000, availableBytes: 600, usedPercent: 40, availabilitySource: "mem_available" });
function fixture(options = {}) {
  let at = Date.parse("2026-10-23T18:00:00.001Z"), cpu = 25;
  const recorder = createSystemUtilizationRecorder({ now: () => at,
    cpuSample: now => ({ usedPercent: cpu, logicalProcessors: 4, measuredAt: new Date(now).toISOString(), sampleDurationMs: 10_000,
      status: cpu === null ? "warming-up" : "ready", measurement: "host_cpu_times" }), memorySample: memory, ...options });
  return { recorder, advance: (amount = 10_000) => { at += amount; }, cpu: value => { cpu = value; } };
}

test("host CPU measures counter differences across every core, never load average", () => {
  let value = counters(100, 300);
  const sample = createHostCpuSampler({ readCounters: () => value });
  const first = sample(1000);
  assert.equal(first.usedPercent, null); assert.equal(first.status, "warming-up");
  value = counters(200, 600);
  const next = sample(11000);
  assert.equal(next.usedPercent, 25); assert.equal(next.logicalProcessors, 2);
  assert.equal(next.measurement, "host_cpu_times"); assert.equal(next.sampleDurationMs, 10000);
  value = counters(600, 600); assert.equal(sample(21000).usedPercent, 100);
  value = counters(600, 1000); assert.equal(sample(31000).usedPercent, 0);
});

test("Linux parser excludes guest double-counting and includes I/O wait in idle", () => {
  const value = readCpuCounters("linux", () => "cpu 100 20 30 400 50 6 7 8 90 10\ncpu0 1 2\ncpu1 1 2\n");
  assert.deepEqual(value.values, [100, 20, 30, 400, 50, 6, 7, 8]);
  assert.equal(value.idle, 450); assert.equal(value.logicalProcessors, 2);
  const local = readCpuCounters("win32", undefined, () => [{ times: { user: 100, nice: 0, sys: 50, idle: 300, irq: 5 } }]);
  assert.equal(local.idle, 300); assert.deepEqual(local.values, [100, 0, 50, 300, 5]);
});

test("Linux CPU prefers the native proc file and never reads the optional bind unnecessarily", () => {
  const calls = [], content = "cpu 100 0 20 400 0 0 0 0\ncpu0 1 2\n";
  assert.equal(readLinuxCpuStat((file, encoding) => { calls.push([file, encoding]); return content; }), content);
  assert.deepEqual(calls, [["/proc/stat", "utf8"]]);
});

test("hidden or denied global proc counters use only the fixed read-only host alias", () => {
  for (const code of ["ENOENT", "EACCES", "EPERM"]) {
    const calls = [], content = "cpu 100 0 20 400 0 0 0 0\ncpu0 1 2\n";
    const value = readLinuxCpuStat((file, encoding) => {
      calls.push([file, encoding]);
      if (file === "/proc/stat") throw Object.assign(new Error("ProcSubset=pid"), { code });
      assert.equal(file, HOST_CPU_STAT_PATH); return content;
    });
    assert.equal(value, content);
    assert.deepEqual(calls, [["/proc/stat", "utf8"], ["/run/grabenplaner-host-cpu-stat", "utf8"]]);
  }
});

test("CPU alias does not hide unexpected primary I/O errors or malformed counters", () => {
  const calls = [], error = Object.assign(new Error("I/O failure"), { code: "EIO" });
  assert.throws(() => readLinuxCpuStat(file => { calls.push(file); throw error; }), value => value === error);
  assert.deepEqual(calls, ["/proc/stat"]);
  const malformedCalls = [];
  const sample = createHostCpuSampler({ readCounters: () => readCpuCounters("linux", () => readLinuxCpuStat(file => {
    malformedCalls.push(file); return "not CPU counters";
  })) });
  assert.equal(sample(1000).status, "unavailable");
  assert.deepEqual(malformedCalls, ["/proc/stat"]);
});

test("hardened Linux recorder measures fresh host alias deltas and retains unavailable gaps", () => {
  let at = 1000, content = "cpu 100 0 0 300 0 0 0 0\ncpu0 1 2\ncpu1 1 2\n", present = true;
  const readFile = file => {
    if (file === "/proc/stat" || !present) throw Object.assign(new Error("not present"), { code: "ENOENT" });
    assert.equal(file, HOST_CPU_STAT_PATH); return content;
  };
  const sampler = createHostCpuSampler({ readCounters: () => readCpuCounters("linux", () => readLinuxCpuStat(readFile)) });
  const recorder = createSystemUtilizationRecorder({ now: () => at, cpuSample: sampler, memorySample: memory });
  recorder.collect(); assert.equal(recorder.snapshot().cpu.status, "warming-up");
  at += 10_000; content = "cpu 200 0 0 600 0 0 0 0\ncpu0 1 2\ncpu1 1 2\n";
  recorder.collect(); assert.equal(recorder.snapshot().cpu.usedPercent, 25);
  assert.equal(recorder.snapshot().cpu.logicalProcessors, 2);
  assert.equal(recorder.snapshot().cpu.measurement, "host_cpu_times");
  at += 10_000; recorder.collect();
  assert.equal(recorder.snapshot().cpu.usedPercent, null, "a copied/stale counter file cannot invent zero utilization");
  at += 10_000; present = false; recorder.collect(); assert.equal(recorder.snapshot().cpu.status, "unavailable");
  at += 10_000; present = true; content = "cpu 300 0 0 900 0 0 0 0\ncpu0 1 2\ncpu1 1 2\n";
  recorder.collect(); assert.equal(recorder.snapshot().cpu.status, "warming-up");
  at += 10_000; content = "cpu 400 0 0 1200 0 0 0 0\ncpu0 1 2\ncpu1 1 2\n";
  recorder.collect(); assert.equal(recorder.snapshot().cpu.usedPercent, 25);
  at += 10_000;
  const points = recorder.read(1).points.filter(point => point.sampleCount);
  assert.equal(points.filter(point => point.cpu.count).length, 2);
  assert(points.some(point => point.hasGap && point.cpu.count === 0));
  assert.equal(recorder.snapshot().memory.usedPercent, 40);
});

test("CPU bind template exposes only live read-only aggregate counters and preserves the Core6 proc sandbox", () => {
  const root = path.join(__dirname, "..");
  const template = fs.readFileSync(path.join(root, "server-tools/linux/grabenplaner-host-cpu-stat.conf.in"), "utf8");
  const directives = template.split(/\r?\n/u).filter(line => line && !line.startsWith("#"));
  assert.deepEqual(directives, ["[Service]", `BindReadOnlyPaths=/proc/stat:${HOST_CPU_STAT_PATH}:norbind`]);
  const unit = fs.readFileSync(path.join(root, "server-tools/linux/grabenplaner.service.in"), "utf8");
  assert.match(unit, /^ProtectProc=invisible$/mu); assert.match(unit, /^ProcSubset=pid$/mu);
  assert.doesNotMatch(template, /^\s*(?:BindPaths|ProcSubset|ProtectProc|CapabilityBoundingSet|AmbientCapabilities|ExecStart|User|Group)=/mu);
});

test("CPU resets, hotplug, bad counters and large/negative intervals stay unknown", () => {
  let value = counters(100, 300);
  const sample = createHostCpuSampler({ readCounters: () => value });
  sample(1000);
  value = counters(90, 500); assert.equal(sample(11000).usedPercent, null);
  value = counters(100, 600, 4); assert.equal(sample(21000).usedPercent, null);
  value = counters(100, 600, 4); assert.equal(sample(31000).usedPercent, null);
  value = counters(200, 700, 4); assert.equal(sample(20000).usedPercent, null);
  value = counters(300, 800, 4); assert.equal(sample(200000).usedPercent, null);
  value = counters(NaN, 900, 4); assert.equal(sample(210000).status, "unavailable");
  value = counters(400, 1000, 4); assert.equal(sample(220000).usedPercent, null);
  value = counters(500, 1100, 4); assert.equal(sample(220001).usedPercent, null);
});

test("recorder runs without browser reads; lifecycle starts once and stops cleanly", () => {
  let scheduled = 0, cleared = 0, unrefs = 0, tick;
  const { recorder, advance } = fixture({ setTimer: (callback, interval) => {
    scheduled++; tick = callback; assert.equal(interval, 10000); return { unref() { unrefs++; } };
  }, clearTimer: () => { cleared++; } });
  recorder.start(); recorder.start(); advance(); tick();
  const history = recorder.read(1);
  assert.equal(scheduled, 1); assert.equal(unrefs, 1); assert.equal(history.current.cpu.usedPercent, 25);
  assert.equal(history.points.reduce((sum, point) => sum + point.sampleCount, 0), 2);
  recorder.stop(); recorder.stop(); assert.equal(cleared, 1);
});

test("history returns measured averages/extrema/counts, keeps unknown and full gaps open", () => {
  const { recorder, advance, cpu } = fixture();
  cpu(null); recorder.collect(); advance(); cpu(20); recorder.collect(); advance(); cpu(80); recorder.collect(); advance(90000);
  cpu(40); recorder.collect(); advance();
  const history = recorder.read(6), known = history.points.filter(point => point.sampleCount > 0);
  assert.equal(history.scope, "host"); assert.equal(history.retentionDays, 180); assert.equal(history.intervalSeconds, 10);
  assert.equal(known[0].sampleCount, 3); assert.equal(known[0].cpu.avg, 50); assert.equal(known[0].cpu.count, 2);
  assert.equal(known[0].cpu.min, 20); assert.equal(known[0].cpu.max, 80); assert.equal(known[0].hasGap, true);
  assert(history.points.some(point => point.sampleCount === 0 && point.cpu.avg === null && point.memory.avg === null));
  assert(known.at(-1).hasGap); assert.equal(history.current.memory.usedPercent, 40);
});

test("every allowed range is capped, ordered, inside the exact requested interval", () => {
  const { recorder, advance } = fixture(); recorder.collect(); advance();
  for (const hours of HOURS) {
    const value = recorder.read(hours);
    assert(value.points.length > 0 && value.points.length <= 1200, String(hours));
    assert.equal(Date.parse(value.to) - Date.parse(value.from), hours * 3600000);
    assert.equal(value.points[0].at, value.from); assert.equal(value.points.at(-1).until, value.to);
    value.points.forEach((point, index) => { assert(Date.parse(point.at) < Date.parse(point.until)); if (index) assert.equal(point.at, value.points[index - 1].until); });
  }
  for (const bad of [0, 2, 24.5, 4321, "24", Infinity, NaN]) assert.throws(() => recorder.read(bad), error => error.status === 400);
});

test("stale snapshots expire apparent current percentages without changing history", () => {
  const { recorder, advance } = fixture(); recorder.collect(); advance(31000);
  const value = recorder.read(1);
  assert.equal(value.status, "stale"); assert.equal(value.current.cpu.usedPercent, null); assert.equal(value.current.memory.usedPercent, null);
  assert(value.points.some(point => point.cpu.avg === 25));
});

test("GET-style reads do not sample, extend retention or touch a file", () => {
  let samples = 0;
  const { recorder } = fixture({ cpuSample: () => { samples++; throw new Error(); } });
  const first = recorder.read(24); const second = recorder.read(24);
  assert.equal(first.status, "warming-up"); assert.deepEqual(first, second); assert.equal(samples, 0);
});

test("history is batched, atomic, reloadable and checksum failures never overwritten", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-utilization-"));
  const file = path.join(directory, "history.json");
  try {
    const f = fixture({ file }); f.recorder.collect(); assert(!fs.existsSync(file));
    f.advance(900000); f.recorder.collect(); assert(fs.existsSync(file));
    const before = fs.readFileSync(file, "utf8");
    f.recorder.read(1); assert.equal(fs.readFileSync(file, "utf8"), before);
    const next = fixture({ file }); assert.equal(next.recorder.read(1).integrityVerified, true);
    assert(next.recorder.read(1).points.some(point => point.cpu.avg === 25));
    const broken = JSON.parse(before); broken.series.recent.at(-1)[3] = 9000; fs.writeFileSync(file, JSON.stringify(broken));
    const damaged = fixture({ file }); damaged.recorder.collect(); damaged.recorder.stop();
    assert.equal(damaged.recorder.read(1).status, "unavailable");
    assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(broken));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("retention remains bounded through 181 days and backward timestamps cannot duplicate bins", () => {
  const f = fixture();
  f.recorder.collect(); assert.equal(f.recorder.collect(), false);
  f.advance(181 * 86400000); f.recorder.collect(); f.advance();
  const value = f.recorder.read(4320);
  assert.equal(value.points.reduce((sum, point) => sum + point.sampleCount, 0), 1);
});

test("missing host memory/counters remain unknown, not fabricated zero", () => {
  const { recorder, advance } = fixture({ cpuSample: () => { throw new Error(); }, memorySample: () => ({ totalBytes: 0, availableBytes: 0, usedPercent: 0 }) });
  recorder.collect(); advance(); const value = recorder.read(1);
  assert.equal(value.current.cpu.usedPercent, null); assert.equal(value.current.memory.usedPercent, null);
  const point = value.points.find(entry => entry.sampleCount);
  assert.equal(point.cpu.avg, null); assert.equal(point.memory.avg, null);
});

test("a history path changed to a directory reports failure and preserves the existing directory", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-utilization-path-")), file = path.join(directory, "history.json");
  try {
    const f = fixture({ file }); f.recorder.collect(); assert.equal(f.recorder.flush(), true);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.unlinkSync(file); fs.mkdirSync(file); f.advance(); f.recorder.collect(); assert.equal(f.recorder.flush(), false);
    assert.equal(f.recorder.read(1).persistence.writeFailed, true); assert(fs.statSync(file).isDirectory());
    assert.equal(fs.readdirSync(directory).length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("minute/hour rollups retain correct peaks and summaries over a week", () => {
  const f = fixture();
  for (let hour = 0; hour < 24 * 8; hour++) { f.cpu(hour % 2 ? 80 : 20); f.recorder.collect(); f.advance(3600000); }
  for (const hours of [168, 720, 4320]) {
    const value = f.recorder.read(hours), known = value.points.filter(point => point.cpu.count);
    const sum = known.reduce((total, point) => total + point.cpu.avg * point.cpu.count, 0);
    const count = known.reduce((total, point) => total + point.cpu.count, 0);
    assert.equal(Math.round(sum / count), 50); assert(known.every(point => point.cpu.min >= 20 && point.cpu.max <= 80));
    assert(value.points.length <= 1200);
  }
});
