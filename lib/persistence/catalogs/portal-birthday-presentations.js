"use strict";

const {
  PORTAL_BIRTHDAY_PRESENTATION_STATEMENTS: S,
} = require("../statements/portal-birthday-presentations");

const policySelect = `
  SELECT
    enabled,
    revision,
    updated_at AS updatedAt
  FROM portal_birthday_presentation_policy
`;

const assignmentSelect = `
  SELECT
    employee_number AS employeeNumber,
    presentation_id AS presentationId,
    revision,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM portal_birthday_presentation_assignments
`;

const SQLITE_PORTAL_BIRTHDAY_PRESENTATION_CATALOG = Object.freeze([
  Object.freeze({
    statement: S.getPolicy,
    sql: `${policySelect} WHERE singleton_id = 1 LIMIT 1`,
    returning: false,
  }),
  Object.freeze({
    statement: S.updatePolicy,
    sql: `
      UPDATE portal_birthday_presentation_policy
      SET enabled = $enabled,
          revision = revision + 1,
          updated_at = $updatedAt
      WHERE singleton_id = 1
        AND revision = $expectedRevision
        AND enabled <> $enabled
      RETURNING enabled, revision, updated_at AS updatedAt
    `,
    returning: true,
  }),
  Object.freeze({
    statement: S.listAssignments,
    sql: `${assignmentSelect} ORDER BY employee_number`,
    returning: false,
  }),
  Object.freeze({
    statement: S.getAssignment,
    sql: `${assignmentSelect} WHERE employee_number = $employeeNumber LIMIT 1`,
    returning: false,
  }),
  Object.freeze({
    statement: S.insertAssignment,
    sql: `
      INSERT INTO portal_birthday_presentation_assignments (
        employee_number, presentation_id, revision, created_at, updated_at
      ) VALUES (
        $employeeNumber, $presentationId, 1, $updatedAt, $updatedAt
      )
      RETURNING employee_number AS employeeNumber,
                presentation_id AS presentationId,
                revision,
                created_at AS createdAt,
                updated_at AS updatedAt
    `,
    returning: true,
  }),
  Object.freeze({
    statement: S.updateAssignment,
    sql: `
      UPDATE portal_birthday_presentation_assignments
      SET presentation_id = $presentationId,
          revision = revision + 1,
          updated_at = $updatedAt
      WHERE employee_number = $employeeNumber
        AND revision = $expectedRevision
        AND presentation_id <> $presentationId
      RETURNING employee_number AS employeeNumber,
                presentation_id AS presentationId,
                revision,
                created_at AS createdAt,
                updated_at AS updatedAt
    `,
    returning: true,
  }),
  Object.freeze({
    statement: S.claimEvent,
    sql: `
      INSERT INTO portal_birthday_presentation_claims (
        employee_number, event_year, presentation_id, policy_revision,
        assignment_revision, receipt_sha256, revision
      ) VALUES (
        $employeeNumber, $eventYear, $presentationId, $policyRevision,
        $assignmentRevision, $receiptSha256, 1
      )
      ON CONFLICT(employee_number, event_year) DO NOTHING
      RETURNING employee_number AS employeeNumber,
                event_year AS eventYear,
                presentation_id AS presentationId,
                policy_revision AS policyRevision,
                assignment_revision AS assignmentRevision,
                receipt_sha256 AS receiptSha256,
                revision
    `,
    returning: true,
  }),
  Object.freeze({
    statement: S.listClaimsForEmployee,
    sql: `
      SELECT event_year AS eventYear, presentation_id AS presentationId
      FROM portal_birthday_presentation_claims
      WHERE employee_number = $employeeNumber
      ORDER BY event_year
    `,
    returning: false,
  }),
]);

module.exports = {
  SQLITE_PORTAL_BIRTHDAY_PRESENTATION_CATALOG,
};
