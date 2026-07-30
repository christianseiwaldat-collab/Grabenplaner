"use strict";

const { createHash } = require("node:crypto");
const {
  POSTGRESQL_APPLICATION_DIALECT_PLAN,
  SQLITE_APPLICATION_DIALECT_MANIFEST,
} = require("../dialects/application-manifest");
const {
  ORGANIZATION_PERSONNEL_STATEMENTS,
} = require("../statements/organization-personnel");
const {
  compilePostgresqlDialectEntry,
} = require("./dialect-compiler");

const ORGANIZATION_DEPARTMENTS_SLICE_ID = "organization-personnel.departments";
const DEPARTMENT_STATEMENT_ORDER = Object.freeze([
  ORGANIZATION_PERSONNEL_STATEMENTS.listDepartments,
  ORGANIZATION_PERSONNEL_STATEMENTS.insertDepartment,
]);
const EXPECTED_SOURCE_CONTRACT_FINGERPRINTS = Object.freeze({
  "organization-personnel.department.list":
    "a5ec6577da503df2838d0a62df6848e2180fb98c289b9f23d13a635caa3cf7ca",
  "organization-personnel.department.insert":
    "d38671fdf3da24ce2337b47b8955d775260e0f66adfdd7c10c844bce185a2b12",
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
  return new TypeError("Der PostgreSQL-Abteilungsslice ist ungültig.");
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
  returning = false,
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
    returning,
  });
  if (compiled.strategy !== "portable-generated") throw invalidSliceInput();
  return Object.freeze({
    providerEntry: Object.freeze({
      statement,
      sql: compiled.compiledSql,
      parameterOrder: compiled.parameterOrder,
      parameterBindings: compiled.parameterBindings,
      returning,
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

function createPostgresqlOrganizationDepartmentsSlice({ schemaName } = {}) {
  const schema = quotedSchemaName(schemaName);
  const relation = `${schema}."departments"`;
  const compiled = [
    compiledEntry(ORGANIZATION_PERSONNEL_STATEMENTS.listDepartments, `
      SELECT
        id,
        location_id,
        name,
        min_staff,
        active,
        sort_order,
        to_char(
          created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD HH24:MI:SS'
        ) AS created_at
      FROM ${relation}
      WHERE $includeInactive OR active
      ORDER BY
        location_id COLLATE "C" NULLS FIRST,
        active DESC NULLS LAST,
        sort_order NULLS FIRST,
        name COLLATE "C" NULLS FIRST
    `, {
      semanticResolutions: [
        "postgresql.boolean-predicate",
        "postgresql.sqlite-binary-collation",
        "postgresql.sqlite-utc-timestamp-text",
      ],
    }),
    compiledEntry(ORGANIZATION_PERSONNEL_STATEMENTS.insertDepartment, `
      INSERT INTO ${relation} (
        location_id,
        name,
        min_staff,
        active,
        sort_order
      )
      VALUES (
        $locationId,
        $name,
        $minStaff,
        $active,
        $sortOrder
      )
      RETURNING id
    `, {
      returning: true,
      semanticResolutions: ["postgresql.boolean-parameter"],
    }),
  ];
  if (compiled.length !== DEPARTMENT_STATEMENT_ORDER.length
    || compiled.some((entry, index) => (
      entry.providerEntry.statement !== DEPARTMENT_STATEMENT_ORDER[index]
    ))) {
    throw invalidSliceInput();
  }
  const entries = Object.freeze(compiled.map((entry) => entry.providerEntry));
  const provenance = Object.freeze(compiled.map((entry) => entry.provenance));
  const fingerprintSnapshot = Object.freeze({
    sliceId: ORGANIZATION_DEPARTMENTS_SLICE_ID,
    schemaName,
    sourcePlanFingerprint: POSTGRESQL_APPLICATION_DIALECT_PLAN.fingerprint,
    provenance,
  });
  return Object.freeze({
    sliceId: ORGANIZATION_DEPARTMENTS_SLICE_ID,
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
  ORGANIZATION_DEPARTMENTS_SLICE_ID,
  createPostgresqlOrganizationDepartmentsSlice,
};
