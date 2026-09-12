"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const HASH = /^[a-f0-9]{64}$/;
const PREFIX = "server-tools/linux/offsite/";
const INSTALLER = "install-grabenplaner-offsite.sh";
const SUPPORTED_MODULE_VERSIONS = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
const LEGACY_V1_ARTIFACTS = Object.freeze([
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
  "uninstall-grabenplaner-offsite.sh",
  "test-grabenplaner-offsite.sh",
]);
const LEGACY_V2_ARTIFACTS = Object.freeze([
  "grabenplaner-offsite-assurance.sh",
  "grabenplaner-offsite-check.sh",
  "grabenplaner-offsite-pre-update.sh",
  "grabenplaner-offsite-prepare.sh",
  "grabenplaner-offsite-read-secret.sh",
  "grabenplaner-offsite-rclone-wrapper.sh",
  "grabenplaner-offsite-recovery-set.sh",
  "grabenplaner-offsite-rebind-rclone.sh",
  "grabenplaner-offsite-restore-test.sh",
  "grabenplaner-offsite-upload.sh",
  "install-grabenplaner-offsite.sh",
  "lib/offsite-common.sh",
  "lib/offsite-contract.js",
  "lib/assurance-history.js",
  "lib/offsite-rclone-policy.js",
  "lib/offsite-restore-verify.js",
  "lib/offsite-retention-verify.js",
  "lib/offsite-stage.js",
  "lib/offsite-status.js",
  "lib/offsite-setup-rclone-wrapper.sh",
  "systemd/grabenplaner-offsite-assurance@.service.in",
  "systemd/grabenplaner-offsite-check.service.in",
  "systemd/grabenplaner-offsite-check.timer.in",
  "systemd/grabenplaner-offsite-prepare.service.in",
  "systemd/grabenplaner-offsite-restore-test.service.in",
  "systemd/grabenplaner-offsite-restore-test.timer.in",
  "systemd/grabenplaner-offsite-upload.service.in",
  "systemd/grabenplaner-offsite-upload.timer.in",
  "uninstall-grabenplaner-offsite.sh",
  "test-grabenplaner-offsite.sh",
]);
const LEGACY_V3_ARTIFACTS = Object.freeze([
  ...LEGACY_V2_ARTIFACTS,
  "lib/assurance-control-broker.js",
  "systemd/grabenplaner-offsite-assurance-control.socket.in",
  "systemd/grabenplaner-offsite-assurance-control@.service.in",
]);
const MODULE_V4_ARTIFACTS = Object.freeze([
  ...LEGACY_V3_ARTIFACTS,
  "grabenplaner-offsite-application-smoke.sh",
  "lib/application-smoke.js",
  "systemd/grabenplaner-offsite-application-smoke.service.in",
  "systemd/grabenplaner-offsite-assurance.timer.in",
]);
const MODULE_V5_ARTIFACTS = Object.freeze([...MODULE_V4_ARTIFACTS]);
const MODULE_V6_ARTIFACTS = Object.freeze([
  ...MODULE_V5_ARTIFACTS,
  "grabenplaner-offsite-switch-target.sh",
  "lib/offsite-target-broker.js",
  "systemd/grabenplaner-offsite-target-control.socket.in",
  "systemd/grabenplaner-offsite-target-control@.service.in",
]);
const VERSION_ARTIFACTS = new Map([
  [1, new Set(LEGACY_V1_ARTIFACTS)],
  [2, new Set(LEGACY_V2_ARTIFACTS)],
  [3, new Set(LEGACY_V3_ARTIFACTS)],
  [4, new Set(MODULE_V4_ARTIFACTS)],
  [5, new Set(MODULE_V5_ARTIFACTS)],
  [6, new Set(MODULE_V6_ARTIFACTS)],
  [7, new Set(MODULE_V6_ARTIFACTS)],
  [8, new Set(MODULE_V6_ARTIFACTS)],
]);

function safeRelative(value) {
  return typeof value === "string" && value && !value.includes("\\") && !value.startsWith("/")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function fingerprint(files) {
  return crypto.createHash("sha256")
    .update([...files].sort(([left], [right]) => left.localeCompare(right))
      .map(([name, hash]) => `${PREFIX}${name}\0${hash}\n`).join(""))
    .digest("hex");
}

function classify(candidateEnvelope, installed) {
  const candidate = candidateEnvelope?.offsiteModule;
  if (!candidate || candidate.schemaVersion !== 1 || !SUPPORTED_MODULE_VERSIONS.has(candidate.moduleVersion)
    || candidate.activationPolicy !== "explicit-root-setup" || !HASH.test(String(candidate.fingerprint || ""))
    || !HASH.test(String(candidate.installerSha256 || "")) || !Array.isArray(candidate.managedArtifacts)
    || installed?.format !== "grabenplaner-linux-offsite-installed-contract" || installed.schemaVersion !== 1
    || !SUPPORTED_MODULE_VERSIONS.has(installed.moduleVersion) || !HASH.test(String(installed.fingerprint || ""))
    || !Array.isArray(installed.files)) return "invalid";

  const expectedPaths = candidate.managedArtifacts.map((value) => {
    const full = String(value || "");
    if (!full.startsWith(PREFIX)) return "";
    const relative = full.slice(PREFIX.length);
    return safeRelative(relative) ? relative : "";
  });
  if (expectedPaths.some((value) => !value) || new Set(expectedPaths).size !== expectedPaths.length
    || !expectedPaths.includes(INSTALLER)) {
    return "invalid";
  }
  const candidateExpected = VERSION_ARTIFACTS.get(candidate.moduleVersion);
  if (!candidateExpected || expectedPaths.length !== candidateExpected.size
    || expectedPaths.some((relative) => !candidateExpected.has(relative))) {
    return "invalid";
  }
  if (candidate.moduleVersion < installed.moduleVersion) return "invalid";

  const expected = new Set(expectedPaths);
  const installedFiles = new Map();
  for (const item of installed.files) {
    const relative = String(item?.path || "");
    const sha256 = String(item?.sha256 || "");
    if (!safeRelative(relative) || installedFiles.has(relative) || !HASH.test(sha256)) {
      return "invalid";
    }
    installedFiles.set(relative, sha256);
  }
  if (fingerprint(installedFiles) !== installed.fingerprint) return "invalid";
  const installedExpected = VERSION_ARTIFACTS.get(installed.moduleVersion);
  if (!installedExpected) return "invalid";
  if (installedFiles.size !== installedExpected.size
    || [...installedExpected].some((relative) => !installedFiles.has(relative))) return "invalid";
  if (candidate.moduleVersion !== installed.moduleVersion) {
    return `migration-required:${installed.moduleVersion}->${candidate.moduleVersion}`;
  }
  if (expectedPaths.length !== installed.files.length || installedFiles.size !== expected.size) return "invalid";
  if (candidate.fingerprint === installed.fingerprint) {
    return installedFiles.get(INSTALLER) === candidate.installerSha256 ? "compatible" : "invalid";
  }

  const candidateFiles = new Map(installedFiles);
  candidateFiles.set(INSTALLER, candidate.installerSha256);
  return fingerprint(candidateFiles) === candidate.fingerprint
    ? "compatible-installer-only"
    : `migration-required:${installed.moduleVersion}->${candidate.moduleVersion}`;
}

if (require.main === module) {
  try {
    const [candidatePath, installedPath] = process.argv.slice(2);
    if (!candidatePath || !installedPath) throw new Error("Dateipfade fehlen.");
    const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
    const installed = JSON.parse(fs.readFileSync(installedPath, "utf8"));
    process.stdout.write(classify(candidate, installed));
  } catch {
    process.stdout.write("invalid");
    process.exitCode = 1;
  }
}

module.exports = { classify, fingerprint };
