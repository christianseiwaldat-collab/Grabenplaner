"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createAmuStorage, syncEncryptedFilesBackup } = require("../lib/amu-storage");
const { verifyCommittedBackup } = require("../lib/backup-commit");

const powershell = process.platform === "win32"
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "";

test("standalone backup creates a verifiable committed pair on Windows-compatible paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-backup-cli-"));
  const dataRoot = path.join(root, "data-root");
  const protectedRoot = path.join(dataRoot, "private", "amu");
  const backupDirectory = path.join(root, "backups");
  process.env.GRABENPLANER_DATA_ROOT = dataRoot;
  createAmuStorage({
    rootDirectory: protectedRoot,
    encryptionKeys: { primary: crypto.randomBytes(32) },
    activeKeyId: "primary",
    scanner: async () => ({ available: true, clean: true, engine: "test" }),
  });
  const { createPairedBackup, verifyStandaloneBackupPair } = require("../backup");
  const { pruneCommittedBackups } = require("../lib/backup-commit");
  const database = new DatabaseSync(path.join(root, "source.db"));
  try {
    database.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample (value) VALUES ('ok')");
    const result = createPairedBackup(database, backupDirectory, "2026-07-19T12-00-00-000Z", "Testbackup");
    assert.equal(result.committed, true);
    assert.equal(fs.existsSync(result.marker), true);
    assert.equal(verifyCommittedBackup(backupDirectory, path.basename(result.marker)).committed, true);

    const newer = createPairedBackup(database, backupDirectory, "2026-07-20T12-00-00-000Z", "Testbackup neu");
    fs.utimesSync(result.marker, new Date("2026-07-19T12:00:00Z"), new Date("2026-07-19T12:00:00Z"));
    fs.utimesSync(newer.marker, new Date("2026-07-20T12:00:00Z"), new Date("2026-07-20T12:00:00Z"));
    const newerManifest = JSON.parse(fs.readFileSync(path.join(newer.protectedDirectory, "manifest.json"), "utf8"));
    fs.appendFileSync(path.join(newer.protectedDirectory, newerManifest.keyCheck.fileName), "tampered");
    const retention = pruneCommittedBackups(backupDirectory, 1, { verifyPair: verifyStandaloneBackupPair });
    assert.equal(retention.removed, 0);
    assert.equal(fs.existsSync(result.marker), true);
    assert.equal(fs.existsSync(newer.marker), true);

    database.exec(`
      CREATE TABLE loan_documents (id TEXT PRIMARY KEY, storage_key TEXT NOT NULL);
      CREATE TABLE loan_photos (id TEXT PRIMARY KEY, storage_key TEXT NOT NULL);
      INSERT INTO loan_documents (id, storage_key)
      VALUES ('missing-loan-document', 'aa/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.amu');
    `);
    assert.throws(
      () => createPairedBackup(database, backupDirectory, "2026-07-21T12-00-00-000Z", "UnvollstÃ¤ndiger Beleg"),
      (error) => error?.code === "AMU_BACKUP_REFERENCE_MISSING",
    );
    database.exec(`
      DELETE FROM loan_documents;
      INSERT INTO loan_photos (id, storage_key)
      VALUES ('missing-loan-photo', 'bb/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.amu');
    `);
    assert.throws(
      () => createPairedBackup(database, backupDirectory, "2026-07-22T12-00-00-000Z", "UnvollstÃ¤ndiges Foto"),
      (error) => error?.code === "AMU_BACKUP_REFERENCE_MISSING",
    );
    assert.deepEqual(
      fs.readdirSync(backupDirectory).filter((name) => name.includes("2026-07-21") || name.includes("2026-07-22")),
      [],
    );
  } finally {
    database.close();
    delete process.env.GRABENPLANER_DATA_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows server backup rejects snapshots with missing protected loan or candidate files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-windows-backup-verify-"));
  const protectedRoot = path.join(root, "private", "amu");
  const sourceDatabase = path.join(root, "source.db");
  const targetDatabase = path.join(root, "snapshot.db");
  const protectedBackup = path.join(root, "snapshot.amu");
  try {
    createAmuStorage({
      rootDirectory: protectedRoot,
      encryptionKeys: { primary: crypto.randomBytes(32) },
      activeKeyId: "primary",
    });
    const database = new DatabaseSync(sourceDatabase);
    database.exec(`
      CREATE TABLE loan_documents (id TEXT PRIMARY KEY, storage_key TEXT NOT NULL);
      INSERT INTO loan_documents (id, storage_key)
      VALUES ('missing-document', 'aa/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.amu');
    `);
    database.close();
    const tool = fs.readFileSync(
      path.join(__dirname, "..", "server-tools", "windows", "Backup-Grabenplaner.ps1"),
      "utf8",
    );
    const nodeScript = tool.match(/\$nodeScript = @'\r?\n([\s\S]*?)\r?\n'@/)?.[1] || "";
    assert.match(nodeScript, /verifyBackupReferences/);
    const result = spawnSync(process.execPath, [
      "-",
      sourceDatabase,
      targetDatabase,
      path.join(__dirname, "..", "lib", "database-lock.js"),
      path.join(__dirname, "..", "lib", "amu-storage.js"),
      protectedRoot,
      protectedBackup,
      path.basename(targetDatabase),
    ], {
      input: nodeScript,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /referenzierte geschützte Datei|referenzierte geschuetzte Datei/i);

    const candidateDatabase = new DatabaseSync(sourceDatabase);
    candidateDatabase.exec(`
      DELETE FROM loan_documents;
      CREATE TABLE candidate_document_versions (
        document_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        storage_key TEXT NOT NULL,
        PRIMARY KEY (document_id, version_number)
      );
      INSERT INTO candidate_document_versions (document_id, version_number, storage_key)
      VALUES ('candidate-photo', 1, 'cc/cccccccc-cccc-4ccc-8ccc-cccccccccccc.amu');
    `);
    candidateDatabase.close();
    const candidateTargetDatabase = path.join(root, "candidate-snapshot.db");
    const candidateProtectedBackup = path.join(root, "candidate-snapshot.amu");
    const candidateResult = spawnSync(process.execPath, [
      "-",
      sourceDatabase,
      candidateTargetDatabase,
      path.join(__dirname, "..", "lib", "database-lock.js"),
      path.join(__dirname, "..", "lib", "amu-storage.js"),
      protectedRoot,
      candidateProtectedBackup,
      path.basename(candidateTargetDatabase),
    ], {
      input: nodeScript,
      encoding: "utf8",
    });
    assert.notEqual(candidateResult.status, 0, candidateResult.stdout);
    assert.match(
      candidateResult.stderr,
      /referenzierte geschützte Datei|referenzierte geschuetzte Datei/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows restore accepts only an empty installer-created AMU skeleton", {
  skip: !powershell || !fs.existsSync(powershell),
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-windows-restore-skeleton-"));
  const amuTarget = path.join(root, "private", "amu");
  const harness = path.join(root, "restore-amu-guard.ps1");
  try {
    fs.mkdirSync(path.join(amuTarget, "blobs"), { recursive: true });
    fs.mkdirSync(path.join(amuTarget, "tmp"), { recursive: true });
    const restore = fs.readFileSync(
      path.join(__dirname, "..", "server-tools", "windows", "Restore-Grabenplaner.ps1"),
      "utf8",
    );
    const guardStart = restore.indexOf("$amuTarget =");
    const guardEnd = restore.indexOf("$amuModule =", guardStart);
    assert.notEqual(guardStart, -1, "AMU-Zielpruefung im Restore-Skript fehlt.");
    assert.notEqual(guardEnd, -1, "Ende der AMU-Zielpruefung im Restore-Skript fehlt.");
    fs.writeFileSync(harness, [
      "param([Parameter(Mandatory = $true)][string]$AmuDirectory)",
      "$ErrorActionPreference = 'Stop'",
      restore.slice(guardStart, guardEnd).trim(),
      "Write-Output 'accepted'",
      "",
    ].join("\r\n"), "utf8");

    const emptySkeleton = spawnSync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", harness, "-AmuDirectory", amuTarget,
    ], { encoding: "utf8" });
    assert.equal(emptySkeleton.status, 0, emptySkeleton.stderr);
    assert.match(emptySkeleton.stdout, /accepted/);

    const sentinel = path.join(amuTarget, "blobs", "existing.amu");
    fs.writeFileSync(sentinel, "must-not-be-overwritten", "utf8");
    const nonEmptySkeleton = spawnSync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", harness, "-AmuDirectory", amuTarget,
    ], { encoding: "utf8" });
    assert.notEqual(nonEmptySkeleton.status, 0, nonEmptySkeleton.stdout);
    assert.match(
      `${nonEmptySkeleton.stderr}\n${nonEmptySkeleton.stdout}`,
      /AMU-Ziel ist nicht initialisiert und nicht leer/i,
    );
    assert.equal(fs.readFileSync(sentinel, "utf8"), "must-not-be-overwritten");

    const fileTarget = path.join(root, "private", "amu-file-target");
    fs.writeFileSync(fileTarget, "existing-file-must-survive", "utf8");
    const regularFileTarget = spawnSync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", harness, "-AmuDirectory", fileTarget,
    ], { encoding: "utf8" });
    assert.notEqual(regularFileTarget.status, 0, regularFileTarget.stdout);
    assert.match(
      `${regularFileTarget.stderr}\n${regularFileTarget.stdout}`,
      /AMU-Ziel muss ein regulaeres lokales Verzeichnis ohne Reparse-Point sein/i,
    );
    assert.equal(fs.readFileSync(fileTarget, "utf8"), "existing-file-must-survive");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows diagnostics reject a backup with a missing protected loan reference", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-windows-diagnostic-backup-"));
  const protectedRoot = path.join(root, "private", "amu");
  const protectedBackup = path.join(root, "snapshot.amu");
  const databasePath = path.join(root, "snapshot.db");
  try {
    createAmuStorage({
      rootDirectory: protectedRoot,
      encryptionKeys: { primary: crypto.randomBytes(32) },
      activeKeyId: "primary",
    });
    syncEncryptedFilesBackup({
      sourceDirectory: protectedRoot,
      targetDirectory: protectedBackup,
    });
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE loan_documents (id TEXT PRIMARY KEY, storage_key TEXT NOT NULL);
      CREATE TABLE loan_photos (id TEXT PRIMARY KEY, storage_key TEXT NOT NULL);
      INSERT INTO loan_documents (id, storage_key)
      VALUES ('missing-document', 'aa/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.amu');
      INSERT INTO loan_photos (id, storage_key)
      VALUES ('missing-photo', 'bb/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.amu');
    `);
    database.close();

    const diagnostic = fs.readFileSync(
      path.join(__dirname, "..", "server-tools", "windows", "Test-GrabenplanerServer.ps1"),
      "utf8",
    );
    const nodeScript = diagnostic.match(/\$amuCheckScript = @'\r?\n([\s\S]*?)\r?\n'@/)?.[1] || "";
    assert.match(nodeScript, /verifyBackupReferences/);
    assert.match(nodeScript, /loan_documents/);
    assert.match(nodeScript, /loan_photos/);
    const result = spawnSync(process.execPath, [
      "-",
      path.join(__dirname, "..", "lib", "amu-storage.js"),
      protectedBackup,
      databasePath,
    ], {
      input: nodeScript,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /referenzierte gesch.tzte Datei/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
