"use strict";

const { createHash } = require("node:crypto");
const {
  POSTGRESQL_APPLICATION_DIALECT_PLAN,
  SQLITE_APPLICATION_DIALECT_MANIFEST,
} = require("../dialects/application-manifest");
const {
  SYSTEM_CENTER_METRICS_STATEMENTS,
} = require("../statements/system-center-metrics");
const {
  compilePostgresqlDialectEntry,
} = require("./dialect-compiler");

const SYSTEM_CENTER_METRICS_OLDEST_INTERVAL_KEYS_SLICE_ID =
  "system-center-metrics.oldest-interval-keys";
const SYSTEM_CENTER_METRICS_STATEMENT_ORDER = Object.freeze([
  SYSTEM_CENTER_METRICS_STATEMENTS.oldestIntervalKeys,
]);
const EXPECTED_SOURCE_CONTRACT_FINGERPRINTS = Object.freeze({
  "system-center-metrics.oldest-interval-keys":
    "a45dc726dd8bee65f063bc4493502041bb95e07b070d57d9e67610b9c13b686b",
});
const SOURCE_PLAN_BY_ID = new Map(
  POSTGRESQL_APPLICATION_DIALECT_PLAN.entries.map((entry) => [
    entry.statementId,
    entry,
  ]),
);
const SOURCE_ENTRY_BY_ID = new Map(
  SQLITE_APPLICATION_DIALECT_MANIFEST.entries.map((entry) => [
    entry.statement.id,
    entry,
  ]),
);

function invalidSliceInput() {
  return new TypeError("Der PostgreSQL-System-Center-Metrics-Slice ist ungültig.");
}

function quotedSchemaName(schemaName) {
  if (typeof schemaName !== "string"
    || !/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) {
    throw invalidSliceInput();
  }
  return `"${schemaName}"`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fieldContractSnapshot(fields, preserveOrder) {
  const names = preserveOrder ? Object.keys(fields) : Object.keys(fields).sort();
  return names.map((name) => {
    const definition = fields[name];
    return {
      name,
      kind: definition.kind,
      nullable: definition.nullable,
      optional: definition.optional,
    };
  });
}

function sourceContractFingerprint(sourceEntry) {
  return sha256(JSON.stringify({
    sourceSql: sourceEntry.sql,
    statement: {
      id: sourceEntry.statement.id,
      operation: sourceEntry.statement.operation,
      parameters: fieldContractSnapshot(
        sourceEntry.statement.parameters,
        false,
      ),
      columns: fieldContractSnapshot(sourceEntry.statement.columns, true),
    },
  }));
}

function compiledEntry(statement, sql, {
  semanticResolutions = [],
} = {}) {
  const sourcePlan = SOURCE_PLAN_BY_ID.get(statement.id);
  const sourceEntry = SOURCE_ENTRY_BY_ID.get(statement.id);
  const pinnedSourceContract = sourceEntry
    ? sourceContractFingerprint(sourceEntry)
    : null;
  if (!sourcePlan
    || !sourceEntry
    || sourceEntry.statement !== statement
    || sourcePlan.statementId !== statement.id
    || sourcePlan.sourceSqlFingerprint !== sha256(sourceEntry.sql)
    || sourcePlan.returning !== sourceEntry.returning
    || pinnedSourceContract
      !== EXPECTED_SOURCE_CONTRACT_FINGERPRINTS[statement.id]) {
    throw invalidSliceInput();
  }
  const compiled = compilePostgresqlDialectEntry({
    statement,
    sql,
    returning: false,
  });
  if (compiled.strategy !== "portable-generated") throw invalidSliceInput();
  return Object.freeze({
    providerEntry: Object.freeze({
      statement,
      sql: compiled.compiledSql,
      parameterOrder: compiled.parameterOrder,
      parameterBindings: compiled.parameterBindings,
      returning: false,
    }),
    provenance: Object.freeze({
      statementId: statement.id,
      sourceSqlFingerprint: sourcePlan.sourceSqlFingerprint,
      sourceContractFingerprint: pinnedSourceContract,
      sourceStrategy: sourcePlan.strategy,
      coveredFeatures: compiled.coveredFeatures,
      semanticResolutions: Object.freeze([...semanticResolutions].sort()),
      sqlFingerprint: compiled.compiledSqlFingerprint,
    }),
  });
}

function createPostgresqlSystemCenterMetricsOldestIntervalKeysSlice({
  schemaName,
} = {}) {
  const schema = quotedSchemaName(schemaName);
  const relation = `${schema}."system_center_trust_metrics"`;
  const compiled = [
    compiledEntry(SYSTEM_CENTER_METRICS_STATEMENTS.oldestIntervalKeys, `
      SELECT interval_key AS "intervalKey"
      FROM ${relation}
      ORDER BY
        recorded_at ASC NULLS FIRST,
        interval_key COLLATE "C" ASC NULLS FIRST
      LIMIT $limit::bigint
    `, {
      semanticResolutions: ["postgresql.sqlite-binary-collation"],
    }),
  ];
  if (compiled.length !== SYSTEM_CENTER_METRICS_STATEMENT_ORDER.length
    || compiled.some((entry, index) => (
      entry.providerEntry.statement !== SYSTEM_CENTER_METRICS_STATEMENT_ORDER[index]
    ))) {
    throw invalidSliceInput();
  }
  const entries = Object.freeze(compiled.map((entry) => entry.providerEntry));
  const provenance = Object.freeze(compiled.map((entry) => entry.provenance));
  const fingerprintSnapshot = Object.freeze({
    sliceId: SYSTEM_CENTER_METRICS_OLDEST_INTERVAL_KEYS_SLICE_ID,
    schemaName,
    sourcePlanFingerprint: POSTGRESQL_APPLICATION_DIALECT_PLAN.fingerprint,
    provenance,
  });
  return Object.freeze({
    sliceId: SYSTEM_CENTER_METRICS_OLDEST_INTERVAL_KEYS_SLICE_ID,
    status: "development-contract",
    developmentExecutable: true,
    executable: true,
    applicationExecutable: false,
    fullApplicationCatalog: false,
    productActivation: false,
    schemaName,
    sourcePlanFingerprint: POSTGRESQL_APPLICATION_DIALECT_PLAN.fingerprint,
    fingerprint: sha256(JSON.stringify(fingerprintSnapshot)),
    entries,
    provenance,
  });
}

module.exports = {
  SYSTEM_CENTER_METRICS_OLDEST_INTERVAL_KEYS_SLICE_ID,
  createPostgresqlSystemCenterMetricsOldestIntervalKeysSlice,
};
