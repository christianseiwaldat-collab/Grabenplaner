"use strict";

const { DatabaseSync } = require("node:sqlite");

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdentifier(value) {
  const identifier = String(value || "");
  if (!IDENTIFIER.test(identifier)) throw new Error(`Ungültiger SQLite-Bezeichner: ${identifier}`);
  return `"${identifier}"`;
}

function tableExists(database, tableName) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function rows(database, tableName, where = "", parameters = []) {
  if (!tableExists(database, tableName)) return [];
  return database.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}${where ? ` ${where}` : ""}`).all(...parameters);
}

function insertRows(database, tableName, records) {
  if (!records.length || !tableExists(database, tableName)) return;
  const available = new Set(database.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map((column) => column.name));
  const columns = Object.keys(records[0]).filter((column) => available.has(column));
  if (!columns.length) return;
  const statement = database.prepare(`INSERT OR REPLACE INTO ${quoteIdentifier(tableName)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
  for (const record of records) statement.run(...columns.map((column) => record[column]));
}

function snapshotKeyValues(database, tableName) {
  return new Map(rows(database, tableName).map((row) => [String(row.key), String(row.value)]));
}

function upsertKeyValues(database, tableName, entries) {
  if (!tableExists(database, tableName)) return;
  const statement = database.prepare(`INSERT INTO ${quoteIdentifier(tableName)} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const [key, value] of entries) statement.run(String(key), String(value));
}

function resetTargetDatabase(database) {
  const preservedMigrations = rows(database, "schema_migrations");
  const preservedRoles = rows(database, "portal_roles");
  const defaultSettings = snapshotKeyValues(database, "settings");
  const defaultPortalSettings = snapshotKeyValues(database, "portal_settings");
  const tableNames = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);

  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const tableName of tableNames) database.exec(`DELETE FROM ${quoteIdentifier(tableName)}`);
    if (tableExists(database, "sqlite_sequence")) database.exec("DELETE FROM sqlite_sequence");
    insertRows(database, "schema_migrations", preservedMigrations);
    insertRows(database, "portal_roles", preservedRoles);
    upsertKeyValues(database, "settings", defaultSettings);
    upsertKeyValues(database, "portal_settings", defaultPortalSettings);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function sourceRowsForLocations(source, tableName, locationIds) {
  if (!locationIds.length || !tableExists(source, tableName)) return [];
  const placeholders = locationIds.map(() => "?").join(",");
  return rows(source, tableName, `WHERE location_id IN (${placeholders})`, locationIds);
}

function normalizeEmployeeRecord(record) {
  return {
    personnel_number: String(record.personnelNumber || record.personnel_number || "").trim(),
    full_name: String(record.fullName || record.full_name || "").trim(),
    nickname: String(record.nickname || "").trim(),
    color: String(record.color || "#0b84c6").trim().toLowerCase(),
    contracted_hours: Number(record.contractedHours ?? record.contracted_hours ?? 38.5),
    preferred_day_off: record.preferredDayOff ?? record.preferred_day_off ?? null,
    fixed_workdays: String(record.fixedWorkdays ?? record.fixed_workdays ?? ""),
    position_id: String(record.positionId ?? record.position_id ?? "verkaufsmitarbeiter"),
    time_confirmation_level: String(record.timeConfirmationLevel ?? record.time_confirmation_level ?? "C"),
    home_location_id: String(record.homeLocationId ?? record.home_location_id ?? "").trim() || null,
    preferred_department_id: Number(record.preferredDepartmentId ?? record.preferred_department_id ?? 0) || null,
    active: record.active === false || Number(record.active) === 0 ? 0 : 1,
  };
}

function populateUsbProfileDatabase({
  sourceDatabase,
  targetDatabasePath,
  selectedLocationIds,
  employees,
  creator,
  primaryBranding,
  enabledFeatures,
  permissionCatalog = [],
}) {
  if (!sourceDatabase) throw new Error("Die Quelldatenbank fehlt.");
  const locations = [...new Set((selectedLocationIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!locations.length) throw new Error("Mindestens ein Standort muss ausgewählt sein.");

  const target = new DatabaseSync(targetDatabasePath);
  try {
    resetTargetDatabase(target);
    const placeholders = locations.map(() => "?").join(",");
    const locationRows = rows(sourceDatabase, "locations", `WHERE id IN (${placeholders})`, locations);
    if (locationRows.length !== locations.length) throw new Error("Mindestens ein ausgewählter Standort wurde nicht gefunden.");
    const departmentRows = sourceRowsForLocations(sourceDatabase, "departments", locations);
    const validDepartmentIds = new Set(departmentRows.map((row) => Number(row.id)));
    const positionRows = rows(sourceDatabase, "positions");
    const creatorNumber = String(creator.personnelNumber);

    target.exec("PRAGMA foreign_keys = OFF");
    target.exec("BEGIN IMMEDIATE");
    try {
      insertRows(target, "positions", positionRows);
      insertRows(target, "locations", locationRows);
      insertRows(target, "departments", departmentRows);

      const sourceSettings = snapshotKeyValues(sourceDatabase, "settings");
      const safeSettings = [...sourceSettings.entries()].filter(([key]) => ![
        "operation_mode",
        "branding_management_kit_id",
        "branding_company_name",
        "branding_logo_url",
        "branding_icon_url",
        "branding_logo_alt",
        "branding_admin_email",
        "installation_features",
        "backup_directory",
      ].includes(key));
      upsertKeyValues(target, "settings", safeSettings);
      upsertKeyValues(target, "settings", new Map([
        ["operation_mode", "local"],
        ["installation_features", JSON.stringify([...new Set(enabledFeatures || [])])],
        ["external_backup_enabled", "1"],
        ["backup_directory", "%GRABENPLANER_ROOT%\\Backups"],
        ["branding_management_kit_id", primaryBranding.kitId],
        ["branding_company_name", primaryBranding.companyName || ""],
        ["branding_logo_url", primaryBranding.logoUrl || "/assets/grabenplaner-logo.svg"],
        ["branding_icon_url", primaryBranding.iconUrl || "/assets/webicon.svg"],
        ["branding_logo_alt", primaryBranding.logoAlt || "Grabenplaner"],
        ["branding_admin_email", primaryBranding.adminEmail || ""],
      ]));

      const pdfRows = sourceRowsForLocations(sourceDatabase, "pdf_settings", locations);
      insertRows(target, "pdf_settings", pdfRows);
      for (const location of locationRows) {
        insertRows(target, "location_branding", [{
          location_id: location.id,
          kit_id: primaryBranding.kitId,
          company_name: primaryBranding.companyName || "",
          logo_url: primaryBranding.logoUrl || "/assets/grabenplaner-logo.svg",
          icon_url: primaryBranding.iconUrl || "/assets/webicon.svg",
          logo_alt: primaryBranding.logoAlt || "Grabenplaner",
          admin_email: primaryBranding.adminEmail || "",
          updated_by: creator.personnelNumber,
        }]);
      }

      const normalizedEmployees = employees.map(normalizeEmployeeRecord);
      if (!normalizedEmployees.some((employee) => employee.personnel_number === creatorNumber)) {
        normalizedEmployees.unshift(normalizeEmployeeRecord(creator.employee));
      }
      const uniqueEmployees = [...new Map(normalizedEmployees.map((employee) => [employee.personnel_number, employee])).values()];
      for (const employee of uniqueEmployees) {
        if (!employee.personnel_number || !employee.full_name || !employee.nickname) throw new Error("Ein Teammitglied hat unvollständige Stammdaten.");
        if (!locations.includes(employee.home_location_id)) employee.home_location_id = locations[0];
        if (!validDepartmentIds.has(Number(employee.preferred_department_id))) employee.preferred_department_id = null;
      }
      insertRows(target, "employees", uniqueEmployees);

      const knownPermissions = new Set(permissionCatalog);
      const employeeInput = new Map(employees.map((employee) => [String(employee.personnelNumber || employee.personnel_number), employee]));
      for (const employee of uniqueEmployees) {
        const input = employeeInput.get(employee.personnel_number) || {};
        const isCreator = employee.personnel_number === creatorNumber;
        const role = isCreator ? "admin" : String(input.role || "employee");
        if (role === "department_manager" && !validDepartmentIds.has(Number(employee.preferred_department_id))) {
          throw new Error(`Für die Abteilungsleitung ${employee.personnel_number} fehlt eine gültige Abteilung.`);
        }
        const passwordHash = isCreator ? creator.passwordHash : String(input.passwordHash || "");
        const accountActive = Boolean(passwordHash);
        insertRows(target, "portal_users", [{
          employee_number: employee.personnel_number,
          password_hash: passwordHash,
          role,
          role_locked: 0,
          active: accountActive ? 1 : 0,
          must_change_password: isCreator ? 0 : (accountActive ? 1 : 0),
          failed_login_attempts: 0,
          locked_until: null,
        }]);
        if (!isCreator) {
          const grants = [...new Set(input.additionalPermissions || [])].filter((permission) => knownPermissions.has(permission));
          insertRows(target, "portal_permission_grants", grants.map((permission) => ({
            employee_number: employee.personnel_number,
            permission,
            granted_by: creatorNumber,
          })));
          if (["manager", "department_manager"].includes(role)) {
            insertRows(target, "portal_access_scopes", [{
              employee_number: employee.personnel_number,
              location_id: employee.home_location_id,
              department_id: role === "department_manager" ? Number(employee.preferred_department_id) : 0,
              assigned_by: creatorNumber,
            }]);
          }
        }
      }
      target.exec("COMMIT");
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    } finally {
      target.exec("PRAGMA foreign_keys = ON");
    }
    const integrity = target.prepare("PRAGMA quick_check").get();
    if (String(Object.values(integrity || {})[0] || "").toLowerCase() !== "ok") throw new Error("Die vorbereitete Datenbank hat die Integritätsprüfung nicht bestanden.");
    return {
      locations: locationRows.length,
      departments: departmentRows.length,
      employees: new Set(employees.map((employee) => String(employee.personnelNumber || employee.personnel_number)).concat(String(creator.personnelNumber))).size,
      creator: creatorNumber,
    };
  } finally {
    target.close();
  }
}

module.exports = {
  insertRows,
  populateUsbProfileDatabase,
  quoteIdentifier,
  resetTargetDatabase,
};
