"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  RECOVERY_ASSURANCE_PHASES,
  createRecoveryAssuranceReceipt,
  verifyRecoveryAssuranceReceipt,
} = require("../lib/persistence/operations/recovery-assurance");
const {
  POSTGRESQL_ASSURANCE_ERROR_CODES,
  createPostgresqlExternalRecoveryEvidence,
  createPostgresqlRecoveryAssuranceReceipt,
} = require("../lib/persistence/postgresql/operations/recovery-assurance");

function evidence(overrides = {}) {
  return {
    bundleHash: "1".repeat(64),
    databaseArtifactSha256: "2".repeat(64),
    protectedDocumentsManifestSha256: "3".repeat(64),
    sourceEvidenceFingerprint: "4".repeat(64),
    restoredEvidenceFingerprint: "4".repeat(64),
    restoreReceiptSha256: "5".repeat(64),
    appVersion: "0.87.0-beta",
    ...overrides,
  };
}

function phases(status = "passed") {
  return Object.fromEntries(RECOVERY_ASSURANCE_PHASES.map((phase, index) => [
    phase,
    status === "not-run"
      ? { status, completedAt: null, evidenceSha256: null }
      : {
        status,
        completedAt: `2026-07-30T09:${String(index).padStart(2, "0")}:00.000Z`,
        evidenceSha256: String(index + 6).repeat(64).slice(0, 64),
      },
  ]));
}

function keyPair() {
  return crypto.generateKeyPairSync("ed25519");
}

function postgresqlRun() {
  const sourceEvidence = {
    fingerprint: "4".repeat(64),
    referenceCount: 1,
  };
  const bundle = {
    providerId: "postgresql",
    method: "postgresql-pg-dump-custom",
    appVersion: "0.87.0-beta",
    bundleHash: "1".repeat(64),
    marker: {
      database: { sha256: "2".repeat(64) },
      protectedDocuments: { manifestSha256: "3".repeat(64) },
    },
  };
  return {
    backup: {
      bundle,
      sourceEvidence,
      protectedDocumentReferences: [
        "ab/12345678-1234-4123-8123-123456789abc.amu",
      ],
      productActivation: false,
    },
    restore: {
      providerId: "postgresql",
      backupMethod: "postgresql-pg-dump-custom",
      bundleHash: bundle.bundleHash,
      databaseArtifactSha256: bundle.marker.database.sha256,
      protectedDocumentsManifestSha256:
        bundle.marker.protectedDocuments.manifestSha256,
      sourceEvidence: { ...sourceEvidence },
      restoredEvidence: { ...sourceEvidence },
      applicationSmoke: true,
      targetBinding: "6".repeat(64),
      productActivation: false,
    },
  };
}

function passedReceipt(privateKey, overrides = {}) {
  return createRecoveryAssuranceReceipt({
    privateKey,
    runId: "019f-a123-b456-c789-d012",
    providerId: "postgresql",
    profile: "development-contract",
    backupMethod: "postgresql-pg-dump-custom",
    status: "passed",
    issuedAt: "2026-07-30T10:00:00.000Z",
    errorCode: null,
    evidence: evidence(),
    phases: phases(),
    ...overrides,
  });
}

test("DB Block 6: PostgreSQL-Assurance bindet Provider, Methode, Bundle und Restore kryptografisch", () => {
  const keys = keyPair();
  const receipt = passedReceipt(keys.privateKey);
  const status = verifyRecoveryAssuranceReceipt(receipt, {
    publicKey: keys.publicKey,
    expectedProviderId: "postgresql",
    expectedBackupMethod: "postgresql-pg-dump-custom",
    now: new Date("2026-07-30T11:00:00.000Z"),
    maximumAgeHours: 24,
  });
  assert.equal(status.providerId, "postgresql");
  assert.equal(status.backupMethod, "postgresql-pg-dump-custom");
  assert.equal(status.status, "passed");
  assert.equal(status.verified, true);
  assert.equal(status.technicallyValid, true);
  assert.equal(status.productActivation, false);
  assert.equal(status.effective, false);
  assert.equal(status.ageHours, 1);
  assert.match(status.receiptHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(receipt), /DATABASE_URL|postgresql:\/\/|password|secret|host|user|role|path/i);
});

test("DB Block 6: Provider-/Methodenmischung und Manipulation scheitern geschlossen", () => {
  const keys = keyPair();
  const receipt = passedReceipt(keys.privateKey);
  assert.throws(
    () => verifyRecoveryAssuranceReceipt(receipt, {
      publicKey: keys.publicKey,
      expectedProviderId: "sqlite",
      expectedBackupMethod: "vacuum-into-v1",
    }),
    (error) => error?.code === "RECOVERY_ASSURANCE_BINDING_INVALID",
  );
  assert.throws(
    () => verifyRecoveryAssuranceReceipt({
      ...receipt,
      evidence: { ...receipt.evidence, bundleHash: "f".repeat(64) },
    }, {
      publicKey: keys.publicKey,
      expectedProviderId: "postgresql",
      expectedBackupMethod: "postgresql-pg-dump-custom",
    }),
    (error) => error?.code === "RECOVERY_ASSURANCE_SIGNATURE_INVALID",
  );
});

test("DB Block 6: Pass ist ohne jede bestandene Phase und Evidence-Parität unmöglich", () => {
  const keys = keyPair();
  const incomplete = phases();
  incomplete.applicationSmoke = {
    status: "not-run",
    completedAt: null,
    evidenceSha256: null,
  };
  assert.throws(() => passedReceipt(keys.privateKey, { phases: incomplete }));
  assert.throws(() => passedReceipt(keys.privateKey, {
    evidence: evidence({ restoredEvidenceFingerprint: "9".repeat(64) }),
  }));
});

test("DB Block 6: signierter Fehler benötigt feste Fehlerkennung und mindestens eine Fehlerphase", () => {
  const keys = keyPair();
  const failedPhases = phases("not-run");
  failedPhases.backup = {
    status: "failed",
    completedAt: "2026-07-30T09:00:00.000Z",
    evidenceSha256: "a".repeat(64),
  };
  const receipt = createRecoveryAssuranceReceipt({
    privateKey: keys.privateKey,
    runId: "019f-a123-b456-c789-d013",
    providerId: "postgresql",
    profile: "development-contract",
    backupMethod: "postgresql-pg-dump-custom",
    status: "failed",
    issuedAt: "2026-07-30T10:00:00.000Z",
    errorCode: "BACKUP_FAILED",
    evidence: evidence({
      restoredEvidenceFingerprint: "8".repeat(64),
    }),
    phases: failedPhases,
  });
  const result = verifyRecoveryAssuranceReceipt(receipt, {
    publicKey: keys.publicKey,
    expectedProviderId: "postgresql",
    expectedBackupMethod: "postgresql-pg-dump-custom",
    now: new Date("2026-07-30T10:05:00.000Z"),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.effective, false);
  assert.equal(result.errorCode, "BACKUP_FAILED");

  assert.throws(() => createRecoveryAssuranceReceipt({
    privateKey: keys.privateKey,
    runId: "019f-a123-b456-c789-d014",
    providerId: "postgresql",
    profile: "development-contract",
    backupMethod: "postgresql-pg-dump-custom",
    status: "failed",
    issuedAt: "2026-07-30T10:00:00.000Z",
    errorCode: null,
    evidence: evidence(),
    phases: failedPhases,
  }));
});

test("DB Block 6: alte und zukünftige signierte Nachweise bleiben verifiziert, aber nicht wirksam", () => {
  const keys = keyPair();
  const old = verifyRecoveryAssuranceReceipt(passedReceipt(keys.privateKey), {
    publicKey: keys.publicKey,
    expectedProviderId: "postgresql",
    expectedBackupMethod: "postgresql-pg-dump-custom",
    now: new Date("2026-08-05T10:00:00.000Z"),
    maximumAgeHours: 24,
  });
  assert.equal(old.verified, true);
  assert.equal(old.stale, true);
  assert.equal(old.effective, false);

  const futureReceipt = passedReceipt(keys.privateKey, {
    issuedAt: "2026-07-31T10:00:00.000Z",
    phases: Object.fromEntries(RECOVERY_ASSURANCE_PHASES.map((phase, index) => [
      phase,
      {
        status: "passed",
        completedAt: `2026-07-31T09:${String(index).padStart(2, "0")}:00.000Z`,
        evidenceSha256: "b".repeat(64),
      },
    ])),
  });
  const future = verifyRecoveryAssuranceReceipt(futureReceipt, {
    publicKey: keys.publicKey,
    expectedProviderId: "postgresql",
    expectedBackupMethod: "postgresql-pg-dump-custom",
    now: new Date("2026-07-30T10:00:00.000Z"),
    maximumAgeHours: 24,
  });
  assert.equal(future.stale, true);
  assert.equal(future.effective, false);
  assert.equal(future.ageHours, null);
});

test("DB Block 6: PostgreSQL-Orchestrator bindet Run-Artefakte und lässt fehlendes Offsite sichtbar", () => {
  const keys = keyPair();
  const run = postgresqlRun();
  const incomplete = createPostgresqlRecoveryAssuranceReceipt({
    privateKey: keys.privateKey,
    runId: "019f-a123-b456-c789-d015",
    issuedAt: "2026-07-30T12:00:00.000Z",
    appVersion: "0.87.0-beta",
    ...run,
  });
  const incompleteStatus = verifyRecoveryAssuranceReceipt(incomplete, {
    publicKey: keys.publicKey,
    expectedProviderId: "postgresql",
    expectedProfile: "development-contract",
    expectedBackupMethod: "postgresql-pg-dump-custom",
    now: new Date("2026-07-30T12:05:00.000Z"),
  });
  assert.equal(incomplete.status, "failed");
  assert.equal(incomplete.errorCode, "POSTGRESQL_OFFSITE_UPLOAD_NOT_VERIFIED");
  assert.equal(incomplete.phases.offsiteUpload.status, "failed");
  assert.equal(incomplete.phases.repositoryReadCheck.status, "not-run");
  assert.equal(incompleteStatus.verified, true);
  assert.equal(incompleteStatus.technicallyValid, false);
  assert.equal(incompleteStatus.productActivation, false);
  assert.equal(incompleteStatus.effective, false);

  const complete = createPostgresqlRecoveryAssuranceReceipt({
    privateKey: keys.privateKey,
    runId: "019f-a123-b456-c789-d016",
    issuedAt: "2026-07-30T12:00:00.000Z",
    appVersion: "0.87.0-beta",
    ...run,
    offsiteUpload: createPostgresqlExternalRecoveryEvidence({
      phase: "offsiteUpload",
      completedAt: "2026-07-30T11:58:00.000Z",
      providerId: "postgresql",
      backupMethod: "postgresql-pg-dump-custom",
      bundleHash: run.backup.bundle.bundleHash,
      databaseArtifactSha256: run.backup.bundle.marker.database.sha256,
      protectedDocumentsManifestSha256:
        run.backup.bundle.marker.protectedDocuments.manifestSha256,
    }),
    repositoryReadCheck: createPostgresqlExternalRecoveryEvidence({
      phase: "repositoryReadCheck",
      completedAt: "2026-07-30T11:59:00.000Z",
      providerId: "postgresql",
      backupMethod: "postgresql-pg-dump-custom",
      bundleHash: run.backup.bundle.bundleHash,
      databaseArtifactSha256: run.backup.bundle.marker.database.sha256,
      protectedDocumentsManifestSha256:
        run.backup.bundle.marker.protectedDocuments.manifestSha256,
      databaseReadBackSha256: run.backup.bundle.marker.database.sha256,
      protectedDocumentsManifestReadBackSha256:
        run.backup.bundle.marker.protectedDocuments.manifestSha256,
    }),
  });
  const completeStatus = verifyRecoveryAssuranceReceipt(complete, {
    publicKey: keys.publicKey,
    expectedProviderId: "postgresql",
    expectedProfile: "development-contract",
    expectedBackupMethod: "postgresql-pg-dump-custom",
    now: new Date("2026-07-30T12:05:00.000Z"),
  });
  assert.equal(complete.status, "passed");
  assert.equal(completeStatus.technicallyValid, true);
  assert.equal(completeStatus.productActivation, false);
  assert.equal(completeStatus.effective, false);
  assert.equal(
    complete.evidence.sourceEvidenceFingerprint,
    run.backup.sourceEvidence.fingerprint,
  );
  assert.equal(
    complete.evidence.restoredEvidenceFingerprint,
    run.restore.restoredEvidence.fingerprint,
  );

  assert.throws(
    () => createPostgresqlRecoveryAssuranceReceipt({
      privateKey: keys.privateKey,
      runId: "019f-a123-b456-c789-d017",
      issuedAt: "2026-07-30T12:00:00.000Z",
      appVersion: "0.87.0-beta",
      backup: run.backup,
      restore: {
        ...run.restore,
        bundleHash: "9".repeat(64),
      },
    }),
    (error) => error?.code === POSTGRESQL_ASSURANCE_ERROR_CODES.EVIDENCE_MISMATCH,
  );
});
