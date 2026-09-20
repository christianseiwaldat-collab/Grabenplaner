"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const cases = [
  { name: "space-separated stat output under restricted updater IFS", output: "20000000 4096\n", bytes: "81920000000" },
  { name: "zero available blocks stay zero", output: "0 4096\n", bytes: "0" },
  { name: "missing output", output: "" },
  { name: "missing second field", output: "20000000\n" },
  { name: "malformed numeric field", output: "invalid 4096\n" },
  { name: "negative free blocks", output: "-1 4096\n" },
  { name: "unexpected third field", output: "20000000 4096 extra\n" },
  { name: "unexpected second line", output: "20000000 4096\nextra\n" },
  { name: "failed stat without output", output: "", status: 1 },
  { name: "failed stat with valid-looking output", output: "20000000 4096\n", status: 1 },
  { name: "unavailable stat command", output: "", status: 127 },
];
for (const [label, file, functionName] of [
  ["updater", "update-grabenplaner-server.sh", "free_bytes_for_deploy"],
  ["preflight", "preflight-grabenplaner-deploy.sh", "free_bytes_for"],
]) {
  const source = fs.readFileSync(path.join(__dirname, "../server-tools/linux", file), "utf8").replace(/\r\n/g, "\n");
  const prologue = source.match(/^set -Eeuo pipefail\nIFS=.*$/m)?.[0];
  const functionSource = source.match(new RegExp(`^${functionName}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"))?.[0];
  assert.ok(prologue && functionSource, "execute the script's actual IFS and space function");
  for (const scenario of cases) {
  test(label + " free-space shell: " + scenario.name, { skip: !fs.existsSync(bash) }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-deploy-free-space-"));
    t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
    fs.writeFileSync(path.join(root, "run.sh"), `${prologue}
gp_die() { printf '%s\\n' "$*" >&2; exit 42; }
stat() {
  [[ "$#" == 4 && "$1" == --file-system && "$2" == '--format=%a %S' && "$3" == -- && "$4" == '/fixture/path with spaces' ]] || exit 91
  printf '%s' ${quote(scenario.output)}
  return ${scenario.status || 0}
}
${functionSource}
before_ifs="$IFS"
actual="$(${functionName} '/fixture/path with spaces')"
[[ "$IFS" == "$before_ifs" && "$IFS" == $'\\n\\t' ]]
printf '%s\\n' "$actual"
`);
    const result = spawnSync(bash, ["--noprofile", "--norc", "run.sh"], { cwd: root, encoding: "utf8", timeout: 10000, windowsHide: true });
    if (scenario.bytes !== undefined) {
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.equal(result.stdout.trim(), scenario.bytes);
    } else {
      assert.equal(result.status, 42, result.stderr || result.error?.message);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /nicht pruefbar/);
    }
  });
  }
}
