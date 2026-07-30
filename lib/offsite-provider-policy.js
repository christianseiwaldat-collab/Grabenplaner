"use strict";

const OFFSITE_PROVIDER_POLICY_SCHEMA_VERSION = 1;
const PREFERRED_OFFSITE_PROVIDER_ID = "google_drive";
const OFFSITE_PROVIDER_IDS = Object.freeze([
  PREFERRED_OFFSITE_PROVIDER_ID,
  "hetzner_object_storage",
  "backblaze_b2",
]);
const OFFSITE_PROVIDER_ID_SET = new Set(OFFSITE_PROVIDER_IDS);
const OFFSITE_PROVIDER_CATALOG = Object.freeze([
  Object.freeze({
    id: PREFERRED_OFFSITE_PROVIDER_ID,
    label: "Google Drive",
    preferred: true,
  }),
  Object.freeze({
    id: "hetzner_object_storage",
    label: "Hetzner Object Storage",
    preferred: false,
  }),
  Object.freeze({
    id: "backblaze_b2",
    label: "Backblaze B2",
    preferred: false,
  }),
]);

const OFFSITE_PROVIDER_POLICY_REASON_CODES = Object.freeze({
  READY: "OFFSITE_PROVIDER_READY",
  INPUT_VALID: "OFFSITE_PROVIDER_POLICY_INPUT_VALID",
  INPUT_INVALID: "OFFSITE_PROVIDER_POLICY_INPUT_INVALID",
  PROVIDER_SELECTED: "OFFSITE_PROVIDER_SELECTED",
  PROVIDER_NOT_SELECTED: "OFFSITE_PROVIDER_NOT_SELECTED",
  PROVIDER_UNSUPPORTED: "OFFSITE_PROVIDER_UNSUPPORTED",
  PROVIDER_CONFIGURED: "OFFSITE_PROVIDER_CONFIGURED",
  PROVIDER_NOT_CONFIGURED: "OFFSITE_PROVIDER_NOT_CONFIGURED",
  PROVIDER_CONFIGURATION_UNVERIFIED: "OFFSITE_PROVIDER_CONFIGURATION_UNVERIFIED",
  PROVIDER_BINDING_MATCHED: "OFFSITE_PROVIDER_BINDING_MATCHED",
  PROVIDER_BINDING_MISMATCH: "OFFSITE_PROVIDER_BINDING_MISMATCH",
  PROVIDER_BINDING_UNVERIFIED: "OFFSITE_PROVIDER_BINDING_UNVERIFIED",
  PROVIDER_REACHABLE: "OFFSITE_PROVIDER_REACHABLE",
  PROVIDER_UNREACHABLE: "OFFSITE_PROVIDER_UNREACHABLE",
  PROVIDER_REACHABILITY_UNVERIFIED: "OFFSITE_PROVIDER_REACHABILITY_UNVERIFIED",
  BACKUP_CURRENT: "OFFSITE_BACKUP_CURRENT",
  BACKUP_NOT_CURRENT: "OFFSITE_BACKUP_NOT_CURRENT",
  BACKUP_CURRENTNESS_UNVERIFIED: "OFFSITE_BACKUP_CURRENTNESS_UNVERIFIED",
  REPOSITORY_CHECK_PASSED: "OFFSITE_REPOSITORY_CHECK_PASSED",
  REPOSITORY_CHECK_FAILED: "OFFSITE_REPOSITORY_CHECK_FAILED",
  REPOSITORY_CHECK_UNVERIFIED: "OFFSITE_REPOSITORY_CHECK_UNVERIFIED",
  ISOLATED_RESTORE_PASSED: "OFFSITE_ISOLATED_RESTORE_PASSED",
  ISOLATED_RESTORE_FAILED: "OFFSITE_ISOLATED_RESTORE_FAILED",
  ISOLATED_RESTORE_UNVERIFIED: "OFFSITE_ISOLATED_RESTORE_UNVERIFIED",
  RECOVERY_ASSURANCE_PASSED: "OFFSITE_RECOVERY_ASSURANCE_PASSED",
  RECOVERY_ASSURANCE_FAILED: "OFFSITE_RECOVERY_ASSURANCE_FAILED",
  RECOVERY_ASSURANCE_UNVERIFIED: "OFFSITE_RECOVERY_ASSURANCE_UNVERIFIED",
});

const POLICY_INPUT_KEYS = new Set([
  "selectedProviderId",
  "configured",
  "providerBindingMatches",
  "reachable",
  "backupCurrent",
  "repositoryCheckPassed",
  "isolatedRestorePassed",
  "recoveryAssurancePassed",
]);

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function policyInputCheck(input) {
  const valid = isPlainObject(input)
    && Object.keys(input).every((key) => POLICY_INPUT_KEYS.has(key));
  return Object.freeze({
    id: "policy_input",
    state: valid ? "pass" : "fail",
    reasonCode: valid
      ? OFFSITE_PROVIDER_POLICY_REASON_CODES.INPUT_VALID
      : OFFSITE_PROVIDER_POLICY_REASON_CODES.INPUT_INVALID,
  });
}

function selectedProviderCheck(value) {
  if (value === undefined || value === null || value === "") {
    return Object.freeze({
      id: "selection",
      state: "fail",
      reasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.PROVIDER_NOT_SELECTED,
    });
  }
  if (typeof value !== "string" || !OFFSITE_PROVIDER_ID_SET.has(value)) {
    return Object.freeze({
      id: "selection",
      state: "fail",
      reasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.PROVIDER_UNSUPPORTED,
    });
  }
  return Object.freeze({
    id: "selection",
    state: "pass",
    reasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.PROVIDER_SELECTED,
  });
}

function booleanEvidenceCheck({
  id,
  value,
  passedReasonCode,
  failedReasonCode,
  unverifiedReasonCode,
}) {
  if (value === true) {
    return Object.freeze({ id, state: "pass", reasonCode: passedReasonCode });
  }
  if (value === false) {
    return Object.freeze({ id, state: "fail", reasonCode: failedReasonCode });
  }
  return Object.freeze({ id, state: "unknown", reasonCode: unverifiedReasonCode });
}

function evaluateOffsiteProviderPolicy(input = {}) {
  const normalizedInput = isPlainObject(input) ? input : {};
  const inputCheck = policyInputCheck(input);
  const selectionCheck = selectedProviderCheck(normalizedInput.selectedProviderId);
  const checks = Object.freeze([
    inputCheck,
    selectionCheck,
    booleanEvidenceCheck({
      id: "configuration",
      value: normalizedInput.configured,
      passedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.PROVIDER_CONFIGURED,
      failedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.PROVIDER_NOT_CONFIGURED,
      unverifiedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.PROVIDER_CONFIGURATION_UNVERIFIED,
    }),
    booleanEvidenceCheck({
      id: "provider_binding",
      value: normalizedInput.providerBindingMatches,
      passedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.PROVIDER_BINDING_MATCHED,
      failedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.PROVIDER_BINDING_MISMATCH,
      unverifiedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.PROVIDER_BINDING_UNVERIFIED,
    }),
    booleanEvidenceCheck({
      id: "reachability",
      value: normalizedInput.reachable,
      passedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.PROVIDER_REACHABLE,
      failedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.PROVIDER_UNREACHABLE,
      unverifiedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.PROVIDER_REACHABILITY_UNVERIFIED,
    }),
    booleanEvidenceCheck({
      id: "current_backup",
      value: normalizedInput.backupCurrent,
      passedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.BACKUP_CURRENT,
      failedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.BACKUP_NOT_CURRENT,
      unverifiedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.BACKUP_CURRENTNESS_UNVERIFIED,
    }),
    booleanEvidenceCheck({
      id: "repository_check",
      value: normalizedInput.repositoryCheckPassed,
      passedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.REPOSITORY_CHECK_PASSED,
      failedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.REPOSITORY_CHECK_FAILED,
      unverifiedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.REPOSITORY_CHECK_UNVERIFIED,
    }),
    booleanEvidenceCheck({
      id: "isolated_restore",
      value: normalizedInput.isolatedRestorePassed,
      passedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.ISOLATED_RESTORE_PASSED,
      failedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.ISOLATED_RESTORE_FAILED,
      unverifiedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.ISOLATED_RESTORE_UNVERIFIED,
    }),
    booleanEvidenceCheck({
      id: "recovery_assurance",
      value: normalizedInput.recoveryAssurancePassed,
      passedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.RECOVERY_ASSURANCE_PASSED,
      failedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.RECOVERY_ASSURANCE_FAILED,
      unverifiedReasonCode: OFFSITE_PROVIDER_POLICY_REASON_CODES.RECOVERY_ASSURANCE_UNVERIFIED,
    }),
  ]);
  const blockingChecks = checks.filter((check) => check.state !== "pass");
  const ready = blockingChecks.length === 0;
  const reasonCodes = Object.freeze(ready
    ? [OFFSITE_PROVIDER_POLICY_REASON_CODES.READY]
    : blockingChecks.map((check) => check.reasonCode));
  const selectedProviderId = selectionCheck.state === "pass"
    ? normalizedInput.selectedProviderId
    : null;

  return Object.freeze({
    schemaVersion: OFFSITE_PROVIDER_POLICY_SCHEMA_VERSION,
    state: ready ? "ok" : "blocked",
    ready,
    systemCenterOk: ready,
    blocksSystemCenterOk: !ready,
    selectionRequired: true,
    selectedProviderId,
    preferredProviderId: PREFERRED_OFFSITE_PROVIDER_ID,
    reasonCode: reasonCodes[0],
    reasonCodes,
    checks,
  });
}

function listOffsiteProviders() {
  return OFFSITE_PROVIDER_CATALOG;
}

module.exports = {
  OFFSITE_PROVIDER_CATALOG,
  OFFSITE_PROVIDER_IDS,
  OFFSITE_PROVIDER_POLICY_REASON_CODES,
  OFFSITE_PROVIDER_POLICY_SCHEMA_VERSION,
  PREFERRED_OFFSITE_PROVIDER_ID,
  evaluateOffsiteProviderPolicy,
  listOffsiteProviders,
};
