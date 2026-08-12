"use strict";

const crypto = require("node:crypto");
const {
  SQLITE_SALES_ANALYTICS_CATALOG,
} = require("../sqlite/sales-analytics-catalog");
const {
  compilePostgresqlDialectEntry,
} = require("./dialect-compiler");

const SALES_ANALYTICS_PERSISTENCE_SLICE_ID = "sales-analytics-persistence";
const SALES_RELATIONS = Object.freeze([
  "sales_import_profiles",
  "sales_import_profile_revisions",
  "sales_import_runs",
  "sales_import_staging_records",
  "sales_branch_mapping_heads",
  "sales_branch_mapping_revisions",
  "sales_aggregate_reports",
  "sales_report_product_group_metrics",
  "sales_report_total_metrics",
]);

function quotedSchemaName(schemaName) {
  if (typeof schemaName !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) {
    throw new TypeError("Der PostgreSQL-Sales-Persistenzslice ist ungueltig.");
  }
  return `"${schemaName}"`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fieldSnapshot(fields, preserveOrder) {
  const names = preserveOrder ? Object.keys(fields) : Object.keys(fields).sort();
  return names.map((name) => ({ name, ...fields[name] }));
}

function sourceCatalogSnapshot() {
  return SQLITE_SALES_ANALYTICS_CATALOG.map(({ statement, sql, returning }) => ({
    statement: {
      id: statement.id,
      operation: statement.operation,
      parameters: fieldSnapshot(statement.parameters, false),
      columns: fieldSnapshot(statement.columns, true),
    },
    sql,
    returning,
  }));
}

function qualifyRelations(sql, schemaName) {
  const schema = quotedSchemaName(schemaName);
  let qualified = sql;
  for (const relation of SALES_RELATIONS) {
    qualified = qualified.replace(
      new RegExp(`\\b${relation}\\b`, "g"),
      `${schema}."${relation}"`,
    );
  }
  return qualified;
}

function createPostgresqlSalesAnalyticsPersistenceSlice({ schemaName } = {}) {
  quotedSchemaName(schemaName);
  const sourceCatalogFingerprint = sha256(JSON.stringify(sourceCatalogSnapshot()));
  const compiled = SQLITE_SALES_ANALYTICS_CATALOG.map((sourceEntry) => {
    const qualifiedSql = qualifyRelations(sourceEntry.sql, schemaName);
    const result = compilePostgresqlDialectEntry({
      statement: sourceEntry.statement,
      sql: qualifiedSql,
      returning: sourceEntry.returning,
    });
    if (result.strategy !== "portable-generated") {
      throw new TypeError("Der PostgreSQL-Sales-Persistenzslice ist nicht portabel.");
    }
    return Object.freeze({
      providerEntry: Object.freeze({
        statement: sourceEntry.statement,
        sql: result.compiledSql,
        parameterOrder: result.parameterOrder,
        parameterBindings: result.parameterBindings,
        returning: sourceEntry.returning,
      }),
      provenance: Object.freeze({
        statementId: sourceEntry.statement.id,
        sourceSqlFingerprint: sha256(sourceEntry.sql),
        qualifiedSqlFingerprint: sha256(qualifiedSql),
        compiledSqlFingerprint: result.compiledSqlFingerprint,
        coveredFeatures: result.coveredFeatures,
      }),
    });
  });
  const entries = Object.freeze(compiled.map(({ providerEntry }) => providerEntry));
  const provenance = Object.freeze(compiled.map((item) => item.provenance));
  const snapshot = {
    sliceId: SALES_ANALYTICS_PERSISTENCE_SLICE_ID,
    schemaName,
    sourceCatalogFingerprint,
    entries: provenance,
  };
  return Object.freeze({
    sliceId: SALES_ANALYTICS_PERSISTENCE_SLICE_ID,
    status: "development-contract",
    developmentExecutable: true,
    executable: true,
    applicationExecutable: false,
    fullApplicationCatalog: false,
    productActivation: false,
    schemaName,
    sourceCatalogFingerprint,
    fingerprint: sha256(JSON.stringify(snapshot)),
    entries,
    provenance,
  });
}

module.exports = {
  SALES_ANALYTICS_PERSISTENCE_SLICE_ID,
  createPostgresqlSalesAnalyticsPersistenceSlice,
};
