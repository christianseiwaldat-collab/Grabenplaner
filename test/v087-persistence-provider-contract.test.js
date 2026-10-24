"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceStatement,
  definePersistenceStatement,
  normalizePersistenceValue,
} = require("../lib/persistence/contract");
const {
  redactPersistenceConfiguration,
  resolvePersistenceConfiguration,
} = require("../lib/persistence/configuration");
const {
  PHASE_3_SQLITE_PROVIDER_FILES,
  PHASE_3_SQLITE_PROVIDER_TEST_FILES,
  PHASE_3_SQLITE_RAW_ACCESS_FILES,
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
  scanRepository,
} = require("../scripts/audit-persistence-coupling");
const {
  createContractTestSubject,
} = require("../test-support/persistence-contract-adapter");
const {
  definePersistenceProviderContractTests,
} = require("../test-support/persistence-provider-contract");

const root = path.resolve(__dirname, "..");

test("Paired-backup file verifier registration grants no driver, facade, statements or runtime configuration", () => {
  const file = "lib/persistence/postgresql/operations/protected-files.js";
  for (const fixture of ["test-support/postgresql-api/backup-pools.js", "test/postgresql-backup-protected-files.test.js"]) {
    assert.equal(PHASE_3_SQLITE_PROVIDER_TEST_FILES.filter(name => name === fixture).length, 1, fixture);
  }
  for (const candidate of [file, "lib/persistence/postgresql/operations/other-protected-files.js"]) {
    for (const [source, kind] of [
      ['require("pg");', "postgresql-driver-import"],
      ['require("node:sqlite");', "sqlite-driver-import-outside-boundary"],
      ["createPersistenceProviderFacade(adapter);", "provider-facade-outside-boundary"],
      ["definePersistenceStatement({});", "provider-statement-outside-boundary"],
      ["process.env.DB_PROVIDER;", "provider-runtime-config-outside-boundary"],
    ]) assert.ok(architectureBoundaryViolationsForText(candidate, source).some(row => row.kind === kind), `${candidate}: ${kind}`);
  }
});

definePersistenceProviderContractTests({
  name: "v0.87 Datenbank Block 2",
  createSubject: createContractTestSubject,
});

test("v0.87 Datenbank Block 4: nur definierte Statementverträge bestehen die synchrone Brand-Prüfung", () => {
  const statement = definePersistenceStatement({
    id: "dialect-contract.brand-probe",
    operation: "queryOne",
    parameters: { id: "text" },
    columns: { value: "text" },
  });
  const forged = Object.freeze({
    id: statement.id,
    operation: statement.operation,
    parameters: statement.parameters,
    columns: statement.columns,
  });

  assert.equal(assertPersistenceStatement(statement), statement);
  assert.throws(
    () => assertPersistenceStatement(forged),
    (error) => error?.code === PERSISTENCE_ERROR_CODES.STATEMENT_INVALID,
  );
  assert.throws(
    () => assertPersistenceStatement(null),
    (error) => error?.code === PERSISTENCE_ERROR_CODES.STATEMENT_INVALID,
  );
});

test("PostgreSQL-only: former SQLite defaults and paths cannot create an unconfigured server", () => {
  for (const providerValue of [undefined, null, "", "   ", "postgresql", "PostgreSQL", " POSTGRESQL "]) {
    const environment = { DB_PROVIDER: providerValue, DB_PATH: "data/old.db" };
    assert.throws(() => resolvePersistenceConfiguration({ environment, defaultSqlitePath: "unused.db" }), error => {
      assert.equal(error.code, PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID);
      assert.equal(error.messageKey, "postgresql-configuration-required");
      return true;
    });
  }
  for (const providerValue of ["sqlite", "SQLite", " SQLITE "]) {
    assert.throws(() => resolvePersistenceConfiguration({environment:{DB_PROVIDER:providerValue, DB_PATH:":memory:"}}),
      error => error.code === PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID && error.messageKey === "provider-id-invalid");
  }
});

test("v0.87 Datenbank Block 2: Wert- und Fehlerregeln sind verlustfrei und stabil", async () => {
  assert.equal(
    normalizePersistenceValue(9007199254740993n, { kind: "bigint_string", nullable: false }),
    "9007199254740993",
  );
  assert.equal(
    normalizePersistenceValue(new Date("2026-07-29T10:00:00.000Z"), {
      kind: "utc_timestamp",
      nullable: false,
    }),
    "2026-07-29T10:00:00.000Z",
  );
  const source = Buffer.from([7, 8, 9]);
  const copied = normalizePersistenceValue(source, { kind: "bytes", nullable: false });
  assert.deepEqual(copied, source);
  assert.notEqual(copied, source);
  const json = normalizePersistenceValue({ nested: [true, null, 3] }, {
    kind: "json",
    nullable: false,
  });
  assert.equal(Object.isFrozen(json), true);
  assert.equal(Object.isFrozen(json.nested), true);
  const specialJson = normalizePersistenceValue(
    JSON.parse('{"__proto__":{"polluted":true}}'),
    { kind: "json", nullable: false },
  );
  assert.equal(Object.hasOwn(specialJson, "__proto__"), true);
  assert.equal(Object.prototype.polluted, undefined);
  const normalizedSecretError = new PersistenceError(PERSISTENCE_ERROR_CODES.UNKNOWN, {
    publicMessage: "SEHR-GEHEIM",
    cause: Object.assign(new Error("SEHR-GEHEIM"), {
      name: "SEHRGEHEIM",
      code: "SEHRGEHEIM",
    }),
  });
  assert.equal(JSON.stringify(normalizedSecretError).includes("SEHRGEHEIM"), false);
  assert.equal(String(normalizedSecretError.message).includes("SEHR-GEHEIM"), false);

  for (const [value, definition] of [
    [Number.MAX_SAFE_INTEGER + 1, { kind: "safe_integer", nullable: false }],
    [Number.NaN, { kind: "safe_integer", nullable: false }],
    [new Date("invalid"), { kind: "utc_timestamp", nullable: false }],
    ["2026-02-30", { kind: "date", nullable: false }],
    [[, "Lücke"], { kind: "json", nullable: false }],
    [undefined, { kind: "text", nullable: true }],
    [null, { kind: "text", nullable: false }],
  ]) {
    assert.throws(
      () => normalizePersistenceValue(value, definition),
      (error) => error?.code === PERSISTENCE_ERROR_CODES.RESULT_INVALID,
    );
  }
  assert.equal(normalizePersistenceValue(null, { kind: "text", nullable: true }), null);

  const subject = createContractTestSubject();
  assert.throws(
    () => normalizePersistenceValue(
      { invalid: undefined },
      { kind: "json", nullable: false },
      { invalidCode: PERSISTENCE_ERROR_CODES.STATEMENT_INVALID },
    ),
    (error) => error?.code === PERSISTENCE_ERROR_CODES.STATEMENT_INVALID,
  );
  await assert.rejects(
    subject.provider.queryOne(subject.statements.jsonParameter, {
      value: { invalid: undefined },
    }),
    (error) => error?.code === PERSISTENCE_ERROR_CODES.STATEMENT_INVALID,
  );

  const retryable = new Set([
    PERSISTENCE_ERROR_CODES.BUSY,
    PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION,
  ]);
  for (const code of Object.values(PERSISTENCE_ERROR_CODES)) {
    const error = new PersistenceError(code, {
      cause: Object.assign(new Error("SEHR-GEHEIM"), {
        name: "SEHRGEHEIM",
        code: "SEHRGEHEIM",
      }),
    });
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable.has(code));
    assert.equal(JSON.stringify(error).includes("SEHRGEHEIM"), false);
    assert.equal(JSON.stringify(error.cause || {}).includes("SEHRGEHEIM"), false);
  }
  await subject.provider.close();
});

test("PostgreSQL-only: arbitrary URLs and rehearsal flags fail closed without leaking secrets", () => {
  for (const value of ["pg", "postgres", "sqlite3", "mysql", "postgrsql", "sqlite"]) {
    assert.throws(() => resolvePersistenceConfiguration({environment:{DB_PROVIDER:value}}), error => error.code === PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID);
  }
  for (const environment of [
    {}, {DATABASE_URL:"postgresql://admin:PRIVATE-SYNTHETIC@db.example/app"},
    {DB_PATH:":memory:"}, {DB_PATH:"legacy.db"},
    {DB_PROVIDER:"postgresql",NODE_ENV:"production",GRABENPLANER_POSTGRESQL_REHEARSAL:"application-11"},
  ]) assert.throws(() => resolvePersistenceConfiguration({environment}), error => {
    assert.equal(error.code,PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID);
    assert.equal(JSON.stringify(error).includes("PRIVATE-SYNTHETIC"),false);
    assert.equal(String(error.message).includes("PRIVATE-SYNTHETIC"),false);
    return true;
  });
  assert.deepEqual(redactPersistenceConfiguration({providerId:"postgresql",databasePath:"PRIVATE-SYNTHETIC",databaseUrlConfigured:true,coreUrl:"PRIVATE-SYNTHETIC"}),
    {providerId:"postgresql",databasePath:"",databaseUrlConfigured:true});
  assert.deepEqual(redactPersistenceConfiguration({providerId:"sqlite",databasePath:"PRIVATE-SYNTHETIC"}),
    {providerId:"unknown",databasePath:"",databaseUrlConfigured:false});
});

test("PostgreSQL-only: configuration validation precedes filesystem writes, singleton lock and pair opening", () => {
  const server = fs.readFileSync(path.join(root,"server.js"),"utf8");
  const configurationCall=server.indexOf("resolvePersistenceConfiguration({"),runtimeValidation=server.indexOf("assertRuntimeConfiguration(runtimeConfiguration)"),
    lockPath=server.indexOf("const instanceLockPath = lockPathForDatabase(databasePath)"),firstDirectoryWrite=server.indexOf("fs.mkdirSync("),
    lockAcquire=server.indexOf("acquireInstanceLock();"),driverOpen=server.indexOf("openDeferredPostgresqlApplication({");
  assert.ok(configurationCall>0 && configurationCall<runtimeValidation);
  assert.ok(runtimeValidation<lockPath && lockPath<firstDirectoryWrite);
  assert.ok(firstDirectoryWrite<lockAcquire && lockAcquire<driverOpen);
  assert.doesNotMatch(server,/node:sqlite|DatabaseSync|openSqlite|persistence\/sqlite/);
  assert.equal(server.includes("process.env.DB_PROVIDER"),false);
  assert.equal(server.includes("process.env.DATABASE_URL"),false);
});

test("v0.87 Datenbank Block 5: Architekturprüfung erlaubt nur die benannten Provider-Slices", () => {
  assert.deepEqual(
    architectureBoundaryViolationsForText(
      "lib/persistence/contract.js",
      "function createPersistenceProviderFacade() {}",
    ),
    [],
  );
  assert.deepEqual(
    architectureBoundaryViolationsForText(
      "lib/persistence/configuration.js",
      "const provider = environment.DB_PROVIDER; const configured = environment.DATABASE_URL;",
    ),
    [],
  );
  assert.deepEqual(
    architectureBoundaryViolationsForText(
      "lib/errors.js",
      "const safeMessage = 'DB_PROVIDER und DATABASE_URL werden nicht protokolliert';",
    ),
    [],
  );
  assert.deepEqual(
    architectureBoundaryViolationsForText(
      "lib/persistence/sqlite/provider.js",
      "const sqlite = require('node:" + "sqlite'); const provider = createPersistenceProviderFacade(adapter);",
    ),
    [],
  );
  assert.deepEqual(
    architectureBoundaryViolationsForText(
      "lib/persistence/statements/ui-preferences.js",
      "const statement = definePersistenceStatement({});",
    ),
    [],
  );
  assert.deepEqual(
    architectureBoundaryViolationsForText(
      "lib/persistence/postgresql/pool.js",
      'const { Pool } = require("pg"); function openPostgresqlDevelopmentPersistence() {}',
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

  for (const [file, source, expectedKind] of [
    ["lib/personnel.js", "const provider = createPersistenceProviderFacade(adapter);", "provider-facade-outside-boundary"],
    ["lib/personnel.js", "const statement = definePersistenceStatement({});", "provider-statement-outside-boundary"],
    ["lib/personnel.js", "const sqlite = require('node:" + "sqlite');", "sqlite-driver-import-outside-boundary"],
    ["lib/personnel.js", "const sqlite = require /* erlaubt, aber verboten */ ('node:" + "sqlite');", "sqlite-driver-import-outside-boundary"],
    ["lib/personnel.mjs", "import { DatabaseSync } from 'node:" + "sqlite';", "sqlite-driver-import-outside-boundary"],
    ["lib/personnel.cjs", "const sqlite = await import('node:" + "sqlite');", "sqlite-driver-import-outside-boundary"],
    ["lib/personnel.cjs", "const sqlite = await import(`node:" + "sqlite`);", "sqlite-driver-import-outside-boundary"],
    ["lib/personnel.mjs", "export { DatabaseSync } from 'node:" + "sqlite';", "sqlite-driver-import-outside-boundary"],
    [
      "lib/personnel.js",
      "spawnSync(process.execPath, [\"--no-warnings\", /* eval */ \"-e\", `require(\"node:" + "sqlite\")`]);",
      "sqlite-driver-import-outside-boundary",
    ],
    [
      "lib/personnel.js",
      "const script = `require(\"node:" + "sqlite\")`; spawnSync(process.execPath, [\"-e\", script]);",
      "sqlite-driver-import-outside-boundary",
    ],
    [
      "lib/personnel.js",
      "spawnSync(process.execPath, [\"-e\", \"require(\\\"node:" + "sqlite\\\")\"]);",
      "sqlite-driver-import-outside-boundary",
    ],
    [
      "lib/personnel.js",
      "execSync(`node -e 'require(\"node:" + "sqlite\")'`);",
      "sqlite-driver-import-outside-boundary",
    ],
    [
      "lib/personnel.js",
      "const text = `${require(\"node:" + "sqlite\")}`;",
      "sqlite-driver-import-outside-boundary",
    ],
    ["server.js", "const configured = process.env.DB_PROVIDER;", "provider-runtime-config-outside-boundary"],
    ["server.js", "const { DB_PROVIDER } = process.env;", "provider-runtime-config-outside-boundary"],
    ["server.js", "const env = process.env; const configured = env.DB_PROVIDER;", "provider-runtime-config-outside-boundary"],
    ["server.js", "const configured = process.env['DB_PROVIDER'];", "provider-runtime-config-outside-boundary"],
    ["public/app.js", "const url = process.env.DATABASE_URL;", "postgresql-secret-outside-boundary"],
    ["lib/persistence/contract.js", "const pg = require('pg');", "postgresql-driver-import"],
    ["lib/persistence/contract.js", "const pg = require('pg/lib/client');", "postgresql-driver-import"],
    ["lib/persistence/contract.js", "const pgp = require('pg-promise');", "postgresql-driver-import"],
    ["lib/persistence/contract.js", "const neon = require('@neondatabase/serverless');", "postgresql-driver-import"],
    ["server.js", "const contract = require('./lib/persistence/contract');", "provider-contract-runtime-import"],
  ]) {
    const violations = architectureBoundaryViolationsForText(file, source);
    assert.equal(violations.some((entry) => entry.kind === expectedKind), true, `${file}: ${expectedKind}`);
  }
  for (const source of [
    "// Beispiel: require('node:" + "sqlite')",
    "const text = \"import('node:" + "sqlite')\";",
    "const pattern = /require\\(\"node:" + "sqlite\"\\)/;",
    "const text = `Beispiel require(\"node:" + "sqlite\") ${value}`;",
  ]) {
    assert.deepEqual(
      architectureBoundaryViolationsForText("lib/personnel.js", source),
      [],
    );
  }
  assert.equal(
    architectureBoundaryViolationsForText(
      "scripts/example.sh",
      "node - <<'NODE'\nconst sqlite = require // Kommentar\n(\"node:" + "sqlite\");\nNODE",
    ).some((entry) => entry.kind === "sqlite-driver-import-outside-boundary"),
    true,
  );
  assert.deepEqual(
    architectureBoundaryViolationsForText(
      "scripts/example.sh",
      "# example: require(\"node:" + "sqlite\")\nprintf '%s\\n' ok",
    ),
    [],
  );
  assert.deepEqual(
    architectureBoundaryViolationsForText(
      "scripts/example.sh",
      "echo 'require(\"node:" + "sqlite\")'",
    ),
    [],
  );

  const report = scanRepository(root);
  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.equal(report.summary.phase2ContractFiles, 3);
  assert.equal(report.summary.phase2ContractTestFiles, 3);
  assert.equal(report.summary.phase3SqliteProviderFiles, PHASE_3_SQLITE_PROVIDER_FILES.length);
  assert.equal(report.summary.phase3SqliteProviderTestFiles, PHASE_3_SQLITE_PROVIDER_TEST_FILES.length);
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
    "lib/persistence/catalogs/sales-analytics-catalog.js",
    "lib/persistence/statements/sales-analytics.js",
  ]);
  assert.deepEqual(SALES_ANALYTICS_PERSISTENCE_SLICE_TEST_FILES, [
    "test/sales-analytics-persistence-foundation.test.js",
    "test/sales-analytics-production-hardening.test.js",
    "test/sales-analytics-tradefoto-report.test.js",
  ]);
  assert.deepEqual(report.phase3Progress.completedSlices, ["all-runtime-domains"]);
  assert.equal(report.phase3Progress.uiPreferencesRepositoryWiringComplete, true);
  assert.equal(report.phase3Progress.uiPreferencesRoutesAwaited, true);
  assert.equal(report.phase3Progress.status, "completed");
  assert.equal(report.phase3Progress.remainingDomainRawAccess, 0);
  assert.equal(report.phase3Progress.fullSqliteParity, true);
  assert.equal(report.phase4Progress.status, "completed");
  assert.equal(report.phase4Progress.complete, true);
  assert.equal(report.phase4Progress.executablePostgresqlRuntimeArtifacts, 0);
  assert.equal(report.phase5Progress.status, "in-progress");
  assert.equal(report.phase5Progress.providerSliceStatus, "completed");
  assert.equal(report.phase5Progress.providerSliceComplete, true);
  assert.equal(report.phase5Progress.productionActivation, false);
  assert.equal(report.phase5Progress.configurationStillClosed, true);
  assert.ok(report.phase5Progress.serverActivationReferences > 0);
  assert.equal(report.phase5Progress.rehearsalGuardClosed, true);
  assert.equal(report.phase5Progress.driverDependency, "8.22.0");
  assert.equal(
    report.phase5Progress.compilerVersion,
    PHASE_5_EXPECTED_COMPILER_VERSION,
  );
  assert.equal(report.phase5Progress.dialectPlanStatementCount, 1507);
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
  assert.equal(report.phase5Progress.executableMigrationBindingCount, 0);
  assert.deepEqual(report.phase5Progress.catalogContract, {
    valid: true,
    executableSlice: false,
    applicationExecutable: false,
    fullApplicationCatalog: false,
    acceptanceStatus: "closed",
    requiredReceiptCount: 1507,
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
  assert.deepEqual(report.phase5Progress.missingFiles, []);
  assert.deepEqual(report.phase5Progress.missingTestFiles, []);
  assert.deepEqual(report.phase5Progress.missingSalesAnalyticsFiles, []);
  assert.deepEqual(report.phase5Progress.missingSalesAnalyticsTestFiles, []);
  assert.deepEqual(report.phase5Progress.moduleErrors, []);
  assert.deepEqual(report.phaseBoundaryViolations, []);
  assert.deepEqual(report.unknownProduction, []);
  assert.deepEqual(report.unknownTests, []);
});

test("CRM, article and statistics registration grants no additional provider capabilities", () => {
  const modules = [
    "lib/persistence/postgresql/sales/import-source-tolerance-catalog.js",
    "lib/persistence/postgresql/core/import-master-customer-reference.js",
    "lib/persistence/postgresql/sales/cash-customer-search.js",
    "lib/persistence/postgresql/operations/sql-runtime-statistics.js",
  ];
  for (const file of modules) {
    assert.deepEqual(architectureBoundaryViolationsForText(file, fs.readFileSync(path.join(root, file), "utf8")), [], file);
  }
  for (const file of [...modules, ...modules.map(file => file.replace(/\.js$/, "-other.js")),
    "test/cash-customer-search-sql.test.js", "test/import-master-customer-reference.test.js",
    "test/postgresql-article-search-optimization.test.js"]) {
    for (const [source, kind] of [
      ["const driver = require('node:" + "sqlite');", "sqlite-driver-import-outside-boundary"],
      ["const driver = require('pg');", "postgresql-driver-import"],
      ["const provider = createPersistenceProviderFacade(adapter);", "provider-facade-outside-boundary"],
      ["const statement = definePersistenceStatement({});", "provider-statement-outside-boundary"],
      ["const config = process.env.DB_PROVIDER;", "provider-runtime-config-outside-boundary"],
    ]) assert.equal(architectureBoundaryViolationsForText(file, source).some(entry => entry.kind === kind), true, `${file}: ${kind}`);
  }
});

test("The two derived catalog JSON contracts admit neither adjacent executable privileges nor a third JSON artifact", () => {
  const qualified = [
    "lib/persistence/postgresql/contracts/onboarding-receipt-projection-catalog-v1.json",
    "lib/persistence/postgresql/contracts/payroll-handoff-department-catalog-v1.json",
  ];
  // JSON is data, so JavaScript capability checks apply to the corresponding
  // executable neighbours, which must remain outside the exact registration.
  for (const file of qualified.map(file => file.replace(/\.json$/, ".js"))) {
    for (const [source, kind] of [
      ["const driver = require('pg');", "postgresql-driver-import"],
      ["const driver = require('node:" + "sqlite');", "sqlite-driver-import-outside-boundary"],
      ["const statement = definePersistenceStatement({});", "provider-statement-outside-boundary"],
      ["const config = process.env.DB_PROVIDER;", "provider-runtime-config-outside-boundary"],
    ]) assert.equal(architectureBoundaryViolationsForText(file, source).some(entry => entry.kind === kind), true, `${file}: ${kind}`);
  }

  // Give the real repository scanner one extra read-only virtual file. No
  // checkout file, global fs method, module cache or migration lock is changed.
  const unknown = "lib/persistence/postgresql/contracts/unqualified-third-derived-catalog-v1.json";
  const unknownAbsolute = path.join(root, unknown);
  const contractsDirectory = path.dirname(unknownAbsolute);
  const unknownContents = Buffer.from(JSON.stringify({
    ...JSON.parse(fs.readFileSync(path.join(root, qualified[0]), "utf8")),
    scope: "unqualified-third-derived-application-extension",
  }));
  const auditFile = path.join(root, "scripts/audit-persistence-coupling.js");
  const { Module } = require("node:module");
  const subject = new Module(auditFile, module);
  subject.filename = auditFile;
  subject.paths = Module._nodeModulePaths(path.dirname(auditFile));
  const realRequire = subject.require.bind(subject);
  const samePath = (value, expected) => path.resolve(String(value)) === expected;
  const virtualFs = Object.create(fs);
  virtualFs.existsSync = value => samePath(value, unknownAbsolute) || fs.existsSync(value);
  virtualFs.statSync = (value, ...args) => samePath(value, unknownAbsolute)
    ? { isFile: () => true }
    : fs.statSync(value, ...args);
  virtualFs.readdirSync = (value, options) => {
    const entries = fs.readdirSync(value, options);
    if (!samePath(value, contractsDirectory)) return entries;
    assert.equal(options?.withFileTypes, true);
    return [...entries, { name: path.basename(unknown), isDirectory: () => false }];
  };
  virtualFs.readFileSync = (value, options) => {
    if (!samePath(value, unknownAbsolute)) return fs.readFileSync(value, options);
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? unknownContents.toString(encoding) : Buffer.from(unknownContents);
  };
  subject.require = id => id === "node:fs" ? virtualFs : realRequire(id);
  subject._compile(fs.readFileSync(auditFile, "utf8"), auditFile);
  const rejected = subject.exports.scanRepository(root);
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.phase4Progress.postgresqlRuntimeArtifacts, [`file:${unknown}`]);
  assert.ok(rejected.errors.some(error => error.includes(`file:${unknown}`)));
  for (const file of qualified) {
    assert.equal(rejected.phase4Progress.postgresqlRuntimeArtifacts.includes(`file:${file}`), false);
  }
  assert.equal(fs.existsSync(unknownAbsolute), false);
});

test("Provider-Dokumentation schützt den Installationsstandard; Treiberabhängigkeiten bleiben begrenzt", () => {
  const operations = fs.readFileSync(path.join(root, "SERVERBETRIEB.md"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  assert.match(operations, /PostgreSQL ist die einzige unterstützte Betriebsdatenbank/);
  assert.doesNotMatch(operations, /SQLite bleibt der Installationsstandard/);
  assert.match(operations, /Eine alleinige Änderung von `DB_PROVIDER` aktiviert keine Migration/);
  assert.match(operations, /keinen automatischen Rückfall auf SQLite/);
  assert.equal(packageJson.dependencies?.pg, "8.22.0");
  assert.equal(Object.hasOwn(packageJson.devDependencies || {}, "pg"), false);
  assert.equal(Object.hasOwn(packageJson.optionalDependencies || {}, "pg"), false);
  assert.equal(Object.hasOwn(packageJson.peerDependencies || {}, "pg"), false);
  for (const dependency of ["postgres", "postgresql", "knex", "sequelize", "typeorm", "prisma", "@prisma/client"]) {
    assert.equal(Object.hasOwn(packageJson.dependencies || {}, dependency), false);
    assert.equal(Object.hasOwn(packageJson.devDependencies || {}, dependency), false);
    assert.equal(Object.hasOwn(packageJson.optionalDependencies || {}, dependency), false);
    assert.equal(Object.hasOwn(packageJson.peerDependencies || {}, dependency), false);
  }
});

test("School migration inventory permits only the named CLI driver and keeps domain modules provider-neutral", () => {
  const migrationCli = "server-tools/linux/lib/vocational-school-migrate.js";
  const migrationCore = "lib/persistence/postgresql/core/vocational-school.js";
  const domainGuard = "lib/work-rules/vocational-school-mutation-guard.js";
  for (const file of [migrationCli, migrationCore, domainGuard]) {
    assert.deepEqual(architectureBoundaryViolationsForText(file, fs.readFileSync(path.join(root, file), "utf8")), [], file);
    assert.equal(architectureBoundaryViolationsForText(file, "const driver = require('node:" + "sqlite');")
      .some(entry => entry.kind === "sqlite-driver-import-outside-boundary"), true, file);
  }
  for (const file of [
    migrationCli,
    migrationCore,
    domainGuard,
    "server-tools/linux/lib/vocational-school-other-migrate.js",
    "lib/persistence/postgresql/core/vocational-school-other.js",
  ]) {
    assert.equal(architectureBoundaryViolationsForText(file, "const driver = require('pg');")
      .some(entry => entry.kind === "postgresql-driver-import"), file !== migrationCli, file);
  }
  for (const file of ["test/youth-profile-integration.test.js", "test/vocational-school-mutation-guard.test.js"]) {
    assert.equal(PHASE_3_SQLITE_PROVIDER_TEST_FILES.filter(entry => entry === file).length, 1, file);
  }
});

test("Session migration inventory permits only its named CLI driver", () => {
  const cli = "server-tools/linux/lib/session-security-migrate.js";
  const files = [cli, "lib/persistence/postgresql/core/session-security.js", "lib/persistence/postgresql/core/session-security-catalog.js", "lib/portal-session-security.js"];
  for (const file of files) {
    assert.deepEqual(architectureBoundaryViolationsForText(file, fs.readFileSync(path.join(root, file), "utf8")), [], file);
    assert.equal(architectureBoundaryViolationsForText(file, "const driver = require('node:" + "sqlite');")
      .some(entry => entry.kind === "sqlite-driver-import-outside-boundary"), true, file);
  }
  for (const file of [...files, "server-tools/linux/lib/session-security-other-migrate.js"]) {
    assert.equal(architectureBoundaryViolationsForText(file, "const driver = require('pg');")
      .some(entry => entry.kind === "postgresql-driver-import"), file !== cli, file);
  }
});

test("Planning protection qualifies only its synthetic integration tests and grants no domain drivers", () => {
  for (const file of ["test/maternity-protection-integration.test.js", "test/planning-protection-mutation.test.js"]) {
    assert.ok(PHASE_3_SQLITE_PROVIDER_TEST_FILES.includes(file), file);
  }
  for (const file of ["test/maternity-protection-other-integration.test.js", "test/planning-protection-other-mutation.test.js"]) {
    assert.equal(PHASE_3_SQLITE_PROVIDER_TEST_FILES.includes(file), false, file);
  }
  for (const file of ["lib/personnel-protection-status.js", "lib/work-rules/planning-protection.js", "lib/work-rules/planning-protection-mutation.js"]) {
    for (const text of ["const db = require('node:" + "sqlite');", "const db = await import('node:" + "sqlite');",
      "const db = require('pg');", "const db = await import('pg');"]) {
      const kind = text.includes("sqlite") ? "sqlite-driver-import-outside-boundary" : "postgresql-driver-import";
      assert.equal(architectureBoundaryViolationsForText(file, text).some(entry => entry.kind === kind), true, `${file}: ${text}`);
    }
  }
});

test("Article tools classify exact persistence modules without granting drivers or unrelated statement declarations", () => {
  const namedSlices = [
    "lib/persistence/repositories/sales-article-local-notes.js",
    "lib/sales-article-sales-statements.js",
    "lib/sales-article-sales-catalog.js",
    "lib/sales-article-sales-identity.js",
    "lib/sales-article-sales.js",
    "lib/sales-article-sales-routes.js",
    "lib/sales-price-label-template-store.js",
  ];
  for (const file of namedSlices) {
    assert.equal(PHASE_3_SQLITE_PROVIDER_FILES.filter(entry => entry === file).length, 1, file);
    assert.deepEqual(architectureBoundaryViolationsForText(file, fs.readFileSync(path.join(root, file), "utf8")), [], file);
    assert.equal(architectureBoundaryViolationsForText(file, "const driver = require('node:" + "sqlite');")
      .some(entry => entry.kind === "sqlite-driver-import-outside-boundary"), true, file);
    assert.equal(architectureBoundaryViolationsForText(file, "const driver = require('pg');")
      .some(entry => entry.kind === "postgresql-driver-import"), true, file);
    assert.equal(architectureBoundaryViolationsForText(file, "const provider = createPersistenceProviderFacade(adapter);")
      .some(entry => entry.kind === "provider-facade-outside-boundary"), true, file);
    assert.equal(architectureBoundaryViolationsForText(file, "const statement = definePersistenceStatement({});")
      .some(entry => entry.kind === "provider-statement-outside-boundary"),
    file !== "lib/sales-article-sales-statements.js", file);
  }
  for (const file of ["lib/sales-article-sales-other-statements.js", "lib/sales-price-label-other-store.js"]) {
    const source = "const contract = require('./persistence/contract'); const statement = definePersistenceStatement({});";
    const violations = architectureBoundaryViolationsForText(file, source);
    assert.equal(violations.some(entry => entry.kind === "provider-contract-runtime-import"), true, file);
    assert.equal(violations.some(entry => entry.kind === "provider-statement-outside-boundary"), true, file);
  }
  for (const file of [
    "test/sales-article-local-notes.test.js",
    "test/sales-article-catalog-local-route.test.js",
    "test/sales-article-sales.test.js",
    "test/sales-price-label-template-store.test.js",
    "test/sales-price-labels-server-access.test.js",
    "test/trade-movements.test.js",
  ]) assert.equal(PHASE_3_SQLITE_PROVIDER_TEST_FILES.filter(entry => entry === file).length, 1, file);
  const localRouteFixture = "test/sales-article-catalog-local-route.test.js";
  assert.deepEqual(architectureBoundaryViolationsForText(localRouteFixture,
    fs.readFileSync(path.join(root, localRouteFixture), "utf8")), []);
  for (const [source, kind] of [
    ["const driver = require('node:" + "sqlite');", "sqlite-driver-import-outside-boundary"],
    ["const driver = require('pg');", "postgresql-driver-import"],
    ["const statement = definePersistenceStatement({});", "provider-statement-outside-boundary"],
  ]) assert.equal(architectureBoundaryViolationsForText(localRouteFixture, source).some(entry => entry.kind === kind), true, kind);
  assert.equal(PHASE_3_SQLITE_PROVIDER_TEST_FILES.includes("test/sales-article-catalog-other-local-route.test.js"), false);
  assert.equal(PHASE_3_SQLITE_PROVIDER_FILES.includes("lib/sales-article-search-window-preferences.js"), false,
    "The pure preference normalizer needs no production persistence exception");
});

test("Article report membership grants only its exact read-only statement declaration", () => {
  const file = "lib/sales-article-report-statements.js";
  assert.equal(PHASE_3_SQLITE_PROVIDER_FILES.filter(entry => entry === file).length, 1);
  assert.equal(PHASE_3_SQLITE_RAW_ACCESS_FILES.includes(file), false);
  assert.deepEqual(architectureBoundaryViolationsForText(file, fs.readFileSync(path.join(root, file), "utf8")), []);
  assert.equal(architectureBoundaryViolationsForText(file, "const statement = definePersistenceStatement({});")
    .some(entry => entry.kind === "provider-statement-outside-boundary"), false);
  for (const target of [file, "lib/sales-article-report-other-statements.js", "lib/sales-article-report-data.js", "lib/sales-article-report-routes.js"]) {
    for (const [source, kind] of [
      ["const driver = require('node:" + "sqlite');", "sqlite-driver-import-outside-boundary"],
      ["const driver = require('pg');", "postgresql-driver-import"],
      ["const provider = createPersistenceProviderFacade(adapter);", "provider-facade-outside-boundary"],
      ["const configured = process.env.DB_PROVIDER;", "provider-runtime-config-outside-boundary"],
    ]) assert.equal(architectureBoundaryViolationsForText(target, source).some(entry => entry.kind === kind), true, `${target}: ${kind}`);
    if (target !== file) assert.equal(architectureBoundaryViolationsForText(target, "const statement = definePersistenceStatement({});")
      .some(entry => entry.kind === "provider-statement-outside-boundary"), true);
  }
});

test("Simulation registration permits only its named epoch and scoped CAS statements without raw access", () => {
  const file = "lib/sales-bwl-simulation-statements.js";
  assert.equal(PHASE_3_SQLITE_PROVIDER_FILES.filter(entry => entry === file).length, 1);
  assert.equal(PHASE_3_SQLITE_RAW_ACCESS_FILES.includes(file), false);
  assert.deepEqual(architectureBoundaryViolationsForText(file, fs.readFileSync(path.join(root, file), "utf8")), []);
  const statements = require('../lib/sales-bwl-simulation-statements');
  assert.equal(statements.catalogEpoch.operation, 'queryOne'); assert.equal(statements.remove.operation, 'execute');
  for (const target of [file, 'lib/sales-bwl-simulation-data.js', 'lib/sales-bwl-simulation-variants-store.js', 'lib/sales-bwl-simulation-routes.js']) {
    for (const [source, kind] of [["const driver = require('node:" + "sqlite');", 'sqlite-driver-import-outside-boundary'], ["const driver = require('pg');", 'postgresql-driver-import'],
      ['const provider = createPersistenceProviderFacade(adapter);', 'provider-facade-outside-boundary'], ['const configured = process.env.DB_PROVIDER;', 'provider-runtime-config-outside-boundary']]) {
      assert.equal(architectureBoundaryViolationsForText(target, source).some(entry => entry.kind === kind), true);
    }
    if (target !== file) assert.equal(architectureBoundaryViolationsForText(target, 'const statement = definePersistenceStatement({});').some(entry => entry.kind === 'provider-statement-outside-boundary'), true);
  }
});

test("Encrypted window and price-label workspace registration grants no drivers, raw SQL, facade or statements", () => {
  const modules = [
    "lib/sales-price-label-template-store.js",
    "lib/sales-price-label-image-store.js",
    "lib/sales-price-label-draft-store.js",
    "lib/sales-price-label-project-store.js",
    "lib/branch-window-preferences-store.js",
    "lib/branch-window-preferences-routes.js",
  ];
  const fixtures = [
    "test/sales-price-label-draft-store.test.js",
    "test/sales-price-label-project.test.js",
    "test/branch-window-preferences-store.test.js",
    "test/branch-window-preferences-api.test.js",
  ];
  for (const file of modules) {
    assert.equal(PHASE_3_SQLITE_PROVIDER_FILES.filter(entry => entry === file).length, 1, file);
    assert.equal(PHASE_3_SQLITE_RAW_ACCESS_FILES.includes(file), false, `${file}: no raw SQL grant`);
    assert.deepEqual(architectureBoundaryViolationsForText(file, fs.readFileSync(path.join(root, file), "utf8")), [], file);
  }
  for (const file of fixtures) {
    assert.equal(PHASE_3_SQLITE_PROVIDER_TEST_FILES.filter(entry => entry === file).length, 1, file);
  }
  for (const file of [...modules, ...fixtures]) {
    for (const [source, kind] of [
      ["const driver = require('node:" + "sqlite');", "sqlite-driver-import-outside-boundary"],
      ["const driver = require('pg');", "postgresql-driver-import"],
      ["const provider = createPersistenceProviderFacade(adapter);", "provider-facade-outside-boundary"],
      ["const statement = definePersistenceStatement({});", "provider-statement-outside-boundary"],
      ["const configured = process.env.DB_PROVIDER;", "provider-runtime-config-outside-boundary"],
    ]) assert.equal(architectureBoundaryViolationsForText(file, source).some(entry => entry.kind === kind), true, `${file}: ${kind}`);
  }
  for (const file of [
    "lib/sales-price-label-other-draft-store.js", "lib/sales-price-label-other-project-store.js",
    "lib/branch-other-window-preferences-store.js", "lib/branch-other-window-preferences-routes.js",
  ]) {
    assert.equal(PHASE_3_SQLITE_PROVIDER_FILES.includes(file), false, file);
    assert.equal(architectureBoundaryViolationsForText(file, "const contract = require('./persistence/contract');")
      .some(entry => entry.kind === "provider-contract-runtime-import"), true, file);
  }
  assert.equal(PHASE_3_SQLITE_PROVIDER_FILES.includes("lib/gp-window-preferences.js"), false,
    "The pure shared geometry schema needs no persistence exception");
  assert.equal(PHASE_3_SQLITE_PROVIDER_TEST_FILES.includes("test/branch-window-preferences-portal.test.js"), false,
    "The pure browser adapter fixture grants no database capability");
});
