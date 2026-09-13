"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const FILE = "/var/lib/grabenplaner-postgresql/status.json";
const FORMAT = "grabenplaner-postgresql-status-v1";

function readStatus(binding) {
  try {
    const stat = fs.lstatSync(FILE);
    if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o022)
        || stat.size > 16384 || fs.realpathSync(FILE) !== FILE) throw new Error();
    const value = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (value.format !== FORMAT || value.clusterId !== binding?.clusterId
        || value.environmentId !== binding?.environmentId || !Number.isFinite(Date.parse(value.generatedAt))) throw new Error();
    const backup = value.backup;
    const verified = backup?.verified === true && backup.provider === "postgresql" && backup.databaseCount === 2
      && Number.isFinite(Date.parse(backup.createdAt)) && /^[a-f0-9]{64}$/.test(backup.manifestSha256 || "");
    return { available: true, state: value.state, action: value.action || null,
      generatedAt: value.generatedAt, requestId: value.requestId || null, acceptedAt: value.acceptedAt || null, code: value.code || null,
      backup: verified ? { name: "PostgreSQL-Datenbankpaar", provider: "postgresql", databaseCount: 2,
        verified: true, committed: true, modifiedAt: backup.createdAt, modifiedMs: Date.parse(backup.createdAt),
        size: backup.bytes, bytes: backup.bytes } : null };
  } catch { return { available: false, state: "unknown", code: "PG_OPERATIONS_STATUS_UNAVAILABLE", backup: null }; }
}

function writeStatus(config, change) {
  if (process.platform !== "linux" || process.getuid() !== 0 || config.mode !== "productive") {
    throw new Error("PG_OPERATIONS_STATUS_ROOT_REQUIRED");
  }
  const root = "/var/lib/grabenplaner-postgresql", stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) || fs.realpathSync(root) !== root) {
    throw new Error("PG_OPERATIONS_STATUS_ROOT");
  }
  let previous = {};
  if (fs.existsSync(FILE)) {
    const info = fs.lstatSync(FILE);
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o022) || info.size > 16384) {
      throw new Error("PG_OPERATIONS_STATUS_PERMISSIONS");
    }
    previous = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (previous.clusterId !== config.clusterId || previous.environmentId !== config.domains[0].environmentId) previous = {};
  }
  const value = { ...previous, ...change, format: FORMAT, generatedAt: new Date().toISOString(),
    clusterId: config.clusterId, environmentId: config.domains[0].environmentId };
  const temporary = `${FILE}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o644 });
  fs.chmodSync(temporary, 0o644);
  const fd = fs.openSync(temporary, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, FILE);
  const directory = fs.openSync(root, "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return value;
}

module.exports = { FILE, FORMAT, readStatus, writeStatus };
