"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { systemMemorySummary } = require("./system-memory");

const INTERVAL_MS = 10_000;
const RETENTION_DAYS = 180;
const HOST_CPU_STAT_PATH = "/run/grabenplaner-host-cpu-stat";
const HOURS = Object.freeze([1, 6, 24, 72, 168, 720, 2160, 4320]);
const TIERS = Object.freeze([
  { name: "recent", resolution: INTERVAL_MS, retention: 3_600_000, limit: 362 },
  { name: "minutes", resolution: 60_000, retention: 7 * 86_400_000, limit: 10_082 },
  { name: "hours", resolution: 3_600_000, retention: RETENTION_DAYS * 86_400_000, limit: 4_322 },
]);
const percentage = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
const counter = value => Number.isSafeInteger(value) && value >= 0;
const iso = value => new Date(value).toISOString();

function readLinuxCpuStat(readFile = fs.readFileSync) {
  try { return readFile("/proc/stat", "utf8"); }
  catch (error) {
    // ProcSubset=pid hides global proc files. The optional systemd drop-in
    // exposes only this live counter file through a read-only host bind mount.
    // Do not mask malformed data or unrelated I/O failures with a fallback.
    if (!["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error;
    return readFile(HOST_CPU_STAT_PATH, "utf8");
  }
}

function readCpuCounters(platform = process.platform, readKernel = readLinuxCpuStat, cpus = os.cpus) {
  if (platform === "linux") {
    const content = readKernel();
    if (typeof content !== "string" || content.length > 2 * 1024 * 1024) throw new Error("CPU_COUNTERS_UNAVAILABLE");
    const values = /^cpu\s+([\d\s]+)$/mu.exec(content)?.[1].trim().split(/\s+/u).map(Number);
    if (!values || values.length < 8 || values.slice(0, 8).some(value => !counter(value))) throw new Error("CPU_COUNTERS_UNAVAILABLE");
    // guest/guest_nice are already included in user/nice. Waiting for I/O is
    // idle time, not a busy processor. These are host counters, not GP CPU time.
    return { values: values.slice(0, 8), idle: values[3] + values[4], logicalProcessors: (content.match(/^cpu\d+\s/gmu) || []).length };
  }
  const processors = cpus();
  const values = processors.flatMap(processor => ["user", "nice", "sys", "idle", "irq"].map(key => processor.times?.[key]));
  return { values, idle: processors.reduce((sum, processor) => sum + processor.times.idle, 0), logicalProcessors: processors.length };
}

function createHostCpuSampler({ readCounters = readCpuCounters } = {}) {
  let baseline = null;
  return function sample(now = Date.now()) {
    const unavailable = { usedPercent: null, logicalProcessors: null, measuredAt: iso(now), sampleDurationMs: null,
      measurement: "host_cpu_times", status: "unavailable" };
    try {
      const value = readCounters();
      const total = value.values.reduce((sum, current) => sum + current, 0);
      if (!value.values.length || value.values.some(current => !counter(current)) || !counter(total)
        || !counter(value.idle) || value.idle > total || !Number.isInteger(value.logicalProcessors)
        || value.logicalProcessors < 1 || value.logicalProcessors > 65_536) throw new Error("CPU_COUNTERS_UNAVAILABLE");
      const result = { ...unavailable, logicalProcessors: value.logicalProcessors, status: "warming-up" };
      const duration = baseline ? now - baseline.at : 0;
      if (baseline && duration >= 250 && duration <= 120_000 && baseline.logicalProcessors === value.logicalProcessors
        && baseline.values.length === value.values.length && value.values.every((current, index) => current >= baseline.values[index])
        && total > baseline.total && value.idle >= baseline.idle && value.idle - baseline.idle <= total - baseline.total) {
        result.usedPercent = Math.round((1 - (value.idle - baseline.idle) / (total - baseline.total)) * 1000) / 10;
        result.sampleDurationMs = duration;
        result.status = "ready";
      }
      baseline = { ...value, values: [...value.values], total, at: now };
      return result;
    } catch { baseline = null; return unavailable; }
  };
}

// Compact bins are [at, samples, cpuCount, cpuSum, cpuMin, cpuMax,
// ramCount, ramSum, ramMin, ramMax, firstSample, lastSample, largestGap].
function validBin(bin, tier) {
  if (!Array.isArray(bin) || bin.length !== 13 || !bin.every((value, index) => [4, 5, 8, 9].includes(index)
    ? value === null || percentage(value) : typeof value === "number" && Number.isFinite(value) && value >= 0)) return false;
  if (!Number.isSafeInteger(bin[0]) || bin[0] % tier.resolution || !Number.isSafeInteger(bin[1]) || bin[1] < 1 || bin[1] > tier.resolution / 250
    || !Number.isSafeInteger(bin[10]) || !Number.isSafeInteger(bin[11]) || bin[10] < bin[0] || bin[11] < bin[10]
    || bin[11] >= bin[0] + tier.resolution) return false;
  for (const offset of [2, 6]) {
    const [count, sum, min, max] = bin.slice(offset, offset + 4);
    if (!Number.isSafeInteger(count) || count > bin[1] || (count === 0 ? sum !== 0 || min !== null || max !== null
      : !percentage(min) || !percentage(max) || min > max || sum < min * count - .0001 || sum > max * count + .0001)) return false;
  }
  return true;
}

function addMeasure(bin, offset, value, count = 1, min = value, max = value) {
  if (!percentage(value) || count < 1) return;
  bin[offset] += count; bin[offset + 1] += value * count;
  bin[offset + 2] = bin[offset + 2] === null ? min : Math.min(bin[offset + 2], min);
  bin[offset + 3] = bin[offset + 3] === null ? max : Math.max(bin[offset + 3], max);
}

function createSystemUtilizationRecorder({ file = null, now = Date.now, cpuSample = createHostCpuSampler(),
  memorySample = systemMemorySummary, setTimer = setInterval, clearTimer = clearInterval, flushIntervalMs = 15 * 60_000 } = {}) {
  const series = Object.fromEntries(TIERS.map(tier => [tier.name, new Map()]));
  let timer = null, lastAt = null, lastFlush = null, dirty = false, integrityVerified = true, writeFailed = false;
  let current = { measuredAt: null, cpu: { usedPercent: null, logicalProcessors: null, measuredAt: null, sampleDurationMs: null,
    status: "warming-up", measurement: "host_cpu_times" }, memory: { usedPercent: null, totalBytes: null, availableBytes: null, status: "unavailable" } };
  if (file) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 6 * 1024 * 1024) throw new Error("UTILIZATION_HISTORY_INVALID");
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      const payload = { version: value.version, series: value.series };
      if (value.version !== 1 || !value.series || crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex") !== value.checksum) throw new Error("UTILIZATION_HISTORY_INVALID");
      for (const tier of TIERS) {
        const rows = value.series[tier.name];
        if (!Array.isArray(rows) || rows.length > tier.limit || !rows.every(bin => validBin(bin, tier))
          || rows.some((bin, index) => index > 0 && bin[0] <= rows[index - 1][0])) throw new Error("UTILIZATION_HISTORY_INVALID");
      }
      for (const tier of TIERS) for (const bin of value.series[tier.name]) {
        series[tier.name].set(bin[0], bin);
        lastAt = Math.max(lastAt ?? 0, bin[11]);
      }
    } catch (error) { if (error.code !== "ENOENT") integrityVerified = false; }
  }
  if (!integrityVerified) for (const tier of TIERS) series[tier.name].clear();

  function prune(at) {
    for (const tier of TIERS) {
      const entries = series[tier.name];
      for (const key of entries.keys()) if (key + tier.resolution <= at - tier.retention) entries.delete(key);
      while (entries.size > tier.limit) entries.delete(entries.keys().next().value);
    }
  }

  function flush() {
    if (!file || !dirty || !integrityVerified) return false;
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      // A changed path must never turn a history write into a symlink overwrite.
      try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("UTILIZATION_HISTORY_INVALID"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const payload = { version: 1, series: Object.fromEntries(TIERS.map(tier => [tier.name, [...series[tier.name].values()]])) };
      const content = JSON.stringify({ ...payload, checksum: crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex") }) + "\n";
      if (Buffer.byteLength(content) > 6 * 1024 * 1024) throw new Error("UTILIZATION_HISTORY_LIMIT");
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, file);
      dirty = false; lastFlush = now(); writeFailed = false; return true;
    } catch { writeFailed = true; return false; }
    finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") writeFailed = true; } }
  }

  function collect() {
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0 || lastAt !== null && at - lastAt < 250) return false;
    let cpu;
    try { cpu = cpuSample(at); }
    catch { cpu = { usedPercent: null, logicalProcessors: null, measuredAt: iso(at), sampleDurationMs: null, status: "unavailable", measurement: "host_cpu_times" }; }
    let memory;
    try {
      memory = memorySample();
      const valid = Number.isSafeInteger(memory.totalBytes) && memory.totalBytes > 0
        && Number.isSafeInteger(memory.availableBytes) && memory.availableBytes >= 0 && memory.availableBytes <= memory.totalBytes
        && percentage(memory.usedPercent);
      memory = valid ? { ...memory, status: "ready" } : { usedPercent: null, totalBytes: null, availableBytes: null, status: "unavailable" };
    } catch { memory = { usedPercent: null, totalBytes: null, availableBytes: null, status: "unavailable" }; }
    current = { measuredAt: iso(at), cpu, memory };
    if (!integrityVerified) return false;
    const gap = lastAt === null ? 0 : at - lastAt;
    for (const tier of TIERS) {
      const slot = Math.floor(at / tier.resolution) * tier.resolution;
      const bin = series[tier.name].get(slot) || [slot, 0, 0, 0, null, null, 0, 0, null, null, at, at, 0];
      bin[1]++; addMeasure(bin, 2, cpu.usedPercent); addMeasure(bin, 6, memory.usedPercent);
      bin[11] = at; bin[12] = Math.max(bin[12], gap);
      series[tier.name].set(slot, bin);
    }
    lastAt = at; dirty = true; prune(at);
    if (lastFlush === null) lastFlush = at;
    if (at - lastFlush >= flushIntervalMs) flush();
    return true;
  }

  function snapshot() {
    if (current.measuredAt === null) return structuredClone(current);
    const age = current.measuredAt === null ? Infinity : now() - Date.parse(current.measuredAt);
    if (age >= 0 && age <= 3 * INTERVAL_MS) return structuredClone(current);
    return { ...structuredClone(current), cpu: { ...current.cpu, usedPercent: null, status: "stale" },
      memory: { ...current.memory, usedPercent: null, status: "stale" } };
  }

  function read(hours = 24) {
    if (!HOURS.includes(hours)) throw Object.assign(new Error("Ungültiges Zeitfenster für den Messverlauf."), { status: 400, code: "SYSTEM_UTILIZATION_RANGE_INVALID" });
    const to = now(), from = to - hours * 3_600_000;
    const tier = TIERS[hours === 1 ? 0 : hours <= 168 ? 1 : 2];
    const resolution = Math.max(tier.resolution, Math.ceil((to - from) / 1198 / tier.resolution) * tier.resolution);
    const firstSlot = Math.floor(from / resolution) * resolution;
    const buckets = Array.from({ length: Math.ceil((to - firstSlot) / resolution) }, (_, index) => ({ at: Math.max(from, firstSlot + index * resolution),
      until: Math.min(to, firstSlot + (index + 1) * resolution), bin: [0, 0, 0, 0, null, null, 0, 0, null, null, 0, 0, 0] }));
    for (const bin of series[tier.name].values()) {
      if (bin[0] < from || bin[0] >= to) continue;
      const target = buckets[Math.floor((bin[0] - firstSlot) / resolution)]?.bin;
      if (!target) continue;
      target[1] += bin[1];
      if (bin[2]) addMeasure(target, 2, bin[3] / bin[2], bin[2], bin[4], bin[5]);
      if (bin[6]) addMeasure(target, 6, bin[7] / bin[6], bin[6], bin[8], bin[9]);
      target[10] = target[10] ? Math.min(target[10], bin[10]) : bin[10]; target[11] = Math.max(target[11], bin[11]); target[12] = Math.max(target[12], bin[12]);
    }
    const measure = (bin, offset) => ({ avg: bin[offset] ? Math.round(bin[offset + 1] / bin[offset] * 100) / 100 : null,
      min: bin[offset + 2], max: bin[offset + 3], count: bin[offset] });
    const latest = snapshot();
    return { schemaVersion: 1, generatedAt: iso(to), from: iso(from), to: iso(to), hours, scope: "host", intervalSeconds: INTERVAL_MS / 1000,
      retentionDays: RETENTION_DAYS, resolutionSeconds: resolution / 1000, integrityVerified,
      status: !integrityVerified ? "unavailable" : latest.cpu.status === "stale" ? "stale" : latest.cpu.status,
      persistence: { available: Boolean(file) && integrityVerified, writeFailed }, current: latest,
      points: buckets.map(({ at, until, bin }) => ({ at: iso(at), until: iso(until), sampleCount: bin[1], cpu: measure(bin, 2), memory: measure(bin, 6),
        hasGap: !bin[1] || bin[2] < bin[1] || bin[6] < bin[1] || bin[12] > 2 * INTERVAL_MS
          || bin[10] - at > 2 * INTERVAL_MS || until - bin[11] > 2 * INTERVAL_MS })) };
  }

  return { collect, read, snapshot, flush,
    start() { if (timer !== null) return; collect(); timer = setTimer(collect, INTERVAL_MS); timer?.unref?.(); },
    stop() { if (timer !== null) clearTimer(timer); timer = null; flush(); } };
}

module.exports = { HOURS, INTERVAL_MS, RETENTION_DAYS, HOST_CPU_STAT_PATH, createHostCpuSampler, createSystemUtilizationRecorder, readCpuCounters, readLinuxCpuStat };
