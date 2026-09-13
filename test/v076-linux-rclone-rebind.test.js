"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const scriptPath = path.join(root, "server-tools", "linux", "offsite", "grabenplaner-offsite-rebind-rclone.sh");
const script = fs.readFileSync(scriptPath, "utf8");
const installer = fs.readFileSync(path.join(root, "server-tools", "linux", "offsite", "install-grabenplaner-offsite.sh"), "utf8");
const uninstaller = fs.readFileSync(path.join(root, "server-tools", "linux", "offsite", "uninstall-grabenplaner-offsite.sh"), "utf8");
const selfTest = fs.readFileSync(path.join(root, "server-tools", "linux", "offsite", "test-grabenplaner-offsite.sh"), "utf8");
const setupWrapper = fs.readFileSync(path.join(root, "server-tools", "linux", "offsite", "lib", "offsite-setup-rclone-wrapper.sh"), "utf8");
const schema = JSON.parse(fs.readFileSync(path.join(root, "server-tools", "linux", "offsite", "module-schema.json"), "utf8"));

test("v0.76 rclone rebind requires explicit root-only canonical credential files", () => {
  assert.match(script, /offsite_require_root/);
  assert.match(script, /--rclone-config\)/);
  assert.match(script, /--rclone-config-password\)/);
  assert.match(script, /--yes\) confirmed=1/);
  assert.match(script, /confirmed == 1/);
  assert.match(script, /realpath --canonicalize-existing/);
  assert.match(script, /resolved" == "\$source/);
  assert.match(script, /0:0:600:1/);
  assert.match(script, /RCLONE_ENCRYPT_V0:/);
});

test("v0.76 validates the bound provider candidate and the pinned repository before commit", () => {
  const policy = script.indexOf('config redacted "$remote"');
  const repositoryProbe = script.indexOf('setup_restic cat config');
  const identityComparison = script.indexOf('candidate_repository_id" == "$expected_repository_id');
  const commit = script.lastIndexOf("commit_started=1");
  assert.ok(policy >= 0);
  assert.ok(repositoryProbe > policy);
  assert.ok(identityComparison > repositoryProbe);
  assert.ok(commit > identityComparison);
  assert.match(script, /OFFSITE_RCLONE_POLICY_HELPER/);
  assert.match(script, /offsite_verify_repository_identity "\$post_credentials"/);
  assert.doesNotMatch(script, /setup_restic\s+init|restic\s+init|--initialize-repository/);
  assert.doesNotMatch(script, /config\s+show/);
});

test("v0.76 serializes rebind with maintenance and repository locks and restores timer state", () => {
  const maintenanceLock = script.indexOf("gp_acquire_maintenance_lock");
  const pause = script.indexOf('systemctl disable --now "${timers[index]}"');
  const repositoryLock = script.indexOf("offsite_acquire_repository_lock");
  const candidateProbe = script.indexOf('config redacted "$remote"', repositoryLock);
  assert.ok(maintenanceLock >= 0);
  assert.ok(pause > maintenanceLock);
  assert.ok(repositoryLock > pause);
  assert.ok(candidateProbe > repositoryLock);
  assert.match(script, /timer_was_enabled/);
  assert.match(script, /timer_was_active/);
  assert.match(script, /restore_timer_state/);
  assert.match(script, /systemctl enable "\$\{timers\[index\]\}"/);
  assert.match(script, /systemctl start "\$\{timers\[index\]\}"/);
});

test("v0.76 repeats live runtime and credential validation after all rebind locks", () => {
  const repositoryLock = script.indexOf("offsite_acquire_repository_lock");
  const runtimeRecheck = script.indexOf("offsite_assert_runtime_binaries", repositoryLock);
  const configRecheck = script.indexOf("offsite_assert_persistent_rclone_config", repositoryLock);
  const passwordRecheck = script.indexOf('offsite_assert_regular_root_file "$OFFSITE_CONFIG_ROOT/rclone-config-password"', repositoryLock);
  const remoteRecheck = script.indexOf('locked_remote="$(offsite_repository_remote', repositoryLock);
  const candidateProbe = script.indexOf('config redacted "$remote"', repositoryLock);
  assert.ok(repositoryLock > 0 && runtimeRecheck > repositoryLock && configRecheck > runtimeRecheck
    && passwordRecheck > configRecheck && remoteRecheck > passwordRecheck && candidateProbe > remoteRecheck);
  assert.match(script, /locked_repository_id/);
  assert.match(script, /Die bestehende Repository-Bindung hat sich waehrend der Sperruebernahme geaendert/);
});

test("v0.76 swaps both credential files through same-directory renames and fully rolls back bytes", () => {
  assert.match(script, /mktemp --tmpdir="\$OFFSITE_CREDENTIAL_STATE_ROOT" \.rclone\.conf\.rebind/);
  assert.match(script, /mktemp --tmpdir="\$OFFSITE_CONFIG_ROOT" \.rclone-config-password\.rebind/);
  assert.match(script, /mv -f -- "\$config_next" "\$OFFSITE_RCLONE_CONFIG"/);
  assert.match(script, /mv -f -- "\$password_next" "\$OFFSITE_CONFIG_ROOT\/rclone-config-password"/);
  assert.match(script, /restore_original_credentials/);
  assert.match(script, /\.rclone\.conf\.rollback/);
  assert.match(script, /\.rclone-config-password\.rollback/);
  assert.match(script, /cmp --silent -- "\$operation_root\/original-rclone\.conf" "\$OFFSITE_RCLONE_CONFIG"/);
  assert.match(script, /cmp --silent -- "\$operation_root\/original-rclone-config-password" "\$OFFSITE_CONFIG_ROOT\/rclone-config-password"/);
  assert.ok(script.lastIndexOf("commit_started=1") < script.indexOf('mv -f -- "$config_next"'));
});

test("v0.76 uses a wrapper-compatible isolated setup directory that can persist OAuth refreshes", () => {
  assert.match(script, /mktemp --directory --tmpdir="\$OFFSITE_RUN_ROOT" setup\.XXXXXXXX/);
  assert.match(script, /chown "root:\$OFFSITE_GROUP" -- "\$setup_root"/);
  assert.match(script, /chmod 0750 -- "\$setup_root"/);
  assert.match(script, /install -d -m 0700 -o "\$OFFSITE_USER" -g "\$OFFSITE_GROUP" -- "\$setup_root\/config"/);
  assert.match(script, /"\$setup_root\/config\/rclone\.conf"/);
  assert.match(script, /GRABENPLANER_OFFSITE_SETUP_ROOT="\$setup_root"/);
  assert.match(script, /rm -rf --one-file-system -- "\$setup_root"/);
  assert.match(setupWrapper, /0:grabenplaner-offsite:750/);
  assert.match(setupWrapper, /grabenplaner-offsite:grabenplaner-offsite:700/);
  assert.match(setupWrapper, /"\$config_root\/rclone\.conf"/);
});

test("v0.76 packages, installs, verifies and removes the controlled rebind command", () => {
  assert.equal(schema.moduleVersion, 9);
  assert.ok(schema.managedArtifacts.includes("server-tools/linux/offsite/grabenplaner-offsite-assurance.sh"));
  assert.ok(schema.managedArtifacts.includes("server-tools/linux/offsite/grabenplaner-offsite-recovery-set.sh"));
  assert.ok(schema.managedArtifacts.includes("server-tools/linux/offsite/grabenplaner-offsite-rebind-rclone.sh"));
  assert.ok(schema.managedArtifacts.includes("server-tools/linux/offsite/lib/assurance-history.js"));
  assert.ok(schema.managedArtifacts.includes("server-tools/linux/offsite/lib/offsite-rclone-policy.js"));
  assert.ok(schema.managedArtifacts.includes("server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance@.service.in"));
  assert.match(installer, /\[grabenplaner-offsite-assurance\]="\$OFFSITE_MODULE_ROOT\/grabenplaner-offsite-assurance\.sh"/);
  assert.match(installer, /\[grabenplaner-offsite-recovery-set\]="\$OFFSITE_MODULE_ROOT\/grabenplaner-offsite-recovery-set\.sh"/);
  assert.match(installer, /\[grabenplaner-offsite-rebind-rclone\]="\$OFFSITE_MODULE_ROOT\/grabenplaner-offsite-rebind-rclone\.sh"/);
  assert.match(installer, /assurance-history\.js" init/);
  assert.match(installer, /assurance_root_had_original/);
  assert.match(uninstaller, /grabenplaner-offsite-assurance/);
  assert.match(uninstaller, /grabenplaner-offsite-recovery-set/);
  assert.match(uninstaller, /grabenplaner-offsite-rebind-rclone/);
  assert.match(selfTest, /assurance_link="\/usr\/local\/sbin\/grabenplaner-offsite-assurance"/);
  assert.match(selfTest, /recovery_set_link="\/usr\/local\/sbin\/grabenplaner-offsite-recovery-set"/);
  assert.match(selfTest, /offsite_assurance_history inspect/);
  assert.match(selfTest, /rebind_link="\/usr\/local\/sbin\/grabenplaner-offsite-rebind-rclone"/);
});

test("v0.76 rebind leaves the application and status writer untouched", () => {
  assert.doesNotMatch(script, /OFFSITE_APP_SERVICE|grabenplaner\.service|systemctl\s+(?:restart|stop|start)\s+.*grabenplaner\.service/);
  assert.doesNotMatch(script, /OFFSITE_STATUS_FILE|offsite_status\s|status\.json/);
  assert.doesNotMatch(script, /client[_-]?secret[^\n]*(?:printf|echo)|token[^\n]*(?:printf|echo)/i);
  assert.doesNotMatch(script, /set\s+-x|config\s+show/);
});
