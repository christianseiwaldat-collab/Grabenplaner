"use strict";

const {
  buildPersonnelLearningCompetencyState,
  competencyReceiptSha256,
  competencyRevisionReceiptSha256,
} = require("../../../personnel-learning-competencies");
const {
  isPersonnelLearningSkillContent,
} = require("../../../personnel-learning-skills");

const PERSONNEL_LEARNING_COMPETENCY_MIGRATION_ID =
  "v0.92.8-personnel-learning-competency-profiles";

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

const PERSONNEL_LEARNING_COMPETENCY_TABLE_DEFINITIONS = Object.freeze([
  definition("personnel_learning_employee_competencies", `
    CREATE TABLE IF NOT EXISTS personnel_learning_employee_competencies (
      id TEXT PRIMARY KEY CHECK(TRIM(id) <> ''),
      employee_number TEXT NOT NULL CHECK(TRIM(employee_number) <> ''),
      skill_module_id TEXT NOT NULL CHECK(TRIM(skill_module_id) <> ''),
      ${sha256Column("receipt_sha256")},
      created_by TEXT NOT NULL CHECK(TRIM(created_by) <> ''),
      created_at TEXT NOT NULL CHECK(TRIM(created_at) <> ''),
      UNIQUE(employee_number, skill_module_id),
      UNIQUE(id, skill_module_id),
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (skill_module_id) REFERENCES personnel_learning_modules(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_learning_employee_competency_revisions", `
    CREATE TABLE IF NOT EXISTS personnel_learning_employee_competency_revisions (
      competency_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL CHECK(revision_number >= 1),
      skill_module_id TEXT NOT NULL CHECK(TRIM(skill_module_id) <> ''),
      skill_version_number INTEGER NOT NULL CHECK(skill_version_number >= 1),
      competency_level INTEGER NOT NULL CHECK(competency_level BETWEEN 1 AND 10),
      trainer_authorized INTEGER NOT NULL CHECK(trainer_authorized IN (0, 1)),
      active INTEGER NOT NULL CHECK(active IN (0, 1)),
      change_type TEXT NOT NULL
        CHECK(change_type IN ('assigned','updated','withdrawn','restored')),
      ${sha256Column("previous_receipt_sha256", { allowEmpty: true })},
      ${sha256Column("receipt_sha256")},
      changed_by TEXT NOT NULL CHECK(TRIM(changed_by) <> ''),
      changed_at TEXT NOT NULL CHECK(TRIM(changed_at) <> ''),
      PRIMARY KEY (competency_id, revision_number),
      UNIQUE(receipt_sha256),
      CHECK(active = 1 OR trainer_authorized = 0),
      FOREIGN KEY (competency_id, skill_module_id)
        REFERENCES personnel_learning_employee_competencies(id, skill_module_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (skill_module_id, skill_version_number)
        REFERENCES personnel_learning_module_versions(module_id, version_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
]);

const PERSONNEL_LEARNING_COMPETENCY_TABLE_NAMES = Object.freeze(
  PERSONNEL_LEARNING_COMPETENCY_TABLE_DEFINITIONS.map(({ name }) => name),
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

const PERSONNEL_LEARNING_COMPETENCY_TRIGGER_DEFINITIONS = Object.freeze([
  definition("trg_personnel_learning_employee_competencies_skill", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_learning_employee_competencies_skill
    BEFORE INSERT ON personnel_learning_employee_competencies
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_learning_modules module
      JOIN personnel_learning_module_versions version
        ON version.module_id = module.id
      WHERE module.id = NEW.skill_module_id
        AND module.module_type = 'knowledge'
        AND json_extract(version.content_json, '$.catalogEntity') = 'skill'
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel learning competency skill is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_learning_employee_competencies",
    "personnel learning employee competencies",
  ),
  definition("trg_personnel_learning_employee_competency_revisions_chain", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_learning_employee_competency_revisions_chain
    BEFORE INSERT ON personnel_learning_employee_competency_revisions
    WHEN NEW.revision_number <> COALESCE((
      SELECT MAX(revision_number) + 1
      FROM personnel_learning_employee_competency_revisions
      WHERE competency_id = NEW.competency_id
    ), 1)
    OR NEW.previous_receipt_sha256 <> COALESCE((
      SELECT receipt_sha256
      FROM personnel_learning_employee_competency_revisions
      WHERE competency_id = NEW.competency_id
      ORDER BY revision_number DESC
      LIMIT 1
    ), '')
    OR NEW.skill_module_id <> COALESCE((
      SELECT skill_module_id
      FROM personnel_learning_employee_competencies
      WHERE id = NEW.competency_id
    ), '')
    OR NOT EXISTS (
      SELECT 1
      FROM personnel_learning_module_versions version
      JOIN personnel_learning_module_events published
        ON published.module_id = version.module_id
       AND published.module_version_number = version.version_number
       AND published.event_type = 'published'
      WHERE version.module_id = NEW.skill_module_id
        AND version.version_number = NEW.skill_version_number
        AND json_extract(version.content_json, '$.catalogEntity') = 'skill'
        AND json_type(version.content_json, '$.levelDefinitions') = 'array'
        AND json_array_length(version.content_json, '$.levelDefinitions') = 10
        AND CAST(json_extract(
          version.content_json,
          '$.levelDefinitions[' || (NEW.competency_level - 1) || '].level'
        ) AS INTEGER) = NEW.competency_level
    )
    OR (NEW.revision_number = 1 AND (NEW.change_type <> 'assigned' OR NEW.active <> 1))
    OR (NEW.revision_number > 1 AND NEW.change_type = 'assigned')
    OR (
      NEW.revision_number > 1
      AND NEW.change_type = 'updated'
      AND (
        NEW.active <> 1
        OR COALESCE((
          SELECT active
          FROM personnel_learning_employee_competency_revisions
          WHERE competency_id = NEW.competency_id
          ORDER BY revision_number DESC
          LIMIT 1
        ), 0) <> 1
      )
    )
    OR (
      NEW.revision_number > 1
      AND NEW.change_type = 'withdrawn'
      AND (
        NEW.active <> 0
        OR COALESCE((
          SELECT active
          FROM personnel_learning_employee_competency_revisions
          WHERE competency_id = NEW.competency_id
          ORDER BY revision_number DESC
          LIMIT 1
        ), 0) <> 1
      )
    )
    OR (
      NEW.revision_number > 1
      AND NEW.change_type = 'restored'
      AND (
        NEW.active <> 1
        OR COALESCE((
          SELECT active
          FROM personnel_learning_employee_competency_revisions
          WHERE competency_id = NEW.competency_id
          ORDER BY revision_number DESC
          LIMIT 1
        ), 1) <> 0
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel learning competency revision chain is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_learning_employee_competency_revisions",
    "personnel learning employee competency revisions",
  ),
]);

const PERSONNEL_LEARNING_COMPETENCY_TRIGGER_NAMES = Object.freeze(
  PERSONNEL_LEARNING_COMPETENCY_TRIGGER_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LEARNING_COMPETENCY_INDEX_DEFINITIONS = Object.freeze([
  definition("idx_personnel_learning_competencies_employee", `
    CREATE INDEX IF NOT EXISTS idx_personnel_learning_competencies_employee
      ON personnel_learning_employee_competencies(employee_number, skill_module_id)
  `),
  definition("idx_personnel_learning_competencies_skill", `
    CREATE INDEX IF NOT EXISTS idx_personnel_learning_competencies_skill
      ON personnel_learning_employee_competencies(skill_module_id, employee_number)
  `),
  definition("idx_personnel_learning_competency_revisions_skill", `
    CREATE INDEX IF NOT EXISTS idx_personnel_learning_competency_revisions_skill
      ON personnel_learning_employee_competency_revisions(
        skill_module_id, skill_version_number, competency_id, revision_number
      )
  `),
  definition("idx_personnel_learning_competency_revisions_trainer", `
    CREATE INDEX IF NOT EXISTS idx_personnel_learning_competency_revisions_trainer
      ON personnel_learning_employee_competency_revisions(
        trainer_authorized, active, skill_module_id, competency_id, revision_number
      )
  `),
]);

const PERSONNEL_LEARNING_COMPETENCY_INDEX_NAMES = Object.freeze(
  PERSONNEL_LEARNING_COMPETENCY_INDEX_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LEARNING_COMPETENCY_REQUIRED_TABLES = Object.freeze([
  "employees",
  "personnel_learning_modules",
  "personnel_learning_module_versions",
  "personnel_learning_module_events",
]);

function normalizeDefinitionSql(sql, type) {
  let normalized = String(sql || "").trim().replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "").toLowerCase();
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

function inspectSqlitePersonnelLearningCompetencySchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const tables = inspectDefinitions(
    database,
    "table",
    PERSONNEL_LEARNING_COMPETENCY_TABLE_DEFINITIONS,
  );
  const triggers = inspectDefinitions(
    database,
    "trigger",
    PERSONNEL_LEARNING_COMPETENCY_TRIGGER_DEFINITIONS,
  );
  const indexes = inspectDefinitions(
    database,
    "index",
    PERSONNEL_LEARNING_COMPETENCY_INDEX_DEFINITIONS,
  );
  const issues = Object.freeze([
    ...tables.missing.map((name) => `table-missing:${name}`),
    ...tables.invalid.map((name) => `table-invalid:${name}`),
    ...triggers.missing.map((name) => `trigger-missing:${name}`),
    ...triggers.invalid.map((name) => `trigger-invalid:${name}`),
    ...indexes.missing.map((name) => `index-missing:${name}`),
    ...indexes.invalid.map((name) => `index-invalid:${name}`),
  ]);
  const targetObjectsPresent = tables.missing.length
      < PERSONNEL_LEARNING_COMPETENCY_TABLE_DEFINITIONS.length
    || triggers.missing.length < PERSONNEL_LEARNING_COMPETENCY_TRIGGER_DEFINITIONS.length
    || indexes.missing.length < PERSONNEL_LEARNING_COMPETENCY_INDEX_DEFINITIONS.length;
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

function parsedJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed : null;
  } catch {
    return null;
  }
}

function inspectSqlitePersonnelLearningCompetencyRows(database) {
  const schema = inspectSqlitePersonnelLearningCompetencySchema(database);
  if (schema.absent) return Object.freeze({ valid: true, absent: true, issues: [] });
  if (!schema.valid) {
    return Object.freeze({ valid: false, absent: false, issues: ["schema-invalid"] });
  }
  const issues = [];
  const competencies = database.prepare(`
    SELECT competency.id, competency.employee_number, competency.skill_module_id,
           competency.receipt_sha256, competency.created_by, competency.created_at,
           employee.personnel_number AS matched_employee_number,
           module.id AS matched_skill_module_id
    FROM personnel_learning_employee_competencies competency
    LEFT JOIN employees employee ON employee.personnel_number = competency.employee_number
    LEFT JOIN personnel_learning_modules module ON module.id = competency.skill_module_id
    ORDER BY competency.id
  `).all();
  const revisionsByCompetency = new Map();
  for (const row of database.prepare(`
    SELECT competency_id, revision_number, skill_module_id, skill_version_number,
           competency_level, trainer_authorized, active, change_type,
           previous_receipt_sha256, receipt_sha256, changed_by, changed_at
    FROM personnel_learning_employee_competency_revisions
    ORDER BY competency_id, revision_number
  `).all()) {
    const rows = revisionsByCompetency.get(row.competency_id) || [];
    rows.push(row);
    revisionsByCompetency.set(row.competency_id, rows);
  }
  const version = database.prepare(`
    SELECT version.content_json
    FROM personnel_learning_module_versions version
    JOIN personnel_learning_module_events published
      ON published.module_id = version.module_id
     AND published.module_version_number = version.version_number
     AND published.event_type = 'published'
    WHERE version.module_id = ? AND version.version_number = ?
    LIMIT 1
  `);
  for (const competency of competencies) {
    if (competency.matched_employee_number !== competency.employee_number
      || competency.matched_skill_module_id !== competency.skill_module_id
      || competencyReceiptSha256(competency) !== competency.receipt_sha256) {
      issues.push(`competency-row-invalid:${competency.id}`);
    }
    const revisions = revisionsByCompetency.get(competency.id) || [];
    try {
      buildPersonnelLearningCompetencyState({ competency, revisions });
    } catch {
      issues.push(`competency-history-invalid:${competency.id}`);
      continue;
    }
    for (const revision of revisions) {
      if (competencyRevisionReceiptSha256(revision) !== revision.receipt_sha256) {
        issues.push(
          `competency-receipt-invalid:${competency.id}:${revision.revision_number}`,
        );
      }
      const skillContent = parsedJsonObject(
        version.get(
          revision.skill_module_id,
          revision.skill_version_number,
        )?.content_json,
      );
      const definition = skillContent?.levelDefinitions?.[
        Number(revision.competency_level) - 1
      ];
      if (!isPersonnelLearningSkillContent(skillContent)
        || !Array.isArray(skillContent.levelDefinitions)
        || skillContent.levelDefinitions.length !== 10
        || Number(definition?.level) !== Number(revision.competency_level)) {
        issues.push(
          `competency-skill-version-invalid:${competency.id}:${revision.revision_number}`,
        );
      }
    }
  }
  for (const competencyId of revisionsByCompetency.keys()) {
    if (!competencies.some(({ id }) => id === competencyId)) {
      issues.push(`competency-history-orphan:${competencyId}`);
    }
  }
  return Object.freeze({
    valid: issues.length === 0,
    absent: false,
    issues: Object.freeze([...new Set(issues)]),
  });
}

function ensureSqlitePersonnelLearningCompetencySchema(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  for (const table of PERSONNEL_LEARNING_COMPETENCY_REQUIRED_TABLES) {
    const exists = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
    `).get(table);
    if (!exists) {
      throw new Error(`personnel learning competency dependency missing: ${table}`);
    }
  }
  for (const item of PERSONNEL_LEARNING_COMPETENCY_TABLE_DEFINITIONS) database.exec(item.sql);
  for (const item of PERSONNEL_LEARNING_COMPETENCY_INDEX_DEFINITIONS) database.exec(item.sql);
  for (const item of PERSONNEL_LEARNING_COMPETENCY_TRIGGER_DEFINITIONS) database.exec(item.sql);
}

module.exports = {
  PERSONNEL_LEARNING_COMPETENCY_INDEX_DEFINITIONS,
  PERSONNEL_LEARNING_COMPETENCY_INDEX_NAMES,
  PERSONNEL_LEARNING_COMPETENCY_MIGRATION_ID,
  PERSONNEL_LEARNING_COMPETENCY_REQUIRED_TABLES,
  PERSONNEL_LEARNING_COMPETENCY_TABLE_DEFINITIONS,
  PERSONNEL_LEARNING_COMPETENCY_TABLE_NAMES,
  PERSONNEL_LEARNING_COMPETENCY_TRIGGER_DEFINITIONS,
  PERSONNEL_LEARNING_COMPETENCY_TRIGGER_NAMES,
  ensureSqlitePersonnelLearningCompetencySchema,
  inspectSqlitePersonnelLearningCompetencyRows,
  inspectSqlitePersonnelLearningCompetencySchema,
};
