"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateEncryptionKeyForStorage } = require("./amu-storage");
const { existingVaultFromEnvironment } = require("./local-backup-environment");
const { managedImportRecoveryMetadataFromFile } = require("./persistence/sqlite/operations/maintenance");

function verifyBackupRecoveryKeys({ databasePath, protectedDirectory, environment = process.env } = {}) {
  try {
    const activeKeyId = String(environment.GRABENPLANER_AMU_KEY_ID || "").trim();
    const encryptionKeys = Object.create(null);
    if (environment.GRABENPLANER_AMU_KEYS) {
      const ring = JSON.parse(environment.GRABENPLANER_AMU_KEYS);
      if (!ring || typeof ring !== "object" || Array.isArray(ring)) throw new Error();
      for (const [id, value] of Object.entries(ring)) {
        if (typeof value !== "string") throw new Error();
        encryptionKeys[id] = value;
      }
    }
    if (environment.GRABENPLANER_AMU_KEY) encryptionKeys[activeKeyId] = environment.GRABENPLANER_AMU_KEY;
    if (!activeKeyId || !encryptionKeys[activeKeyId]) throw new Error();
    const keyCheck = fs.lstatSync(path.join(protectedDirectory, "key-check.amu"));
    if (!keyCheck.isFile() || keyCheck.isSymbolicLink() || keyCheck.nlink !== 1) throw new Error();
    // Validate the existing key-check and authenticate every encrypted blob in
    // the restored copy. No plaintext, credential or replacement key is stored.
    const documents = validateEncryptionKeyForStorage({ sourceDirectory: protectedDirectory, encryptionKeys, activeKeyId });
    const { keys, hasManagedSources } = managedImportRecoveryMetadataFromFile(databasePath);
    if (keys.length > 1 || (hasManagedSources && keys.length !== 1)) throw new Error();
    for (const row of keys) {
      if (row.id !== "data-import-v1" || typeof row.payload !== "string") throw new Error();
      const vault = existingVaultFromEnvironment(environment);
      vault.useSecretSync(row.payload, { namespace: "data-import", connectorId: "data-import-v1",
        field: "data-and-index-keys", purpose: "source-archive-and-recovery" }, bytes => {
        if (bytes.length !== 64) throw new Error();
      });
    }
    return { verified: true, documentKeyVerified: true, documentFiles: documents.fileCount,
      managedImportKeysVerified: keys.length };
  } catch {
    const error = new Error("Die bestehenden Wiederherstellungsschluessel konnten nicht bestaetigt werden.");
    error.code = "BACKUP_RECOVERY_KEYS_UNVERIFIED";
    throw error;
  }
}

module.exports = { verifyBackupRecoveryKeys };
