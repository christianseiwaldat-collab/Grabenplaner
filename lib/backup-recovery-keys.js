"use strict";

const { validateEncryptionKeyForStorage, verifyProtectedFileReferences } = require("./amu-storage");
const { existingVaultFromEnvironment } = require("./local-backup-environment");

function encryptionOptions(environment) {
  const activeKeyId = String(environment.GRABENPLANER_AMU_KEY_ID || "").trim();
  const encryptionKeys = Object.create(null);
  if (environment.GRABENPLANER_AMU_KEYS) {
    const ring = JSON.parse(environment.GRABENPLANER_AMU_KEYS);
    if (!ring || typeof ring !== "object" || Array.isArray(ring)) throw new Error("AMU_ACTIVE_KEY_UNAVAILABLE");
    for (const [id, value] of Object.entries(ring)) {
      if (typeof value !== "string") throw new Error("AMU_ACTIVE_KEY_UNAVAILABLE");
      encryptionKeys[id] = value;
    }
  }
  if (environment.GRABENPLANER_AMU_KEY) encryptionKeys[activeKeyId] = environment.GRABENPLANER_AMU_KEY;
  if (!activeKeyId || !encryptionKeys[activeKeyId]) throw new Error("AMU_ACTIVE_KEY_UNAVAILABLE");
  return { activeKeyId, encryptionKeys };
}

// Metadata must come from a qualified PostgreSQL snapshot/transaction. These
// helpers never infer an engine, inspect a database path or create a new key.
function verifyBackupPriceLabelImages({ imageRows, keyPayload, protectedDirectory, environment = process.env } = {}) {
  if (!Array.isArray(imageRows)) throw new Error("BACKUP_IMAGE_METADATA_REQUIRED");
  if (!imageRows.length) return { verified: true, fileCount: 0 };
  const requiredFiles = require("./sales-price-label-image-references").verifyPriceLabelImageRowsSync({
    rows: imageRows, keyPayload, vault: existingVaultFromEnvironment(environment),
  });
  return verifyProtectedFileReferences({ ...encryptionOptions(environment), sourceDirectory: protectedDirectory, requiredFiles });
}

function verifyBackupRecoveryKeys({ managedImportMetadata, protectedDirectory, environment = process.env } = {}) {
  try {
    if (!managedImportMetadata || !Array.isArray(managedImportMetadata.keys)
        || typeof managedImportMetadata.hasManagedSources !== "boolean") throw new Error();
    const documents = validateEncryptionKeyForStorage({ sourceDirectory: protectedDirectory, ...encryptionOptions(environment) });
    const { keys, hasManagedSources } = managedImportMetadata;
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
module.exports = { verifyBackupRecoveryKeys, verifyBackupPriceLabelImages };
