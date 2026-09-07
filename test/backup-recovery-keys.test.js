"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { openSqliteLegacyDatabase } = require("../lib/persistence/sqlite/provider");
const { createAmuStorage, syncEncryptedFilesBackup } = require("../lib/amu-storage");
const { createIntegrationSecretVault } = require("../lib/integration-secret-vault");
const { verifyBackupRecoveryKeys } = require("../lib/backup-recovery-keys");

test("archived recovery authenticates existing document and import keys, rejecting missing, wrong and damaged key evidence", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-backup-key-proof-"));
  let database;
  t.after(() => { database?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const documentKey = crypto.randomBytes(32), vaultKey = crypto.randomBytes(32);
  const source = path.join(root, "source"), protectedDirectory = path.join(root, "backup");
  const storage = createAmuStorage({ rootDirectory: source, encryptionKeys: { fixture: documentKey }, activeKeyId: "fixture",
    scanner: async () => ({ available: true, clean: true, engine: "synthetic" }) });
  const saved = await storage.saveBuffer({ buffer: Buffer.from("%PDF-1.7\nsynthetic recovery proof"), originalName: "synthetic.pdf" });
  syncEncryptedFilesBackup({ sourceDirectory: source, targetDirectory: protectedDirectory });
  const databasePath = path.join(root, "snapshot.db");
  database = openSqliteLegacyDatabase(databasePath);
  database.exec("CREATE TABLE data_import_runtime_keys (id TEXT PRIMARY KEY, payload TEXT); CREATE TABLE data_import_sources (id TEXT PRIMARY KEY)");
  const vault = createIntegrationSecretVault({ activeKeyId: "fixture", keys: { fixture: vaultKey } });
  const bytes = crypto.randomBytes(64);
  const envelope = vault.seal(bytes, { namespace: "data-import", connectorId: "data-import-v1", field: "data-and-index-keys", purpose: "source-archive-and-recovery" });
  bytes.fill(0);
  database.prepare("INSERT INTO data_import_runtime_keys VALUES (?, ?)").run("data-import-v1", envelope);
  const environment = { GRABENPLANER_AMU_KEY_ID: "fixture", GRABENPLANER_AMU_KEY: documentKey.toString("base64"),
    GRABENPLANER_INTEGRATION_KEY_ID: "fixture", GRABENPLANER_INTEGRATION_KEY: vaultKey.toString("base64") };
  const verify = env => verifyBackupRecoveryKeys({ databasePath, protectedDirectory, environment: env });
  assert.deepEqual(verify(environment), { verified: true, documentKeyVerified: true, documentFiles: 1, managedImportKeysVerified: 1 });
  assert.throws(() => verify({ ...environment, GRABENPLANER_AMU_KEY: crypto.randomBytes(32).toString("base64") }), { code: "BACKUP_RECOVERY_KEYS_UNVERIFIED" });
  assert.throws(() => verify({ ...environment, GRABENPLANER_INTEGRATION_KEY: crypto.randomBytes(32).toString("base64") }), { code: "BACKUP_RECOVERY_KEYS_UNVERIFIED" });
  database.exec("DELETE FROM data_import_runtime_keys; INSERT INTO data_import_sources VALUES ('synthetic-source')");
  assert.throws(() => verify(environment), { code: "BACKUP_RECOVERY_KEYS_UNVERIFIED" });
  database.exec("DELETE FROM data_import_sources; CREATE TABLE cash_snapshot_datasets (slot INTEGER PRIMARY KEY); INSERT INTO cash_snapshot_datasets VALUES (1)");
  assert.throws(() => verify(environment), { code: "BACKUP_RECOVERY_KEYS_UNVERIFIED" });
  database.prepare("INSERT INTO data_import_runtime_keys VALUES (?, ?)").run("data-import-v1", envelope);
  const blob = path.join(protectedDirectory, "blobs", ...saved.storageKey.split("/"));
  fs.appendFileSync(blob, "synthetic corruption");
  assert.throws(() => verify(environment), { code: "BACKUP_RECOVERY_KEYS_UNVERIFIED" });
  assert.ok(documentKey.some(byte => byte !== 0), "borrowed input keys are never destroyed by validation");
});
