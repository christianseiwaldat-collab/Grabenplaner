#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { parseRedactedConfig } = require("./offsite-rclone-policy.js");

const REQUEST_FORMAT = "grabenplaner-offsite-target-control-request";
const RESPONSE_FORMAT = "grabenplaner-offsite-target-control-response";
const STATE_FORMAT = "grabenplaner-offsite-target-control-state";
const SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 1;
const MAX_REQUEST_BYTES = 2048;
const MAX_RCLONE_OUTPUT_BYTES = 64 * 1024;
const MAX_TARGET_SWITCH_OUTPUT_BYTES = 4096;
const MAX_FOLDER_COUNT = 100;
const RATE_LIMIT_SECONDS = 60;
const MANAGED_PREFIX = "Grabenplaner-Offsite";
const CONFIG_ROOT = "/etc/grabenplaner/offsite";
const INSTALLED_CONTRACT_NAME = "installed-contract.json";
const RUNTIME_ROOT = "/run/grabenplaner-offsite-target-control";
const STATE_PATH = `${RUNTIME_ROOT}/state.json`;
const RCLONE_WRAPPER = "/opt/grabenplaner-offsite/module/grabenplaner-offsite-rclone-wrapper.sh";
const TARGET_SWITCH_HELPER = "/opt/grabenplaner-offsite/module/grabenplaner-offsite-switch-target.sh";
const TARGET_SWITCH_FORMAT = "grabenplaner-offsite-target-switch-result";
const TARGET_SWITCH_SCHEMA_VERSION = 1;
const TARGET_SWITCH_TIMEOUT_MS = 31 * 60 * 1000;
const UPLOADER_HOME = "/var/lib/grabenplaner-offsite/uploader-home";
const OFFSITE_USER = "grabenplaner-offsite";
const RUNUSER = "/usr/sbin/runuser";
const ENV = "/usr/bin/env";
const ID = "/usr/bin/id";
const REQUEST_KEYS = new Set(["action", "format", "parameters", "requestId", "schemaVersion"]);
const EMPTY_PARAMETER_KEYS = new Set();
const FOLDER_PARAMETER_KEYS = new Set(["folderLabel"]);
const TARGET_SWITCH_RESULT_KEYS = new Set([
  "code",
  "fallbackPreserved",
  "format",
  "migrationMode",
  "ok",
  "recoverySetState",
  "schemaVersion",
]);
const STATE_KEYS = new Set([
  "format",
  "lastAction",
  "lastMutationAt",
  "lastRequestId",
  "schemaVersion",
]);
const ACTIONS = new Set([
  "status",
  "list-managed-folders",
  "create-managed-folder",
  "activate-managed-folder",
]);
const MUTATING_ACTIONS = new Set([
  "create-managed-folder",
  "activate-managed-folder",
]);
const SUCCESS_CODES = new Set([
  "TARGET_CONTROL_READY",
  "TARGET_FOLDERS_LISTED",
  "TARGET_FOLDER_CREATED",
  "TARGET_FOLDER_ACTIVATED",
]);
const TARGET_SWITCH_MIGRATION_MODES = new Set(["copied", "verified-existing"]);
const TARGET_SWITCH_RECOVERY_SET_STATE = "pending-offline-transfer-and-verification";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FOLDER_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,46}[A-Za-z0-9])?$/;
const REMOTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REPOSITORY_ID_PATTERN = /^[a-f0-9]{16,64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PROVIDER_BINDING_KEYS = new Set([
  "authentication",
  "backend",
  "configSha256",
  "endpoint",
  "format",
  "policySha256",
  "providerId",
  "region",
  "remoteName",
  "repositoryLayout",
  "schemaVersion",
  "scope",
  "storageRoot",
]);

class OffsiteTargetBrokerError extends Error {
  constructor(code) {
    super(code);
    this.name = "OffsiteTargetBrokerError";
    this.code = code;
  }
}

function fail(code = "TARGET_CONTROL_FAILED") {
  throw new OffsiteTargetBrokerError(code);
}

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function timingSafeCanonicalEqual(left, right) {
  const leftBuffer = Buffer.from(canonicalJson(left), "utf8");
  const rightBuffer = Buffer.from(canonicalJson(right), "utf8");
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function canonicalUtcTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validFolderLabel(value) {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= 48
    && FOLDER_LABEL_PATTERN.test(value);
}

function canonicalFolderList(folders) {
  if (!Array.isArray(folders) || folders.length > MAX_FOLDER_COUNT
    || folders.some((folder) => !validFolderLabel(folder))) {
    fail();
  }
  const seen = new Set();
  for (const folder of folders) {
    const folded = folder.toLowerCase();
    if (seen.has(folded)) fail();
    seen.add(folded);
  }
  return [...folders].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function parseRequest(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer.length > MAX_REQUEST_BYTES || buffer.includes(0)) {
    fail("TARGET_REQUEST_INVALID");
  }
  const text = buffer.toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r")) {
    fail("TARGET_REQUEST_INVALID");
  }
  let value;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    fail("TARGET_REQUEST_INVALID");
  }
  if (!exactKeys(value, REQUEST_KEYS)
    || value.format !== REQUEST_FORMAT
    || value.schemaVersion !== SCHEMA_VERSION
    || !ACTIONS.has(value.action)
    || !UUID_PATTERN.test(String(value.requestId || ""))) {
    fail("TARGET_REQUEST_INVALID");
  }
  const needsFolder = value.action === "create-managed-folder" || value.action === "activate-managed-folder";
  if (!exactKeys(value.parameters, needsFolder ? FOLDER_PARAMETER_KEYS : EMPTY_PARAMETER_KEYS)
    || (needsFolder && !validFolderLabel(value.parameters.folderLabel))) {
    fail("TARGET_REQUEST_INVALID");
  }
  return value;
}

function response(requestId, code, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  if (!canonicalUtcTimestamp(generatedAt)) fail();
  const ok = SUCCESS_CODES.has(code);
  const activeFolder = ok && validFolderLabel(options.activeFolder) ? options.activeFolder : null;
  const folders = ok ? canonicalFolderList(options.folders || []) : [];
  const createdFolder = code === "TARGET_FOLDER_CREATED" && validFolderLabel(options.createdFolder)
    ? options.createdFolder
    : null;
  const retryAfterSeconds = code === "TARGET_REQUEST_RATE_LIMITED"
    && Number.isSafeInteger(options.retryAfterSeconds)
    && options.retryAfterSeconds >= 1
    && options.retryAfterSeconds <= 900
    ? options.retryAfterSeconds
    : null;
  const activated = code === "TARGET_FOLDER_ACTIVATED";
  const migrationMode = activated && TARGET_SWITCH_MIGRATION_MODES.has(options.migrationMode)
    ? options.migrationMode
    : null;
  const recoverySetState = activated && options.recoverySetState === TARGET_SWITCH_RECOVERY_SET_STATE
    ? options.recoverySetState
    : null;
  const fallbackPreserved = activated && options.fallbackPreserved === true;
  if ((code === "TARGET_FOLDER_CREATED") !== (createdFolder !== null)
    || (code === "TARGET_REQUEST_RATE_LIMITED") !== (retryAfterSeconds !== null)
    || activated !== (migrationMode !== null
      && recoverySetState !== null
      && fallbackPreserved)
    || (activeFolder !== null && folders.length > 0 && !folders.includes(activeFolder))) {
    fail();
  }
  return {
    format: RESPONSE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    requestId: UUID_PATTERN.test(String(requestId || "")) ? requestId : crypto.randomUUID(),
    ok,
    code,
    generatedAt,
    activeFolder,
    folders,
    createdFolder,
    retryAfterSeconds,
    migrationMode,
    recoverySetState,
    fallbackPreserved,
  };
}

function assertSecureDirectory(directory, expectedMode, options = {}) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    fail();
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.platform !== "win32" && (stat.nlink < 2
      || (stat.mode & 0o7777) !== expectedMode || (stat.mode & 0o022) !== 0))
    || (options.requireRootOwner !== false && typeof stat.uid === "number" && (stat.uid !== 0 || stat.gid !== 0))) {
    fail();
  }
  return path.resolve(directory);
}

function readProtectedFile(filePath, limits, options = {}) {
  let descriptor;
  try {
    const before = fs.lstatSync(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size < limits.minimum || before.size > limits.maximum
      || (process.platform !== "win32" && (before.mode & 0o7777) !== 0o600)
      || (options.requireRootOwner !== false && typeof before.uid === "number"
        && (before.uid !== 0 || before.gid !== 0))) {
      fail();
    }
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY
      | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_CLOEXEC || 0));
    const after = fs.fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1 || after.size !== before.size) {
      fail();
    }
    const value = fs.readFileSync(descriptor);
    if (value.length !== before.size || value.includes(0)) fail();
    return value;
  } catch (error) {
    if (error instanceof OffsiteTargetBrokerError) throw error;
    fail();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function strictUtf8(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail();
  }
}

function oneLine(buffer) {
  const text = strictUtf8(buffer);
  const value = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!value || value.includes("\n") || value.includes("\r")) fail();
  return value;
}

function managedActiveFolder(repositoryPath) {
  const prefix = `${MANAGED_PREFIX}/`;
  if (!repositoryPath.startsWith(prefix)) return null;
  const label = repositoryPath.slice(prefix.length);
  return validFolderLabel(label) ? label : null;
}

function readBoundProvider(configRoot, options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "providerId")) {
    if (!["google_drive", "hetzner_object_storage", "backblaze_b2"].includes(options.providerId)) fail();
    return { providerId: options.providerId, remoteName: null };
  }
  let receipt;
  try {
    receipt = JSON.parse(strictUtf8(readProtectedFile(path.join(configRoot, INSTALLED_CONTRACT_NAME), {
      minimum: 128,
      maximum: 64 * 1024,
    }, options)));
  } catch (error) {
    if (error instanceof OffsiteTargetBrokerError) throw error;
    fail();
  }
  const binding = receipt?.providerBinding;
  if (receipt?.format !== "grabenplaner-linux-offsite-installed-contract"
    || receipt?.schemaVersion !== 1
    || !exactKeys(binding, PROVIDER_BINDING_KEYS)
    || binding.format !== "grabenplaner-offsite-provider-binding"
    || binding.schemaVersion !== 1
    || !HASH_PATTERN.test(String(binding.configSha256 || ""))
    || !HASH_PATTERN.test(String(binding.policySha256 || ""))
    || !REMOTE_PATTERN.test(String(binding.remoteName || ""))) {
    fail();
  }
  if (binding.providerId === "google_drive"
    && (binding.backend !== "drive"
      || binding.authentication !== "dedicated_oauth"
      || binding.scope !== "drive.file"
      || binding.endpoint !== null
      || binding.region !== null
      || binding.repositoryLayout !== "google-drive-direct-safe-path-v1"
      || binding.storageRoot !== null)) {
    fail();
  }
  return binding;
}

function readBoundProviderId(configRoot, options = {}) {
  return readBoundProvider(configRoot, options).providerId;
}

function readRootConfig(options = {}) {
  const configRoot = path.resolve(options.configRoot || CONFIG_ROOT);
  assertSecureDirectory(configRoot, 0o700, options);
  // Die verwaltete Ordnersteuerung ist bewusst eine Google-Drive-Funktion.
  // Fuer S3-Provider bleibt der gesamte Broker fail-closed, selbst wenn das
  // App-Environment faelschlich auf Google umbenannt wuerde.
  const providerBinding = readBoundProvider(configRoot, options);
  if (providerBinding.providerId !== "google_drive") fail();
  const repository = oneLine(readProtectedFile(path.join(configRoot, "repository"), {
    minimum: 10,
    maximum: 1024,
  }, options));
  const match = repository.match(/^rclone:([A-Za-z0-9][A-Za-z0-9_-]{0,63}):([A-Za-z0-9][A-Za-z0-9._/-]{0,511})$/);
  if (!match || !REMOTE_PATTERN.test(match[1])
    || providerBinding.remoteName !== null && match[1] !== providerBinding.remoteName
    || match[2].split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    fail();
  }
  const repositoryId = oneLine(readProtectedFile(path.join(configRoot, "repository-id"), {
    minimum: 16,
    maximum: 65,
  }, options)).toLowerCase();
  if (!REPOSITORY_ID_PATTERN.test(repositoryId)) fail();
  const password = readProtectedFile(path.join(configRoot, "rclone-config-password"), {
    minimum: 16,
    maximum: 1024,
  }, options);
  const passwordText = strictUtf8(password);
  const passwordWithoutTrailingWhitespace = passwordText.trimEnd();
  if (!passwordText.trim() || passwordWithoutTrailingWhitespace.includes("\n")
    || passwordWithoutTrailingWhitespace.includes("\r")) {
    fail();
  }
  return {
    configRoot,
    remote: match[1],
    repositoryPath: match[2],
    repositoryId,
    password,
    activeFolder: managedActiveFolder(match[2]),
    providerBinding,
  };
}

function assertStateDirectory(statePath, options = {}) {
  return assertSecureDirectory(path.dirname(path.resolve(statePath)), 0o755, options);
}

function readRateLimitState(statePath = STATE_PATH, options = {}) {
  assertStateDirectory(statePath, options);
  if (!fs.existsSync(statePath)) return null;
  let value;
  try {
    value = JSON.parse(strictUtf8(readProtectedFile(statePath, {
      minimum: 2,
      maximum: 4096,
    }, options)));
  } catch (error) {
    if (error instanceof OffsiteTargetBrokerError) throw error;
    fail();
  }
  if (!exactKeys(value, STATE_KEYS)
    || value.format !== STATE_FORMAT
    || value.schemaVersion !== STATE_SCHEMA_VERSION
    || !MUTATING_ACTIONS.has(value.lastAction)
    || !UUID_PATTERN.test(String(value.lastRequestId || ""))
    || !canonicalUtcTimestamp(value.lastMutationAt)) {
    fail();
  }
  return value;
}

function writeRateLimitState(statePath, value, options = {}) {
  const directory = assertStateDirectory(statePath, options);
  if (!exactKeys(value, STATE_KEYS)
    || value.format !== STATE_FORMAT
    || value.schemaVersion !== STATE_SCHEMA_VERSION
    || !MUTATING_ACTIONS.has(value.lastAction)
    || !UUID_PATTERN.test(String(value.lastRequestId || ""))
    || !canonicalUtcTimestamp(value.lastMutationAt)) {
    fail();
  }
  const temporary = path.join(directory, `.state.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY
      | fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_CLOEXEC || 0), 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, statePath);
    if (process.platform !== "win32") {
      const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best effort cleanup of a broker-owned, unpredictable temporary file.
    }
    if (error instanceof OffsiteTargetBrokerError) throw error;
    fail();
  }
}

function strictNumericCommand(result) {
  if (!result || result.error || result.status !== 0 || typeof result.stdout !== "string"
    || Buffer.byteLength(result.stdout, "utf8") > 32 || result.stdout.includes("\0") || result.stdout.includes("\r")) {
    fail();
  }
  const value = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  if (!/^[1-9][0-9]{0,9}$/.test(value)) fail();
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) fail();
  return numeric;
}

function uploaderIdentity(options = {}) {
  const runner = options.identitySpawnSync || childProcess.spawnSync;
  const common = {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 64,
    stdio: ["ignore", "pipe", "ignore"],
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
  };
  return {
    uid: strictNumericCommand(runner(ID, ["-u", OFFSITE_USER], common)),
    gid: strictNumericCommand(runner(ID, ["-g", OFFSITE_USER], common)),
  };
}

function safeRemoveCredentials(temporary, runtimeRoot, options = {}) {
  const resolvedRoot = path.resolve(runtimeRoot);
  const resolved = path.resolve(temporary);
  const lstatSync = options.lstatSync || fs.lstatSync;
  if (path.dirname(resolved) !== resolvedRoot || !/^credentials\.[A-Za-z0-9_-]+$/.test(path.basename(resolved))) {
    fail();
  }
  if (!fs.existsSync(resolved)) return;
  let stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    const chownSync = options.chownSync || fs.chownSync;
    const chmodSync = options.chmodSync || fs.chmodSync;
    try {
      chownSync(resolved, 0, 0);
      chmodSync(resolved, 0o700);
      stat = lstatSync(resolved);
    } catch {
      fail();
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (stat.mode & 0o7777) !== 0o700
      || (options.requireRootOwner !== false
        && typeof stat.uid === "number"
        && (stat.uid !== 0 || stat.gid !== 0))) {
      fail();
    }
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function defaultRunRclone(args, config, options = {}) {
  if (!Array.isArray(args) || args.length < 2 || args.some((entry) => typeof entry !== "string"
    || entry.includes("\0") || entry.includes("\r") || entry.includes("\n"))) {
    fail();
  }
  const runtimeRoot = assertSecureDirectory(path.resolve(options.runtimeRoot || RUNTIME_ROOT), 0o755, options);
  const identity = uploaderIdentity(options);
  const platform = options.platform || process.platform;
  const chownSync = options.chownSync || fs.chownSync;
  const temporary = fs.mkdtempSync(path.join(runtimeRoot, "credentials."));
  const passwordPath = path.join(temporary, "rclone-config-password");
  let descriptor;
  try {
    fs.chmodSync(temporary, 0o700);
    descriptor = fs.openSync(passwordPath, fs.constants.O_WRONLY
      | fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_CLOEXEC || 0), 0o400);
    fs.writeFileSync(descriptor, config.password);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (platform !== "win32") {
      chownSync(passwordPath, identity.uid, identity.gid);
      chownSync(temporary, identity.uid, identity.gid);
    }
    const runner = options.rcloneSpawnSync || childProcess.spawnSync;
    return runner(RUNUSER, [
      "--user",
      OFFSITE_USER,
      "--",
      ENV,
      "-i",
      `HOME=${UPLOADER_HOME}`,
      `USER=${OFFSITE_USER}`,
      `LOGNAME=${OFFSITE_USER}`,
      "PATH=/opt/grabenplaner-offsite/bin:/usr/bin:/bin",
      `CREDENTIALS_DIRECTORY=${temporary}`,
      RCLONE_WRAPPER,
      ...args,
    ], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: MAX_RCLONE_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/sbin:/usr/bin:/bin" },
    });
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The outer failure remains authoritative.
      }
    }
    if (error instanceof OffsiteTargetBrokerError) throw error;
    fail();
  } finally {
    safeRemoveCredentials(temporary, runtimeRoot, options);
  }
}

function runRclone(args, config, options = {}) {
  const runner = options.runRclone || defaultRunRclone;
  let result;
  try {
    result = runner(args, config, options);
  } catch (error) {
    if (error instanceof OffsiteTargetBrokerError) throw error;
    fail();
  }
  if (!result || result.error || !Number.isSafeInteger(result.status)
    || result.status < 0 || result.status > 9
    || typeof result.stdout !== "string"
    || typeof result.stderr !== "string"
    || Buffer.byteLength(result.stdout, "utf8") > MAX_RCLONE_OUTPUT_BYTES
    || Buffer.byteLength(result.stderr, "utf8") > 8192
    || result.stdout.includes("\0")
    || result.stderr.includes("\0")) {
    fail();
  }
  return result;
}

function assertLiveProviderBinding(config, options = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)
    || !REMOTE_PATTERN.test(String(config.remote || ""))
    || typeof config.repositoryPath !== "string"
    || typeof config.configRoot !== "string") {
    fail();
  }

  // Receipt und Repository werden direkt vor jedem rclone-Listen- oder
  // Schreibzugriff nochmals gelesen. Damit kann weder ein zwischenzeitlicher
  // Remote-Wechsel noch eine ausgetauschte Bindung mit einem bereits
  // eingelesenen Request-Kontext weiterarbeiten.
  const liveBinding = readBoundProvider(config.configRoot, options);
  const liveRepository = oneLine(readProtectedFile(path.join(config.configRoot, "repository"), {
    minimum: 10,
    maximum: 1024,
  }, options));
  if (liveRepository !== `rclone:${config.remote}:${config.repositoryPath}`
    || !timingSafeCanonicalEqual(liveBinding, config.providerBinding)) {
    fail();
  }

  const result = runRclone(["config", "redacted", config.remote], config, options);
  if (result.status !== 0) fail();
  const policy = parseRedactedConfig(result.stdout, config.remote);
  if (!policy) fail();
  const expectedBinding = {
    format: "grabenplaner-offsite-provider-binding",
    schemaVersion: 1,
    providerId: policy.providerId,
    remoteName: policy.remoteName,
    backend: policy.backend,
    authentication: policy.authentication,
    endpoint: policy.endpoint,
    region: policy.region,
    scope: policy.scope,
    configSha256: policy.configSha256,
    policySha256: crypto.createHash("sha256")
      .update(canonicalJson(policy), "utf8")
      .digest("hex"),
    repositoryLayout: "google-drive-direct-safe-path-v1",
    storageRoot: null,
  };
  if (policy.providerId !== "google_drive"
    || !timingSafeCanonicalEqual(liveBinding, expectedBinding)) {
    fail();
  }
}

function parseRcloneFolderList(result) {
  if (result.status === 3) return [];
  if (result.status !== 0) fail();
  let entries;
  try {
    entries = JSON.parse(result.stdout);
  } catch {
    fail();
  }
  if (!Array.isArray(entries) || entries.length > MAX_FOLDER_COUNT) fail();
  const folders = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.getPrototypeOf(entry) !== Object.prototype
      || entry.IsDir !== true
      || typeof entry.Name !== "string"
      || typeof entry.Path !== "string"
      || entry.Name !== entry.Path
      || !validFolderLabel(entry.Name)) {
      fail();
    }
    folders.push(entry.Name);
  }
  return canonicalFolderList(folders);
}

function listManagedFolders(config, options = {}) {
  assertLiveProviderBinding(config, options);
  const result = runRclone([
    "lsjson",
    `${config.remote}:${MANAGED_PREFIX}`,
    "--dirs-only",
    "--max-depth",
    "1",
  ], config, options);
  const folders = parseRcloneFolderList(result);
  if (config.activeFolder !== null && !folders.includes(config.activeFolder)) fail();
  return folders;
}

function createManagedFolder(config, folderLabel, options = {}) {
  if (!validFolderLabel(folderLabel)) fail();
  assertLiveProviderBinding(config, options);
  const result = runRclone([
    "mkdir",
    `${config.remote}:${MANAGED_PREFIX}/${folderLabel}`,
  ], config, options);
  if (result.status !== 0 || result.stdout.trim() !== "") fail();
}

function parseTargetSwitchResult(result) {
  if (!result || result.error || ![0, 1, 2].includes(result.status)
    || typeof result.stdout !== "string"
    || typeof result.stderr !== "string"
    || Buffer.byteLength(result.stdout, "utf8") > MAX_TARGET_SWITCH_OUTPUT_BYTES
    || Buffer.byteLength(result.stderr, "utf8") > 8192
    || result.stdout.includes("\0")
    || result.stderr.includes("\0")
    || !result.stdout.endsWith("\n")
    || result.stdout.slice(0, -1).includes("\n")
    || result.stdout.includes("\r")) {
    fail();
  }
  let value;
  try {
    value = JSON.parse(result.stdout.slice(0, -1));
  } catch {
    fail();
  }
  if (!exactKeys(value, TARGET_SWITCH_RESULT_KEYS)
    || value.format !== TARGET_SWITCH_FORMAT
    || value.schemaVersion !== TARGET_SWITCH_SCHEMA_VERSION
    || typeof value.ok !== "boolean"
    || typeof value.fallbackPreserved !== "boolean") {
    fail();
  }
  if (result.status === 0) {
    if (value.ok !== true
      || value.code !== "TARGET_FOLDER_ACTIVATED"
      || !TARGET_SWITCH_MIGRATION_MODES.has(value.migrationMode)
      || value.recoverySetState !== TARGET_SWITCH_RECOVERY_SET_STATE
      || value.fallbackPreserved !== true) {
      fail();
    }
    return value;
  }
  const expectedCode = result.status === 2 ? "TARGET_SWITCH_REQUEST_INVALID" : "TARGET_SWITCH_FAILED";
  if (value.ok !== false
    || value.code !== expectedCode
    || value.migrationMode !== null
    || value.recoverySetState !== null
    || value.fallbackPreserved !== false) {
    fail();
  }
  fail();
}

function defaultRunTargetSwitch(folderLabel, options = {}) {
  if (!validFolderLabel(folderLabel)) fail();
  const runner = options.targetSwitchSpawnSync || childProcess.spawnSync;
  return runner(TARGET_SWITCH_HELPER, ["--folder-label", folderLabel], {
    encoding: "utf8",
    timeout: TARGET_SWITCH_TIMEOUT_MS,
    maxBuffer: MAX_TARGET_SWITCH_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/sbin:/usr/bin:/bin" },
  });
}

function activateManagedFolder(folderLabel, options = {}) {
  if (!validFolderLabel(folderLabel)) fail();
  const runner = options.runTargetSwitch || defaultRunTargetSwitch;
  let result;
  try {
    result = runner(folderLabel, options);
  } catch (error) {
    if (error instanceof OffsiteTargetBrokerError) throw error;
    fail();
  }
  return parseTargetSwitchResult(result);
}

function rateLimitResult(request, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const now = new Date(nowMs);
  if (!canonicalUtcTimestamp(now.toISOString())) fail();
  const stateBasePath = path.resolve(options.statePath || STATE_PATH);
  const stateSuffix = request.action === "create-managed-folder" ? "create" : "activate";
  const statePath = `${stateBasePath}.${stateSuffix}`;
  const state = readRateLimitState(statePath, options);
  if (state) {
    if (state.lastAction !== request.action) fail();
    const elapsedSeconds = Math.floor((nowMs - Date.parse(state.lastMutationAt)) / 1000);
    if (!Number.isSafeInteger(elapsedSeconds) || elapsedSeconds < 0) fail();
    if (elapsedSeconds < RATE_LIMIT_SECONDS) {
      return {
        limited: true,
        retryAfterSeconds: RATE_LIMIT_SECONDS - elapsedSeconds,
      };
    }
  }
  writeRateLimitState(statePath, {
    format: STATE_FORMAT,
    schemaVersion: STATE_SCHEMA_VERSION,
    lastMutationAt: now.toISOString(),
    lastRequestId: request.requestId,
    lastAction: request.action,
  }, options);
  return { limited: false, retryAfterSeconds: null };
}

function handleRequest(buffer, options = {}) {
  let request;
  try {
    request = parseRequest(buffer);
  } catch (error) {
    return response(null, error?.code === "TARGET_REQUEST_INVALID" ? error.code : "TARGET_CONTROL_FAILED", options);
  }

  let config;
  try {
    config = readRootConfig(options);
    if (request.action === "status") {
      return response(request.requestId, "TARGET_CONTROL_READY", {
        ...options,
        activeFolder: config.activeFolder,
      });
    }

    const folders = listManagedFolders(config, options);
    if (request.action === "list-managed-folders") {
      return response(request.requestId, "TARGET_FOLDERS_LISTED", {
        ...options,
        activeFolder: config.activeFolder,
        folders,
      });
    }

    const folderLabel = request.parameters.folderLabel;
    if (request.action === "activate-managed-folder") {
      if (!folders.includes(folderLabel)) {
        return response(request.requestId, "TARGET_FOLDER_NOT_FOUND", options);
      }
      if (config.activeFolder === folderLabel) {
        return response(request.requestId, "TARGET_FOLDER_ALREADY_ACTIVE", options);
      }
      const rateLimit = rateLimitResult(request, options);
      if (rateLimit.limited) {
        return response(request.requestId, "TARGET_REQUEST_RATE_LIMITED", {
          ...options,
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        });
      }
      const switchResult = activateManagedFolder(folderLabel, options);
      let switchedConfig;
      try {
        switchedConfig = readRootConfig(options);
        if (switchedConfig.activeFolder !== folderLabel) fail();
        const switchedFolders = listManagedFolders(switchedConfig, options);
        if (!switchedFolders.includes(folderLabel)) fail();
        return response(request.requestId, "TARGET_FOLDER_ACTIVATED", {
          ...options,
          activeFolder: folderLabel,
          folders: switchedFolders,
          migrationMode: switchResult.migrationMode,
          recoverySetState: switchResult.recoverySetState,
          fallbackPreserved: switchResult.fallbackPreserved,
        });
      } finally {
        if (Buffer.isBuffer(switchedConfig?.password)) switchedConfig.password.fill(0);
      }
    }

    if (folders.some((folder) => folder.toLowerCase() === folderLabel.toLowerCase())) {
      return response(request.requestId, "TARGET_FOLDER_EXISTS", options);
    }
    if (folders.length >= MAX_FOLDER_COUNT) {
      return response(request.requestId, "TARGET_FOLDER_LIMIT_REACHED", options);
    }
    const rateLimit = rateLimitResult(request, options);
    if (rateLimit.limited) {
      return response(request.requestId, "TARGET_REQUEST_RATE_LIMITED", {
        ...options,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
    }
    createManagedFolder(config, folderLabel, options);
    return response(request.requestId, "TARGET_FOLDER_CREATED", {
      ...options,
      activeFolder: config.activeFolder,
      createdFolder: folderLabel,
      folders: canonicalFolderList([...folders, folderLabel]),
    });
  } catch {
    return response(request.requestId, "TARGET_CONTROL_FAILED", options);
  } finally {
    if (Buffer.isBuffer(config?.password)) config.password.fill(0);
  }
}

function readStandardInput() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => reject(new OffsiteTargetBrokerError("TARGET_REQUEST_INVALID")), 2000);
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        clearTimeout(timer);
        process.stdin.destroy();
        reject(new OffsiteTargetBrokerError("TARGET_REQUEST_INVALID"));
      } else {
        chunks.push(chunk);
      }
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      reject(new OffsiteTargetBrokerError("TARGET_REQUEST_INVALID"));
    });
  });
}

function writeStandardOutput(value, output = process.stdout) {
  const payload = `${JSON.stringify(value)}\n`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      output.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = () => finish(new OffsiteTargetBrokerError("TARGET_CONTROL_FAILED"));
    output.once("error", onError);
    try {
      output.end(payload, (error) => {
        if (error) {
          if (!settled) {
            settled = true;
            reject(new OffsiteTargetBrokerError("TARGET_CONTROL_FAILED"));
          }
          return;
        }
        finish(null);
      });
    } catch {
      finish(new OffsiteTargetBrokerError("TARGET_CONTROL_FAILED"));
    }
  });
}

async function main() {
  if (process.platform !== "linux"
    || typeof process.getuid !== "function"
    || process.getuid() !== 0
    || process.argv.length !== 2) {
    process.exitCode = 1;
    return;
  }
  let result;
  try {
    result = handleRequest(await readStandardInput());
  } catch {
    result = response(null, "TARGET_REQUEST_INVALID");
  }
  await writeStandardOutput(result);
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  ACTIONS,
  CONFIG_ROOT,
  FOLDER_LABEL_PATTERN,
  MANAGED_PREFIX,
  MAX_FOLDER_COUNT,
  MAX_REQUEST_BYTES,
  MAX_RCLONE_OUTPUT_BYTES,
  MAX_TARGET_SWITCH_OUTPUT_BYTES,
  OFFSITE_USER,
  OffsiteTargetBrokerError,
  RATE_LIMIT_SECONDS,
  REQUEST_FORMAT,
  RESPONSE_FORMAT,
  RUNTIME_ROOT,
  SCHEMA_VERSION,
  STATE_FORMAT,
  STATE_PATH,
  STATE_SCHEMA_VERSION,
  TARGET_SWITCH_FORMAT,
  TARGET_SWITCH_HELPER,
  TARGET_SWITCH_MIGRATION_MODES,
  TARGET_SWITCH_RECOVERY_SET_STATE,
  TARGET_SWITCH_SCHEMA_VERSION,
  TARGET_SWITCH_TIMEOUT_MS,
  activateManagedFolder,
  assertLiveProviderBinding,
  canonicalFolderList,
  createManagedFolder,
  defaultRunTargetSwitch,
  defaultRunRclone,
  handleRequest,
  listManagedFolders,
  managedActiveFolder,
  parseRcloneFolderList,
  parseRequest,
  parseTargetSwitchResult,
  readBoundProviderId,
  readRateLimitState,
  readRootConfig,
  response,
  runRclone,
  safeRemoveCredentials,
  uploaderIdentity,
  validFolderLabel,
  writeStandardOutput,
  writeRateLimitState,
};
