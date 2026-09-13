"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function fail(message) { throw new Error(message); }
// This module is installed independently of the app. Keep the bounded reader
// local so an older/newer core installation cannot change its pinned contract.
function sha256(file) {
  const before = assertRegular(file);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  const unchanged = (after) => after.isFile() && after.nlink === 1
    && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
  try {
    if (!unchanged(fs.fstatSync(descriptor))) fail("Eine Staging-Datei wurde ausgetauscht.");
    const buffer = Buffer.allocUnsafe(1024 * 1024), hash = crypto.createHash("sha256");
    let position = 0;
    while (position < before.size) {
      const bytes = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (bytes <= 0) fail("Eine Staging-Datei endete unerwartet.");
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
    if (!unchanged(fs.fstatSync(descriptor)) || !unchanged(assertRegular(file))) {
      fail("Eine Staging-Datei wurde waehrend der Pruefung veraendert.");
    }
    return hash.digest("hex");
  } finally { fs.closeSync(descriptor); }
}
function safeName(value) { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/.test(value); }

function assertRegular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("Eine Staging-Datei ist unzulaessig.");
  return stat;
}

function walk(root, directory = root) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!safeName(entry.name)) fail("Ein Staging-Name ist unzulaessig.");
    const target = path.join(directory, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fail("Symbolische Links sind im Staging nicht erlaubt.");
    if (stat.isDirectory()) files.push(...walk(root, target));
    else if (stat.isFile() && stat.nlink === 1) files.push({
      path: path.relative(root, target).split(path.sep).join("/"),
      bytes: stat.size,
      sha256: sha256(target),
    });
    else fail("Ein Staging-Dateityp ist unzulaessig.");
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o400, flag: "wx" });
  fs.renameSync(temporary, file);
}

// Version 2 carries an inseparable Core/Sales pair. Version 1 remains the
// existing SQLite format so old snapshots keep their original restore route.
function verifyPair(stage, source) {
  if (!safeName(String(source.bundle || "")) || !safeName(String(source.commitMarker || ""))
    || !/^[a-f0-9]{64}$/.test(String(source.manifestSha256 || ""))) fail("Der PostgreSQL-Sicherungsbezug ist ungueltig.");
  const bundle = path.join(stage, "backup", source.bundle);
  const markerFile = path.join(stage, "backup", source.commitMarker);
  const manifestFile = path.join(bundle, "manifest.json");
  if (assertRegular(markerFile).size > 4096 || assertRegular(manifestFile).size > 4 * 1024 * 1024) fail("Der PostgreSQL-Sicherungsbezug ist zu gross.");
  const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
  if (marker.format !== "grabenplaner-postgresql-pair" || marker.schemaVersion !== 1
    || marker.bundle !== source.bundle || marker.manifestSha256 !== source.manifestSha256
    || sha256(manifestFile) !== source.manifestSha256) fail("Der gemeinsame PostgreSQL-Abschlussbeleg stimmt nicht.");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.format !== marker.format || manifest.schemaVersion !== 1 || manifest.snapshotId !== marker.snapshotId
    || !Array.isArray(manifest.databases) || manifest.databases.map((d) => d.domain).join(",") !== "core,sales"
    || manifest.databases[0].database === manifest.databases[1].database || !Array.isArray(manifest.files)) fail("Die PostgreSQL-Datenbankpaarung ist ungueltig.");
  const actual = walk(bundle).filter((file) => file.path !== "manifest.json");
  const expected = new Map();
  for (const file of manifest.files) {
    if (typeof file.file !== "string" || !file.file.split("/").every((part) => safeName(part) && part !== "." && part !== "..")
      || expected.has(file.file)) fail("Eine PostgreSQL-Komponente ist ungueltig.");
    expected.set(file.file, file);
  }
  if (expected.size !== actual.length) fail("Die PostgreSQL-Sicherung ist unvollstaendig.");
  for (const file of actual) {
    const entry = expected.get(file.path);
    if (!entry || entry.bytes !== file.bytes || entry.sha256 !== file.sha256) fail("Eine PostgreSQL-Komponente stimmt nicht.");
  }
  for (const database of manifest.databases) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(database.database) || database.file !== `${database.domain}.dump`
      || !expected.has(database.file)) fail("Eine PostgreSQL-Datenbank fehlt.");
  }
  for (const file of ["configuration.env", "roles.sql"]) if (!expected.has(file)) fail("Die PostgreSQL-Wiederherstellungskonfiguration fehlt.");
  return { providerId: "postgresql-pair", bundle, commitMarker: markerFile, manifestSha256: source.manifestSha256 };
}

function createPair(stage, result) {
  const sourceBackup = {
    providerId: "postgresql-pair", bundle: path.basename(String(result.bundle || "")),
    commitMarker: path.basename(String(result.commitMarker || "")), manifestSha256: result.sha256,
    sourcePaths: { bundle: result.bundle, commitMarker: result.commitMarker },
  };
  verifyPair(stage, sourceBackup);
  const files = walk(stage).filter((item) => item.path !== "offsite-stage-manifest.json");
  atomicJson(path.join(stage, "offsite-stage-manifest.json"), {
    format: "grabenplaner-offsite-stage", schemaVersion: 2, createdAt: new Date().toISOString(), sourceBackup, files,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, providerId: "postgresql-pair", files: files.length })}\n`);
}

function create(stage, resultFile, metadataFiles) {
  const stageStat = fs.lstatSync(stage);
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) fail("Der Stagingordner ist unzulaessig.");
  const resultStat = assertRegular(resultFile);
  if (resultStat.size < 2 || resultStat.size > 64 * 1024) fail("Das Backup-Ergebnis ist unzulaessig.");
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8").replace(/^\uFEFF/, ""));
  if (result.providerId === "postgresql-pair") return createPair(stage, result);
  for (const key of ["path", "amuBackup", "commitMarker", "sha256", "createdAt"]) {
    if (!Object.hasOwn(result, key)) fail("Das Backup-Ergebnis ist unvollstaendig.");
  }
  const backupNames = [result.path, result.amuBackup, result.commitMarker].map((value) => path.basename(String(value)));
  if (!backupNames.every(safeName) || !backupNames[0].endsWith(".db") || !backupNames[1].endsWith(".amu") || !backupNames[2].endsWith(".complete.json")) {
    fail("Die Backup-Dateinamen sind unzulaessig.");
  }
  for (const metadata of metadataFiles) assertRegular(metadata);
  const files = walk(stage).filter((item) => item.path !== "offsite-stage-manifest.json");
  for (const required of backupNames) {
    if (!files.some((item) => item.path === `backup/${required}` || item.path.startsWith(`backup/${required}/`))) {
      fail("Das Staging enthaelt nicht den exakten Backup-Sicherungspunkt.");
    }
  }
  const manifest = {
    format: "grabenplaner-offsite-stage",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceBackup: {
      database: backupNames[0],
      documents: backupNames[1],
      commitMarker: backupNames[2],
      databaseSha256: String(result.sha256).toLowerCase(),
      sourcePaths: {
        database: String(result.path),
        documents: String(result.amuBackup),
        commitMarker: String(result.commitMarker),
      },
    },
    files,
  };
  if (!/^[a-f0-9]{64}$/.test(manifest.sourceBackup.databaseSha256)) fail("Der Datenbank-Hash ist ungueltig.");
  const databaseEntry = files.find((item) => item.path === `backup/${manifest.sourceBackup.database}`);
  if (!databaseEntry || databaseEntry.sha256 !== manifest.sourceBackup.databaseSha256) {
    fail("Die kopierte Datenbank stimmt nicht mit dem Backupbeleg ueberein.");
  }
  atomicJson(path.join(stage, "offsite-stage-manifest.json"), manifest);
  process.stdout.write(`${JSON.stringify({ ok: true, manifest: "offsite-stage-manifest.json", files: files.length })}\n`);
}

function verify(stage) {
  const manifestPath = path.join(stage, "offsite-stage-manifest.json");
  const stat = assertRegular(manifestPath);
  if (stat.size < 2 || stat.size > 1024 * 1024) fail("Das Staging-Manifest ist unzulaessig.");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.format !== "grabenplaner-offsite-stage" || ![1, 2].includes(manifest.schemaVersion) || !Array.isArray(manifest.files)) fail("Das Staging-Manifest wird nicht unterstuetzt.");
  const actual = walk(stage).filter((item) => item.path !== "offsite-stage-manifest.json");
  if (actual.length !== manifest.files.length) fail("Das Staging ist unvollstaendig.");
  for (let index = 0; index < actual.length; index += 1) {
    const expected = manifest.files[index];
    if (actual[index].path !== expected.path || actual[index].bytes !== expected.bytes || actual[index].sha256 !== expected.sha256) fail("Die Staging-Pruefsumme stimmt nicht.");
  }
  const source = manifest.sourceBackup || {};
  if (manifest.schemaVersion === 2) {
    if (source.providerId !== "postgresql-pair") fail("Der Staging-Provider ist ungueltig.");
    process.stdout.write(`${JSON.stringify({ ok: true, ...verifyPair(stage, source) })}\n`);
    return;
  }
  for (const name of [source.database, source.documents, source.commitMarker]) if (!safeName(String(name || ""))) fail("Der Backup-Bezug ist ungueltig.");
  if (!/^[a-f0-9]{64}$/.test(String(source.databaseSha256 || ""))) fail("Der Datenbank-Hash ist ungueltig.");
  const databaseEntry = actual.find((item) => item.path === `backup/${source.database}`);
  if (!databaseEntry || databaseEntry.sha256 !== source.databaseSha256) fail("Der Datenbank-Hash stimmt nicht mit dem Backupbeleg ueberein.");
  const result = {
    ok: true,
    database: path.join(stage, "backup", source.database),
    documents: path.join(stage, "backup", source.documents),
    commitMarker: path.join(stage, "backup", source.commitMarker),
  };
  for (const target of [result.database, result.commitMarker]) assertRegular(target);
  const documentsStat = fs.lstatSync(result.documents);
  if (!documentsStat.isDirectory() || documentsStat.isSymbolicLink()) fail("Der Dokument-Sicherungspunkt fehlt.");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function verifyResult(stage, resultFile) {
  const resultOutput = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (value) => { resultOutput.push(String(value)); return true; };
  try { verify(stage); } finally { process.stdout.write = originalWrite; }
  const resultStat = assertRegular(resultFile);
  if (resultStat.size < 2 || resultStat.size > 64 * 1024) fail("Das Backup-Ergebnis ist unzulaessig.");
  const supplied = JSON.parse(fs.readFileSync(resultFile, "utf8").replace(/^\uFEFF/, ""));
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, "offsite-stage-manifest.json"), "utf8"));
  const source = manifest.sourceBackup || {};
  const paths = source.sourcePaths || {};
  if (manifest.schemaVersion === 2) {
    if (supplied.providerId !== "postgresql-pair" || paths.bundle !== supplied.bundle || paths.commitMarker !== supplied.commitMarker
      || source.bundle !== path.basename(String(supplied.bundle || "")) || source.commitMarker !== path.basename(String(supplied.commitMarker || ""))
      || source.manifestSha256 !== supplied.sha256) fail("Das PostgreSQL-Staging gehoert nicht zum uebergebenen Sicherungsstand.");
    process.stdout.write(`${JSON.stringify({ ok: true, exactBackupResult: true, providerId: "postgresql-pair" })}\n`);
    return;
  }
  if (paths.database !== supplied.path || paths.documents !== supplied.amuBackup || paths.commitMarker !== supplied.commitMarker
    || source.database !== path.basename(String(supplied.path || ""))
    || source.documents !== path.basename(String(supplied.amuBackup || ""))
    || source.commitMarker !== path.basename(String(supplied.commitMarker || ""))
    || source.databaseSha256 !== String(supplied.sha256 || "").toLowerCase()) {
    fail("Das vorhandene Staging gehoert nicht zum uebergebenen Backupbeleg.");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, exactBackupResult: true })}\n`);
}

function main() {
  const [command, stageArg, resultFile, ...metadataFiles] = process.argv.slice(2);
  const stage = path.resolve(String(stageArg || ""));
  if (!path.isAbsolute(String(stageArg || "")) || stage === path.parse(stage).root) fail("Der Stagingpfad ist ungueltig.");
  if (command === "assert-empty-root") {
    if (resultFile !== undefined || metadataFiles.length) fail("Unzulaessige Staging-Parameter.");
    let current = path.parse(stage).root;
    for (const part of path.relative(current, stage).split(path.sep)) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Der Stagingpfad ist unsicher.");
    }
    if (fs.readdirSync(stage).length) fail("Vorhandene Staging-Arbeitsdaten muessen zuerst geprueft werden.");
    process.stdout.write('{"ok":true,"empty":true}\n');
  }
  else if (command === "create") create(stage, path.resolve(String(resultFile || "")), metadataFiles.map((file) => path.resolve(file)));
  else if (command === "verify") verify(stage);
  else if (command === "verify-result") verifyResult(stage, path.resolve(String(resultFile || "")));
  else fail("Unbekannter Staging-Vorgang.");
}

try { main(); }
catch (error) {
  process.stderr.write(`${error?.message || "Staging-Pruefung fehlgeschlagen."}\n`);
  process.exitCode = 1;
}
