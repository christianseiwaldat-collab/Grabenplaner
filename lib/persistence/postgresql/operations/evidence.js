"use strict";

const crypto = require("node:crypto");

const POSTGRESQL_RECOVERY_EVIDENCE_FORMAT = "grabenplaner-postgresql-recovery-evidence";
const POSTGRESQL_RECOVERY_EVIDENCE_SCHEMA_VERSION = 1;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const STORAGE_KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.amu$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

const POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES = Object.freeze({
  CONFIGURATION_INVALID: "POSTGRESQL_RECOVERY_EVIDENCE_CONFIGURATION_INVALID",
  QUERY_FAILED: "POSTGRESQL_RECOVERY_EVIDENCE_QUERY_FAILED",
  RESULT_INVALID: "POSTGRESQL_RECOVERY_EVIDENCE_RESULT_INVALID",
  DUPLICATE_DOCUMENT_REFERENCE: "POSTGRESQL_RECOVERY_EVIDENCE_DUPLICATE_DOCUMENT_REFERENCE",
});

const SCHEMA_QUERY = `
SELECT
  relation.relname::text AS table_name,
  attribute.attnum::integer AS ordinal_position,
  attribute.attname::text AS column_name,
  pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)::text AS data_type,
  attribute.attnotnull AS not_null,
  COALESCE(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid), '')::text
    AS default_expression
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_attribute AS attribute
  ON attribute.attrelid = relation.oid
LEFT JOIN pg_catalog.pg_attrdef AS default_value
  ON default_value.adrelid = relation.oid
 AND default_value.adnum = attribute.attnum
WHERE namespace.nspname = $1
  AND relation.relkind IN ('r', 'p')
  AND attribute.attnum > 0
  AND attribute.attisdropped = false
ORDER BY relation.relname COLLATE "C", attribute.attnum
`.trim();

const CONSTRAINT_QUERY = `
SELECT
  relation.relname::text AS table_name,
  constraint_value.conname::text AS constraint_name,
  constraint_value.contype::text AS constraint_type,
  pg_catalog.pg_get_constraintdef(constraint_value.oid, true)::text AS definition
FROM pg_catalog.pg_constraint AS constraint_value
JOIN pg_catalog.pg_class AS relation
  ON relation.oid = constraint_value.conrelid
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = $1
ORDER BY
  relation.relname COLLATE "C",
  constraint_value.conname COLLATE "C"
`.trim();

const INDEX_QUERY = `
SELECT
  relation.relname::text AS table_name,
  index_relation.relname::text AS index_name,
  pg_catalog.pg_get_indexdef(index_value.indexrelid, 0, true)::text AS definition
FROM pg_catalog.pg_index AS index_value
JOIN pg_catalog.pg_class AS relation
  ON relation.oid = index_value.indrelid
JOIN pg_catalog.pg_class AS index_relation
  ON index_relation.oid = index_value.indexrelid
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = $1
ORDER BY
  relation.relname COLLATE "C",
  index_relation.relname COLLATE "C"
`.trim();

class PostgresqlRecoveryEvidenceError extends Error {
  constructor(code) {
    super("Der PostgreSQL-Recovery-Evidenzstand konnte nicht sicher ermittelt werden.");
    this.name = "PostgresqlRecoveryEvidenceError";
    this.code = code;
  }
}

function evidenceError(code) {
  return new PostgresqlRecoveryEvidenceError(code);
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.RESULT_INVALID);
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.RESULT_INVALID);
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function quoteIdentifier(value) {
  if (!IDENTIFIER_PATTERN.test(String(value || ""))) {
    throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.CONFIGURATION_INVALID);
  }
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizeReferenceSources(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.CONFIGURATION_INVALID);
  }
  const normalized = value.map((entry) => {
    if (!entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || Object.keys(entry).length !== 2) {
      throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.CONFIGURATION_INVALID);
    }
    return Object.freeze({
      table: quoteIdentifier(entry.table).slice(1, -1),
      column: quoteIdentifier(entry.column).slice(1, -1),
    });
  }).sort((left, right) => (
    left.table.localeCompare(right.table, "en")
      || left.column.localeCompare(right.column, "en")
  ));
  const identities = normalized.map((entry) => `${entry.table}\0${entry.column}`);
  if (new Set(identities).size !== identities.length) {
    throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.CONFIGURATION_INVALID);
  }
  return Object.freeze(normalized);
}

function assertQueryExecutor(value) {
  if (!value || typeof value !== "object" || typeof value.query !== "function") {
    throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.CONFIGURATION_INVALID);
  }
}

async function safeQuery(executor, text, parameters = []) {
  try {
    const result = await executor.query(text, parameters);
    if (!result || !Array.isArray(result.rows)) {
      throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.RESULT_INVALID);
    }
    return result.rows;
  } catch (error) {
    if (error instanceof PostgresqlRecoveryEvidenceError) throw error;
    throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.QUERY_FAILED);
  }
}

function assertExactRow(row, keys) {
  if (!row
    || typeof row !== "object"
    || Array.isArray(row)
    || Object.keys(row).length !== keys.length
    || Object.keys(row).some((key) => !keys.includes(key))) {
    throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.RESULT_INVALID);
  }
}

function normalizeSchemaRows(rows) {
  return rows.map((row) => {
    assertExactRow(row, [
      "table_name",
      "ordinal_position",
      "column_name",
      "data_type",
      "not_null",
      "default_expression",
    ]);
    if (!IDENTIFIER_PATTERN.test(String(row.table_name || ""))
      || !Number.isSafeInteger(row.ordinal_position)
      || row.ordinal_position < 1
      || !IDENTIFIER_PATTERN.test(String(row.column_name || ""))
      || typeof row.data_type !== "string"
      || !row.data_type
      || typeof row.not_null !== "boolean"
      || typeof row.default_expression !== "string") {
      throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.RESULT_INVALID);
    }
    return {
      table: row.table_name,
      position: row.ordinal_position,
      column: row.column_name,
      type: row.data_type,
      notNull: row.not_null,
      defaultExpression: row.default_expression,
    };
  });
}

function normalizeNamedDefinitions(rows, kind) {
  return rows.map((row) => {
    const keys = kind === "constraint"
      ? ["table_name", "constraint_name", "constraint_type", "definition"]
      : ["table_name", "index_name", "definition"];
    assertExactRow(row, keys);
    const name = row[kind === "constraint" ? "constraint_name" : "index_name"];
    if (!IDENTIFIER_PATTERN.test(String(row.table_name || ""))
      || !IDENTIFIER_PATTERN.test(String(name || ""))
      || (kind === "constraint"
        && (typeof row.constraint_type !== "string" || row.constraint_type.length !== 1))
      || typeof row.definition !== "string"
      || !row.definition) {
      throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.RESULT_INVALID);
    }
    return {
      table: row.table_name,
      name,
      ...(kind === "constraint" ? { type: row.constraint_type } : {}),
      definition: row.definition,
    };
  });
}

function rowDataQuery(schema, table) {
  return `
SELECT to_jsonb(source_row)::text AS row_json
FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} AS source_row
ORDER BY to_jsonb(source_row)::text COLLATE "C"
  `.trim();
}

function migrationDataQuery(schema, table) {
  return rowDataQuery(schema, table);
}

function referenceQuery(schema, sources) {
  const selects = sources.map(({ table, column }) => `
SELECT ${quoteIdentifier(column)}::text AS storage_key
FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}
WHERE ${quoteIdentifier(column)} IS NOT NULL
  `.trim());
  return `
SELECT storage_key
FROM (
  ${selects.join("\n  UNION ALL\n  ")}
) AS protected_reference
ORDER BY storage_key COLLATE "C"
  `.trim();
}

function normalizeJsonRows(rows) {
  return rows.map((row) => {
    assertExactRow(row, ["row_json"]);
    if (typeof row.row_json !== "string" || !row.row_json) {
      throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.RESULT_INVALID);
    }
    try {
      JSON.parse(row.row_json);
    } catch {
      throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.RESULT_INVALID);
    }
    return row.row_json;
  });
}

function normalizeReferences(rows) {
  const references = rows.map((row) => {
    assertExactRow(row, ["storage_key"]);
    const storageKey = String(row.storage_key || "").toLowerCase();
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.RESULT_INVALID);
    }
    return storageKey;
  });
  if (new Set(references).size !== references.length) {
    throw evidenceError(
      POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.DUPLICATE_DOCUMENT_REFERENCE,
    );
  }
  return references;
}

function createPostgresqlRecoveryEvidenceReader({
  applicationSchema,
  migrationLedgerTable,
  protectedDocumentSources,
} = {}) {
  const schema = quoteIdentifier(applicationSchema).slice(1, -1);
  const ledger = quoteIdentifier(migrationLedgerTable).slice(1, -1);
  const referenceSources = normalizeReferenceSources(protectedDocumentSources);
  const contract = Object.freeze({
    format: POSTGRESQL_RECOVERY_EVIDENCE_FORMAT,
    schemaVersion: POSTGRESQL_RECOVERY_EVIDENCE_SCHEMA_VERSION,
    applicationSchema: schema,
    migrationLedgerTable: ledger,
    protectedDocumentSources: referenceSources,
  });
  const contractHash = sha256(canonicalJson(contract));

  async function readProtectedDocumentReferences(executor) {
    assertQueryExecutor(executor);
    return Object.freeze(normalizeReferences(await safeQuery(
      executor,
      referenceQuery(schema, referenceSources),
    )));
  }

  async function read(executor) {
    assertQueryExecutor(executor);
    const rawColumns = await safeQuery(executor, SCHEMA_QUERY, [schema]);
    const rawConstraints = await safeQuery(executor, CONSTRAINT_QUERY, [schema]);
    const rawIndexes = await safeQuery(executor, INDEX_QUERY, [schema]);
    const columns = normalizeSchemaRows(rawColumns);
    const constraints = normalizeNamedDefinitions(rawConstraints, "constraint");
    const indexes = normalizeNamedDefinitions(rawIndexes, "index");
    const tableNames = [...new Set(columns.map((column) => column.table))];
    if (!tableNames.length || !tableNames.includes(ledger)) {
      throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.RESULT_INVALID);
    }
    const tableData = [];
    let rowCount = 0;
    for (const table of tableNames) {
      const rows = normalizeJsonRows(await safeQuery(
        executor,
        rowDataQuery(schema, table),
      ));
      rowCount += rows.length;
      if (!Number.isSafeInteger(rowCount)) {
        throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.RESULT_INVALID);
      }
      tableData.push({
        table,
        rowCount: rows.length,
        rowsSha256: sha256(rows.join("\n")),
      });
    }
    const migrationRows = normalizeJsonRows(await safeQuery(
      executor,
      migrationDataQuery(schema, ledger),
    ));
    const protectedDocumentReferences = await readProtectedDocumentReferences(executor);
    const schemaEvidence = {
      columns,
      constraints,
      indexes,
    };
    const dataEvidence = {
      tables: tableData,
      rowCount,
    };
    const evidence = {
      format: POSTGRESQL_RECOVERY_EVIDENCE_FORMAT,
      schemaVersion: POSTGRESQL_RECOVERY_EVIDENCE_SCHEMA_VERSION,
      contractHash,
      schemaFingerprint: sha256(canonicalJson(schemaEvidence)),
      dataFingerprint: sha256(canonicalJson(dataEvidence)),
      migrationLedgerFingerprint: sha256(migrationRows.join("\n")),
      protectedDocumentReferencesFingerprint:
        sha256(protectedDocumentReferences.join("\n")),
      tableCount: tableNames.length,
      rowCount,
      migrationCount: migrationRows.length,
      referenceCount: protectedDocumentReferences.length,
    };
    const fingerprintValue = sha256(canonicalJson(evidence));
    if (!HASH_PATTERN.test(fingerprintValue)) {
      throw evidenceError(POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES.RESULT_INVALID);
    }
    return Object.freeze({
      ...evidence,
      fingerprint: fingerprintValue,
      protectedDocumentReferences,
    });
  }

  return Object.freeze({
    contract,
    contractHash,
    read,
    readProtectedDocumentReferences,
  });
}

module.exports = {
  POSTGRESQL_RECOVERY_EVIDENCE_ERROR_CODES,
  POSTGRESQL_RECOVERY_EVIDENCE_FORMAT,
  POSTGRESQL_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  PostgresqlRecoveryEvidenceError,
  createPostgresqlRecoveryEvidenceReader,
};
