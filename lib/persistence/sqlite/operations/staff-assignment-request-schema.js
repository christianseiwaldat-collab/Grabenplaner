"use strict";

const { canonicalSha256 } = require("../../../work-rules/receipt");
const {
  eventPayloadForStaffAssignmentRequest,
  staffAssignmentRequestEventReceiptSha256,
  staffAssignmentRequestReceiptSha256,
  staffAssignmentRequestRevisionReceiptSha256,
} = require("../../../staff-assignment-requests");

const STAFF_ASSIGNMENT_REQUEST_MIGRATION_ID =
  "v0.92.9-staff-assignment-request-versioning";

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

const STAFF_ASSIGNMENT_REQUEST_TABLE_DEFINITIONS = Object.freeze([
  definition("staff_assignment_requests", `
    CREATE TABLE IF NOT EXISTS staff_assignment_requests (
      id TEXT PRIMARY KEY CHECK(length(TRIM(id)) BETWEEN 1 AND 120),
      created_by_employee_number TEXT NOT NULL
        CHECK(length(TRIM(created_by_employee_number)) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(TRIM(created_at) <> ''),
      ${sha256Column("receipt_sha256")},
      FOREIGN KEY (created_by_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `),
  definition("staff_assignment_request_revisions", `
    CREATE TABLE IF NOT EXISTS staff_assignment_request_revisions (
      request_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL CHECK(revision_number >= 1),
      status TEXT NOT NULL CHECK(status IN (
        'draft','submitted','accepted','rejected','withdrawn','cancelled','expired'
      )),
      source_location_id TEXT NOT NULL CHECK(TRIM(source_location_id) <> ''),
      destination_location_id TEXT NOT NULL CHECK(TRIM(destination_location_id) <> ''),
      destination_department_id INTEGER NOT NULL CHECK(destination_department_id >= 1),
      period_start_date TEXT NOT NULL
        CHECK(
          length(period_start_date) = 10
          AND period_start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          AND date(period_start_date, '+0 days') = period_start_date
        ),
      period_end_date TEXT NOT NULL
        CHECK(
          length(period_end_date) = 10
          AND period_end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          AND date(period_end_date, '+0 days') = period_end_date
        ),
      time_kind TEXT NOT NULL CHECK(time_kind IN ('hourly','full_day','multi_day')),
      start_time TEXT,
      end_time TEXT,
      preferred_employee_number TEXT,
      confirmed_employee_number TEXT,
      request_reason TEXT NOT NULL DEFAULT '' CHECK(length(request_reason) <= 2000),
      decision_reason TEXT NOT NULL DEFAULT '' CHECK(length(decision_reason) <= 2000),
      ${sha256Column("previous_receipt_sha256", { allowEmpty: true })},
      ${sha256Column("receipt_sha256")},
      changed_by_employee_number TEXT NOT NULL
        CHECK(length(TRIM(changed_by_employee_number)) BETWEEN 1 AND 120),
      changed_at TEXT NOT NULL CHECK(TRIM(changed_at) <> ''),
      PRIMARY KEY (request_id, revision_number),
      UNIQUE(receipt_sha256),
      CHECK(source_location_id <> destination_location_id),
      CHECK(period_end_date >= period_start_date),
      CHECK(
        (time_kind = 'hourly'
          AND period_start_date = period_end_date
          AND start_time IS NOT NULL AND end_time IS NOT NULL
          AND start_time GLOB '[0-2][0-9]:[0-5][0-9]'
          AND end_time GLOB '[0-2][0-9]:[0-5][0-9]'
          AND CAST(substr(start_time, 1, 2) AS INTEGER) <= 23
          AND CAST(substr(end_time, 1, 2) AS INTEGER) <= 23
          AND end_time > start_time)
        OR (time_kind = 'full_day'
          AND period_start_date = period_end_date
          AND start_time IS NULL AND end_time IS NULL)
        OR (time_kind = 'multi_day'
          AND period_start_date < period_end_date
          AND start_time IS NULL AND end_time IS NULL)
      ),
      CHECK(
        (status IN ('accepted','cancelled') AND confirmed_employee_number IS NOT NULL
          AND TRIM(confirmed_employee_number) <> '')
        OR (status NOT IN ('accepted','cancelled') AND confirmed_employee_number IS NULL)
      ),
      CHECK(status = 'draft' OR TRIM(request_reason) <> ''),
      FOREIGN KEY (request_id) REFERENCES staff_assignment_requests(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (source_location_id) REFERENCES locations(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (destination_location_id) REFERENCES locations(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (destination_department_id) REFERENCES departments(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (preferred_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (confirmed_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (changed_by_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `),
  definition("staff_assignment_request_events", `
    CREATE TABLE IF NOT EXISTS staff_assignment_request_events (
      id TEXT PRIMARY KEY CHECK(length(TRIM(id)) BETWEEN 1 AND 120),
      request_id TEXT NOT NULL,
      sequence_number INTEGER NOT NULL CHECK(sequence_number >= 1),
      request_revision_number INTEGER NOT NULL CHECK(request_revision_number >= 1),
      event_type TEXT NOT NULL CHECK(event_type IN (
        'created','revised','submitted','accepted','rejected','withdrawn','cancelled','expired'
      )),
      from_status TEXT CHECK(from_status IN (
        'draft','submitted','accepted','rejected','withdrawn','cancelled','expired'
      )),
      to_status TEXT NOT NULL CHECK(to_status IN (
        'draft','submitted','accepted','rejected','withdrawn','cancelled','expired'
      )),
      event_payload_json TEXT NOT NULL
        CHECK(json_valid(event_payload_json) AND json_type(event_payload_json) = 'object'),
      ${sha256Column("event_payload_sha256")},
      ${sha256Column("previous_receipt_sha256", { allowEmpty: true })},
      ${sha256Column("receipt_sha256")},
      actor_employee_number TEXT NOT NULL
        CHECK(length(TRIM(actor_employee_number)) BETWEEN 1 AND 120),
      occurred_at TEXT NOT NULL CHECK(TRIM(occurred_at) <> ''),
      UNIQUE(request_id, sequence_number),
      UNIQUE(request_id, request_revision_number),
      UNIQUE(receipt_sha256),
      FOREIGN KEY (request_id) REFERENCES staff_assignment_requests(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (request_id, request_revision_number)
        REFERENCES staff_assignment_request_revisions(request_id, revision_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (actor_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `),
]);

const STAFF_ASSIGNMENT_REQUEST_TABLE_NAMES = Object.freeze(
  STAFF_ASSIGNMENT_REQUEST_TABLE_DEFINITIONS.map(({ name }) => name),
);

function immutableTriggers(tableName) {
  return [
    definition(`trg_${tableName}_immutable_update`, `
      CREATE TRIGGER IF NOT EXISTS trg_${tableName}_immutable_update
      BEFORE UPDATE ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, 'staff assignment request history is immutable');
      END
    `),
    definition(`trg_${tableName}_immutable_delete`, `
      CREATE TRIGGER IF NOT EXISTS trg_${tableName}_immutable_delete
      BEFORE DELETE ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, 'staff assignment request history is immutable');
      END
    `),
  ];
}

const STAFF_ASSIGNMENT_REQUEST_TRIGGER_DEFINITIONS = Object.freeze([
  ...immutableTriggers("staff_assignment_requests"),
  definition("trg_staff_assignment_request_revisions_sequence", `
    CREATE TRIGGER IF NOT EXISTS trg_staff_assignment_request_revisions_sequence
    BEFORE INSERT ON staff_assignment_request_revisions
    WHEN NEW.revision_number <> COALESCE((
      SELECT MAX(revision_number) + 1
      FROM staff_assignment_request_revisions
      WHERE request_id = NEW.request_id
    ), 1)
    OR NEW.previous_receipt_sha256 <> COALESCE((
      SELECT receipt_sha256
      FROM staff_assignment_request_revisions
      WHERE request_id = NEW.request_id
      ORDER BY revision_number DESC
      LIMIT 1
    ), '')
    BEGIN
      SELECT RAISE(ABORT, 'staff assignment request revision chain is invalid');
    END
  `),
  definition("trg_staff_assignment_request_revisions_transition", `
    CREATE TRIGGER IF NOT EXISTS trg_staff_assignment_request_revisions_transition
    BEFORE INSERT ON staff_assignment_request_revisions
    WHEN (NEW.revision_number = 1 AND NEW.status <> 'draft')
      OR (NEW.revision_number > 1 AND NOT EXISTS (
        SELECT 1
        FROM staff_assignment_request_revisions previous
        WHERE previous.request_id = NEW.request_id
          AND previous.revision_number = NEW.revision_number - 1
          AND (
            (previous.status = 'draft' AND NEW.status IN ('draft','submitted','withdrawn','expired'))
            OR (previous.status = 'submitted'
              AND NEW.status IN ('accepted','rejected','withdrawn','expired'))
            OR (previous.status = 'accepted' AND NEW.status = 'cancelled')
          )
      ))
    BEGIN
      SELECT RAISE(ABORT, 'staff assignment request transition is invalid');
    END
  `),
  definition("trg_staff_assignment_request_revisions_locked_fields", `
    CREATE TRIGGER IF NOT EXISTS trg_staff_assignment_request_revisions_locked_fields
    BEFORE INSERT ON staff_assignment_request_revisions
    WHEN NEW.revision_number > 1
      AND NEW.status <> 'draft'
      AND EXISTS (
        SELECT 1
        FROM staff_assignment_request_revisions previous
        WHERE previous.request_id = NEW.request_id
          AND previous.revision_number = NEW.revision_number - 1
          AND (
            previous.source_location_id IS NOT NEW.source_location_id
            OR previous.destination_location_id IS NOT NEW.destination_location_id
            OR previous.destination_department_id IS NOT NEW.destination_department_id
            OR previous.period_start_date IS NOT NEW.period_start_date
            OR previous.period_end_date IS NOT NEW.period_end_date
            OR previous.time_kind IS NOT NEW.time_kind
            OR previous.start_time IS NOT NEW.start_time
            OR previous.end_time IS NOT NEW.end_time
            OR previous.preferred_employee_number IS NOT NEW.preferred_employee_number
            OR previous.request_reason IS NOT NEW.request_reason
            OR (previous.status = 'accepted'
              AND previous.confirmed_employee_number IS NOT NEW.confirmed_employee_number)
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'staff assignment request submitted fields are locked');
    END
  `),
  definition("trg_staff_assignment_request_revisions_department_scope", `
    CREATE TRIGGER IF NOT EXISTS trg_staff_assignment_request_revisions_department_scope
    BEFORE INSERT ON staff_assignment_request_revisions
    WHEN NOT EXISTS (
      SELECT 1
      FROM departments department
      WHERE department.id = NEW.destination_department_id
        AND department.location_id = NEW.destination_location_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'staff assignment request destination department is invalid');
    END
  `),
  ...immutableTriggers("staff_assignment_request_revisions"),
  definition("trg_staff_assignment_request_events_chain", `
    CREATE TRIGGER IF NOT EXISTS trg_staff_assignment_request_events_chain
    BEFORE INSERT ON staff_assignment_request_events
    WHEN NEW.sequence_number <> NEW.request_revision_number
      OR NEW.sequence_number <> COALESCE((
        SELECT MAX(sequence_number) + 1
        FROM staff_assignment_request_events
        WHERE request_id = NEW.request_id
      ), 1)
      OR NEW.previous_receipt_sha256 <> COALESCE((
        SELECT receipt_sha256
        FROM staff_assignment_request_events
        WHERE request_id = NEW.request_id
        ORDER BY sequence_number DESC
        LIMIT 1
      ), '')
    BEGIN
      SELECT RAISE(ABORT, 'staff assignment request event chain is invalid');
    END
  `),
  definition("trg_staff_assignment_request_events_transition", `
    CREATE TRIGGER IF NOT EXISTS trg_staff_assignment_request_events_transition
    BEFORE INSERT ON staff_assignment_request_events
    WHEN NOT EXISTS (
      SELECT 1
      FROM staff_assignment_request_revisions revision
      LEFT JOIN staff_assignment_request_revisions previous
        ON previous.request_id = revision.request_id
       AND previous.revision_number = revision.revision_number - 1
      WHERE revision.request_id = NEW.request_id
        AND revision.revision_number = NEW.request_revision_number
        AND revision.status = NEW.to_status
        AND revision.changed_by_employee_number = NEW.actor_employee_number
        AND revision.changed_at = NEW.occurred_at
        AND (
          (NEW.event_type = 'created' AND NEW.sequence_number = 1
            AND NEW.from_status IS NULL AND NEW.to_status = 'draft')
          OR (NEW.event_type = 'revised' AND NEW.sequence_number > 1
            AND NEW.from_status = 'draft' AND NEW.to_status = 'draft'
            AND previous.status = NEW.from_status)
          OR (NEW.event_type = 'submitted' AND NEW.from_status = 'draft'
            AND NEW.to_status = 'submitted' AND previous.status = NEW.from_status)
          OR (NEW.event_type = 'accepted' AND NEW.from_status = 'submitted'
            AND NEW.to_status = 'accepted' AND previous.status = NEW.from_status)
          OR (NEW.event_type = 'rejected' AND NEW.from_status = 'submitted'
            AND NEW.to_status = 'rejected' AND previous.status = NEW.from_status)
          OR (NEW.event_type = 'withdrawn' AND NEW.from_status IN ('draft','submitted')
            AND NEW.to_status = 'withdrawn' AND previous.status = NEW.from_status)
          OR (NEW.event_type = 'cancelled' AND NEW.from_status = 'accepted'
            AND NEW.to_status = 'cancelled' AND previous.status = NEW.from_status)
          OR (NEW.event_type = 'expired' AND NEW.from_status IN ('draft','submitted')
            AND NEW.to_status = 'expired' AND previous.status = NEW.from_status)
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'staff assignment request event transition is invalid');
    END
  `),
  ...immutableTriggers("staff_assignment_request_events"),
  definition("trg_staff_assignment_request_department_location_update", `
    CREATE TRIGGER IF NOT EXISTS trg_staff_assignment_request_department_location_update
    BEFORE UPDATE OF location_id ON departments
    WHEN NEW.location_id IS NOT OLD.location_id
      AND EXISTS (
        SELECT 1
        FROM staff_assignment_request_revisions revision
        WHERE revision.destination_department_id = OLD.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'staff assignment request destination department is referenced');
    END
  `),
]);

const STAFF_ASSIGNMENT_REQUEST_TRIGGER_NAMES = Object.freeze(
  STAFF_ASSIGNMENT_REQUEST_TRIGGER_DEFINITIONS.map(({ name }) => name),
);

const STAFF_ASSIGNMENT_REQUEST_INDEX_DEFINITIONS = Object.freeze([
  definition("idx_staff_assignment_request_revisions_source_period", `
    CREATE INDEX IF NOT EXISTS idx_staff_assignment_request_revisions_source_period
      ON staff_assignment_request_revisions(
        source_location_id, period_start_date, period_end_date, request_id, revision_number
      )
  `),
  definition("idx_staff_assignment_request_revisions_destination_period", `
    CREATE INDEX IF NOT EXISTS idx_staff_assignment_request_revisions_destination_period
      ON staff_assignment_request_revisions(
        destination_location_id, destination_department_id,
        period_start_date, period_end_date, request_id, revision_number
      )
  `),
  definition("idx_staff_assignment_request_revisions_preferred_employee", `
    CREATE INDEX IF NOT EXISTS idx_staff_assignment_request_revisions_preferred_employee
      ON staff_assignment_request_revisions(
        preferred_employee_number, period_start_date, period_end_date
      )
      WHERE preferred_employee_number IS NOT NULL
  `),
  definition("idx_staff_assignment_request_revisions_confirmed_employee", `
    CREATE INDEX IF NOT EXISTS idx_staff_assignment_request_revisions_confirmed_employee
      ON staff_assignment_request_revisions(
        confirmed_employee_number, period_start_date, period_end_date
      )
      WHERE confirmed_employee_number IS NOT NULL
  `),
  definition("idx_staff_assignment_request_events_request", `
    CREATE INDEX IF NOT EXISTS idx_staff_assignment_request_events_request
      ON staff_assignment_request_events(request_id, sequence_number)
  `),
]);

const STAFF_ASSIGNMENT_REQUEST_INDEX_NAMES = Object.freeze(
  STAFF_ASSIGNMENT_REQUEST_INDEX_DEFINITIONS.map(({ name }) => name),
);

const STAFF_ASSIGNMENT_REQUEST_REQUIRED_TABLES = Object.freeze([
  "locations",
  "departments",
  "employees",
]);

function normalizeDefinitionSql(sql, type) {
  let normalized = String(sql || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .toLowerCase();
  if (type === "table") normalized = normalized.replace(/^create table if not exists /, "create table ");
  else if (type === "trigger") normalized = normalized.replace(/^create trigger if not exists /, "create trigger ");
  else if (type === "index") {
    normalized = normalized.replace(
      /^create (unique )?index if not exists /,
      (_, unique = "") => `create ${unique}index `,
    );
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
  return Object.freeze({ missing: Object.freeze(missing), invalid: Object.freeze(invalid) });
}

function inspectSqliteStaffAssignmentRequestSchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benötigt.");
  }
  const tables = inspectDefinitions(database, "table", STAFF_ASSIGNMENT_REQUEST_TABLE_DEFINITIONS);
  const triggers = inspectDefinitions(
    database,
    "trigger",
    STAFF_ASSIGNMENT_REQUEST_TRIGGER_DEFINITIONS,
  );
  const indexes = inspectDefinitions(database, "index", STAFF_ASSIGNMENT_REQUEST_INDEX_DEFINITIONS);
  const issues = Object.freeze([
    ...tables.missing.map((name) => `table-missing:${name}`),
    ...tables.invalid.map((name) => `table-invalid:${name}`),
    ...triggers.missing.map((name) => `trigger-missing:${name}`),
    ...triggers.invalid.map((name) => `trigger-invalid:${name}`),
    ...indexes.missing.map((name) => `index-missing:${name}`),
    ...indexes.invalid.map((name) => `index-invalid:${name}`),
  ]);
  const present = tables.missing.length < STAFF_ASSIGNMENT_REQUEST_TABLE_DEFINITIONS.length
    || triggers.missing.length < STAFF_ASSIGNMENT_REQUEST_TRIGGER_DEFINITIONS.length
    || indexes.missing.length < STAFF_ASSIGNMENT_REQUEST_INDEX_DEFINITIONS.length;
  return Object.freeze({
    valid: issues.length === 0,
    absent: !present,
    issues,
    missingTables: tables.missing,
    invalidTables: tables.invalid,
    missingTriggers: triggers.missing,
    invalidTriggers: triggers.invalid,
    missingIndexes: indexes.missing,
    invalidIndexes: indexes.invalid,
  });
}

function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
}

function parsedJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function inspectSqliteStaffAssignmentRequestRows(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benötigt.");
  }
  const schema = inspectSqliteStaffAssignmentRequestSchema(database);
  if (schema.missingTables.length || schema.invalidTables.length) {
    return Object.freeze({
      valid: schema.absent,
      absent: schema.absent,
      issues: Object.freeze(schema.absent ? [] : ["schema-invalid"]),
    });
  }
  const issues = [];
  for (const dependency of STAFF_ASSIGNMENT_REQUEST_REQUIRED_TABLES) {
    if (!tableExists(database, dependency)) issues.push(`dependency-missing:${dependency}`);
  }
  if (issues.length) return Object.freeze({ valid: false, absent: false, issues: Object.freeze(issues) });
  for (const tableName of STAFF_ASSIGNMENT_REQUEST_TABLE_NAMES) {
    for (const violation of database.prepare(`PRAGMA foreign_key_check("${tableName}")`).all()) {
      issues.push(`foreign-key:${tableName}:${violation.rowid ?? "unknown"}`);
    }
  }

  const requests = database.prepare(`
    SELECT id, created_by_employee_number, created_at, receipt_sha256
    FROM staff_assignment_requests
    ORDER BY id
  `).all();
  const requestIds = new Set(requests.map(({ id }) => id));
  for (const request of requests) {
    try {
      if (staffAssignmentRequestReceiptSha256(request) !== request.receipt_sha256) {
        issues.push(`request-receipt-invalid:${request.id}`);
      }
    } catch {
      issues.push(`request-row-invalid:${request.id || "missing"}`);
    }
  }

  const revisionsByRequest = new Map();
  for (const revision of database.prepare(`
    SELECT request_id, revision_number, status, source_location_id,
           destination_location_id, destination_department_id,
           period_start_date, period_end_date, time_kind, start_time, end_time,
           preferred_employee_number, confirmed_employee_number,
           request_reason, decision_reason, previous_receipt_sha256, receipt_sha256,
           changed_by_employee_number, changed_at
    FROM staff_assignment_request_revisions
    ORDER BY request_id, revision_number
  `).all()) {
    const rows = revisionsByRequest.get(revision.request_id) || [];
    rows.push(revision);
    revisionsByRequest.set(revision.request_id, rows);
  }
  const eventsByRequest = new Map();
  for (const event of database.prepare(`
    SELECT id, request_id, sequence_number, request_revision_number, event_type,
           from_status, to_status, event_payload_json, event_payload_sha256,
           previous_receipt_sha256, receipt_sha256, actor_employee_number, occurred_at
    FROM staff_assignment_request_events
    ORDER BY request_id, sequence_number
  `).all()) {
    const rows = eventsByRequest.get(event.request_id) || [];
    rows.push(event);
    eventsByRequest.set(event.request_id, rows);
  }
  const departmentLocations = new Map(database.prepare(
    "SELECT id, location_id FROM departments",
  ).all().map(({ id, location_id: locationId }) => [Number(id), locationId]));

  for (const request of requests) {
    const revisions = revisionsByRequest.get(request.id) || [];
    const events = eventsByRequest.get(request.id) || [];
    if (!revisions.length || revisions.length !== events.length) {
      issues.push(`request-history-incomplete:${request.id}`);
    }
    let previousRevisionReceipt = "";
    let previousEventReceipt = "";
    let previousStatus = null;
    for (let index = 0; index < revisions.length; index += 1) {
      const revision = revisions[index];
      const event = events[index];
      const revisionNumber = index + 1;
      try {
        if (Number(revision.revision_number) !== revisionNumber
          || revision.previous_receipt_sha256 !== previousRevisionReceipt
          || staffAssignmentRequestRevisionReceiptSha256(revision) !== revision.receipt_sha256) {
          issues.push(`request-revision-chain-invalid:${request.id}:${revisionNumber}`);
        }
      } catch {
        issues.push(`request-revision-row-invalid:${request.id}:${revisionNumber}`);
      }
      if (departmentLocations.get(Number(revision.destination_department_id))
        !== revision.destination_location_id) {
        issues.push(`request-revision-scope-invalid:${request.id}:${revisionNumber}`);
      }
      if (!event) {
        previousRevisionReceipt = revision.receipt_sha256;
        previousStatus = revision.status;
        continue;
      }
      const payload = parsedJsonObject(event.event_payload_json);
      try {
        const expectedPayload = eventPayloadForStaffAssignmentRequest({
          action: event.event_type,
          fromStatus: previousStatus,
          toStatus: revision.status,
          revisionNumber,
          revisionReceipt: revision.receipt_sha256,
        });
        if (Number(event.sequence_number) !== revisionNumber
          || Number(event.request_revision_number) !== revisionNumber
          || event.from_status !== previousStatus
          || event.to_status !== revision.status
          || event.actor_employee_number !== revision.changed_by_employee_number
          || event.occurred_at !== revision.changed_at
          || event.previous_receipt_sha256 !== previousEventReceipt
          || !payload
          || canonicalSha256(payload) !== event.event_payload_sha256
          || canonicalSha256(payload) !== canonicalSha256(expectedPayload)
          || staffAssignmentRequestEventReceiptSha256({
            ...event,
            eventPayload: payload,
          }) !== event.receipt_sha256) {
          issues.push(`request-event-chain-invalid:${request.id}:${revisionNumber}`);
        }
      } catch {
        issues.push(`request-event-row-invalid:${request.id}:${revisionNumber}`);
      }
      previousRevisionReceipt = revision.receipt_sha256;
      previousEventReceipt = event.receipt_sha256;
      previousStatus = revision.status;
    }
  }
  for (const requestId of new Set([...revisionsByRequest.keys(), ...eventsByRequest.keys()])) {
    if (!requestIds.has(requestId)) issues.push(`request-history-orphan:${requestId}`);
  }
  return Object.freeze({
    valid: issues.length === 0,
    absent: false,
    issues: Object.freeze([...new Set(issues)]),
  });
}

function ensureSqliteStaffAssignmentRequestSchema(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benötigt.");
  }
  for (const item of STAFF_ASSIGNMENT_REQUEST_TABLE_DEFINITIONS) database.exec(item.sql);
  for (const item of STAFF_ASSIGNMENT_REQUEST_INDEX_DEFINITIONS) database.exec(item.sql);
  for (const item of STAFF_ASSIGNMENT_REQUEST_TRIGGER_DEFINITIONS) database.exec(item.sql);
}

module.exports = {
  STAFF_ASSIGNMENT_REQUEST_INDEX_DEFINITIONS,
  STAFF_ASSIGNMENT_REQUEST_INDEX_NAMES,
  STAFF_ASSIGNMENT_REQUEST_MIGRATION_ID,
  STAFF_ASSIGNMENT_REQUEST_REQUIRED_TABLES,
  STAFF_ASSIGNMENT_REQUEST_TABLE_DEFINITIONS,
  STAFF_ASSIGNMENT_REQUEST_TABLE_NAMES,
  STAFF_ASSIGNMENT_REQUEST_TRIGGER_DEFINITIONS,
  STAFF_ASSIGNMENT_REQUEST_TRIGGER_NAMES,
  ensureSqliteStaffAssignmentRequestSchema,
  inspectSqliteStaffAssignmentRequestRows,
  inspectSqliteStaffAssignmentRequestSchema,
};
