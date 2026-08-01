"use strict";

const {
  PORTAL_ACCESS_STATEMENTS: S,
} = require("../statements/portal-access");

function entry(statement, sql) {
  return Object.freeze({ statement, sql, returning: false });
}

function jsonObject(fields) {
  return `json_object(${Object.entries(fields)
    .flatMap(([name, expression]) => [`'${name}'`, expression])
    .join(", ")}) AS data`;
}

const EMPLOYEE_SESSION_FIELDS = Object.freeze({
  id: "s.id",
  employee_number: "s.employee_number",
  expires_at: "s.expires_at",
  revoked_at: "s.revoked_at",
  role: "u.role",
  role_locked: "u.role_locked",
  active: "u.active",
  must_change_password: "u.must_change_password",
  full_name: "e.full_name",
  nickname: "e.nickname",
  color: "e.color",
  home_location_id: "e.home_location_id",
  preferred_department_id: "e.preferred_department_id",
  time_confirmation_level: "e.time_confirmation_level",
  position_id: "e.position_id",
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
    WHERE g.employee_number = s.employee_number
  ), '[]')`,
  denied_permissions: `COALESCE((
    SELECT json_group_array(d.permission)
    FROM portal_permission_denials d
    WHERE d.employee_number = s.employee_number
  ), '[]')`,
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
    WHERE permission_scope.employee_number = s.employee_number
      AND (
        permission_scope.department_id = 0
        OR permission_department.id IS NOT NULL
      )
  ), '[]')`,
  access_scopes: `COALESCE((
    SELECT json_group_array(json_object(
      'locationId', scope.location_id,
      'departmentId', NULLIF(scope.department_id, 0),
      'departmentManagerSubstitutionActive', CASE
        WHEN EXISTS (
          SELECT 1
          FROM approval_delegations delegation
          WHERE delegation.location_id = scope.location_id
            AND delegation.delegate_employee_number = s.employee_number
            AND delegation.active = 1
            AND json_extract($payload, '$.businessDate')
              BETWEEN delegation.date_from AND delegation.date_to
        ) OR NOT EXISTS (
          SELECT 1
          FROM portal_users manager_user
          JOIN employees manager ON manager.personnel_number = manager_user.employee_number
          WHERE manager_user.role = 'manager'
            AND manager_user.active = 1
            AND manager.active = 1
            AND manager.home_location_id = scope.location_id
            AND NOT EXISTS (
              SELECT 1
              FROM week_options option
              WHERE option.employee_number = manager_user.employee_number
                AND json_extract($payload, '$.businessDate')
                  BETWEEN option.date_from AND option.date_to
                AND option.option_type IN ('vacation','sick','time_off','branch')
            )
        ) THEN 1 ELSE 0
      END
    ))
    FROM portal_access_scopes scope
    JOIN locations scope_location
      ON scope_location.id = scope.location_id
      AND scope_location.active = 1
    LEFT JOIN departments scope_department
      ON scope_department.id = scope.department_id
      AND scope_department.location_id = scope.location_id
      AND scope_department.active = 1
    WHERE scope.employee_number = s.employee_number
      AND (
        scope.department_id = 0
        OR scope_department.id IS NOT NULL
      )
  ), '[]')`,
});

const ORGANIZATION_SESSION_FIELDS = Object.freeze({
  id: "s.id",
  account_id: "s.account_id",
  expires_at: "s.expires_at",
  login_name: "account.login_name",
  display_name: "account.display_name",
  account_type: "account.account_type",
  active: "account.active",
  must_change_password: "account.must_change_password",
  permissions: `COALESCE((
    SELECT json_group_array(permission.permission)
    FROM portal_organization_account_permissions permission
    WHERE permission.account_id = account.id
  ), '[]')`,
  access_scopes: `COALESCE((
    SELECT json_group_array(json_object(
      'locationId', scope.location_id,
      'departmentId', NULLIF(scope.department_id, 0)
    ))
    FROM portal_organization_account_scopes scope
    JOIN locations scope_location
      ON scope_location.id = scope.location_id
      AND scope_location.active = 1
    LEFT JOIN departments scope_department
      ON scope_department.id = scope.department_id
      AND scope_department.location_id = scope.location_id
      AND scope_department.active = 1
    WHERE scope.account_id = account.id
      AND (
        scope.department_id = 0
        OR scope_department.id IS NOT NULL
      )
  ), '[]')`,
});

const SQLITE_PORTAL_ACCESS_CATALOG = Object.freeze([
  entry(S.getBackupAdminUser, `
    SELECT json_object(
      'employee_number', u.employee_number,
      'password_hash', u.password_hash,
      'role', u.role,
      'active', u.active,
      'locked_until', u.locked_until,
      'employee_active', e.active
    ) AS data
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    WHERE u.employee_number = json_extract($payload, '$.employeeNumber')
    LIMIT 1
  `),
  entry(S.insertNotification, `
    INSERT OR IGNORE INTO portal_notifications (
      id, recipient_employee_number, event_type, title, message,
      target, entity_type, entity_id, dedupe_key
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.eventType'),
      json_extract($payload, '$.title'),
      json_extract($payload, '$.message'),
      json_extract($payload, '$.target'),
      json_extract($payload, '$.entityType'),
      json_extract($payload, '$.entityId'),
      json_extract($payload, '$.dedupeKey')
    )
  `),
  entry(S.getNotificationByDedupe, `
    SELECT json_object('id', id) AS data
    FROM portal_notifications
    WHERE recipient_employee_number = json_extract($payload, '$.employeeNumber')
      AND dedupe_key = json_extract($payload, '$.dedupeKey')
    LIMIT 1
  `),
  entry(S.reactivateNotification, `
    UPDATE portal_notifications
    SET read_at = NULL, created_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.listHrReviewerRecipients, `
    SELECT json_object('employee_number', u.employee_number) AS data
    FROM portal_users u
    WHERE u.active = 1
      AND TRIM(u.password_hash) <> ''
      AND u.role IN ('hr','admin')
      AND json_extract($payload, '$') IS NOT NULL
    ORDER BY u.employee_number
  `),
  entry(S.listLocalReviewerRecipients, `
    SELECT json_object('employee_number', u.employee_number) AS data
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    WHERE u.active = 1
      AND TRIM(u.password_hash) <> ''
      AND (
        u.role = 'admin'
        OR (
          u.role IN ('manager','department_manager')
          AND (
            EXISTS (
              SELECT 1
              FROM portal_access_scopes scope
              WHERE scope.employee_number = u.employee_number
                AND scope.location_id = json_extract($payload, '$.locationId')
                AND (
                  u.role = 'manager'
                  OR scope.department_id = json_extract($payload, '$.departmentId')
                )
            )
            OR (
              NOT EXISTS (
                SELECT 1
                FROM portal_access_scopes scope
                WHERE scope.employee_number = u.employee_number
              )
              AND e.home_location_id = json_extract($payload, '$.locationId')
              AND (
                u.role = 'manager'
                OR e.preferred_department_id = json_extract($payload, '$.departmentId')
              )
            )
          )
        )
      )
    ORDER BY u.employee_number
  `),
  entry(S.resolveReviewNotifications, `
    UPDATE portal_notifications
    SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE event_type = 'request.review'
      AND dedupe_key LIKE json_extract($payload, '$.pattern')
  `),

  entry(S.getEmployeeSessionByToken, `
    SELECT ${jsonObject(EMPLOYEE_SESSION_FIELDS)}
    FROM portal_sessions s
    JOIN portal_users u ON u.employee_number = s.employee_number
    JOIN employees e ON e.personnel_number = u.employee_number
    LEFT JOIN positions p ON p.id = e.position_id
    LEFT JOIN portal_roles r ON r.id = u.role
    LEFT JOIN amu_local_access_overrides amu ON amu.employee_number = u.employee_number
    WHERE s.token_hash = json_extract($payload, '$.tokenHash')
      AND s.revoked_at IS NULL
      AND s.expires_at > json_extract($payload, '$.now')
      AND u.active = 1
      AND e.active = 1
    LIMIT 1
  `),
  entry(S.touchEmployeeSession, `
    UPDATE portal_sessions
    SET last_seen_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.getOrganizationSessionByToken, `
    SELECT ${jsonObject(ORGANIZATION_SESSION_FIELDS)}
    FROM portal_organization_sessions s
    JOIN portal_organization_accounts account ON account.id = s.account_id
    WHERE s.token_hash = json_extract($payload, '$.tokenHash')
      AND s.revoked_at IS NULL
      AND s.expires_at > json_extract($payload, '$.now')
      AND account.active = 1
    LIMIT 1
  `),
  entry(S.touchOrganizationSession, `
    UPDATE portal_organization_sessions
    SET last_seen_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),

  entry(S.getEmployeeLogin, `
    SELECT json_object(
      'employee_number', u.employee_number,
      'password_hash', u.password_hash,
      'active', u.active,
      'failed_login_attempts', u.failed_login_attempts,
      'locked_until', u.locked_until,
      'employee_active', e.active
    ) AS data
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    WHERE u.employee_number = json_extract($payload, '$.loginName')
    LIMIT 1
  `),
  entry(S.getOrganizationLogin, `
    SELECT json_object(
      'account_id', account.id,
      'employee_number', account.login_name,
      'password_hash', account.password_hash,
      'active', account.active,
      'failed_login_attempts', account.failed_login_attempts,
      'locked_until', account.locked_until,
      'employee_active', 1
    ) AS data
    FROM portal_organization_accounts account
    WHERE account.login_name = json_extract($payload, '$.loginName') COLLATE NOCASE
    LIMIT 1
  `),
  entry(S.updateEmployeeLoginFailure, `
    UPDATE portal_users
    SET failed_login_attempts = json_extract($payload, '$.attempts'),
        locked_until = json_extract($payload, '$.lockedUntil'),
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
  `),
  entry(S.updateOrganizationLoginFailure, `
    UPDATE portal_organization_accounts
    SET failed_login_attempts = json_extract($payload, '$.attempts'),
        locked_until = json_extract($payload, '$.lockedUntil'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.accountId')
  `),
  entry(S.purgeExpiredOrganizationSessions, `
    DELETE FROM portal_organization_sessions
    WHERE (expires_at <= CURRENT_TIMESTAMP OR revoked_at IS NOT NULL)
      AND json_extract($payload, '$') IS NOT NULL
  `),
  entry(S.revokeOrganizationSessionsForAccount, `
    UPDATE portal_organization_sessions
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE account_id = json_extract($payload, '$.accountId')
      AND revoked_at IS NULL
  `),
  entry(S.insertOrganizationSession, `
    INSERT INTO portal_organization_sessions (id, account_id, token_hash, expires_at)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.accountId'),
      json_extract($payload, '$.tokenHash'),
      json_extract($payload, '$.expiresAt')
    )
  `),
  entry(S.markOrganizationLoginSuccess, `
    UPDATE portal_organization_accounts
    SET failed_login_attempts = 0,
        locked_until = NULL,
        last_login_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.accountId')
  `),
  entry(S.purgeExpiredEmployeeSessions, `
    DELETE FROM portal_sessions
    WHERE (expires_at <= CURRENT_TIMESTAMP OR revoked_at IS NOT NULL)
      AND json_extract($payload, '$') IS NOT NULL
  `),
  entry(S.revokeEmployeeSessionsForEmployee, `
    UPDATE portal_sessions
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND revoked_at IS NULL
  `),
  entry(S.insertEmployeeSession, `
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.tokenHash'),
      json_extract($payload, '$.expiresAt')
    )
  `),
  entry(S.markEmployeeLoginSuccess, `
    UPDATE portal_users
    SET failed_login_attempts = 0,
        locked_until = NULL,
        last_login_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
  `),
  entry(S.revokeOrganizationSessionById, `
    UPDATE portal_organization_sessions
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.revokeEmployeeSessionById, `
    UPDATE portal_sessions
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.getActiveHrAccount, `
    SELECT json_object('found', 1) AS data
    FROM portal_users
    WHERE role = 'hr'
      AND active = 1
      AND TRIM(password_hash) <> ''
      AND json_extract($payload, '$') IS NOT NULL
    LIMIT 1
  `),
  entry(S.getConfiguredAdmin, `
    SELECT json_object('found', 1) AS data
    FROM portal_users
    WHERE active = 1
      AND role IN ('developer','it_admin','admin')
      AND TRIM(password_hash) <> ''
      AND json_extract($payload, '$') IS NOT NULL
    LIMIT 1
  `),
  entry(S.listUsbCreatorCandidates, `
    SELECT ${jsonObject({
      employee_number: "u.employee_number",
      role: "u.role",
      full_name: "e.full_name",
      nickname: "e.nickname",
      home_location_id: "e.home_location_id",
      position_name: "p.name",
    })}
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    LEFT JOIN positions p ON p.id = e.position_id
    WHERE u.active = 1
      AND e.active = 1
      AND TRIM(u.password_hash) <> ''
      AND u.role IN ('developer', 'it_admin', 'admin')
      AND json_extract($payload, '$') IS NOT NULL
    ORDER BY CAST(u.employee_number AS INTEGER), u.employee_number
  `),
  entry(S.getUsbCreator, `
    SELECT ${jsonObject({
      employee_number: "u.employee_number",
      password_hash: "u.password_hash",
      role: "u.role",
      personnel_number: "e.personnel_number",
      full_name: "e.full_name",
      nickname: "e.nickname",
      color: "e.color",
      contracted_hours: "e.contracted_hours",
      preferred_day_off: "e.preferred_day_off",
      fixed_workdays: "e.fixed_workdays",
      position_id: "e.position_id",
      time_confirmation_level: "e.time_confirmation_level",
      home_location_id: "e.home_location_id",
      preferred_department_id: "e.preferred_department_id",
      cost_center_id: "e.cost_center_id",
      active: "e.active",
    })}
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    WHERE u.employee_number = json_extract($payload, '$.employeeNumber')
      AND u.active = 1
      AND e.active = 1
    LIMIT 1
  `),
]);

module.exports = {
  SQLITE_PORTAL_ACCESS_CATALOG,
};
