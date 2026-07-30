"use strict";

const { definePersistenceStatement } = require("../contract");

const SYSTEM_CENTER_METRICS_STATEMENTS = Object.freeze({
  listSamples: definePersistenceStatement({
    id: "system-center-metrics.list-samples",
    operation: "queryAll",
    parameters: {
      limit: "safe_integer",
    },
    columns: {
      intervalKey: "text",
      recordedAt: "utc_timestamp",
      trustScore: "safe_integer",
      coverage: "safe_integer",
      trustState: "text",
      databaseBytes: { kind: "safe_integer", nullable: true },
      storageFreeBytes: { kind: "safe_integer", nullable: true },
      automationState: "text",
      previousHash: { kind: "text", nullable: true },
      sampleHash: "text",
    },
  }),
  insertSample: definePersistenceStatement({
    id: "system-center-metrics.insert-sample",
    operation: "execute",
    parameters: {
      intervalKey: "text",
      recordedAt: "utc_timestamp",
      trustScore: "safe_integer",
      coverage: "safe_integer",
      trustState: "text",
      databaseBytes: { kind: "safe_integer", nullable: true },
      storageFreeBytes: { kind: "safe_integer", nullable: true },
      automationState: "text",
      previousHash: { kind: "text", nullable: true },
      sampleHash: "text",
    },
  }),
  deleteBefore: definePersistenceStatement({
    id: "system-center-metrics.delete-before",
    operation: "execute",
    parameters: {
      cutoff: "utc_timestamp",
    },
  }),
  overflowCount: definePersistenceStatement({
    id: "system-center-metrics.overflow-count",
    operation: "queryOne",
    parameters: {
      maximumSamples: "safe_integer",
    },
    columns: {
      count: "safe_integer",
    },
  }),
  oldestIntervalKeys: definePersistenceStatement({
    id: "system-center-metrics.oldest-interval-keys",
    operation: "queryAll",
    parameters: {
      limit: "safe_integer",
    },
    columns: {
      intervalKey: "text",
    },
  }),
  deleteByIntervalKey: definePersistenceStatement({
    id: "system-center-metrics.delete-by-interval-key",
    operation: "execute",
    parameters: {
      intervalKey: "text",
    },
  }),
  listReadinessEvidence: definePersistenceStatement({
    id: "system-center-metrics.list-readiness-evidence",
    operation: "queryAll",
    columns: {
      id: "text",
      check_id: "text",
      outcome: "text",
      payload_json: "text",
      receipt_sha256: "text",
      observed_by: "text",
      observed_at: "text",
      created_at: "text",
    },
  }),
  insertReadinessEvidence: definePersistenceStatement({
    id: "system-center-metrics.insert-readiness-evidence",
    operation: "execute",
    parameters: {
      id: "text",
      checkId: "text",
      outcome: "text",
      payloadJson: "text",
      receiptSha256: "text",
      observedBy: "text",
      observedAt: "text",
      createdAt: "text",
    },
  }),
  listReadinessAcceptances: definePersistenceStatement({
    id: "system-center-metrics.list-readiness-acceptances",
    operation: "queryAll",
    columns: {
      id: "text",
      discipline: "text",
      decision: "text",
      release_version: "text",
      basis_sha256: "text",
      payload_json: "text",
      receipt_sha256: "text",
      decided_by: "text",
      decided_at: "text",
    },
  }),
  insertReadinessAcceptance: definePersistenceStatement({
    id: "system-center-metrics.insert-readiness-acceptance",
    operation: "execute",
    parameters: {
      id: "text",
      discipline: "text",
      decision: "text",
      releaseVersion: "text",
      basisSha256: "text",
      payloadJson: "text",
      receiptSha256: "text",
      decidedBy: "text",
      decidedAt: "text",
    },
  }),
  listRecoveryNotifications: definePersistenceStatement({
    id: "system-center-metrics.list-recovery-notifications",
    operation: "queryAll",
    columns: {
      id: "text",
      recipient: "text",
      dedupeKey: { kind: "text", nullable: true },
      readAt: { kind: "text", nullable: true },
    },
  }),
  closeRecoveryNotification: definePersistenceStatement({
    id: "system-center-metrics.close-recovery-notification",
    operation: "execute",
    parameters: {
      id: "text",
    },
  }),
  latestRecoveryNotification: definePersistenceStatement({
    id: "system-center-metrics.latest-recovery-notification",
    operation: "queryOne",
    columns: {
      createdAt: { kind: "text", nullable: true },
    },
  }),
});

module.exports = {
  SYSTEM_CENTER_METRICS_STATEMENTS,
};
