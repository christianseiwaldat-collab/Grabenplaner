"use strict";

const crypto = require("node:crypto");

const RECOVERY_ASSURANCE_FORMAT = "grabenplaner-provider-recovery-assurance";
const RECOVERY_ASSURANCE_SCHEMA_VERSION = 2;
const RECOVERY_ASSURANCE_PHASES = Object.freeze([
  "backup",
  "offsiteUpload",
  "repositoryReadCheck",
  "isolatedRestore",
  "schemaVerification",
  "protectedDocumentsVerification",
  "applicationSmoke",
  "scratchCleanup",
]);
const PHASE_STATUS = new Set(["passed", "failed", "not-run"]);
const TERMINAL_STATUS = new Set(["passed", "failed"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-f0-9-]{16,80}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{2,31}$/;
const METHOD_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
const OPERATIONAL_PROFILES = new Set(["supported", "development-contract"]);
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

const RECEIPT_KEYS = Object.freeze([
  "format",
  "schemaVersion",
  "runId",
  "providerId",
  "profile",
  "backupMethod",
  "status",
  "issuedAt",
  "errorCode",
  "evidence",
  "phases",
  "keyId",
  "receiptHash",
  "signature",
]);
const EVIDENCE_KEYS = Object.freeze([
  "bundleHash",
  "databaseArtifactSha256",
  "protectedDocumentsManifestSha256",
  "sourceEvidenceFingerprint",
  "restoredEvidenceFingerprint",
  "restoreReceiptSha256",
  "appVersion",
]);
const PHASE_KEYS = Object.freeze(["status", "completedAt", "evidenceSha256"]);

class RecoveryAssuranceContractError extends Error {
  constructor(code = "RECOVERY_ASSURANCE_CONTRACT_INVALID") {
    super("Der providerbezogene Recovery-Assurance-Nachweis ist ungültig.");
    this.name = "RecoveryAssuranceContractError";
    this.code = code;
  }
}

function assuranceError(code) {
  return new RecoveryAssuranceContractError(code);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(value, key))) {
    throw assuranceError();
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw assuranceError();
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) throw assuranceError();
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalTimestamp(value, { nullable = false } = {}) {
  if (nullable && (value === null || value === "" || value === undefined)) return null;
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value) {
    throw assuranceError();
  }
  return value;
}

function normalizeEvidence(value) {
  exactKeys(value, EVIDENCE_KEYS);
  for (const key of EVIDENCE_KEYS.filter((key) => key !== "appVersion")) {
    if (!HASH_PATTERN.test(String(value[key] || ""))) throw assuranceError();
  }
  if (!VERSION_PATTERN.test(String(value.appVersion || ""))) throw assuranceError();
  return Object.freeze({ ...value });
}

function normalizePhases(value, issuedAt) {
  exactKeys(value, RECOVERY_ASSURANCE_PHASES);
  const issuedMs = Date.parse(issuedAt);
  const normalized = {};
  for (const phase of RECOVERY_ASSURANCE_PHASES) {
    const entry = value[phase];
    exactKeys(entry, PHASE_KEYS);
    if (!PHASE_STATUS.has(entry.status)
      || (entry.evidenceSha256 !== null && !HASH_PATTERN.test(String(entry.evidenceSha256 || "")))) {
      throw assuranceError();
    }
    const completedAt = canonicalTimestamp(entry.completedAt, { nullable: true });
    if ((entry.status === "not-run") !== (completedAt === null)
      || (entry.status === "not-run") !== (entry.evidenceSha256 === null)
      || (completedAt && Date.parse(completedAt) > issuedMs + 5 * 60 * 1000)) {
      throw assuranceError();
    }
    normalized[phase] = Object.freeze({
      status: entry.status,
      completedAt,
      evidenceSha256: entry.evidenceSha256,
    });
  }
  return Object.freeze(normalized);
}

function publicKeyId(publicKey) {
  return sha256(publicKey.export({ type: "spki", format: "der" }));
}

function unsignedReceipt(value) {
  return {
    format: value.format,
    schemaVersion: value.schemaVersion,
    runId: value.runId,
    providerId: value.providerId,
    profile: value.profile,
    backupMethod: value.backupMethod,
    status: value.status,
    issuedAt: value.issuedAt,
    errorCode: value.errorCode,
    evidence: value.evidence,
    phases: value.phases,
    keyId: value.keyId,
  };
}

function normalizeReceiptShape(value, { requireSignature = true } = {}) {
  if (requireSignature) exactKeys(value, RECEIPT_KEYS);
  else {
    const unsignedKeys = RECEIPT_KEYS.filter((key) => !["receiptHash", "signature"].includes(key));
    exactKeys(value, unsignedKeys);
  }
  if (value.format !== RECOVERY_ASSURANCE_FORMAT
    || value.schemaVersion !== RECOVERY_ASSURANCE_SCHEMA_VERSION
    || !ID_PATTERN.test(String(value.runId || ""))
    || !PROVIDER_PATTERN.test(String(value.providerId || ""))
    || !OPERATIONAL_PROFILES.has(value.profile)
    || !METHOD_PATTERN.test(String(value.backupMethod || ""))
    || !TERMINAL_STATUS.has(value.status)
    || (value.errorCode !== null && !ERROR_CODE_PATTERN.test(String(value.errorCode || "")))
    || !HASH_PATTERN.test(String(value.keyId || ""))) {
    throw assuranceError();
  }
  const issuedAt = canonicalTimestamp(value.issuedAt);
  const evidence = normalizeEvidence(value.evidence);
  const phases = normalizePhases(value.phases, issuedAt);
  const phaseStatuses = Object.values(phases).map((phase) => phase.status);
  if (value.status === "passed") {
    if (value.errorCode !== null
      || phaseStatuses.some((status) => status !== "passed")
      || evidence.sourceEvidenceFingerprint !== evidence.restoredEvidenceFingerprint) {
      throw assuranceError();
    }
  } else if (value.errorCode === null || !phaseStatuses.includes("failed")) {
    throw assuranceError();
  }
  const normalized = {
    format: RECOVERY_ASSURANCE_FORMAT,
    schemaVersion: RECOVERY_ASSURANCE_SCHEMA_VERSION,
    runId: value.runId,
    providerId: value.providerId,
    profile: value.profile,
    backupMethod: value.backupMethod,
    status: value.status,
    issuedAt,
    errorCode: value.errorCode,
    evidence,
    phases,
    keyId: value.keyId,
  };
  if (requireSignature) {
    if (!HASH_PATTERN.test(String(value.receiptHash || ""))
      || typeof value.signature !== "string"
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.signature)) {
      throw assuranceError();
    }
    normalized.receiptHash = value.receiptHash;
    normalized.signature = value.signature;
  }
  return Object.freeze(normalized);
}

function createRecoveryAssuranceReceipt({
  privateKey,
  runId,
  providerId,
  profile,
  backupMethod,
  status,
  issuedAt = new Date().toISOString(),
  errorCode = null,
  evidence,
  phases,
} = {}) {
  let normalizedPrivateKey;
  try {
    normalizedPrivateKey = privateKey instanceof crypto.KeyObject && privateKey.type === "private"
      ? privateKey
      : crypto.createPrivateKey(privateKey);
  } catch (error) {
    throw assuranceError("RECOVERY_ASSURANCE_KEY_INVALID");
  }
  if (normalizedPrivateKey.asymmetricKeyType !== "ed25519") {
    throw assuranceError("RECOVERY_ASSURANCE_KEY_INVALID");
  }
  const keyId = publicKeyId(crypto.createPublicKey(normalizedPrivateKey));
  const normalized = normalizeReceiptShape({
    format: RECOVERY_ASSURANCE_FORMAT,
    schemaVersion: RECOVERY_ASSURANCE_SCHEMA_VERSION,
    runId,
    providerId,
    profile,
    backupMethod,
    status,
    issuedAt,
    errorCode,
    evidence,
    phases,
    keyId,
  }, { requireSignature: false });
  const payload = Buffer.from(canonicalJson(normalized), "utf8");
  const receiptHash = sha256(payload);
  const signature = crypto.sign(null, payload, normalizedPrivateKey).toString("base64");
  return Object.freeze({
    ...normalized,
    receiptHash,
    signature,
  });
}

function verifyRecoveryAssuranceReceipt(value, {
  publicKey,
  expectedProviderId,
  expectedProfile,
  expectedBackupMethod,
  now = new Date(),
  maximumAgeHours = 24 * 100,
} = {}) {
  const receipt = normalizeReceiptShape(value);
  let normalizedPublicKey;
  try {
    normalizedPublicKey = publicKey instanceof crypto.KeyObject && publicKey.type === "public"
      ? publicKey
      : crypto.createPublicKey(publicKey);
  } catch {
    throw assuranceError("RECOVERY_ASSURANCE_KEY_INVALID");
  }
  if (normalizedPublicKey.asymmetricKeyType !== "ed25519"
    || publicKeyId(normalizedPublicKey) !== receipt.keyId
    || (expectedProviderId !== undefined && receipt.providerId !== expectedProviderId)
    || (expectedProfile !== undefined && receipt.profile !== expectedProfile)
    || (expectedBackupMethod !== undefined && receipt.backupMethod !== expectedBackupMethod)) {
    throw assuranceError("RECOVERY_ASSURANCE_BINDING_INVALID");
  }
  const payload = Buffer.from(canonicalJson(unsignedReceipt(receipt)), "utf8");
  if (sha256(payload) !== receipt.receiptHash
    || !crypto.verify(null, payload, normalizedPublicKey, Buffer.from(receipt.signature, "base64"))) {
    throw assuranceError("RECOVERY_ASSURANCE_SIGNATURE_INVALID");
  }
  if (!Number.isSafeInteger(maximumAgeHours)
    || maximumAgeHours < 1
    || maximumAgeHours > 24 * 400) {
    throw assuranceError();
  }
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) throw assuranceError();
  const difference = nowMs - Date.parse(receipt.issuedAt);
  const future = difference < -5 * 60 * 1000;
  const ageHours = future ? null : Math.max(0, difference / 3_600_000);
  const stale = future || ageHours > maximumAgeHours;
  const technicallyValid = receipt.status === "passed" && !stale;
  const productActivation = receipt.profile === "supported";
  return Object.freeze({
    providerId: receipt.providerId,
    profile: receipt.profile,
    backupMethod: receipt.backupMethod,
    status: receipt.status,
    verified: true,
    technicallyValid,
    productActivation,
    effective: technicallyValid && productActivation,
    issuedAt: receipt.issuedAt,
    ageHours: ageHours === null ? null : Math.round(ageHours * 100) / 100,
    stale,
    runIdPrefix: receipt.runId.slice(0, 12),
    receiptHash: receipt.receiptHash,
    errorCode: receipt.errorCode,
  });
}

module.exports = {
  RECOVERY_ASSURANCE_FORMAT,
  RECOVERY_ASSURANCE_PHASES,
  RECOVERY_ASSURANCE_SCHEMA_VERSION,
  RecoveryAssuranceContractError,
  createRecoveryAssuranceReceipt,
  verifyRecoveryAssuranceReceipt,
};
