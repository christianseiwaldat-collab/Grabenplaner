"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES,
  createPostgresqlRecoveryEvidenceReader,
} = require("../lib/persistence/postgresql/operations/evidence");

const STORAGE_KEY = "00/00000000-0000-4000-8000-000000000001.amu";

function reader() {
  return createPostgresqlRecoveryEvidenceReader({
    applicationSchema: "grabenplaner",
    migrationLedgerTable: "persistence_migration_history",
    protectedDocumentSources: [
      { table: "protected_documents", column: "storage_key" },
    ],
  });
}

function executor({
  references = [STORAGE_KEY],
  extraResultField = false,
} = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes("pg_catalog.pg_attribute")) {
        return {
          rows: [
            {
              table_name: "items",
              ordinal_position: 1,
              column_name: "id",
              data_type: "integer",
              not_null: true,
              default_expression: "",
            },
            {
              table_name: "persistence_migration_history",
              ordinal_position: 1,
              column_name: "migration_id",
              data_type: "text",
              not_null: true,
              default_expression: "",
            },
            {
              table_name: "protected_documents",
              ordinal_position: 1,
              column_name: "storage_key",
              data_type: "text",
              not_null: true,
              default_expression: "",
            },
          ],
        };
      }
      if (sql.includes("pg_catalog.pg_constraint")) {
        return {
          rows: [{
            table_name: "items",
            constraint_name: "items_pkey",
            constraint_type: "p",
            definition: "PRIMARY KEY (id)",
          }],
        };
      }
      if (sql.includes("pg_catalog.pg_index")) {
        return {
          rows: [{
            table_name: "items",
            index_name: "items_pkey",
            definition: "CREATE UNIQUE INDEX items_pkey ON items USING btree (id)",
          }],
        };
      }
      if (sql.includes("AS protected_reference")) {
        return {
          rows: references.map((storageKey) => ({ storage_key: storageKey })),
        };
      }
      if (sql.includes('"items" AS source_row')) {
        return {
          rows: [
            { row_json: "{\"id\": 1}" },
            { row_json: "{\"id\": 2}" },
          ],
        };
      }
      if (sql.includes('"persistence_migration_history" AS source_row')) {
        return {
          rows: [{
            row_json: "{\"migration_id\": \"001\"}",
            ...(extraResultField ? { database_url: "postgresql://secret" } : {}),
          }],
        };
      }
      if (sql.includes('"protected_documents" AS source_row')) {
        return { rows: [{ row_json: `{"storage_key": "${STORAGE_KEY}"}` }] };
      }
      throw new Error("unexpected query");
    },
  };
}

test("DB Block 6: versionierte PostgreSQL-Evidence bindet Schema, Constraints, Ledger, Daten und Dokumentreferenzen", async () => {
  const evidenceReader = reader();
  const value = executor();
  const evidence = await evidenceReader.read(value);

  assert.equal(evidence.format, "grabenplaner-postgresql-recovery-evidence");
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.tableCount, 3);
  assert.equal(evidence.rowCount, 4);
  assert.equal(evidence.migrationCount, 1);
  assert.equal(evidence.referenceCount, 1);
  assert.deepEqual(evidence.protectedDocumentReferences, [STORAGE_KEY]);
  for (const key of [
    "contractHash",
    "schemaFingerprint",
    "dataFingerprint",
    "migrationLedgerFingerprint",
    "protectedDocumentReferencesFingerprint",
    "fingerprint",
  ]) {
    assert.match(evidence[key], /^[0-9a-f]{64}$/, key);
  }
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.protectedDocumentReferences), true);
  assert.deepEqual(
    await evidenceReader.read(executor()),
    evidence,
  );
  assert.doesNotMatch(JSON.stringify(evidence), /postgresql:\/\/|password|host|user/i);
});

test("DB Block 6: doppelte Dokumentreferenzen und Ergebnisdrift scheitern geschlossen", async () => {
  await assert.rejects(
    reader().read(executor({ references: [STORAGE_KEY, STORAGE_KEY] })),
    (error) => (
      error?.code
        === POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.DUPLICATE_DOCUMENT_REFERENCE
    ),
  );
  await assert.rejects(
    reader().read(executor({ extraResultField: true })),
    (error) => (
      error?.code === POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.RESULT_INVALID
      && !JSON.stringify(error).includes("secret")
    ),
  );
});

test("DB Block 6: ungueltige oder doppelte Evidence-Quellen werden vor der Abfrage abgelehnt", () => {
  assert.throws(
    () => createPostgresqlRecoveryEvidenceReader({
      applicationSchema: "grabenplaner; DROP SCHEMA public",
      migrationLedgerTable: "persistence_migration_history",
      protectedDocumentSources: [
        { table: "protected_documents", column: "storage_key" },
      ],
    }),
    (error) => error?.code
      === POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.CONFIGURATION_INVALID,
  );
  assert.throws(
    () => createPostgresqlRecoveryEvidenceReader({
      applicationSchema: "grabenplaner",
      migrationLedgerTable: "persistence_migration_history",
      protectedDocumentSources: [
        { table: "protected_documents", column: "storage_key" },
        { table: "protected_documents", column: "storage_key" },
      ],
    }),
    (error) => error?.code
      === POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.CONFIGURATION_INVALID,
  );
});
