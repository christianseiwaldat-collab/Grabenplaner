"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
test('a newer manual full proof is shown separately without rewriting a failed night', () => {
  const assurance = { configured: true, statusAvailable: true, integrityVerified: true,
    scheduler: { evidenceTrusted: true, timerInstalled: true, timerEnabled: true },
    trendRuns: [
      { trigger: 'scheduled-nightly', at: '2026-09-20T02:22:00Z', status: 'failed', applicationSmokeState: 'failed' },
      { trigger: 'manual-cli', at: '2026-09-20T11:05:28Z', status: 'passed', applicationSmokeState: 'passed' },
    ] };
  const result = deriveAutomationStatus(assurance, { now: new Date('2026-09-20T13:00:00Z') });
  assert.equal(result.state, 'critical');
  assert.equal(result.applicationSmokeState, 'failed');
  assert.equal(result.latestFullProofAt, '2026-09-20T11:05:28.000Z');
  assert.equal(deriveAutomationStatus({ ...assurance, integrityVerified: false }).latestFullProofAt, null);
});
const {
  createSystemCenterMetricsRepository,
} = require("../lib/persistence/repositories/system-center-metrics");
const {
  SQLITE_SYSTEM_CENTER_METRICS_CATALOG,
} = require("../lib/persistence/sqlite/system-center-metrics-catalog");
const {
  ensureSqliteSystemCenterMetricsSchema,
} = require("../lib/persistence/sqlite/operations/system-center-metrics-schema");
const {
  createSqlitePersistenceProvider,
} = require("../lib/persistence/sqlite/provider");
const {
  buildSystemCenterTrendPayload,
  createSystemCenterMetricsStore,
  deriveAutomationStatus,
  planSystemCenterNotificationSync,
  recoveryTrendRuns,
  systemCenterNotificationIncidentKey,
  systemCenterRecoveryAlert,
} = require("../lib/system-center-metrics");

function createSystemCenterMetricsProviderFixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-system-center-metrics-"));
  const databasePath = path.join(directory, "metrics.sqlite");
  const schemaDatabase = new DatabaseSync(databasePath);
  try {
    ensureSqliteSystemCenterMetricsSchema(schemaDatabase);
    schemaDatabase.exec(`
      CREATE TABLE product_readiness_evidence (
        id TEXT PRIMARY KEY,
        check_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        receipt_sha256 TEXT NOT NULL,
        observed_by TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE product_readiness_acceptances (
        id TEXT PRIMARY KEY,
        discipline TEXT NOT NULL,
        decision TEXT NOT NULL,
        release_version TEXT NOT NULL,
        basis_sha256 TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        receipt_sha256 TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL
      );
      CREATE TABLE portal_notifications (
        id TEXT PRIMARY KEY,
        recipient_employee_number TEXT NOT NULL,
        event_type TEXT NOT NULL,
        dedupe_key TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } finally {
    schemaDatabase.close();
  }
  const provider = createSqlitePersistenceProvider({
    databasePath,
    catalog: SQLITE_SYSTEM_CENTER_METRICS_CATALOG,
  });
  const repository = createSystemCenterMetricsRepository(provider);
  return {
    repository,
    store: createSystemCenterMetricsStore(repository, options),
    tamperTrustScoreWithSqliteTestOperation(intervalKey, trustScore) {
      const manipulationDatabase = new DatabaseSync(databasePath);
      try {
        manipulationDatabase
          .prepare("UPDATE system_center_trust_metrics SET trust_score = ? WHERE interval_key = ?")
          .run(trustScore, intervalKey);
      } finally {
        manipulationDatabase.close();
      }
    },
    insertRecoveryNotificationWithSqliteTestOperation({
      id,
      recipient,
      dedupeKey,
      createdAt,
    }) {
      const manipulationDatabase = new DatabaseSync(databasePath);
      try {
        manipulationDatabase.prepare(`
          INSERT INTO portal_notifications
            (id, recipient_employee_number, event_type, dedupe_key, created_at)
          VALUES (?, ?, 'system.recovery.alert', ?, ?)
        `).run(id, recipient, dedupeKey, createdAt);
      } finally {
        manipulationDatabase.close();
      }
    },
    async close() {
      try {
        await provider.close();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

function event(runId, eventType, occurredAt, trigger = "scheduled-nightly") {
  return { payload: { runId, eventType, occurredAt, trigger } };
}

function scheduler(overrides = {}) {
  return {
    evidenceTrusted: true,
    timerInstalled: true,
    timerEnabled: true,
    nextElapse: "2026-07-22T01:00:00.000Z",
    checkedAt: "2026-07-21T10:00:00.000Z",
    ...overrides,
  };
}

function deferredAssurance(overrides = {}) {
  return {
    configured: true, statusAvailable: true, integrityVerified: true, state: "ok",
    scheduler: scheduler(),
    trendRuns: [{ trigger: "scheduled-nightly", at: "2026-07-21T01:00:00.000Z", status: "passed", applicationSmokeState: "passed" }],
    deployDeferral: { evidenceTrusted: true, state: "deferred", activeDeploy: true, withinGrace: true,
      dueAt: "2026-07-22T01:00:00.000Z", deadlineAt: "2026-07-22T04:00:00.000Z" },
    ...overrides,
  };
}

test("a verified deployment pauses only the due night inside its exact three-hour deadline", () => {
  const a = deferredAssurance();
  for (const now of ["2026-07-22T01:00:00Z", "2026-07-22T03:59:59.999Z"]) {
    const result = deriveAutomationStatus(a, { now });
    assert.equal(result.state, "healthy"); assert.equal(result.paused, true);
    assert.equal(result.reasonCode, "AUTOMATION_DEPLOY_DEFERRED"); assert.equal(result.overdue, false);
    assert.equal(result.lastRunAt, "2026-07-21T01:00:00.000Z");
    assert.equal(systemCenterRecoveryAlert({ recoveryAssurance: a, automation: result }), null);
  }
  assert.equal(deriveAutomationStatus(a, { now: "2026-07-22T00:59:59Z" }).paused, false);
  const expired = deriveAutomationStatus(a, { now: "2026-07-22T04:00:00Z" });
  assert.equal(expired.state, "critical"); assert.equal(expired.paused, false);
  assert.equal(expired.reasonCode, "AUTOMATION_DEPLOY_DEFERRAL_EXPIRED");
  assert.equal(systemCenterRecoveryAlert({ recoveryAssurance: a, automation: expired }).kind, "deploy_deferral_expired");
});

test("deployment evidence cannot forgive an old bad or missing nightly history or broken timer", () => {
  const now = "2026-07-22T02:00:00Z";
  const cases = [
    [{ statusAvailable: false }, "AUTOMATION_HISTORY_UNVERIFIED"],
    [{ integrityVerified: false }, "AUTOMATION_HISTORY_UNVERIFIED"],
    [{ integrityVerified: undefined }, "AUTOMATION_HISTORY_UNVERIFIED"],
    [{ statusAvailable: undefined }, "AUTOMATION_HISTORY_UNVERIFIED"],
    [{ scheduler: scheduler({ timerInstalled: false }) }, "AUTOMATION_TIMER_NOT_INSTALLED"],
    [{ scheduler: scheduler({ timerEnabled: false }) }, "AUTOMATION_TIMER_DISABLED"],
    [{ scheduler: scheduler({ evidenceTrusted: false }) }, "AUTOMATION_SCHEDULER_EVIDENCE_MISSING"],
    [{ trendRuns: [] }, "AUTOMATION_AWAITING_FIRST_RUN"],
    [{ trendRuns: [{ trigger: "scheduled-nightly", at: "2026-07-19T01:00:00Z", status: "passed", applicationSmokeState: "passed" }] }, "AUTOMATION_OVERDUE"],
    [{ trendRuns: [{ trigger: "scheduled-nightly", at: "2026-07-21T01:00:00Z", status: "failed", applicationSmokeState: "passed" }] }, "AUTOMATION_RUN_FAILED"],
    [{ trendRuns: [{ trigger: "scheduled-nightly", at: "2026-07-21T01:00:00Z", status: "passed", applicationSmokeState: "failed" }] }, "AUTOMATION_APPLICATION_SMOKE_FAILED"],
  ];
  for (const [patch, expected] of cases) {
    const result = deriveAutomationStatus(deferredAssurance(patch), { now });
    assert.equal(result.paused, false, expected); assert.equal(result.reasonCode, expected);
  }
});

test("untrusted, forged longer or inactive deployment evidence grants no pause", () => {
  for (const patch of [{ evidenceTrusted: false }, { deadlineAt: "2026-07-22T05:00:00Z" },
    { deadlineAt: "invalid" }, { withinGrace: false }, { state: "catchup-pending", activeDeploy: false },
    { state: "not-due" }]) {
    const a = deferredAssurance(); Object.assign(a.deployDeferral, patch);
    assert.equal(deriveAutomationStatus(a, { now: "2026-07-22T02:00:00Z" }).paused, false);
  }
  for (const state of ["abandoned", "aborted", "deferred"]) {
    const a = deferredAssurance(); Object.assign(a.deployDeferral, { state, activeDeploy: false });
    assert.equal(deriveAutomationStatus(a, { now: "2026-07-22T02:00:00Z" }).state, "critical");
  }
});

test("catchup gains no pause and a later full signed proof settles only the deployment deferral", () => {
  const a = deferredAssurance(); Object.assign(a.deployDeferral, { state: "catchup-pending", activeDeploy: false, withinGrace: false });
  assert.equal(deriveAutomationStatus(a, { now: "2026-07-22T02:00:00Z" }).paused, false);
  assert.equal(deriveAutomationStatus(a, { now: "2026-07-22T04:00:00Z" }).reasonCode, "AUTOMATION_DEPLOY_DEFERRAL_EXPIRED");
  a.trendRuns.push({ trigger: "manual-cli", at: "2026-07-22T03:30:00Z", status: "passed", applicationSmokeState: "passed" });
  let result = deriveAutomationStatus(a, { now: "2026-07-22T04:00:00Z" });
  assert.equal(result.state, "healthy"); assert.equal(result.deployDeferral.satisfied, true); assert.equal(result.paused, false);
  a.trendRuns[0].status = "failed";
  result = deriveAutomationStatus(a, { now: "2026-07-22T04:00:00Z" });
  assert.equal(result.state, "critical"); assert.equal(result.reasonCode, "AUTOMATION_RUN_FAILED");
});

test("a signed timely nightly start satisfies the start deadline but cannot run forever or hide failure", () => {
  const a = deferredAssurance(); Object.assign(a.deployDeferral, { state: "catchup-pending", activeDeploy: false, withinGrace: false });
  a.recentRuns = [{ trigger: "scheduled-nightly", startedAt: "2026-07-22T03:00:00Z", completedAt: null, status: "running", phases: [] }];
  let result = deriveAutomationStatus(a, { now: "2026-07-22T05:00:00Z" });
  assert.equal(result.state, "healthy"); assert.equal(result.reasonCode, "AUTOMATION_DEPLOY_CATCHUP_RUNNING");
  assert.equal(result.paused, false); assert.equal(result.deployDeferral.catchupRunning, true);
  assert.equal(result.deployDeferral.satisfied, false);
  assert.equal(deriveAutomationStatus(a, { now: "2026-07-23T19:00:00Z" }).state, "critical");
  for (const patch of [{ startedAt: "2026-07-22T04:00:01Z" }, { trigger: "manual-cli" }]) {
    const changed = structuredClone(a); Object.assign(changed.recentRuns[0], patch);
    assert.equal(deriveAutomationStatus(changed, { now: "2026-07-22T05:00:00Z" }).reasonCode, "AUTOMATION_DEPLOY_DEFERRAL_EXPIRED");
  }
  a.recentRuns[0].status = "failed";
  assert.equal(deriveAutomationStatus(a, { now: "2026-07-22T05:00:00Z" }).reasonCode, "AUTOMATION_RUN_FAILED");
  a.trendRuns.push({ trigger: "manual-cli", at: "2026-07-22T02:00:00Z", status: "passed", applicationSmokeState: "passed" });
  assert.equal(deriveAutomationStatus(a, { now: "2026-07-22T05:00:00Z" }).reasonCode, "AUTOMATION_RUN_FAILED");
});

test("a deployment that ended before the due time creates no three-hour deadline incident", () => {
  for (const state of ["completed", "aborted"]) {
    const a = deferredAssurance(); Object.assign(a.deployDeferral, { state, activeDeploy: false, withinGrace: false, finishedAt: "2026-07-22T00:59:00Z" });
    const result = deriveAutomationStatus(a, { now: "2026-07-22T05:00:00Z" });
    assert.equal(result.state, "healthy"); assert.equal(result.paused, false);
    assert.equal(result.reasonCode, "AUTOMATION_CURRENT");
  }
});

test("v0.78: signierte RAS-Ereignisse werden zu begrenzten, redigierten Trendwerten verdichtet", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const runs = recoveryTrendRuns([
    event(runId, "full-assurance-started", "2026-07-21T01:00:00.000Z"),
    event(runId, "oauth-policy-passed", "2026-07-21T01:00:10.000Z"),
    event(runId, "backup-passed", "2026-07-21T01:01:10.000Z"),
    event(runId, "repository-check-passed", "2026-07-21T01:01:30.000Z"),
    event(runId, "restore-test-passed", "2026-07-21T01:03:30.000Z"),
    event(runId, "application-smoke-passed", "2026-07-21T01:03:40.000Z"),
    event(runId, "full-assurance-passed", "2026-07-21T01:03:45.000Z"),
  ], { now: new Date("2026-07-22T00:00:00.000Z") });
  assert.deepEqual(runs, [{
    at: "2026-07-21T01:03:45.000Z",
    trigger: "scheduled-nightly",
    status: "passed",
    backupDurationSeconds: 60,
    recoveryDurationSeconds: 120,
    fullDurationSeconds: 225,
    applicationSmokeState: "passed",
  }]);
  assert.equal(JSON.stringify(runs).includes(runId), false);
});

test("v0.78: Nacht-Automatik bewertet echten Smoke-Nachweis und Ueberfaelligkeit konservativ", () => {
  const healthy = deriveAutomationStatus({
    configured: true,
    statusAvailable: true,
    integrityVerified: true,
    scheduler: scheduler(),
    trendRuns: [{
      at: "2026-07-21T01:03:45.000Z",
      trigger: "scheduled-nightly",
      status: "passed",
      applicationSmokeState: "passed",
    }],
  }, { now: new Date("2026-07-21T10:00:00.000Z") });
  assert.equal(healthy.state, "healthy");
  assert.equal(healthy.nextRunAt, "2026-07-22T01:00:00.000Z");
  assert.equal(healthy.overdue, false);

  const overdue = deriveAutomationStatus({
    configured: true,
    statusAvailable: true,
    integrityVerified: true,
    scheduler: scheduler({ nextElapse: "2026-07-22T01:00:00.000Z" }),
    trendRuns: [{
      at: "2026-07-19T01:03:45.000Z",
      trigger: "scheduled-nightly",
      status: "passed",
      applicationSmokeState: "passed",
    }],
  }, { now: new Date("2026-07-21T10:00:00.000Z") });
  assert.equal(overdue.state, "critical");
  assert.equal(overdue.reasonCode, "AUTOMATION_OVERDUE");

  const missingSmoke = deriveAutomationStatus({
    configured: true,
    statusAvailable: true,
    integrityVerified: true,
    scheduler: scheduler(),
    trendRuns: [{
      at: "2026-07-21T01:03:45.000Z",
      trigger: "scheduled-nightly",
      status: "passed",
      applicationSmokeState: "not_run",
    }],
  }, { now: new Date("2026-07-21T10:00:00.000Z") });
  assert.equal(missingSmoke.state, "attention");
  assert.equal(missingSmoke.reasonCode, "AUTOMATION_APPLICATION_SMOKE_NOT_RUN");
});

test("v0.78: fehlender Scheduler-Nachweis bleibt fail-closed", () => {
  const result = deriveAutomationStatus({
    configured: true,
    statusAvailable: true,
    integrityVerified: true,
    trendRuns: [{
      at: "2026-07-21T01:03:45.000Z",
      trigger: "scheduled-nightly",
      status: "passed",
      applicationSmokeState: "passed",
    }],
  }, { now: new Date("2026-07-21T10:00:00.000Z") });
  assert.equal(result.enabled, false);
  assert.equal(result.state, "attention");
  assert.equal(result.reasonCode, "AUTOMATION_SCHEDULER_EVIDENCE_MISSING");
  assert.deepEqual(result.scheduler, {
    evidenceTrusted: false,
    timerInstalled: null,
    timerEnabled: null,
    nextElapse: null,
    checkedAt: null,
  });
});

test("v0.78: deaktivierter Nacht-Timer wird kritisch und nicht als aktiv gemeldet", () => {
  const result = deriveAutomationStatus({
    configured: true,
    statusAvailable: true,
    integrityVerified: true,
    scheduler: scheduler({ timerEnabled: false, nextElapse: null }),
    trendRuns: [],
  });
  assert.equal(result.enabled, false);
  assert.equal(result.state, "critical");
  assert.equal(result.reasonCode, "AUTOMATION_TIMER_DISABLED");
  const alert = systemCenterRecoveryAlert({
    recoveryAssurance: { configured: true, statusAvailable: true, integrityVerified: true },
    automation: result,
  });
  assert.equal(alert.kind, "automation_unavailable");
  assert.equal(alert.evidenceAt, null);
  assert.equal(JSON.stringify(alert).includes("systemctl"), false);
});

test("v0.78: alter Wochenlauf beweist keine aktive Nacht-Automatik", () => {
  const result = deriveAutomationStatus({
    configured: true,
    statusAvailable: true,
    integrityVerified: true,
    scheduler: scheduler(),
    trendRuns: [{
      at: "2026-07-21T01:03:45.000Z",
      trigger: "scheduled-weekly",
      status: "passed",
      applicationSmokeState: "passed",
    }],
  }, { now: new Date("2026-07-21T10:00:00.000Z") });
  assert.equal(result.enabled, true);
  assert.equal(result.state, "attention");
  assert.equal(result.reasonCode, "AUTOMATION_LEGACY_WEEKLY_ONLY");
  assert.equal(result.lastRunAt, null);
});

test("v0.78: vertrauenswuerdig aktiver Timer plus Nachtlauf wird gesund", () => {
  const result = deriveAutomationStatus({
    configured: true,
    statusAvailable: true,
    integrityVerified: true,
    scheduler: scheduler(),
    trendRuns: [{
      at: "2026-07-21T01:03:45.000Z",
      trigger: "scheduled-nightly",
      status: "passed",
      applicationSmokeState: "passed",
    }],
  }, { now: new Date("2026-07-21T10:00:00.000Z") });
  assert.equal(result.enabled, true);
  assert.equal(result.state, "healthy");
  assert.equal(result.reasonCode, "AUTOMATION_CURRENT");
});

test("v0.78: lokale Trust-Metriken sind gedrosselt, begrenzt und manipulationsauffaellig", async () => {
  const fixture = createSystemCenterMetricsProviderFixture({
    retentionDays: 30,
    sampleIntervalHours: 6,
  });
  try {
    const input = {
      trustIndex: { score: 93, coverage: 100, state: "healthy" },
      resources: { storage: { databaseBytes: 4096, freeBytes: 8192 } },
      automation: { state: "healthy" },
      now: new Date("2026-07-21T01:10:00.000Z"),
    };
    assert.equal(await fixture.store.record(input), true);
    assert.equal(await fixture.store.record({
      ...input,
      now: new Date("2026-07-21T05:59:00.000Z"),
    }), false);
    assert.equal(await fixture.store.record({
      ...input,
      trustIndex: { score: 94, coverage: 100, state: "healthy" },
      now: new Date("2026-07-21T07:00:00.000Z"),
    }), true);
    const verified = await fixture.store.read();
    assert.equal(verified.integrityVerified, true);
    assert.equal(verified.samples.length, 2);
    assert.equal(verified.samples[0].databaseBytes, 4096);

    fixture.tamperTrustScoreWithSqliteTestOperation(verified.samples[0].intervalKey, 12);
    assert.deepEqual(await fixture.store.read(), { integrityVerified: false, samples: [] });
  } finally {
    await fixture.close();
  }
});

test("v0.87 Datenbank Block 3: parallele Slots und rueckdatierte Metriken bleiben atomar", async () => {
  const fixture = createSystemCenterMetricsProviderFixture({
    retentionDays: 30,
    sampleIntervalHours: 6,
  });
  try {
    const input = {
      trustIndex: { score: 91, coverage: 100, state: "healthy" },
      resources: { storage: { databaseBytes: 4096, freeBytes: 8192 } },
      automation: { state: "healthy" },
      now: new Date("2026-07-21T07:00:00.000Z"),
    };
    const concurrentResults = await Promise.all([
      fixture.store.record(input),
      fixture.store.record(input),
    ]);
    assert.equal(concurrentResults.filter(Boolean).length, 1);
    assert.equal(concurrentResults.filter((result) => result === false).length, 1);

    assert.equal(await fixture.store.record({
      ...input,
      now: new Date("2026-07-21T13:00:00.000Z"),
    }), true);
    assert.equal(await fixture.store.record({
      ...input,
      now: new Date("2026-07-21T01:00:00.000Z"),
    }), false);
    const verified = await fixture.store.read();
    assert.equal(verified.integrityVerified, true);
    assert.deepEqual(
      verified.samples.map((sample) => sample.recordedAt),
      ["2026-07-21T06:00:00.000Z", "2026-07-21T12:00:00.000Z"],
    );
  } finally {
    await fixture.close();
  }
});

test("v0.87 Datenbank Block 3: Metrics-Retention bleibt begrenzt und hashverifiziert", async () => {
  const fixture = createSystemCenterMetricsProviderFixture({
    retentionDays: 30,
    sampleIntervalHours: 24,
  });
  try {
    const start = Date.parse("2026-06-01T01:00:00.000Z");
    for (let day = 0; day < 40; day += 1) {
      assert.equal(await fixture.store.record({
        trustIndex: { score: 90 + (day % 5), coverage: 100, state: "healthy" },
        resources: { storage: { databaseBytes: 4096 + day, freeBytes: 8192 - day } },
        automation: { state: "healthy" },
        now: new Date(start + (day * 24 * 60 * 60 * 1_000)),
      }), true);
    }
    const verified = await fixture.store.read();
    assert.equal(verified.integrityVerified, true);
    assert.ok(verified.samples.length <= fixture.store.maximumSamples);
    assert.equal(verified.samples.at(-1).recordedAt, "2026-07-10T00:00:00.000Z");
    assert.ok(Date.parse(verified.samples[0].recordedAt) >= Date.parse("2026-06-10T00:00:00.000Z"));
  } finally {
    await fixture.close();
  }
});

test("v0.87 Datenbank Block 3: Pilotnachweise und Abnahmen laufen providerneutral", async () => {
  const fixture = createSystemCenterMetricsProviderFixture();
  try {
    const evidence = {
      id: "evidence-1",
      checkId: "security",
      outcome: "passed",
      receiptSha256: "a".repeat(64),
      observedBy: "E1",
      observedAt: "2026-07-29T10:00:00.000Z",
      createdAt: "2026-07-29T10:00:00.000Z",
    };
    await fixture.repository.insertReadinessEvidence(evidence);
    assert.deepEqual(await fixture.repository.listReadinessEvidence(), [{
      id: evidence.id,
      check_id: evidence.checkId,
      outcome: evidence.outcome,
      payload_json: JSON.stringify(evidence),
      receipt_sha256: evidence.receiptSha256,
      observed_by: evidence.observedBy,
      observed_at: evidence.observedAt,
      created_at: evidence.createdAt,
    }]);

    const acceptance = {
      id: "acceptance-1",
      discipline: "technical",
      decision: "accepted",
      releaseVersion: "0.87.0-beta",
      basisSha256: "b".repeat(64),
      receiptSha256: "c".repeat(64),
      decidedBy: "E1",
      decidedAt: "2026-07-29T10:05:00.000Z",
    };
    await fixture.repository.insertReadinessAcceptance(acceptance);
    assert.deepEqual(await fixture.repository.listReadinessAcceptances(), [{
      id: acceptance.id,
      discipline: acceptance.discipline,
      decision: acceptance.decision,
      release_version: acceptance.releaseVersion,
      basis_sha256: acceptance.basisSha256,
      payload_json: JSON.stringify(acceptance),
      receipt_sha256: acceptance.receiptSha256,
      decided_by: acceptance.decidedBy,
      decided_at: acceptance.decidedAt,
    }]);

    fixture.insertRecoveryNotificationWithSqliteTestOperation({
      id: "notification-1",
      recipient: "E1",
      dedupeKey: "incident-1",
      createdAt: "2026-07-29 10:06:00",
    });
    assert.deepEqual(await fixture.repository.listRecoveryNotifications(), [{
      id: "notification-1",
      recipient: "E1",
      dedupeKey: "incident-1",
      readAt: null,
    }]);
    await fixture.repository.closeRecoveryNotification("notification-1");
    assert.ok((await fixture.repository.listRecoveryNotifications())[0].readAt);
    assert.deepEqual(await fixture.repository.latestRecoveryNotification(), {
      createdAt: "2026-07-29 10:06:00",
    });
  } finally {
    await fixture.close();
  }
});

test("v0.78: API-Trendvertrag liefert nur kompakte, UI-taugliche Punkte", () => {
  const payload = buildSystemCenterTrendPayload({
    trustSamples: [{ recordedAt: "2026-07-21T00:00:00.000Z", trustScore: 91, databaseBytes: 12_345 }],
    recoveryRuns: [{ at: "2026-07-21T02:00:00.000Z", backupDurationSeconds: 80, recoveryDurationSeconds: 140 }],
    integrityVerified: true,
  });
  assert.deepEqual(payload, {
    schemaVersion: 1,
    retentionDays: 180,
    integrityVerified: true,
    points: [{
      at: "2026-07-21T00:00:00.000Z",
      trustScore: 91,
      databaseBytes: 12_345,
      backupDurationSeconds: 80,
      recoveryDurationSeconds: 140,
    }],
  });
});

test("v0.78: technische Warnungen sind redigiert und pro Vorfall stabil dedupliziert", () => {
  const assurance = { configured: true, statusAvailable: true, integrityVerified: true };
  const first = systemCenterRecoveryAlert({
    recoveryAssurance: assurance,
    automation: {
      state: "critical",
      reasonCode: "AUTOMATION_APPLICATION_SMOKE_FAILED",
      lastRunAt: "2026-07-21T01:00:00.000Z",
    },
  });
  assert.equal(first.kind, "application_smoke_failed");
  const firstKey = systemCenterNotificationIncidentKey(first);
  assert.match(firstKey, /^system-recovery:application_smoke_failed:[a-f0-9]{24}$/);
  assert.equal(systemCenterNotificationIncidentKey({ ...first }), firstKey);
  const nextKey = systemCenterNotificationIncidentKey({ ...first, evidenceAt: "2026-07-22T01:00:00.000Z" });
  assert.notEqual(nextKey, firstKey);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("/var/"), false);
  assert.equal(serialized.includes("runId"), false);
  assert.equal(serialized.includes("employee"), false);

  const timerAlertFirst = systemCenterRecoveryAlert({
    recoveryAssurance: assurance,
    automation: {
      state: "critical",
      reasonCode: "AUTOMATION_TIMER_DISABLED",
      scheduler: { checkedAt: "2026-07-21T01:00:00.000Z" },
    },
  });
  const timerAlertLater = systemCenterRecoveryAlert({
    recoveryAssurance: assurance,
    automation: {
      state: "critical",
      reasonCode: "AUTOMATION_TIMER_DISABLED",
      scheduler: { checkedAt: "2026-07-22T01:00:00.000Z" },
    },
  });
  assert.equal(timerAlertFirst.evidenceAt, null);
  assert.equal(systemCenterNotificationIncidentKey(timerAlertFirst), systemCenterNotificationIncidentKey(timerAlertLater));
});

test("v0.78: Recovery-Warnungen durchlaufen Erstellen, Deduplizieren, Schliessen und neuen Vorfall", () => {
  const recipients = ["101"];
  const firstAlert = { kind: "overdue", evidenceAt: "2026-07-21T01:00:00.000Z" };
  const create = planSystemCenterNotificationSync({ alert: firstAlert, recipients, existing: [] });
  assert.deepEqual(create.createRecipients, ["101"]);
  assert.deepEqual(create.closeIds, []);

  const firstRow = { id: "first", recipient: "101", dedupeKey: create.dedupeKey, readAt: null };
  const duplicate = planSystemCenterNotificationSync({ alert: firstAlert, recipients, existing: [firstRow] });
  assert.deepEqual(duplicate.createRecipients, []);
  assert.deepEqual(duplicate.closeIds, []);

  const cleared = planSystemCenterNotificationSync({ alert: null, recipients, existing: [firstRow] });
  assert.deepEqual(cleared.createRecipients, []);
  assert.deepEqual(cleared.closeIds, ["first"]);

  const nextAlert = { kind: "overdue", evidenceAt: "2026-07-22T01:00:00.000Z" };
  const next = planSystemCenterNotificationSync({
    alert: nextAlert,
    recipients,
    existing: [{ ...firstRow, readAt: "2026-07-21T02:00:00.000Z" }],
  });
  assert.notEqual(next.dedupeKey, create.dedupeKey);
  assert.deepEqual(next.createRecipients, ["101"]);
  assert.deepEqual(next.closeIds, []);

  const recurringAlert = { kind: "automation_unavailable", evidenceAt: null };
  const recurringKey = systemCenterNotificationIncidentKey(recurringAlert);
  const activeRecurring = planSystemCenterNotificationSync({
    alert: recurringAlert,
    recipients,
    existing: [{ id: "timer", recipient: "101", dedupeKey: recurringKey, readAt: null }],
  });
  assert.deepEqual(activeRecurring.createRecipients, []);
  const recurrenceAfterClear = planSystemCenterNotificationSync({
    alert: recurringAlert,
    recipients,
    existing: [{ id: "timer", recipient: "101", dedupeKey: recurringKey, readAt: "2026-07-21T02:00:00.000Z" }],
  });
  assert.deepEqual(recurrenceAfterClear.createRecipients, ["101"]);
});
