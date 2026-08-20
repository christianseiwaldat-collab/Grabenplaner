"use strict";

const {
  STAFF_ASSIGNMENT_REQUEST_STATEMENTS: S,
} = require("../statements/staff-assignment-requests");

const requestSelect = `
  SELECT
    id,
    created_by_employee_number AS createdByEmployeeNumber,
    created_at AS createdAt,
    receipt_sha256 AS receiptSha256
  FROM staff_assignment_requests
`;

const revisionSelect = `
  SELECT
    request_id AS requestId,
    revision_number AS revisionNumber,
    status,
    source_location_id AS sourceLocationId,
    destination_location_id AS destinationLocationId,
    destination_department_id AS destinationDepartmentId,
    period_start_date AS periodStartDate,
    period_end_date AS periodEndDate,
    time_kind AS timeKind,
    start_time AS startTime,
    end_time AS endTime,
    preferred_employee_number AS preferredEmployeeNumber,
    confirmed_employee_number AS confirmedEmployeeNumber,
    request_reason AS requestReason,
    decision_reason AS decisionReason,
    previous_receipt_sha256 AS previousReceiptSha256,
    receipt_sha256 AS receiptSha256,
    changed_by_employee_number AS changedByEmployeeNumber,
    changed_at AS changedAt
  FROM staff_assignment_request_revisions
`;

const eventSelect = `
  SELECT
    id,
    request_id AS requestId,
    sequence_number AS sequenceNumber,
    request_revision_number AS requestRevisionNumber,
    event_type AS eventType,
    from_status AS fromStatus,
    to_status AS toStatus,
    event_payload_json AS eventPayload,
    event_payload_sha256 AS eventPayloadSha256,
    previous_receipt_sha256 AS previousReceiptSha256,
    receipt_sha256 AS receiptSha256,
    actor_employee_number AS actorEmployeeNumber,
    occurred_at AS occurredAt
  FROM staff_assignment_request_events
`;

const SQLITE_STAFF_ASSIGNMENT_REQUEST_CATALOG = Object.freeze([
  {
    statement: S.listRequests,
    sql: `${requestSelect} ORDER BY created_at DESC, id DESC`,
  },
  {
    statement: S.getRequest,
    sql: `${requestSelect} WHERE id = $requestId LIMIT 1`,
  },
  {
    statement: S.insertRequest,
    sql: `
      INSERT INTO staff_assignment_requests (
        id, created_by_employee_number, created_at, receipt_sha256
      ) VALUES (
        $id, $createdByEmployeeNumber, $createdAt, $receiptSha256
      )
    `,
  },
  {
    statement: S.listRevisions,
    sql: `${revisionSelect}
      WHERE request_id = $requestId
      ORDER BY revision_number`,
  },
  {
    statement: S.getLatestRevision,
    sql: `${revisionSelect}
      WHERE request_id = $requestId
      ORDER BY revision_number DESC
      LIMIT 1`,
  },
  {
    statement: S.insertRevision,
    sql: `
      INSERT INTO staff_assignment_request_revisions (
        request_id, revision_number, status, source_location_id,
        destination_location_id, destination_department_id,
        period_start_date, period_end_date, time_kind, start_time, end_time,
        preferred_employee_number, confirmed_employee_number,
        request_reason, decision_reason, previous_receipt_sha256, receipt_sha256,
        changed_by_employee_number, changed_at
      ) VALUES (
        $requestId, $revisionNumber, $status, $sourceLocationId,
        $destinationLocationId, $destinationDepartmentId,
        $periodStartDate, $periodEndDate, $timeKind, $startTime, $endTime,
        $preferredEmployeeNumber, $confirmedEmployeeNumber,
        $requestReason, $decisionReason, $previousReceiptSha256, $receiptSha256,
        $changedByEmployeeNumber, $changedAt
      )
    `,
  },
  {
    statement: S.listEvents,
    sql: `${eventSelect}
      WHERE request_id = $requestId
      ORDER BY sequence_number`,
  },
  {
    statement: S.getLatestEvent,
    sql: `${eventSelect}
      WHERE request_id = $requestId
      ORDER BY sequence_number DESC
      LIMIT 1`,
  },
  {
    statement: S.insertEvent,
    sql: `
      INSERT INTO staff_assignment_request_events (
        id, request_id, sequence_number, request_revision_number,
        event_type, from_status, to_status, event_payload_json,
        event_payload_sha256, previous_receipt_sha256, receipt_sha256,
        actor_employee_number, occurred_at
      ) VALUES (
        $id, $requestId, $sequenceNumber, $requestRevisionNumber,
        $eventType, $fromStatus, $toStatus, $eventPayload,
        $eventPayloadSha256, $previousReceiptSha256, $receiptSha256,
        $actorEmployeeNumber, $occurredAt
      )
    `,
  },
  {
    statement: S.insertBoundAssignment,
    sql: `
      INSERT INTO employee_location_lendings (
        id, employee_number, home_location_id, destination_location_id,
        destination_department_id, date_from, date_to, all_day, start_time,
        end_time, note, status, revision, created_by, created_at, updated_by, updated_at
      ) VALUES (
        $id, $employeeNumber, $homeLocationId, $destinationLocationId,
        $destinationDepartmentId, $dateFrom, $dateTo, $allDay, $startTime,
        $endTime, $note, 'active', 1, $actor, $timestamp, $actor, $timestamp
      )
    `,
  },
].map((entry) => Object.freeze({ ...entry, returning: false })));

module.exports = {
  SQLITE_STAFF_ASSIGNMENT_REQUEST_CATALOG,
};
