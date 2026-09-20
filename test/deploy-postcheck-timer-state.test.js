"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const source = fs.readFileSync(path.join(__dirname, "../server-tools/linux/test-grabenplaner-server.sh"), "utf8").replace(/\r\n/g, "\n");
function section(begin, end) {
  const from = source.indexOf(begin), to = source.indexOf(end, from);
  assert.ok(from > 0 && to > from, "actual postcheck section exists");
  return source.slice(from, to);
}
const checks = section("maintenance_deploy_pause=0", "monitor_status_gid=");
const offsite = section("  offsite_timer_ok=1", "  # A recovery fix");
const common = fs.readFileSync(path.join(__dirname, "../server-tools/linux/lib/common.sh"), "utf8").replace(/\r\n/g, "\n");
const timerHelpers = common.slice(common.indexOf("gp_maintenance_timer_expected()"), common.indexOf("gp_configure_nightly_backups()"));
assert.ok(timerHelpers.includes("gp_maintenance_timer_matches()"), "actual saved-schedule timer helpers exist");
const cases = [
  { name: "controlled deploy accepts enabled paused monitor and offsite timers", deploy: 1, lease: "held", active: "inactive", expected: true },
  { name: "monitor rejects unexpectedly paused timers", deploy: 0, lease: "held", active: "inactive", expected: false },
  { name: "nightly rejects unexpectedly paused timers", deploy: 0, lease: "none", active: "inactive", expected: false },
  { name: "deploy flag alone cannot excuse paused timers", deploy: 1, lease: "none", active: "inactive", expected: false },
  { name: "another descriptor target cannot excuse paused timers", deploy: 1, lease: "wrong-path", active: "inactive", expected: false },
  { name: "unavailable maintenance lease cannot excuse paused timers", deploy: 1, lease: "busy", active: "inactive", expected: false },
  { name: "disabled paused timers still fail during controlled deploy", deploy: 1, lease: "held", enabled: "disabled", active: "inactive", expected: false },
  { name: "disabled active timers still fail during controlled deploy", deploy: 1, lease: "held", enabled: "disabled", active: "active", expected: false },
  { name: "failed timers cannot masquerade as a controlled pause", deploy: 1, lease: "held", active: "failed", expected: false },
  { name: "ordinary checks accept healthy enabled active timers", deploy: 0, lease: "none", active: "active", expected: true },
  { name: "saved disabled timers remain valid outside deployment", deploy: 0, lease: "none", enabled: "disabled", active: "inactive", savedState: "disabled", expected: true },
  { name: "saved disabled timers reject unexpected activation", deploy: 1, lease: "held", active: "active", savedState: "disabled", expected: false },
  { name: "invalid saved schedule fails closed during deployment", deploy: 1, lease: "held", active: "inactive", savedState: "invalid", expected: false },
  { name: "controlled pause also covers required legacy upload timer", deploy: 1, lease: "held", active: "inactive", schedule: "legacy", expected: true },
  { name: "single schedule still rejects an enabled upload timer", deploy: 1, lease: "held", active: "inactive", uploadEnabled: true, expected: false, monitorExpected: true },
];
for (const scenario of cases) {
  test("post-deploy timer state: " + scenario.name, { skip: !fs.existsSync(bash) }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-postcheck-timers-"));
    t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
    // Execute the actual shell decisions. Only systemd state and inherited
    // descriptor observations are modeled; no real system unit is touched.
    const script = `set -Eeuo pipefail
IFS=$'\\n\\t'
failures=0
deploy_checks=${scenario.deploy}
service=grabenplaner.service
caddy_service=caddy.service
monitor_timer=grabenplaner-monitor.timer
app_dir=/fixture/app
node=/fixture/node
maintenance_schedule_state='${scenario.savedState === "disabled" ? ["grabenplaner-monitor.timer", "grabenplaner-offsite-assurance.timer", "grabenplaner-offsite-check.timer", "grabenplaner-offsite-restore-test.timer"].map(unit => unit + "=0").join("\n") : scenario.savedState || "none"}'
${timerHelpers}
readlink() {
  [[ "$1" == -f && "$2" == -- && "$3" =~ ^/proc/[0-9]+/fd/9$ ]] || return 92
  printf '%s\\n' '${scenario.lease === "none" ? "" : scenario.lease === "wrong-path" ? "/other/maintenance.lock" : "/run/grabenplaner/maintenance.lock"}'
}
flock() {
  [[ "$1" == --nonblock && "$2" == 9 ]] || return 93
  printf 'lease-check\\n' >> events
  ${scenario.lease === "held" ? "return 0" : "return 1"}
}
systemctl() {
  local command="$1" unit="\${@: -1}" value quiet=0
  [[ "\${2:-}" == --quiet ]] && quiet=1
  case "$command" in
    is-enabled) value=${scenario.enabled || "enabled"};;
    is-active) value=${scenario.active};;
    *) return 94;;
  esac
  if [[ "$unit" == grabenplaner.service || "$unit" == caddy.service ]]; then value=active; fi
  if [[ "$unit" == grabenplaner-offsite-upload.timer && '${scenario.schedule || "single"}' == single ]]; then
    if [[ "$command" == is-enabled ]]; then value=${scenario.uploadEnabled ? "enabled" : "disabled"}; else value=inactive; fi
  fi
  if (( quiet == 0 )); then printf '%s\\n' "$value"; fi
  [[ "$value" == active || "$value" == enabled ]]
}
gp_systemd_unit_exists() { return 0; }
gp_nightly_schedule_mode() { printf '${scenario.schedule || "single"}\\n'; }
check_ok() { :; }
check_fail() { failures=$((failures + 1)); }
${checks}
${offsite}
printf '%s %s %s\\n' "$failures" "$offsite_timer_ok" "$maintenance_deploy_pause"
`;
    fs.writeFileSync(path.join(root, "run.sh"), script);
    const result = spawnSync(bash, ["--noprofile", "--norc", "run.sh"], { cwd: root, encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const [failures, offsiteReady, pause] = result.stdout.trim().split(" ").map(Number);
    assert.equal(failures, (scenario.monitorExpected ?? scenario.expected) ? 0 : 1);
    assert.equal(offsiteReady, Number(scenario.expected));
    assert.equal(pause, Number(scenario.deploy === 1 && scenario.lease === "held"));
    const events = fs.existsSync(path.join(root, "events")) ? fs.readFileSync(path.join(root, "events"), "utf8") : "";
    assert.equal(events, scenario.deploy === 1 && ["held", "busy"].includes(scenario.lease) ? "lease-check\n" : "");
  });
}
