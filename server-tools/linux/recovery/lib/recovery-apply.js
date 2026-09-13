"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { __internalTestOnly, assertFrozenTree, safetyReceipt: writeSafetyReceipt, validateReceipt } = require("./recovery-metadata.js");

const HASH = /^[a-f0-9]{64}$/;
const RECOVERY_ID = /^[a-f0-9]{64}$/;

function fail(message) { throw new Error(message); }
function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}
function pathExists(target) {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function regular(file, { maximumBytes = 1024 * 1024 } = {}) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximumBytes) {
    fail("Eine Recovery-Datei ist unzulaessig.");
  }
  return stat;
}

function readJson(file, options) {
  regular(file, options);
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
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
  fsyncDirectory(directory);
}

function assertChild(target, root, label) {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  if (resolvedRoot === path.parse(resolvedRoot).root || !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail(`${label} liegt ausserhalb des freigegebenen Datenbaums.`);
  }
  let current = resolvedRoot;
  for (const segment of path.relative(resolvedRoot, resolvedTarget).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (pathExists(current) && fs.lstatSync(current).isSymbolicLink()) fail(`${label} enthaelt einen symbolischen Pfadbestandteil.`);
  }
  return resolvedTarget;
}

function assertSafeExisting(target, type) {
  if (!pathExists(target)) return false;
  const stat = fs.lstatSync(target);
  const correct = type === "directory" ? stat.isDirectory() : stat.isFile();
  if (!correct || stat.isSymbolicLink() || (type === "file" && stat.nlink !== 1)) fail("Ein vorhandenes Live-Ziel ist unzulaessig.");
  return true;
}

function assertStrictTree(source) {
  const root = path.resolve(source);
  const walk = (directory) => {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail("Ein Recovery-Quellbaum ist unzulaessig.");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(target);
      else if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("Ein Recovery-Quellbaum enthaelt Links oder besondere Dateien.");
    }
  };
  walk(root);
}

function copyDirectory(source, target) {
  assertStrictTree(source);
  if (pathExists(target)) fail("Ein Recovery-Vorbereitungsziel existiert bereits.");
  fs.mkdirSync(target, { recursive: false, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  }
}

function freezeTree(root) {
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        walk(target);
        fs.chmodSync(target, 0o500);
      } else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) fs.chmodSync(target, 0o400);
      else fail("Der Vorab-Sicherheitsbaum enthaelt Links oder besondere Dateien.");
    }
  };
  walk(root);
  fs.chmodSync(root, 0o500);
}

function fsyncTree(root) {
  if (process.platform === "win32") return;
  const directories = [];
  const walk = (directory) => {
    directories.push(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else fsyncFile(target);
    }
  };
  walk(root);
  for (const directory of directories.reverse()) fsyncDirectory(directory);
}

function fsyncFile(file) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function createSafetySnapshot({ safetyRoot, safetyReceipt, recoveryId, snapshotId, targets }, internalPolicy) {
  const root = path.resolve(safetyRoot);
  const receipt = assertChild(safetyReceipt, root, "Vorab-Sicherheitsbeleg");
  const rootStat = fs.lstatSync(root);
  if (root === path.parse(root).root || !rootStat.isDirectory() || rootStat.isSymbolicLink()
    || (process.platform === "linux" && (
      (internalPolicy !== __internalTestOnly.nonRootOwnershipPolicy && rootStat.uid !== 0)
      || (rootStat.mode & 0o077) !== 0
    ))
    || fs.readdirSync(root).length !== 0 || path.dirname(receipt) !== root) {
    fail("Der permanente Vorab-Sicherheitsbereich ist unzulaessig oder nicht leer.");
  }
  const live = path.join(root, "live");
  const data = path.join(live, "data");
  const privateRoot = path.join(live, "private");
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  const byName = new Map(targets.map((item) => [item.name, item]));
  for (const item of targets) {
    assertSafeExisting(item.target, ["documents", "directory"].includes(item.type) ? "directory" : "file");
  }
  const database = byName.get("database");
  const documents = byName.get("documents");
  if (!database || !documents || !pathExists(database.target) || !pathExists(documents.target)) {
    fail("Der aktuelle Live-Datenbestand ist fuer den Sicherheitsbeleg unvollstaendig.");
  }
  fs.copyFileSync(database.target, path.join(data, path.basename(database.target)), fs.constants.COPYFILE_EXCL);
  copyDirectory(documents.target, path.join(privateRoot, "amu"));
  for (const name of ["wal", "shm"]) {
    const item = byName.get(name);
    if (item && pathExists(item.target)) fs.copyFileSync(item.target, path.join(data, path.basename(item.target)), fs.constants.COPYFILE_EXCL);
  }
  const runtime = byName.get("runtimeConfig");
  if (runtime && pathExists(runtime.target)) fs.copyFileSync(runtime.target, path.join(live, "runtime-config.json"), fs.constants.COPYFILE_EXCL);
  const branding = byName.get("branding");
  if (branding && pathExists(branding.target)) copyDirectory(branding.target, path.join(live, "branding-kits"));
  freezeTree(live);
  fsyncTree(live);
  const result = writeSafetyReceipt(receipt, live, recoveryId, snapshotId, internalPolicy);
  fsyncDirectory(root);
  fsyncDirectory(path.dirname(root));
  fsyncDirectory(path.dirname(path.dirname(root)));
  return { receipt, live, result };
}

function sqliteIntegrity(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const result = database.prepare("PRAGMA integrity_check").all().map((row) => String(Object.values(row)[0]));
    if (result.length !== 1 || result[0] !== "ok") fail("SQLite integrity_check ist nach der Vorbereitung fehlgeschlagen.");
  } finally { database.close(); }
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function sourcePaths(stage) {
  const manifest = readJson(path.join(stage, "offsite-stage-manifest.json"), { maximumBytes: 1024 * 1024 });
  const source = manifest?.sourceBackup || {};
  const safeName = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/.test(String(value || ""));
  if (manifest.format !== "grabenplaner-offsite-stage" || manifest.schemaVersion !== 1
    || !safeName(source.database) || !safeName(source.documents) || !safeName(source.commitMarker)) {
    fail("Das Recovery-Stagingmanifest ist ungueltig.");
  }
  const database = assertChild(path.join(stage, "backup", source.database), stage, "Recovery-Datenbank");
  const documents = assertChild(path.join(stage, "backup", source.documents), stage, "Recovery-Dokumente");
  const runtimeConfig = path.join(stage, "recovery", "runtime-config.json");
  const branding = path.join(stage, "recovery", "branding-kits");
  regular(database, { maximumBytes: Number.MAX_SAFE_INTEGER });
  const documentStat = fs.lstatSync(documents);
  if (!documentStat.isDirectory() || documentStat.isSymbolicLink()) fail("Der Recovery-Dokumentbaum fehlt.");
  if (pathExists(runtimeConfig)) regular(runtimeConfig, { maximumBytes: 16 * 1024 * 1024 });
  if (pathExists(branding)) {
    const stat = fs.lstatSync(branding);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Der Recovery-Brandingbaum ist unzulaessig.");
    assertStrictTree(branding);
  }
  return { database, documents, runtimeConfig: pathExists(runtimeConfig) ? runtimeConfig : null, branding: pathExists(branding) ? branding : null };
}

function assertSqliteRecoveryTarget(dataRoot, prepared, verified) {
  if (prepared?.providerId === 'postgresql-pair' || verified?.providerId === 'postgresql-pair'
      || pathExists(path.join(dataRoot, 'data', 'postgresql-pair.json'))) {
    fail('PostgreSQL benoetigt die gekoppelte Wiederherstellung beider Datenbanken. SQLite-Apply darf den PostgreSQL-Bestand und seine Dateien nicht ersetzen.');
  }
}

function verifySafetyReceipt(file, safetyRoot, recoveryId, snapshotId, internalPolicy) {
  const receipt = readJson(file, { maximumBytes: 8 * 1024 * 1024 });
  if (receipt?.format !== "grabenplaner-pre-restore-safety" || receipt?.schemaVersion !== 1
    || receipt.recoveryId !== recoveryId || receipt.snapshotId !== snapshotId
    || !HASH.test(String(receipt.treeSha256 || "")) || !Array.isArray(receipt.files) || !receipt.files.length) {
    fail("Der unveraenderliche Vorab-Sicherheitsbeleg fehlt oder passt nicht.");
  }
  const files = assertFrozenTree(path.resolve(safetyRoot), internalPolicy);
  const treeSha256 = crypto.createHash("sha256")
    .update(files.map((item) => `${item.path}\0${item.bytes}\0${item.sha256}\n`).join(""), "utf8").digest("hex");
  if (JSON.stringify(files) !== JSON.stringify(receipt.files) || treeSha256 !== receipt.treeSha256) {
    fail("Der unveraenderliche Vorab-Sicherheitsbaum stimmt nicht mit seinem Hashbeleg ueberein.");
  }
  return receipt;
}

function parseArguments(argv) {
  const allowed = new Set(["stage", "prepared-receipt", "verified-receipt", "safety-receipt", "safety-root", "recovery-id", "snapshot", "data-root", "database", "amu-module", "database-lock-module", "output"]);
  const values = {};
  const args = [...argv];
  while (args.length) {
    const raw = String(args.shift() || "");
    const name = raw.startsWith("--") ? raw.slice(2) : "";
    if (!allowed.has(name) || !args.length || Object.hasOwn(values, name)) fail("Recovery-Anwendungsparameter sind unvollstaendig.");
    values[name] = String(args.shift());
  }
  for (const name of allowed) if (!values[name]) fail("Recovery-Anwendungsparameter sind unvollstaendig.");
  return values;
}

function applyRecovery(values, internalPolicy) {
  const recoveryId = String(values["recovery-id"] || "").toLowerCase();
  const snapshotId = String(values.snapshot || "").toLowerCase();
  if (!RECOVERY_ID.test(recoveryId) || !HASH.test(snapshotId)) fail("Die Recovery-Kennungen sind ungueltig.");
  const stage = path.resolve(values.stage);
  assertFrozenTree(stage, internalPolicy);
  const prepared = validateReceipt(readJson(path.resolve(values["prepared-receipt"]), { maximumBytes: 256 * 1024 }), "prepared", recoveryId, snapshotId);
  const verified = validateReceipt(readJson(path.resolve(values["verified-receipt"]), { maximumBytes: 256 * 1024 }), "verified", recoveryId, snapshotId);
  if (prepared.databaseSha256 !== verified.databaseSha256 || prepared.stageManifestSha256 !== verified.stageManifestSha256) {
    fail("Vorbereitung und Schlusspruefung stimmen nicht ueberein.");
  }
  const safetyRoot = path.resolve(values["safety-root"]);
  const safetyReceiptPath = path.resolve(values["safety-receipt"]);
  const dataRoot = path.resolve(values["data-root"]);
  assertSqliteRecoveryTarget(dataRoot, prepared, verified);
  const dataRootStat = fs.lstatSync(dataRoot);
  if (dataRoot === path.parse(dataRoot).root || !dataRootStat.isDirectory() || dataRootStat.isSymbolicLink()) fail("Der Live-Datenbaum ist unzulaessig.");
  const targetDatabase = assertChild(values.database, dataRoot, "Live-Datenbank");
  const targetDocuments = assertChild(path.join(dataRoot, "private", "amu"), dataRoot, "Live-Dokumente");
  const targetRuntime = assertChild(path.join(dataRoot, "runtime-config.json"), dataRoot, "Live-Konfiguration");
  const targetBranding = assertChild(path.join(dataRoot, "branding-kits"), dataRoot, "Live-Brandings");
  const source = sourcePaths(stage);
  if (sha256File(source.database) !== prepared.databaseSha256) fail("Die vorbereitete Recovery-Datenbank wurde veraendert.");
  const amuModule = path.resolve(values["amu-module"]);
  const databaseLockModule = path.resolve(values["database-lock-module"]);
  for (const helper of [amuModule, databaseLockModule]) regular(helper, { maximumBytes: 4 * 1024 * 1024 });
  const { readAndVerifyBackup, restoreEncryptedFilesBackup } = require(amuModule);
  readAndVerifyBackup(source.documents, { includeContent: false });
  const { acquireDatabaseLock, releaseDatabaseLock } = require(databaseLockModule);

  const targets = [
    { name: "database", target: targetDatabase, source: source.database, type: "file", required: true },
    { name: "documents", target: targetDocuments, source: source.documents, type: "documents", required: true },
    { name: "runtimeConfig", target: targetRuntime, source: source.runtimeConfig, type: "file", required: false },
    { name: "branding", target: targetBranding, source: source.branding, type: "directory", required: false },
    { name: "wal", target: `${targetDatabase}-wal`, source: null, type: "file", required: false },
    { name: "shm", target: `${targetDatabase}-shm`, source: null, type: "file", required: false },
  ].map((item) => ({
    ...item,
    prepared: `${item.target}.recovery-${recoveryId}`,
    previous: `${item.target}.pre-recovery-${recoveryId}`,
    failed: `${item.target}.failed-recovery-${recoveryId}`,
  }));
  for (const item of targets) {
    assertSafeExisting(item.target, ["documents", "directory"].includes(item.type) ? "directory" : "file");
    for (const reserved of [item.prepared, item.previous, item.failed]) if (pathExists(reserved)) fail("Diese Recovery-ID wurde fuer einen Live-Pfad bereits verwendet.");
  }

  fs.mkdirSync(path.dirname(targetDatabase), { recursive: true, mode: 0o750 });
  fs.mkdirSync(path.dirname(targetDocuments), { recursive: true, mode: 0o750 });
  const databaseItem = targets.find((item) => item.name === "database");
  fs.copyFileSync(source.database, databaseItem.prepared, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(databaseItem.prepared, 0o640);
  sqliteIntegrity(databaseItem.prepared);
  fsyncFile(databaseItem.prepared);
  const documentsItem = targets.find((item) => item.name === "documents");
  restoreEncryptedFilesBackup({ backupDirectory: source.documents, targetDirectory: documentsItem.prepared });
  assertStrictTree(documentsItem.prepared);
  fsyncTree(documentsItem.prepared);
  const runtimeItem = targets.find((item) => item.name === "runtimeConfig");
  if (source.runtimeConfig) {
    fs.copyFileSync(source.runtimeConfig, runtimeItem.prepared, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(runtimeItem.prepared, 0o640);
    fsyncFile(runtimeItem.prepared);
  }
  const brandingItem = targets.find((item) => item.name === "branding");
  if (source.branding) {
    copyDirectory(source.branding, brandingItem.prepared);
    fsyncTree(brandingItem.prepared);
  }

  const lock = acquireDatabaseLock({ databasePath: targetDatabase, kind: "recovery", appVersion: "linux-supervised-recovery" });
  const movedPrevious = [];
  const movedPrepared = [];
  let receipt;
  let safety;
  try {
    createSafetySnapshot({
      safetyRoot,
      safetyReceipt: safetyReceiptPath,
      recoveryId,
      snapshotId,
      targets,
    }, internalPolicy);
    safety = verifySafetyReceipt(safetyReceiptPath, path.join(safetyRoot, "live"), recoveryId, snapshotId, internalPolicy);
    for (const item of targets) {
      if (pathExists(item.target)) {
        fs.renameSync(item.target, item.previous);
        movedPrevious.push(item);
      }
      if (item.source && pathExists(item.prepared)) {
        fs.renameSync(item.prepared, item.target);
        movedPrepared.push(item);
      } else if (item.required) fail("Ein erforderlicher Recovery-Bestandteil fehlt.");
      fsyncDirectory(path.dirname(item.target));
    }
    sqliteIntegrity(targetDatabase);
    receipt = {
      format: "grabenplaner-linux-recovery-application",
      schemaVersion: 1,
      state: "applied",
      recoveryId,
      snapshotId,
      databaseSha256: sha256File(targetDatabase),
      verifiedReceiptSha256: sha256File(path.resolve(values["verified-receipt"])),
      safetyReceiptSha256: sha256File(path.resolve(values["safety-receipt"])),
      safetyTreeSha256: safety.treeSha256,
      preservedLivePaths: movedPrevious.map((item) => item.previous),
      appliedAt: new Date().toISOString(),
      servicesStarted: false,
    };
    atomicJson(path.resolve(values.output), receipt);
  } catch (error) {
    for (const item of [...movedPrepared].reverse()) {
      if (pathExists(item.target) && !pathExists(item.failed)) fs.renameSync(item.target, item.failed);
    }
    for (const item of [...movedPrevious].reverse()) {
      if (!pathExists(item.target) && pathExists(item.previous)) fs.renameSync(item.previous, item.target);
    }
    throw error;
  } finally {
    if (!releaseDatabaseLock(lock)) fail("Die Recovery-Datenbanksperre konnte nicht sicher freigegeben werden.");
  }
  return receipt;
}

if (require.main === module) {
  try {
    const result = applyRecovery(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ ok: true, recoveryId: result.recoveryId, snapshotId: result.snapshotId })}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || "Recovery-Anwendung fehlgeschlagen."}\n`);
    process.exitCode = 1;
  }
}

module.exports = { applyRecovery, parseArguments, sourcePaths, assertSqliteRecoveryTarget };
