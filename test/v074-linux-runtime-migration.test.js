"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const migration = read("server-tools", "linux", "migrate-grabenplaner-runtime-v2.sh");

test("v0.74 ships an explicit package-bound runtime schema 1 to 2 migration", () => {
  assert.match(migration, /gp_require_root/);
  assert.match(migration, /actual_package_sha256=.*gp_sha256/);
  assert.match(migration, /candidate_verifier=.*verify-package\.js/);
  assert.match(migration, /cmp --silent -- "\$SCRIPT_PATH".*migrate-grabenplaner-runtime-v2\.sh/);
  assert.match(migration, /old\.deploymentSchemaVersion!==1\|\|next\?\.deploymentSchemaVersion!==2/);
  assert.match(migration, /Schema 1 -> 2/);
  assert.ok(migration.indexOf("actual_package_sha256=") < migration.indexOf("gp_acquire_maintenance_lock"));
  assert.ok(migration.indexOf("Manifest- und Einzeldateipruefung") < migration.indexOf("gp_acquire_maintenance_lock"));
  assert.match(migration, /chmod 0711 -- "\$work_root"/);
  assert.match(migration, /chown "root:\$build_group" -- "\$staged_package"/);
  assert.match(migration, /chmod 0640 -- "\$staged_package"/);
  assert.ok(migration.indexOf('chmod 0711 -- "$work_root"') < migration.indexOf('runuser --user "$build_user" -- unzip'));
  assert.ok(migration.indexOf("trap early_cleanup EXIT") < migration.indexOf('chown root:root -- "$work_root"'));
});

test("v0.74 migration preserves the completed bootstrap and existing administrative identity", () => {
  assert.match(migration, /GRABENPLANER_BOOTSTRAP_TOKEN:-/);
  assert.match(migration, /portal_users WHERE active=1 AND role IN \('developer','it_admin','admin'\)/);
  assert.match(migration, /systemctl is-active --quiet "\$BOOTSTRAP_SERVICE"/);
  assert.match(migration, /bootstrapReopened:false/);
  assert.doesNotMatch(migration, /grabenplaner-bootstrap-admin["']?\s+start/);
  assert.doesNotMatch(migration, /install-grabenplaner-server\.sh/);
});

test("v0.74 migration binds monitor runtime before delegating the backed-up app swap", () => {
  for (const value of [
    "grabenplaner-monitor.service.in",
    "grabenplaner-monitor.timer.in",
    "monitor-status.js",
    "systemctl enable --now grabenplaner-monitor.timer",
    "--lock-already-held",
  ]) assert.ok(migration.includes(value), `Migrationsvertrag fehlt: ${value}`);
  assert.match(migration, /update_args=\([\s\S]*--package "\$staged_package"[\s\S]*--lock-already-held/);
  assert.match(migration, /commit\?\.verification\?\.status!=="verified"/);
  assert.match(migration, /sha256:commit\.database\.sha256/);
  assert.ok(migration.indexOf("systemctl enable --now grabenplaner-monitor.timer") < migration.indexOf("bash \"$extract_root/server-tools/linux/update-grabenplaner-server.sh\""));
});

test("v0.74 migration marks each destructive transition before another fallible operation", () => {
  const runtimeMove = migration.indexOf('mv -T -- "$app_dir/server-tools/linux" "$rollback_root/linux-schema1"');
  const runtimeIntent = migration.lastIndexOf('write_phase "runtime-swap-intent"', runtimeMove);
  const runtimeFlag = migration.lastIndexOf("runtime_swapped=1", runtimeMove);
  const runtimeCopy = migration.indexOf('cp --archive -- "$extract_root/server-tools/linux"', runtimeMove);
  assert.ok(runtimeIntent >= 0 && runtimeFlag > runtimeIntent && runtimeFlag < runtimeMove && runtimeMove < runtimeCopy);

  const offsiteMove = migration.indexOf('mv -T -- "$OFFSITE_MODULE_ROOT" "$rollback_root/offsite-module"');
  const offsiteIntent = migration.lastIndexOf('write_phase "offsite-swap-intent"', offsiteMove);
  const offsiteFlag = migration.lastIndexOf("offsite_swapped=1", offsiteMove);
  const offsiteCopy = migration.indexOf('cp --archive -- "$app_dir/server-tools/linux/offsite"', offsiteMove);
  assert.ok(offsiteIntent >= 0 && offsiteFlag > offsiteIntent && offsiteFlag < offsiteMove && offsiteMove < offsiteCopy);

  const recoveryLink = migration.indexOf('ln -s -- "$app_dir/server-tools/linux/recovery/grabenplaner-recovery.sh" /usr/local/sbin/grabenplaner-recovery');
  const recoveryIntent = migration.lastIndexOf('write_phase "recovery-link-intent"', recoveryLink);
  const recoveryFlag = migration.lastIndexOf("recovery_link_created=1", recoveryLink);
  assert.ok(recoveryIntent >= 0 && recoveryFlag > recoveryIntent && recoveryFlag < recoveryLink);
  assert.match(migration, /monitor_membership_added/);
  assert.match(migration, /gpasswd --delete/);
  assert.match(migration, /monitor_group_created/);
  assert.match(migration, /groupdel/);
  assert.match(migration, /monitor_status_root_created/);
});

test("v0.74 migration preserves and rebinds configured offsite without replacing secrets", () => {
  assert.match(migration, /verify-installed "\$OFFSITE_MODULE_ROOT" "\$OFFSITE_RECEIPT"/);
  assert.match(migration, /offsite_secret_digest/);
  for (const name of ["restic-password", "rclone-config-password", "rclone.conf", "repository-id"]) {
    assert.ok(migration.includes(name), `Geschuetzte Offsite-Datei fehlt im Erhaltungsnachweis: ${name}`);
  }
  assert.match(migration, /offsite_secrets_after.*offsite_secret_digest/);
  assert.match(migration, /offsite_secrets_after" == "\$offsite_secrets_before/);
  assert.match(migration, /grabenplaner-recovery/);
  assert.match(migration, /recovery_link_created=1/);
  assert.match(migration, /recovery_link_created == 1/);
  assert.ok(migration.indexOf("Ein vorhandener grabenplaner-recovery-Befehl") < migration.indexOf('mv -T -- "$OFFSITE_MODULE_ROOT"'));
  assert.match(migration, /offsite_timer_was_active=\(0 0 0\)/);
  assert.match(migration, /offsite_timer_was_active\[index\]=1/);
  assert.match(migration, /offsite_timer_was_active\[index\] == 1/);
  assert.match(migration, /if \(\( offsite_timers_paused == 1 && offsite_configured == 1 \)\); then/);
  assert.match(migration, /offsite_timers_paused=0/);
  assert.ok(migration.indexOf("offsite_timers_paused == 1") < migration.indexOf("if (( migration_complete == 1"));
  const pauseStart = migration.indexOf("offsite_timers_paused=1");
  const updaterStart = migration.indexOf('write_phase "updater-invoked"');
  const successfulRestore = migration.indexOf("offsite_timers_paused=0", updaterStart);
  assert.ok(pauseStart >= 0 && updaterStart > pauseStart);
  assert.equal(migration.slice(pauseStart, updaterStart).includes("offsite_timers_paused=0"), false);
  assert.ok(successfulRestore > updaterStart);
  assert.doesNotMatch(migration, /restic\s+init|rclone\s+config\s+create/);
});

test("v0.74 updater accepts an inherited lock only when FD 9 is bound to the maintenance lock", () => {
  const updater = read("server-tools", "linux", "update-grabenplaner-server.sh");
  assert.match(updater, /--lock-already-held\) lock_already_held=1/);
  assert.match(updater, /readlink -f -- \/proc\/\$\$\/fd\/9/);
  assert.match(updater, /inherited_lock_target" == "\$expected_lock_target/);
  assert.match(updater, /flock --nonblock 9/);
  assert.match(updater, /else\s+gp_acquire_maintenance_lock/);
});

test("v0.74 post-commit errors keep a consistent schema-2 state instead of partial rollback", () => {
  assert.match(migration, /post_update_fail\(\)/);
  assert.match(migration, /POST-UPDATE-ACTION-REQUIRED/);
  assert.match(migration, /kein unsicherer Schema-1-Teilrollback/);
  assert.match(migration, /updater_succeeded == 0/);
  assert.match(migration, /write_phase "updater-invoked"/);
  assert.match(migration, /--commit-marker "\$updater_commit_marker"/);
  assert.match(migration, /updater_commit_is_valid/);
  assert.match(migration, /value\?\.schemaVersion!==1/);
  assert.match(migration, /Date\.parse\(value\?\.committedAt/);
});

test("v0.74 package contracts require the official migration tool", () => {
  for (const file of [
    ["server-tools", "linux", "lib", "verify-package.js"],
    ["server-tools", "linux", "install-grabenplaner-server.sh"],
    ["server-tools", "package", "New-GrabenplanerLinuxServerPackage.ps1"],
  ]) assert.match(read(...file), /migrate-grabenplaner-runtime-v2\.sh/);
  assert.match(read("server-tools", "linux", "RUNTIME-MIGRATIONS.md"), /Offizieller Weg von Schema 1 auf Schema 2/);
});

test("v0.74 migration shell is syntactically valid on POSIX test hosts", { skip: process.platform === "win32" }, () => {
  const result = spawnSync("bash", ["-n", path.join(root, "server-tools/linux/migrate-grabenplaner-runtime-v2.sh")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
