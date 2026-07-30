"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  prepareControlledHostReboot,
  verifiedBackupMarkerFileName,
} = require("../lib/controlled-host-reboot");

const requestId = "af24b6d2-a935-4af0-a738-69a99d106897";
const marker = path.resolve(
  "/var/lib/grabenplaner/backups/dienstplan-2026-07-30T12-00-00-000Z-a1b2c3.complete.json",
);

function verifiedBackup() {
  return {
    appBackup: {
      marker,
      verified: true,
      committed: true,
    },
  };
}

test("controlled host reboot proves backup and audit before invoking the broker", async () => {
  const order = [];
  const result = await prepareControlledHostReboot({
    requestId,
    createBackup: () => {
      order.push("backup");
      return verifiedBackup();
    },
    recordRequest: ({ backupMarkerFileName }) => {
      order.push(`audit:${backupMarkerFileName}`);
    },
    requestControl: ({ backupMarkerFileName }) => {
      order.push(`broker:${backupMarkerFileName}`);
      return { accepted: true };
    },
  });
  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(order, [
    "backup",
    "audit:dienstplan-2026-07-30T12-00-00-000Z-a1b2c3.complete.json",
    "broker:dienstplan-2026-07-30T12-00-00-000Z-a1b2c3.complete.json",
  ]);
});

test("backup or audit failure can never reach the privileged broker", async () => {
  let brokerCalls = 0;
  await assert.rejects(
    prepareControlledHostReboot({
      requestId,
      createBackup: () => null,
      recordRequest: () => {},
      requestControl: () => { brokerCalls += 1; },
    }),
    { code: "HOST_REBOOT_BACKUP_FAILED" },
  );
  await assert.rejects(
    prepareControlledHostReboot({
      requestId,
      createBackup: verifiedBackup,
      recordRequest: () => { throw new Error("audit unavailable"); },
      requestControl: () => { brokerCalls += 1; },
    }),
    /audit unavailable/,
  );
  assert.equal(brokerCalls, 0);
});

test("backup evidence never accepts a forged or uncommitted marker", () => {
  assert.throws(
    () => verifiedBackupMarkerFileName({
      appBackup: {
        marker: path.resolve("/var/lib/grabenplaner/backups/forged.json"),
        verified: true,
        committed: true,
      },
    }),
    { code: "HOST_REBOOT_BACKUP_FAILED" },
  );
  assert.throws(
    () => verifiedBackupMarkerFileName({
      appBackup: { marker, verified: true, committed: false },
    }),
    { code: "HOST_REBOOT_BACKUP_FAILED" },
  );
});
