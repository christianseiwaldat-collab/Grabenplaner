"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const updater = read("server-tools/linux/update-grabenplaner-server.sh");
const preflight = read("server-tools/linux/preflight-grabenplaner-deploy.sh");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const functionSource = (name) => {
  // Stop at the next shell function, not a closing brace inside a Node heredoc.
  const source = updater.match(new RegExp(`^${name}\\(\\) \\{\\r?\\n[\\s\\S]*?(?=^[a-z_]+\\(\\) \\{)`, "m"));
  assert.ok(source, `${name} is available`);
  assert.match(source[0].trim(), /\}$/);
  return source[0];
};

test("deploy has a separate pre-build preflight entry point", () => {
  assert.match(updater, /--preflight-only/);
  assert.match(updater, /exec bash "\$preflight_script"/);
  assert.match(preflight, /gp_acquire_maintenance_lock/);
  assert.match(preflight, /recovery-files-preflight/);
  assert.match(preflight, /verify-package\.js/);
  assert.match(preflight, /verify-install-tree\.js/);
  assert.match(preflight, /minimum_free_bytes=5368709120/);
  assert.match(preflight, /grabenplaner-offsite-assurance@app-updated\.service/);
  assert.match(preflight, /grabenplaner-offsite-application-smoke\.service/);
  assert.match(preflight, /grabenplaner-postgresql-maintenance-recover\.service/);
  assert.match(preflight, /grabenplaner-host-security-rollback\.timer/);
  assert.match(preflight, /NextElapseUSecRealtime/);
  assert.match(preflight, /clamscan --no-summary -- "\$SCRIPT_PATH"/);
  assert.match(preflight, /runuser --user "\$GP_DEFAULT_BUILD_USER"/);
  assert.doesNotMatch(preflight, /systemctl\s+(?:disable|stop|restart|start|enable)/);
});

test("updater reserves the maintenance window before copying or scanning a package", () => {
  const phase = updater.indexOf("begin_deploy_phase deploy-preflight");
  const lock = updater.indexOf("gp_acquire_maintenance_lock", phase);
  const timers = updater.indexOf("pause_deploy_timers", phase);
  const packageCopy = updater.indexOf('install -m 0600 -o root -g root -- "$package"', phase);
  const scan = updater.indexOf("scan_candidate_with_clamav", packageCopy);
  assert.ok(phase >= 0 && lock > phase && timers > lock && packageCopy > timers && scan > packageCopy);
  assert.ok(updater.indexOf("begin_deploy_deferral() {") < updater.indexOf("pause_deploy_timers() {"));
  assert.ok(updater.indexOf("pause_deploy_timers() {") < timers);
  assert.match(updater, /restore_deploy_timers \|\| exit_code=1/);
  assert.match(updater, /Der Deploy wird vor Paketinstallation und Virenscan beendet/);
  assert.match(updater, /grabenplaner-offsite-assurance@app-updated\.service/);
  assert.match(updater, /grabenplaner-offsite-application-smoke\.service/);
  assert.match(updater, /grabenplaner-postgresql-maintenance-recover\.service/);
  assert.match(updater, /Der Sicherheits-Rollback .* ist aktiv/);
});

test("both deploy entry points reject unsafe shared /tmp before expensive work", () => {
  const check = preflight.indexOf('gp_assert_shared_tmp "$GP_DEFAULT_SERVICE_USER" "$GP_DEFAULT_BUILD_USER"');
  const updateCheck = updater.indexOf('gp_assert_shared_tmp "$service_user" "$build_user"');
  assert.ok(check > preflight.indexOf('gp_load_env_file "$env_file"'));
  for (const operation of ['actual_pnpm="', 'clamscan --no-summary']) assert.ok(preflight.indexOf(operation) > check, operation);
  assert.ok(updateCheck > updater.indexOf('gp_load_env_file "$env_file"'));
  for (const operation of ['package="$(gp_existing_file', 'install -m 0600 -o root -g root -- "$package"',
    'begin_deploy_phase dependencies', 'begin_deploy_phase package-scan', 'gp_begin_update_backup_ownership "$database"']) {
    assert.ok(updater.indexOf(operation) > updateCheck, operation);
  }
  assert.ok(updater.indexOf('exec bash "$preflight_script"') < updateCheck, "--preflight-only delegates to the protected standalone check");
});

for (const timer of ["grabenplaner-offsite-assurance.timer", "apt-daily.timer", "apt-daily-upgrade.timer"])
for (const active of [0, 1]) for (const enabled of [0, 1]) {
  test(`deploy uses and restores ${timer} without an offsite lease: active=${active}, enabled=${enabled}`,
    { skip: !fs.existsSync(bash) }, (t) => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gp-deploy-timer-"));
      t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
      const decisionStart = updater.indexOf("  nightly_timer_active=0", updater.indexOf("begin_deploy_phase verification-policy"));
      const decisionEnd = updater.indexOf("  deploy_decision=", decisionStart);
      assert.ok(decisionStart > 0 && decisionEnd > decisionStart);
      const script = `set -Eeuo pipefail
IFS=$'\\n\\t'
${updater.match(/^declare -a deploy_timer_units=\([\s\S]*?^\)/m)[0]}
declare -a deploy_blocking_timer_units=() deploy_maintenance_units=()
declare -A deploy_timer_was_active=() deploy_timer_was_enabled=()
deploy_timer_state_captured=0
GRABENPLANER_OFFSITE_CONFIGURED=0
deploy_deferral_generation=''
active=${active}
enabled=${enabled}
gp_systemd_unit_exists() { [[ "$1" == "${timer}" ]]; }
gp_info() { :; }
gp_warn() { printf '%s\\n' "$*" >&2; }
gp_die() { printf '%s\\n' "$*" >&2; exit 1; }
systemctl() {
  case "$1" in
    is-active) [[ "$active" == 1 ]] ;;
    is-enabled) [[ "$enabled" == 1 ]] ;;
    show) printf 'scheduled\\n' ;;
    stop) active=0 ;;
    start) active=1 ;;
    *) exit 90 ;;
  esac
}
${functionSource("begin_deploy_deferral")}
${functionSource("pause_deploy_timers")}
${functionSource("restore_deploy_timers")}
pause_deploy_timers
[[ "$active" == 0 ]]
[[ -z "$deploy_deferral_generation" ]]
${updater.slice(decisionStart, decisionEnd)}
printf 'decision=%s\\n' "$nightly_timer_active"
restore_deploy_timers
printf 'active=%s enabled=%s\\n' "$active" "$enabled"
`;
      fs.writeFileSync(path.join(temporary, "run.sh"), script.replace(/\r\n/g, "\n"));
      const result = spawnSync(bash, ["--noprofile", "--norc", "run.sh"], {
        cwd: temporary, encoding: "utf8", windowsHide: true, timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const expectedDecision = timer === "grabenplaner-offsite-assurance.timer" ? active && enabled : 0;
      assert.equal(result.stdout.trim(), `decision=${expectedDecision}\nactive=${active} enabled=${enabled}`);
    });
}

for (const [configured, active, enabled] of [[0, 1, 1], [1, 0, 1], [1, 1, 0], [0, 0, 0], [1, 0, 0]]) {
  test(`deploy creates no lease without configured active/enabled night timer: ${configured}/${active}/${enabled}`,
    { skip: !fs.existsSync(bash) }, () => {
      // Run the real guard. Any accidental contract/lease/heartbeat or lock
      // operation fails; the configured positive lifecycle is exercised in
      // deploy-nightly-deferral.test.js, including the native root CLI test.
      const result = spawnSync(bash, ["--noprofile", "--norc", "-c", `set -Eeuo pipefail
GRABENPLANER_OFFSITE_CONFIGURED=${configured}
deploy_deferral_generation=''
deploy_deferral_pid=''
declare -A deploy_timer_was_active=([grabenplaner-offsite-assurance.timer]=${active})
declare -A deploy_timer_was_enabled=([grabenplaner-offsite-assurance.timer]=${enabled})
node=node
node() { echo unexpected-node >&2; exit 97; }
flock() { echo unexpected-lock >&2; exit 98; }
gp_die() { echo "$*" >&2; exit 99; }
${functionSource("begin_deploy_deferral")}
begin_deploy_deferral
[[ -z "$deploy_deferral_generation" && -z "$deploy_deferral_pid" ]]
printf 'no-lease\\n'
`], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.equal(result.stdout.trim(), "no-lease");
    });
}

for (const [service, state, expectedStatus] of [
  ["apt-daily.service", "active", 2], ["apt-daily-upgrade.service", "active", 2],
  ["apt-daily.service", "inactive", 0], ["apt-daily-upgrade.service", "inactive", 0],
  ["unattended-upgrades.service", "active", 0],
]) {
  test(`preflight checks actual APT jobs without blocking the shutdown helper: ${service} ${state}`,
    { skip: !fs.existsSync(bash) }, () => {
      const start = preflight.indexOf("readonly -a maintenance_units=(");
      const end = preflight.indexOf("\nif gp_systemd_unit_exists grabenplaner-host-security-rollback.timer", start);
      assert.ok(start > 0 && end > start);
      const result = spawnSync(bash, ["--noprofile", "--norc", "-c", `set -Eeuo pipefail
gp_systemd_unit_exists() { [[ "$1" == "${service}" ]]; }
systemctl() { printf '%s\\n' "${state}"; }
gp_die() { exit 2; }
${preflight.slice(start, end)}
`], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      assert.equal(result.status, expectedStatus, result.stderr || result.error?.message);
    });
}

test("PostgreSQL recovery paths fail before dependencies, ClamAV and backup", () => {
  const preflightIndex = updater.indexOf("recovery-files-preflight");
  const dependencyIndex = updater.indexOf('install --prod --frozen-lockfile', preflightIndex);
  const scanIndex = updater.indexOf("scan_candidate_with_clamav", preflightIndex);
  const backupIndex = updater.indexOf('gp_begin_update_backup_ownership "$database"', preflightIndex);
  assert.ok(preflightIndex > 0);
  assert.ok(dependencyIndex > preflightIndex);
  assert.ok(scanIndex > preflightIndex);
  assert.ok(backupIndex > preflightIndex);
});

test("candidate recovery preflight uses only local path code before dependency installation", { skip: !fs.existsSync(bash) }, (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gp-preflight-node-path-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const write = (relative, source) => {
    const target = path.join(temporary, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  };
  const resultFile = path.join(temporary, "result.txt");
  write("installed/node_modules/pg/index.js", 'throw new Error("UNEXPECTED_INSTALLED_DRIVER_LOAD");');
  write("candidate/lib/runtime.js", 'module.exports={source:"local-path-code"};');
  write("candidate/server-tools/linux/lib/postgresql-operations.js", `
const fs=require("node:fs");
const assert=require("node:assert/strict");
assert.equal(require("../../../lib/runtime").source,"local-path-code");
assert.equal(process.env.NODE_PATH,undefined);
assert.ok(process.execArgv.includes('--no-global-search-paths'));
assert.equal(process.argv[2],"recovery-files-preflight");
assert.equal(process.argv[3],"/etc/grabenplaner/postgresql-operations.json");
fs.writeFileSync(${JSON.stringify(resultFile)},"verified");
`);
  const invocation = updater.split(/\r?\n/).find(line => line.includes('"$extract_root/server-tools/linux/lib/postgresql-operations.js" recovery-files-preflight'));
  assert.ok(invocation);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  let rootNode = updater.match(/^root_node\(\) \{[^\r\n]+\}/m)[0];
  // Git Bash has a second native-process argument conversion in env.exe.
  // Preserve the literal Linux config argument through that test-only layer;
  // Linux executes the exact unmodified production root_node function.
  if (process.platform === "win32") rootNode = rootNode.replace(" NODE_ENV=production ",
    " NODE_ENV=production MSYS2_ARG_CONV_EXCL=/etc/grabenplaner/postgresql-operations.json ");
  write("run.sh", `set -Eeuo pipefail
app_dir="$PWD/installed"
extract_root="$PWD/candidate"
node=${quote(process.execPath.replaceAll("\\", "/"))}
${rootNode}
${invocation}
  /etc/grabenplaner/postgresql-operations.json >/dev/null
`);
  const result = spawnSync(bash, ["--noprofile", "--norc", "run.sh"], {
    cwd: temporary, encoding: "utf8", windowsHide: true, timeout: 10000,
    env: { ...process.env, NODE_PATH: path.join(temporary, "installed/node_modules"), MSYS2_ARG_CONV_EXCL: "/etc/grabenplaner/postgresql-operations.json" },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(fs.readFileSync(resultFile, "utf8"), "verified");
  assert.equal(fs.existsSync(path.join(temporary, "candidate/node_modules")), false);
});

for (const version of ["0.92.58-beta", "0.92.61-beta", "0.92.62-beta"]) {
  test(`the scanner backup bridge is limited to the affected predecessor: ${version}`, { skip: !fs.existsSync(bash) }, () => {
    const start = updater.indexOf('  if [[ "$old_version" == 0.92.58-beta');
    const end = updater.indexOf("\n  fi", start) + "\n  fi".length;
    assert.ok(start > 0 && end > start);
    const result = spawnSync(bash, ["--noprofile", "--norc", "-c", `set -Eeuo pipefail
old_version=${version}
runtime_v5_transition=''
xoffi_snapshots_migration=0
postgresql_backup_repair=0
node=node
app_dir=/installed
extract_root=/candidate
root_node() { :; }
gp_die() { exit 1; }
${updater.slice(start, end)}
printf '%s\\n' "$postgresql_backup_repair"
`], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(result.stdout.trim(), version === "0.92.58-beta" ? "1" : "0");
  });
}

test("ClamAV has no elapsed-time abort and reports continued liveness", () => {
  const start = updater.indexOf("scan_candidate_with_clamav() {");
  const end = updater.indexOf("\n}\n\nstart_database_lock()", start);
  const source = updater.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(source, /clamscan --recursive --infected --no-summary/);
  assert.match(source, /ClamAV arbeitet weiter/);
  assert.match(source, /CPU-Ticks/);
  assert.match(source, /keine messbare CPU- oder Leseaktivitaet/);
  assert.match(source, /while kill -0 "\$clamav_scan_pid"/);
  assert.doesNotMatch(source, /timeout|1500|deadline|kill -KILL/);
});

test("ClamAV activity fields stay numeric under the updater's restricted IFS", { skip: !fs.existsSync(bash) }, () => {
  const activityReads = updater.split(/\r?\n/).filter((line) => /read -r (?:previous|current)_ticks/.test(line));
  assert.equal(activityReads.length, 2);
  const result = spawnSync(bash, ["--noprofile", "--norc", "-c", `set -Eeuo pipefail
IFS=$'\\n\\t'
clamav_activity_snapshot() { printf '123 456\\n'; }
${activityReads.join("\n")}
[[ "$previous_ticks" == 123 && "$previous_read_chars" == 456 ]]
[[ "$current_ticks" == 123 && "$current_read_chars" == 456 ]]
[[ "$IFS" == $'\\n\\t' ]]
`], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test("ClamAV progress reports remain executable after the first minute", { skip: !fs.existsSync(bash) }, () => {
  const reports = updater.split(/\r?\n/).filter((line) => /gp_(?:info|warn) "ClamAV/.test(line));
  assert.equal(reports.length, 2);
  const result = spawnSync(bash, ["--noprofile", "--norc", "-c", `set -Eeuo pipefail
SECONDS=61
started_at=1
clamav_scan_pid=123
tick_delta=2
read_delta=3
stagnant_reports=1
gp_info() { printf '%s\\n' "$*"; }
gp_warn() { printf '%s\\n' "$*"; }
${reports.join("\n")}
`], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /ClamAV arbeitet weiter \(60s, PID 123, CPU-Ticks \+2, gelesene Bytes \+3\)/);
  assert.match(result.stdout, /Leseaktivitaet \(60s, PID 123, Intervalle 1\)/);
});

test("the 1500 second value remains scoped to service readiness", () => {
  assert.match(updater, /health_timeout=1500/);
  assert.match(updater, /gp_wait_ready "\$internal_ready_url" "\$health_timeout"/);
  const scanStart = updater.indexOf("scan_candidate_with_clamav() {");
  const scanEnd = updater.indexOf("\n}\n\nstart_database_lock()", scanStart);
  assert.equal(updater.slice(scanStart, scanEnd).includes("health_timeout"), false);
});
