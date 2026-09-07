"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createIntegrationSecretVault } = require("./integration-secret-vault");

function configurationError(code) {
  const error = new Error("Die lokale Archivkonfiguration ist nicht vollständig oder nicht freigegeben.");
  error.code = code;
  return error;
}

function localBackupArchiveEnabled(environment = process.env) {
  const flag = environment.GRABENPLANER_LOCAL_BACKUP_ARCHIVE;
  if (flag === undefined || flag === "" || flag === "0") return false;
  if (flag === "1") return true;
  throw configurationError("LOCAL_ARCHIVE_MODE_INVALID");
}

function configuredArchivePresent(backupDirectory) {
  // Incomplete initialization must not silently reactivate legacy pruning.
  const file = path.join(path.resolve(backupDirectory), ".gp-local-archive");
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function existingVaultFromEnvironment(environment) {
  const activeKeyId = String(environment.GRABENPLANER_INTEGRATION_KEY_ID || "").trim();
  const keys = Object.create(null);
  try {
    if (environment.GRABENPLANER_INTEGRATION_KEYS) {
      const parsed = JSON.parse(environment.GRABENPLANER_INTEGRATION_KEYS);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      for (const [id, value] of Object.entries(parsed)) {
        if (typeof value !== "string") throw new Error();
        keys[id] = value;
      }
    }
    if (environment.GRABENPLANER_INTEGRATION_KEY) keys[activeKeyId] = environment.GRABENPLANER_INTEGRATION_KEY;
    if (!activeKeyId || !keys[activeKeyId]) throw new Error();
    return createIntegrationSecretVault({ activeKeyId, keys });
  } catch { throw configurationError("LOCAL_ARCHIVE_EXISTING_VAULT_REQUIRED"); }
}

// Trusted application environment supplies the executable and its independent
// digest. A backup or recovery envelope can NEVER choose a program to execute.
// This adapter does not create a vault key, repository, setting or config file.
function openLocalBackupArchiveFromEnvironment({ backupDirectory, vault, expectedStream,
  environment = process.env, requireConfigured = true, archiveFactory, cachedMetadataOnly = false } = {}) {
  if (typeof cachedMetadataOnly !== "boolean") throw configurationError("LOCAL_ARCHIVE_METADATA_MODE_INVALID");
  if (typeof backupDirectory !== "string" || !backupDirectory.trim()) {
    throw configurationError("LOCAL_ARCHIVE_DIRECTORY_REQUIRED");
  }
  if (!localBackupArchiveEnabled(environment)) {
    if (configuredArchivePresent(backupDirectory)) throw configurationError("LOCAL_ARCHIVE_DISABLED_WITH_HISTORY");
    return null;
  }
  const binary = String(environment.GRABENPLANER_LOCAL_BACKUP_RESTIC || "");
  const binarySha256 = String(environment.GRABENPLANER_LOCAL_BACKUP_RESTIC_SHA256 || "");
  if (!path.isAbsolute(binary) || /[\0\r\n]/.test(binary) || !/^[a-f0-9]{64}$/.test(binarySha256)) {
    throw configurationError("LOCAL_ARCHIVE_TRUSTED_BINARY_REQUIRED");
  }
  const selectedVault = vault || existingVaultFromEnvironment(environment);
  if (typeof selectedVault.seal !== "function" || typeof selectedVault.useSecretSync !== "function") {
    throw configurationError("LOCAL_ARCHIVE_EXISTING_VAULT_REQUIRED");
  }
  const factory = archiveFactory || require("./local-backup-archive").createLocalBackupArchive;
  const archive = factory({ backupDirectory, binary, binarySha256, vault: selectedVault, expectedStream,
    verifyBinaryOnConstruction: !cachedMetadataOnly });
  if (requireConfigured && !archive.configured()) throw configurationError("LOCAL_ARCHIVE_NOT_INITIALIZED");
  // HTTP diagnostics may read authenticated receipts, never execute or mutate.
  // All operational constructors and every subprocess still verify the pin.
  if (cachedMetadataOnly) return Object.freeze({
    configured: () => archive.configured(),
    listMetadata: () => archive.listMetadata({ verifyInventory: false }),
  });
  return archive;
}

module.exports = { localBackupArchiveEnabled, configuredArchivePresent, openLocalBackupArchiveFromEnvironment, existingVaultFromEnvironment };
