"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  syncEncryptedFilesBackup,
  verifyBackupReferences,
} = require("../../../amu-storage");
const {
  BACKUP_BUNDLE_DATABASE_FORMATS,
  BACKUP_BUNDLE_FORMAT,
  BACKUP_BUNDLE_METHODS,
  BACKUP_BUNDLE_SCHEMA_VERSION,
  BACKUP_BUNDLE_VERIFICATION_CHECK_KEYS,
  verifyBackupBundle,
  writeBackupBundleCommitMarker,
} = require("../../../backup-bundle");
const { withPostgresqlExportedSnapshot } = require("./snapshot");
const {
  POSTGRESQL_OPERATIONAL_PROFILE,
  buildPostgresqlDumpCommand,
  buildPostgresqlRestoreListCommand,
  buildPostgresqlVersionCommand,
  parsePostgresqlToolMajor,
  runPostgresqlTool,
} = require("./tools");

const POSTGRESQL_BACKUP_ERROR_CODES = Object.freeze({
  CONFIGURATION_INVALID: "POSTGRESQL_BACKUP_CONFIGURATION_INVALID",
  QUIESCE_INVALID: "POSTGRESQL_BACKUP_QUIESCE_INVALID",
  COMPONENT_INVALID: "POSTGRESQL_BACKUP_COMPONENT_INVALID",
  CLEANUP_FAILED: "POSTGRESQL_BACKUP_CLEANUP_FAILED",
});
const APP_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

class PostgresqlBackupError extends Error {
  constructor(code, cause) {
    super("Der PostgreSQL-Sicherungspunkt konnte nicht sicher erstellt werden.");
    this.name = "PostgresqlBackupError";
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

function backupError(code, cause) {
  return new PostgresqlBackupError(code, cause);
}

function canonicalTimestamp(value) {
  const text = value instanceof Date ? value.toISOString() : "";
  if (!text || !Number.isFinite(Date.parse(text))) {
    throw backupError(POSTGRESQL_BACKUP_ERROR_CODES.CONFIGURATION_INVALID);
  }
  return text;
}

function assertRegularDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw backupError(POSTGRESQL_BACKUP_ERROR_CODES.CONFIGURATION_INVALID);
  }
  const resolved = path.resolve(directory);
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory()
      || stat.isSymbolicLink()
      || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
      throw new Error("unsafe");
    }
  } catch (error) {
    throw backupError(POSTGRESQL_BACKUP_ERROR_CODES.CONFIGURATION_INVALID, error);
  }
  return resolved;
}

function sha256File(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || stat.size <= 0
    || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw backupError(POSTGRESQL_BACKUP_ERROR_CODES.COMPONENT_INVALID);
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    while (position < stat.size) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, stat.size - position),
        position,
      );
      if (bytesRead <= 0) {
        throw backupError(POSTGRESQL_BACKUP_ERROR_CODES.COMPONENT_INVALID);
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fs.fstatSync(descriptor);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) {
      throw backupError(POSTGRESQL_BACKUP_ERROR_CODES.COMPONENT_INVALID);
    }
    return {
      bytes: stat.size,
      sha256: hash.digest("hex"),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function treeBytes(directory) {
  let bytes = 0;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current)) {
      const candidate = path.join(current, name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw backupError(POSTGRESQL_BACKUP_ERROR_CODES.COMPONENT_INVALID);
      }
      if (stat.isDirectory()) stack.push(candidate);
      else if (stat.isFile() && stat.nlink === 1) bytes += stat.size;
      else throw backupError(POSTGRESQL_BACKUP_ERROR_CODES.COMPONENT_INVALID);
      if (!Number.isSafeInteger(bytes)) {
        throw backupError(POSTGRESQL_BACKUP_ERROR_CODES.COMPONENT_INVALID);
      }
    }
  }
  return bytes;
}

function assertQuiesceEvidence(value) {
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== 2
    || value.active !== true
    || value.pendingMutations !== 0) {
    throw backupError(POSTGRESQL_BACKUP_ERROR_CODES.QUIESCE_INVALID);
  }
}

async function verifyPostgresqlToolchain({ policy, runTool }) {
  const dumpVersion = await runTool(buildPostgresqlVersionCommand({
    executable: policy.pgDumpPath,
    operation: "backup-tool-version",
  }));
  const restoreVersion = await runTool(buildPostgresqlVersionCommand({
    executable: policy.pgRestorePath,
    operation: "restore-tool-version",
  }));
  parsePostgresqlToolMajor(dumpVersion.stdout, policy.expectedToolMajor);
  parsePostgresqlToolMajor(restoreVersion.stdout, policy.expectedToolMajor);
  return policy.expectedToolMajor;
}

function snapshotName(createdAt) {
  return `dienstplan-${createdAt.replace(/[-:.]/g, "").replace("Z", "Z")}-${crypto.randomBytes(6).toString("hex")}`;
}

function normalizeOptions(options) {
  if (!options
    || typeof options !== "object"
    || Array.isArray(options)
    || options.policy?.profile !== POSTGRESQL_OPERATIONAL_PROFILE
    || options.policy?.productActivation !== false
    || !options.credentials?.serviceName
    || !options.pool
    || typeof options.readSourceEvidence !== "function"
    || typeof options.readProtectedDocumentReferences !== "function"
    || typeof options.withQuiescedProtectedDocuments !== "function"
    || (options.now !== undefined && typeof options.now !== "function")
    || (options.runTool !== undefined && typeof options.runTool !== "function")
    || (options.syncProtectedDocuments !== undefined
      && typeof options.syncProtectedDocuments !== "function")
    || !APP_VERSION_PATTERN.test(String(options.appVersion || ""))) {
    throw backupError(POSTGRESQL_BACKUP_ERROR_CODES.CONFIGURATION_INVALID);
  }
  return {
    ...options,
    backupDirectory: assertRegularDirectory(options.backupDirectory),
    protectedDocumentsDirectory: assertRegularDirectory(options.protectedDocumentsDirectory),
    now: options.now || (() => new Date()),
    runTool: options.runTool || runPostgresqlTool,
    syncProtectedDocuments: options.syncProtectedDocuments || syncEncryptedFilesBackup,
  };
}

async function createPostgresqlBackupSnapshot(options = {}) {
  const normalized = normalizeOptions(options);
  await verifyPostgresqlToolchain(normalized);
  const createdAt = canonicalTimestamp(normalized.now());
  const snapshotId = snapshotName(createdAt);
  const databaseFileName = `${snapshotId}.pgdump`;
  const protectedDirectoryName = `${snapshotId}.documents`;
  const databasePath = path.join(normalized.backupDirectory, databaseFileName);
  const protectedDirectory = path.join(
    normalized.backupDirectory,
    protectedDirectoryName,
  );
  const nonce = crypto.randomUUID();
  const temporaryDatabasePath = `${databasePath}.partial-${nonce}`;
  const temporaryProtectedDirectory = `${protectedDirectory}.partial-${nonce}`;
  let markerPath = null;
  let databasePublished = false;
  let documentsPublished = false;
  if ([databasePath, protectedDirectory, temporaryDatabasePath, temporaryProtectedDirectory]
    .some((candidate) => fs.existsSync(candidate))) {
    throw backupError(POSTGRESQL_BACKUP_ERROR_CODES.CONFIGURATION_INVALID);
  }
  try {
    return await normalized.withQuiescedProtectedDocuments(async (quiesceEvidence) => {
      assertQuiesceEvidence(quiesceEvidence);
      const prepared = await withPostgresqlExportedSnapshot({
        pool: normalized.pool,
        readSourceEvidence: normalized.readSourceEvidence,
        readProtectedDocumentReferences: normalized.readProtectedDocumentReferences,
        async work({
          snapshotId: exportedSnapshot,
          sourceEvidence,
          protectedDocumentReferences,
        }) {
          await normalized.runTool(buildPostgresqlDumpCommand({
            policy: normalized.policy,
            credentials: normalized.credentials,
            targetPath: temporaryDatabasePath,
            exportedSnapshot,
          }));
          try { fs.chmodSync(temporaryDatabasePath, 0o600); } catch {}
          const database = sha256File(temporaryDatabasePath);
          const listing = await normalized.runTool(buildPostgresqlRestoreListCommand({
            policy: normalized.policy,
            dumpPath: temporaryDatabasePath,
          }));
          if (!String(listing.stdout || "").trim()) {
            throw backupError(POSTGRESQL_BACKUP_ERROR_CODES.COMPONENT_INVALID);
          }
          const documentBackup = normalized.syncProtectedDocuments({
            sourceDirectory: normalized.protectedDocumentsDirectory,
            targetDirectory: temporaryProtectedDirectory,
            manifestMetadata: {
              createdAt,
              database: {
                fileName: databaseFileName,
                sha256: database.sha256,
              },
              snapshot: {
                providerId: "postgresql",
                method: BACKUP_BUNDLE_METHODS.postgresql,
                snapshotId,
                sourceEvidenceFingerprint: sourceEvidence.fingerprint,
                referenceCount: sourceEvidence.referenceCount,
              },
            },
          });
          const verifiedDocuments = verifyBackupReferences({
            backupDirectory: temporaryProtectedDirectory,
            requiredStorageKeys: protectedDocumentReferences,
          });
          if (verifiedDocuments.manifest?.database?.fileName !== databaseFileName
            || String(verifiedDocuments.manifest?.database?.sha256 || "").toLowerCase()
              !== database.sha256
            || verifiedDocuments.manifest?.snapshot?.providerId !== "postgresql"
            || verifiedDocuments.manifest?.snapshot?.method
              !== BACKUP_BUNDLE_METHODS.postgresql
            || verifiedDocuments.manifest?.snapshot?.snapshotId !== snapshotId
            || verifiedDocuments.manifest?.snapshot?.sourceEvidenceFingerprint
              !== sourceEvidence.fingerprint
            || verifiedDocuments.manifest?.snapshot?.referenceCount
              !== sourceEvidence.referenceCount) {
            throw backupError(POSTGRESQL_BACKUP_ERROR_CODES.COMPONENT_INVALID);
          }
          const manifestPath = path.join(temporaryProtectedDirectory, "manifest.json");
          const manifest = sha256File(manifestPath);
          return Object.freeze({
            database,
            documentBackup,
            manifest,
            protectedDocumentsBytes: treeBytes(temporaryProtectedDirectory),
            sourceEvidence,
            protectedDocumentReferences,
          });
        },
      });

      // A bundle becomes externally visible only after the PostgreSQL snapshot
      // transaction has committed successfully. The document mutation gate is
      // still held while both components and finally the commit marker publish.
      fs.renameSync(temporaryProtectedDirectory, protectedDirectory);
      documentsPublished = true;
      fs.renameSync(temporaryDatabasePath, databasePath);
      databasePublished = true;
      const verifiedAt = canonicalTimestamp(normalized.now());
      markerPath = writeBackupBundleCommitMarker({
        backupDirectory: normalized.backupDirectory,
        format: BACKUP_BUNDLE_FORMAT,
        schemaVersion: BACKUP_BUNDLE_SCHEMA_VERSION,
        providerId: "postgresql",
        method: BACKUP_BUNDLE_METHODS.postgresql,
        snapshotId,
        createdAt,
        appVersion: normalized.appVersion,
        database: {
          fileName: databaseFileName,
          sha256: prepared.database.sha256,
          bytes: prepared.database.bytes,
          format: BACKUP_BUNDLE_DATABASE_FORMATS.postgresql,
          toolMajor: normalized.policy.expectedToolMajor,
        },
        protectedDocuments: {
          directoryName: protectedDirectoryName,
          manifestFileName: "manifest.json",
          manifestSha256: prepared.manifest.sha256,
          manifestBytes: prepared.manifest.bytes,
          files: prepared.documentBackup.fileCount,
          bytes: prepared.protectedDocumentsBytes,
        },
        verification: {
          status: "verified",
          verifiedAt,
          checks: Object.fromEntries(
            BACKUP_BUNDLE_VERIFICATION_CHECK_KEYS.map((key) => [key, true]),
          ),
        },
      });
      const bundle = verifyBackupBundle(
        normalized.backupDirectory,
        markerPath,
        {
          expectedProviderId: "postgresql",
          expectedMethod: BACKUP_BUNDLE_METHODS.postgresql,
        },
      );
      return Object.freeze({
        bundle,
        sourceEvidence: prepared.sourceEvidence,
        protectedDocumentReferences: prepared.protectedDocumentReferences,
        productActivation: false,
      });
    });
  } catch (error) {
    let cleanupFailure = null;
    for (const file of [
      markerPath,
      temporaryDatabasePath,
      ...(databasePublished ? [databasePath] : []),
    ]) {
      if (!file) continue;
      try { fs.rmSync(file, { force: true }); } catch (caught) {
        cleanupFailure ||= caught;
      }
    }
    for (const directory of [
      temporaryProtectedDirectory,
      ...(documentsPublished ? [protectedDirectory] : []),
    ]) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch (caught) {
        cleanupFailure ||= caught;
      }
    }
    if (cleanupFailure) {
      throw backupError(
        POSTGRESQL_BACKUP_ERROR_CODES.CLEANUP_FAILED,
        cleanupFailure,
      );
    }
    throw error;
  }
}

module.exports = {
  POSTGRESQL_BACKUP_ERROR_CODES,
  PostgresqlBackupError,
  createPostgresqlBackupSnapshot,
  verifyPostgresqlToolchain,
};
