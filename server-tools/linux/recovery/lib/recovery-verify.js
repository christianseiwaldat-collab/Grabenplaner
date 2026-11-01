"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { compareSemver, encryptionConfiguration, protectedRecordChecks } = require("./recovery-shared");
const { __internalTestOnly, assertFrozenTree } = require("./recovery-metadata.js");


function fail(message) { throw new Error(message); }

function regular(file, { maximumBytes = 16 * 1024 * 1024 } = {}) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximumBytes) {
    fail("Eine Recovery-Pruefdatei ist unzulaessig.");
  }
  return stat;
}

function readJson(file, options) {
  regular(file, options);
  const value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Recovery-Metadaten sind ungueltig.");
  return value;
}

function atomicJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o400);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.chmodSync(temporary, 0o400);
  fs.renameSync(temporary, file);
  if (process.platform !== "win32") {
    const directoryHandle = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
    try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
  }
}

function runNode(script, args) {
  regular(script, { maximumBytes: 4 * 1024 * 1024 });
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) fail("Eine isolierte Recovery-Pruefung ist fehlgeschlagen.");
  return String(result.stdout || "");
}

function readEnvironment(file, internalPolicy) {
  const stat = regular(file, { maximumBytes: 64 * 1024 });
  const requireRootOwner = process.platform === "linux"
    && internalPolicy !== __internalTestOnly.nonRootOwnershipPolicy;
  if (process.platform === "linux" && ((requireRootOwner && stat.uid !== 0) || (stat.mode & 0o077) !== 0)) {
    fail("Die Recovery-Schluesseldatei ist unzulaessig.");
  }
  const values = new Map();
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) fail("Die Recovery-Schluesseldatei enthaelt eine ungueltige Zeile.");
    if (values.has(match[1])) fail("Die Recovery-Schluesseldatei enthaelt doppelte Werte.");
    values.set(match[1], match[2]);
  }
  return values;
}

async function verifyRecovery(options, internalPolicy) {
  const stage = path.resolve(options.stage);
  const stageStat = fs.lstatSync(stage);
  if (!path.isAbsolute(options.stage) || stage === path.parse(stage).root || !stageStat.isDirectory() || stageStat.isSymbolicLink()) {
    fail("Der Recovery-Baum ist unzulaessig.");
  }
  const frozenFiles = assertFrozenTree(stage, internalPolicy);
  const stageOutput = JSON.parse(runNode(path.resolve(options.stageHelper), ["verify", stage]));
  if (stageOutput.providerId === "postgresql-pair") {
    const result = await require("./postgresql-recovery").verifyPostgresqlRecovery({
      stageOutput, stage, frozenFiles,
      sourcePackage: readJson(path.join(stage, "recovery", "package.json")),
      targetPackage: readJson(path.resolve(options.targetPackage)),
      sourceRuntime: readJson(path.join(stage, "recovery", "runtime-schema.json")),
      targetRuntime: readJson(path.resolve(options.targetRuntime)),
    });
    atomicJson(path.resolve(options.output), result);
    return result;
  }
  throw Object.assign(new Error("SQLite-Sicherungen duerfen nur mit der archivierten Offline-Recovery wiederhergestellt werden; der aktuelle GP unterstuetzt ausschliesslich PostgreSQL-Paare."), { code: "RECOVERY_LEGACY_OFFLINE_REQUIRED" });
}

function parseArguments(argv) {
  const names = new Set(["stage", "stage-helper", "backup-verifier", "amu-module", "integration-module", "environment", "target-package", "target-runtime", "scratch-root", "output"]);
  const options = {};
  const args = [...argv];
  while (args.length) {
    const name = String(args.shift() || "");
    if (!name.startsWith("--") || !names.has(name.slice(2)) || !args.length) fail("Recovery-Pruefparameter sind unvollstaendig.");
    if (Object.hasOwn(options, name.slice(2))) fail("Recovery-Pruefparameter sind doppelt.");
    options[name.slice(2)] = String(args.shift());
  }
  for (const name of names) if (name !== "scratch-root" && !options[name]) fail("Recovery-Pruefparameter sind unvollstaendig.");
  return {
    stage: options.stage,
    stageHelper: options["stage-helper"],
    backupVerifier: options["backup-verifier"],
    amuModule: options["amu-module"],
    integrationModule: options["integration-module"],
    environment: options.environment,
    targetPackage: options["target-package"],
    targetRuntime: options["target-runtime"],
    scratchRoot: options["scratch-root"],
    output: options.output,
  };
}

const PUBLIC_RECOVERY_FAILURES = new Set([
  "PG_RECOVERY_STALLED", "PG_RECOVERY_ACTIVITY_UNAVAILABLE", "PG_RECOVERY_STOP_UNCONFIRMED",
  "PG_RECOVERY_INTERRUPTED", "PG_RECOVERY_WORKER_FAILED", "PG_RECOVERY_CLEANUP_FAILED",
  "PG_RECOVERY_CLEANUP_GUARD", "PG_RECOVERY_APPLICATION_SMOKE", "PG_RECOVERY_RESULT_BINDING",
  "RECOVERY_LEGACY_OFFLINE_REQUIRED",
]);
function recoveryFailureDiagnostic(error) {
  const code = PUBLIC_RECOVERY_FAILURES.has(error?.code) ? error.code
    : PUBLIC_RECOVERY_FAILURES.has(error?.message) ? error.message : "RECOVERY_VERIFY_FAILED";
  return { event: "recovery-verification-failed", code };
}

if (require.main === module) {
  Promise.resolve().then(() => verifyRecovery({ ...parseArguments(process.argv.slice(2)), requiredProvider: "postgresql-pair" }))
    .then((result) => process.stdout.write(`${JSON.stringify({ ok: true, databaseSha256: result.databaseSha256 })}\n`))
    .catch((error) => { process.stderr.write(`${JSON.stringify(recoveryFailureDiagnostic(error))}\n`); process.exitCode = 1; });
}

module.exports = {
  compareSemver,
  readEnvironment,
  protectedRecordChecks,
  encryptionConfiguration,
  verifyRecovery,
  recoveryFailureDiagnostic,
};
