"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { inspectCommittedBackupMetadata } = require("./backup-commit");

const TIMEOUT_MS = 1500 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_PENDING_JOBS = 4;
const MINIMUM_FREE_BYTES = 10 * 1024 ** 3;
const CHILD_ENTRY = path.resolve(__dirname, "../scripts/run-background-backup.js");
const ENVIRONMENT_KEYS = Object.freeze([
  "GRABENPLANER_BACKUP_RETENTION_DAYS",
  "GRABENPLANER_LOCAL_BACKUP_ARCHIVE", "GRABENPLANER_LOCAL_BACKUP_RESTIC", "GRABENPLANER_LOCAL_BACKUP_RESTIC_SHA256",
  "GRABENPLANER_INTEGRATION_KEY_ID", "GRABENPLANER_INTEGRATION_KEY", "GRABENPLANER_INTEGRATION_KEYS",
  "GRABENPLANER_AMU_KEY_ID", "GRABENPLANER_AMU_KEY", "GRABENPLANER_AMU_KEYS",
]);

function failure(code) { const error = new Error("Die Hintergrundsicherung konnte nicht sicher abgeschlossen werden."); error.code = code; return error; }
function safePath(value, kind) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw failure("BACKGROUND_BACKUP_PATH_INVALID");
  const resolved = path.resolve(value), root = path.parse(resolved).root;
  if (resolved === root) throw failure("BACKGROUND_BACKUP_PATH_INVALID");
  let cursor = root;
  for (const segment of path.relative(root, resolved).split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || (cursor !== resolved && !stat.isDirectory())) throw failure("BACKGROUND_BACKUP_PATH_INVALID");
  }
  const stat = fs.lstatSync(resolved);
  if (kind === "file" ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) throw failure("BACKGROUND_BACKUP_PATH_INVALID");
  return resolved;
}
function overlaps(first, second) {
  const relative = path.relative(first, second);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function validateJob(options = {}) {
  const databasePath = safePath(options.databasePath, "file"), protectedDirectory = safePath(options.protectedDirectory, "directory");
  const backupDirectory = safePath(options.backupDirectory, "directory");
  for (const source of [path.dirname(databasePath), protectedDirectory]) {
    if (overlaps(source, backupDirectory) || overlaps(backupDirectory, source)) throw failure("BACKGROUND_BACKUP_TREE_OVERLAP");
  }
  if (!["app", "external"].includes(options.expectedStream)) throw failure("BACKGROUND_BACKUP_STREAM_INVALID");
  return { databasePath, protectedDirectory, backupDirectory, expectedStream: options.expectedStream };
}
function childEnvironment(job, environment = process.env) {
  const result = { PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production", NODE_NO_WARNINGS: "1",
    DB_PATH: job.databasePath, GRABENPLANER_AMU_DIR: job.protectedDirectory,
    TMPDIR: job.backupDirectory, TMP: job.backupDirectory, TEMP: job.backupDirectory };
  for (const key of ENVIRONMENT_KEYS) if (environment[key] !== undefined) result[key] = String(environment[key]);
  for (const key of ["SystemRoot", "WINDIR"]) if (process.env[key]) result[key] = process.env[key];
  return result;
}
function capacityBytes(directory, statfs = fs.statfsSync) {
  const stat = statfs(directory), available = stat.bavail * stat.bsize;
  if (!Number.isSafeInteger(available) || available < 0) throw failure("BACKGROUND_BACKUP_CAPACITY_UNKNOWN");
  return available;
}
function estimateRawBackupBytes(job) {
  let bytes = fs.lstatSync(safePath(job.databasePath, "file")).size;
  const wal = `${job.databasePath}-wal`;
  try { fs.lstatSync(wal); bytes += fs.lstatSync(safePath(wal, "file")).size; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  function walk(directory) {
    safePath(directory, "directory");
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name), stat = fs.lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(target);
      else { safePath(target, "file"); bytes += stat.size; }
      if (!Number.isSafeInteger(bytes)) throw failure("BACKGROUND_BACKUP_CAPACITY_UNKNOWN");
    }
  }
  walk(job.protectedDirectory);
  return bytes + 64 * 1024;
}
function assertRawBackupCapacity(job, statfs) {
  const required = estimateRawBackupBytes(job) + MINIMUM_FREE_BYTES;
  if (!Number.isSafeInteger(required) || capacityBytes(job.backupDirectory, statfs) < required) throw failure("BACKGROUND_BACKUP_CAPACITY_REQUIRED");
}
function validateResult(raw, job, { archiveRequired = false } = {}) {
  let result;
  try { result = JSON.parse(raw); } catch { throw failure("BACKGROUND_BACKUP_RESULT_INVALID"); }
  if (result?.format !== "grabenplaner-background-backup-result" || result.schemaVersion !== 1
    || result.backup?.committed !== true || result.backup?.verified !== true
    || !/^dienstplan-[A-Za-z0-9._-]+$/.test(String(result.backup?.snapshot || ""))) throw failure("BACKGROUND_BACKUP_RESULT_INVALID");
  const value = result.backup;
  const metadata = inspectCommittedBackupMetadata(job.backupDirectory, `${value.snapshot}.complete.json`);
  if (value.path !== metadata.databasePath || value.protectedDirectory !== metadata.protectedDirectory || value.marker !== metadata.markerPath
    || value.databaseSha256 !== metadata.databaseSha256) throw failure("BACKGROUND_BACKUP_RESULT_INVALID");
  for (const [target, kind] of [[value.path, "file"], [value.marker, "file"], [value.protectedDirectory, "directory"]]) safePath(target, kind);
  let archive = null;
  if (value.archive !== null && value.archive !== undefined) {
    const a = value.archive;
    if (a.archived !== true || !/^[a-f0-9]{64}$/.test(String(a.archiveSnapshotId))
      || !Number.isSafeInteger(a.retained) || a.retained < 1 || a.retained > 20
      || ![a.removedArchives, a.removedRaw].every(n => Number.isSafeInteger(n) && n >= 0)) throw failure("BACKGROUND_BACKUP_RESULT_INVALID");
    archive = { archived: true, archiveSnapshotId: a.archiveSnapshotId, retained: a.retained, removedArchives: a.removedArchives, removedRaw: a.removedRaw };
  }
  if (archiveRequired && !archive) throw failure("BACKGROUND_BACKUP_RESULT_INVALID");
  return { snapshot: value.snapshot, path: value.path, databasePath: value.path, protectedDirectory: value.protectedDirectory,
    marker: value.marker, markerPath: value.marker, databaseSha256: value.databaseSha256,
    modifiedAt: metadata.modifiedAt, modifiedMs: metadata.modifiedMs, committed: true, verified: true, archive };
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function terminateOwnedTree(child, { platform = process.platform, kill = process.kill, spawnProcess = spawn,
  graceMs = 2000, settleMs = 5000 } = {}) {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    if (child.exitCode !== null || child.signalCode) throw failure("BACKGROUND_BACKUP_TREE_UNVERIFIED");
    const windowsRoot = process.env.SystemRoot || "C:\\Windows";
    const executable = safePath(path.join(windowsRoot, "System32", "taskkill.exe"), "file");
    await new Promise((resolve, reject) => {
      const killer = spawnProcess(executable, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
      const timer = setTimeout(() => { killer.kill(); reject(failure("BACKGROUND_BACKUP_TREE_UNVERIFIED")); }, settleMs);
      killer.once("error", () => { clearTimeout(timer); reject(failure("BACKGROUND_BACKUP_TREE_UNVERIFIED")); });
      killer.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(failure("BACKGROUND_BACKUP_TREE_UNVERIFIED")); });
    });
    return;
  }
  const alive = () => {
    try { kill(-pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw failure("BACKGROUND_BACKUP_TREE_UNVERIFIED"); }
  };
  try { kill(-pid, "SIGTERM"); } catch (error) { if (error.code === "ESRCH") return; throw failure("BACKGROUND_BACKUP_TREE_UNVERIFIED"); }
  const gracefulEnd = Date.now() + graceMs;
  while (alive() && Date.now() < gracefulEnd) await delay(50);
  if (!alive()) return;
  try { kill(-pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw failure("BACKGROUND_BACKUP_TREE_UNVERIFIED"); }
  const forcedEnd = Date.now() + settleMs;
  while (alive() && Date.now() < forcedEnd) await delay(50);
  if (alive()) throw failure("BACKGROUND_BACKUP_TREE_UNVERIFIED");
}

function createScheduler(dependencies = {}) {
  const pending = [], drains = [], failedScopes = new Map();
  let active = null, lastSuccessAt = null, lastErrorCode = null, blocked = false;
  const platform = dependencies.platform || process.platform, spawnProcess = dependencies.spawn || spawn;
  function settleDrains() {
    if (!active && !pending.length) while (drains.length) {
      const item = drains.shift();
      if (blocked) item.reject(failure("BACKGROUND_BACKUP_TREE_UNVERIFIED"));
      else if (failedScopes.size) item.reject(failure("BACKGROUND_BACKUP_ARCHIVE_RECOVERY_REQUIRED"));
      else item.resolve();
    }
  }
  function run(job, environment, deadlineMs, registerDeadline) {
    // Preserve the per-child cap when a later drain shortens a distant deadline.
    deadlineMs = Math.min(deadlineMs, Date.now() + TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const archiveRequired = environment.GRABENPLANER_LOCAL_BACKUP_ARCHIVE === "1";
      let child, closed = false, settled = false, exitCode, code = null, termination = null, timeout, monitor, closeDeadline, output = [], outputBytes = 0, errorBytes = 0;
      const finish = (force = false) => {
        if (settled || (!force && !closed) || termination) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(closeDeadline);
        clearInterval(monitor);
        for (const key of ENVIRONMENT_KEYS) delete environment[key];
        if (code || exitCode !== 0) return reject(failure(code || "BACKGROUND_BACKUP_FAILED"));
        try { resolve((dependencies.validateResult || validateResult)(Buffer.concat(output).toString("utf8").trim(), job, { archiveRequired })); }
        catch { reject(failure("BACKGROUND_BACKUP_RESULT_INVALID")); }
      };
      const stop = reason => {
        if (termination || settled) return;
        code = code || reason;
        lastErrorCode = reason;
        termination = Promise.resolve().then(() => (dependencies.terminateTree || terminateOwnedTree)(child, { platform }));
        termination.catch(() => { code = "BACKGROUND_BACKUP_TREE_UNVERIFIED"; blocked = true; lastErrorCode = code; })
          .finally(() => {
            termination = null;
            finish(blocked);
            if (!settled && !closed) closeDeadline = setTimeout(() => {
              code = "BACKGROUND_BACKUP_TREE_UNVERIFIED"; blocked = true; lastErrorCode = code;
              finish(true);
            }, dependencies.closeSettleMs || 5000);
          });
      };
      const armDeadline = () => {
        clearTimeout(timeout);
        const remaining = deadlineMs - Date.now();
        if (remaining <= 0) stop("BACKGROUND_BACKUP_TIMEOUT");
        else timeout = setTimeout(() => stop("BACKGROUND_BACKUP_TIMEOUT"), Math.min(TIMEOUT_MS, remaining));
      };
      registerDeadline(nextDeadline => {
        if (nextDeadline >= deadlineMs) return;
        deadlineMs = nextDeadline;
        if (child && !closed && !settled) armDeadline();
      });
      try {
        if (Date.now() >= deadlineMs) throw failure("BACKGROUND_BACKUP_TIMEOUT");
        validateJob(job);
        // Only constant-time filesystem capacity checks in the HTTP process.
        // The child inventories DB/WAL and the complete document tree before VACUUM.
        if (capacityBytes(job.backupDirectory, dependencies.statfs) <= MINIMUM_FREE_BYTES) throw failure("BACKGROUND_BACKUP_CAPACITY_REQUIRED");
        if (Date.now() >= deadlineMs) throw failure("BACKGROUND_BACKUP_TIMEOUT");
        child = spawnProcess(process.execPath, ["--max-old-space-size=512", CHILD_ENTRY], { env: environment, cwd: path.dirname(CHILD_ENTRY),
          shell: false, windowsHide: true, detached: platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
        child.once("error", () => {
          if (!child.pid) { code = "BACKGROUND_BACKUP_SPAWN_FAILED"; closed = true; finish(); }
          else stop("BACKGROUND_BACKUP_SPAWN_FAILED");
        });
        child.stdout.on("data", chunk => {
          outputBytes += Buffer.byteLength(chunk);
          if (outputBytes > MAX_OUTPUT_BYTES) stop("BACKGROUND_BACKUP_OUTPUT_LIMIT");
          else output.push(Buffer.from(chunk));
        });
        child.stderr.on("data", chunk => { errorBytes += Buffer.byteLength(chunk); if (errorBytes > MAX_OUTPUT_BYTES) stop("BACKGROUND_BACKUP_OUTPUT_LIMIT"); });
        child.once("close", value => {
          closed = true; exitCode = value;
          if (value !== 0 && platform !== "win32" && !termination && !settled) stop(code || "BACKGROUND_BACKUP_FAILED");
          else finish();
        });
        child.stdin.once("error", () => { if (!closed) stop("BACKGROUND_BACKUP_INPUT_FAILED"); });
        armDeadline();
        monitor = setInterval(() => {
          if (closed || settled) return;
          try { if (capacityBytes(job.backupDirectory, dependencies.statfs) < MINIMUM_FREE_BYTES) stop("BACKGROUND_BACKUP_CAPACITY_REQUIRED"); }
          catch { stop("BACKGROUND_BACKUP_CAPACITY_UNKNOWN"); }
        }, dependencies.monitorMs || 500);
        child.stdin.end(JSON.stringify(job));
      } catch (error) {
        if (child?.pid && !closed) stop("BACKGROUND_BACKUP_SPAWN_FAILED");
        else { code = error.code === "BACKGROUND_BACKUP_TIMEOUT" || /^BACKGROUND_BACKUP_CAPACITY_/.test(error.code)
          ? error.code : "BACKGROUND_BACKUP_SPAWN_FAILED"; closed = true; finish(); }
      }
    });
  }
  function pump() {
    if (active) return;
    if (blocked) {
      while (pending.length) {
        const item = pending.shift(); for (const key of ENVIRONMENT_KEYS) delete item.environment[key];
        item.reject(failure("BACKGROUND_BACKUP_TREE_UNVERIFIED"));
      }
      settleDrains(); return;
    }
    const item = pending.shift();
    if (!item) { settleDrains(); return; }
    if (failedScopes.has(item.job.backupDirectory)) {
      for (const key of ENVIRONMENT_KEYS) delete item.environment[key];
      item.reject(failure("BACKGROUND_BACKUP_ARCHIVE_RECOVERY_REQUIRED"));
      pump(); return;
    }
    active = item;
    run(item.job, item.environment, item.deadlineMs, shorten => { item.shortenDeadline = shorten; }).then(result => {
      lastSuccessAt = new Date().toISOString(); lastErrorCode = null; item.resolve(result);
    }, error => {
      lastErrorCode = error.code || "BACKGROUND_BACKUP_FAILED";
      if (item.archiveRequired) failedScopes.set(item.job.backupDirectory, { stream: item.job.expectedStream, code: lastErrorCode });
      item.reject(failure(lastErrorCode));
    })
      .finally(() => { active = null; pump(); });
  }
  return {
    createBackgroundBackup(options) {
      try {
        if (blocked) throw failure("BACKGROUND_BACKUP_TREE_UNVERIFIED");
        if (pending.length + Number(Boolean(active)) >= MAX_PENDING_JOBS) throw failure("BACKGROUND_BACKUP_QUEUE_FULL");
        const deadlineMs = options.deadlineMs === undefined ? Date.now() + (dependencies.timeoutMs || TIMEOUT_MS) : options.deadlineMs;
        if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw failure("BACKGROUND_BACKUP_DEADLINE_INVALID");
        if (Date.now() >= deadlineMs) throw failure("BACKGROUND_BACKUP_TIMEOUT");
        const job = validateJob(options), environment = childEnvironment(job, options.environment || process.env);
        if (failedScopes.has(job.backupDirectory)) {
          for (const key of ENVIRONMENT_KEYS) delete environment[key];
          throw failure("BACKGROUND_BACKUP_ARCHIVE_RECOVERY_REQUIRED");
        }
        const archiveRequired = environment.GRABENPLANER_LOCAL_BACKUP_ARCHIVE === "1";
        return new Promise((resolve, reject) => { pending.push({ job, environment, archiveRequired, deadlineMs, resolve, reject }); pump(); });
      } catch (error) { return Promise.reject(failure(/^BACKGROUND_BACKUP_/.test(error.code) ? error.code : "BACKGROUND_BACKUP_ARGUMENTS_INVALID")); }
    },
    drainBackgroundBackups({ deadlineMs } = {}) {
      if (deadlineMs !== undefined) {
        if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) return Promise.reject(failure("BACKGROUND_BACKUP_DEADLINE_INVALID"));
        for (const item of pending) item.deadlineMs = Math.min(item.deadlineMs, deadlineMs);
        if (active && deadlineMs < active.deadlineMs) {
          active.deadlineMs = deadlineMs;
          active.shortenDeadline?.(deadlineMs);
        }
      }
      if (!active && !pending.length) {
        if (blocked) return Promise.reject(failure("BACKGROUND_BACKUP_TREE_UNVERIFIED"));
        if (failedScopes.size) return Promise.reject(failure("BACKGROUND_BACKUP_ARCHIVE_RECOVERY_REQUIRED"));
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => drains.push({ resolve, reject }));
    },
    backgroundBackupStatus() { return { running: Boolean(active) || blocked, queued: pending.length, lastSuccessAt, lastErrorCode,
      ...(failedScopes.size ? { recoveryRequired: true, failedScopes: [...failedScopes.values()].map(({ stream, code }) => ({ stream, code })) } : {}) }; },
  };
}
const scheduler = createScheduler();
module.exports = { ...scheduler, validateJob, childEnvironment, validateResult, assertRawBackupCapacity,
  __test: { createScheduler, terminateOwnedTree, TIMEOUT_MS, MAX_OUTPUT_BYTES, MAX_PENDING_JOBS, MINIMUM_FREE_BYTES, CHILD_ENTRY } };
