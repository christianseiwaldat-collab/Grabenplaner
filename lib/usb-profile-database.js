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

function customProcessDashboardSnapshot(process, stepRows, scopeLabel) {
  const scopeType = String(process.scope_type || "company");
  const scope = {
    type: scopeType,
    locationId: scopeType === "company" ? null : String(process.location_id || "") || null,
    departmentId: scopeType === "department" ? Number(process.department_id || 0) || null : null,
    label: scopeLabel,
    valid: true,
  };
  const steps = stepRows.map((step) => {
    let notificationChannels = [];
    try {
      const parsed = JSON.parse(step.notification_channels || "[]");
      if (Array.isArray(parsed)) notificationChannels = parsed.filter((channel) => ["internal", "email", "sms"].includes(channel));
    } catch {}
    const conditionType = String(step.condition_type || "always");
    const conditionText = String(step.condition_text || "");
    const conditionLabel = conditionType === "always"
      ? "Immer"
      : conditionType === "when"
        ? `Wenn: ${conditionText}`
        : conditionText ? `Optional: ${conditionText}` : "Optionaler Schritt";
    return {
      id: step.id,
      type: step.step_type,
      title: step.title,
      description: step.description || "",
      responsibilityType: step.responsibility_type,
      responsibilityReference: step.responsibility_reference,
      responsibilityLabel: step.responsibility_label,
      conditionType,
      conditionText,
      notificationChannels,
      actor: step.responsibility_label || "Grabenplaner",
      state: conditionType === "always" ? "active" : "conditional",
      setting: conditionLabel,
      permissions: [],
    };
  });
  const notifications = steps.reduce((sum, step) => sum + step.notificationChannels.length, 0);
  const triggerType = String(process.trigger_type || "manual");
  const minimumShortfall = Number(process.trigger_minimum_shortfall || 1);
  const triggerLabel = triggerType === "staffing_shortfall"
    ? `Notbesetzung ab ${minimumShortfall} fehlender Person(en)`
    : "Manuell durch PL+";
  return {
    id: process.id,
    source: "custom",
    revision: Number(process.revision || 1),
    status: process.status,
    statusLabel: process.status === "active" ? "Ablauf aktiv" : process.status === "draft" ? "Entwurf" : "Archiviert",
    enabled: process.status === "active",
    symbol: process.symbol || "P",
    title: process.title,
    description: process.description || "",
    summary: process.description || "",
    locationSensitive: false,
    scope,
    trigger: { type: triggerType, minimumShortfall, label: triggerLabel },
    rules: [
      { label: "Geltungsbereich", value: scopeLabel, tone: "neutral" },
      { label: "Auslöser", value: triggerLabel, tone: triggerType === "staffing_shortfall" ? "attention" : "neutral" },
      { label: "Benachrichtigungen", value: String(notifications), tone: notifications ? "positive" : "neutral" },
      { label: "Status", value: process.status === "active" ? "Aktiv" : process.status === "draft" ? "Entwurf" : "Archiviert", tone: process.status === "active" ? "positive" : "neutral" },
    ],
    simulations: [{ id: "current", label: "Gespeicherter Ablauf", description: "Die Vorschau verändert keine gespeicherten Daten.", stepStates: {} }],
    steps,
    createdAt: process.created_at || null,
    updatedAt: process.updated_at || null,
  };
}

function sourceRowsForCustomProcesses(source, target, locationIds, departmentIds, selectedEmployees) {
  const requiredTables = ["custom_processes", "custom_process_steps"];
  if (requiredTables.some((tableName) => !tableExists(source, tableName) || !tableExists(target, tableName))) {
    return { processes: [], steps: [], revisions: [] };
  }
  const selectedLocations = new Set(locationIds.map(String));
  const selectedDepartments = new Set([...departmentIds].map(Number));
  const selectedEmployeeLabels = new Map((selectedEmployees || []).map((employee) => {
    const personnelNumber = String(employee.personnel_number || "").trim();
    return [personnelNumber, String(employee.full_name || employee.nickname || personnelNumber).trim()];
  }).filter(([personnelNumber]) => personnelNumber));
  const selectedEmployeeNumbers = new Set(selectedEmployeeLabels.keys());
  const roleLabels = new Map(rows(target, "portal_roles").map((role) => [String(role.id || "").trim(), String(role.name || role.id || "").trim()]));
  const scopedProcesses = rows(source, "custom_processes", "WHERE status = 'active'").filter((process) => {
    if (process.scope_type === "company") return true;
    if (process.scope_type === "location") return selectedLocations.has(String(process.location_id || ""));
    if (process.scope_type === "department") return selectedDepartments.has(Number(process.department_id));
    return false;
  });
  if (!scopedProcesses.length) return { processes: [], steps: [], revisions: [] };
  const processIds = scopedProcesses.map((process) => String(process.id));
  const placeholders = processIds.map(() => "?").join(",");
  const sourceSteps = rows(source, "custom_process_steps", `WHERE process_id IN (${placeholders}) ORDER BY process_id, sort_order, id`, processIds);
  const stepsByProcess = new Map();
  for (const step of sourceSteps) {
    const processId = String(step.process_id || "");
    if (!stepsByProcess.has(processId)) stepsByProcess.set(processId, []);
    stepsByProcess.get(processId).push(step);
  }

  const processes = [];
  const steps = [];
  const revisions = [];
  const locationNames = new Map(rows(source, "locations").map((location) => [String(location.id), String(location.name || location.id)]));
  const departmentScopes = new Map(rows(source, "departments").map((department) => [Number(department.id), {
    name: String(department.name || department.id),
    locationId: String(department.location_id || ""),
  }]));
  for (const process of scopedProcesses) {
    const processId = String(process.id || "");
    const sanitizedSteps = [];
    let resolvable = true;
    for (const step of stepsByProcess.get(processId) || []) {
      const responsibilityType = String(step.responsibility_type || "system").trim();
      if (responsibilityType === "employee") {
        const personnelNumber = String(step.responsibility_reference || "").trim();
        if (!selectedEmployeeNumbers.has(personnelNumber)) {
          resolvable = false;
          break;
        }
        sanitizedSteps.push({
          ...step,
          responsibility_type: "employee",
          responsibility_reference: personnelNumber,
          responsibility_label: selectedEmployeeLabels.get(personnelNumber),
        });
      } else if (responsibilityType === "role") {
        const roleId = String(step.responsibility_reference || "").trim();
        if (!roleLabels.has(roleId)) {
          resolvable = false;
          break;
        }
        sanitizedSteps.push({
          ...step,
          responsibility_type: "role",
          responsibility_reference: roleId,
          responsibility_label: roleLabels.get(roleId),
        });
      } else if (responsibilityType === "system") {
        sanitizedSteps.push({
          ...step,
          responsibility_type: "system",
          responsibility_reference: "",
          responsibility_label: "Grabenplaner",
        });
      } else {
        resolvable = false;
        break;
      }
    }
    if (!resolvable) continue;
    const sanitizedProcess = {
      ...process,
      created_by: selectedEmployeeNumbers.has(String(process.created_by || "").trim()) ? String(process.created_by).trim() : "",
      updated_by: selectedEmployeeNumbers.has(String(process.updated_by || "").trim()) ? String(process.updated_by).trim() : "",
    };
    processes.push(sanitizedProcess);
    steps.push(...sanitizedSteps);
    if (tableExists(target, "custom_process_revisions")) {
      const department = departmentScopes.get(Number(sanitizedProcess.department_id || 0));
      const scopeLabel = sanitizedProcess.scope_type === "company"
        ? "Gesamtes Unternehmen"
        : sanitizedProcess.scope_type === "department"
          ? `${locationNames.get(department?.locationId) || department?.locationId || "Filiale"} · ${department?.name || "Abteilung"}`
          : locationNames.get(String(sanitizedProcess.location_id || "")) || String(sanitizedProcess.location_id || "Filiale");
      revisions.push({
        process_id: processId,
        revision: Number(sanitizedProcess.revision || 1),
        snapshot_json: JSON.stringify(customProcessDashboardSnapshot(sanitizedProcess, sanitizedSteps, scopeLabel)),
        created_by: sanitizedProcess.updated_by || sanitizedProcess.created_by || "",
      });
    }
  }
  return { processes, steps, revisions };
}

function normalizeEmployeeRecord(record) {
  return {
    personnel_number: String(record.personnelNumber || record.personnel_number || "").trim(),
    full_name: String(record.fullName || record.full_name || "").trim(),
    nickname: String(record.nickname || "").trim(),
    color: String(record.color || "#0b84c6").trim().toLowerCase(),
    contracted_hours: Number(record.contractedHours ?? record.contracted_hours ?? 38.5),
    target_workdays_per_week: Math.min(6, Math.max(1, Math.trunc(Number(record.targetWorkdaysPerWeek ?? record.target_workdays_per_week ?? 5) || 5))),
    preferred_day_off: record.preferredDayOff ?? record.preferred_day_off ?? null,
    fixed_workdays: String(record.fixedWorkdays ?? record.fixed_workdays ?? ""),
    position_id: String(record.positionId ?? record.position_id ?? "verkaufsmitarbeiter"),
    time_confirmation_level: String(record.timeConfirmationLevel ?? record.time_confirmation_level ?? "C"),
    sickness_without_aum_enabled: record.sicknessWithoutAumEnabled === true
      || record.sickness_without_aum_enabled === true || Number(record.sickness_without_aum_enabled) === 1 ? 1 : 0,
    home_location_id: String(record.homeLocationId ?? record.home_location_id ?? "").trim() || null,
    preferred_department_id: Number(record.preferredDepartmentId ?? record.preferred_department_id ?? 0) || null,
    cost_center_id: String(record.costCenterId ?? record.cost_center_id ?? "").trim() || null,
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
    const normalizedEmployees = employees.map(normalizeEmployeeRecord);
    if (!normalizedEmployees.some((employee) => employee.personnel_number === creatorNumber)) {
      normalizedEmployees.unshift(normalizeEmployeeRecord(creator.employee));
    }
    const uniqueEmployees = [...new Map(normalizedEmployees.map((employee) => [employee.personnel_number, employee])).values()];
    const customProcesses = sourceRowsForCustomProcesses(sourceDatabase, target, locations, validDepartmentIds, uniqueEmployees);
    const locationCostCenters = new Map(locationRows
      .map((location) => [String(location.id), String(location.cost_center_id || "")])
      .filter(([, id]) => id));
    for (const employee of uniqueEmployees) {
      if (!employee.cost_center_id) employee.cost_center_id = locationCostCenters.get(String(employee.home_location_id || "")) || null;
    }
    const referencedCostCenterIds = [...new Set([
      ...locationRows.map((location) => String(location.cost_center_id || "")),
      ...uniqueEmployees.map((employee) => String(employee.cost_center_id || "")),
    ].filter(Boolean))];
    const costCenterRows = referencedCostCenterIds.length && tableExists(sourceDatabase, "cost_centers")
      ? rows(sourceDatabase, "cost_centers", `WHERE id IN (${referencedCostCenterIds.map(() => "?").join(",")})`, referencedCostCenterIds)
      : [];
    if (tableExists(sourceDatabase, "cost_centers") && costCenterRows.length !== referencedCostCenterIds.length) {
      throw new Error("Mindestens eine referenzierte Kostenstelle wurde nicht gefunden.");
    }

    target.exec("PRAGMA foreign_keys = OFF");
    target.exec("BEGIN IMMEDIATE");
    try {
      insertRows(target, "positions", positionRows);
      insertRows(target, "cost_centers", costCenterRows);
      insertRows(target, "locations", locationRows);
      insertRows(target, "departments", departmentRows);
      insertRows(target, "custom_processes", customProcesses.processes);
      insertRows(target, "custom_process_steps", customProcesses.steps);
      insertRows(target, "custom_process_revisions", customProcesses.revisions);

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

      for (const employee of uniqueEmployees) {
        if (!employee.personnel_number || !employee.full_name || !employee.nickname) throw new Error("Ein Teammitglied hat unvollständige Stammdaten.");
        if (!locations.includes(employee.home_location_id)) employee.home_location_id = locations[0];
        if (!employee.cost_center_id) employee.cost_center_id = locationCostCenters.get(String(employee.home_location_id || "")) || null;
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
