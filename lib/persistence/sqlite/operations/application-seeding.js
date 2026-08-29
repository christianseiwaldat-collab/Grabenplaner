"use strict";

const fs = require("node:fs");

function createSqliteApplicationSeedingOperations(database) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  const db = database;

  function seedApplicationDefaults({
    defaultSettings,
    planningDays,
    builtinPortalRoles,
  } = {}) {
    if (!defaultSettings || typeof defaultSettings !== "object") {
      throw new TypeError("defaultSettings wird benoetigt.");
    }
    if (!Array.isArray(planningDays) || !Array.isArray(builtinPortalRoles)) {
      throw new TypeError("Planungstage und Portalrollen werden benoetigt.");
    }

const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
for (const [key, value] of Object.entries(defaultSettings)) insertSetting.run(key, value);

function legacyDaySettingsSnapshot() {
  const stored = Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
  return Object.fromEntries(planningDays.map(([day]) => [day, {
    open: stored[`${day}_open`] !== "0",
    start: stored[`${day}_start_time`], end: stored[`${day}_end_time`],
    lunchEnabled: stored[`${day}_lunch_enabled`] === "1",
    lunchStart: stored[`${day}_lunch_start`], lunchEnd: stored[`${day}_lunch_end`],
    minStaff: Number(stored[`${day}_min_staff`] || 0),
    minFrom: stored[`${day}_min_from`], minTo: stored[`${day}_min_to`],
  }]));
}
db.prepare("UPDATE locations SET day_settings_json = ? WHERE TRIM(COALESCE(day_settings_json, '')) = ''")
  .run(JSON.stringify(legacyDaySettingsSnapshot()));

const builtinPositions = [
  ["teamleitung", "Teamleitung", 1],
  ["abteilungsleitung", "Abteilungsleitung", 2],
  ["verkaufsmitarbeiter", "Verkaufsmitarbeiter", 3],
  ["lehrling", "Lehrling", 4],
];
const insertPosition = db.prepare(`
  INSERT OR IGNORE INTO positions
    (id, name, builtin, active, is_default, employment_classification, sort_order, created_by, updated_by)
  VALUES (?, ?, 0, 1, ?, ?, ?, 'seed', 'seed')
`);
for (const [id, name, order] of builtinPositions) {
  insertPosition.run(id, name, id === "verkaufsmitarbeiter" ? 1 : 0, id === "lehrling" ? "apprentice" : "standard", order);
}
db.prepare("UPDATE employees SET position_id = 'verkaufsmitarbeiter' WHERE position_id IS NULL OR position_id = ''").run();

const upsertPortalRole = db.prepare(`
  INSERT INTO portal_roles (id, name, description, builtin, permissions, sort_order, updated_at)
  VALUES (?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    builtin = 1,
    permissions = excluded.permissions,
    sort_order = excluded.sort_order,
    updated_at = CURRENT_TIMESTAMP
`);
for (const role of builtinPortalRoles) {
  upsertPortalRole.run(role.id, role.name, role.description, JSON.stringify(role.permissions), role.sortOrder);
}
db.prepare("UPDATE portal_users SET role_locked = 1 WHERE role = 'developer'").run();
db.prepare(`
  DELETE FROM portal_permission_grants
  WHERE permission IN (
    'amu:metadata:read','amu:file:read','amu:review','amu:delete','amu:audit'
  )
    AND EXISTS (
      SELECT 1 FROM portal_users u
      WHERE u.employee_number = portal_permission_grants.employee_number
        AND u.role NOT IN ('hr','admin','it_admin','developer')
    )
`).run();
db.prepare(`
  DELETE FROM portal_permission_grants
  WHERE permission IN ('personnel:sensitive:read','personnel:sensitive:write')
    AND EXISTS (
      SELECT 1 FROM portal_users u
      WHERE u.employee_number = portal_permission_grants.employee_number
        AND u.role NOT IN ('location_planner','department_manager','manager','hr','admin','it_admin','developer')
    )
`).run();
db.exec("BEGIN");
try {
  db.prepare(`
    DELETE FROM portal_permission_grants
    WHERE permission = 'employees:write'
      AND EXISTS (
        SELECT 1 FROM portal_permission_grants newer
        WHERE newer.employee_number = portal_permission_grants.employee_number
          AND newer.permission = 'employees:display:write'
      )
  `).run();
  db.prepare("UPDATE portal_permission_grants SET permission = 'employees:display:write', updated_at = CURRENT_TIMESTAMP WHERE permission = 'employees:write'").run();
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

    return Object.freeze({
      legacyDaySettingsSnapshot,
    });
  }

  function seedDemoIfRequested({
    enabled = false,
    demoProfile = "",
    appVersion,
    planningDays,
    sporthandelProfilePath,
  } = {}) {
    if (!Array.isArray(planningDays)) {
      throw new TypeError("Planungstage werden benoetigt.");
    }
    const packageMetadata = { version: String(appVersion || "") };
    const process = {
      env: {
        GRABENPLANER_SEED_DEMO: enabled ? "1" : "0",
        GRABENPLANER_DEMO_PROFILE: String(demoProfile || ""),
      },
    };

const seedEmployees = [
  ["101", "Alex Demo", "Alex", "#0b84c6"],
  ["102", "Bea Demo", "Bea", "#e26500"],
  ["103", "Cem Demo", "Cem", "#07a67a"],
  ["104", "Dana Demo", "Dana", "#c873a5"],
  ["105", "Erik Demo", "Erik", "#7651b5"],
  ["106", "Fina Demo", "Fina", "#c58b00"],
];

function demoLocationDaySettings(location) {
  return Object.fromEntries(planningDays.map(([day]) => {
    const saturday = day === "saturday";
    const start = saturday ? location.saturdayStart : location.weekdayStart;
    const end = saturday ? location.saturdayEnd : location.weekdayEnd;
    return [day, {
      open: true,
      start,
      end,
      lunchEnabled: false,
      lunchStart: "13:00",
      lunchEnd: "14:00",
      minStaff: Number(location.minStaff || 0),
      minFrom: start,
      minTo: end,
    }];
  }));
}

function loadSporthandelDemoProfile() {
  const profilePath = sporthandelProfilePath;
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8").replace(/^\uFEFF/, ""));
  if (profile?.format !== "grabenplaner-demo-profile" || profile?.id !== "sporthandel"
    || !Array.isArray(profile.locations) || !Array.isArray(profile.employees)) {
    throw new Error("Das Sporthandel-Demoprofil ist ungueltig.");
  }
  const salesCount = profile.employees.filter((employee) => employee.category === "sales").length;
  if (profile.locations.length !== 6 || salesCount !== 31) {
    throw new Error("Das Sporthandel-Demoprofil muss sechs Filialen und 31 Verkaufsmitarbeitende enthalten.");
  }
  return profile;
}

function seedSporthandelDemo() {
  const profile = loadSporthandelDemoProfile();
  const insertCostCenter = db.prepare(`
    INSERT OR IGNORE INTO cost_centers
      (id, code, name, type, cost_center_type_id, description, active, sort_order, created_by, updated_by)
    VALUES (?, ?, ?, 'branch', 'branch', 'Demodaten', 1, ?, 'demo-profile', 'demo-profile')
  `);
  const insertLocation = db.prepare(`
    INSERT INTO locations
      (id, name, cost_center_id, min_staff, day_settings_json, time_tracking_enabled, time_tracking_access_mode,
       time_tracking_allowed_networks, time_tracking_variance_minutes, active)
    VALUES (?, ?, ?, ?, ?, 1, 'anywhere', '', 15, 1)
  `);
  const insertDepartment = db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, ?, ?, 1, ?)
  `);
  const insertEmployee = db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, position_id,
       time_confirmation_level, home_location_id, preferred_department_id, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const insertBranding = db.prepare(`
    INSERT INTO location_branding
      (location_id, kit_id, company_name, logo_url, icon_url, logo_alt, admin_email, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'demo-profile')
  `);
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM location_branding").run();
    db.prepare("DELETE FROM departments").run();
    db.prepare("DELETE FROM locations").run();

    const departmentIds = new Map();
    for (const location of profile.locations) {
      const costCenterCode = `FIL${String(location.id).toUpperCase()}`;
      insertCostCenter.run(`cc-location-${location.id}`, costCenterCode, location.name, 100 + (Number(location.id) || 0));
      const costCenterId = db.prepare("SELECT id FROM cost_centers WHERE code = ? COLLATE NOCASE").get(costCenterCode)?.id;
      insertLocation.run(location.id, location.name, costCenterId, Number(location.minStaff || 0), JSON.stringify(demoLocationDaySettings(location)));
      for (const [index, departmentName] of location.departments.entries()) {
        const result = insertDepartment.run(location.id, departmentName, 1, index + 1);
        departmentIds.set(`${location.id}:${departmentName}`, Number(result.lastInsertRowid));
      }
      insertBranding.run(
        location.id,
        profile.branding.kitId,
        profile.companyName,
        profile.branding.logoUrl,
        profile.branding.iconUrl,
        profile.branding.logoAlt,
        profile.branding.adminEmail || "",
      );
    }

    for (const employee of profile.employees) {
      const departmentId = departmentIds.get(`${employee.locationId}:${employee.department}`) || null;
      insertEmployee.run(
        employee.personnelNumber,
        employee.fullName,
        employee.nickname,
        employee.color,
        Number(employee.contractedHours || 38.5),
        employee.positionId || "verkaufsmitarbeiter",
        ["A", "B", "C"].includes(employee.confirmationLevel) ? employee.confirmationLevel : "C",
        employee.locationId,
        departmentId,
      );
    }

    const managementBranding = {
      branding_management_kit_id: profile.branding.kitId,
      branding_company_name: profile.companyName,
      branding_logo_url: profile.branding.logoUrl,
      branding_icon_url: profile.branding.iconUrl,
      branding_logo_alt: profile.branding.logoAlt,
      branding_admin_email: profile.branding.adminEmail || "",
    };
    for (const [key, value] of Object.entries(managementBranding)) upsertSetting.run(key, value);
    db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES ('demo-profile-sporthandel-v1', ?)")
      .run(packageMetadata.version);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

if (process.env.GRABENPLANER_SEED_DEMO === "1" && db.prepare("SELECT COUNT(*) AS count FROM employees").get().count === 0) {
  if (String(process.env.GRABENPLANER_DEMO_PROFILE || "").trim().toLowerCase() === "sporthandel") {
    seedSporthandelDemo();
  } else {
    const seedLocationId = db.prepare("SELECT id FROM locations ORDER BY active DESC, id LIMIT 1").get()?.id || "01";
    const insertEmployee = db.prepare(`
      INSERT INTO employees
        (personnel_number, full_name, nickname, color, contracted_hours, home_location_id, active)
      VALUES (?, ?, ?, ?, 38.5, ?, 1)
    `);
    for (const employee of seedEmployees) insertEmployee.run(...employee, seedLocationId);
  }
}
  }

  return Object.freeze({
    seedApplicationDefaults,
    seedDemoIfRequested,
  });
}

module.exports = {
  createSqliteApplicationSeedingOperations,
};
