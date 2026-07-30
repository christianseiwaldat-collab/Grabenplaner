"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ERROR_CODES,
} = require("../lib/persistence/postgresql/operations/tools");
const {
  withPostgresqlExportedSnapshot,
} = require("../lib/persistence/postgresql/operations/snapshot");

function fakePool({
  snapshotId = "00000003-0000001B-1",
  rollbackFails = false,
} = {}) {
  const calls = [];
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (text === "SELECT pg_export_snapshot() AS snapshot_id") {
        return { rows: [{ snapshot_id: snapshotId }] };
      }
      if (text === "ROLLBACK" && rollbackFails) throw new Error("rollback-secret");
      if (text === "SELECT evidence") return { rows: [{ id: 1 }] };
      return { rows: [] };
    },
    release(destroy) {
      calls.push({ release: true, destroy: destroy === true });
    },
  };
  return {
    calls,
    pool: {
      async connect() {
        calls.push({ connect: true });
        return client;
      },
    },
  };
}

test("DB Block 6: Export-Snapshot bleibt bis nach Dump-/Dokumentarbeit offen", async () => {
  const value = fakePool();
  const result = await withPostgresqlExportedSnapshot({
    pool: value.pool,
    async readSourceEvidence(executor) {
      assert.deepEqual(await executor.query("SELECT evidence"), { rows: [{ id: 1 }] });
      return {
        fingerprint: "a".repeat(64),
        referenceCount: 2,
      };
    },
    async readProtectedDocumentReferences(executor) {
      assert.deepEqual(await executor.query("SELECT evidence"), { rows: [{ id: 1 }] });
      return [
        "11/11111111-1111-4111-8111-111111111111.amu",
        "00/00000000-0000-4000-8000-000000000001.amu",
      ];
    },
    async work(snapshot) {
      assert.equal(snapshot.snapshotId, "00000003-0000001B-1");
      assert.deepEqual(snapshot.sourceEvidence, {
        fingerprint: "a".repeat(64),
        referenceCount: 2,
      });
      assert.deepEqual(snapshot.protectedDocumentReferences, [
        "00/00000000-0000-4000-8000-000000000001.amu",
        "11/11111111-1111-4111-8111-111111111111.amu",
      ]);
      assert.equal(value.calls.some((call) => call.text === "COMMIT"), false);
      return { ok: true };
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(value.calls.map((call) => call.text || (call.release ? "release" : "connect")), [
    "connect",
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SELECT pg_export_snapshot() AS snapshot_id",
    "SELECT evidence",
    "SELECT evidence",
    "COMMIT",
    "release",
  ]);
});

test("DB Block 6: Fehler rollen Snapshot zurück und lassen den Primärfehler sichtbar", async () => {
  const value = fakePool({ rollbackFails: true });
  await assert.rejects(
    withPostgresqlExportedSnapshot({
      pool: value.pool,
      async readSourceEvidence() {
        return { fingerprint: "b".repeat(64), referenceCount: 0 };
      },
      async work() {
        const error = new Error("primary");
        error.code = "PRIMARY";
        throw error;
      },
    }),
    (error) => {
      assert.equal(error?.code, ERROR_CODES.TOOL_FAILED);
      assert.equal(error?.cause?.code, "PRIMARY");
      assert.doesNotMatch(`${error.message}\n${JSON.stringify(error)}`, /rollback-secret/);
      return true;
    },
  );
  assert.equal(value.calls.some((call) => call.text === "ROLLBACK"), true);
  assert.equal(value.calls.at(-1).destroy, true);
});

test("DB Block 6: ungültige Snapshot-ID und Source-Evidence scheitern geschlossen", async () => {
  const invalidSnapshot = fakePool({ snapshotId: "postgresql://secret" });
  await assert.rejects(
    withPostgresqlExportedSnapshot({
      pool: invalidSnapshot.pool,
      readSourceEvidence: async () => ({ fingerprint: "c".repeat(64), referenceCount: 1 }),
      work: async () => {},
    }),
    (error) => error?.code === ERROR_CODES.TOOL_OUTPUT_INVALID,
  );

  const invalidEvidence = fakePool();
  await assert.rejects(
    withPostgresqlExportedSnapshot({
      pool: invalidEvidence.pool,
      readSourceEvidence: async () => ({
        fingerprint: "d".repeat(64),
        referenceCount: 1,
        databaseUrl: "postgresql://secret",
      }),
      work: async () => {},
    }),
    (error) => error?.code === ERROR_CODES.TOOL_OUTPUT_INVALID,
  );

  const invalidReferences = fakePool();
  await assert.rejects(
    withPostgresqlExportedSnapshot({
      pool: invalidReferences.pool,
      readSourceEvidence: async () => ({
        fingerprint: "e".repeat(64),
        referenceCount: 1,
      }),
      readProtectedDocumentReferences: async () => [],
      work: async () => {},
    }),
    (error) => (
      error?.code === ERROR_CODES.TOOL_OUTPUT_INVALID
      && error?.operation === "snapshot-document-references"
    ),
  );
});
