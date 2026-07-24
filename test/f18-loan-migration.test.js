"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  F18MigrationError,
  inspectF18Backup,
  publicF18Inspection,
  readZipEntries,
} = require("../lib/f18-loan-migration");
const { createF18Backup, storedZip } = require("./helpers/f18-backup-fixture");

function fixtureBackup() {
  return createF18Backup({
    employees: [
      { id: 1, employeeNumber: "101", name: "Erika Beispiel" },
      { id: 2, employeeNumber: "102", name: "Walter Beispiel" },
    ],
    loans: [{
      id: 7,
      borrowerId: 1,
      returnWitnessId: 2,
      dueDate: "2026-07-30",
      issuedAt: "2026-07-24T08:00:00+00:00",
      returnedAt: "2026-07-24T17:00:00+00:00",
      borrowerConfirmed: true,
      returnCondition: "gebraucht, aber vollständig",
      items: [{
        position: 1,
        articleNumber: "123456",
        description: "Demo-Kamera",
        serialNumber: "SN-1",
        conditionOut: "gut",
      }],
    }],
  });
}

test("F18 backup inspection verifies manifest and normalizes loans", () => {
  const inspection = inspectF18Backup(fixtureBackup());
  assert.match(inspection.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(inspection.summary, {
    employees: 2,
    loans: 1,
    openLoans: 0,
    returnedLoans: 1,
    items: 1,
    photos: 0,
  });
  assert.equal(inspection.loans[0].items[0].conditionOut.normalized, "good");
  assert.equal(inspection.loans[0].returnCondition.normalized, "used");
  assert.equal(publicF18Inspection(inspection).canImport, true);
  assert.equal(publicF18Inspection(inspection).loans, undefined);
  assert.equal(publicF18Inspection(inspection).files, undefined);
});

test("F18 backup inspection rejects path traversal", () => {
  const archive = storedZip({ "../f18-lagerware-backup/backup-manifest.json": "{}" });
  assert.throws(
    () => inspectF18Backup(archive),
    (error) => error instanceof F18MigrationError && error.code === "F18_ARCHIVE_PATH_INVALID",
  );
});

test("F18 backup inspection rejects a tampered manifest hash", () => {
  const entries = Object.fromEntries(readZipEntries(fixtureBackup()));
  const database = Buffer.from(entries["f18-lagerware-backup/database/lagerware.sqlite3"]);
  database[100] ^= 0xff;
  entries["f18-lagerware-backup/database/lagerware.sqlite3"] = database;
  const changed = storedZip(entries);
  assert.throws(
    () => inspectF18Backup(changed),
    (error) => error instanceof F18MigrationError
      && ["F18_MANIFEST_HASH_MISMATCH", "F18_DATABASE_INTEGRITY_FAILED"].includes(error.code),
  );
});
