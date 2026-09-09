"use strict";

const {
  SICKNESS_AMU_MANAGEMENT_STATEMENTS: S,
} = require("../statements/sickness-amu-management");

function entry(statement, sql) {
  return Object.freeze({
    statement,
    sql,
    returning: statement.operation === "execute"
      && Object.keys(statement.columns || {}).length > 0,
  });
}

function jsonObject(fields) {
  return `json_object(${Object.entries(fields)
    .flatMap(([name, expression]) => [`'${name}'`, expression])
    .join(", ")}) AS data`;
}

const SICKNESS_CASE = Object.freeze({
  id: "c.id",
  revision: "c.revision",
  employee_lookup: "c.employee_lookup",
  status_lookup: "c.status_lookup",
  protected_payload: "c.protected_payload",
  purge_after: "c.purge_after",
  created_at: "c.created_at",
  updated_at: "c.updated_at",
});

const SICKNESS_ALERT = Object.freeze({
  id: "a.id",
  sickness_case_id: "a.sickness_case_id",
  status_lookup: "a.status_lookup",
  protected_payload: "a.protected_payload",
  purge_after: "a.purge_after",
  dedupe_lookup: "a.dedupe_lookup",
});

const NOTIFICATION_PREFERENCE = Object.freeze({
  employee_number: "p.employee_number",
  channel: "p.channel",
  enabled: "p.enabled",
  process_notifications_enabled: "p.process_notifications_enabled",
  earliest_time: "p.earliest_time",
  protected_destination: "p.protected_destination",
  verified_at: "p.verified_at",
  verification_hash: "p.verification_hash",
  verification_salt: "p.verification_salt",
  verification_expires_at: "p.verification_expires_at",
  verification_attempts: "p.verification_attempts",
  verification_sent_at: "p.verification_sent_at",
  updated_at: "p.updated_at",
});

const OUTBOUND_JOB = Object.freeze({
  id: "j.id",
  recipient_lookup: "j.recipient_lookup",
  channel: "j.channel",
  entity_lookup: "j.entity_lookup",
  protected_payload: "j.protected_payload",
  not_before: "j.not_before",
  status: "j.status",
  attempts: "j.attempts",
  last_error_code: "j.last_error_code",
  sent_at: "j.sent_at",
  purge_after: "j.purge_after",
  created_at: "j.created_at",
  updated_at: "j.updated_at",
  dedupe_lookup: "j.dedupe_lookup",
});

const PERSONNEL_DOCUMENT = Object.freeze({
  id: "p.id",
  employee_number: "p.employee_number",
  storage_key: "p.storage_key",
  status: "p.status",
  protected_payload: "p.protected_payload",
  created_at: "p.created_at",
  updated_at: "p.updated_at",
  deleted_by: "p.deleted_by",
  deleted_at: "p.deleted_at",
  current_version: "p.current_version",
  revision: "p.revision",
  archived_by: "p.archived_by",
  archived_at: "p.archived_at",
});

const PERSONNEL_DOCUMENT_CATEGORY = Object.freeze({
  id: "c.id",
  code: "c.code",
  label: "c.label",
  default_visibility: "c.default_visibility",
  retention_disposition: "c.retention_disposition",
  default_retention_days: "c.default_retention_days",
  active: "c.active",
  builtin: "c.builtin",
  sort_order: "c.sort_order",
  created_at: "c.created_at",
  updated_at: "c.updated_at",
});

const PERSONNEL_DOCUMENT_VERSION = Object.freeze({
  document_id: "v.document_id",
  version_number: "v.version_number",
  storage_key: "v.storage_key",
  protected_payload: "v.protected_payload",
  created_by: "v.created_by",
  created_at: "v.created_at",
});

const PERSONNEL_DOCUMENT_EVENT = Object.freeze({
  id: "e.id",
  document_id: "e.document_id",
  sequence_number: "e.sequence_number",
  event_type: "e.event_type",
  previous_receipt_sha256: "e.previous_receipt_sha256",
  receipt_sha256: "e.receipt_sha256",
  actor_employee_number: "e.actor_employee_number",
  created_at: "e.created_at",
});

const AMU_REPORT = Object.freeze({
  id: "r.id",
  revision: "r.revision",
  sickness_case_id: "r.sickness_case_id",
  employee_number: "r.employee_number",
  location_id: "r.location_id",
  department_id: "r.department_id",
  incapacity_from: "r.incapacity_from",
  incapacity_to: "r.incapacity_to",
  employee_note: "r.employee_note",
  status: "r.status",
  submitted_at: "r.submitted_at",
  reviewed_by: "r.reviewed_by",
  reviewed_at: "r.reviewed_at",
  review_note: "r.review_note",
  retention_until: "r.retention_until",
  withdrawn_at: "r.withdrawn_at",
  protected_payload: "r.protected_payload",
  created_at: "r.created_at",
  updated_at: "r.updated_at",
});

const AMU_REPORT_DISPLAY = Object.freeze({
  ...AMU_REPORT,
  full_name: "e.full_name",
  nickname: "e.nickname",
  color: "e.color",
  preferred_department_id: "e.preferred_department_id",
  location_name: "l.name",
  department_name: "d.name",
});

const AMU_DOCUMENT = Object.freeze({
  id: "a.id",
  report_id: "a.report_id",
  storage_key: "a.storage_key",
  original_filename: "a.original_filename",
  detected_mime: "a.detected_mime",
  byte_size: "a.byte_size",
  sha256: "a.sha256",
  scan_status: "a.scan_status",
  encryption_key_id: "a.encryption_key_id",
  encryption_iv: "a.encryption_iv",
  encryption_tag: "a.encryption_tag",
  status: "a.status",
  uploaded_by: "a.uploaded_by",
  created_at: "a.created_at",
  deleted_by: "a.deleted_by",
  deleted_at: "a.deleted_at",
  purged_at: "a.purged_at",
  protected_payload: "a.protected_payload",
});

const SQLITE_SICKNESS_AMU_MANAGEMENT_CATALOG = Object.freeze([
  entry(S.listNotificationRecipientPrincipals, `
    SELECT ${jsonObject({
      employee_number: "u.employee_number",
      role: "u.role",
      home_location_id: "e.home_location_id",
      preferred_department_id: "e.preferred_department_id",
      role_permissions: "r.permissions",
      granted_permissions: `COALESCE((
        SELECT json_group_array(g.permission)
        FROM portal_permission_grants g
        WHERE g.employee_number = u.employee_number
      ), '[]')`,
      denied_permissions: `COALESCE((
        SELECT json_group_array(dn.permission)
        FROM portal_permission_denials dn
        WHERE dn.employee_number = u.employee_number
      ), '[]')`,
      scopes: `COALESCE((
        SELECT json_group_array(json_object(
          'locationId', s.location_id,
          'departmentId', s.department_id
        ))
        FROM portal_access_scopes s
        WHERE s.employee_number = u.employee_number
      ), '[]')`,
    })}
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    LEFT JOIN portal_user_roles r ON r.employee_number = u.employee_number
    WHERE u.active = 1 AND TRIM(u.password_hash) <> ''
      AND json_type($payload) = 'object'
    ORDER BY u.employee_number
  `),
  entry(S.getSicknessCaseRetention, `
    SELECT ${jsonObject({ id: "c.id", purge_after: "c.purge_after" })}
    FROM sickness_cases c
    WHERE c.id = json_extract($payload, '$.id')
  `),
  entry(S.getSicknessAlertByDedupe, `
    SELECT ${jsonObject(SICKNESS_ALERT)}
    FROM sickness_alerts a
    WHERE a.dedupe_lookup = json_extract($payload, '$.dedupeLookup')
  `),
  entry(S.listSicknessAlertsByCase, `
    SELECT ${jsonObject(SICKNESS_ALERT)}
    FROM sickness_alerts a
    WHERE a.sickness_case_id = json_extract($payload, '$.caseId')
    ORDER BY a.id
  `),
  entry(S.listProtectedNotificationRecipients, `
    SELECT ${jsonObject({ recipient_employee_number: "n.recipient_employee_number" })}
    FROM portal_notifications n
    WHERE n.entity_type = 'protected_record'
      AND n.entity_id = json_extract($payload, '$.entityId')
    GROUP BY n.recipient_employee_number
    ORDER BY n.recipient_employee_number
  `),
  entry(S.listEscalationSicknessCases, `
    SELECT ${jsonObject(SICKNESS_CASE)}
    FROM sickness_cases c
    WHERE c.status_lookup IN (
      SELECT value FROM json_each(json_extract($payload, '$.statusLookups'))
    )
    ORDER BY c.created_at, c.id
  `),
  entry(S.listNotificationPreferences, `
    SELECT ${jsonObject(NOTIFICATION_PREFERENCE)}
    FROM sickness_notification_preferences p
    WHERE p.employee_number = json_extract($payload, '$.employeeNumber')
    ORDER BY p.channel
  `),
  entry(S.getNotificationPreference, `
    SELECT ${jsonObject(NOTIFICATION_PREFERENCE)}
    FROM sickness_notification_preferences p
    WHERE p.employee_number = json_extract($payload, '$.employeeNumber')
      AND p.channel = json_extract($payload, '$.channel')
  `),
  entry(S.listActiveNotificationPreferences, `
    SELECT ${jsonObject(NOTIFICATION_PREFERENCE)}
    FROM sickness_notification_preferences p
    WHERE p.employee_number = json_extract($payload, '$.employeeNumber')
      AND p.enabled = 1
      AND p.verified_at IS NOT NULL
    ORDER BY p.channel
  `),
  entry(S.getOutboundNotificationJobByDedupe, `
    SELECT ${jsonObject(OUTBOUND_JOB)}
    FROM outbound_notification_jobs j
    WHERE j.dedupe_lookup = json_extract($payload, '$.dedupeLookup')
  `),
  entry(S.listDueOutboundJobs, `
    SELECT ${jsonObject(OUTBOUND_JOB)}
    FROM outbound_notification_jobs j
    WHERE j.status = 'pending'
      AND j.not_before <= json_extract($payload, '$.now')
    ORDER BY j.not_before, j.created_at, j.id
    LIMIT 20
  `),
  entry(S.listExpiredSicknessCases, `
    SELECT ${jsonObject({ id: "c.id" })}
    FROM sickness_cases c
    WHERE c.purge_after < json_extract($payload, '$.today')
      AND c.status_lookup NOT IN (
        SELECT value FROM json_each(json_extract($payload, '$.activeStatusLookups'))
      )
    ORDER BY c.id
  `),
  entry(S.listPersonnelDocuments, `
    SELECT ${jsonObject(PERSONNEL_DOCUMENT)}
    FROM personnel_record_documents p
    WHERE p.employee_number = json_extract($payload, '$.employeeNumber')
      AND (
        json_extract($payload, '$.includeDeleted') = 1
        OR p.status IN ('active','retention_review')
      )
    ORDER BY p.created_at DESC, p.id DESC
  `),
  entry(S.getPersonnelDocument, `
    SELECT ${jsonObject(PERSONNEL_DOCUMENT)}
    FROM personnel_record_documents p
    WHERE p.employee_number = json_extract($payload, '$.employeeNumber')
      AND p.id = json_extract($payload, '$.documentId')
      AND (
        json_extract($payload, '$.activeOnly') = 0
        OR p.status = 'active'
      )
  `),
  entry(S.listPersonnelDocumentCategories, `
    SELECT ${jsonObject(PERSONNEL_DOCUMENT_CATEGORY)}
    FROM personnel_document_categories c
    WHERE json_extract($payload, '$.activeOnly') = 0 OR c.active = 1
    ORDER BY c.sort_order, c.label, c.id
  `),
  entry(S.listPersonnelDocumentVersions, `
    SELECT ${jsonObject(PERSONNEL_DOCUMENT_VERSION)}
    FROM personnel_record_document_versions v
    WHERE v.document_id = json_extract($payload, '$.documentId')
    ORDER BY v.version_number
  `),
  entry(S.getPersonnelDocumentVersion, `
    SELECT ${jsonObject(PERSONNEL_DOCUMENT_VERSION)}
    FROM personnel_record_document_versions v
    WHERE v.document_id = json_extract($payload, '$.documentId')
      AND v.version_number = json_extract($payload, '$.versionNumber')
  `),
  entry(S.listPersonnelDocumentEvents, `
    SELECT ${jsonObject(PERSONNEL_DOCUMENT_EVENT)}
    FROM personnel_record_document_events e
    WHERE e.document_id = json_extract($payload, '$.documentId')
    ORDER BY e.sequence_number
  `),
  entry(S.getLatestPersonnelDocumentEvent, `
    SELECT ${jsonObject(PERSONNEL_DOCUMENT_EVENT)}
    FROM personnel_record_document_events e
    WHERE e.document_id = json_extract($payload, '$.documentId')
    ORDER BY e.sequence_number DESC
    LIMIT 1
  `),
  entry(S.listDeletedPersonnelDocuments, `
    SELECT ${jsonObject(PERSONNEL_DOCUMENT)}
    FROM personnel_record_documents p
    WHERE p.status = 'deleted'
      AND json_type($payload) = 'object'
    ORDER BY p.deleted_at, p.id
  `),
  entry(S.listPersonnelDocumentStorageKeys, `
    SELECT ${jsonObject({ storage_key: "refs.storage_key" })}
    FROM (
      SELECT v.storage_key
      FROM personnel_record_document_versions v
      JOIN personnel_record_documents p ON p.id = v.document_id
      WHERE p.status <> 'purged'
      UNION ALL
      SELECT p.storage_key
      FROM personnel_record_documents p
      WHERE p.status <> 'purged'
        AND NOT EXISTS (
          SELECT 1 FROM personnel_record_document_versions v
          WHERE v.document_id = p.id
        )
    ) refs
    WHERE json_type($payload) = 'object'
    ORDER BY refs.storage_key
  `),
  entry(S.listActivePersonnelDocuments, `
    SELECT ${jsonObject(PERSONNEL_DOCUMENT)}
    FROM personnel_record_documents p
    WHERE p.status = 'active'
      AND json_type($payload) = 'object'
    ORDER BY p.created_at, p.id
  `),
  entry(S.countPendingAmuForContext, `
    SELECT ${jsonObject({ count: "COUNT(*)" })}
    FROM amu_reports r
    WHERE r.location_id = json_extract($payload, '$.locationId')
      AND r.status IN ('submitted','returned')
      AND (
        json_extract($payload, '$.departmentId') IS NULL
        OR r.department_id = json_extract($payload, '$.departmentId')
      )
  `),
  entry(S.listAmuDocumentsForReports, `
    SELECT ${jsonObject({
      ...AMU_DOCUMENT,
      employee_number: "r.employee_number",
    })}
    FROM amu_documents a
    JOIN amu_reports r ON r.id = a.report_id
    WHERE a.report_id IN (
      SELECT CAST(value AS INTEGER)
      FROM json_each(json_extract($payload, '$.reportIds'))
    )
      AND a.status = 'active'
    ORDER BY a.created_at, a.id
  `),
  entry(S.getSicknessContract, `
    SELECT ${jsonObject({
      personnel_number: "e.personnel_number",
      contracted_hours: "e.contracted_hours",
      target_workdays_per_week: "e.target_workdays_per_week",
      preferred_day_off: "e.preferred_day_off",
      fixed_workdays: "e.fixed_workdays",
      time_confirmation_level: "e.time_confirmation_level",
      sickness_without_aum_enabled: "e.sickness_without_aum_enabled",
      home_location_id: "e.home_location_id",
    })}
    FROM employees e
    WHERE e.personnel_number = json_extract($payload, '$.employeeNumber')
  `),
  entry(S.listSicknessAllowanceCases, `
    SELECT ${jsonObject({
      id: "c.id",
      employee_lookup: "c.employee_lookup",
      protected_payload: "c.protected_payload",
    })}
    FROM sickness_cases c
    WHERE c.status_lookup IN (
      SELECT value FROM json_each(json_extract($payload, '$.statusLookups'))
    )
    ORDER BY c.id
  `),
  entry(S.getSicknessValuationContext, `
    SELECT ${jsonObject({
      planned_shift: `EXISTS(
        SELECT 1 FROM shifts s
        WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
          AND s.shift_date = json_extract($payload, '$.date')
      )`,
      week_has_plan: `EXISTS(
        SELECT 1 FROM shifts s
        WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
          AND s.shift_date BETWEEN json_extract($payload, '$.weekStart')
                               AND json_extract($payload, '$.weekEnd')
      )`,
    })}
  `),
  entry(S.listSicknessCasesForCredit, `
    SELECT ${jsonObject(SICKNESS_CASE)}
    FROM sickness_cases c
    WHERE c.status_lookup IN (
      SELECT value FROM json_each(json_extract($payload, '$.statusLookups'))
    )
    ORDER BY c.created_at DESC, c.id DESC
  `),
  entry(S.listActiveSicknessCases, `
    SELECT ${jsonObject(SICKNESS_CASE)}
    FROM sickness_cases c
    WHERE c.status_lookup IN (
      SELECT value FROM json_each(json_extract($payload, '$.statusLookups'))
    )
    ORDER BY c.id
  `),
  entry(S.listStaffingShiftsForEmployee, `
    SELECT ${jsonObject({
      shift_date: "s.shift_date",
      start_time: "s.start_time",
      end_time: "s.end_time",
      department_id: "s.department_id",
      location_id: "COALESCE(s.location_id, d.location_id, e.home_location_id)",
    })}
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number
    LEFT JOIN departments d ON d.id = s.department_id
    WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
      AND s.shift_date BETWEEN json_extract($payload, '$.dateFrom')
                           AND json_extract($payload, '$.dateTo')
    ORDER BY s.shift_date, s.start_time, s.id
  `),
  entry(S.getDepartmentStaffingRequirement, `
    SELECT ${jsonObject({ min_staff: "d.min_staff" })}
    FROM departments d
    WHERE d.id = json_extract($payload, '$.departmentId')
      AND d.location_id = json_extract($payload, '$.locationId')
  `),
  entry(S.listStaffingEmployeesAtPoint, `
    SELECT ${jsonObject({ employee_number: "s.employee_number" })}
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number
    LEFT JOIN departments d ON d.id = s.department_id
    WHERE s.shift_date = json_extract($payload, '$.date')
      AND COALESCE(s.location_id, d.location_id, e.home_location_id)
        = json_extract($payload, '$.locationId')
      AND s.start_time <= json_extract($payload, '$.pointTime')
      AND s.end_time > json_extract($payload, '$.pointTime')
      AND (
        json_extract($payload, '$.departmentId') IS NULL
        OR s.department_id = json_extract($payload, '$.departmentId')
      )
    GROUP BY s.employee_number
    ORDER BY s.employee_number
  `),
  entry(S.listProtectedCaseEvents, `
    SELECT ${jsonObject({
      id: "p.id",
      entity_kind: "p.entity_kind",
      entity_id: "p.entity_id",
      action_lookup: "p.action_lookup",
      actor_lookup: "p.actor_lookup",
      protected_payload: "p.protected_payload",
      created_at: "p.created_at",
    })}
    FROM protected_case_events p
    WHERE p.entity_kind = json_extract($payload, '$.entityKind')
      AND p.entity_id = json_extract($payload, '$.entityId')
    ORDER BY p.created_at, p.id
  `),
  entry(S.listSicknessCaseReportStatuses, `
    SELECT ${jsonObject({ status: "r.status" })}
    FROM amu_reports r
    WHERE r.sickness_case_id = json_extract($payload, '$.caseId')
      AND r.status NOT IN ('withdrawn','purged')
    ORDER BY r.submitted_at DESC, r.id DESC
  `),
  entry(S.getSicknessCaseDisplayContext, `
    SELECT ${jsonObject({
      full_name: "e.full_name",
      nickname: "e.nickname",
      location_name: "l.name",
      department_name: "d.name",
    })}
    FROM employees e
    LEFT JOIN locations l
      ON l.id = json_extract($payload, '$.locationId')
    LEFT JOIN departments d
      ON d.id = json_extract($payload, '$.departmentId')
    WHERE e.personnel_number = json_extract($payload, '$.employeeNumber')
  `),
  entry(S.getSicknessCase, `
    SELECT ${jsonObject(SICKNESS_CASE)}
    FROM sickness_cases c
    WHERE c.id = json_extract($payload, '$.id')
  `),
  entry(S.listOwnSicknessCases, `
    SELECT ${jsonObject(SICKNESS_CASE)}
    FROM sickness_cases c
    WHERE c.employee_lookup = json_extract($payload, '$.employeeLookup')
    ORDER BY c.created_at DESC, c.id DESC
  `),
  entry(S.listOwnAmuReports, `
    SELECT ${jsonObject({
      ...AMU_REPORT,
      location_name: "l.name",
    })}
    FROM amu_reports r
    JOIN locations l ON l.id = r.location_id
    WHERE r.employee_number = json_extract($payload, '$.employeeNumber')
      AND r.status <> 'purged'
    ORDER BY r.submitted_at DESC, r.id DESC
  `),
  entry(S.getAmuReport, `
    SELECT ${jsonObject(AMU_REPORT_DISPLAY)}
    FROM amu_reports r
    JOIN employees e ON e.personnel_number = r.employee_number
    JOIN locations l ON l.id = r.location_id
    LEFT JOIN departments d ON d.id = r.department_id
    WHERE r.id = json_extract($payload, '$.id')
  `),
  entry(S.listOpenAmuReports, `
    SELECT ${jsonObject(AMU_REPORT_DISPLAY)}
    FROM amu_reports r
    JOIN employees e ON e.personnel_number = r.employee_number
    JOIN locations l ON l.id = r.location_id
    LEFT JOIN departments d ON d.id = r.department_id
    WHERE r.status IN ('submitted','returned')
      AND json_type($payload) = 'object'
    ORDER BY r.id
  `),
  entry(S.getAmuDocument, `
    SELECT ${jsonObject({
      ...AMU_DOCUMENT,
      employee_number: "r.employee_number",
      location_id: "r.location_id",
      department_id: "r.department_id",
      report_status: "r.status",
    })}
    FROM amu_documents a
    JOIN amu_reports r ON r.id = a.report_id
    WHERE a.report_id = json_extract($payload, '$.reportId')
      AND a.id = json_extract($payload, '$.documentId')
      AND (
        json_extract($payload, '$.activeOnly') = 0
        OR a.status = 'active'
      )
  `),
  entry(S.listActiveAmuDocuments, `
    SELECT ${jsonObject({
      ...AMU_DOCUMENT,
      employee_number: "r.employee_number",
    })}
    FROM amu_documents a
    JOIN amu_reports r ON r.id = a.report_id
    WHERE a.status = 'active'
      AND json_type($payload) = 'object'
    ORDER BY a.created_at, a.id
  `),
  entry(S.listAmuReportsForRetention, `
    SELECT ${jsonObject(AMU_REPORT)}
    FROM amu_reports r
    WHERE r.status IN ('submitted','returned','reviewed','withdrawn','purged')
      AND json_type($payload) = 'object'
    ORDER BY r.id
  `),
  entry(S.listAmuDocumentsForReportIds, `
    SELECT ${jsonObject({
      id: "a.id",
      storage_key: "a.storage_key",
      report_id: "a.report_id",
      status: "a.status",
    })}
    FROM amu_documents a
    WHERE a.report_id IN (
      SELECT CAST(value AS INTEGER)
      FROM json_each(json_extract($payload, '$.reportIds'))
    )
      AND a.status IN ('active','deleted')
    ORDER BY a.created_at, a.id
  `),
  entry(S.listAmuDocumentStorageKeys, `
    SELECT ${jsonObject({ storage_key: "a.storage_key" })}
    FROM amu_documents a
    WHERE json_type($payload) = 'object'
    ORDER BY a.storage_key
  `),
  entry(S.listLinkedAmuReports, `
    SELECT ${jsonObject(AMU_REPORT)}
    FROM amu_reports r
    WHERE r.sickness_case_id = json_extract($payload, '$.caseId')
      AND r.status <> 'purged'
    ORDER BY r.id
  `),
  entry(S.listAllSicknessCases, `
    SELECT ${jsonObject(SICKNESS_CASE)}
    FROM sickness_cases c
    WHERE json_type($payload) = 'object'
    ORDER BY c.created_at DESC, c.id DESC
  `),
  entry(S.listAllAmuReports, `
    SELECT ${jsonObject(AMU_REPORT_DISPLAY)}
    FROM amu_reports r
    JOIN employees e ON e.personnel_number = r.employee_number
    JOIN locations l ON l.id = r.location_id
    LEFT JOIN departments d ON d.id = r.department_id
    WHERE r.status <> 'purged'
      AND json_type($payload) = 'object'
    ORDER BY r.submitted_at DESC, r.id DESC
  `),
  entry(S.listAmuReportsForEmployee, `
    SELECT ${jsonObject(AMU_REPORT_DISPLAY)}
    FROM amu_reports r
    JOIN employees e ON e.personnel_number = r.employee_number
    JOIN locations l ON l.id = r.location_id
    LEFT JOIN departments d ON d.id = r.department_id
    WHERE r.employee_number = json_extract($payload, '$.employeeNumber')
      AND r.status <> 'purged'
    ORDER BY r.submitted_at DESC, r.id DESC
  `),
  entry(S.getOwnOpenAmuReport, `
    SELECT ${jsonObject(AMU_REPORT)}
    FROM amu_reports r
    WHERE r.id = json_extract($payload, '$.id')
      AND r.employee_number = json_extract($payload, '$.employeeNumber')
      AND r.status IN ('submitted','returned')
  `),
  entry(S.countOtherAmuReportsForCase, `
    SELECT ${jsonObject({ count: "COUNT(*)" })}
    FROM amu_reports r
    WHERE r.sickness_case_id = json_extract($payload, '$.caseId')
      AND r.id <> json_extract($payload, '$.excludedReportId')
      AND r.status NOT IN ('withdrawn','purged')
  `),
  entry(S.getEmployeePersonnelRecordProjection, `
    SELECT ${jsonObject({
      personnel_number: "e.personnel_number",
      full_name: "e.full_name",
      nickname: "e.nickname",
      color: "e.color",
      home_location_id: "e.home_location_id",
      preferred_department_id: "e.preferred_department_id",
      home_location_name: "l.name",
      preferred_department_name: "d.name",
    })}
    FROM employees e
    LEFT JOIN locations l ON l.id = e.home_location_id
    LEFT JOIN departments d ON d.id = e.preferred_department_id
    WHERE e.personnel_number = json_extract($payload, '$.employeeNumber')
  `),

  entry(S.recordAudit, `
    INSERT INTO audit_log (actor, action, entity_type, entity_id, detail)
    VALUES (
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.action'),
      json_extract($payload, '$.entityType'),
      json_extract($payload, '$.entityId'),
      substr(json_extract($payload, '$.detail'), 1, 2000)
    )
  `),
  entry(S.insertProtectedNotification, `
    INSERT OR IGNORE INTO portal_notifications
      (id, recipient_employee_number, event_type, title, message, target,
       entity_type, entity_id, dedupe_key)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.recipientEmployeeNumber'),
      json_extract($payload, '$.eventType'),
      json_extract($payload, '$.title'),
      json_extract($payload, '$.message'),
      json_extract($payload, '$.target'),
      json_extract($payload, '$.entityType'),
      json_extract($payload, '$.entityId'),
      json_extract($payload, '$.dedupeKey')
    )
  `),
  entry(S.reactivateProtectedNotification, `
    UPDATE portal_notifications
    SET read_at = NULL, created_at = CURRENT_TIMESTAMP
    WHERE recipient_employee_number = json_extract($payload, '$.recipientEmployeeNumber')
      AND dedupe_key = json_extract($payload, '$.dedupeKey')
  `),
  entry(S.updateSicknessAlert, `
    UPDATE sickness_alerts
    SET
      status_lookup = json_extract($payload, '$.statusLookup'),
      protected_payload = json_extract($payload, '$.protectedPayload'),
      purge_after = json_extract($payload, '$.purgeAfter')
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.insertSicknessAlert, `
    INSERT OR IGNORE INTO sickness_alerts
      (id, sickness_case_id, status_lookup, protected_payload, purge_after, dedupe_lookup)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.caseId'),
      json_extract($payload, '$.statusLookup'),
      json_extract($payload, '$.protectedPayload'),
      json_extract($payload, '$.purgeAfter'),
      json_extract($payload, '$.dedupeLookup')
    )
  `),
  entry(S.markProtectedNotificationRead, `
    UPDATE portal_notifications
    SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE recipient_employee_number = json_extract($payload, '$.recipientEmployeeNumber')
      AND dedupe_key = json_extract($payload, '$.dedupeKey')
  `),
  entry(S.markProtectedEntityNotificationsRead, `
    UPDATE portal_notifications
    SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE entity_type = 'protected_record'
      AND entity_id = json_extract($payload, '$.entityId')
      AND (
        json_extract($payload, '$.eventTypes') IS NULL
        OR event_type IN (
          SELECT value FROM json_each(json_extract($payload, '$.eventTypes'))
        )
      )
  `),
  entry(S.markNotificationReadByDedupe, `
    UPDATE portal_notifications
    SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE dedupe_key = json_extract($payload, '$.dedupeKey')
  `),
  entry(S.reactivateNotificationByDedupe, `
    UPDATE portal_notifications
    SET read_at = NULL
    WHERE dedupe_key = json_extract($payload, '$.dedupeKey')
  `),
  entry(S.cancelPendingJobsForEntity, `
    UPDATE outbound_notification_jobs
    SET
      status = 'cancelled',
      purge_after = json_extract($payload, '$.purgeAfter'),
      updated_at = CURRENT_TIMESTAMP
    WHERE entity_lookup = json_extract($payload, '$.entityLookup')
      AND status = 'pending'
  `),
  entry(S.updateSicknessCasePayload, `
    UPDATE sickness_cases
    SET
      protected_payload = json_extract($payload, '$.protectedPayload'),
      revision = revision + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.upsertNotificationPreference, `
    INSERT INTO sickness_notification_preferences
      (employee_number, channel, enabled, process_notifications_enabled, earliest_time,
       protected_destination, verified_at, verification_hash, verification_salt,
       verification_expires_at, verification_attempts, verification_sent_at, updated_at)
    VALUES (
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.channel'),
      json_extract($payload, '$.enabled'),
      json_extract($payload, '$.processEnabled'),
      json_extract($payload, '$.earliestTime'),
      json_extract($payload, '$.protectedDestination'),
      json_extract($payload, '$.verifiedAt'),
      json_extract($payload, '$.verificationHash'),
      json_extract($payload, '$.verificationSalt'),
      json_extract($payload, '$.verificationExpiresAt'),
      json_extract($payload, '$.verificationAttempts'),
      json_extract($payload, '$.verificationSentAt'),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(employee_number, channel) DO UPDATE SET
      enabled = excluded.enabled,
      process_notifications_enabled = excluded.process_notifications_enabled,
      earliest_time = excluded.earliest_time,
      protected_destination = excluded.protected_destination,
      verified_at = excluded.verified_at,
      verification_hash = excluded.verification_hash,
      verification_salt = excluded.verification_salt,
      verification_expires_at = excluded.verification_expires_at,
      verification_attempts = excluded.verification_attempts,
      verification_sent_at = excluded.verification_sent_at,
      updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.requestNotificationVerification, `
    INSERT INTO sickness_notification_preferences
      (employee_number, channel, enabled, earliest_time, protected_destination, verified_at,
       verification_hash, verification_salt, verification_expires_at, verification_attempts,
       verification_sent_at, updated_at)
    VALUES (
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.channel'),
      0,
      json_extract($payload, '$.earliestTime'),
      json_extract($payload, '$.protectedDestination'),
      NULL,
      json_extract($payload, '$.verificationHash'),
      json_extract($payload, '$.verificationSalt'),
      json_extract($payload, '$.verificationExpiresAt'),
      0,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(employee_number, channel) DO UPDATE SET
      enabled = 0,
      earliest_time = excluded.earliest_time,
      protected_destination = excluded.protected_destination,
      verified_at = NULL,
      verification_hash = excluded.verification_hash,
      verification_salt = excluded.verification_salt,
      verification_expires_at = excluded.verification_expires_at,
      verification_attempts = 0,
      verification_sent_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.resetNotificationVerification, `
    UPDATE sickness_notification_preferences
    SET
      verification_hash = '',
      verification_salt = '',
      verification_expires_at = NULL,
      verification_attempts = 0,
      updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND channel = json_extract($payload, '$.channel')
  `),
  entry(S.incrementNotificationVerificationAttempts, `
    UPDATE sickness_notification_preferences
    SET
      verification_attempts = json_extract($payload, '$.attempts'),
      updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND channel = json_extract($payload, '$.channel')
  `),
  entry(S.confirmNotificationVerification, `
    UPDATE sickness_notification_preferences
    SET
      enabled = 1,
      verified_at = CURRENT_TIMESTAMP,
      verification_hash = '',
      verification_salt = '',
      verification_expires_at = NULL,
      verification_attempts = 0,
      updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND channel = json_extract($payload, '$.channel')
  `),
  entry(S.insertOutboundNotificationJob, `
    INSERT OR IGNORE INTO outbound_notification_jobs
      (id, recipient_lookup, channel, entity_lookup, protected_payload,
       not_before, purge_after, dedupe_lookup)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.recipientLookup'),
      json_extract($payload, '$.channel'),
      json_extract($payload, '$.entityLookup'),
      json_extract($payload, '$.protectedPayload'),
      json_extract($payload, '$.notBefore'),
      json_extract($payload, '$.purgeAfter'),
      json_extract($payload, '$.dedupeLookup')
    )
  `),
  entry(S.rearmOutboundNotificationJob, `
    UPDATE outbound_notification_jobs
    SET
      recipient_lookup = json_extract($payload, '$.recipientLookup'),
      channel = json_extract($payload, '$.channel'),
      entity_lookup = json_extract($payload, '$.entityLookup'),
      protected_payload = json_extract($payload, '$.protectedPayload'),
      not_before = json_extract($payload, '$.notBefore'),
      status = 'pending',
      attempts = 0,
      last_error_code = '',
      sent_at = NULL,
      purge_after = json_extract($payload, '$.purgeAfter'),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND status NOT IN ('pending','processing')
  `),
  entry(S.claimOutboundJob, `
    UPDATE outbound_notification_jobs
    SET status = 'processing', updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND status = 'pending'
  `),
  entry(S.cancelOutboundJob, `
    UPDATE outbound_notification_jobs
    SET
      status = 'cancelled',
      purge_after = json_extract($payload, '$.purgeAfter'),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.markOutboundJobSent, `
    UPDATE outbound_notification_jobs
    SET
      status = 'sent',
      attempts = attempts + 1,
      last_error_code = '',
      sent_at = CURRENT_TIMESTAMP,
      purge_after = json_extract($payload, '$.purgeAfter'),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.rescheduleOutboundJob, `
    UPDATE outbound_notification_jobs
    SET
      status = json_extract($payload, '$.status'),
      attempts = json_extract($payload, '$.attempts'),
      last_error_code = json_extract($payload, '$.lastErrorCode'),
      not_before = json_extract($payload, '$.notBefore'),
      purge_after = json_extract($payload, '$.purgeAfter'),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.deleteExpiredSicknessAlerts, `
    DELETE FROM sickness_alerts
    WHERE purge_after < json_extract($payload, '$.today')
      AND status_lookup <> json_extract($payload, '$.openStatusLookup')
  `),
  entry(S.deleteExpiredOutboundJobs, `
    DELETE FROM outbound_notification_jobs
    WHERE purge_after < json_extract($payload, '$.today')
      AND status <> 'processing'
  `),
  entry(S.deleteProtectedNotificationsByEntity, `
    DELETE FROM portal_notifications
    WHERE entity_type = 'protected_record'
      AND entity_id = json_extract($payload, '$.entityId')
  `),
  entry(S.deleteExpiredSicknessCase, `
    DELETE FROM sickness_cases
    WHERE id = json_extract($payload, '$.id')
      AND purge_after < json_extract($payload, '$.today')
      AND status_lookup NOT IN (
        SELECT value FROM json_each(json_extract($payload, '$.activeStatusLookups'))
      )
  `),
  entry(S.deleteProtectedCaseEvents, `
    DELETE FROM protected_case_events
    WHERE entity_kind = json_extract($payload, '$.entityKind')
      AND entity_id = json_extract($payload, '$.entityId')
  `),
  entry(S.insertProtectedCaseEvent, `
    INSERT INTO protected_case_events
      (id, entity_kind, entity_id, action_lookup, actor_lookup, protected_payload)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.entityKind'),
      json_extract($payload, '$.entityId'),
      json_extract($payload, '$.actionLookup'),
      json_extract($payload, '$.actorLookup'),
      json_extract($payload, '$.protectedPayload')
    )
  `),
  entry(S.upsertPersonnelSensitiveRecord, `
    INSERT INTO personnel_sensitive_records
      (employee_number, social_security_lookup, protected_payload, updated_by, updated_at)
    VALUES (
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.socialSecurityLookup'),
      json_extract($payload, '$.protectedPayload'),
      json_extract($payload, '$.actor'),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(employee_number) DO UPDATE SET
      social_security_lookup = excluded.social_security_lookup,
      protected_payload = excluded.protected_payload,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.markPersonnelDocumentPurged, `
    UPDATE personnel_record_documents
    SET
      status = 'purged',
      protected_payload = json_extract($payload, '$.protectedPayload'),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND status = 'deleted'
  `),
  entry(S.insertPersonnelDocument, `
    INSERT INTO personnel_record_documents
      (id, employee_number, storage_key, status, protected_payload)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.storageKey'),
      'active',
      json_extract($payload, '$.protectedPayload')
    )
  `),
  entry(S.insertPersonnelDocumentVersion, `
    INSERT INTO personnel_record_document_versions (
      document_id, version_number, storage_key, protected_payload, created_by, created_at
    ) VALUES (
      json_extract($payload, '$.documentId'),
      json_extract($payload, '$.versionNumber'),
      json_extract($payload, '$.storageKey'),
      json_extract($payload, '$.protectedPayload'),
      COALESCE(json_extract($payload, '$.createdBy'), ''),
      json_extract($payload, '$.createdAt')
    )
  `),
  entry(S.replacePersonnelDocumentCurrentPointer, `
    UPDATE personnel_record_documents
    SET
      storage_key = json_extract($payload, '$.storageKey'),
      protected_payload = json_extract($payload, '$.protectedPayload'),
      current_version = json_extract($payload, '$.versionNumber'),
      revision = revision + 1,
      updated_at = json_extract($payload, '$.updatedAt')
    WHERE id = json_extract($payload, '$.id')
      AND employee_number = json_extract($payload, '$.employeeNumber')
      AND current_version = json_extract($payload, '$.expectedCurrentVersion')
      AND status = 'active'
      AND EXISTS (
        SELECT 1
        FROM personnel_record_document_versions version
        WHERE version.document_id = personnel_record_documents.id
          AND version.version_number = json_extract($payload, '$.versionNumber')
          AND version.storage_key = json_extract($payload, '$.storageKey')
          AND version.protected_payload = json_extract($payload, '$.protectedPayload')
      )
  `),
  entry(S.insertPersonnelDocumentEvent, `
    INSERT INTO personnel_record_document_events (
      id, document_id, sequence_number, event_type, previous_receipt_sha256,
      receipt_sha256, actor_employee_number, created_at
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.documentId'),
      json_extract($payload, '$.sequenceNumber'),
      json_extract($payload, '$.eventType'),
      COALESCE(json_extract($payload, '$.previousReceiptSha256'), ''),
      json_extract($payload, '$.receiptSha256'),
      COALESCE(json_extract($payload, '$.actorEmployeeNumber'), ''),
      json_extract($payload, '$.createdAt')
    )
  `),
  entry(S.archivePersonnelDocument, `
    UPDATE personnel_record_documents
    SET
      status = 'archived',
      archived_by = json_extract($payload, '$.archivedBy'),
      archived_at = json_extract($payload, '$.archivedAt'),
      revision = revision + 1,
      updated_at = json_extract($payload, '$.archivedAt')
    WHERE id = json_extract($payload, '$.id')
      AND employee_number = json_extract($payload, '$.employeeNumber')
      AND revision = json_extract($payload, '$.expectedRevision')
      AND status IN ('active','retention_review')
      AND current_version > 0
  `),
  entry(S.requestPersonnelDocumentRetentionReview, `
    UPDATE personnel_record_documents
    SET
      status = 'retention_review',
      revision = revision + 1,
      updated_at = json_extract($payload, '$.occurredAt')
    WHERE id = json_extract($payload, '$.id')
      AND employee_number = json_extract($payload, '$.employeeNumber')
      AND revision = json_extract($payload, '$.expectedRevision')
      AND status = 'active'
      AND current_version > 0
  `),
  entry(S.markPersonnelDocumentDeleted, `
    UPDATE personnel_record_documents
    SET
      status = 'deleted',
      deleted_by = json_extract($payload, '$.deletedBy'),
      deleted_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND employee_number = json_extract($payload, '$.employeeNumber')
      AND status = 'active'
  `),
  entry(S.markPersonnelDocumentActive, `
    UPDATE personnel_record_documents
    SET
      status = 'active',
      deleted_by = NULL,
      deleted_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.updateAmuReportPayload, `
    UPDATE amu_reports
    SET
      protected_payload = json_extract($payload, '$.protectedPayload'),
      revision = revision + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.markAmuDocumentDeleted, `
    UPDATE amu_documents
    SET
      status = 'deleted',
      deleted_by = COALESCE(NULLIF(json_extract($payload, '$.deletedBy'), ''), deleted_by),
      deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP)
    WHERE id = json_extract($payload, '$.id')
      AND (
        json_extract($payload, '$.activeOnly') = 0
        OR status = 'active'
      )
  `),
  entry(S.markAmuDocumentPurged, `
    UPDATE amu_documents
    SET
      status = 'purged',
      original_filename = '',
      protected_payload = '',
      purged_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.purgeAmuReportIfNoDocuments, `
    UPDATE amu_reports
    SET
      status = 'purged',
      protected_payload = json_extract($payload, '$.protectedPayload'),
      revision = revision + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND NOT EXISTS (
        SELECT 1
        FROM amu_documents d
        WHERE d.report_id = amu_reports.id
          AND d.status <> 'purged'
      )
  `),
  entry(S.updateAmuReportRetention, `
    UPDATE amu_reports
    SET
      protected_payload = json_extract($payload, '$.protectedPayload'),
      revision = revision + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.insertSicknessCase, `
    INSERT INTO sickness_cases
      (employee_lookup, status_lookup, protected_payload, purge_after)
    VALUES (
      json_extract($payload, '$.employeeLookup'),
      json_extract($payload, '$.statusLookup'),
      json_extract($payload, '$.protectedPayload'),
      json_extract($payload, '$.purgeAfter')
    )
    RETURNING json_object('id', id) AS data
  `),
  entry(S.updateSicknessCasePayloadInitial, `
    UPDATE sickness_cases
    SET
      protected_payload = json_extract($payload, '$.protectedPayload'),
      revision = revision + 1
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.updateSicknessCaseWithdraw, `
    UPDATE sickness_cases
    SET
      status_lookup = json_extract($payload, '$.statusLookup'),
      protected_payload = json_extract($payload, '$.protectedPayload'),
      purge_after = json_extract($payload, '$.purgeAfter'),
      revision = revision + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND status_lookup = json_extract($payload, '$.expectedStatusLookup')
  `),
  entry(S.updateSicknessCaseVersioned, `
    UPDATE sickness_cases
    SET
      status_lookup = json_extract($payload, '$.statusLookup'),
      protected_payload = json_extract($payload, '$.protectedPayload'),
      purge_after = json_extract($payload, '$.purgeAfter'),
      revision = revision + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND revision = json_extract($payload, '$.expectedRevision')
      AND status_lookup = json_extract($payload, '$.expectedStatusLookup')
  `),
  entry(S.updateSicknessCaseVersionedForEmployee, `
    UPDATE sickness_cases
    SET
      status_lookup = json_extract($payload, '$.statusLookup'),
      protected_payload = json_extract($payload, '$.protectedPayload'),
      purge_after = json_extract($payload, '$.purgeAfter'),
      revision = revision + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND revision = json_extract($payload, '$.expectedRevision')
      AND status_lookup = json_extract($payload, '$.expectedStatusLookup')
      AND employee_lookup = json_extract($payload, '$.employeeLookup')
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
  entry(S.insertAmuReport, `
    INSERT INTO amu_reports
      (sickness_case_id, employee_number, location_id, department_id,
       incapacity_from, incapacity_to, employee_note, status, retention_until,
       protected_payload)
    VALUES (
      json_extract($payload, '$.sicknessCaseId'),
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.departmentId'),
      '',
      '',
      '',
      json_extract($payload, '$.status'),
      NULL,
      ''
    )
    RETURNING json_object('id', id) AS data
  `),
  entry(S.insertAmuDocument, `
    INSERT INTO amu_documents
      (id, report_id, storage_key, original_filename, detected_mime, byte_size,
       sha256, scan_status, encryption_key_id, encryption_iv, encryption_tag,
       status, uploaded_by, protected_payload)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.reportId'),
      json_extract($payload, '$.storageKey'),
      '',
      'application/octet-stream',
      0,
      '',
      json_extract($payload, '$.scanStatus'),
      json_extract($payload, '$.encryptionKeyId'),
      '',
      '',
      'active',
      '',
      json_extract($payload, '$.protectedPayload')
    )
  `),
  entry(S.updateAmuReportWithdraw, `
    UPDATE amu_reports
    SET
      status = 'withdrawn',
      protected_payload = json_extract($payload, '$.protectedPayload'),
      revision = revision + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND status IN ('submitted','returned')
  `),
  entry(S.markAmuDocumentsDeletedByReport, `
    UPDATE amu_documents
    SET
      status = 'deleted',
      deleted_by = json_extract($payload, '$.deletedBy'),
      deleted_at = CURRENT_TIMESTAMP
    WHERE report_id = json_extract($payload, '$.reportId')
      AND status = 'active'
  `),
  entry(S.updateAmuReportVersioned, `
    UPDATE amu_reports
    SET
      status = json_extract($payload, '$.status'),
      protected_payload = json_extract($payload, '$.protectedPayload'),
      revision = revision + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND revision = json_extract($payload, '$.expectedRevision')
      AND status = json_extract($payload, '$.expectedStatus')
  `),
  entry(S.restoreAmuDocument, `
    UPDATE amu_documents
    SET status = 'active', deleted_by = NULL, deleted_at = NULL
    WHERE id = json_extract($payload, '$.id')
  `),
]);

module.exports = {
  SQLITE_SICKNESS_AMU_MANAGEMENT_CATALOG,
};
