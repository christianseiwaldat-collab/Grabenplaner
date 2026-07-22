"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const verifier = path.join(root, "server-tools", "linux", "lib", "verify-package.js");
const { classify, fingerprint } = require("../server-tools/linux/lib/offsite-update-compat");
const PREFIX = "server-tools/linux/offsite/";
const V1_PATHS = Object.freeze([
  "grabenplaner-offsite-check.sh",
  "grabenplaner-offsite-pre-update.sh",
  "grabenplaner-offsite-prepare.sh",
  "grabenplaner-offsite-read-secret.sh",
  "grabenplaner-offsite-rclone-wrapper.sh",
  "grabenplaner-offsite-restore-test.sh",
  "grabenplaner-offsite-upload.sh",
  "install-grabenplaner-offsite.sh",
  "lib/offsite-common.sh",
  "lib/offsite-contract.js",
  "lib/offsite-restore-verify.js",
  "lib/offsite-retention-verify.js",
  "lib/offsite-stage.js",
  "lib/offsite-status.js",
  "lib/offsite-setup-rclone-wrapper.sh",
  "systemd/grabenplaner-offsite-check.service.in",
  "systemd/grabenplaner-offsite-check.timer.in",
  "systemd/grabenplaner-offsite-prepare.service.in",
  "systemd/grabenplaner-offsite-restore-test.service.in",
  "systemd/grabenplaner-offsite-restore-test.timer.in",
  "systemd/grabenplaner-offsite-upload.service.in",
  "systemd/grabenplaner-offsite-upload.timer.in",
  "test-grabenplaner-offsite.sh",
  "uninstall-grabenplaner-offsite.sh",
]);
const V4_PATHS = Object.freeze([
  "grabenplaner-offsite-application-smoke.sh",
  "grabenplaner-offsite-assurance.sh",
  "grabenplaner-offsite-check.sh",
  "grabenplaner-offsite-pre-update.sh",
  "grabenplaner-offsite-prepare.sh",
  "grabenplaner-offsite-read-secret.sh",
  "grabenplaner-offsite-rclone-wrapper.sh",
  "grabenplaner-offsite-rebind-rclone.sh",
  "grabenplaner-offsite-recovery-set.sh",
  "grabenplaner-offsite-restore-test.sh",
  "grabenplaner-offsite-upload.sh",
  "install-grabenplaner-offsite.sh",
  "lib/application-smoke.js",
  "lib/assurance-control-broker.js",
  "lib/assurance-history.js",
  "lib/offsite-common.sh",
  "lib/offsite-contract.js",
  "lib/offsite-rclone-policy.js",
  "lib/offsite-restore-verify.js",
  "lib/offsite-retention-verify.js",
  "lib/offsite-setup-rclone-wrapper.sh",
  "lib/offsite-stage.js",
  "lib/offsite-status.js",
  "systemd/grabenplaner-offsite-application-smoke.service.in",
  "systemd/grabenplaner-offsite-assurance-control.socket.in",
  "systemd/grabenplaner-offsite-assurance-control@.service.in",
  "systemd/grabenplaner-offsite-assurance.timer.in",
  "systemd/grabenplaner-offsite-assurance@.service.in",
  "systemd/grabenplaner-offsite-check.service.in",
  "systemd/grabenplaner-offsite-check.timer.in",
  "systemd/grabenplaner-offsite-prepare.service.in",
  "systemd/grabenplaner-offsite-restore-test.service.in",
  "systemd/grabenplaner-offsite-restore-test.timer.in",
  "systemd/grabenplaner-offsite-upload.service.in",
  "systemd/grabenplaner-offsite-upload.timer.in",
  "test-grabenplaner-offsite.sh",
  "uninstall-grabenplaner-offsite.sh",
]);

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function files(paths, seed) {
  return new Map(paths.map((relative) => [relative, sha(`${seed}:${relative}`)]));
}

function installed(version, paths, seed) {
  const mapped = files(paths, seed);
  return {
    format: "grabenplaner-linux-offsite-installed-contract",
    schemaVersion: 1,
    moduleVersion: version,
    fingerprint: fingerprint(mapped),
    files: [...mapped].map(([relative, sha256]) => ({ path: relative, sha256 })),
  };
}

function candidate(version, paths, seed) {
  const mapped = files(paths, seed);
  return { offsiteModule: {
    schemaVersion: 1,
    moduleVersion: version,
    activationPolicy: "explicit-root-setup",
    fingerprint: fingerprint(mapped),
    installerSha256: mapped.get("install-grabenplaner-offsite.sh"),
    managedArtifacts: paths.map((relative) => `${PREFIX}${relative}`),
  } };
}

test("v0.75.8: Bridge bleibt bytegleich auf Runtime 2, Offsite v1 und Hardening v1", () => {
  const result = spawnSync(process.execPath, [verifier, "--runtime-contract", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const contract = JSON.parse(result.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "0.75.8-beta");
  assert.equal(contract.deploymentSchemaVersion, 2);
  assert.equal(contract.fingerprint, "c0769637c5ec9e38f75b2a685af8f336a57ed9bf429ab887160036eb55fd9cc0");
  assert.equal(contract.offsiteModule.moduleVersion, 1);
  assert.equal(contract.offsiteModule.fingerprint, "0b48388e022a98a086ca7830b128dca2e50502ccec9260cd3c7e7ade05d07680");
  assert.equal(contract.offsiteModule.installerSha256, "e1384321c85242a77920a0a23fb54d8f08b520fc2a0e199dabda558af9459552");
  assert.equal(contract.hardeningModule.moduleVersion, 1);
  assert.equal(contract.hardeningModule.fingerprint, "e917ee0355874ce08f8ab096335ea6b533d151a4e9ab2bc4755d4f940682f91d");
});

test("v0.75.8: Compat akzeptiert exakt v1 und v4 und erzwingt die Migration 1 nach 4", () => {
  assert.equal(classify(candidate(1, V1_PATHS, "v1"), installed(1, V1_PATHS, "v1")), "compatible");
  assert.equal(classify(candidate(4, V4_PATHS, "v4"), installed(4, V4_PATHS, "v4")), "compatible");
  assert.equal(classify(candidate(4, V4_PATHS, "v4"), installed(1, V1_PATHS, "v1")), "migration-required:1->4");
  assert.equal(classify(candidate(1, V1_PATHS, "v1"), installed(4, V4_PATHS, "v4")), "invalid");
  assert.equal(classify(candidate(2, V1_PATHS, "v2"), installed(1, V1_PATHS, "v1")), "invalid");
  assert.equal(classify(candidate(4, V4_PATHS.slice(1), "v4"), installed(1, V1_PATHS, "v1")), "invalid");
});

const bridgePackageRoot = process.env.GRABENPLANER_V0758_PACKAGE_ROOT;
const originalVerifier = process.env.GRABENPLANER_V0757_VERIFIER;
test("v0.75.8: originaler v0.75.7-Verifier akzeptiert das fertige Bridge-Paket", {
  skip: !(bridgePackageRoot && originalVerifier),
}, () => {
  const result = spawnSync(process.execPath, [originalVerifier, bridgePackageRoot], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).appVersion, "0.75.8-beta");
});

const v078PackageRoot = process.env.GRABENPLANER_V078_PACKAGE_ROOT;
test("v0.75.8: Bridge-Verifier akzeptiert das finale v0.78-Paket", { skip: !v078PackageRoot }, () => {
  const result = spawnSync(process.execPath, [verifier, v078PackageRoot], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const verified = JSON.parse(result.stdout);
  assert.equal(verified.appVersion, "0.78.0-beta");
  assert.equal(verified.offsiteModule.moduleVersion, 4);
});
