"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const entries = ["backup.js", "scripts/run-background-backup.js", "server-tools/linux/lib/backup-snapshot.js",
  "server-tools/linux/lib/restore-backup.js", "server-tools/linux/lib/verify-backup.js",
  "server-tools/linux/offsite/lib/application-smoke.js"];

test("all retired online backup entrypoints reject before loading a database or writing a file", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-retired-backup-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = path.join(directory, "old.db"), bytes = Buffer.from("SQLite format 3\0preserve old archive");
  fs.writeFileSync(database, bytes);
  for (const entry of entries) {
    const script = `const M=require('node:module'),load=M._load;M._load=function(id,...args){if(id==='node:sqlite'||id.includes('persistence/sqlite'))throw new Error('FORBIDDEN_DATABASE_LOAD');return load.call(this,id,...args);};require(${JSON.stringify(path.join(root, entry))});`;
    const loaded = spawnSync(process.execPath, ["-e", script], { cwd: directory, encoding: "utf8", timeout: 15000 });
    assert.equal(loaded.status, 0, entry + ": " + loaded.stderr);
    const result = spawnSync(process.execPath, [path.join(root, entry), database, path.join(directory, "must-not-exist")], {
      cwd: directory, encoding: "utf8", timeout: 15000, env: { ...process.env, DB_PROVIDER: "postgresql", DB_PATH: database },
    });
    assert.equal(result.status, 1, entry);
    assert.match(result.stderr, /PG_PAIRED_MAINTENANCE_REQUIRED/, entry);
    assert.deepEqual(fs.readFileSync(database), bytes);
    assert.deepEqual(fs.readdirSync(directory), ["old.db"]);
  }
});

test("engine-neutral recovery key checks require explicit snapshot metadata and existing correct keys", async t => {
  const { createAmuStorage, syncEncryptedFilesBackup } = require("../lib/amu-storage");
  const { createIntegrationSecretVault } = require("../lib/integration-secret-vault");
  const { verifyBackupRecoveryKeys, verifyBackupPriceLabelImages } = require("../lib/backup-recovery-keys");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-pg-key-metadata-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = crypto.randomBytes(32), vaultKey = crypto.randomBytes(32), protectedDirectory = path.join(directory, "backup");
  const source = path.join(directory, "source"), storage = createAmuStorage({ rootDirectory: source, activeKeyId: "synthetic", encryptionKeys: { synthetic: key },
    scanner: async () => ({ available: true, clean: true, engine: "synthetic" }) });
  await storage.saveBuffer({ buffer: Buffer.from("%PDF-1.7\nsynthetic key verification"), originalName: "test.pdf" });
  syncEncryptedFilesBackup({ sourceDirectory: source, targetDirectory: protectedDirectory });
  const vault = createIntegrationSecretVault({ activeKeyId: "synthetic", keys: { synthetic: vaultKey } });
  const keyMaterial = crypto.randomBytes(64), payload = vault.seal(keyMaterial, { namespace: "data-import", connectorId: "data-import-v1",
    field: "data-and-index-keys", purpose: "source-archive-and-recovery" }); keyMaterial.fill(0);
  const managedImportMetadata = { keys: [{ id: "data-import-v1", payload }], hasManagedSources: true };
  const environment = { GRABENPLANER_AMU_KEY_ID: "synthetic", GRABENPLANER_AMU_KEY: key.toString("base64"),
    GRABENPLANER_INTEGRATION_KEY_ID: "synthetic", GRABENPLANER_INTEGRATION_KEY: vaultKey.toString("base64") };
  const input = { managedImportMetadata, protectedDirectory, environment };
  assert.deepEqual(verifyBackupRecoveryKeys(input), { verified: true, documentKeyVerified: true, documentFiles: 1, managedImportKeysVerified: 1 });
  for (const invalid of [undefined, { keys: [], hasManagedSources: true }, { keys: [] }])
    assert.throws(() => verifyBackupRecoveryKeys({ ...input, managedImportMetadata: invalid }), { code: "BACKUP_RECOVERY_KEYS_UNVERIFIED" });
  assert.throws(() => verifyBackupRecoveryKeys({ ...input, environment: { ...environment, GRABENPLANER_AMU_KEY: crypto.randomBytes(32).toString("base64") } }), { code: "BACKUP_RECOVERY_KEYS_UNVERIFIED" });
  assert.throws(() => verifyBackupPriceLabelImages({ protectedDirectory, environment }), /BACKUP_IMAGE_METADATA_REQUIRED/);
  assert.deepEqual(verifyBackupPriceLabelImages({ imageRows: [], protectedDirectory, environment }), { verified: true, fileCount: 0 });
});
