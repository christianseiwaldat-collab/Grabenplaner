"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const source = fs.readFileSync(path.join(__dirname, "../server-tools/linux/activate-grabenplaner-passkeys.sh"), "utf8").replaceAll("\r\n", "\n");
const start = source.indexOf("declare -a timers=(");
assert(start > source.indexOf("gp_acquire_maintenance_lock"));
const workflow = source.slice(start).replaceAll("/var/lib/grabenplaner-passkeys-activation", "$TEST_ACTIVATION_ROOT");
const hash = "a".repeat(64), config = "b".repeat(64), backup = "c".repeat(64), pair = "d".repeat(64);

// This exercises actual shell ordering/traps with synthetic operating adapters.
// Actual systemd/SQL/updater availability remains a separate Linux qualification.
for (const scenario of ["success", "stop-failure", "backup-failure", "activation-failure", "committed-failure", "source-changed", "post-state-changed", "active-maintenance", "start-failure", "recovery-start-failure", "health-failure", "timer-failure"]) {
  test(`explicit schema activation service and timer orchestration: ${scenario}`, { skip: !fs.existsSync(bash) }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-activation-shell-"));
    t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
    const tools = path.join(root, "tools"); fs.mkdirSync(path.join(tools, "lib"), { recursive: true });
    fs.writeFileSync(path.join(tools, "lib/passkeys-schema-activate.js"), `
const fs=require('node:fs'),[action,manifest,...pins]=process.argv.slice(2),e=process.env.EVENTS;
fs.appendFileSync(e,action+'\\n');
if(action==='activate'){
 require('node:assert/strict').deepEqual(pins,['${config}','${backup}','${pair}','--maintenance-lock-held']);
 if(['activation-failure','committed-failure','source-changed','recovery-start-failure'].includes('${scenario}')){fs.writeFileSync(process.env.FAILED,'1');process.exit(42);}
 fs.writeFileSync(process.env.FAILED,'activated');
 console.log(JSON.stringify({verified:true,passkeysVerified:true,salesUnchanged:true,sameInstalledApplication:true,
 afterPairIdentitySha256:'${pair}',coreAfter:'newcore',manifestSha256:manifest,configurationSha256:'${config}',backupManifestSha256:'${backup}'}));
}else{
 if('${scenario}'==='source-changed'&&fs.existsSync(process.env.FAILED))process.exit(42);
 console.log(JSON.stringify({manifestSha256:manifest,configurationSha256:'${config}',backupManifestSha256:'${backup}',
 coreSchemaSha256:fs.existsSync(process.env.FAILED)?'newcore':'oldcore',salesSchemaSha256:'sales',
 beforePairIdentitySha256:'${pair}',passkeysSchemaPolicy:'compatible',passkeysState:fs.existsSync(process.env.FAILED)&&'${scenario}'!=='post-state-changed'?'present':'absent'}));
}
`);
    fs.writeFileSync(path.join(tools, "backup-grabenplaner.sh"), `#!/usr/bin/env bash
printf 'backup\\n' >> "$EVENTS"
[[ "$*" == *--preserve-existing-backups* && "$*" == *'--keep 1000'* ]] || exit 43
${scenario === "backup-failure" ? "exit 42" : "printf '{}\\n'"}
`, { mode: 0o755 });
    const node = process.execPath.replaceAll("\\", "/").replaceAll("'", "'\\''");
    fs.writeFileSync(path.join(root, "run.sh"), `#!/usr/bin/env bash
set -Eeuo pipefail
export EVENTS="$PWD/events" FAILED="$PWD/failed" TEST_ACTIVATION_ROOT="$PWD/evidence"
: > "$EVENTS"
tools="$PWD/tools"
expected_manifest=${hash}
GP_DEFAULT_SERVICE=grabenplaner.service
internal_live_url=http://internal/live
internal_ready_url=http://internal/ready
public_live_url=https://fixture.invalid/live
public_ready_url=https://fixture.invalid/ready
node='${node}'
root_node(){ "$node" "$@"; }
gp_die(){ printf 'error\\n' >> "$EVENTS"; exit 1; }
gp_info(){ :; }
install(){ mkdir -p -- "\${@: -1}"; }
stat(){ printf '0:0:700\\n'; }
gp_systemd_unit_exists(){ [[ "$1" != grabenplaner-host-security-rollback.timer ]]; }
gp_stop_service(){ printf 'stop-app\\n' >> "$EVENTS"; ${scenario === "stop-failure" ? "return 1" : "return 0"}; }
gp_start_service(){ printf 'start-app\\n' >> "$EVENTS"; ${["start-failure","recovery-start-failure"].includes(scenario)?"exit 41":"return 0"}; }
gp_wait_ready(){ printf 'ready:%s\\n' "$1" >> "$EVENTS"; ${scenario === "health-failure" ? "return 1" : "return 0"}; }
gp_url_reports_ready(){ printf 'live:%s\\n' "$1" >> "$EVENTS"; }
systemctl(){
 if [[ "$1" == is-active ]]; then [[ "$3" == grabenplaner-monitor.timer && ! -f "$PWD/timer-stopped" ]]; return; fi
 if [[ "$1" == show ]]; then printf '${scenario === "active-maintenance" ? "active" : "inactive"}\\n'; return; fi
 if [[ "$1" == stop ]]; then printf 'pause:%s\\n' "$2" >> "$EVENTS"; touch "$PWD/timer-stopped"; return; fi
 if [[ "$1" == start ]]; then printf 'resume:%s\\n' "$2" >> "$EVENTS"; ${scenario === "timer-failure" ? "return 1" : "return 0"}; fi
}
${workflow}
`);
    const result = spawnSync(bash, ["--noprofile", "--norc", "run.sh"], { cwd: root, encoding: "utf8", timeout: 20000 });
    assert.ifError(result.error);
    const events = fs.readFileSync(path.join(root, "events"), "utf8").trim().split("\n");
    assert.equal(result.status === 0, scenario === "success", result.stderr);
    assert.equal(events.filter(e => e.startsWith("resume:")).length, 1, "only the previously active monitor timer resumes");
    assert(events.includes("resume:grabenplaner-monitor.timer"));
    if (scenario === "active-maintenance") { assert(!events.includes("stop-app")); assert(!events.includes("backup")); return; }
    assert(events.indexOf("pause:grabenplaner-monitor.timer") < events.indexOf("stop-app"));
    if (scenario === "stop-failure") { assert(!events.includes("backup")); assert(events.includes("start-app")); return; }
    assert(events.indexOf("stop-app") < events.indexOf("backup"));
    if (scenario === "backup-failure") assert(!events.includes("activate"));
    if (["source-changed","post-state-changed"].includes(scenario)) assert(!events.includes("start-app"), "unverified source or activation target must stay stopped");
    else assert(events.includes("start-app"), "the unchanged compatible application returns after a verified failed activation");
    if (scenario === "health-failure") assert.equal(events.filter(e=>e==='start-app').length,1,"failed health does not create a restart loop");
    if (scenario === "success") {
      assert(events.indexOf("backup") < events.indexOf("activate"));
      assert(events.indexOf("activate") < events.indexOf("start-app"));
      for (const health of ["ready:http://internal/ready", "ready:https://fixture.invalid/ready", "live:http://internal/live", "live:https://fixture.invalid/live"]) assert(events.includes(health));
    }
    const run = fs.readdirSync(path.join(root, "evidence")).find(name => name.startsWith("run."));
    const end = JSON.parse(fs.readFileSync(path.join(root, "evidence", run, "end.json"), "utf8"));
    assert.equal(end.exitCode === 0, scenario === "success");
    assert.equal(end.completed,scenario === "success");
    if (["backup-failure", "activation-failure", "committed-failure"].includes(scenario)) {
      assert.equal(end.completed, false); assert.equal(end.recoveredAfterFailure, true);
    }
  });
}
