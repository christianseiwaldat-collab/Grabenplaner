"use strict";

const {
  GOVERNANCE_STORE_STATEMENTS,
} = require("../statements/governance-store");

function jsonRow(alias, columns) {
  return `json_object(${columns.map(([key, expression]) => (
    `'${key}', ${expression.includes(".") || expression.includes("(")
      ? expression
      : `${alias}.${expression}`}`
  )).join(", ")})`;
}

function entry(statement, sql) {
  return Object.freeze({ statement, sql, returning: false });
}

const RETENTION_RULE_ROW = [
  ["id", "r.id"],
  ["configuration_json", "r.configuration_json"],
];
const LEGAL_HOLD_ROW = [
  ["id", "h.id"],
  ["category", "h.category"],
  ["subject_employee_number", "h.subject_employee_number"],
  ["reason", "h.reason"],
  ["valid_from", "h.valid_from"],
  ["valid_to", "h.valid_to"],
  ["active", "h.active"],
];
const RETENTION_PREVIEW_ROW = [
  ["id", "p.id"],
  ["as_of", "p.as_of"],
  ["result_json", "p.result_json"],
  ["result_sha256", "p.result_sha256"],
  ["created_at", "p.created_at"],
];
const PRIVACY_REQUEST_ROW = [
  ["id", "p.id"],
  ["employee_number", "p.employee_number"],
  ["request_type", "p.request_type"],
  ["status", "p.status"],
  ["identity_status", "p.identity_status"],
  ["received_at", "p.received_at"],
  ["due_at", "p.due_at"],
  ["extended_due_at", "p.extended_due_at"],
  ["assigned_to", "p.assigned_to"],
  ["protected_payload", "p.protected_payload"],
  ["revision", "p.revision"],
  ["updated_at", "p.updated_at"],
];
const PRIVACY_EVENT_ROW = [
  ["id", "e.id"],
  ["request_id", "e.request_id"],
  ["event_type", "e.event_type"],
  ["actor_employee_number", "e.actor_employee_number"],
  ["protected_payload", "e.protected_payload"],
  ["previous_receipt_sha256", "e.previous_receipt_sha256"],
  ["receipt_sha256", "e.receipt_sha256"],
  ["created_at", "e.created_at"],
];
const VACATION_ACCOUNT_ROW = [
  ["id", "v.id"],
  ["employee_number", "v.employee_number"],
  ["leave_year", "v.leave_year"],
  ["revision", "v.revision"],
  ["status", "v.status"],
  ["total_days", "v.total_days"],
  ["eu_minimum_days", "v.eu_minimum_days"],
  ["national_additional_days", "v.national_additional_days"],
  ["weekly_workdays", "v.weekly_workdays"],
  ["leave_year_start", "v.leave_year_start"],
  ["leave_year_end", "v.leave_year_end"],
  ["expiry_candidate_on", "v.expiry_candidate_on"],
  ["expiry_status", "v.expiry_status"],
  ["calculation_json", "v.calculation_json"],
  ["sources_json", "v.sources_json"],
  ["receipt_sha256", "v.receipt_sha256"],
  ["supersedes_id", "v.supersedes_id"],
  ["created_by", "v.created_by"],
  ["created_at", "v.created_at"],
];
const VACATION_ENTITLEMENT_EMPLOYEE_ROW = [
  ["personnel_number", "e.personnel_number"],
  ["target_workdays_per_week", "e.target_workdays_per_week"],
];
const VACATION_EVENT_ROW = [
  ["id", "e.id"],
  ["employee_number", "e.employee_number"],
  ["leave_year", "e.leave_year"],
  ["account_revision_id", "e.account_revision_id"],
  ["event_type", "e.event_type"],
  ["tranche_type", "e.tranche_type"],
  ["amount_days", "e.amount_days"],
  ["effective_on", "e.effective_on"],
  ["detail_json", "e.detail_json"],
  ["receipt_sha256", "e.receipt_sha256"],
  ["created_by", "e.created_by"],
  ["created_at", "e.created_at"],
];
const TIME_STATEMENT_ROW = [
  ["id", "s.id"],
  ["employee_number", "s.employee_number"],
  ["period_start", "s.period_start"],
  ["period_end", "s.period_end"],
  ["revision", "s.revision"],
  ["status", "s.status"],
  ["source_sha256", "s.source_sha256"],
  ["snapshot_json", "s.snapshot_json"],
  ["receipt_sha256", "s.receipt_sha256"],
  ["supersedes_id", "s.supersedes_id"],
  ["created_by", "s.created_by"],
  ["created_at", "s.created_at"],
];
const TIME_EVENT_ROW = [
  ["id", "e.id"],
  ["statement_id", "e.statement_id"],
  ["event_type", "e.event_type"],
  ["actor_employee_number", "e.actor_employee_number"],
  ["detail_json", "e.detail_json"],
  ["receipt_sha256", "e.receipt_sha256"],
  ["created_at", "e.created_at"],
];
const PAYROLL_HANDOFF_ROW = [
  ["id", "h.id"],
  ["period_month", "h.period_month"],
  ["location_id", "h.location_id"],
  ["department_id", "h.department_id"],
  ["revision", "h.revision"],
  ["payload_json", "h.payload_json"],
  ["receipt_sha256", "h.receipt_sha256"],
  ["supersedes_id", "h.supersedes_id"],
  ["created_by", "h.created_by"],
  ["created_at", "h.created_at"],
];
const PAYROLL_EVENT_ROW = [
  ["id", "e.id"],
  ["handoff_id", "e.handoff_id"],
  ["event_type", "e.event_type"],
  ["payload_json", "e.payload_json"],
  ["receipt_sha256", "e.receipt_sha256"],
  ["actor_employee_number", "e.actor_employee_number"],
  ["occurred_at", "e.occurred_at"],
];

const SQLITE_GOVERNANCE_STORE_CATALOG = Object.freeze([
  entry(GOVERNANCE_STORE_STATEMENTS.listRetentionRules, `
    SELECT ${jsonRow("r", RETENTION_RULE_ROW)} AS data
    FROM retention_policy_versions r
    ORDER BY r.category, r.version DESC, r.created_at DESC
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.insertRetentionRule, `
    INSERT INTO retention_policy_versions
      (id, category, version, status, valid_from, valid_to, duration_days, start_trigger,
       disposition, legal_basis, source_json, configuration_json, receipt_sha256, created_by)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.category'),
      json_extract($data, '$.version'),
      json_extract($data, '$.status'),
      json_extract($data, '$.validFrom'),
      json_extract($data, '$.validTo'),
      json_extract($data, '$.durationDays'),
      json_extract($data, '$.startTrigger'),
      json_extract($data, '$.disposition'),
      json_extract($data, '$.legalBasis'),
      json_extract($data, '$.sourceJson'),
      json_extract($data, '$.configurationJson'),
      json_extract($data, '$.receiptSha256'),
      json_extract($data, '$.createdBy')
    )
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.retentionRuleExists, `
    SELECT json_object('id', r.id) AS data
    FROM retention_policy_versions r
    WHERE r.id = $id
    LIMIT 1
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.listLegalHolds, `
    SELECT ${jsonRow("h", LEGAL_HOLD_ROW)} AS data
    FROM legal_holds h
    ORDER BY h.created_at DESC, h.id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.insertLegalHold, `
    INSERT INTO legal_holds (
      id, category, subject_employee_number, reason,
      valid_from, valid_to, active, created_by
    ) VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.category'),
      json_extract($data, '$.employeeNumber'),
      json_extract($data, '$.reasonCode'),
      json_extract($data, '$.validFrom'),
      json_extract($data, '$.validTo'),
      1,
      json_extract($data, '$.actor')
    )
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.releaseLegalHold, `
    UPDATE legal_holds
    SET active = 0,
        released_by = json_extract($data, '$.actor'),
        released_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($data, '$.id')
      AND active = 1
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.insertRetentionPreview, `
    INSERT INTO retention_preview_runs
      (id, as_of, result_json, result_sha256, created_by, created_at)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.asOf'),
      json_extract($data, '$.resultJson'),
      json_extract($data, '$.resultSha256'),
      json_extract($data, '$.createdBy'),
      json_extract($data, '$.createdAt')
    )
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.latestRetentionPreview, `
    SELECT ${jsonRow("p", RETENTION_PREVIEW_ROW)} AS data
    FROM retention_preview_runs p
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT 1
  `),

  entry(GOVERNANCE_STORE_STATEMENTS.privacyRequestById, `
    SELECT ${jsonRow("p", PRIVACY_REQUEST_ROW)} AS data
    FROM privacy_requests p
    WHERE p.id = $id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.privacyRequestEvents, `
    SELECT ${jsonRow("e", PRIVACY_EVENT_ROW)} AS data
    FROM privacy_request_events e
    WHERE e.request_id = $requestId
    ORDER BY CAST(substr(e.id, instr(e.id, ':event:') + 7) AS INTEGER), e.id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.privacyRequestRevision, `
    SELECT json_object('revision', p.revision) AS data
    FROM privacy_requests p
    WHERE p.id = $id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.upsertPrivacyRequest, `
    INSERT INTO privacy_requests
      (id, employee_number, request_type, status, identity_status, received_at, due_at,
       extended_due_at, assigned_to, protected_payload, revision, updated_at)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.employeeNumber'),
      json_extract($data, '$.requestType'),
      json_extract($data, '$.status'),
      json_extract($data, '$.identityStatus'),
      json_extract($data, '$.receivedAt'),
      json_extract($data, '$.dueAt'),
      json_extract($data, '$.extendedDueAt'),
      json_extract($data, '$.assignedTo'),
      json_extract($data, '$.protectedPayload'),
      json_extract($data, '$.revision'),
      json_extract($data, '$.updatedAt')
    )
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      identity_status = excluded.identity_status,
      due_at = excluded.due_at,
      extended_due_at = excluded.extended_due_at,
      protected_payload = excluded.protected_payload,
      revision = excluded.revision,
      updated_at = excluded.updated_at
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.insertPrivacyRequestEvent, `
    INSERT INTO privacy_request_events
      (id, request_id, event_type, actor_employee_number, protected_payload,
       previous_receipt_sha256, receipt_sha256, created_at)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.requestId'),
      json_extract($data, '$.eventType'),
      json_extract($data, '$.actorEmployeeNumber'),
      json_extract($data, '$.protectedPayload'),
      json_extract($data, '$.previousReceiptSha256'),
      json_extract($data, '$.receiptSha256'),
      json_extract($data, '$.createdAt')
    )
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.listPrivacyRequests, `
    SELECT ${jsonRow("p", PRIVACY_REQUEST_ROW)} AS data
    FROM privacy_requests p
    ORDER BY p.received_at DESC
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.listPrivacyRequestsByEmployee, `
    SELECT ${jsonRow("p", PRIVACY_REQUEST_ROW)} AS data
    FROM privacy_requests p
    WHERE p.employee_number = $employeeNumber
    ORDER BY p.received_at DESC
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.retentionTimeEntries, `
    SELECT json_object(
      'id', t.id,
      'employee_number', t.employee_number,
      'entry_timestamp', t.entry_timestamp,
      'created_at', t.created_at
    ) AS data
    FROM time_entries t
    ORDER BY t.id
    LIMIT 50000
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.retentionVacationHistory, `
    SELECT json_object(
      'id', h.id,
      'employee_number', h.employee_number,
      'created_at', h.created_at
    ) AS data
    FROM vacation_history_events h
    ORDER BY h.created_at, h.id
    LIMIT 20000
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.retentionPrivacyRequests, `
    SELECT json_object(
      'id', p.id,
      'employee_number', p.employee_number,
      'received_at', p.received_at,
      'updated_at', p.updated_at,
      'status', p.status
    ) AS data
    FROM privacy_requests p
    ORDER BY p.received_at, p.id
    LIMIT 10000
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.retentionAmuReports, `
    SELECT json_object(
      'id', a.id,
      'employee_number', a.employee_number,
      'submitted_at', a.submitted_at,
      'updated_at', a.updated_at,
      'status', a.status
    ) AS data
    FROM amu_reports a
    ORDER BY a.submitted_at, a.id
    LIMIT 10000
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.openPrivacyRequests, `
    SELECT json_object(
      'id', p.id,
      'employee_number', p.employee_number,
      'received_at', p.received_at
    ) AS data
    FROM privacy_requests p
    WHERE p.status NOT IN ('fulfilled','partially_fulfilled','rejected','withdrawn')
    ORDER BY p.id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.privacyExportEmployee, `
    SELECT json_object(
      'personnel_number', e.personnel_number,
      'full_name', e.full_name,
      'nickname', e.nickname,
      'contracted_hours', e.contracted_hours,
      'target_workdays_per_week', e.target_workdays_per_week,
      'position_id', e.position_id,
      'home_location_id', e.home_location_id,
      'preferred_department_id', e.preferred_department_id,
      'cost_center_id', e.cost_center_id,
      'active', e.active,
      'created_at', e.created_at
    ) AS data
    FROM employees e
    WHERE e.personnel_number = $employeeNumber
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.privacyExportTimeEntries, `
    SELECT json_object(
      'id', t.id,
      'work_date', t.work_date,
      'entry_type', t.entry_type,
      'entry_timestamp', t.entry_timestamp,
      'source', t.source,
      'note', t.note,
      'created_at', t.created_at,
      'voided_at', t.voided_at,
      'void_reason', t.void_reason,
      'correction_id', t.correction_id
    ) AS data
    FROM time_entries t
    WHERE t.employee_number = $employeeNumber
    ORDER BY t.work_date, t.entry_timestamp, t.id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.privacyExportTimeCorrections, `
    SELECT json_object(
      'id', c.id,
      'correction_date', c.correction_date,
      'requested_change', c.requested_change,
      'request_note', c.request_note,
      'status', c.status,
      'decision_note', c.decision_note,
      'created_at', c.created_at,
      'updated_at', c.updated_at
    ) AS data
    FROM time_corrections c
    WHERE c.employee_number = $employeeNumber
    ORDER BY c.correction_date, c.id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.privacyExportVacationEntitlements, `
    SELECT json_object(
      'year', v.year,
      'days', v.days,
      'updated_at', v.updated_at
    ) AS data
    FROM vacation_entitlements v
    WHERE v.employee_number = $employeeNumber
    ORDER BY v.year
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.privacyExportVacationHistory, `
    SELECT json_object(
      'id', h.id,
      'group_id', h.group_id,
      'employee_number', h.employee_number,
      'action', h.action,
      'snapshot_json', h.snapshot_json,
      'receipt_sha256', h.receipt_sha256,
      'created_by', h.created_by,
      'created_at', h.created_at
    ) AS data
    FROM vacation_history_events h
    WHERE h.employee_number = $employeeNumber
    ORDER BY h.created_at, h.id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.privacyExportSicknessMetadata, `
    SELECT json_object(
      'id', a.id,
      'status', a.status,
      'submitted_at', a.submitted_at,
      'updated_at', a.updated_at,
      'retention_until', a.retention_until,
      'revision', a.revision
    ) AS data
    FROM amu_reports a
    WHERE a.employee_number = $employeeNumber
    ORDER BY a.submitted_at, a.id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.insertPrivacyExportReceipt, `
    INSERT INTO privacy_export_receipts
      (id, request_id, employee_number, format, content_sha256, categories_json,
       expires_at, created_by, created_at, downloaded_at)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.requestId'),
      json_extract($data, '$.employeeNumber'),
      'json',
      json_extract($data, '$.contentSha256'),
      json_extract($data, '$.categoriesJson'),
      json_extract($data, '$.expiresAt'),
      json_extract($data, '$.createdBy'),
      json_extract($data, '$.createdAt'),
      json_extract($data, '$.downloadedAt')
    )
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.listVacationHistoryForIntegrity, `
    SELECT json_object(
      'id', h.id,
      'group_id', h.group_id,
      'employee_number', h.employee_number,
      'action', h.action,
      'snapshot_json', h.snapshot_json,
      'receipt_sha256', h.receipt_sha256,
      'created_by', h.created_by,
      'created_at', h.created_at
    ) AS data
    FROM vacation_history_events h
    ORDER BY h.created_at, h.id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.listRetentionPreviewsForIntegrity, `
    SELECT json_object(
      'id', p.id,
      'result_json', p.result_json,
      'result_sha256', p.result_sha256
    ) AS data
    FROM retention_preview_runs p
    ORDER BY p.created_at, p.id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.listPrivacyEventsForIntegrity, `
    SELECT json_object(
      'id', e.id,
      'request_id', e.request_id,
      'protected_payload', e.protected_payload,
      'receipt_sha256', e.receipt_sha256,
      'employee_number', r.employee_number
    ) AS data
    FROM privacy_request_events e
    JOIN privacy_requests r ON r.id = e.request_id
    ORDER BY e.request_id, e.created_at, e.id
  `),

  entry(GOVERNANCE_STORE_STATEMENTS.latestVacationAccount, `
    SELECT ${jsonRow("v", VACATION_ACCOUNT_ROW)} AS data
    FROM vacation_account_revisions v
    WHERE v.employee_number = $employeeNumber AND v.leave_year = $year
    ORDER BY v.revision DESC
    LIMIT 1
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.vacationEntitlementEmployee, `
    SELECT ${jsonRow("e", VACATION_ENTITLEMENT_EMPLOYEE_ROW)} AS data
    FROM employees e
    WHERE e.personnel_number = $employeeNumber
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.upsertVacationEntitlement, `
    INSERT INTO vacation_entitlements (employee_number, year, days, updated_at)
    VALUES (
      json_extract($data, '$.employeeNumber'),
      json_extract($data, '$.year'),
      json_extract($data, '$.days'),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(employee_number, year)
    DO UPDATE SET days = excluded.days, updated_at = CURRENT_TIMESTAMP
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.vacationAccountById, `
    SELECT ${jsonRow("v", VACATION_ACCOUNT_ROW)} AS data
    FROM vacation_account_revisions v
    WHERE v.id = $id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.listVacationAccounts, `
    SELECT ${jsonRow("v", VACATION_ACCOUNT_ROW)} AS data
    FROM vacation_account_revisions v
    ORDER BY v.employee_number, v.leave_year, v.revision, v.id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.insertVacationAccount, `
    INSERT INTO vacation_account_revisions
      (id, employee_number, leave_year, revision, status, total_days, eu_minimum_days,
       national_additional_days, weekly_workdays, leave_year_start, leave_year_end,
       expiry_candidate_on, expiry_status, calculation_json, sources_json, receipt_sha256,
       supersedes_id, created_by, created_at)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.employeeNumber'),
      json_extract($data, '$.leaveYear'),
      json_extract($data, '$.revision'),
      'confirmed',
      json_extract($data, '$.totalDays'),
      json_extract($data, '$.euMinimumDays'),
      json_extract($data, '$.nationalAdditionalDays'),
      json_extract($data, '$.weeklyWorkdays'),
      json_extract($data, '$.leaveYearStart'),
      json_extract($data, '$.leaveYearEnd'),
      json_extract($data, '$.expiryCandidateOn'),
      json_extract($data, '$.expiryStatus'),
      json_extract($data, '$.calculationJson'),
      json_extract($data, '$.sourcesJson'),
      json_extract($data, '$.receiptSha256'),
      json_extract($data, '$.supersedesId'),
      json_extract($data, '$.createdBy'),
      json_extract($data, '$.createdAt')
    )
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.listVacationAccountEvents, `
    SELECT ${jsonRow("e", VACATION_EVENT_ROW)} AS data
    FROM vacation_account_events e
    ORDER BY e.account_revision_id, e.created_at, e.id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.insertVacationAccountEvent, `
    INSERT INTO vacation_account_events
      (id, employee_number, leave_year, account_revision_id, event_type, tranche_type,
       amount_days, effective_on, detail_json, receipt_sha256, created_by, created_at)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.employeeNumber'),
      json_extract($data, '$.leaveYear'),
      json_extract($data, '$.accountRevisionId'),
      json_extract($data, '$.eventType'),
      'unallocated',
      json_extract($data, '$.amountDays'),
      json_extract($data, '$.effectiveOn'),
      json_extract($data, '$.detailJson'),
      json_extract($data, '$.receiptSha256'),
      json_extract($data, '$.createdBy'),
      json_extract($data, '$.createdAt')
    )
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.vacationEntitlementsForBackfill, `
    SELECT json_object(
      'employee_number', v.employee_number,
      'year', v.year,
      'days', v.days,
      'target_workdays_per_week', e.target_workdays_per_week
    ) AS data
    FROM vacation_entitlements v
    JOIN employees e ON e.personnel_number = v.employee_number
    ORDER BY v.year, CAST(v.employee_number AS INTEGER), v.employee_number
  `),

  entry(GOVERNANCE_STORE_STATEMENTS.timeStatementById, `
    SELECT ${jsonRow("s", TIME_STATEMENT_ROW)} AS data
    FROM time_record_statements s
    WHERE s.id = $id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.timeStatementSuccessor, `
    SELECT json_object('id', s.id) AS data
    FROM time_record_statements s
    WHERE s.supersedes_id = $id
    ORDER BY s.revision DESC, s.created_at DESC, s.id DESC
    LIMIT 1
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.listTimeStatementsForIntegrity, `
    SELECT ${jsonRow("s", TIME_STATEMENT_ROW)} AS data
    FROM time_record_statements s
    ORDER BY s.employee_number, s.period_start, s.revision, s.id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.listTimeStatementEvents, `
    SELECT ${jsonRow("e", TIME_EVENT_ROW)} AS data
    FROM time_record_statement_events e
    ORDER BY e.statement_id, e.created_at, e.id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.insertTimeStatement, `
    INSERT INTO time_record_statements
      (id, employee_number, period_start, period_end, revision, status, source_sha256,
       snapshot_json, receipt_sha256, supersedes_id, created_by, created_at)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.employeeNumber'),
      json_extract($data, '$.periodStart'),
      json_extract($data, '$.periodEnd'),
      json_extract($data, '$.revision'),
      json_extract($data, '$.status'),
      json_extract($data, '$.sourceSha256'),
      json_extract($data, '$.snapshotJson'),
      json_extract($data, '$.receiptSha256'),
      json_extract($data, '$.supersedesId'),
      json_extract($data, '$.createdBy'),
      json_extract($data, '$.createdAt')
    )
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.insertTimeStatementEvent, `
    INSERT INTO time_record_statement_events
      (id, statement_id, event_type, actor_employee_number, detail_json,
       receipt_sha256, created_at)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.statementId'),
      json_extract($data, '$.eventType'),
      json_extract($data, '$.actorEmployeeNumber'),
      json_extract($data, '$.detailJson'),
      json_extract($data, '$.receiptSha256'),
      json_extract($data, '$.createdAt')
    )
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.latestTimeStatement, `
    SELECT ${jsonRow("s", TIME_STATEMENT_ROW)} AS data
    FROM time_record_statements s
    WHERE s.employee_number = $employeeNumber
      AND s.period_start = $periodStart
      AND s.period_end = $periodEnd
    ORDER BY s.revision DESC
    LIMIT 1
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.listTimeStatementsForPeriod, `
    SELECT ${jsonRow("s", [
      ...TIME_STATEMENT_ROW,
      ["superseded_by_id", `(
        SELECT newer.id
        FROM time_record_statements newer
        WHERE newer.supersedes_id = s.id
        ORDER BY newer.revision DESC, newer.created_at DESC, newer.id DESC
        LIMIT 1
      )`],
    ])} AS data
    FROM time_record_statements s
    WHERE s.period_start = $periodStart AND s.period_end = $periodEnd
    ORDER BY s.employee_number, s.revision DESC, s.created_at DESC
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.timeEntriesForStatement, `
    SELECT json_object(
      'id', t.id,
      'employee_number', t.employee_number,
      'work_date', t.work_date,
      'entry_type', t.entry_type,
      'entry_timestamp', t.entry_timestamp,
      'source', t.source,
      'note', t.note,
      'created_by', t.created_by,
      'created_at', t.created_at
    ) AS data
    FROM time_entries t
    WHERE t.employee_number = $employeeNumber
      AND t.work_date BETWEEN $periodStart AND $periodEnd
      AND t.voided_at IS NULL
    ORDER BY t.work_date, t.entry_timestamp, t.id
  `),

  entry(GOVERNANCE_STORE_STATEMENTS.payrollHandoffById, `
    SELECT ${jsonRow("h", PAYROLL_HANDOFF_ROW)} AS data
    FROM payroll_handoffs h
    WHERE h.id = $id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.payrollHandoffEvents, `
    SELECT ${jsonRow("e", PAYROLL_EVENT_ROW)} AS data
    FROM payroll_handoff_events e
    WHERE e.handoff_id = $handoffId
    ORDER BY e.occurred_at, e.id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.insertPayrollHandoffEvent, `
    INSERT INTO payroll_handoff_events
      (id, handoff_id, event_type, payload_json, receipt_sha256, actor_employee_number, occurred_at)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.handoffId'),
      json_extract($data, '$.eventType'),
      json_extract($data, '$.payloadJson'),
      json_extract($data, '$.receiptSha256'),
      json_extract($data, '$.actorEmployeeNumber'),
      json_extract($data, '$.occurredAt')
    )
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.latestPayrollHandoff, `
    SELECT ${jsonRow("h", PAYROLL_HANDOFF_ROW)} AS data
    FROM payroll_handoffs h
    WHERE h.period_month = $month
      AND h.location_id = $locationId
      AND h.department_id = $departmentId
    ORDER BY h.revision DESC
    LIMIT 1
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.insertPayrollHandoff, `
    INSERT INTO payroll_handoffs
      (id, period_month, location_id, department_id, revision, payload_json, receipt_sha256,
       supersedes_id, created_by, created_at)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.month'),
      json_extract($data, '$.locationId'),
      json_extract($data, '$.departmentId'),
      json_extract($data, '$.revision'),
      json_extract($data, '$.payloadJson'),
      json_extract($data, '$.receiptSha256'),
      json_extract($data, '$.supersedesId'),
      json_extract($data, '$.createdBy'),
      json_extract($data, '$.createdAt')
    )
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.listPayrollHandoffReferences, `
    SELECT json_object(
      'id', h.id,
      'supersedes_id', h.supersedes_id,
      'period_month', h.period_month,
      'location_id', h.location_id
    ) AS data
    FROM payroll_handoffs h
    ORDER BY h.period_month DESC, h.location_id, h.department_id, h.revision DESC
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.listPayrollHandoffsForIntegrity, `
    SELECT json_object(
      'id', h.id,
      'payload_json', h.payload_json
    ) AS data
    FROM payroll_handoffs h
    ORDER BY h.period_month, h.location_id, h.department_id, h.revision
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.listPayrollHandoffEventsForIntegrity, `
    SELECT json_object(
      'id', e.id,
      'payload_json', e.payload_json
    ) AS data
    FROM payroll_handoff_events e
    ORDER BY e.handoff_id, e.occurred_at, e.id
  `),
  entry(GOVERNANCE_STORE_STATEMENTS.payrollHandoffEventCount, `
    SELECT COUNT(*) AS count
    FROM payroll_handoff_events
  `),
]);

module.exports = {
  SQLITE_GOVERNANCE_STORE_CATALOG,
};
