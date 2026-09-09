"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";

test("maintenance stop waits for the original main process before systemd group cleanup", { skip: !fs.existsSync(bash) }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-backup-stop-test-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true });
  });
  const common = fs.readFileSync(path.join(__dirname, "../server-tools/linux/lib/common.sh"), "utf8").replace(/\r\n/g, "\n");
  fs.writeFileSync(path.join(root, "common.sh"), common);
  const script = `set -Eeuo pipefail
source ./common.sh
systemctl() {
  printf '%s\\n' "$*" >> events
  case "$1" in
    show)
      if [[ "$2" == "--property=LoadState" ]]; then printf 'loaded\\n'; return; fi
      cat pid
      if [[ -f worker-running ]]; then rm worker-running; printf '0\\n' > pid; fi
      ;;
    is-active)
      if [[ "$2" == "--quiet" ]]; then [[ "$(cat pid)" != "0" ]]; else printf 'inactive\\n'; fi
      ;;
    kill)
      [[ "$2" == "--kill-whom=main" && "$3" == "--signal=SIGTERM" ]] || return 90
      if [[ "$GP_STOP_TEST_SCENARIO" == "restarted" ]]; then printf '99\\n' > pid; else touch worker-running; fi
      ;;
    stop) [[ "$(cat pid)" == "0" ]] || return 91 ;;
    *) return 92 ;;
  esac
}
sleep() { :; }
gp_stop_service fixture.service 2
`;
  fs.writeFileSync(path.join(root, "check.sh"), script);
  for (const scenario of ["drained", "restarted", "invalid-pid"]) {
    fs.writeFileSync(path.join(root, "pid"), scenario === "invalid-pid" ? "invalid\n" : "42\n");
    fs.writeFileSync(path.join(root, "events"), "");
    const result = spawnSync(bash, ["--noprofile", "--norc", "check.sh"], { cwd: root, encoding: "utf8", windowsHide: true,
      env: { ...process.env, GP_STOP_TEST_SCENARIO: scenario }, timeout: 10000 });
    const events = fs.readFileSync(path.join(root, "events"), "utf8");
    if (scenario === "drained") {
      assert.equal(result.status, 0, result.stderr);
      assert.match(events, /kill --kill-whom=main --signal=SIGTERM fixture.service/);
      assert.ok(events.indexOf("stop fixture.service") > events.lastIndexOf("show --property=MainPID"));
    } else {
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(events, /^stop /m, "unknown or replaced main process must not be killed");
    }
  }
});
