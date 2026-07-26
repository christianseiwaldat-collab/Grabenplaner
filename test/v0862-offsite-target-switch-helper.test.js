"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const helper = read("server-tools/linux/offsite/grabenplaner-offsite-switch-target.sh");
const common = read("server-tools/linux/offsite/lib/offsite-common.sh");

test("v0.86.2: target switch helper exposes only the fixed bounded result contract", () => {
  assert.match(helper, /RESULT_FORMAT="grabenplaner-offsite-target-switch-result"/);
  assert.match(helper, /RESULT_SCHEMA_VERSION=1/);
  assert.match(helper, /if \(\(\$# != 2\)\) \|\| \[\[ "\$1" != "--folder-label" \]\]/);
  assert.match(helper, /\^\[A-Za-z0-9\]\(\[A-Za-z0-9_-\]\{0,46\}\[A-Za-z0-9\]\)\?\$/);
  assert.match(
    helper,
    /"format":"%s","schemaVersion":%d,"ok":%s,"code":"%s","migrationMode":%s,"recoverySetState":%s,"fallbackPreserved":%s/,
  );
  assert.match(helper, /TARGET_SWITCH_REQUEST_INVALID/);
  assert.match(helper, /TARGET_SWITCH_FAILED/);
  assert.match(helper, /TARGET_FOLDER_ACTIVATED/);
  assert.match(helper, /pending-offline-transfer-and-verification/);
  assert.doesNotMatch(helper, /emit_result[^\n]*(?:folder_label|candidate_path|current_path|repository_id|remote)/);
});

test("v0.86.2: switch keeps all three operational locks through copy, recovery export and commit", () => {
  const maintenance = helper.indexOf("gp_acquire_maintenance_lock");
  const assurance = helper.indexOf("offsite_acquire_assurance_lock");
  const repository = helper.indexOf("offsite_acquire_repository_lock");
  const copy = helper.indexOf('copy "$remote:$current_path" "$remote:$candidate_path"');
  const recovery = helper.indexOf("grabenplaner-offsite-recovery-set.sh");
  const commit = helper.indexOf('mv -T -- "$repository_next" "$OFFSITE_CONFIG_ROOT/repository"');
  assert.ok(maintenance > 0);
  assert.ok(assurance > maintenance);
  assert.ok(repository > assurance);
  assert.ok(copy > repository);
  assert.ok(recovery > copy);
  assert.ok(commit > recovery);
});

test("v0.86.2: an empty candidate receives and verifies the complete old repository before identity check", () => {
  assert.match(helper, /lsf "\$remote:\$candidate_path" --max-depth 1/);
  assert.match(
    helper,
    /copy "\$remote:\$current_path" "\$remote:\$candidate_path"[\s\S]*?--max-duration "\$COPY_MAX_DURATION"/,
  );
  assert.match(
    helper,
    /check "\$remote:\$current_path" "\$remote:\$candidate_path"[\s\S]*?--one-way --max-duration 5m/,
  );
  assert.match(
    helper,
    /if \(\( candidate_empty == 1 && pending_marker_present == 0 \)\); then[\s\S]*?create_pending_marker[\s\S]*?fi[\s\S]*?if \(\( pending_marker_present == 1 \)\); then[\s\S]*?migration_mode="copied"[\s\S]*?else[\s\S]*?verify_repository_identity_bounded "\$candidate_credentials"[\s\S]*?fi[\s\S]*?copy "\$remote:\$current_path" "\$remote:\$candidate_path"[\s\S]*?check "\$remote:\$current_path" "\$remote:\$candidate_path"/,
  );
  assert.doesNotMatch(helper, /copyto "\$remote:\$current_path\/config"/);
  const completeCheck = helper.indexOf('check "$remote:$current_path" "$remote:$candidate_path"');
  const identityCheck = helper.indexOf(
    'verify_repository_identity_bounded "$candidate_credentials" "$operation_root/candidate-repository.json"',
    completeCheck,
  );
  assert.ok(completeCheck > 0 && identityCheck > completeCheck);
  assert.doesNotMatch(helper, /\b(?:delete|deletefile|purge|rmdirs|sync)\s+"\$remote:/);
});

test("v0.86.2: interrupted full copies resume only with an exact root-only local marker", () => {
  assert.match(helper, /PENDING_MARKER_FORMAT="grabenplaner-offsite-target-switch-pending"/);
  assert.match(helper, /pending_marker="\$OFFSITE_RECOVERY_SET_ROOT\/target-switch-pending\.json"/);
  assert.match(helper, /offsite_assert_regular_root_file "\$pending_marker"/);
  assert.match(helper, /stat --format='%u:%g:%a:%h' -- "\$pending_marker"\)" == "0:0:600:1"/);
  assert.match(helper, /"createdAt", "folderLabel", "format", "repositoryId", "schemaVersion"/);
  assert.match(helper, /marker\.folderLabel !== expectedLabel/);
  assert.match(helper, /marker\.repositoryId !== expectedId/);
  assert.match(
    helper,
    /fs\.fsyncSync\(descriptor\)[\s\S]*?mv -T -- "\$pending_marker_temporary" "\$pending_marker"[\s\S]*?sync -f "\$OFFSITE_RECOVERY_SET_ROOT"/,
  );
  const markerCreate = helper.indexOf("create_pending_marker", helper.indexOf("candidate_empty == 1"));
  const fullCopy = helper.indexOf('copy "$remote:$current_path" "$remote:$candidate_path"');
  const fullCheck = helper.indexOf('check "$remote:$current_path" "$remote:$candidate_path"');
  const postIdentity = helper.indexOf(
    'verify_repository_identity_bounded "$candidate_credentials" "$operation_root/candidate-repository.json"',
    fullCheck,
  );
  const markerRemoval = helper.indexOf("remove_pending_marker", postIdentity);
  assert.ok(markerCreate > 0 && fullCopy > markerCreate && fullCheck > fullCopy);
  assert.ok(postIdentity > fullCheck && markerRemoval > postIdentity);
  assert.doesNotMatch(helper, /candidate-(?:config|keys)-copy/);
});

test("v0.86.2: candidate recovery set is root-only, verified twice and marked pending", () => {
  assert.match(helper, /install -d -m 0700 -o root -g root -- "\$OFFSITE_RECOVERY_SET_ROOT"/);
  assert.match(helper, /grabenplaner-recovery-set-pending-\$pending_stamp-\$pending_nonce/);
  assert.match(helper, /TRANSFER UND PRUEFUNG AUSSTAENDIG/);
  assert.equal((helper.match(/grabenplaner-offsite-recovery-set\.sh" verify --input/g) || []).length, 2);
  assert.match(helper, /sync -f "\$pending_temporary"[\s\S]*?mv -T -- "\$pending_temporary" "\$pending_final"/);
  assert.match(helper, /completed == 0[\s\S]*?rm -rf --one-file-system -- "\$pending_final"/);
  assert.doesNotMatch(helper, /install[^\n]*"\$OFFSITE_RCLONE_CONFIG"/);
  assert.match(
    helper,
    /install -m 0600 -o root -g root \/dev\/null "\$pending_temporary\/rclone\.conf"[\s\S]*?offsite_stream_persistent_rclone_config >"\$pending_temporary\/rclone\.conf"/,
  );
});

test("v0.86.2: one pending offline recovery set blocks every further target switch", () => {
  const activeReject = helper.indexOf('failure_code="TARGET_FOLDER_ALREADY_ACTIVE"');
  const pendingSearch = helper.indexOf("-name 'grabenplaner-recovery-set-pending-*' -print -quit");
  const candidateCredentials = helper.indexOf('candidate_credentials="$(offsite_make_uploader_credentials');
  assert.ok(activeReject > 0);
  assert.ok(pendingSearch > activeReject);
  assert.ok(candidateCredentials > pendingSearch);
  assert.match(
    helper,
    /\[\[ -z "\$existing_pending_recovery_set" \]\][\s\S]*?Ein vorheriger Recovery-Satz wartet noch auf den bestaetigten Offline-Transfer/,
  );
  assert.doesNotMatch(helper, /migration_mode="already-active"/);
});

test("v0.86.2: cap-bounded root reads the uploader-owned rclone config only through a descriptor-checked privilege drop", () => {
  assert.match(common, /offsite_stream_persistent_rclone_config\(\)/);
  assert.match(common, /runuser --user "\$OFFSITE_USER" -- env -i/);
  assert.match(common, /directoryStat\.uid !== uid \|\| directoryStat\.gid !== gid/);
  assert.match(common, /\(directoryStat\.mode & 0o7777\) !== 0o700/);
  assert.match(common, /fs\.constants\.O_NOFOLLOW/);
  assert.match(common, /opened\.dev !== before\.dev \|\| opened\.ino !== before\.ino/);
  assert.match(common, /after\.dev !== opened\.dev \|\| after\.ino !== opened\.ino/);
  assert.match(common, /before\.nlink !== 1[\s\S]*?\(before\.mode & 0o7777\) !== 0o600/);
  assert.match(common, /offsite_assert_persistent_rclone_config\(\) \{[\s\S]*?offsite_stream_persistent_rclone_config >\/dev\/null/);
});

test("v0.86.2: repository binding is fsynced, atomically replaced, post-verified and rolled back on failure", () => {
  assert.match(
    helper,
    /sync -f "\$repository_next"[\s\S]*?mv -T -- "\$repository_next" "\$OFFSITE_CONFIG_ROOT\/repository"[\s\S]*?sync -f "\$OFFSITE_CONFIG_ROOT"/,
  );
  assert.match(helper, /repository_committed=1/);
  assert.match(helper, /rollback_repository_binding/);
  assert.match(
    helper,
    /mv -T -- "\$rollback_next" "\$OFFSITE_CONFIG_ROOT\/repository"[\s\S]*?verify_repository_identity_bounded "\$rollback_credentials"/,
  );
  assert.match(helper, /if ! verify_repository_identity_bounded "\$candidate_credentials" "\$operation_root\/post-repository\.json"/);
  assert.match(helper, /--kill-after=5s 60s[\s\S]*?--retry-lock 30s/);
});

test("v0.86.2: module, installer and systemd own the privileged helper boundary", () => {
  const schema = JSON.parse(read("server-tools/linux/offsite/module-schema.json"));
  assert.ok(schema.managedArtifacts.includes(
    "server-tools/linux/offsite/grabenplaner-offsite-switch-target.sh",
  ));
  const installer = read("server-tools/linux/offsite/install-grabenplaner-offsite.sh");
  assert.match(installer, /assert_existing_directory "\$OFFSITE_RECOVERY_SET_ROOT" 0 0 700/);
  assert.match(installer, /install -d -m 0700 -o root -g root -- "\$OFFSITE_RECOVERY_SET_ROOT"/);
  const service = read("server-tools/linux/offsite/systemd/grabenplaner-offsite-target-control@.service.in");
  assert.match(service, /^TimeoutStartSec=31min$/m);
  assert.match(service, /^RuntimeMaxSec=32min$/m);
  assert.match(service, /^RuntimeDirectory=grabenplaner-offsite-target-control grabenplaner grabenplaner-offsite$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /ReadWritePaths=[^\n]*\/etc\/grabenplaner\/offsite/);
  assert.match(service, /ReadWritePaths=[^\n]*\/var\/lib\/grabenplaner-offsite\/recovery-sets/);
  assert.match(service, /^CapabilityBoundingSet=CAP_CHOWN CAP_SETGID CAP_SETUID$/m);
});
