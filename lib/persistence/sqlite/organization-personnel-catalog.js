"use strict";

const {
  ORGANIZATION_PERSONNEL_STATEMENTS: S,
} = require("../statements/organization-personnel");

function entry(statement, sql, returning = false) {
  return Object.freeze({ statement, sql, returning });
}

const SQLITE_ORGANIZATION_PERSONNEL_CATALOG = Object.freeze([
  entry(S.getScheduleNote, `
    SELECT location_id, department_key, week_start, note_text, note_html, font_size,
           bold, italic, underline, updated_at
    FROM schedule_notes
    WHERE location_id = $locationId
      AND department_key = $departmentKey
      AND week_start = $weekStart
  `),
  entry(S.getPersonnelSensitiveRecord, `
    SELECT employee_number, protected_payload, social_security_lookup
    FROM personnel_sensitive_records
    WHERE employee_number = $employeeNumber
  `),
  entry(S.listCostCenterTypes, `
    SELECT cct.*,
      (SELECT COUNT(*) FROM cost_centers c WHERE c.cost_center_type_id = cct.id) AS cost_center_count,
      (SELECT COUNT(*) FROM cost_centers c
       WHERE c.cost_center_type_id = cct.id AND c.active = 1) AS active_cost_center_count,
      (SELECT COUNT(*)
       FROM locations l
       JOIN cost_centers c ON c.id = l.cost_center_id
       WHERE c.cost_center_type_id = cct.id) AS location_count
    FROM cost_center_types cct
    WHERE $includeInactive = 1 OR cct.active = 1
    ORDER BY cct.active DESC, cct.sort_order, cct.name COLLATE NOCASE
  `),
  entry(S.listCostCenterTypePositions, `
    SELECT cctp.cost_center_type_id, p.id, p.name, p.builtin, p.sort_order, p.created_at
    FROM cost_center_type_positions cctp
    JOIN positions p ON p.id = cctp.position_id
    ORDER BY cctp.cost_center_type_id, cctp.sort_order, p.sort_order, p.name COLLATE NOCASE
  `),
  entry(S.listCostCenters, `
    SELECT c.*,
      cct.code AS cost_center_type_code,
      cct.name AS cost_center_type_name,
      cct.is_branch AS cost_center_type_is_branch,
      cct.active AS cost_center_type_active,
      (SELECT COUNT(*) FROM employees e WHERE e.cost_center_id = c.id) AS employee_count,
      (SELECT COUNT(*) FROM employees e
       WHERE e.cost_center_id = c.id AND e.active = 1) AS active_employee_count,
      (SELECT COUNT(*) FROM locations l WHERE l.cost_center_id = c.id) AS location_count,
      (SELECT l.id FROM locations l
       WHERE l.cost_center_id = c.id ORDER BY l.id LIMIT 1) AS location_id,
      (SELECT l.name FROM locations l
       WHERE l.cost_center_id = c.id ORDER BY l.id LIMIT 1) AS location_name
    FROM cost_centers c
    LEFT JOIN cost_center_types cct ON cct.id = c.cost_center_type_id
    WHERE $includeInactive = 1 OR c.active = 1
    ORDER BY c.active DESC, c.sort_order, c.code COLLATE NOCASE
  `),
  entry(S.listPositions, `
    SELECT p.id, p.name, p.builtin, p.sort_order, p.created_at,
           GROUP_CONCAT(cctp.cost_center_type_id, '|') AS cost_center_type_ids
    FROM positions p
    LEFT JOIN cost_center_type_positions cctp ON cctp.position_id = p.id
    GROUP BY p.id, p.name, p.builtin, p.sort_order, p.created_at
    ORDER BY p.builtin DESC, p.sort_order, p.name
  `),
  entry(S.listLocations, `
    SELECT l.id, l.name, l.cost_center_id, c.code AS cost_center_code,
           c.name AS cost_center_name, c.type AS cost_center_type,
           c.cost_center_type_id, cct.name AS cost_center_type_name,
           cct.is_branch AS cost_center_is_branch,
           l.min_staff, l.day_settings_json, l.time_tracking_enabled,
           l.time_tracking_access_mode, l.time_tracking_allowed_networks,
           l.time_tracking_variance_minutes, l.active, l.created_at
    FROM locations l
    LEFT JOIN cost_centers c ON c.id = l.cost_center_id
    LEFT JOIN cost_center_types cct ON cct.id = c.cost_center_type_id
    WHERE $includeInactive = 1 OR l.active = 1
    ORDER BY l.active DESC, l.id
  `),
  entry(S.listDepartments, `
    SELECT id, location_id, name, min_staff, active, sort_order, created_at
    FROM departments
    WHERE $includeInactive = 1 OR active = 1
    ORDER BY location_id, active DESC, sort_order, name
  `),
  entry(S.getPortalAccessProjection, `
    SELECT u.employee_number, u.role, u.role_locked, u.active,
           r.name AS role_name, r.permissions,
           COALESCE(amu.access_mode, 'inherit') AS amu_local_access_mode
    FROM portal_users u
    LEFT JOIN portal_roles r ON r.id = u.role
    LEFT JOIN amu_local_access_overrides amu ON amu.employee_number = u.employee_number
    WHERE u.employee_number = $employeeNumber
  `),
  entry(S.listPortalPermissionGrants, `
    SELECT permission
    FROM portal_permission_grants
    WHERE employee_number = $employeeNumber
    ORDER BY permission
  `),
  entry(S.listPortalPermissionDenials, `
    SELECT permission
    FROM portal_permission_denials
    WHERE employee_number = $employeeNumber
    ORDER BY permission
  `),
  entry(S.listPortalAccessScopes, `
    SELECT location_id, department_id
    FROM portal_access_scopes
    WHERE employee_number = $employeeNumber
    ORDER BY location_id, department_id
  `),
  entry(S.listPortalPermissionScopeGrants, `
    SELECT employee_number, permission, location_id, department_id,
           approved_by, created_at, updated_at
    FROM portal_permission_scope_grants
    WHERE employee_number = $employeeNumber
    ORDER BY permission, location_id, department_id
  `),
  entry(S.listPortalRoles, `
    SELECT id, name, description, builtin, permissions, sort_order
    FROM portal_roles
    ORDER BY sort_order, name, id
  `),
  entry(S.listPortalUsersForAdmin, `
    SELECT e.personnel_number, e.full_name, e.nickname, e.home_location_id,
           e.preferred_department_id, e.active AS employee_active,
           u.role, u.role_locked, u.active, u.must_change_password,
           u.last_login_at, u.failed_login_attempts, u.locked_until,
           CASE WHEN TRIM(COALESCE(u.password_hash, '')) <> '' THEN 1 ELSE 0 END AS password_configured,
           r.name AS role_name, r.permissions AS role_permissions,
           e.time_confirmation_level,
           COALESCE(amu.access_mode, 'inherit') AS amu_local_access_mode,
           COALESCE((
             SELECT json_group_array(json_object(
               'fieldKey', field.field_key,
               'accessLevel', field.access_level
             ))
             FROM personnel_field_permissions field
             WHERE field.role_id = u.role
           ), '[]') AS personnel_field_permissions
    FROM employees e
    LEFT JOIN portal_users u ON u.employee_number = e.personnel_number
    LEFT JOIN portal_roles r ON r.id = u.role
    LEFT JOIN amu_local_access_overrides amu ON amu.employee_number = e.personnel_number
    ORDER BY CAST(e.personnel_number AS INTEGER), e.personnel_number
  `),
  entry(S.portalRoleExists, `
    SELECT 1 AS found
    FROM portal_roles
    WHERE id = $id
    LIMIT 1
  `),
  entry(S.getPortalRoleProjection, `
    SELECT id, name, permissions
    FROM portal_roles
    WHERE id = $id
  `),
  entry(S.getPortalMutationTarget, `
    SELECT employee_number, role, role_locked, active
    FROM portal_users
    WHERE employee_number = $employeeNumber
  `),
  entry(S.getEmployeeScopeProjection, `
    SELECT personnel_number, home_location_id, preferred_department_id
    FROM employees
    WHERE personnel_number = $employeeNumber
  `),
  entry(S.getEmployeeProfileOverviewProjection, `
    SELECT
      employee.personnel_number,
      COALESCE(
        NULLIF(TRIM(employee.full_name), ''),
        NULLIF(TRIM(employee.nickname), ''),
        employee.personnel_number
      ) AS display_name,
      employee.active,
      position.name AS position_name,
      cost_center.code AS cost_center_code,
      cost_center.name AS cost_center_name,
      location.id AS location_id,
      location.name AS location_name,
      department.id AS department_id,
      department.name AS department_name
    FROM employees employee
    LEFT JOIN positions position ON position.id = employee.position_id
    LEFT JOIN cost_centers cost_center ON cost_center.id = employee.cost_center_id
    LEFT JOIN locations location ON location.id = employee.home_location_id
    LEFT JOIN departments department
      ON department.id = employee.preferred_department_id
      AND department.location_id = employee.home_location_id
    WHERE employee.personnel_number = $employeeNumber
  `),
  entry(S.employeeExists, `
    SELECT 1 AS found
    FROM employees
    WHERE personnel_number = $employeeNumber
    LIMIT 1
  `),
  entry(S.getPortalUserAccountProjection, `
    SELECT employee_number, role, role_locked, password_hash, active, must_change_password
    FROM portal_users
    WHERE employee_number = $employeeNumber
  `),
  entry(S.getPortalScopeAssignmentTarget, `
    SELECT u.employee_number, u.role, u.role_locked, u.active, e.home_location_id
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    WHERE u.employee_number = $employeeNumber
  `),
  entry(S.listOrganizationAccounts, `
    SELECT account.id, account.login_name, account.display_name, account.account_type,
           account.password_hash, account.active, account.must_change_password,
           account.last_login_at, account.failed_login_attempts, account.locked_until,
           account.created_at, account.updated_at,
           COALESCE((
             SELECT json_group_array(permission.permission)
             FROM portal_organization_account_permissions permission
             WHERE permission.account_id = account.id
           ), '[]') AS permissions_json,
           COALESCE((
             SELECT json_group_array(json_object(
               'locationId', scope.location_id,
               'departmentId', NULLIF(scope.department_id, 0)
             ))
             FROM portal_organization_account_scopes scope
             WHERE scope.account_id = account.id
           ), '[]') AS scopes_json
    FROM portal_organization_accounts account
    ORDER BY account.active DESC, account.login_name COLLATE NOCASE
  `),
  entry(S.getOrganizationAccount, `
    SELECT account.id, account.login_name, account.display_name, account.account_type,
           account.password_hash, account.active, account.must_change_password,
           account.last_login_at, account.failed_login_attempts, account.locked_until,
           account.created_at, account.updated_at,
           COALESCE((
             SELECT json_group_array(permission.permission)
             FROM portal_organization_account_permissions permission
             WHERE permission.account_id = account.id
           ), '[]') AS permissions_json,
           COALESCE((
             SELECT json_group_array(json_object(
               'locationId', scope.location_id,
               'departmentId', NULLIF(scope.department_id, 0)
             ))
             FROM portal_organization_account_scopes scope
             WHERE scope.account_id = account.id
           ), '[]') AS scopes_json
    FROM portal_organization_accounts account
    WHERE account.id = $accountId
  `),
  entry(S.organizationAccountLoginCollision, `
    SELECT 1 AS found
    FROM (
      SELECT personnel_number AS login_name FROM employees
      UNION ALL
      SELECT employee_number AS login_name FROM portal_users
      UNION ALL
      SELECT login_name FROM portal_organization_accounts
    ) login
    WHERE login.login_name = $loginName COLLATE NOCASE
    LIMIT 1
  `),
  entry(S.listPersonnelFieldPermissions, `
    SELECT field_key, access_level
    FROM personnel_field_permissions
    WHERE role_id = $role
    ORDER BY field_key
  `),
  entry(S.activeDepartmentManagerDelegation, `
    SELECT 1 AS found
    FROM approval_delegations
    WHERE location_id = $locationId
      AND delegate_employee_number = $employeeNumber
      AND active = 1
      AND date_from <= $date
      AND date_to >= $date
    LIMIT 1
  `),
  entry(S.activeLocationManagerPresent, `
    SELECT 1 AS found
    FROM portal_users user
    JOIN employees employee ON employee.personnel_number = user.employee_number
    WHERE user.role = 'manager'
      AND user.active = 1
      AND employee.active = 1
      AND employee.home_location_id = $locationId
      AND NOT EXISTS (
        SELECT 1
        FROM week_options option
        WHERE option.employee_number = user.employee_number
          AND $date BETWEEN option.date_from AND option.date_to
          AND option.option_type IN ('vacation','sick','time_off','branch')
      )
    LIMIT 1
  `),
  entry(S.listApprovalDelegations, `
    SELECT delegation.*, location.name AS location_name,
           employee.full_name, employee.nickname
    FROM approval_delegations delegation
    JOIN locations location ON location.id = delegation.location_id
    JOIN employees employee
      ON employee.personnel_number = delegation.delegate_employee_number
    ORDER BY delegation.active DESC, delegation.date_from DESC, delegation.id DESC
  `),
  entry(S.eligibleDepartmentManagerForLocation, `
    SELECT 1 AS found
    FROM employees employee
    JOIN portal_users user ON user.employee_number = employee.personnel_number
    WHERE employee.personnel_number = $employeeNumber
      AND employee.home_location_id = $locationId
      AND user.role = 'department_manager'
      AND user.active = 1
    LIMIT 1
  `),
  entry(S.upsertScheduleNote, `
    INSERT INTO schedule_notes
      (location_id, department_key, week_start, note_text, note_html, font_size, bold, italic, underline, updated_at)
    VALUES ($locationId, $departmentKey, $weekStart, $noteText, $noteHtml, $fontSize, $bold, $italic, $underline, CURRENT_TIMESTAMP)
    ON CONFLICT(location_id, department_key, week_start)
    DO UPDATE SET
      note_text = excluded.note_text,
      note_html = excluded.note_html,
      font_size = excluded.font_size,
      bold = excluded.bold,
      italic = excluded.italic,
      underline = excluded.underline,
      updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.deleteScheduleNote, `
    DELETE FROM schedule_notes
    WHERE location_id = $locationId
      AND department_key = $departmentKey
      AND week_start = $weekStart
  `),
  entry(S.findCostCenterIdByCode, `
    SELECT id
    FROM cost_centers
    WHERE code = $code COLLATE NOCASE
    LIMIT 1
  `),
  entry(S.costCenterIdExists, `
    SELECT 1 AS found
    FROM cost_centers
    WHERE id = $id
    LIMIT 1
  `),
  entry(S.insertAutomaticBranchCostCenter, `
    INSERT INTO cost_centers
      (id, code, name, type, cost_center_type_id, description, active, sort_order, created_by, updated_by)
    VALUES ($id, $code, $name, 'branch', 'branch', '', 1, $sortOrder, $actor, $actor)
  `),
  entry(S.insertLocation, `
    INSERT INTO locations
      (id, name, cost_center_id, min_staff, day_settings_json, time_tracking_enabled, time_tracking_access_mode,
       time_tracking_allowed_networks, time_tracking_variance_minutes, active)
    VALUES ($id, $name, $costCenterId, $minStaff, $daySettingsJson, $timeTrackingEnabled,
      $timeTrackingAccessMode, $timeTrackingAllowedNetworks, $timeTrackingVarianceMinutes, $active)
  `),
  entry(S.updateLocation, `
    UPDATE locations
    SET name = $name,
        cost_center_id = $costCenterId,
        min_staff = $minStaff,
        day_settings_json = $daySettingsJson,
        time_tracking_enabled = $timeTrackingEnabled,
        time_tracking_access_mode = $timeTrackingAccessMode,
        time_tracking_allowed_networks = $timeTrackingAllowedNetworks,
        time_tracking_variance_minutes = $timeTrackingVarianceMinutes,
        active = $active
    WHERE id = $id
  `),
  entry(S.insertAccessScopeIgnore, `
    INSERT OR IGNORE INTO portal_access_scopes
      (employee_number, location_id, department_id, assigned_by)
    VALUES ($employeeNumber, $locationId, $departmentId, $assignedBy)
  `),
  entry(S.insertAccessScope, `
    INSERT INTO portal_access_scopes
      (employee_number, location_id, department_id, assigned_by)
    VALUES ($employeeNumber, $locationId, $departmentId, $assignedBy)
  `),
  entry(S.nextDepartmentSortOrder, `
    SELECT COALESCE(MAX(sort_order), 0) + 1 AS next
    FROM departments
    WHERE location_id = $locationId
  `),
  entry(S.insertDepartment, `
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES ($locationId, $name, $minStaff, $active, $sortOrder)
    RETURNING id
  `, true),
  entry(S.countDepartmentShifts, `
    SELECT COUNT(*) AS count
    FROM shifts
    WHERE department_id = $id
  `),
  entry(S.updateDepartment, `
    UPDATE departments
    SET location_id = $locationId,
        name = $name,
        min_staff = $minStaff,
        active = $active
    WHERE id = $id
  `),
  entry(S.costCenterAssignments, `
    SELECT
      (SELECT COUNT(*) FROM employees WHERE cost_center_id = $id) AS employees,
      (SELECT COUNT(*) FROM locations WHERE cost_center_id = $id) AS locations
  `),
  entry(S.insertCostCenterType, `
    INSERT INTO cost_center_types
      (id, code, name, description, is_branch, active, builtin, sort_order, created_by, updated_by)
    VALUES ($id, $code, $name, $description, $isBranch, $active, 0, $sortOrder, $actor, $actor)
  `),
  entry(S.getCostCenterType, `
    SELECT
      id, code, name, description, is_branch, active, builtin, sort_order,
      created_by, updated_by, created_at, updated_at
    FROM cost_center_types
    WHERE id = $id
  `),
  entry(S.listCostCenterTypePositionIds, `
    SELECT position_id
    FROM cost_center_type_positions
    WHERE cost_center_type_id = $id
    ORDER BY sort_order, position_id
  `),
  entry(S.updateCostCenterType, `
    UPDATE cost_center_types
    SET name = $name,
        description = $description,
        is_branch = $isBranch,
        active = $active,
        sort_order = $sortOrder,
        updated_by = $actor,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $id
  `),
  entry(S.archiveCostCenterType, `
    UPDATE cost_center_types
    SET active = 0, updated_by = $actor, updated_at = CURRENT_TIMESTAMP
    WHERE id = $id
  `),
  entry(S.deleteCostCenterTypePositions, `
    DELETE FROM cost_center_type_positions
    WHERE cost_center_type_id = $id
  `),
  entry(S.insertCostCenterTypePosition, `
    INSERT INTO cost_center_type_positions
      (cost_center_type_id, position_id, sort_order)
    VALUES ($id, $positionId, $sortOrder)
  `),
  entry(S.insertCostCenter, `
    INSERT INTO cost_centers
      (id, code, name, type, cost_center_type_id, description, active, sort_order, created_by, updated_by)
    VALUES ($id, $code, $name, $type, $costCenterTypeId, $description, $active, $sortOrder, $actor, $actor)
  `),
  entry(S.getCostCenter, `
    SELECT
      id, code, name, type, cost_center_type_id, description, active, sort_order,
      created_by, updated_by, created_at, updated_at
    FROM cost_centers
    WHERE id = $id
  `),
  entry(S.costCenterHasEmployee, `
    SELECT 1 AS found
    FROM employees
    WHERE cost_center_id = $id
    LIMIT 1
  `),
  entry(S.costCenterHasLocation, `
    SELECT 1 AS found
    FROM locations
    WHERE cost_center_id = $id
    LIMIT 1
  `),
  entry(S.updateCostCenter, `
    UPDATE cost_centers
    SET code = $code,
        name = $name,
        type = $type,
        cost_center_type_id = $costCenterTypeId,
        description = $description,
        active = $active,
        sort_order = $sortOrder,
        updated_by = $actor,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $id
  `),
  entry(S.archiveCostCenter, `
    UPDATE cost_centers
    SET active = 0, updated_by = $actor, updated_at = CURRENT_TIMESTAMP
    WHERE id = $id
  `),
  entry(S.listPersonnelDirectory, `
    SELECT
      e.personnel_number,
      e.full_name,
      e.nickname,
      e.color,
      CAST(e.contracted_hours AS TEXT) AS contracted_hours,
      e.target_workdays_per_week,
      e.preferred_day_off,
      e.fixed_workdays,
      e.position_id,
      e.time_confirmation_level,
      e.sickness_without_aum_enabled,
      e.home_location_id,
      e.preferred_department_id,
      e.cost_center_id,
      e.active,
      l.name AS home_location_name,
      d.name AS preferred_department_name,
      p.name AS position_name,
      c.code AS cost_center_code,
      c.name AS cost_center_name,
      c.type AS cost_center_type,
      c.cost_center_type_id,
      cct.name AS cost_center_type_name,
      cct.is_branch AS cost_center_is_branch,
      u.role AS portal_role,
      r.name AS portal_role_name,
      CASE WHEN u.employee_number IS NULL THEN 0 ELSE 1 END AS portal_configured,
      CASE WHEN u.active = 1 THEN 1 ELSE 0 END AS portal_active
    FROM employees e
    LEFT JOIN locations l ON l.id = e.home_location_id
    LEFT JOIN departments d ON d.id = e.preferred_department_id
    LEFT JOIN positions p ON p.id = e.position_id
    LEFT JOIN cost_centers c ON c.id = e.cost_center_id
    LEFT JOIN cost_center_types cct ON cct.id = c.cost_center_type_id
    LEFT JOIN portal_users u ON u.employee_number = e.personnel_number
    LEFT JOIN portal_roles r ON r.id = u.role
    ORDER BY e.active DESC, c.sort_order, c.code COLLATE NOCASE,
      CAST(e.personnel_number AS INTEGER), e.personnel_number
  `),
  entry(S.nextPositionSortOrder, `
    SELECT COALESCE(MAX(sort_order), 0) + 1 AS next
    FROM positions
  `),
  entry(S.insertPosition, `
    INSERT INTO positions (id, name, builtin, sort_order)
    VALUES ($id, $name, 0, $sortOrder)
  `),
  entry(S.getPosition, `
    SELECT id, builtin
    FROM positions
    WHERE id = $id
  `),
  entry(S.updatePosition, `
    UPDATE positions
    SET name = $name
    WHERE id = $id
  `),
  entry(S.countPositionTypeAssignments, `
    SELECT COUNT(*) AS count
    FROM cost_center_type_positions
    WHERE position_id = $id
  `),
  entry(S.reassignEmployeesFromPosition, `
    UPDATE employees
    SET position_id = 'verkaufsmitarbeiter'
    WHERE position_id = $id
  `),
  entry(S.deletePosition, `
    DELETE FROM positions
    WHERE id = $id
  `),
  entry(S.listEmployees, `
    SELECT
      e.personnel_number,
      e.full_name,
      e.nickname,
      e.color,
      CAST(e.contracted_hours AS TEXT) AS contracted_hours,
      e.target_workdays_per_week,
      e.preferred_day_off,
      e.fixed_workdays,
      e.position_id,
      e.time_confirmation_level,
      e.sickness_without_aum_enabled,
      e.home_location_id,
      e.preferred_department_id,
      e.cost_center_id,
      e.active,
      l.name AS home_location_name,
      d.name AS preferred_department_name,
      p.name AS position_name,
      c.code AS cost_center_code,
      c.name AS cost_center_name,
      c.type AS cost_center_type,
      c.cost_center_type_id,
      cct.name AS cost_center_type_name,
      cct.is_branch AS cost_center_is_branch
    FROM employees e
    LEFT JOIN locations l ON l.id = e.home_location_id
    LEFT JOIN departments d ON d.id = e.preferred_department_id
    LEFT JOIN positions p ON p.id = e.position_id
    LEFT JOIN cost_centers c ON c.id = e.cost_center_id
    LEFT JOIN cost_center_types cct ON cct.id = c.cost_center_type_id
    ORDER BY e.active DESC, CAST(e.personnel_number AS INTEGER), e.personnel_number
  `),
  entry(S.insertEmployee, `
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, target_workdays_per_week,
       preferred_day_off, fixed_workdays, position_id, time_confirmation_level, sickness_without_aum_enabled,
       home_location_id, preferred_department_id, cost_center_id, active)
    VALUES ($personnelNumber, $fullName, $nickname, $color, $contractedHours, $targetWorkdaysPerWeek,
      $preferredDayOff, $fixedWorkdays, $positionId, $timeConfirmationLevel, $sicknessWithoutAumEnabled,
      $homeLocationId, $preferredDepartmentId, $costCenterId, $active)
  `),
  entry(S.getEmployeeForUpdate, `
    SELECT
      personnel_number,
      full_name,
      nickname,
      color,
      CAST(contracted_hours AS TEXT) AS contracted_hours,
      time_confirmation_level,
      sickness_without_aum_enabled,
      target_workdays_per_week,
      preferred_day_off,
      fixed_workdays,
      position_id,
      home_location_id,
      preferred_department_id,
      cost_center_id,
      active
    FROM employees
    WHERE personnel_number = $personnelNumber
  `),
  entry(S.updateEmployee, `
    UPDATE employees
    SET full_name = $fullName,
        nickname = $nickname,
        color = $color,
        contracted_hours = $contractedHours,
        target_workdays_per_week = $targetWorkdaysPerWeek,
        preferred_day_off = $preferredDayOff,
        fixed_workdays = $fixedWorkdays,
        position_id = $positionId,
        time_confirmation_level = $timeConfirmationLevel,
        sickness_without_aum_enabled = $sicknessWithoutAumEnabled,
        home_location_id = $homeLocationId,
        preferred_department_id = $preferredDepartmentId,
        cost_center_id = $costCenterId,
        active = $active
    WHERE personnel_number = $personnelNumber
  `),
  entry(S.getEmployeeDisplay, `
    SELECT color, nickname
    FROM employees
    WHERE personnel_number = $personnelNumber
  `),
  entry(S.getEmployeeIdentity, `
    SELECT personnel_number, full_name
    FROM employees
    WHERE personnel_number = $personnelNumber
  `),
  entry(S.updateEmployeeDisplay, `
    UPDATE employees
    SET color = $color, nickname = $nickname
    WHERE personnel_number = $personnelNumber
  `),
  entry(S.getEmployeeActivation, `
    SELECT personnel_number, active
    FROM employees
    WHERE personnel_number = $personnelNumber
  `),
  entry(S.deactivateEmployee, `
    UPDATE employees
    SET active = 0
    WHERE personnel_number = $personnelNumber
  `),
  entry(S.countOtherSystemOwners, `
    SELECT COUNT(*) AS count
    FROM portal_users
    WHERE role IN ('developer', 'admin')
      AND active = 1
      AND employee_number <> $employeeNumber
  `),
  entry(S.upsertPortalUserRole, `
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, updated_at)
    VALUES ($employeeNumber, '', $role, 1, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      role = excluded.role,
      updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.deletePermissionGrants, `
    DELETE FROM portal_permission_grants
    WHERE employee_number = $employeeNumber
  `),
  entry(S.deletePermissionDenials, `
    DELETE FROM portal_permission_denials
    WHERE employee_number = $employeeNumber
  `),
  entry(S.insertPermissionGrant, `
    INSERT INTO portal_permission_grants
      (employee_number, permission, granted_by, updated_at)
    VALUES ($employeeNumber, $permission, $actor, CURRENT_TIMESTAMP)
  `),
  entry(S.deletePermissionGrant, `
    DELETE FROM portal_permission_grants
    WHERE employee_number = $employeeNumber
      AND permission = $permission
  `),
  entry(S.deletePermissionScopeGrants, `
    DELETE FROM portal_permission_scope_grants
    WHERE employee_number = $employeeNumber
      AND permission = $permission
      AND ($all = 1 OR (location_id = $locationId AND department_id = $departmentId))
  `),
  entry(S.insertPermissionScopeGrant, `
    INSERT INTO portal_permission_scope_grants
      (employee_number, permission, location_id, department_id, approved_by, updated_at)
    VALUES (
      $employeeNumber, $permission, $locationId, $departmentId, $approvedBy, CURRENT_TIMESTAMP
    )
  `),
  entry(S.insertPermissionDenial, `
    INSERT INTO portal_permission_denials
      (employee_number, permission, denied_by, updated_at)
    VALUES ($employeeNumber, $permission, $actor, CURRENT_TIMESTAMP)
  `),
  entry(S.deletePermissionDenial, `
    DELETE FROM portal_permission_denials
    WHERE employee_number = $employeeNumber
      AND permission = $permission
  `),
  entry(S.deleteAccessScopes, `
    DELETE FROM portal_access_scopes
    WHERE employee_number = $employeeNumber
      AND ($all = 1 OR (location_id = $locationId AND department_id = $departmentId))
  `),
  entry(S.upsertPortalUserAccount, `
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (
      $employeeNumber, $passwordHash, $role, $active, $mustChangePassword,
      CASE WHEN $passwordChanged = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = excluded.password_hash,
      role = excluded.role,
      active = excluded.active,
      must_change_password = excluded.must_change_password,
      password_changed_at = CASE
        WHEN $passwordChanged = 1 THEN CURRENT_TIMESTAMP
        ELSE portal_users.password_changed_at
      END,
      updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.unlockPortalUser, `
    UPDATE portal_users
    SET failed_login_attempts = 0,
        locked_until = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = $employeeNumber
  `),
  entry(S.updatePortalUserPassword, `
    UPDATE portal_users
    SET password_hash = $passwordHash,
        must_change_password = 0,
        password_changed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = $employeeNumber
  `),
  entry(S.insertOrganizationAccount, `
    INSERT INTO portal_organization_accounts
      (id, login_name, display_name, account_type, password_hash, active,
       must_change_password, password_changed_at, created_by, updated_by)
    VALUES (
      $accountId, $loginName, $displayName, $accountType, $passwordHash, $active,
      $mustChangePassword,
      CASE WHEN $passwordChanged = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
      $actor, $actor
    )
  `),
  entry(S.updateOrganizationAccount, `
    UPDATE portal_organization_accounts
    SET display_name = $displayName,
        account_type = $accountType,
        password_hash = $passwordHash,
        active = $active,
        must_change_password = CASE
          WHEN $passwordChanged = 1 THEN 1
          ELSE must_change_password
        END,
        password_changed_at = CASE
          WHEN $passwordChanged = 1 THEN CURRENT_TIMESTAMP
          ELSE password_changed_at
        END,
        updated_by = $actor,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $accountId
  `),
  entry(S.unlockOrganizationAccount, `
    UPDATE portal_organization_accounts
    SET failed_login_attempts = 0,
        locked_until = NULL,
        updated_by = $actor,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $accountId
  `),
  entry(S.updateOrganizationAccountPassword, `
    UPDATE portal_organization_accounts
    SET password_hash = $passwordHash,
        must_change_password = 0,
        password_changed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $accountId
  `),
  entry(S.deleteOrganizationAccountPermissions, `
    DELETE FROM portal_organization_account_permissions
    WHERE account_id = $accountId
  `),
  entry(S.insertOrganizationAccountPermission, `
    INSERT INTO portal_organization_account_permissions
      (account_id, permission, granted_by, updated_at)
    VALUES ($accountId, $permission, $actor, CURRENT_TIMESTAMP)
  `),
  entry(S.deleteOrganizationAccountScopes, `
    DELETE FROM portal_organization_account_scopes
    WHERE account_id = $accountId
  `),
  entry(S.insertOrganizationAccountScope, `
    INSERT INTO portal_organization_account_scopes
      (account_id, location_id, department_id, assigned_by)
    VALUES ($accountId, $locationId, 0, $actor)
  `),
  entry(S.revokeOrganizationSessions, `
    UPDATE portal_organization_sessions
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE account_id = $accountId
      AND revoked_at IS NULL
  `),
  entry(S.deletePersonnelFieldPermissions, `
    DELETE FROM personnel_field_permissions
    WHERE role_id = $role
  `),
  entry(S.insertPersonnelFieldPermission, `
    INSERT INTO personnel_field_permissions
      (role_id, field_key, access_level, updated_by, updated_at)
    VALUES ($role, $fieldKey, $accessLevel, $actor, CURRENT_TIMESTAMP)
  `),
  entry(S.upsertManagerAmuDefault, `
    INSERT INTO portal_settings (key, value, updated_at)
    VALUES (
      'amu_manager_file_access',
      CASE WHEN $enabled = 1 THEN '1' ELSE '0' END,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.deleteManagerAmuOverrides, `
    DELETE FROM amu_local_access_overrides
  `),
  entry(S.insertManagerAmuOverride, `
    INSERT INTO amu_local_access_overrides
      (employee_number, access_mode, updated_by, updated_at)
    VALUES ($employeeNumber, $accessMode, $actor, CURRENT_TIMESTAMP)
  `),
  entry(S.insertApprovalDelegation, `
    INSERT INTO approval_delegations
      (location_id, delegate_employee_number, date_from, date_to, note, created_by)
    VALUES ($locationId, $employeeNumber, $dateFrom, $dateTo, $note, $actor)
  `),
  entry(S.deleteApprovalDelegation, `
    DELETE FROM approval_delegations
    WHERE id = $id
  `),
  entry(S.disablePortalUser, `
    UPDATE portal_users
    SET active = 0, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = $employeeNumber
  `),
  entry(S.revokePortalSessions, `
    UPDATE portal_sessions
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE employee_number = $employeeNumber
      AND revoked_at IS NULL
  `),
  entry(S.revokeMobileSessions, `
    UPDATE mobile_sessions
    SET revoked_at = CURRENT_TIMESTAMP,
        revoked_reason = $reason,
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = $employeeNumber
      AND revoked_at IS NULL
  `),
  entry(S.upsertPersonnelSensitiveRecord, `
    INSERT INTO personnel_sensitive_records
      (employee_number, social_security_lookup, protected_payload, updated_by, updated_at)
    VALUES ($employeeNumber, $socialSecurityLookup, $protectedPayload, $actor, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      social_security_lookup = excluded.social_security_lookup,
      protected_payload = excluded.protected_payload,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.insertAudit, `
    INSERT INTO audit_log (actor, action, entity_type, entity_id, detail)
    VALUES ($actor, $action, $entityType, $entityId, $detail)
  `),
]);

module.exports = {
  SQLITE_ORGANIZATION_PERSONNEL_CATALOG,
};
