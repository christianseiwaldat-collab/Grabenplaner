"use strict";

const { createHash } = require("node:crypto");
const {
  personnelWorkflowPublicationReceiptBody,
} = require("../../../personnel-workflow-publication-receipt");

const PERSONNEL_WORKFLOW_MIGRATION_ID = "v0.89-personnel-workflow-publications";

function definition(name, sql) {
  return Object.freeze({ name, sql: String(sql || "").trim() });
}

const PERSONNEL_WORKFLOW_TABLE_DEFINITIONS = Object.freeze([
  definition("custom_process_publications", `
    CREATE TABLE IF NOT EXISTS custom_process_publications (
      id TEXT PRIMARY KEY,
      process_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL CHECK(source_revision >= 1),
      version_number INTEGER NOT NULL CHECK(version_number >= 1),
      workflow_code TEXT NOT NULL
        CHECK(length(TRIM(workflow_code)) BETWEEN 2 AND 80),
      workflow_type TEXT NOT NULL
        CHECK(workflow_type IN (
          'application','preboarding','onboarding','training','position_change',
          'department_change','location_change','return_from_absence',
          'offboarding','custom_personnel'
        )),
      authority_level TEXT NOT NULL
        CHECK(authority_level IN ('central','local')),
      requirement_kind TEXT NOT NULL
        CHECK(requirement_kind IN ('mandatory','supplemental')),
      data_classification TEXT NOT NULL DEFAULT 'standard'
        CHECK(data_classification = 'standard'),
      scope_type TEXT NOT NULL
        CHECK(scope_type IN ('company','location','department')),
      location_id TEXT,
      department_id INTEGER,
      snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
      snapshot_sha256 TEXT NOT NULL
        CHECK(
          length(snapshot_sha256) = 64
          AND snapshot_sha256 = lower(snapshot_sha256)
          AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
      receipt_sha256 TEXT NOT NULL
        CHECK(
          length(receipt_sha256) = 64
          AND receipt_sha256 = lower(receipt_sha256)
          AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
      published_by TEXT NOT NULL CHECK(TRIM(published_by) <> ''),
      published_at TEXT NOT NULL,
      UNIQUE(process_id, source_revision),
      UNIQUE(process_id, version_number),
      CHECK(
        (scope_type = 'company' AND location_id IS NULL AND department_id IS NULL)
        OR (scope_type = 'location' AND location_id IS NOT NULL AND department_id IS NULL)
        OR (scope_type = 'department' AND location_id IS NOT NULL AND department_id IS NOT NULL)
      ),
      CHECK(requirement_kind <> 'mandatory' OR scope_type = 'company'),
      CHECK(authority_level <> 'local' OR (
        requirement_kind = 'supplemental' AND scope_type IN ('location','department')
      )),
      FOREIGN KEY (process_id) REFERENCES custom_processes(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (process_id, source_revision)
        REFERENCES custom_process_revisions(process_id, revision)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("custom_process_publication_archives", `
    CREATE TABLE IF NOT EXISTS custom_process_publication_archives (
      publication_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL CHECK(length(TRIM(reason)) BETWEEN 3 AND 300),
      archived_by TEXT NOT NULL CHECK(TRIM(archived_by) <> ''),
      archived_at TEXT NOT NULL,
      FOREIGN KEY (publication_id) REFERENCES custom_process_publications(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
]);

const PERSONNEL_WORKFLOW_TABLE_NAMES = Object.freeze(
  PERSONNEL_WORKFLOW_TABLE_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS = Object.freeze([
  definition("trg_custom_process_publications_version_sequence", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_publications_version_sequence
    BEFORE INSERT ON custom_process_publications
    WHEN NEW.version_number <> COALESCE((
      SELECT MAX(version_number) + 1
      FROM custom_process_publications
      WHERE process_id = NEW.process_id
    ), 1)
    BEGIN
      SELECT RAISE(ABORT, 'custom process publication version sequence is invalid');
    END;
  `),
  definition("trg_custom_process_publications_stable_code", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_publications_stable_code
    BEFORE INSERT ON custom_process_publications
    WHEN EXISTS (
      SELECT 1
      FROM custom_process_publications publication
      WHERE publication.process_id = NEW.process_id
        AND publication.workflow_code <> NEW.workflow_code
    )
    BEGIN
      SELECT RAISE(ABORT, 'custom process publication workflow code is immutable');
    END;
  `),
  definition("trg_custom_process_publications_scope_insert", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_publications_scope_insert
    BEFORE INSERT ON custom_process_publications
    WHEN NEW.scope_type = 'department'
      AND NOT EXISTS (
        SELECT 1
        FROM departments department
        WHERE department.id = NEW.department_id
          AND department.location_id = NEW.location_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'custom process publication scope is invalid');
    END;
  `),
  definition("trg_custom_process_publications_immutable_update", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_publications_immutable_update
    BEFORE UPDATE ON custom_process_publications
    BEGIN
      SELECT RAISE(ABORT, 'custom process publications are immutable');
    END;
  `),
  definition("trg_custom_process_publications_immutable_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_publications_immutable_delete
    BEFORE DELETE ON custom_process_publications
    BEGIN
      SELECT RAISE(ABORT, 'custom process publications are immutable');
    END;
  `),
  definition("trg_custom_process_publication_archives_immutable_update", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_publication_archives_immutable_update
    BEFORE UPDATE ON custom_process_publication_archives
    BEGIN
      SELECT RAISE(ABORT, 'custom process publication archives are immutable');
    END;
  `),
  definition("trg_custom_process_publication_archives_immutable_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_publication_archives_immutable_delete
    BEFORE DELETE ON custom_process_publication_archives
    BEGIN
      SELECT RAISE(ABORT, 'custom process publication archives are immutable');
    END;
  `),
  definition("trg_custom_process_revisions_immutable_update", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_revisions_immutable_update
    BEFORE UPDATE ON custom_process_revisions
    BEGIN
      SELECT RAISE(ABORT, 'custom process revisions are immutable');
    END;
  `),
  definition("trg_custom_process_revisions_protected_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_revisions_protected_delete
    BEFORE DELETE ON custom_process_revisions
    WHEN EXISTS (
        SELECT 1
        FROM custom_process_publications publication
        WHERE publication.process_id = OLD.process_id
          AND publication.source_revision = OLD.revision
      )
      OR EXISTS (
        SELECT 1
        FROM custom_process_runs run
        WHERE run.process_id = OLD.process_id
          AND run.process_revision = OLD.revision
      )
    BEGIN
      SELECT RAISE(ABORT, 'published or used custom process revisions cannot be deleted');
    END;
  `),
  definition("trg_custom_processes_protected_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_processes_protected_delete
    BEFORE DELETE ON custom_processes
    WHEN EXISTS (
        SELECT 1
        FROM custom_process_publications publication
        WHERE publication.process_id = OLD.id
      )
      OR EXISTS (
        SELECT 1
        FROM custom_process_runs run
        WHERE run.process_id = OLD.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'published or used custom processes cannot be deleted');
    END;
  `),
]);

const PERSONNEL_WORKFLOW_TRIGGER_NAMES = Object.freeze(
  PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS.map(({ name }) => name),
);

function normalizeDefinitionSql(sql, type) {
  const prefix = type === "table"
    ? /^create table if not exists /i
    : /^create trigger if not exists /i;
  return String(sql || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .replace(prefix, `create ${type} `)
    .toLowerCase();
}

function inspectDefinitions(database, type, definitions) {
  const read = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
  );
  const missing = [];
  const invalid = [];
  for (const item of definitions) {
    const row = read.get(type, item.name);
    if (!row?.sql) missing.push(item.name);
    else if (normalizeDefinitionSql(row.sql, type) !== normalizeDefinitionSql(item.sql, type)) {
      invalid.push(item.name);
    }
  }
  return { missing: Object.freeze(missing), invalid: Object.freeze(invalid) };
}

function inspectSqlitePersonnelWorkflowSchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const tables = inspectDefinitions(database, "table", PERSONNEL_WORKFLOW_TABLE_DEFINITIONS);
  const triggers = inspectDefinitions(database, "trigger", PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS);
  const issues = Object.freeze([
    ...tables.missing.map((name) => `table-missing:${name}`),
    ...tables.invalid.map((name) => `table-invalid:${name}`),
    ...triggers.missing.map((name) => `trigger-missing:${name}`),
    ...triggers.invalid.map((name) => `trigger-invalid:${name}`),
  ]);
  return Object.freeze({
    valid: issues.length === 0,
    absent: tables.missing.length === PERSONNEL_WORKFLOW_TABLE_DEFINITIONS.length
      && triggers.missing.length === PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS.length,
    issues,
    missingTables: tables.missing,
    invalidTables: tables.invalid,
    missingTriggers: triggers.missing,
    invalidTriggers: triggers.invalid,
  });
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function inspectSqlitePersonnelWorkflowRows(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const schema = inspectSqlitePersonnelWorkflowSchema(database);
  if (schema.absent) return Object.freeze({ valid: true, absent: true, issues: Object.freeze([]) });
  if (!schema.valid) return Object.freeze({ valid: false, absent: false, issues: Object.freeze(["schema-invalid"]) });
  const rows = database.prepare(`
    SELECT publication.*,
      archive.publication_id AS archive_publication_id,
      archive.reason AS archive_reason,
      archive.archived_by AS archive_archived_by,
      archive.archived_at AS archive_archived_at
    FROM custom_process_publications publication
    LEFT JOIN custom_process_publication_archives archive
      ON archive.publication_id = publication.id
    ORDER BY publication.process_id, publication.version_number
  `).all();
  const issues = [];
  const expectedVersion = new Map();
  const workflowCodeByProcess = new Map();
  for (const row of rows) {
    const next = expectedVersion.get(row.process_id) || 1;
    if (Number(row.version_number) !== next) issues.push(`version-sequence:${row.id}`);
    expectedVersion.set(row.process_id, Number(row.version_number) + 1);
    const expectedWorkflowCode = workflowCodeByProcess.get(row.process_id);
    if (expectedWorkflowCode && expectedWorkflowCode !== row.workflow_code) {
      issues.push(`workflow-code:${row.id}`);
    } else workflowCodeByProcess.set(row.process_id, row.workflow_code);
    if (!/^[a-z][a-z0-9._-]{1,79}$/.test(String(row.workflow_code || ""))) {
      issues.push(`workflow-code-format:${row.id}`);
    }
    if (sha256(row.snapshot_json) !== row.snapshot_sha256) issues.push(`snapshot-hash:${row.id}`);
    if (sha256(JSON.stringify(personnelWorkflowPublicationReceiptBody(row))) !== row.receipt_sha256) {
      issues.push(`receipt-hash:${row.id}`);
    }
    let snapshot;
    try { snapshot = JSON.parse(row.snapshot_json); } catch { snapshot = null; }
    const scope = snapshot?.scope;
    if (!snapshot || snapshot.id !== row.process_id
      || Number(snapshot.revision) !== Number(row.source_revision)
      || !Array.isArray(snapshot.steps)
      || scope?.type !== row.scope_type
      || String(scope?.locationId || "") !== String(row.location_id || "")
      || Number(scope?.departmentId || 0) !== Number(row.department_id || 0)) {
      issues.push(`snapshot-relation:${row.id}`);
    }
    if (row.archive_publication_id) {
      const reason = String(row.archive_reason || "").trim();
      if (reason.length < 3 || reason.length > 300
        || !String(row.archive_archived_by || "").trim()
        || !String(row.archive_archived_at || "").trim()) {
        issues.push(`archive-metadata:${row.id}`);
      }
    }
  }
  const orphanArchives = database.prepare(`
    SELECT archive.publication_id
    FROM custom_process_publication_archives archive
    LEFT JOIN custom_process_publications publication ON publication.id = archive.publication_id
    WHERE publication.id IS NULL
  `).all();
  if (orphanArchives.length) issues.push("archive-orphan");
  return Object.freeze({
    valid: issues.length === 0,
    absent: false,
    issues: Object.freeze(issues),
  });
}

function ensureSqlitePersonnelWorkflowSchema(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  for (const item of PERSONNEL_WORKFLOW_TABLE_DEFINITIONS) database.exec(item.sql);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_custom_process_publications_scope
      ON custom_process_publications(scope_type, location_id, department_id, requirement_kind, version_number);
    CREATE INDEX IF NOT EXISTS idx_custom_process_publications_process
      ON custom_process_publications(process_id, version_number DESC);
  `);
  for (const item of PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS) database.exec(item.sql);
}

module.exports = {
  PERSONNEL_WORKFLOW_MIGRATION_ID,
  PERSONNEL_WORKFLOW_TABLE_DEFINITIONS,
  PERSONNEL_WORKFLOW_TABLE_NAMES,
  PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS,
  PERSONNEL_WORKFLOW_TRIGGER_NAMES,
  ensureSqlitePersonnelWorkflowSchema,
  inspectSqlitePersonnelWorkflowRows,
  inspectSqlitePersonnelWorkflowSchema,
  publicationReceiptBody: personnelWorkflowPublicationReceiptBody,
};
