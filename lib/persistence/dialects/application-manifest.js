"use strict";

const { createHash } = require("node:crypto");
const {
  defineDialectManifest,
  definePlannedDialectFixture,
} = require("./contract");
const {
  POSTGRESQL_DIALECT_COMPILER_VERSION,
  compilePostgresqlDialectEntry,
} = require("../postgresql/dialect-compiler");
const {
  SQLITE_APPLICATION_CATALOG,
} = require("../sqlite/application-catalog");

const SQLITE_FEATURE_RULES = Object.freeze([
  Object.freeze({ id: "sqlite.autoincrement", pattern: /\bAUTOINCREMENT\b/i }),
  Object.freeze({ id: "sqlite.collate-nocase", pattern: /\bCOLLATE\s+NOCASE\b/i }),
  Object.freeze({ id: "sqlite.date-time-functions", pattern: /\b(?:date|datetime|strftime|time)\s*\(/i }),
  Object.freeze({ id: "sqlite.glob-operator", pattern: /\bGLOB\b/i }),
  Object.freeze({ id: "sqlite.group-concat", pattern: /\bgroup_concat\s*\(/i }),
  Object.freeze({ id: "sqlite.insert-or-ignore", pattern: /\bINSERT\s+OR\s+IGNORE\b/i }),
  Object.freeze({ id: "sqlite.insert-or-replace", pattern: /\bINSERT\s+OR\s+REPLACE\b/i }),
  Object.freeze({ id: "sqlite.instr-function", pattern: /\binstr\s*\(/i }),
  Object.freeze({ id: "sqlite.json-functions", pattern: /\bjson_(?:array|each|extract|group_array|group_object|insert|object|patch|quote|remove|replace|set|type|valid)\s*\(/i }),
  Object.freeze({ id: "sqlite.julianday-function", pattern: /\bjulianday\s*\(/i }),
  Object.freeze({ id: "sqlite.named-dollar-parameters", pattern: /\$[A-Za-z_][A-Za-z0-9_]*/ }),
  Object.freeze({ id: "sqlite.raise-abort", pattern: /\bRAISE\s*\(\s*ABORT\b/i }),
  Object.freeze({ id: "sqlite.returning-clause", pattern: /\bRETURNING\b/i }),
  Object.freeze({ id: "sqlite.schema-catalog", pattern: /\bsqlite_(?:master|schema|sequence)\b|\bpragma_table_info\s*\(/i }),
  Object.freeze({ id: "sqlite.substr-function", pattern: /\bsubstr\s*\(/i }),
  Object.freeze({ id: "sqlite.upsert-clause", pattern: /\bON\s+CONFLICT\b/i }),
]);

function sqliteDialectFeatures(sql) {
  return SQLITE_FEATURE_RULES
    .filter((rule) => rule.pattern.test(sql))
    .map((rule) => rule.id)
    .sort();
}

const SQLITE_APPLICATION_DIALECT_MANIFEST = defineDialectManifest({
  dialectId: "sqlite",
  executable: true,
  entries: SQLITE_APPLICATION_CATALOG.map((entry) => {
    const features = sqliteDialectFeatures(entry.sql);
    return {
      statement: entry.statement,
      owner: entry.statement.id.split(".")[0],
      classification: features.length ? "dialect-variant" : "sqlite-baseline",
      features,
      sql: entry.sql,
      returning: entry.returning,
    };
  }),
});

const POSTGRESQL_APPLICATION_DIALECT_FIXTURE = definePlannedDialectFixture({
  dialectId: "postgresql",
  sourceManifest: SQLITE_APPLICATION_DIALECT_MANIFEST,
  entries: SQLITE_APPLICATION_DIALECT_MANIFEST.entries.map((entry) => ({
    statementId: entry.statement.id,
    owner: entry.owner,
    classification: entry.classification,
    requiredFeatures: entry.features,
    status: "contract-only",
  })),
});

const POSTGRESQL_DIALECT_PLAN_STATUS = "implementation-in-progress";

function planFingerprint(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function frozenFeatureCounts(entries) {
  const counts = new Map();
  for (const entry of entries) {
    for (const feature of entry.blockingFeatures) {
      counts.set(feature, (counts.get(feature) || 0) + 1);
    }
  }
  return Object.freeze(Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  ));
}

const postgresqlPlanEntries = Object.freeze(
  SQLITE_APPLICATION_DIALECT_MANIFEST.entries.map((sourceEntry) => {
    const compiled = compilePostgresqlDialectEntry({
      statement: sourceEntry.statement,
      sql: sourceEntry.sql,
      returning: sourceEntry.returning,
    });
    const shared = {
      statementId: sourceEntry.statement.id,
      owner: sourceEntry.owner,
      sourceClassification: sourceEntry.classification,
      sourceFeatures: Object.freeze([...sourceEntry.features]),
      strategy: compiled.strategy,
      sourceSqlFingerprint: compiled.sourceSqlFingerprint,
      parameterOrder: compiled.parameterOrder,
      coveredFeatures: compiled.coveredFeatures,
      blockingFeatures: compiled.blockingFeatures,
      returning: sourceEntry.returning,
    };
    if (compiled.strategy === "portable-generated") {
      return Object.freeze({
        ...shared,
        sql: compiled.compiledSql,
        compiledSqlFingerprint: compiled.compiledSqlFingerprint,
        parameterBindings: compiled.parameterBindings,
      });
    }
    return Object.freeze(shared);
  }),
);

const postgresqlPlanSummary = Object.freeze({
  statementCount: postgresqlPlanEntries.length,
  portableGeneratedCount: postgresqlPlanEntries
    .filter((entry) => entry.strategy === "portable-generated").length,
  requiresOverrideCount: postgresqlPlanEntries
    .filter((entry) => entry.strategy === "requires-override").length,
  blockingFeatureCounts: frozenFeatureCounts(postgresqlPlanEntries),
});

const postgresqlPlanSnapshot = Object.freeze({
  compilerVersion: POSTGRESQL_DIALECT_COMPILER_VERSION,
  sourceFingerprint: SQLITE_APPLICATION_DIALECT_MANIFEST.fingerprint,
  status: POSTGRESQL_DIALECT_PLAN_STATUS,
  executable: false,
  summary: postgresqlPlanSummary,
  entries: postgresqlPlanEntries,
});

const POSTGRESQL_APPLICATION_DIALECT_PLAN = Object.freeze({
  ...postgresqlPlanSnapshot,
  fingerprint: planFingerprint(postgresqlPlanSnapshot),
});

module.exports = {
  POSTGRESQL_APPLICATION_DIALECT_FIXTURE,
  POSTGRESQL_APPLICATION_DIALECT_PLAN,
  SQLITE_APPLICATION_DIALECT_MANIFEST,
  SQLITE_FEATURE_RULES,
  sqliteDialectFeatures,
};
