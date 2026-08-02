"use strict";

const PERSONNEL_LIFECYCLE_MIGRATION_ID = "v0.89-personnel-lifecycle-candidate-foundation";
const PERSONNEL_LIFECYCLE_CONVERSION_MIGRATION_ID = "v0.89-personnel-lifecycle-conversion";
const PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_MIGRATION_ID = "v0.89-personnel-lifecycle-scoped-rights";
const PERSONNEL_PROFILE_SCOPED_RIGHTS_MIGRATION_ID = "v0.90-personnel-profile-scoped-rights";
const PERSONNEL_LIFECYCLE_SCOPED_PERMISSION_IDS = Object.freeze([
  "personnel:candidates:read",
  "personnel:applications:write",
  "personnel:workflows:read",
  "personnel:workflows:draft:write",
  "personnel:workflows:publish",
  "personnel:workflows:local:supplement",
  "personnel:profiles:read",
  "personnel:profiles:master:read",
]);

function tableDefinition(name, sql) {
  return Object.freeze({ name, sql: String(sql || "").trim() });
}

const PERSONNEL_LIFECYCLE_TABLE_DEFINITIONS = Object.freeze([
  tableDefinition("candidates", `
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'active'
        CHECK(state IN ('active','archived')),
      protected_payload TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `),
  tableDefinition("candidate_applications", `
    CREATE TABLE IF NOT EXISTS candidate_applications (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new'
        CHECK(status IN (
          'new','screening','first_interview','further_interview','offer','accepted',
          'preboarding','converted','rejected','withdrawn','talent_pool','archived'
        )),
      desired_position_id TEXT,
      desired_location_id TEXT,
      desired_department_id INTEGER,
      desired_weekly_minutes INTEGER
        CHECK(desired_weekly_minutes IS NULL OR desired_weekly_minutes BETWEEN 0 AND 10080),
      available_from TEXT,
      owner_employee_number TEXT,
      retention_due_at TEXT,
      protected_payload TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      status_changed_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(id, candidate_id),
      FOREIGN KEY (candidate_id) REFERENCES candidates(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (desired_position_id) REFERENCES positions(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (desired_location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (desired_department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (owner_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );
  `),
  tableDefinition("candidate_document_categories", `
    CREATE TABLE IF NOT EXISTS candidate_document_categories (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      default_visibility TEXT NOT NULL DEFAULT 'hr_confidential'
        CHECK(default_visibility IN ('hr_confidential','recruiting','scoped_leadership')),
      retention_disposition TEXT NOT NULL DEFAULT 'manual_review'
        CHECK(retention_disposition IN ('manual_review','delete','anonymize','archive')),
      default_retention_days INTEGER
        CHECK(default_retention_days IS NULL OR default_retention_days >= 1),
      transfer_eligible INTEGER NOT NULL DEFAULT 0 CHECK(transfer_eligible IN (0,1)),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      builtin INTEGER NOT NULL DEFAULT 0 CHECK(builtin IN (0,1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `),
  tableDefinition("candidate_documents", `
    CREATE TABLE IF NOT EXISTS candidate_documents (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      application_id TEXT,
      category_id TEXT NOT NULL,
      visibility TEXT NOT NULL
        CHECK(visibility IN ('hr_confidential','recruiting','scoped_leadership')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','archived','retention_review')),
      current_version INTEGER NOT NULL DEFAULT 0 CHECK(current_version >= 0),
      document_date TEXT,
      expires_on TEXT,
      retention_due_at TEXT,
      protected_payload TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(id, candidate_id),
      FOREIGN KEY (candidate_id) REFERENCES candidates(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (application_id, candidate_id) REFERENCES candidate_applications(id, candidate_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (category_id) REFERENCES candidate_document_categories(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );
  `),
  tableDefinition("candidate_document_versions", `
    CREATE TABLE IF NOT EXISTS candidate_document_versions (
      document_id TEXT NOT NULL,
      version_number INTEGER NOT NULL CHECK(version_number >= 1),
      storage_key TEXT NOT NULL UNIQUE,
      content_sha256 TEXT NOT NULL
        CHECK(
          length(content_sha256) = 64
          AND content_sha256 = lower(content_sha256)
          AND content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 1),
      media_type TEXT NOT NULL
        CHECK(media_type IN (
          'application/pdf','image/jpeg','image/png','image/webp','image/tiff'
        )),
      protected_payload TEXT NOT NULL,
      uploaded_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (document_id, version_number),
      FOREIGN KEY (document_id) REFERENCES candidate_documents(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );
  `),
  tableDefinition("candidate_events", `
    CREATE TABLE IF NOT EXISTS candidate_events (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      sequence_number INTEGER NOT NULL CHECK(sequence_number >= 1),
      application_id TEXT,
      document_id TEXT,
      event_type TEXT NOT NULL
        CHECK(event_type IN (
          'candidate_created','candidate_updated','candidate_archived',
          'application_created','application_updated','application_status_changed',
          'document_registered','document_version_added','document_archived',
          'retention_review_requested'
        )),
      protected_payload TEXT NOT NULL,
      previous_receipt_sha256 TEXT NOT NULL DEFAULT ''
        CHECK(
          previous_receipt_sha256 = ''
          OR (
            length(previous_receipt_sha256) = 64
            AND previous_receipt_sha256 = lower(previous_receipt_sha256)
            AND previous_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
          )
        ),
      receipt_sha256 TEXT NOT NULL
        CHECK(
          length(receipt_sha256) = 64
          AND receipt_sha256 = lower(receipt_sha256)
          AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
      actor_employee_number TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(candidate_id, sequence_number),
      FOREIGN KEY (candidate_id) REFERENCES candidates(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (application_id, candidate_id) REFERENCES candidate_applications(id, candidate_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (document_id, candidate_id) REFERENCES candidate_documents(id, candidate_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );
  `),
]);

const PERSONNEL_LIFECYCLE_TABLE_NAMES = Object.freeze(
  PERSONNEL_LIFECYCLE_TABLE_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LIFECYCLE_CONVERSION_TABLE_DEFINITIONS = Object.freeze([
  tableDefinition("candidate_conversions", `
    CREATE TABLE IF NOT EXISTS candidate_conversions (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL UNIQUE,
      application_id TEXT NOT NULL UNIQUE,
      employee_number TEXT NOT NULL UNIQUE,
      request_sha256 TEXT NOT NULL
        CHECK(
          length(request_sha256) = 64
          AND request_sha256 = lower(request_sha256)
          AND request_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
      protected_payload TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL
        CHECK(
          length(receipt_sha256) = 64
          AND receipt_sha256 = lower(receipt_sha256)
          AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
      actor_employee_number TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(application_id, candidate_id),
      FOREIGN KEY (candidate_id) REFERENCES candidates(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (application_id, candidate_id) REFERENCES candidate_applications(id, candidate_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
]);

const PERSONNEL_LIFECYCLE_CONVERSION_TABLE_NAMES = Object.freeze(
  PERSONNEL_LIFECYCLE_CONVERSION_TABLE_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LIFECYCLE_LEGACY_SCOPED_RIGHTS_TABLE_DEFINITION = tableDefinition(
  "portal_permission_scope_grants",
  `
    CREATE TABLE IF NOT EXISTS portal_permission_scope_grants (
      employee_number TEXT NOT NULL,
      permission TEXT NOT NULL
        CHECK(permission IN ('personnel:candidates:read','personnel:applications:write')),
      location_id TEXT NOT NULL,
      department_id INTEGER NOT NULL DEFAULT 0 CHECK(department_id >= 0),
      approved_by TEXT NOT NULL CHECK(TRIM(approved_by) <> ''),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, permission, location_id, department_id),
      FOREIGN KEY (employee_number, permission)
        REFERENCES portal_permission_grants(employee_number, permission)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );
  `,
);

const PERSONNEL_LIFECYCLE_M4_SCOPED_RIGHTS_TABLE_DEFINITION = tableDefinition(
  "portal_permission_scope_grants",
  `
    CREATE TABLE IF NOT EXISTS portal_permission_scope_grants (
      employee_number TEXT NOT NULL,
      permission TEXT NOT NULL
        CHECK(permission IN (
          'personnel:candidates:read','personnel:applications:write',
          'personnel:workflows:read','personnel:workflows:draft:write',
          'personnel:workflows:publish','personnel:workflows:local:supplement'
        )),
      location_id TEXT NOT NULL,
      department_id INTEGER NOT NULL DEFAULT 0 CHECK(department_id >= 0),
      approved_by TEXT NOT NULL CHECK(TRIM(approved_by) <> ''),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, permission, location_id, department_id),
      FOREIGN KEY (employee_number, permission)
        REFERENCES portal_permission_grants(employee_number, permission)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );
  `,
);

const PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TABLE_DEFINITIONS = Object.freeze([
  tableDefinition("portal_permission_scope_grants", `
    CREATE TABLE IF NOT EXISTS portal_permission_scope_grants (
      employee_number TEXT NOT NULL,
      permission TEXT NOT NULL
        CHECK(permission IN (
          'personnel:candidates:read','personnel:applications:write',
          'personnel:workflows:read','personnel:workflows:draft:write',
          'personnel:workflows:publish','personnel:workflows:local:supplement',
          'personnel:profiles:read','personnel:profiles:master:read'
        )),
      location_id TEXT NOT NULL,
      department_id INTEGER NOT NULL DEFAULT 0 CHECK(department_id >= 0),
      approved_by TEXT NOT NULL CHECK(TRIM(approved_by) <> ''),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, permission, location_id, department_id),
      FOREIGN KEY (employee_number, permission)
        REFERENCES portal_permission_grants(employee_number, permission)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );
  `),
]);

const PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TABLE_NAMES = Object.freeze(
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TABLE_DEFINITIONS.map(({ name }) => name),
);

function triggerDefinition(name, sql) {
  return Object.freeze({ name, sql: String(sql || "").trim() });
}

const PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS = Object.freeze([
  triggerDefinition("trg_candidate_applications_scope_insert", `
    CREATE TRIGGER IF NOT EXISTS trg_candidate_applications_scope_insert
    BEFORE INSERT ON candidate_applications
    WHEN NEW.desired_department_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM departments department
        WHERE department.id = NEW.desired_department_id
          AND department.location_id = NEW.desired_location_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'candidate application scope is invalid');
    END;
  `),
  triggerDefinition("trg_candidate_applications_scope_update", `
    CREATE TRIGGER IF NOT EXISTS trg_candidate_applications_scope_update
    BEFORE UPDATE OF desired_location_id, desired_department_id ON candidate_applications
    WHEN NEW.desired_department_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM departments department
        WHERE department.id = NEW.desired_department_id
          AND department.location_id = NEW.desired_location_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'candidate application scope is invalid');
    END;
  `),
  triggerDefinition("trg_candidate_document_versions_sequence", `
    CREATE TRIGGER IF NOT EXISTS trg_candidate_document_versions_sequence
    BEFORE INSERT ON candidate_document_versions
    WHEN NEW.version_number <> COALESCE((
      SELECT MAX(version_number) + 1
      FROM candidate_document_versions
      WHERE document_id = NEW.document_id
    ), 1)
    BEGIN
      SELECT RAISE(ABORT, 'candidate document version sequence is invalid');
    END;
  `),
  triggerDefinition("trg_candidate_document_versions_advance", `
    CREATE TRIGGER IF NOT EXISTS trg_candidate_document_versions_advance
    AFTER INSERT ON candidate_document_versions
    BEGIN
      UPDATE candidate_documents
      SET
        current_version = NEW.version_number,
        revision = revision + 1,
        updated_by = NEW.uploaded_by,
        updated_at = NEW.created_at
      WHERE id = NEW.document_id;
    END;
  `),
  triggerDefinition("trg_candidate_document_versions_immutable_update", `
    CREATE TRIGGER IF NOT EXISTS trg_candidate_document_versions_immutable_update
    BEFORE UPDATE ON candidate_document_versions
    BEGIN
      SELECT RAISE(ABORT, 'candidate document versions are immutable');
    END;
  `),
  triggerDefinition("trg_candidate_document_versions_immutable_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_candidate_document_versions_immutable_delete
    BEFORE DELETE ON candidate_document_versions
    BEGIN
      SELECT RAISE(ABORT, 'candidate document versions are immutable');
    END;
  `),
  triggerDefinition("trg_candidate_events_chain", `
    CREATE TRIGGER IF NOT EXISTS trg_candidate_events_chain
    BEFORE INSERT ON candidate_events
    WHEN NEW.sequence_number <> COALESCE((
        SELECT MAX(sequence_number) + 1
        FROM candidate_events
        WHERE candidate_id = NEW.candidate_id
      ), 1)
      OR NEW.previous_receipt_sha256 <> COALESCE((
        SELECT receipt_sha256
        FROM candidate_events
        WHERE candidate_id = NEW.candidate_id
        ORDER BY sequence_number DESC
        LIMIT 1
      ), '')
    BEGIN
      SELECT RAISE(ABORT, 'candidate event chain is invalid');
    END;
  `),
  triggerDefinition("trg_candidate_events_immutable_update", `
    CREATE TRIGGER IF NOT EXISTS trg_candidate_events_immutable_update
    BEFORE UPDATE ON candidate_events
    BEGIN
      SELECT RAISE(ABORT, 'candidate events are immutable');
    END;
  `),
  triggerDefinition("trg_candidate_events_immutable_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_candidate_events_immutable_delete
    BEFORE DELETE ON candidate_events
    BEGIN
      SELECT RAISE(ABORT, 'candidate events are immutable');
    END;
  `),
]);

const PERSONNEL_LIFECYCLE_TRIGGER_NAMES = Object.freeze(
  PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS = Object.freeze([
  triggerDefinition("trg_candidate_conversions_immutable_update", `
    CREATE TRIGGER IF NOT EXISTS trg_candidate_conversions_immutable_update
    BEFORE UPDATE ON candidate_conversions
    BEGIN
      SELECT RAISE(ABORT, 'candidate conversions are immutable');
    END;
  `),
  triggerDefinition("trg_candidate_conversions_immutable_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_candidate_conversions_immutable_delete
    BEFORE DELETE ON candidate_conversions
    BEGIN
      SELECT RAISE(ABORT, 'candidate conversions are immutable');
    END;
  `),
]);

const PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_NAMES = Object.freeze(
  PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS = Object.freeze([
  triggerDefinition("trg_portal_access_scopes_department_insert", `
    CREATE TRIGGER IF NOT EXISTS trg_portal_access_scopes_department_insert
    BEFORE INSERT ON portal_access_scopes
    WHEN NEW.department_id <> 0
      AND NOT EXISTS (
        SELECT 1
        FROM departments department
        WHERE department.id = NEW.department_id
          AND department.location_id = NEW.location_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'portal access scope is invalid');
    END;
  `),
  triggerDefinition("trg_portal_access_scopes_department_update", `
    CREATE TRIGGER IF NOT EXISTS trg_portal_access_scopes_department_update
    BEFORE UPDATE OF location_id, department_id ON portal_access_scopes
    WHEN NEW.department_id <> 0
      AND NOT EXISTS (
        SELECT 1
        FROM departments department
        WHERE department.id = NEW.department_id
          AND department.location_id = NEW.location_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'portal access scope is invalid');
    END;
  `),
  triggerDefinition("trg_portal_permission_scope_grants_scope_insert", `
    CREATE TRIGGER IF NOT EXISTS trg_portal_permission_scope_grants_scope_insert
    BEFORE INSERT ON portal_permission_scope_grants
    WHEN (
        NEW.department_id <> 0
        AND NOT EXISTS (
          SELECT 1
          FROM departments department
          WHERE department.id = NEW.department_id
            AND department.location_id = NEW.location_id
        )
      )
      OR NOT EXISTS (
        SELECT 1
        FROM portal_access_scopes scope
        WHERE scope.employee_number = NEW.employee_number
          AND scope.location_id = NEW.location_id
          AND (scope.department_id = 0 OR scope.department_id = NEW.department_id)
      )
    BEGIN
      SELECT RAISE(ABORT, 'permission scope grant is outside the portal access scope');
    END;
  `),
  triggerDefinition("trg_portal_permission_scope_grants_scope_update", `
    CREATE TRIGGER IF NOT EXISTS trg_portal_permission_scope_grants_scope_update
    BEFORE UPDATE OF employee_number, permission, location_id, department_id
      ON portal_permission_scope_grants
    WHEN (
        NEW.department_id <> 0
        AND NOT EXISTS (
          SELECT 1
          FROM departments department
          WHERE department.id = NEW.department_id
            AND department.location_id = NEW.location_id
        )
      )
      OR NOT EXISTS (
        SELECT 1
        FROM portal_access_scopes scope
        WHERE scope.employee_number = NEW.employee_number
          AND scope.location_id = NEW.location_id
          AND (scope.department_id = 0 OR scope.department_id = NEW.department_id)
      )
    BEGIN
      SELECT RAISE(ABORT, 'permission scope grant is outside the portal access scope');
    END;
  `),
  triggerDefinition("trg_portal_access_scopes_permission_scope_cleanup_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_portal_access_scopes_permission_scope_cleanup_delete
    AFTER DELETE ON portal_access_scopes
    BEGIN
      DELETE FROM portal_permission_scope_grants
      WHERE employee_number = OLD.employee_number
        AND NOT EXISTS (
          SELECT 1
          FROM portal_access_scopes scope
          WHERE scope.employee_number = portal_permission_scope_grants.employee_number
            AND scope.location_id = portal_permission_scope_grants.location_id
            AND (
              scope.department_id = 0
              OR scope.department_id = portal_permission_scope_grants.department_id
            )
        );
    END;
  `),
  triggerDefinition("trg_portal_access_scopes_permission_scope_cleanup_update", `
    CREATE TRIGGER IF NOT EXISTS trg_portal_access_scopes_permission_scope_cleanup_update
    AFTER UPDATE OF employee_number, location_id, department_id ON portal_access_scopes
    BEGIN
      DELETE FROM portal_permission_scope_grants
      WHERE employee_number IN (OLD.employee_number, NEW.employee_number)
        AND NOT EXISTS (
          SELECT 1
          FROM portal_access_scopes scope
          WHERE scope.employee_number = portal_permission_scope_grants.employee_number
            AND scope.location_id = portal_permission_scope_grants.location_id
            AND (
              scope.department_id = 0
              OR scope.department_id = portal_permission_scope_grants.department_id
            )
        );
    END;
  `),
  triggerDefinition("trg_departments_portal_scopes_restrict_update", `
    CREATE TRIGGER IF NOT EXISTS trg_departments_portal_scopes_restrict_update
    BEFORE UPDATE OF id, location_id ON departments
    WHEN (NEW.id <> OLD.id OR NEW.location_id <> OLD.location_id)
      AND (
        EXISTS (
          SELECT 1 FROM portal_access_scopes scope
          WHERE scope.department_id = OLD.id
        )
        OR EXISTS (
          SELECT 1 FROM portal_permission_scope_grants permission_scope
          WHERE permission_scope.department_id = OLD.id
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'department is referenced by a portal scope');
    END;
  `),
  triggerDefinition("trg_departments_portal_scopes_restrict_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_departments_portal_scopes_restrict_delete
    BEFORE DELETE ON departments
    WHEN EXISTS (
        SELECT 1 FROM portal_access_scopes scope
        WHERE scope.department_id = OLD.id
      )
      OR EXISTS (
        SELECT 1 FROM portal_permission_scope_grants permission_scope
        WHERE permission_scope.department_id = OLD.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'department is referenced by a portal scope');
    END;
  `),
]);

const PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_NAMES = Object.freeze(
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS.map(({ name }) => name),
);

function normalizeSqliteSchemaDefinitionSql(sql, type) {
  const createPrefix = type === "table"
    ? /^create table if not exists /i
    : /^create trigger if not exists /i;
  return String(sql || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .replace(createPrefix, `create ${type} `)
    .toLowerCase();
}

function inspectDefinitions(database, type, definitions) {
  const readDefinition = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
  );
  const missing = [];
  const invalid = [];
  for (const definition of definitions) {
    const stored = readDefinition.get(type, definition.name);
    if (!stored?.sql) {
      missing.push(definition.name);
    } else if (normalizeSqliteSchemaDefinitionSql(stored.sql, type)
      !== normalizeSqliteSchemaDefinitionSql(definition.sql, type)) {
      invalid.push(definition.name);
    }
  }
  return {
    missing: Object.freeze(missing),
    invalid: Object.freeze(invalid),
  };
}

function inspectSqlitePersonnelLifecycleSchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const tables = inspectDefinitions(
    database,
    "table",
    PERSONNEL_LIFECYCLE_TABLE_DEFINITIONS,
  );
  const triggers = inspectDefinitions(
    database,
    "trigger",
    PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS,
  );
  const issues = Object.freeze([
    ...tables.missing.map((name) => `table-missing:${name}`),
    ...tables.invalid.map((name) => `table-invalid:${name}`),
    ...triggers.missing.map((name) => `trigger-missing:${name}`),
    ...triggers.invalid.map((name) => `trigger-invalid:${name}`),
  ]);
  return Object.freeze({
    valid: issues.length === 0,
    absent: tables.missing.length === PERSONNEL_LIFECYCLE_TABLE_DEFINITIONS.length,
    issues,
    missingTables: tables.missing,
    invalidTables: tables.invalid,
    missingTriggers: triggers.missing,
    invalidTriggers: triggers.invalid,
  });
}

function inspectSqlitePersonnelLifecycleConversionSchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const tables = inspectDefinitions(
    database,
    "table",
    PERSONNEL_LIFECYCLE_CONVERSION_TABLE_DEFINITIONS,
  );
  const triggers = inspectDefinitions(
    database,
    "trigger",
    PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS,
  );
  const issues = Object.freeze([
    ...tables.missing.map((name) => `table-missing:${name}`),
    ...tables.invalid.map((name) => `table-invalid:${name}`),
    ...triggers.missing.map((name) => `trigger-missing:${name}`),
    ...triggers.invalid.map((name) => `trigger-invalid:${name}`),
  ]);
  return Object.freeze({
    valid: issues.length === 0,
    absent: tables.missing.length === PERSONNEL_LIFECYCLE_CONVERSION_TABLE_DEFINITIONS.length,
    issues,
    missingTables: tables.missing,
    invalidTables: tables.invalid,
    missingTriggers: triggers.missing,
    invalidTriggers: triggers.invalid,
  });
}

function inspectSqlitePersonnelLifecycleScopedRightsSchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const tables = inspectDefinitions(
    database,
    "table",
    PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TABLE_DEFINITIONS,
  );
  const triggers = inspectDefinitions(
    database,
    "trigger",
    PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS,
  );
  const issues = Object.freeze([
    ...tables.missing.map((name) => `table-missing:${name}`),
    ...tables.invalid.map((name) => `table-invalid:${name}`),
    ...triggers.missing.map((name) => `trigger-missing:${name}`),
    ...triggers.invalid.map((name) => `trigger-invalid:${name}`),
  ]);
  return Object.freeze({
    valid: issues.length === 0,
    absent: tables.missing.length === PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TABLE_DEFINITIONS.length
      && triggers.missing.length === PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS.length,
    issues,
    missingTables: tables.missing,
    invalidTables: tables.invalid,
    missingTriggers: triggers.missing,
    invalidTriggers: triggers.invalid,
  });
}

function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function tableHasColumns(database, name, columns) {
  if (!tableExists(database, name)) return false;
  const present = new Set(database.prepare(`PRAGMA table_info("${name}")`).all()
    .map((column) => String(column.name || "")));
  return columns.every((column) => present.has(column));
}

function inspectSqlitePersonnelLifecycleScopedRightsRows(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const schema = inspectSqlitePersonnelLifecycleScopedRightsSchema(database);
  let invalidPortalAccessScopes = [];
  if (tableExists(database, "portal_access_scopes")) {
    if (!tableHasColumns(database, "portal_access_scopes", [
      "employee_number", "location_id", "department_id",
    ]) || !tableHasColumns(database, "departments", ["id", "location_id"])) {
      invalidPortalAccessScopes = [{ schema_invalid: 1 }];
    } else {
      try {
        invalidPortalAccessScopes = database.prepare(`
          SELECT scope.employee_number, scope.location_id, scope.department_id
          FROM portal_access_scopes scope
          WHERE scope.department_id <> 0
            AND NOT EXISTS (
              SELECT 1
              FROM departments department
              WHERE department.id = scope.department_id
                AND department.location_id = scope.location_id
            )
          ORDER BY scope.employee_number, scope.location_id, scope.department_id
        `).all();
      } catch {
        invalidPortalAccessScopes = [{ inspection_failed: 1 }];
      }
    }
  }
  let invalidPermissionScopes = [];
  if (tableExists(database, "portal_permission_scope_grants")) {
    const dependenciesPresent = tableHasColumns(database, "portal_permission_scope_grants", [
      "employee_number", "permission", "location_id", "department_id",
      "approved_by", "created_at", "updated_at",
    ]) && tableHasColumns(database, "portal_permission_grants", [
      "employee_number", "permission",
    ]) && tableHasColumns(database, "portal_access_scopes", [
      "employee_number", "location_id", "department_id",
    ]) && tableHasColumns(database, "locations", ["id"])
      && tableHasColumns(database, "departments", ["id", "location_id"]);
    if (!dependenciesPresent) {
      invalidPermissionScopes = [{ dependency_missing: 1 }];
    } else {
      try {
        invalidPermissionScopes = database.prepare(`
        SELECT scoped.employee_number, scoped.permission,
               scoped.location_id, scoped.department_id
        FROM portal_permission_scope_grants scoped
        WHERE scoped.permission NOT IN (
            'personnel:candidates:read',
            'personnel:applications:write',
            'personnel:workflows:read',
            'personnel:workflows:draft:write',
            'personnel:workflows:publish',
            'personnel:workflows:local:supplement',
            'personnel:profiles:read',
            'personnel:profiles:master:read'
          )
          OR TRIM(scoped.approved_by) = ''
          OR NOT EXISTS (
            SELECT 1
            FROM portal_permission_grants permission_grant
            WHERE permission_grant.employee_number = scoped.employee_number
              AND permission_grant.permission = scoped.permission
          )
          OR NOT EXISTS (
            SELECT 1 FROM locations location
            WHERE location.id = scoped.location_id
          )
          OR (
            scoped.department_id <> 0
            AND NOT EXISTS (
              SELECT 1
              FROM departments department
              WHERE department.id = scoped.department_id
                AND department.location_id = scoped.location_id
            )
          )
          OR NOT EXISTS (
            SELECT 1
            FROM portal_access_scopes access_scope
            WHERE access_scope.employee_number = scoped.employee_number
              AND access_scope.location_id = scoped.location_id
              AND (
                access_scope.department_id = 0
                OR access_scope.department_id = scoped.department_id
              )
          )
        ORDER BY scoped.employee_number, scoped.permission,
                 scoped.location_id, scoped.department_id
        `).all();
      } catch {
        invalidPermissionScopes = [{ inspection_failed: 1 }];
      }
    }
  }
  const issues = Object.freeze([
    ...(schema.valid || schema.absent ? [] : ["schema-invalid"]),
    ...(invalidPortalAccessScopes.length ? ["portal-access-scope-invalid"] : []),
    ...(invalidPermissionScopes.length ? ["permission-scope-grant-invalid"] : []),
  ]);
  return Object.freeze({
    valid: issues.length === 0,
    absent: schema.absent,
    issues,
    invalidPortalAccessScopes: Object.freeze(invalidPortalAccessScopes),
    invalidPermissionScopes: Object.freeze(invalidPermissionScopes),
  });
}

function inspectSqlitePersonnelLifecycleScopedRightsCompatibility(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const schema = inspectSqlitePersonnelLifecycleScopedRightsSchema(database);
  const rows = inspectSqlitePersonnelLifecycleScopedRightsRows(database);
  const rowDataValid = rows.invalidPortalAccessScopes.length === 0
    && rows.invalidPermissionScopes.length === 0;
  if (schema.absent && rows.valid) {
    return Object.freeze({
      valid: true,
      state: "pre-r1-compatible",
      predecessorVersion: null,
    });
  }
  if (schema.valid && rows.valid) {
    return Object.freeze({
      valid: true,
      state: "m7",
      predecessorVersion: null,
    });
  }
  const stored = tableExists(database, "portal_permission_scope_grants")
    ? database.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'portal_permission_scope_grants'
      `).get()
    : null;
  const storedSql = normalizeSqliteSchemaDefinitionSql(stored?.sql, "table");
  const predecessorVersion = [
    ["r1", PERSONNEL_LIFECYCLE_LEGACY_SCOPED_RIGHTS_TABLE_DEFINITION],
    ["m4", PERSONNEL_LIFECYCLE_M4_SCOPED_RIGHTS_TABLE_DEFINITION],
  ].find(([, definition]) => storedSql
    === normalizeSqliteSchemaDefinitionSql(definition.sql, "table"))?.[0] || null;
  const predecessorSchemaValid = predecessorVersion !== null
    && schema.missingTables.length === 0
    && schema.invalidTables.length === 1
    && schema.invalidTables[0] === "portal_permission_scope_grants"
    && schema.missingTriggers.length === 0
    && schema.invalidTriggers.length === 0;
  if (predecessorSchemaValid && rowDataValid) {
    return Object.freeze({
      valid: true,
      state: `pre-m7-${predecessorVersion}-compatible`,
      predecessorVersion,
    });
  }
  return Object.freeze({
    valid: false,
    state: "invalid",
    predecessorVersion,
  });
}

function assertSqliteOperationsDatabase(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  return database;
}

function ensureSqlitePersonnelLifecycleSchema(database) {
  const sqliteDatabase = assertSqliteOperationsDatabase(database);
  for (const definition of PERSONNEL_LIFECYCLE_TABLE_DEFINITIONS) {
    sqliteDatabase.exec(definition.sql);
  }
  sqliteDatabase.exec(`
    CREATE INDEX IF NOT EXISTS idx_candidate_applications_candidate_status
      ON candidate_applications(candidate_id, status, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_candidate_applications_scope
      ON candidate_applications(desired_location_id, desired_department_id, status);
    CREATE INDEX IF NOT EXISTS idx_candidate_documents_candidate_status
      ON candidate_documents(candidate_id, status, category_id, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_candidate_documents_retention
      ON candidate_documents(retention_due_at, status);
    CREATE INDEX IF NOT EXISTS idx_candidate_document_versions_document
      ON candidate_document_versions(document_id, version_number);
    CREATE INDEX IF NOT EXISTS idx_candidate_events_candidate_sequence
      ON candidate_events(candidate_id, sequence_number);

    INSERT INTO candidate_document_categories (
      id, code, label, default_visibility, retention_disposition,
      default_retention_days, transfer_eligible, active, builtin, sort_order
    ) VALUES
      ('resume', 'resume', 'Lebenslauf', 'recruiting', 'manual_review', NULL, 1, 1, 1, 10),
      ('cover-letter', 'cover_letter', 'Bewerbungsschreiben', 'recruiting', 'manual_review', NULL, 1, 1, 1, 20),
      ('certificate', 'certificate', 'Zeugnis', 'hr_confidential', 'manual_review', NULL, 1, 1, 1, 30),
      ('reference', 'reference', 'Referenz', 'hr_confidential', 'manual_review', NULL, 1, 1, 1, 40),
      ('work-sample', 'work_sample', 'Arbeitsprobe', 'recruiting', 'manual_review', NULL, 0, 1, 1, 50),
      ('other', 'other', 'Sonstiges', 'hr_confidential', 'manual_review', NULL, 0, 1, 1, 60)
    ON CONFLICT(id) DO NOTHING;
  `);
  for (const definition of PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS) {
    sqliteDatabase.exec(definition.sql);
  }
  ensureSqlitePersonnelLifecycleConversionSchema(sqliteDatabase);
}

function ensureSqlitePersonnelLifecycleConversionSchema(database) {
  const sqliteDatabase = assertSqliteOperationsDatabase(database);
  for (const definition of PERSONNEL_LIFECYCLE_CONVERSION_TABLE_DEFINITIONS) {
    sqliteDatabase.exec(definition.sql);
  }
  for (const definition of PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS) {
    sqliteDatabase.exec(definition.sql);
  }
}

function ensureSqlitePersonnelLifecycleScopedRightsSchema(database) {
  const sqliteDatabase = assertSqliteOperationsDatabase(database);
  for (const definition of PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TABLE_DEFINITIONS) {
    sqliteDatabase.exec(definition.sql);
  }
  sqliteDatabase.exec(`
    CREATE INDEX IF NOT EXISTS idx_portal_permission_scope_grants_permission
      ON portal_permission_scope_grants(employee_number, permission, location_id, department_id);
    CREATE INDEX IF NOT EXISTS idx_portal_permission_scope_grants_scope
      ON portal_permission_scope_grants(location_id, department_id, permission, employee_number);
  `);
  for (const definition of PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS) {
    sqliteDatabase.exec(definition.sql);
  }
}

module.exports = {
  PERSONNEL_LIFECYCLE_CONVERSION_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_CONVERSION_TABLE_DEFINITIONS,
  PERSONNEL_LIFECYCLE_CONVERSION_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS,
  PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_NAMES,
  PERSONNEL_LIFECYCLE_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_LEGACY_SCOPED_RIGHTS_TABLE_DEFINITION,
  PERSONNEL_LIFECYCLE_M4_SCOPED_RIGHTS_TABLE_DEFINITION,
  PERSONNEL_LIFECYCLE_SCOPED_PERMISSION_IDS,
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TABLE_DEFINITIONS,
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS,
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_NAMES,
  PERSONNEL_LIFECYCLE_TABLE_DEFINITIONS,
  PERSONNEL_LIFECYCLE_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS,
  PERSONNEL_LIFECYCLE_TRIGGER_NAMES,
  PERSONNEL_PROFILE_SCOPED_RIGHTS_MIGRATION_ID,
  ensureSqlitePersonnelLifecycleConversionSchema,
  ensureSqlitePersonnelLifecycleScopedRightsSchema,
  ensureSqlitePersonnelLifecycleSchema,
  inspectSqlitePersonnelLifecycleConversionSchema,
  inspectSqlitePersonnelLifecycleScopedRightsCompatibility,
  inspectSqlitePersonnelLifecycleScopedRightsRows,
  inspectSqlitePersonnelLifecycleScopedRightsSchema,
  inspectSqlitePersonnelLifecycleSchema,
};
