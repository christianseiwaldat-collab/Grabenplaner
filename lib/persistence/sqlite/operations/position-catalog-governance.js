"use strict";

const POSITION_CATALOG_MIGRATION_ID = "v0.92.20-position-catalog-governance";
const POSITION_ASSIGNMENT_MIGRATION_ID = "v0.92.20-position-assignment-419";

const POSITION_CATALOG = Object.freeze([
  Object.freeze({
    id: "teamleitung",
    name: "Teamleitung",
    sortOrder: 10,
    costCenterTypeIds: Object.freeze(["branch", "administration", "production", "other"]),
  }),
  Object.freeze({
    id: "fl-stellvertretung",
    name: "FL Stellvertretung",
    sortOrder: 20,
    costCenterTypeIds: Object.freeze(["branch"]),
  }),
  Object.freeze({
    id: "abteilungsleitung",
    name: "Abteilungsleitung",
    sortOrder: 30,
    costCenterTypeIds: Object.freeze(["branch", "administration", "production", "other"]),
  }),
  Object.freeze({
    id: "verkaufsmitarbeiter",
    name: "Verkaufsmitarbeiter",
    sortOrder: 40,
    isDefault: true,
    costCenterTypeIds: Object.freeze(["branch", "administration", "production", "other"]),
  }),
  Object.freeze({
    id: "lehrling",
    name: "Lehrling",
    sortOrder: 50,
    employmentClassification: "apprentice",
    costCenterTypeIds: Object.freeze(["branch", "administration", "production", "other"]),
  }),
  Object.freeze({
    id: "logistik",
    name: "Logistik",
    sortOrder: 100,
    costCenterTypeIds: Object.freeze(["administration"]),
  }),
  Object.freeze({
    id: "it",
    name: "IT",
    sortOrder: 110,
    costCenterTypeIds: Object.freeze(["administration"]),
  }),
  Object.freeze({
    id: "personalleitung",
    name: "Personalleitung",
    sortOrder: 120,
    costCenterTypeIds: Object.freeze(["administration"]),
  }),
  Object.freeze({
    id: "buchhaltung",
    name: "Buchhaltung",
    sortOrder: 130,
    costCenterTypeIds: Object.freeze(["administration"]),
  }),
  Object.freeze({
    id: "sekretariat",
    name: "Sekretariat",
    sortOrder: 140,
    costCenterTypeIds: Object.freeze(["administration"]),
  }),
]);

function assertSqliteDatabase(database) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  return database;
}

function installSqlitePositionCatalogIntegrity(database) {
  const db = assertSqliteDatabase(database);
  db.exec(`
    DROP TRIGGER IF EXISTS trg_positions_archive_active_employees;
    DROP TRIGGER IF EXISTS trg_positions_delete_archive_only;
    DROP TRIGGER IF EXISTS trg_positions_promote_default_after_archive;
    DROP TRIGGER IF EXISTS trg_employees_active_position_insert;
    DROP TRIGGER IF EXISTS trg_employees_active_position_update;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_single_active_default
      ON positions(is_default)
      WHERE active = 1 AND is_default = 1;

    CREATE INDEX IF NOT EXISTS idx_positions_active_sort
      ON positions(active, sort_order, name);

    CREATE TRIGGER trg_positions_archive_active_employees
    BEFORE UPDATE OF active ON positions
    WHEN OLD.active = 1 AND NEW.active = 0
      AND EXISTS (
        SELECT 1
        FROM employees
        WHERE position_id = OLD.id AND active = 1
      )
    BEGIN
      SELECT RAISE(ABORT, 'POSITION_ACTIVE_EMPLOYEES_IN_USE');
    END;

    CREATE TRIGGER trg_positions_delete_archive_only
    BEFORE DELETE ON positions
    BEGIN
      SELECT RAISE(ABORT, 'POSITION_ARCHIVE_ONLY');
    END;

    CREATE TRIGGER trg_positions_promote_default_after_archive
    AFTER UPDATE OF active ON positions
    WHEN OLD.active = 1 AND NEW.active = 0 AND OLD.is_default = 1
    BEGIN
      UPDATE positions SET is_default = 0 WHERE id = NEW.id;
      UPDATE positions
      SET is_default = 1
      WHERE id = (
        SELECT id
        FROM positions
        WHERE active = 1
        ORDER BY sort_order, name COLLATE NOCASE, id
        LIMIT 1
      );
    END;

    CREATE TRIGGER trg_employees_active_position_insert
    BEFORE INSERT ON employees
    WHEN NEW.active = 1
      AND NOT EXISTS (
        SELECT 1 FROM positions WHERE id = NEW.position_id AND active = 1
      )
    BEGIN
      SELECT RAISE(ABORT, 'EMPLOYEE_POSITION_INACTIVE');
    END;

    CREATE TRIGGER trg_employees_active_position_update
    BEFORE UPDATE OF position_id, active ON employees
    WHEN NEW.active = 1
      AND NOT EXISTS (
        SELECT 1 FROM positions WHERE id = NEW.position_id AND active = 1
      )
    BEGIN
      SELECT RAISE(ABORT, 'EMPLOYEE_POSITION_INACTIVE');
    END;
  `);
}

function migrateSqlitePositionCatalogGovernance(database, { appVersion = "" } = {}) {
  const db = assertSqliteDatabase(database);
  const applied = Boolean(db.prepare(
    "SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1",
  ).get(POSITION_CATALOG_MIGRATION_ID));
  if (applied) {
    installSqlitePositionCatalogIntegrity(db);
    return Object.freeze({ applied: false, migrationId: POSITION_CATALOG_MIGRATION_ID });
  }

  const insertPosition = db.prepare(`
    INSERT INTO positions
      (id, name, builtin, active, is_default, employment_classification,
       sort_order, revision, created_by, updated_by, updated_at)
    VALUES (?, ?, 0, 1, 0, 'standard', ?, 1, 'migration', 'migration', CURRENT_TIMESTAMP)
  `);
  const findPosition = db.prepare(`
    SELECT id, name
    FROM positions
    WHERE id = ? OR name = ? COLLATE NOCASE
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `);
  const insertMapping = db.prepare(`
    INSERT OR IGNORE INTO cost_center_type_positions
      (cost_center_type_id, position_id, sort_order)
    VALUES (?, ?, ?)
  `);
  const resolvedCatalog = [];
  const insertedIds = [];

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE positions
      SET
        builtin = 0,
        active = CASE WHEN active IN (0,1) THEN active ELSE 1 END,
        is_default = CASE WHEN is_default IN (0,1) THEN is_default ELSE 0 END,
        employment_classification = CASE
          WHEN employment_classification IN ('standard','apprentice')
            THEN employment_classification
          ELSE 'standard'
        END,
        revision = CASE WHEN revision >= 1 THEN revision ELSE 1 END,
        updated_at = COALESCE(NULLIF(updated_at, ''), created_at, CURRENT_TIMESTAMP)
    `).run();

    for (const entry of POSITION_CATALOG) {
      let position = findPosition.get(entry.id, entry.name, entry.id);
      if (!position) {
        insertPosition.run(entry.id, entry.name, entry.sortOrder);
        insertedIds.push(entry.id);
        position = { id: entry.id, name: entry.name };
      }
      resolvedCatalog.push({ ...entry, resolvedId: String(position.id) });
    }

    const apprentice = resolvedCatalog.find((entry) => entry.employmentClassification === "apprentice");
    if (apprentice) {
      db.prepare(`
        UPDATE positions
        SET employment_classification = 'apprentice', updated_by = 'migration',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(apprentice.resolvedId);
    }

    db.prepare("UPDATE positions SET is_default = 0").run();
    const preferredDefault = resolvedCatalog.find((entry) => entry.isDefault);
    const activeDefault = preferredDefault
      ? db.prepare("SELECT id FROM positions WHERE id = ? AND active = 1").get(preferredDefault.resolvedId)
      : null;
    const fallbackDefault = activeDefault || db.prepare(`
      SELECT id FROM positions WHERE active = 1 ORDER BY sort_order, name COLLATE NOCASE, id LIMIT 1
    `).get();
    if (!fallbackDefault) throw new Error("Der Positionskatalog enthaelt keine aktive Standardposition.");
    db.prepare("UPDATE positions SET is_default = 1 WHERE id = ?").run(fallbackDefault.id);

    for (const entry of resolvedCatalog) {
      for (const [index, typeId] of entry.costCenterTypeIds.entries()) {
        if (db.prepare("SELECT 1 FROM cost_center_types WHERE id = ? AND active = 1").get(typeId)) {
          insertMapping.run(typeId, entry.resolvedId, index + 1);
        }
      }
    }

    db.prepare(`
      INSERT INTO audit_log (actor, action, entity_type, entity_id, detail)
      VALUES ('migration', 'position.catalog.migrate', 'position_catalog', ?, ?)
    `).run(POSITION_CATALOG_MIGRATION_ID, JSON.stringify({
      insertedIds,
      resolvedIds: Object.fromEntries(resolvedCatalog.map((entry) => [entry.id, entry.resolvedId])),
      defaultPositionId: String(fallbackDefault.id),
      allPositionsEditable: true,
      deletionMode: "archive",
    }));
    db.prepare("INSERT INTO schema_migrations (id, app_version) VALUES (?, ?)")
      .run(POSITION_CATALOG_MIGRATION_ID, String(appVersion || ""));
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }

  installSqlitePositionCatalogIntegrity(db);
  return Object.freeze({
    applied: true,
    migrationId: POSITION_CATALOG_MIGRATION_ID,
    insertedIds: Object.freeze([...insertedIds]),
  });
}

function migrateSqlitePositionCatalogAssignments(database, { appVersion = "" } = {}) {
  const db = assertSqliteDatabase(database);
  const applied = Boolean(db.prepare(
    "SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1",
  ).get(POSITION_ASSIGNMENT_MIGRATION_ID));
  if (applied) {
    return Object.freeze({
      applied: false,
      migrationId: POSITION_ASSIGNMENT_MIGRATION_ID,
      employeeFound: null,
      changed: false,
    });
  }

  const targetPosition = db.prepare(`
    SELECT id, name
    FROM positions
    WHERE id = 'fl-stellvertretung' AND active = 1
    LIMIT 1
  `).get();
  if (!targetPosition) {
    throw new Error("Die aktive Position FL Stellvertretung fehlt für die Positionszuordnung.");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const employee = db.prepare(`
      SELECT personnel_number, position_id, active
      FROM employees
      WHERE personnel_number = '419'
      LIMIT 1
    `).get();
    const changed = Boolean(employee && String(employee.position_id) !== String(targetPosition.id));
    if (changed) {
      db.prepare(`
        UPDATE employees
        SET position_id = ?
        WHERE personnel_number = '419'
      `).run(targetPosition.id);
    }

    db.prepare(`
      INSERT INTO audit_log (actor, action, entity_type, entity_id, detail)
      VALUES ('migration', 'employee.position.migrate', ?, ?, ?)
    `).run(
      employee ? "employee" : "position_assignment",
      employee ? String(employee.personnel_number) : POSITION_ASSIGNMENT_MIGRATION_ID,
      JSON.stringify({
        migrationId: POSITION_ASSIGNMENT_MIGRATION_ID,
        employeeNumber: "419",
        employeeFound: Boolean(employee),
        employeeActive: employee ? Boolean(employee.active) : null,
        beforePositionId: employee ? String(employee.position_id || "") : null,
        afterPositionId: employee ? String(targetPosition.id) : null,
        changed,
      }),
    );
    db.prepare("INSERT INTO schema_migrations (id, app_version) VALUES (?, ?)")
      .run(POSITION_ASSIGNMENT_MIGRATION_ID, String(appVersion || ""));
    db.exec("COMMIT");

    return Object.freeze({
      applied: true,
      migrationId: POSITION_ASSIGNMENT_MIGRATION_ID,
      employeeFound: Boolean(employee),
      changed,
    });
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

module.exports = {
  POSITION_CATALOG,
  POSITION_CATALOG_MIGRATION_ID,
  POSITION_ASSIGNMENT_MIGRATION_ID,
  installSqlitePositionCatalogIntegrity,
  migrateSqlitePositionCatalogAssignments,
  migrateSqlitePositionCatalogGovernance,
};
