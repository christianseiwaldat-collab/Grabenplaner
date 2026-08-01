"use strict";

const {
  PERSONNEL_LIFECYCLE_STATEMENTS: S,
} = require("../statements/personnel-lifecycle");

function entry(statement, sql) {
  return Object.freeze({ statement, sql, returning: false });
}

const CANDIDATE_COLUMNS = `
  id,
  state,
  protected_payload AS protectedPayload,
  revision,
  created_by AS createdBy,
  updated_by AS updatedBy,
  archived_at AS archivedAt,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const APPLICATION_COLUMNS = `
  id,
  candidate_id AS candidateId,
  status,
  desired_position_id AS desiredPositionId,
  desired_location_id AS desiredLocationId,
  desired_department_id AS desiredDepartmentId,
  desired_weekly_minutes AS desiredWeeklyMinutes,
  available_from AS availableFrom,
  owner_employee_number AS ownerEmployeeNumber,
  retention_due_at AS retentionDueAt,
  protected_payload AS protectedPayload,
  revision,
  status_changed_at AS statusChangedAt,
  created_by AS createdBy,
  updated_by AS updatedBy,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const CONVERSION_COLUMNS = `
  id,
  candidate_id AS candidateId,
  application_id AS applicationId,
  employee_number AS employeeNumber,
  request_sha256 AS requestSha256,
  protected_payload AS protectedPayload,
  receipt_sha256 AS receiptSha256,
  actor_employee_number AS actorEmployeeNumber,
  created_at AS createdAt
`;

const DOCUMENT_CATEGORY_COLUMNS = `
  id,
  code,
  label,
  default_visibility AS defaultVisibility,
  retention_disposition AS retentionDisposition,
  default_retention_days AS defaultRetentionDays,
  transfer_eligible AS transferEligible,
  active,
  builtin,
  sort_order AS sortOrder,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const DOCUMENT_COLUMNS = `
  id,
  candidate_id AS candidateId,
  application_id AS applicationId,
  category_id AS categoryId,
  visibility,
  status,
  current_version AS currentVersion,
  document_date AS documentDate,
  expires_on AS expiresOn,
  retention_due_at AS retentionDueAt,
  protected_payload AS protectedPayload,
  revision,
  created_by AS createdBy,
  updated_by AS updatedBy,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const DOCUMENT_VERSION_COLUMNS = `
  document_id AS documentId,
  version_number AS versionNumber,
  storage_key AS storageKey,
  content_sha256 AS contentSha256,
  size_bytes AS sizeBytes,
  media_type AS mediaType,
  protected_payload AS protectedPayload,
  uploaded_by AS uploadedBy,
  created_at AS createdAt
`;

const EVENT_COLUMNS = `
  id,
  candidate_id AS candidateId,
  sequence_number AS sequenceNumber,
  application_id AS applicationId,
  document_id AS documentId,
  event_type AS eventType,
  protected_payload AS protectedPayload,
  previous_receipt_sha256 AS previousReceiptSha256,
  receipt_sha256 AS receiptSha256,
  actor_employee_number AS actorEmployeeNumber,
  created_at AS createdAt
`;

const SQLITE_PERSONNEL_LIFECYCLE_CATALOG = Object.freeze([
  entry(S.candidateById, `
    SELECT ${CANDIDATE_COLUMNS}
    FROM candidates
    WHERE id = $id
  `),
  entry(S.listCandidates, `
    SELECT ${CANDIDATE_COLUMNS}
    FROM candidates
    WHERE $includeArchived = 1 OR state <> 'archived'
    ORDER BY updated_at DESC, id
    LIMIT $limit OFFSET $offset
  `),
  entry(S.listCandidateAccessHeaders, `
    SELECT id, state, revision, created_at AS createdAt, updated_at AS updatedAt
    FROM candidates
    WHERE $includeArchived = 1 OR state <> 'archived'
    ORDER BY updated_at DESC, id
    LIMIT $limit OFFSET $offset
  `),
  entry(S.insertCandidate, `
    INSERT INTO candidates (
      id, state, protected_payload, revision, created_by, updated_by, created_at, updated_at
    ) VALUES (
      $id, 'active', $protectedPayload, 1, $actor, $actor, $occurredAt, $occurredAt
    )
  `),
  entry(S.updateCandidate, `
    UPDATE candidates
    SET
      protected_payload = $protectedPayload,
      revision = revision + 1,
      updated_by = $actor,
      updated_at = $occurredAt
    WHERE id = $id
      AND state = 'active'
      AND revision = $expectedRevision
  `),
  entry(S.archiveCandidateForConversion, `
    UPDATE candidates
    SET
      state = 'archived',
      revision = revision + 1,
      archived_at = $occurredAt,
      updated_by = $actor,
      updated_at = $occurredAt
    WHERE id = $id
      AND state = 'active'
      AND revision = $expectedRevision
  `),
  entry(S.applicationById, `
    SELECT ${APPLICATION_COLUMNS}
    FROM candidate_applications
    WHERE candidate_id = $candidateId AND id = $id
  `),
  entry(S.listApplications, `
    SELECT ${APPLICATION_COLUMNS}
    FROM candidate_applications
    WHERE candidate_id = $candidateId
    ORDER BY created_at DESC, id
  `),
  entry(S.listApplicationAccessScopes, `
    SELECT id, candidate_id AS candidateId, status,
           desired_location_id AS desiredLocationId,
           desired_department_id AS desiredDepartmentId,
           revision, created_at AS createdAt, updated_at AS updatedAt
    FROM candidate_applications
    WHERE candidate_id = $candidateId
    ORDER BY created_at DESC, id
  `),
  entry(S.insertApplication, `
    INSERT INTO candidate_applications (
      id, candidate_id, status, desired_position_id, desired_location_id,
      desired_department_id, desired_weekly_minutes, available_from,
      owner_employee_number, retention_due_at, protected_payload, revision,
      status_changed_at, created_by, updated_by, created_at, updated_at
    ) VALUES (
      $id, $candidateId, $status, $desiredPositionId, $desiredLocationId,
      $desiredDepartmentId, $desiredWeeklyMinutes, $availableFrom,
      $ownerEmployeeNumber, $retentionDueAt, $protectedPayload, 1,
      $occurredAt, $actor, $actor, $occurredAt, $occurredAt
    )
  `),
  entry(S.updateApplication, `
    UPDATE candidate_applications
    SET
      desired_position_id = $desiredPositionId,
      desired_location_id = $desiredLocationId,
      desired_department_id = $desiredDepartmentId,
      desired_weekly_minutes = $desiredWeeklyMinutes,
      available_from = $availableFrom,
      owner_employee_number = $ownerEmployeeNumber,
      retention_due_at = $retentionDueAt,
      protected_payload = $protectedPayload,
      revision = revision + 1,
      updated_by = $actor,
      updated_at = $occurredAt
    WHERE id = $id
      AND candidate_id = $candidateId
      AND status NOT IN ('converted','archived')
      AND revision = $expectedRevision
      AND EXISTS (
        SELECT 1 FROM candidates
        WHERE candidates.id = $candidateId AND candidates.state = 'active'
      )
  `),
  entry(S.updateApplicationStatus, `
    UPDATE candidate_applications
    SET
      status = $status,
      revision = revision + 1,
      status_changed_at = $occurredAt,
      updated_by = $actor,
      updated_at = $occurredAt
    WHERE id = $id
      AND candidate_id = $candidateId
      AND revision = $expectedRevision
      AND EXISTS (
        SELECT 1 FROM candidates
        WHERE candidates.id = $candidateId AND candidates.state = 'active'
      )
  `),
  entry(S.conversionById, `
    SELECT ${CONVERSION_COLUMNS}
    FROM candidate_conversions
    WHERE id = $id
  `),
  entry(S.conversionForCandidate, `
    SELECT ${CONVERSION_COLUMNS}
    FROM candidate_conversions
    WHERE candidate_id = $candidateId
  `),
  entry(S.insertConversion, `
    INSERT INTO candidate_conversions (
      id, candidate_id, application_id, employee_number, request_sha256,
      protected_payload, receipt_sha256, actor_employee_number, created_at
    ) VALUES (
      $id, $candidateId, $applicationId, $employeeNumber, $requestSha256,
      $protectedPayload, $receiptSha256, $actorEmployeeNumber, $createdAt
    )
  `),
  entry(S.listDocumentCategories, `
    SELECT ${DOCUMENT_CATEGORY_COLUMNS}
    FROM candidate_document_categories
    WHERE $activeOnly = 0 OR active = 1
    ORDER BY sort_order, label, id
  `),
  entry(S.documentById, `
    SELECT ${DOCUMENT_COLUMNS}
    FROM candidate_documents
    WHERE candidate_id = $candidateId AND id = $id
  `),
  entry(S.listDocuments, `
    SELECT ${DOCUMENT_COLUMNS}
    FROM candidate_documents
    WHERE candidate_id = $candidateId
    ORDER BY updated_at DESC, id
  `),
  entry(S.insertDocument, `
    INSERT INTO candidate_documents (
      id, candidate_id, application_id, category_id, visibility, status,
      current_version, document_date, expires_on, retention_due_at,
      protected_payload, revision, created_by, updated_by, created_at, updated_at
    ) VALUES (
      $id, $candidateId, $applicationId, $categoryId, $visibility, 'active',
      0, $documentDate, $expiresOn, $retentionDueAt,
      $protectedPayload, 1, $actor, $actor, $occurredAt, $occurredAt
    )
  `),
  entry(S.insertDocumentVersion, `
    INSERT INTO candidate_document_versions (
      document_id, version_number, storage_key, content_sha256, size_bytes,
      media_type, protected_payload, uploaded_by, created_at
    ) VALUES (
      $documentId, $versionNumber, $storageKey, $contentSha256, $sizeBytes,
      $mediaType, $protectedPayload, $actor, $occurredAt
    )
  `),
  entry(S.listDocumentVersions, `
    SELECT ${DOCUMENT_VERSION_COLUMNS}
    FROM candidate_document_versions
    WHERE document_id = $documentId
    ORDER BY version_number
  `),
  entry(S.insertEvent, `
    INSERT INTO candidate_events (
      id, candidate_id, sequence_number, application_id, document_id,
      event_type, protected_payload, previous_receipt_sha256, receipt_sha256,
      actor_employee_number, created_at
    ) VALUES (
      $id, $candidateId, $sequenceNumber, $applicationId, $documentId,
      $eventType, $protectedPayload, $previousReceiptSha256, $receiptSha256,
      $actor, $occurredAt
    )
  `),
  entry(S.listEvents, `
    SELECT ${EVENT_COLUMNS}
    FROM candidate_events
    WHERE candidate_id = $candidateId
    ORDER BY sequence_number
  `),
]);

module.exports = {
  SQLITE_PERSONNEL_LIFECYCLE_CATALOG,
};
