"use strict";

const {
  migrateSqlitePositionCatalogAssignments,
  migrateSqlitePositionCatalogGovernance,
} = require("./position-catalog-governance");

function assertFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} muss eine Funktion sein.`);
  }
  return value;
}

function runSqliteOrganizationSchemaMigrations(database, {
  appVersion,
  migrationState,
  legacyDaySettingsSnapshot,
  auditPortal,
  getSettings,
  brandingFromSettings,
  defaultSettings,
} = {}) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  const db = database;
  const packageMetadata = { version: String(appVersion || "") };
  assertFunction(legacyDaySettingsSnapshot, "legacyDaySettingsSnapshot");
  assertFunction(auditPortal, "auditPortal");
  assertFunction(getSettings, "getSettings");
  assertFunction(brandingFromSettings, "brandingFromSettings");
  const {
    costCenterMigrationId,
    costCenterTypeMigrationApplied,
    costCenterTypeMigrationId,
    costCenterTypePositionTableMissingBeforeSchema,
    costCenterTypeTableMissingBeforeSchema,
    employeeCostCenterAssignmentMigrationId,
    employeeCostCenterAssignmentMigrationRequired,
    principalSeparationMigrationId,
    principalSeparationMigrationRequired,
    shiftLocationMigrationId,
  } = migrationState || {};

function ensureDefaultLocation() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM locations").get().count;
  if (count === 0) {
    db.prepare("INSERT INTO locations (id, name, day_settings_json, active) VALUES ('01', 'Hauptstandort', ?, 1)")
      .run(JSON.stringify(legacyDaySettingsSnapshot()));
  }
}

ensureDefaultLocation();

const BUILTIN_COST_CENTER_TYPES = Object.freeze([
  { id: "branch", code: "branch", name: "Filiale", isBranch: true, sortOrder: 10 },
  { id: "administration", code: "administration", name: "Verwaltung", isBranch: false, sortOrder: 20 },
  { id: "production", code: "production", name: "Produktion", isBranch: false, sortOrder: 30 },
  { id: "other", code: "other", name: "Sonstiges", isBranch: false, sortOrder: 90 },
]);
const LEGACY_COST_CENTER_TYPES = new Set(BUILTIN_COST_CENTER_TYPES.map((entry) => entry.id));

function legacyCostCenterType(type) {
  return LEGACY_COST_CENTER_TYPES.has(type?.id) ? type.id : "other";
}

function migrateCostCenterTypes() {
  const seedPositionMappings = !costCenterTypeMigrationApplied
    || costCenterTypeTableMissingBeforeSchema
    || costCenterTypePositionTableMissingBeforeSchema;
  const insertType = db.prepare(`
    INSERT OR IGNORE INTO cost_center_types
      (id, code, name, description, is_branch, active, builtin, sort_order, created_by, updated_by)
    VALUES (?, ?, ?, '', ?, 1, 1, ?, 'migration', 'migration')
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const type of BUILTIN_COST_CENTER_TYPES) {
      insertType.run(type.id, type.code, type.name, type.isBranch ? 1 : 0, type.sortOrder);
    }
    db.exec(`
      UPDATE cost_centers
      SET cost_center_type_id = CASE
        WHEN type IN ('branch','administration','production') THEN type
        ELSE 'other'
      END
      WHERE TRIM(COALESCE(cost_center_type_id, '')) = ''
        OR NOT EXISTS (
          SELECT 1 FROM cost_center_types cct WHERE cct.id = cost_centers.cost_center_type_id
        )
    `);
    if (seedPositionMappings) {
      const insertMapping = db.prepare(`
        INSERT OR IGNORE INTO cost_center_type_positions
          (cost_center_type_id, position_id, sort_order)
        SELECT ?, p.id, p.sort_order FROM positions p
      `);
      for (const type of BUILTIN_COST_CENTER_TYPES) insertMapping.run(type.id);
    }
    const invalidCenters = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM cost_centers c
      LEFT JOIN cost_center_types cct ON cct.id = c.cost_center_type_id
      WHERE cct.id IS NULL
    `).get().count || 0);
    if (invalidCenters) throw new Error(`Kostenstellentyp-Migration unvollständig: ${invalidCenters} Kostenstellen.`);
    db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
      .run(costCenterTypeMigrationId, packageMetadata.version);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function installCostCenterTypeIntegrityTriggers() {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_cost_centers_type_insert;
    DROP TRIGGER IF EXISTS trg_cost_centers_type_update;
    DROP TRIGGER IF EXISTS trg_cost_centers_location_type_update;
    DROP TRIGGER IF EXISTS trg_cost_centers_location_archive;
    DROP TRIGGER IF EXISTS trg_cost_center_types_archive_in_use;
    DROP TRIGGER IF EXISTS trg_cost_center_types_branch_in_use;
    DROP TRIGGER IF EXISTS trg_cost_center_types_delete;

    CREATE TRIGGER trg_cost_centers_type_insert
    BEFORE INSERT ON cost_centers
    WHEN TRIM(COALESCE(NEW.cost_center_type_id, '')) = ''
      OR NOT EXISTS (
        SELECT 1 FROM cost_center_types
        WHERE id = NEW.cost_center_type_id AND active = 1
      )
    BEGIN
      SELECT RAISE(ABORT, 'COST_CENTER_TYPE_REQUIRED');
    END;

    CREATE TRIGGER trg_cost_centers_type_update
    BEFORE UPDATE OF cost_center_type_id ON cost_centers
    WHEN COALESCE(NEW.cost_center_type_id, '') <> COALESCE(OLD.cost_center_type_id, '')
      AND (
        TRIM(COALESCE(NEW.cost_center_type_id, '')) = ''
        OR NOT EXISTS (
          SELECT 1 FROM cost_center_types
          WHERE id = NEW.cost_center_type_id AND active = 1
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'COST_CENTER_TYPE_REQUIRED');
    END;

    CREATE TRIGGER trg_cost_centers_location_type_update
    BEFORE UPDATE OF cost_center_type_id ON cost_centers
    WHEN EXISTS (SELECT 1 FROM locations WHERE cost_center_id = OLD.id)
      AND NOT EXISTS (
        SELECT 1 FROM cost_center_types
        WHERE id = NEW.cost_center_type_id AND active = 1 AND is_branch = 1
      )
    BEGIN
      SELECT RAISE(ABORT, 'COST_CENTER_TYPE_LOCATION_CONFLICT');
    END;

    CREATE TRIGGER trg_cost_centers_location_archive
    BEFORE UPDATE OF active ON cost_centers
    WHEN OLD.active = 1 AND NEW.active = 0
      AND EXISTS (SELECT 1 FROM locations WHERE cost_center_id = OLD.id)
    BEGIN
      SELECT RAISE(ABORT, 'COST_CENTER_LOCATION_IN_USE');
    END;

    CREATE TRIGGER trg_cost_center_types_archive_in_use
    BEFORE UPDATE OF active ON cost_center_types
    WHEN OLD.active = 1 AND NEW.active = 0
      AND EXISTS (
        SELECT 1 FROM cost_centers
        WHERE cost_center_type_id = OLD.id AND active = 1
      )
    BEGIN
      SELECT RAISE(ABORT, 'COST_CENTER_TYPE_IN_USE');
    END;

    CREATE TRIGGER trg_cost_center_types_branch_in_use
    BEFORE UPDATE OF is_branch ON cost_center_types
    WHEN OLD.is_branch = 1 AND NEW.is_branch = 0
      AND EXISTS (
        SELECT 1
        FROM locations l
        JOIN cost_centers c ON c.id = l.cost_center_id
        WHERE c.cost_center_type_id = OLD.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'COST_CENTER_TYPE_BRANCH_IN_USE');
    END;

    CREATE TRIGGER trg_cost_center_types_delete
    BEFORE DELETE ON cost_center_types
    BEGIN
      SELECT RAISE(ABORT, 'COST_CENTER_TYPE_ARCHIVE_ONLY');
    END;
  `);
}

function installCostCenterIntegrityTriggers() {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_locations_cost_center_supplied;
    DROP TRIGGER IF EXISTS trg_locations_cost_center_default;
    DROP TRIGGER IF EXISTS trg_locations_cost_center_update;
    DROP TRIGGER IF EXISTS trg_employees_cost_center_supplied;
    DROP TRIGGER IF EXISTS trg_employees_cost_center_default;
    DROP TRIGGER IF EXISTS trg_employees_cost_center_update;
    DROP TRIGGER IF EXISTS trg_employees_assignment_position_insert;
    DROP TRIGGER IF EXISTS trg_employees_assignment_position_update;
    DROP TRIGGER IF EXISTS trg_employees_assignment_location_insert;
    DROP TRIGGER IF EXISTS trg_employees_assignment_location_update;
    DROP TRIGGER IF EXISTS trg_employees_assignment_department_insert;
    DROP TRIGGER IF EXISTS trg_employees_assignment_department_update;

    CREATE TRIGGER trg_locations_cost_center_supplied
    BEFORE INSERT ON locations
    WHEN TRIM(COALESCE(NEW.cost_center_id, '')) <> ''
      AND (
        NOT EXISTS (
          SELECT 1
          FROM cost_centers c
          JOIN cost_center_types cct ON cct.id = c.cost_center_type_id
          WHERE c.id = NEW.cost_center_id AND c.active = 1 AND cct.active = 1 AND cct.is_branch = 1
        )
        OR EXISTS (SELECT 1 FROM locations WHERE cost_center_id = NEW.cost_center_id)
      )
    BEGIN
      SELECT RAISE(ABORT, 'LOCATION_COST_CENTER_INVALID');
    END;

    CREATE TRIGGER trg_locations_cost_center_default
    AFTER INSERT ON locations
    WHEN TRIM(COALESCE(NEW.cost_center_id, '')) = ''
    BEGIN
      INSERT OR IGNORE INTO cost_centers
        (id, code, name, type, cost_center_type_id, description, active, sort_order, created_by, updated_by)
      SELECT
        'cc-location-' || NEW.id,
        UPPER('FIL' || NEW.id),
        COALESCE(NULLIF(TRIM(NEW.name), ''), UPPER('FIL' || NEW.id)),
        'branch',
        cct.id,
        '',
        1,
        100,
        'trigger',
        'trigger'
      FROM cost_center_types cct
      WHERE cct.id = 'branch' AND cct.active = 1;

      UPDATE locations
      SET cost_center_id = (
        SELECT c.id
        FROM cost_centers c
        JOIN cost_center_types cct ON cct.id = c.cost_center_type_id
        WHERE c.code = UPPER('FIL' || NEW.id) COLLATE NOCASE
          AND c.active = 1 AND cct.active = 1 AND cct.is_branch = 1
        LIMIT 1
      )
      WHERE id = NEW.id;
      SELECT CASE WHEN TRIM(COALESCE((SELECT cost_center_id FROM locations WHERE id = NEW.id), '')) = ''
        THEN RAISE(ABORT, 'COST_CENTER_REQUIRED') END;
    END;

    CREATE TRIGGER trg_locations_cost_center_update
    BEFORE UPDATE OF cost_center_id ON locations
    WHEN TRIM(COALESCE(NEW.cost_center_id, '')) = ''
      OR NOT EXISTS (
        SELECT 1
        FROM cost_centers c
        JOIN cost_center_types cct ON cct.id = c.cost_center_type_id
        WHERE c.id = NEW.cost_center_id AND c.active = 1 AND cct.active = 1 AND cct.is_branch = 1
      )
      OR EXISTS (
        SELECT 1 FROM locations
        WHERE cost_center_id = NEW.cost_center_id AND id <> OLD.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'LOCATION_COST_CENTER_INVALID');
    END;

    CREATE TRIGGER trg_employees_cost_center_supplied
    BEFORE INSERT ON employees
    WHEN TRIM(COALESCE(NEW.cost_center_id, '')) <> ''
      AND NOT EXISTS (SELECT 1 FROM cost_centers WHERE id = NEW.cost_center_id AND active = 1)
    BEGIN
      SELECT RAISE(ABORT, 'COST_CENTER_INVALID');
    END;

    CREATE TRIGGER trg_employees_cost_center_default
    AFTER INSERT ON employees
    WHEN TRIM(COALESCE(NEW.cost_center_id, '')) = ''
    BEGIN
      UPDATE employees
      SET cost_center_id = COALESCE(
        (SELECT l.cost_center_id FROM locations l
          JOIN cost_centers c ON c.id = l.cost_center_id
          WHERE l.id = NEW.home_location_id LIMIT 1),
        (SELECT id FROM cost_centers
          WHERE active = 1 AND cost_center_type_id = 'administration'
          ORDER BY sort_order, code LIMIT 1),
        (SELECT id FROM cost_centers WHERE active = 1 ORDER BY sort_order, code LIMIT 1)
      )
      WHERE personnel_number = NEW.personnel_number;
      SELECT CASE WHEN TRIM(COALESCE((SELECT cost_center_id FROM employees WHERE personnel_number = NEW.personnel_number), '')) = ''
        THEN RAISE(ABORT, 'COST_CENTER_REQUIRED') END;
    END;

    CREATE TRIGGER trg_employees_cost_center_update
    BEFORE UPDATE OF cost_center_id ON employees
    WHEN COALESCE(NEW.cost_center_id, '') <> COALESCE(OLD.cost_center_id, '')
      AND (
        TRIM(COALESCE(NEW.cost_center_id, '')) = ''
        OR NOT EXISTS (SELECT 1 FROM cost_centers WHERE id = NEW.cost_center_id AND active = 1)
      )
    BEGIN
      SELECT RAISE(ABORT, 'COST_CENTER_REQUIRED');
    END;

    CREATE TRIGGER trg_employees_assignment_position_insert
    BEFORE INSERT ON employees
    WHEN TRIM(COALESCE(NEW.cost_center_id, '')) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM cost_centers c
        JOIN cost_center_type_positions cctp
          ON cctp.cost_center_type_id = c.cost_center_type_id
        WHERE c.id = NEW.cost_center_id AND cctp.position_id = NEW.position_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'EMPLOYEE_POSITION_NOT_ALLOWED_FOR_COST_CENTER');
    END;

    CREATE TRIGGER trg_employees_assignment_position_update
    BEFORE UPDATE OF cost_center_id, position_id ON employees
    WHEN NOT EXISTS (
      SELECT 1
      FROM cost_centers c
      JOIN cost_center_type_positions cctp
        ON cctp.cost_center_type_id = c.cost_center_type_id
      WHERE c.id = NEW.cost_center_id AND cctp.position_id = NEW.position_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'EMPLOYEE_POSITION_NOT_ALLOWED_FOR_COST_CENTER');
    END;

    CREATE TRIGGER trg_employees_assignment_location_insert
    BEFORE INSERT ON employees
    WHEN TRIM(COALESCE(NEW.cost_center_id, '')) <> ''
      AND COALESCE(NEW.home_location_id, '') <> COALESCE((
        SELECT CASE WHEN cct.is_branch = 1
          THEN (SELECT l.id FROM locations l WHERE l.cost_center_id = c.id LIMIT 1)
          ELSE NULL END
        FROM cost_centers c
        JOIN cost_center_types cct ON cct.id = c.cost_center_type_id
        WHERE c.id = NEW.cost_center_id
      ), '')
    BEGIN
      SELECT RAISE(ABORT, 'EMPLOYEE_LOCATION_MUST_FOLLOW_COST_CENTER');
    END;

    CREATE TRIGGER trg_employees_assignment_location_update
    BEFORE UPDATE OF cost_center_id, home_location_id ON employees
    WHEN COALESCE(NEW.home_location_id, '') <> COALESCE((
      SELECT CASE WHEN cct.is_branch = 1
        THEN (SELECT l.id FROM locations l WHERE l.cost_center_id = c.id LIMIT 1)
        ELSE NULL END
      FROM cost_centers c
      JOIN cost_center_types cct ON cct.id = c.cost_center_type_id
      WHERE c.id = NEW.cost_center_id
    ), '')
    BEGIN
      SELECT RAISE(ABORT, 'EMPLOYEE_LOCATION_MUST_FOLLOW_COST_CENTER');
    END;

    CREATE TRIGGER trg_employees_assignment_department_insert
    BEFORE INSERT ON employees
    WHEN NEW.preferred_department_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM departments d
        WHERE d.id = NEW.preferred_department_id AND d.location_id = NEW.home_location_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'EMPLOYEE_DEPARTMENT_LOCATION_CONFLICT');
    END;

    CREATE TRIGGER trg_employees_assignment_department_update
    BEFORE UPDATE OF home_location_id, preferred_department_id ON employees
    WHEN NEW.preferred_department_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM departments d
        WHERE d.id = NEW.preferred_department_id AND d.location_id = NEW.home_location_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'EMPLOYEE_DEPARTMENT_LOCATION_CONFLICT');
    END;
  `);
}

function migrateCostCenters() {
  const insertCostCenter = db.prepare(`
    INSERT OR IGNORE INTO cost_centers
      (id, code, name, type, cost_center_type_id, description, active, sort_order, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, '', 1, ?, 'migration', 'migration')
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    insertCostCenter.run("cc-administration", "VERW", "Verwaltung", "administration", "administration", 10);
    const administrationId = db.prepare("SELECT id FROM cost_centers WHERE code = ? COLLATE NOCASE").get("VERW")?.id
      || db.prepare(`
        SELECT id FROM cost_centers
        WHERE cost_center_type_id = 'administration'
        ORDER BY active DESC, sort_order, code LIMIT 1
      `).get()?.id;
    if (!administrationId) throw new Error("COST_CENTER_ADMINISTRATION_REQUIRED");

    const activeBranchById = db.prepare(`
      SELECT c.id
      FROM cost_centers c
      JOIN cost_center_types cct ON cct.id = c.cost_center_type_id
      WHERE c.id = ? AND c.active = 1 AND cct.active = 1 AND cct.is_branch = 1
    `);
    const activeBranchByCode = db.prepare(`
      SELECT c.id
      FROM cost_centers c
      JOIN cost_center_types cct ON cct.id = c.cost_center_type_id
      WHERE c.code = ? COLLATE NOCASE
        AND c.active = 1 AND cct.active = 1 AND cct.is_branch = 1
      LIMIT 1
    `);
    const anyCostCenterById = db.prepare("SELECT 1 FROM cost_centers WHERE id = ?");
    const anyCostCenterByCode = db.prepare("SELECT 1 FROM cost_centers WHERE code = ? COLLATE NOCASE");
    const centerUsedByOtherLocation = db.prepare(`
      SELECT 1 FROM locations WHERE cost_center_id = ? AND id <> ? LIMIT 1
    `);
    const updateLocationCostCenter = db.prepare("UPDATE locations SET cost_center_id = ? WHERE id = ?");
    const moveEmployeesWithLegacyLocationCenter = db.prepare(`
      UPDATE employees
      SET cost_center_id = ?
      WHERE home_location_id = ? AND cost_center_id = ?
    `);
    const claimedBranchCenters = new Set();

    for (const location of db.prepare("SELECT id, name, cost_center_id FROM locations ORDER BY id").all()) {
      let costCenterId = "";
      const current = location.cost_center_id ? activeBranchById.get(location.cost_center_id) : null;
      if (current && !claimedBranchCenters.has(String(current.id))) costCenterId = String(current.id);

      const codeToken = String(location.id || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24) || "STANDORT";
      const baseCode = `FIL${codeToken}`.slice(0, 30);
      if (!costCenterId) {
        const candidate = activeBranchByCode.get(baseCode);
        if (candidate
          && !claimedBranchCenters.has(String(candidate.id))
          && !centerUsedByOtherLocation.get(candidate.id, location.id)) {
          costCenterId = String(candidate.id);
        }
      }

      if (!costCenterId) {
        const baseId = `cc-location-${location.id}`;
        let id = baseId;
        let idSuffix = 1;
        while (anyCostCenterById.get(id)) {
          id = `${baseId}-migration-${idSuffix}`;
          idSuffix += 1;
        }
        let code = baseCode;
        let codeSuffix = 1;
        while (anyCostCenterByCode.get(code)) {
          const suffix = `-M${codeSuffix}`;
          code = `${baseCode.slice(0, 30 - suffix.length)}${suffix}`;
          codeSuffix += 1;
        }
        insertCostCenter.run(id, code, String(location.name || code), "branch", "branch",
          100 + (Number(location.id) || 0));
        costCenterId = String(activeBranchById.get(id)?.id || "");
      }
      if (!costCenterId) throw new Error(`COST_CENTER_BRANCH_REQUIRED:${location.id}`);
      claimedBranchCenters.add(costCenterId);
      if (String(location.cost_center_id || "") !== costCenterId) {
        updateLocationCostCenter.run(costCenterId, location.id);
        if (String(location.cost_center_id || "")) {
          moveEmployeesWithLegacyLocationCenter.run(costCenterId, location.id, location.cost_center_id);
        }
      }
    }

    db.prepare(`
      UPDATE employees
      SET cost_center_id = COALESCE(
        (SELECT l.cost_center_id FROM locations l WHERE l.id = employees.home_location_id),
        ?
      )
      WHERE TRIM(COALESCE(cost_center_id, '')) = ''
        OR NOT EXISTS (SELECT 1 FROM cost_centers c WHERE c.id = employees.cost_center_id)
    `).run(administrationId);
    db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
      .run(costCenterMigrationId, packageMetadata.version);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  installCostCenterIntegrityTriggers();
  const invalidLocations = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM locations l
    LEFT JOIN cost_centers c ON c.id = l.cost_center_id
    WHERE c.id IS NULL
  `).get().count || 0);
  const invalidEmployees = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM employees e
    LEFT JOIN cost_centers c ON c.id = e.cost_center_id
    WHERE c.id IS NULL
  `).get().count || 0);
  if (invalidLocations || invalidEmployees) {
    throw new Error(`Kostenstellen-Migration unvollständig: ${invalidLocations} Standorte, ${invalidEmployees} Beschäftigte.`);
  }
}

migrateCostCenterTypes();
migrateSqlitePositionCatalogGovernance(db, { appVersion: packageMetadata.version });
migrateSqlitePositionCatalogAssignments(db, { appVersion: packageMetadata.version });
migrateCostCenters();

function employeeCostCenterReconciliationPlan() {
  return db.prepare(`
    SELECT employee.personnel_number, employee.cost_center_id,
           employee.home_location_id, employee.preferred_department_id,
           type.is_branch,
           (
             SELECT location.id
             FROM locations location
             WHERE location.cost_center_id = center.id
             ORDER BY location.id
             LIMIT 1
           ) AS derived_home_location_id,
           department.location_id AS preferred_department_location_id
    FROM employees employee
    JOIN cost_centers center ON center.id = employee.cost_center_id
    JOIN cost_center_types type ON type.id = center.cost_center_type_id
    LEFT JOIN departments department ON department.id = employee.preferred_department_id
    ORDER BY employee.personnel_number
  `).all().map((row) => {
    const beforeHomeLocationId = String(row.home_location_id || "") || null;
    const afterHomeLocationId = Number(row.is_branch) === 1
      ? (String(row.derived_home_location_id || "") || null)
      : null;
    const beforePreferredDepartmentId = Number(row.preferred_department_id || 0) || null;
    const preferredDepartmentMatches = beforePreferredDepartmentId
      && afterHomeLocationId
      && String(row.preferred_department_location_id || "") === afterHomeLocationId;
    const afterPreferredDepartmentId = preferredDepartmentMatches
      ? beforePreferredDepartmentId
      : null;
    const reasons = [];
    if (beforeHomeLocationId !== afterHomeLocationId) reasons.push("home-location-derived-from-cost-center");
    if (beforePreferredDepartmentId !== afterPreferredDepartmentId) reasons.push("preferred-department-outside-derived-location");
    return {
      personnelNumber: String(row.personnel_number),
      costCenterId: String(row.cost_center_id),
      homeLocationId: { before: beforeHomeLocationId, after: afterHomeLocationId },
      preferredDepartmentId: {
        before: beforePreferredDepartmentId,
        after: afterPreferredDepartmentId,
      },
      reasons,
    };
  }).filter((entry) => entry.reasons.length);
}

function migrateEmployeeCostCenterAssignments() {
  if (!employeeCostCenterAssignmentMigrationRequired) return;
  const employeeNumbersBefore = db.prepare(`
    SELECT personnel_number FROM employees ORDER BY personnel_number
  `).all().map((row) => String(row.personnel_number));
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      INSERT OR IGNORE INTO cost_center_type_positions
        (cost_center_type_id, position_id, sort_order)
      SELECT DISTINCT
        c.cost_center_type_id,
        e.position_id,
        COALESCE(p.sort_order, 9999)
      FROM employees e
      JOIN cost_centers c ON c.id = e.cost_center_id
      JOIN positions p ON p.id = e.position_id
      WHERE TRIM(COALESCE(c.cost_center_type_id, '')) <> '';
    `);
    const reconcileEmployee = db.prepare(`
      UPDATE employees
      SET home_location_id = ?, preferred_department_id = ?
      WHERE personnel_number = ?
    `);
    for (const entry of employeeCostCenterReconciliationPlan()) {
      reconcileEmployee.run(
        entry.homeLocationId.after,
        entry.preferredDepartmentId.after,
        entry.personnelNumber,
      );
      auditPortal(
        "system",
        "employee.cost-center.reconcile",
        "employee",
        entry.personnelNumber,
        JSON.stringify({
          migrationId: employeeCostCenterAssignmentMigrationId,
          reason: entry.reasons,
          costCenterId: entry.costCenterId,
          homeLocationId: entry.homeLocationId,
          preferredDepartmentId: entry.preferredDepartmentId,
        }),
      );
    }
    const employeeNumbersAfter = db.prepare(`
      SELECT personnel_number FROM employees ORDER BY personnel_number
    `).all().map((row) => String(row.personnel_number));
    if (JSON.stringify(employeeNumbersAfter) !== JSON.stringify(employeeNumbersBefore)) {
      throw new Error("EMPLOYEE_ASSIGNMENT_MIGRATION_NOT_LOSSLESS");
    }
    db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
      .run(employeeCostCenterAssignmentMigrationId, packageMetadata.version);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

migrateEmployeeCostCenterAssignments();
installCostCenterIntegrityTriggers();
installCostCenterTypeIntegrityTriggers();

const invalidLocationCostCenterTypes = db.prepare(`
  SELECT l.id, l.cost_center_id
  FROM locations l
  LEFT JOIN cost_centers c ON c.id = l.cost_center_id
  LEFT JOIN cost_center_types cct ON cct.id = c.cost_center_type_id
  WHERE c.id IS NULL OR c.active <> 1
    OR cct.id IS NULL OR cct.active <> 1 OR cct.is_branch <> 1
  ORDER BY l.id
`).all();
if (invalidLocationCostCenterTypes.length) {
  throw new Error(`Standort-Kostenstellen sind keinem Filialtyp zugeordnet: ${
    invalidLocationCostCenterTypes.map((row) => row.id).join(", ")
  }.`);
}
const duplicateLocationCostCenters = db.prepare(`
  SELECT cost_center_id, GROUP_CONCAT(id, ', ') AS location_ids
  FROM locations
  GROUP BY cost_center_id
  HAVING COUNT(*) > 1
`).all();
if (duplicateLocationCostCenters.length) {
  throw new Error(`Eine Filialkostenstelle ist mehreren Standorten zugeordnet: ${
    duplicateLocationCostCenters.map((row) => `${row.cost_center_id} (${row.location_ids})`).join("; ")
  }.`);
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_cost_center_unique
  ON locations(cost_center_id)
  WHERE TRIM(COALESCE(cost_center_id, '')) <> ''
`);
const invalidEmployeeCostCenterAssignments = db.prepare(`
  SELECT employee.personnel_number
  FROM employees employee
  LEFT JOIN cost_centers center ON center.id = employee.cost_center_id
  LEFT JOIN cost_center_types type ON type.id = center.cost_center_type_id
  WHERE center.id IS NULL OR type.id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM cost_center_type_positions mapping
      WHERE mapping.cost_center_type_id = center.cost_center_type_id
        AND mapping.position_id = employee.position_id
    )
    OR COALESCE(employee.home_location_id, '') <> COALESCE(
      CASE WHEN type.is_branch = 1
        THEN (
          SELECT location.id
          FROM locations location
          WHERE location.cost_center_id = center.id
          ORDER BY location.id
          LIMIT 1
        )
        ELSE NULL
      END,
      ''
    )
    OR (
      employee.preferred_department_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM departments department
        WHERE department.id = employee.preferred_department_id
          AND department.location_id = employee.home_location_id
      )
    )
  ORDER BY employee.personnel_number
`).all();
if (invalidEmployeeCostCenterAssignments.length) {
  throw new Error(`Mitarbeiter-Kostenstellenzuordnungen sind widersprüchlich: ${
    invalidEmployeeCostCenterAssignments.map((row) => row.personnel_number).join(", ")
  }.`);
}
const postCostCenterForeignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
if (postCostCenterForeignKeyErrors.length) {
  throw new Error(`Datenbank-Fremdschlüsselprüfung nach Kostenstellenmigration fehlgeschlagen: ${
    postCostCenterForeignKeyErrors.length
  } Konflikt(e).`);
}
const postCostCenterIntegrity = db.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
if (!(postCostCenterIntegrity.length === 1 && postCostCenterIntegrity[0] === "ok")) {
  throw new Error(`Datenbank-Integritätsprüfung nach Kostenstellenmigration fehlgeschlagen: ${
    postCostCenterIntegrity.join("; ")
  }`);
}

function installPortalPrincipalSeparation() {
  const collisions = db.prepare(`
    SELECT organization.login_name, employee.personnel_number
    FROM portal_organization_accounts organization
    JOIN employees employee
      ON employee.personnel_number = organization.login_name COLLATE NOCASE
    UNION
    SELECT organization.login_name, user.employee_number
    FROM portal_organization_accounts organization
    JOIN portal_users user
      ON user.employee_number = organization.login_name COLLATE NOCASE
    ORDER BY login_name
  `).all();
  if (collisions.length) {
    throw new Error(`Mitarbeiter- und Organisationskonten verwenden dieselbe Zugangskennung: ${
      collisions.map((row) => row.login_name).join(", ")
    }.`);
  }
  if (!principalSeparationMigrationRequired) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_employees_organization_login_insert;
      DROP TRIGGER IF EXISTS trg_employees_organization_login_update;
      DROP TRIGGER IF EXISTS trg_organization_accounts_employee_login_insert;
      DROP TRIGGER IF EXISTS trg_organization_accounts_employee_login_update;

      CREATE TRIGGER trg_employees_organization_login_insert
      BEFORE INSERT ON employees
      WHEN EXISTS (
        SELECT 1 FROM portal_organization_accounts
        WHERE login_name = NEW.personnel_number COLLATE NOCASE
      )
      BEGIN
        SELECT RAISE(ABORT, 'PORTAL_PRINCIPAL_LOGIN_CONFLICT');
      END;

      CREATE TRIGGER trg_employees_organization_login_update
      BEFORE UPDATE OF personnel_number ON employees
      WHEN EXISTS (
        SELECT 1 FROM portal_organization_accounts
        WHERE login_name = NEW.personnel_number COLLATE NOCASE
      )
      BEGIN
        SELECT RAISE(ABORT, 'PORTAL_PRINCIPAL_LOGIN_CONFLICT');
      END;

      CREATE TRIGGER trg_organization_accounts_employee_login_insert
      BEFORE INSERT ON portal_organization_accounts
      WHEN EXISTS (
        SELECT 1 FROM employees
        WHERE personnel_number = NEW.login_name COLLATE NOCASE
      ) OR EXISTS (
        SELECT 1 FROM portal_users
        WHERE employee_number = NEW.login_name COLLATE NOCASE
      )
      BEGIN
        SELECT RAISE(ABORT, 'PORTAL_PRINCIPAL_LOGIN_CONFLICT');
      END;

      CREATE TRIGGER trg_organization_accounts_employee_login_update
      BEFORE UPDATE OF login_name ON portal_organization_accounts
      WHEN EXISTS (
        SELECT 1 FROM employees
        WHERE personnel_number = NEW.login_name COLLATE NOCASE
      ) OR EXISTS (
        SELECT 1 FROM portal_users
        WHERE employee_number = NEW.login_name COLLATE NOCASE
      )
      BEGIN
        SELECT RAISE(ABORT, 'PORTAL_PRINCIPAL_LOGIN_CONFLICT');
      END;
    `);
    db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
      .run(principalSeparationMigrationId, packageMetadata.version);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

installPortalPrincipalSeparation();

function installShiftLocationIntegrityTriggers() {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_shifts_location_supplied;
    DROP TRIGGER IF EXISTS trg_shifts_location_default;
    DROP TRIGGER IF EXISTS trg_shifts_location_update;
    DROP TRIGGER IF EXISTS trg_shifts_department_location_insert;
    DROP TRIGGER IF EXISTS trg_shifts_department_location_update;
    DROP TRIGGER IF EXISTS trg_shifts_staff_assignment_insert;
    DROP TRIGGER IF EXISTS trg_shifts_staff_assignment_update;
    DROP TRIGGER IF EXISTS trg_staff_assignments_shift_coverage_insert;
    DROP TRIGGER IF EXISTS trg_staff_assignments_shift_coverage_update;
    DROP TRIGGER IF EXISTS trg_week_options_staff_assignment_insert;
    DROP TRIGGER IF EXISTS trg_week_options_staff_assignment_update;

    CREATE TRIGGER trg_shifts_location_supplied
    BEFORE INSERT ON shifts
    WHEN TRIM(COALESCE(NEW.location_id, '')) <> ''
      AND NOT EXISTS (SELECT 1 FROM locations WHERE id = NEW.location_id)
    BEGIN
      SELECT RAISE(ABORT, 'SHIFT_LOCATION_INVALID');
    END;

    CREATE TRIGGER trg_shifts_location_default
    AFTER INSERT ON shifts
    WHEN TRIM(COALESCE(NEW.location_id, '')) = ''
    BEGIN
      UPDATE shifts
      SET location_id = COALESCE(
        (SELECT d.location_id FROM departments d WHERE d.id = NEW.department_id),
        (SELECT e.home_location_id FROM employees e WHERE e.personnel_number = NEW.employee_number)
      )
      WHERE id = NEW.id;
      SELECT CASE WHEN TRIM(COALESCE((SELECT location_id FROM shifts WHERE id = NEW.id), '')) = ''
        THEN RAISE(ABORT, 'SHIFT_LOCATION_REQUIRED') END;
    END;

    CREATE TRIGGER trg_shifts_location_update
    BEFORE UPDATE OF location_id ON shifts
    WHEN TRIM(COALESCE(NEW.location_id, '')) = ''
      OR NOT EXISTS (SELECT 1 FROM locations WHERE id = NEW.location_id)
    BEGIN
      SELECT RAISE(ABORT, 'SHIFT_LOCATION_REQUIRED');
    END;

    CREATE TRIGGER trg_shifts_department_location_insert
    BEFORE INSERT ON shifts
    WHEN NEW.department_id IS NOT NULL
      AND TRIM(COALESCE(NEW.location_id, '')) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM departments d
        WHERE d.id = NEW.department_id AND d.location_id = NEW.location_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'SHIFT_DEPARTMENT_LOCATION_CONFLICT');
    END;

    CREATE TRIGGER trg_shifts_department_location_update
    BEFORE UPDATE OF location_id, department_id ON shifts
    WHEN NEW.department_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM departments d
        WHERE d.id = NEW.department_id AND d.location_id = NEW.location_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'SHIFT_DEPARTMENT_LOCATION_CONFLICT');
    END;

    CREATE TRIGGER trg_shifts_staff_assignment_insert
    BEFORE INSERT ON shifts
    BEGIN
      SELECT CASE WHEN
        TRIM(COALESCE((SELECT e.home_location_id FROM employees e
          WHERE e.personnel_number = NEW.employee_number), '')) <> ''
        AND COALESCE(
          NULLIF(TRIM(COALESCE(NEW.location_id, '')), ''),
          (SELECT d.location_id FROM departments d WHERE d.id = NEW.department_id),
          (SELECT e.home_location_id FROM employees e WHERE e.personnel_number = NEW.employee_number)
        ) = (SELECT e.home_location_id FROM employees e
          WHERE e.personnel_number = NEW.employee_number)
        AND EXISTS (
          SELECT 1 FROM employee_location_lendings lending
          WHERE lending.employee_number = NEW.employee_number
            AND lending.status = 'active'
            AND lending.date_from <= NEW.shift_date
            AND lending.date_to >= NEW.shift_date
            AND (
              lending.all_day = 1
              OR (
                lending.date_from = NEW.shift_date
                AND lending.date_to = NEW.shift_date
                AND lending.start_time < NEW.end_time
                AND NEW.start_time < lending.end_time
              )
            )
        )
        THEN RAISE(ABORT, 'STAFF_ASSIGNMENT_HOME_SHIFT_CONFLICT') END;

      SELECT CASE WHEN
        TRIM(COALESCE(COALESCE(
          NULLIF(TRIM(COALESCE(NEW.location_id, '')), ''),
          (SELECT d.location_id FROM departments d WHERE d.id = NEW.department_id),
          (SELECT e.home_location_id FROM employees e WHERE e.personnel_number = NEW.employee_number)
        ), '')) <> ''
        AND COALESCE(
          NULLIF(TRIM(COALESCE(NEW.location_id, '')), ''),
          (SELECT d.location_id FROM departments d WHERE d.id = NEW.department_id),
          (SELECT e.home_location_id FROM employees e WHERE e.personnel_number = NEW.employee_number)
        ) <> COALESCE((SELECT e.home_location_id FROM employees e
          WHERE e.personnel_number = NEW.employee_number), '')
        AND EXISTS (
          SELECT 1 FROM locations location
          WHERE location.id = COALESCE(
            NULLIF(TRIM(COALESCE(NEW.location_id, '')), ''),
            (SELECT d.location_id FROM departments d WHERE d.id = NEW.department_id),
            (SELECT e.home_location_id FROM employees e WHERE e.personnel_number = NEW.employee_number)
          )
        )
        AND (
          NEW.department_id IS NULL
          OR EXISTS (
            SELECT 1 FROM departments department
            WHERE department.id = NEW.department_id
              AND department.location_id = COALESCE(
                NULLIF(TRIM(COALESCE(NEW.location_id, '')), ''),
                (SELECT d.location_id FROM departments d WHERE d.id = NEW.department_id),
                (SELECT e.home_location_id FROM employees e WHERE e.personnel_number = NEW.employee_number)
              )
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM employee_location_lendings lending
          WHERE lending.employee_number = NEW.employee_number
            AND lending.status = 'active'
            AND lending.destination_location_id = COALESCE(
              NULLIF(TRIM(COALESCE(NEW.location_id, '')), ''),
              (SELECT d.location_id FROM departments d WHERE d.id = NEW.department_id),
              (SELECT e.home_location_id FROM employees e WHERE e.personnel_number = NEW.employee_number)
            )
            AND (lending.destination_department_id IS NULL
              OR lending.destination_department_id = NEW.department_id)
            AND (
              (lending.all_day = 1
                AND lending.date_from <= NEW.shift_date
                AND lending.date_to >= NEW.shift_date)
              OR (
                lending.all_day = 0
                AND lending.date_from = NEW.shift_date
                AND lending.date_to = NEW.shift_date
                AND lending.start_time <= NEW.start_time
                AND lending.end_time >= NEW.end_time
              )
            )
        )
        THEN RAISE(ABORT, 'STAFF_ASSIGNMENT_COVERAGE_REQUIRED') END;
    END;

    CREATE TRIGGER trg_shifts_staff_assignment_update
    BEFORE UPDATE OF employee_number, location_id, department_id, shift_date, start_time, end_time ON shifts
    BEGIN
      SELECT CASE WHEN
        TRIM(COALESCE((SELECT e.home_location_id FROM employees e
          WHERE e.personnel_number = NEW.employee_number), '')) <> ''
        AND NEW.location_id = (SELECT e.home_location_id FROM employees e
          WHERE e.personnel_number = NEW.employee_number)
        AND EXISTS (
          SELECT 1 FROM employee_location_lendings lending
          WHERE lending.employee_number = NEW.employee_number
            AND lending.status = 'active'
            AND lending.date_from <= NEW.shift_date
            AND lending.date_to >= NEW.shift_date
            AND (
              lending.all_day = 1
              OR (
                lending.date_from = NEW.shift_date
                AND lending.date_to = NEW.shift_date
                AND lending.start_time < NEW.end_time
                AND NEW.start_time < lending.end_time
              )
            )
        )
        THEN RAISE(ABORT, 'STAFF_ASSIGNMENT_HOME_SHIFT_CONFLICT') END;

      SELECT CASE WHEN
        TRIM(COALESCE(NEW.location_id, '')) <> ''
        AND NEW.location_id <> COALESCE((SELECT e.home_location_id FROM employees e
          WHERE e.personnel_number = NEW.employee_number), '')
        AND EXISTS (SELECT 1 FROM locations location WHERE location.id = NEW.location_id)
        AND (
          NEW.department_id IS NULL
          OR EXISTS (
            SELECT 1 FROM departments department
            WHERE department.id = NEW.department_id
              AND department.location_id = NEW.location_id
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM employee_location_lendings lending
          WHERE lending.employee_number = NEW.employee_number
            AND lending.status = 'active'
            AND lending.destination_location_id = NEW.location_id
            AND (lending.destination_department_id IS NULL
              OR lending.destination_department_id = NEW.department_id)
            AND (
              (lending.all_day = 1
                AND lending.date_from <= NEW.shift_date
                AND lending.date_to >= NEW.shift_date)
              OR (
                lending.all_day = 0
                AND lending.date_from = NEW.shift_date
                AND lending.date_to = NEW.shift_date
                AND lending.start_time <= NEW.start_time
                AND lending.end_time >= NEW.end_time
              )
            )
        )
        THEN RAISE(ABORT, 'STAFF_ASSIGNMENT_COVERAGE_REQUIRED') END;
    END;

    CREATE TRIGGER trg_staff_assignments_shift_coverage_insert
    BEFORE INSERT ON employee_location_lendings
    WHEN NEW.status = 'active'
      AND EXISTS (
        SELECT 1
        FROM shifts shift
        WHERE shift.employee_number = NEW.employee_number
          AND julianday(shift.shift_date || ' ' || shift.start_time) < julianday(
            NEW.date_to || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.end_time END,
            CASE WHEN NEW.all_day = 1 THEN '+1 day' ELSE '+0 day' END
          )
          AND julianday(
            NEW.date_from || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.start_time END
          ) < julianday(shift.shift_date || ' ' || shift.end_time)
          AND NOT (
            shift.location_id = NEW.destination_location_id
            AND (NEW.destination_department_id IS NULL
              OR shift.department_id = NEW.destination_department_id)
            AND julianday(
              NEW.date_from || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.start_time END
            ) <= julianday(shift.shift_date || ' ' || shift.start_time)
            AND julianday(shift.shift_date || ' ' || shift.end_time) <= julianday(
              NEW.date_to || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.end_time END,
              CASE WHEN NEW.all_day = 1 THEN '+1 day' ELSE '+0 day' END
            )
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'EMPLOYEE_LENDING_SHIFT_CONFLICT');
    END;

    CREATE TRIGGER trg_staff_assignments_shift_coverage_update
    BEFORE UPDATE OF employee_number, destination_location_id, destination_department_id,
      date_from, date_to, all_day, start_time, end_time, status
      ON employee_location_lendings
    WHEN NEW.status = 'active'
      AND (
        NEW.employee_number IS NOT OLD.employee_number
        OR NEW.destination_location_id IS NOT OLD.destination_location_id
        OR NEW.destination_department_id IS NOT OLD.destination_department_id
        OR NEW.date_from IS NOT OLD.date_from
        OR NEW.date_to IS NOT OLD.date_to
        OR NEW.all_day IS NOT OLD.all_day
        OR NEW.start_time IS NOT OLD.start_time
        OR NEW.end_time IS NOT OLD.end_time
        OR NEW.status IS NOT OLD.status
      )
      AND EXISTS (
        SELECT 1
        FROM shifts shift
        WHERE shift.employee_number = NEW.employee_number
          AND julianday(shift.shift_date || ' ' || shift.start_time) < julianday(
            NEW.date_to || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.end_time END,
            CASE WHEN NEW.all_day = 1 THEN '+1 day' ELSE '+0 day' END
          )
          AND julianday(
            NEW.date_from || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.start_time END
          ) < julianday(shift.shift_date || ' ' || shift.end_time)
          AND NOT (
            shift.location_id = NEW.destination_location_id
            AND (NEW.destination_department_id IS NULL
              OR shift.department_id = NEW.destination_department_id)
            AND julianday(
              NEW.date_from || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.start_time END
            ) <= julianday(shift.shift_date || ' ' || shift.start_time)
            AND julianday(shift.shift_date || ' ' || shift.end_time) <= julianday(
              NEW.date_to || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.end_time END,
              CASE WHEN NEW.all_day = 1 THEN '+1 day' ELSE '+0 day' END
            )
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'EMPLOYEE_LENDING_SHIFT_CONFLICT');
    END;

    CREATE TRIGGER trg_week_options_staff_assignment_insert
    BEFORE INSERT ON week_options
    WHEN NEW.option_type IN ('vacation', 'time_off')
      AND EXISTS (
        SELECT 1
        FROM employee_location_lendings assignment
        WHERE assignment.employee_number = NEW.employee_number
          AND assignment.status = 'active'
          AND julianday(
            NEW.date_from || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.start_time END
          ) < julianday(
            assignment.date_to || ' ' || CASE WHEN assignment.all_day = 1 THEN '00:00' ELSE assignment.end_time END,
            CASE WHEN assignment.all_day = 1 THEN '+1 day' ELSE '+0 day' END
          )
          AND julianday(
            assignment.date_from || ' ' || CASE WHEN assignment.all_day = 1 THEN '00:00' ELSE assignment.start_time END
          ) < julianday(
            NEW.date_to || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.end_time END,
            CASE WHEN NEW.all_day = 1 THEN '+1 day' ELSE '+0 day' END
          )
          AND (
            NEW.option_type = 'vacation'
            OR NOT EXISTS (
              SELECT 1
              FROM time_off_requests request
              WHERE NEW.group_id = 'za-request-' || request.id
                AND request.employee_number = NEW.employee_number
                AND request.lending_id = assignment.id
                AND request.status = 'approved'
                AND COALESCE(request.date_from, request.request_date) <= NEW.date_from
                AND COALESCE(request.date_to, request.request_date) >= NEW.date_to
                AND (
                  request.all_day = 1
                  OR (
                    NEW.all_day = 0
                    AND COALESCE(request.date_from, request.request_date) = NEW.date_from
                    AND COALESCE(request.date_to, request.request_date) = NEW.date_to
                    AND request.start_time <= NEW.start_time
                    AND request.end_time >= NEW.end_time
                  )
                )
            )
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'STAFF_ASSIGNMENT_DIRECT_ABSENCE_CONFLICT');
    END;

    CREATE TRIGGER trg_week_options_staff_assignment_update
    BEFORE UPDATE OF employee_number, group_id, date_from, date_to, option_type, all_day, start_time, end_time
      ON week_options
    WHEN NEW.option_type IN ('vacation', 'time_off')
      AND EXISTS (
        SELECT 1
        FROM employee_location_lendings assignment
        WHERE assignment.employee_number = NEW.employee_number
          AND assignment.status = 'active'
          AND julianday(
            NEW.date_from || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.start_time END
          ) < julianday(
            assignment.date_to || ' ' || CASE WHEN assignment.all_day = 1 THEN '00:00' ELSE assignment.end_time END,
            CASE WHEN assignment.all_day = 1 THEN '+1 day' ELSE '+0 day' END
          )
          AND julianday(
            assignment.date_from || ' ' || CASE WHEN assignment.all_day = 1 THEN '00:00' ELSE assignment.start_time END
          ) < julianday(
            NEW.date_to || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.end_time END,
            CASE WHEN NEW.all_day = 1 THEN '+1 day' ELSE '+0 day' END
          )
          AND (
            NEW.option_type = 'vacation'
            OR NOT EXISTS (
              SELECT 1
              FROM time_off_requests request
              WHERE NEW.group_id = 'za-request-' || request.id
                AND request.employee_number = NEW.employee_number
                AND request.lending_id = assignment.id
                AND request.status = 'approved'
                AND COALESCE(request.date_from, request.request_date) <= NEW.date_from
                AND COALESCE(request.date_to, request.request_date) >= NEW.date_to
                AND (
                  request.all_day = 1
                  OR (
                    NEW.all_day = 0
                    AND COALESCE(request.date_from, request.request_date) = NEW.date_from
                    AND COALESCE(request.date_to, request.request_date) = NEW.date_to
                    AND request.start_time <= NEW.start_time
                    AND request.end_time >= NEW.end_time
                  )
                )
            )
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'STAFF_ASSIGNMENT_DIRECT_ABSENCE_CONFLICT');
    END;
  `);
}

function shiftLocationForeignKeyPresent() {
  return db.prepare("PRAGMA foreign_key_list(shifts)").all()
    .some((row) => row.from === "location_id" && row.table === "locations" && row.to === "id");
}

function migrateShiftLocations() {
  db.prepare(`
    UPDATE shifts
    SET location_id = COALESCE(
      (SELECT d.location_id FROM departments d WHERE d.id = shifts.department_id),
      (SELECT e.home_location_id FROM employees e WHERE e.personnel_number = shifts.employee_number)
    )
    WHERE TRIM(COALESCE(location_id, '')) = ''
      OR NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = shifts.location_id)
  `).run();
  const invalid = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM shifts s
    LEFT JOIN locations l ON l.id = s.location_id
    LEFT JOIN departments d ON d.id = s.department_id
    WHERE l.id IS NULL
       OR (s.department_id IS NOT NULL AND (d.id IS NULL OR d.location_id <> s.location_id))
  `).get().count || 0);
  if (invalid) throw new Error(`Einsatzfilialen-Migration unvollständig: ${invalid} Dienst(e).`);

  if (!shiftLocationForeignKeyPresent()) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE shifts_v071 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_number TEXT NOT NULL,
          location_id TEXT,
          department_id INTEGER,
          shift_date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          area TEXT NOT NULL DEFAULT '',
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
            ON UPDATE CASCADE ON DELETE CASCADE,
          FOREIGN KEY (location_id) REFERENCES locations(id)
            ON UPDATE CASCADE ON DELETE RESTRICT,
          FOREIGN KEY (department_id) REFERENCES departments(id)
            ON UPDATE CASCADE ON DELETE SET NULL
        );
        INSERT INTO shifts_v071
          (id, employee_number, location_id, department_id, shift_date, start_time, end_time, area, note, created_at)
        SELECT id, employee_number, location_id, department_id, shift_date, start_time, end_time, area, note, created_at
        FROM shifts;
        DROP TABLE shifts;
        ALTER TABLE shifts_v071 RENAME TO shifts;
      `);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(shift_date)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_shifts_employee ON shifts(employee_number)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_shifts_location_date ON shifts(location_id, shift_date)");
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
    .run(shiftLocationMigrationId, packageMetadata.version);
  installShiftLocationIntegrityTriggers();
}

migrateShiftLocations();

function freezeLegacyLocationBranding() {
  const migrationId = "v0.53.1-branch-branding-snapshots";
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(migrationId)) return;
  const settings = getSettings();
  const branding = brandingFromSettings(settings);
  const neutralBranding = brandingFromSettings(defaultSettings);
  const isNeutral = ["companyName", "logoUrl", "iconUrl", "logoAlt", "adminEmail"]
    .every((key) => branding[key] === neutralBranding[key]);
  const kitId = String(settings.branding_management_kit_id || "").trim() || (isNeutral ? "neutral" : "custom");
  const insertSnapshot = db.prepare(`
    INSERT OR IGNORE INTO location_branding
      (location_id, kit_id, company_name, logo_url, icon_url, logo_alt, admin_email, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'migration', CURRENT_TIMESTAMP)
  `);
  db.exec("BEGIN");
  try {
    for (const location of db.prepare("SELECT id FROM locations ORDER BY id").all()) {
      insertSnapshot.run(location.id, kitId, branding.companyName, branding.logoUrl, branding.iconUrl, branding.logoAlt, branding.adminEmail);
    }
    db.prepare("INSERT INTO schema_migrations (id, app_version) VALUES (?, ?)").run(migrationId, packageMetadata.version);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

freezeLegacyLocationBranding();

  return Object.freeze({
    ensureDefaultLocation,
  });
}

module.exports = {
  runSqliteOrganizationSchemaMigrations,
};
