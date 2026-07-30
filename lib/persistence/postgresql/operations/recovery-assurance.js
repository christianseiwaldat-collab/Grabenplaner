"use strict";

const crypto = require("node:crypto");

const {
  createRecoveryAssuranceReceipt,
} = require("../../operations/recovery-assurance");
const {
  BACKUP_BUNDLE_METHODS,
} = require("../../../backup-bundle");
const {
  POSTGRESQL_OPERATIONAL_PROFILE,
} = require("./tools");

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const STORAGE_KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.amu$/;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const POSTGRESQL_ASSURANCE_ERROR_CODES = Object.freeze({
  CONFIGURATION_INVALID: "POSTGRESQL_ASSURANCE_CONFIGURATION_INVALID",
  EVIDENCE_MISMATCH: "POSTGRESQL_ASSURANCE_EVIDENCE_MISMATCH",
});
const EXTERNAL_EVIDENCE_FORMATS = Object.freeze({
  offsiteUpload: "grabenplaner-postgresql-offsite-upload-evidence",
  repositoryReadCheck: "grabenplaner-postgresql-repository-read-check-evidence",
});

class PostgresqlRecoveryAssuranceError extends Error {
  constructor(code) {
    super("Der PostgreSQL-Recovery-Nachweis konnte nicht sicher gebunden werden.");
    this.name = "PostgresqlRecoveryAssuranceError";
    this.code = code;
  }
}

function assuranceError(code) {
  return new PostgresqlRecoveryAssuranceError(code);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, code = POSTGRESQL_ASSURANCE_ERROR_CODES.CONFIGURATION_INVALID) {
  if (!isPlainObject(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(value, key))) {
    throw assuranceError(code);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw assuranceError(POSTGRESQL_ASSURANCE_ERROR_CODES.EVIDENCE_MISMATCH);
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) {
    throw assuranceError(POSTGRESQL_ASSURANCE_ERROR_CODES.EVIDENCE_MISMATCH);
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function evidenceHash(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function canonicalTimestamp(value) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value) {
    throw assuranceError(POSTGRESQL_ASSURANCE_ERROR_CODES.CONFIGURATION_INVALID);
  }
  return value;
}

function createPostgresqlExternalRecoveryEvidence(options = {}) {
  if (!isPlainObject(options)
    || !Object.hasOwn(EXTERNAL_EVIDENCE_FORMATS, options.phase)) {
    throw assuranceError(POSTGRESQL_ASSURANCE_ERROR_CODES.CONFIGURATION_INVALID);
  }
  const commonKeys = [
    "phase",
    "completedAt",
    "providerId",
    "backupMethod",
    "bundleHash",
    "databaseArtifactSha256",
    "protectedDocumentsManifestSha256",
  ];
  const keys = options.phase === "repositoryReadCheck"
    ? [
      ...commonKeys,
      "databaseReadBackSha256",
      "protectedDocumentsManifestReadBackSha256",
    ]
    : commonKeys;
  exactKeys(options, keys);
  const completedAt = canonicalTimestamp(options.completedAt);
  if (options.providerId !== "postgresql"
    || options.backupMethod !== BACKUP_BUNDLE_METHODS.postgresql
    || !HASH_PATTERN.test(String(options.bundleHash || ""))
    || !HASH_PATTERN.test(String(options.databaseArtifactSha256 || ""))
    || !HASH_PATTERN.test(String(options.protectedDocumentsManifestSha256 || ""))
    || (options.phase === "repositoryReadCheck"
      && (options.databaseReadBackSha256 !== options.databaseArtifactSha256
        || options.protectedDocumentsManifestReadBackSha256
          !== options.protectedDocumentsManifestSha256))) {
    throw assuranceError(POSTGRESQL_ASSURANCE_ERROR_CODES.EVIDENCE_MISMATCH);
  }
  const evidence = {
    format: EXTERNAL_EVIDENCE_FORMATS[options.phase],
    schemaVersion: 1,
    completedAt,
    providerId: options.providerId,
    backupMethod: options.backupMethod,
    bundleHash: options.bundleHash,
    databaseArtifactSha256: options.databaseArtifactSha256,
    protectedDocumentsManifestSha256:
      options.protectedDocumentsManifestSha256,
  };
  if (options.phase === "repositoryReadCheck") {
    evidence.databaseReadBackSha256 = options.databaseReadBackSha256;
    evidence.protectedDocumentsManifestReadBackSha256 =
      options.protectedDocumentsManifestReadBackSha256;
  }
  return Object.freeze({
    ...evidence,
    evidenceSha256: evidenceHash(evidence),
  });
}

function externalPhase(value, issuedAt, runEvidence, phase) {
  const commonKeys = [
    "format",
    "schemaVersion",
    "completedAt",
    "providerId",
    "backupMethod",
    "bundleHash",
    "databaseArtifactSha256",
    "protectedDocumentsManifestSha256",
    "evidenceSha256",
  ];
  const keys = phase === "repositoryReadCheck"
    ? [
      ...commonKeys.slice(0, -1),
      "databaseReadBackSha256",
      "protectedDocumentsManifestReadBackSha256",
      "evidenceSha256",
    ]
    : commonKeys;
  exactKeys(value, keys);
  const expected = createPostgresqlExternalRecoveryEvidence({
    phase,
    completedAt: value.completedAt,
    providerId: value.providerId,
    backupMethod: value.backupMethod,
    bundleHash: value.bundleHash,
    databaseArtifactSha256: value.databaseArtifactSha256,
    protectedDocumentsManifestSha256:
      value.protectedDocumentsManifestSha256,
    ...(phase === "repositoryReadCheck" ? {
      databaseReadBackSha256: value.databaseReadBackSha256,
      protectedDocumentsManifestReadBackSha256:
        value.protectedDocumentsManifestReadBackSha256,
    } : {}),
  });
  if (Date.parse(expected.completedAt) > Date.parse(issuedAt) + 5 * 60 * 1000
    || expected.format !== value.format
    || expected.schemaVersion !== value.schemaVersion
    || expected.evidenceSha256 !== value.evidenceSha256
    || expected.bundleHash !== runEvidence.bundleHash
    || expected.databaseArtifactSha256 !== runEvidence.databaseArtifactSha256
    || expected.protectedDocumentsManifestSha256
      !== runEvidence.protectedDocumentsManifestSha256) {
    throw assuranceError(POSTGRESQL_ASSURANCE_ERROR_CODES.EVIDENCE_MISMATCH);
  }
  return Object.freeze({
    status: "passed",
    completedAt: expected.completedAt,
    evidenceSha256: expected.evidenceSha256,
  });
}

function completedPhase(completedAt, value) {
  return Object.freeze({
    status: "passed",
    completedAt,
    evidenceSha256: evidenceHash(value),
  });
}

function normalizeRunEvidence({ backup, restore, appVersion }) {
  const bundle = backup?.bundle;
  const marker = bundle?.marker;
  const backupSource = backup?.sourceEvidence;
  const restoreSource = restore?.sourceEvidence;
  const restored = restore?.restoredEvidence;
  if (!VERSION_PATTERN.test(String(appVersion || ""))
    || backup?.productActivation !== false
    || restore?.productActivation !== false
    || bundle?.providerId !== "postgresql"
    || bundle?.method !== BACKUP_BUNDLE_METHODS.postgresql
    || bundle?.appVersion !== appVersion
    || restore?.providerId !== "postgresql"
    || restore?.backupMethod !== BACKUP_BUNDLE_METHODS.postgresql
    || !HASH_PATTERN.test(String(bundle?.bundleHash || ""))
    || restore?.bundleHash !== bundle.bundleHash
    || !HASH_PATTERN.test(String(marker?.database?.sha256 || ""))
    || restore?.databaseArtifactSha256 !== marker.database.sha256
    || !HASH_PATTERN.test(String(marker?.protectedDocuments?.manifestSha256 || ""))
    || restore?.protectedDocumentsManifestSha256
      !== marker.protectedDocuments.manifestSha256
    || !HASH_PATTERN.test(String(backupSource?.fingerprint || ""))
    || !Number.isSafeInteger(backupSource?.referenceCount)
    || backupSource.referenceCount < 0
    || restoreSource?.fingerprint !== backupSource.fingerprint
    || restoreSource?.referenceCount !== backupSource.referenceCount
    || restored?.fingerprint !== backupSource.fingerprint
    || restored?.referenceCount !== backupSource.referenceCount
    || restore?.applicationSmoke !== true
    || !HASH_PATTERN.test(String(restore?.targetBinding || ""))
    || !Array.isArray(backup?.protectedDocumentReferences)
    || backup.protectedDocumentReferences.length !== backupSource.referenceCount
    || backup.protectedDocumentReferences.some(
      (reference) => !STORAGE_KEY_PATTERN.test(String(reference || "").toLowerCase()),
    )
    || new Set(
      backup.protectedDocumentReferences.map((reference) => String(reference).toLowerCase()),
    ).size !== backup.protectedDocumentReferences.length) {
    throw assuranceError(POSTGRESQL_ASSURANCE_ERROR_CODES.EVIDENCE_MISMATCH);
  }

  const sanitizedRestoreReceipt = Object.freeze({
    providerId: restore.providerId,
    backupMethod: restore.backupMethod,
    bundleHash: restore.bundleHash,
    databaseArtifactSha256: restore.databaseArtifactSha256,
    protectedDocumentsManifestSha256: restore.protectedDocumentsManifestSha256,
    sourceEvidence: {
      fingerprint: restoreSource.fingerprint,
      referenceCount: restoreSource.referenceCount,
    },
    restoredEvidence: {
      fingerprint: restored.fingerprint,
      referenceCount: restored.referenceCount,
    },
    applicationSmoke: true,
    targetBinding: restore.targetBinding,
    productActivation: false,
  });
  return Object.freeze({
    bundleHash: bundle.bundleHash,
    databaseArtifactSha256: marker.database.sha256,
    protectedDocumentsManifestSha256:
      marker.protectedDocuments.manifestSha256,
    sourceEvidenceFingerprint: backupSource.fingerprint,
    restoredEvidenceFingerprint: restored.fingerprint,
    restoreReceiptSha256: evidenceHash(sanitizedRestoreReceipt),
    appVersion,
    referenceCount: backupSource.referenceCount,
    sanitizedRestoreReceipt,
  });
}

function createPostgresqlRecoveryAssuranceReceipt(options = {}) {
  if (!isPlainObject(options)) {
    throw assuranceError(POSTGRESQL_ASSURANCE_ERROR_CODES.CONFIGURATION_INVALID);
  }
  const allowed = [
    "privateKey",
    "runId",
    "issuedAt",
    "appVersion",
    "backup",
    "restore",
    "offsiteUpload",
    "repositoryReadCheck",
  ];
  if (Object.keys(options).some((key) => !allowed.includes(key))
    || !Object.hasOwn(options, "privateKey")
    || !Object.hasOwn(options, "runId")
    || !Object.hasOwn(options, "issuedAt")
    || !Object.hasOwn(options, "appVersion")
    || !Object.hasOwn(options, "backup")
    || !Object.hasOwn(options, "restore")) {
    throw assuranceError(POSTGRESQL_ASSURANCE_ERROR_CODES.CONFIGURATION_INVALID);
  }
  const issuedAt = canonicalTimestamp(options.issuedAt);
  const evidence = normalizeRunEvidence(options);
  const hasOffsite = options.offsiteUpload !== undefined;
  const hasRepositoryCheck = options.repositoryReadCheck !== undefined;
  if (hasOffsite !== hasRepositoryCheck) {
    throw assuranceError(POSTGRESQL_ASSURANCE_ERROR_CODES.CONFIGURATION_INVALID);
  }
  const allExternalEvidenceAvailable = hasOffsite && hasRepositoryCheck;
  const phases = {
    backup: completedPhase(issuedAt, {
      bundleHash: evidence.bundleHash,
      databaseArtifactSha256: evidence.databaseArtifactSha256,
    }),
    offsiteUpload: allExternalEvidenceAvailable
      ? externalPhase(options.offsiteUpload, issuedAt, evidence, "offsiteUpload")
      : Object.freeze({
        status: "failed",
        completedAt: issuedAt,
        evidenceSha256: evidenceHash({
          reasonCode: "POSTGRESQL_OFFSITE_UPLOAD_NOT_VERIFIED",
        }),
      }),
    repositoryReadCheck: allExternalEvidenceAvailable
      ? externalPhase(
        options.repositoryReadCheck,
        issuedAt,
        evidence,
        "repositoryReadCheck",
      )
      : Object.freeze({
        status: "not-run",
        completedAt: null,
        evidenceSha256: null,
      }),
    isolatedRestore: completedPhase(issuedAt, {
      restoreReceiptSha256: evidence.restoreReceiptSha256,
    }),
    schemaVerification: completedPhase(issuedAt, {
      sourceEvidenceFingerprint: evidence.sourceEvidenceFingerprint,
      restoredEvidenceFingerprint: evidence.restoredEvidenceFingerprint,
    }),
    protectedDocumentsVerification: completedPhase(issuedAt, {
      manifestSha256: evidence.protectedDocumentsManifestSha256,
      referenceCount: evidence.referenceCount,
    }),
    applicationSmoke: completedPhase(issuedAt, {
      applicationSmoke: true,
    }),
    scratchCleanup: completedPhase(issuedAt, {
      targetBinding: evidence.sanitizedRestoreReceipt.targetBinding,
      cleanup: "passed",
    }),
  };

  return createRecoveryAssuranceReceipt({
    privateKey: options.privateKey,
    runId: options.runId,
    providerId: "postgresql",
    profile: POSTGRESQL_OPERATIONAL_PROFILE,
    backupMethod: BACKUP_BUNDLE_METHODS.postgresql,
    status: allExternalEvidenceAvailable ? "passed" : "failed",
    issuedAt,
    errorCode: allExternalEvidenceAvailable
      ? null
      : "POSTGRESQL_OFFSITE_UPLOAD_NOT_VERIFIED",
    evidence: {
      bundleHash: evidence.bundleHash,
      databaseArtifactSha256: evidence.databaseArtifactSha256,
      protectedDocumentsManifestSha256:
        evidence.protectedDocumentsManifestSha256,
      sourceEvidenceFingerprint: evidence.sourceEvidenceFingerprint,
      restoredEvidenceFingerprint: evidence.restoredEvidenceFingerprint,
      restoreReceiptSha256: evidence.restoreReceiptSha256,
      appVersion: evidence.appVersion,
    },
    phases,
  });
}

module.exports = {
  POSTGRESQL_ASSURANCE_ERROR_CODES,
  PostgresqlRecoveryAssuranceError,
  createPostgresqlExternalRecoveryEvidence,
  createPostgresqlRecoveryAssuranceReceipt,
};
