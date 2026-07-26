"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CURRENT_MODULE_VERSION = 5;
const SUPPORTED_INSTALLED_MODULE_VERSIONS = new Set([1, 2, 3, 4, CURRENT_MODULE_VERSION]);
const LEGACY_V1_ARTIFACTS = Object.freeze([
  "grabenplaner-offsite-check.sh", "grabenplaner-offsite-pre-update.sh", "grabenplaner-offsite-prepare.sh",
  "grabenplaner-offsite-read-secret.sh", "grabenplaner-offsite-rclone-wrapper.sh",
  "grabenplaner-offsite-restore-test.sh", "grabenplaner-offsite-upload.sh", "install-grabenplaner-offsite.sh",
  "lib/offsite-common.sh", "lib/offsite-contract.js", "lib/offsite-restore-verify.js",
  "lib/offsite-retention-verify.js", "lib/offsite-stage.js", "lib/offsite-status.js",
  "lib/offsite-setup-rclone-wrapper.sh", "systemd/grabenplaner-offsite-check.service.in",
  "systemd/grabenplaner-offsite-check.timer.in", "systemd/grabenplaner-offsite-prepare.service.in",
  "systemd/grabenplaner-offsite-restore-test.service.in", "systemd/grabenplaner-offsite-restore-test.timer.in",
  "systemd/grabenplaner-offsite-upload.service.in", "systemd/grabenplaner-offsite-upload.timer.in",
  "uninstall-grabenplaner-offsite.sh", "test-grabenplaner-offsite.sh",
]);
const LEGACY_V2_ARTIFACTS = Object.freeze([
  "grabenplaner-offsite-assurance.sh", "grabenplaner-offsite-check.sh", "grabenplaner-offsite-pre-update.sh",
  "grabenplaner-offsite-prepare.sh", "grabenplaner-offsite-read-secret.sh", "grabenplaner-offsite-rclone-wrapper.sh",
  "grabenplaner-offsite-recovery-set.sh", "grabenplaner-offsite-rebind-rclone.sh",
  "grabenplaner-offsite-restore-test.sh", "grabenplaner-offsite-upload.sh", "install-grabenplaner-offsite.sh",
  "lib/offsite-common.sh", "lib/offsite-contract.js", "lib/assurance-history.js", "lib/offsite-rclone-policy.js",
  "lib/offsite-restore-verify.js", "lib/offsite-retention-verify.js", "lib/offsite-stage.js",
  "lib/offsite-status.js", "lib/offsite-setup-rclone-wrapper.sh",
  "systemd/grabenplaner-offsite-assurance@.service.in", "systemd/grabenplaner-offsite-check.service.in",
  "systemd/grabenplaner-offsite-check.timer.in", "systemd/grabenplaner-offsite-prepare.service.in",
  "systemd/grabenplaner-offsite-restore-test.service.in", "systemd/grabenplaner-offsite-restore-test.timer.in",
  "systemd/grabenplaner-offsite-upload.service.in", "systemd/grabenplaner-offsite-upload.timer.in",
  "uninstall-grabenplaner-offsite.sh", "test-grabenplaner-offsite.sh",
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
const VERSION_ARTIFACTS = new Map([
  [1, new Set(LEGACY_V1_ARTIFACTS)], [2, new Set(LEGACY_V2_ARTIFACTS)],
  [3, new Set(LEGACY_V3_ARTIFACTS)], [4, new Set(MODULE_V4_ARTIFACTS)],
  [5, new Set(MODULE_V5_ARTIFACTS)],
]);

function assertExactArtifactContract(moduleVersion, fullArtifacts) {
  const prefix = "server-tools/linux/offsite/";
  const expected = VERSION_ARTIFACTS.get(moduleVersion);
  const relative = Array.isArray(fullArtifacts) ? fullArtifacts.map((entry) => {
    const value = String(entry || "");
    return value.startsWith(prefix) ? value.slice(prefix.length) : "";
  }) : [];
  if (!expected || relative.length !== expected.size || new Set(relative).size !== relative.length
    || relative.some((entry) => !safeRelative(entry) || !expected.has(entry))) {
    throw new Error("Der Offsite-Modulvertrag enthaelt nicht exakt die freigegebenen Dateien.");
  }
}

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function safeRelative(value) {
  return typeof value === "string" && value && !value.includes("\\") && !value.startsWith("/")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function moduleContract(sourceRoot) {
  const schemaPath = path.join(sourceRoot, "module-schema.json");
  const stat = fs.lstatSync(schemaPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Der Offsite-Modulvertrag fehlt.");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8").replace(/^\uFEFF/, ""));
  if (schema.format !== "grabenplaner-linux-offsite-module-contract" || schema.schemaVersion !== 1
    || schema.moduleVersion !== CURRENT_MODULE_VERSION || schema.activationPolicy !== "explicit-root-setup"
    || !Array.isArray(schema.managedArtifacts) || schema.managedArtifacts.length < 15 || schema.managedArtifacts.length > 64) {
    throw new Error("Der Offsite-Modulvertrag wird nicht unterstuetzt.");
  }
  assertExactArtifactContract(schema.moduleVersion, schema.managedArtifacts);
  const prefix = "server-tools/linux/offsite/";
  const files = new Map();
  for (const fullRelative of schema.managedArtifacts) {
    if (!String(fullRelative).startsWith(prefix)) throw new Error("Ein Offsite-Modulpfad ist ungueltig.");
    const relative = fullRelative.slice(prefix.length);
    if (!safeRelative(relative) || files.has(relative)) throw new Error("Ein Offsite-Modulpfad ist ungueltig oder doppelt.");
    const target = path.resolve(sourceRoot, ...relative.split("/"));
    if (!target.startsWith(`${sourceRoot}${path.sep}`)) throw new Error("Ein Offsite-Modulpfad verlaesst die Modulwurzel.");
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error(`Offsite-Moduldatei fehlt: ${relative}`);
    files.set(relative, digest(target));
  }
  const fingerprint = crypto.createHash("sha256")
    .update([...files].sort(([a], [b]) => a.localeCompare(b))
      .map(([name, hash]) => `server-tools/linux/offsite/${name}\0${hash}\n`).join(""))
    .digest("hex");
  return {
    schemaSha256: digest(schemaPath),
    fingerprint,
    files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([filePath, sha256]) => ({ path: filePath, sha256 })),
  };
}

function verifyInstalled(moduleRoot, receiptPath) {
  for (const directory of [path.dirname(moduleRoot), moduleRoot]) {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== 0 || (directoryStat.mode & 0o022) !== 0) {
      throw new Error("Die installierte Modulwurzel ist unsicher.");
    }
  }
  const receiptStat = fs.lstatSync(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) throw new Error("Der Installationsbeleg fehlt.");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8").replace(/^\uFEFF/, ""));
  if (receipt.format !== "grabenplaner-linux-offsite-installed-contract" || receipt.schemaVersion !== 1
    || !SUPPORTED_INSTALLED_MODULE_VERSIONS.has(receipt.moduleVersion)
    || !Array.isArray(receipt.files) || !/^[a-f0-9]{64}$/.test(String(receipt.fingerprint || ""))
    || !/^[a-f0-9]{64}$/.test(String(receipt.schemaSha256 || ""))) {
    throw new Error("Der Installationsbeleg ist ungueltig.");
  }
  const schemaPath = path.join(moduleRoot, "module-schema.json");
  const schemaStat = fs.lstatSync(schemaPath);
  if (!schemaStat.isFile() || schemaStat.isSymbolicLink() || digest(schemaPath) !== receipt.schemaSha256) {
    throw new Error("Der installierte Modulvertrag stimmt nicht mit dem Installationsbeleg ueberein.");
  }
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8").replace(/^\uFEFF/, ""));
  if (schema.format !== "grabenplaner-linux-offsite-module-contract" || schema.schemaVersion !== 1
    || schema.moduleVersion !== receipt.moduleVersion || !SUPPORTED_INSTALLED_MODULE_VERSIONS.has(schema.moduleVersion)
    || schema.activationPolicy !== "explicit-root-setup" || !Array.isArray(schema.managedArtifacts)) {
    throw new Error("Der installierte Modulvertrag wird nicht unterstuetzt.");
  }
  assertExactArtifactContract(schema.moduleVersion, schema.managedArtifacts);
  const prefix = "server-tools/linux/offsite/";
  const expected = new Set(schema.managedArtifacts.map((relative) => {
    if (!String(relative).startsWith(prefix) || !safeRelative(String(relative).slice(prefix.length))) {
      throw new Error("Der installierte Modulvertrag enthaelt einen ungueltigen Pfad.");
    }
    return String(relative).slice(prefix.length);
  }));
  if (expected.size !== schema.managedArtifacts.length || expected.size !== receipt.files.length) {
    throw new Error("Installationsbeleg und Modulvertrag enthalten unterschiedliche Dateilisten.");
  }
  const files = new Map();
  for (const item of receipt.files) {
    const relative = String(item?.path || "");
    if (!safeRelative(relative) || files.has(relative) || !/^[a-f0-9]{64}$/.test(String(item?.sha256 || ""))) {
      throw new Error("Der Installationsbeleg enthaelt ungueltige Dateien.");
    }
    if (!expected.has(relative)) throw new Error("Der Installationsbeleg enthaelt eine nicht verwaltete Datei.");
    const target = path.resolve(moduleRoot, ...relative.split("/"));
    if (!target.startsWith(`${moduleRoot}${path.sep}`)) throw new Error("Ein installierter Modulpfad verlaesst die Modulwurzel.");
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.uid !== 0 || targetStat.nlink !== 1
      || (targetStat.mode & 0o022) !== 0 || digest(target) !== item.sha256) {
      throw new Error("Die installierte Offsite-Modulpruefung ist fehlgeschlagen.");
    }
    files.set(relative, item.sha256);
  }
  if ([...expected].some((relative) => !files.has(relative))) throw new Error("Im Installationsbeleg fehlt eine verwaltete Datei.");
  const fingerprint = crypto.createHash("sha256")
    .update([...files].sort(([a], [b]) => a.localeCompare(b))
      .map(([name, hash]) => `server-tools/linux/offsite/${name}\0${hash}\n`).join(""))
    .digest("hex");
  if (fingerprint !== receipt.fingerprint) throw new Error("Der installierte Offsite-Fingerprint stimmt nicht.");
  return { ok: true, fingerprint, files: files.size };
}

try {
  const [command, first, second] = process.argv.slice(2);
  if (command === "contract") {
    const result = moduleContract(path.resolve(first || ""));
    process.stdout.write(`${JSON.stringify({ format: "grabenplaner-linux-offsite-installed-contract", schemaVersion: 1, moduleVersion: CURRENT_MODULE_VERSION, ...result }, null, 2)}\n`);
  } else if (command === "verify-installed") {
    process.stdout.write(`${JSON.stringify(verifyInstalled(path.resolve(first || ""), path.resolve(second || "")))}\n`);
  } else {
    throw new Error("Unbekannter Offsite-Vertragsvorgang.");
  }
} catch (error) {
  process.stderr.write(`${error?.message || "Offsite-Vertragspruefung fehlgeschlagen."}\n`);
  process.exitCode = 1;
}
