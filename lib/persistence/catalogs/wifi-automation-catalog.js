"use strict";

const {
  WIFI_AUTOMATION_STATEMENTS: S,
} = require("../statements/wifi-automation");

function entry(statement, sql) {
  return Object.freeze({ statement, sql, returning: false });
}

function jsonObject(fields) {
  return `json_object(${Object.entries(fields)
    .flatMap(([name, expression]) => [`'${name}'`, expression])
    .join(", ")}) AS data`;
}

const PRESENCE_FIELDS = Object.freeze({
  id: "s.id",
  employee_number: "s.employee_number",
  location_id: "s.location_id",
  provider_id: "s.provider_id",
  correlation_hash: "s.correlation_hash",
  observed_start_at: "s.observed_start_at",
  last_seen_at: "s.last_seen_at",
  disconnect_observed_at: "s.disconnect_observed_at",
  observed_end_at: "s.observed_end_at",
  state: "s.state",
  created_at: "s.created_at",
  updated_at: "s.updated_at",
});

const SUGGESTION_FIELDS = Object.freeze({
  id: "s.id",
  presence_session_id: "s.presence_session_id",
  employee_number: "s.employee_number",
  location_id: "s.location_id",
  work_date: "s.work_date",
  suggested_start_at: "s.suggested_start_at",
  suggested_end_at: "s.suggested_end_at",
  confirmation_level_snapshot: "s.confirmation_level_snapshot",
  minimum_presence_minutes_snapshot: "s.minimum_presence_minutes_snapshot",
  absence_grace_minutes_snapshot: "s.absence_grace_minutes_snapshot",
  confirmation_due_at: "s.confirmation_due_at",
  status: "s.status",
  confirmed_start_at: "s.confirmed_start_at",
  confirmed_end_at: "s.confirmed_end_at",
  confirmed_break_start_at: "s.confirmed_break_start_at",
  confirmed_break_end_at: "s.confirmed_break_end_at",
  confirmed_by: "s.confirmed_by",
  confirmed_at: "s.confirmed_at",
  rejected_by: "s.rejected_by",
  rejected_at: "s.rejected_at",
  rejection_reason: "s.rejection_reason",
  created_at: "s.created_at",
  updated_at: "s.updated_at",
  location_name: "l.name",
});

const SQLITE_WIFI_AUTOMATION_CATALOG = Object.freeze([
  entry(S.listConfirmationLevels, `
    SELECT ${jsonObject({
      personnel_number: "e.personnel_number",
      full_name: "e.full_name",
      nickname: "e.nickname",
      active: "e.active",
      time_confirmation_level: "e.time_confirmation_level",
    })}
    FROM employees e
    WHERE json_type($payload) = 'object'
    ORDER BY e.active DESC, CAST(e.personnel_number AS INTEGER), e.personnel_number
  `),
  entry(S.employeeExists, `
    SELECT json_object('found', 1) AS data
    FROM employees e
    WHERE e.personnel_number = json_extract($payload, '$.employeeNumber')
    LIMIT 1
  `),
  entry(S.listLocationMappings, `
    SELECT ${jsonObject({
      location_id: "m.location_id",
      updated_at: "m.updated_at",
    })}
    FROM wifi_location_mappings m
    WHERE m.provider_id = json_extract($payload, '$.providerId')
  `),
  entry(S.listLocations, `
    SELECT ${jsonObject({
      id: "l.id",
      name: "l.name",
      active: "l.active",
    })}
    FROM locations l
    WHERE json_type($payload) = 'object'
    ORDER BY l.active DESC, l.id
  `),
  entry(S.getPreference, `
    SELECT ${jsonObject({
      employee_number: "p.employee_number",
      enabled: "p.enabled",
      provider_id: "p.provider_id",
      opted_in_at: "p.opted_in_at",
      opted_out_at: "p.opted_out_at",
      updated_at: "p.updated_at",
    })}
    FROM wifi_automation_preferences p
    WHERE p.employee_number = json_extract($payload, '$.employeeNumber')
    LIMIT 1
  `),
  entry(S.getEmployeeConfirmationLevel, `
    SELECT json_object('time_confirmation_level', e.time_confirmation_level) AS data
    FROM employees e
    WHERE e.personnel_number = json_extract($payload, '$.employeeNumber')
      AND (
        json_extract($payload, '$.activeOnly') = 0
        OR e.active = 1
      )
    LIMIT 1
  `),
  entry(S.listExpiredGraceSessions, `
    SELECT ${jsonObject(PRESENCE_FIELDS)}
    FROM wifi_presence_sessions s
    WHERE s.state = 'grace' AND s.disconnect_observed_at IS NOT NULL
      AND json_type($payload) = 'object'
    ORDER BY s.disconnect_observed_at
  `),
  entry(S.getGraceSession, `
    SELECT ${jsonObject(PRESENCE_FIELDS)}
    FROM wifi_presence_sessions s
    WHERE s.id = json_extract($payload, '$.id') AND s.state = 'grace'
    LIMIT 1
  `),
  entry(S.findActivePreference, `
    SELECT json_object('employee_number', p.employee_number) AS data
    FROM wifi_automation_preferences p
    JOIN employees e ON e.personnel_number = p.employee_number
    JOIN portal_users u ON u.employee_number = p.employee_number
    WHERE p.enabled = 1
      AND p.provider_id = json_extract($payload, '$.providerId')
      AND p.external_subject_hash = json_extract($payload, '$.externalSubjectHash')
      AND e.active = 1
      AND u.active = 1
    LIMIT 1
  `),
  entry(S.findLocationMapping, `
    SELECT json_object('location_id', m.location_id) AS data
    FROM wifi_location_mappings m
    WHERE m.provider_id = json_extract($payload, '$.providerId')
      AND m.external_location_hash = json_extract($payload, '$.externalLocationHash')
    LIMIT 1
  `),
  entry(S.findOpenPresenceSession, `
    SELECT ${jsonObject(PRESENCE_FIELDS)}
    FROM wifi_presence_sessions s
    WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
      AND s.location_id = json_extract($payload, '$.locationId')
      AND s.provider_id = json_extract($payload, '$.providerId')
      AND s.state IN ('observing', 'present', 'grace')
    ORDER BY s.observed_start_at DESC
    LIMIT 1
  `),
  entry(S.getEmployeeAutomationContext, `
    SELECT ${jsonObject({
      time_confirmation_level: "e.time_confirmation_level",
      home_location_id: "e.home_location_id",
      location_name: "l.name",
      time_tracking_enabled: "l.time_tracking_enabled",
    })}
    FROM employees e
    LEFT JOIN locations l ON l.id = e.home_location_id
    WHERE e.personnel_number = json_extract($payload, '$.employeeNumber')
    LIMIT 1
  `),
  entry(S.hasLocationMapping, `
    SELECT json_object('found', 1) AS data
    FROM wifi_location_mappings m
    WHERE m.provider_id = json_extract($payload, '$.providerId')
      AND m.location_id = json_extract($payload, '$.locationId')
    LIMIT 1
  `),
  entry(S.listEmployeeSuggestions, `
    SELECT ${jsonObject(SUGGESTION_FIELDS)}
    FROM wifi_time_suggestions s
    LEFT JOIN locations l ON l.id = s.location_id
    WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
      AND (
        s.status = 'pending'
        OR s.work_date >= json_extract($payload, '$.cutoff')
      )
    ORDER BY s.work_date DESC, s.suggested_start_at DESC
  `),
  entry(S.getSuggestionForEmployee, `
    SELECT ${jsonObject(SUGGESTION_FIELDS)}
    FROM wifi_time_suggestions s
    LEFT JOIN locations l ON l.id = s.location_id
    WHERE s.id = json_extract($payload, '$.id')
      AND s.employee_number = json_extract($payload, '$.employeeNumber')
    LIMIT 1
  `),
  entry(S.listPendingSuggestionIds, `
    SELECT json_object('id', s.id) AS data
    FROM wifi_time_suggestions s
    WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
      AND s.status = 'pending'
      AND s.work_date BETWEEN json_extract($payload, '$.dateFrom')
        AND json_extract($payload, '$.dateTo')
    ORDER BY s.work_date, s.suggested_start_at
  `),
  entry(S.listScheduledDepartments, `
    SELECT ${jsonObject({
      department_id: "s.department_id",
      start_time: "s.start_time",
      end_time: "s.end_time",
    })}
    FROM shifts s
    WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
      AND s.shift_date = json_extract($payload, '$.workDate')
      AND s.department_id IS NOT NULL
    ORDER BY s.start_time, s.id
  `),
  entry(S.getEmployeeRequestContext, `
    SELECT ${jsonObject({
      personnel_number: "e.personnel_number",
      full_name: "e.full_name",
      nickname: "e.nickname",
      home_location_id: "e.home_location_id",
      preferred_department_id: "e.preferred_department_id",
    })}
    FROM employees e
    WHERE e.personnel_number = json_extract($payload, '$.employeeNumber')
      AND e.active = 1
    LIMIT 1
  `),
  entry(S.listTimeEntriesForDay, `
    SELECT ${jsonObject({
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
      created_at: "t.created_at",
    })}
    FROM time_entries t
    WHERE t.employee_number = json_extract($payload, '$.employeeNumber')
      AND t.work_date = json_extract($payload, '$.workDate')
      AND t.voided_at IS NULL
    ORDER BY t.entry_timestamp, t.id
  `),

  entry(S.removeLocationMapping, `
    DELETE FROM wifi_location_mappings
    WHERE provider_id = json_extract($payload, '$.providerId')
      AND location_id = json_extract($payload, '$.locationId')
  `),
  entry(S.upsertLocationMapping, `
    INSERT INTO wifi_location_mappings (
      provider_id, location_id, external_location_hash, updated_by, updated_at
    ) VALUES (
      json_extract($payload, '$.providerId'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.externalLocationHash'),
      json_extract($payload, '$.updatedBy'),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(provider_id, location_id) DO UPDATE SET
      external_location_hash = excluded.external_location_hash,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.upsertPreference, `
    INSERT INTO wifi_automation_preferences (
      employee_number, enabled, provider_id, external_subject_hash,
      opted_in_at, opted_out_at, updated_by, updated_at
    ) VALUES (
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.enabled'),
      NULLIF(json_extract($payload, '$.providerId'), ''),
      NULLIF(json_extract($payload, '$.externalSubjectHash'), ''),
      CASE WHEN json_extract($payload, '$.enabled') = 1 THEN CURRENT_TIMESTAMP END,
      CASE WHEN json_extract($payload, '$.enabled') = 0 THEN CURRENT_TIMESTAMP END,
      json_extract($payload, '$.employeeNumber'),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(employee_number) DO UPDATE SET
      enabled = excluded.enabled,
      provider_id = excluded.provider_id,
      external_subject_hash = excluded.external_subject_hash,
      opted_in_at = CASE
        WHEN excluded.enabled = 1
          THEN COALESCE(wifi_automation_preferences.opted_in_at, CURRENT_TIMESTAMP)
        ELSE wifi_automation_preferences.opted_in_at
      END,
      opted_out_at = CASE WHEN excluded.enabled = 0 THEN CURRENT_TIMESTAMP ELSE NULL END,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.cancelPresenceSessions, `
    UPDATE wifi_presence_sessions
    SET state = 'cancelled',
        observed_end_at = COALESCE(observed_end_at, last_seen_at),
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND state IN ('observing', 'present', 'grace')
  `),
  entry(S.insertSuggestion, `
    INSERT OR IGNORE INTO wifi_time_suggestions (
      id, presence_session_id, employee_number, location_id, work_date,
      suggested_start_at, suggested_end_at, confirmation_level_snapshot,
      minimum_presence_minutes_snapshot, absence_grace_minutes_snapshot,
      confirmation_due_at
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.presenceSessionId'),
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.workDate'),
      json_extract($payload, '$.suggestedStartAt'),
      json_extract($payload, '$.suggestedEndAt'),
      json_extract($payload, '$.confirmationLevel'),
      json_extract($payload, '$.minimumPresenceMinutes'),
      json_extract($payload, '$.absenceGraceMinutes'),
      json_extract($payload, '$.confirmationDueAt')
    )
  `),
  entry(S.markPresenceInvalid, `
    UPDATE wifi_presence_sessions
    SET state = 'invalid',
        observed_end_at = json_extract($payload, '$.endAt'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.closePresenceSession, `
    UPDATE wifi_presence_sessions
    SET observed_end_at = json_extract($payload, '$.endAt'),
        state = json_extract($payload, '$.state'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.insertInboxEvent, `
    INSERT OR IGNORE INTO wifi_event_inbox (
      id, provider_id, external_event_hash, event_type, external_subject_hash,
      location_reference_hash, occurred_at, payload_fingerprint
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.providerId'),
      json_extract($payload, '$.externalEventHash'),
      json_extract($payload, '$.eventType'),
      json_extract($payload, '$.externalSubjectHash'),
      json_extract($payload, '$.externalLocationHash'),
      json_extract($payload, '$.occurredAt'),
      json_extract($payload, '$.payloadFingerprint')
    )
  `),
  entry(S.markInboxStatus, `
    UPDATE wifi_event_inbox
    SET processing_status = json_extract($payload, '$.status'),
        processed_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.reconnectPresenceSession, `
    UPDATE wifi_presence_sessions
    SET last_seen_at = json_extract($payload, '$.occurredAt'),
        disconnect_observed_at = NULL,
        observed_end_at = NULL,
        state = 'present',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.touchPresenceSession, `
    UPDATE wifi_presence_sessions
    SET last_seen_at = json_extract($payload, '$.occurredAt'),
        state = json_extract($payload, '$.state'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.insertPresenceSession, `
    INSERT INTO wifi_presence_sessions (
      id, employee_number, location_id, provider_id, correlation_hash,
      observed_start_at, last_seen_at, state
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.providerId'),
      json_extract($payload, '$.correlationHash'),
      json_extract($payload, '$.occurredAt'),
      json_extract($payload, '$.occurredAt'),
      'observing'
    )
  `),
  entry(S.startPresenceGrace, `
    UPDATE wifi_presence_sessions
    SET disconnect_observed_at = json_extract($payload, '$.occurredAt'),
        state = 'grace',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.completeInboxEvent, `
    UPDATE wifi_event_inbox
    SET processing_status = json_extract($payload, '$.status'),
        presence_session_id = NULLIF(json_extract($payload, '$.presenceSessionId'), ''),
        processed_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.insertTimeEntry, `
    INSERT INTO time_entries (
      employee_number, location_id, department_id, work_date, entry_type,
      entry_timestamp, source, note, created_by
    ) VALUES (
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.departmentId'),
      json_extract($payload, '$.workDate'),
      json_extract($payload, '$.entryType'),
      json_extract($payload, '$.entryTimestamp'),
      'wifi_confirmed',
      'Bestätigter WLAN-Zeitvorschlag',
      json_extract($payload, '$.createdBy')
    )
  `),
  entry(S.confirmSuggestion, `
    UPDATE wifi_time_suggestions
    SET status = 'confirmed',
        confirmed_start_at = json_extract($payload, '$.startAt'),
        confirmed_end_at = json_extract($payload, '$.endAt'),
        confirmed_break_start_at = NULLIF(json_extract($payload, '$.breakStartAt'), ''),
        confirmed_break_end_at = NULLIF(json_extract($payload, '$.breakEndAt'), ''),
        confirmed_by = json_extract($payload, '$.employeeNumber'),
        confirmed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND employee_number = json_extract($payload, '$.employeeNumber')
      AND status = 'pending'
  `),
  entry(S.invalidateTimeDayReview, `
    DELETE FROM time_day_reviews
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND work_date = json_extract($payload, '$.workDate')
  `),
  entry(S.rejectSuggestion, `
    UPDATE wifi_time_suggestions
    SET status = 'rejected',
        rejected_by = json_extract($payload, '$.employeeNumber'),
        rejected_at = CURRENT_TIMESTAMP,
        rejection_reason = json_extract($payload, '$.reason'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND employee_number = json_extract($payload, '$.employeeNumber')
      AND status = 'pending'
  `),
  entry(S.upsertPortalSetting, `
    INSERT INTO portal_settings (key, value, updated_at)
    VALUES (
      json_extract($payload, '$.key'),
      json_extract($payload, '$.value'),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.updateEmployeeConfirmationLevel, `
    UPDATE employees
    SET time_confirmation_level = json_extract($payload, '$.level')
    WHERE personnel_number = json_extract($payload, '$.employeeNumber')
  `),
]);

module.exports = {
  SQLITE_WIFI_AUTOMATION_CATALOG,
};
