"use strict";

const {
  ERROR_CODES,
  PostgresqlOperationalError,
} = require("./tools");

const PROTECTED_STORAGE_KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.amu$/;

const EXPORTED_SNAPSHOT_PATTERN = /^[A-Fa-f0-9][A-Fa-f0-9-]{2,127}$/;

function operationalError(code, operation, cause) {
  return new PostgresqlOperationalError(code, operation, cause);
}

function assertPool(pool) {
  if (!pool || typeof pool !== "object" || typeof pool.connect !== "function") {
    throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, "snapshot");
  }
}

function assertEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.fingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !Number.isSafeInteger(value.referenceCount)
    || value.referenceCount < 0
    || Object.keys(value).some((key) => !["fingerprint", "referenceCount"].includes(key))) {
    throw operationalError(ERROR_CODES.TOOL_OUTPUT_INVALID, "snapshot-evidence");
  }
  return Object.freeze({
    fingerprint: value.fingerprint,
    referenceCount: value.referenceCount,
  });
}

function snapshotIdFromResult(result) {
  const rows = result?.rows;
  const snapshotId = Array.isArray(rows) && rows.length === 1
    ? String(rows[0]?.snapshot_id || "")
    : "";
  if (!EXPORTED_SNAPSHOT_PATTERN.test(snapshotId)) {
    throw operationalError(ERROR_CODES.TOOL_OUTPUT_INVALID, "snapshot");
  }
  return snapshotId;
}

function assertProtectedDocumentReferences(value, referenceCount) {
  if (!Array.isArray(value) || value.length !== referenceCount) {
    throw operationalError(ERROR_CODES.TOOL_OUTPUT_INVALID, "snapshot-document-references");
  }
  const normalized = value.map((entry) => String(entry || "").toLowerCase());
  if (normalized.some((entry) => !PROTECTED_STORAGE_KEY_PATTERN.test(entry))
    || new Set(normalized).size !== normalized.length) {
    throw operationalError(ERROR_CODES.TOOL_OUTPUT_INVALID, "snapshot-document-references");
  }
  return Object.freeze([...normalized].sort());
}

async function withPostgresqlExportedSnapshot({
  pool,
  readSourceEvidence,
  readProtectedDocumentReferences,
  work,
} = {}) {
  assertPool(pool);
  if (typeof readSourceEvidence !== "function"
    || (readProtectedDocumentReferences !== undefined
      && typeof readProtectedDocumentReferences !== "function")
    || typeof work !== "function") {
    throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, "snapshot");
  }
  let client;
  let transactionOpen = false;
  let releaseDamaged = false;
  try {
    client = await pool.connect();
    if (!client || typeof client.query !== "function" || typeof client.release !== "function") {
      throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, "snapshot");
    }
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    const snapshotId = snapshotIdFromResult(
      await client.query("SELECT pg_export_snapshot() AS snapshot_id"),
    );
    const queryExecutor = Object.freeze({
      async query(text, values = []) {
        if (!transactionOpen
          || typeof text !== "string"
          || !text.trim()
          || !Array.isArray(values)) {
          throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, "snapshot-evidence");
        }
        return client.query(text, values);
      },
    });
    const sourceEvidence = assertEvidence(await readSourceEvidence(queryExecutor));
    const protectedDocumentReferences = readProtectedDocumentReferences === undefined
      ? null
      : assertProtectedDocumentReferences(
        await readProtectedDocumentReferences(queryExecutor),
        sourceEvidence.referenceCount,
      );
    const result = await work(Object.freeze({
      snapshotId,
      sourceEvidence,
      protectedDocumentReferences,
    }));
    await client.query("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    const primary = error instanceof PostgresqlOperationalError
      ? error
      : operationalError(ERROR_CODES.TOOL_FAILED, "snapshot", error);
    if (client && transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch {
        releaseDamaged = true;
      }
    }
    throw primary;
  } finally {
    try { client?.release(releaseDamaged || undefined); } catch {}
  }
}

module.exports = {
  withPostgresqlExportedSnapshot,
};
