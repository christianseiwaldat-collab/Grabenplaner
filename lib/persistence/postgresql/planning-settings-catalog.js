"use strict";

const { createHash } = require("node:crypto");
const {
  POSTGRESQL_APPLICATION_DIALECT_PLAN,
  SQLITE_APPLICATION_DIALECT_MANIFEST,
} = require("../dialects/application-manifest");
const {
  PLANNING_SETTINGS_STATEMENTS,
} = require("../statements/planning-settings");
const {
  compilePostgresqlDialectEntry,
} = require("./dialect-compiler");

const PLANNING_SETTINGS_SLICE_ID = "planning-settings.settings";
const PLANNING_SETTINGS_STATEMENT_ORDER = Object.freeze([
  PLANNING_SETTINGS_STATEMENTS.listSettings,
  PLANNING_SETTINGS_STATEMENTS.upsertSetting,
]);
const EXPECTED_SOURCE_CONTRACT_FINGERPRINTS = Object.freeze({
  "planning-settings.settings.list":
    "8c74e79c9abfcb1440c5d4609f0d6932849b8f921408a221f082a93b1ca6e57e",
  "planning-settings.settings.upsert":
    "3fc7914e883a9f0a2fa4ca88fec001953acc9a5da6bfc4703de362607a0a52f3",
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
  return new TypeError("Der PostgreSQL-Planning-Settings-Slice ist ungültig.");
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

function createPostgresqlPlanningSettingsSlice({ schemaName } = {}) {
  const schema = quotedSchemaName(schemaName);
  const relation = `${schema}."settings"`;
  const compiled = [
    compiledEntry(PLANNING_SETTINGS_STATEMENTS.listSettings, `
      SELECT json_object(
        'key', "key",
        'value', "value"
      ) AS data
      FROM ${relation}
      ORDER BY "key" COLLATE "C" NULLS FIRST
    `, {
      semanticResolutions: ["postgresql.sqlite-binary-collation"],
    }),
    compiledEntry(PLANNING_SETTINGS_STATEMENTS.upsertSetting, `
      INSERT INTO ${relation} ("key", "value")
      VALUES (
        json_extract($payload, '$.key'),
        json_extract($payload, '$.value')
      )
      ON CONFLICT ("key") DO UPDATE SET
        "value" = excluded."value"
    `),
  ];
  if (compiled.length !== PLANNING_SETTINGS_STATEMENT_ORDER.length
    || compiled.some((entry, index) => (
      entry.providerEntry.statement !== PLANNING_SETTINGS_STATEMENT_ORDER[index]
    ))) {
    throw invalidSliceInput();
  }
  const entries = Object.freeze(compiled.map((entry) => entry.providerEntry));
  const provenance = Object.freeze(compiled.map((entry) => entry.provenance));
  const fingerprintSnapshot = Object.freeze({
    sliceId: PLANNING_SETTINGS_SLICE_ID,
    schemaName,
    sourcePlanFingerprint: POSTGRESQL_APPLICATION_DIALECT_PLAN.fingerprint,
    provenance,
  });
  return Object.freeze({
    sliceId: PLANNING_SETTINGS_SLICE_ID,
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
  PLANNING_SETTINGS_SLICE_ID,
  createPostgresqlPlanningSettingsSlice,
};
