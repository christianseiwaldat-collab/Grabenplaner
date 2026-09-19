"use strict";

// A one-release bridge for the scanner-probe backup repair. Both application
// trees have already passed the updater's manifest and ownership checks.
// Configuration parsing, database snapshots, checkpointing, bundle format,
// retention and native backup tools remain byte-identical outside the reviewed
// repairs. The isolated restore watchdog change is pinned separately below.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const approvedRepairs = Object.freeze({
  "lib/persistence/postgresql/operations/runtime.js": {
    before: "b2d21c93aecaa24cd9dc73f9aea25c4e03c4e3bd743d159cb89ed1da3f83c45c",
    after: "17fbe3a06ee85c9dee36dbdd15f2d6312df29eea0b5855c171cf1ec0f1bc4b46",
  },
  "server-tools/linux/lib/postgresql-operations.js": {
    before: "0d0801f74d26094cf6093f8ca1e11909a01d60253d36cc0cd48ec6ed46069145",
    after: "a0699ec58917ae64fe3e5d36894ccf8eed7bc88d7fd438be4d3e16972d552006",
  },
  "lib/persistence/postgresql/operations/paired-restore.js": {
    before: "00963fbaac4fdce62ca48552cb505237ec260b2b06100fcdcfb86944343633c7",
    after: "5a3b2b89baccbd24e89493dbe9a1d334c00280ae154eaf4a4b3acc88d27d0fa2",
  },
});
const identicalFiles = Object.freeze([
  "pnpm-lock.yaml", "pnpm-workspace.yaml",
  "server-tools/linux/backup-grabenplaner.sh",
  "server-tools/linux/lib/common.sh",
  "server-tools/linux/lib/postgresql-maintenance.sh",
  "server-tools/linux/lib/deploy-policy.js",
]);
function regular(root, relative) {
  const file = path.join(root, relative);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(file) !== file) {
    throw new Error("PG_BACKUP_REPAIR_FILE");
  }
  return fs.readFileSync(file);
}
function libraryFiles(root, relative = "lib") {
  const result = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const next = `${relative}/${name}`, stat = fs.lstatSync(path.join(root, next));
    if (stat.isSymbolicLink()) throw new Error("PG_BACKUP_REPAIR_FILE");
    if (stat.isDirectory()) result.push(...libraryFiles(root, next));
    else {
      if (!stat.isFile()) throw new Error("PG_BACKUP_REPAIR_FILE");
      result.push(next);
    }
  }
  return result;
}
function sourceHash(bytes) {
  return crypto.createHash("sha256").update(bytes.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");
}
function verifyBackupRepairCompatibility(installedRoot, candidateRoot) {
  for (const root of [installedRoot, candidateRoot]) {
    if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) {
      throw new Error("PG_BACKUP_REPAIR_ROOT");
    }
  }
  for (const [relative, hashes] of Object.entries(approvedRepairs)) {
    if (![hashes.before, hashes.after].includes(sourceHash(regular(installedRoot, relative)))
      || sourceHash(regular(candidateRoot, relative)) !== hashes.after) throw new Error("PG_BACKUP_REPAIR_UNREVIEWED");
  }
  const oldPackage = JSON.parse(regular(installedRoot, "package.json"));
  const newPackage = JSON.parse(regular(candidateRoot, "package.json"));
  if (oldPackage.version !== "0.92.58-beta") throw new Error("PG_BACKUP_REPAIR_PREDECESSOR");
  for (const field of ["dependencies", "engines", "packageManager"]) {
    if (JSON.stringify(oldPackage[field]) !== JSON.stringify(newPackage[field])) throw new Error("PG_BACKUP_REPAIR_DEPENDENCIES");
  }
  // The report-duration repository is independent of the backup engine. All
  // other shared modules must match, including every paired backup/restore file.
  const comparedLibraries = root => libraryFiles(root).filter(relative =>
    !Object.hasOwn(approvedRepairs, relative) && relative !== "lib/persistence/repositories/sales-report-jobs.js");
  const oldLibraries = comparedLibraries(installedRoot), newLibraries = comparedLibraries(candidateRoot);
  if (JSON.stringify(oldLibraries) !== JSON.stringify(newLibraries)) throw new Error("PG_BACKUP_REPAIR_LIBRARY_SET");
  for (const relative of [...identicalFiles, ...oldLibraries]) {
    if (!regular(installedRoot, relative).equals(regular(candidateRoot, relative))) throw new Error("PG_BACKUP_REPAIR_CONTRACT_CHANGED");
  }
  return { verified: true, configurationUnchanged: true, pairedFormatUnchanged: true, excludedVolatilePath: "private/amu/tmp" };
}
if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error("PG_BACKUP_REPAIR_ARGUMENTS");
    process.stdout.write(JSON.stringify(verifyBackupRepairCompatibility(...process.argv.slice(2))) + "\n");
  } catch (error) {
    process.stderr.write((/^PG_BACKUP_REPAIR_/.test(error.message) ? error.message : "PG_BACKUP_REPAIR_FAILED") + "\n");
    process.exitCode = 1;
  }
}
module.exports = { verifyBackupRepairCompatibility };
