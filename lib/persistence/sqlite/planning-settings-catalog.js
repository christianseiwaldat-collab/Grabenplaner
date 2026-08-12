"use strict";

const {
  PLANNING_SETTINGS_STATEMENTS: S,
} = require("../statements/planning-settings");

function entry(statement, sql, returning = false) {
  return Object.freeze({ statement, sql, returning });
}

function jsonObject(fields) {
  return `json_object(${Object.entries(fields)
    .flatMap(([name, expression]) => [`'${name}'`, expression])
    .join(", ")}) AS data`;
}

const EMPLOYEE_FIELDS = Object.freeze({
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
  home_location_name: "location.name",
  preferred_department_name: "department.name",
  position_name: "position.name",
});

const EMPLOYEE_JOINS = `
  FROM employees e
  LEFT JOIN locations location ON location.id = e.home_location_id
  LEFT JOIN departments department ON department.id = e.preferred_department_id
  LEFT JOIN positions position ON position.id = e.position_id
`;

const SQLITE_PLANNING_SETTINGS_CATALOG = Object.freeze([
  entry(S.listSettings, `
    SELECT ${jsonObject({ key: "key", value: "value" })}
    FROM settings
    ORDER BY key
  `),
  entry(S.upsertSetting, `
    INSERT INTO settings (key, value)
    VALUES (
      json_extract($payload, '$.key'),
      json_extract($payload, '$.value')
    )
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  entry(S.listPortalSettings, `
    SELECT ${jsonObject({ key: "key", value: "value" })}
    FROM portal_settings
    ORDER BY key
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
  entry(S.listPdfSettings, `
    SELECT ${jsonObject({
      scope_type: "scope_type",
      location_id: "location_id",
      department_key: "department_key",
      key: "key",
      value: "value",
      updated_at: "updated_at",
    })}
    FROM pdf_settings
    ORDER BY scope_type, location_id, department_key, key
  `),
  entry(S.upsertPdfSetting, `
    INSERT INTO pdf_settings
      (scope_type, location_id, department_key, key, value, updated_at)
    VALUES (
      json_extract($payload, '$.scopeType'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.departmentKey'),
      json_extract($payload, '$.key'),
      json_extract($payload, '$.value'),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(scope_type, location_id, department_key, key)
    DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.listLocationBranding, `
    SELECT ${jsonObject({
      location_id: "location_id",
      kit_id: "kit_id",
      company_name: "company_name",
      logo_url: "logo_url",
      icon_url: "icon_url",
      logo_alt: "logo_alt",
      admin_email: "admin_email",
      updated_by: "updated_by",
      updated_at: "updated_at",
    })}
    FROM location_branding
    ORDER BY location_id
  `),
  entry(S.upsertLocationBranding, `
    INSERT INTO location_branding
      (location_id, kit_id, company_name, logo_url, icon_url, logo_alt,
       admin_email, updated_by, updated_at)
    VALUES (
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.kitId'),
      json_extract($payload, '$.companyName'),
      json_extract($payload, '$.logoUrl'),
      json_extract($payload, '$.iconUrl'),
      json_extract($payload, '$.logoAlt'),
      json_extract($payload, '$.adminEmail'),
      json_extract($payload, '$.updatedBy'),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(location_id) DO UPDATE SET
      kit_id = excluded.kit_id,
      company_name = excluded.company_name,
      logo_url = excluded.logo_url,
      icon_url = excluded.icon_url,
      logo_alt = excluded.logo_alt,
      admin_email = excluded.admin_email,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.deleteLocationBranding, `
    DELETE FROM location_branding
    WHERE location_id = json_extract($payload, '$.locationId')
  `),
  entry(S.listGlobalDayBlocks, `
    SELECT ${jsonObject({
      id: "id",
      location_id: "location_id",
      week_start: "week_start",
      block_date: "block_date",
      reason: "reason",
      is_public_holiday: "is_public_holiday",
      created_at: "created_at",
    })}
    FROM global_day_blocks
    ORDER BY block_date, location_id, id
  `),

  entry(S.listMobileScheduleShifts, `
    SELECT ${jsonObject({
      id: "s.id",
      shift_date: "s.shift_date",
      start_time: "s.start_time",
      end_time: "s.end_time",
      area: "s.area",
      note: "s.note",
      location_id: "s.location_id",
      department_id: "s.department_id",
      location_name: "location.name",
      department_name: "department.name",
    })}
    FROM shifts s
    LEFT JOIN locations location ON location.id = s.location_id
    LEFT JOIN departments department ON department.id = s.department_id
    WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
      AND s.shift_date BETWEEN json_extract($payload, '$.weekStart')
        AND json_extract($payload, '$.weekEnd')
    ORDER BY s.shift_date, s.start_time, s.id
  `),
  entry(S.listMobileScheduleOptions, `
    SELECT ${jsonObject({
      id: "id",
      date_from: "date_from",
      date_to: "date_to",
      option_type: "option_type",
      note: "note",
      all_day: "all_day",
      start_time: "start_time",
      end_time: "end_time",
    })}
    FROM week_options
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND date_from <= json_extract($payload, '$.weekEnd')
      AND date_to >= json_extract($payload, '$.weekStart')
    ORDER BY date_from, id
  `),
  entry(S.listLocationDashboardScheduleShifts, `
    SELECT ${jsonObject({
      shift_date: "shift.shift_date",
      start_time: "shift.start_time",
      end_time: "shift.end_time",
      area: "shift.area",
      full_name: "employee.full_name",
      nickname: "employee.nickname",
      department_name: "department.name",
    })}
    FROM shifts shift
    JOIN employees employee ON employee.personnel_number = shift.employee_number
    LEFT JOIN departments department ON department.id = shift.department_id
    WHERE shift.location_id = json_extract($payload, '$.locationId')
      AND shift.shift_date BETWEEN json_extract($payload, '$.weekStart')
        AND json_extract($payload, '$.weekEnd')
      AND employee.active = 1
    ORDER BY shift.shift_date, shift.start_time,
      COALESCE(NULLIF(employee.nickname, ''), employee.full_name)
  `),
  entry(S.listLocationDashboardVacations, `
    SELECT ${jsonObject({
      date_from: "week_option.date_from",
      date_to: "week_option.date_to",
      employee_name: "COALESCE(NULLIF(employee.nickname, ''), employee.full_name)",
    })}
    FROM week_options week_option
    JOIN employees employee ON employee.personnel_number = week_option.employee_number
    WHERE employee.home_location_id = json_extract($payload, '$.locationId')
      AND employee.active = 1
      AND week_option.option_type = 'vacation'
      AND week_option.date_from <= json_extract($payload, '$.weekEnd')
      AND week_option.date_to >= json_extract($payload, '$.weekStart')
    ORDER BY week_option.date_from,
      COALESCE(NULLIF(employee.nickname, ''), employee.full_name),
      week_option.date_to, week_option.id
  `),

  entry(S.listWeekOptionsForEmployeeDate, `
    SELECT ${jsonObject({
      id: "o.id",
      employee_number: "o.employee_number",
      group_id: "o.group_id",
      week_start: "o.week_start",
      date_from: "o.date_from",
      date_to: "o.date_to",
      option_type: "o.option_type",
      note: "o.note",
      credited_minutes_per_day: "o.credited_minutes_per_day",
      all_day: "o.all_day",
      start_time: "o.start_time",
      end_time: "o.end_time",
      nickname: "e.nickname",
    })}
    FROM week_options o
    JOIN employees e ON e.personnel_number = o.employee_number
    WHERE o.employee_number = json_extract($payload, '$.employeeNumber')
      AND json_extract($payload, '$.date') BETWEEN o.date_from AND o.date_to
    ORDER BY o.all_day DESC, o.start_time
  `),
  entry(S.getPlanningEmployee, `
    SELECT ${jsonObject(EMPLOYEE_FIELDS)}
    ${EMPLOYEE_JOINS}
    WHERE e.personnel_number = json_extract($payload, '$.employeeNumber')
  `),
  entry(S.getOtherLocationShift, `
    SELECT ${jsonObject({
      id: "s.id",
      start_time: "s.start_time",
      end_time: "s.end_time",
      location_id: "s.location_id",
      location_name: "location.name",
    })}
    FROM shifts s
    LEFT JOIN locations location ON location.id = s.location_id
    WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
      AND s.shift_date = json_extract($payload, '$.shiftDate')
      AND s.id <> json_extract($payload, '$.existingId')
      AND s.location_id <> json_extract($payload, '$.locationId')
    LIMIT 1
  `),
  entry(S.getOverlappingShift, `
    SELECT ${jsonObject({
      id: "s.id",
      start_time: "s.start_time",
      end_time: "s.end_time",
      location_id: "s.location_id",
      location_name: "location.name",
    })}
    FROM shifts s
    LEFT JOIN locations location ON location.id = s.location_id
    WHERE s.employee_number = json_extract($payload, '$.employeeNumber')
      AND s.shift_date = json_extract($payload, '$.shiftDate')
      AND s.id <> json_extract($payload, '$.existingId')
      AND s.start_time < json_extract($payload, '$.endTime')
      AND json_extract($payload, '$.startTime') < s.end_time
    LIMIT 1
  `),
  entry(S.listOverlappingWeekOptions, `
    SELECT ${jsonObject({
      id: "id",
      all_day: "all_day",
      start_time: "start_time",
      end_time: "end_time",
    })}
    FROM week_options
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND date_from <= json_extract($payload, '$.dateTo')
      AND date_to >= json_extract($payload, '$.dateFrom')
      AND id <> json_extract($payload, '$.existingId')
  `),
  entry(S.listShiftConflictsForRange, `
    SELECT ${jsonObject({
      shift_date: "shift_date",
      start_time: "start_time",
      end_time: "end_time",
    })}
    FROM shifts
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND shift_date BETWEEN json_extract($payload, '$.dateFrom')
        AND json_extract($payload, '$.dateTo')
    ORDER BY shift_date, start_time, id
  `),
  entry(S.listSaturdayServiceShifts, `
    SELECT ${jsonObject({
      employee_number: "s.employee_number",
      shift_date: "s.shift_date",
      start_time: "s.start_time",
      end_time: "s.end_time",
    })}
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number
    WHERE e.active = 1
      AND s.location_id = json_extract($payload, '$.locationId')
      AND (
        json_extract($payload, '$.departmentId') IS NULL
        OR s.department_id = json_extract($payload, '$.departmentId')
      )
      AND s.shift_date <= json_extract($payload, '$.endDate')
    ORDER BY s.shift_date, s.employee_number, s.id
  `),
  entry(S.listWorkRuleShiftsForRange, `
    SELECT ${jsonObject({
      id: "id",
      employee_number: "employee_number",
      location_id: "location_id",
      department_id: "department_id",
      shift_date: "shift_date",
      start_time: "start_time",
      end_time: "end_time",
    })}
    FROM shifts
    WHERE shift_date BETWEEN json_extract($payload, '$.dateFrom')
      AND json_extract($payload, '$.dateTo')
    ORDER BY employee_number, shift_date, start_time, id
  `),
  entry(S.getActivePlanningEmployee, `
    SELECT ${jsonObject({
      personnel_number: "personnel_number",
      full_name: "full_name",
      nickname: "nickname",
      home_location_id: "home_location_id",
      preferred_department_id: "preferred_department_id",
      position_id: "position_id",
    })}
    FROM employees
    WHERE personnel_number = json_extract($payload, '$.employeeNumber')
      AND active = 1
  `),

  entry(S.listScheduleEmployees, `
    SELECT ${jsonObject(EMPLOYEE_FIELDS)}
    ${EMPLOYEE_JOINS}
    WHERE e.active = 1
      AND (
        (
          json_extract($payload, '$.departmentId') IS NULL
          AND (
            e.home_location_id = json_extract($payload, '$.locationId')
            OR EXISTS (
              SELECT 1
              FROM shifts assigned
              WHERE assigned.employee_number = e.personnel_number
                AND assigned.location_id = json_extract($payload, '$.locationId')
                AND assigned.shift_date BETWEEN json_extract($payload, '$.weekStart')
                  AND json_extract($payload, '$.weekEnd')
            )
            OR EXISTS (
              SELECT 1
              FROM employee_location_lendings lending
              WHERE lending.employee_number = e.personnel_number
                AND lending.status = 'active'
                AND lending.destination_location_id = json_extract($payload, '$.locationId')
                AND lending.date_from <= json_extract($payload, '$.weekEnd')
                AND lending.date_to >= json_extract($payload, '$.weekStart')
            )
          )
        )
        OR (
          json_extract($payload, '$.departmentId') IS NOT NULL
          AND (
            (
              e.home_location_id = json_extract($payload, '$.locationId')
              AND e.preferred_department_id = json_extract($payload, '$.departmentId')
            )
            OR EXISTS (
              SELECT 1
              FROM shifts assigned
              WHERE assigned.employee_number = e.personnel_number
                AND assigned.location_id = json_extract($payload, '$.locationId')
                AND assigned.shift_date BETWEEN json_extract($payload, '$.weekStart')
                  AND json_extract($payload, '$.weekEnd')
                AND assigned.department_id = json_extract($payload, '$.departmentId')
            )
            OR EXISTS (
              SELECT 1
              FROM employee_location_lendings lending
              WHERE lending.employee_number = e.personnel_number
                AND lending.status = 'active'
                AND lending.destination_location_id = json_extract($payload, '$.locationId')
                AND lending.destination_department_id = json_extract($payload, '$.departmentId')
                AND lending.date_from <= json_extract($payload, '$.weekEnd')
                AND lending.date_to >= json_extract($payload, '$.weekStart')
            )
          )
        )
      )
    ORDER BY CAST(e.personnel_number AS INTEGER), e.personnel_number
  `),
  entry(S.listScheduleShifts, `
    SELECT ${jsonObject({
      id: "s.id",
      employee_number: "s.employee_number",
      location_id: "s.location_id",
      department_id: "s.department_id",
      shift_date: "s.shift_date",
      start_time: "s.start_time",
      end_time: "s.end_time",
      area: "s.area",
      note: "s.note",
      full_name: "e.full_name",
      nickname: "e.nickname",
      color: "e.color",
      department_name: "department.name",
    })}
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number
    LEFT JOIN departments department ON department.id = s.department_id
    WHERE s.shift_date BETWEEN json_extract($payload, '$.weekStart')
      AND json_extract($payload, '$.weekEnd')
      AND s.location_id = json_extract($payload, '$.locationId')
      AND (
        json_extract($payload, '$.departmentId') IS NULL
        OR s.department_id = json_extract($payload, '$.departmentId')
      )
    ORDER BY s.shift_date, s.start_time,
      CAST(s.employee_number AS INTEGER), s.employee_number
  `),
  entry(S.listScheduleWeekOptions, `
    SELECT ${jsonObject({
      id: "o.id",
      group_id: "o.group_id",
      employee_number: "o.employee_number",
      week_start: "o.week_start",
      date_from: "o.date_from",
      date_to: "o.date_to",
      option_type: "o.option_type",
      note: "o.note",
      credited_minutes_per_day: "o.credited_minutes_per_day",
      all_day: "o.all_day",
      start_time: "o.start_time",
      end_time: "o.end_time",
      nickname: "e.nickname",
      color: "e.color",
      contracted_hours: "e.contracted_hours",
    })}
    FROM week_options o
    JOIN employees e ON e.personnel_number = o.employee_number
    WHERE o.date_from <= json_extract($payload, '$.weekEnd')
      AND o.date_to >= json_extract($payload, '$.weekStart')
      AND e.active = 1
      AND (
        (
          json_extract($payload, '$.departmentId') IS NULL
          AND (
            e.home_location_id = json_extract($payload, '$.locationId')
            OR EXISTS (
              SELECT 1 FROM shifts assigned
              WHERE assigned.employee_number = e.personnel_number
                AND assigned.location_id = json_extract($payload, '$.locationId')
                AND assigned.shift_date BETWEEN json_extract($payload, '$.weekStart')
                  AND json_extract($payload, '$.weekEnd')
                AND assigned.shift_date BETWEEN o.date_from AND o.date_to
                AND (
                  COALESCE(o.all_day, 1) = 1
                  OR (
                    assigned.start_time < o.end_time
                    AND assigned.end_time > o.start_time
                  )
                )
            )
            OR EXISTS (
              SELECT 1 FROM employee_location_lendings lending
              WHERE lending.employee_number = e.personnel_number
                AND lending.status = 'active'
                AND lending.destination_location_id = json_extract($payload, '$.locationId')
                AND lending.date_from <= json_extract($payload, '$.weekEnd')
                AND lending.date_to >= json_extract($payload, '$.weekStart')
                AND lending.date_from <= o.date_to
                AND lending.date_to >= o.date_from
                AND (
                  COALESCE(lending.all_day, 1) = 1
                  OR COALESCE(o.all_day, 1) = 1
                  OR (
                    lending.start_time < o.end_time
                    AND lending.end_time > o.start_time
                  )
                )
            )
          )
        )
        OR (
          json_extract($payload, '$.departmentId') IS NOT NULL
          AND (
            (
              e.home_location_id = json_extract($payload, '$.locationId')
              AND e.preferred_department_id = json_extract($payload, '$.departmentId')
            )
            OR EXISTS (
              SELECT 1 FROM shifts assigned
              WHERE assigned.employee_number = e.personnel_number
                AND assigned.location_id = json_extract($payload, '$.locationId')
                AND assigned.shift_date BETWEEN json_extract($payload, '$.weekStart')
                  AND json_extract($payload, '$.weekEnd')
                AND assigned.department_id = json_extract($payload, '$.departmentId')
                AND assigned.shift_date BETWEEN o.date_from AND o.date_to
                AND (
                  COALESCE(o.all_day, 1) = 1
                  OR (
                    assigned.start_time < o.end_time
                    AND assigned.end_time > o.start_time
                  )
                )
            )
            OR EXISTS (
              SELECT 1 FROM employee_location_lendings lending
              WHERE lending.employee_number = e.personnel_number
                AND lending.status = 'active'
                AND lending.destination_location_id = json_extract($payload, '$.locationId')
                AND lending.destination_department_id = json_extract($payload, '$.departmentId')
                AND lending.date_from <= json_extract($payload, '$.weekEnd')
                AND lending.date_to >= json_extract($payload, '$.weekStart')
                AND lending.date_from <= o.date_to
                AND lending.date_to >= o.date_from
                AND (
                  COALESCE(lending.all_day, 1) = 1
                  OR COALESCE(o.all_day, 1) = 1
                  OR (
                    lending.start_time < o.end_time
                    AND lending.end_time > o.start_time
                  )
                )
            )
          )
        )
      )
    ORDER BY CAST(o.employee_number AS INTEGER), o.employee_number, o.date_from, o.id
  `),
  entry(S.listScheduleLendings, `
    SELECT ${jsonObject({
      id: "lending.id",
      employee_number: "lending.employee_number",
      employee_name: "employee.full_name",
      employee_nickname: "employee.nickname",
      home_location_id: "lending.home_location_id",
      home_location_name: "home_location.name",
      destination_location_id: "lending.destination_location_id",
      destination_location_name: "destination_location.name",
      destination_department_id: "lending.destination_department_id",
      destination_department_name: "destination_department.name",
      date_from: "lending.date_from",
      date_to: "lending.date_to",
      all_day: "lending.all_day",
      start_time: "lending.start_time",
      end_time: "lending.end_time",
    })}
    FROM employee_location_lendings lending
    JOIN employees employee ON employee.personnel_number = lending.employee_number
    JOIN locations home_location ON home_location.id = lending.home_location_id
    JOIN locations destination_location ON destination_location.id = lending.destination_location_id
    LEFT JOIN departments destination_department
      ON destination_department.id = lending.destination_department_id
    WHERE lending.status = 'active'
      AND lending.date_from <= json_extract($payload, '$.weekEnd')
      AND lending.date_to >= json_extract($payload, '$.weekStart')
      AND (
        lending.home_location_id = json_extract($payload, '$.locationId')
        OR lending.destination_location_id = json_extract($payload, '$.locationId')
      )
      AND (
        json_extract($payload, '$.departmentId') IS NULL
        OR (
          lending.destination_location_id = json_extract($payload, '$.locationId')
          AND lending.destination_department_id = json_extract($payload, '$.departmentId')
        )
        OR (
          lending.home_location_id = json_extract($payload, '$.locationId')
          AND employee.preferred_department_id = json_extract($payload, '$.departmentId')
        )
      )
    ORDER BY lending.date_from, lending.start_time, lending.employee_number, lending.id
  `),
  entry(S.listVacationEmployees, `
    SELECT ${jsonObject(EMPLOYEE_FIELDS)}
    ${EMPLOYEE_JOINS}
    WHERE e.active = 1
      AND e.home_location_id = json_extract($payload, '$.locationId')
      AND (
        json_extract($payload, '$.departmentId') IS NULL
        OR e.preferred_department_id = json_extract($payload, '$.departmentId')
      )
    ORDER BY CAST(e.personnel_number AS INTEGER), e.personnel_number
  `),
  entry(S.listVacationEntitlements, `
    SELECT ${jsonObject({
      employee_number: "employee_number",
      days: "days",
    })}
    FROM vacation_entitlements
    WHERE year = json_extract($payload, '$.year')
    ORDER BY employee_number
  `),
  entry(S.listVacationOptions, `
    SELECT ${jsonObject({
      id: "o.id",
      group_id: "o.group_id",
      employee_number: "o.employee_number",
      week_start: "o.week_start",
      date_from: "o.date_from",
      date_to: "o.date_to",
      option_type: "o.option_type",
      note: "o.note",
      credited_minutes_per_day: "o.credited_minutes_per_day",
      all_day: "o.all_day",
      start_time: "o.start_time",
      end_time: "o.end_time",
      nickname: "e.nickname",
      full_name: "e.full_name",
      color: "e.color",
    })}
    FROM week_options o
    JOIN employees e ON e.personnel_number = o.employee_number
    WHERE o.option_type = 'vacation'
      AND o.date_from <= json_extract($payload, '$.yearEnd')
      AND o.date_to >= json_extract($payload, '$.yearStart')
      AND e.home_location_id = json_extract($payload, '$.locationId')
      AND (
        json_extract($payload, '$.departmentId') IS NULL
        OR e.preferred_department_id = json_extract($payload, '$.departmentId')
      )
    ORDER BY o.date_from, CAST(o.employee_number AS INTEGER), o.employee_number, o.id
  `),
  entry(S.listCentralVacationEmployees, `
    SELECT ${jsonObject({
      ...EMPLOYEE_FIELDS,
      cost_center_code: "cost_center.code",
      cost_center_name: "cost_center.name",
      cost_center_type: "cost_center.type",
    })}
    ${EMPLOYEE_JOINS}
    LEFT JOIN cost_centers cost_center ON cost_center.id = e.cost_center_id
    WHERE (
        json_extract($payload, '$.includeInactive') = 1
        OR e.active = 1
      )
      AND (
        json_extract($payload, '$.costCenterId') = ''
        OR e.cost_center_id = json_extract($payload, '$.costCenterId')
      )
      AND (
        json_extract($payload, '$.locationId') = ''
        OR e.home_location_id = json_extract($payload, '$.locationId')
      )
      AND (
        json_extract($payload, '$.departmentId') IS NULL
        OR e.preferred_department_id = json_extract($payload, '$.departmentId')
      )
    ORDER BY cost_center.sort_order, cost_center.code COLLATE NOCASE,
      CAST(e.personnel_number AS INTEGER), e.personnel_number
  `),
  entry(S.listCentralVacationOptions, `
    SELECT ${jsonObject({
      id: "id",
      group_id: "group_id",
      employee_number: "employee_number",
      date_from: "date_from",
      date_to: "date_to",
      note: "note",
    })}
    FROM week_options
    WHERE option_type = 'vacation'
      AND date_from <= json_extract($payload, '$.yearEnd')
      AND date_to >= json_extract($payload, '$.yearStart')
    ORDER BY date_from, CAST(employee_number AS INTEGER), employee_number, id
  `),
  entry(S.countShiftsForDateLocation, `
    SELECT ${jsonObject({ count: "COUNT(*)" })}
    FROM shifts
    WHERE shift_date = json_extract($payload, '$.date')
      AND location_id = json_extract($payload, '$.locationId')
  `),

  entry(S.listDashboardLocations, `
    SELECT ${jsonObject({
      id: "id",
      name: "name",
      min_staff: "min_staff",
    })}
    FROM locations
    WHERE active = 1
    ORDER BY id COLLATE NOCASE, name COLLATE NOCASE
  `),
  entry(S.listDashboardDepartments, `
    SELECT ${jsonObject({
      id: "id",
      location_id: "location_id",
      name: "name",
      min_staff: "min_staff",
    })}
    FROM departments
    WHERE active = 1
    ORDER BY location_id COLLATE NOCASE, sort_order, name COLLATE NOCASE
  `),
  entry(S.listDashboardTeamCounts, `
    SELECT ${jsonObject({
      location_id: "home_location_id",
      count: "COUNT(*)",
    })}
    FROM employees
    WHERE active = 1 AND home_location_id IS NOT NULL
    GROUP BY home_location_id
    ORDER BY home_location_id
  `),
  entry(S.listDashboardScheduledCounts, `
    SELECT ${jsonObject({
      location_id: "s.location_id",
      count: "COUNT(DISTINCT s.employee_number)",
    })}
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number AND e.active = 1
    WHERE s.shift_date = json_extract($payload, '$.date')
    GROUP BY s.location_id
    ORDER BY s.location_id
  `),
  entry(S.listDashboardOptions, `
    SELECT ${jsonObject({
      id: "o.id",
      employee_number: "o.employee_number",
      option_type: "o.option_type",
      all_day: "o.all_day",
      start_time: "o.start_time",
      end_time: "o.end_time",
      full_name: "e.full_name",
      nickname: "e.nickname",
      color: "e.color",
      home_location_id: "e.home_location_id",
      department_name: "department.name",
    })}
    FROM week_options o
    JOIN employees e ON e.personnel_number = o.employee_number AND e.active = 1
    LEFT JOIN departments department ON department.id = e.preferred_department_id
    WHERE o.date_from <= json_extract($payload, '$.date')
      AND o.date_to >= json_extract($payload, '$.date')
      AND e.home_location_id IS NOT NULL
    ORDER BY e.home_location_id COLLATE NOCASE,
      e.personnel_number COLLATE NOCASE, o.id
  `),
  entry(S.getProcessDashboardCounts, `
    SELECT ${jsonObject({
      active_delegations: "(SELECT COUNT(*) FROM approval_delegations WHERE active = 1)",
      payroll_targets: `(SELECT COUNT(*) FROM integration_connections
        WHERE kind = 'payroll_https_target' AND active = 1
          AND TRIM(COALESCE(protected_credentials, '')) <> '')`,
      payroll_profiles: `(SELECT COUNT(*) FROM integration_profiles
        WHERE direction = 'export' AND kind = 'payroll' AND active = 1)`,
    })}
  `),

  entry(S.getShiftById, `
    SELECT ${jsonObject({
      id: "id",
      employee_number: "employee_number",
      location_id: "location_id",
      shift_date: "shift_date",
      department_id: "department_id",
    })}
    FROM shifts
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.insertWeekOption, `
    INSERT INTO week_options
      (employee_number, group_id, week_start, date_from, date_to, option_type,
       note, credited_minutes_per_day, all_day, start_time, end_time)
    VALUES (
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.groupId'),
      json_extract($payload, '$.weekStart'),
      json_extract($payload, '$.dateFrom'),
      json_extract($payload, '$.dateTo'),
      json_extract($payload, '$.optionType'),
      json_extract($payload, '$.note'),
      json_extract($payload, '$.creditedMinutesPerDay'),
      json_extract($payload, '$.allDay'),
      json_extract($payload, '$.startTime'),
      json_extract($payload, '$.endTime')
    )
    RETURNING ${jsonObject({ id: "id" })}
  `, true),
  entry(S.getWeekOptionById, `
    SELECT ${jsonObject({
      id: "id",
      group_id: "group_id",
      week_start: "week_start",
      employee_number: "employee_number",
      date_from: "date_from",
      date_to: "date_to",
      option_type: "option_type",
      note: "note",
      credited_minutes_per_day: "credited_minutes_per_day",
      all_day: "all_day",
      start_time: "start_time",
      end_time: "end_time",
    })}
    FROM week_options
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.updateWeekOption, `
    UPDATE week_options
    SET employee_number = json_extract($payload, '$.employeeNumber'),
        group_id = json_extract($payload, '$.groupId'),
        week_start = json_extract($payload, '$.weekStart'),
        date_from = json_extract($payload, '$.dateFrom'),
        date_to = json_extract($payload, '$.dateTo'),
        option_type = json_extract($payload, '$.optionType'),
        note = json_extract($payload, '$.note'),
        credited_minutes_per_day = json_extract($payload, '$.creditedMinutesPerDay'),
        all_day = json_extract($payload, '$.allDay'),
        start_time = json_extract($payload, '$.startTime'),
        end_time = json_extract($payload, '$.endTime')
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.deleteWeekOption, `
    DELETE FROM week_options
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.insertGlobalDayBlock, `
    INSERT INTO global_day_blocks
      (location_id, week_start, block_date, reason, is_public_holiday)
    VALUES (
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.weekStart'),
      json_extract($payload, '$.blockDate'),
      json_extract($payload, '$.reason'),
      json_extract($payload, '$.isPublicHoliday')
    )
    RETURNING ${jsonObject({ id: "id" })}
  `, true),
  entry(S.getGlobalDayBlockById, `
    SELECT ${jsonObject({
      id: "id",
      week_start: "week_start",
      location_id: "location_id",
      block_date: "block_date",
      reason: "reason",
      is_public_holiday: "is_public_holiday",
    })}
    FROM global_day_blocks
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.updateGlobalDayBlock, `
    UPDATE global_day_blocks
    SET location_id = json_extract($payload, '$.locationId'),
        week_start = json_extract($payload, '$.weekStart'),
        block_date = json_extract($payload, '$.blockDate'),
        reason = json_extract($payload, '$.reason'),
        is_public_holiday = json_extract($payload, '$.isPublicHoliday')
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.deleteGlobalDayBlock, `
    DELETE FROM global_day_blocks
    WHERE id = json_extract($payload, '$.id')
  `),

  entry(S.listAutoPlanningEmployees, `
    SELECT ${jsonObject({
      personnel_number: "e.personnel_number",
      contracted_hours: "e.contracted_hours",
      preferred_day_off: "e.preferred_day_off",
      fixed_workdays: "e.fixed_workdays",
      home_location_id: "e.home_location_id",
      preferred_department_id: "e.preferred_department_id",
    })}
    FROM employees e
    WHERE e.active = 1
      AND (
        (
          e.home_location_id = json_extract($payload, '$.locationId')
          AND (
            json_extract($payload, '$.departmentId') IS NULL
            OR e.preferred_department_id = json_extract($payload, '$.departmentId')
          )
        )
        OR EXISTS (
          SELECT 1
          FROM employee_location_lendings assignment
          WHERE assignment.employee_number = e.personnel_number
            AND assignment.status = 'active'
            AND assignment.destination_location_id = json_extract($payload, '$.locationId')
            AND assignment.date_from <= json_extract($payload, '$.weekEnd')
            AND assignment.date_to >= json_extract($payload, '$.weekStart')
            AND (
              json_extract($payload, '$.departmentId') IS NULL
              OR assignment.destination_department_id = json_extract($payload, '$.departmentId')
            )
        )
      )
    ORDER BY CAST(e.personnel_number AS INTEGER), e.personnel_number
  `),
  entry(S.listAutoPlanningShifts, `
    SELECT ${jsonObject({
      employee_number: "employee_number",
      location_id: "location_id",
      department_id: "department_id",
      shift_date: "shift_date",
      start_time: "start_time",
      end_time: "end_time",
    })}
    FROM shifts
    WHERE shift_date BETWEEN json_extract($payload, '$.weekStart')
      AND json_extract($payload, '$.weekEnd')
      AND location_id = json_extract($payload, '$.locationId')
      AND (
        json_extract($payload, '$.departmentId') IS NULL
        OR department_id = json_extract($payload, '$.departmentId')
      )
    ORDER BY shift_date, start_time, employee_number
  `),
  entry(S.listAutoPlanningEmployeeShifts, `
    SELECT ${jsonObject({
      employee_number: "shift.employee_number",
      location_id: "shift.location_id",
      department_id: "shift.department_id",
      shift_date: "shift.shift_date",
      start_time: "shift.start_time",
      end_time: "shift.end_time",
    })}
    FROM shifts shift
    JOIN employees employee ON employee.personnel_number = shift.employee_number
    WHERE shift.shift_date BETWEEN json_extract($payload, '$.weekStart')
      AND json_extract($payload, '$.weekEnd')
      AND employee.active = 1
      AND (
        (
          employee.home_location_id = json_extract($payload, '$.locationId')
          AND (
            json_extract($payload, '$.departmentId') IS NULL
            OR employee.preferred_department_id = json_extract($payload, '$.departmentId')
          )
        )
        OR EXISTS (
          SELECT 1
          FROM employee_location_lendings assignment
          WHERE assignment.employee_number = employee.personnel_number
            AND assignment.status = 'active'
            AND assignment.destination_location_id = json_extract($payload, '$.locationId')
            AND assignment.date_from <= json_extract($payload, '$.weekEnd')
            AND assignment.date_to >= json_extract($payload, '$.weekStart')
            AND (
              json_extract($payload, '$.departmentId') IS NULL
              OR assignment.destination_department_id = json_extract($payload, '$.departmentId')
            )
        )
      )
    ORDER BY shift.shift_date, shift.start_time, shift.employee_number
  `),
  entry(S.listAutoPlanningOptions, `
    SELECT ${jsonObject({
      employee_number: "o.employee_number",
      date_from: "o.date_from",
      date_to: "o.date_to",
      option_type: "o.option_type",
      credited_minutes_per_day: "o.credited_minutes_per_day",
      all_day: "o.all_day",
      start_time: "o.start_time",
      end_time: "o.end_time",
      contracted_hours: "e.contracted_hours",
    })}
    FROM week_options o
    JOIN employees e ON e.personnel_number = o.employee_number
    WHERE o.date_from <= json_extract($payload, '$.weekEnd')
      AND o.date_to >= json_extract($payload, '$.weekStart')
      AND (
        (
          e.home_location_id = json_extract($payload, '$.locationId')
          AND (
            json_extract($payload, '$.departmentId') IS NULL
            OR e.preferred_department_id = json_extract($payload, '$.departmentId')
          )
        )
        OR EXISTS (
          SELECT 1
          FROM employee_location_lendings assignment
          WHERE assignment.employee_number = e.personnel_number
            AND assignment.status = 'active'
            AND assignment.destination_location_id = json_extract($payload, '$.locationId')
            AND assignment.date_from <= json_extract($payload, '$.weekEnd')
            AND assignment.date_to >= json_extract($payload, '$.weekStart')
            AND (
              json_extract($payload, '$.departmentId') IS NULL
              OR assignment.destination_department_id = json_extract($payload, '$.departmentId')
            )
        )
      )
    ORDER BY o.employee_number, o.date_from, o.id
  `),
]);

module.exports = {
  SQLITE_PLANNING_SETTINGS_CATALOG,
};
