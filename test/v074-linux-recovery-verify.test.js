"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const root = path.resolve(__dirname, "..");
const amuModule = path.join(root, "lib/amu-storage.js");
const stageHelper = path.join(root, "server-tools/linux/offsite/lib/offsite-stage.js");
const backupVerifier = path.join(root, "server-tools/linux/lib/verify-backup.js");
const integrationModule = path.join(root, "lib/integration-secret-vault.js");
const databaseLockModule = path.join(root, "lib/database-lock.js");
const { createAmuStorage, syncEncryptedFilesBackup } = require(amuModule);
const { verifyRecovery } = require("../server-tools/linux/recovery/lib/recovery-verify.js");
const { applyRecovery } = require("../server-tools/linux/recovery/lib/recovery-apply.js");
const { __internalTestOnly } = require("../server-tools/linux/recovery/lib/recovery-metadata.js");
const nonRootPolicy = __internalTestOnly.nonRootOwnershipPolicy;

function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function freezeTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) freezeTree(target);
    else fs.chmodSync(target, 0o400);
  }
  fs.chmodSync(directory, 0o500);
}
function thawTree(directory) {
  if (!fs.existsSync(directory)) return;
  fs.chmodSync(directory, 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) thawTree(target);
    else fs.chmodSync(target, 0o600);
  }
}

function buildStage(temporary) {
  const stage = path.join(temporary, "stage");
  const backup = path.join(stage, "backup");
  const recovery = path.join(stage, "recovery");
  const liveAmu = path.join(temporary, "source-amu");
  const database = path.join(backup, "snapshot.db");
  const documents = path.join(backup, "snapshot.amu");
  const marker = path.join(backup, "snapshot.complete.json");
  const key = Buffer.alloc(32, 7).toString("base64");
  fs.mkdirSync(backup, { recursive: true });
  fs.mkdirSync(recovery, { recursive: true });
  createAmuStorage({ rootDirectory: liveAmu, encryptionKeys: { "server-v1": key }, activeKeyId: "server-v1" });
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, app_version TEXT NOT NULL); INSERT INTO schema_migrations VALUES ('base', '0.73.0-beta'); CREATE TABLE recovery_marker (value TEXT NOT NULL); INSERT INTO recovery_marker VALUES ('restored');");
  db.close();
  const databaseSha256 = sha256(database);
  const backupResult = syncEncryptedFilesBackup({
    sourceDirectory: liveAmu,
    targetDirectory: documents,
    manifestMetadata: { database: { fileName: path.basename(database), sha256: databaseSha256 } },
  });
  const manifestPath = path.join(documents, "manifest.json");
  const committedAt = new Date().toISOString();
  writeJson(marker, {
    format: "grabenplaner-backup-commit", schemaVersion: 1, snapshot: "snapshot", committedAt,
    database: { fileName: path.basename(database), sha256: databaseSha256, bytes: fs.statSync(database).size },
    protectedDocuments: {
      directoryName: path.basename(documents), files: backupResult.fileCount, manifestFileName: "manifest.json",
      manifestSha256: sha256(manifestPath), manifestBytes: fs.statSync(manifestPath).size,
    },
    verification: { status: "verified", verifiedAt: committedAt },
  });
  const packageFile = path.join(recovery, "package.json");
  const runtimeFile = path.join(recovery, "runtime-schema.json");
  const envExample = path.join(recovery, "grabenplaner.env.example");
  writeJson(packageFile, { version: "0.73.0-beta" });
  writeJson(runtimeFile, { format: "grabenplaner-linux-runtime-contract", schemaVersion: 1, deploymentSchemaVersion: 1 });
  fs.writeFileSync(envExample, "NODE_ENV=production\n");
  const backupResultFile = path.join(temporary, "backup-result.json");
  writeJson(backupResultFile, {
    ok: true, path: path.join(temporary, "snapshot.db"), amuBackup: path.join(temporary, "snapshot.amu"),
    commitMarker: path.join(temporary, "snapshot.complete.json"), sha256: databaseSha256, createdAt: committedAt,
  });
  const created = require("node:child_process").spawnSync(process.execPath, [stageHelper, "create", stage, backupResultFile, envExample, packageFile, runtimeFile], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  return { stage, liveAmu, database, documents, marker, key, databaseSha256 };
}

test("v0.74 performs full frozen-stage, SQLite, document, key and compatibility verification", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-recovery-verify-"));
  let stage;
  try {
    const built = buildStage(temporary);
    stage = built.stage;
    const targetPackage = path.join(temporary, "target-package.json");
    const targetRuntime = path.join(temporary, "target-runtime.json");
    const environment = path.join(temporary, "grabenplaner.env");
    const output = path.join(temporary, "verification.json");
    writeJson(targetPackage, { version: "0.74.0-beta" });
    writeJson(targetRuntime, { format: "grabenplaner-linux-runtime-contract", schemaVersion: 1, deploymentSchemaVersion: 1 });
    fs.writeFileSync(environment, [
      "GRABENPLANER_AMU_KEY_ID=server-v1", `GRABENPLANER_AMU_KEY=${built.key}`,
      "GRABENPLANER_INTEGRATION_KEY_ID=server-v1", `GRABENPLANER_INTEGRATION_KEY=${Buffer.alloc(32, 8).toString("base64")}`, "",
    ].join("\n"));
    fs.chmodSync(environment, 0o600);
    freezeTree(stage);
    const result = await verifyRecovery({
      stage, stageHelper, backupVerifier, amuModule, integrationModule, environment,
      targetPackage, targetRuntime, scratchRoot: temporary, output,
    }, nonRootPolicy);
    assert.equal(result.ok, true);
    assert.equal(result.databaseSha256, built.databaseSha256);
    assert.equal(result.sourceAppVersion, "0.73.0-beta");
    assert.equal(result.targetAppVersion, "0.74.0-beta");
    assert.equal(result.protectedDocuments, 0);
    assert.equal(result.integrationCredentials, 0);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).ok, true);
  } finally {
    if (stage) thawTree(stage);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("v0.74 apply keeps the former live database and documents under the exact recovery id", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-recovery-apply-"));
  let stage;
  let safetyRoot;
  try {
    const built = buildStage(temporary);
    stage = built.stage;
    freezeTree(stage);
    const dataRoot = path.join(temporary, "data-root");
    const liveDatabase = path.join(dataRoot, "data", "dienstplan.db");
    const liveDocuments = path.join(dataRoot, "private", "amu");
    fs.mkdirSync(path.dirname(liveDatabase), { recursive: true });
    fs.mkdirSync(path.dirname(liveDocuments), { recursive: true });
    const oldDb = new DatabaseSync(liveDatabase);
    oldDb.exec("CREATE TABLE recovery_marker (value TEXT NOT NULL); INSERT INTO recovery_marker VALUES ('former-live');");
    oldDb.close();
    fs.cpSync(built.liveAmu, liveDocuments, { recursive: true, errorOnExist: true, force: false });

    const recoveryId = "6".repeat(64);
    const snapshotId = "7".repeat(64);
    const prepared = path.join(temporary, "prepared.json");
    const verified = path.join(temporary, "verified.json");
    safetyRoot = path.join(temporary, "safety");
    fs.mkdirSync(safetyRoot, { mode: 0o700 });
    const safetyReceipt = path.join(safetyRoot, "pre-restore-safety.json");
    const output = path.join(temporary, "applied.json");
    const baseReceipt = {
      format: "grabenplaner-linux-recovery", schemaVersion: 1, recoveryId, snapshotId,
      databaseSha256: built.databaseSha256, stageManifestSha256: sha256(path.join(stage, "offsite-stage-manifest.json")),
    };
    writeJson(prepared, { ...baseReceipt, state: "prepared" });
    writeJson(verified, { ...baseReceipt, state: "verified" });
    const result = applyRecovery({
      stage, "prepared-receipt": prepared, "verified-receipt": verified, "safety-receipt": safetyReceipt,
      "safety-root": safetyRoot, "recovery-id": recoveryId, snapshot: snapshotId, "data-root": dataRoot,
      database: liveDatabase, "amu-module": amuModule, "database-lock-module": databaseLockModule, output,
    }, nonRootPolicy);
    assert.equal(result.state, "applied");
    const restored = new DatabaseSync(liveDatabase, { readOnly: true });
    assert.equal(restored.prepare("SELECT value FROM recovery_marker").get().value, "restored");
    restored.close();
    const previousDatabase = `${liveDatabase}.pre-recovery-${recoveryId}`;
    const previous = new DatabaseSync(previousDatabase, { readOnly: true });
    assert.equal(previous.prepare("SELECT value FROM recovery_marker").get().value, "former-live");
    previous.close();
    assert.ok(fs.existsSync(`${liveDocuments}.pre-recovery-${recoveryId}`));
    assert.equal(JSON.parse(fs.readFileSync(safetyReceipt, "utf8")).recoveryId, recoveryId);
  } finally {
    if (stage) thawTree(stage);
    if (safetyRoot && fs.existsSync(path.join(safetyRoot, "live"))) thawTree(path.join(safetyRoot, "live"));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("v0.74 apply restores the former live state when the durable application receipt cannot be committed", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-recovery-receipt-rollback-"));
  let stage;
  let safetyRoot;
  try {
    const built = buildStage(temporary);
    stage = built.stage;
    freezeTree(stage);
    const dataRoot = path.join(temporary, "data-root");
    const liveDatabase = path.join(dataRoot, "data", "dienstplan.db");
    const liveDocuments = path.join(dataRoot, "private", "amu");
    fs.mkdirSync(path.dirname(liveDatabase), { recursive: true });
    fs.mkdirSync(path.dirname(liveDocuments), { recursive: true });
    const oldDb = new DatabaseSync(liveDatabase);
    oldDb.exec("CREATE TABLE recovery_marker (value TEXT NOT NULL); INSERT INTO recovery_marker VALUES ('former-live');");
    oldDb.close();
    fs.cpSync(built.liveAmu, liveDocuments, { recursive: true, errorOnExist: true, force: false });

    const recoveryId = "8".repeat(64);
    const snapshotId = "9".repeat(64);
    const prepared = path.join(temporary, "prepared.json");
    const verified = path.join(temporary, "verified.json");
    safetyRoot = path.join(temporary, "safety");
    fs.mkdirSync(safetyRoot, { mode: 0o700 });
    const safetyReceipt = path.join(safetyRoot, "pre-restore-safety.json");
    const baseReceipt = {
      format: "grabenplaner-linux-recovery", schemaVersion: 1, recoveryId, snapshotId,
      databaseSha256: built.databaseSha256, stageManifestSha256: sha256(path.join(stage, "offsite-stage-manifest.json")),
    };
    writeJson(prepared, { ...baseReceipt, state: "prepared" });
    writeJson(verified, { ...baseReceipt, state: "verified" });
    const receiptBlocker = path.join(temporary, "receipt-parent-is-a-file");
    fs.writeFileSync(receiptBlocker, "blocked");

    assert.throws(() => applyRecovery({
      stage, "prepared-receipt": prepared, "verified-receipt": verified, "safety-receipt": safetyReceipt,
      "safety-root": safetyRoot, "recovery-id": recoveryId, snapshot: snapshotId, "data-root": dataRoot,
      database: liveDatabase, "amu-module": amuModule, "database-lock-module": databaseLockModule,
      output: path.join(receiptBlocker, "applied.json"),
    }, nonRootPolicy));
    const restoredFormer = new DatabaseSync(liveDatabase, { readOnly: true });
    assert.equal(restoredFormer.prepare("SELECT value FROM recovery_marker").get().value, "former-live");
    restoredFormer.close();
    assert.ok(fs.existsSync(`${liveDatabase}.failed-recovery-${recoveryId}`));
    assert.equal(fs.existsSync(`${liveDatabase}.pre-recovery-${recoveryId}`), false);
  } finally {
    if (stage) thawTree(stage);
    if (safetyRoot && fs.existsSync(path.join(safetyRoot, "live"))) thawTree(path.join(safetyRoot, "live"));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
