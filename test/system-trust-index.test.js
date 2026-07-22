"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CARD_DEFINITIONS,
  CHECK_STATES,
  DISCLAIMER,
  buildSystemTrustIndex,
} = require("../lib/system-trust-index");

const NOW = "2026-07-22T08:00:00.000Z";
const MONITOR_AT = "2026-07-22T07:45:00.000Z";
const RESTORE_AT = "2026-07-21T23:00:00.000Z";

function healthyInput({ appSmoke = null, emailConfigured = false } = {}) {
  const input = {
    now: NOW,
    diagnostics: {
      mode: "server",
      publicUrl: "https://beta.example.test",
      process: { startedAt: "2026-07-21T20:00:00.000Z" },
      productionChecks: [
        { id: "runtime", ok: true },
        { id: "listener", ok: true },
        { id: "proxy", ok: true },
        { id: "backup", ok: true },
      ],
      database: { integrity: "ok", foreignKeys: true },
      storage: { data: { writable: true, directory: "C:\\secret\\must-not-leak" } },
      backups: {
        freshnessHours: 6,
        externalEnabled: true,
        externalWritable: true,
        latestAppAgeHours: 2,
        latestAppTimestampValid: true,
        latestApp: { committed: true, verified: true, modifiedAt: "2026-07-22T06:00:00.000Z", path: "/secret/app.db" },
        latestExternalTimestampValid: true,
        latestExternalAgeHours: 1.92,
        latestExternal: { committed: true, verified: true, modifiedAt: "2026-07-22T06:05:00.000Z", path: "/secret/external.db" },
        offsite: {
          applicable: true,
          configured: true,
          statusAvailable: true,
          state: "ok",
          lastSuccessAt: "2026-07-22T05:00:00.000Z",
          lastRepositoryCheckAt: "2026-07-22T05:10:00.000Z",
          lastFullCheckAt: "2026-07-22T05:20:00.000Z",
          unresolvedFailures: { backup: false, fullCheck: false, restoreTest: false },
          agesHours: { backup: 3, repositoryCheck: 2.83, fullCheck: 2.67, restoreTest: 9 },
          lastSnapshotId: "abcdef012345-secret-rest-must-not-leak",
        },
      },
      monitor: {
        configured: true,
        statusAvailable: true,
        state: "ok",
        complete: true,
        generatedAt: MONITOR_AT,
        ageHours: 0.25,
        checks: {
          appService: true,
          live: true,
          proxyService: true,
          sqlite: true,
          publicReady: true,
          tlsCertificate: true,
          hsts: true,
          diskSpace: true,
        },
      },
      hostSecurity: {
        configured: true,
        statusAvailable: true,
        state: "ok",
        checkedAt: "2026-07-22T07:00:00.000Z",
        ageHours: 1,
        pendingConfirmation: false,
        rebootRequired: false,
        checks: { automaticUpdates: true },
      },
      recoveryAssurance: {
        configured: true,
        statusAvailable: true,
        state: "ok",
        integrityVerified: true,
        checkedAt: NOW,
        generatedAt: RESTORE_AT,
        ageHours: 9,
        maximumAgeHours: 2400,
        stale: false,
        events: [{
          eventType: "application-smoke-not-run",
          occurredAt: RESTORE_AT,
          evidence: { receiptSha256Prefix: "deadbeefcafe" },
        }],
      },
      recovery: {
        isolatedRestoreTestAt: RESTORE_AT,
        isolatedRestoreTestAgeHours: 9,
        isolatedRestoreTestPending: false,
      },
      alerts: [],
    },
    updateStatus: { ok: true, updateAvailable: false, checkedAt: NOW, latestUrl: "https://secret.example/release" },
    automationStatus: {
      state: "healthy",
      reasonCode: "AUTOMATION_CURRENT",
      lastRunAt: RESTORE_AT,
    },
    notificationProviders: {
      email: emailConfigured
        ? { configured: true, valid: true, available: true, host: "smtp.secret.example" }
        : { configured: false, valid: true, available: false },
    },
  };
  if (appSmoke) input.applicationSmoke = appSmoke;
  return input;
}

function card(result, id) {
  return result.cards.find((entry) => entry.id === id);
}

function evidence(result, id) {
  return result.cards.flatMap((entry) => entry.checks).find((entry) => entry.id === id);
}

test("die freigegebenen Karten ergeben exakt 100 Gewichtspunkte", () => {
  assert.equal(CARD_DEFINITIONS.reduce((sum, entry) => sum + entry.points, 0), 100);
  assert.deepEqual(CARD_DEFINITIONS.map((entry) => entry.id), [
    "server", "database", "backup", "recovery", "tls", "notifications", "storage", "updates",
  ]);
});

test("application-smoke-not-run bleibt unbekannt und verhindert einen vorgetaeuschten 100er-Index", () => {
  const result = buildSystemTrustIndex(healthyInput());
  assert.equal(evidence(result, "recovery_application_smoke").state, CHECK_STATES.UNKNOWN);
  assert.equal(card(result, "recovery").state, CHECK_STATES.UNKNOWN);
  assert.equal(result.rawScore, 95);
  assert.equal(result.score, 95);
  assert.equal(result.coverage, 95);
  assert.equal(result.state, "attention");
  assert.match(result.disclaimer, /keine Verfügbarkeitsgarantie/);
});

test("ein explizit nachgewiesener Anwendungsstart erlaubt bei vollstaendiger Evidenz 100 Punkte", () => {
  const result = buildSystemTrustIndex(healthyInput({
    appSmoke: { state: "pass", checkedAt: "2026-07-21T23:05:00.000Z" },
  }));
  assert.equal(evidence(result, "recovery_application_smoke").state, CHECK_STATES.PASS);
  assert.equal(result.score, 100);
  assert.equal(result.coverage, 100);
  assert.equal(result.state, "healthy");
});

test("nicht konfiguriertes SMTP ist nicht zutreffend und wird nicht als Erfolg ausgegeben", () => {
  const result = buildSystemTrustIndex(healthyInput());
  assert.equal(card(result, "notifications").state, CHECK_STATES.NOT_APPLICABLE);
  assert.equal(card(result, "notifications").possiblePoints, 0);
  assert.equal(card(result, "notifications").coverage, null);
});

test("ein geladener SMTP-Provider ist ohne reale Zustellung nur teilweise nachgewiesen", () => {
  const result = buildSystemTrustIndex(healthyInput({
    appSmoke: { state: "pass", checkedAt: RESTORE_AT },
    emailConfigured: true,
  }));
  assert.equal(evidence(result, "notifications_provider").state, CHECK_STATES.PASS);
  assert.equal(evidence(result, "notifications_delivery").state, CHECK_STATES.UNKNOWN);
  assert.equal(card(result, "notifications").state, CHECK_STATES.UNKNOWN);
  assert.equal(result.score, 97);
  assert.equal(result.state, "attention");
});

test("der vereinbarte Eingabevertrag akzeptiert status und notificationStatus", () => {
  const input = healthyInput({ appSmoke: { state: "pass", checkedAt: RESTORE_AT } });
  input.status = {
    mode: input.diagnostics.mode,
    publicUrl: input.diagnostics.publicUrl,
    alerts: input.diagnostics.alerts,
  };
  input.notificationStatus = { providers: input.notificationProviders };
  delete input.notificationProviders;
  const result = buildSystemTrustIndex(input);
  assert.equal(result.cards.length, 8);
  assert.equal(card(result, "notifications").state, CHECK_STATES.NOT_APPLICABLE);
  assert.deepEqual(Object.keys(result), ["score", "rawScore", "coverage", "state", "label", "capReason", "disclaimer", "cards"]);
});

test("ein kritischer Datenbankfehler begrenzt auch einen sonst hohen Rohwert auf 49", () => {
  const input = healthyInput({ appSmoke: { state: "pass", checkedAt: RESTORE_AT } });
  input.diagnostics.database.integrity = "corrupt";
  const result = buildSystemTrustIndex(input);
  assert.ok(result.rawScore > 49);
  assert.equal(result.score, 49);
  assert.equal(result.capReason, "CRITICAL_CHECK_FAILED");
  assert.equal(result.state, "critical");
});

test("ein kritischer Diagnosealarm begrenzt den Index ohne doppelten Punkteabzug", () => {
  const input = healthyInput({ appSmoke: { state: "pass", checkedAt: RESTORE_AT } });
  input.diagnostics.alerts.push({ severity: "critical", message: "interner geheimer Pfad C:\\secret" });
  const result = buildSystemTrustIndex(input);
  assert.equal(result.rawScore, 100);
  assert.equal(result.score, 49);
  assert.equal(result.capReason, "CRITICAL_ALERT_PRESENT");
});

test("zu geringe Evidenzabdeckung ist transparent und kann keinen hohen Index erzeugen", () => {
  const result = buildSystemTrustIndex({
    now: NOW,
    diagnostics: { mode: "server", publicUrl: "https://beta.example.test", alerts: [] },
    notificationProviders: { email: { configured: false } },
  });
  assert.ok(result.coverage < 60);
  assert.ok(result.score <= 49);
  assert.equal(result.capReason, "EVIDENCE_COVERAGE_BELOW_60");
  assert.equal(result.state, "unverified");
});

test("ein verfuegbares Update ist Aufmerksamkeit, aber kein kritischer Fehler", () => {
  const input = healthyInput({ appSmoke: { state: "pass", checkedAt: RESTORE_AT } });
  input.updateStatus.updateAvailable = true;
  const result = buildSystemTrustIndex(input);
  assert.equal(evidence(result, "updates_app_current").state, CHECK_STATES.FAIL);
  assert.equal(result.capReason, null);
  assert.equal(result.score, 99);
  assert.equal(result.state, "attention");
});

test("ein veralteter Monitor macht abhaengige Nachweise unbekannt statt gruener", () => {
  const input = healthyInput({ appSmoke: { state: "pass", checkedAt: RESTORE_AT } });
  input.diagnostics.monitor.state = "warning";
  input.diagnostics.monitor.ageHours = 3;
  const result = buildSystemTrustIndex(input);
  assert.equal(evidence(result, "server_monitor_current").state, CHECK_STATES.UNKNOWN);
  assert.equal(evidence(result, "database_monitor_integrity").state, CHECK_STATES.UNKNOWN);
  assert.equal(evidence(result, "tls_certificate").state, CHECK_STATES.UNKNOWN);
  assert.equal(evidence(result, "storage_disk_space").state, CHECK_STATES.UNKNOWN);
  assert.ok(result.coverage < 90);
  assert.equal(result.state, "attention");
});

test("veraltete interne und externe Sicherungen bleiben unbekannt", () => {
  const input = healthyInput({ appSmoke: { state: "pass", checkedAt: RESTORE_AT } });
  input.diagnostics.backups.latestAppAgeHours = 7;
  input.diagnostics.backups.latestExternalAgeHours = 7;
  input.diagnostics.mode = "local";
  const result = buildSystemTrustIndex(input);
  assert.equal(evidence(result, "backup_internal").state, CHECK_STATES.UNKNOWN);
  assert.equal(evidence(result, "backup_external").state, CHECK_STATES.UNKNOWN);
  assert.equal(card(result, "backup").state, CHECK_STATES.UNKNOWN);
  assert.ok(result.coverage < 100);
});

test("ein veralteter Assurance-Lauf, Restore und App-Smoke bleiben unbekannt", () => {
  const input = healthyInput({
    appSmoke: { state: "pass", checkedAt: "2026-03-01T00:00:00.000Z" },
  });
  input.diagnostics.recoveryAssurance.state = "warning";
  input.diagnostics.recoveryAssurance.stale = false;
  input.diagnostics.recoveryAssurance.ageHours = 3432;
  input.diagnostics.recovery.isolatedRestoreTestAt = "2026-03-01T00:00:00.000Z";
  input.diagnostics.recovery.isolatedRestoreTestAgeHours = 3432;
  const result = buildSystemTrustIndex(input);
  assert.equal(evidence(result, "recovery_full_run").state, CHECK_STATES.UNKNOWN);
  assert.equal(evidence(result, "recovery_isolated_restore").state, CHECK_STATES.UNKNOWN);
  assert.equal(evidence(result, "recovery_application_smoke").state, CHECK_STATES.UNKNOWN);
  assert.equal(card(result, "recovery").state, CHECK_STATES.UNKNOWN);
  assert.ok(result.score < 100);
});

test("ein veralteter Host-Sicherheitsstatus bleibt bei Updates unbekannt", () => {
  const input = healthyInput({ appSmoke: { state: "pass", checkedAt: RESTORE_AT } });
  input.diagnostics.hostSecurity.state = "warning";
  input.diagnostics.hostSecurity.ageHours = 104;
  input.diagnostics.hostSecurity.lastErrorCode = "HOST_SECURITY_STATUS_STALE";
  const result = buildSystemTrustIndex(input);
  assert.equal(evidence(result, "updates_host_automatic").state, CHECK_STATES.UNKNOWN);
  assert.equal(evidence(result, "updates_restart_clear").state, CHECK_STATES.UNKNOWN);
  assert.equal(card(result, "updates").state, CHECK_STATES.UNKNOWN);
});

test("ein expliziter alter Host-Fehler bleibt sichtbar statt unbekannt zu werden", () => {
  const input = healthyInput({ appSmoke: { state: "pass", checkedAt: RESTORE_AT } });
  input.diagnostics.hostSecurity.state = "error";
  input.diagnostics.hostSecurity.ageHours = 104;
  input.diagnostics.hostSecurity.checks.automaticUpdates = false;
  input.diagnostics.hostSecurity.rebootRequired = true;
  const result = buildSystemTrustIndex(input);
  assert.equal(evidence(result, "updates_host_automatic").state, CHECK_STATES.FAIL);
  assert.equal(evidence(result, "updates_restart_clear").state, CHECK_STATES.FAIL);
});

test("Ausgabe ist deterministisch, redigiert und enthaelt nur statische Erklaerungen", () => {
  const input = healthyInput();
  const first = buildSystemTrustIndex(input);
  const second = buildSystemTrustIndex(input);
  assert.deepEqual(first, second);
  const serialized = JSON.stringify(first);
  for (const secret of ["C:\\secret", "/secret/app.db", "/secret/external.db", "smtp.secret.example", "secret.example/release", "abcdef012345-secret"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal(first.disclaimer, DISCLAIMER);
  assert.equal(Object.hasOwn(first, "diagnostics"), false);
  assert.deepEqual(Object.keys(first), ["score", "rawScore", "coverage", "state", "label", "capReason", "disclaimer", "cards"]);
});

test("ungueltige oder fehlende Eingaben werfen nicht und bleiben unbekannt", () => {
  assert.doesNotThrow(() => buildSystemTrustIndex(null));
  const result = buildSystemTrustIndex({ now: "ungueltig", diagnostics: "ungueltig" });
  assert.equal(result.cards.length, 8);
  assert.ok(result.cards.every((entry) => Object.values(CHECK_STATES).includes(entry.state)));
});
