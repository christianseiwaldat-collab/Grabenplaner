"use strict";

const {
  INTEGRATION_RUNTIME_STATEMENTS: S,
} = require("../statements/integration-runtime");

function entry(statement, sql) {
  return Object.freeze({ statement, sql, returning: false });
}

function jsonObject(fields) {
  return `json_object(${Object.entries(fields)
    .flatMap(([name, expression]) => [`'${name}'`, expression])
    .join(", ")}) AS data`;
}

const CONNECTION = Object.freeze({
  id: "c.id",
  kind: "c.kind",
  name: "c.name",
  provider: "c.provider",
  configuration_json: "c.configuration_json",
  protected_credentials: "c.protected_credentials",
  credential_key_id: "c.credential_key_id",
  revision: "c.revision",
  active: "c.active",
  last_test_status: "c.last_test_status",
  last_test_at: "c.last_test_at",
  last_error_code: "c.last_error_code",
  created_by: "c.created_by",
  updated_by: "c.updated_by",
  created_at: "c.created_at",
  updated_at: "c.updated_at",
});

const PROFILE = Object.freeze({
  id: "p.id",
  direction: "p.direction",
  kind: "p.kind",
  name: "p.name",
  format: "p.format",
  configuration_json: "p.configuration_json",
  active: "p.active",
  created_by: "p.created_by",
  updated_by: "p.updated_by",
  created_at: "p.created_at",
  updated_at: "p.updated_at",
});

const RUN = Object.freeze({
  id: "r.id",
  profile_id: "r.profile_id",
  direction: "r.direction",
  kind: "r.kind",
  format: "r.format",
  content_sha256: "r.content_sha256",
  status: "r.status",
  total_count: "r.total_count",
  created_count: "r.created_count",
  updated_count: "r.updated_count",
  skipped_count: "r.skipped_count",
  error_count: "r.error_count",
  actor_employee_number: "r.actor_employee_number",
  options_json: "r.options_json",
  result_json: "r.result_json",
  error_code: "r.error_code",
  started_at: "r.started_at",
  completed_at: "r.completed_at",
});

const DELIVERY = Object.freeze({
  id: "d.id",
  connection_id: "d.connection_id",
  profile_id: "d.profile_id",
  idempotency_key: "d.idempotency_key",
  date_from: "d.date_from",
  date_to: "d.date_to",
  location_id: "d.location_id",
  department_id: "d.department_id",
  connection_revision: "d.connection_revision",
  connection_fingerprint: "d.connection_fingerprint",
  payload_sha256: "d.payload_sha256",
  row_count: "d.row_count",
  status: "d.status",
  attempt_count: "d.attempt_count",
  http_status: "d.http_status",
  error_code: "d.error_code",
  actor_employee_number: "d.actor_employee_number",
  started_at: "d.started_at",
  completed_at: "d.completed_at",
  updated_at: "d.updated_at",
});

const EMPLOYEE_IMPORT = Object.freeze({
  personnel_number: "e.personnel_number",
  full_name: "e.full_name",
  nickname: "e.nickname",
  color: "e.color",
  contracted_hours: "e.contracted_hours",
  target_workdays_per_week: "e.target_workdays_per_week",
  preferred_day_off: "e.preferred_day_off",
  fixed_workdays: "e.fixed_workdays",
  position_id: "e.position_id",
  time_confirmation_level: "e.time_confirmation_level",
  sickness_without_aum_enabled: "e.sickness_without_aum_enabled",
  home_location_id: "e.home_location_id",
  preferred_department_id: "e.preferred_department_id",
  cost_center_id: "e.cost_center_id",
  active: "e.active",
});

const SQLITE_INTEGRATION_RUNTIME_CATALOG = Object.freeze([
  entry(S.listConnections, `
    SELECT ${jsonObject(CONNECTION)}
    FROM integration_connections c
    WHERE json_extract($payload, '$.kind') = ''
       OR c.kind = json_extract($payload, '$.kind')
    ORDER BY c.active DESC, c.kind, c.name COLLATE NOCASE
  `),
  entry(S.getConnection, `
    SELECT ${jsonObject(CONNECTION)}
    FROM integration_connections c
    WHERE c.id = json_extract($payload, '$.id')
      AND (
        json_extract($payload, '$.includeInactive') = 1
        OR c.active = 1
      )
  `),
  entry(S.locationForCostCenter, `
    SELECT json_object('id', l.id) AS data
    FROM locations l
    WHERE l.cost_center_id = json_extract($payload, '$.costCenterId')
    ORDER BY l.active DESC, l.id
    LIMIT 1
  `),
  entry(S.listProfiles, `
    SELECT ${jsonObject(PROFILE)}
    FROM integration_profiles p
    WHERE (
      json_extract($payload, '$.direction') = ''
      OR p.direction = json_extract($payload, '$.direction')
    )
      AND (
        json_extract($payload, '$.kind') = ''
        OR p.kind = json_extract($payload, '$.kind')
      )
    ORDER BY p.active DESC, p.direction, p.kind, p.name COLLATE NOCASE
  `),
  entry(S.getProfile, `
    SELECT ${jsonObject(PROFILE)}
    FROM integration_profiles p
    WHERE p.id = json_extract($payload, '$.id')
      AND (
        json_extract($payload, '$.includeInactive') = 1
        OR p.active = 1
      )
  `),
  entry(S.getEmployeeImportRow, `
    SELECT ${jsonObject(EMPLOYEE_IMPORT)}
    FROM employees e
    WHERE e.personnel_number = json_extract($payload, '$.personnelNumber')
  `),
  entry(S.listEmployeeImportRowsCaseInsensitive, `
    SELECT ${jsonObject(EMPLOYEE_IMPORT)}
    FROM employees e
    WHERE e.personnel_number = json_extract($payload, '$.personnelNumber') COLLATE NOCASE
    ORDER BY e.personnel_number
  `),
  entry(S.listPayrollAbsencesForDay, `
    SELECT ${jsonObject({
      id: "w.id",
      group_id: "w.group_id",
      option_type: "w.option_type",
      date_from: "w.date_from",
      date_to: "w.date_to",
      all_day: "w.all_day",
      start_time: "w.start_time",
      end_time: "w.end_time",
      credited_minutes_per_day: "w.credited_minutes_per_day",
    })}
    FROM week_options w
    WHERE w.employee_number = json_extract($payload, '$.employeeNumber')
      AND json_extract($payload, '$.date') BETWEEN w.date_from AND w.date_to
    ORDER BY w.id
  `),
  entry(S.listPayrollEmployees, `
    SELECT ${jsonObject({
      personnel_number: "e.personnel_number",
      full_name: "e.full_name",
      contracted_hours: "e.contracted_hours",
      target_workdays_per_week: "e.target_workdays_per_week",
      home_location_id: "e.home_location_id",
      preferred_department_id: "e.preferred_department_id",
      active: "e.active",
    })}
    FROM employees e
    WHERE (e.active = 1 AND e.home_location_id = json_extract($payload, '$.locationId'))
       OR EXISTS (
         SELECT 1 FROM time_entries t
         WHERE t.employee_number = e.personnel_number
           AND t.location_id = json_extract($payload, '$.locationId')
           AND t.work_date BETWEEN json_extract($payload, '$.dateFrom') AND json_extract($payload, '$.dateTo')
           AND t.voided_at IS NULL
       )
       OR EXISTS (
         SELECT 1 FROM shifts s
         WHERE s.employee_number = e.personnel_number
           AND s.location_id = json_extract($payload, '$.locationId')
           AND s.shift_date BETWEEN json_extract($payload, '$.dateFrom') AND json_extract($payload, '$.dateTo')
       )
       OR EXISTS (
         SELECT 1 FROM week_options w
         WHERE w.employee_number = e.personnel_number
           AND e.home_location_id = json_extract($payload, '$.locationId')
           AND w.date_from <= json_extract($payload, '$.dateTo')
           AND w.date_to >= json_extract($payload, '$.dateFrom')
       )
    ORDER BY CAST(e.personnel_number AS INTEGER), e.personnel_number
  `),
  entry(S.hasPayrollDepartmentActivity, `
    SELECT json_object('found', 1) AS data
    WHERE EXISTS (
      SELECT 1 FROM shifts
      WHERE employee_number = json_extract($payload, '$.employeeNumber')
        AND shift_date BETWEEN json_extract($payload, '$.dateFrom') AND json_extract($payload, '$.dateTo')
        AND department_id = json_extract($payload, '$.departmentId')
    )
       OR EXISTS (
         SELECT 1 FROM time_entries
         WHERE employee_number = json_extract($payload, '$.employeeNumber')
           AND work_date BETWEEN json_extract($payload, '$.dateFrom') AND json_extract($payload, '$.dateTo')
           AND department_id = json_extract($payload, '$.departmentId')
           AND voided_at IS NULL
       )
  `),
  entry(S.getPayrollCorrectionState, `
    SELECT json_object('status', c.status) AS data
    FROM time_corrections c
    WHERE c.employee_number = json_extract($payload, '$.employeeNumber')
      AND c.correction_date = json_extract($payload, '$.date')
      AND c.location_id = json_extract($payload, '$.locationId')
      AND (
        json_extract($payload, '$.departmentId') IS NULL
        OR c.department_id = json_extract($payload, '$.departmentId')
      )
    ORDER BY CASE c.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, c.id DESC
    LIMIT 1
  `),
  entry(S.listSendingDeliveryIds, `
    SELECT json_object('id', d.id) AS data
    FROM integration_deliveries d
    WHERE d.status = 'sending'
  `),
  entry(S.listPayrollHandoffEmployees, `
    SELECT json_object('personnel_number', e.personnel_number, 'active', e.active) AS data
    FROM employees e
    WHERE e.home_location_id = json_extract($payload, '$.locationId')
      AND (
        json_extract($payload, '$.departmentId') = ''
        OR e.preferred_department_id = json_extract($payload, '$.departmentId')
      )
    ORDER BY CAST(e.personnel_number AS INTEGER), e.personnel_number
  `),
  entry(S.listRuns, `
    SELECT ${jsonObject(RUN)}
    FROM integration_runs r
    WHERE json_extract($payload, '$.actorEmployeeNumber') = ''
       OR r.actor_employee_number = json_extract($payload, '$.actorEmployeeNumber')
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT json_extract($payload, '$.limit')
  `),
  entry(S.listDeliveries, `
    SELECT ${jsonObject(DELIVERY)}
    FROM integration_deliveries d
    WHERE json_extract($payload, '$.actorEmployeeNumber') = ''
       OR d.actor_employee_number = json_extract($payload, '$.actorEmployeeNumber')
    ORDER BY d.started_at DESC, d.id DESC
    LIMIT json_extract($payload, '$.limit')
  `),
  entry(S.getDeliveryByIdempotencyKey, `
    SELECT ${jsonObject(DELIVERY)}
    FROM integration_deliveries d
    WHERE d.idempotency_key = json_extract($payload, '$.idempotencyKey')
  `),
  entry(S.getDelivery, `
    SELECT ${jsonObject(DELIVERY)}
    FROM integration_deliveries d
    WHERE d.id = json_extract($payload, '$.id')
  `),
  entry(S.getDeliveryStatus, `
    SELECT json_object('status', d.status) AS data
    FROM integration_deliveries d
    WHERE d.id = json_extract($payload, '$.id')
  `),

  entry(S.insertRun, `
    INSERT INTO integration_runs (
      id, profile_id, direction, kind, format, content_sha256, status, total_count,
      created_count, updated_count, skipped_count, error_count, actor_employee_number,
      options_json, result_json, error_code, completed_at
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.profileId'),
      json_extract($payload, '$.direction'),
      json_extract($payload, '$.kind'),
      json_extract($payload, '$.format'),
      json_extract($payload, '$.contentSha256'),
      json_extract($payload, '$.status'),
      json_extract($payload, '$.totalCount'),
      json_extract($payload, '$.createdCount'),
      json_extract($payload, '$.updatedCount'),
      json_extract($payload, '$.skippedCount'),
      json_extract($payload, '$.errorCount'),
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.optionsJson'),
      json_extract($payload, '$.resultJson'),
      json_extract($payload, '$.errorCode'),
      CURRENT_TIMESTAMP
    )
  `),
  entry(S.insertEmployee, `
    INSERT INTO employees (
      personnel_number, full_name, nickname, color, contracted_hours, target_workdays_per_week,
      preferred_day_off, fixed_workdays, position_id, time_confirmation_level,
      sickness_without_aum_enabled, home_location_id, preferred_department_id, cost_center_id, active
    ) VALUES (
      json_extract($payload, '$.personnelNumber'),
      json_extract($payload, '$.fullName'),
      json_extract($payload, '$.nickname'),
      json_extract($payload, '$.color'),
      json_extract($payload, '$.contractedHours'),
      json_extract($payload, '$.targetWorkdaysPerWeek'),
      json_extract($payload, '$.preferredDayOff'),
      json_extract($payload, '$.fixedWorkdays'),
      json_extract($payload, '$.positionId'),
      json_extract($payload, '$.timeConfirmationLevel'),
      json_extract($payload, '$.sicknessWithoutAumEnabled'),
      json_extract($payload, '$.homeLocationId'),
      NULLIF(json_extract($payload, '$.preferredDepartmentId'), ''),
      json_extract($payload, '$.costCenterId'),
      json_extract($payload, '$.active')
    )
  `),
  entry(S.updateEmployee, `
    UPDATE employees SET
      full_name = json_extract($payload, '$.fullName'),
      nickname = json_extract($payload, '$.nickname'),
      color = json_extract($payload, '$.color'),
      contracted_hours = json_extract($payload, '$.contractedHours'),
      target_workdays_per_week = json_extract($payload, '$.targetWorkdaysPerWeek'),
      preferred_day_off = json_extract($payload, '$.preferredDayOff'),
      fixed_workdays = json_extract($payload, '$.fixedWorkdays'),
      position_id = json_extract($payload, '$.positionId'),
      time_confirmation_level = json_extract($payload, '$.timeConfirmationLevel'),
      sickness_without_aum_enabled = json_extract($payload, '$.sicknessWithoutAumEnabled'),
      home_location_id = json_extract($payload, '$.homeLocationId'),
      preferred_department_id = NULLIF(json_extract($payload, '$.preferredDepartmentId'), ''),
      cost_center_id = json_extract($payload, '$.costCenterId'),
      active = json_extract($payload, '$.active')
    WHERE personnel_number = json_extract($payload, '$.personnelNumber')
  `),
  entry(S.deactivateImportedPortalUser, `
    UPDATE portal_users
    SET active = 0, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.personnelNumber')
  `),
  entry(S.revokeImportedPortalSessions, `
    UPDATE portal_sessions
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.personnelNumber')
      AND revoked_at IS NULL
  `),
  entry(S.revokeImportedMobileSessions, `
    UPDATE mobile_sessions
    SET revoked_at = CURRENT_TIMESTAMP,
        revoked_reason = json_extract($payload, '$.reason'),
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.personnelNumber')
      AND revoked_at IS NULL
  `),
  entry(S.markDeliveryInterrupted, `
    UPDATE integration_deliveries
    SET status = 'unknown',
        error_code = 'PROCESS_INTERRUPTED',
        completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND status = 'sending'
  `),
  entry(S.insertConnection, `
    INSERT INTO integration_connections (
      id, kind, name, provider, configuration_json, protected_credentials, credential_key_id,
      active, created_by, updated_by
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.kind'),
      json_extract($payload, '$.name'),
      json_extract($payload, '$.provider'),
      json_extract($payload, '$.configurationJson'),
      json_extract($payload, '$.protectedCredentials'),
      json_extract($payload, '$.credentialKeyId'),
      json_extract($payload, '$.active'),
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.actor')
    )
  `),
  entry(S.updateConnection, `
    UPDATE integration_connections SET
      name = json_extract($payload, '$.name'),
      provider = json_extract($payload, '$.provider'),
      configuration_json = json_extract($payload, '$.configurationJson'),
      protected_credentials = json_extract($payload, '$.protectedCredentials'),
      credential_key_id = json_extract($payload, '$.credentialKeyId'),
      active = json_extract($payload, '$.active'),
      revision = revision + 1,
      last_test_status = '',
      last_test_at = NULL,
      last_error_code = '',
      updated_by = json_extract($payload, '$.actor'),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.disableConnection, `
    UPDATE integration_connections SET
      active = 0,
      revision = revision + 1,
      last_test_status = '',
      last_error_code = '',
      updated_by = json_extract($payload, '$.actor'),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.recordConnectionTest, `
    UPDATE integration_connections SET
      last_test_status = json_extract($payload, '$.status'),
      last_test_at = CURRENT_TIMESTAMP,
      last_error_code = json_extract($payload, '$.errorCode'),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.insertProfile, `
    INSERT INTO integration_profiles (
      id, direction, kind, name, format, configuration_json, active, created_by, updated_by
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.direction'),
      json_extract($payload, '$.kind'),
      json_extract($payload, '$.name'),
      json_extract($payload, '$.format'),
      json_extract($payload, '$.configurationJson'),
      json_extract($payload, '$.active'),
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.actor')
    )
  `),
  entry(S.updateProfile, `
    UPDATE integration_profiles SET
      name = json_extract($payload, '$.name'),
      format = json_extract($payload, '$.format'),
      configuration_json = json_extract($payload, '$.configurationJson'),
      active = json_extract($payload, '$.active'),
      updated_by = json_extract($payload, '$.actor'),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.deleteProfile, `
    DELETE FROM integration_profiles
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.insertDelivery, `
    INSERT INTO integration_deliveries (
      id, connection_id, profile_id, idempotency_key, date_from, date_to, location_id, department_id,
      connection_revision, connection_fingerprint, payload_sha256, row_count, status, attempt_count,
      actor_employee_number, started_at, updated_at
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.connectionId'),
      json_extract($payload, '$.profileId'),
      json_extract($payload, '$.idempotencyKey'),
      json_extract($payload, '$.dateFrom'),
      json_extract($payload, '$.dateTo'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.departmentId'),
      json_extract($payload, '$.connectionRevision'),
      json_extract($payload, '$.connectionFingerprint'),
      json_extract($payload, '$.payloadSha256'),
      json_extract($payload, '$.rowCount'),
      'pending',
      0,
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.startedAt'),
      json_extract($payload, '$.startedAt')
    )
  `),
  entry(S.claimDelivery, `
    UPDATE integration_deliveries
    SET status = 'sending',
        attempt_count = attempt_count + 1,
        http_status = NULL,
        error_code = '',
        completed_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND status IN ('pending', 'unknown')
  `),
  entry(S.completeDelivery, `
    UPDATE integration_deliveries
    SET status = json_extract($payload, '$.status'),
        http_status = json_extract($payload, '$.httpStatus'),
        error_code = json_extract($payload, '$.errorCode'),
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.failDelivery, `
    UPDATE integration_deliveries
    SET status = json_extract($payload, '$.status'),
        error_code = json_extract($payload, '$.errorCode'),
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
]);

module.exports = {
  SQLITE_INTEGRATION_RUNTIME_CATALOG,
};
