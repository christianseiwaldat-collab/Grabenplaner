"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const test = require("node:test"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const source = fs.readFileSync(path.join(__dirname, "../server-tools/linux/migrate-grabenplaner-runtime-v6.sh"), "utf8");
function run(t, failure) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-core6-timers-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pauseStart = source.indexOf('for index in "${!offsite_timer_names[@]}"; do\n  timer_state=');
  const pauseEnd = source.indexOf("for unit in grabenplaner-offsite-prepare.service", pauseStart);
  assert(pauseStart > 0 && pauseEnd > pauseStart);
  const cleanup = source.match(/^cleanup\(\) \{[\s\S]*?^\}/m)?.[0]; assert(cleanup);
  const restoreTimers = source.match(/^restore_timer_states\(\) \{[\s\S]*?^\}/m)?.[0]; assert(restoreTimers);
  const program = `set -Eeuo pipefail
work_root="$1"
failure="$2"
module_phase=0 bootstrap_changed=0 transition_complete=0 interrupted=0 timers_paused=0 rollback_failed=0
offsite_timer_names=(one two three four)
offsite_timer_was_active=(0 0 0 0)
declare -A states=([one]=active [two]=inactive [three]=active [four]=inactive)
write_states() {
  local timer
  for timer in one two three four; do printf '%s=%s\\n' "$timer" "\$\{states[$timer]}"; done >"$work_root/final"
}
write_states
systemctl() {
  local command="$1" timer="$2"
  if [[ "$command" == show ]]; then
    if [[ "$failure" == capture && "$timer" == three ]]; then return 18; fi
    printf '%s' "\$\{states[$timer]}"
  elif [[ "$command" == start || "$command" == stop ]]; then
    printf '%s %s\\n' "$command" "$timer" >>"$work_root/operations"
    if [[ "$failure" == stop && "$command" == stop && "$timer" == one && ! -e "$work_root/failed-once" ]]; then
      touch "$work_root/failed-once"; return 19
    fi
    if [[ "$failure" == resume && "$command" == start && "$timer" == one ]]; then return 0; fi
    if [[ "$command" == start ]]; then states[$timer]=active; else states[$timer]=inactive; fi
    write_states
  else return 20; fi
}
commit_is_valid() { return 1; }
gp_warn() { :; }
gp_die() { exit 17; }
${restoreTimers}
${cleanup}
trap cleanup EXIT
${source.slice(pauseStart, pauseEnd)}
exit 0
`;
  const result = spawnSync("bash", ["-s", "--", directory, failure], { input: program, encoding: "utf8" });
  return { result, final: fs.existsSync(path.join(directory, "final")) ? fs.readFileSync(path.join(directory, "final"), "utf8") : "",
    operations: fs.existsSync(path.join(directory, "operations")) ? fs.readFileSync(path.join(directory, "operations"), "utf8") : "" };
}
test("Core6 timer capture failure leaves every original timer untouched", { skip: process.platform !== "linux" }, t => {
  const value = run(t, "capture");
  assert.equal(value.result.status, 17, value.result.stderr); assert.equal(value.operations, "");
  assert.equal(value.final, "one=active\ntwo=inactive\nthree=active\nfour=inactive\n");
});
test("Core6 first-stop failure restores all four fully captured original timer states", { skip: process.platform !== "linux" }, t => {
  const value = run(t, "stop");
  assert.equal(value.result.status, 19, value.result.stderr);
  assert.equal(value.final, "one=active\ntwo=inactive\nthree=active\nfour=inactive\n");
  assert.equal(value.operations, "stop one\nstart one\nstop two\nstart three\nstop four\n");
});
test("Core6 rejects an acknowledged timer start that did not reach its original active state", { skip: process.platform !== "linux" }, t => {
  const value = run(t, "resume");
  assert.equal(value.result.status, 2, value.result.stderr);
  assert.equal(value.final, "one=inactive\ntwo=inactive\nthree=active\nfour=inactive\n");
});
