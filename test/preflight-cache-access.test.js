"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const source = fs.readFileSync(path.join(__dirname, "../server-tools/linux/preflight-grabenplaner-deploy.sh"), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf('getent group "$GP_DEFAULT_SERVICE_GROUP"');
const end = source.indexOf('required_pnpm="', start);
assert.ok(start >= 0 && end > start);
const permissionChecks = source.slice(start, end);
const modelPermissions = process.platform === "win32" || process.getuid() === 0;

for (const [scenario, denied, mode, expectedChecks] of [
  ["read/write/search available", "", 0o700, ["-r", "-w", "-x"]],
  ["read denied", "-r", 0o300, ["-r"]],
  ["write denied", "-w", 0o500, ["-r", "-w"]],
  ["directory search denied", "-x", 0o600, ["-r", "-w", "-x"]],
]) {
  test("preflight executes build-user cache permission checks: " + scenario, { skip: !fs.existsSync(bash) }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-preflight-cache-"));
    const cache = path.join(root, "cache with spaces");
    fs.mkdirSync(cache, { mode: 0o700 });
    if (!modelPermissions) fs.chmodSync(cache, mode);
    t.after(() => {
      assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
      fs.chmodSync(cache, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(root, "run.sh"), [
      "set -Eeuo pipefail", "IFS=$'\\n\\t'",
      "GP_DEFAULT_SERVICE_GROUP=gp-service-fixture",
      "GP_DEFAULT_BUILD_USER=gp-build-fixture", "GP_DEFAULT_BUILD_GROUP=gp-build-fixture",
      'build_cache="$PWD/cache with spaces"',
      'gp_die() { printf "%s\\n" "$*" >&2; exit 42; }',
      "getent() { return 0; }", 'id() { printf "%s\\n" "$GP_DEFAULT_BUILD_GROUP"; }',
      // Only the identity switch is simulated; execute the real extracted shell commands.
      'runuser() { [[ "$1" == --user && "$2" == "$GP_DEFAULT_BUILD_USER" && "$3" == -- ]] || exit 88; shift 3; "$@"; }',
      'native_test="$(type -P test)"',
      "test() {",
      '  printf "%s\\n" "$1" >> permission-checks',
      // The real external test always validates/evaluates syntax. Windows has no Unix
      // mode enforcement and root can override read/write bits, so model denials there.
      '  "$native_test" "$@" || return "$?"',
      '  if [[ "$GP_MODEL_PERMISSIONS" == 1 && "$1" == "$GP_DENIED_PERMISSION" ]]; then return 1; fi',
      "  return 0",
      "}",
      permissionChecks,
      "printf 'reached-next-preflight-check\\n'",
    ].join("\n"));
    const result = spawnSync(bash, ["--noprofile", "--norc", "run.sh"], {
      cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true,
      env: { ...process.env, GP_MODEL_PERMISSIONS: modelPermissions ? "1" : "0", GP_DENIED_PERMISSION: denied },
    });
    assert.ifError(result.error);
    assert.deepEqual(fs.readFileSync(path.join(root, "permission-checks"), "utf8").trim().split("\n"), expectedChecks);
    if (!denied) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "reached-next-preflight-check\n");
      assert.equal(result.stderr, "");
    } else {
      assert.equal(result.status, 42, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "Der isolierte Build-Benutzer kann den Build-Cache nicht verwenden.\n");
    }
  });
}
