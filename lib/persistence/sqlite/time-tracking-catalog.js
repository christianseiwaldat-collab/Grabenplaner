"use strict";

const {
  TIME_TRACKING_STATEMENTS: S,
} = require("../statements/time-tracking");

function entry(statement, sql, returning = false) {
  return Object.freeze({ statement, sql, returning });
}

function jsonObject(fields) {
  return `json_object(${Object.entries(fields)
    .map(([key, value]) => `'${key}', ${value}`)
    .join(", ")}) AS data`;
}

const EMPLOYEE_FIELDS = Object.freeze({
  personnel_number: "e.personnel_number",
  full_name: "e.full_name",
  nickname: "e.nickname",
  color: "e.color",
  home_location_id: "e.home_location_id",
  preferred_department_id: "e.preferred_department_id",
  active: "e.active",
});

const TIME_ENTRY_FIELDS = Object.freeze({
  id: "t.id",
  employee_number: "t.employee_number",
  location_id: "t.location_id",
  department_id: "t.department_id",
  work_date: "t.work_date",
  entry_type: "t.entry_type",
  entry_timestamp: "t.entry_timestamp",
  source: "t.source",
  note: "t.note",
  created_by: "t.created_by",
  correction_id: "t.correction_id",
  client_request_id: "t.client_request_id",
  mobile_session_id: "t.mobile_session_id",
  created_at: "t.created_at",
});

const DAY_REVIEW_FIELDS = Object.freeze({
  employee_number: "review.employee_number",
  location_id: "review.location_id",
  department_id: "review.department_id",
  department_key: "review.department_key",
  work_date: "review.work_date",
  note: "review.note",
  reviewed_by: "review.reviewed_by",
  reviewed_at: "review.reviewed_at",
  evaluation_version: "review.evaluation_version",
  snapshot_json: "review.snapshot_json",
  updated_at: "review.updated_at",
});

const CORRECTION_FIELDS = Object.freeze({
  id: "c.id",
  employee_number: "c.employee_number",
  location_id: "c.location_id",
  department_id: "c.department_id",
  correction_date: "c.correction_date",
  requested_change: "c.requested_change",
  request_note: "c.request_note",
  status: "c.status",
  decided_by: "c.decided_by",
  decided_at: "c.decided_at",
  decision_note: "c.decision_note",
  requested_by: "c.requested_by",
  created_at: "c.created_at",
  updated_at: "c.updated_at",
});

const SQLITE_TIME_TRACKING_CATALOG = Object.freeze([
  entry(S.getClientRequestEntry, `
    SELECT json_object(
      'id', t.id,
      'entry_type', t.entry_type
    ) AS data
    FROM time_entries t
    WHERE t.employee_number = json_extract($payload, '$.employeeNumber')
      AND t.client_request_id = json_extract($payload, '$.clientRequestId')
    LIMIT 1
  `),
  entry(S.insertTimeEntry, `
    INSERT INTO time_entries (
      employee_number, location_id, department_id, work_date, entry_type,
      entry_timestamp, source, created_by, client_request_id, mobile_session_id
    ) VALUES (
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.departmentId'),
      json_extract($payload, '$.workDate'),
      json_extract($payload, '$.entryType'),
      json_extract($payload, '$.entryTimestamp'),
      json_extract($payload, '$.source'),
      json_extract($payload, '$.createdBy'),
      NULLIF(json_extract($payload, '$.clientRequestId'), ''),
      NULLIF(json_extract($payload, '$.mobileSessionId'), '')
    )
    RETURNING json_object('id', id) AS data
  `, true),
  entry(S.invalidateDayReview, `
    DELETE FROM time_day_reviews
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND work_date = json_extract($payload, '$.workDate')
  `),

  entry(S.getEmployeeContext, `
    SELECT ${jsonObject({
      ...EMPLOYEE_FIELDS,
      fallback_location_id: "(SELECT location.id FROM locations location ORDER BY location.active DESC, location.id LIMIT 1)",
    })}
    FROM employees e
    WHERE e.personnel_number = json_extract($payload, '$.employeeNumber')
      AND (
        json_extract($payload, '$.includeInactive') = 1
        OR e.active = 1
      )
  `),
  entry(S.getShiftDepartmentForDate, `
    SELECT ${jsonObject({ department_id: "s.department_id" })}
    FROM shifts s
    WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
      AND s.shift_date = json_extract($payload, '$.date')
      AND s.department_id IS NOT NULL
    ORDER BY s.start_time, s.id
    LIMIT 1
  `),
  entry(S.getLatestEntryContext, `
    SELECT ${jsonObject({
      location_id: "t.location_id",
      department_id: "t.department_id",
    })}
    FROM time_entries t
    WHERE t.employee_number = json_extract($payload, '$.employeeNumber')
      AND t.work_date = json_extract($payload, '$.date')
      AND t.voided_at IS NULL
    ORDER BY t.entry_timestamp DESC, t.id DESC
    LIMIT 1
  `),
  entry(S.getPlannedShiftContext, `
    SELECT ${jsonObject({
      location_id: "s.location_id",
      department_id: "s.department_id",
    })}
    FROM shifts s
    WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
      AND s.shift_date = json_extract($payload, '$.date')
    ORDER BY s.start_time, s.id
    LIMIT 1
  `),
  entry(S.getLatestShiftEnd, `
    SELECT ${jsonObject({ end_time: "s.end_time" })}
    FROM shifts s
    WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
      AND s.shift_date = json_extract($payload, '$.date')
    ORDER BY s.end_time DESC, s.id DESC
    LIMIT 1
  `),
  entry(S.listPlannedDayShifts, `
    SELECT ${jsonObject({
      id: "s.id",
      employee_number: "s.employee_number",
      location_id: "s.location_id",
      department_id: "s.department_id",
      shift_date: "s.shift_date",
      start_time: "s.start_time",
      end_time: "s.end_time",
    })}
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number
    WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
      AND s.shift_date = json_extract($payload, '$.date')
      AND (
        json_extract($payload, '$.filterDepartment') = 0
        OR s.department_id = json_extract($payload, '$.departmentId')
      )
      AND (
        json_extract($payload, '$.filterLocation') = 0
        OR s.location_id = json_extract($payload, '$.locationId')
      )
    ORDER BY s.start_time, s.id
  `),
  entry(S.listExcusedOptions, `
    SELECT ${jsonObject({
      option_type: "option.option_type",
      note: "option.note",
      all_day: "option.all_day",
      start_time: "option.start_time",
      end_time: "option.end_time",
    })}
    FROM week_options option
    WHERE option.employee_number = json_extract($payload, '$.employeeNumber')
      AND json_extract($payload, '$.date') BETWEEN option.date_from AND option.date_to
    ORDER BY option.all_day DESC, option.start_time
  `),

  entry(S.getDayReview, `
    SELECT ${jsonObject(DAY_REVIEW_FIELDS)}
    FROM time_day_reviews review
    WHERE review.employee_number = json_extract($payload, '$.employeeNumber')
      AND review.work_date = json_extract($payload, '$.workDate')
      AND review.department_key = json_extract($payload, '$.departmentKey')
  `),
  entry(S.invalidateDayReviewsForRange, `
    DELETE FROM time_day_reviews
    WHERE location_id = json_extract($payload, '$.locationId')
      AND work_date BETWEEN json_extract($payload, '$.dateFrom')
        AND json_extract($payload, '$.dateTo')
      AND (
        json_extract($payload, '$.filterDepartment') = 0
        OR department_key IN (0, json_extract($payload, '$.departmentId'))
      )
  `),
  entry(S.deleteScopedDayReview, `
    DELETE FROM time_day_reviews
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND work_date = json_extract($payload, '$.workDate')
      AND department_key = json_extract($payload, '$.departmentKey')
  `),
  entry(S.upsertDayReview, `
    INSERT INTO time_day_reviews (
      employee_number, location_id, department_id, department_key, work_date,
      note, reviewed_by, reviewed_at, evaluation_version, snapshot_json,
      updated_at
    )
    VALUES (
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.departmentId'),
      json_extract($payload, '$.departmentKey'),
      json_extract($payload, '$.workDate'),
      json_extract($payload, '$.note'),
      json_extract($payload, '$.reviewedBy'),
      CURRENT_TIMESTAMP,
      json_extract($payload, '$.evaluationVersion'),
      json_extract($payload, '$.snapshotJson'),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(employee_number, work_date, department_key) DO UPDATE SET
      location_id = excluded.location_id,
      department_id = excluded.department_id,
      note = excluded.note,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = CURRENT_TIMESTAMP,
      evaluation_version = excluded.evaluation_version,
      snapshot_json = excluded.snapshot_json,
      updated_at = CURRENT_TIMESTAMP
  `),

  entry(S.hasPendingCorrection, `
    SELECT ${jsonObject({ exists: "1" })}
    FROM time_corrections c
    WHERE c.employee_number = json_extract($payload, '$.employeeNumber')
      AND c.correction_date = json_extract($payload, '$.date')
      AND c.status = 'pending'
      AND (
        json_extract($payload, '$.filterLocation') = 0
        OR c.location_id = json_extract($payload, '$.locationId')
      )
      AND (
        json_extract($payload, '$.filterDepartment') = 0
        OR c.department_id = json_extract($payload, '$.departmentId')
      )
    LIMIT 1
  `),
  entry(S.listTimeEntriesForDay, `
    SELECT ${jsonObject(TIME_ENTRY_FIELDS)}
    FROM time_entries t
    WHERE t.employee_number = json_extract($payload, '$.employeeNumber')
      AND t.work_date = json_extract($payload, '$.date')
      AND t.voided_at IS NULL
    ORDER BY t.entry_timestamp, t.id
  `),
  entry(S.listPastTimeEntryDates, `
    SELECT ${jsonObject({ work_date: "t.work_date" })}
    FROM time_entries t
    WHERE t.employee_number = json_extract($payload, '$.employeeNumber')
      AND t.work_date < json_extract($payload, '$.today')
      AND t.voided_at IS NULL
    GROUP BY t.work_date
    ORDER BY t.work_date DESC
  `),
  entry(S.listScheduledShiftDepartments, `
    SELECT ${jsonObject({
      department_id: "s.department_id",
      start_time: "s.start_time",
      end_time: "s.end_time",
    })}
    FROM shifts s
    WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
      AND s.shift_date = json_extract($payload, '$.date')
      AND s.department_id IS NOT NULL
    ORDER BY s.start_time, s.id
  `),
  entry(S.listContextEmployees, `
    SELECT ${jsonObject(EMPLOYEE_FIELDS)}
    FROM employees e
    WHERE e.active = 1
      AND (
        COALESCE(json_extract($payload, '$.employeeNumber'), '') = ''
        OR e.personnel_number = json_extract($payload, '$.employeeNumber')
      )
      AND (
        (
          e.home_location_id = json_extract($payload, '$.locationId')
          AND (
            json_extract($payload, '$.filterDepartment') = 0
            OR e.preferred_department_id = json_extract($payload, '$.departmentId')
          )
        )
        OR EXISTS (
          SELECT 1
          FROM shifts s
          WHERE s.employee_number = e.personnel_number
            AND s.shift_date = json_extract($payload, '$.date')
            AND s.location_id = json_extract($payload, '$.locationId')
            AND (
              json_extract($payload, '$.filterDepartment') = 0
              OR s.department_id = json_extract($payload, '$.departmentId')
            )
        )
        OR EXISTS (
          SELECT 1
          FROM time_entries t
          WHERE t.employee_number = e.personnel_number
            AND t.work_date = json_extract($payload, '$.date')
            AND t.location_id = json_extract($payload, '$.locationId')
            AND t.voided_at IS NULL
            AND (
              json_extract($payload, '$.filterDepartment') = 0
              OR t.department_id = json_extract($payload, '$.departmentId')
            )
        )
      )
    ORDER BY CAST(e.personnel_number AS INTEGER), e.personnel_number
  `),
  entry(S.listSummaryEmployees, `
    SELECT ${jsonObject(EMPLOYEE_FIELDS)}
    FROM employees e
    WHERE e.active = 1
      AND (
        e.home_location_id = json_extract($payload, '$.locationId')
        OR EXISTS (
          SELECT 1
          FROM shifts s
          WHERE s.employee_number = e.personnel_number
            AND s.location_id = json_extract($payload, '$.locationId')
            AND s.shift_date BETWEEN json_extract($payload, '$.dateFrom')
              AND json_extract($payload, '$.dateTo')
        )
        OR EXISTS (
          SELECT 1
          FROM time_entries t
          WHERE t.employee_number = e.personnel_number
            AND t.location_id = json_extract($payload, '$.locationId')
            AND t.work_date BETWEEN json_extract($payload, '$.dateFrom')
              AND json_extract($payload, '$.dateTo')
            AND t.voided_at IS NULL
        )
      )
      AND (
        json_extract($payload, '$.filterDepartment') = 0
        OR e.preferred_department_id = json_extract($payload, '$.departmentId')
        OR EXISTS (
          SELECT 1
          FROM shifts s
          WHERE s.employee_number = e.personnel_number
            AND s.shift_date BETWEEN json_extract($payload, '$.dateFrom')
              AND json_extract($payload, '$.dateTo')
            AND s.department_id = json_extract($payload, '$.departmentId')
        )
        OR EXISTS (
          SELECT 1
          FROM time_entries t
          WHERE t.employee_number = e.personnel_number
            AND t.work_date BETWEEN json_extract($payload, '$.dateFrom')
              AND json_extract($payload, '$.dateTo')
            AND t.department_id = json_extract($payload, '$.departmentId')
            AND t.voided_at IS NULL
        )
      )
    ORDER BY CAST(e.personnel_number AS INTEGER), e.personnel_number
  `),

  entry(S.listCorrections, `
    SELECT ${jsonObject({
      ...CORRECTION_FIELDS,
      full_name: "e.full_name",
      nickname: "e.nickname",
      location_name: "l.name",
      department_name: "d.name",
    })}
    FROM time_corrections c
    JOIN employees e ON e.personnel_number = c.employee_number
    LEFT JOIN locations l ON l.id = c.location_id
    LEFT JOIN departments d ON d.id = c.department_id
    WHERE (
        COALESCE(json_extract($payload, '$.employeeNumber'), '') = ''
        OR c.employee_number = json_extract($payload, '$.employeeNumber')
      )
      AND (
        COALESCE(json_extract($payload, '$.id'), 0) = 0
        OR c.id = json_extract($payload, '$.id')
      )
      AND (
        COALESCE(json_extract($payload, '$.dateFrom'), '') = ''
        OR c.correction_date >= json_extract($payload, '$.dateFrom')
      )
      AND (
        COALESCE(json_extract($payload, '$.dateTo'), '') = ''
        OR c.correction_date <= json_extract($payload, '$.dateTo')
      )
      AND (
        json_extract($payload, '$.excludeWithdrawn') = 0
        OR c.status <> 'withdrawn'
      )
      AND (
        COALESCE(json_extract($payload, '$.locationId'), '') = ''
        OR c.location_id = json_extract($payload, '$.locationId')
      )
      AND (
        json_extract($payload, '$.filterDepartment') = 0
        OR c.department_id = json_extract($payload, '$.departmentId')
      )
      AND (
        COALESCE(json_extract($payload, '$.status'), '') IN ('', 'all')
        OR c.status = json_extract($payload, '$.status')
      )
    ORDER BY c.correction_date DESC, c.created_at DESC, c.id DESC
  `),
  entry(S.getCorrection, `
    SELECT ${jsonObject(CORRECTION_FIELDS)}
    FROM time_corrections c
    WHERE c.id = json_extract($payload, '$.id')
  `),
  entry(S.findPendingCorrection, `
    SELECT ${jsonObject({ id: "c.id" })}
    FROM time_corrections c
    WHERE c.employee_number = json_extract($payload, '$.employeeNumber')
      AND c.correction_date = json_extract($payload, '$.correctionDate')
      AND c.status = 'pending'
      AND c.id <> json_extract($payload, '$.excludeId')
    LIMIT 1
  `),
  entry(S.listActiveTimeEntriesForRange, `
    SELECT ${jsonObject(TIME_ENTRY_FIELDS)}
    FROM time_entries t
    WHERE t.employee_number = json_extract($payload, '$.employeeNumber')
      AND t.work_date BETWEEN json_extract($payload, '$.dateFrom')
        AND json_extract($payload, '$.dateTo')
      AND t.voided_at IS NULL
      AND (
        json_extract($payload, '$.filterDepartment') = 0
        OR t.department_id = json_extract($payload, '$.departmentId')
      )
    ORDER BY t.work_date, t.entry_timestamp, t.id
  `),
  entry(S.listDistinctShiftDepartments, `
    SELECT ${jsonObject({ department_id: "s.department_id" })}
    FROM shifts s
    WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
      AND s.shift_date = json_extract($payload, '$.correctionDate')
      AND s.department_id IS NOT NULL
    GROUP BY s.department_id
    ORDER BY s.department_id
  `),
  entry(S.insertCorrection, `
    INSERT INTO time_corrections (
      employee_number, location_id, department_id, correction_date,
      requested_change, request_note, status, requested_by, decided_by,
      decided_at, decision_note
    )
    VALUES (
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.departmentId'),
      json_extract($payload, '$.correctionDate'),
      json_extract($payload, '$.requestedChange'),
      json_extract($payload, '$.requestNote'),
      json_extract($payload, '$.status'),
      json_extract($payload, '$.requestedBy'),
      NULLIF(json_extract($payload, '$.decidedBy'), ''),
      CASE
        WHEN json_extract($payload, '$.decideNow') = 1 THEN CURRENT_TIMESTAMP
        ELSE NULL
      END,
      json_extract($payload, '$.decisionNote')
    )
    RETURNING json_object('id', id) AS data
  `, true),
  entry(S.updateCorrectionRequestedChange, `
    UPDATE time_corrections
    SET requested_change = json_extract($payload, '$.requestedChange'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.updateOwnCorrection, `
    UPDATE time_corrections
    SET location_id = json_extract($payload, '$.locationId'),
        department_id = json_extract($payload, '$.departmentId'),
        correction_date = json_extract($payload, '$.correctionDate'),
        requested_change = json_extract($payload, '$.requestedChange'),
        request_note = json_extract($payload, '$.requestNote'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND employee_number = json_extract($payload, '$.employeeNumber')
      AND status = 'pending'
  `),
  entry(S.withdrawOwnCorrection, `
    UPDATE time_corrections
    SET status = 'withdrawn',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND employee_number = json_extract($payload, '$.employeeNumber')
      AND status = 'pending'
  `),
  entry(S.updateCorrectionScope, `
    UPDATE time_corrections
    SET location_id = json_extract($payload, '$.locationId'),
        department_id = json_extract($payload, '$.departmentId'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.voidActiveTimeEntries, `
    UPDATE time_entries
    SET voided_at = CURRENT_TIMESTAMP,
        voided_by = json_extract($payload, '$.voidedBy'),
        void_reason = json_extract($payload, '$.voidReason'),
        correction_id = json_extract($payload, '$.correctionId')
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND work_date = json_extract($payload, '$.workDate')
      AND voided_at IS NULL
  `),
  entry(S.insertCorrectionTimeEntry, `
    INSERT INTO time_entries (
      employee_number, location_id, department_id, work_date, entry_type,
      entry_timestamp, source, note, created_by, correction_id
    )
    VALUES (
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.departmentId'),
      json_extract($payload, '$.workDate'),
      json_extract($payload, '$.entryType'),
      json_extract($payload, '$.entryTimestamp'),
      'manager_correction',
      json_extract($payload, '$.note'),
      json_extract($payload, '$.createdBy'),
      json_extract($payload, '$.correctionId')
    )
    RETURNING json_object('id', id) AS data
  `, true),
  entry(S.decideCorrection, `
    UPDATE time_corrections
    SET status = json_extract($payload, '$.status'),
        decided_by = json_extract($payload, '$.decidedBy'),
        decided_at = CURRENT_TIMESTAMP,
        decision_note = json_extract($payload, '$.decisionNote'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND status = 'pending'
  `),
  entry(S.markCorrectionNotificationsRead, `
    UPDATE portal_notifications
    SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE entity_type = 'time_correction'
      AND entity_id = json_extract($payload, '$.entityId')
  `),

  entry(S.listGreetingShiftDates, `
    SELECT ${jsonObject({ shift_date: "s.shift_date" })}
    FROM shifts s
    WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
      AND s.shift_date > json_extract($payload, '$.endedOn')
      AND s.shift_date <= json_extract($payload, '$.horizon')
    GROUP BY s.shift_date
    ORDER BY s.shift_date
  `),
  entry(S.getEmployeeHomeLocation, `
    SELECT ${jsonObject({ home_location_id: "e.home_location_id" })}
    FROM employees e
    WHERE e.personnel_number = json_extract($payload, '$.employeeNumber')
  `),
]);

module.exports = {
  SQLITE_TIME_TRACKING_CATALOG,
};
