"use strict";

// A recent successful full recovery run permits an ordinary code update to
// defer archive work. It never replaces the fresh, fully verified rollback pair.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { deploymentSchemaSnapshotFromFile } = require("../../../lib/persistence/sqlite/operations/maintenance");
const { sha256File } = require("../../../lib/file-integrity");
const FORMAT = "grabenplaner-deploy-verification";
const MAX_AGE_MS = 36 * 60 * 60 * 1000;
const PROOF_FILE = "/var/lib/grabenplaner-assurance/deploy-verification.json";
const HISTORY_ROOT = "/var/lib/grabenplaner-assurance";
const OFFSITE_ROOT = "/opt/grabenplaner-offsite/module";
const HASH = /^[a-f0-9]{64}$/;
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function criticalPath(relative) {
  if (relative.startsWith("public/")) return false;
  return relative === "server.js" || relative === "pnpm-lock.yaml"
    || relative.startsWith("server-tools/") || relative.startsWith("lib/persistence/")
    || /(?:migration|schema|database|backup|recovery|vault|storage|file-integrity|runtime-config)/i.test(relative);
}

function readRegular(file, maxBytes = 2 * 1024 * 1024, { rootOnly = false } = {}) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes
    || rootOnly && (before.uid !== 0 || (before.mode & 0o022))) throw new Error("DEPLOY_FILE_INVALID");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const after = fs.lstatSync(file);
    if (opened.dev !== before.dev || opened.ino !== before.ino || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size) throw new Error("DEPLOY_FILE_CHANGED");
    return bytes;
  } finally { fs.closeSync(fd); }
}

function applicationContract(root) {
  const manifest = JSON.parse(readRegular(path.join(root, "grabenplaner-server-manifest.json")));
  const metadata = JSON.parse(readRegular(path.join(root, "package.json")));
  if (manifest.format !== "grabenplaner-server-package" || manifest.schemaVersion !== 1
    || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10000
    || manifest.appVersion !== metadata.version) throw new Error("DEPLOY_MANIFEST_INVALID");
  const seen = new Set(), critical = [];
  for (const entry of manifest.files) {
    const relative = entry?.path;
    if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.startsWith("/")
      || relative.split("/").some(part => !part || part === "." || part === "..")
      || /[\x00-\x1f\x7f]/.test(relative) || seen.has(relative) || !HASH.test(entry.sha256 || "")) throw new Error("DEPLOY_MANIFEST_INVALID");
    seen.add(relative);
    if (criticalPath(relative) || relative === "package.json") {
      const file = path.join(root, ...relative.split("/"));
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== entry.bytes
        || sha256File(file) !== entry.sha256) throw new Error("DEPLOY_CONTRACT_CHANGED");
      if (relative !== "package.json") critical.push([relative, entry.sha256]);
    }
  }
  for (const required of ["server.js", "package.json", "pnpm-lock.yaml", "lib/backup-maintenance.js",
    "server-tools/linux/runtime-schema.json", "server-tools/linux/offsite/module-schema.json"]) {
    if (!seen.has(required)) throw new Error("DEPLOY_CONTRACT_INCOMPLETE");
  }
  critical.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { appVersion: metadata.version, fingerprint: digest({ critical,
    runtime: { engines: metadata.engines, packageManager: metadata.packageManager, dependencies: metadata.dependencies } }) };
}

function databaseIdentity(databasePath) {
  const resolved = fs.realpathSync(databasePath), info = fs.lstatSync(databasePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("DEPLOY_DATABASE_INVALID");
  return { databasePath: resolved, schemaSha256: digest(deploymentSchemaSnapshotFromFile(resolved)) };
}

function postgresqlPairIdentity({ core, sales } = {}) {
  if (!core || !sales || core.clusterId !== sales.clusterId || !/^[0-9]+$/.test(String(core.clusterId || ""))
    || core.database === sales.database || [core, sales].some(item => !/^[a-z][a-z0-9_]{0,62}$/.test(item.database || "")
      || !HASH.test(item.schemaSha256 || "") || typeof item.environmentId !== "string" || !item.environmentId)) {
    throw new Error("DEPLOY_POSTGRESQL_PAIR_INVALID");
  }
  const pair = [core, sales].map((item, index) => ({ domain: index === 0 ? "core" : "sales", clusterId: item.clusterId,
    database: item.database, environmentId: item.environmentId, schemaSha256: item.schemaSha256 }));
  return { providerId: "postgresql-pair", databaseIdentitySha256: digest(pair), schemaSha256: digest(pair.map(item => [item.domain, item.schemaSha256])) };
}

function sameDatabaseIdentity(proof, identity) {
  if (identity?.providerId === "postgresql-pair") {
    return proof.schemaVersion === 2 && proof.providerId === "postgresql-pair"
      && HASH.test(identity.databaseIdentitySha256 || "") && proof.databaseIdentitySha256 === identity.databaseIdentitySha256
      && proof.schemaSha256 === identity.schemaSha256;
  }
  return proof.schemaVersion === 1 && (!proof.providerId || proof.providerId === "sqlite")
    && (!identity?.providerId || identity.providerId === "sqlite")
    && proof.databasePath === identity?.databasePath && proof.schemaSha256 === identity?.schemaSha256;
}

function configurationIdentity(envFile) {
  const files = [envFile, "/etc/grabenplaner/offsite/installed-contract.json",
    "/etc/grabenplaner/offsite/repository-id", "/etc/grabenplaner/offsite/installation-id", "/etc/caddy/Caddyfile"];
  if (require("node:util").parseEnv(readRegular(envFile, 65536, { rootOnly: true }).toString("utf8")).DB_PROVIDER === "postgresql") {
    files.push("/etc/grabenplaner/postgresql-operations.json");
  }
  // No configuration values, tokens or credentials are emitted or saved.
  const hashes = files.map(file => [file, crypto.createHash("sha256").update(readRegular(file, 2 * 1024 * 1024, { rootOnly: true })).digest("hex")]);
  hashes.push(["node", sha256File(process.execPath)]);
  return digest(hashes);
}

function evaluateDeploy({ installed, candidate, proof, history, identity, configurationSha256, now = Date.now(), timerActive = false }) {
  const full = reason => ({ mode: "full", reason });
  if (!installed || !candidate || !HASH.test(installed.fingerprint || "") || installed.fingerprint !== candidate.fingerprint) return full("RECOVERY_CONTRACT_CHANGED");
  if (!timerActive) return full("NIGHTLY_TIMER_UNAVAILABLE");
  if (!proof || proof.format !== FORMAT || !sameDatabaseIdentity(proof, identity) || proof.contractSha256 !== installed.fingerprint
    || proof.configurationSha256 !== configurationSha256 || !HASH.test(proof.configurationSha256 || "")
    || !HASH.test(proof.schemaSha256 || "")) return full("VERIFICATION_BINDING_CHANGED");
  const verifiedAt = Date.parse(proof.verifiedAt);
  if (!Number.isFinite(now) || !Number.isFinite(verifiedAt) || now < verifiedAt || now - verifiedAt > MAX_AGE_MS) return full("VERIFICATION_EXPIRED");
  if (!history?.ok || !Array.isArray(history.events)) return full("HISTORY_UNVERIFIED");
  const pass = history.events.find(event => event.eventHash === proof.eventHash && event.sequence === proof.sequence);
  if (pass?.payload?.eventType !== "full-assurance-passed" || pass.payload.runId !== proof.runId
    || pass.payload.occurredAt !== proof.verifiedAt || pass.payload.evidence?.receiptSha256 !== proof.receiptSha256
    || !HASH.test(proof.receiptSha256 || "")) return full("VERIFICATION_NOT_CONFIRMED");
  // An unfinished/failed run, changed configuration or server migration
  // invalidates the previous pass. Ordinary deferred app updates may queue.
  if (history.events.some(event => event.sequence > proof.sequence
    && !(event.payload?.eventType === "update-queued" && event.payload.trigger === "app-updated"))) return full("NEW_RECOVERY_WORK_PENDING");
  return { mode: "short", reason: "RECENT_FULL_RECOVERY", verifiedAt: proof.verifiedAt, runId: proof.runId,
    receiptSha256: proof.receiptSha256, maximumAgeHours: MAX_AGE_MS / 3600000 };
}

function inspectedHistory() {
  const info = fs.lstatSync(HISTORY_ROOT);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o777) !== 0o750) throw new Error("DEPLOY_HISTORY_INVALID");
  return require(path.join(OFFSITE_ROOT, "lib/assurance-history.js")).inspectHistory({ root: HISTORY_ROOT, statusGid: info.gid });
}

async function configuredDatabaseIdentity(databasePath, envFile) {
  const environment = require("node:util").parseEnv(readRegular(envFile, 65536, { rootOnly: true }).toString("utf8"));
  const provider = String(environment.DB_PROVIDER || "sqlite");
  if (provider === "sqlite") return databaseIdentity(databasePath);
  if (provider !== "postgresql") throw new Error("DEPLOY_PROVIDER_INVALID");
  const operations = require("../../../lib/persistence/postgresql/operations/runtime");
  const configuration = operations.loadConfiguration("/etc/grabenplaner/postgresql-operations.json");
  return postgresqlPairIdentity(await operations.inspectPair(configuration));
}

async function recordVerification({ appRoot, databasePath, envFile, runId }) {
  const history = inspectedHistory(), event = history.events.at(-1);
  const contract = applicationContract(appRoot);
  if (event?.payload.eventType !== "full-assurance-passed" || event.payload.runId !== runId
    || event.payload.evidence.appVersion !== contract.appVersion) throw new Error("DEPLOY_FULL_RECOVERY_REQUIRED");
  const identity = await configuredDatabaseIdentity(databasePath, envFile);
  const proof = { format: FORMAT, schemaVersion: identity.providerId === "postgresql-pair" ? 2 : 1, contractSha256: contract.fingerprint, ...identity,
    configurationSha256: configurationIdentity(envFile), verifiedAt: event.payload.occurredAt,
    runId, sequence: event.sequence, eventHash: event.eventHash, receiptSha256: event.payload.evidence.receiptSha256 };
  const temporary = `${PROOF_FILE}.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(proof)}\n`); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, PROOF_FILE);
    fd = fs.openSync(HISTORY_ROOT, "r"); fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { ok: true, verifiedAt: proof.verifiedAt, runId };
}

async function main(args = process.argv.slice(2)) {
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("DEPLOY_ROOT_REQUIRED");
  const [action, ...values] = args;
  if (action === "record" && values.length === 4) {
    const [appRoot, databasePath, envFile, runId] = values;
    return recordVerification({ appRoot, databasePath, envFile, runId });
  }
  if (action === "decide" && values.length === 5) {
    const [appRoot, candidateRoot, databasePath, envFile, timerActive] = values;
    try {
      return evaluateDeploy({ installed: applicationContract(appRoot), candidate: applicationContract(candidateRoot),
        proof: JSON.parse(readRegular(PROOF_FILE, 16384, { rootOnly: true })), history: inspectedHistory(),
        identity: await configuredDatabaseIdentity(databasePath, envFile), configurationSha256: configurationIdentity(envFile), timerActive: timerActive === "1" });
    } catch { return { mode: "full", reason: "VERIFICATION_UNAVAILABLE" }; }
  }
  throw new Error("DEPLOY_ARGUMENTS_INVALID");
}

if (require.main === module) {
  main().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(() => {
    process.stderr.write("Die Deploy-Pruefgrundlage konnte nicht bestaetigt werden.\n"); process.exitCode = 1;
  });
}
module.exports = { applicationContract, criticalPath, databaseIdentity, postgresqlPairIdentity, sameDatabaseIdentity, evaluateDeploy, MAX_AGE_MS, FORMAT };
