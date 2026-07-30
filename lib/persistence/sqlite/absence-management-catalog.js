"use strict";

const {
  ABSENCE_MANAGEMENT_STATEMENTS,
  REQUEST_KINDS,
} = require("../statements/absence-management");

function jsonRow(columns) {
  return `json_object(${columns
    .map(([key, expression]) => `'${key}', ${expression}`)
    .join(", ")})`;
}

function entry(statement, sql, returning = false) {
  return Object.freeze({ statement, sql, returning });
}

const REQUEST_TABLES = Object.freeze({
  vacation: "vacation_requests",
  timeOff: "time_off_requests",
  vacationChange: "vacation_change_requests",
  timeOffChange: "time_off_change_requests",
});

const COMMON_REQUEST_ROW = [
  ["id", "r.id"],
  ["employee_number", "r.employee_number"],
  ["status", "r.status"],
  ["approval_stage", "r.approval_stage"],
  ["decision_note", "r.decision_note"],
  ["local_approved_by", "r.local_approved_by"],
  ["local_approved_at", "r.local_approved_at"],
  ["hr_approved_by", "r.hr_approved_by"],
  ["hr_approved_at", "r.hr_approved_at"],
  ["decided_by", "r.decided_by"],
  ["decided_at", "r.decided_at"],
  ["created_at", "r.created_at"],
  ["updated_at", "r.updated_at"],
];

const REQUEST_ROWS = Object.freeze({
  vacation: Object.freeze([
    ...COMMON_REQUEST_ROW,
    ["location_id", "r.location_id"],
    ["vacation_group_id", "r.vacation_group_id"],
    ["date_from", "r.date_from"],
    ["date_to", "r.date_to"],
    ["note", "r.note"],
  ]),
  timeOff: Object.freeze([
    ...COMMON_REQUEST_ROW,
    ["location_id", "r.location_id"],
    ["request_date", "r.request_date"],
    ["date_from", "COALESCE(r.date_from, r.request_date)"],
    ["date_to", "COALESCE(r.date_to, r.request_date)"],
    ["all_day", "r.all_day"],
    ["start_time", "r.start_time"],
    ["end_time", "r.end_time"],
    ["note", "r.note"],
    ["approval_type", "r.approval_type"],
    ["traffic_light", "r.traffic_light"],
    ["check_reason", "r.check_reason"],
    ["option_id", "r.option_id"],
    ["original_shifts_json", "r.original_shifts_json"],
  ]),
  vacationChange: Object.freeze([
    ...COMMON_REQUEST_ROW,
    ["vacation_group_id", "r.vacation_group_id"],
    ["request_type", "r.request_type"],
    ["original_date_from", "r.original_date_from"],
    ["original_date_to", "r.original_date_to"],
    ["requested_date_from", "r.requested_date_from"],
    ["requested_date_to", "r.requested_date_to"],
    ["note", "r.note"],
  ]),
  timeOffChange: Object.freeze([
    ...COMMON_REQUEST_ROW,
    ["location_id", "r.location_id"],
    ["original_request_id", "r.original_request_id"],
    ["request_type", "r.request_type"],
    ["requested_date_from", "r.requested_date_from"],
    ["requested_date_to", "r.requested_date_to"],
    ["requested_all_day", "r.requested_all_day"],
    ["requested_start_time", "r.requested_start_time"],
    ["requested_end_time", "r.requested_end_time"],
    ["note", "r.note"],
    ["approval_type", "r.approval_type"],
  ]),
});

const BLACKOUT_ROW = [
  ["id", "b.id"],
  ["location_id", "b.location_id"],
  ["department_id", "b.department_id"],
  ["date_from", "b.date_from"],
  ["date_to", "b.date_to"],
  ["block_vacation", "b.block_vacation"],
  ["block_time_off", "b.block_time_off"],
  ["reason", "b.reason"],
  ["active", "b.active"],
  ["created_by", "b.created_by"],
  ["created_at", "b.created_at"],
  ["updated_at", "b.updated_at"],
  ["location_name", "l.name"],
  ["department_name", "d.name"],
];

const NOTIFICATION_ROW = [
  ["cursor_rowid", "n.rowid"],
  ["id", "n.id"],
  ["recipient_employee_number", "n.recipient_employee_number"],
  ["event_type", "n.event_type"],
  ["title", "n.title"],
  ["message", "n.message"],
  ["target", "n.target"],
  ["entity_type", "n.entity_type"],
  ["entity_id", "n.entity_id"],
  ["dedupe_key", "n.dedupe_key"],
  ["read_at", "n.read_at"],
  ["created_at", "n.created_at"],
];
const MOBILE_NOTIFICATION_ROW = NOTIFICATION_ROW.filter(([name]) => name !== "target");

const OPTION_ROW = [
  ["id", "o.id"],
  ["group_id", "o.group_id"],
  ["employee_number", "o.employee_number"],
  ["week_start", "o.week_start"],
  ["date_from", "o.date_from"],
  ["date_to", "o.date_to"],
  ["option_type", "o.option_type"],
  ["note", "o.note"],
  ["credited_minutes_per_day", "o.credited_minutes_per_day"],
  ["all_day", "o.all_day"],
  ["start_time", "o.start_time"],
  ["end_time", "o.end_time"],
  ["created_at", "o.created_at"],
];

const SHIFT_ROW = [
  ["id", "s.id"],
  ["employee_number", "s.employee_number"],
  ["location_id", "s.location_id"],
  ["department_id", "s.department_id"],
  ["shift_date", "s.shift_date"],
  ["start_time", "s.start_time"],
  ["end_time", "s.end_time"],
  ["area", "s.area"],
  ["note", "s.note"],
  ["created_at", "s.created_at"],
];

function requestCatalogEntries() {
  const entries = [];
  for (const kind of REQUEST_KINDS) {
    const table = REQUEST_TABLES[kind];
    const row = REQUEST_ROWS[kind];
    entries.push(entry(ABSENCE_MANAGEMENT_STATEMENTS.requestById[kind], `
      SELECT ${jsonRow(row)} AS data
      FROM ${table} r
      WHERE r.id = $id
      LIMIT 1
    `));
    entries.push(entry(ABSENCE_MANAGEMENT_STATEMENTS.reviewRequests[kind], `
      SELECT ${jsonRow([
        ...row,
        ["employee_full_name", "e.full_name"],
        ["full_name", "e.full_name"],
        ["nickname", "e.nickname"],
        ["color", "e.color"],
        ["employee_home_location_id", "e.home_location_id"],
        ["employee_department_id", "e.preferred_department_id"],
      ])} AS data
      FROM ${table} r
      JOIN employees e ON e.personnel_number = r.employee_number
      ORDER BY r.created_at DESC, r.id DESC
    `));

    const transitions = ABSENCE_MANAGEMENT_STATEMENTS.requestTransitions[kind];
    entries.push(entry(transitions.preliminary, `
      UPDATE ${table}
      SET status = 'preliminary_local', approval_stage = 'local',
          decision_note = json_extract($data, '$.note'),
          local_approved_by = json_extract($data, '$.actor'),
          local_approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = json_extract($data, '$.id')
    `));
    entries.push(entry(transitions.reject, `
      UPDATE ${table}
      SET status = 'rejected', approval_stage = 'complete',
          decision_note = json_extract($data, '$.note'),
          decided_by = json_extract($data, '$.actor'),
          decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = json_extract($data, '$.id')
    `));
    entries.push(entry(transitions.localApproved, `
      UPDATE ${table}
      SET status = 'approved', approval_stage = 'complete',
          decision_note = json_extract($data, '$.note'),
          local_approved_by = COALESCE(local_approved_by, json_extract($data, '$.actor')),
          local_approved_at = COALESCE(local_approved_at, CURRENT_TIMESTAMP),
          decided_by = json_extract($data, '$.actor'),
          decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = json_extract($data, '$.id')
    `));
    entries.push(entry(transitions.pendingHr, `
      UPDATE ${table}
      SET status = 'pending_hr', approval_stage = 'hr',
          decision_note = json_extract($data, '$.note'),
          local_approved_by = json_extract($data, '$.actor'),
          local_approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = json_extract($data, '$.id')
    `));
    entries.push(entry(transitions.hrApproved, `
      UPDATE ${table}
      SET status = 'approved', approval_stage = 'complete',
          decision_note = json_extract($data, '$.note'),
          hr_approved_by = json_extract($data, '$.actor'),
          hr_approved_at = CURRENT_TIMESTAMP,
          decided_by = json_extract($data, '$.actor'),
          decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = json_extract($data, '$.id')
    `));
    entries.push(entry(transitions.cancel, `
      UPDATE ${table}
      SET status = 'cancelled', approval_stage = 'complete',
          decision_note = json_extract($data, '$.note'),
          decided_by = json_extract($data, '$.actor'),
          decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = json_extract($data, '$.id')
    `));
  }
  return entries;
}

const SQLITE_ABSENCE_MANAGEMENT_CATALOG = Object.freeze([
  entry(ABSENCE_MANAGEMENT_STATEMENTS.listBlackouts, `
    SELECT ${jsonRow(BLACKOUT_ROW)} AS data
    FROM request_blackouts b
    JOIN locations l ON l.id = b.location_id
    LEFT JOIN departments d ON d.id = b.department_id
    ORDER BY b.active DESC, b.date_from, b.location_id, b.department_id
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.listActiveBlackouts, `
    SELECT ${jsonRow(BLACKOUT_ROW)} AS data
    FROM request_blackouts b
    JOIN locations l ON l.id = b.location_id
    LEFT JOIN departments d ON d.id = b.department_id
    WHERE b.active = 1
    ORDER BY b.date_from, b.location_id, b.department_id
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.duplicateBlackout, `
    SELECT json_object('id', b.id) AS data
    FROM request_blackouts b
    WHERE b.id <> json_extract($data, '$.existingId')
      AND b.location_id = json_extract($data, '$.locationId')
      AND COALESCE(b.department_id, 0) = COALESCE(json_extract($data, '$.departmentId'), 0)
      AND b.date_from = json_extract($data, '$.dateFrom')
      AND b.date_to = json_extract($data, '$.dateTo')
      AND b.block_vacation = json_extract($data, '$.blockVacation')
      AND b.block_time_off = json_extract($data, '$.blockTimeOff')
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.matchingVacationBlackout, `
    SELECT ${jsonRow(BLACKOUT_ROW)} AS data
    FROM request_blackouts b
    JOIN locations l ON l.id = b.location_id
    LEFT JOIN departments d ON d.id = b.department_id
    WHERE b.active = 1 AND b.location_id = json_extract($data, '$.locationId')
      AND b.block_vacation = 1
      AND b.date_from <= json_extract($data, '$.dateTo')
      AND b.date_to >= json_extract($data, '$.dateFrom')
      AND (b.department_id IS NULL OR b.department_id = json_extract($data, '$.departmentId'))
    ORDER BY CASE WHEN b.department_id IS NULL THEN 1 ELSE 0 END, b.date_from
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.matchingTimeOffBlackout, `
    SELECT ${jsonRow(BLACKOUT_ROW)} AS data
    FROM request_blackouts b
    JOIN locations l ON l.id = b.location_id
    LEFT JOIN departments d ON d.id = b.department_id
    WHERE b.active = 1 AND b.location_id = json_extract($data, '$.locationId')
      AND b.block_time_off = 1
      AND b.date_from <= json_extract($data, '$.dateTo')
      AND b.date_to >= json_extract($data, '$.dateFrom')
      AND (b.department_id IS NULL OR b.department_id = json_extract($data, '$.departmentId'))
    ORDER BY CASE WHEN b.department_id IS NULL THEN 1 ELSE 0 END, b.date_from
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.blackoutById, `
    SELECT ${jsonRow(BLACKOUT_ROW)} AS data
    FROM request_blackouts b
    JOIN locations l ON l.id = b.location_id
    LEFT JOIN departments d ON d.id = b.department_id
    WHERE b.id = $id
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.insertBlackout, `
    INSERT INTO request_blackouts
      (location_id, department_id, date_from, date_to, block_vacation,
       block_time_off, reason, active, created_by)
    VALUES (
      json_extract($data, '$.locationId'),
      json_extract($data, '$.departmentId'),
      json_extract($data, '$.dateFrom'),
      json_extract($data, '$.dateTo'),
      json_extract($data, '$.blockVacation'),
      json_extract($data, '$.blockTimeOff'),
      json_extract($data, '$.reason'),
      json_extract($data, '$.active'),
      json_extract($data, '$.createdBy')
    )
    RETURNING json_object('id', id) AS data
  `, true),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.updateBlackout, `
    UPDATE request_blackouts
    SET location_id = json_extract($data, '$.locationId'),
        department_id = json_extract($data, '$.departmentId'),
        date_from = json_extract($data, '$.dateFrom'),
        date_to = json_extract($data, '$.dateTo'),
        block_vacation = json_extract($data, '$.blockVacation'),
        block_time_off = json_extract($data, '$.blockTimeOff'),
        reason = json_extract($data, '$.reason'),
        active = json_extract($data, '$.active'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.deleteBlackout, `
    DELETE FROM request_blackouts
    WHERE id = json_extract($data, '$.id')
  `),

  entry(ABSENCE_MANAGEMENT_STATEMENTS.reviewersHr, `
    SELECT json_object('employee_number', u.employee_number) AS data
    FROM portal_users u
    WHERE u.active = 1 AND TRIM(u.password_hash) <> ''
      AND u.role IN ('hr', 'admin')
    ORDER BY u.employee_number
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.reviewersLocal, `
    SELECT json_object('employee_number', u.employee_number) AS data
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    WHERE u.active = 1 AND TRIM(u.password_hash) <> ''
      AND (
        u.role = 'admin'
        OR (
          u.role IN ('manager', 'department_manager')
          AND (
            EXISTS (
              SELECT 1 FROM portal_access_scopes s
              WHERE s.employee_number = u.employee_number
                AND s.location_id = json_extract($data, '$.locationId')
                AND (
                  u.role = 'manager'
                  OR s.department_id = json_extract($data, '$.departmentId')
                )
            )
            OR (
              NOT EXISTS (
                SELECT 1 FROM portal_access_scopes s
                WHERE s.employee_number = u.employee_number
              )
              AND e.home_location_id = json_extract($data, '$.locationId')
              AND (
                u.role = 'manager'
                OR e.preferred_department_id = json_extract($data, '$.departmentId')
              )
            )
          )
        )
      )
    ORDER BY u.employee_number
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.insertNotification, `
    INSERT OR IGNORE INTO portal_notifications
      (id, recipient_employee_number, event_type, title, message, target,
       entity_type, entity_id, dedupe_key)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.recipient'),
      json_extract($data, '$.eventType'),
      json_extract($data, '$.title'),
      json_extract($data, '$.message'),
      json_extract($data, '$.target'),
      json_extract($data, '$.entityType'),
      json_extract($data, '$.entityId'),
      json_extract($data, '$.dedupeKey')
    )
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.notificationByDedupe, `
    SELECT json_object('id', n.id) AS data
    FROM portal_notifications n
    WHERE n.recipient_employee_number = json_extract($data, '$.recipient')
      AND n.dedupe_key = json_extract($data, '$.dedupeKey')
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.reactivateNotification, `
    UPDATE portal_notifications
    SET read_at = NULL, created_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.resolveReviewNotifications, `
    UPDATE portal_notifications
    SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE event_type = 'request.review'
      AND dedupe_key LIKE (
        json_extract($data, '$.kind') || ':' || json_extract($data, '$.id') || ':%:review'
      )
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.resolveReviewNotificationsForStage, `
    UPDATE portal_notifications
    SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE event_type = 'request.review'
      AND dedupe_key = (
        json_extract($data, '$.kind') || ':' || json_extract($data, '$.id')
        || ':' || json_extract($data, '$.stage') || ':review'
      )
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.portalNotifications, `
    SELECT ${jsonRow(NOTIFICATION_ROW)} AS data
    FROM portal_notifications n
    WHERE n.recipient_employee_number = $employeeNumber
    ORDER BY n.rowid DESC
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.portalUnreadCount, `
    SELECT json_object('count', COUNT(*)) AS data
    FROM portal_notifications n
    WHERE n.recipient_employee_number = $employeeNumber AND n.read_at IS NULL
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.mobileNotifications, `
    SELECT ${jsonRow(MOBILE_NOTIFICATION_ROW)} AS data
    FROM portal_notifications n
    WHERE n.recipient_employee_number = json_extract($data, '$.employeeNumber')
      AND n.rowid < json_extract($data, '$.cursor')
    ORDER BY n.rowid DESC
    LIMIT json_extract($data, '$.limit')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.mobileUnreadNotifications, `
    SELECT ${jsonRow(MOBILE_NOTIFICATION_ROW)} AS data
    FROM portal_notifications n
    WHERE n.recipient_employee_number = json_extract($data, '$.employeeNumber')
      AND n.rowid < json_extract($data, '$.cursor')
      AND n.read_at IS NULL
    ORDER BY n.rowid DESC
    LIMIT json_extract($data, '$.limit')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.markNotificationRead, `
    UPDATE portal_notifications
    SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE id = json_extract($data, '$.id')
      AND recipient_employee_number = json_extract($data, '$.employeeNumber')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.markAllNotificationsRead, `
    UPDATE portal_notifications
    SET read_at = CURRENT_TIMESTAMP
    WHERE recipient_employee_number = json_extract($data, '$.employeeNumber')
      AND read_at IS NULL
  `),

  entry(ABSENCE_MANAGEMENT_STATEMENTS.insertRequestDecision, `
    INSERT INTO request_decisions
      (request_kind, request_id, stage, action, actor_employee_number, note)
    VALUES (
      json_extract($data, '$.kind'),
      json_extract($data, '$.id'),
      json_extract($data, '$.stage'),
      json_extract($data, '$.action'),
      json_extract($data, '$.actor'),
      json_extract($data, '$.note')
    )
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.requestDecisions, `
    SELECT json_object(
      'id', d.id, 'stage', d.stage, 'action', d.action,
      'actor_employee_number', d.actor_employee_number,
      'note', d.note, 'created_at', d.created_at
    ) AS data
    FROM request_decisions d
    WHERE d.request_kind = json_extract($data, '$.kind')
      AND d.request_id = json_extract($data, '$.id')
    ORDER BY d.id
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.insertAudit, `
    INSERT INTO audit_log (actor, action, entity_type, entity_id, detail)
    VALUES (
      json_extract($data, '$.actor'),
      json_extract($data, '$.action'),
      json_extract($data, '$.entityType'),
      json_extract($data, '$.entityId'),
      json_extract($data, '$.detail')
    )
  `),

  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationHistory, `
    SELECT ${jsonRow(REQUEST_ROWS.vacation)} AS data
    FROM vacation_requests r
    WHERE r.employee_number = $employeeNumber
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.timeOffHistory, `
    SELECT ${jsonRow(REQUEST_ROWS.timeOff)} AS data
    FROM time_off_requests r
    WHERE r.employee_number = $employeeNumber
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationChangeHistory, `
    SELECT ${jsonRow(REQUEST_ROWS.vacationChange)} AS data
    FROM vacation_change_requests r
    WHERE r.employee_number = $employeeNumber
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.timeOffChangeHistory, `
    SELECT ${jsonRow([
      ...REQUEST_ROWS.timeOffChange,
      ["original_date_from", "COALESCE(t.date_from, t.request_date)"],
      ["original_date_to", "COALESCE(t.date_to, t.request_date)"],
      ["original_all_day", "t.all_day"],
      ["original_start_time", "t.start_time"],
      ["original_end_time", "t.end_time"],
    ])} AS data
    FROM time_off_change_requests r
    JOIN time_off_requests t ON t.id = r.original_request_id
    WHERE r.employee_number = $employeeNumber
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.approvedTimeOff, `
    SELECT ${jsonRow(REQUEST_ROWS.timeOff)} AS data
    FROM time_off_requests r
    WHERE r.employee_number = json_extract($data, '$.employeeNumber')
      AND r.status = 'approved'
      AND COALESCE(r.date_to, r.request_date) >= json_extract($data, '$.fromDate')
    ORDER BY COALESCE(r.date_from, r.request_date), r.start_time, r.id
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.pendingTimeOffChanges, `
    SELECT ${jsonRow(REQUEST_ROWS.timeOffChange)} AS data
    FROM time_off_change_requests r
    WHERE r.employee_number = $employeeNumber
      AND r.status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
    ORDER BY r.created_at DESC
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.pendingVacationChanges, `
    SELECT ${jsonRow(REQUEST_ROWS.vacationChange)} AS data
    FROM vacation_change_requests r
    WHERE r.employee_number = $employeeNumber
      AND r.status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
    ORDER BY r.created_at DESC
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.approvedVacationRows, `
    SELECT ${jsonRow(OPTION_ROW)} AS data
    FROM week_options o
    WHERE o.employee_number = json_extract($data, '$.employeeNumber')
      AND o.option_type = 'vacation'
      AND o.date_to >= json_extract($data, '$.fromDate')
    ORDER BY o.date_from, o.id
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.pendingAbsenceForLocation, `
    SELECT json_object(
      'employee_number', r.employee_number,
      'request_date', r.date_from
    ) AS data
    FROM vacation_requests r
    WHERE r.location_id = json_extract($data, '$.locationId')
      AND r.status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
    UNION ALL
    SELECT json_object(
      'employee_number', r.employee_number,
      'request_date', COALESCE(r.date_from, r.request_date)
    ) AS data
    FROM time_off_requests r
    WHERE r.location_id = json_extract($data, '$.locationId')
      AND r.status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.pendingTimeOffForRange, `
    SELECT json_object(
      'id', r.id,
      'employee_number', r.employee_number,
      'date_from', COALESCE(r.date_from, r.request_date),
      'date_to', COALESCE(r.date_to, r.request_date),
      'all_day', r.all_day,
      'start_time', r.start_time,
      'end_time', r.end_time,
      'note', r.note,
      'nickname', e.nickname,
      'color', e.color,
      'contracted_hours', e.contracted_hours
    ) AS data
    FROM time_off_requests r
    JOIN employees e ON e.personnel_number = r.employee_number
    WHERE r.status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
      AND COALESCE(r.date_from, r.request_date) <= json_extract($data, '$.dateTo')
      AND COALESCE(r.date_to, r.request_date) >= json_extract($data, '$.dateFrom')
    ORDER BY COALESCE(r.date_from, r.request_date), r.id
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationRequestSources, `
    SELECT json_object(
      'vacation_group_id', r.vacation_group_id,
      'source', CASE
        WHEN SUM(CASE WHEN r.status = 'approved' THEN 1 ELSE 0 END) > 0
          THEN 'approved_request'
        ELSE 'request'
      END
    ) AS data
    FROM vacation_requests r
    WHERE r.vacation_group_id IS NOT NULL
      AND TRIM(r.vacation_group_id) <> ''
    GROUP BY r.vacation_group_id
  `),

  entry(ABSENCE_MANAGEMENT_STATEMENTS.openVacationForOwner, `
    SELECT ${jsonRow(REQUEST_ROWS.vacation)} AS data
    FROM vacation_requests r
    WHERE r.id = json_extract($data, '$.id')
      AND r.employee_number = json_extract($data, '$.employeeNumber')
      AND r.status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.openTimeOffForOwner, `
    SELECT ${jsonRow(REQUEST_ROWS.timeOff)} AS data
    FROM time_off_requests r
    WHERE r.id = json_extract($data, '$.id')
      AND r.employee_number = json_extract($data, '$.employeeNumber')
      AND r.status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.openVacationChangeForOwner, `
    SELECT ${jsonRow(REQUEST_ROWS.vacationChange)} AS data
    FROM vacation_change_requests r
    WHERE r.id = json_extract($data, '$.id')
      AND r.employee_number = json_extract($data, '$.employeeNumber')
      AND r.status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.openTimeOffChangeForOwner, `
    SELECT ${jsonRow(REQUEST_ROWS.timeOffChange)} AS data
    FROM time_off_change_requests r
    WHERE r.id = json_extract($data, '$.id')
      AND r.employee_number = json_extract($data, '$.employeeNumber')
      AND r.status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.approvedTimeOffForOwner, `
    SELECT ${jsonRow(REQUEST_ROWS.timeOff)} AS data
    FROM time_off_requests r
    WHERE r.id = json_extract($data, '$.id')
      AND r.employee_number = json_extract($data, '$.employeeNumber')
      AND r.status = 'approved'
      AND COALESCE(r.date_to, r.request_date) >= json_extract($data, '$.fromDate')
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationOverlap, `
    SELECT json_object('id', r.id) AS data
    FROM vacation_requests r
    WHERE r.employee_number = json_extract($data, '$.employeeNumber')
      AND r.id <> json_extract($data, '$.excludeId')
      AND r.status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr', 'approved')
      AND r.date_from <= json_extract($data, '$.dateTo')
      AND r.date_to >= json_extract($data, '$.dateFrom')
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.pendingVacationChange, `
    SELECT json_object('id', r.id) AS data
    FROM vacation_change_requests r
    WHERE r.employee_number = json_extract($data, '$.employeeNumber')
      AND r.vacation_group_id = json_extract($data, '$.groupId')
      AND r.status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.pendingTimeOffChange, `
    SELECT json_object('id', r.id) AS data
    FROM time_off_change_requests r
    WHERE r.original_request_id = json_extract($data, '$.originalRequestId')
      AND r.status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.timeOffRangeOverlap, `
    SELECT json_object('id', r.id) AS data
    FROM time_off_requests r
    WHERE r.employee_number = json_extract($data, '$.employeeNumber')
      AND r.id <> json_extract($data, '$.excludeId')
      AND r.status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr', 'approved')
      AND COALESCE(r.date_from, r.request_date) <= json_extract($data, '$.dateTo')
      AND COALESCE(r.date_to, r.request_date) >= json_extract($data, '$.dateFrom')
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.timeOffPointOverlap, `
    SELECT json_object('id', r.id) AS data
    FROM time_off_requests r
    WHERE r.employee_number = json_extract($data, '$.employeeNumber')
      AND r.id <> json_extract($data, '$.excludeId')
      AND r.status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr', 'approved')
      AND json_extract($data, '$.date') BETWEEN COALESCE(r.date_from, r.request_date)
        AND COALESCE(r.date_to, r.request_date)
      AND (
        r.all_day = 1
        OR (
          r.start_time < json_extract($data, '$.endTime')
          AND json_extract($data, '$.startTime') < r.end_time
        )
      )
    LIMIT 1
  `),

  entry(ABSENCE_MANAGEMENT_STATEMENTS.insertVacationRequest, `
    INSERT INTO vacation_requests
      (employee_number, location_id, date_from, date_to, note, status, approval_stage)
    VALUES (
      json_extract($data, '$.employeeNumber'),
      json_extract($data, '$.locationId'),
      json_extract($data, '$.dateFrom'),
      json_extract($data, '$.dateTo'),
      json_extract($data, '$.note'),
      'pending_local',
      'local'
    )
    RETURNING json_object('id', id) AS data
  `, true),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.insertTimeOffRequest, `
    INSERT INTO time_off_requests
      (employee_number, location_id, request_date, date_from, date_to, all_day,
       start_time, end_time, note, approval_type, approval_stage, status,
       traffic_light, check_reason)
    VALUES (
      json_extract($data, '$.employeeNumber'),
      json_extract($data, '$.locationId'),
      json_extract($data, '$.requestDate'),
      json_extract($data, '$.dateFrom'),
      json_extract($data, '$.dateTo'),
      json_extract($data, '$.allDay'),
      json_extract($data, '$.startTime'),
      json_extract($data, '$.endTime'),
      json_extract($data, '$.note'),
      json_extract($data, '$.approvalType'),
      'local',
      'pending_local',
      json_extract($data, '$.trafficLight'),
      json_extract($data, '$.checkReason')
    )
    RETURNING json_object('id', id) AS data
  `, true),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.insertVacationChange, `
    INSERT INTO vacation_change_requests
      (employee_number, vacation_group_id, request_type, original_date_from,
       original_date_to, requested_date_from, requested_date_to, note, status,
       approval_stage)
    VALUES (
      json_extract($data, '$.employeeNumber'),
      json_extract($data, '$.groupId'),
      json_extract($data, '$.requestType'),
      json_extract($data, '$.originalDateFrom'),
      json_extract($data, '$.originalDateTo'),
      json_extract($data, '$.requestedDateFrom'),
      json_extract($data, '$.requestedDateTo'),
      json_extract($data, '$.note'),
      'pending_local',
      'local'
    )
    RETURNING json_object('id', id) AS data
  `, true),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.insertTimeOffChange, `
    INSERT INTO time_off_change_requests
      (employee_number, location_id, original_request_id, request_type,
       requested_date_from, requested_date_to, requested_all_day,
       requested_start_time, requested_end_time, note, status, approval_type,
       approval_stage)
    VALUES (
      json_extract($data, '$.employeeNumber'),
      json_extract($data, '$.locationId'),
      json_extract($data, '$.originalRequestId'),
      json_extract($data, '$.requestType'),
      json_extract($data, '$.requestedDateFrom'),
      json_extract($data, '$.requestedDateTo'),
      json_extract($data, '$.requestedAllDay'),
      json_extract($data, '$.requestedStartTime'),
      json_extract($data, '$.requestedEndTime'),
      json_extract($data, '$.note'),
      'pending_local',
      json_extract($data, '$.approvalType'),
      'local'
    )
    RETURNING json_object('id', id) AS data
  `, true),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.updateVacationRequest, `
    UPDATE vacation_requests
    SET date_from = json_extract($data, '$.dateFrom'),
        date_to = json_extract($data, '$.dateTo'),
        note = json_extract($data, '$.note'),
        status = 'pending_local', approval_stage = 'local', decision_note = '',
        local_approved_by = NULL, local_approved_at = NULL,
        hr_approved_by = NULL, hr_approved_at = NULL,
        decided_by = NULL, decided_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
      AND status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.updateTimeOffRequest, `
    UPDATE time_off_requests
    SET request_date = json_extract($data, '$.requestDate'),
        date_from = json_extract($data, '$.dateFrom'),
        date_to = json_extract($data, '$.dateTo'),
        all_day = json_extract($data, '$.allDay'),
        start_time = json_extract($data, '$.startTime'),
        end_time = json_extract($data, '$.endTime'),
        note = json_extract($data, '$.note'),
        approval_type = json_extract($data, '$.approvalType'),
        status = 'pending_local', approval_stage = 'local',
        traffic_light = json_extract($data, '$.trafficLight'),
        check_reason = json_extract($data, '$.checkReason'),
        decision_note = '', local_approved_by = NULL, local_approved_at = NULL,
        hr_approved_by = NULL, hr_approved_at = NULL,
        decided_by = NULL, decided_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
      AND status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.withdrawVacationRequest, `
    UPDATE vacation_requests
    SET status = 'withdrawn', approval_stage = 'complete',
        decided_by = json_extract($data, '$.actor'),
        decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
      AND status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.withdrawTimeOffRequest, `
    UPDATE time_off_requests
    SET status = 'withdrawn', approval_stage = 'complete',
        decided_by = json_extract($data, '$.actor'),
        decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
      AND status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.withdrawVacationChange, `
    UPDATE vacation_change_requests
    SET status = 'withdrawn', approval_stage = 'complete',
        decided_by = json_extract($data, '$.actor'),
        decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
      AND status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.withdrawTimeOffChange, `
    UPDATE time_off_change_requests
    SET status = 'withdrawn', approval_stage = 'complete',
        decided_by = json_extract($data, '$.actor'),
        decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
      AND status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
  `),

  entry(ABSENCE_MANAGEMENT_STATEMENTS.employeeHomeLocation, `
    SELECT json_object(
      'personnel_number', e.personnel_number,
      'home_location_id', e.home_location_id,
      'preferred_department_id', e.preferred_department_id
    ) AS data
    FROM employees e
    WHERE e.personnel_number = $employeeNumber
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.employeeReviewScope, `
    SELECT json_object(
      'personnel_number', e.personnel_number,
      'full_name', e.full_name,
      'home_location_id', e.home_location_id,
      'preferred_department_id', COALESCE((
        SELECT s.department_id
        FROM shifts s
        WHERE s.employee_number = e.personnel_number
          AND s.shift_date = json_extract($data, '$.date')
          AND s.department_id IS NOT NULL
        ORDER BY s.start_time
        LIMIT 1
      ), e.preferred_department_id)
    ) AS data
    FROM employees e
    WHERE e.personnel_number = json_extract($data, '$.employeeNumber')
      AND (
        json_extract($data, '$.includeInactive') = 1
        OR e.active = 1
      )
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationEmployeeContext, `
    SELECT json_object(
      'personnel_number', e.personnel_number,
      'home_location_id', e.home_location_id,
      'preferred_department_id', e.preferred_department_id,
      'cost_center_id', e.cost_center_id,
      'employee_cost_center_is_branch', ect.is_branch,
      'location_cost_center_id', l.cost_center_id,
      'location_cost_center_is_branch', lct.is_branch
    ) AS data
    FROM employees e
    LEFT JOIN cost_centers ec ON ec.id = e.cost_center_id
    LEFT JOIN cost_center_types ect ON ect.id = ec.cost_center_type_id
    LEFT JOIN locations l ON l.id = e.home_location_id
    LEFT JOIN cost_centers lc ON lc.id = l.cost_center_id
    LEFT JOIN cost_center_types lct ON lct.id = lc.cost_center_type_id
    WHERE e.personnel_number = $employeeNumber AND e.active = 1
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationEntryEmployee, `
    SELECT json_object('personnel_number', e.personnel_number) AS data
    FROM employees e
    WHERE e.personnel_number = $employeeNumber
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationEntryOverlap, `
    SELECT json_object(
      'id', o.id,
      'group_id', o.group_id,
      'option_type', o.option_type,
      'date_from', o.date_from,
      'date_to', o.date_to
    ) AS data
    FROM week_options o
    WHERE o.employee_number = json_extract($data, '$.employeeNumber')
      AND o.date_from <= json_extract($data, '$.dateTo')
      AND o.date_to >= json_extract($data, '$.dateFrom')
      AND COALESCE(o.group_id, 'legacy-' || o.id) <>
        COALESCE(NULLIF(json_extract($data, '$.excludeGroupId'), ''), '__none__')
    ORDER BY o.date_from, o.id
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationEntryShiftConflict, `
    SELECT json_object(
      'shift_date', s.shift_date,
      'start_time', s.start_time,
      'end_time', s.end_time
    ) AS data
    FROM shifts s
    WHERE s.employee_number = json_extract($data, '$.employeeNumber')
      AND s.shift_date BETWEEN json_extract($data, '$.dateFrom')
        AND json_extract($data, '$.dateTo')
    ORDER BY s.shift_date, s.start_time
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationOptionsForDate, `
    SELECT ${jsonRow(OPTION_ROW)} AS data
    FROM week_options o
    WHERE $date BETWEEN o.date_from AND o.date_to
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationCapacityEmployees, `
    SELECT json_object(
      'personnel_number', e.personnel_number,
      'fixed_workdays', e.fixed_workdays,
      'preferred_department_id', e.preferred_department_id
    ) AS data
    FROM employees e
    WHERE e.active = 1 AND e.home_location_id = $locationId
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationShiftsForDate, `
    SELECT ${jsonRow([
      ["id", "s.id"],
      ["employee_number", "s.employee_number"],
      ["department_id", "s.department_id"],
      ["start_time", "s.start_time"],
      ["end_time", "s.end_time"],
    ])} AS data
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number
    LEFT JOIN departments d ON d.id = s.department_id
    WHERE s.shift_date = json_extract($data, '$.date')
      AND COALESCE(s.location_id, d.location_id, e.home_location_id)
        = json_extract($data, '$.locationId')
      AND e.active = 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.departmentStaffing, `
    SELECT json_object('min_staff', d.min_staff, 'name', d.name) AS data
    FROM departments d
    WHERE d.id = json_extract($data, '$.departmentId')
      AND d.location_id = json_extract($data, '$.locationId')
      AND d.active = 1
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.plannedShiftOnDate, `
    SELECT json_object('planned', 1) AS data
    FROM shifts s
    WHERE s.employee_number = json_extract($data, '$.employeeNumber')
      AND s.shift_date = json_extract($data, '$.date')
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.timeOffOptionsOnDate, `
    SELECT ${jsonRow(OPTION_ROW)} AS data
    FROM week_options o
    WHERE o.employee_number = json_extract($data, '$.employeeNumber')
      AND json_extract($data, '$.date') BETWEEN o.date_from AND o.date_to
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.coveringShift, `
    SELECT ${jsonRow(SHIFT_ROW)} AS data
    FROM shifts s
    WHERE s.employee_number = json_extract($data, '$.employeeNumber')
      AND s.shift_date = json_extract($data, '$.date')
      AND s.start_time <= json_extract($data, '$.startTime')
      AND s.end_time >= json_extract($data, '$.endTime')
    ORDER BY s.start_time
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.overlappingShift, `
    SELECT ${jsonRow(SHIFT_ROW)} AS data
    FROM shifts s
    WHERE s.employee_number = json_extract($data, '$.employeeNumber')
      AND s.shift_date = json_extract($data, '$.date')
      AND s.start_time < json_extract($data, '$.endTime')
      AND json_extract($data, '$.startTime') < s.end_time
    ORDER BY s.start_time
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.staffingAtLocation, `
    SELECT json_object('count', COUNT(DISTINCT s.employee_number)) AS data
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number
    WHERE s.shift_date = json_extract($data, '$.date')
      AND s.location_id = json_extract($data, '$.locationId')
      AND s.start_time <= json_extract($data, '$.pointTime')
      AND s.end_time > json_extract($data, '$.pointTime')
      AND s.employee_number <> json_extract($data, '$.excludedEmployeeNumber')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.staffingAtDepartment, `
    SELECT json_object('count', COUNT(DISTINCT s.employee_number)) AS data
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number
    WHERE s.shift_date = json_extract($data, '$.date')
      AND s.location_id = json_extract($data, '$.locationId')
      AND s.department_id = json_extract($data, '$.departmentId')
      AND s.start_time <= json_extract($data, '$.pointTime')
      AND s.end_time > json_extract($data, '$.pointTime')
      AND s.employee_number <> json_extract($data, '$.excludedEmployeeNumber')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.departmentById, `
    SELECT json_object('id', d.id, 'name', d.name, 'min_staff', d.min_staff) AS data
    FROM departments d
    WHERE d.id = $id
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.shiftsForTimeOffRange, `
    SELECT ${jsonRow(SHIFT_ROW)} AS data
    FROM shifts s
    WHERE s.employee_number = json_extract($data, '$.employeeNumber')
      AND s.shift_date BETWEEN json_extract($data, '$.dateFrom')
        AND json_extract($data, '$.dateTo')
    ORDER BY s.shift_date, s.start_time
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.shiftsForTimeOffPeriod, `
    SELECT ${jsonRow(SHIFT_ROW)} AS data
    FROM shifts s
    WHERE s.employee_number = json_extract($data, '$.employeeNumber')
      AND s.shift_date = json_extract($data, '$.date')
      AND s.start_time < json_extract($data, '$.endTime')
      AND json_extract($data, '$.startTime') < s.end_time
    ORDER BY s.start_time
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.shiftsWithinOriginalWindow, `
    SELECT ${jsonRow(SHIFT_ROW)} AS data
    FROM shifts s
    WHERE s.employee_number = json_extract($data, '$.employeeNumber')
      AND s.shift_date = json_extract($data, '$.shiftDate')
      AND COALESCE(s.department_id, 0)
        = COALESCE(json_extract($data, '$.departmentId'), 0)
      AND s.start_time >= json_extract($data, '$.startTime')
      AND s.end_time <= json_extract($data, '$.endTime')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.workRuleEvaluationEmployee, `
    SELECT json_object(
      'personnel_number', e.personnel_number,
      'full_name', e.full_name,
      'nickname', e.nickname,
      'home_location_id', e.home_location_id,
      'preferred_department_id', e.preferred_department_id
    ) AS data
    FROM employees e
    WHERE e.personnel_number = $employeeNumber
    LIMIT 1
  `),

  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationRowsByNumericId, `
    SELECT ${jsonRow(OPTION_ROW)} AS data
    FROM week_options o
    WHERE o.id = $id AND o.option_type = 'vacation'
    ORDER BY o.date_from, o.id
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationRowsByGroupId, `
    SELECT ${jsonRow(OPTION_ROW)} AS data
    FROM week_options o
    WHERE o.group_id = $groupId AND o.option_type = 'vacation'
    ORDER BY o.date_from, o.id
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationExistsByNumericId, `
    SELECT json_object('id', o.id) AS data
    FROM week_options o
    WHERE o.id = $id AND o.option_type = 'vacation'
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationExistsByGroupId, `
    SELECT json_object('id', o.id) AS data
    FROM week_options o
    WHERE o.group_id = $groupId AND o.option_type = 'vacation'
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.vacationEmployeeByGroupId, `
    SELECT json_object('employee_number', o.employee_number) AS data
    FROM week_options o
    WHERE o.group_id = $groupId AND o.option_type = 'vacation'
    ORDER BY o.id
    LIMIT 1
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.insertVacationOption, `
    INSERT INTO week_options
      (employee_number, group_id, week_start, date_from, date_to, option_type,
       note, all_day)
    VALUES (
      json_extract($data, '$.employeeNumber'),
      json_extract($data, '$.groupId'),
      json_extract($data, '$.weekStart'),
      json_extract($data, '$.dateFrom'),
      json_extract($data, '$.dateTo'),
      'vacation',
      json_extract($data, '$.note'),
      1
    )
    RETURNING json_object('id', id) AS data
  `, true),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.deleteVacationByNumericId, `
    DELETE FROM week_options
    WHERE id = json_extract($data, '$.id') AND option_type = 'vacation'
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.deleteVacationByGroupId, `
    DELETE FROM week_options
    WHERE group_id = json_extract($data, '$.groupId') AND option_type = 'vacation'
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.insertVacationHistory, `
    INSERT INTO vacation_history_events
      (id, group_id, employee_number, action, snapshot_json, receipt_sha256,
       created_by, created_at)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.groupId'),
      json_extract($data, '$.employeeNumber'),
      json_extract($data, '$.action'),
      json_extract($data, '$.snapshotJson'),
      json_extract($data, '$.receiptSha256'),
      json_extract($data, '$.createdBy'),
      json_extract($data, '$.createdAt')
    )
  `),

  entry(ABSENCE_MANAGEMENT_STATEMENTS.finalizeVacationRequest, `
    UPDATE vacation_requests
    SET status = 'approved', approval_stage = 'complete',
        decision_note = json_extract($data, '$.note'),
        decided_by = json_extract($data, '$.actor'),
        decided_at = CURRENT_TIMESTAMP,
        vacation_group_id = json_extract($data, '$.groupId'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.finalizeTimeOffRequest, `
    UPDATE time_off_requests
    SET status = 'approved', approval_stage = 'complete',
        option_id = json_extract($data, '$.optionId'),
        traffic_light = json_extract($data, '$.trafficLight'),
        check_reason = json_extract($data, '$.checkReason'),
        decision_note = json_extract($data, '$.note'),
        decided_by = json_extract($data, '$.actor'),
        decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.cancelOriginalTimeOff, `
    UPDATE time_off_requests
    SET status = 'cancelled', approval_stage = 'complete', option_id = NULL,
        original_shifts_json = '[]',
        decision_note = json_extract($data, '$.note'),
        decided_by = json_extract($data, '$.actor'),
        decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.replaceOriginalTimeOff, `
    UPDATE time_off_requests
    SET request_date = json_extract($data, '$.dateFrom'),
        date_from = json_extract($data, '$.dateFrom'),
        date_to = json_extract($data, '$.dateTo'),
        all_day = json_extract($data, '$.allDay'),
        start_time = json_extract($data, '$.startTime'),
        end_time = json_extract($data, '$.endTime'),
        note = CASE
          WHEN json_extract($data, '$.requestNote') <> ''
            THEN json_extract($data, '$.requestNote')
          ELSE note
        END,
        option_id = NULL, original_shifts_json = '[]',
        traffic_light = json_extract($data, '$.trafficLight'),
        check_reason = json_extract($data, '$.checkReason'),
        decision_note = json_extract($data, '$.note'),
        decided_by = json_extract($data, '$.actor'),
        decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.setOriginalTimeOffOption, `
    UPDATE time_off_requests
    SET option_id = json_extract($data, '$.optionId'),
        status = 'approved', approval_stage = 'complete',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.finalizeTimeOffChange, `
    UPDATE time_off_change_requests
    SET status = 'approved', approval_stage = 'complete',
        decision_note = json_extract($data, '$.note'),
        decided_by = json_extract($data, '$.actor'),
        decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.finalizeVacationChange, `
    UPDATE vacation_change_requests
    SET status = 'approved', approval_stage = 'complete',
        decision_note = json_extract($data, '$.note'),
        decided_by = json_extract($data, '$.actor'),
        decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.updateVacationRequestGroup, `
    UPDATE vacation_requests
    SET date_from = json_extract($data, '$.dateFrom'),
        date_to = json_extract($data, '$.dateTo'),
        note = json_extract($data, '$.note'),
        updated_at = CURRENT_TIMESTAMP
    WHERE vacation_group_id = json_extract($data, '$.groupId')
  `),
  entry(ABSENCE_MANAGEMENT_STATEMENTS.cancelVacationRequestGroup, `
    UPDATE vacation_requests
    SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
    WHERE vacation_group_id = json_extract($data, '$.groupId')
  `),

  ...requestCatalogEntries(),
]);

module.exports = {
  SQLITE_ABSENCE_MANAGEMENT_CATALOG,
};
