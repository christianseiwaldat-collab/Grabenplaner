"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("v0.73 runs the pre-update offsite hook only after the exact local backup and before the app swap", () => {
  const update = read("server-tools/linux/update-grabenplaner-server.sh");
  const backup = update.indexOf('backup_script="$app_dir/server-tools/linux/backup-grabenplaner.sh"');
  const exactBackup = update.indexOf('[[ -f "$backup_database" && -d "$backup_amu" ]] || gp_die "Das Sicherheitsbackup vor dem Update ist unvollstaendig."');
  const restartBeforeUpload = update.indexOf('gp_info "Starte den bisherigen Grabenplaner vor der externen Uebertragung wieder."');
  const hook = update.indexOf('"$offsite_pre_update_hook" --backup-result "$backup_result_file" --lock-already-held');
  const finalBackup = update.indexOf('gp_info "Erstelle unmittelbar vor dem App-Tausch einen aktuellen lokalen Rollback-Sicherungspunkt."');
  const appSwap = update.indexOf("\nstart_database_lock\n", finalBackup);

  assert.ok(backup >= 0 && exactBackup > backup && restartBeforeUpload > exactBackup && hook > restartBeforeUpload
    && finalBackup > hook && appSwap > finalBackup);
  assert.match(update, /GRABENPLANER_OFFSITE_CONFIGURED:-0/);
  assert.match(update, /GRABENPLANER_OFFSITE_STATUS_FILE:-/);
  assert.match(update, /\/opt\/grabenplaner-offsite\/module\/grabenplaner-offsite-pre-update\.sh/);
  assert.match(update, /Offsite-Sicherung vor dem Update ist fehlgeschlagen/);
  assert.match(update, /installed-contract\.json/);
  assert.match(update, /offsite-update-compat\.js/);
  assert.match(update, /compatible\|compatible-installer-only/);
  assert.match(update, /explizit freigegebene Offsite-Migration/);
  const preUpdate = read("server-tools/linux/offsite/grabenplaner-offsite-pre-update.sh");
  assert.match(preUpdate, /offsite_acquire_repository_lock/);
  assert.match(preUpdate, /grabenplaner-offsite-prepare\.sh" --backup-result "\$backup_result" --lock-already-held/);
  assert.match(preUpdate, /grabenplaner-offsite-upload\.sh" --credentials-source "\$OFFSITE_CONFIG_ROOT" --lock-already-held/);
  assert.doesNotMatch(preUpdate, /systemctl start/);
  assert.match(preUpdate, /UPLOAD_FAILED/);
});

test("v0.73 integrates optional offsite health and prevents unsafe implicit core removal", () => {
  const testScript = read("server-tools/linux/test-grabenplaner-server.sh");
  const uninstall = read("server-tools/linux/uninstall-grabenplaner-server.sh");
  const install = read("server-tools/linux/install-grabenplaner-server.sh");
  const builder = read("server-tools/package/New-GrabenplanerLinuxServerPackage.ps1");
  const prepare = read("server-tools/linux/offsite/grabenplaner-offsite-prepare.sh");
  const prepareUnit = read("server-tools/linux/offsite/systemd/grabenplaner-offsite-prepare.service.in");
  const secretReader = read("server-tools/linux/offsite/grabenplaner-offsite-read-secret.sh");

  assert.match(testScript, /grabenplaner-offsite-test/);
  assert.match(testScript, /Offsite-Sicherung/);
  assert.match(testScript, /maximum_backup_age_explicit=0/);
  assert.match(testScript, /GRABENPLANER_OFFSITE_CONFIGURED:-0/);
  assert.match(testScript, /maximum_backup_age_hours=36/);
  assert.match(uninstall, /grabenplaner-offsite-uninstall --yes/);
  assert.match(uninstall, /GRABENPLANER_OFFSITE_CONFIGURED=1/);
  assert.match(install, /grabenplaner-linux-offsite-module-contract/);
  assert.match(install, /server-tools\/linux\/offsite\/module-schema\.json/);
  assert.match(builder, /server-tools\\linux\\offsite\\module-schema\.json/);
  assert.match(prepare, /gp_wait_ready "\$internal_ready_url" 1500/);
  assert.match(prepareUnit, /IPAddressDeny=any/);
  assert.match(prepareUnit, /IPAddressAllow=127\.0\.0\.0\/8/);
  assert.match(prepareUnit, /IPAddressAllow=::1\/128/);
  assert.doesNotMatch(prepareUnit, /PrivateNetwork=yes/);
  assert.match(secretReader, /read -r secret <"\$target" \|\| \[\[ -n "\$secret" \]\] \|\| exit 1/);
});
