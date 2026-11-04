"use strict";

// Explicit schema activation on the unchanged compatible application. The
// caller owns service/timer orchestration, the existing FD9 lease, and durable
// intent/result receipts. This entrypoint never swaps code or restarts services.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const R = require("../../../lib/persistence/postgresql/operations/runtime");
const { createBackupBudget, boundedSnapshotClient } = require("../../../lib/persistence/postgresql/operations/backup-budget");
const APP = "/opt/grabenplaner/app", CONFIG = "/etc/grabenplaner/postgresql-operations.json";
const FORMAT = "grabenplaner-passkeys-schema-activation", HASH = /^[a-f0-9]{64}$/;
const CONFIGURATION_FILES = Object.freeze([CONFIG, "/etc/grabenplaner/grabenplaner.env",
  "/etc/grabenplaner/postgresql-application.json", "/var/lib/grabenplaner/data/postgresql-pair.json"]);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function readProtected(file, maximum = 4 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  const signature = value => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.mode, value.uid, value.nlink].join(":");
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o022)
    || stat.size < 1 || stat.size > maximum || fs.realpathSync(file) !== file) throw new Error("PG_PASSKEYS_ACTIVATION_FILE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (signature(fs.fstatSync(fd)) !== signature(stat)) throw new Error("PG_PASSKEYS_ACTIVATION_FILE_CHANGED");
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== stat.size || signature(fs.fstatSync(fd)) !== signature(stat)
      || signature(fs.lstatSync(file)) !== signature(stat)) throw new Error("PG_PASSKEYS_ACTIVATION_FILE_CHANGED");
    return bytes;
  } finally { fs.closeSync(fd); }
}

function assertLease() {
  if (fs.realpathSync("/proc/self/fd/9") !== "/run/grabenplaner/maintenance.lock"
    || spawnSync("/usr/bin/flock", ["--nonblock", "9"], {
      stdio: Array.from({ length: 10 }, (_, index) => index === 9 ? 9 : "ignore"), timeout: 5000,
    }).status !== 0) throw new Error("PG_PASSKEYS_ACTIVATION_LEASE");
}

function assertEmptyCgroup() {
  const base = "/sys/fs/cgroup", parent = base + "/system.slice", group = parent + "/grabenplaner.service";
  function directory(file) {
    const info = fs.lstatSync(file);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || fs.realpathSync(file) !== file) {
      throw new Error("PG_PASSKEYS_ACTIVATION_CGROUP");
    }
  }
  directory(base); directory(parent);
  try { directory(group); }
  catch (error) {
    // systemd may retain a ControlGroup name after the kernel removes the empty
    // cgroup. Its genuine absence in the verified parent is also empty.
    if (error.code !== "ENOENT" || fs.readdirSync(parent).includes("grabenplaner.service")) throw error;
    return;
  }
  let count = 0;
  function inspect(file) {
    if (++count > 256) throw new Error("PG_PASSKEYS_ACTIVATION_CGROUP");
    directory(file);
    if (fs.readFileSync(file + "/cgroup.procs", "utf8").trim()) throw new Error("PG_PASSKEYS_ACTIVATION_WRITERS");
    for (const entry of fs.readdirSync(file, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.includes("/") || [".", ".."].includes(entry.name)) throw new Error("PG_PASSKEYS_ACTIVATION_CGROUP");
      if (entry.isDirectory()) inspect(file + "/" + entry.name);
    }
  }
  inspect(group);
}

function assertStopped() {
  const result = spawnSync("/usr/bin/systemctl", ["show", "grabenplaner.service",
    "--property=ActiveState,SubState,MainPID,ControlPID,ControlGroup"], { encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
  if (result.status !== 0) throw new Error("PG_PASSKEYS_ACTIVATION_SERVICE");
  const entries = String(result.stdout).trim().split("\n").map(line => line.split("="));
  const state = Object.fromEntries(entries);
  if (entries.length !== 5 || Object.keys(state).length !== 5 || state.ActiveState !== "inactive" || state.SubState !== "dead"
    || state.MainPID !== "0" || state.ControlPID !== "0"
    || !["", "/system.slice/grabenplaner.service"].includes(state.ControlGroup)) throw new Error("PG_PASSKEYS_ACTIVATION_WRITERS");
  assertEmptyCgroup();
}

function installed(expectedManifest, { requireStopped = true } = {}) {
  assertLease(); if (requireStopped) assertStopped();
  const manifestBytes = readProtected(APP + "/grabenplaner-server-manifest.json");
  if (hash(manifestBytes) !== expectedManifest) throw new Error("PG_PASSKEYS_ACTIVATION_MANIFEST");
  const manifest = JSON.parse(manifestBytes), metadata = JSON.parse(readProtected(APP + "/package.json"));
  require("./deploy-policy").applicationContract(APP);
  const policy = require("./passkeys-release-policy").readPolicy(metadata);
  if (policy !== "compatible" || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit || "")) throw new Error("PG_PASSKEYS_ACTIVATION_POLICY");
  // The manifest must list the actual activation entrypoint and policy; the
  // general application contract verifies every listed critical source byte.
  for (const relative of ["server-tools/linux/lib/passkeys-schema-activate.js", "server-tools/linux/lib/passkeys-release-policy.js",
    "lib/passkey-schema-policy.js",
    "lib/persistence/postgresql/core/passkeys.js", "lib/persistence/postgresql/boundary/migrate.js",
    "lib/persistence/postgresql/operations/runtime.js", "lib/persistence/postgresql/operations/paired-bundle.js",
    "lib/persistence/postgresql/operations/paired-checkpoint.js"]) {
    const entry = manifest.files.find(item => item.path === relative);
    if (!entry || hash(readProtected(APP + "/" + relative)) !== entry.sha256) throw new Error("PG_PASSKEYS_ACTIVATION_SOURCE");
  }
  const configurationSha256 = hash(JSON.stringify(CONFIGURATION_FILES.map(file => [file, hash(readProtected(file, 65536))])));
  return { format: FORMAT, schemaVersion: 1, appVersion: manifest.appVersion, sourceCommit: manifest.sourceCommit,
    manifestSha256: expectedManifest, passkeysSchemaPolicy: policy, configurationSha256 };
}

async function current(config, expectedManifest) {
  const state = installed(expectedManifest), pair = await R.inspectPair(config);
  const identity = require("./deploy-policy").postgresqlPairIdentity(pair);
  const client = new (require("pg").Client)(R.url(config, config.domains[0]));
  let passkeysState;
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY;SET LOCAL search_path=pg_catalog,gp;SET LOCAL statement_timeout='30s'");
    await require("../../../lib/persistence/postgresql/boundary/migrate").verifyCoreSchema(client,
      { requireVocationalSchool: true, requireSessionSecurity: true });
    passkeysState = await require("../../../lib/persistence/postgresql/core/passkeys").readLedger(client) ? "present" : "absent";
    await client.query("COMMIT");
  } finally { await client.end(); }
  return { ...state, beforePairIdentitySha256: identity.databaseIdentitySha256, coreSchemaSha256: pair.core.schemaSha256,
    salesSchemaSha256: pair.sales.schemaSha256, passkeysState, pair };
}

async function backupProof(config, expected, pair, budget) {
  // Select the exact latest complete pair without duplicating its full content
  // scan. The complete hash scan below happens exactly once before the DDL.
  const recent = await R.latestBackup(config, { short: true, maximumAgeHours: 1 });
  if (recent.manifestSha256 !== expected) throw new Error("PG_PASSKEYS_ACTIVATION_BACKUP_BINDING");
  const markers = fs.readdirSync(config.backupDirectory).filter(name => /^[a-f0-9-]{36}\.pair\.complete\.json$/.test(name))
    .map(name => path.join(config.backupDirectory, name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!markers.length) throw new Error("PG_PASSKEYS_ACTIVATION_BACKUP_BINDING");
  const marker = markers[0], directory = marker.replace(/\.complete\.json$/, "");
  const proof = await require("../../../lib/persistence/postgresql/operations/paired-bundle").verifyPairBundle(directory, marker,
    { expectedSha256: expected, verifyContent: true, checkBudget: budget.remaining });
  if (!proof.verified || proof.verificationScope !== "complete-file-content" || proof.manifest.createdAt !== recent.createdAt
    || proof.manifest.checkpoint?.quiescence !== "application-and-files-drained;both-databases-share-locked") {
    throw new Error("PG_PASSKEYS_ACTIVATION_BACKUP_BINDING");
  }
  for (const domain of config.domains) {
    const point = proof.manifest.checkpoint.domains?.[domain.domain], live = pair[domain.domain];
    if (!point || ["clusterId", "database", "environmentId", "schemaSha256"].some(key => point[key] !== live[key])
      || point.restore?.schemaSha256 !== live.schemaSha256) throw new Error("PG_PASSKEYS_ACTIVATION_BACKUP_PAIR");
  }
  for (const [name, source] of [["configuration.env", config.environmentFile],
    ["postgresql-application.json", CONFIGURATION_FILES[2]], ["postgresql-pair.json", CONFIGURATION_FILES[3]]]) {
    const entry = proof.manifest.files.find(item => item.file === name);
    if (!entry || entry.sha256 !== hash(readProtected(source, 65536))) throw new Error("PG_PASSKEYS_ACTIVATION_BACKUP_CONFIGURATION");
  }
  const copied = JSON.parse(fs.readFileSync(path.join(directory, "postgresql-operations.json"), "utf8"));
  if (JSON.stringify(copied) !== JSON.stringify(config)) throw new Error("PG_PASSKEYS_ACTIVATION_BACKUP_CONFIGURATION");
  return { proof, receipt: { verified: true, verificationScope: proof.verificationScope, manifestSha256: expected,
    createdAt: recent.createdAt, files: proof.files } };
}

async function main(args = process.argv.slice(2)) {
  const [action, expectedManifest, ...values] = args;
  if (process.platform !== "linux" || process.getuid?.() !== 0
    || fs.realpathSync(path.resolve(__dirname, "../../..")) !== APP || !HASH.test(expectedManifest || "")
    || !(["guard", "inspect", "binding"].includes(action) && values.length === 1 || action === "activate" && values.length === 4)
    || values.at(-1) !== "--maintenance-lock-held") throw new Error("PG_PASSKEYS_ACTIVATION_INSTALLED_SCOPE");
  // Validate all private/source boundaries before loading secrets or connecting.
  const initial = installed(expectedManifest, { requireStopped: action !== "guard" }), config = R.loadConfiguration(CONFIG);
  if (action === "guard") {
    if (JSON.stringify(initial) !== JSON.stringify(installed(expectedManifest, { requireStopped: false }))) {
      throw new Error("PG_PASSKEYS_ACTIVATION_CONFIGURATION_CHANGED");
    }
    return initial;
  }
  const before = await current(config, expectedManifest);
  if (JSON.stringify(initial) !== JSON.stringify(installed(expectedManifest))) throw new Error("PG_PASSKEYS_ACTIVATION_CONFIGURATION_CHANGED");
  if (action === "inspect") {
    const { pair, ...binding } = before;
    return binding;
  }
  if (action === "binding") {
    const backup = await R.latestBackup(config, { short: true, maximumAgeHours: 1 });
    const { pair, ...binding } = before;
    return { ...binding, backupManifestSha256: backup.manifestSha256 };
  }
  const [expectedConfiguration, expectedBackup, expectedPair] = values;
  if (![expectedConfiguration, expectedBackup, expectedPair].every(value => HASH.test(value || ""))
    || before.configurationSha256 !== expectedConfiguration || before.beforePairIdentitySha256 !== expectedPair) {
    throw new Error("PG_PASSKEYS_ACTIVATION_BINDING");
  }
  const budget = createBackupBudget(), backup = await backupProof(config, expectedBackup, before.pair, budget), clients = [];
  let migration, failure;
  try {
    for (const domain of config.domains) {
      const client = new (require("pg").Client)(R.url(config, domain)); clients.push(client);
      await client.connect();
      await client.query("SET search_path=pg_catalog,gp;SET lock_timeout='5s';SET statement_timeout='30s'");
      await require("../../../lib/persistence/postgresql/core/environment").verifyEnvironment(client,
        { domain: domain.domain, purpose: "migrator", binding: config.binding });
      await client.query("SELECT pg_advisory_lock(9261207)");
      // An unelevated migrator may see NULL for another role's restricted
      // activity fields. Unknown backends must not pass the writer-drain check.
      const others = (await client.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND (backend_type='client backend' OR backend_type IS NULL)")).rows;
      if (others.length !== 1 || others[0].n !== 0) throw new Error("PG_PASSKEYS_ACTIVATION_ACTIVE_CLIENTS");
      await client.query("BEGIN READ ONLY");
      try {
        await require("../../../lib/persistence/postgresql/operations/paired-checkpoint").verifyCheckpoint(boundedSnapshotClient(client, budget), domain.domain,
          backup.proof.manifest.checkpoint.domains[domain.domain].restore);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    }
    budget.remaining();
    if (JSON.stringify(initial) !== JSON.stringify(installed(expectedManifest))) throw new Error("PG_PASSKEYS_ACTIVATION_CONFIGURATION_CHANGED");
    migration = await require("../../../lib/persistence/postgresql/core/passkeys").migrate(clients[0], { binding: config.binding });
    await require("../../../lib/persistence/postgresql/boundary/migrate").verifyCoreSchema(clients[0],
      { requireVocationalSchool: true, requireSessionSecurity: true, requirePasskeys: true });
  } catch (error) { failure = error; throw error; }
  finally {
    const closed = await Promise.allSettled([...clients].reverse().map(async client => {
      try { await client.query("SELECT pg_advisory_unlock(9261207)"); } finally { await client.end(); }
    }));
    if (!failure && closed.some(result => result.status === "rejected")) throw new Error("PG_PASSKEYS_ACTIVATION_CONNECTION_CLEANUP");
  }
  const after = await current(config, expectedManifest);
  if (JSON.stringify(initial) !== JSON.stringify(installed(expectedManifest))
    || after.passkeysState !== "present" || typeof migration.applied !== "boolean"
    || migration.digest !== require("../../../lib/persistence/postgresql/core/passkeys").digest
    || migration.applied && migration.target !== after.coreSchemaSha256
    || JSON.stringify(before.pair.sales) !== JSON.stringify(after.pair.sales)
    || ["clusterId", "database", "environmentId"].some(key => before.pair.core[key] !== after.pair.core[key])) {
    throw new Error("PG_PASSKEYS_ACTIVATION_DOMAIN_DRIFT");
  }
  return { ...initial, beforePairIdentitySha256: expectedPair, afterPairIdentitySha256: after.beforePairIdentitySha256,
    backupManifestSha256: expectedBackup,
    verified: true, schemaCommitted: migration.applied === true, passkeysVerified: true, passkeysState: "present", migration,
    backup: backup.receipt, coreBefore: before.coreSchemaSha256, coreAfter: after.coreSchemaSha256,
    salesSchemaSha256: after.salesSchemaSha256,
    salesUnchanged: true, sameInstalledApplication: true, restartRequired: true };
}

if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + "\n"))
  .catch(error => { process.stderr.write(JSON.stringify({ failed: true,
    code: /^PG_/.test(error.message) ? error.message : "PG_PASSKEYS_ACTIVATION_FAILED",
    schemaMayBeActive: true, restartRequiresSameCompatibleApplication: true }) + "\n"); process.exitCode = 1; });
module.exports = { main, readProtected, assertStopped, FORMAT, CONFIGURATION_FILES };
