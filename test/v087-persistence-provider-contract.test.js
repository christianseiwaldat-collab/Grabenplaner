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

test("v0.87 Datenbank Block 2: fehlender Provider bleibt vollständig DB_PATH-kompatibel", () => {
  for (const providerValue of [undefined, null, "", "   ", "sqlite", "SQLite", " SQLITE "]) {
    const environment = {};
    if (providerValue !== undefined) environment.DB_PROVIDER = providerValue;
    const configuration = resolvePersistenceConfiguration({
      environment,
      defaultSqlitePath: "data/dienstplan.db",
    });
    assert.deepEqual(configuration, {
      providerId: "sqlite",
      databasePath: "data/dienstplan.db",
      databaseUrlConfigured: false,
    });
    assert.equal(Object.isFrozen(configuration), true);
  }

  const configuredPath = "  relative/custom database.db  ";
  const explicit = resolvePersistenceConfiguration({
    environment: { DB_PROVIDER: "sqlite", DB_PATH: configuredPath },
    defaultSqlitePath: "unused.db",
  });
  assert.equal(explicit.databasePath, configuredPath);

  const memory = resolvePersistenceConfiguration({
    environment: { DB_PATH: ":memory:" },
    defaultSqlitePath: "unused.db",
  });
  assert.equal(memory.databasePath, ":memory:");
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

test("v0.87 Datenbank Block 2: unbekannte, widersprüchliche und noch nicht verfügbare Provider scheitern geschlossen", () => {
  for (const value of ["pg", "postgres", "sqlite3", "mysql", "postgrsql"]) {
    assert.throws(
      () => resolvePersistenceConfiguration({
        environment: { DB_PROVIDER: value },
        defaultSqlitePath: "data/dienstplan.db",
      }),
      (error) => error?.code === PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID,
    );
  }

  for (const environment of [
    { DB_PROVIDER: "postgresql" },
    { DB_PROVIDER: "postgresql", DATABASE_URL: "postgresql://admin:GEHEIM@db.example/app" },
  ]) {
    assert.throws(
      () => resolvePersistenceConfiguration({
        environment,
        defaultSqlitePath: "data/dienstplan.db",
      }),
      (error) => {
        assert.equal(error?.code, PERSISTENCE_ERROR_CODES.PROVIDER_UNAVAILABLE);
        assert.equal(JSON.stringify(error).includes("GEHEIM"), false);
        assert.equal(String(error.message).includes("GEHEIM"), false);
        return true;
      },
    );
  }

  const secret = "postgresql://admin:ANDERES-GEHEIM@db.example/app";
  assert.throws(
    () => resolvePersistenceConfiguration({
      environment: { DB_PROVIDER: "sqlite", DATABASE_URL: secret },
      defaultSqlitePath: "data/dienstplan.db",
    }),
    (error) => {
      assert.equal(error?.code, PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID);
      assert.equal(JSON.stringify(error).includes("ANDERES-GEHEIM"), false);
      assert.equal(String(error.message).includes("ANDERES-GEHEIM"), false);
      return true;
    },
  );

  const blankSecret = resolvePersistenceConfiguration({
    environment: { DATABASE_URL: "   " },
    defaultSqlitePath: "data/dienstplan.db",
  });
  assert.equal(blankSecret.databaseUrlConfigured, false);
  assert.deepEqual(redactPersistenceConfiguration(blankSecret), blankSecret);
});

test("v0.87 Datenbank Block 2: Startvalidierung liegt vor Lock, Dateisystem und Treiberöffnung", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const configurationCall = server.indexOf("resolvePersistenceConfiguration({");
  const runtimeValidation = server.indexOf("assertRuntimeConfiguration(runtimeConfiguration)");
  const lockPath = server.indexOf("const instanceLockPath = lockPathForDatabase(databasePath)");
  const firstDirectoryWrite = server.indexOf("fs.mkdirSync(");
  const driverOpen = server.indexOf("openSqliteApplicationPersistence({");

  assert.ok(configurationCall > 0);
  assert.ok(configurationCall < runtimeValidation);
  assert.ok(runtimeValidation < lockPath);
  assert.ok(lockPath < firstDirectoryWrite);
  assert.ok(firstDirectoryWrite < driverOpen);
  assert.equal(server.includes("node:sqlite"), false);
  assert.equal(server.includes("DatabaseSync"), false);
  assert.equal(server.includes("process.env.DB_PROVIDER"), false);
  assert.equal(server.includes("process.env.DATABASE_URL"), false);
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
    "test/v087-database-block5-postgresql-system-center-metrics.test.js",
    "test/v087-database-block5-postgresql-ui-preferences.test.js",
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
  assert.equal(report.phase5Progress.serverActivationReferences, 0);
  assert.equal(report.phase5Progress.driverDependency, "8.22.0");
  assert.equal(
    report.phase5Progress.compilerVersion,
    PHASE_5_EXPECTED_COMPILER_VERSION,
  );
  assert.equal(report.phase5Progress.dialectPlanStatementCount, 891);
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
    requiredReceiptCount: 891,
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
  assert.deepEqual(report.phase5Progress.developmentSlices, {
    sliceCount: 4,
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
    expectedApplicationMigrationCount: 9,
    productActivation: false,
  });
  assert.deepEqual(report.phase5Progress.missingFiles, []);
  assert.deepEqual(report.phase5Progress.missingTestFiles, []);
  assert.deepEqual(report.phase5Progress.moduleErrors, []);
  assert.deepEqual(report.phaseBoundaryViolations, []);
  assert.deepEqual(report.unknownProduction, []);
  assert.deepEqual(report.unknownTests, []);
});

test("v0.87 Datenbank Block 5: Vertragsdokument hält Historie und aktuellen Provider-Slice getrennt", () => {
  const contract = fs.readFileSync(path.join(root, "docs", "DATENBANK-PROVIDER-VERTRAG.md"), "utf8");
  const phase3 = fs.readFileSync(path.join(root, "docs", "DATENBANK-SQLITE-PROVIDER.md"), "utf8");
  const phase5 = fs.readFileSync(path.join(root, "docs", "DATENBANK-POSTGRESQL-PROVIDER.md"), "utf8");
  const strategy = fs.readFileSync(path.join(root, "docs", "DATENBANK-PROVIDER-STRATEGIE.md"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  assert.match(contract, /Status:\*\* Block 2\/7 abgeschlossen/);
  assert.match(contract, /Block 3 wurde am 29\.07\.2026 separat freigegeben/);
  assert.match(contract, /keinen PostgreSQL-Treiber/);
  assert.match(phase3, /Block 3\/7 abgeschlossen/);
  assert.match(phase3, /keinen? PostgreSQL-Treiber/i);
  assert.match(strategy, /Datenbank-Provider-Vertrag/);
  assert.match(strategy, /Phase 5 ist begonnen und weiterhin in[\s\S]{0,30}Bearbeitung/i);
  assert.match(phase5, /nicht produktiven Status/i);
  assert.match(phase5, /`development-contract`/);
  assert.match(phase5, /789[^\r\n]*Syntaxkandidaten/);
  assert.match(phase5, /102[\s\S]{0,100}`requires-override`/);
  assert.match(phase5, /`fullApplicationCatalog: false`/);
  assert.match(phase5, /Abdeckungen 4\/4, 2\/2, 2\/2 und 1\/1[\s\S]{0,120}0\/891/);
  assert.match(phase5, /`applicationExecutable: false`/);
  assert.match(phase5, /Produktiver Datenbankpfad:[\s\S]{0,80}ausschließlich SQLite/i);
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
