"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));

const coreRuntimeArtifacts = [
  "server-tools/linux/Caddyfile.in",
  "server-tools/linux/grabenplaner-bootstrap-admin.sh.in",
  "server-tools/linux/grabenplaner-bootstrap.service.in",
  "server-tools/linux/grabenplaner.env.example",
  "server-tools/linux/grabenplaner-monitor.service.in",
  "server-tools/linux/grabenplaner-monitor.timer.in",
  "server-tools/linux/grabenplaner.service.in",
];

const offsiteArtifacts = [
  "server-tools/linux/offsite/grabenplaner-offsite-assurance.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-check.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-pre-update.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-prepare.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-read-secret.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-rclone-wrapper.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-recovery-set.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-rebind-rclone.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-restore-test.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-upload.sh",
  "server-tools/linux/offsite/install-grabenplaner-offsite.sh",
  "server-tools/linux/offsite/lib/offsite-common.sh",
  "server-tools/linux/offsite/lib/offsite-contract.js",
  "server-tools/linux/offsite/lib/assurance-history.js",
  "server-tools/linux/offsite/lib/assurance-control-broker.js",
  "server-tools/linux/offsite/lib/offsite-rclone-policy.js",
  "server-tools/linux/offsite/lib/offsite-restore-verify.js",
  "server-tools/linux/offsite/lib/offsite-retention-verify.js",
  "server-tools/linux/offsite/lib/offsite-stage.js",
  "server-tools/linux/offsite/lib/offsite-status.js",
  "server-tools/linux/offsite/lib/offsite-setup-rclone-wrapper.sh",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance@.service.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance-control.socket.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance-control@.service.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-check.service.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-check.timer.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-prepare.service.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-restore-test.service.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-restore-test.timer.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-upload.service.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-upload.timer.in",
  "server-tools/linux/offsite/uninstall-grabenplaner-offsite.sh",
  "server-tools/linux/offsite/test-grabenplaner-offsite.sh",
];

test("Linux runtime artifacts stay separate from the optional offsite contract", () => {
  const runtime = readJson("server-tools/linux/runtime-schema.json");
  const offsite = readJson("server-tools/linux/offsite/module-schema.json");

  assert.deepEqual([...runtime.managedArtifacts].sort(), [...coreRuntimeArtifacts].sort());
  assert.equal(runtime.managedArtifacts.length, 7);
  assert.equal(offsite.activationPolicy, "explicit-root-setup");
  assert.equal(offsite.moduleVersion, 3);
  assert.deepEqual([...offsite.managedArtifacts].sort(), [...offsiteArtifacts].sort());
  for (const relative of offsiteArtifacts) assert.ok(fs.statSync(path.join(root, relative)).isFile(), `Fehlt: ${relative}`);
});

test("package verifier validates the separate offsite module without changing the core runtime result", () => {
  const verifier = path.join(root, "server-tools/linux/lib/verify-package.js");
  const result = childProcess.spawnSync(process.execPath, [verifier, "--runtime-contract", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const contract = JSON.parse(result.stdout);
  assert.deepEqual(contract.managedArtifacts, [...coreRuntimeArtifacts].sort());
  assert.equal(contract.offsiteModule.activationPolicy, "explicit-root-setup");
  assert.equal(contract.offsiteModule.moduleVersion, 3);
  assert.deepEqual(contract.offsiteModule.managedArtifacts, [...offsiteArtifacts].sort());
  assert.match(contract.offsiteModule.fingerprint, /^[a-f0-9]{64}$/);
});

test("v0.73 keeps an unresolved verification failure visible when a new backup attempt starts", () => {
  const writer = fs.readFileSync(path.join(root, "server-tools/linux/offsite/lib/offsite-status.js"), "utf8");
  assert.match(
    writer,
    /case "attempt":[\s\S]*?next\.state = Object\.values\(next\.unresolvedFailures\)\.some\(Boolean\) \? "error" : "warning";/,
  );
});

test("v0.73 binds the staged database bytes to the verified local backup result", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-offsite-stage-"));
  const stage = path.join(temporaryRoot, "stage");
  const backup = path.join(stage, "backup");
  const documents = path.join(backup, "snapshot.amu");
  const recovery = path.join(stage, "recovery");
  const database = path.join(backup, "snapshot.db");
  const marker = path.join(backup, "snapshot.complete.json");
  const resultFile = path.join(temporaryRoot, "backup-result.json");
  const metadata = ["grabenplaner.env.example", "package.json", "runtime-schema.json"]
    .map((name) => path.join(recovery, name));
  const helper = path.join(root, "server-tools/linux/offsite/lib/offsite-stage.js");
  try {
    fs.mkdirSync(documents, { recursive: true });
    fs.mkdirSync(recovery, { recursive: true });
    fs.writeFileSync(database, "verified database bytes");
    fs.writeFileSync(path.join(documents, "manifest.json"), "{}\n");
    fs.writeFileSync(marker, "{}\n");
    for (const file of metadata) fs.writeFileSync(file, "{}\n");
    const baseResult = {
      ok: true,
      path: path.join(temporaryRoot, "snapshot.db"),
      amuBackup: path.join(temporaryRoot, "snapshot.amu"),
      commitMarker: path.join(temporaryRoot, "snapshot.complete.json"),
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(resultFile, JSON.stringify({ ...baseResult, sha256: "0".repeat(64) }));
    const rejected = childProcess.spawnSync(process.execPath, [helper, "create", stage, resultFile, ...metadata], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0, "Ein vom Backupbeleg abweichender DB-Inhalt wurde akzeptiert.");

    const actualSha256 = crypto.createHash("sha256").update(fs.readFileSync(database)).digest("hex");
    fs.writeFileSync(resultFile, JSON.stringify({ ...baseResult, sha256: actualSha256 }));
    const created = childProcess.spawnSync(process.execPath, [helper, "create", stage, resultFile, ...metadata], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const verified = childProcess.spawnSync(process.execPath, [helper, "verify", stage], { encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
