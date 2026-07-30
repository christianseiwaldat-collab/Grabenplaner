"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  OPERATIONAL_CAPABILITY_KEYS,
  createOperationalCapabilityReport,
  createPersistenceOperationsFacade,
} = require("../lib/persistence/operations/contract");

function capability(overrides = {}) {
  return {
    implemented: false,
    configured: false,
    verified: false,
    reasonCode: "NOT_IMPLEMENTED",
    lastVerifiedAt: null,
    maximumAgeHours: null,
    ...overrides,
  };
}

function capabilityMap(overrides = {}) {
  return Object.fromEntries(OPERATIONAL_CAPABILITY_KEYS.map((key) => [
    key,
    capability(overrides[key]),
  ]));
}

function reportInput(overrides = {}) {
  return {
    providerId: "postgresql",
    profile: "development-contract",
    backupMethod: "postgresql-pg-dump-custom",
    restoreMethod: "postgresql-pg-restore-custom",
    artifactFormat: "grabenplaner-backup-bundle-v2",
    generatedAt: "2026-07-30T10:00:00.000Z",
    capabilities: capabilityMap(),
    ...overrides,
  };
}

test("DB Block 6: Betriebsreport ist exakt, tief eingefroren und providergebunden", () => {
  const report = createOperationalCapabilityReport(reportInput({
    capabilities: capabilityMap({
      databaseBackup: {
        implemented: true,
        configured: true,
        verified: true,
        reasonCode: null,
        lastVerifiedAt: "2026-07-30T09:30:00.000Z",
        maximumAgeHours: 6,
      },
    }),
  }));
  assert.equal(report.providerId, "postgresql");
  assert.equal(report.profile, "development-contract");
  assert.equal(report.productActivation, false);
  assert.equal(report.capabilities.databaseBackup.state, "available");
  assert.equal(report.capabilities.databaseBackup.effective, false);
  assert.equal(report.capabilities.databaseBackup.ageHours, 0.5);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.capabilities), true);
  assert.equal(Object.isFrozen(report.capabilities.databaseBackup), true);
  assert.doesNotMatch(JSON.stringify(report), /DATABASE_URL|password|secret|host|role/i);
});

test("DB Block 6: fehlende, alte und zukünftige Nachweise werden nie grün", () => {
  const capabilities = capabilityMap({
    databaseBackup: {
      implemented: true,
      configured: false,
      verified: false,
      reasonCode: "NOT_CONFIGURED",
    },
    restore: {
      implemented: true,
      configured: true,
      verified: false,
      reasonCode: "RESTORE_NOT_VERIFIED",
    },
    integrityCheck: {
      implemented: true,
      configured: true,
      verified: true,
      reasonCode: null,
      lastVerifiedAt: "2026-07-28T00:00:00.000Z",
      maximumAgeHours: 24,
    },
    recoveryAssurance: {
      implemented: true,
      configured: true,
      verified: true,
      reasonCode: null,
      lastVerifiedAt: "2026-07-30T10:10:01.000Z",
      maximumAgeHours: 24,
    },
  });
  const report = createOperationalCapabilityReport(reportInput({ capabilities }));
  assert.equal(report.capabilities.databaseBackup.state, "not-configured");
  assert.equal(report.capabilities.restore.state, "not-verified");
  assert.equal(report.capabilities.integrityCheck.state, "stale");
  assert.equal(report.capabilities.recoveryAssurance.state, "stale");
  for (const key of OPERATIONAL_CAPABILITY_KEYS) {
    assert.equal(report.capabilities[key].effective, false);
  }
});

test("DB Block 6: widersprüchliche oder unbekannte Capabilityfelder scheitern geschlossen", () => {
  const contradictory = capabilityMap({
    databaseBackup: {
      implemented: false,
      configured: true,
      verified: false,
      reasonCode: "INVALID",
    },
  });
  assert.throws(() => createOperationalCapabilityReport(reportInput({
    capabilities: contradictory,
  })));

  const extra = capabilityMap();
  extra.databaseBackup.databaseUrl = "postgresql://admin:secret@host/db";
  assert.throws(() => createOperationalCapabilityReport(reportInput({
    capabilities: extra,
  })));

  const missing = capabilityMap();
  delete missing.restore;
  assert.throws(() => createOperationalCapabilityReport(reportInput({
    capabilities: missing,
  })));
});

test("DB Block 6: Facade wartet beim Schließen auf laufende Betriebsarbeit", async () => {
  let resolveSnapshot;
  let closeCalls = 0;
  const snapshotGate = new Promise((resolve) => { resolveSnapshot = resolve; });
  const adapter = {
    getCapabilityReport: () => createOperationalCapabilityReport(reportInput()),
    preflight: async () => ({ ok: true }),
    createSnapshot: async () => {
      await snapshotGate;
      return { ok: true };
    },
    verifySnapshot: async () => ({ ok: true }),
    restoreIntoEmptyTarget: async () => ({ ok: true }),
    verifyRestoredTarget: async () => ({ ok: true }),
    readDiagnostics: async () => ({ ok: true }),
    close: async () => { closeCalls += 1; },
  };
  const operations = createPersistenceOperationsFacade(adapter);
  const pending = operations.createSnapshot({});
  const closing = operations.close();
  await assert.rejects(
    operations.preflight({}),
    (error) => error?.code === "PERSISTENCE_OPERATIONS_CLOSING",
  );
  assert.equal(closeCalls, 0);
  resolveSnapshot();
  await pending;
  await closing;
  assert.equal(closeCalls, 1);
  await operations.close();
  assert.equal(closeCalls, 1);
  await assert.rejects(
    operations.readDiagnostics({}),
    (error) => error?.code === "PERSISTENCE_OPERATIONS_CLOSED",
  );
});

test("DB Block 6: Facade akzeptiert keinen Raw-Handle oder Escape-Hatch", () => {
  const adapter = {
    getCapabilityReport() {},
    preflight() {},
    createSnapshot() {},
    verifySnapshot() {},
    restoreIntoEmptyTarget() {},
    verifyRestoredTarget() {},
    readDiagnostics() {},
    close() {},
    rawClient: {},
  };
  assert.throws(() => createPersistenceOperationsFacade(adapter));
});
