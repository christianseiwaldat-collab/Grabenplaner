"use strict";

const {
  WORK_RULE_STORE_STATEMENTS,
} = require("../statements/work-rule-store");

const ASSIGNMENT_SELECTION = `
  a.id,
  a.profile_version_id AS profileVersionId,
  v.profile_id AS profileId,
  p.name AS profileName,
  v.version AS profileVersion,
  a.scope_type AS scopeType,
  a.scope_key AS scopeKey,
  a.valid_from AS validFrom,
  a.valid_to AS validTo,
  a.enforcement_mode AS enforcementMode,
  a.applicability_confirmed AS applicabilityConfirmed,
  a.confirmed_by AS confirmedBy,
  a.confirmed_at AS confirmedAt,
  a.active,
  a.created_by AS createdBy,
  a.created_at AS createdAt
`;

const EVALUATION_SELECTION = `
  id,
  target_type AS targetType,
  scope_type AS scopeType,
  scope_key AS scopeKey,
  period_from AS periodFrom,
  period_to AS periodTo,
  profile_version_ids_json AS profileVersionIds,
  input_sha256 AS inputSha256,
  result_sha256 AS resultSha256,
  result_json AS result,
  receipt_sha256 AS receiptSha256,
  outcome,
  created_by AS createdBy,
  created_at AS createdAt
`;

const EXCEPTION_SELECTION = `
  id,
  evaluation_id AS evaluationId,
  finding_fingerprint AS findingFingerprint,
  rule_id AS ruleId,
  profile_version_id AS profileVersionId,
  exception_type AS exceptionType,
  reason,
  evidence,
  state,
  valid_from AS validFrom,
  valid_to AS validTo,
  created_by AS createdBy,
  created_at AS createdAt,
  revoked_by AS revokedBy,
  revoked_at AS revokedAt
`;

const SQLITE_WORK_RULE_STORE_CATALOG = Object.freeze([
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.upsertBuiltinProfile,
    sql: `
      INSERT INTO work_rule_profiles (
        id,
        name,
        description,
        jurisdiction,
        sector,
        builtin,
        status,
        current_version_id,
        created_by,
        updated_by,
        updated_at
      )
      VALUES (
        $id,
        $name,
        $description,
        $jurisdiction,
        $sector,
        1,
        $status,
        $currentVersionId,
        $createdBy,
        $updatedBy,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        jurisdiction = excluded.jurisdiction,
        sector = excluded.sector,
        builtin = 1,
        status = excluded.status,
        current_version_id = excluded.current_version_id,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.insertBuiltinProfileVersion,
    sql: `
      INSERT OR IGNORE INTO work_rule_profile_versions (
        id,
        profile_id,
        version,
        layer,
        status,
        valid_from,
        valid_to,
        rules_json,
        sources_json,
        content_sha256,
        created_by,
        published_at
      )
      VALUES (
        $id,
        $profileId,
        $version,
        $layer,
        $status,
        $validFrom,
        $validTo,
        $rules,
        $sources,
        $contentSha256,
        $createdBy,
        CASE WHEN $status = 'published' THEN CURRENT_TIMESTAMP ELSE NULL END
      )
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.getProfileVersionHash,
    sql: `
      SELECT content_sha256 AS contentSha256
      FROM work_rule_profile_versions
      WHERE id = $id
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.insertBuiltinAssignment,
    sql: `
      INSERT OR IGNORE INTO work_rule_assignments (
        id,
        profile_version_id,
        scope_type,
        scope_key,
        valid_from,
        valid_to,
        enforcement_mode,
        applicability_confirmed,
        active,
        created_by
      )
      VALUES (
        $id,
        $profileVersionId,
        'installation',
        '',
        $validFrom,
        NULL,
        'monitor',
        0,
        1,
        $createdBy
      )
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.listProfiles,
    sql: `
      SELECT
        p.id,
        p.name,
        p.description,
        p.jurisdiction,
        p.sector,
        p.builtin,
        p.status,
        p.current_version_id AS currentVersionId,
        v.version,
        v.layer,
        v.status AS versionStatus,
        v.valid_from AS validFrom,
        v.valid_to AS validTo,
        v.content_sha256 AS contentSha256,
        v.rules_json AS rules,
        v.sources_json AS sources,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt
      FROM work_rule_profiles p
      LEFT JOIN work_rule_profile_versions v
        ON v.id = p.current_version_id
      ORDER BY p.builtin DESC, p.name, p.id
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.getProfileVersion,
    sql: `
      SELECT
        v.id,
        v.profile_id AS profileId,
        v.version,
        v.layer,
        v.status,
        v.valid_from AS validFrom,
        v.valid_to AS validTo,
        v.rules_json AS rules,
        v.sources_json AS sources,
        v.content_sha256 AS contentSha256,
        p.name AS profileName
      FROM work_rule_profile_versions v
      JOIN work_rule_profiles p
        ON p.id = v.profile_id
      WHERE v.id = $id
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.listActiveAssignments,
    sql: `
      SELECT ${ASSIGNMENT_SELECTION}
      FROM work_rule_assignments a
      JOIN work_rule_profile_versions v
        ON v.id = a.profile_version_id
      JOIN work_rule_profiles p
        ON p.id = v.profile_id
      WHERE a.active = 1
      ORDER BY a.active DESC, a.scope_type, a.scope_key, a.valid_from, a.id
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.listAllAssignments,
    sql: `
      SELECT ${ASSIGNMENT_SELECTION}
      FROM work_rule_assignments a
      JOIN work_rule_profile_versions v
        ON v.id = a.profile_version_id
      JOIN work_rule_profiles p
        ON p.id = v.profile_id
      ORDER BY a.active DESC, a.scope_type, a.scope_key, a.valid_from, a.id
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.getAssignment,
    sql: `
      SELECT ${ASSIGNMENT_SELECTION}
      FROM work_rule_assignments a
      JOIN work_rule_profile_versions v
        ON v.id = a.profile_version_id
      JOIN work_rule_profiles p
        ON p.id = v.profile_id
      WHERE a.id = $id
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.getAssignableProfileVersion,
    sql: `
      SELECT
        v.id,
        v.status,
        v.valid_from AS validFrom,
        v.valid_to AS validTo,
        v.rules_json AS rules,
        p.status AS profileStatus
      FROM work_rule_profile_versions v
      JOIN work_rule_profiles p
        ON p.id = v.profile_id
      WHERE v.id = $id
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.insertAssignment,
    sql: `
      INSERT INTO work_rule_assignments (
        id,
        profile_version_id,
        scope_type,
        scope_key,
        valid_from,
        valid_to,
        enforcement_mode,
        applicability_confirmed,
        confirmed_by,
        confirmed_at,
        active,
        created_by
      )
      VALUES (
        $id,
        $profileVersionId,
        $scopeType,
        $scopeKey,
        $validFrom,
        $validTo,
        $enforcementMode,
        $applicabilityConfirmed,
        $confirmedBy,
        CASE WHEN $applicabilityConfirmed = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
        1,
        $createdBy
      )
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.insertEvaluation,
    sql: `
      INSERT INTO work_rule_evaluation_runs (
        id,
        target_type,
        scope_type,
        scope_key,
        period_from,
        period_to,
        profile_version_ids_json,
        input_sha256,
        result_sha256,
        result_json,
        receipt_sha256,
        outcome,
        created_by,
        created_at
      )
      VALUES (
        $id,
        $targetType,
        $scopeType,
        $scopeKey,
        $periodFrom,
        $periodTo,
        $profileVersionIds,
        $inputSha256,
        $resultSha256,
        $result,
        $receiptSha256,
        $outcome,
        $createdBy,
        $createdAt
      )
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.getEvaluation,
    sql: `
      SELECT ${EVALUATION_SELECTION}
      FROM work_rule_evaluation_runs
      WHERE id = $id
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.listEvaluations,
    sql: `
      SELECT ${EVALUATION_SELECTION}
      FROM work_rule_evaluation_runs
      ORDER BY created_at DESC, id DESC
      LIMIT $limit
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.insertPlanningShift,
    sql: `
      INSERT INTO shifts (
        employee_number,
        location_id,
        department_id,
        duty_code,
        shift_date,
        start_time,
        end_time,
        area,
        note
      )
      VALUES (
        $employeeNumber,
        $locationId,
        $departmentId,
        $dutyCode,
        $shiftDate,
        $startTime,
        $endTime,
        $area,
        $note
      )
      RETURNING id
    `,
    returning: true,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.updatePlanningShift,
    sql: `
      UPDATE shifts
      SET
        employee_number = $employeeNumber,
        location_id = $locationId,
        department_id = $departmentId,
        duty_code = COALESCE($dutyCode, duty_code),
        shift_date = $shiftDate,
        start_time = $startTime,
        end_time = $endTime,
        area = $area,
        note = $note
      WHERE id = $id
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.deletePlanningShift,
    sql: `
      DELETE FROM shifts
      WHERE id = $id
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.deletePlanningShiftsForLocationRange,
    sql: `
      DELETE FROM shifts
      WHERE shift_date BETWEEN $dateFrom AND $dateTo
        AND location_id = $locationId
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.deletePlanningShiftsForDepartmentRange,
    sql: `
      DELETE FROM shifts
      WHERE shift_date BETWEEN $dateFrom AND $dateTo
        AND location_id = $locationId
        AND department_id = $departmentId
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.invalidatePlanningDayReview,
    sql: `
      DELETE FROM time_day_reviews
      WHERE employee_number = $employeeNumber
        AND work_date = $workDate
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.invalidatePlanningLocationReviews,
    sql: `
      DELETE FROM time_day_reviews
      WHERE location_id = $locationId
        AND work_date BETWEEN $dateFrom AND $dateTo
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.invalidatePlanningDepartmentReviews,
    sql: `
      DELETE FROM time_day_reviews
      WHERE location_id = $locationId
        AND work_date BETWEEN $dateFrom AND $dateTo
        AND department_key IN (0, $departmentId)
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.updateTimeOffOriginalShifts,
    sql: `
      UPDATE time_off_requests
      SET original_shifts_json = $originalShifts
      WHERE id = $id
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.insertTimeOffOption,
    sql: `
      INSERT INTO week_options (
        employee_number,
        group_id,
        week_start,
        date_from,
        date_to,
        option_type,
        note,
        credited_minutes_per_day,
        all_day,
        start_time,
        end_time
      )
      VALUES (
        $employeeNumber,
        $groupId,
        $weekStart,
        $dateFrom,
        $dateTo,
        'time_off',
        $note,
        $creditedMinutesPerDay,
        $allDay,
        $startTime,
        $endTime
      )
      RETURNING id
    `,
    returning: true,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.deleteTimeOffOptions,
    sql: `
      DELETE FROM week_options
      WHERE group_id = $groupId
        OR id = $optionId
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.deletePlanningShiftsWithinWindow,
    sql: `
      DELETE FROM shifts
      WHERE employee_number = $employeeNumber
        AND shift_date = $shiftDate
        AND COALESCE(department_id, 0) = COALESCE($departmentId, 0)
        AND start_time >= $startTime
        AND end_time <= $endTime
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.listCollectiveAgreementProfileVersions,
    sql: `
      SELECT v.id,
             p.name AS profileName,
             v.version,
             v.status,
             v.valid_from AS validFrom,
             v.valid_to AS validTo
      FROM work_rule_profile_versions v
      JOIN work_rule_profiles p ON p.id = v.profile_id
      WHERE v.layer = 'collective_agreement'
      ORDER BY p.name COLLATE NOCASE, v.valid_from DESC, v.id
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.listExceptions,
    sql: `
      SELECT ${EXCEPTION_SELECTION}
      FROM work_rule_exceptions
      ORDER BY created_at DESC, id DESC
      LIMIT 200
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.listExceptionsByState,
    sql: `
      SELECT ${EXCEPTION_SELECTION}
      FROM work_rule_exceptions
      WHERE state = $state
      ORDER BY created_at DESC, id DESC
      LIMIT 200
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.profileVersionExists,
    sql: `
      SELECT 1 AS found
      FROM work_rule_profile_versions
      WHERE id = $id
      LIMIT 1
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.insertException,
    sql: `
      INSERT INTO work_rule_exceptions (
        id, evaluation_id, finding_fingerprint, rule_id, profile_version_id,
        exception_type, reason, evidence, valid_from, valid_to, created_by
      ) VALUES (
        $id, $evaluationId, $findingFingerprint, $ruleId, $profileVersionId,
        $exceptionType, $reason, $evidence, $validFrom, $validTo, $actor
      )
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.getException,
    sql: `
      SELECT id, state
      FROM work_rule_exceptions
      WHERE id = $id
      LIMIT 1
    `,
    returning: false,
  }),
  Object.freeze({
    statement: WORK_RULE_STORE_STATEMENTS.revokeException,
    sql: `
      UPDATE work_rule_exceptions
      SET state = 'revoked',
          revoked_by = $actor,
          revoked_at = CURRENT_TIMESTAMP,
          evidence = CASE
            WHEN TRIM(evidence) = '' THEN $evidence
            ELSE evidence || CHAR(10) || $evidence
          END
      WHERE id = $id
        AND state = 'active'
    `,
    returning: false,
  }),
]);

module.exports = {
  SQLITE_WORK_RULE_STORE_CATALOG,
};
