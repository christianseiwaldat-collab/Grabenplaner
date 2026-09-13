"use strict";

const fs = require("node:fs");
const { validateRequest, FORMAT } = require("../../../lib/persistence/postgresql/lifecycle-control");
const { verifyPairBundle } = require("../../../lib/persistence/postgresql/operations/paired-bundle");
const R = require("../../../lib/persistence/postgresql/operations/runtime");
const STATUS = "/var/lib/grabenplaner-postgresql/status.json";

async function verifyResult(file, requestId, { completeContent = false } = {}) {
  if (process.getuid() !== 0 || file !== `/var/lib/grabenplaner-postgresql/operations/${requestId}.lifecycle-backup.json`) {
    throw new Error("PG_LIFECYCLE_RESULT_PATH");
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o077)
      || stat.size > 65536 || fs.realpathSync(file) !== file) throw new Error("PG_LIFECYCLE_RESULT_PERMISSIONS");
  const config = R.loadConfiguration("/etc/grabenplaner/postgresql-operations.json");
  const result = JSON.parse(fs.readFileSync(file, "utf8"));
  if (result.ok !== true || !/^\/var\/backups\/grabenplaner-postgresql\/[a-f0-9-]{36}\.pair$/.test(result.path || "")
      || result.commitMarker !== result.path + ".complete.json") throw new Error("PG_LIFECYCLE_BACKUP_REQUIRED");
  const proof = await verifyPairBundle(result.path, result.commitMarker, { verifyContent: completeContent });
  const age = Date.now() - Date.parse(proof.manifest.createdAt);
  const owned = require('../../../lib/persistence/postgresql/operations/status').readStatus(config.binding);
  if (owned.requestId !== requestId || !Number.isFinite(Date.parse(owned.acceptedAt))
      || Date.parse(proof.manifest.createdAt) < Date.parse(owned.acceptedAt) - 5000
      || age < -5000 || age > 1500000 || !Number.isFinite(age)
      || proof.manifest.databases.some((domain, index) => domain.database !== config.domains[index].database)
      || proof.manifest.checkpoint?.domains?.core?.clusterId !== config.clusterId
      || proof.manifest.checkpoint?.domains?.sales?.clusterId !== config.clusterId) throw new Error("PG_LIFECYCLE_BACKUP_BINDING");
  return { verified: true, createdAt: proof.manifest.createdAt, manifestSha256: proof.manifestSha256,
    bytes: proof.bytes, files: proof.files, provider: "postgresql", databaseCount: 2 };
}

async function publish(requestId, action, state, resultFile) {
  validateRequest({ format: FORMAT, action, requestId });
  if (!['preparing', 'completed', 'failed'].includes(state)) throw new Error("PG_LIFECYCLE_STATE");
  const config = R.loadConfiguration("/etc/grabenplaner/postgresql-operations.json");
  const backup = state === 'completed' ? await verifyResult(resultFile, requestId) : undefined;
  return require("../../../lib/persistence/postgresql/operations/status").writeStatus(config, {
    state, action, requestId, code: state === 'failed' ? 'PG_LIFECYCLE_FAILED' : null,
    ...(state === 'preparing' ? { acceptedAt: new Date().toISOString() } : {}),
    ...(backup ? { backup } : {}),
  });
}

if (require.main === module) {
  const [first, action, third, file] = process.argv.slice(2);
  if (first === 'recovery-required' && process.argv.length === 3 && process.platform === 'linux' && process.getuid() === 0) {
    try {
      const config = R.loadConfiguration('/etc/grabenplaner/postgresql-operations.json');
      const state = require('../../../lib/persistence/postgresql/operations/status').readStatus(config.binding);
      const age = Date.now() - Date.parse(state.acceptedAt);
      if (!state.available || !['preparing', 'failed'].includes(state.state) || !Number.isFinite(age) || age < 0 || age > 1800000) throw new Error();
    } catch { process.exitCode = 1; }
  } else if (process.platform !== "linux" || process.getuid() !== 0 || process.argv.length !== 6) process.exitCode = 1;
  else (first === 'verify' ? verifyResult(file, third) : publish(first, action, third, file))
    .then(() => {}).catch(() => { process.stderr.write("PG_LIFECYCLE_STATUS_FAILED\n"); process.exitCode = 1; });
}

module.exports = { STATUS, verifyResult, publish };
