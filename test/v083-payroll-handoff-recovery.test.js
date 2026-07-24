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

function context(namespace, recordId) {
  return {
    namespace,
    recordId: String(recordId),
    field: "payload",
    employeeNumber: "system",
  };
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v083-recovery-"));
  const database = new DatabaseSync(path.join(directory, "dienstplan.db"));
  const storage = createAmuStorage({
    rootDirectory: path.join(directory, "private", "amu"),
    encryptionKeys: { "server-v083": Buffer.alloc(32, 83).toString("base64") },
    activeKeyId: "server-v083",
  });
  database.exec(`
    CREATE TABLE payroll_handoffs (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE payroll_handoff_events (
      id TEXT PRIMARY KEY,
      handoff_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY (handoff_id) REFERENCES payroll_handoffs(id)
    );
  `);
  database.prepare("INSERT INTO payroll_handoffs VALUES (?, ?)").run(
    "payroll-handoff:test",
    storage.protectRecord(
      JSON.stringify({ receiptSha256: "a".repeat(64) }),
      context("payroll-handoff", "payroll-handoff:test"),
    ),
  );
  database.prepare("INSERT INTO payroll_handoff_events VALUES (?, ?, ?)").run(
    "payroll-handoff-event:test",
    "payroll-handoff:test",
    storage.protectRecord(
      JSON.stringify({ receiptSha256: "b".repeat(64) }),
      context("payroll-handoff-event", "payroll-handoff-event:test"),
    ),
  );
  return { database, directory, storage };
}

test("v0.83 Linux recovery verifies encrypted payroll handoffs and events", () => {
  const { database, directory, storage } = fixture();
  try {
    assert.equal(verifyProtectedRecords(database, storage), 2);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("v0.83 Linux recovery rejects payroll handoff ciphertext moved to an event context", () => {
  const { database, directory, storage } = fixture();
  try {
    const handoff = database.prepare("SELECT payload_json FROM payroll_handoffs").get().payload_json;
    database.prepare("UPDATE payroll_handoff_events SET payload_json = ?").run(handoff);
    assert.throws(
      () => verifyProtectedRecords(database, storage),
      { code: "PERSONNEL_RECORD_INTEGRITY_FAILED" },
    );
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
