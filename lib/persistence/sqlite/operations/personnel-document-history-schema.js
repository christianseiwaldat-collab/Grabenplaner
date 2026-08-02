"use strict";

const { createHash } = require("node:crypto");

const PERSONNEL_DOCUMENT_HISTORY_MIGRATION_ID = "v0.90-personnel-document-history";

const PERSONNEL_DOCUMENT_CATEGORY_SEEDS = Object.freeze([
  Object.freeze(["contract", "contract", "Dienstvertrag", 10]),
  Object.freeze(["amendment", "amendment", "Vertragsänderung", 20]),
  Object.freeze(["certificate", "certificate", "Nachweis", 30]),
  Object.freeze(["training", "training", "Schulung", 40]),
  Object.freeze(["identity", "identity", "Identitätsnachweis", 50]),
  Object.freeze(["payroll", "payroll", "Lohnverrechnung", 60]),
  Object.freeze(["other", "other", "Dokument", 70]),
]);

function definition(name, sql) {
  return Object.freeze({ name, sql: String(sql || "").trim() });
}

const PERSONNEL_DOCUMENT_HISTORY_TABLE_DEFINITIONS = Object.freeze([
  definition("personnel_document_categories", `
    CREATE TABLE IF NOT EXISTS personnel_document_categories (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      default_visibility TEXT NOT NULL DEFAULT 'hr_confidential'
        CHECK(default_visibility IN ('hr_confidential','scoped_leadership','employee_private')),
      retention_disposition TEXT NOT NULL DEFAULT 'manual_review'
        CHECK(retention_disposition = 'manual_review'),
      default_retention_days INTEGER
        CHECK(default_retention_days IS NULL OR default_retention_days >= 1),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      builtin INTEGER NOT NULL DEFAULT 0 CHECK(builtin IN (0,1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `),
  definition("personnel_record_document_versions", `
    CREATE TABLE IF NOT EXISTS personnel_record_document_versions (
      document_id TEXT NOT NULL,
      version_number INTEGER NOT NULL CHECK(version_number >= 1),
      storage_key TEXT NOT NULL UNIQUE,
      protected_payload TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (document_id, version_number),
      FOREIGN KEY (document_id) REFERENCES personnel_record_documents(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );
  `),
  definition("personnel_record_document_events", `
    CREATE TABLE IF NOT EXISTS personnel_record_document_events (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      sequence_number INTEGER NOT NULL CHECK(sequence_number >= 1),
      event_type TEXT NOT NULL
        CHECK(event_type IN (
          'registered','version_added','archived','retention_review','legacy_purged'
        )),
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
      UNIQUE(document_id, sequence_number),
      FOREIGN KEY (document_id) REFERENCES personnel_record_documents(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );
  `),
]);

const PERSONNEL_DOCUMENT_HISTORY_TABLE_NAMES = Object.freeze(
  PERSONNEL_DOCUMENT_HISTORY_TABLE_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_DOCUMENT_HISTORY_ROOT_COLUMN_CONTRACTS = Object.freeze({
  current_version: Object.freeze({ affinity: "INTEGER", notNull: true, defaultValue: "0" }),
  revision: Object.freeze({ affinity: "INTEGER", notNull: true, defaultValue: "1" }),
  archived_by: Object.freeze({ affinity: "TEXT", notNull: false, defaultValue: null }),
  archived_at: Object.freeze({ affinity: "TEXT", notNull: false, defaultValue: null }),
});

const PERSONNEL_DOCUMENT_HISTORY_ROOT_COLUMNS = Object.freeze(
  Object.keys(PERSONNEL_DOCUMENT_HISTORY_ROOT_COLUMN_CONTRACTS),
);

const PERSONNEL_DOCUMENT_HISTORY_TRIGGER_DEFINITIONS = Object.freeze([
  definition("trg_personnel_record_document_versions_sequence", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_record_document_versions_sequence
    BEFORE INSERT ON personnel_record_document_versions
    WHEN NEW.version_number <> COALESCE((
      SELECT MAX(version_number) + 1
      FROM personnel_record_document_versions
      WHERE document_id = NEW.document_id
    ), 1)
    OR EXISTS (
      SELECT 1 FROM personnel_record_documents document
      WHERE document.id = NEW.document_id
        AND document.status <> 'active'
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel document version sequence is invalid');
    END;
  `),
  definition("trg_personnel_record_document_versions_immutable_update", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_record_document_versions_immutable_update
    BEFORE UPDATE ON personnel_record_document_versions
    BEGIN
      SELECT RAISE(ABORT, 'personnel document versions are immutable');
    END;
  `),
  definition("trg_personnel_record_document_versions_immutable_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_record_document_versions_immutable_delete
    BEFORE DELETE ON personnel_record_document_versions
    BEGIN
      SELECT RAISE(ABORT, 'personnel document versions are immutable');
    END;
  `),
  definition("trg_personnel_record_documents_pointer_update", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_record_documents_pointer_update
    BEFORE UPDATE OF storage_key, protected_payload, current_version
      ON personnel_record_documents
    WHEN NEW.storage_key <> OLD.storage_key
      OR NEW.protected_payload <> OLD.protected_payload
      OR NEW.current_version <> OLD.current_version
    BEGIN
      SELECT CASE WHEN NOT (
        OLD.status = 'active'
        AND NEW.status = 'active'
        AND NEW.current_version = OLD.current_version + 1
        AND EXISTS (
          SELECT 1
          FROM personnel_record_document_versions version
          WHERE version.document_id = NEW.id
            AND version.version_number = NEW.current_version
            AND version.storage_key = NEW.storage_key
            AND version.protected_payload = NEW.protected_payload
        )
      ) THEN RAISE(ABORT, 'personnel document current pointer is invalid') END;
    END;
  `),
  definition("trg_personnel_record_documents_no_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_record_documents_no_delete
    BEFORE DELETE ON personnel_record_documents
    WHEN OLD.current_version > 0
    BEGIN
      SELECT RAISE(ABORT, 'versioned personnel documents cannot be deleted');
    END;
  `),
  definition("trg_personnel_record_documents_no_purge", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_record_documents_no_purge
    BEFORE UPDATE OF status ON personnel_record_documents
    WHEN OLD.current_version > 0
      AND NEW.status IN ('deleted','purged')
    BEGIN
      SELECT RAISE(ABORT, 'versioned personnel documents cannot be purged');
    END;
  `),
  definition("trg_personnel_record_documents_archive_transition", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_record_documents_archive_transition
    BEFORE UPDATE OF status, archived_by, archived_at ON personnel_record_documents
    WHEN OLD.current_version > 0
      AND NEW.status NOT IN ('deleted','purged')
      AND NOT (
        (
          NEW.status = OLD.status
          AND NEW.archived_by IS OLD.archived_by
          AND NEW.archived_at IS OLD.archived_at
        )
        OR (
          OLD.status = 'active'
          AND NEW.status = 'retention_review'
          AND NEW.archived_by IS NULL
          AND NEW.archived_at IS NULL
          AND NEW.revision = OLD.revision + 1
        )
        OR (
          OLD.status IN ('active','retention_review')
          AND NEW.status = 'archived'
          AND length(trim(COALESCE(NEW.archived_by, ''))) > 0
          AND length(trim(COALESCE(NEW.archived_at, ''))) > 0
          AND NEW.revision = OLD.revision + 1
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'personnel document archive transition is invalid');
    END;
  `),
  definition("trg_personnel_record_document_events_chain", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_record_document_events_chain
    BEFORE INSERT ON personnel_record_document_events
    WHEN NEW.sequence_number <> COALESCE((
      SELECT MAX(sequence_number) + 1
      FROM personnel_record_document_events
      WHERE document_id = NEW.document_id
    ), 1)
    OR NEW.previous_receipt_sha256 <> COALESCE((
      SELECT receipt_sha256
      FROM personnel_record_document_events
      WHERE document_id = NEW.document_id
      ORDER BY sequence_number DESC
      LIMIT 1
    ), '')
    BEGIN
      SELECT RAISE(ABORT, 'personnel document event chain is invalid');
    END;
  `),
  definition("trg_personnel_record_document_events_immutable_update", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_record_document_events_immutable_update
    BEFORE UPDATE ON personnel_record_document_events
    BEGIN
      SELECT RAISE(ABORT, 'personnel document events are immutable');
    END;
  `),
  definition("trg_personnel_record_document_events_immutable_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_record_document_events_immutable_delete
    BEFORE DELETE ON personnel_record_document_events
    BEGIN
      SELECT RAISE(ABORT, 'personnel document events are immutable');
    END;
  `),
]);

const PERSONNEL_DOCUMENT_HISTORY_TRIGGER_NAMES = Object.freeze(
  PERSONNEL_DOCUMENT_HISTORY_TRIGGER_DEFINITIONS.map(({ name }) => name),
);

function normalizeSql(value, type) {
  const prefix = type === "trigger"
    ? /^create trigger if not exists /i
    : /^create table if not exists /i;
  return String(value || "")
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
    const stored = read.get(type, item.name);
    if (!stored?.sql) missing.push(item.name);
    else if (normalizeSql(stored.sql, type) !== normalizeSql(item.sql, type)) invalid.push(item.name);
  }
  return { missing: Object.freeze(missing), invalid: Object.freeze(invalid) };
}

function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function rootColumns(database) {
  if (!tableExists(database, "personnel_record_documents")) return new Map();
  return new Map(database.prepare("PRAGMA table_info(personnel_record_documents)").all()
    .map((column) => [String(column.name || ""), column]));
}

function sqliteColumnAffinity(declaredType) {
  const type = String(declaredType || "").trim().toUpperCase();
  if (type.includes("INT")) return "INTEGER";
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) return "TEXT";
  if (!type || type.includes("BLOB")) return "BLOB";
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

function normalizedColumnDefault(value) {
  if (value === null || value === undefined) return null;
  let normalized = String(value).trim();
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1).trim();
  }
  return /^null$/i.test(normalized) ? null : normalized;
}

function inspectSqlitePersonnelDocumentHistorySchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const tables = inspectDefinitions(database, "table", PERSONNEL_DOCUMENT_HISTORY_TABLE_DEFINITIONS);
  const triggers = inspectDefinitions(database, "trigger", PERSONNEL_DOCUMENT_HISTORY_TRIGGER_DEFINITIONS);
  const columns = rootColumns(database);
  const missingRootColumns = PERSONNEL_DOCUMENT_HISTORY_ROOT_COLUMNS
    .filter((name) => !columns.has(name));
  const rootColumnIssues = [];
  const invalidRootColumns = new Set();
  for (const [name, expected] of Object.entries(
    PERSONNEL_DOCUMENT_HISTORY_ROOT_COLUMN_CONTRACTS,
  )) {
    const actual = columns.get(name);
    if (!actual) continue;
    if (sqliteColumnAffinity(actual.type) !== expected.affinity) {
      rootColumnIssues.push(`root-column-affinity-invalid:${name}`);
      invalidRootColumns.add(name);
    }
    if (Boolean(actual.notnull) !== expected.notNull) {
      rootColumnIssues.push(`root-column-not-null-invalid:${name}`);
      invalidRootColumns.add(name);
    }
    if (normalizedColumnDefault(actual.dflt_value) !== expected.defaultValue) {
      rootColumnIssues.push(`root-column-default-invalid:${name}`);
      invalidRootColumns.add(name);
    }
  }
  const targetObjectsPresent = tables.missing.length < PERSONNEL_DOCUMENT_HISTORY_TABLE_DEFINITIONS.length
    || triggers.missing.length < PERSONNEL_DOCUMENT_HISTORY_TRIGGER_DEFINITIONS.length
    || PERSONNEL_DOCUMENT_HISTORY_ROOT_COLUMNS.some((name) => columns.has(name));
  const issues = Object.freeze([
    ...tables.missing.map((name) => `table-missing:${name}`),
    ...tables.invalid.map((name) => `table-invalid:${name}`),
    ...triggers.missing.map((name) => `trigger-missing:${name}`),
    ...triggers.invalid.map((name) => `trigger-invalid:${name}`),
    ...missingRootColumns.map((name) => `root-column-missing:${name}`),
    ...rootColumnIssues,
  ]);
  return Object.freeze({
    valid: issues.length === 0,
    absent: !targetObjectsPresent,
    issues,
    missingTables: tables.missing,
    invalidTables: tables.invalid,
    missingTriggers: triggers.missing,
    invalidTriggers: triggers.invalid,
    missingRootColumns: Object.freeze(missingRootColumns),
    invalidRootColumns: Object.freeze([...invalidRootColumns]),
  });
}

function eventReceiptBody(row) {
  return {
    schemaVersion: 1,
    id: String(row.id || ""),
    documentId: String(row.document_id ?? row.documentId ?? ""),
    sequenceNumber: Number(row.sequence_number ?? row.sequenceNumber ?? 0),
    eventType: String(row.event_type ?? row.eventType ?? ""),
    previousReceiptSha256: String(
      row.previous_receipt_sha256 ?? row.previousReceiptSha256 ?? "",
    ),
    actorEmployeeNumber: String(
      row.actor_employee_number ?? row.actorEmployeeNumber ?? "",
    ),
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
  };
}

function eventReceiptSha256(row) {
  return createHash("sha256")
    .update(JSON.stringify(eventReceiptBody(row)))
    .digest("hex");
}

function inspectSqlitePersonnelDocumentHistoryRows(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const schema = inspectSqlitePersonnelDocumentHistorySchema(database);
  if (!schema.valid) {
    return Object.freeze({ valid: schema.absent, absent: schema.absent, issues: schema.issues });
  }
  const issues = [];
  const categories = new Map(database.prepare(`
    SELECT id, code, default_visibility, retention_disposition,
           default_retention_days, active, builtin
    FROM personnel_document_categories
    ORDER BY id
  `).all().map((row) => [row.id, row]));
  for (const [id, code] of PERSONNEL_DOCUMENT_CATEGORY_SEEDS) {
    const category = categories.get(id);
    if (!category
      || category.code !== code
      || category.default_visibility !== "hr_confidential"
      || category.retention_disposition !== "manual_review"
      || category.default_retention_days !== null
      || Number(category.active) !== 1
      || Number(category.builtin) !== 1) {
      issues.push(`category-seed-invalid:${id}`);
    }
  }
  const documents = database.prepare(`
    SELECT id, storage_key, status, protected_payload, current_version, revision,
           archived_by, archived_at
    FROM personnel_record_documents
    ORDER BY id
  `).all();
  const versionsByDocument = new Map();
  for (const row of database.prepare(`
    SELECT document_id, version_number, storage_key, protected_payload, created_by, created_at
    FROM personnel_record_document_versions
    ORDER BY document_id, version_number
  `).all()) {
    const rows = versionsByDocument.get(row.document_id) || [];
    rows.push(row);
    versionsByDocument.set(row.document_id, rows);
  }
  const eventsByDocument = new Map();
  for (const row of database.prepare(`
    SELECT id, document_id, sequence_number, event_type, previous_receipt_sha256,
           receipt_sha256, actor_employee_number, created_at
    FROM personnel_record_document_events
    ORDER BY document_id, sequence_number
  `).all()) {
    const rows = eventsByDocument.get(row.document_id) || [];
    rows.push(row);
    eventsByDocument.set(row.document_id, rows);
  }
  const documentIds = new Set(documents.map(({ id }) => id));
  for (const document of documents) {
    const versions = versionsByDocument.get(document.id) || [];
    const events = eventsByDocument.get(document.id) || [];
    if (document.status === "purged") {
      if (Number(document.current_version) !== 0 || versions.length) {
        issues.push(`purged-document-versioned:${document.id}`);
      }
      if (events.length !== 1 || events[0].event_type !== "legacy_purged") {
        issues.push(`purged-document-event-invalid:${document.id}`);
      }
    } else {
      const currentVersion = Number(document.current_version);
      if (typeof document.revision !== "number"
        || !Number.isSafeInteger(document.revision)
        || document.revision < 1) {
        issues.push(`document-revision-invalid:${document.id}`);
      }
      if (!Number.isSafeInteger(currentVersion) || currentVersion < 1
        || versions.length !== currentVersion
        || versions.some((row, index) => Number(row.version_number) !== index + 1)
        || versions.at(-1)?.storage_key !== document.storage_key
        || versions.at(-1)?.protected_payload !== document.protected_payload) {
        issues.push(`document-version-invalid:${document.id}`);
      }
      let eventState = "initial";
      let versionAddedEvents = 0;
      let eventStateInvalid = false;
      for (const { event_type: eventType } of events) {
        if (eventState === "initial" && eventType === "registered") {
          eventState = "active";
        } else if (eventState === "active" && eventType === "version_added") {
          versionAddedEvents += 1;
        } else if (eventState === "active" && eventType === "retention_review") {
          eventState = "retention_review";
        } else if (["active", "retention_review"].includes(eventState)
          && eventType === "archived") {
          eventState = "archived";
        } else {
          eventStateInvalid = true;
          break;
        }
      }
      const terminalEvent = events.at(-1);
      if (eventStateInvalid
        || eventState !== document.status
        || versionAddedEvents !== Math.max(0, currentVersion - 1)
        || !["active", "archived", "retention_review"].includes(document.status)) {
        issues.push(`document-status-event-invalid:${document.id}`);
      }
      if (document.status === "archived") {
        if (!document.archived_by || !document.archived_at
          || String(document.archived_by) !== String(terminalEvent?.actor_employee_number || "")
          || String(document.archived_at) !== String(terminalEvent?.created_at || "")) {
          issues.push(`document-archive-metadata-invalid:${document.id}`);
        }
      } else if (document.archived_by !== null || document.archived_at !== null) {
        issues.push(`document-archive-metadata-invalid:${document.id}`);
      }
    }
    let previous = "";
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (Number(event.sequence_number) !== index + 1
        || event.previous_receipt_sha256 !== previous) {
        issues.push(`document-event-chain-invalid:${document.id}`);
        break;
      }
      if (eventReceiptSha256(event) !== event.receipt_sha256) {
        issues.push(`document-event-receipt-invalid:${document.id}`);
        break;
      }
      previous = event.receipt_sha256;
    }
  }
  for (const documentId of new Set([...versionsByDocument.keys(), ...eventsByDocument.keys()])) {
    if (!documentIds.has(documentId)) issues.push(`document-history-orphan:${documentId}`);
  }
  return Object.freeze({
    valid: issues.length === 0,
    absent: false,
    issues: Object.freeze([...new Set(issues)]),
  });
}

function ensureRootColumns(database) {
  const columns = rootColumns(database);
  const definitions = Object.freeze({
    current_version: "INTEGER NOT NULL DEFAULT 0",
    revision: "INTEGER NOT NULL DEFAULT 1",
    archived_by: "TEXT",
    archived_at: "TEXT",
  });
  for (const [name, columnDefinition] of Object.entries(definitions)) {
    if (!columns.has(name)) database.exec(
      `ALTER TABLE personnel_record_documents ADD COLUMN "${name}" ${columnDefinition}`,
    );
  }
}

function ensureSqlitePersonnelDocumentHistorySchema(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  ensureRootColumns(database);
  for (const item of PERSONNEL_DOCUMENT_HISTORY_TABLE_DEFINITIONS) database.exec(item.sql);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_personnel_document_categories_active
      ON personnel_document_categories(active, sort_order, label, id);
    CREATE INDEX IF NOT EXISTS idx_personnel_record_document_versions_document
      ON personnel_record_document_versions(document_id, version_number);
    CREATE INDEX IF NOT EXISTS idx_personnel_record_document_events_document
      ON personnel_record_document_events(document_id, sequence_number);
  `);
  const insertCategory = database.prepare(`
    INSERT INTO personnel_document_categories (
      id, code, label, default_visibility, retention_disposition,
      default_retention_days, active, builtin, sort_order
    ) VALUES (?, ?, ?, 'hr_confidential', 'manual_review', NULL, 1, 1, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  for (const category of PERSONNEL_DOCUMENT_CATEGORY_SEEDS) insertCategory.run(...category);
  for (const item of PERSONNEL_DOCUMENT_HISTORY_TRIGGER_DEFINITIONS) database.exec(item.sql);
}

module.exports = {
  PERSONNEL_DOCUMENT_CATEGORY_SEEDS,
  PERSONNEL_DOCUMENT_HISTORY_MIGRATION_ID,
  PERSONNEL_DOCUMENT_HISTORY_ROOT_COLUMNS,
  PERSONNEL_DOCUMENT_HISTORY_TABLE_DEFINITIONS,
  PERSONNEL_DOCUMENT_HISTORY_TABLE_NAMES,
  PERSONNEL_DOCUMENT_HISTORY_TRIGGER_DEFINITIONS,
  PERSONNEL_DOCUMENT_HISTORY_TRIGGER_NAMES,
  ensureSqlitePersonnelDocumentHistorySchema,
  eventReceiptBody,
  eventReceiptSha256,
  inspectSqlitePersonnelDocumentHistoryRows,
  inspectSqlitePersonnelDocumentHistorySchema,
};
