"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  APPLICATION_MIGRATION_MANIFEST,
  APPLICATION_MIGRATION_OPERATION_IDS,
  APPLICATION_MIGRATION_OPERATION_CONTEXT_VERSION,
  APPLICATION_MIGRATION_RUNTIME_CONTEXT_KEY,
} = require("../lib/persistence/migrations/application-manifest");
const {
  runMigrationManifest,
} = require("../lib/persistence/migrations/runner");
const {
  POSTGRESQL_APPLICATION_MIGRATION_FIXTURE,
  SQLITE_APPLICATION_MIGRATION_BINDINGS,
  SQLITE_APPLICATION_MIGRATION_HANDLERS,
  SQLITE_APPLICATION_MIGRATION_OPERATIONS,
  sqliteApplicationMigrationImplementationClosure,
  sqliteApplicationMigrationImplementationFingerprint,
} = require("../lib/persistence/sqlite/migrations/application-bindings");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");

function syntheticApplicationMigrationContext(database) {
  const defaultSettings = {
    branding_management_kit_id: "",
    branding_company_name: "",
    branding_logo_url: "/assets/grabenplaner-logo.svg",
    branding_icon_url: "/assets/webicon.svg",
    branding_logo_alt: "Grabenplaner",
    branding_admin_email: "",
  };
  const brandingFromSettings = (settings = {}) => ({
    companyName: String(settings.branding_company_name || ""),
    logoUrl: String(settings.branding_logo_url || "/assets/grabenplaner-logo.svg"),
    iconUrl: String(settings.branding_icon_url || "/assets/webicon.svg"),
    logoAlt: String(settings.branding_logo_alt || "Grabenplaner"),
    adminEmail: String(settings.branding_admin_email || ""),
  });
  return {
    [APPLICATION_MIGRATION_RUNTIME_CONTEXT_KEY]: {
      appVersion: "0.0.0-synthetic",
      state: {},
      startupSchema: {
        databaseExistedBeforeOpen: false,
        createPreMigrationBackup() {
          throw new Error("An empty synthetic rebuild must not request a backup.");
        },
        workRuleSha256() {
          return "0".repeat(64);
        },
      },
      protectedRecords: {
        httpError(status, message, code) {
          return Object.assign(new Error(message), { status, code });
        },
        parseProtectedJson() {
          return {};
        },
        personnelRecordDocumentProtectionContext() {
          return {};
        },
        personnelSensitiveProtectionContext() {
          return {};
        },
        parseVacationHistorySnapshot() {
          return {};
        },
        protectJson() {
          return "enc:v2:synthetic";
        },
        vacationHistoryProtectionContext() {
          return {};
        },
        requireAmuStorage() {
          throw new Error("An empty synthetic rebuild must not require AMU storage.");
        },
        amuReportProtectionContext() {
          return {};
        },
        amuDocumentProtectionContext() {
          return {};
        },
      },
      applicationDefaults: {
        defaultSettings,
        planningDays: [],
        builtinPortalRoles: [],
      },
      featureCompatibility: {
        normalizeAppFontScalePercent() {
          return 100;
        },
        defaultPortalSettings: {},
        passwordMinLength: 12,
        installationFeatureIds: new Set(),
        preV063DefaultInstallationFeatures: [],
        preV085DefaultInstallationFeatures: [],
      },
      organizationSchema: {
        auditPortal() {},
        getSettings() {
          return Object.fromEntries(
            database.prepare("SELECT key, value FROM settings").all()
              .map((row) => [row.key, row.value]),
          );
        },
        brandingFromSettings,
        defaultSettings,
      },
      demoProfile: {
        enabled: false,
        demoProfile: "",
        planningDays: [],
        sporthandelProfilePath: "",
      },
    },
  };
}

function createSyntheticRunnerAdapter(database, invokedOperationIds) {
  const history = [];
  return Object.freeze({
    providerId: "sqlite-synthetic-runner",
    runExclusive(work) {
      return work(Object.freeze({
        readAppliedMigrations(manifestId) {
          assert.equal(manifestId, APPLICATION_MIGRATION_MANIFEST.id);
          return history.map((entry) => ({ ...entry }));
        },
        executeMigrationStep({
          manifestId,
          migration,
          direction,
          operationIds,
          context,
        }) {
          assert.equal(manifestId, APPLICATION_MIGRATION_MANIFEST.id);
          assert.equal(direction, "apply");
          for (const operationId of operationIds) {
            const handler = SQLITE_APPLICATION_MIGRATION_HANDLERS[operationId];
            assert.equal(typeof handler, "function", operationId);
            const result = handler(Object.freeze({
              database,
              context,
              direction,
              manifestId,
              migrationId: migration.id,
            }));
            assert.equal(result && typeof result.then, undefined, operationId);
            invokedOperationIds.push(operationId);
          }
          history.push({
            id: migration.id,
            fingerprint: migration.fingerprint,
          });
        },
      }));
    },
  });
}

test("Block 4/7: application migration stages are provider-neutral and deterministic", () => {
  assert.equal(APPLICATION_MIGRATION_MANIFEST.id, "grabenplaner.application");
  assert.equal(APPLICATION_MIGRATION_MANIFEST.migrations.length, 10);
  assert.equal(new Set(APPLICATION_MIGRATION_OPERATION_IDS).size, 10);
  assert.equal(APPLICATION_MIGRATION_OPERATION_CONTEXT_VERSION, 1);
  assert.equal(APPLICATION_MIGRATION_RUNTIME_CONTEXT_KEY, "applicationMigrations");
  assert.match(APPLICATION_MIGRATION_MANIFEST.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(APPLICATION_MIGRATION_MANIFEST), true);

  const serialized = JSON.stringify(APPLICATION_MIGRATION_MANIFEST);
  for (const forbidden of [
    "CREATE TABLE",
    "INSERT INTO",
    "PRAGMA",
    "BEGIN IMMEDIATE",
    "node:sqlite",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("Block 4/7: every application operation has one executable SQLite handler", () => {
  const fixture = SQLITE_APPLICATION_MIGRATION_BINDINGS;
  assert.equal(fixture.providerId, "sqlite");
  assert.equal(fixture.status, "implemented-existing-runtime");
  assert.equal(fixture.executable, true);
  assert.equal(fixture.executionBoundary, "existing-runtime-bridge");
  assert.equal(fixture.genericAdapterCompatible, false);
  assert.equal(fixture.activationStatus, "mapped-not-ledger-activated");
  assert.equal(fixture.manifestFingerprint, APPLICATION_MIGRATION_MANIFEST.fingerprint);
  assert.equal(
    fixture.operationContextVersion,
    APPLICATION_MIGRATION_OPERATION_CONTEXT_VERSION,
  );
  assert.deepEqual(
    fixture.bindings.map((binding) => binding.operationId),
    APPLICATION_MIGRATION_OPERATION_IDS,
  );

  for (const binding of fixture.bindings) {
    const implementation = require(path.join(
      __dirname,
      "..",
      "lib",
      "persistence",
      "sqlite",
      "migrations",
      binding.modulePath,
    ));
    assert.equal(typeof implementation[binding.exportName], "function", binding.operationId);
    assert.equal(typeof binding.handler, "function", binding.operationId);
    assert.notEqual(binding.handler, implementation[binding.exportName], binding.operationId);
    assert.equal(
      SQLITE_APPLICATION_MIGRATION_HANDLERS[binding.operationId],
      binding.handler,
    );
    assert.deepEqual(
      SQLITE_APPLICATION_MIGRATION_OPERATIONS[binding.operationId],
      {
        handler: binding.handler,
        implementationFingerprint: binding.implementationFingerprint,
      },
    );
    assert.match(binding.implementationFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(binding.implementationFiles), true);
    assert.deepEqual(
      sqliteApplicationMigrationImplementationClosure(binding.modulePath)
        .map((entry) => entry.file),
      binding.implementationFiles,
    );
    assert.equal(
      sqliteApplicationMigrationImplementationFingerprint(binding),
      binding.implementationFingerprint,
    );
    assert.notEqual(
      sqliteApplicationMigrationImplementationFingerprint({
        ...binding,
        invocationId: `${binding.invocationId}-changed`,
      }),
      binding.implementationFingerprint,
    );
    assert.notEqual(
      sqliteApplicationMigrationImplementationFingerprint({
        ...binding,
        handler() {},
      }),
      binding.implementationFingerprint,
    );
    assert.equal(binding.atomicity, "implementation-managed");
    assert.equal(
      binding.recoveryPolicy,
      "transaction-or-verified-pre-migration-backup",
    );
  }
  assert.ok(
    fixture.bindings
      .find((binding) => binding.operationId === "application.schema.ensure")
      .implementationFiles
      .includes("lib/persistence/sqlite/operations/work-rule-store-schema.js"),
    "transitive application-schema dependency",
  );
});

test("Block 4/7: all ten SQLite bindings run synchronously on an empty fixture", async () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const invokedOperationIds = [];
  const context = syntheticApplicationMigrationContext(database);
  try {
    const result = await runMigrationManifest({
      manifest: APPLICATION_MIGRATION_MANIFEST,
      adapter: createSyntheticRunnerAdapter(database, invokedOperationIds),
      context,
    });

    assert.equal(result.kind, "rebuild");
    assert.deepEqual(result.applied, APPLICATION_MIGRATION_MANIFEST.migrations.map(
      (migration) => migration.id,
    ));
    assert.deepEqual(invokedOperationIds, APPLICATION_MIGRATION_OPERATION_IDS);
    assert.ok(
      context.applicationMigrations.state.startupSchemaMigrationState,
      "startup state",
    );
    assert.equal(
      typeof context.applicationMigrations.state.legacyDaySettingsSnapshot,
      "function",
    );
    assert.ok(
      context.applicationMigrations.state.featureCompatibilityMigrationState,
      "feature state",
    );
    assert.ok(
      context.applicationMigrations.state.organizationSchemaMigrationState,
      "organization state",
    );
    for (const tableName of [
      "employees",
      "schema_migrations",
      "locations",
      "system_center_trust_metrics",
      "branch_orders",
      "branch_order_drafts",
      "employee_location_lendings",
      "maintenance_cleanup_receipts",
    ]) {
      assert.equal(
        database.prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(tableName)?.present,
        1,
        tableName,
      );
    }
  } finally {
    database.close();
  }
});

test("Block 4/7: PostgreSQL migration path stays planned and non-executable", () => {
  const fixture = POSTGRESQL_APPLICATION_MIGRATION_FIXTURE;
  assert.equal(fixture.providerId, "postgresql");
  assert.equal(fixture.status, "contract-only");
  assert.equal(fixture.executable, false);
  assert.equal(fixture.manifestFingerprint, APPLICATION_MIGRATION_MANIFEST.fingerprint);
  assert.deepEqual(
    fixture.bindings.map((binding) => binding.operationId),
    APPLICATION_MIGRATION_OPERATION_IDS,
  );
  for (const binding of fixture.bindings) {
    assert.deepEqual(Object.keys(binding).sort(), ["operationId", "status"]);
    assert.equal(binding.status, "contract-only");
  }
});
