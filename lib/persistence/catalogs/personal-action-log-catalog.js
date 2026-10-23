"use strict";

const {
  PERSONAL_ACTION_LOG_STATEMENTS: S,
} = require("../statements/personal-action-log");

function entry(statement, sql) {
  return Object.freeze({ statement, sql, returning: false });
}

const PUBLIC_COLUMNS = `
  id,
  actor_kind AS actorKind,
  actor_id AS actorId,
  action_type AS actionType,
  entity_type AS entityType,
  entity_id AS entityId,
  scope,
  summary,
  compensator_key AS compensatorKey,
  source_audit_id AS sourceAuditId,
  undo_expires_at AS undoExpiresAt,
  compensates_action_id AS compensatesActionId,
  created_at AS createdAt
`;

const INTERNAL_COLUMNS = `
  ${PUBLIC_COLUMNS},
  undo_payload AS undoPayload,
  result_revision AS resultRevision,
  result_fingerprint AS resultFingerprint
`;

const SQLITE_PERSONAL_ACTION_LOG_CATALOG = Object.freeze([
  entry(S.insert, `
    INSERT INTO personal_action_receipts (
      id, actor_kind, actor_id, action_type, entity_type, entity_id, scope, summary,
      compensator_key, undo_payload, result_revision, result_fingerprint,
      source_audit_id, undo_expires_at, compensates_action_id, created_at
    ) VALUES (
      $id, $actorKind, $actorId, $actionType, $entityType, $entityId, $scope, $summary,
      $compensatorKey, $undoPayload, $resultRevision, $resultFingerprint,
      $sourceAuditId, $undoExpiresAt, $compensatesActionId, $createdAt
    )
  `),
  entry(S.listOwn, `
    SELECT ${PUBLIC_COLUMNS}
    FROM personal_action_receipts
    WHERE actor_kind = 'employee'
      AND actor_id = $actorId
      AND (
        $beforeCreatedAt IS NULL
        OR created_at < $beforeCreatedAt
        OR (created_at = $beforeCreatedAt AND id < $beforeId)
      )
    ORDER BY created_at DESC, id DESC
    LIMIT $limit
  `),
  entry(S.getOwn, `
    SELECT ${INTERNAL_COLUMNS}
    FROM personal_action_receipts
    WHERE actor_kind = 'employee'
      AND actor_id = $actorId
      AND id = $id
    LIMIT 1
  `),
  entry(S.findCompensation, `
    SELECT ${PUBLIC_COLUMNS}
    FROM personal_action_receipts
    WHERE actor_kind = 'employee'
      AND actor_id = $actorId
      AND compensates_action_id = $compensatesActionId
    LIMIT 1
  `),
  entry(S.listLegacyAuditForActor, `
    SELECT
      id,
      action,
      entity_type AS entityType,
      entity_id AS entityId,
      created_at AS createdAt
    FROM audit_log
    WHERE actor = $actorId
      AND ($beforeId IS NULL OR id < $beforeId)
    ORDER BY id DESC
    LIMIT $limit
  `),
]);

module.exports = {
  SQLITE_PERSONAL_ACTION_LOG_CATALOG,
};
