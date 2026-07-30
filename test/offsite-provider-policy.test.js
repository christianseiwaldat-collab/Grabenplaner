"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  OFFSITE_PROVIDER_CATALOG,
  OFFSITE_PROVIDER_IDS,
  OFFSITE_PROVIDER_POLICY_REASON_CODES,
  OFFSITE_PROVIDER_POLICY_SCHEMA_VERSION,
  PREFERRED_OFFSITE_PROVIDER_ID,
  evaluateOffsiteProviderPolicy,
  listOffsiteProviders,
} = require("../lib/offsite-provider-policy");

function readyEvidence(overrides = {}) {
  return {
    selectedProviderId: "google_drive",
    configured: true,
    providerBindingMatches: true,
    reachable: true,
    backupCurrent: true,
    repositoryCheckPassed: true,
    isolatedRestorePassed: true,
    recoveryAssurancePassed: true,
    ...overrides,
  };
}

test("offsite provider catalog is fixed, ordered and marks Google Drive as preferred", () => {
  assert.equal(OFFSITE_PROVIDER_POLICY_SCHEMA_VERSION, 1);
  assert.equal(PREFERRED_OFFSITE_PROVIDER_ID, "google_drive");
  assert.deepEqual(OFFSITE_PROVIDER_IDS, [
    "google_drive",
    "hetzner_object_storage",
    "backblaze_b2",
  ]);
  assert.deepEqual(listOffsiteProviders(), [
    { id: "google_drive", label: "Google Drive", preferred: true },
    { id: "hetzner_object_storage", label: "Hetzner Object Storage", preferred: false },
    { id: "backblaze_b2", label: "Backblaze B2", preferred: false },
  ]);
  assert.equal(listOffsiteProviders(), OFFSITE_PROVIDER_CATALOG);
  assert.equal(Object.isFrozen(OFFSITE_PROVIDER_IDS), true);
  assert.equal(Object.isFrozen(OFFSITE_PROVIDER_CATALOG), true);
  assert.equal(Object.isFrozen(OFFSITE_PROVIDER_CATALOG[0]), true);
});

test("no provider selection blocks the System Center fail-closed", () => {
  const assessment = evaluateOffsiteProviderPolicy({});
  assert.equal(assessment.state, "blocked");
  assert.equal(assessment.ready, false);
  assert.equal(assessment.systemCenterOk, false);
  assert.equal(assessment.blocksSystemCenterOk, true);
  assert.equal(assessment.selectionRequired, true);
  assert.equal(assessment.selectedProviderId, null);
  assert.equal(assessment.reasonCode, OFFSITE_PROVIDER_POLICY_REASON_CODES.PROVIDER_NOT_SELECTED);
  assert.equal(
    assessment.checks.find(({ id }) => id === "selection").state,
    "fail",
  );
});

test("a supported provider selection alone is never sufficient", () => {
  const assessment = evaluateOffsiteProviderPolicy({
    selectedProviderId: "google_drive",
  });
  assert.equal(assessment.selectedProviderId, "google_drive");
  assert.equal(assessment.ready, false);
  assert.equal(assessment.systemCenterOk, false);
  assert.deepEqual(assessment.reasonCodes, [
    "OFFSITE_PROVIDER_CONFIGURATION_UNVERIFIED",
    "OFFSITE_PROVIDER_BINDING_UNVERIFIED",
    "OFFSITE_PROVIDER_REACHABILITY_UNVERIFIED",
    "OFFSITE_BACKUP_CURRENTNESS_UNVERIFIED",
    "OFFSITE_REPOSITORY_CHECK_UNVERIFIED",
    "OFFSITE_ISOLATED_RESTORE_UNVERIFIED",
    "OFFSITE_RECOVERY_ASSURANCE_UNVERIFIED",
  ]);
});

test("all required evidence must pass before the System Center may report OK", () => {
  for (const selectedProviderId of OFFSITE_PROVIDER_IDS) {
    const assessment = evaluateOffsiteProviderPolicy(readyEvidence({ selectedProviderId }));
    assert.equal(assessment.schemaVersion, 1);
    assert.equal(assessment.state, "ok");
    assert.equal(assessment.ready, true);
    assert.equal(assessment.systemCenterOk, true);
    assert.equal(assessment.blocksSystemCenterOk, false);
    assert.equal(assessment.selectedProviderId, selectedProviderId);
    assert.equal(assessment.reasonCode, "OFFSITE_PROVIDER_READY");
    assert.deepEqual(assessment.reasonCodes, ["OFFSITE_PROVIDER_READY"]);
    assert.equal(assessment.checks.every(({ state }) => state === "pass"), true);
    assert.equal(Object.isFrozen(assessment), true);
    assert.equal(Object.isFrozen(assessment.reasonCodes), true);
    assert.equal(Object.isFrozen(assessment.checks), true);
  }
});

test("each negative operational gate independently blocks readiness with a stable reason code", () => {
  const scenarios = [
    ["configured", "OFFSITE_PROVIDER_NOT_CONFIGURED"],
    ["providerBindingMatches", "OFFSITE_PROVIDER_BINDING_MISMATCH"],
    ["reachable", "OFFSITE_PROVIDER_UNREACHABLE"],
    ["backupCurrent", "OFFSITE_BACKUP_NOT_CURRENT"],
    ["repositoryCheckPassed", "OFFSITE_REPOSITORY_CHECK_FAILED"],
    ["isolatedRestorePassed", "OFFSITE_ISOLATED_RESTORE_FAILED"],
    ["recoveryAssurancePassed", "OFFSITE_RECOVERY_ASSURANCE_FAILED"],
  ];
  for (const [field, expectedReasonCode] of scenarios) {
    const assessment = evaluateOffsiteProviderPolicy(readyEvidence({ [field]: false }));
    assert.equal(assessment.ready, false, field);
    assert.equal(assessment.systemCenterOk, false, field);
    assert.deepEqual(assessment.reasonCodes, [expectedReasonCode], field);
  }
});

test("unsupported or free-form provider values are rejected without echoing them", () => {
  const secretProviderValue = "sftp://user:very-secret@example.invalid/private/path";
  const unsupported = evaluateOffsiteProviderPolicy(
    readyEvidence({ selectedProviderId: secretProviderValue }),
  );
  assert.equal(unsupported.selectedProviderId, null);
  assert.equal(unsupported.ready, false);
  assert.equal(unsupported.reasonCode, "OFFSITE_PROVIDER_UNSUPPORTED");
  assert.doesNotMatch(JSON.stringify(unsupported), /very-secret|example\.invalid|private\/path/);

  const almostValid = evaluateOffsiteProviderPolicy(
    readyEvidence({ selectedProviderId: " google_drive " }),
  );
  assert.equal(almostValid.selectedProviderId, null);
  assert.equal(almostValid.reasonCode, "OFFSITE_PROVIDER_UNSUPPORTED");
});

test("free paths, credentials and all other unknown input fields fail closed without disclosure", () => {
  const value = readyEvidence();
  value.providerPath = "/private/offsite/customer";
  value.credentials = {
    accessKey: "never-return-access-key",
    secretKey: "never-return-secret-key",
  };
  const assessment = evaluateOffsiteProviderPolicy(value);
  const serialized = JSON.stringify(assessment);
  assert.equal(assessment.ready, false);
  assert.equal(assessment.systemCenterOk, false);
  assert.equal(assessment.reasonCode, "OFFSITE_PROVIDER_POLICY_INPUT_INVALID");
  assert.doesNotMatch(serialized, /private\/offsite|never-return|accessKey|secretKey|credentials/);
});

test("malformed evidence remains unverified and never throws or becomes ready", () => {
  for (const input of [null, [], "google_drive", 42]) {
    assert.doesNotThrow(() => evaluateOffsiteProviderPolicy(input));
    const assessment = evaluateOffsiteProviderPolicy(input);
    assert.equal(assessment.ready, false);
    assert.equal(assessment.reasonCode, "OFFSITE_PROVIDER_POLICY_INPUT_INVALID");
    assert.equal(assessment.selectedProviderId, null);
  }

  const malformedBoolean = evaluateOffsiteProviderPolicy(readyEvidence({
    reachable: "true",
  }));
  assert.equal(malformedBoolean.ready, false);
  assert.deepEqual(malformedBoolean.reasonCodes, [
    "OFFSITE_PROVIDER_REACHABILITY_UNVERIFIED",
  ]);
});
