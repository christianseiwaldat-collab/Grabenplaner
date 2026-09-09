"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const source = fs.readFileSync(path.join(__dirname, "../server-tools/linux/hardening/test-grabenplaner-host-hardening.sh"), "utf8").replace(/\r\n/g, "\n");

function shellFunction(name) {
  const start = source.indexOf(`${name}() {\n`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end + 3);
}

test("host audit exercises real listener classification with safe command fixtures", { skip: !fs.existsSync(bash) }, t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gp-listener-audit-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(temporary)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const functions = ["record_ok", "record_error", "record_warn", "record_unknown", "internal_port_is_loopback_only", "check_firewall", "check_failed_units"].map(shellFunction).join("\n");
  const fixture = `set -Eeuo pipefail
IFS=$'\\n\\t'
ERROR_COUNT=0
WARNING_COUNT=0
declare -A CHECK_VALUE=([firewall]=false [publicPorts]=false [failedUnits]=false)
${functions}
ufw() { [[ "$GP_AUDIT_SCENARIO" != firewall-unavailable ]]; }
validate_transaction_ufw_policy() { [[ "$GP_AUDIT_SCENARIO" != firewall-unsafe ]]; }
sleep() { printf 'sleep\\n' >> sleeps; }
systemctl() {
  [[ "$*" == $'--failed\\n--no-legend\\n--plain' ]] || exit 90
  case "$GP_AUDIT_SCENARIO" in
    failed-units) printf 'historical-fixture.service loaded failed failed\\n' ;;
    units-unavailable) return 1 ;;
  esac
  return 0
}
ss() {
  local count
  count="$(cat count)"
  printf '%s\\n' "$((count + 1))" > count
  case "$GP_AUDIT_SCENARIO" in
    missing) return 0 ;;
    transient) [[ "$count" -ge 1 ]] || return 0 ;;
    listener-unavailable) return 1 ;;
    malformed) printf 'unrecognized output\\n'; return ;;
    unsafe-ipv4) printf 'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*\\n'; return ;;
    unsafe-ipv6) printf 'LISTEN 0 511 [::]:3000 [::]:*\\n'; return ;;
    mixed) printf 'LISTEN 0 511 *:3000 *:*\\n' ;;
  esac
  printf 'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*\\nLISTEN 0 511 [::1]:3000 [::]:*\\nLISTEN 0 511 *:443 *:*\\n'
}
check_firewall
check_failed_units
printf 'RESULT:%s,%s,%s,%s,%s\\n' "\${CHECK_VALUE[firewall]}" "\${CHECK_VALUE[publicPorts]}" "\${CHECK_VALUE[failedUnits]}" "$ERROR_COUNT" "$WARNING_COUNT"
`;
  for (const [scenario, values, attempts, sleeps] of [
    ["safe", "true,true,true,0,0", 1, 0],
    ["transient", "true,true,true,0,0", 2, 1],
    ["missing", "true,null,true,0,1", 7, 6],
    ["unsafe-ipv4", "true,false,true,1,0", 1, 0],
    ["unsafe-ipv6", "true,false,true,1,0", 1, 0],
    ["mixed", "true,false,true,1,0", 1, 0],
    ["listener-unavailable", "true,null,true,1,0", 1, 0],
    ["malformed", "true,null,true,1,0", 1, 0],
    ["firewall-unavailable", "null,null,true,1,1", 1, 0],
    ["firewall-unsafe", "false,false,true,2,0", 1, 0],
    ["failed-units", "true,true,false,0,1", 1, 0],
    ["units-unavailable", "true,true,null,0,1", 1, 0],
  ]) {
    fs.writeFileSync(path.join(temporary, "count"), "0\n");
    fs.writeFileSync(path.join(temporary, "sleeps"), "");
    const result = spawnSync(bash, ["--noprofile", "--norc", "-s"], {
      cwd: temporary, input: fixture, encoding: "utf8", windowsHide: true, timeout: 10000,
      env: { ...process.env, GP_AUDIT_SCENARIO: scenario },
    });
    assert.equal(result.status, 0, `${scenario}: ${result.stderr}`);
    assert.ok(result.stdout.includes(`RESULT:${values}\n`), `${scenario}: ${result.stdout}`);
    assert.equal(Number(fs.readFileSync(path.join(temporary, "count"), "utf8").trim()), attempts, scenario);
    assert.equal(fs.readFileSync(path.join(temporary, "sleeps"), "utf8").split("\n").filter(Boolean).length, sleeps, scenario);
  }
});
