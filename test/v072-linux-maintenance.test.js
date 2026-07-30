"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("v0.72 Linux backup publishes only committed DB/document pairs", () => {
  const backup = read("server-tools/linux/backup-grabenplaner.sh");
  const health = read("server-tools/linux/test-grabenplaner-server.sh");
  const pruner = read("server-tools/linux/lib/prune-backups.js");
  assert.match(backup, /gp_prepare_runtime_directory/);
  assert.match(backup, /mktemp --tmpdir="\$runtime_directory" backup-result/);
  assert.doesNotMatch(backup, /result_file="\$backup_dir\//);
  assert.match(backup, /grabenplaner-backup-commit/);
  assert.match(backup, /manifestSha256/);
  assert.match(backup, /verification: \{ status: "verified"/);
  assert.match(backup, /mv -T -- "\$marker_file" "\$target_marker"/);
  assert.match(backup, /lib\/prune-backups\.js/);
  assert.ok(backup.indexOf('"$verifier" "$target_database"') < backup.indexOf('"$pruner" "$backup_dir"'));
  assert.match(health, /dienstplan-\*\.complete\.json/);
  assert.match(health, /"\$latest_marker"/);
  assert.match(pruner, /!rawBackupDirectory/);
  assert.match(pruner, /if \(failures\.length\) throw new Error/);

  const invalidPrunerCall = spawnSync(process.execPath, [
    path.join(root, "server-tools/linux/lib/prune-backups.js"),
  ], { encoding: "utf8" });
  assert.notEqual(invalidPrunerCall.status, 0);
  assert.match(invalidPrunerCall.stderr, /Parameter fuer die Backup-Aufbewahrung/);
});

test("v0.72 updater strictly checks ZIP metadata and gates runtime migrations", () => {
  const updater = read("server-tools/linux/update-grabenplaner-server.sh");
  assert.match(updater, /unzip -Z -t/);
  assert.match(updater, /parsed_modes == declared_entry_count/);
  assert.match(updater, /Links, Sockets und Spezialdateien/);
  assert.match(updater, /\[\[:cntrl:\]\]/);
  assert.match(updater, /ZIP-Dateiliste und Zentralverzeichnis sind inkonsistent/);
  assert.match(updater, /--runtime-contract/);
  assert.match(updater, /migration-required/);
  assert.match(updater, /schema-not-incremented/);
  assert.match(updater, /rollback_app_ok=0/);
  assert.match(updater, /rollback-incomplete/);
  assert.match(updater, /rollback_stop_ok=0/);
  assert.match(updater, /App und Daten werden nicht destruktiv veraendert/);
  assert.match(updater, /rollback_stop_ok == 1 && old_app_moved == 1/);
  assert.match(updater, /old_app_moved == 0 && rollback_app_ok == 1/);
});

test("Linux runtime contract is versioned and cryptographically fingerprinted", () => {
  const result = spawnSync(process.execPath, [
    path.join(root, "server-tools/linux/lib/verify-package.js"),
    "--runtime-contract",
    root,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const contract = JSON.parse(result.stdout);
  assert.equal(contract.deploymentSchemaVersion, 3);
  assert.match(contract.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(contract.managedArtifacts.length, 11);

  const schema = JSON.parse(read("server-tools/linux/runtime-schema.json"));
  assert.equal(schema.format, "grabenplaner-linux-runtime-contract");
  assert.equal(schema.migrationPolicy, "explicit-maintenance");

  const installer = read("server-tools/linux/install-grabenplaner-server.sh");
  assert.match(installer, /server-tools\/linux\/runtime-schema\.json/);
  assert.match(installer, /Der Linux-Runtimevertrag v3 ist ungueltig/);
});
