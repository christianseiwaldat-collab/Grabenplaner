"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const source = fs.readFileSync(path.join(__dirname, "../server-tools/linux/update-grabenplaner-server.sh"), "utf8").replace(/\r\n/g, "\n");
const entry = 'gp_begin_update_backup_ownership "$database"';
const workflow = source.slice(source.indexOf(entry))
  .replaceAll("/usr/local/sbin/grabenplaner-offsite-pre-update", "$TEST_MODULE_ROOT/grabenplaner-offsite-pre-update.sh")
  .replaceAll("/opt/grabenplaner-offsite/module", "$TEST_MODULE_ROOT");

for (const scenario of ["short", "full", "failed-readiness"]) {
  test(`actual updater orchestration: ${scenario}`, { skip: !fs.existsSync(bash) }, t => {
    assert.ok(source.indexOf(entry) > 0);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-deploy-shell-"));
    t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
    const write = (relative, content) => {
      const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, { mode: 0o755 });
    };
    write("app/old.txt", "old application");
    write("candidate/server-tools/linux/test-grabenplaner-server.sh", '#!/usr/bin/env bash\nprintf "short-checks\\n" >> "$EVENTS_FILE"\n');
    write("module/grabenplaner-offsite-pre-update.sh", '#!/usr/bin/env bash\nprintf "offsite-transfer\\n" >> "$EVENTS_FILE"\n');
    write("module/lib/offsite-common.sh", `offsite_acquire_assurance_lock() { :; }
offsite_assert_runtime_binaries() { :; }
offsite_record_assurance_queue() { printf 'queue-assurance\\n' >> "$EVENTS_FILE"; }
`);
    const script = `#!/usr/bin/env bash
set -Eeuo pipefail
export EVENTS_FILE="$PWD/events"
: > "$EVENTS_FILE"
export TEST_MODULE_ROOT="$PWD/module"
app_dir="$PWD/app"
extract_root="$PWD/candidate"
rollback_root="$PWD/previous"
database="$PWD/live.db"
data_dir="$PWD/data"
backup_dir="$PWD/backups"
backup_result_file="$PWD/backup.json"
env_file="$PWD/environment"
SCRIPT_DIR="$PWD/scripts"
service=fixture.service
caddy_service=fixture-caddy.service
service_group=root
node=${quote(process.execPath.replaceAll("\\", "/"))}
health_timeout=1500
internal_ready_url=http://127.0.0.1/ready
public_ready_url=https://fixture.invalid/ready
public_url=https://fixture.invalid
old_version=0.92.37-beta
candidate_version=0.92.38-beta
actual_package_sha256=synthetic
runtime_v5_transition=""
GRABENPLANER_OFFSITE_CONFIGURED=1
GRABENPLANER_OFFSITE_STATUS_FILE=/var/lib/grabenplaner-offsite/status.json
deploy_mode=${scenario === "full" ? "full" : "short"}
backup_count=0
gp_info() { :; }
gp_warn() { printf 'warning\\n' >> "$EVENTS_FILE"; }
gp_die() { printf 'failed\\n' >> "$EVENTS_FILE"; return 1; }
begin_deploy_phase() { printf 'phase:%s\\n' "$1" >> "$EVENTS_FILE"; }
finish_deploy_phase() { :; }
gp_begin_update_backup_ownership() { printf 'owner\\n' >> "$EVENTS_FILE"; }
gp_stop_service() { printf 'stop\\n' >> "$EVENTS_FILE"; }
gp_start_service() { printf 'start\\n' >> "$EVENTS_FILE"; }
gp_wait_ready() { ${scenario === "failed-readiness" ? "return 1" : ":"}; }
gp_apply_app_permissions() { :; }
start_database_lock() { printf 'database-lock\\n' >> "$EVENTS_FILE"; }
release_database_lock() { :; }
create_exact_local_backup() {
  backup_count=$((backup_count + 1))
  printf 'verified-backup\\n' >> "$EVENTS_FILE"
  backup_database="$PWD/backup-$backup_count.db"
  backup_amu="$PWD/backup-$backup_count.amu"
  touch "$backup_database"; mkdir "$backup_amu"
}
write_receipt() { printf 'success-receipt\\n' >> "$EVENTS_FILE"; printf '%s\\n' "$PWD/receipt"; }
write_commit_marker() { printf 'commit\\n' >> "$EVENTS_FILE"; }
stat() { if [[ "$1" == "--format=%a" ]]; then printf '600\\n'; else printf '0:0:1\\n'; fi; }
systemctl() { printf 'start-assurance\\n' >> "$EVENTS_FILE"; }
${workflow}
`;
    write("run.sh", script);
    const result = spawnSync(bash, ["--noprofile", "--norc", "run.sh"], { cwd: root, encoding: "utf8", timeout: 15000 });
    const events = fs.readFileSync(path.join(root, "events"), "utf8").trim().split("\n");
    if (scenario === "failed-readiness") {
      assert.notEqual(result.status, 0); assert.ok(events.includes("failed")); assert.ok(!events.includes("commit")); assert.ok(!events.includes("queue-assurance"));
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(events.filter(event => event === "verified-backup").length, scenario === "full" ? 2 : 1);
      assert.equal(events.filter(event => event === "start").length, scenario === "full" ? 2 : 1);
      assert.equal(events.includes("offsite-transfer"), scenario === "full");
      assert.equal(events.includes("start-assurance"), scenario === "full");
      assert.ok(events.indexOf("owner") < events.indexOf("stop"));
      assert.ok(events.indexOf("short-checks") < events.indexOf("success-receipt"));
      assert.ok(events.indexOf("commit") < events.indexOf("queue-assurance"));
      assert.ok(fs.existsSync(path.join(root, "previous/old.txt")));
    }
  });
}
