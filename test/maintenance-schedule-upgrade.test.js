"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const common = read("server-tools/linux/lib/common.sh");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const helpers = common.slice(common.indexOf("gp_maintenance_schedule_state()"), common.indexOf("gp_apply_app_permissions()"));
const configure = common.slice(common.indexOf("gp_configure_nightly_backups()"), common.indexOf("gp_apply_app_permissions()"));
const bashOptions = { skip: !fs.existsSync(bash) };
function runBash(code) {
  const result = spawnSync(bash, ["--noprofile", "--norc", "-s"], { input: "set -e\n" + code, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("core upgrade preserves a matrix-disabled backup and refuses invalid saved state before timer mutations", bashOptions, () => {
  for (const valid of [true, false]) {
    const output = runBash(`gp_nightly_schedule_mode(){ printf single; }
gp_maintenance_schedule_state(){ ${valid ? "printf 'grabenplaner-offsite-assurance.timer=0'" : "return 1"}; }
systemctl(){ printf 'UNEXPECTED MUTATION: %s\\n' "$*"; }
${configure}
if gp_configure_nightly_backups /fixture node; then printf 'accepted\\n'; else printf 'rejected\\n'; fi`);
    assert.equal(output, valid ? "accepted\n" : "rejected\n");
  }
});

test("offsite upgrade restores independent enabled and active states; a fresh install enables defaults", bashOptions, () => {
  const installer = read("server-tools/linux/offsite/install-grabenplaner-offsite.sh");
  const start = installer.indexOf("if (( installed_module_version >= 1 )); then\n  for index in 0 1 2 3; do");
  assert.ok(start > 0);
  const block = installer.slice(start, installer.indexOf("# A module can precede", start));
  for (const version of [0, 11]) {
    const output = runBash(`installed_module_version=${version}
timers=(grabenplaner-offsite-assurance.timer grabenplaner-offsite-upload.timer grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.timer)
timer_was_enabled=(0 0 1 1)
timer_was_active=(0 0 0 1)
declare -A enabled=() active=()
for timer in "\${timers[@]}"; do enabled[$timer]=0; active[$timer]=0; done
systemctl(){
  local verb="$1" now=0 unit; shift
  if [[ "\${1:-}" == --now ]]; then now=1; shift; fi
  for unit in "$@"; do
    case "$verb" in
      enable) enabled[$unit]=1; if (( now == 1 )); then active[$unit]=1; fi ;;
      disable) enabled[$unit]=0 ;;
      start) active[$unit]=1 ;;
      stop) active[$unit]=0 ;;
      *) return 1 ;;
    esac
  done
}
${block}
for timer in "\${timers[@]}"; do printf '%s:%s:%s\\n' "$timer" "\${enabled[$timer]}" "\${active[$timer]}"; done`);
    assert.equal(output, [
      `grabenplaner-offsite-assurance.timer:${version ? "0:0" : "1:1"}`,
      "grabenplaner-offsite-upload.timer:0:0",
      `grabenplaner-offsite-check.timer:${version ? "1:0" : "1:1"}`,
      "grabenplaner-offsite-restore-test.timer:1:1", "",
    ].join("\n"));
  }
});

test("timer health accepts deliberately disabled rows but rejects broken enabled timers outside a proven pause", bashOptions, () => {
  for (const [expected, enabled, active, paused, accepted] of [
    [0, "disabled", "inactive", 0, true], [0, "enabled", "active", 0, false],
    [1, "enabled", "active", 0, true], [1, "enabled", "inactive", 0, false],
    [1, "enabled", "inactive", 1, true], [1, "disabled", "inactive", 1, false],
    [0, "masked", "inactive", 0, false], [1, "enabled", "failed", 1, false],
  ]) {
    const output = runBash(`${helpers}
systemctl(){ case "$1" in is-enabled) printf '${enabled}'; ${enabled === "enabled" ? "return 0" : "return 1"} ;; is-active) printf '${active}'; ${active === "active" ? "return 0" : "return 3"} ;; *) return 1 ;; esac; }
if gp_maintenance_timer_matches grabenplaner-offsite-assurance.timer ${expected} ${paused}; then printf accepted; else printf rejected; fi`);
    assert.equal(output, accepted ? "accepted" : "rejected", JSON.stringify({ expected, enabled, active, paused }));
  }
});

test("saved matrix validation uses the actual broker revision and protected file contracts", () => {
  const brokerSource = read("server-tools/linux/offsite/lib/maintenance-schedule-broker.js");
  const stateReader = helpers.slice(0, helpers.indexOf("gp_maintenance_timer_expected()"));
  const code = stateReader.split("<<'NODE'\n")[1].split("\nNODE")[0];
  function run(invalid = "") {
    let document;
    const rootPath = "/var/lib/grabenplaner-maintenance-schedules";
    const stat = (directory, mode) => ({ isDirectory: () => directory, isFile: () => !directory,
      isSymbolicLink: () => false, uid: 0, gid: 0, nlink: directory ? 2 : 1, mode, size: 4096 });
    const fakeFs = {
      lstatSync(file) {
        const result = stat(file === rootPath, file === rootPath ? 0o40700 : file.endsWith(".json") ? 0o100600 : 0o100644);
        if (file.endsWith("maintenance-schedule-broker.js")) result.gid = 1001; // App files are root:service-group.
        if (invalid === "root-owner" && file === rootPath) result.uid = 1000;
        if (invalid === "file-mode" && file.endsWith(".json")) result.mode = 0o100644;
        if (invalid === "file-symlink" && file.endsWith(".json")) result.isSymbolicLink = () => true;
        return result;
      },
      existsSync: () => true, realpathSync: file => file,
      readFileSync: () => JSON.stringify(document),
    };
    const brokerContext = { module: { exports: {} }, process: { platform: "linux" },
      require: name => name === "node:fs" ? fakeFs : name === "node:path" ? path.posix : require(name) };
    vm.runInNewContext(brokerSource, brokerContext);
    const broker = brokerContext.module.exports;
    const schedules = broker.defaultSchedules();
    schedules.find(row => row.id === "complete-backup").enabled = false;
    document = { format: broker.STATE_FORMAT, schemaVersion: broker.STATE_SCHEMA_VERSION,
      updatedAt: "2026-09-19T12:00:00.000Z", revision: broker.revisionFor(schedules), schedules };
    if (invalid === "revision") document.revision = "0".repeat(64);
    let output = "", error = "";
    const runtime = { argv: ["node", "-", "/fixture"], stdout: { write: value => { output += value; } },
      stderr: { write: value => { error += value; } }, exitCode: 0 };
    vm.runInNewContext(code, { process: runtime,
      require: name => name === "node:fs" ? fakeFs : name === "node:path" ? path.posix : broker });
    return { output, error, status: runtime.exitCode };
  }
  const good = run();
  assert.equal(good.status, 0, good.error);
  assert.match(good.output, /grabenplaner-offsite-assurance.timer=0/);
  assert.equal(good.output.split("\n").length, 5);
  for (const invalid of ["revision", "root-owner", "file-mode", "file-symlink"]) {
    const result = run(invalid);
    assert.equal(result.status, 1, invalid);
    assert.equal(result.output, "", invalid);
  }
});
