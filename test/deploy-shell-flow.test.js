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

for (const scenario of ["ordinary", "xoffi", "runtime-v5", "postgresql-repair"]) {
  test(`backup source and retention selection: ${scenario}`, { skip: !fs.existsSync(bash) }, t => {
    const start = source.indexOf("create_exact_local_backup() {");
    const selection = source.slice(start, source.indexOf('  [[ -x "$backup_script" ]]', start));
    assert.ok(start > 0 && selection.includes('backup_app_dir="$extract_root"'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-backup-selection-"));
    t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
    fs.writeFileSync(path.join(root,"run.sh"), `set -Eeuo pipefail
app_dir=/installed
extract_root=/verified-candidate
runtime_v5_transition=${scenario === "runtime-v5" ? "bound-transition" : "''"}
xoffi_snapshots_migration=${scenario === "xoffi" ? 1 : 0}
postgresql_backup_repair=${scenario === "postgresql-repair" ? 1 : 0}
deploy_mode=full
${selection}
  printf '%s\\n' "$backup_app_dir" "$backup_script" "\${retention_args[*]}"
}
create_exact_local_backup
`);
    const result=spawnSync(bash,["--noprofile","--norc","run.sh"],{cwd:root,encoding:"utf8",timeout:10000});
    assert.equal(result.status,0,result.stderr);
    const lines=result.stdout.split(/\r?\n/),expected=scenario==="ordinary"?"/installed":"/verified-candidate";
    assert.equal(lines[0],expected);assert.equal(lines[1],expected+"/server-tools/linux/backup-grabenplaner.sh");
    assert.equal(lines[2],scenario==="runtime-v5"?"--preserve-existing-backups":"");
  });
}

for (const scenario of ["default", "pinned", "wrong-hash", "writable", "non-root", "migration-conflict"]) {
  test(`explicit package verifier trust: ${scenario}`, { skip: !fs.existsSync(bash) }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-verifier-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(path.join(root, "lib/verify-package.js"), "// synthetic verifier\n");
    const hash = require("node:crypto").createHash("sha256").update("// synthetic verifier\n").digest("hex");
    const selection = source.slice(source.indexOf('trusted_package_verifier="$app_dir/'), source.indexOf('if [[ -n "$runtime_v5_transition" ]]; then'));
    assert.ok(selection.includes('package_verifier_sha256'));
    const script = `set -Eeuo pipefail
app_dir=/installed
SCRIPT_DIR="$PWD"
verification_policy=auto
package_verifier_sha256=${scenario === "default" ? "''" : scenario === "wrong-hash" ? "a".repeat(64) : hash}
runtime_v5_transition=${scenario === "migration-conflict" ? "conflict" : "''"}
gp_die() { exit 42; }
gp_info() { :; }
gp_validate_sha256() { [[ "$1" =~ ^[a-f0-9]{64}$ ]]; }
stat() {
 case "$1" in
  --format=%u:%h) printf '${scenario === "non-root" ? "1000" : "0"}:1\\n';;
  --format=%u) printf '0\\n';;
  --format=%a) printf '${scenario === "writable" ? "777" : "755"}\\n';;
 esac
}
${selection}
printf '%s\\n' "$trusted_package_verifier" "$installed_runtime_verifier" "$verification_policy"
`;
    fs.writeFileSync(path.join(root, "run.sh"), script);
    const result = spawnSync(bash, ["--noprofile", "--norc", "run.sh"], { cwd: root, encoding: "utf8", timeout: 10000 });
    if (["default", "pinned"].includes(scenario)) {
      assert.equal(result.status, 0, result.stderr);
      const lines = result.stdout.trim().split(/\r?\n/);
      assert.equal(lines[1], "/installed/server-tools/linux/lib/verify-package.js");
      assert.equal(lines[2], scenario === "pinned" ? "full" : "auto");
      assert.equal(lines[0].endsWith("/lib/verify-package.js"), true);
      assert.equal(lines[0] === lines[1], scenario === "default");
    } else assert.equal(result.status, 42, result.stderr);
  });
}

for (const scenario of ["short", "full", "failed-readiness", "failed-schedule", "xoffi", "failed-xoffi", "invalid-xoffi", "import-delete", "failed-import-delete", "invalid-import-delete"]) {
  test(`actual updater orchestration: ${scenario}`, { skip: !fs.existsSync(bash) }, t => {
    assert.ok(source.indexOf(entry) > 0);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-deploy-shell-"));
    t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
    const write = (relative, content) => {
      const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, { mode: 0o755 });
    };
    write("app/old.txt", "old application");
    write("candidate/server-tools/linux/test-grabenplaner-server.sh", '#!/usr/bin/env bash\nprintf "short-checks\\n" >> "$EVENTS_FILE"\n');
    const xoffi = scenario.includes("xoffi");
    const importDelete = scenario.includes("import-delete");
    if (importDelete) write("candidate/server-tools/linux/lib/import-delete-migrate.js", `
const fs=require('node:fs');
fs.appendFileSync(process.env.EVENTS_FILE, 'import-migration\\n');
require('node:assert/strict').deepEqual(process.argv.slice(2), ['${"a".repeat(64)}','--maintenance-lock-held']);
${scenario === "failed-import-delete" ? "process.exit(42);" : `console.log(JSON.stringify({verified:${scenario !== "invalid-import-delete"},coreUnchanged:true}));`}
`);
    if (xoffi) write("candidate/server-tools/linux/lib/xoffi-snapshots-migrate.js", `
const fs=require('node:fs');
fs.appendFileSync(process.env.EVENTS_FILE, 'schema-migration\\n');
require('node:assert/strict').deepEqual(process.argv.slice(2), ['${"a".repeat(64)}','--maintenance-lock-held']);
${scenario === "failed-xoffi" ? "process.exit(42);" : `console.log(JSON.stringify({verified:${scenario !== "invalid-xoffi"},salesUnchanged:true}));`}
`);
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
database_provider=${importDelete ? "postgresql" : "sqlite"}
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
xoffi_snapshots_migration=${xoffi ? 1 : 0}
schema_migration_result="$PWD/migration.json"
backup_count=0
gp_info() { :; }
gp_warn() { printf 'warning\\n' >> "$EVENTS_FILE"; }
gp_die() { printf 'failed\\n' >> "$EVENTS_FILE"; return 1; }
begin_deploy_phase() { printf 'phase:%s\\n' "$1" >> "$EVENTS_FILE"; }
finish_deploy_phase() { :; }
gp_begin_update_backup_ownership() { printf 'owner\\n' >> "$EVENTS_FILE"; }
gp_stop_service() { printf 'stop\\n' >> "$EVENTS_FILE"; }
gp_start_service() { printf 'start\\n' >> "$EVENTS_FILE"; }
gp_configure_nightly_backups() { printf 'schedule-converged\\n' >> "$EVENTS_FILE"; ${scenario === "failed-schedule" ? "return 1" : ":"}; }
gp_wait_ready() { ${scenario === "failed-readiness" ? "return 1" : ":"}; }
gp_apply_app_permissions() { :; }
gp_sha256() { printf '${"a".repeat(64)}'; }
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
    if (["failed-readiness", "failed-schedule", "failed-xoffi", "invalid-xoffi", "failed-import-delete", "invalid-import-delete"].includes(scenario)) {
      assert.notEqual(result.status, 0); assert.ok(events.includes("failed")); assert.ok(!events.includes("commit")); assert.ok(!events.includes("queue-assurance"));
      if (xoffi) { assert.ok(events.includes("schema-migration")); assert.ok(!events.includes("start")); }
      if (importDelete) { assert.ok(events.includes("import-migration")); assert.ok(!events.includes("start")); }
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(events.filter(event => event === "verified-backup").length, scenario === "full" ? 2 : 1);
      assert.equal(events.filter(event => event === "start").length, scenario === "full" ? 2 : 1);
      assert.equal(events.includes("offsite-transfer"), scenario === "full");
      assert.equal(events.includes("start-assurance"), scenario === "full");
      assert.ok(events.indexOf("owner") < events.indexOf("stop"));
      assert.ok(events.indexOf("schedule-converged") > events.indexOf("start"));
      assert.ok(events.indexOf("schedule-converged") < events.indexOf("short-checks"));
      assert.ok(events.indexOf("short-checks") < events.indexOf("success-receipt"));
      assert.ok(events.indexOf("commit") < events.indexOf("queue-assurance"));
      assert.ok(fs.existsSync(path.join(root, "previous/old.txt")));
      assert.equal(events.includes("import-migration"), importDelete);
      if (importDelete) {
        assert.ok(events.indexOf("import-migration") > events.indexOf("verified-backup"));
        assert.ok(events.indexOf("import-migration") < events.indexOf("start"));
      }
      if (xoffi) {
        assert.ok(events.indexOf("schema-migration") > events.indexOf("database-lock"));
        assert.ok(events.indexOf("schema-migration") < events.indexOf("start"));
        assert.equal(JSON.parse(fs.readFileSync(path.join(root,"migration.json"),"utf8")).verified,true);
      }
    }
  });
}
