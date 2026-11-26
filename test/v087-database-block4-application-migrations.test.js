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


test("Block 4/7: application migration stages are provider-neutral and deterministic", () => {
  assert.equal(APPLICATION_MIGRATION_MANIFEST.id, "grabenplaner.application");
  assert.equal(APPLICATION_MIGRATION_MANIFEST.migrations.length, 10);
  assert.equal(new Set(APPLICATION_MIGRATION_OPERATION_IDS).size, 10);
  assert.equal(APPLICATION_MIGRATION_OPERATION_CONTEXT_VERSION, 1);
  assert.equal(APPLICATION_MIGRATION_RUNTIME_CONTEXT_KEY, "applicationMigrations");
  assert.deepEqual(
    APPLICATION_MIGRATION_MANIFEST.migrations.slice(0, 2).map((migration) => migration.id),
    ["stage.startup-compatibility", "stage.application-schema"],
    "Backup- und Startup-Gate muss jeder Anwendungsschema-Mutation vorausgehen",
  );
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
