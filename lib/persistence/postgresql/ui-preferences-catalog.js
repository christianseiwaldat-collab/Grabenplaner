"use strict";

const { createHash } = require("node:crypto");
const {
  POSTGRESQL_APPLICATION_DIALECT_PLAN,
  SQLITE_APPLICATION_DIALECT_MANIFEST,
} = require("../dialects/application-manifest");
const {
  UI_PREFERENCES_STATEMENTS,
} = require("../statements/ui-preferences");
const {
  compilePostgresqlDialectEntry,
} = require("./dialect-compiler");

const UI_PREFERENCES_SLICE_ID = "ui-preferences";
const UI_PREFERENCES_STATEMENT_ORDER = Object.freeze([
  UI_PREFERENCES_STATEMENTS.list,
  UI_PREFERENCES_STATEMENTS.get,
  UI_PREFERENCES_STATEMENTS.upsert,
  UI_PREFERENCES_STATEMENTS.delete,
]);
const EXPECTED_SOURCE_CONTRACT_FINGERPRINTS = Object.freeze({
  "ui-preferences.list-by-employee":
    "26d43be6ba111caa6f80e450a62c14c810e8f7dc8070466d81f965352e744d6a",
  "ui-preferences.get":
    "4f5196ccf0716128e513c6be4e84351f9b4804e83f106bd6387ed9c044ab0b95",
  "ui-preferences.upsert":
    "14323490141f806cc70a23bb4d256258dee3fc9e334383f4a8bd3f041909c126",
  "ui-preferences.delete":
    "207005efe439461f52780ece0ba94c4ac434e44d4fa86faa7b44f80ddf9a7720",
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
  return new TypeError("Der PostgreSQL-UI-Präferenzslice ist ungültig.");
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

function compiledEntry(statement, sql) {
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
      resolvedFeatures: Object.freeze(
        statement === UI_PREFERENCES_STATEMENTS.list
          ? ["sqlite.collate-nocase"]
          : [],
      ),
      sqlFingerprint: compiled.compiledSqlFingerprint,
    }),
  });
}

function createPostgresqlUiPreferencesSlice({ schemaName } = {}) {
  const schema = quotedSchemaName(schemaName);
  const relation = `${schema}."portal_user_preferences"`;
  const compiled = [
    compiledEntry(UI_PREFERENCES_STATEMENTS.list, `
      SELECT preference_key AS preferenceKey, value
      FROM ${relation}
      WHERE employee_number = $employeeNumber
      ORDER BY
        translate(
          preference_key,
          'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
          'abcdefghijklmnopqrstuvwxyz'
        ) COLLATE "C" NULLS FIRST,
        preference_key COLLATE "C" NULLS FIRST
    `),
    compiledEntry(UI_PREFERENCES_STATEMENTS.get, `
      SELECT preference_key AS preferenceKey, value
      FROM ${relation}
      WHERE employee_number = $employeeNumber
        AND preference_key = $preferenceKey
      LIMIT 1
    `),
    compiledEntry(UI_PREFERENCES_STATEMENTS.upsert, `
      INSERT INTO ${relation} (
        employee_number,
        preference_key,
        value,
        updated_at
      )
      VALUES (
        $employeeNumber,
        $preferenceKey,
        $value,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (employee_number, preference_key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `),
    compiledEntry(UI_PREFERENCES_STATEMENTS.delete, `
      DELETE FROM ${relation}
      WHERE employee_number = $employeeNumber
        AND preference_key = $preferenceKey
    `),
  ];
  if (compiled.length !== UI_PREFERENCES_STATEMENT_ORDER.length
    || compiled.some((entry, index) => (
      entry.providerEntry.statement !== UI_PREFERENCES_STATEMENT_ORDER[index]
    ))) {
    throw invalidSliceInput();
  }
  const providerEntries = Object.freeze(
    compiled.map((entry) => entry.providerEntry),
  );
  const provenance = Object.freeze(
    compiled.map((entry) => entry.provenance),
  );
  const fingerprintSnapshot = Object.freeze({
    sliceId: UI_PREFERENCES_SLICE_ID,
    schemaName,
    sourcePlanFingerprint: POSTGRESQL_APPLICATION_DIALECT_PLAN.fingerprint,
    provenance,
  });
  return Object.freeze({
    sliceId: UI_PREFERENCES_SLICE_ID,
    status: "development-contract",
    developmentExecutable: true,
    executable: true,
    applicationExecutable: false,
    fullApplicationCatalog: false,
    productActivation: false,
    schemaName,
    sourcePlanFingerprint: POSTGRESQL_APPLICATION_DIALECT_PLAN.fingerprint,
    fingerprint: sha256(JSON.stringify(fingerprintSnapshot)),
    entries: providerEntries,
    provenance,
  });
}

module.exports = {
  UI_PREFERENCES_SLICE_ID,
  createPostgresqlUiPreferencesSlice,
};
