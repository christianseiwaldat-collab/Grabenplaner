"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { createAmuStorage } = require("../lib/amu-storage");
const {
  verifyProtectedRecords,
} = require("../server-tools/linux/recovery/lib/recovery-verify");

function context(namespace, recordId, employeeNumber = "system") {
  const field = namespace === "privacy-request"
    ? "state"
    : namespace === "vacation-history-event"
      ? "snapshot"
      : "payload";
  return {
    namespace,
    recordId: String(recordId),
    field,
    employeeNumber: String(employeeNumber),
  };
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v082-recovery-"));
  const database = new DatabaseSync(path.join(directory, "dienstplan.db"));
  const storage = createAmuStorage({
    rootDirectory: path.join(directory, "private", "amu"),
    encryptionKeys: { "server-v082": Buffer.alloc(32, 82).toString("base64") },
    activeKeyId: "server-v082",
  });
  database.exec(`
    CREATE TABLE privacy_requests (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      protected_payload TEXT NOT NULL
    );
    CREATE TABLE privacy_request_events (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      protected_payload TEXT NOT NULL,
      FOREIGN KEY (request_id) REFERENCES privacy_requests(id)
    );
    CREATE TABLE vacation_account_revisions (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      calculation_json TEXT NOT NULL
    );
    CREATE TABLE vacation_history_events (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE time_record_statements (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE retention_preview_runs (
      id TEXT PRIMARY KEY,
      result_json TEXT NOT NULL
    );
  `);

  const privacyId = "privacy-request:test";
  const privacyEventId = `${privacyId}:event:1`;
  const vacationId = "vacation-account:101:2026:r1";
  const vacationHistoryId = "vacation-history:test";
  const statementId = "time-statement:101:2026-07:r1";
  const retentionId = "retention-preview:test";
  database.prepare("INSERT INTO privacy_requests VALUES (?, ?, ?)").run(
    privacyId,
    "101",
    storage.protectRecord(JSON.stringify({ id: privacyId }), context("privacy-request", privacyId, "101")),
  );
  database.prepare("INSERT INTO privacy_request_events VALUES (?, ?, ?)").run(
    privacyEventId,
    privacyId,
    storage.protectRecord(JSON.stringify({ sequence: 1 }), context("privacy-request-event", privacyEventId, "101")),
  );
  database.prepare("INSERT INTO vacation_account_revisions VALUES (?, ?, ?)").run(
    vacationId,
    "101",
    storage.protectRecord(JSON.stringify({ revision: 1 }), context("vacation-account", vacationId, "101")),
  );
  database.prepare("INSERT INTO vacation_history_events VALUES (?, ?, ?)").run(
    vacationHistoryId,
    "101",
    storage.protectRecord(
      JSON.stringify({ action: "created" }),
      context("vacation-history-event", vacationHistoryId, "101"),
    ),
  );
  database.prepare("INSERT INTO time_record_statements VALUES (?, ?, ?)").run(
    statementId,
    "101",
    storage.protectRecord(JSON.stringify({ revision: 1 }), context("time-record-statement", statementId, "101")),
  );
  database.prepare("INSERT INTO retention_preview_runs VALUES (?, ?)").run(
    retentionId,
    storage.protectRecord(JSON.stringify({ asOf: "2026-07-24" }), context("retention-preview", retentionId)),
  );
  return { database, directory };
}

test("v0.82 recovery verifies every encrypted governance domain with its application context", () => {
  const { database, directory } = fixture();
  try {
    const storage = createAmuStorage({
      rootDirectory: path.join(directory, "private", "amu"),
      encryptionKeys: { "server-v082": Buffer.alloc(32, 82).toString("base64") },
      activeKeyId: "server-v082",
    });
    assert.equal(verifyProtectedRecords(database, storage), 6);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("v0.82 recovery rejects governance ciphertext moved to a different employee context", () => {
  const { database, directory } = fixture();
  try {
    const storage = createAmuStorage({
      rootDirectory: path.join(directory, "private", "amu"),
      encryptionKeys: { "server-v082": Buffer.alloc(32, 82).toString("base64") },
      activeKeyId: "server-v082",
    });
    database.prepare("UPDATE privacy_requests SET employee_number = '999'").run();
    assert.throws(
      () => verifyProtectedRecords(database, storage),
      { code: "PERSONNEL_RECORD_INTEGRITY_FAILED" },
    );
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("v0.82 recovery rejects plaintext in encrypted governance columns", () => {
  const { database, directory } = fixture();
  try {
    const storage = createAmuStorage({
      rootDirectory: path.join(directory, "private", "amu"),
      encryptionKeys: { "server-v082": Buffer.alloc(32, 82).toString("base64") },
      activeKeyId: "server-v082",
    });
    database.prepare("UPDATE retention_preview_runs SET result_json = '{}'").run();
    assert.throws(
      () => verifyProtectedRecords(database, storage),
      { code: "PERSONNEL_RECORD_PLAINTEXT_REJECTED" },
    );
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
