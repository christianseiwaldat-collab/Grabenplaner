"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("runtime schema 4 binds the boot ID through systemd without relaxing proc hardening", () => {
  const schema = JSON.parse(read("server-tools", "linux", "runtime-schema.json"));
  const unit = read("server-tools", "linux", "grabenplaner.service.in");
  assert.equal(schema.deploymentSchemaVersion, 4);
  assert.equal(schema.migrationPolicy, "explicit-maintenance");
  assert.equal(schema.managedArtifacts.length, 11);
  assert.match(unit, /^LoadCredential=host-boot-id:\/proc\/sys\/kernel\/random\/boot_id$/m);
  for (const directive of [
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectKernelTunables=yes",
    "ProtectProc=invisible",
    "ProcSubset=pid",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
  ]) assert.match(unit, new RegExp(`^${directive}$`, "m"));

  const verification = spawnSync(process.execPath, [
    path.join(root, "server-tools/linux/lib/verify-package.js"),
    "--runtime-contract",
    root,
  ], { encoding: "utf8" });
  assert.equal(verification.status, 0, verification.stderr);
  const contract = JSON.parse(verification.stdout);
  assert.equal(contract.deploymentSchemaVersion, 4);
  assert.match(contract.fingerprint, /^[a-f0-9]{64}$/);
});

test("runtime-v4 migration is package-bound, exact-delta-only, rollback-capable, and live-verified", () => {
  const migration = read("server-tools", "linux", "migrate-grabenplaner-runtime-v4.sh");
  for (const required of [
    "old.deploymentSchemaVersion!==3",
    "next?.deploymentSchemaVersion!==4",
    "Schema 4 erlaubt keine weitere Runtime-Aenderung",
    "nextText.replace(block,\"\")!==oldText",
    "nextText.replace(notificationBlock,\"\")!==oldText",
    "Optionaler Scaleway-TEM-Versand",
    "GRABENPLANER_WHATSAPP_ALLOWED_EVENTS=",
    "LoadCredential=host-boot-id:/proc/sys/kernel/random/boot_id",
    "ProtectProc=invisible",
    "ProcSubset=pid",
    "systemd-analyze verify",
    "rollback_runtime()",
    "rollback_root/linux-schema3",
    "actual.fingerprint!==expected.fingerprint",
    "ROLLBACK-ACTION-REQUIRED",
    "update-grabenplaner-server.sh",
    "--lock-already-held",
    "updater_commit_is_valid",
    "hostBootGeneration",
    "deploymentSchema:{from:3,to:4}",
    "runtimeFingerprint",
    "rebootTriggered:false",
  ]) assert.ok(migration.includes(required), `Runtime-v4-Vertrag fehlt: ${required}`);
  assert.ok(
    migration.indexOf("actual_package_sha256=") < migration.indexOf("gp_acquire_maintenance_lock"),
  );
  assert.ok(
    migration.indexOf("systemd-analyze verify") < migration.indexOf("mv -T -- \"$unit_pending\" \"$APP_UNIT\""),
  );
  assert.doesNotMatch(migration, /\bsystemctl\s+(?:reboot|poweroff)|\bshutdown\s+-r|\breboot\s+--/);
});

test("runtime-v4 migration pins the existing notification example delta byte-for-byte", () => {
  const migration = read("server-tools", "linux", "migrate-grabenplaner-runtime-v4.sh");
  const environment = read("server-tools", "linux", "grabenplaner.env.example");
  const notificationBlock = migration.match(/const notificationBlock=`([\s\S]*?)`;/)?.[1] || "";
  assert.ok(notificationBlock.length > 500, "Der fest gebundene Kommentarblock fehlt.");
  assert.equal(environment.split(notificationBlock).length, 2);
  const previousEnvironment = environment.replace(notificationBlock, "");
  assert.match(previousEnvironment, /GRABENPLANER_SERVICE_CONTROL_TOKEN=\{\{SERVICE_CONTROL_TOKEN\}\}\n# Einmaliger/);
  assert.doesNotMatch(previousEnvironment, /GRABENPLANER_(?:EMAIL|SMS|WHATSAPP)_/);
  assert.match(migration, /nextText!==oldText/);
  assert.match(migration, /nextText\.replace\(notificationBlock,""\)!==oldText/);
});

test("package, installer, verifier, and updater understand the explicit schema-4 path", () => {
  const builder = read("server-tools", "package", "New-GrabenplanerLinuxServerPackage.ps1");
  const installer = read("server-tools", "linux", "install-grabenplaner-server.sh");
  const verifier = read("server-tools", "linux", "lib", "verify-package.js");
  const updater = read("server-tools", "linux", "update-grabenplaner-server.sh");
  for (const source of [builder, installer, verifier]) {
    assert.match(source, /migrate-grabenplaner-runtime-v4\.sh/);
  }
  assert.match(installer, /deploymentSchemaVersion !== 4/);
  assert.match(verifier, /contract\.deploymentSchemaVersion === 4 \? requiredV4/);
  assert.match(verifier, /\[3, 4\]\.includes\(contract\.deploymentSchemaVersion\)/);
  assert.match(updater, /installed_runtime_schema" == "3" \|\| "\$installed_runtime_schema" == "4"/);
  assert.match(updater, /\.runtime-v\(2\|3\|4\)-migration/);
  assert.match(updater, /schema-not-incremented/);
});

test("runtime-v4 migration shell parses on POSIX test hosts", {
  skip: process.platform === "win32" ? "Bash-Syntax wird im Ubuntu-Testjob geprüft." : false,
}, () => {
  const result = spawnSync("bash", [
    "-n",
    path.join(root, "server-tools/linux/migrate-grabenplaner-runtime-v4.sh"),
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
