"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAmuStorage } = require("../lib/amu-storage");
const {
  createPostgresqlBackupSnapshot,
} = require("../lib/persistence/postgresql/operations/backup");
const {
  POSTGRESQL_RESTORE_ERROR_CODES,
  verifyPostgresqlBackupRestore,
} = require("../lib/persistence/postgresql/operations/restore");
const {
  POSTGRESQL_OPERATIONAL_PROFILE,
  createPostgresqlToolCredentials,
  createPostgresqlToolPolicy,
} = require("../lib/persistence/postgresql/operations/tools");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-pg-restore-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backupDirectory = path.join(root, "backups");
  const protectedDocumentsDirectory = path.join(root, "protected");
  fs.mkdirSync(backupDirectory, { mode: 0o700 });
  const binaries = {
    pgDumpPath: path.join(root, process.platform === "win32" ? "pg_dump.exe" : "pg_dump"),
    pgRestorePath: path.join(root, process.platform === "win32" ? "pg_restore.exe" : "pg_restore"),
  };
  const sourceServiceFile = path.join(root, "pg-source.conf");
  const targetServiceFile = path.join(root, "pg-target.conf");
  const passwordFile = path.join(root, "pg-pass");
  for (const file of [
    ...Object.values(binaries),
    sourceServiceFile,
    targetServiceFile,
    passwordFile,
  ]) {
    fs.writeFileSync(file, "fixture", { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
  }
  const policy = createPostgresqlToolPolicy({
    profile: POSTGRESQL_OPERATIONAL_PROFILE,
    ...binaries,
    expectedToolMajor: 18,
    applicationSchema: "grabenplaner",
  });
  const sourceCredentials = createPostgresqlToolCredentials({
    serviceName: "grabenplaner_backup",
    serviceFilePath: sourceServiceFile,
    passwordFilePath: passwordFile,
  });
  const targetCredentials = createPostgresqlToolCredentials({
    serviceName: "grabenplaner_restore",
    serviceFilePath: targetServiceFile,
    passwordFilePath: passwordFile,
  });
  const pool = {
    async connect() {
      return {
        async query(text) {
          if (text === "SELECT pg_export_snapshot() AS snapshot_id") {
            return { rows: [{ snapshot_id: "00000003-0000001B-1" }] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  return {
    backupDirectory,
    policy,
    pool,
    protectedDocumentsDirectory,
    root,
    sourceCredentials,
    targetCredentials,
  };
}

async function createBundle(value) {
  const encryptionKey = Buffer.alloc(32, 9);
  const storage = createAmuStorage({
    rootDirectory: value.protectedDocumentsDirectory,
    encryptionKeys: { primary: encryptionKey },
    activeKeyId: "primary",
    scanner: async () => ({ available: true, clean: true, engine: "test" }),
  });
  const document = await storage.saveBuffer({
    buffer: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF", "utf8"),
    originalName: "restore.pdf",
  });
  const nowValues = [
    new Date("2026-07-30T13:00:00.000Z"),
    new Date("2026-07-30T13:00:01.000Z"),
  ];
  const created = await createPostgresqlBackupSnapshot({
    pool: value.pool,
    policy: value.policy,
    credentials: value.sourceCredentials,
    backupDirectory: value.backupDirectory,
    protectedDocumentsDirectory: value.protectedDocumentsDirectory,
    appVersion: "0.87.0-beta",
    now: () => nowValues.shift(),
    async runTool(command) {
      if (command.operation.endsWith("tool-version")) {
        return { stdout: "pg_dump (PostgreSQL) 18.4\n" };
      }
      if (command.operation === "backup") {
        fs.writeFileSync(command.outputPath, "PGDMP-restore-fixture");
        return { stdout: "" };
      }
      if (command.operation === "backup-verification") {
        return { stdout: "; PostgreSQL database dump\n1; 0 0 TABLE grabenplaner items postgres\n" };
      }
      throw new Error("unexpected");
    },
    async withQuiescedProtectedDocuments(work) {
      return work({ active: true, pendingMutations: 0 });
    },
    async readSourceEvidence() {
      return { fingerprint: "c".repeat(64), referenceCount: 1 };
    },
    async readProtectedDocumentReferences() {
      return [document.storageKey];
    },
  });
  return {
    created,
    document,
    encryptionKey,
  };
}

test("DB Block 6: isolierter Restore prueft DB-Evidence, Dokumente, Smoke und Cleanup", async (t) => {
  const value = fixture(t);
  const { created, document, encryptionKey } = await createBundle(value);
  const scratchDocuments = path.join(value.root, "scratch-documents");
  const calls = [];
  const proof = await verifyPostgresqlBackupRestore({
    backupDirectory: value.backupDirectory,
    markerNameOrPath: created.bundle.markerPath,
    policy: value.policy,
    credentials: value.targetCredentials,
    scratchRootDirectory: value.root,
    scratchProtectedDocumentsDirectory: scratchDocuments,
    async runTool(command) {
      calls.push(command.operation);
      if (command.operation.endsWith("tool-version")) {
        return { stdout: "pg_restore (PostgreSQL) 18.4\n" };
      }
      if (command.operation === "restore") return { stdout: "" };
      throw new Error("unexpected");
    },
    async prepareEmptyTarget({ targetBinding }) {
      calls.push("prepare-empty");
      return { created: true, empty: true, isolated: true, targetBinding };
    },
    async readRestoredEvidence({ targetBinding }) {
      calls.push("read-evidence");
      return {
        fingerprint: "c".repeat(64),
        referenceCount: 1,
        protectedDocumentReferences: [document.storageKey],
        targetBinding,
      };
    },
    async verifyApplicationSmoke({ protectedDocumentsDirectory, targetBinding }) {
      calls.push("application-smoke");
      const restoredStorage = createAmuStorage({
        rootDirectory: protectedDocumentsDirectory,
        encryptionKeys: { primary: encryptionKey },
        activeKeyId: "primary",
      });
      assert.ok(restoredStorage.readBuffer(document).length > 0);
      return { passed: true, targetBinding };
    },
    async cleanupScratchTarget() {
      calls.push("cleanup");
    },
  });

  assert.equal(proof.providerId, "postgresql");
  assert.equal(proof.backupMethod, "postgresql-pg-dump-custom");
  assert.equal(proof.applicationSmoke, true);
  assert.equal(proof.productActivation, false);
  assert.deepEqual(proof.sourceEvidence, proof.restoredEvidence);
  assert.match(proof.bundleHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(calls, [
    "backup-tool-version",
    "restore-tool-version",
    "prepare-empty",
    "restore",
    "read-evidence",
    "application-smoke",
    "cleanup",
  ]);
  assert.equal(fs.existsSync(scratchDocuments), false);
});

test("DB Block 6: nichtleeres Ziel und Evidence-Abweichung scheitern samt Cleanup geschlossen", async (t) => {
  const value = fixture(t);
  const { created, document } = await createBundle(value);
  for (const scenario of [
    {
      expectedCode: POSTGRESQL_RESTORE_ERROR_CODES.TARGET_NOT_EMPTY,
      target: ({ targetBinding }) => ({
        created: false,
        empty: false,
        isolated: true,
        targetBinding,
      }),
      fingerprint: "c".repeat(64),
      cleanupCalls: 1,
    },
    {
      expectedCode: POSTGRESQL_RESTORE_ERROR_CODES.EVIDENCE_MISMATCH,
      target: ({ targetBinding }) => ({
        created: true,
        empty: true,
        isolated: true,
        targetBinding,
      }),
      fingerprint: "d".repeat(64),
      cleanupCalls: 1,
    },
    {
      expectedCode: POSTGRESQL_RESTORE_ERROR_CODES.RESTORE_FAILED,
      target: async () => {
        throw new Error("target creation acknowledgement failed");
      },
      fingerprint: "c".repeat(64),
      cleanupCalls: 1,
    },
  ]) {
    const scratchDocuments = path.join(
      value.root,
      `scratch-${scenario.expectedCode.toLowerCase()}`,
    );
    let cleanupCalls = 0;
    await assert.rejects(
      verifyPostgresqlBackupRestore({
        backupDirectory: value.backupDirectory,
        markerNameOrPath: created.bundle.markerPath,
        policy: value.policy,
        credentials: value.targetCredentials,
        scratchRootDirectory: value.root,
        scratchProtectedDocumentsDirectory: scratchDocuments,
        runTool: async (command) => {
          if (command.operation.endsWith("tool-version")) {
            return { stdout: "pg_restore (PostgreSQL) 18.4\n" };
          }
          if (command.operation === "restore") return { stdout: "" };
          throw new Error("unexpected");
        },
        prepareEmptyTarget: async (input) => scenario.target(input),
        readRestoredEvidence: async ({ targetBinding }) => ({
          fingerprint: scenario.fingerprint,
          referenceCount: 1,
          protectedDocumentReferences: [document.storageKey],
          targetBinding,
        }),
        verifyApplicationSmoke: async ({ targetBinding }) => ({
          passed: true,
          targetBinding,
        }),
        cleanupScratchTarget: async () => {
          cleanupCalls += 1;
        },
      }),
      (error) => error?.code === scenario.expectedCode,
    );
    assert.equal(cleanupCalls, scenario.cleanupCalls);
    assert.equal(fs.existsSync(scratchDocuments), false);
  }
});

test("DB Block 6: fehlgeschlagenes Scratch-Cleanup kann niemals als Restore-Erfolg gelten", async (t) => {
  const value = fixture(t);
  const { created, document } = await createBundle(value);
  await assert.rejects(
    verifyPostgresqlBackupRestore({
      backupDirectory: value.backupDirectory,
      markerNameOrPath: created.bundle.markerPath,
      policy: value.policy,
      credentials: value.targetCredentials,
      scratchRootDirectory: value.root,
      scratchProtectedDocumentsDirectory: path.join(value.root, "scratch-cleanup"),
      runTool: async (command) => {
        if (command.operation.endsWith("tool-version")) {
          return { stdout: "pg_restore (PostgreSQL) 18.4\n" };
        }
        if (command.operation === "restore") return { stdout: "" };
        throw new Error("unexpected");
      },
      prepareEmptyTarget: async ({ targetBinding }) => ({
        created: true,
        empty: true,
        isolated: true,
        targetBinding,
      }),
      readRestoredEvidence: async ({ targetBinding }) => ({
        fingerprint: "c".repeat(64),
        referenceCount: 1,
        protectedDocumentReferences: [document.storageKey],
        targetBinding,
      }),
      verifyApplicationSmoke: async ({ targetBinding }) => ({
        passed: true,
        targetBinding,
      }),
      cleanupScratchTarget: async () => {
        throw new Error("postgresql://secret@internal");
      },
    }),
    (error) => {
      assert.equal(error?.code, POSTGRESQL_RESTORE_ERROR_CODES.CLEANUP_FAILED);
      assert.doesNotMatch(`${error.message}\n${JSON.stringify(error)}`, /secret|internal/);
      return true;
    },
  );
});
