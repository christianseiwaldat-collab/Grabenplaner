"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("v0.74 exposes an explicit root-only four-phase recovery without implicit latest or destructive repository maintenance", () => {
  const script = read("server-tools/linux/recovery/grabenplaner-recovery.sh");
  assert.match(script, /offsite_require_root/);
  for (const phase of ["list", "prepare", "verify", "apply"]) assert.match(script, new RegExp(`\\n  ${phase}\\)`));
  assert.match(script, /\^\[a-f0-9\]\{64\}\$/);
  assert.match(script, /--confirm-snapshot/);
  assert.match(script, /--confirm-recovery/);
  assert.match(script, /"\$confirm_snapshot" == "\$snapshot_id" && "\$confirm_recovery" == "\$recovery_id"/);
  assert.doesNotMatch(script, /restore\s+latest/);
  assert.doesNotMatch(script, /\b(?:init|unlock|repair|forget|prune)\b/);
  assert.match(script, /systemctl is-active --quiet "\$OFFSITE_APP_SERVICE"/);
  assert.match(script, /systemctl is-active --quiet "\$RECOVERY_CADDY_SERVICE"/);
  assert.doesNotMatch(script, /systemctl (?:start|restart) /);
  assert.match(script, /pre-restore-safety\.json/);
  assert.match(script, /pre-recovery-\$recovery_id/);
  assert.match(script, /Dienste wurden absichtlich nicht gestartet/);
});

test("v0.74 freezes downloaded trees, verifies capacity and binds repository, installation, host, tag and source path", () => {
  const script = read("server-tools/linux/recovery/grabenplaner-recovery.sh");
  const metadata = read("server-tools/linux/recovery/lib/recovery-metadata.js");
  assert.match(script, /stats --mode restore-size --json "\$snapshot_id"/);
  assert.match(script, /df --block-size=1 --output=avail/);
  assert.match(script, /offsite_verify_repository_identity/);
  assert.match(script, /snapshots --json --host "\$installation_host" --tag grabenplaner-offsite --path "\$RECOVERY_SOURCE_PATH"/);
  assert.match(script, /restore "\$snapshot_id" --host "\$installation_host" --tag grabenplaner-offsite/);
  assert.match(script, /chown root:root -- "\$restore_root"[\s\S]*chmod 0700 -- "\$restore_root"/);
  assert.match(script, /-type l -o -type f -links \+1/);
  assert.match(script, /find "\$restore_root" -xdev -type d -exec chmod 0500/);
  assert.match(script, /find "\$restore_root" -xdev -type f -exec chmod 0400/);
  assert.match(metadata, /snapshot\.hostname !== `grabenplaner-\$\{installationId\}`/);
  assert.match(metadata, /receipt\?\.repositoryId !== repositoryId/);
  assert.match(metadata, /receipt\?\.sourcePath !== expectedPath/);
});

test("v0.74 locks live data before creating a durable pre-restore safety tree", () => {
  const apply = read("server-tools/linux/recovery/lib/recovery-apply.js");
  const lockIndex = apply.indexOf("const lock = acquireDatabaseLock");
  const safetyIndex = apply.indexOf("createSafetySnapshot({", lockIndex);
  const moveIndex = apply.indexOf("fs.renameSync(item.target, item.previous)", safetyIndex);
  const receiptIndex = apply.indexOf("atomicJson(path.resolve(values.output), receipt)", moveIndex);
  const releaseIndex = apply.indexOf("releaseDatabaseLock(lock)", receiptIndex);
  assert.ok(lockIndex > 0 && safetyIndex > lockIndex && moveIndex > safetyIndex && receiptIndex > moveIndex && releaseIndex > receiptIndex);
  assert.match(apply, /freezeTree\(live\);\s*fsyncTree\(live\);\s*const result = writeSafetyReceipt/s);
  assert.match(apply, /fsyncDirectory\(root\);\s*fsyncDirectory\(path\.dirname\(root\)\);\s*fsyncDirectory\(path\.dirname\(path\.dirname\(root\)\)\)/s);
  assert.match(apply, /safety = verifySafetyReceipt\(safetyReceiptPath/);
});

test("v0.74 installs and removes only the supervised recovery command with the optional offsite module", () => {
  const install = read("server-tools/linux/offsite/install-grabenplaner-offsite.sh");
  const uninstall = read("server-tools/linux/offsite/uninstall-grabenplaner-offsite.sh");
  assert.match(install, /recovery_command="\$OFFSITE_APP_ROOT\/server-tools\/linux\/recovery\/grabenplaner-recovery\.sh"/);
  assert.match(install, /\[grabenplaner-recovery\]="\$recovery_command"/);
  assert.match(uninstall, /grabenplaner-recovery/);
  assert.match(uninstall, /expected_recovery="\$OFFSITE_APP_ROOT\/server-tools\/linux\/recovery\/grabenplaner-recovery\.sh"/);
});

test("v0.74 requires every recovery helper in both package verification stages", () => {
  const installer = read("server-tools/linux/install-grabenplaner-server.sh");
  const verifier = read("server-tools/linux/lib/verify-package.js");
  const builder = read("server-tools/package/New-GrabenplanerLinuxServerPackage.ps1");
  for (const relative of [
    "server-tools/linux/recovery/grabenplaner-recovery.sh",
    "server-tools/linux/recovery/lib/recovery-apply.js",
    "server-tools/linux/recovery/lib/recovery-metadata.js",
    "server-tools/linux/recovery/lib/recovery-verify.js",
  ]) {
    assert.match(installer, new RegExp(relative.replaceAll("/", "\\/").replaceAll(".", "\\.")));
    assert.match(verifier, new RegExp(relative.replaceAll("/", "\\/").replaceAll(".", "\\.")));
    assert.match(builder, new RegExp(relative.replaceAll("/", "[\\\\/]").replaceAll(".", "\\.")));
  }
});

test("v0.74 quarterly restore test resolves latest only for testing, restores its full exact id and records the smoke-test boundary", () => {
  const script = read("server-tools/linux/offsite/grabenplaner-offsite-restore-test.sh");
  const metadata = read("server-tools/linux/recovery/lib/recovery-metadata.js");
  assert.match(script, /select-latest/);
  assert.match(script, /snapshot_id=.*\^\[a-f0-9\]\{64\}\$/s);
  assert.match(script, /restore "\$snapshot_id"/);
  assert.doesNotMatch(script, /restore latest/);
  assert.match(script, /offsite_status failure --code RESTORE_TEST_FAILED/);
  assert.ok(script.indexOf("offsite_status failure --code RESTORE_TEST_FAILED") < script.indexOf("for command_name in"));
  assert.match(script, /offsite_status restore-test/);
  assert.match(metadata, /RECOVERY_TEST_MODE_UNAVAILABLE/);
  assert.match(metadata, /Kein nachweislich nebenwirkungsfreier isolierter App-Testmodus vorhanden/);
});
