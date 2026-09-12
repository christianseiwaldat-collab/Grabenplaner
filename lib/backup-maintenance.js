"use strict";

// A live OS lease, not an environment switch or a timestamp, delegates only
// lifecycle backups to the Linux updater. A crashed owner releases its flock.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const LEASE_PATH = "/run/grabenplaner/update-backup-owner.json";
const MAINTENANCE_PATH = "/run/grabenplaner/maintenance.lock";
const FORMAT = "grabenplaner-update-backup-owner-v1";

function secureFile(stat, mode) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    && stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o777) === mode;
}
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function secureParents(file, io = fs) {
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    const stat = io.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) return false;
    if (directory === path.dirname(directory)) return true;
  }
}

function ownsLifecycleBackup(databasePath, {
  platform = process.platform, leasePath = LEASE_PATH, io = fs, run = spawnSync,
} = {}) {
  if (platform !== "linux" || typeof databasePath !== "string" || !path.isAbsolute(databasePath)) return false;
  let fd;
  try {
    if (!secureParents(leasePath, io)) return false;
    fd = io.openSync(leasePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = io.fstatSync(fd), named = io.lstatSync(leasePath);
    if (!secureFile(opened, 0o644) || !secureFile(named, 0o644) || !sameFile(opened, named)
      || opened.size < 1 || opened.size > 2048) return false;
    const receipt = JSON.parse(io.readFileSync(fd, "utf8"));
    if (receipt.format !== FORMAT || receipt.databasePath !== databasePath || !Number.isFinite(Date.parse(receipt.createdAt))) return false;
    // A successful shared lock means there is NO writer responsible for a
    // backup. Only flock's specific conflict status proves a live owner.
    const probe = run("/usr/bin/flock", ["--shared", "--nonblock", "--conflict-exit-code", "73", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd], timeout: 2000, windowsHide: true,
    });
    const after = io.lstatSync(leasePath);
    return !probe.error && !probe.signal && probe.status === 73
      && secureFile(after, 0o644) && sameFile(opened, after)
      && after.size === opened.size && after.mtimeMs === opened.mtimeMs;
  } catch { return false; }
  finally { if (fd !== undefined) io.closeSync(fd); }
}

function prepareOwnerFile({ leasePath = LEASE_PATH, maintenancePath = MAINTENANCE_PATH, maintenanceFd = 9, io = fs, run = spawnSync, platform = process.platform, uid = process.getuid?.() } = {}) {
  if (platform !== "linux" || uid !== 0 || !secureParents(leasePath, io) || !secureParents(maintenancePath, io)) throw new Error("BACKUP_OWNER_ROOT_REQUIRED");
  if (![6, 9].includes(maintenanceFd)) throw new Error("BACKUP_OWNER_MAINTENANCE_REQUIRED");
  const held = io.fstatSync(maintenanceFd), named = io.lstatSync(maintenancePath);
  if (!secureFile(held, 0o600) || !secureFile(named, 0o600) || !sameFile(held, named)) throw new Error("BACKUP_OWNER_MAINTENANCE_REQUIRED");
  // Same open description as the invoking updater. Never break another lock.
  const checked = run("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
    stdio: ["ignore", "ignore", "ignore", maintenanceFd], timeout: 2000, windowsHide: true,
  });
  if (checked.error || checked.signal || checked.status !== 0) throw new Error("BACKUP_OWNER_MAINTENANCE_REQUIRED");
  let fd;
  try {
    try { fd = io.openSync(leasePath, "wx", 0o644); io.fchmodSync(fd, 0o644); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      fd = io.openSync(leasePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    }
    if (!secureFile(io.fstatSync(fd), 0o644) || !sameFile(io.fstatSync(fd), io.lstatSync(leasePath))) throw new Error("BACKUP_OWNER_FILE_INVALID");
  } finally { if (fd !== undefined) io.closeSync(fd); }
  return leasePath;
}

function publishOwner(databasePath, options = {}) {
  const { leasePath = LEASE_PATH, ownerFd = 8, io = fs, run = spawnSync } = options;
  prepareOwnerFile(options);
  if (![4, 8].includes(ownerFd)) throw new Error("BACKUP_OWNER_FILE_INVALID");
  if (typeof databasePath !== "string" || !path.isAbsolute(databasePath) || /[\x00-\x1f\x7f]/.test(databasePath)
    || !io.lstatSync(databasePath).isFile() || io.lstatSync(databasePath).isSymbolicLink()) throw new Error("BACKUP_OWNER_DATABASE_INVALID");
  const opened = io.fstatSync(ownerFd), named = io.lstatSync(leasePath);
  if (!secureFile(opened, 0o644) || !secureFile(named, 0o644) || !sameFile(opened, named)) throw new Error("BACKUP_OWNER_FILE_INVALID");
  const locked = run("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
    stdio: ["ignore", "ignore", "ignore", ownerFd], timeout: 2000, windowsHide: true,
  });
  if (locked.error || locked.signal || locked.status !== 0) throw new Error("BACKUP_OWNER_LOCK_REQUIRED");
  const data = Buffer.from(JSON.stringify({ format: FORMAT, databasePath, createdAt: new Date().toISOString() }) + "\n");
  io.ftruncateSync(ownerFd, 0);
  io.writeSync(ownerFd, data, 0, data.length, 0);
  io.fsyncSync(ownerFd);
}

if (require.main === module) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === "prepare" && args.length <= 1) process.stdout.write(prepareOwnerFile({ maintenanceFd: args.length ? Number(args[0]) : 9 }) + "\n");
    else if (action === "publish" && (args.length === 1 || args.length === 3)) {
      publishOwner(args[0], { maintenanceFd: args.length === 3 ? Number(args[1]) : 9, ownerFd: args.length === 3 ? Number(args[2]) : 8 });
    }
    else throw new Error("BACKUP_OWNER_ARGUMENTS_INVALID");
  } catch { process.stderr.write("Die Sicherungsverantwortung konnte nicht sicher uebernommen werden.\n"); process.exitCode = 1; }
}

module.exports = { ownsLifecycleBackup, prepareOwnerFile, publishOwner, LEASE_PATH, FORMAT };
