"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateEncryptionKeyForStorage } = require("./amu-storage");
const { existingVaultFromEnvironment } = require("./local-backup-environment");
const { managedImportRecoveryMetadataFromFile, verifyPriceLabelImageFilesFromFile } = require("./persistence/sqlite/operations/maintenance");

function readExistingDesktopKey(directory, name) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('BACKUP_LOCAL_KEY_DIRECTORY');
  const root = path.resolve(directory), file = path.join(root, name), parent = fs.lstatSync(root);
  if (!parent.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error('BACKUP_LOCAL_KEY_DIRECTORY');
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 43 || before.size > 128
    || process.platform !== 'win32' && (before.mode & 0o077) !== 0) throw new Error('BACKUP_LOCAL_KEY_INVALID');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('BACKUP_LOCAL_KEY_INVALID');
    const value = fs.readFileSync(descriptor, 'utf8').trim(), bytes = Buffer.from(value, 'base64');
    try { if (bytes.length !== 32 || bytes.toString('base64') !== value) throw new Error('BACKUP_LOCAL_KEY_INVALID'); }
    finally { bytes.fill(0); }
    return value;
  } finally { fs.closeSync(descriptor); }
}

function verifyBackupPriceLabelImages({ databasePath, protectedDirectory, environment = process.env, privateKeyDirectory } = {}) {
  // Old backups without images do not acquire a new key requirement. New image
  // references require the existing vault and AMU keys before publication.
  return verifyPriceLabelImageFilesFromFile(databasePath, () => {
    if (privateKeyDirectory && String(environment.GRABENPLANER_OPERATION_MODE || '').trim().toLowerCase() !== 'server') {
      environment = { ...environment };
      if (!environment.GRABENPLANER_AMU_KEY && !environment.GRABENPLANER_AMU_KEYS) {
        environment.GRABENPLANER_AMU_KEY_ID ||= 'local-v1';
        environment.GRABENPLANER_AMU_KEY = readExistingDesktopKey(privateKeyDirectory, 'amu-local.key');
      }
      if (!environment.GRABENPLANER_INTEGRATION_KEY && !environment.GRABENPLANER_INTEGRATION_KEYS) {
        environment.GRABENPLANER_INTEGRATION_KEY_ID ||= 'local-v1';
        environment.GRABENPLANER_INTEGRATION_KEY = readExistingDesktopKey(privateKeyDirectory, 'integration-local.key');
      }
    }
    const activeKeyId = String(environment.GRABENPLANER_AMU_KEY_ID || '').trim();
    const encryptionKeys = Object.create(null);
    if (environment.GRABENPLANER_AMU_KEYS) {
      const ring = JSON.parse(environment.GRABENPLANER_AMU_KEYS);
      if (!ring || typeof ring !== 'object' || Array.isArray(ring)) throw new Error('AMU_ACTIVE_KEY_UNAVAILABLE');
      for (const [id, value] of Object.entries(ring)) {
        if (typeof value !== 'string') throw new Error('AMU_ACTIVE_KEY_UNAVAILABLE');
        encryptionKeys[id] = value;
      }
    }
    if (environment.GRABENPLANER_AMU_KEY) encryptionKeys[activeKeyId] = environment.GRABENPLANER_AMU_KEY;
    return { vault: existingVaultFromEnvironment(environment), sourceDirectory: protectedDirectory, activeKeyId, encryptionKeys };
  });
}

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

module.exports = { verifyBackupRecoveryKeys, verifyBackupPriceLabelImages };
