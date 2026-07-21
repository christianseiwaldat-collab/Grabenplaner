"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const assurance = fs.readFileSync(path.join(root, "server-tools/linux/offsite/grabenplaner-offsite-assurance.sh"), "utf8");
const common = fs.readFileSync(path.join(root, "server-tools/linux/offsite/lib/offsite-common.sh"), "utf8");
const upload = fs.readFileSync(path.join(root, "server-tools/linux/offsite/grabenplaner-offsite-upload.sh"), "utf8");
const check = fs.readFileSync(path.join(root, "server-tools/linux/offsite/grabenplaner-offsite-check.sh"), "utf8");
const restore = fs.readFileSync(path.join(root, "server-tools/linux/offsite/grabenplaner-offsite-restore-test.sh"), "utf8");
const recoverySet = fs.readFileSync(path.join(root, "server-tools/linux/offsite/grabenplaner-offsite-recovery-set.sh"), "utf8");
const rebind = fs.readFileSync(path.join(root, "server-tools/linux/offsite/grabenplaner-offsite-rebind-rclone.sh"), "utf8");
const installer = fs.readFileSync(path.join(root, "server-tools/linux/offsite/install-grabenplaner-offsite.sh"), "utf8");
const updater = fs.readFileSync(path.join(root, "server-tools/linux/update-grabenplaner-server.sh"), "utf8");
const unit = fs.readFileSync(path.join(root, "server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance@.service.in"), "utf8");

test("v0.76 runs the exact signed assurance phases in the approved order", () => {
  const phases = [
    "full-assurance-started",
    "oauth-policy-passed",
    "backup-passed",
    "repository-check-passed",
    "restore-test-passed",
    "application-smoke-not-run",
    "full-assurance-passed",
  ];
  let cursor = -1;
  for (const phase of phases) {
    const next = assurance.indexOf(`record_event ${phase}`, cursor + 1);
    assert.ok(next > cursor, phase);
    cursor = next;
  }
  assert.match(assurance, /record_event full-assurance-failed --error-code "\$failure_code"/);
  for (const code of ["CONFIGURATION_VERIFY_FAILED", "PREPARE_FAILED", "UPLOAD_FAILED", "FULL_CHECK_FAILED", "RESTORE_TEST_FAILED"]) {
    assert.match(assurance, new RegExp(`failure_code="${code}"`));
  }
});

test("v0.76 serializes assurance through one repository lock and never exposes full snapshot identifiers", () => {
  assert.match(common, /exec 7<>"\$OFFSITE_ASSURANCE_LOCK"[\s\S]*flock --wait 14400 7/);
  const maintenance = assurance.indexOf('exec 6<>"$maintenance_lock"');
  const assuranceLock = assurance.indexOf("offsite_acquire_assurance_lock");
  const prepare = assurance.indexOf('grabenplaner-offsite-prepare.sh" --lock-already-held');
  const repositoryLock = assurance.indexOf("offsite_acquire_repository_lock", prepare);
  const uploadRun = assurance.indexOf('grabenplaner-offsite-upload.sh" --lock-already-held', repositoryLock);
  const checkRun = assurance.indexOf('grabenplaner-offsite-check.sh" --lock-already-held', uploadRun);
  const restoreRun = assurance.indexOf('grabenplaner-offsite-restore-test.sh" --lock-already-held', checkRun);
  assert.ok(maintenance > 0 && assuranceLock > maintenance);
  assert.ok(prepare > assuranceLock && repositoryLock > prepare && uploadRun > repositoryLock
    && checkRun > uploadRun && restoreRun > checkRun);
  assert.equal(assurance.match(/offsite_acquire_repository_lock/g)?.length, 1);
  for (const child of [upload, check, restore]) {
    assert.match(child, /--lock-already-held\) lock_already_held=1/);
    assert.match(child, /lock_already_held == 1[\s\S]*offsite_assert_inherited_repository_lock[\s\S]*else[\s\S]*offsite_acquire_repository_lock/);
  }
  assert.match(common, /offsite_assert_inherited_lock\(\)/);
  assert.match(common, /\/proc\/\$\$\/fd\/\$descriptor/);
  assert.match(common, /descriptor_target" == "\$expected"/);
  assert.match(common, /flock --nonblock "\$descriptor"/);
  assert.doesNotMatch(assurance, /--snapshot-id|snapshotId[^P]/);
  assert.match(assurance, /\^\[a-f0-9\]\{12\}\$/);
  assert.match(restore, /snapshotIdPrefix/);
  assert.match(restore, /receiptSha256/);
  assert.doesNotMatch(restore, /offsite_info[^\n]*\$snapshot_id/);
  assert.match(restore, /offsite_info[^\n]*\$\{snapshot_id:0:12\}/);
});

test("v0.76 queues automatic assurance only after a committed update or OAuth rebind", () => {
  const committed = updater.indexOf("update_committed=1");
  const updateEvent = updater.indexOf("offsite_record_assurance_queue update-queued app-updated", committed);
  const queued = updater.indexOf("grabenplaner-offsite-assurance@app-updated.service");
  assert.ok(committed > 0 && updateEvent > committed && queued > updateEvent);
  assert.match(updater, /gp_warn "Das erfolgreiche App-Update konnte nicht im signierten Recovery-Assurance-Verlauf vorgemerkt werden\."/);
  assert.match(updater, /systemctl start --no-block grabenplaner-offsite-assurance@app-updated\.service/);
  const rebindComplete = rebind.indexOf("rebind_complete=1");
  const oauthEvent = rebind.indexOf("offsite_record_assurance_queue configuration-change-queued oauth-config-changed");
  const oauthQueued = rebind.indexOf("grabenplaner-offsite-assurance@oauth-config-changed.service");
  assert.ok(oauthEvent > 0 && oauthQueued > oauthEvent && rebindComplete > oauthQueued);
  assert.ok(rebind.indexOf("offsite_acquire_assurance_lock") < oauthQueued);
  assert.match(common, /offsite_record_assurance_queue\(\)/);
  assert.match(common, /configuration-change-queued:oauth-config-changed/);
  assert.match(common, /update-queued:app-updated/);
});

test("v0.76 records configuration or module installation before it queues assurance", () => {
  const committed = installer.indexOf("setup_complete=1");
  const event = installer.indexOf("offsite_record_assurance_queue configuration-change-queued", committed);
  const queued = installer.indexOf('systemctl start --no-block "grabenplaner-offsite-assurance@${assurance_trigger}.service"', event);
  assert.ok(committed > 0 && event > committed && queued > event);
  assert.match(installer, /assurance_trigger="offsite-config-changed"/);
  assert.match(installer, /assurance_trigger="offsite-module-changed"/);
  assert.match(installer, /offsite_warn "Die erfolgreiche Offsite-Einrichtung konnte nicht im signierten Recovery-Assurance-Verlauf vorgemerkt werden\."/);
});

test("v0.76 installs a hardened parameterized service without adding a schedule", () => {
  assert.match(unit, /ExecStart=.*--trigger %i/);
  assert.match(unit, /NoNewPrivileges=yes/);
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(unit, /ProtectHome=yes/);
  assert.match(unit, /ReadWritePaths=.*\/var\/lib\/grabenplaner-assurance/);
  assert.match(unit, /TimeoutStartSec=40h/);
  assert.equal(fs.existsSync(path.join(root, "server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance.timer.in")), false);
});

test("v0.76 accepts only allowlisted trigger names and fixed evidence fields", () => {
  for (const trigger of [
    "scheduled-weekly", "oauth-config-changed", "offsite-config-changed", "binary-changed",
    "offsite-module-changed", "app-updated", "server-updated", "manual-cli",
  ]) assert.match(assurance, new RegExp(trigger));
  for (const forbidden of ["client_secret", "client-id", "access_token", "refresh_token", "password="]) {
    assert.equal(assurance.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test("v0.76 prepares a verified root-only offline recovery set without cloud-side writes", () => {
  assert.match(recoverySet, /export --output \/root\/grabenplaner-recovery-set-DATUM --yes/);
  assert.match(recoverySet, /verify --input \/root\/grabenplaner-recovery-set-DATUM/);
  assert.match(recoverySet, /format: "grabenplaner-offline-recovery-set"/);
  for (const item of [
    "restic-password", "rclone.conf", "rclone-config-password", "grabenplaner.env",
    "repository-id", "installation-id", "binary-pins.json", "offsite-installed-contract.json",
    "assurance/head.json", "assurance/signing-private.pem", "assurance/signing-public.pem",
  ]) assert.match(recoverySet, new RegExp(item.replace(".", "\\.")));
  assert.match(recoverySet, /historyPattern = \/\^assurance\\\/history\\\/\\d\{12\}-\[a-f0-9\]\{64\}\\\.json\$\//);
  assert.match(recoverySet, /cp --archive --reflink=never -- "\$OFFSITE_ASSURANCE_HISTORY\/\."/);
  assert.match(recoverySet, /manifestStat\.uid !== 0 \|\| manifestStat\.gid !== 0/);
  assert.match(recoverySet, /manifestStat\.mode & 0o7777\) !== 0o600/);
  assert.match(recoverySet, /stat\.gid !== expectedGid/);
  assert.match(recoverySet, /stat\.mode & 0o7777\) !== expectedMode/);
  const maintenanceLock = recoverySet.indexOf("gp_acquire_maintenance_lock");
  const assuranceLock = recoverySet.indexOf("offsite_acquire_assurance_lock");
  const repositoryLock = recoverySet.indexOf("offsite_acquire_repository_lock");
  const liveSecretRead = recoverySet.indexOf("offsite_assert_runtime_binaries", repositoryLock);
  assert.ok(maintenanceLock > 0 && assuranceLock > maintenanceLock && repositoryLock > assuranceLock
    && liveSecretRead > repositoryLock);
  const published = recoverySet.indexOf('mv -T -- "$temporary" "$output"');
  const durable = recoverySet.indexOf('sync -f "$output"', published);
  const verifiedPublished = recoverySet.indexOf('verify_set "$output"', durable);
  assert.ok(published > liveSecretRead && durable > published && verifiedPublished > durable);
  assert.doesNotMatch(recoverySet, /rclone (copy|sync)|restic (backup|restore)|curl /);
});
