"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createAmuStorage, syncEncryptedFilesBackup } = require("../lib/amu-storage");
const { candidateProtectionContext } = require("../lib/personnel-lifecycle");
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
function createLegacyRecoveryFixture(root) {
  const stage = path.join(root, "stage"), backup = path.join(stage, "backup"), recovery = path.join(stage, "recovery");
  fs.mkdirSync(backup, { recursive: true }); fs.mkdirSync(recovery);
  const key = Buffer.alloc(32, 61).toString("base64"), integrationKey = Buffer.alloc(32, 62).toString("base64");
  const storage = createAmuStorage({ rootDirectory: path.join(root, "source-amu"), activeKeyId: "archive-v1", encryptionKeys: { "archive-v1": key } });
  const database = path.join(backup, "snapshot.db"), db = new DatabaseSync(database);
  try {
    db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, app_version TEXT NOT NULL); INSERT INTO schema_migrations VALUES ('base','0.73.0-beta'); CREATE TABLE recovery_marker (value TEXT NOT NULL); INSERT INTO recovery_marker VALUES ('restored-offline'); CREATE TABLE candidates (id TEXT PRIMARY KEY, protected_payload TEXT NOT NULL)");
    db.prepare("INSERT INTO candidates VALUES (?, ?)").run("synthetic-candidate", storage.protectRecord(JSON.stringify({ synthetic: true }), candidateProtectionContext({ id: "synthetic-candidate" })));
  } finally { db.close(); }
  const documents = path.join(backup, "snapshot.amu"), sync = syncEncryptedFilesBackup({ sourceDirectory: path.join(root, "source-amu"), targetDirectory: documents,
    manifestMetadata: { database: { fileName: "snapshot.db", sha256: hash(database) } } });
  const createdAt = new Date().toISOString(), marker = path.join(backup, "snapshot.complete.json"), manifestFile = path.join(documents, "manifest.json");
  json(marker, { format: "grabenplaner-backup-commit", schemaVersion: 1, snapshot: "snapshot", committedAt: createdAt,
    database: { fileName: "snapshot.db", sha256: hash(database), bytes: fs.statSync(database).size },
    protectedDocuments: { directoryName: "snapshot.amu", files: sync.fileCount, manifestFileName: "manifest.json", manifestSha256: hash(manifestFile), manifestBytes: fs.statSync(manifestFile).size },
    verification: { status: "verified", verifiedAt: createdAt } });
  json(path.join(recovery, "package.json"), { version: "0.73.0-beta" });
  json(path.join(recovery, "runtime-schema.json"), { format: "grabenplaner-linux-runtime-contract", schemaVersion: 1, deploymentSchemaVersion: 1 });
  fs.writeFileSync(path.join(recovery, "grabenplaner.env.example"), "NODE_ENV=production\n");
  const resultFile = path.join(root, "backup-result.json");
  json(resultFile, { ok: true, path: database, amuBackup: documents, commitMarker: marker, sha256: hash(database), createdAt });
  const helper = path.join(__dirname, "../server-tools/linux/offsite/lib/offsite-stage.js");
  const result = spawnSync(process.execPath, [helper, "create", stage, resultFile, path.join(recovery, "grabenplaner.env.example"), path.join(recovery, "package.json"), path.join(recovery, "runtime-schema.json")], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  const environment = path.join(root, "keys.env");
  fs.writeFileSync(environment, `GRABENPLANER_AMU_KEY_ID=archive-v1\nGRABENPLANER_AMU_KEY=${key}\nGRABENPLANER_INTEGRATION_KEY_ID=archive-v1\nGRABENPLANER_INTEGRATION_KEY=${integrationKey}\n`, { mode: 0o600 });
  return { stage, database, environment, databaseSha256: hash(database) };
}
function thaw(root) {
  if (!fs.existsSync(root)) return;
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) thaw(target); else if (!entry.isSymbolicLink()) fs.chmodSync(target, 0o600);
  }
}
module.exports = { createLegacyRecoveryFixture, thaw };
