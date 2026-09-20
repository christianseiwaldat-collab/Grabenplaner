"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CURRENT_MODULE_VERSION = 11;
const SUPPORTED_INSTALLED_MODULE_VERSIONS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, CURRENT_MODULE_VERSION]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const REMOTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FOLDER_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,46}[A-Za-z0-9])?$/;
const BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/;
const PROVIDER_POLICY_FORMAT = "grabenplaner-offsite-rclone-provider-policy";
const PROVIDER_BINDING_FORMAT = "grabenplaner-offsite-provider-binding";
const PROVIDER_BINDING_SCHEMA_VERSION = 1;
const PROVIDER_POLICY_KEYS = Object.freeze([
  "authentication", "backend", "configSha256", "endpoint", "format",
  "providerId", "region", "remoteName", "schemaVersion", "scope",
]);
const PROVIDER_BINDING_KEYS = Object.freeze([
  "authentication", "backend", "configSha256", "endpoint", "format",
  "policySha256", "providerId", "region", "remoteName", "repositoryLayout",
  "schemaVersion", "scope", "storageRoot",
]);
const S3_PROVIDER_ENDPOINTS = Object.freeze(new Map([
  ["fsn1.your-objectstorage.com", Object.freeze({
    providerId: "hetzner_object_storage",
    region: "fsn1",
  })],
  ["nbg1.your-objectstorage.com", Object.freeze({
    providerId: "hetzner_object_storage",
    region: "nbg1",
  })],
  ["hel1.your-objectstorage.com", Object.freeze({
    providerId: "hetzner_object_storage",
    region: "hel1",
  })],
  ["s3.eu-central-003.backblazeb2.com", Object.freeze({
    providerId: "backblaze_b2",
    region: "eu-central-003",
  })],
]));
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
const MODULE_V6_ARTIFACTS = Object.freeze([
  ...MODULE_V5_ARTIFACTS,
  "grabenplaner-offsite-switch-target.sh",
  "lib/offsite-target-broker.js",
  "systemd/grabenplaner-offsite-target-control.socket.in",
  "systemd/grabenplaner-offsite-target-control@.service.in",
]);
const MODULE_V11_ARTIFACTS = Object.freeze([
  ...MODULE_V6_ARTIFACTS,
  "lib/maintenance-schedule-broker.js",
]);
const VERSION_ARTIFACTS = new Map([
  [1, new Set(LEGACY_V1_ARTIFACTS)], [2, new Set(LEGACY_V2_ARTIFACTS)],
  [3, new Set(LEGACY_V3_ARTIFACTS)], [4, new Set(MODULE_V4_ARTIFACTS)],
  [5, new Set(MODULE_V5_ARTIFACTS)],
  [6, new Set(MODULE_V6_ARTIFACTS)],
  [7, new Set(MODULE_V6_ARTIFACTS)],
  [8, new Set(MODULE_V6_ARTIFACTS)],
  [9, new Set(MODULE_V6_ARTIFACTS)],
  [10, new Set(MODULE_V6_ARTIFACTS)],
  [11, new Set(MODULE_V11_ARTIFACTS)],
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

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function timingSafeCanonicalEqual(left, right) {
  const leftBuffer = Buffer.from(canonicalJson(left));
  const rightBuffer = Buffer.from(canonicalJson(right));
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function readJson(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${label} ist ungueltig.`);
  }
  return value;
}

function providerPolicy(value) {
  if (!exactKeys(value, PROVIDER_POLICY_KEYS)
    || value.format !== PROVIDER_POLICY_FORMAT
    || value.schemaVersion !== PROVIDER_BINDING_SCHEMA_VERSION
    || !REMOTE_PATTERN.test(String(value.remoteName || ""))
    || !HASH_PATTERN.test(String(value.configSha256 || ""))) {
    throw new Error("Die validierte Offsite-Provider-Richtlinie ist ungueltig.");
  }
  if (value.providerId === "google_drive") {
    if (value.backend !== "drive" || value.authentication !== "dedicated_oauth"
      || value.scope !== "drive.file" || value.endpoint !== null || value.region !== null) {
      throw new Error("Die Google-Drive-Provider-Richtlinie ist ungueltig.");
    }
  } else {
    const selected = typeof value.endpoint === "string"
      ? S3_PROVIDER_ENDPOINTS.get(value.endpoint)
      : null;
    if (!selected || value.providerId !== selected.providerId || value.region !== selected.region
      || value.backend !== "s3" || value.authentication !== "static_access_key"
      || value.scope !== null) {
      throw new Error("Die S3-Provider-Richtlinie ist ungueltig.");
    }
  }
  return value;
}

function repositoryBinding(repositoryFile, policy) {
  const repository = fs.readFileSync(repositoryFile, "utf8").trim();
  const match = repository.match(/^rclone:([A-Za-z0-9][A-Za-z0-9_-]{0,63}):([A-Za-z0-9][A-Za-z0-9._/-]{0,511})$/);
  if (!match || match[1] !== policy.remoteName
    || match[2].split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Die Repository-Bindung passt nicht zur validierten Provider-Richtlinie.");
  }
  if (policy.providerId === "google_drive") {
    return {
      repositoryLayout: "google-drive-direct-safe-path-v1",
      storageRoot: null,
    };
  }
  const segments = match[2].split("/");
  const bucket = segments.shift();
  const label = segments.pop();
  if (segments.length !== 1 || segments[0] !== "Grabenplaner-Offsite"
    || !BUCKET_PATTERN.test(bucket)
    || bucket.includes("..")
    || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(bucket)
    || !FOLDER_LABEL_PATTERN.test(label)
    || Buffer.byteLength(label, "utf8") > 48) {
    throw new Error("Das S3-Repository muss exakt BUCKET/Grabenplaner-Offsite/ORDNER verwenden.");
  }
  return {
    repositoryLayout: "s3-managed-prefix-v1",
    storageRoot: bucket,
  };
}

function bindingFromPolicy(policyValue, repositoryFile) {
  const policy = providerPolicy(policyValue);
  const repository = repositoryBinding(repositoryFile, policy);
  return {
    format: PROVIDER_BINDING_FORMAT,
    schemaVersion: PROVIDER_BINDING_SCHEMA_VERSION,
    providerId: policy.providerId,
    remoteName: policy.remoteName,
    backend: policy.backend,
    authentication: policy.authentication,
    endpoint: policy.endpoint,
    region: policy.region,
    scope: policy.scope,
    configSha256: policy.configSha256,
    policySha256: crypto.createHash("sha256").update(canonicalJson(policy)).digest("hex"),
    repositoryLayout: repository.repositoryLayout,
    storageRoot: repository.storageRoot,
  };
}

function validProviderBinding(value) {
  if (!exactKeys(value, PROVIDER_BINDING_KEYS)
    || value.format !== PROVIDER_BINDING_FORMAT
    || value.schemaVersion !== PROVIDER_BINDING_SCHEMA_VERSION
    || !REMOTE_PATTERN.test(String(value.remoteName || ""))
    || !HASH_PATTERN.test(String(value.configSha256 || ""))
    || !HASH_PATTERN.test(String(value.policySha256 || ""))) {
    return false;
  }
  if (value.providerId === "google_drive") {
    return value.backend === "drive"
      && value.authentication === "dedicated_oauth"
      && value.scope === "drive.file"
      && value.endpoint === null
      && value.region === null
      && value.repositoryLayout === "google-drive-direct-safe-path-v1"
      && value.storageRoot === null;
  }
  const selected = typeof value.endpoint === "string"
    ? S3_PROVIDER_ENDPOINTS.get(value.endpoint)
    : null;
  return Boolean(selected)
    && value.providerId === selected.providerId
    && value.region === selected.region
    && value.backend === "s3"
    && value.authentication === "static_access_key"
    && value.scope === null
    && value.repositoryLayout === "s3-managed-prefix-v1"
    && typeof value.storageRoot === "string"
    && BUCKET_PATTERN.test(value.storageRoot)
    && !value.storageRoot.includes("..")
    && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value.storageRoot);
}

function boundReceipt(receiptFile, policyFile, repositoryFile) {
  const receipt = readJson(receiptFile, "Der ungebundene Installationsbeleg");
  if (receipt.format !== "grabenplaner-linux-offsite-installed-contract"
    || receipt.schemaVersion !== 1
    || receipt.moduleVersion !== CURRENT_MODULE_VERSION
    || !HASH_PATTERN.test(String(receipt.fingerprint || ""))
    || !HASH_PATTERN.test(String(receipt.schemaSha256 || ""))
    || !Array.isArray(receipt.files)
    || receipt.providerBinding !== undefined) {
    throw new Error("Der ungebundene Installationsbeleg ist ungueltig.");
  }
  const policy = readJson(policyFile, "Die validierte Provider-Richtlinie");
  return {
    ...receipt,
    providerBinding: bindingFromPolicy(policy, repositoryFile),
  };
}

function verifyProviderBinding(receiptFile, policyFile, repositoryFile) {
  const receipt = readJson(receiptFile, "Der Installationsbeleg");
  const policy = readJson(policyFile, "Die validierte Provider-Richtlinie");
  const expected = bindingFromPolicy(policy, repositoryFile);
  if (receipt.format !== "grabenplaner-linux-offsite-installed-contract"
    || receipt.schemaVersion !== 1
    || !SUPPORTED_INSTALLED_MODULE_VERSIONS.has(receipt.moduleVersion)
    || !HASH_PATTERN.test(String(receipt.fingerprint || ""))
    || !Array.isArray(receipt.files)
    || !validProviderBinding(receipt.providerBinding)
    || !timingSafeCanonicalEqual(receipt.providerBinding, expected)) {
    throw new Error("Die aktive Offsite-Provider-Bindung weicht vom Installationsbeleg ab.");
  }
  return receipt.providerBinding.providerId;
}

function providerIdFromReceipt(receiptFile) {
  const receipt = readJson(receiptFile, "Der Installationsbeleg");
  if (receipt.format !== "grabenplaner-linux-offsite-installed-contract"
    || receipt.schemaVersion !== 1
    || !validProviderBinding(receipt.providerBinding)) {
    throw new Error("Der Installationsbeleg besitzt keine gueltige Offsite-Provider-Bindung.");
  }
  return receipt.providerBinding.providerId;
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

function verifyInstalled(moduleRoot, receiptPath, options = {}) {
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
  if ((options.requireProviderBinding === true && !validProviderBinding(receipt.providerBinding))
    || (receipt.providerBinding !== undefined && !validProviderBinding(receipt.providerBinding))) {
    throw new Error("Der Installationsbeleg besitzt keine gueltige Offsite-Provider-Bindung.");
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
  const [command, first, second, third] = process.argv.slice(2);
  if (command === "contract") {
    const result = moduleContract(path.resolve(first || ""));
    process.stdout.write(`${JSON.stringify({ format: "grabenplaner-linux-offsite-installed-contract", schemaVersion: 1, moduleVersion: CURRENT_MODULE_VERSION, ...result }, null, 2)}\n`);
  } else if (command === "verify-installed") {
    process.stdout.write(`${JSON.stringify(verifyInstalled(path.resolve(first || ""), path.resolve(second || "")))}\n`);
  } else if (command === "verify-installed-bound") {
    process.stdout.write(`${JSON.stringify(verifyInstalled(
      path.resolve(first || ""),
      path.resolve(second || ""),
      { requireProviderBinding: true },
    ))}\n`);
  } else if (command === "bind-provider") {
    process.stdout.write(`${JSON.stringify(boundReceipt(
      path.resolve(first || ""),
      path.resolve(second || ""),
      path.resolve(third || ""),
    ), null, 2)}\n`);
  } else if (command === "verify-provider-binding") {
    process.stdout.write(`${verifyProviderBinding(
      path.resolve(first || ""),
      path.resolve(second || ""),
      path.resolve(third || ""),
    )}\n`);
  } else if (command === "provider-id") {
    process.stdout.write(`${providerIdFromReceipt(path.resolve(first || ""))}\n`);
  } else {
    throw new Error("Unbekannter Offsite-Vertragsvorgang.");
  }
} catch (error) {
  process.stderr.write(`${error?.message || "Offsite-Vertragspruefung fehlgeschlagen."}\n`);
  process.exitCode = 1;
}
