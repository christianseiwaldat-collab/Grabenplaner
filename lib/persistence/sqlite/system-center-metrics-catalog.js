"use strict";

const {
  SYSTEM_CENTER_METRICS_STATEMENTS,
} = require("../statements/system-center-metrics");

const SQLITE_SYSTEM_CENTER_METRICS_CATALOG = Object.freeze([
  Object.freeze({
    statement: SYSTEM_CENTER_METRICS_STATEMENTS.listSamples,
    sql: `
      SELECT
        interval_key AS intervalKey,
        recorded_at AS recordedAt,
        trust_score AS trustScore,
        coverage,
        trust_state AS trustState,
        database_bytes AS databaseBytes,
        storage_free_bytes AS storageFreeBytes,
        automation_state AS automationState,
        previous_hash AS previousHash,
        sample_hash AS sampleHash
      FROM system_center_trust_metrics
      ORDER BY recorded_at, interval_key
      LIMIT $limit
    `,
    returning: false,
  }),
  Object.freeze({
    statement: SYSTEM_CENTER_METRICS_STATEMENTS.insertSample,
    sql: `
      INSERT OR IGNORE INTO system_center_trust_metrics (
        interval_key,
        recorded_at,
        trust_score,
        coverage,
        trust_state,
        database_bytes,
        storage_free_bytes,
        automation_state,
        previous_hash,
        sample_hash
      )
      VALUES (
        $intervalKey,
        $recordedAt,
        $trustScore,
        $coverage,
        $trustState,
        $databaseBytes,
        $storageFreeBytes,
        $automationState,
        $previousHash,
        $sampleHash
      )
    `,
    returning: false,
  }),
  Object.freeze({
    statement: SYSTEM_CENTER_METRICS_STATEMENTS.deleteBefore,
    sql: `
      DELETE FROM system_center_trust_metrics
      WHERE recorded_at < $cutoff
    `,
    returning: false,
  }),
  Object.freeze({
    statement: SYSTEM_CENTER_METRICS_STATEMENTS.overflowCount,
    sql: `
      SELECT MAX(0, COUNT(*) - $maximumSamples) AS count
      FROM system_center_trust_metrics
    `,
    returning: false,
  }),
  Object.freeze({
    statement: SYSTEM_CENTER_METRICS_STATEMENTS.oldestIntervalKeys,
    sql: `
      SELECT interval_key AS intervalKey
      FROM system_center_trust_metrics
      ORDER BY recorded_at, interval_key
      LIMIT $limit
    `,
    returning: false,
  }),
  Object.freeze({
    statement: SYSTEM_CENTER_METRICS_STATEMENTS.deleteByIntervalKey,
    sql: `
      DELETE FROM system_center_trust_metrics
      WHERE interval_key = $intervalKey
    `,
    returning: false,
  }),
  Object.freeze({
    statement: SYSTEM_CENTER_METRICS_STATEMENTS.listReadinessEvidence,
    sql: `
      SELECT id, check_id, outcome, payload_json, receipt_sha256,
             observed_by, observed_at, created_at
      FROM product_readiness_evidence
      ORDER BY observed_at, id
    `,
    returning: false,
  }),
  Object.freeze({
    statement: SYSTEM_CENTER_METRICS_STATEMENTS.insertReadinessEvidence,
    sql: `
      INSERT INTO product_readiness_evidence
        (id, check_id, outcome, payload_json, receipt_sha256, observed_by, observed_at, created_at)
      VALUES
        ($id, $checkId, $outcome, $payloadJson, $receiptSha256, $observedBy, $observedAt, $createdAt)
    `,
    returning: false,
  }),
  Object.freeze({
    statement: SYSTEM_CENTER_METRICS_STATEMENTS.listReadinessAcceptances,
    sql: `
      SELECT id, discipline, decision, release_version, basis_sha256,
             payload_json, receipt_sha256, decided_by, decided_at
      FROM product_readiness_acceptances
      ORDER BY decided_at, id
    `,
    returning: false,
  }),
  Object.freeze({
    statement: SYSTEM_CENTER_METRICS_STATEMENTS.insertReadinessAcceptance,
    sql: `
      INSERT INTO product_readiness_acceptances
        (id, discipline, decision, release_version, basis_sha256, payload_json,
         receipt_sha256, decided_by, decided_at)
      VALUES
        ($id, $discipline, $decision, $releaseVersion, $basisSha256, $payloadJson,
         $receiptSha256, $decidedBy, $decidedAt)
    `,
    returning: false,
  }),
  Object.freeze({
    statement: SYSTEM_CENTER_METRICS_STATEMENTS.listRecoveryNotifications,
    sql: `
      SELECT id,
             recipient_employee_number AS recipient,
             dedupe_key AS dedupeKey,
             read_at AS readAt
      FROM portal_notifications
      WHERE event_type = 'system.recovery.alert'
    `,
    returning: false,
  }),
  Object.freeze({
    statement: SYSTEM_CENTER_METRICS_STATEMENTS.closeRecoveryNotification,
    sql: `
      UPDATE portal_notifications
      SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
      WHERE id = $id AND read_at IS NULL
    `,
    returning: false,
  }),
  Object.freeze({
    statement: SYSTEM_CENTER_METRICS_STATEMENTS.latestRecoveryNotification,
    sql: `
      SELECT MAX(created_at) AS createdAt
      FROM portal_notifications
      WHERE event_type = 'system.recovery.alert'
    `,
    returning: false,
  }),
]);

module.exports = {
  SQLITE_SYSTEM_CENTER_METRICS_CATALOG,
};
