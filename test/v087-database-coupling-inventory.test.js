"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  BASELINE,
  PHASE_3_ALLOWED_PRODUCTION_DRIVER_FILES,
  PHASE_3_ALLOWED_TEST_DRIVER_FILES,
  PHASE_3_SQLITE_DRIVER_FILES,
  PHASE_3_SQLITE_PROVIDER_FILES,
  PHASE_3_SQLITE_PROVIDER_TEST_FILES,
  PHASE_4_EXPECTED_DIALECT_VARIANT_COUNT,
  PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT,
  PHASE_4_EXPECTED_NAMED_DOLLAR_PARAMETER_STATEMENT_COUNT,
  PHASE_4_EXPECTED_SQLITE_BASELINE_STATEMENT_COUNT,
  PHASE_4_EXPECTED_STATEMENT_COUNT,
  PHASE_4_PERSISTENCE_FILES,
  PHASE_4_PERSISTENCE_TEST_FILES,
  PHASE_5_EXPECTED_COMPILER_VERSION,
  PHASE_5_EXPECTED_DEVELOPMENT_SLICE_STATEMENT_COUNT,
  PHASE_5_EXPECTED_ORGANIZATION_DEPARTMENTS_STATEMENT_COUNT,
  PHASE_5_EXPECTED_OVERRIDE_DIALECT_COUNT,
  PHASE_5_EXPECTED_PLANNING_SETTINGS_STATEMENT_COUNT,
  PHASE_5_EXPECTED_PORTABLE_DIALECT_COUNT,
  PHASE_5_EXPECTED_SYSTEM_CENTER_METRICS_STATEMENT_COUNT,
  PHASE_5_EXPECTED_UI_PREFERENCES_STATEMENT_COUNT,
  PHASE_5_POSTGRESQL_DRIVER_FILES,
  PHASE_5_POSTGRESQL_FILES,
  PHASE_5_POSTGRESQL_TEST_FILES,
  SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_COUNT,
  SALES_ANALYTICS_EXPECTED_SCHEMA_STATEMENT_COUNT,
  SALES_ANALYTICS_PERSISTENCE_SLICE_FILES,
  SALES_ANALYTICS_PERSISTENCE_SLICE_TEST_FILES,
  architectureBoundaryViolationsForText,
  isPostgresqlRuntimeArtifactPath,
  scanRepository,
} = require("../scripts/audit-persistence-coupling");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("v0.87 Datenbank Block 3: Importscanner erkennt Ausfuehrung ohne Dokumentationstext zu melden", () => {
  const specifier = "node:" + "sqlite";
  const hasSqliteViolation = (file, source) => architectureBoundaryViolationsForText(file, source)
    .some((entry) => entry.kind === "sqlite-driver-import-outside-boundary");

  for (const source of [
    `const load = require; load("${specifier}");`,
    `require?.("${specifier}");`,
    'require("node:" + "sqlite");',
    `eval('require("${specifier}")');`,
    `spawnSync(process.execPath, ["-e", 'require("${specifier}")']);`,
  ]) {
    assert.equal(hasSqliteViolation("lib/personnel.js", source), true, source);
  }
  assert.equal(
    hasSqliteViolation(
      "scripts/example.sh",
      `node - <<'NODE'\nrequire("${specifier}")\nNODE`,
    ),
    true,
  );

  assert.equal(
    hasSqliteViolation(
      "lib/personnel.js",
      `spawnSync("echo", ["-e", 'require("${specifier}")']);`,
    ),
    false,
  );
  assert.equal(
    hasSqliteViolation(
      "scripts/example.sh",
      `cat <<'DOC'\nrequire("${specifier}")\nDOC`,
    ),
    false,
  );
});

test("v0.87 Datenbank Block 5: PostgreSQL-Runtime-Gate erlaubt nur den benannten Slice", () => {
  const hasPostgresqlViolation = (file, source) => architectureBoundaryViolationsForText(file, source)
    .some((entry) => [
      "postgresql-driver-import",
      "postgresql-runtime-provider",
    ].includes(entry.kind));

  for (const source of [
    'const load = require; load("pg");',
    'require?.("postgres");',
    'require("p" + "g");',
    'import("pg-promise");',
    'import "@neondatabase/serverless";',
    'import client from "@vercel/postgres";',
    'export { Pool } from "pg";',
    'eval(\'require("postgresql")\');',
    'spawnSync(process.execPath, ["-e", \'require("pg")\']);',
    'const { createRequire } = require("node:module"); const load = createRequire(__filename); load("pg");',
    'Reflect.apply(require, null, ["pg"]);',
    "module.exports = { createPostgresqlProvider(client) { return client; } };",
  ]) {
    assert.equal(hasPostgresqlViolation("lib/personnel.js", source), true, source);
  }

  assert.deepEqual(
    architectureBoundaryViolationsForText(
      "lib/persistence/postgresql/pool.js",
      'const pg = require("pg"); function openPostgresqlDevelopmentPersistence() {}',
    ),
    [],
  );
  assert.deepEqual(
    architectureBoundaryViolationsForText(
      "lib/persistence/postgresql/provider.js",
      "function createPostgresqlPersistenceProvider() {}",
    ),
    [],
  );
  assert.deepEqual(
    architectureBoundaryViolationsForText(
      "lib/persistence/postgresql/ui-preferences-catalog.js",
      "function createPostgresqlUiPreferencesSlice() {}",
    ),
    [],
  );
  for (const [file, source] of [
    [
      "lib/persistence/postgresql/catalog-contract.js",
      "function definePostgresqlApplicationCatalog() {}",
    ],
    [
      "lib/persistence/postgresql/migrations/adapter.js",
      "function createPostgresqlMigrationAdapter() {}",
    ],
    [
      "lib/persistence/postgresql/planning-settings-catalog.js",
      "function createPostgresqlPlanningSettingsSlice() {}",
    ],
    [
      "lib/persistence/postgresql/organization-departments-catalog.js",
      "function createPostgresqlOrganizationDepartmentsSlice() {}",
    ],
    [
      "lib/persistence/postgresql/system-center-metrics-catalog.js",
      "function createPostgresqlSystemCenterMetricsOldestIntervalKeysSlice() {}",
    ],
  ]) {
    assert.deepEqual(architectureBoundaryViolationsForText(file, source), []);
  }
  assert.deepEqual(PHASE_5_POSTGRESQL_DRIVER_FILES, [
    "lib/persistence/postgresql/pool.js",
  ]);
  assert.deepEqual(PHASE_5_POSTGRESQL_FILES, [
    "lib/persistence/postgresql/catalog-contract.js",
    "lib/persistence/postgresql/dialect-compiler.js",
    "lib/persistence/postgresql/migrations/adapter.js",
    "lib/persistence/postgresql/organization-departments-catalog.js",
    "lib/persistence/postgresql/planning-settings-catalog.js",
    "lib/persistence/postgresql/policy.js",
    "lib/persistence/postgresql/pool.js",
    "lib/persistence/postgresql/provider.js",
    "lib/persistence/postgresql/sales-article-catalog-schema.js",
    "lib/persistence/postgresql/system-center-metrics-catalog.js",
    "lib/persistence/postgresql/ui-preferences-catalog.js",
  ]);
  assert.deepEqual(PHASE_5_POSTGRESQL_TEST_FILES, [
    "test/v087-database-block5-postgresql-application-dialect-plan.test.js",
    "test/v087-database-block5-postgresql-catalog-contract.test.js",
    "test/v087-database-block5-postgresql-dialect-compiler.test.js",
    "test/v087-database-block5-postgresql-live.test.js",
    "test/v087-database-block5-postgresql-migration-adapter.test.js",
    "test/v087-database-block5-postgresql-organization-departments.test.js",
    "test/v087-database-block5-postgresql-planning-settings.test.js",
    "test/v087-database-block5-postgresql-pool-policy.test.js",
    "test/v087-database-block5-postgresql-provider.test.js",
    "test/sales-article-catalog-postgresql-contract.test.js",
    "test/v087-database-block5-postgresql-system-center-metrics.test.js",
    "test/v087-database-block5-postgresql-ui-preferences.test.js",
  ]);
  assert.deepEqual(SALES_ANALYTICS_PERSISTENCE_SLICE_FILES, [
    "lib/persistence/postgresql/sales-analytics-catalog.js",
    "lib/persistence/postgresql/sales-analytics-schema.js",
    "lib/persistence/repositories/sales-analytics.js",
    "lib/persistence/sqlite/operations/sales-analytics-schema.js",
    "lib/persistence/sqlite/sales-analytics-catalog.js",
    "lib/persistence/statements/sales-analytics.js",
  ]);
  assert.deepEqual(SALES_ANALYTICS_PERSISTENCE_SLICE_TEST_FILES, [
    "test/sales-analytics-persistence-foundation.test.js",
    "test/sales-analytics-production-hardening.test.js",
    "test/sales-analytics-tradefoto-report.test.js",
  ]);
  assert.deepEqual(
    architectureBoundaryViolationsForText(
      "lib/persistence/postgresql/sales-analytics-catalog.js",
      "function createPostgresqlSalesAnalyticsPersistenceSlice() {}",
    ),
    [],
  );
  assert.equal(isPostgresqlRuntimeArtifactPath("lib/persistence/providers/postgresql.js"), true);
  assert.equal(isPostgresqlRuntimeArtifactPath("lib/postgres/provider.js"), true);
  assert.equal(isPostgresqlRuntimeArtifactPath("lib/persistence/pg-adapter.js"), true);
  assert.equal(isPostgresqlRuntimeArtifactPath("lib/persistence/postgresql/provider.js"), true);
  assert.equal(isPostgresqlRuntimeArtifactPath("test/postgresql-fixture.js"), false);
  assert.equal(isPostgresqlRuntimeArtifactPath("lib/persistence/dialects/application-manifest.js"), false);
});

test("v0.87 Datenbank Block 4: bestehende Anwendungsmigration bleibt ausserhalb der Produktivverdrahtung", () => {
  const activationSource = `
    const { runMigrationManifest } = require("./lib/persistence/migrations/runner");
    const {
      createSqliteMigrationAdapter,
    } = require("./lib/persistence/sqlite/migrations/adapter");
    const {
      SQLITE_APPLICATION_MIGRATION_OPERATIONS,
    } = require("./lib/persistence/sqlite/migrations/application-bindings");
    runMigrationManifest({
      adapter: createSqliteMigrationAdapter({
        database,
        operations: SQLITE_APPLICATION_MIGRATION_OPERATIONS,
      }),
    });
  `;
  assert.equal(
    architectureBoundaryViolationsForText("server.js", activationSource)
      .some((entry) => entry.kind === "phase4-application-migration-runtime-activation"),
    true,
  );
});

test("v0.87 Datenbank Block 5: historische Baselines und aktuelle Phasen bleiben auditierbar", () => {
  const report = scanRepository(root);

  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.deepEqual(BASELINE, {
    schemaVersion: 1,
    capturedAt: "2026-07-29",
    sourceCommit: "92b023ce0b3fe545aa5253ae0903af8822388afc",
    productionDirectFiles: 28,
    productionIndirectFiles: 28,
    testCandidateFiles: 69,
    testDriverFiles: 26,
    productionTotals: {
      directNodeSqliteImport: 25,
      prepareCall: 1394,
      execCall: 419,
      beginImmediate: 68,
      beginExclusive: 1,
      ["prag" + "ma"]: 63,
      insertOrIgnore: 65,
      insertOrReplace: 3,
      onConflict: 41,
      raiseAbort: 98,
      ["auto" + "increment"]: 21,
      collateNocase: 54,
      julianday: 14,
      globOperator: 2,
      vacuumInto: 6,
      quickCheck: 27,
      foreignKeyCheck: 3,
      walCheckpoint: 2,
      ["lastInsert" + "Rowid"]: 32,
      sqliteCatalog: 32,
      schemaMigrations: 87,
      ensureColumn: 94,
      createTable: 122,
      createTriggerDdl: 98,
      createIndex: 128,
      alterTable: 19,
      migrationIdDeclaration: 17,
    },
    serverHotspot: {
      prepareCall: 1149,
      dbPrepareCall: 1101,
      dbExecCall: 359,
      beginImmediate: 59,
      createTable: 120,
      createTriggerDdl: 98,
      createIndex: 127,
      alterTable: 19,
      ensureColumn: 94,
      schemaMigrations: 82,
      migrationIdDeclaration: 17,
    },
  });

  for (const [key, maximum] of Object.entries(BASELINE.productionTotals)) {
    assert.ok(report.legacyProductionTotals[key] <= maximum, `${key}: ${report.legacyProductionTotals[key]} > ${maximum}`);
  }
  for (const [key, maximum] of Object.entries(BASELINE.serverHotspot)) {
    assert.ok(report.serverHotspot[key] <= maximum, `${key}: ${report.serverHotspot[key]} > ${maximum}`);
  }
  assert.ok(report.legacyProductionTotals.prepareCall < BASELINE.productionTotals.prepareCall);
  assert.ok(report.serverHotspot.dbPrepareCall < BASELINE.serverHotspot.dbPrepareCall);
  assert.equal(
    report.productionTotals.directNodeSqliteImport,
    BASELINE.productionTotals.directNodeSqliteImport + 2,
  );
  assert.equal(
    report.legacyProductionTotals.directNodeSqliteImport,
    BASELINE.productionTotals.directNodeSqliteImport,
  );

  // Personalmodul-, Lernmodul- inklusive Fortschritt, versionierte Einsatzanfragen,
  // Geburtstagseinblendungs-Claims, Filialbestellungs-, Teamsitzungs-, Positionskatalog- und
  // Verkaufsanalyse- und zentraler Artikelstamm-Schemaoperationen sowie die
  // persistenzfreie Funktionssuche sind
  // explizit klassifiziert.
  // Block 5 adds a named query repository; raw test DB access stays in test-support.
  // The CRM identity startup migration now reads its existing table schema
  // through the already classified SQLite operations adapter.
  // The explicitly authorized customer maintenance CLI adds only connection
  // PRAGMAs; business writes use the existing audited repositories.
  // Search projection, cash inventory and role-default schema adapters are
  // explicit SQLite operations; the synthetic benchmark is a test entrypoint.
  assert.equal(report.summary.productionDirectFiles, 81);
  // Five archive/child operating adapters and one read-only recovery-key
  // verifier and isolated full-source measurement extend the existing indirect
  // inventory; no raw business access or productive import activation.
  // The workspace lease reuses the existing lock adapter; Offsite staging
  // reads only the configured database path, not business records.
  assert.equal(report.summary.productionIndirectFiles, BASELINE.productionIndirectFiles + 15);
  assert.equal(report.summary.testCandidateFiles, BASELINE.testCandidateFiles + 4);
  const expectedTestDriverFiles = [...PHASE_3_ALLOWED_TEST_DRIVER_FILES];
  assert.equal(report.summary.testDriverFiles, expectedTestDriverFiles.length);
  assert.equal(report.summary.productionJavaScriptDriverFiles, 14);
  assert.equal(report.summary.phase3SqliteProviderFiles, PHASE_3_SQLITE_PROVIDER_FILES.length);
  assert.equal(report.summary.phase3SqliteProviderTestFiles, PHASE_3_SQLITE_PROVIDER_TEST_FILES.length);
  assert.equal(report.summary.phase4PersistenceFiles, PHASE_4_PERSISTENCE_FILES.length);
  assert.equal(report.summary.phase4PersistenceTestFiles, PHASE_4_PERSISTENCE_TEST_FILES.length);
  assert.equal(report.summary.phase5PostgresqlFiles, PHASE_5_POSTGRESQL_FILES.length);
  assert.equal(report.summary.phase5PostgresqlTestFiles, PHASE_5_POSTGRESQL_TEST_FILES.length);
  assert.equal(
    report.summary.salesAnalyticsPersistenceFiles,
    SALES_ANALYTICS_PERSISTENCE_SLICE_FILES.length,
  );
  assert.equal(
    report.summary.salesAnalyticsPersistenceTestFiles,
    SALES_ANALYTICS_PERSISTENCE_SLICE_TEST_FILES.length,
  );
  assert.deepEqual(report.productionDriverFiles, [...PHASE_3_ALLOWED_PRODUCTION_DRIVER_FILES].sort());
  assert.deepEqual(report.testDriverFiles, expectedTestDriverFiles.sort());
  assert.equal(report.phase3Progress.status, "completed");
  assert.deepEqual(report.phase3Progress.completedSlices, ["all-runtime-domains"]);
  assert.deepEqual(report.phase3Progress.sqliteProviderDriverFiles, [...PHASE_3_SQLITE_DRIVER_FILES]);
  assert.equal(report.phase3Progress.sqliteProviderDriverImports, 1);
  assert.equal(report.phase3Progress.uiPreferencesFunctionsFound, 4);
  assert.equal(report.phase3Progress.uiPreferencesLegacyRawCalls, 0);
  assert.equal(report.phase3Progress.uiPreferencesRepositoryWiringComplete, true);
  assert.equal(report.phase3Progress.uiPreferencesRoutesAwaited, true);
  assert.equal(report.phase3Progress.remainingServerDbPrepareCalls, 0);
  assert.equal(report.phase3Progress.remainingServerDbExecCalls, 0);
  assert.equal(report.phase3Progress.remainingDomainRawAccess, 0);
  assert.equal(report.phase3Progress.legacyServerDriverImportStillPresent, false);
  assert.equal(report.phase3Progress.fullSqliteParity, true);
  assert.equal(report.phase4Progress.status, "completed");
  assert.equal(report.phase4Progress.complete, true);
  assert.equal(report.phase4Progress.statementCount, PHASE_4_EXPECTED_STATEMENT_COUNT);
  assert.equal(report.phase4Progress.sqliteStatementCount, PHASE_4_EXPECTED_STATEMENT_COUNT);
  assert.equal(report.phase4Progress.postgresqlStatementCount, PHASE_4_EXPECTED_STATEMENT_COUNT);
  assert.equal(
    report.phase4Progress.sqliteBaselineStatementCount,
    PHASE_4_EXPECTED_SQLITE_BASELINE_STATEMENT_COUNT,
  );
  assert.equal(
    report.phase4Progress.dialectVariantStatementCount,
    PHASE_4_EXPECTED_DIALECT_VARIANT_COUNT,
  );
  assert.equal(
    report.phase4Progress.sqliteBaselineStatementCount
      + report.phase4Progress.dialectVariantStatementCount,
    PHASE_4_EXPECTED_STATEMENT_COUNT,
  );
  assert.equal(
    report.phase4Progress.namedDollarParameterStatementCount,
    PHASE_4_EXPECTED_NAMED_DOLLAR_PARAMETER_STATEMENT_COUNT,
  );
  assert.equal(
    report.phase4Progress.migrationCount,
    PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT,
  );
  assert.equal(
    report.phase4Progress.migrationOperationCount,
    PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT,
  );
  assert.equal(
    report.phase4Progress.sqliteMigrationBindingCount,
    PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT,
  );
  assert.equal(
    report.phase4Progress.postgresqlMigrationBindingCount,
    PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT,
  );
  assert.equal(report.phase4Progress.executablePostgresqlRuntimeArtifacts, 0);
  for (const field of [
    "postgresqlRuntimeArtifacts",
    "duplicateStatementIds",
    "duplicateSqliteStatementBindings",
    "duplicatePostgresqlStatementBindings",
    "missingSqliteStatementBindings",
    "extraSqliteStatementBindings",
    "missingPostgresqlStatementBindings",
    "extraPostgresqlStatementBindings",
    "dialectMetadataViolations",
    "duplicateMigrationOperationIds",
    "duplicateSqliteMigrationBindings",
    "duplicatePostgresqlMigrationBindings",
    "missingSqliteMigrationBindings",
    "extraSqliteMigrationBindings",
    "missingPostgresqlMigrationBindings",
    "extraPostgresqlMigrationBindings",
    "migrationMetadataViolations",
    "bindingImplementationErrors",
    "missingFiles",
    "missingTestFiles",
    "moduleErrors",
  ]) {
    assert.deepEqual(report.phase4Progress[field], [], field);
  }
  assert.equal(report.phase5Progress.status, "in-progress");
  assert.equal(report.phase5Progress.providerSliceStatus, "completed");
  assert.equal(report.phase5Progress.providerSliceComplete, true);
  assert.equal(report.phase5Progress.productionActivation, false);
  assert.equal(report.phase5Progress.configurationStillClosed, true);
  assert.equal(report.phase5Progress.serverActivationReferences, 0);
  assert.equal(report.phase5Progress.driverDependency, "8.22.0");
  assert.equal(report.phase5Progress.providerContractValid, true);
  assert.equal(report.phase5Progress.policyValid, true);
  assert.equal(report.phase5Progress.compilerValid, true);
  assert.equal(
    report.phase5Progress.compilerVersion,
    PHASE_5_EXPECTED_COMPILER_VERSION,
  );
  assert.equal(report.phase5Progress.dialectPlanValid, true);
  assert.equal(report.phase5Progress.dialectPlanStatementCount, 1348);
  assert.equal(
    report.phase5Progress.portableDialectCount,
    PHASE_5_EXPECTED_PORTABLE_DIALECT_COUNT,
  );
  assert.equal(
    report.phase5Progress.overrideDialectCount,
    PHASE_5_EXPECTED_OVERRIDE_DIALECT_COUNT,
  );
  assert.equal(report.phase5Progress.executableApplicationDialectCount, 0);
  assert.equal(report.phase5Progress.fullApplicationCatalogExecutable, false);
  assert.deepEqual(report.phase5Progress.catalogContract, {
    valid: true,
    executableSlice: false,
    applicationExecutable: false,
    fullApplicationCatalog: false,
    acceptanceStatus: "closed",
    requiredReceiptCount: 1348,
    acceptedReceiptCount: 0,
  });
  assert.deepEqual(report.phase5Progress.uiPreferencesSlice, {
    status: "development-contract",
    valid: true,
    sourceDriftPinValid: true,
    sourceContractDriftPinValid: true,
    developmentExecutable: true,
    executable: true,
    applicationExecutable: false,
    fullApplicationCatalog: false,
    productActivation: false,
    statementCount: PHASE_5_EXPECTED_UI_PREFERENCES_STATEMENT_COUNT,
    expectedStatementCount: PHASE_5_EXPECTED_UI_PREFERENCES_STATEMENT_COUNT,
    executableStatementCount: PHASE_5_EXPECTED_UI_PREFERENCES_STATEMENT_COUNT,
  });
  assert.deepEqual(report.phase5Progress.planningSettingsSlice, {
    status: "development-contract",
    valid: true,
    sourceDriftPinValid: true,
    sourceContractDriftPinValid: true,
    developmentExecutable: true,
    executable: true,
    applicationExecutable: false,
    fullApplicationCatalog: false,
    productActivation: false,
    statementCount: PHASE_5_EXPECTED_PLANNING_SETTINGS_STATEMENT_COUNT,
    expectedStatementCount: PHASE_5_EXPECTED_PLANNING_SETTINGS_STATEMENT_COUNT,
    executableStatementCount: PHASE_5_EXPECTED_PLANNING_SETTINGS_STATEMENT_COUNT,
  });
  assert.deepEqual(report.phase5Progress.organizationDepartmentsSlice, {
    status: "development-contract",
    valid: true,
    sourceDriftPinValid: true,
    sourceContractDriftPinValid: true,
    developmentExecutable: true,
    executable: true,
    applicationExecutable: false,
    fullApplicationCatalog: false,
    productActivation: false,
    statementCount: PHASE_5_EXPECTED_ORGANIZATION_DEPARTMENTS_STATEMENT_COUNT,
    expectedStatementCount: PHASE_5_EXPECTED_ORGANIZATION_DEPARTMENTS_STATEMENT_COUNT,
    executableStatementCount: PHASE_5_EXPECTED_ORGANIZATION_DEPARTMENTS_STATEMENT_COUNT,
  });
  assert.deepEqual(report.phase5Progress.systemCenterMetricsSlice, {
    status: "development-contract",
    valid: true,
    sourceDriftPinValid: true,
    sourceContractDriftPinValid: true,
    developmentExecutable: true,
    executable: true,
    applicationExecutable: false,
    fullApplicationCatalog: false,
    productActivation: false,
    statementCount: PHASE_5_EXPECTED_SYSTEM_CENTER_METRICS_STATEMENT_COUNT,
    expectedStatementCount: PHASE_5_EXPECTED_SYSTEM_CENTER_METRICS_STATEMENT_COUNT,
    executableStatementCount: PHASE_5_EXPECTED_SYSTEM_CENTER_METRICS_STATEMENT_COUNT,
  });
  assert.deepEqual(report.phase5Progress.salesAnalyticsPersistenceSlice, {
    status: "development-contract",
    valid: true,
    standaloneContract: false,
    sqliteApplicationIntegrated: true,
    sourceCatalogFingerprintValid: true,
    sliceFingerprintValid: true,
    schemaContractValid: true,
    schemaFingerprintValid: true,
    repositoryContractValid: true,
    developmentExecutable: true,
    executable: true,
    applicationExecutable: false,
    fullApplicationCatalog: false,
    productActivation: false,
    statementCount: SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_COUNT,
    expectedStatementCount: SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_COUNT,
    executableStatementCount: SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_COUNT,
    schemaStatementCount: SALES_ANALYTICS_EXPECTED_SCHEMA_STATEMENT_COUNT,
    expectedSchemaStatementCount: SALES_ANALYTICS_EXPECTED_SCHEMA_STATEMENT_COUNT,
    applicationWiringReferences: 37,
  });
  assert.deepEqual(report.phase5Progress.developmentSlices, {
    sliceCount: 5,
    executableStatementCount: PHASE_5_EXPECTED_DEVELOPMENT_SLICE_STATEMENT_COUNT,
    expectedStatementCount: PHASE_5_EXPECTED_DEVELOPMENT_SLICE_STATEMENT_COUNT,
    applicationExecutable: false,
    fullApplicationCatalog: false,
  });
  assert.deepEqual(report.phase5Progress.migrationAdapter, {
    status: "development-contract",
    valid: true,
    sessionAdvisoryLockBeforeSerializableTransaction: true,
    advisoryLockStatementCount: 1,
    serializableTransactionStatementCount: 1,
    advisoryUnlockStatementCount: 1,
    expectedRole: "grabenplaner_audit_role",
    artifactExecution: "adapter-owned-versioned-sql-bundle",
    roleBoundaryEnforced: true,
    ledgerAccessFromArtifacts: "rejected",
    applicationMigrationsImplemented: 0,
    expectedApplicationMigrationCount: 10,
    productActivation: false,
  });
  assert.equal(report.phase5Progress.executableMigrationBindingCount, 0);
  assert.deepEqual(report.phase5Progress.missingFiles, []);
  assert.deepEqual(report.phase5Progress.missingTestFiles, []);
  assert.deepEqual(report.phase5Progress.missingSalesAnalyticsFiles, []);
  assert.deepEqual(report.phase5Progress.missingSalesAnalyticsTestFiles, []);
  assert.deepEqual(report.phase5Progress.moduleErrors, []);
  assert.deepEqual(report.unknownProduction, []);
  assert.deepEqual(report.unknownTests, []);
  assert.deepEqual(report.resolvedProductionFiles, [
    "lib/collective-agreements.js",
    "lib/governance-store.js",
    "lib/system-center-metrics.js",
    "lib/work-rules/custom-rules.js",
    "lib/work-rules/governance.js",
    "lib/work-rules/store.js",
    "server-tools/linux/migrate-grabenplaner-runtime-v4.sh",
    "server-tools/linux/migrate-grabenplaner-runtime-v5.sh",
  ]);
  assert.deepEqual(report.resolvedTestFiles, []);
  assert.deepEqual(report.missingIndirectFiles, []);
  assert.deepEqual(report.missingPhase3Files, []);
  assert.deepEqual(report.missingPhase3TestFiles, []);
  assert.deepEqual(report.productionRegressions, []);
  assert.deepEqual(report.serverRegressions, []);
  assert.deepEqual(report.phaseBoundaryViolations, []);
  assert.deepEqual(report.classificationDuplicates, []);

  assert.ok(report.findings.length > 3_000);
  for (const finding of report.findings) {
    assert.ok(finding.file);
    assert.ok(Number.isInteger(finding.line) && finding.line > 0);
    assert.ok(finding.kind);
    assert.ok(finding.operation);
    assert.notEqual(finding.owner, "unclassified", `${finding.file}:${finding.line}`);
    assert.notEqual(finding.targetLayer, "unclassified", `${finding.file}:${finding.line}`);
  }
});

test("v0.87 Datenbank Block 5: Dokumentation und CI bilden den nicht produktiven Zwischenstand ab", () => {
  const inventory = read("docs/DATENBANK-KOPPLUNGSINVENTAR.md");
  const phase3 = read("docs/DATENBANK-SQLITE-PROVIDER.md");
  const phase4 = read("docs/DATENBANK-DIALEKTE-UND-MIGRATIONEN.md");
  const phase5 = read("docs/DATENBANK-POSTGRESQL-PROVIDER.md");
  const strategy = read("docs/DATENBANK-PROVIDER-STRATEGIE.md");
  const ciWorkflow = read(".github/workflows/ci.yml");
  const packageJson = JSON.parse(read("package.json"));

  assert.match(inventory, /Status:\*\* Block 1\/7 abgeschlossen/);
  assert.match(inventory, /audit-persistence-coupling\.js --check/);
  assert.match(inventory, /Nicht klassifizierte Treffer \| 0/);
  assert.match(inventory, /Windows-Serverwerkzeuge werden vollständig als Betriebszugriffe inventarisiert/);
  assert.match(inventory, /Portable, USB, Lokal- und LAN-Host bleiben dagegen eingefrorenes Legacy/);
  assert.match(inventory, /SQLite backup schema 1|SQLite-Sicherungspunkt|sqlite-backup-v1/i);
  assert.match(inventory, /Block 2 wurde am 29\.07\.2026 separat freigegeben/);
  assert.match(inventory, /Datenbank-Provider-Vertrag/);
  assert.match(inventory, /Block 3 wurde am 29\.07\.2026 separat freigegeben/);
  assert.match(inventory, /unveränderte Phase-1-Ausgangsbasis/);
  assert.match(phase3, /Status:\*\* Block 3\/7 abgeschlossen/);
  assert.match(phase3, /UI-Präferenzen/);
  assert.match(phase3, /lib\/persistence\/sqlite\/provider\.js/);
  assert.match(phase3, /node:sqlite/);
  assert.match(phase3, /Allowlist[\s\S]{0,120}genau\s+einen neuen Providerimport/i);
  assert.match(phase3, /Vollständige SQLite-Parität[\s\S]{0,40}erreicht/i);
  assert.match(phase3, /direkte `db\.prepare`-Aufrufe in `server\.js` \| 0/);
  assert.match(phase3, /direkte `db\.exec`-Aufrufe in `server\.js` \| 0/);
  assert.match(phase3, /lokal mit Node 22\.13\.0/);
  assert.match(phase4, /Status:\*\* Block 4\/7 abgeschlossen/);
  assert.match(phase4, /1348 Statementvertr/);
  assert.match(phase4, /SQLite-Baseline \| 37/);
  assert.match(phase4, /SQLite-Dialektvariante \| 1311/);
  assert.match(phase4, /1238[\s\S]{0,100}Dollar-Parameter/i);
  assert.match(phase4, /`contract-only`/);
  assert.match(phase4, /Implementierungs-Fingerprint/);
  assert.match(phase4, /`mapped-not-ledger-activated`/);
  assert.match(phase4, /`genericAdapterCompatible: false`/);
  assert.match(phase4, /Phase-5-Zwischenstand/);
  assert.match(phase4, /Phase 5[\s\S]{0,80}begonnen[\s\S]{0,80}in Bearbeitung/i);
  assert.match(phase4, /1233 Syntaxkandidaten \(`portable-generated`\)/);
  assert.match(phase4, /115[^\r\n]*`requires-override`/);
  assert.match(
    phase4,
    /PostgreSQL-Anwendungsmigrationsstand bleibt 0\/10[\s\S]{0,80}keine der zehn[\s\S]{0,40}Anwendungsmigrationen ist implementiert/i,
  );
  assert.match(phase5, /nicht produktiven Status/i);
  assert.match(phase5, /`development-contract`/);
  assert.match(phase5, /`fullApplicationCatalog: false`/);
  assert.match(phase5, /Abdeckungen 4\/4, 2\/2, 2\/2 und 1\/1[\s\S]{0,120}0\/1348/);
  assert.match(phase5, /`applicationExecutable: false`/);
  assert.match(phase5, /Produktiver Datenbankpfad:[\s\S]{0,80}ausschließlich SQLite/i);
  assert.match(strategy, /Block 3[\s\S]{0,100}abgeschlossen/i);
  assert.match(strategy, /Block 4[\s\S]{0,100}abgeschlossen/i);
  assert.match(strategy, /Phase 5 ist begonnen und weiterhin in[\s\S]{0,30}Bearbeitung/i);
  assert.match(
    strategy,
    /weder in der Produkt- noch in der[\s\S]{0,100}Serverkonfiguration aktiviert[\s\S]{0,100}ausschließlich auf SQLite/i,
  );
  assert.match(
    strategy,
    /1348 Anwendungsstatements:[\s\S]{0,60}1233[\s\S]{0,100}`portable-generated`[\s\S]{0,60}115[\s\S]{0,100}`requires-override`[\s\S]{0,100}0 von 1348[\s\S]{0,100}Vollanwendungskatalog/i,
  );
  assert.match(
    strategy,
    /PostgreSQL-Migrationsstand bleibt 0\/10[\s\S]{0,60}keine Anwendungsmigration ist[\s\S]{0,30}implementiert/i,
  );
  assert.match(strategy, /Datenbank-Kopplungsinventar/);
  assert.match(ciWorkflow, /sqlite-provider-node-minimum:/);
  assert.match(ciWorkflow, /postgresql-provider-development-contract:/);
  assert.match(
    ciWorkflow,
    /TEST_POSTGRESQL_URL:\s*postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/grabenplaner_test/,
  );
  assert.match(ciWorkflow, /node-version:\s*22\.13\.0/);
  assert.match(ciWorkflow, /test\/v087-persistence-provider-contract\.test\.js/);
  assert.match(ciWorkflow, /test\/v087-sqlite-persistence-provider\.test\.js/);
  for (const testFile of [
    "application-migrations",
    "dialect-contract",
    "migration-contract",
    "sqlite-migration-runner",
    "statement-dialects",
  ]) {
    assert.match(
      ciWorkflow,
      new RegExp(`test/v087-database-block4-${testFile}\\.test\\.js`),
      testFile,
    );
  }
  for (const testFile of [
    "provider",
    "pool-policy",
    "dialect-compiler",
    "application-dialect-plan",
    "catalog-contract",
    "ui-preferences",
    "planning-settings",
    "organization-departments",
    "system-center-metrics",
    "migration-adapter",
    "live",
  ]) {
    assert.match(
      ciWorkflow,
      new RegExp(`test/v087-database-block5-postgresql-${testFile}\\.test\\.js`),
      testFile,
    );
  }

  assert.equal(packageJson.dependencies?.pg, "8.22.0");
  for (const dependencyGroup of [
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    assert.equal(
      Object.hasOwn(packageJson[dependencyGroup] || {}, "pg"),
      false,
      `${dependencyGroup}:pg`,
    );
  }
  for (const dependency of ["postgres", "postgresql", "knex", "sequelize", "typeorm", "prisma", "@prisma/client"]) {
    for (const dependencyGroup of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      assert.equal(
        Object.hasOwn(packageJson[dependencyGroup] || {}, dependency),
        false,
        `${dependencyGroup}:${dependency}`,
      );
    }
  }
});
