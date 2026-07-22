"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const {
  buildSystemCenterTrendPayload,
  createSystemCenterMetricsStore,
  deriveAutomationStatus,
  planSystemCenterNotificationSync,
  recoveryTrendRuns,
  systemCenterNotificationIncidentKey,
  systemCenterRecoveryAlert,
} = require("../lib/system-center-metrics");

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

test("v0.78: lokale Trust-Metriken sind gedrosselt, begrenzt und manipulationsauffaellig", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = createSystemCenterMetricsStore(db, { retentionDays: 30, sampleIntervalHours: 6 });
    const input = {
      trustIndex: { score: 93, coverage: 100, state: "healthy" },
      resources: { storage: { databaseBytes: 4096, freeBytes: 8192 } },
      automation: { state: "healthy" },
      now: new Date("2026-07-21T01:10:00.000Z"),
    };
    assert.equal(store.record(input), true);
    assert.equal(store.record({ ...input, now: new Date("2026-07-21T05:59:00.000Z") }), false);
    assert.equal(store.record({ ...input, trustIndex: { score: 94, coverage: 100, state: "healthy" }, now: new Date("2026-07-21T07:00:00.000Z") }), true);
    const verified = store.read();
    assert.equal(verified.integrityVerified, true);
    assert.equal(verified.samples.length, 2);
    assert.equal(verified.samples[0].databaseBytes, 4096);

    db.prepare("UPDATE system_center_trust_metrics SET trust_score = 12 WHERE interval_key = ?")
      .run(verified.samples[0].intervalKey);
    assert.deepEqual(store.read(), { integrityVerified: false, samples: [] });
  } finally {
    db.close();
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
