"use strict";

const {
  MOBILE_AUTH_STATEMENTS: S,
} = require("../statements/mobile-auth");

function entry(statement, sql) {
  return Object.freeze({ statement, sql, returning: false });
}

function jsonObject(fields) {
  return `json_object(${Object.entries(fields)
    .flatMap(([name, expression]) => [`'${name}'`, expression])
    .join(", ")}) AS data`;
}

const SESSION_FIELDS = Object.freeze({
  id: "m.id",
  employee_number: "m.employee_number",
  access_token_hash: "m.access_token_hash",
  access_expires_at: "m.access_expires_at",
  refresh_token_hash: "m.refresh_token_hash",
  previous_refresh_token_hash: "m.previous_refresh_token_hash",
  refresh_expires_at: "m.refresh_expires_at",
  installation_id_hash: "m.installation_id_hash",
  platform: "m.platform",
  device_label: "m.device_label",
  app_version: "m.app_version",
  last_seen_at: "m.last_seen_at",
  revoked_at: "m.revoked_at",
  revoked_reason: "m.revoked_reason",
  created_at: "m.created_at",
  updated_at: "m.updated_at",
  role: "u.role",
  role_locked: "u.role_locked",
  active: "u.active",
  must_change_password: "u.must_change_password",
  full_name: "e.full_name",
  nickname: "e.nickname",
  color: "e.color",
  home_location_id: "e.home_location_id",
  preferred_department_id: "e.preferred_department_id",
  home_location_active: `EXISTS (
    SELECT 1
    FROM locations active_home_location
    WHERE active_home_location.id = e.home_location_id
      AND active_home_location.active = 1
  )`,
  preferred_department_active: `EXISTS (
    SELECT 1
    FROM departments active_home_department
    JOIN locations active_department_location
      ON active_department_location.id = active_home_department.location_id
      AND active_department_location.active = 1
    WHERE active_home_department.id = e.preferred_department_id
      AND active_home_department.location_id = e.home_location_id
      AND active_home_department.active = 1
  )`,
  time_confirmation_level: "e.time_confirmation_level",
  position_id: "e.position_id",
  employee_active: "e.active",
  position_name: "p.name",
  role_name: "r.name",
  permissions: "r.permissions",
  amu_local_access_mode: "COALESCE(amu.access_mode, 'inherit')",
  personnel_field_permissions: `COALESCE((
    SELECT json_group_array(json_object(
      'fieldKey', field.field_key,
      'accessLevel', field.access_level
    ))
    FROM personnel_field_permissions field
    WHERE field.role_id = u.role
  ), '[]')`,
  granted_permissions: `COALESCE((
    SELECT json_group_array(g.permission)
    FROM portal_permission_grants g
    WHERE g.employee_number = m.employee_number
  ), '[]')`,
  denied_permissions: `COALESCE((
    SELECT json_group_array(d.permission)
    FROM portal_permission_denials d
    WHERE d.employee_number = m.employee_number
  ), '[]')`,
  access_scope_assignment_count: `(
    SELECT COUNT(*)
    FROM portal_access_scopes assigned_scope
    WHERE assigned_scope.employee_number = m.employee_number
  )`,
  permission_scopes: `COALESCE((
    SELECT json_group_array(json_object(
      'permission', permission_scope.permission,
      'locationId', permission_scope.location_id,
      'departmentId', NULLIF(permission_scope.department_id, 0),
      'approvedBy', permission_scope.approved_by
    ))
    FROM portal_permission_scope_grants permission_scope
    JOIN locations permission_location
      ON permission_location.id = permission_scope.location_id
      AND permission_location.active = 1
    LEFT JOIN departments permission_department
      ON permission_department.id = permission_scope.department_id
      AND permission_department.location_id = permission_scope.location_id
      AND permission_department.active = 1
    WHERE permission_scope.employee_number = m.employee_number
      AND (
        permission_scope.department_id = 0
        OR permission_department.id IS NOT NULL
      )
  ), '[]')`,
  access_scopes: `COALESCE((
    SELECT json_group_array(json_object(
      'locationId', s.location_id,
      'departmentId', NULLIF(s.department_id, 0),
      'departmentManagerSubstitutionActive', CASE
        WHEN EXISTS (
          SELECT 1
          FROM approval_delegations delegation
          WHERE delegation.location_id = s.location_id
            AND delegation.delegate_employee_number = m.employee_number
            AND delegation.active = 1
            AND json_extract($payload, '$.businessDate')
              BETWEEN delegation.date_from AND delegation.date_to
        ) OR NOT EXISTS (
          SELECT 1
          FROM portal_users manager_user
          JOIN employees manager
            ON manager.personnel_number = manager_user.employee_number
          WHERE manager_user.role = 'manager'
            AND manager_user.active = 1
            AND manager.active = 1
            AND manager.home_location_id = s.location_id
            AND NOT EXISTS (
              SELECT 1
              FROM week_options option
              WHERE option.employee_number = manager_user.employee_number
                AND json_extract($payload, '$.businessDate')
                  BETWEEN option.date_from AND option.date_to
                AND option.option_type IN ('vacation', 'sick', 'time_off', 'branch')
            )
        ) THEN 1 ELSE 0
      END
    ))
    FROM portal_access_scopes s
    JOIN locations scope_location
      ON scope_location.id = s.location_id
      AND scope_location.active = 1
    LEFT JOIN departments scope_department
      ON scope_department.id = s.department_id
      AND scope_department.location_id = s.location_id
      AND scope_department.active = 1
    WHERE s.employee_number = m.employee_number
      AND (
        s.department_id = 0
        OR scope_department.id IS NOT NULL
      )
  ), '[]')`,
});

const RECEIPT_FIELDS = Object.freeze({
  operation: "r.operation",
  request_sha256: "r.request_sha256",
  status: "r.status",
  entity_type: "r.entity_type",
  entity_id: "r.entity_id",
  action_completed_at: "r.action_completed_at",
  http_status: "r.http_status",
  response_json: "r.response_json",
  created_at: "r.created_at",
  updated_at: "r.updated_at",
});

const SQLITE_MOBILE_AUTH_CATALOG = Object.freeze([
  entry(S.getSession, `
    SELECT ${jsonObject(SESSION_FIELDS)}
    FROM mobile_sessions m
    JOIN portal_users u ON u.employee_number = m.employee_number
    JOIN employees e ON e.personnel_number = u.employee_number
    LEFT JOIN positions p ON p.id = e.position_id
    LEFT JOIN portal_roles r ON r.id = u.role
    LEFT JOIN amu_local_access_overrides amu ON amu.employee_number = u.employee_number
    WHERE m.id = json_extract($payload, '$.sessionId')
    LIMIT 1
  `),
  entry(S.getMutationReceipt, `
    SELECT ${jsonObject(RECEIPT_FIELDS)}
    FROM mobile_mutation_receipts r
    WHERE r.employee_number = json_extract($payload, '$.employeeNumber')
      AND r.idempotency_key = json_extract($payload, '$.idempotencyKey')
  `),
  entry(S.getMutationReceiptStatus, `
    SELECT json_object('status', r.status) AS data
    FROM mobile_mutation_receipts r
    WHERE r.employee_number = json_extract($payload, '$.employeeNumber')
      AND r.idempotency_key = json_extract($payload, '$.idempotencyKey')
  `),
  entry(S.getPortalPasswordHash, `
    SELECT json_object('password_hash', u.password_hash) AS data
    FROM portal_users u
    WHERE u.employee_number = json_extract($payload, '$.employeeNumber')
  `),
  entry(S.getPortalPasswordMetadata, `
    SELECT json_object('password_changed_at', u.password_changed_at) AS data
    FROM portal_users u
    WHERE u.employee_number = json_extract($payload, '$.employeeNumber')
  `),
  entry(S.listActiveSessionIds, `
    SELECT json_object('id', m.id) AS data
    FROM mobile_sessions m
    WHERE m.employee_number = json_extract($payload, '$.employeeNumber')
      AND m.revoked_at IS NULL
      AND m.refresh_expires_at > json_extract($payload, '$.now')
    ORDER BY m.last_seen_at DESC, m.created_at DESC
  `),
  entry(S.refreshTokenWasConsumed, `
    SELECT json_object('found', 1) AS data
    FROM mobile_refresh_token_history
    WHERE session_id = json_extract($payload, '$.sessionId')
      AND token_hash = json_extract($payload, '$.tokenHash')
    LIMIT 1
  `),

  entry(S.touchSession, `
    UPDATE mobile_sessions
    SET last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.sessionId')
  `),
  entry(S.purgeExpiredMutationReceipts, `
    DELETE FROM mobile_mutation_receipts
    WHERE expires_at < json_extract($payload, '$.today')
  `),
  entry(S.finalizeRecoveredMutationReceipt, `
    UPDATE mobile_mutation_receipts
    SET status = 'completed',
        http_status = json_extract($payload, '$.httpStatus'),
        response_json = json_extract($payload, '$.responseJson'),
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND idempotency_key = json_extract($payload, '$.idempotencyKey')
      AND status = 'in_progress'
      AND action_completed_at IS NOT NULL
  `),
  entry(S.insertMutationReceipt, `
    INSERT INTO mobile_mutation_receipts (
      employee_number, idempotency_key, operation, request_sha256, status, expires_at
    ) VALUES (
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.idempotencyKey'),
      json_extract($payload, '$.operation'),
      json_extract($payload, '$.requestSha256'),
      'in_progress',
      json_extract($payload, '$.expiresAt')
    )
  `),
  entry(S.finalizeMutationReceipt, `
    UPDATE mobile_mutation_receipts
    SET status = 'completed',
        entity_type = json_extract($payload, '$.entityType'),
        entity_id = json_extract($payload, '$.entityId'),
        action_completed_at = CURRENT_TIMESTAMP,
        http_status = json_extract($payload, '$.httpStatus'),
        response_json = json_extract($payload, '$.responseJson'),
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND idempotency_key = json_extract($payload, '$.idempotencyKey')
      AND status = 'in_progress'
  `),
  entry(S.deleteInProgressMutationReceipt, `
    DELETE FROM mobile_mutation_receipts
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND idempotency_key = json_extract($payload, '$.idempotencyKey')
      AND status = 'in_progress'
  `),
  entry(S.preserveMutationReceiptAction, `
    UPDATE mobile_mutation_receipts
    SET entity_type = json_extract($payload, '$.entityType'),
        entity_id = json_extract($payload, '$.entityId'),
        action_completed_at = COALESCE(action_completed_at, CURRENT_TIMESTAMP),
        http_status = json_extract($payload, '$.httpStatus'),
        response_json = json_extract($payload, '$.responseJson'),
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND idempotency_key = json_extract($payload, '$.idempotencyKey')
      AND status = 'in_progress'
  `),
  entry(S.revokeEmployeeMobileSessions, `
    UPDATE mobile_sessions
    SET revoked_at = CURRENT_TIMESTAMP,
        revoked_reason = json_extract($payload, '$.reason'),
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND (
        json_extract($payload, '$.exceptSessionId') = ''
        OR id <> json_extract($payload, '$.exceptSessionId')
      )
      AND revoked_at IS NULL
  `),
  entry(S.revokeEmployeePortalSessions, `
    UPDATE portal_sessions
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND revoked_at IS NULL
  `),
  entry(S.updateMobilePassword, `
    UPDATE portal_users
    SET password_hash = json_extract($payload, '$.passwordHash'),
        must_change_password = 0,
        password_changed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
  `),
  entry(S.purgeExpiredSessions, `
    DELETE FROM mobile_sessions
    WHERE refresh_expires_at <= json_extract($payload, '$.now')
  `),
  entry(S.revokeDeviceSessions, `
    UPDATE mobile_sessions
    SET revoked_at = CURRENT_TIMESTAMP,
        revoked_reason = 'device_replaced',
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND installation_id_hash = json_extract($payload, '$.installationIdHash')
      AND revoked_at IS NULL
  `),
  entry(S.revokeSession, `
    UPDATE mobile_sessions
    SET revoked_at = CURRENT_TIMESTAMP,
        revoked_reason = json_extract($payload, '$.reason'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.sessionId')
      AND revoked_at IS NULL
  `),
  entry(S.insertSession, `
    INSERT INTO mobile_sessions (
      id, employee_number, access_token_hash, access_expires_at, refresh_token_hash,
      refresh_expires_at, installation_id_hash, platform, device_label, app_version
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.accessTokenHash'),
      json_extract($payload, '$.accessExpiresAt'),
      json_extract($payload, '$.refreshTokenHash'),
      json_extract($payload, '$.refreshExpiresAt'),
      json_extract($payload, '$.installationIdHash'),
      json_extract($payload, '$.platform'),
      json_extract($payload, '$.deviceLabel'),
      json_extract($payload, '$.appVersion')
    )
  `),
  entry(S.rememberRefreshToken, `
    INSERT OR IGNORE INTO mobile_refresh_token_history (session_id, token_hash, consumed_at)
    VALUES (
      json_extract($payload, '$.sessionId'),
      json_extract($payload, '$.tokenHash'),
      json_extract($payload, '$.consumedAt')
    )
  `),
  entry(S.rotateSession, `
    UPDATE mobile_sessions
    SET access_token_hash = json_extract($payload, '$.accessTokenHash'),
        access_expires_at = json_extract($payload, '$.accessExpiresAt'),
        previous_refresh_token_hash = refresh_token_hash,
        refresh_token_hash = json_extract($payload, '$.refreshTokenHash'),
        last_seen_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.sessionId')
      AND revoked_at IS NULL
  `),
  entry(S.revokeRefreshReuse, `
    UPDATE mobile_sessions
    SET revoked_at = CURRENT_TIMESTAMP,
        revoked_reason = 'refresh_reuse',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.sessionId')
  `),
  entry(S.refreshSession, `
    UPDATE mobile_sessions
    SET access_token_hash = json_extract($payload, '$.accessTokenHash'),
        access_expires_at = json_extract($payload, '$.accessExpiresAt'),
        previous_refresh_token_hash = refresh_token_hash,
        refresh_token_hash = json_extract($payload, '$.refreshTokenHash'),
        device_label = json_extract($payload, '$.deviceLabel'),
        app_version = json_extract($payload, '$.appVersion'),
        last_seen_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.sessionId')
      AND refresh_token_hash = json_extract($payload, '$.expectedRefreshTokenHash')
      AND revoked_at IS NULL
  `),
]);

module.exports = {
  SQLITE_MOBILE_AUTH_CATALOG,
};
