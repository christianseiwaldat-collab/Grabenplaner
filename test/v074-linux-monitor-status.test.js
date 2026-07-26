"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CHECK_IDS,
  CHECK_LABELS,
  FORMAT,
  LEGACY_CHECK_IDS,
  RESTART_COOLDOWN_MS,
  emptyStatus,
  errorStatus,
  evaluateStatus,
  migrateLegacyStatus,
  parseTestOutput,
  restartAttemptStatus,
  restartResultStatus,
  validateStatus,
} = require("../server-tools/linux/monitor/lib/monitor-status");

function passingOutput(detail = "ok") {
  return [...CHECK_LABELS.keys()].map((label) => `OK\t${label}\t${detail}`).join("\n");
}

function checksWith(overrides = {}) {
  return Object.fromEntries(CHECK_IDS.map((id) => [id, overrides[id] ?? true]));
}

test("v0.86.2 migrates the exact legacy monitor schema before the next protected write", () => {
  const legacy = {
    format: FORMAT,
    schemaVersion: 1,
    generatedAt: "2026-07-26T15:35:00.000Z",
    state: "ok",
    complete: true,
    consecutiveLiveFailures: 0,
    lastRestartAt: null,
    checks: Object.fromEntries(LEGACY_CHECK_IDS.map((id) => [id, true])),
    recovery: { attempted: false, successful: false, suppressed: false },
    lastError: null,
  };
  const migrated = migrateLegacyStatus(legacy);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.state, "warning");
  assert.equal(migrated.complete, false);
  assert.deepEqual(Object.keys(migrated.checks), CHECK_IDS);
  for (const id of LEGACY_CHECK_IDS) assert.equal(migrated.checks[id], true, id);
  for (const id of CHECK_IDS.filter((id) => !LEGACY_CHECK_IDS.includes(id))) {
    assert.equal(migrated.checks[id], false, id);
  }
});

test("v0.74 monitor persists only allowlisted boolean checks and discards diagnostic details", () => {
  const sensitive = "https://user:secret@example.invalid/C:/private/token";
  const checks = parseTestOutput(passingOutput(sensitive), 0);
  assert.deepEqual(Object.keys(checks), CHECK_IDS);
  assert.ok(Object.values(checks).every((value) => value === true));

  const result = evaluateStatus(emptyStatus(new Date("2026-07-19T08:00:00.000Z")), checks,
    new Date("2026-07-19T08:05:00.000Z"));
  const serialized = JSON.stringify(result.status);
  assert.equal(result.status.format, FORMAT);
  assert.equal(result.status.schemaVersion, 2);
  assert.equal(result.status.state, "ok");
  assert.equal(result.status.complete, true);
  assert.equal(result.restartEligible, false);
  assert.doesNotMatch(serialized, /secret|example\.invalid|private|token/i);
  assert.deepEqual(Object.keys(result.status.checks), CHECK_IDS);
});

test("v0.86.2 maps the complete hardened HTTP-header output contract", () => {
  assert.deepEqual(
    [...CHECK_LABELS.entries()].filter(([, id]) => [
      "frameOptions",
      "permissionsPolicy",
      "crossOriginOpenerPolicy",
      "crossOriginResourcePolicy",
      "permittedCrossDomainPolicies",
    ].includes(id)),
    [
      ["X-Frame-Options", "frameOptions"],
      ["Permissions-Policy", "permissionsPolicy"],
      ["Cross-Origin-Opener-Policy", "crossOriginOpenerPolicy"],
      ["Cross-Origin-Resource-Policy", "crossOriginResourcePolicy"],
      ["X-Permitted-Cross-Domain-Policies", "permittedCrossDomainPolicies"],
    ],
  );
});

test("v0.74 monitor rejects unknown, duplicate, incomplete and exit-code-inconsistent output", () => {
  assert.throws(() => parseTestOutput(`${passingOutput()}\nOK\tUnbekannt\tWert`, 0), /CHECK_OUTPUT_INVALID/);
  const first = [...CHECK_LABELS.keys()][0];
  assert.throws(() => parseTestOutput(`${passingOutput()}\nOK\t${first}\tNoch einmal`, 0), /CHECK_OUTPUT_INVALID/);
  assert.throws(() => parseTestOutput("OK\tInterne Liveness\tok", 0), /CHECK_OUTPUT_INVALID/);
  assert.throws(() => parseTestOutput(passingOutput(), 1), /CHECK_OUTPUT_INVALID/);
});

test("v0.74 restarts only after three live failures and suppresses another attempt for 30 minutes", () => {
  let status = emptyStatus(new Date("2026-07-19T08:00:00.000Z"));
  const failedLive = checksWith({ appService: false, live: false });
  for (const [index, minute] of [0, 5, 10].entries()) {
    const evaluation = evaluateStatus(status, failedLive, new Date(`2026-07-19T08:${String(minute).padStart(2, "0")}:00.000Z`));
    status = evaluation.status;
    assert.equal(evaluation.restartEligible, index === 2);
  }
  assert.equal(status.consecutiveLiveFailures, 3);

  status = restartAttemptStatus(status, new Date("2026-07-19T08:10:01.000Z"));
  status = restartResultStatus(status, false, new Date("2026-07-19T08:10:30.000Z"));
  assert.equal(status.lastError.code, "LIVE_RESTART_FAILED");
  const cooldown = evaluateStatus(status, failedLive,
    new Date(new Date(status.lastRestartAt).getTime() + RESTART_COOLDOWN_MS - 1));
  assert.equal(cooldown.restartEligible, false);
  assert.equal(cooldown.status.recovery.suppressed, true);

  const later = evaluateStatus(cooldown.status, failedLive,
    new Date(new Date(status.lastRestartAt).getTime() + RESTART_COOLDOWN_MS));
  assert.equal(later.restartEligible, true);
});

test("v0.74 ready, backup and offsite failures remain warnings and never request a restart", () => {
  let status = emptyStatus(new Date("2026-07-19T08:00:00.000Z"));
  const nonLiveFailures = checksWith({ ready: false, backupFresh: false, backupIntegrity: false, offsite: false });
  for (const minute of [5, 10, 15, 20]) {
    const evaluation = evaluateStatus(status, nonLiveFailures,
      new Date(`2026-07-19T08:${String(minute).padStart(2, "0")}:00.000Z`));
    status = evaluation.status;
    assert.equal(evaluation.restartEligible, false);
    assert.equal(status.consecutiveLiveFailures, 0);
    assert.equal(status.state, "warning");
  }
});

test("v0.74 monitor error state is fixed, bounded and schema-exact", () => {
  const now = new Date("2026-07-19T09:00:00.000Z");
  const failed = errorStatus(emptyStatus(now), "MONITOR_RUN_FAILED", now);
  assert.equal(validateStatus(failed), failed);
  assert.deepEqual(failed.lastError, { code: "MONITOR_RUN_FAILED", at: now.toISOString() });
  assert.throws(() => validateStatus({ ...failed, leakedPath: "/etc/grabenplaner/grabenplaner.env" }), /Schema/);
  assert.throws(() => errorStatus(failed, "https://secret.invalid"), /freigegebener/);

  const recovered = restartResultStatus(
    restartAttemptStatus(
      evaluateStatus(
        evaluateStatus(
          evaluateStatus(emptyStatus(now), checksWith({ appService: false, live: false }), new Date("2026-07-19T09:01:00.000Z")).status,
          checksWith({ appService: false, live: false }), new Date("2026-07-19T09:06:00.000Z")).status,
        checksWith({ appService: false, live: false }), new Date("2026-07-19T09:11:00.000Z")).status,
      new Date("2026-07-19T09:11:01.000Z")),
    true,
    new Date("2026-07-19T09:11:10.000Z"),
  );
  assert.equal(recovered.checks.live, true);
  assert.equal(recovered.consecutiveLiveFailures, 0);
  assert.equal(recovered.recovery.successful, true);
  assert.equal(recovered.lastError, null);
});
