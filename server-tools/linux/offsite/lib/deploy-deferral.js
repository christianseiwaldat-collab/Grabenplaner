"use strict";

// A bounded explanation for a scheduled assurance waiting for an actual updater.
// This is not a recovery success receipt and cannot renew a recovery proof.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const STATE_PATH = "/var/lib/grabenplaner-assurance/deploy-deferral.json";
const MAINTENANCE_LOCK = "/run/grabenplaner/maintenance.lock";
const TIMER = "grabenplaner-offsite-assurance.timer";
const SERVICE = "grabenplaner-offsite-assurance@scheduled-nightly.service";
const FORMAT = "grabenplaner-deploy-nightly-deferral";
const MAX_DELAY_SECONDS = 10800;
const HEARTBEAT_MS = 10000;
const MAX_HEARTBEAT_AGE_MS = 25000;
const CLOCK_SKEW_MS = 5000;
const ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", TZ: "UTC", LC_ALL: "C" };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const keys = ["format", "schemaVersion", "generation", "unit", "dueAt", "deadlineAt", "maxDelaySeconds", "startedAt", "updatedAt", "finishedAt", "phase", "owner", "packageSha256", "scheduler"];
function validScheduler(value) {
  return exact(value, ["evidenceTrusted", "timerInstalled", "timerEnabled", "nextElapse", "checkedAt"])
    && [value.evidenceTrusted, value.timerInstalled, value.timerEnabled].every(v => typeof v === "boolean")
    && (value.nextElapse === null || time(value.nextElapse)) && (value.checkedAt === null || time(value.checkedAt))
    && (!value.evidenceTrusted || time(value.checkedAt))
    && (!value.timerEnabled || value.timerInstalled && time(value.nextElapse));
}
function fail(code) { throw Object.assign(new Error(code), { code }); }
function exact(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}
function time(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validate(value) {
  if (!exact(value, keys) || value.format !== FORMAT || value.schemaVersion !== 1 || !UUID.test(value.generation)
    || value.unit !== SERVICE || value.maxDelaySeconds !== MAX_DELAY_SECONDS
    || !["deploying", "completed", "aborted"].includes(value.phase) || !HASH.test(value.packageSha256)
    || ![value.dueAt, value.deadlineAt, value.startedAt, value.updatedAt].every(time)
    || Date.parse(value.deadlineAt) !== Date.parse(value.dueAt) + MAX_DELAY_SECONDS * 1000
    || Date.parse(value.updatedAt) < Date.parse(value.startedAt)
    || value.phase === "deploying" && value.finishedAt !== null
    || value.phase !== "deploying" && (!time(value.finishedAt) || value.finishedAt !== value.updatedAt)
    || !validScheduler(value.scheduler) || !exact(value.owner, ["pid", "startTicks", "bootId"])
    || !Number.isSafeInteger(value.owner.pid) || value.owner.pid < 2
    || !/^[1-9]\d{0,19}$/.test(value.owner.startTicks) || !UUID.test(value.owner.bootId)) fail("DEPLOY_DEFERRAL_INVALID");
  return value;
}
function procIdentity(pid, procRoot = "/proc") {
  const base = path.join(procRoot, String(pid));
  const stat = fs.readFileSync(path.join(base, "stat"), "utf8");
  const tail = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  const uid = fs.readFileSync(path.join(base, "status"), "utf8").match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m);
  if (!uid || uid.slice(1).some(x => x !== "0") || ["Z", "X"].includes(tail[0])) return null;
  return { pid, startTicks: tail[19], bootId: fs.readFileSync(path.join(procRoot, "sys/kernel/random/boot_id"), "utf8").trim() };
}
function ownerMatches(owner, procRoot = "/proc") {
  try { const actual = procIdentity(owner.pid, procRoot); return actual && Object.keys(owner).every(k => actual[k] === owner[k]); }
  catch (error) { if (["ENOENT", "ESRCH", "EACCES"].includes(error.code)) return false; throw error; }
}
function readDocument(statePath = STATE_PATH) {
  const root = path.dirname(statePath), directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o7777) !== 0o750
    || fs.realpathSync(root) !== root) fail("DEPLOY_DEFERRAL_PROTECTION");
  const before = fs.lstatSync(statePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== 0 || before.gid !== directory.gid
    || (before.mode & 0o7777) !== 0o640 || before.size < 2 || before.size > 4096 || fs.realpathSync(statePath) !== statePath) fail("DEPLOY_DEFERRAL_PROTECTION");
  const fd = fs.openSync(statePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd, "utf8"), after = fs.lstatSync(statePath);
    if (opened.ino !== before.ino || opened.dev !== before.dev || after.ino !== before.ino || after.dev !== before.dev
      || after.mtimeMs !== before.mtimeMs || after.size !== before.size) fail("DEPLOY_DEFERRAL_CHANGED");
    return validate(JSON.parse(bytes));
  } finally { fs.closeSync(fd); }
}
function classify(value, { now = Date.now(), ownerAlive = false } = {}) {
  validate(value);
  if (!Number.isFinite(now) || Date.parse(value.startedAt) > now + CLOCK_SKEW_MS || Date.parse(value.updatedAt) > now + CLOCK_SKEW_MS) fail("DEPLOY_DEFERRAL_CLOCK");
  const due = Date.parse(value.dueAt), deadline = Date.parse(value.deadlineAt);
  let state, reasonCode;
  if (value.finishedAt && Date.parse(value.finishedAt) < due) { state = value.phase; reasonCode = "NIGHTLY_NOT_DEFERRED"; }
  else if (now < due) { state = value.phase === "deploying" && ownerAlive ? "scheduled" : value.phase; reasonCode = "NIGHTLY_NOT_DUE"; }
  else if (now >= deadline) { state = "expired"; reasonCode = "DEPLOY_DEFERRAL_EXPIRED"; }
  else if (value.phase === "aborted") { state = "aborted"; reasonCode = "DEPLOY_ABORTED"; }
  else if (value.phase === "completed") { state = "catchup"; reasonCode = "NIGHTLY_CATCHUP_REQUIRED"; }
  else if (!ownerAlive) { state = "abandoned"; reasonCode = "DEPLOY_OWNER_GONE"; }
  else { state = "deferred"; reasonCode = "ACTIVE_DEPLOY_WITHIN_LIMIT"; }
  return { state, activeDeploy: value.phase === "deploying" && Boolean(ownerAlive), dueAt: value.dueAt, deadlineAt: value.deadlineAt,
    startedAt: value.startedAt, finishedAt: value.finishedAt, maxDelaySeconds: MAX_DELAY_SECONDS,
    withinGrace: state === "deferred", evidenceTrusted: true, reasonCode,
    scheduler: ownerAlive && fresh(value.scheduler.checkedAt, now) ? { ...value.scheduler } : null };
}
function fresh(stamp, now) { return time(stamp) && now - Date.parse(stamp) <= MAX_HEARTBEAT_AGE_MS && Date.parse(stamp) <= now + CLOCK_SKEW_MS; }
function heartbeatOwnerAlive(value, { now, bootGeneration, ownerAlive, rootReader }) {
  if (!fresh(value.updatedAt, now)) return false;
  if (rootReader) return Boolean(ownerAlive);
  const expected = crypto.createHash("sha256").update(`grabenplaner-host-boot:boot-id:${value.owner.bootId}`).digest("hex").slice(0, 32);
  return typeof bootGeneration === "string" && bootGeneration === expected;
}
function readDeployDeferral(options = {}) {
  try {
    const value = readDocument(options.statePath || STATE_PATH);
    const now = options.now ?? Date.now(), rootReader = typeof process.getuid === "function" && process.getuid() === 0;
    const bootGeneration = rootReader ? null : require("../../../../lib/host-reboot-control-client").readHostBootGeneration();
    const ownerAlive = heartbeatOwnerAlive(value, { now, rootReader, bootGeneration,
      ownerAlive: rootReader && ownerMatches(value.owner, options.procRoot || "/proc") });
    return classify(value, { now, ownerAlive });
  } catch (error) {
    return { state: error.code === "ENOENT" ? "unavailable" : "invalid", activeDeploy: false, dueAt: null, deadlineAt: null,
      withinGrace: false, evidenceTrusted: false, reasonCode: error.code === "ENOENT" ? "NO_DEPLOY_DEFERRAL" : "DEPLOY_DEFERRAL_UNTRUSTED" };
  }
}
function command(program, args) { return cp.execFileSync(program, args, { encoding: "utf8", timeout: 5000, env: ENV }).trim(); }
function atomicWrite(value) {
  validate(value);
  const root = path.dirname(STATE_PATH), directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o7777) !== 0o750
    || fs.realpathSync(root) !== root) fail("DEPLOY_DEFERRAL_PROTECTION");
  try { readDocument(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = path.join(root, `.deploy-deferral.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o640);
    fs.fchownSync(fd, 0, directory.gid); fs.fchmodSync(fd, 0o640);
    fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, STATE_PATH);
    const parent = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; } }
}
function parentOwner(pid) {
  // Bash command substitution adds a short-lived subshell between helper and updater.
  let ancestor = process.ppid;
  for (let depth = 0; depth < 3 && ancestor !== pid; depth++) {
    const status = fs.readFileSync(`/proc/${ancestor}/status`, "utf8");
    if (!procIdentity(ancestor)) fail("DEPLOY_DEFERRAL_PARENT");
    ancestor = Number(status.match(/^PPid:\s+(\d+)$/m)?.[1]);
  }
  if (ancestor !== pid) fail("DEPLOY_DEFERRAL_PARENT");
  const owner = procIdentity(pid);
  if (!owner || fs.realpathSync(`/proc/${pid}/fd/9`) !== MAINTENANCE_LOCK) fail("DEPLOY_DEFERRAL_LOCK_BINDING");
  return owner;
}
function nightlyDueAt() {
  for (const [property, expected] of [["ActiveState", "active"], ["UnitFileState", "enabled"]]) {
    if (command("systemctl", ["show", TIMER, `--property=${property}`, "--value"]) !== expected) fail("DEPLOY_DEFERRAL_TIMER_UNAVAILABLE");
  }
  const next = command("systemctl", ["show", TIMER, "--property=NextElapseUSecRealtime", "--value"]);
  if (!next || next === "n/a") fail("DEPLOY_DEFERRAL_TIMER_DUE_UNKNOWN");
  const epoch = command("date", ["--date", next, "+%s%3N"]);
  if (!/^\d{13}$/.test(epoch)) fail("DEPLOY_DEFERRAL_TIMER_DUE_UNKNOWN");
  return new Date(Number(epoch)).toISOString();
}
function previousSatisfied(previous) {
  const status = require("/opt/grabenplaner/app/lib/recovery-assurance-status.js").readRecoveryAssuranceStatus({ configured: true });
  return status.integrityVerified === true && [...(status.recentRuns || []), ...(status.trendRuns || [])]
    .some(run => run.status === "passed" && time(run.completedAt || run.at) && Date.parse(run.completedAt || run.at) >= Date.parse(previous.dueAt));
}
function scheduler(value) {
  const measured = require("./assurance-control-broker").schedulerEvidence();
  if (measured.evidenceTrusted || !value || Date.now() < Date.parse(value.dueAt)) return measured;
  // A fired timer can have no *next* date while its scheduled service waits.
  // Re-measure every flag and the exact service binding; expose the due slot.
  try {
    const expected = { LoadState: "loaded", FragmentPath: "/etc/systemd/system/grabenplaner-offsite-assurance.timer", ActiveState: "active", UnitFileState: "enabled", Unit: SERVICE };
    for (const [property, wanted] of Object.entries(expected)) {
      if (command("systemctl", ["show", TIMER, `--property=${property}`, "--value"]) !== wanted) return measured;
    }
    if (!["activating", "active"].includes(command("systemctl", ["show", SERVICE, "--property=ActiveState", "--value"]))) return measured;
    const last = command("systemctl", ["show", TIMER, "--property=LastTriggerUSec", "--value"]);
    const epoch = Number(command("date", ["--date", last, "+%s%3N"]));
    if (!Number.isFinite(epoch) || epoch < Date.parse(value.dueAt) - CLOCK_SKEW_MS || epoch > Date.now() + CLOCK_SKEW_MS) return measured;
    return { evidenceTrusted: true, timerInstalled: true, timerEnabled: true, nextElapse: value.dueAt, checkedAt: new Date().toISOString() };
  } catch { return measured; }
}
function begin(pid, packageSha256) {
  const owner = parentOwner(pid), now = Date.now();
  if (!HASH.test(packageSha256 || "")) fail("DEPLOY_DEFERRAL_PACKAGE");
  let dueAt = nightlyDueAt(), previous;
  try { previous = readDocument(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous) {
    if (previous.phase === "deploying" && ownerMatches(previous.owner)) fail("DEPLOY_DEFERRAL_ALREADY_ACTIVE");
    if (Date.parse(previous.dueAt) <= now && !(previous.finishedAt && Date.parse(previous.finishedAt) < Date.parse(previous.dueAt)) && !previousSatisfied(previous)) {
      // Another attempt can inherit the original deadline, never reset it.
      if (now >= Date.parse(previous.deadlineAt)) fail("DEPLOY_DEFERRAL_PREVIOUS_UNSETTLED");
      dueAt = previous.dueAt;
    }
  }
  const stamp = new Date(now).toISOString();
  const value = { format: FORMAT, schemaVersion: 1, generation: crypto.randomUUID(), unit: SERVICE, dueAt,
    deadlineAt: new Date(Date.parse(dueAt) + MAX_DELAY_SECONDS * 1000).toISOString(), maxDelaySeconds: MAX_DELAY_SECONDS,
    startedAt: stamp, updatedAt: stamp, finishedAt: null, phase: "deploying", owner, packageSha256, scheduler: scheduler() };
  atomicWrite(value); return value.generation;
}
function finish(pid, generation, outcome) {
  const owner = parentOwner(pid), value = readDocument();
  if (value.generation !== generation || !Object.keys(owner).every(k => owner[k] === value.owner[k])
    || value.phase !== "deploying" || !["completed", "aborted"].includes(outcome)) fail("DEPLOY_DEFERRAL_FINISH_BINDING");
  const now = new Date().toISOString(); atomicWrite({ ...value, phase: outcome, updatedAt: now, finishedAt: now });
  return Date.now() >= Date.parse(value.dueAt) ? "due" : "not-due";
}
function waitSeconds(now = Date.now()) {
  let value;
  try { value = readDocument(); } catch (error) { if (error.code === "ENOENT") return "normal"; throw error; }
  if (Date.parse(value.dueAt) > now) return "normal";
  if (value.finishedAt && Date.parse(value.finishedAt) < Date.parse(value.dueAt)) return "normal";
  // Do not load application code while its active updater may be swapping it.
  if ((value.phase !== "deploying" || !ownerMatches(value.owner)) && previousSatisfied(value)) return "normal";
  // A late invocation must not get a fresh three hours for the same due slot.
  return Math.max(0, Math.min(MAX_DELAY_SECONDS, Math.ceil((Date.parse(value.deadlineAt) - now) / 1000)));
}
function heartbeatStep(pid, generation) {
  const value = readDocument();
  if (value.generation !== generation || value.phase !== "deploying" || value.owner.pid !== pid || !ownerMatches(value.owner)) return false;
  const measured = scheduler(value);
  // No other legitimate writer runs until this child has been joined. Re-read
  // anyway so a replaced generation or a completed marker is never overwritten.
  const current = readDocument();
  if (current.generation !== generation || current.phase !== "deploying" || !ownerMatches(current.owner)) return false;
  atomicWrite({ ...current, updatedAt: new Date().toISOString(), scheduler: measured });
  return true;
}
async function heartbeat(pid, generation) {
  const owner = parentOwner(pid), initial = readDocument();
  if (initial.generation !== generation || initial.owner.pid !== owner.pid) fail("DEPLOY_DEFERRAL_PARENT");
  for (const fd of fs.readdirSync("/proc/self/fd")) {
    let target; try { target = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if ([MAINTENANCE_LOCK, "/run/grabenplaner-offsite/assurance.lock", "/run/grabenplaner-offsite/repository.lock"].includes(target)
      || /^\/var\/lib\/grabenplaner(?:-postgresql)?\/.+\.backup-workspace\.lock$/.test(target)) fail("DEPLOY_DEFERRAL_INHERITED_FD");
  }
  while (heartbeatStep(pid, generation)) await new Promise(resolve => setTimeout(resolve, HEARTBEAT_MS));
}
function currentDue() {
  const value = readDocument();
  return Date.now() >= Date.parse(value.dueAt) ? "due" : "not-due";
}
if (require.main === module) (async () => {
  try {
    if (process.platform !== "linux" || process.getuid() !== 0) fail("DEPLOY_DEFERRAL_ROOT_REQUIRED");
    const [action, ...args] = process.argv.slice(2);
    let result;
    if (action === "begin" && args.length === 2) result = begin(Number(args[0]), args[1]);
    else if (action === "finish" && args.length === 3) result = finish(Number(args[0]), args[1], args[2]);
    else if (action === "wait-seconds" && !args.length) result = waitSeconds();
    else if (action === "due" && !args.length) result = currentDue();
    else if (action === "heartbeat" && args.length === 2) { await heartbeat(Number(args[0]), args[1]); return; }
    else fail("DEPLOY_DEFERRAL_ACTION");
    process.stdout.write(String(result));
  } catch (error) { process.stderr.write(`${/^DEPLOY_DEFERRAL_[A-Z_]+$/.test(error.code || "") ? error.code : "DEPLOY_DEFERRAL_FAILED"}\n`); process.exitCode = 1; }
})();
module.exports = { readDeployDeferral, classify, validate, ownerMatches, heartbeatOwnerAlive, fresh, FORMAT, STATE_PATH, DEFAULT_STATE_PATH: STATE_PATH, MAX_DELAY_SECONDS, HEARTBEAT_MS, MAX_HEARTBEAT_AGE_MS, TIMER, SERVICE };
