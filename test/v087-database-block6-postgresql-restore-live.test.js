"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { Pool } = require("pg");
const { createAmuStorage } = require("../lib/amu-storage");
const {
  MUTATION_QUIESCE_ERROR_CODES,
  createProtectedDocumentMutationGate,
} = require("../lib/persistence/operations/mutation-quiesce");
const {
  verifyRecoveryAssuranceReceipt,
} = require("../lib/persistence/operations/recovery-assurance");
const {
  createPostgresqlBackupSnapshot,
} = require("../lib/persistence/postgresql/operations/backup");
const {
  verifyPostgresqlBackupRestore,
} = require("../lib/persistence/postgresql/operations/restore");
const {
  createPostgresqlRecoveryEvidenceReader,
} = require("../lib/persistence/postgresql/operations/evidence");
const {
  createPostgresqlRecoveryAssuranceReceipt,
} = require("../lib/persistence/postgresql/operations/recovery-assurance");
const {
  REQUIRED_ACCESS_POLICY,
  createPostgresqlOperationsMonitor,
} = require("../lib/persistence/postgresql/operations/monitor");
const {
  ERROR_CODES,
  POSTGRESQL_OPERATIONAL_PROFILE,
  buildPostgresqlRestoreListCommand,
  createPostgresqlToolCredentials,
  createPostgresqlToolPolicy,
  runPostgresqlTool,
} = require("../lib/persistence/postgresql/operations/tools");

const DATABASE_URL = String(process.env.TEST_POSTGRESQL_URL || "").trim();
const POSTGRESQL_BIN = String(process.env.TEST_POSTGRESQL_BIN || "").trim();

function databaseUrlFor(databaseName) {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function databaseUrlForCredentials(databaseName, username, password) {
  const url = new URL(databaseUrlFor(databaseName));
  url.username = username;
  url.password = password;
  return url.toString();
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(value)) throw new Error("unsafe identifier");
  return `"${value}"`;
}

function pgPassPart(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

if (!DATABASE_URL || !POSTGRESQL_BIN) {
  test("DB Block 6 Live: TEST_POSTGRESQL_URL und TEST_POSTGRESQL_BIN sind fuer den realen Restore erforderlich", {
    skip: "PostgreSQL-URL oder gepinnter Client-Bin-Pfad fehlt.",
  }, () => {});
} else {
  test("DB Block 6 Live: gepinnter pg_dump wird konsistent in eine neue DB restauriert und vollstaendig bereinigt", {
    timeout: 120_000,
  }, async (t) => {
    const suffix = `${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const sourceDatabase = `gp_db6_source_${suffix}`;
    const targetDatabase = `gp_db6_target_${suffix}`;
    const operationsRole = `gp_db6_operations_${suffix}`;
    const operationsPassword = crypto.randomBytes(24).toString("hex");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-pg-live-restore-"));
    const backupDirectory = path.join(root, "backups");
    const protectedDirectory = path.join(root, "protected");
    const scratchDocuments = path.join(root, "scratch-documents");
    fs.mkdirSync(backupDirectory, { mode: 0o700 });
    const adminPool = new Pool({
      connectionString: DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 10_000,
    });
    let sourcePool = null;
    let targetPool = null;
    let operationsPool = null;
    let targetExists = false;
    let operationsRoleExists = false;

    async function terminateAndDrop(databaseName) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    }

    t.after(async () => {
      if (targetPool) {
        await targetPool.end();
        targetPool = null;
      }
      if (sourcePool) {
        await sourcePool.end();
        sourcePool = null;
      }
      if (operationsPool) {
        await operationsPool.end();
        operationsPool = null;
      }
      await terminateAndDrop(targetDatabase);
      await terminateAndDrop(sourceDatabase);
      if (operationsRoleExists) {
        await adminPool.query(`DROP ROLE ${quoteIdentifier(operationsRole)}`);
        operationsRoleExists = false;
      }
      await adminPool.end();
      fs.rmSync(root, { recursive: true, force: true });
    });

    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(sourceDatabase)}`);
    sourcePool = new Pool({
      connectionString: databaseUrlFor(sourceDatabase),
      max: 4,
      connectionTimeoutMillis: 10_000,
    });
    await sourcePool.query(`
      CREATE SCHEMA grabenplaner;
      CREATE TABLE grabenplaner.items (
        id integer PRIMARY KEY,
        value text NOT NULL,
        CONSTRAINT items_value_nonempty CHECK (length(value) > 0)
      );
      CREATE TABLE grabenplaner.persistence_migration_history (
        migration_id text PRIMARY KEY,
        fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$')
      );
      CREATE TABLE grabenplaner.protected_documents (
        storage_key text PRIMARY KEY
      );
      INSERT INTO grabenplaner.items (id, value) VALUES (1, 'snapshot-row');
      INSERT INTO grabenplaner.persistence_migration_history (migration_id, fingerprint)
      VALUES ('001-block6-live', repeat('a', 64));
    `);

    await adminPool.query(`
      CREATE ROLE ${quoteIdentifier(operationsRole)}
        LOGIN
        PASSWORD '${operationsPassword}'
        NOSUPERUSER
        NOCREATEDB
        NOCREATEROLE
        NOREPLICATION
        NOBYPASSRLS;
      GRANT pg_monitor TO ${quoteIdentifier(operationsRole)};
      GRANT CONNECT ON DATABASE ${quoteIdentifier(sourceDatabase)}
        TO ${quoteIdentifier(operationsRole)};
    `);
    operationsRoleExists = true;
    operationsPool = new Pool({
      connectionString: databaseUrlForCredentials(
        sourceDatabase,
        operationsRole,
        operationsPassword,
      ),
      max: 1,
      connectionTimeoutMillis: 10_000,
    });
    const operationsClient = await operationsPool.connect();
    try {
      await operationsClient.query("BEGIN TRANSACTION READ ONLY");
      const monitoring = createPostgresqlOperationsMonitor({
        client: operationsClient,
        accessPolicy: { ...REQUIRED_ACCESS_POLICY },
      });
      const monitoringResult = await monitoring.read();
      assert.equal(monitoringResult.productActivation, false);
      assert.equal(monitoringResult.state, "unknown");
      assert.equal(monitoringResult.metrics.transactionReadOnly, true);
      assert.equal(monitoringResult.metrics.roleBoundary.leastPrivilege, true);
      assert.equal(monitoringResult.metrics.roleBoundary.monitorMembership, true);
      assert.equal(JSON.stringify(monitoringResult).includes(operationsRole), false);
      await operationsClient.query("ROLLBACK");
    } finally {
      operationsClient.release();
    }

    const encryptionKey = Buffer.alloc(32, 12);
    const protectedStorage = createAmuStorage({
      rootDirectory: protectedDirectory,
      encryptionKeys: { primary: encryptionKey },
      activeKeyId: "primary",
      scanner: async () => ({ available: true, clean: true, engine: "live-test" }),
    });
    const document = await protectedStorage.saveBuffer({
      buffer: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n% live restore\n%%EOF", "utf8"),
      originalName: "live-restore.pdf",
    });
    await sourcePool.query(
      "INSERT INTO grabenplaner.protected_documents (storage_key) VALUES ($1)",
      [document.storageKey],
    );

    const parsed = new URL(DATABASE_URL);
    const host = parsed.hostname;
    const port = parsed.port || "5432";
    const user = decodeURIComponent(parsed.username);
    const password = decodeURIComponent(parsed.password);
    if ([host, port, user, password].some((value) => /[\r\n]/.test(value))) {
      throw new Error("Die Testverbindung enthaelt unzulaessige Steuerzeichen.");
    }
    const serviceFilePath = path.join(root, "pg_service.conf");
    const passwordFilePath = path.join(root, "pgpass");
    fs.writeFileSync(serviceFilePath, [
      "[grabenplaner_block6_source]",
      `host=${host}`,
      `port=${port}`,
      `user=${user}`,
      `dbname=${sourceDatabase}`,
      "sslmode=disable",
      "connect_timeout=10",
      "",
      "[grabenplaner_block6_target]",
      `host=${host}`,
      `port=${port}`,
      `user=${user}`,
      `dbname=${targetDatabase}`,
      "sslmode=disable",
      "connect_timeout=10",
      "",
    ].join("\n"), { mode: 0o600 });
    fs.writeFileSync(
      passwordFilePath,
      `${pgPassPart(host)}:${pgPassPart(port)}:*:${pgPassPart(user)}:${pgPassPart(password || "unused")}\n`,
      { mode: 0o600 },
    );
    try {
      fs.chmodSync(serviceFilePath, 0o600);
      fs.chmodSync(passwordFilePath, 0o600);
    } catch {}

    const executable = (name) => path.resolve(
      POSTGRESQL_BIN,
      process.platform === "win32" ? `${name}.exe` : name,
    );
    const policy = createPostgresqlToolPolicy({
      profile: POSTGRESQL_OPERATIONAL_PROFILE,
      pgDumpPath: executable("pg_dump"),
      pgRestorePath: executable("pg_restore"),
      expectedToolMajor: 18,
      applicationSchema: "grabenplaner",
      timeoutMilliseconds: 60_000,
    });
    const sourceCredentials = createPostgresqlToolCredentials({
      serviceName: "grabenplaner_block6_source",
      serviceFilePath,
      passwordFilePath,
    });
    const targetCredentials = createPostgresqlToolCredentials({
      serviceName: "grabenplaner_block6_target",
      serviceFilePath,
      passwordFilePath,
    });
    const evidenceReader = createPostgresqlRecoveryEvidenceReader({
      applicationSchema: "grabenplaner",
      migrationLedgerTable: "persistence_migration_history",
      protectedDocumentSources: [
        { table: "protected_documents", column: "storage_key" },
      ],
    });

    const mutationGate = createProtectedDocumentMutationGate({
      timeoutMilliseconds: 10_000,
    });
    let releaseMutation;
    let mutationStarted;
    const mutationStartedPromise = new Promise((resolve) => {
      mutationStarted = resolve;
    });
    const mutationReleasePromise = new Promise((resolve) => {
      releaseMutation = resolve;
    });
    const activeDocumentMutation = mutationGate.runMutation(async () => {
      mutationStarted();
      await mutationReleasePromise;
      const concurrentDocument = await protectedStorage.saveBuffer({
        buffer: Buffer.from(
          "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n% concurrent live restore\n%%EOF",
          "utf8",
        ),
        originalName: "concurrent-live-restore.pdf",
      });
      await sourcePool.query(
        "INSERT INTO grabenplaner.protected_documents (storage_key) VALUES ($1)",
        [concurrentDocument.storageKey],
      );
      return concurrentDocument;
    });
    await mutationStartedPromise;

    let concurrentInsertDone = false;
    const backupPromise = createPostgresqlBackupSnapshot({
      pool: sourcePool,
      policy,
      credentials: sourceCredentials,
      backupDirectory,
      protectedDocumentsDirectory: protectedDirectory,
      appVersion: "0.87.0-beta",
      withQuiescedProtectedDocuments: mutationGate.withQuiescedMutations,
      async readSourceEvidence(executor) {
        const evidence = await evidenceReader.read(executor);
        return {
          fingerprint: evidence.fingerprint,
          referenceCount: evidence.referenceCount,
        };
      },
      async readProtectedDocumentReferences(executor) {
        const references = await evidenceReader
          .readProtectedDocumentReferences(executor);
        await sourcePool.query(
          "INSERT INTO grabenplaner.items (id, value) VALUES (2, 'after-exported-snapshot')",
        );
        concurrentInsertDone = true;
        return references;
      },
    });
    while (!mutationGate.status().quiescing) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await assert.rejects(
      mutationGate.runMutation(async () => {}),
      (error) => error?.code === MUTATION_QUIESCE_ERROR_CODES.MUTATION_BLOCKED,
    );
    releaseMutation();
    const concurrentDocument = await activeDocumentMutation;
    const backup = await backupPromise;
    assert.equal(concurrentInsertDone, true);
    assert.equal(backup.productActivation, false);
    assert.equal(backup.sourceEvidence.referenceCount, 2);
    assert.ok(
      backup.protectedDocumentReferences.includes(concurrentDocument.storageKey),
    );

    const proof = await verifyPostgresqlBackupRestore({
      backupDirectory,
      markerNameOrPath: backup.bundle.markerPath,
      policy,
      credentials: targetCredentials,
      scratchRootDirectory: root,
      scratchProtectedDocumentsDirectory: scratchDocuments,
      async prepareEmptyTarget({ targetBinding }) {
        await adminPool.query(`CREATE DATABASE ${quoteIdentifier(targetDatabase)}`);
        targetExists = true;
        targetPool = new Pool({
          connectionString: databaseUrlFor(targetDatabase),
          max: 2,
          connectionTimeoutMillis: 10_000,
        });
        const state = await targetPool.query(`
          SELECT count(*)::integer AS relations
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
            AND namespace.nspname !~ '^pg_toast'
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        `);
        return {
          created: true,
          empty: state.rows[0].relations === 0,
          isolated: targetDatabase !== sourceDatabase,
          targetBinding,
        };
      },
      async readRestoredEvidence({ targetBinding }) {
        const evidence = await evidenceReader.read(targetPool);
        return {
          fingerprint: evidence.fingerprint,
          referenceCount: evidence.referenceCount,
          protectedDocumentReferences: evidence.protectedDocumentReferences,
          targetBinding,
        };
      },
      async verifyApplicationSmoke({
        protectedDocumentsDirectory,
        targetBinding,
      }) {
        const schema = await targetPool.query(`
          SELECT
            to_regclass('grabenplaner.items') IS NOT NULL AS items,
            to_regclass('grabenplaner.persistence_migration_history') IS NOT NULL AS migrations,
            to_regclass('grabenplaner.protected_documents') IS NOT NULL AS documents,
            EXISTS (
              SELECT 1
              FROM pg_constraint
              WHERE conrelid = 'grabenplaner.items'::regclass
                AND contype = 'p'
            ) AS primary_key,
            EXISTS (
              SELECT 1
              FROM pg_constraint
              WHERE conrelid = 'grabenplaner.items'::regclass
                AND conname = 'items_value_nonempty'
            ) AS check_constraint
        `);
        assert.deepEqual(schema.rows[0], {
          items: true,
          migrations: true,
          documents: true,
          primary_key: true,
          check_constraint: true,
        });
        const rows = await targetPool.query(
          "SELECT id, value FROM grabenplaner.items ORDER BY id",
        );
        assert.deepEqual(rows.rows, [{ id: 1, value: "snapshot-row" }]);
        const restoredStorage = createAmuStorage({
          rootDirectory: protectedDocumentsDirectory,
          encryptionKeys: { primary: encryptionKey },
          activeKeyId: "primary",
        });
        assert.deepEqual(
          restoredStorage.readBuffer(document),
          protectedStorage.readBuffer(document),
        );
        return { passed: true, targetBinding };
      },
      async cleanupScratchTarget() {
        if (targetPool) {
          await targetPool.end();
          targetPool = null;
        }
        if (targetExists) {
          await terminateAndDrop(targetDatabase);
          targetExists = false;
        }
      },
    });

    assert.equal(targetExists, false);
    assert.equal(proof.productActivation, false);
    assert.deepEqual(proof.sourceEvidence, proof.restoredEvidence);
    const assuranceKeys = crypto.generateKeyPairSync("ed25519");
    const assuranceIssuedAt = new Date().toISOString();
    const assuranceReceipt = createPostgresqlRecoveryAssuranceReceipt({
      privateKey: assuranceKeys.privateKey,
      runId: crypto.randomUUID(),
      issuedAt: assuranceIssuedAt,
      appVersion: "0.87.0-beta",
      backup,
      restore: proof,
    });
    const assuranceStatus = verifyRecoveryAssuranceReceipt(assuranceReceipt, {
      publicKey: assuranceKeys.publicKey,
      expectedProviderId: "postgresql",
      expectedProfile: POSTGRESQL_OPERATIONAL_PROFILE,
      expectedBackupMethod: "postgresql-pg-dump-custom",
      now: new Date(assuranceIssuedAt),
      maximumAgeHours: 24,
    });
    assert.equal(assuranceReceipt.status, "failed");
    assert.equal(
      assuranceReceipt.errorCode,
      "POSTGRESQL_OFFSITE_UPLOAD_NOT_VERIFIED",
    );
    assert.equal(
      assuranceReceipt.evidence.bundleHash,
      backup.bundle.bundleHash,
    );
    assert.equal(assuranceStatus.verified, true);
    assert.equal(assuranceStatus.technicallyValid, false);
    assert.equal(assuranceStatus.productActivation, false);
    assert.equal(assuranceStatus.effective, false);
    assert.equal((await sourcePool.query(
      "SELECT count(*)::integer AS count FROM grabenplaner.items",
    )).rows[0].count, 2);

    const corruptDump = path.join(root, "corrupt.pgdump");
    fs.writeFileSync(corruptDump, "not-a-postgresql-custom-archive");
    await assert.rejects(
      runPostgresqlTool(buildPostgresqlRestoreListCommand({
        policy,
        dumpPath: corruptDump,
      })),
      (error) => error?.code === ERROR_CODES.TOOL_FAILED,
    );
  });
}
