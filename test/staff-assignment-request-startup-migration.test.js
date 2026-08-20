"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  STAFF_ASSIGNMENT_REQUEST_MIGRATION_ID,
  inspectSqliteStaffAssignmentRequestRows,
  inspectSqliteStaffAssignmentRequestSchema,
} = require("../lib/persistence/sqlite/operations/staff-assignment-request-schema");
const {
  runSqliteStartupSchemaMigrations,
} = require("../lib/persistence/sqlite/operations/startup-schema-migrations");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");
const { canonicalSha256 } = require("../lib/work-rules/receipt");
const {
  staffAssignmentRequestReceiptSha256,
  staffAssignmentRequestRevisionReceiptSha256,
  eventPayloadForStaffAssignmentRequest,
  staffAssignmentRequestEventReceiptSha256,
} = require("../lib/staff-assignment-requests");

function migrate(database, { databaseExistedBeforeOpen = false, onBackup = () => {} } = {}) {
  return runSqliteStartupSchemaMigrations({
    database,
    databaseExistedBeforeOpen,
    appVersion: "0.92.9-staff-request-test",
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
    createPreMigrationBackup: onBackup,
    workRuleSha256: canonicalSha256,
  });
}

function dropRequestSchema(database) {
  for (const row of database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND name LIKE 'trg_staff_assignment_request%'
  `).all()) database.exec(`DROP TRIGGER "${row.name}"`);
  for (const row of database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name LIKE 'idx_staff_assignment_request%'
  `).all()) database.exec(`DROP INDEX "${row.name}"`);
  database.exec(`
    DROP TABLE staff_assignment_request_events;
    DROP TABLE staff_assignment_request_revisions;
    DROP TABLE staff_assignment_requests;
  `);
  database.prepare("DELETE FROM schema_migrations WHERE id = ?")
    .run(STAFF_ASSIGNMENT_REQUEST_MIGRATION_ID);
}

function seedRequest(database) {
  database.exec(`
    INSERT INTO locations (id, name, active) VALUES
      ('migration-source', 'Quelle', 1),
      ('migration-destination', 'Ziel', 1);
    INSERT INTO departments (id, location_id, name, active)
      VALUES (92911, 'migration-destination', 'Zielabteilung', 1);
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id, active
    ) VALUES ('MIGRATION-ACTOR', 'Migration Actor', 'Actor', 'migration-destination', 1);
  `);
  const request = {
    id: "migration-request",
    createdByEmployeeNumber: "MIGRATION-ACTOR",
    createdAt: "2026-08-19T12:00:00.000Z",
  };
  request.receiptSha256 = staffAssignmentRequestReceiptSha256(request);
  const revision = {
    requestId: request.id,
    revisionNumber: 1,
    status: "draft",
    sourceLocationId: "migration-source",
    destinationLocationId: "migration-destination",
    destinationDepartmentId: 92911,
    periodStartDate: "2026-08-27",
    periodEndDate: "2026-08-27",
    timeKind: "full_day",
    startTime: null,
    endTime: null,
    preferredEmployeeNumber: null,
    confirmedEmployeeNumber: null,
    requestReason: "",
    decisionReason: "",
    previousReceiptSha256: "",
    changedByEmployeeNumber: "MIGRATION-ACTOR",
    changedAt: request.createdAt,
  };
  revision.receiptSha256 = staffAssignmentRequestRevisionReceiptSha256(revision);
  const payload = eventPayloadForStaffAssignmentRequest({
    action: "created",
    fromStatus: null,
    toStatus: "draft",
    revisionNumber: 1,
    revisionReceipt: revision.receiptSha256,
  });
  const event = {
    id: "migration-event",
    requestId: request.id,
    sequenceNumber: 1,
    requestRevisionNumber: 1,
    eventType: "created",
    fromStatus: null,
    toStatus: "draft",
    eventPayload: payload,
    eventPayloadSha256: canonicalSha256(payload),
    previousReceiptSha256: "",
    actorEmployeeNumber: "MIGRATION-ACTOR",
    occurredAt: request.createdAt,
  };
  event.receiptSha256 = staffAssignmentRequestEventReceiptSha256(event);
  database.prepare(`
    INSERT INTO staff_assignment_requests (
      id, created_by_employee_number, created_at, receipt_sha256
    ) VALUES (?, ?, ?, ?)
  `).run(request.id, request.createdByEmployeeNumber, request.createdAt, request.receiptSha256);
  database.prepare(`
    INSERT INTO staff_assignment_request_revisions (
      request_id, revision_number, status, source_location_id,
      destination_location_id, destination_department_id, period_start_date,
      period_end_date, time_kind, start_time, end_time, preferred_employee_number,
      confirmed_employee_number, request_reason, decision_reason,
      previous_receipt_sha256, receipt_sha256, changed_by_employee_number, changed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...[
    revision.requestId, revision.revisionNumber, revision.status,
    revision.sourceLocationId, revision.destinationLocationId,
    revision.destinationDepartmentId, revision.periodStartDate, revision.periodEndDate,
    revision.timeKind, revision.startTime, revision.endTime,
    revision.preferredEmployeeNumber, revision.confirmedEmployeeNumber,
    revision.requestReason, revision.decisionReason, revision.previousReceiptSha256,
    revision.receiptSha256, revision.changedByEmployeeNumber, revision.changedAt,
  ]);
  database.prepare(`
    INSERT INTO staff_assignment_request_events (
      id, request_id, sequence_number, request_revision_number, event_type,
      from_status, to_status, event_payload_json, event_payload_sha256,
      previous_receipt_sha256, receipt_sha256, actor_employee_number, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...[
    event.id, event.requestId, event.sequenceNumber, event.requestRevisionNumber,
    event.eventType, event.fromStatus, event.toStatus, JSON.stringify(event.eventPayload),
    event.eventPayloadSha256, event.previousReceiptSha256, event.receiptSha256,
    event.actorEmployeeNumber, event.occurredAt,
  ]);
}

test("Block 3: Startup-Migration sichert einmal, markiert und läuft idempotent", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  let backups = 0;
  try {
    migrate(database);
    dropRequestSchema(database);
    migrate(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => { backups += 1; },
    });
    const second = migrate(database);
    assert.equal(backups, 1);
    assert.equal(second.staffAssignmentRequestMigrationRequired, false);
    assert.equal(inspectSqliteStaffAssignmentRequestSchema(database).valid, true);
    assert.equal(inspectSqliteStaffAssignmentRequestRows(database).valid, true);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?
    `).get(STAFF_ASSIGNMENT_REQUEST_MIGRATION_ID).count, 1);
  } finally {
    database.close();
  }
});

test("Block 3: Startup-Drift mit Fachdaten bleibt nach Sicherung fail-closed und unverändert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  let backups = 0;
  try {
    migrate(database);
    seedRequest(database);
    database.exec("DROP TRIGGER trg_staff_assignment_request_events_immutable_delete");
    assert.throws(
      () => migrate(database, {
        databaseExistedBeforeOpen: true,
        onBackup: () => { backups += 1; },
      }),
      (error) => error.code === "STAFF_ASSIGNMENT_REQUEST_SCHEMA_DATA_PRESENT",
    );
    assert.equal(backups, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_assignment_requests").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_assignment_request_revisions").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_assignment_request_events").get().count, 1);
  } finally {
    database.close();
  }
});
