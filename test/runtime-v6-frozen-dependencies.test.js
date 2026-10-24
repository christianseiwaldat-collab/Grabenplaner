"use strict";
const assert = require("node:assert/strict"), test = require("node:test");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const wrapper = fs.readFileSync(path.join(__dirname, "../server-tools/linux/migrate-grabenplaner-runtime-v6.sh"), "utf8");
const start = wrapper.indexOf('root_node "$transition_helper" dependency-plan '), end = wrapper.indexOf("\nrender_bootstrap()", start);
assert(start > 0 && end > start);
const sequence = wrapper.slice(start, end);
for (const failure of ["none", "plan", "fresh-root-closure", "postgresql-preflight"]) {
  test("Core6 requires a fresh original-ZIP PostgreSQL closure before privileged preflight: " + failure,
    { skip: !fs.existsSync(bash) }, t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-v6-frozen-flow-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const program = ["set -Eeuo pipefail", "work_root=$PWD", "app_dir=$PWD/old", "extract_root=$PWD/candidate", "staged_package=$PWD/original.zip",
        "node=qualified-node", "transition_helper=qualified-transition", "pnpm_program=qualified-manager", "pnpm_arguments=(pnpm)",
        "failure=" + failure, 'trace="$PWD/trace"',
        'gp_die() { printf "%s\\n" "$*" >&2; exit 1; }',
        'root_node() { if [[ "$2" == dependency-plan ]]; then phase=plan; else phase=postgresql-preflight; fi; printf "%s\\n" "$phase" >>"$trace"; [[ "$failure" != "$phase" ]] || return 1; printf "{}\\n"; }',
        'gp_prepare_root_pg_dependencies() { [[ "$1" == "$staged_package" && "$2" == "$extract_root" && "$3" == "$node" && "$4" == "$pnpm_program" && "$5" == pnpm ]] || return 1; printf "%s\\n" fresh-root-closure >>"$trace"; [[ "$failure" != fresh-root-closure ]] || return 1; printf "{}\\n"; }',
        sequence].join("\n");
      fs.writeFileSync(path.join(root, "flow.sh"), program);
      const result = spawnSync(bash, ["--noprofile", "--norc", "flow.sh"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 15000 });
      assert.equal(result.status, failure === "none" ? 0 : 1, result.stderr || result.error?.message);
      const expected = ["plan", "fresh-root-closure", "postgresql-preflight"];
      assert.deepEqual(fs.readFileSync(path.join(root, "trace"), "utf8").trim().split("\n"),
        failure === "none" ? expected : expected.slice(0, expected.indexOf(failure) + 1));
    });
}
