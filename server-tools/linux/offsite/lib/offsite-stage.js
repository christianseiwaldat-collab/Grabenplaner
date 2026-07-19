"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function fail(message) { throw new Error(message); }
function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
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

function create(stage, resultFile, metadataFiles) {
  const stageStat = fs.lstatSync(stage);
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) fail("Der Stagingordner ist unzulaessig.");
  const resultStat = assertRegular(resultFile);
  if (resultStat.size < 2 || resultStat.size > 64 * 1024) fail("Das Backup-Ergebnis ist unzulaessig.");
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8").replace(/^\uFEFF/, ""));
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
  if (manifest.format !== "grabenplaner-offsite-stage" || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) fail("Das Staging-Manifest wird nicht unterstuetzt.");
  const actual = walk(stage).filter((item) => item.path !== "offsite-stage-manifest.json");
  if (actual.length !== manifest.files.length) fail("Das Staging ist unvollstaendig.");
  for (let index = 0; index < actual.length; index += 1) {
    const expected = manifest.files[index];
    if (actual[index].path !== expected.path || actual[index].bytes !== expected.bytes || actual[index].sha256 !== expected.sha256) fail("Die Staging-Pruefsumme stimmt nicht.");
  }
  const source = manifest.sourceBackup || {};
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
  if (command === "create") create(stage, path.resolve(String(resultFile || "")), metadataFiles.map((file) => path.resolve(file)));
  else if (command === "verify") verify(stage);
  else if (command === "verify-result") verifyResult(stage, path.resolve(String(resultFile || "")));
  else fail("Unbekannter Staging-Vorgang.");
}

try { main(); }
catch (error) {
  process.stderr.write(`${error?.message || "Staging-Pruefung fehlgeschlagen."}\n`);
  process.exitCode = 1;
}
