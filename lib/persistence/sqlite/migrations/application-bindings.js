"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  APPLICATION_MIGRATION_MANIFEST,
  APPLICATION_MIGRATION_OPERATION_IDS,
  APPLICATION_MIGRATION_OPERATION_CONTEXT_VERSION,
  APPLICATION_MIGRATION_RUNTIME_CONTEXT_KEY,
} = require("../../migrations/application-manifest");
const {
  ensureSqliteApplicationSchema,
} = require("../operations/application-schema");
const {
  createSqliteApplicationSeedingOperations,
} = require("../operations/application-seeding");
const {
  runSqliteFeatureCompatibilityMigrations,
} = require("../operations/feature-compatibility-migrations");
const {
  runSqliteHistoricalCompatibilityMigrations,
} = require("../operations/historical-compatibility-migrations");
const {
  runSqliteOrganizationSchemaMigrations,
} = require("../operations/organization-schema-migrations");
const {
  createSqliteProtectedRecordOperations,
} = require("../operations/protected-record-migrations");
const {
  runSqliteStartupSchemaMigrations,
} = require("../operations/startup-schema-migrations");
const {
  ensureSqliteSystemCenterMetricsSchema,
} = require("../operations/system-center-metrics-schema");
const {
  ensureSqliteBranchOrdersSchema,
} = require("../operations/branch-orders");

const REPOSITORY_ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION_BY_OPERATION_ID = new Map(
  APPLICATION_MIGRATION_MANIFEST.migrations.map((migration) => (
    [migration.operations[0], migration]
  )),
);

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function applicationRuntime(operationContext, expectedMigrationId) {
  if (!isPlainRecord(operationContext)
    || !operationContext.database
    || typeof operationContext.database.exec !== "function"
    || typeof operationContext.database.prepare !== "function"
    || operationContext.direction !== "apply"
    || operationContext.manifestId !== APPLICATION_MIGRATION_MANIFEST.id
    || operationContext.migrationId !== expectedMigrationId
    || !isPlainRecord(operationContext.context)) {
    throw new TypeError("SQLite application migration operation context is invalid.");
  }
  const runtime = operationContext.context[APPLICATION_MIGRATION_RUNTIME_CONTEXT_KEY];
  if (!isPlainRecord(runtime) || !isPlainRecord(runtime.state)) {
    throw new TypeError(
      `context.${APPLICATION_MIGRATION_RUNTIME_CONTEXT_KEY} with a mutable state is required.`,
    );
  }
  return {
    database: operationContext.database,
    runtime,
  };
}

function requiredOptions(runtime, key) {
  const options = runtime[key];
  if (!isPlainRecord(options)) {
    throw new TypeError(
      `context.${APPLICATION_MIGRATION_RUNTIME_CONTEXT_KEY}.${key} is required.`,
    );
  }
  return options;
}

function startupMigrationState(runtime, options) {
  const state = runtime.state.startupSchemaMigrationState || options.migrationState;
  if (!isPlainRecord(state)) {
    throw new TypeError("The startup schema migration state is required.");
  }
  return state;
}

function normalizedImplementationSource(value) {
  return String(value).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function sqliteApplicationMigrationImplementationClosure(modulePath) {
  if (typeof modulePath !== "string") {
    throw new TypeError("SQLite application migration module path is invalid.");
  }
  const entryPath = require.resolve(path.resolve(__dirname, modulePath));
  const visited = new Set();
  const sources = [];

  function visit(implementationPath) {
    const resolvedPath = path.resolve(implementationPath);
    if (visited.has(resolvedPath)) return;
    const relativePath = path.relative(REPOSITORY_ROOT, resolvedPath);
    if (!relativePath
      || relativePath.startsWith("..")
      || path.isAbsolute(relativePath)
      || relativePath.split(path.sep).includes("node_modules")) {
      throw new TypeError("SQLite application migration dependency leaves the repository.");
    }
    visited.add(resolvedPath);
    const source = normalizedImplementationSource(fs.readFileSync(resolvedPath, "utf8"));
    sources.push({
      file: relativePath.split(path.sep).join("/"),
      source,
    });
    if (!/\.[cm]?js$/i.test(resolvedPath)) return;
    for (const match of source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const dependencyPath = require.resolve(path.resolve(path.dirname(resolvedPath), specifier));
      visit(dependencyPath);
    }
  }

  visit(entryPath);
  return Object.freeze(
    sources
      .sort((left, right) => (
        left.file < right.file ? -1 : left.file > right.file ? 1 : 0
      ))
      .map((entry) => Object.freeze(entry)),
  );
}

function handleApplicationSchema(operationContext) {
  const { database } = applicationRuntime(
    operationContext,
    "stage.application-schema",
  );
  ensureSqliteApplicationSchema(database);
}

function handleStartupCompatibility(operationContext) {
  const { database, runtime } = applicationRuntime(
    operationContext,
    "stage.startup-compatibility",
  );
  const options = requiredOptions(runtime, "startupSchema");
  runtime.state.startupSchemaMigrationState = runSqliteStartupSchemaMigrations({
    ...options,
    appVersion: runtime.appVersion,
    database,
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
  });
}

function handleProtectedRecords(operationContext) {
  const { database, runtime } = applicationRuntime(
    operationContext,
    "stage.protected-records",
  );
  const options = requiredOptions(runtime, "protectedRecords");
  const migrationState = startupMigrationState(runtime, options);
  const operations = createSqliteProtectedRecordOperations(database, {
    ...options,
    appVersion: runtime.appVersion,
    vacationHistoryProtectionMigrationId: (
      options.vacationHistoryProtectionMigrationId
      || migrationState.vacationHistoryProtectionMigrationId
    ),
  });
  operations.migrateProtectedPersonnelRecords();
  operations.migrateProtectedVacationHistoryRecords();
  operations.verifyProtectedSensitivePersonnelRecords();
  operations.verifyProtectedPersonnelRecordDocuments();
}

function handleHistoricalCompatibility(operationContext) {
  const { database } = applicationRuntime(
    operationContext,
    "stage.historical-compatibility",
  );
  runSqliteHistoricalCompatibilityMigrations(database);
}

function handleApplicationDefaults(operationContext) {
  const { database, runtime } = applicationRuntime(
    operationContext,
    "stage.application-defaults",
  );
  const operations = createSqliteApplicationSeedingOperations(database);
  const result = operations.seedApplicationDefaults(
    requiredOptions(runtime, "applicationDefaults"),
  );
  runtime.state.legacyDaySettingsSnapshot = result.legacyDaySettingsSnapshot;
}

function handleFeatureCompatibility(operationContext) {
  const { database, runtime } = applicationRuntime(
    operationContext,
    "stage.feature-compatibility",
  );
  const options = requiredOptions(runtime, "featureCompatibility");
  runtime.state.featureCompatibilityMigrationState = (
    runSqliteFeatureCompatibilityMigrations(database, {
      ...options,
      appVersion: runtime.appVersion,
      migrationState: startupMigrationState(runtime, options),
    })
  );
}

function handleOrganizationSchema(operationContext) {
  const { database, runtime } = applicationRuntime(
    operationContext,
    "stage.organization-schema",
  );
  const options = requiredOptions(runtime, "organizationSchema");
  const legacyDaySettingsSnapshot = runtime.state.legacyDaySettingsSnapshot
    || options.legacyDaySettingsSnapshot;
  if (typeof legacyDaySettingsSnapshot !== "function") {
    throw new TypeError("The legacy day-settings snapshot operation is required.");
  }
  runtime.state.organizationSchemaMigrationState = (
    runSqliteOrganizationSchemaMigrations(database, {
      ...options,
      appVersion: runtime.appVersion,
      legacyDaySettingsSnapshot,
      migrationState: startupMigrationState(runtime, options),
    })
  );
}

function handleDemoProfile(operationContext) {
  const { database, runtime } = applicationRuntime(
    operationContext,
    "stage.optional-demo-profile",
  );
  const options = requiredOptions(runtime, "demoProfile");
  createSqliteApplicationSeedingOperations(database).seedDemoIfRequested({
    ...options,
    appVersion: runtime.appVersion,
  });
}

function handleSystemCenterSchema(operationContext) {
  const { database } = applicationRuntime(
    operationContext,
    "stage.system-center-schema",
  );
  ensureSqliteSystemCenterMetricsSchema(database);
}

function handleBranchOrdersSchema(operationContext) {
  const { database } = applicationRuntime(
    operationContext,
    "stage.branch-orders-schema",
  );
  ensureSqliteBranchOrdersSchema(database);
}

const SHARED_HANDLER_IMPLEMENTATION_SOURCE = [
  isPlainRecord,
  applicationRuntime,
  requiredOptions,
  startupMigrationState,
].map((implementation) => normalizedImplementationSource(implementation.toString())).join("\n");

function sqliteApplicationMigrationImplementationFingerprint({
  operationId,
  migrationId,
  modulePath,
  exportName,
  invocationId,
  handler,
} = {}) {
  if (typeof operationId !== "string"
    || typeof migrationId !== "string"
    || typeof modulePath !== "string"
    || typeof exportName !== "string"
    || typeof invocationId !== "string"
    || typeof handler !== "function") {
    throw new TypeError("SQLite application migration implementation metadata is invalid.");
  }
  const implementationClosure = sqliteApplicationMigrationImplementationClosure(modulePath);
  return createHash("sha256").update(JSON.stringify({
    operationContextVersion: APPLICATION_MIGRATION_OPERATION_CONTEXT_VERSION,
    operationId,
    migrationId,
    modulePath,
    exportName,
    invocationId,
    handlerSource: normalizedImplementationSource(handler.toString()),
    sharedHandlerSource: SHARED_HANDLER_IMPLEMENTATION_SOURCE,
    implementationClosure,
  })).digest("hex");
}

const SQLITE_BINDING_DEFINITIONS = Object.freeze([
  ["application.startup-compatibility.run", "../operations/startup-schema-migrations", "runSqliteStartupSchemaMigrations", "startup-options-v1", handleStartupCompatibility],
  ["application.schema.ensure", "../operations/application-schema", "ensureSqliteApplicationSchema", "direct-database-v1", handleApplicationSchema],
  ["application.protected-records.run", "../operations/protected-record-migrations", "createSqliteProtectedRecordOperations", "protected-operation-set-v1", handleProtectedRecords],
  ["application.historical-compatibility.run", "../operations/historical-compatibility-migrations", "runSqliteHistoricalCompatibilityMigrations", "direct-database-v1", handleHistoricalCompatibility],
  ["application.defaults.seed", "../operations/application-seeding", "createSqliteApplicationSeedingOperations", "application-defaults-v1", handleApplicationDefaults],
  ["application.feature-compatibility.run", "../operations/feature-compatibility-migrations", "runSqliteFeatureCompatibilityMigrations", "feature-options-v1", handleFeatureCompatibility],
  ["application.organization-schema.run", "../operations/organization-schema-migrations", "runSqliteOrganizationSchemaMigrations", "organization-options-v1", handleOrganizationSchema],
  ["application.demo-profile.seed", "../operations/application-seeding", "createSqliteApplicationSeedingOperations", "optional-demo-profile-v1", handleDemoProfile],
  ["application.system-center-schema.ensure", "../operations/system-center-metrics-schema", "ensureSqliteSystemCenterMetricsSchema", "direct-database-v1", handleSystemCenterSchema],
  ["application.branch-orders-schema.ensure", "../operations/branch-orders", "ensureSqliteBranchOrdersSchema", "direct-database-v1", handleBranchOrdersSchema],
].map(([operationId, modulePath, exportName, invocationId, handler]) => {
  const migration = MIGRATION_BY_OPERATION_ID.get(operationId);
  if (!migration) {
    throw new TypeError(`Application migration ${operationId} is not in the manifest.`);
  }
  return Object.freeze({
    operationId,
    migrationId: migration.id,
    modulePath,
    exportName,
    invocationId,
    handler: Object.freeze(handler),
    implementationFiles: Object.freeze(
      sqliteApplicationMigrationImplementationClosure(modulePath)
        .map((entry) => entry.file),
    ),
  });
}));

const SQLITE_APPLICATION_MIGRATION_BINDINGS = Object.freeze({
  providerId: "sqlite",
  status: "implemented-existing-runtime",
  executable: true,
  executionBoundary: "existing-runtime-bridge",
  genericAdapterCompatible: false,
  activationStatus: "mapped-not-ledger-activated",
  manifestFingerprint: APPLICATION_MIGRATION_MANIFEST.fingerprint,
  operationContextVersion: APPLICATION_MIGRATION_OPERATION_CONTEXT_VERSION,
  bindings: Object.freeze(SQLITE_BINDING_DEFINITIONS.map((definition) => Object.freeze({
    ...definition,
    implementationFingerprint: sqliteApplicationMigrationImplementationFingerprint(definition),
    atomicity: "implementation-managed",
    recoveryPolicy: "transaction-or-verified-pre-migration-backup",
    status: "implemented",
  }))),
});

const SQLITE_APPLICATION_MIGRATION_HANDLERS = Object.freeze(Object.fromEntries(
  SQLITE_APPLICATION_MIGRATION_BINDINGS.bindings.map((binding) => (
    [binding.operationId, binding.handler]
  )),
));

const SQLITE_APPLICATION_MIGRATION_OPERATIONS = Object.freeze(Object.fromEntries(
  SQLITE_APPLICATION_MIGRATION_BINDINGS.bindings.map((binding) => (
    [binding.operationId, Object.freeze({
      handler: binding.handler,
      implementationFingerprint: binding.implementationFingerprint,
    })]
  )),
));

const POSTGRESQL_APPLICATION_MIGRATION_FIXTURE = Object.freeze({
  providerId: "postgresql",
  status: "contract-only",
  executable: false,
  manifestFingerprint: APPLICATION_MIGRATION_MANIFEST.fingerprint,
  bindings: Object.freeze(APPLICATION_MIGRATION_OPERATION_IDS.map((operationId) => Object.freeze({
    operationId,
    status: "contract-only",
  }))),
});

module.exports = {
  POSTGRESQL_APPLICATION_MIGRATION_FIXTURE,
  SQLITE_APPLICATION_MIGRATION_BINDINGS,
  SQLITE_APPLICATION_MIGRATION_HANDLERS,
  SQLITE_APPLICATION_MIGRATION_OPERATIONS,
  sqliteApplicationMigrationImplementationClosure,
  sqliteApplicationMigrationImplementationFingerprint,
};
