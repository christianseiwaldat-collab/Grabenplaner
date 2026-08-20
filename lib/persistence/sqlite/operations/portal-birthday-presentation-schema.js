"use strict";

const PORTAL_BIRTHDAY_PRESENTATION_MIGRATION_ID =
  "v0.92.10-portal-birthday-presentation-settings";
const PORTAL_BIRTHDAY_PRESENTATION_CATALOG_MIGRATION_ID =
  "v0.92.10-portal-birthday-presentation-catalog";

function definition(name, sql) {
  return Object.freeze({ name, sql: String(sql || "").trim() });
}

const UTC_TIMESTAMP_DEFAULT = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

const PORTAL_BIRTHDAY_PRESENTATION_POLICY_TABLE_DEFINITION =
  definition("portal_birthday_presentation_policy", `
    CREATE TABLE IF NOT EXISTS portal_birthday_presentation_policy (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      updated_at TEXT NOT NULL DEFAULT ${UTC_TIMESTAMP_DEFAULT}
        CHECK(TRIM(updated_at) <> '')
    )
  `);

const PORTAL_BIRTHDAY_PRESENTATION_ASSIGNMENT_TABLE_DEFINITION =
  definition("portal_birthday_presentation_assignments", `
    CREATE TABLE IF NOT EXISTS portal_birthday_presentation_assignments (
      employee_number TEXT PRIMARY KEY
        CHECK(length(TRIM(employee_number)) BETWEEN 1 AND 120),
      presentation_id TEXT NOT NULL DEFAULT 'off'
        CHECK(presentation_id IN (
          'off', 'standard', 'elegant', 'farbenfroh', 'fotowelt', 'technik'
        )),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      created_at TEXT NOT NULL DEFAULT ${UTC_TIMESTAMP_DEFAULT}
        CHECK(TRIM(created_at) <> ''),
      updated_at TEXT NOT NULL DEFAULT ${UTC_TIMESTAMP_DEFAULT}
        CHECK(TRIM(updated_at) <> ''),
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `);

const PORTAL_BIRTHDAY_PRESENTATION_LEGACY_V1_ASSIGNMENT_TABLE_DEFINITION =
  definition("portal_birthday_presentation_assignments", `
    CREATE TABLE IF NOT EXISTS portal_birthday_presentation_assignments (
      employee_number TEXT PRIMARY KEY
        CHECK(length(TRIM(employee_number)) BETWEEN 1 AND 120),
      presentation_id TEXT NOT NULL DEFAULT 'off'
        CHECK(presentation_id IN ('off', 'standard')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      created_at TEXT NOT NULL DEFAULT ${UTC_TIMESTAMP_DEFAULT}
        CHECK(TRIM(created_at) <> ''),
      updated_at TEXT NOT NULL DEFAULT ${UTC_TIMESTAMP_DEFAULT}
        CHECK(TRIM(updated_at) <> ''),
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `);

const PORTAL_BIRTHDAY_PRESENTATION_TABLE_DEFINITIONS = Object.freeze([
  PORTAL_BIRTHDAY_PRESENTATION_POLICY_TABLE_DEFINITION,
  PORTAL_BIRTHDAY_PRESENTATION_ASSIGNMENT_TABLE_DEFINITION,
]);

const PORTAL_BIRTHDAY_PRESENTATION_LEGACY_V1_TABLE_DEFINITIONS = Object.freeze([
  PORTAL_BIRTHDAY_PRESENTATION_POLICY_TABLE_DEFINITION,
  PORTAL_BIRTHDAY_PRESENTATION_LEGACY_V1_ASSIGNMENT_TABLE_DEFINITION,
]);

const PORTAL_BIRTHDAY_PRESENTATION_STORAGE_IDS = Object.freeze([
  "off",
  "standard",
  "elegant",
  "farbenfroh",
  "fotowelt",
  "technik",
]);
const PORTAL_BIRTHDAY_PRESENTATION_STORAGE_ID_SET = new Set(
  PORTAL_BIRTHDAY_PRESENTATION_STORAGE_IDS,
);
const PORTAL_BIRTHDAY_PRESENTATION_LEGACY_V1_STORAGE_ID_SET = new Set([
  "off",
  "standard",
]);

const PORTAL_BIRTHDAY_PRESENTATION_TABLE_NAMES = Object.freeze(
  PORTAL_BIRTHDAY_PRESENTATION_TABLE_DEFINITIONS.map(({ name }) => name),
);

const PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_DEFINITIONS = Object.freeze([
  definition("trg_portal_birthday_presentation_policy_revision", `
    CREATE TRIGGER IF NOT EXISTS trg_portal_birthday_presentation_policy_revision
    BEFORE UPDATE ON portal_birthday_presentation_policy
    WHEN NEW.singleton_id IS NOT OLD.singleton_id
      OR NEW.enabled IS OLD.enabled
      OR NEW.revision IS NOT OLD.revision + 1
      OR NEW.updated_at IS OLD.updated_at
    BEGIN
      SELECT RAISE(ABORT, 'portal birthday policy revision is invalid');
    END
  `),
  definition("trg_portal_birthday_presentation_policy_no_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_portal_birthday_presentation_policy_no_delete
    BEFORE DELETE ON portal_birthday_presentation_policy
    BEGIN
      SELECT RAISE(ABORT, 'portal birthday policy cannot be deleted');
    END
  `),
  definition("trg_portal_birthday_presentation_assignment_revision", `
    CREATE TRIGGER IF NOT EXISTS trg_portal_birthday_presentation_assignment_revision
    BEFORE UPDATE ON portal_birthday_presentation_assignments
    WHEN NEW.employee_number IS NOT OLD.employee_number
      OR NEW.presentation_id IS OLD.presentation_id
      OR NEW.revision IS NOT OLD.revision + 1
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.updated_at IS OLD.updated_at
    BEGIN
      SELECT RAISE(ABORT, 'portal birthday assignment revision is invalid');
    END
  `),
  definition("trg_portal_birthday_presentation_assignment_no_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_portal_birthday_presentation_assignment_no_delete
    BEFORE DELETE ON portal_birthday_presentation_assignments
    BEGIN
      SELECT RAISE(ABORT, 'portal birthday assignment cannot be deleted');
    END
  `),
]);

const PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_NAMES = Object.freeze(
  PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_DEFINITIONS.map(({ name }) => name),
);

const PORTAL_BIRTHDAY_PRESENTATION_REQUIRED_TABLES = Object.freeze(["employees"]);

function normalizeDefinitionSql(sql, type) {
  let normalized = String(sql || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .toLowerCase();
  if (type === "table") {
    normalized = normalized.replace(/^create table if not exists /, "create table ");
  } else if (type === "trigger") {
    normalized = normalized.replace(/^create trigger if not exists /, "create trigger ");
  }
  return normalized;
}

function inspectDefinitions(database, type, definitions) {
  const read = database.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?");
  const missing = [];
  const invalid = [];
  for (const item of definitions) {
    const stored = read.get(type, item.name);
    if (!stored?.sql) missing.push(item.name);
    else if (normalizeDefinitionSql(stored.sql, type)
      !== normalizeDefinitionSql(item.sql, type)) invalid.push(item.name);
  }
  return Object.freeze({
    missing: Object.freeze(missing),
    invalid: Object.freeze(invalid),
  });
}

function inspectSqlitePortalBirthdayPresentationSchemaAgainst(
  database,
  tableDefinitions,
) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benötigt.");
  }
  const tables = inspectDefinitions(
    database,
    "table",
    tableDefinitions,
  );
  const triggers = inspectDefinitions(
    database,
    "trigger",
    PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_DEFINITIONS,
  );
  const issues = Object.freeze([
    ...tables.missing.map((name) => `table-missing:${name}`),
    ...tables.invalid.map((name) => `table-invalid:${name}`),
    ...triggers.missing.map((name) => `trigger-missing:${name}`),
    ...triggers.invalid.map((name) => `trigger-invalid:${name}`),
  ]);
  const present = tables.missing.length < tableDefinitions.length
    || triggers.missing.length < PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_DEFINITIONS.length;
  return Object.freeze({
    valid: issues.length === 0,
    absent: !present,
    issues,
    missingTables: tables.missing,
    invalidTables: tables.invalid,
    missingTriggers: triggers.missing,
    invalidTriggers: triggers.invalid,
  });
}

function inspectSqlitePortalBirthdayPresentationSchema(database) {
  return inspectSqlitePortalBirthdayPresentationSchemaAgainst(
    database,
    PORTAL_BIRTHDAY_PRESENTATION_TABLE_DEFINITIONS,
  );
}

function inspectSqlitePortalBirthdayPresentationLegacyV1Schema(database) {
  return inspectSqlitePortalBirthdayPresentationSchemaAgainst(
    database,
    PORTAL_BIRTHDAY_PRESENTATION_LEGACY_V1_TABLE_DEFINITIONS,
  );
}

function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
}

function validUtcTimestamp(value) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function inspectSqlitePortalBirthdayPresentationRowsAgainst(
  database,
  schema,
  allowedPresentationIds,
) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benötigt.");
  }
  if (schema.absent) {
    return Object.freeze({ valid: true, absent: true, issues: Object.freeze([]) });
  }
  if (!schema.valid) {
    return Object.freeze({
      valid: false,
      absent: false,
      issues: Object.freeze(["schema-invalid"]),
    });
  }

  const issues = [];
  for (const dependency of PORTAL_BIRTHDAY_PRESENTATION_REQUIRED_TABLES) {
    if (!tableExists(database, dependency)) issues.push(`dependency-missing:${dependency}`);
  }
  if (issues.length) {
    return Object.freeze({ valid: false, absent: false, issues: Object.freeze(issues) });
  }

  for (const tableName of PORTAL_BIRTHDAY_PRESENTATION_TABLE_NAMES) {
    for (const violation of database.prepare(`PRAGMA foreign_key_check("${tableName}")`).all()) {
      issues.push(`foreign-key:${tableName}:${violation.rowid ?? "unknown"}`);
    }
  }

  const policies = database.prepare(`
    SELECT singleton_id, enabled, revision, updated_at
    FROM portal_birthday_presentation_policy
    ORDER BY singleton_id
  `).all();
  if (policies.length !== 1) {
    issues.push("policy-singleton-invalid");
  } else {
    const policy = policies[0];
    if (Number(policy.singleton_id) !== 1
      || ![0, 1].includes(Number(policy.enabled))
      || !Number.isSafeInteger(Number(policy.revision))
      || Number(policy.revision) < 1
      || !validUtcTimestamp(policy.updated_at)) {
      issues.push("policy-row-invalid");
    }
  }

  for (const row of database.prepare(`
    SELECT employee_number, presentation_id, revision, created_at, updated_at
    FROM portal_birthday_presentation_assignments
    ORDER BY employee_number
  `).all()) {
    const employeeNumber = String(row.employee_number || "");
    if (!employeeNumber.trim()
      || employeeNumber !== employeeNumber.trim()
      || employeeNumber.length > 120
      || !allowedPresentationIds.has(row.presentation_id)
      || !Number.isSafeInteger(Number(row.revision))
      || Number(row.revision) < 1
      || !validUtcTimestamp(row.created_at)
      || !validUtcTimestamp(row.updated_at)) {
      issues.push(`assignment-row-invalid:${employeeNumber || "missing"}`);
    }
  }

  return Object.freeze({
    valid: issues.length === 0,
    absent: false,
    issues: Object.freeze([...new Set(issues)]),
  });
}

function inspectSqlitePortalBirthdayPresentationRows(database) {
  return inspectSqlitePortalBirthdayPresentationRowsAgainst(
    database,
    inspectSqlitePortalBirthdayPresentationSchema(database),
    PORTAL_BIRTHDAY_PRESENTATION_STORAGE_ID_SET,
  );
}

function inspectSqlitePortalBirthdayPresentationLegacyV1Rows(database) {
  return inspectSqlitePortalBirthdayPresentationRowsAgainst(
    database,
    inspectSqlitePortalBirthdayPresentationLegacyV1Schema(database),
    PORTAL_BIRTHDAY_PRESENTATION_LEGACY_V1_STORAGE_ID_SET,
  );
}

function portalBirthdayPresentationCatalogMigrationError(details = []) {
  const error = new Error(
    "Das bestehende Datenfundament der Portal-Geburtstagsdarstellungen kann nicht "
      + "eindeutig als unverändertes Legacy-V1-Schema erkannt werden. Die "
      + "Katalogmigration wurde ohne Datenänderung beendet.",
  );
  error.code = "PORTAL_BIRTHDAY_PRESENTATION_CATALOG_MIGRATION_UNSAFE";
  error.details = Object.freeze([...details]);
  return error;
}

function migrateSqlitePortalBirthdayPresentationCatalogV2(database) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benötigt.");
  }
  const current = inspectSqlitePortalBirthdayPresentationSchema(database);
  if (current.valid) return Object.freeze({ migrated: false, rowsPreserved: 0 });

  const legacySchema = inspectSqlitePortalBirthdayPresentationLegacyV1Schema(database);
  const legacyRows = inspectSqlitePortalBirthdayPresentationLegacyV1Rows(database);
  if (!legacySchema.valid || !legacyRows.valid) {
    throw portalBirthdayPresentationCatalogMigrationError([
      ...(legacySchema.issues || []),
      ...(legacyRows.issues || []),
    ]);
  }

  const beforeCount = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM portal_birthday_presentation_assignments
  `).get().count);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const definitionItem of PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_DEFINITIONS) {
      if (definitionItem.name.includes("_assignment_")) {
        database.exec(`DROP TRIGGER IF EXISTS "${definitionItem.name}"`);
      }
    }
    database.exec(`
      ALTER TABLE portal_birthday_presentation_assignments
        RENAME TO portal_birthday_presentation_assignments_legacy_v1
    `);
    database.exec(PORTAL_BIRTHDAY_PRESENTATION_ASSIGNMENT_TABLE_DEFINITION.sql);
    database.exec(`
      INSERT INTO portal_birthday_presentation_assignments (
        employee_number, presentation_id, revision, created_at, updated_at
      )
      SELECT employee_number, presentation_id, revision, created_at, updated_at
      FROM portal_birthday_presentation_assignments_legacy_v1
      ORDER BY employee_number
    `);
    const afterCount = Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM portal_birthday_presentation_assignments
    `).get().count);
    if (afterCount !== beforeCount) {
      throw portalBirthdayPresentationCatalogMigrationError(["assignment-count-mismatch"]);
    }
    database.exec("DROP TABLE portal_birthday_presentation_assignments_legacy_v1");
    for (const definitionItem of PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_DEFINITIONS) {
      if (definitionItem.name.includes("_assignment_")) database.exec(definitionItem.sql);
    }
    const migratedSchema = inspectSqlitePortalBirthdayPresentationSchema(database);
    const migratedRows = inspectSqlitePortalBirthdayPresentationRows(database);
    if (!migratedSchema.valid || !migratedRows.valid) {
      throw portalBirthdayPresentationCatalogMigrationError([
        ...(migratedSchema.issues || []),
        ...(migratedRows.issues || []),
      ]);
    }
    database.exec("COMMIT");
    return Object.freeze({ migrated: true, rowsPreserved: afterCount });
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function ensureSqlitePortalBirthdayPresentationSchema(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benötigt.");
  }
  for (const item of PORTAL_BIRTHDAY_PRESENTATION_TABLE_DEFINITIONS) database.exec(item.sql);
  database.exec(`
    INSERT OR IGNORE INTO portal_birthday_presentation_policy (
      singleton_id, enabled, revision, updated_at
    ) VALUES (
      1, 0, 1, ${UTC_TIMESTAMP_DEFAULT}
    )
  `);
  for (const item of PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_DEFINITIONS) database.exec(item.sql);
}

module.exports = {
  PORTAL_BIRTHDAY_PRESENTATION_CATALOG_MIGRATION_ID,
  PORTAL_BIRTHDAY_PRESENTATION_LEGACY_V1_TABLE_DEFINITIONS,
  PORTAL_BIRTHDAY_PRESENTATION_MIGRATION_ID,
  PORTAL_BIRTHDAY_PRESENTATION_REQUIRED_TABLES,
  PORTAL_BIRTHDAY_PRESENTATION_STORAGE_IDS,
  PORTAL_BIRTHDAY_PRESENTATION_TABLE_DEFINITIONS,
  PORTAL_BIRTHDAY_PRESENTATION_TABLE_NAMES,
  PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_DEFINITIONS,
  PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_NAMES,
  ensureSqlitePortalBirthdayPresentationSchema,
  inspectSqlitePortalBirthdayPresentationLegacyV1Rows,
  inspectSqlitePortalBirthdayPresentationLegacyV1Schema,
  inspectSqlitePortalBirthdayPresentationRows,
  inspectSqlitePortalBirthdayPresentationSchema,
  migrateSqlitePortalBirthdayPresentationCatalogV2,
};
