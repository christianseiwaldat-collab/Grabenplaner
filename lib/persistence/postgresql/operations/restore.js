"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  readAndVerifyBackup,
  restoreEncryptedFilesBackup,
  verifyBackupReferences,
} = require("../../../amu-storage");
const {
  BACKUP_BUNDLE_METHODS,
  verifyBackupBundle,
} = require("../../../backup-bundle");
const {
  verifyPostgresqlToolchain,
} = require("./backup");
const {
  POSTGRESQL_OPERATIONAL_PROFILE,
  PostgresqlOperationalError,
  buildPostgresqlRestoreCommand,
  runPostgresqlTool,
} = require("./tools");

const POSTGRESQL_RESTORE_ERROR_CODES = Object.freeze({
  CONFIGURATION_INVALID: "POSTGRESQL_RESTORE_CONFIGURATION_INVALID",
  TARGET_NOT_EMPTY: "POSTGRESQL_RESTORE_TARGET_NOT_EMPTY",
  EVIDENCE_MISMATCH: "POSTGRESQL_RESTORE_EVIDENCE_MISMATCH",
  APPLICATION_SMOKE_FAILED: "POSTGRESQL_RESTORE_APPLICATION_SMOKE_FAILED",
  RESTORE_FAILED: "POSTGRESQL_RESTORE_FAILED",
  CLEANUP_FAILED: "POSTGRESQL_RESTORE_CLEANUP_FAILED",
});
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const STORAGE_KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.amu$/;

class PostgresqlRestoreError extends Error {
  constructor(code, cause) {
    super("Der isolierte PostgreSQL-Wiederherstellungsnachweis ist fehlgeschlagen.");
    this.name = "PostgresqlRestoreError";
    this.code = code;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: false,
        enumerable: false,
        value: cause,
        writable: false,
      });
    }
  }
}

function restoreError(code, cause) {
  return new PostgresqlRestoreError(code, cause);
}

function postgresqlCredentialBinding(credentials) {
  try {
    const serviceContent = fs.readFileSync(credentials.serviceFilePath);
    return crypto.createHash("sha256")
      .update(String(credentials.serviceName || ""), "utf8")
      .update(Buffer.from([0]))
      .update(serviceContent)
      .digest("hex");
  } catch (error) {
    throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.CONFIGURATION_INVALID, error);
  }
}

function safeScratchRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.CONFIGURATION_INVALID);
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.CONFIGURATION_INVALID);
  }
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory()
      || stat.isSymbolicLink()
      || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
      throw new Error("unsafe");
    }
  } catch (error) {
    throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.CONFIGURATION_INVALID, error);
  }
  return resolved;
}

function safeScratchDirectory(value, scratchRoot) {
  if (typeof value !== "string" || !path.isAbsolute(value) || fs.existsSync(value)) {
    throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.CONFIGURATION_INVALID);
  }
  const resolved = path.resolve(value);
  if (!resolved.startsWith(`${scratchRoot}${path.sep}`)) {
    throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.CONFIGURATION_INVALID);
  }
  return resolved;
}

function normalizeEvidence(value, {
  includeReferences,
  expectedTargetBinding,
} = {}) {
  const allowed = includeReferences
    ? ["fingerprint", "referenceCount", "protectedDocumentReferences", "targetBinding"]
    : ["fingerprint", "referenceCount"];
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== allowed.length
    || Object.keys(value).some((key) => !allowed.includes(key))
    || !HASH_PATTERN.test(String(value.fingerprint || ""))
    || !Number.isSafeInteger(value.referenceCount)
    || value.referenceCount < 0
    || (includeReferences
      && (!HASH_PATTERN.test(String(value.targetBinding || ""))
        || value.targetBinding !== expectedTargetBinding))) {
    throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.EVIDENCE_MISMATCH);
  }
  if (!includeReferences) {
    return Object.freeze({
      fingerprint: value.fingerprint,
      referenceCount: value.referenceCount,
    });
  }
  if (!Array.isArray(value.protectedDocumentReferences)
    || value.protectedDocumentReferences.length !== value.referenceCount) {
    throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.EVIDENCE_MISMATCH);
  }
  const references = value.protectedDocumentReferences
    .map((entry) => String(entry || "").toLowerCase())
    .sort();
  if (references.some((entry) => !STORAGE_KEY_PATTERN.test(entry))
    || new Set(references).size !== references.length) {
    throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.EVIDENCE_MISMATCH);
  }
  return Object.freeze({
    fingerprint: value.fingerprint,
    referenceCount: value.referenceCount,
    protectedDocumentReferences: Object.freeze(references),
    targetBinding: value.targetBinding,
  });
}

function sourceEvidenceFromBundle(bundle) {
  if (bundle?.providerId !== "postgresql"
    || bundle?.method !== BACKUP_BUNDLE_METHODS.postgresql) {
    throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.EVIDENCE_MISMATCH);
  }
  return normalizeEvidence({
    fingerprint: bundle.sourceEvidence?.fingerprint,
    referenceCount: bundle.sourceEvidence?.referenceCount,
  }, { includeReferences: false });
}

function verifyRestoredProtectedDocuments({
  backupDirectory,
  restoredDirectory,
  requiredStorageKeys,
}) {
  const backup = readAndVerifyBackup(backupDirectory, { includeContent: false });
  verifyBackupReferences({ backupDirectory, requiredStorageKeys });
  const expectedFiles = new Set(["key-check.amu"]);
  const verifyFile = (target, expectedBytes, expectedHash) => {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.size !== expectedBytes
      || require("../../../file-integrity").sha256File(target) !== expectedHash) {
      throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.EVIDENCE_MISMATCH);
    }
  };
  verifyFile(path.join(restoredDirectory, "key-check.amu"), backup.keyCheckContent.length,
    crypto.createHash("sha256").update(backup.keyCheckContent).digest("hex"));
  for (const file of backup.verified) {
    const relative = `blobs/${file.storageKey}`;
    expectedFiles.add(relative);
    verifyFile(
      path.join(restoredDirectory, ...relative.split("/")),
      file.byteSize, String(file.sha256).toLowerCase(),
    );
  }
  const actualFiles = [];
  const stack = [restoredDirectory];
  while (stack.length) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current)) {
      const candidate = path.join(current, name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.EVIDENCE_MISMATCH);
      }
      if (stat.isDirectory()) stack.push(candidate);
      else if (stat.isFile() && stat.nlink === 1) {
        actualFiles.push(path.relative(restoredDirectory, candidate).split(path.sep).join("/"));
      } else {
        throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.EVIDENCE_MISMATCH);
      }
    }
  }
  if (actualFiles.length !== expectedFiles.size
    || actualFiles.some((file) => !expectedFiles.has(file))) {
    throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.EVIDENCE_MISMATCH);
  }
}

function normalizeOptions(options) {
  if (!options
    || typeof options !== "object"
    || Array.isArray(options)
    || options.policy?.profile !== POSTGRESQL_OPERATIONAL_PROFILE
    || options.policy?.productActivation !== false
    || !options.credentials?.serviceName
    || typeof options.prepareEmptyTarget !== "function"
    || typeof options.readRestoredEvidence !== "function"
    || typeof options.verifyApplicationSmoke !== "function"
    || typeof options.cleanupScratchTarget !== "function"
    || (options.runTool !== undefined && typeof options.runTool !== "function")
    || (options.restoreProtectedDocuments !== undefined
      && typeof options.restoreProtectedDocuments !== "function")) {
    throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.CONFIGURATION_INVALID);
  }
  const scratchRootDirectory = safeScratchRoot(options.scratchRootDirectory);
  return {
    ...options,
    scratchRootDirectory,
    scratchProtectedDocumentsDirectory: safeScratchDirectory(
      options.scratchProtectedDocumentsDirectory,
      scratchRootDirectory,
    ),
    runTool: options.runTool || runPostgresqlTool,
    restoreProtectedDocuments:
      options.restoreProtectedDocuments || restoreEncryptedFilesBackup,
  };
}

async function verifyPostgresqlBackupRestore(options = {}) {
  const normalized = normalizeOptions(options);
  const targetBinding = postgresqlCredentialBinding(normalized.credentials);
  let bundle = null;
  let sourceEvidence = null;
  let primaryError = null;
  let result = null;
  let targetCleanupRequired = false;
  try {
    bundle = verifyBackupBundle(
      normalized.backupDirectory,
      normalized.markerNameOrPath,
      {
        expectedProviderId: "postgresql",
        expectedMethod: BACKUP_BUNDLE_METHODS.postgresql,
      },
    );
    sourceEvidence = sourceEvidenceFromBundle(bundle);
    await verifyPostgresqlToolchain(normalized);
    // From the first preparation attempt onward cleanup is mandatory. A
    // preparer may have created the isolated database before it throws or
    // returns an invalid acknowledgement.
    targetCleanupRequired = true;
    const targetState = await normalized.prepareEmptyTarget({ targetBinding });
    if (!targetState
      || typeof targetState !== "object"
      || Array.isArray(targetState)
      || Object.keys(targetState).length !== 4
      || targetState.created !== true
      || targetState.empty !== true
      || targetState.isolated !== true
      || targetState.targetBinding !== targetBinding) {
      throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.TARGET_NOT_EMPTY);
    }
    if (postgresqlCredentialBinding(normalized.credentials) !== targetBinding) {
      throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.EVIDENCE_MISMATCH);
    }
    await normalized.runTool(buildPostgresqlRestoreCommand({
      policy: normalized.policy,
      credentials: normalized.credentials,
      dumpPath: bundle.databasePath,
    }));
    if (postgresqlCredentialBinding(normalized.credentials) !== targetBinding) {
      throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.EVIDENCE_MISMATCH);
    }
    normalized.restoreProtectedDocuments({
      backupDirectory: bundle.protectedDirectory,
      targetDirectory: normalized.scratchProtectedDocumentsDirectory,
    });
    const restoredEvidence = normalizeEvidence(
      await normalized.readRestoredEvidence({ targetBinding }),
      { includeReferences: true, expectedTargetBinding: targetBinding },
    );
    if (restoredEvidence.fingerprint !== sourceEvidence.fingerprint
      || restoredEvidence.referenceCount !== sourceEvidence.referenceCount) {
      throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.EVIDENCE_MISMATCH);
    }
    verifyRestoredProtectedDocuments({
      backupDirectory: bundle.protectedDirectory,
      restoredDirectory: normalized.scratchProtectedDocumentsDirectory,
      requiredStorageKeys: restoredEvidence.protectedDocumentReferences,
    });
    const smoke = await normalized.verifyApplicationSmoke({
      protectedDocumentsDirectory: normalized.scratchProtectedDocumentsDirectory,
      sourceEvidence,
      restoredEvidence,
      targetBinding,
    });
    if (!smoke
      || typeof smoke !== "object"
      || Array.isArray(smoke)
      || Object.keys(smoke).length !== 2
      || smoke.passed !== true
      || smoke.targetBinding !== targetBinding) {
      throw restoreError(POSTGRESQL_RESTORE_ERROR_CODES.APPLICATION_SMOKE_FAILED);
    }
    result = Object.freeze({
      providerId: "postgresql",
      backupMethod: BACKUP_BUNDLE_METHODS.postgresql,
      bundleHash: bundle.bundleHash,
      databaseArtifactSha256: bundle.marker.database.sha256,
      protectedDocumentsManifestSha256:
        bundle.marker.protectedDocuments.manifestSha256,
      sourceEvidence,
      restoredEvidence: Object.freeze({
        fingerprint: restoredEvidence.fingerprint,
        referenceCount: restoredEvidence.referenceCount,
      }),
      applicationSmoke: true,
      targetBinding,
      productActivation: false,
    });
  } catch (error) {
    primaryError = error instanceof PostgresqlRestoreError
      || error instanceof PostgresqlOperationalError
      ? error
      : restoreError(POSTGRESQL_RESTORE_ERROR_CODES.RESTORE_FAILED, error);
  }

  let cleanupError = null;
  if (targetCleanupRequired) {
    try {
      await normalized.cleanupScratchTarget({ targetBinding });
    } catch (error) {
      cleanupError = restoreError(POSTGRESQL_RESTORE_ERROR_CODES.CLEANUP_FAILED, error);
    }
  }
  try {
    fs.rmSync(normalized.scratchProtectedDocumentsDirectory, {
      recursive: true,
      force: true,
    });
  } catch (error) {
    cleanupError ||= restoreError(
      POSTGRESQL_RESTORE_ERROR_CODES.CLEANUP_FAILED,
      error,
    );
  }
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  return result;
}

module.exports = {
  POSTGRESQL_RESTORE_ERROR_CODES,
  PostgresqlRestoreError,
  postgresqlCredentialBinding,
  sourceEvidenceFromBundle,
  verifyPostgresqlBackupRestore,
};
