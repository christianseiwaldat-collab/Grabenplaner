"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { spawn, spawnSync } = require("node:child_process");
const file = path.resolve(__dirname, "../server-tools/linux/offsite/lib/deploy-deferral.js");
const D = require(file), source = fs.readFileSync(file, "utf8");
const due = Date.parse("2026-10-15T03:00:00.000Z");
const stamp = n => new Date(n).toISOString();
function fixture(extra = {}) {
  return { format: D.FORMAT, schemaVersion: 1, generation: "01234567-89ab-4cde-8abc-0123456789ab", unit: D.SERVICE,
    dueAt: stamp(due), deadlineAt: stamp(due + 10800000), maxDelaySeconds: 10800,
    startedAt: stamp(due - 60000), updatedAt: stamp(due), finishedAt: null, phase: "deploying",
    owner: { pid: 1234, startTicks: "111", bootId: "11234567-89ab-4cde-8abc-0123456789ab" }, packageSha256: "a".repeat(64),
    scheduler: { evidenceTrusted: true, timerInstalled: true, timerEnabled: true, checkedAt: stamp(due), nextElapse: stamp(due) }, ...extra };
}
test("bounded deferral covers only an active actual deployment inside its immutable slot", () => {
  const value = fixture();
  assert.equal(D.classify(value, { now: due - 1, ownerAlive: true }).state, "scheduled");
  assert.equal(D.classify(value, { now: due, ownerAlive: true }).withinGrace, true);
  assert.equal(D.classify(value, { now: due + 10800000 - 1, ownerAlive: true }).state, "deferred");
  assert.equal(D.classify(value, { now: due + 10800000, ownerAlive: true }).state, "expired");
  assert.equal(D.classify(value, { now: due, ownerAlive: false }).state, "abandoned");
  assert.throws(() => D.validate({ ...value, deadlineAt: stamp(due + 10801000) }), /INVALID/);
  assert.throws(() => D.validate({ ...value, extra: true }), /INVALID/);
});
test("hardened app authenticates fresh root heartbeat by existing host boot credential", () => {
  const value = fixture();
  const bootGeneration = crypto.createHash("sha256").update(`grabenplaner-host-boot:boot-id:${value.owner.bootId}`).digest("hex").slice(0, 32);
  const options = { now: due, rootReader: false, bootGeneration };
  assert.equal(D.heartbeatOwnerAlive(value, options), true);
  assert.equal(D.heartbeatOwnerAlive(value, { ...options, now: due + 25001 }), false);
  assert.equal(D.heartbeatOwnerAlive(value, { ...options, now: due - 5001 }), false);
  assert.equal(D.heartbeatOwnerAlive(value, { ...options, bootGeneration: null }), false);
  assert.equal(D.heartbeatOwnerAlive(value, { ...options, bootGeneration: "0".repeat(32) }), false);
  assert.equal(D.heartbeatOwnerAlive(value, { ...options, rootReader: true, ownerAlive: false }), false);
  assert.equal(D.heartbeatOwnerAlive(value, { ...options, rootReader: true, ownerAlive: true }), true);
});
test("stale scheduler evidence never substitutes a currently blocked broker", () => {
  assert.equal(D.classify(fixture(), { now: due + 25001, ownerAlive: true }).scheduler, null);
  assert.equal(D.classify(fixture(), { now: due, ownerAlive: false }).scheduler, null);
  assert.equal(D.classify(fixture(), { now: due, ownerAlive: true }).scheduler.evidenceTrusted, true);
  assert.throws(() => D.classify(fixture({ updatedAt: stamp(due + 5001) }), { now: due }), /CLOCK/);
});
test("completed and aborted deployments before the slot never create a later missed-night penalty", () => {
  for (const phase of ["completed", "aborted"]) {
    const value = fixture({ phase, updatedAt: stamp(due - 1), finishedAt: stamp(due - 1) });
    assert.equal(D.classify(value, { now: due + 86400000 }).reasonCode, "NIGHTLY_NOT_DEFERRED");
    assert.equal(D.classify(value, { now: due + 86400000 }).state, phase);
  }
  assert.equal(D.classify(fixture({ phase: "completed", updatedAt: stamp(due), finishedAt: stamp(due) }), { now: due + 1 }).state, "catchup");
  assert.equal(D.classify(fixture({ phase: "aborted", updatedAt: stamp(due), finishedAt: stamp(due) }), { now: due + 1 }).state, "aborted");
});
// Exercise the real private functions with deterministic OS dependencies. The
// production module has no mutable test hooks and no configurable CLI paths.
function harness(now = due, signedStatus = null) {
  const module = { exports: {} }, requireLocal = createRequire(file);
  const context = { module, exports: module.exports, require: name => name === "/opt/grabenplaner/app/lib/recovery-assurance-status.js" && signedStatus
    ? { readRecoveryAssuranceStatus: () => signedStatus } : requireLocal(name), process,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }, setTimeout, console };
  vm.runInNewContext(source + `\nmodule.exports.internal={waitSeconds,begin,heartbeatStep,scheduler,previousSatisfied};
module.exports.inject=(name,value)=>{if(name==='read')readDocument=value;else if(name==='write')atomicWrite=value;else if(name==='alive')ownerMatches=value;else if(name==='satisfied')previousSatisfied=value;else if(name==='parent')parentOwner=value;else if(name==='due')nightlyDueAt=value;else if(name==='scheduler')scheduler=value;else if(name==='command')command=value;};`, context, { filename: file });
  return module.exports;
}
test("waiting retains the deadline across retries; normal and fulfilled slots keep normal maintenance policy", () => {
  const h = harness(due + 50000), value = fixture();
  h.inject("read", () => value); h.inject("satisfied", () => false);
  assert.equal(h.internal.waitSeconds(due + 50000), 10750);
  assert.equal(h.internal.waitSeconds(due + 10800001), 0);
  assert.equal(h.internal.waitSeconds(due - 1), "normal");
  h.inject("satisfied", () => true); assert.equal(h.internal.waitSeconds(due + 86400000), "normal");
  h.inject("read", () => { throw Object.assign(new Error(), { code: "ENOENT" }); });
  assert.equal(h.internal.waitSeconds(due), "normal");
});
test("an older verified successful trend fulfils its slot even after newer independent failures", () => {
  const status = { integrityVerified: true, recentRuns: [{ status: "failed", completedAt: stamp(due + 86400000) }], trendRuns: [{ status: "passed", at: stamp(due + 60000) }] };
  const h = harness(due + 172800000, status);
  assert.equal(h.internal.previousSatisfied(fixture()), true);
  status.integrityVerified = false; assert.equal(h.internal.previousSatisfied(fixture()), false);
});
test("an active updater keeps the fixed deadline without loading the app tree being swapped", () => {
  const h = harness(due + 60000);
  h.inject("read", () => fixture()); h.inject("alive", () => true);
  h.inject("satisfied", () => { throw new Error("app tree is temporarily unavailable"); });
  assert.equal(h.internal.waitSeconds(due + 60000), 10740);
});
test("a retry inherits its exact deadline and cannot renew an expired unresolved slot", () => {
  for (const offset of [60000, 10800001]) {
    const h = harness(due + offset), previous = fixture({ phase: "aborted", finishedAt: stamp(due), updatedAt: stamp(due) });
    let written;
    h.inject("read", () => previous); h.inject("parent", () => previous.owner); h.inject("alive", () => false);
    h.inject("due", () => stamp(due + 86400000)); h.inject("satisfied", () => false);
    h.inject("write", v => { written = v; }); h.inject("scheduler", () => previous.scheduler);
    if (offset < 10800000) {
      h.internal.begin(1234, "a".repeat(64)); assert.equal(written.dueAt, previous.dueAt); assert.equal(written.deadlineAt, previous.deadlineAt);
    } else assert.throws(() => h.internal.begin(1234, "a".repeat(64)), /PREVIOUS_UNSETTLED/);
  }
});
test("a never-deferred old deployment does not block a later repair deployment", () => {
  const h = harness(due + 86400000), previous = fixture({ phase: "completed", updatedAt: stamp(due - 1), finishedAt: stamp(due - 1) });
  let written;
  h.inject("read", () => previous); h.inject("parent", () => previous.owner); h.inject("due", () => stamp(due + 172800000));
  h.inject("write", v => { written = v; }); h.inject("scheduler", () => previous.scheduler);
  h.inject("satisfied", () => { throw new Error("unrelated signed history must not be needed"); });
  h.internal.begin(1234, "a".repeat(64)); assert.equal(written.dueAt, stamp(due + 172800000));
});
test("heartbeat cannot resurrect finished or replaced generations or a dead/reused owner", () => {
  for (const scenario of ["alive", "dead", "finished", "replaced", "changed-during-measurement"]) {
    const h = harness(due + 10000), original = fixture(); let current = original, written;
    if (scenario === "finished") current = { ...current, phase: "completed" };
    if (scenario === "replaced") current = { ...current, generation: "different" };
    h.inject("read", () => current); h.inject("write", v => { written = v; });
    h.inject("alive", () => scenario !== "dead");
    h.inject("scheduler", () => { if (scenario === "changed-during-measurement") current = { ...current, phase: "completed" }; return original.scheduler; });
    assert.equal(h.internal.heartbeatStep(1234, original.generation), scenario === "alive");
    assert.equal(Boolean(written), scenario === "alive");
    if (written) { assert.equal(written.deadlineAt, original.deadlineAt); assert.equal(written.updatedAt, stamp(due + 10000)); }
  }
});
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const updaterSource = () => fs.readFileSync(path.resolve(__dirname, "../server-tools/linux/update-grabenplaner-server.sh"), "utf8").replaceAll("\r", "");
const assuranceSource = () => fs.readFileSync(path.resolve(__dirname, "../server-tools/linux/offsite/grabenplaner-offsite-assurance.sh"), "utf8").replaceAll("\r", "");
function shell(t, script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-defer-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "run.sh"), "set -Eeuo pipefail\n" + script);
  return spawnSync(bash, ["--noprofile", "--norc", "run.sh"], { cwd: root, encoding: "utf8", timeout: 10000 });
}
for (const [trigger, wait, expected] of [["scheduled-nightly", "108", 108], ["scheduled-nightly", "normal", 14400], ["app-updated", "0", 14400], ["scheduled-nightly", "0", null]]) {
  test(`maintenance wait ${trigger}/${wait} keeps assurance lock unheld while waiting`, { skip: !fs.existsSync(bash) }, t => {
    const assurance = assuranceSource();
    const part = assurance.slice(assurance.indexOf('exec 6<>"$maintenance_lock"'), assurance.indexOf("offsite_acquire_assurance_lock\noffsite_assert_runtime_binaries"));
    const r = shell(t, `trigger=${trigger}\nmaintenance_lock="$PWD/test.lock"\nSCRIPT_DIR=/synthetic\nOFFSITE_NODE=node\nnode(){ printf '${wait}'; }\noffsite_die(){ echo "$*" >&2; exit 42; }\nflock(){ if [[ "$1" == --nonblock ]]; then return 1; fi; printf '%s\\n' "$*"; }\n${part}\necho assurance-lock-next\n`);
    assert.equal(r.status, expected === null ? 42 : 0, r.stderr);
    if (expected !== null) assert.equal(r.stdout.trim(), `--wait ${expected} 6\nassurance-lock-next`);
    else assert.match(r.stderr, /DEADLINE_EXCEEDED/);
  });
}
for (const scenario of ["success", "abort"]) {
  test(`updater ${scenario} joins its writer before closing and catches up only its due service`, { skip: !fs.existsSync(bash) }, t => {
    const updater = updaterSource();
    const part = updater.slice(updater.indexOf("finish_deploy_deferral() {"), updater.indexOf("pause_deploy_timers() {"));
    const r = shell(t, `deploy_deferral_generation=synthetic\ndeploy_deferral_helper=/synthetic\ndeploy_deferral_helper_sha256=a\nupdate_committed=${scenario === "success" ? 1 : 0}\nsleep 60 &\ndeploy_deferral_pid=$!\nwriter=$deploy_deferral_pid\ngp_sha256(){ printf a; }\nroot_node(){ ! kill -0 "$writer" 2>/dev/null || exit 77; echo "$*" >&2; printf due; }\nsystemctl(){ printf '%s\\n' "$*" >&2; }\n${part}\nfinish_deploy_deferral\n`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(scenario === "success" ? "completed" : "aborted"));
    assert.match(r.stderr, /start --no-block grabenplaner-offsite-assurance@scheduled-nightly.service/);
  });
}
test("only the own due scheduled unit may wait; its previously active timer remains active", { skip: !fs.existsSync(bash) }, t => {
  const updater = updaterSource();
  const part = updater.slice(updater.indexOf("pause_deploy_timers() {"), updater.indexOf("stop_clamav_scan() {"));
  for (const dueState of ["due", "not-due"]) {
    const r = shell(t, `deploy_deferral_generation=''\ndeploy_deferral_helper=/synthetic\ndeclare -a deploy_blocking_timer_units=()\ndeclare -a deploy_timer_units=(grabenplaner-offsite-assurance.timer apt-daily.timer)\ndeclare -a deploy_maintenance_units=(grabenplaner-offsite-assurance@scheduled-nightly.service)\ndeclare -A deploy_timer_was_active=() deploy_timer_was_enabled=()\ngp_systemd_unit_exists(){ return 0; }\ngp_info(){ :; }\ngp_die(){ echo "$*" >&2; exit 42; }\nbegin_deploy_deferral(){ deploy_deferral_generation=own; }\nroot_node(){ printf '${dueState}'; }\nsystemctl(){\n if [[ "$1" == stop ]]; then echo "stopped $2" >&2; touch stopped; return 0; fi\n if [[ "$1" == is-active && "$3" == apt-daily.timer && -f stopped ]]; then return 3; fi\n if [[ "$1" == show && "$2" == --property=ActiveState ]]; then printf activating; fi\n return 0\n}\n${part}\npause_deploy_timers\n`);
    assert.equal(r.status, dueState === "due" ? 0 : 42, r.stderr);
    assert.match(r.stderr, /stopped apt-daily.timer/);
    assert.doesNotMatch(r.stderr, /stopped grabenplaner-offsite-assurance.timer/);
  }
});
test("a fired timer with no next date needs fresh active/enabled/unit and trigger evidence", () => {
  const localRequire = createRequire(file), module = { exports: {} };
  const absent = { evidenceTrusted: false, timerInstalled: false, timerEnabled: false, nextElapse: null, checkedAt: null };
  const context = { module, exports: module.exports, process, setTimeout, Date: class extends Date { constructor(...v) { super(...(v.length ? v : [due+1000])); } static now() { return due+1000; } },
    require: name => name === "./assurance-control-broker" ? { schedulerEvidence: () => absent } : localRequire(name) };
  vm.runInNewContext(source + "\nmodule.exports.measure=scheduler; module.exports.command=fn=>{command=fn;};", context);
  let broken = "";
  module.exports.command((program, args) => {
    if (program === "date") return String(due);
    const p = args.find(x => x.startsWith("--property="))?.slice(11);
    if (p === broken) return "wrong";
    if (args[1] === D.SERVICE) return "activating";
    return { LoadState:"loaded", FragmentPath:"/etc/systemd/system/grabenplaner-offsite-assurance.timer", ActiveState:"active", UnitFileState:"enabled", Unit:D.SERVICE, LastTriggerUSec:stamp(due) }[p];
  });
  assert.equal(module.exports.measure(fixture()).evidenceTrusted, true);
  for (broken of ["LoadState", "FragmentPath", "ActiveState", "UnitFileState", "Unit"]) assert.equal(module.exports.measure(fixture()).evidenceTrusted, false, broken);
});
test("native root heartbeat survives Node FD reuse; hardened unprivileged app reads only a fresh boot-bound receipt", {
  skip: process.platform !== "linux" || process.getuid() !== 0,
  timeout: 35000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-defer-native-"));
  fs.chmodSync(root, 0o755);
  const stateRoot = path.join(root, "state"), credentialRoot = path.join(root, "credentials"), copied = path.join(root, "app/server-tools/linux/offsite/lib/deploy-deferral.js");
  for (const dir of [stateRoot, credentialRoot]) { fs.mkdirSync(dir); fs.chownSync(dir, 0, 65534); fs.chmodSync(dir, 0o750); }
  fs.mkdirSync(path.dirname(copied), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(root, "app/lib"), { recursive: true, mode: 0o755 });
  fs.copyFileSync(path.resolve(__dirname, "../lib/host-reboot-control-client.js"), path.join(root, "app/lib/host-reboot-control-client.js"));
  for (const relative of ["app", "app/lib", "app/server-tools", "app/server-tools/linux", "app/server-tools/linux/offsite", "app/server-tools/linux/offsite/lib"]) fs.chmodSync(path.join(root, relative), 0o755);
  fs.chmodSync(path.join(root, "app/lib/host-reboot-control-client.js"), 0o644);
  const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
  const credential = path.join(credentialRoot, "host-boot-id");
  fs.writeFileSync(credential, boot); fs.chownSync(credential, 0, 65534); fs.chmodSync(credential, 0o440);
  const stateFile = path.join(stateRoot, "deploy-deferral.json"), lock = path.join(root, "maintenance.lock"), dueAt = stamp(Date.now() - 1000);
  // This is the actual CLI in an exclusively owned synthetic directory. Only
  // OS schedule measurement and fixed paths are substituted; no systemd call.
  const isolated = source.replace('const STATE_PATH = "/var/lib/grabenplaner-assurance/deploy-deferral.json";', `const STATE_PATH = ${JSON.stringify(stateFile)};`)
    .replace('const MAINTENANCE_LOCK = "/run/grabenplaner/maintenance.lock";', `const MAINTENANCE_LOCK = ${JSON.stringify(lock)};`)
    .replace("if (require.main === module) (async () => {", `nightlyDueAt=()=>${JSON.stringify(dueAt)}; scheduler=()=>({evidenceTrusted:true,timerInstalled:true,timerEnabled:true,nextElapse:${JSON.stringify(dueAt)},checkedAt:new Date().toISOString()});\nif (require.main === module) (async () => {`);
  fs.writeFileSync(copied, isolated, { mode: 0o644 });
  fs.chmodSync(copied, 0o644);
  const q = s => "'" + s.replaceAll("'", "'\\''") + "'";
  const script = `set -Eeuo pipefail\nnode=${q(process.execPath)}\nhelper=${q(copied)}\nexec 9<>${q(lock)}\nflock --nonblock 9\ngeneration="$($node "$helper" begin "$$" ${"a".repeat(64)})"\n$node "$helper" heartbeat "$$" "$generation" 5>&- 6>&- 7>&- 8>&- 9>&- &\nwriter=$!\ncleanup(){ kill -TERM "$writer" 2>/dev/null || true; wait "$writer" 2>/dev/null || true; }\ntrap cleanup EXIT\ntrap 'exit 143' TERM\nwhile [[ ! -f ${q(path.join(root, "finish"))} ]]; do kill -0 "$writer"; sleep 0.1; done\ncleanup\ntrap - EXIT\n$node "$helper" finish "$$" "$generation" completed\n`;
  fs.writeFileSync(path.join(root, "run.sh"), script);
  let log = "", status;
  const child = spawn("/bin/bash", ["--noprofile", "--norc", path.join(root, "run.sh")], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", b => { log += b; }); child.stderr.on("data", b => { log += b; });
  const closed = new Promise(resolve => child.on("close", code => { status = code; resolve(code); }));
  t.after(async () => {
    fs.writeFileSync(path.join(root, "finish"), "finish\n");
    if (status === undefined) await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (status === undefined) { child.kill("SIGTERM"); await closed; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  let value;
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    assert.equal(status, undefined, log);
    if (fs.existsSync(stateFile)) {
      value = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (Date.parse(value.updatedAt) - Date.parse(value.startedAt) >= 9000) break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(value && Date.parse(value.updatedAt) - Date.parse(value.startedAt) >= 9000, log);
  const appScript = `const fs=require('node:fs'),read=fs.readFileSync;fs.readFileSync=function(p,...a){if(String(p).startsWith('/proc/'))throw Object.assign(new Error('sandbox'),{code:'EACCES'});return read.call(this,p,...a);};process.stdout.write(JSON.stringify(require(${JSON.stringify(copied)}).readDeployDeferral()));`;
  const app = spawnSync(process.execPath, ["-e", appScript], { uid: 65534, gid: 65534, env: { PATH: "/usr/bin:/bin", CREDENTIALS_DIRECTORY: credentialRoot }, encoding: "utf8", timeout: 5000 });
  assert.equal(app.status, 0, app.stderr);
  const result = JSON.parse(app.stdout);
  assert.equal(result.state, "deferred"); assert.equal(result.withinGrace, true); assert.equal(result.scheduler.evidenceTrusted, true);
  fs.writeFileSync(path.join(root, "finish"), "finish\n");
  assert.equal(await closed, 0, log);
  const finished = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(finished.phase, "completed"); assert.equal(finished.deadlineAt, value.deadlineAt);
});
