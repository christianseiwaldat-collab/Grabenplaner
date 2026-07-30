"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAmuStorage } = require("../lib/amu-storage");
const {
  POSTGRESQL_BACKUP_ERROR_CODES,
  createPostgresqlBackupSnapshot,
} = require("../lib/persistence/postgresql/operations/backup");
const {
  POSTGRESQL_OPERATIONAL_PROFILE,
  createPostgresqlToolCredentials,
  createPostgresqlToolPolicy,
} = require("../lib/persistence/postgresql/operations/tools");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-pg-backup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backupDirectory = path.join(root, "backups");
  const protectedDocumentsDirectory = path.join(root, "protected");
  fs.mkdirSync(backupDirectory, { mode: 0o700 });
  const pgDumpPath = path.join(root, process.platform === "win32" ? "pg_dump.exe" : "pg_dump");
  const pgRestorePath = path.join(root, process.platform === "win32" ? "pg_restore.exe" : "pg_restore");
  const serviceFilePath = path.join(root, "pg-service.conf");
  const passwordFilePath = path.join(root, "pg-pass");
  for (const file of [pgDumpPath, pgRestorePath, serviceFilePath, passwordFilePath]) {
    fs.writeFileSync(file, "fixture", { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
  }
  const policy = createPostgresqlToolPolicy({
    profile: POSTGRESQL_OPERATIONAL_PROFILE,
    pgDumpPath,
    pgRestorePath,
    expectedToolMajor: 18,
    applicationSchema: "grabenplaner",
  });
  const credentials = createPostgresqlToolCredentials({
    serviceName: "grabenplaner_backup",
    serviceFilePath,
    passwordFilePath,
  });
  const calls = [];
  const pool = {
    async connect() {
      return {
        async query(text) {
          calls.push(text);
          if (text === "SELECT pg_export_snapshot() AS snapshot_id") {
            return { rows: [{ snapshot_id: "00000003-0000001B-1" }] };
          }
          return { rows: [] };
        },
        release(destroy) {
          calls.push(destroy ? "release-destroy" : "release");
        },
      };
    },
  };
  return {
    backupDirectory,
    calls,
    credentials,
    policy,
    pool,
    protectedDocumentsDirectory,
    root,
  };
}

async function addProtectedDocument(directory) {
  const storage = createAmuStorage({
    rootDirectory: directory,
    encryptionKeys: { primary: Buffer.alloc(32, 7) },
    activeKeyId: "primary",
    scanner: async () => ({ available: true, clean: true, engine: "test" }),
  });
  return storage.saveBuffer({
    buffer: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF", "utf8"),
    originalName: "beleg.pdf",
  });
}

function fakeToolRunner(calls, { failBackup = false } = {}) {
  return async (command) => {
    calls.push(command.operation);
    if (command.operation.endsWith("tool-version")) {
      return { stdout: "pg_dump (PostgreSQL) 18.4\n" };
    }
    if (command.operation === "backup") {
      if (failBackup) throw new Error("postgresql://secret@internal");
      fs.writeFileSync(command.outputPath, "PGDMP-test-fixture");
      return { stdout: "" };
    }
    if (command.operation === "backup-verification") {
      return { stdout: "; Archive created at 2026-07-30\n1; 0 0 TABLE grabenplaner fixture postgres\n" };
    }
    throw new Error(`unexpected operation: ${command.operation}`);
  };
}

test("DB Block 6: PostgreSQL-Dump, Snapshot-Evidence und geschuetzte Dokumente werden atomar gebunden", async (t) => {
  const value = fixture(t);
  const document = await addProtectedDocument(value.protectedDocumentsDirectory);
  const toolCalls = [];
  const nowValues = [
    new Date("2026-07-30T12:00:00.000Z"),
    new Date("2026-07-30T12:00:01.000Z"),
  ];
  const result = await createPostgresqlBackupSnapshot({
    pool: value.pool,
    policy: value.policy,
    credentials: value.credentials,
    backupDirectory: value.backupDirectory,
    protectedDocumentsDirectory: value.protectedDocumentsDirectory,
    appVersion: "0.87.0-beta",
    now: () => nowValues.shift(),
    runTool: fakeToolRunner(toolCalls),
    async withQuiescedProtectedDocuments(work) {
      return work({ active: true, pendingMutations: 0 });
    },
    async readSourceEvidence() {
      return { fingerprint: "a".repeat(64), referenceCount: 1 };
    },
    async readProtectedDocumentReferences() {
      return [document.storageKey];
    },
  });

  assert.equal(result.productActivation, false);
  assert.equal(result.bundle.providerId, "postgresql");
  assert.equal(result.bundle.method, "postgresql-pg-dump-custom");
  assert.deepEqual(result.sourceEvidence, {
    fingerprint: "a".repeat(64),
    referenceCount: 1,
  });
  assert.deepEqual(result.protectedDocumentReferences, [document.storageKey]);
  assert.deepEqual(toolCalls, [
    "backup-tool-version",
    "restore-tool-version",
    "backup",
    "backup-verification",
  ]);
  assert.deepEqual(value.calls, [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SELECT pg_export_snapshot() AS snapshot_id",
    "COMMIT",
    "release",
  ]);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(result.bundle.protectedDirectory, "manifest.json"),
    "utf8",
  ));
  assert.equal(manifest.database.fileName, path.basename(result.bundle.databasePath));
  assert.equal(manifest.database.sha256, result.bundle.marker.database.sha256);
  assert.deepEqual(manifest.snapshot, {
    providerId: "postgresql",
    method: "postgresql-pg-dump-custom",
    snapshotId: result.bundle.snapshotId,
    sourceEvidenceFingerprint: "a".repeat(64),
    referenceCount: 1,
  });
  assert.equal(
    fs.readdirSync(value.backupDirectory).some((name) => name.includes(".partial-")),
    false,
  );
});

test("DB Block 6: fehlende Quiesce-Evidence und Toolfehler hinterlassen keinen Sicherungspunkt", async (t) => {
  const value = fixture(t);
  await addProtectedDocument(value.protectedDocumentsDirectory);
  const common = {
    pool: value.pool,
    policy: value.policy,
    credentials: value.credentials,
    backupDirectory: value.backupDirectory,
    protectedDocumentsDirectory: value.protectedDocumentsDirectory,
    appVersion: "0.87.0-beta",
    now: () => new Date("2026-07-30T12:00:00.000Z"),
    readSourceEvidence: async () => ({ fingerprint: "b".repeat(64), referenceCount: 0 }),
    readProtectedDocumentReferences: async () => [],
  };

  await assert.rejects(
    createPostgresqlBackupSnapshot({
      ...common,
      runTool: fakeToolRunner([]),
      withQuiescedProtectedDocuments: async (work) => work({
        active: true,
        pendingMutations: 1,
      }),
    }),
    (error) => error?.code === POSTGRESQL_BACKUP_ERROR_CODES.QUIESCE_INVALID,
  );
  assert.deepEqual(fs.readdirSync(value.backupDirectory), []);

  await assert.rejects(
    createPostgresqlBackupSnapshot({
      ...common,
      runTool: fakeToolRunner([], { failBackup: true }),
      withQuiescedProtectedDocuments: async (work) => work({
        active: true,
        pendingMutations: 0,
      }),
    }),
    (error) => {
      assert.doesNotMatch(`${error?.message}\n${JSON.stringify(error)}`, /secret|internal/);
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(value.backupDirectory), []);
});
