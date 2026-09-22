"use strict";

// Technical measurements only. This separate, bounded series preserves the
// existing metric hash chain and never invents a split for old aggregate sizes.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const DAYS = 180;
const SLOT = 6 * 3600000;
const LIMIT = DAYS * 4 + 4;
const digest = points => crypto.createHash("sha256").update(JSON.stringify(points)).digest("hex");
function validPoint(p) {
  return p && Object.keys(p).sort().join() === "at,coreBytes,salesBytes"
    && typeof p.at === "string" && Number.isFinite(Date.parse(p.at))
    && new Date(p.at).toISOString() === p.at
    && [p.coreBytes, p.salesBytes].every(n => Number.isSafeInteger(n) && n > 0);
}
function createDatabaseSizeHistory(file) {
  function read() {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new Error("shape");
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value.version !== 1 || !Array.isArray(value.points) || value.points.length > LIMIT
        || !value.points.every(validPoint) || digest(value.points) !== value.checksum
        || value.points.some((p, i) => i > 0 && p.at <= value.points[i - 1].at)) throw new Error("integrity");
      return { available: true, integrityVerified: true, points: value.points };
    } catch (error) {
      return { available: error.code === "ENOENT", integrityVerified: error.code === "ENOENT", points: [] };
    }
  }
  function record(databases, now = Date.now()) {
    const current = read();
    const point = { at: new Date(Number(now)).toISOString(),
      coreBytes: databases?.core?.bytes, salesBytes: databases?.sales?.bytes };
    if (!current.integrityVerified || !validPoint(point) || Math.floor(Date.parse(current.points.at(-1)?.at) / SLOT) >= Math.floor(Number(now) / SLOT)) return false;
    const cutoff = Number(now) - DAYS * 86400000;
    const points = [...current.points.filter(p => Date.parse(p.at) >= cutoff), point].slice(-LIMIT);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, points, checksum: digest(points) }) + "\n", { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== "ENOENT") throw e; } }
    return true;
  }
  return { read, record };
}
module.exports = { createDatabaseSizeHistory };
