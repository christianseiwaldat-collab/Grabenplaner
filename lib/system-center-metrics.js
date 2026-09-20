"use strict";

const crypto = require("node:crypto");
const {
  assertSystemCenterMetricsRepository,
} = require("./persistence/repositories/system-center-metrics");

const METRICS_SCHEMA_VERSION = 1;
const DEFAULT_RETENTION_DAYS = 180;
const DEFAULT_SAMPLE_INTERVAL_HOURS = 6;
const DEFAULT_AUTOMATION_INTERVAL_HOURS = 24;
const DEFAULT_AUTOMATION_GRACE_HOURS = 12;
const MAX_RETENTION_DAYS = 400;
const MAX_RECOVERY_TREND_RUNS = 1_000;
const TRUST_STATES = new Set(["healthy", "attention", "critical", "unverified"]);
const AUTOMATION_STATES = new Set(["healthy", "attention", "critical", "unconfigured"]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function finiteInteger(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return null;
  return Math.max(minimum, Math.min(maximum, number));
}

function timestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function normalizedNow(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return Number.isFinite(milliseconds) ? milliseconds : Date.now();
}

function elapsedSeconds(from, to) {
  const fromMs = Date.parse(String(from || ""));
  const toMs = Date.parse(String(to || ""));
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return null;
  return Math.min(31_536_000, Math.round((toMs - fromMs) / 1_000));
}

function recoveryTrendRuns(events, { now = new Date(), retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  const nowMs = normalizedNow(now);
  const days = finiteInteger(retentionDays, { minimum: 1, maximum: MAX_RETENTION_DAYS }) || DEFAULT_RETENTION_DAYS;
  const cutoffMs = nowMs - (days * 24 * 60 * 60 * 1_000);
  const runs = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const payload = asObject(event?.payload);
    const occurredAt = timestamp(payload.occurredAt);
    if (!occurredAt || !payload.runId) continue;
    const current = runs.get(payload.runId) || {
      trigger: String(payload.trigger || ""),
      startedAt: null,
      completedAt: null,
      status: "running",
      phases: new Map(),
    };
    if (payload.eventType === "full-assurance-started") current.startedAt = occurredAt;
    else if (["full-assurance-passed", "full-assurance-failed"].includes(payload.eventType)) {
      current.completedAt = occurredAt;
      current.status = payload.eventType === "full-assurance-passed" ? "passed" : "failed";
    } else if (String(payload.eventType || "").endsWith("-passed")
      || ["application-smoke-failed", "application-smoke-not-run"].includes(payload.eventType)) {
      current.phases.set(payload.eventType, occurredAt);
    }
    runs.set(payload.runId, current);
  }
  return [...runs.values()]
    .filter((run) => run.startedAt && run.completedAt && Date.parse(run.completedAt) >= cutoffMs
      && Date.parse(run.completedAt) <= nowMs + (5 * 60 * 1_000))
    .map((run) => {
      const oauthAt = run.phases.get("oauth-policy-passed") || run.startedAt;
      const backupAt = run.phases.get("backup-passed") || null;
      const repositoryAt = run.phases.get("repository-check-passed") || null;
      const restoreAt = run.phases.get("restore-test-passed") || null;
      const smokeState = run.phases.has("application-smoke-passed") ? "passed"
        : run.phases.has("application-smoke-failed") ? "failed"
          : run.phases.has("application-smoke-not-run") ? "not_run" : "unknown";
      return {
        at: run.completedAt,
        trigger: run.trigger,
        status: run.status,
        backupDurationSeconds: backupAt ? elapsedSeconds(oauthAt, backupAt) : null,
        recoveryDurationSeconds: restoreAt ? elapsedSeconds(repositoryAt || backupAt || run.startedAt, restoreAt) : null,
        fullDurationSeconds: elapsedSeconds(run.startedAt, run.completedAt),
        applicationSmokeState: smokeState,
      };
    })
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .slice(-MAX_RECOVERY_TREND_RUNS);
}

function deriveAutomationStatus(recoveryAssurance, {
  now = new Date(),
  intervalHours = DEFAULT_AUTOMATION_INTERVAL_HOURS,
  graceHours = DEFAULT_AUTOMATION_GRACE_HOURS,
} = {}) {
  const assurance = asObject(recoveryAssurance);
  const scheduler = asObject(assurance.scheduler);
  const schedulerEvidenceTrusted = scheduler.evidenceTrusted === true;
  const timerInstalled = schedulerEvidenceTrusted && scheduler.timerInstalled === true;
  const timerEnabled = schedulerEvidenceTrusted && scheduler.timerEnabled === true;
  const enabled = assurance.configured === true && timerInstalled && timerEnabled;
  const grace = finiteInteger(graceHours, { minimum: 1, maximum: 72 })
    || DEFAULT_AUTOMATION_GRACE_HOURS;
  const runs = Array.isArray(assurance.trendRuns) ? assurance.trendRuns : [];
  const nightly = runs.filter((run) => run?.trigger === "scheduled-nightly" && timestamp(run.at));
  const weekly = runs.filter((run) => run?.trigger === "scheduled-weekly" && timestamp(run.at));
  const latest = nightly.at(-1) || null;
  const latestLegacy = weekly.at(-1) || null;
  const effectiveInterval = finiteInteger(intervalHours, { minimum: 24, maximum: 24 * 31 })
    || DEFAULT_AUTOMATION_INTERVAL_HOURS;
  const lastRunAt = timestamp(latest?.at);
  const derivedNextRunAt = lastRunAt
    ? new Date(Date.parse(lastRunAt) + (effectiveInterval * 60 * 60 * 1_000)).toISOString() : null;
  const nextRunAt = schedulerEvidenceTrusted ? (timestamp(scheduler.nextElapse) || derivedNextRunAt) : null;
  const nowMs = normalizedNow(now);
  const overdue = enabled && Boolean(derivedNextRunAt
    && nowMs > Date.parse(derivedNextRunAt) + (grace * 60 * 60 * 1_000));
  const smokeState = String(latest?.applicationSmokeState || "unknown");
  let state = "attention";
  let reasonCode = "AUTOMATION_SCHEDULER_EVIDENCE_MISSING";
  if (assurance.configured !== true) {
    state = "unconfigured";
    reasonCode = "AUTOMATION_NOT_CONFIGURED";
  } else if (assurance.statusAvailable === false || assurance.integrityVerified === false) {
    state = "critical";
    reasonCode = "AUTOMATION_HISTORY_UNVERIFIED";
  } else if (!schedulerEvidenceTrusted) {
    state = "attention";
    reasonCode = "AUTOMATION_SCHEDULER_EVIDENCE_MISSING";
  } else if (!timerInstalled) {
    state = "critical";
    reasonCode = "AUTOMATION_TIMER_NOT_INSTALLED";
  } else if (!timerEnabled) {
    state = "critical";
    reasonCode = "AUTOMATION_TIMER_DISABLED";
  } else if (latest?.status === "failed" || smokeState === "failed") {
    state = "critical";
    reasonCode = smokeState === "failed" ? "AUTOMATION_APPLICATION_SMOKE_FAILED" : "AUTOMATION_RUN_FAILED";
  } else if (overdue) {
    state = "critical";
    reasonCode = "AUTOMATION_OVERDUE";
  } else if (!latest && latestLegacy) {
    state = "attention";
    reasonCode = "AUTOMATION_LEGACY_WEEKLY_ONLY";
  } else if (!latest) {
    state = "attention";
    reasonCode = "AUTOMATION_AWAITING_FIRST_RUN";
  } else if (latest.status !== "passed" || smokeState !== "passed") {
    state = "attention";
    reasonCode = smokeState === "not_run" ? "AUTOMATION_APPLICATION_SMOKE_NOT_RUN" : "AUTOMATION_EVIDENCE_INCOMPLETE";
  } else {
    state = "healthy";
    reasonCode = "AUTOMATION_CURRENT";
  }
  return {
    state,
    enabled,
    scheduleLabel: enabled ? "Täglich, nachts" : latestLegacy && !latest ? "Wöchentlich, nachts (Legacy)" : "Täglich, nachts",
    lastRunAt,
    latestFullProofAt: assurance.integrityVerified === true && assurance.statusAvailable === true
      ? timestamp(runs.filter((run) => run?.status === "passed" && run?.applicationSmokeState === "passed").at(-1)?.at) : null,
    nextRunAt,
    overdue: Boolean(overdue),
    applicationSmokeState: ["passed", "failed", "not_run", "unknown"].includes(smokeState) ? smokeState : "unknown",
    reasonCode,
    scheduler: {
      evidenceTrusted: schedulerEvidenceTrusted,
      timerInstalled: schedulerEvidenceTrusted ? scheduler.timerInstalled === true : null,
      timerEnabled: schedulerEvidenceTrusted ? scheduler.timerEnabled === true : null,
      nextElapse: schedulerEvidenceTrusted ? timestamp(scheduler.nextElapse) : null,
      checkedAt: schedulerEvidenceTrusted ? timestamp(scheduler.checkedAt) : null,
    },
  };
}

function systemCenterRecoveryAlert({ enabled = true, recoveryAssurance, automation } = {}) {
  const assurance = asObject(recoveryAssurance);
  const automatic = asObject(automation);
  if (!enabled || assurance.configured !== true) return null;
  if (assurance.statusAvailable !== true || assurance.integrityVerified !== true) {
    return {
      kind: "history_unverified",
      // checkedAt changes on every probe. Keep one stable incident active
      // until the history can be verified again.
      evidenceAt: null,
      title: "Recovery Assurance technisch prüfen",
      message: "Die signierte Recovery-Historie konnte nicht verlässlich bestätigt werden.",
    };
  }
  if (assurance.state === "error") {
    const latestRun = Array.isArray(assurance.trendRuns) ? assurance.trendRuns.at(-1) : null;
    const smokeFailure = assurance.lastErrorCode === "APPLICATION_SMOKE_FAILED";
    return {
      kind: smokeFailure ? "application_smoke_failed" : "run_failed",
      evidenceAt: timestamp(latestRun?.at) || timestamp(assurance.generatedAt),
      title: smokeFailure ? "Anwendungsprüfung nach Restore fehlgeschlagen" : "Recovery-Assurance-Lauf fehlgeschlagen",
      message: smokeFailure
        ? "Der isolierte Restore war nicht bis zum sicheren Anwendungsstart erfolgreich."
        : "Der Wiederherstellungsnachweis benötigt eine technische Prüfung.",
    };
  }
  if (automatic.state !== "critical") return null;
  if (automatic.reasonCode === "AUTOMATION_OVERDUE") {
    return {
      kind: "overdue",
      evidenceAt: timestamp(automatic.lastRunAt),
      title: "Recovery-Assurance-Lauf überfällig",
      message: "Der automatische Wiederherstellungsnachweis ist überfällig und muss technisch geprüft werden.",
    };
  }
  if (automatic.reasonCode === "AUTOMATION_APPLICATION_SMOKE_FAILED") {
    return {
      kind: "application_smoke_failed",
      evidenceAt: timestamp(automatic.lastRunAt),
      title: "Anwendungsprüfung nach Restore fehlgeschlagen",
      message: "Der isolierte Restore war nicht bis zum sicheren Anwendungsstart erfolgreich.",
    };
  }
  if (["AUTOMATION_TIMER_NOT_INSTALLED", "AUTOMATION_TIMER_DISABLED"].includes(automatic.reasonCode)) {
    return {
      kind: "automation_unavailable",
      // Scheduler checkedAt is observation time, not a transition timestamp.
      evidenceAt: null,
      title: "Nächtliche Recovery-Automatik nicht verfügbar",
      message: "Der geschützte Nacht-Timer ist nicht aktiv und muss technisch geprüft werden.",
    };
  }
  return {
    kind: "run_failed",
    evidenceAt: timestamp(automatic.lastRunAt),
    title: "Recovery-Assurance-Lauf fehlgeschlagen",
    message: "Der automatische Wiederherstellungsnachweis benötigt eine technische Prüfung.",
  };
}

function systemCenterNotificationIncidentKey(alert) {
  if (!alert?.kind) return "";
  const incidentHash = crypto.createHash("sha256")
    .update(`${String(alert.kind)}\0${String(alert.evidenceAt || "unknown")}`, "utf8").digest("hex").slice(0, 24);
  return `system-recovery:${String(alert.kind).slice(0, 40)}:${incidentHash}`;
}

function planSystemCenterNotificationSync({ alert, recipients, existing } = {}) {
  const eligibleRecipients = [...new Set((Array.isArray(recipients) ? recipients : [])
    .map((value) => String(value || "").trim()).filter(Boolean))].sort();
  const eligible = new Set(eligibleRecipients);
  const rows = Array.isArray(existing) ? existing : [];
  const dedupeKey = systemCenterNotificationIncidentKey(alert);
  const closeIds = rows.filter((row) => row && row.readAt === null
    && (!alert || row.dedupeKey !== dedupeKey || !eligible.has(String(row.recipient || ""))))
    .map((row) => String(row.id || "")).filter(Boolean);
  const createRecipients = alert ? eligibleRecipients.filter((recipient) => !rows.some((row) => row
    && row.readAt === null && String(row.recipient || "") === recipient && row.dedupeKey === dedupeKey)) : [];
  return { dedupeKey, closeIds, createRecipients };
}

function canonicalSample(sample) {
  return JSON.stringify({
    intervalKey: sample.intervalKey,
    recordedAt: sample.recordedAt,
    trustScore: sample.trustScore,
    coverage: sample.coverage,
    trustState: sample.trustState,
    databaseBytes: sample.databaseBytes,
    storageFreeBytes: sample.storageFreeBytes,
    automationState: sample.automationState,
    previousHash: sample.previousHash,
  });
}

function sampleHash(sample) {
  return crypto.createHash("sha256").update(canonicalSample(sample), "utf8").digest("hex");
}

function createSystemCenterMetricsStore(repository, {
  retentionDays = DEFAULT_RETENTION_DAYS,
  sampleIntervalHours = DEFAULT_SAMPLE_INTERVAL_HOURS,
} = {}) {
  assertSystemCenterMetricsRepository(repository);
  const days = finiteInteger(retentionDays, { minimum: 30, maximum: MAX_RETENTION_DAYS }) || DEFAULT_RETENTION_DAYS;
  const intervalHours = finiteInteger(sampleIntervalHours, { minimum: 1, maximum: 24 }) || DEFAULT_SAMPLE_INTERVAL_HOURS;
  const maximumSamples = Math.min(10_000, Math.ceil((days * 24) / intervalHours) + 4);

  function normalizeSample({ trustIndex, resources, automation, now = new Date() }) {
    const nowMs = normalizedNow(now);
    const intervalMs = intervalHours * 60 * 60 * 1_000;
    const slotMs = Math.floor(nowMs / intervalMs) * intervalMs;
    const recordedAt = new Date(slotMs).toISOString();
    const trust = asObject(trustIndex);
    const technical = asObject(resources);
    const state = TRUST_STATES.has(trust.state) ? trust.state : "unverified";
    const automationState = AUTOMATION_STATES.has(automation?.state) ? automation.state : "unconfigured";
    return {
      intervalKey: recordedAt,
      recordedAt,
      trustScore: finiteInteger(trust.score, { maximum: 100 }) ?? 0,
      coverage: finiteInteger(trust.coverage, { maximum: 100 }) ?? 0,
      trustState: state,
      databaseBytes: finiteInteger(technical.storage?.databaseBytes),
      storageFreeBytes: finiteInteger(technical.storage?.freeBytes),
      automationState,
      previousHash: null,
    };
  }

  function verifiedRows(rows) {
    if (!Array.isArray(rows) || rows.length > maximumSamples) {
      return { integrityVerified: false, samples: [], lastHash: null };
    }
    let previousHash = null;
    const samples = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const sample = {
        intervalKey: String(row.intervalKey || ""),
        recordedAt: timestamp(row.recordedAt),
        trustScore: finiteInteger(row.trustScore, { maximum: 100 }),
        coverage: finiteInteger(row.coverage, { maximum: 100 }),
        trustState: String(row.trustState || ""),
        databaseBytes: row.databaseBytes === null ? null : finiteInteger(row.databaseBytes),
        storageFreeBytes: row.storageFreeBytes === null ? null : finiteInteger(row.storageFreeBytes),
        automationState: String(row.automationState || ""),
        previousHash: row.previousHash === null ? null : String(row.previousHash),
      };
      const validShape = sample.recordedAt === sample.intervalKey && sample.trustScore !== null
        && sample.coverage !== null && TRUST_STATES.has(sample.trustState)
        && AUTOMATION_STATES.has(sample.automationState)
        && (sample.previousHash === null || /^[a-f0-9]{64}$/.test(sample.previousHash))
        && /^[a-f0-9]{64}$/.test(String(row.sampleHash || ""));
      const validLink = index === 0 || sample.previousHash === previousHash;
      if (!validShape || !validLink || sampleHash(sample) !== row.sampleHash) {
        return { integrityVerified: false, samples: [], lastHash: null };
      }
      previousHash = row.sampleHash;
      samples.push(sample);
    }
    return { integrityVerified: true, samples, lastHash: previousHash };
  }

  async function prune(transaction, nowMs) {
    const cutoff = new Date(nowMs - (days * 24 * 60 * 60 * 1_000)).toISOString();
    await transaction.deleteBefore(cutoff);
    const overflow = Number((await transaction.overflowCount(maximumSamples))?.count || 0);
    if (overflow > 0) {
      const rows = await transaction.oldestIntervalKeys(overflow);
      for (const row of rows) await transaction.deleteByIntervalKey(row.intervalKey);
    }
  }

  async function record(input) {
    const sample = normalizeSample(input);
    return repository.transaction(async (transaction) => {
      const current = verifiedRows(await transaction.listSamples(maximumSamples + 1));
      if (!current.integrityVerified
        || current.samples.some((entry) => entry.intervalKey === sample.intervalKey)) {
        return false;
      }
      const latest = current.samples.at(-1);
      if (latest && Date.parse(sample.recordedAt) < Date.parse(latest.recordedAt)) return false;
      sample.previousHash = current.lastHash;
      const result = await transaction.insertSample({
        ...sample,
        sampleHash: sampleHash(sample),
      });
      if (result.rowsAffected !== 1) return false;
      await prune(transaction, normalizedNow(input.now));
      return true;
    });
  }

  async function read() {
    const { integrityVerified, samples } = verifiedRows(
      await repository.listSamples(maximumSamples + 1),
    );
    return { integrityVerified, samples };
  }

  return { record, read, retentionDays: days, sampleIntervalHours: intervalHours, maximumSamples };
}

function buildSystemCenterTrendPayload({ trustSamples, recoveryRuns, integrityVerified = true,
  retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  const points = new Map();
  for (const sample of Array.isArray(trustSamples) ? trustSamples : []) {
    const at = timestamp(sample.recordedAt);
    if (!at) continue;
    const date = at.slice(0, 10);
    const current = points.get(date);
    if (!current || Date.parse(at) >= Date.parse(current.at)) {
      points.set(date, {
        at,
        trustScore: finiteInteger(sample.trustScore, { maximum: 100 }),
        databaseBytes: finiteInteger(sample.databaseBytes),
        backupDurationSeconds: current?.backupDurationSeconds ?? null,
        recoveryDurationSeconds: current?.recoveryDurationSeconds ?? null,
      });
    }
  }
  for (const run of Array.isArray(recoveryRuns) ? recoveryRuns : []) {
    const at = timestamp(run.at);
    if (!at) continue;
    const date = at.slice(0, 10);
    const current = points.get(date) || {
      at,
      trustScore: null,
      databaseBytes: null,
      backupDurationSeconds: null,
      recoveryDurationSeconds: null,
    };
    if (Date.parse(at) >= Date.parse(current.rasAt || "1970-01-01T00:00:00.000Z")) {
      current.rasAt = at;
      current.backupDurationSeconds = finiteInteger(run.backupDurationSeconds, { maximum: 31_536_000 });
      current.recoveryDurationSeconds = finiteInteger(run.recoveryDurationSeconds, { maximum: 31_536_000 });
    }
    points.set(date, current);
  }
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    retentionDays: finiteInteger(retentionDays, { minimum: 1, maximum: MAX_RETENTION_DAYS }) || DEFAULT_RETENTION_DAYS,
    integrityVerified: integrityVerified === true,
    points: [...points.values()]
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
      .slice(-(finiteInteger(retentionDays, { minimum: 1, maximum: MAX_RETENTION_DAYS }) || DEFAULT_RETENTION_DAYS))
      .map(({ rasAt: _rasAt, ...point }) => point),
  };
}

module.exports = {
  AUTOMATION_STATES,
  DEFAULT_AUTOMATION_GRACE_HOURS,
  DEFAULT_AUTOMATION_INTERVAL_HOURS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SAMPLE_INTERVAL_HOURS,
  MAX_RECOVERY_TREND_RUNS,
  MAX_RETENTION_DAYS,
  METRICS_SCHEMA_VERSION,
  buildSystemCenterTrendPayload,
  createSystemCenterMetricsStore,
  deriveAutomationStatus,
  planSystemCenterNotificationSync,
  recoveryTrendRuns,
  sampleHash,
  systemCenterNotificationIncidentKey,
  systemCenterRecoveryAlert,
};
