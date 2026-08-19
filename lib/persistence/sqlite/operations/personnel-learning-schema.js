"use strict";

const { createHash } = require("node:crypto");

const {
  canonicalSha256,
} = require("../../../work-rules/receipt");

const PERSONNEL_LEARNING_FOUNDATION_MIGRATION_ID =
  "v0.92.8-personnel-learning-foundation";
const PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION =
  "personnel:learning:cross_location:assign";

function definition(name, sql) {
  return Object.freeze({ name, sql: String(sql || "").trim() });
}

function sha256Column(column, { allowEmpty = false } = {}) {
  const valid = `(
          length(${column}) = 64
          AND ${column} = lower(${column})
          AND ${column} NOT GLOB '*[^0-9a-f]*'
        )`;
  return `${column} TEXT NOT NULL${allowEmpty ? " DEFAULT ''" : ""}
        CHECK(${allowEmpty ? `${column} = '' OR ${valid}` : valid})`;
}

const PERSONNEL_LEARNING_TABLE_DEFINITIONS = Object.freeze([
  definition("personnel_learning_modules", `
    CREATE TABLE IF NOT EXISTS personnel_learning_modules (
      id TEXT PRIMARY KEY CHECK(TRIM(id) <> ''),
      module_code TEXT NOT NULL COLLATE NOCASE UNIQUE
        CHECK(length(TRIM(module_code)) BETWEEN 2 AND 80),
      module_type TEXT NOT NULL CHECK(module_type IN ('knowledge','training')),
      ${sha256Column("receipt_sha256")},
      created_by TEXT NOT NULL CHECK(TRIM(created_by) <> ''),
      created_at TEXT NOT NULL CHECK(TRIM(created_at) <> '')
    );
  `),
  definition("personnel_learning_module_versions", `
    CREATE TABLE IF NOT EXISTS personnel_learning_module_versions (
      module_id TEXT NOT NULL,
      version_number INTEGER NOT NULL CHECK(version_number >= 1),
      title TEXT NOT NULL CHECK(length(TRIM(title)) BETWEEN 1 AND 200),
      content_json TEXT NOT NULL
        CHECK(json_valid(content_json) AND json_type(content_json) = 'object'),
      ${sha256Column("content_sha256")},
      scope_type TEXT NOT NULL
        CHECK(scope_type IN ('organization','location','department')),
      scope_location_id TEXT,
      scope_department_id INTEGER,
      scope_snapshot_json TEXT NOT NULL
        CHECK(json_valid(scope_snapshot_json) AND json_type(scope_snapshot_json) = 'object'),
      ${sha256Column("scope_snapshot_sha256")},
      ${sha256Column("previous_receipt_sha256", { allowEmpty: true })},
      ${sha256Column("receipt_sha256")},
      created_by TEXT NOT NULL CHECK(TRIM(created_by) <> ''),
      created_at TEXT NOT NULL CHECK(TRIM(created_at) <> ''),
      PRIMARY KEY (module_id, version_number),
      UNIQUE(receipt_sha256),
      CHECK(
        (scope_type = 'organization'
          AND scope_location_id IS NULL AND scope_department_id IS NULL)
        OR (scope_type = 'location'
          AND scope_location_id IS NOT NULL AND TRIM(scope_location_id) <> ''
          AND scope_department_id IS NULL)
        OR (scope_type = 'department'
          AND scope_location_id IS NOT NULL AND TRIM(scope_location_id) <> ''
          AND scope_department_id IS NOT NULL)
      ),
      FOREIGN KEY (module_id) REFERENCES personnel_learning_modules(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (scope_location_id) REFERENCES locations(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (scope_department_id) REFERENCES departments(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_learning_module_events", `
    CREATE TABLE IF NOT EXISTS personnel_learning_module_events (
      id TEXT PRIMARY KEY CHECK(TRIM(id) <> ''),
      module_id TEXT NOT NULL,
      sequence_number INTEGER NOT NULL CHECK(sequence_number >= 1),
      event_type TEXT NOT NULL
        CHECK(event_type IN ('created','version_added','published','archived','restored')),
      module_version_number INTEGER,
      event_payload_json TEXT NOT NULL
        CHECK(json_valid(event_payload_json) AND json_type(event_payload_json) = 'object'),
      ${sha256Column("event_payload_sha256")},
      ${sha256Column("previous_receipt_sha256", { allowEmpty: true })},
      ${sha256Column("receipt_sha256")},
      actor_id TEXT NOT NULL CHECK(TRIM(actor_id) <> ''),
      occurred_at TEXT NOT NULL CHECK(TRIM(occurred_at) <> ''),
      UNIQUE(module_id, sequence_number),
      UNIQUE(receipt_sha256),
      CHECK(
        (event_type IN ('created','archived','restored') AND module_version_number IS NULL)
        OR (event_type IN ('version_added','published') AND module_version_number IS NOT NULL)
      ),
      FOREIGN KEY (module_id) REFERENCES personnel_learning_modules(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (module_id, module_version_number)
        REFERENCES personnel_learning_module_versions(module_id, version_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_learning_permission_denial_authorities", `
    CREATE TABLE IF NOT EXISTS personnel_learning_permission_denial_authorities (
      employee_number TEXT NOT NULL,
      permission TEXT NOT NULL
        CHECK(permission = 'personnel:learning:cross_location:assign'),
      authority_level TEXT NOT NULL CHECK(authority_level IN ('pl_plus','manager')),
      scope_location_id TEXT NOT NULL DEFAULT '',
      denied_by TEXT NOT NULL CHECK(TRIM(denied_by) <> ''),
      generation_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
        CHECK(
          length(generation_id) = 32
          AND generation_id = lower(generation_id)
          AND generation_id NOT GLOB '*[^0-9a-f]*'
        ),
      created_at TEXT NOT NULL CHECK(TRIM(created_at) <> ''),
      updated_at TEXT NOT NULL CHECK(TRIM(updated_at) <> ''),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      PRIMARY KEY (employee_number, permission),
      CHECK(
        (authority_level = 'pl_plus' AND scope_location_id = '')
        OR (authority_level = 'manager' AND TRIM(scope_location_id) <> '')
      ),
      FOREIGN KEY (employee_number, permission)
        REFERENCES portal_permission_denials(employee_number, permission)
        ON UPDATE RESTRICT ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED
    );
  `),
]);

const PERSONNEL_LEARNING_TABLE_NAMES = Object.freeze(
  PERSONNEL_LEARNING_TABLE_DEFINITIONS.map(({ name }) => name),
);

function immutableTriggers(tableName, message) {
  return [
    definition(`trg_${tableName}_immutable_update`, `
      CREATE TRIGGER IF NOT EXISTS trg_${tableName}_immutable_update
      BEFORE UPDATE ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, '${message} are immutable');
      END;
    `),
    definition(`trg_${tableName}_immutable_delete`, `
      CREATE TRIGGER IF NOT EXISTS trg_${tableName}_immutable_delete
      BEFORE DELETE ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, '${message} are immutable');
      END;
    `),
  ];
}

const PERSONNEL_LEARNING_TRIGGER_DEFINITIONS = Object.freeze([
  ...immutableTriggers("personnel_learning_modules", "personnel learning modules"),
  definition("trg_personnel_learning_module_versions_sequence", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_learning_module_versions_sequence
    BEFORE INSERT ON personnel_learning_module_versions
    WHEN NEW.version_number <> COALESCE((
      SELECT MAX(version_number) + 1
      FROM personnel_learning_module_versions
      WHERE module_id = NEW.module_id
    ), 1)
    OR NEW.previous_receipt_sha256 <> COALESCE((
      SELECT receipt_sha256
      FROM personnel_learning_module_versions
      WHERE module_id = NEW.module_id
      ORDER BY version_number DESC
      LIMIT 1
    ), '')
    BEGIN
      SELECT RAISE(ABORT, 'personnel learning module version chain is invalid');
    END;
  `),
  definition("trg_personnel_learning_module_versions_scope", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_learning_module_versions_scope
    BEFORE INSERT ON personnel_learning_module_versions
    WHEN json_extract(NEW.scope_snapshot_json, '$.type') IS NOT NEW.scope_type
      OR (
        NEW.scope_type = 'organization'
        AND (
          json_type(NEW.scope_snapshot_json, '$.locationId') IS NOT NULL
          OR json_type(NEW.scope_snapshot_json, '$.departmentId') IS NOT NULL
        )
      )
      OR (
        NEW.scope_type = 'location'
        AND (
          json_type(NEW.scope_snapshot_json, '$.locationId') <> 'text'
          OR json_extract(NEW.scope_snapshot_json, '$.locationId') IS NOT NEW.scope_location_id
          OR json_type(NEW.scope_snapshot_json, '$.departmentId') IS NOT NULL
        )
      )
      OR (
        NEW.scope_type = 'department'
        AND (
          json_type(NEW.scope_snapshot_json, '$.locationId') <> 'text'
          OR json_extract(NEW.scope_snapshot_json, '$.locationId') IS NOT NEW.scope_location_id
          OR json_type(NEW.scope_snapshot_json, '$.departmentId') <> 'integer'
          OR json_extract(NEW.scope_snapshot_json, '$.departmentId') IS NOT NEW.scope_department_id
          OR NOT EXISTS (
            SELECT 1
            FROM departments department
            WHERE department.id = NEW.scope_department_id
              AND department.location_id = NEW.scope_location_id
          )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'personnel learning module version scope is invalid');
    END;
  `),
  definition("trg_personnel_learning_department_location_update", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_learning_department_location_update
    BEFORE UPDATE OF location_id ON departments
    WHEN NEW.location_id IS NOT OLD.location_id
      AND EXISTS (
        SELECT 1
        FROM personnel_learning_module_versions version
        WHERE version.scope_department_id = OLD.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'personnel learning module version department location is referenced');
    END;
  `),
  ...immutableTriggers(
    "personnel_learning_module_versions",
    "personnel learning module versions",
  ),
  definition("trg_personnel_learning_module_events_chain", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_learning_module_events_chain
    BEFORE INSERT ON personnel_learning_module_events
    WHEN NEW.sequence_number <> COALESCE((
      SELECT MAX(sequence_number) + 1
      FROM personnel_learning_module_events
      WHERE module_id = NEW.module_id
    ), 1)
    OR NEW.previous_receipt_sha256 <> COALESCE((
      SELECT receipt_sha256
      FROM personnel_learning_module_events
      WHERE module_id = NEW.module_id
      ORDER BY sequence_number DESC
      LIMIT 1
    ), '')
    OR (NEW.sequence_number = 1 AND NEW.event_type <> 'created')
    OR (NEW.sequence_number > 1 AND NEW.event_type = 'created')
    OR (
      NEW.event_type = 'version_added'
      AND NEW.module_version_number <> COALESCE((
        SELECT MAX(module_version_number) + 1
        FROM personnel_learning_module_events
        WHERE module_id = NEW.module_id AND event_type = 'version_added'
      ), 1)
    )
    OR (
      NEW.event_type = 'published'
      AND NOT EXISTS (
        SELECT 1
        FROM personnel_learning_module_events
        WHERE module_id = NEW.module_id
          AND event_type = 'version_added'
          AND module_version_number = NEW.module_version_number
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel learning module event chain is invalid');
    END;
  `),
  ...immutableTriggers("personnel_learning_module_events", "personnel learning module events"),
  definition("trg_personnel_learning_denial_authorities_insert", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_learning_denial_authorities_insert
    BEFORE INSERT ON personnel_learning_permission_denial_authorities
    WHEN NEW.revision <> 1
      OR (
        NEW.authority_level = 'manager'
        AND NOT EXISTS (
          SELECT 1 FROM locations WHERE id = NEW.scope_location_id
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'personnel learning denial authority is invalid');
    END;
  `),
  definition("trg_personnel_learning_denial_authorities_update", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_learning_denial_authorities_update
    BEFORE UPDATE ON personnel_learning_permission_denial_authorities
    WHEN NEW.employee_number IS NOT OLD.employee_number
      OR NEW.permission IS NOT OLD.permission
      OR NEW.generation_id IS NOT OLD.generation_id
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.revision <> OLD.revision + 1
      OR (
        NEW.authority_level = 'manager'
        AND NOT EXISTS (
          SELECT 1 FROM locations WHERE id = NEW.scope_location_id
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'personnel learning denial authority revision is invalid');
    END;
  `),
  definition("trg_personnel_learning_denial_authority_location_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_learning_denial_authority_location_delete
    BEFORE DELETE ON locations
    WHEN EXISTS (
      SELECT 1
      FROM personnel_learning_permission_denial_authorities authority
      WHERE authority.authority_level = 'manager'
        AND authority.scope_location_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel learning denial authority location is referenced');
    END;
  `),
  definition("trg_personnel_learning_denial_authority_location_update", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_learning_denial_authority_location_update
    BEFORE UPDATE OF id ON locations
    WHEN NEW.id IS NOT OLD.id
      AND EXISTS (
        SELECT 1
        FROM personnel_learning_permission_denial_authorities authority
        WHERE authority.authority_level = 'manager'
          AND authority.scope_location_id = OLD.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'personnel learning denial authority location is referenced');
    END;
  `),
]);

const PERSONNEL_LEARNING_TRIGGER_NAMES = Object.freeze(
  PERSONNEL_LEARNING_TRIGGER_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LEARNING_INDEX_DEFINITIONS = Object.freeze([
  definition("idx_personnel_learning_modules_type", `
    CREATE INDEX IF NOT EXISTS idx_personnel_learning_modules_type
      ON personnel_learning_modules(module_type, created_at, id)
  `),
  definition("idx_personnel_learning_module_versions_scope", `
    CREATE INDEX IF NOT EXISTS idx_personnel_learning_module_versions_scope
      ON personnel_learning_module_versions(
        scope_type, scope_location_id, scope_department_id, module_id, version_number
      )
  `),
  definition("idx_personnel_learning_module_events_module", `
    CREATE INDEX IF NOT EXISTS idx_personnel_learning_module_events_module
      ON personnel_learning_module_events(module_id, sequence_number)
  `),
  definition("idx_personnel_learning_module_events_version_added", `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_personnel_learning_module_events_version_added
      ON personnel_learning_module_events(module_id, module_version_number)
      WHERE event_type = 'version_added'
  `),
  definition("idx_personnel_learning_denial_authorities_scope", `
    CREATE INDEX IF NOT EXISTS idx_personnel_learning_denial_authorities_scope
      ON personnel_learning_permission_denial_authorities(scope_location_id, employee_number)
      WHERE authority_level = 'manager'
  `),
]);

const PERSONNEL_LEARNING_INDEX_NAMES = Object.freeze(
  PERSONNEL_LEARNING_INDEX_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LEARNING_REQUIRED_TABLES = Object.freeze([
  "locations",
  "departments",
  "portal_permission_denials",
]);

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
  } else if (type === "index") {
    normalized = normalized.replace(
      /^create (unique )?index if not exists /,
      (_, unique = "") => `create ${unique}index `,
    );
  }
  return normalized;
}

function inspectDefinitions(database, type, definitions) {
  const read = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
  );
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

function inspectSqlitePersonnelLearningSchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const tables = inspectDefinitions(database, "table", PERSONNEL_LEARNING_TABLE_DEFINITIONS);
  const triggers = inspectDefinitions(
    database,
    "trigger",
    PERSONNEL_LEARNING_TRIGGER_DEFINITIONS,
  );
  const indexes = inspectDefinitions(database, "index", PERSONNEL_LEARNING_INDEX_DEFINITIONS);
  const issues = Object.freeze([
    ...tables.missing.map((name) => `table-missing:${name}`),
    ...tables.invalid.map((name) => `table-invalid:${name}`),
    ...triggers.missing.map((name) => `trigger-missing:${name}`),
    ...triggers.invalid.map((name) => `trigger-invalid:${name}`),
    ...indexes.missing.map((name) => `index-missing:${name}`),
    ...indexes.invalid.map((name) => `index-invalid:${name}`),
  ]);
  const targetObjectsPresent = tables.missing.length < PERSONNEL_LEARNING_TABLE_DEFINITIONS.length
    || triggers.missing.length < PERSONNEL_LEARNING_TRIGGER_DEFINITIONS.length
    || indexes.missing.length < PERSONNEL_LEARNING_INDEX_DEFINITIONS.length;
  return Object.freeze({
    valid: issues.length === 0,
    absent: !targetObjectsPresent,
    issues,
    missingTables: tables.missing,
    invalidTables: tables.invalid,
    missingTriggers: triggers.missing,
    invalidTriggers: triggers.invalid,
    missingIndexes: indexes.missing,
    invalidIndexes: indexes.invalid,
  });
}

function sha256Text(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function parsedJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function scopeSnapshotMatches(row, snapshot, departmentLocations) {
  if (!snapshot || snapshot.type !== row.scope_type) return false;
  const hasLocation = Object.prototype.hasOwnProperty.call(snapshot, "locationId");
  const hasDepartment = Object.prototype.hasOwnProperty.call(snapshot, "departmentId");
  if (row.scope_type === "organization") return !hasLocation && !hasDepartment;
  if (row.scope_type === "location") {
    return hasLocation
      && typeof snapshot.locationId === "string"
      && snapshot.locationId === row.scope_location_id
      && !hasDepartment;
  }
  return row.scope_type === "department"
    && hasLocation
    && typeof snapshot.locationId === "string"
    && snapshot.locationId === row.scope_location_id
    && hasDepartment
    && Number.isSafeInteger(snapshot.departmentId)
    && snapshot.departmentId === Number(row.scope_department_id)
    && departmentLocations.get(Number(row.scope_department_id)) === row.scope_location_id;
}

function moduleReceiptBody(row) {
  return {
    schemaVersion: 1,
    id: String(row.id || ""),
    moduleCode: String(row.module_code ?? row.moduleCode ?? ""),
    moduleType: String(row.module_type ?? row.moduleType ?? ""),
    createdBy: String(row.created_by ?? row.createdBy ?? ""),
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
  };
}

function moduleReceiptSha256(row) {
  return sha256Text(JSON.stringify(moduleReceiptBody(row)));
}

function moduleVersionReceiptBody(row) {
  const departmentId = row.scope_department_id ?? row.scopeDepartmentId;
  return {
    schemaVersion: 1,
    moduleId: String(row.module_id ?? row.moduleId ?? ""),
    versionNumber: Number(row.version_number ?? row.versionNumber ?? 0),
    title: String(row.title || ""),
    contentSha256: String(row.content_sha256 ?? row.contentSha256 ?? ""),
    scopeType: String(row.scope_type ?? row.scopeType ?? ""),
    scopeLocationId: String(row.scope_location_id ?? row.scopeLocationId ?? ""),
    scopeDepartmentId: departmentId === null || departmentId === undefined
      ? null : Number(departmentId),
    scopeSnapshotSha256: String(
      row.scope_snapshot_sha256 ?? row.scopeSnapshotSha256 ?? "",
    ),
    previousReceiptSha256: String(
      row.previous_receipt_sha256 ?? row.previousReceiptSha256 ?? "",
    ),
    createdBy: String(row.created_by ?? row.createdBy ?? ""),
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
  };
}

function moduleVersionReceiptSha256(row) {
  return sha256Text(JSON.stringify(moduleVersionReceiptBody(row)));
}

function moduleEventReceiptBody(row) {
  const versionNumber = row.module_version_number ?? row.moduleVersionNumber;
  return {
    schemaVersion: 1,
    id: String(row.id || ""),
    moduleId: String(row.module_id ?? row.moduleId ?? ""),
    sequenceNumber: Number(row.sequence_number ?? row.sequenceNumber ?? 0),
    eventType: String(row.event_type ?? row.eventType ?? ""),
    moduleVersionNumber: versionNumber === null || versionNumber === undefined
      ? null : Number(versionNumber),
    eventPayloadSha256: String(
      row.event_payload_sha256 ?? row.eventPayloadSha256 ?? "",
    ),
    previousReceiptSha256: String(
      row.previous_receipt_sha256 ?? row.previousReceiptSha256 ?? "",
    ),
    actorId: String(row.actor_id ?? row.actorId ?? ""),
    occurredAt: String(row.occurred_at ?? row.occurredAt ?? ""),
  };
}

function moduleEventReceiptSha256(row) {
  return sha256Text(JSON.stringify(moduleEventReceiptBody(row)));
}

function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
}

function relevantDenials(database) {
  if (!tableExists(database, "portal_permission_denials")) return [];
  return database.prepare(`
    SELECT employee_number
    FROM portal_permission_denials
    WHERE permission = ?
    ORDER BY employee_number
  `).all(PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION);
}

function inspectSqlitePersonnelLearningRows(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const schema = inspectSqlitePersonnelLearningSchema(database);
  const tablesValid = schema.missingTables.length === 0 && schema.invalidTables.length === 0;
  if (!tablesValid) {
    const denialIssues = relevantDenials(database).map(
      ({ employee_number: employeeNumber }) => (
        `permission-denial-authority-missing:${employeeNumber}`
      ),
    );
    const issues = schema.absent
      ? denialIssues
      : ["schema-invalid", ...denialIssues];
    return Object.freeze({
      valid: schema.absent && issues.length === 0,
      absent: schema.absent,
      issues: Object.freeze(issues),
    });
  }

  const issues = [];
  const missingDependencies = [];
  for (const dependency of PERSONNEL_LEARNING_REQUIRED_TABLES) {
    if (!tableExists(database, dependency)) missingDependencies.push(dependency);
  }
  if (missingDependencies.length) {
    return Object.freeze({
      valid: false,
      absent: false,
      issues: Object.freeze(
        missingDependencies.map((dependency) => `dependency-missing:${dependency}`),
      ),
    });
  }
  for (const tableName of PERSONNEL_LEARNING_TABLE_NAMES) {
    for (const violation of database.prepare(`PRAGMA foreign_key_check("${tableName}")`).all()) {
      issues.push(`foreign-key:${tableName}:${violation.rowid ?? "unknown"}`);
    }
  }

  const modules = database.prepare(`
    SELECT id, module_code, module_type, receipt_sha256, created_by, created_at
    FROM personnel_learning_modules
    ORDER BY id
  `).all();
  const moduleIds = new Set(modules.map(({ id }) => id));
  for (const module of modules) {
    if (!String(module.id || "").trim()
      || !["knowledge", "training"].includes(module.module_type)
      || String(module.module_code || "").trim().length < 2
      || String(module.module_code || "").trim().length > 80
      || !String(module.created_by || "").trim()
      || !String(module.created_at || "").trim()) {
      issues.push(`module-row-invalid:${module.id || "missing"}`);
    }
    if (moduleReceiptSha256(module) !== module.receipt_sha256) {
      issues.push(`module-receipt-invalid:${module.id}`);
    }
  }

  const versionsByModule = new Map();
  const departmentLocations = new Map(database.prepare(`
    SELECT id, location_id
    FROM departments
  `).all().map(({ id, location_id: locationId }) => [Number(id), locationId]));
  for (const row of database.prepare(`
    SELECT module_id, version_number, title, content_json, content_sha256,
           scope_type, scope_location_id, scope_department_id, scope_snapshot_json,
           scope_snapshot_sha256, previous_receipt_sha256, receipt_sha256,
           created_by, created_at
    FROM personnel_learning_module_versions
    ORDER BY module_id, version_number
  `).all()) {
    const rows = versionsByModule.get(row.module_id) || [];
    rows.push(row);
    versionsByModule.set(row.module_id, rows);
  }

  const eventsByModule = new Map();
  for (const row of database.prepare(`
    SELECT id, module_id, sequence_number, event_type, module_version_number,
           event_payload_json, event_payload_sha256, previous_receipt_sha256,
           receipt_sha256, actor_id, occurred_at
    FROM personnel_learning_module_events
    ORDER BY module_id, sequence_number
  `).all()) {
    const rows = eventsByModule.get(row.module_id) || [];
    rows.push(row);
    eventsByModule.set(row.module_id, rows);
  }

  for (const module of modules) {
    const versions = versionsByModule.get(module.id) || [];
    let previousVersionReceipt = "";
    for (let index = 0; index < versions.length; index += 1) {
      const version = versions[index];
      const content = parsedJsonObject(version.content_json);
      const scopeSnapshot = parsedJsonObject(version.scope_snapshot_json);
      if (Number(version.version_number) !== index + 1
        || version.previous_receipt_sha256 !== previousVersionReceipt) {
        issues.push(`module-version-chain-invalid:${module.id}`);
        break;
      }
      if (!String(version.title || "").trim()
        || String(version.title || "").trim().length > 200
        || !content
        || !String(version.created_by || "").trim()
        || !String(version.created_at || "").trim()) {
        issues.push(`module-version-row-invalid:${module.id}:${version.version_number}`);
      }
      if (!scopeSnapshotMatches(version, scopeSnapshot, departmentLocations)) {
        issues.push(`module-version-scope-invalid:${module.id}:${version.version_number}`);
      }
      // Fachliche JSON-Belege werden beim Schreiben ueber die kanonische
      // Schluesselreihenfolge gehasht. SQLite speichert dagegen die vom
      // Provider serialisierte, semantisch gleichwertige Reihenfolge. Der
      // Neustart-Inspector muss deshalb den geparsten Inhalt und nicht die
      // zufaellige Byte-Reihenfolge des gespeicherten JSON-Texts pruefen.
      if (!content || canonicalSha256(content) !== version.content_sha256) {
        issues.push(`module-version-content-invalid:${module.id}:${version.version_number}`);
      }
      if (!scopeSnapshot
        || canonicalSha256(scopeSnapshot) !== version.scope_snapshot_sha256) {
        issues.push(`module-version-scope-receipt-invalid:${module.id}:${version.version_number}`);
      }
      if (moduleVersionReceiptSha256(version) !== version.receipt_sha256) {
        issues.push(`module-version-receipt-invalid:${module.id}:${version.version_number}`);
      }
      previousVersionReceipt = version.receipt_sha256;
    }

    const events = eventsByModule.get(module.id) || [];
    if (!events.length) issues.push(`module-event-history-missing:${module.id}`);
    let previousEventReceipt = "";
    let nextVersionAdded = 1;
    const versionAddedCounts = new Map();
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const eventPayload = parsedJsonObject(event.event_payload_json);
      if (Number(event.sequence_number) !== index + 1
        || event.previous_receipt_sha256 !== previousEventReceipt
        || (index === 0 && event.event_type !== "created")
        || (index > 0 && event.event_type === "created")) {
        issues.push(`module-event-chain-invalid:${module.id}`);
        break;
      }
      const versionRequired = ["version_added", "published"].includes(event.event_type);
      if (!eventPayload
        || !["created", "version_added", "published", "archived", "restored"]
          .includes(event.event_type)
        || versionRequired !== (event.module_version_number !== null)
        || !String(event.actor_id || "").trim()
        || !String(event.occurred_at || "").trim()) {
        issues.push(`module-event-row-invalid:${module.id}:${event.sequence_number}`);
      }
      if (!eventPayload || canonicalSha256(eventPayload) !== event.event_payload_sha256) {
        issues.push(`module-event-payload-invalid:${module.id}:${event.sequence_number}`);
      }
      if (moduleEventReceiptSha256(event) !== event.receipt_sha256) {
        issues.push(`module-event-receipt-invalid:${module.id}:${event.sequence_number}`);
      }
      if (event.event_type === "version_added") {
        const versionNumber = Number(event.module_version_number);
        if (versionNumber !== nextVersionAdded) {
          issues.push(`module-version-event-order-invalid:${module.id}:${versionNumber}`);
        }
        nextVersionAdded += 1;
        versionAddedCounts.set(versionNumber, (versionAddedCounts.get(versionNumber) || 0) + 1);
      }
      previousEventReceipt = event.receipt_sha256;
    }
    for (const version of versions) {
      if (versionAddedCounts.get(Number(version.version_number)) !== 1) {
        issues.push(`module-version-event-invalid:${module.id}:${version.version_number}`);
      }
    }
  }

  for (const moduleId of new Set([...versionsByModule.keys(), ...eventsByModule.keys()])) {
    if (!moduleIds.has(moduleId)) issues.push(`module-history-orphan:${moduleId}`);
  }

  if (tableExists(database, "portal_permission_denials")) {
    for (const row of database.prepare(`
      SELECT denial.employee_number
      FROM portal_permission_denials denial
      LEFT JOIN personnel_learning_permission_denial_authorities authority
        ON authority.employee_number = denial.employee_number
       AND authority.permission = denial.permission
      WHERE denial.permission = ? AND authority.employee_number IS NULL
      ORDER BY denial.employee_number
    `).all(PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION)) {
      issues.push(`permission-denial-authority-missing:${row.employee_number}`);
    }
  }
  for (const row of database.prepare(`
    SELECT authority.employee_number, authority.permission, authority.authority_level,
           authority.scope_location_id, authority.denied_by, authority.generation_id,
           authority.created_at,
           authority.updated_at, authority.revision, location.id AS matched_location_id
    FROM personnel_learning_permission_denial_authorities authority
    LEFT JOIN locations location ON location.id = authority.scope_location_id
    ORDER BY authority.employee_number
  `).all()) {
    const scopeValid = row.authority_level === "pl_plus"
      ? row.scope_location_id === ""
      : row.authority_level === "manager"
        && Boolean(String(row.scope_location_id || "").trim())
        && row.matched_location_id === row.scope_location_id;
    if (row.permission !== PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION
      || !scopeValid
      || !String(row.denied_by || "").trim()
      || !/^[0-9a-f]{32}$/.test(String(row.generation_id || ""))
      || !String(row.created_at || "").trim()
      || !String(row.updated_at || "").trim()
      || !Number.isSafeInteger(row.revision)
      || row.revision < 1) {
      issues.push(`permission-denial-authority-invalid:${row.employee_number}`);
    }
  }

  return Object.freeze({
    valid: issues.length === 0,
    absent: false,
    issues: Object.freeze([...new Set(issues)]),
  });
}

function ensureSqlitePersonnelLearningSchema(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  for (const item of PERSONNEL_LEARNING_TABLE_DEFINITIONS) database.exec(item.sql);
  for (const item of PERSONNEL_LEARNING_INDEX_DEFINITIONS) database.exec(item.sql);
  for (const item of PERSONNEL_LEARNING_TRIGGER_DEFINITIONS) database.exec(item.sql);
}

module.exports = {
  PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION,
  PERSONNEL_LEARNING_FOUNDATION_MIGRATION_ID,
  PERSONNEL_LEARNING_INDEX_DEFINITIONS,
  PERSONNEL_LEARNING_INDEX_NAMES,
  PERSONNEL_LEARNING_REQUIRED_TABLES,
  PERSONNEL_LEARNING_TABLE_DEFINITIONS,
  PERSONNEL_LEARNING_TABLE_NAMES,
  PERSONNEL_LEARNING_TRIGGER_DEFINITIONS,
  PERSONNEL_LEARNING_TRIGGER_NAMES,
  ensureSqlitePersonnelLearningSchema,
  inspectSqlitePersonnelLearningRows,
  inspectSqlitePersonnelLearningSchema,
  moduleEventReceiptBody,
  moduleEventReceiptSha256,
  moduleReceiptBody,
  moduleReceiptSha256,
  moduleVersionReceiptBody,
  moduleVersionReceiptSha256,
  sha256Text,
};
