"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const BASELINE = Object.freeze({
  schemaVersion: 1,
  capturedAt: "2026-07-29",
  sourceCommit: "92b023ce0b3fe545aa5253ae0903af8822388afc",
  productionDirectFiles: 28,
  productionIndirectFiles: 28,
  testCandidateFiles: 69,
  testDriverFiles: 26,
  productionTotals: Object.freeze({
    directNodeSqliteImport: 25,
    prepareCall: 1394,
    execCall: 419,
    beginImmediate: 68,
    beginExclusive: 1,
    pragma: 63,
    insertOrIgnore: 65,
    insertOrReplace: 3,
    onConflict: 41,
    raiseAbort: 98,
    autoincrement: 21,
    collateNocase: 54,
    julianday: 14,
    globOperator: 2,
    vacuumInto: 6,
    quickCheck: 27,
    foreignKeyCheck: 3,
    walCheckpoint: 2,
    lastInsertRowid: 32,
    sqliteCatalog: 32,
    schemaMigrations: 87,
    ensureColumn: 94,
    createTable: 122,
    createTriggerDdl: 98,
    createIndex: 128,
    alterTable: 19,
    migrationIdDeclaration: 17,
  }),
  serverHotspot: Object.freeze({
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
  }),
});
const BASELINE_PACKAGE_DEPENDENCY_NAMES = Object.freeze([
  "@tesseract.js-data/deu",
  "exceljs",
  "express",
  "pdfjs-dist",
  "pdfkit",
  "quill",
  "sharp",
  "tedious",
  "tesseract.js",
]);
const APPLICATION_ALLOWED_DEPENDENCIES = Object.freeze(["mdb-reader", "nodemailer"]);
// A read-only SQLite snapshot is the source of the user-authorized Block 9
// transfer. This exception does not permit application fallback to SQLite.
const HISTORICAL_SOURCE_DRIVER_FILES = Object.freeze(['lib/persistence/postgresql/transfer/history.js']);
// User-authorized 2026 migration blocks; isolated environment, never product activation.
const MIGRATION_DEVELOPMENT_FILES = new Set([
  'lib/persistence/postgresql/runtime-binding.js',
  'lib/persistence/postgresql/productive-configuration.js',
  'lib/persistence/postgresql/lifecycle-control.js',
  'lib/persistence/postgresql/operations/status.js',
  'lib/persistence/postgresql/operations/lifecycle.js',
  'lib/persistence/postgresql/operations/cutover.js',
  'lib/persistence/postgresql/transfer/staging.js',
  'lib/persistence/postgresql/transfer/activation.js',
  'lib/persistence/postgresql/transfer/protection.js',
  'scripts/postgresql/activation-rehearsal-step.js',
  'scripts/postgresql/managed-activation-qualification.js',
  'server-tools/linux/postgresql/control-worker.js',
  'server-tools/linux/postgresql/host-reboot.js',
  'server-tools/linux/postgresql/lifecycle-run.js',
  'server-tools/linux/postgresql/lifecycle-status.js',
  'server-tools/linux/postgresql/lifecycle-maintenance.sh',
  'server-tools/linux/postgresql/migration-host.js',
  'server-tools/linux/postgresql/managed-contract.js',
  'server-tools/linux/postgresql/recover-maintenance.sh',
  'server-tools/linux/postgresql/migrate-grabenplaner-postgresql.sh',
  'server-tools/linux/postgresql/capture-final-source.py',
  'test/postgresql-migration-activation.test.js',
  'test/postgresql-migration-cutover.test.js',
  'test-support/postgresql-migration/application-outbox.js',
  'test-support/postgresql-migration/application-load.js',
  'test-support/postgresql-migration/application-export.js',
  'lib/persistence/postgresql/operations/application-export.js',
  'test/postgresql-migration-full-application.test.js',
  'scripts/postgresql/application-fault-child.js',
  'server-tools/linux/recovery/lib/postgresql-application-smoke.js',
  'lib/persistence/postgresql/application.js',
  'lib/persistence/postgresql/rehearsal-configuration.js',
  'lib/persistence/postgresql/application-operations/access.js',
  'lib/persistence/postgresql/application-operations/async-collections.js',
  'lib/persistence/postgresql/application-operations/branch-orders.js',
  'lib/persistence/postgresql/application-operations/diagnostics.js',
  'lib/persistence/postgresql/application-operations/employee-location-lendings.js',
  'lib/persistence/postgresql/application-operations/protected-storage.js',
  'lib/persistence/postgresql/application-operations/startup.js',
  'lib/persistence/postgresql/boundary/personal-actions.js',
  'lib/persistence/postgresql/operations/restore-privileges.js',
  'lib/persistence/postgresql/contracts/manifest.json',
  'lib/persistence/postgresql/contracts/source-schema-v09237.json',
  'lib/persistence/postgresql/contracts/block-1-inventory.json',
  'lib/persistence/postgresql/contracts/block-4-catalog.json',
  'lib/persistence/postgresql/contracts/block-5-catalog.json',
  'lib/persistence/postgresql/contracts/block-6-catalog.json',
  'lib/persistence/postgresql/contracts/block-7-catalog.json',
  'lib/persistence/postgresql/contracts/block-8-catalog.json',
  'lib/persistence/postgresql/contracts/block-7-boundary-catalog.json',
  'lib/persistence/postgresql/contracts/block-8-reporting-catalog.json',
  'scripts/postgresql/application-rehearsal-step.js',
  'test-support/postgresql-migration/application-http.js',
  'test-support/postgresql-migration/application-operations.js',
  'lib/persistence/postgresql/operations/paired-checkpoint.js',
  'lib/persistence/postgresql/operations/paired-restore.js',
  'scripts/postgresql/qualify-nightly-restore.js',
  'server-tools/linux/recovery/lib/postgresql-recovery.js',
  'server-tools/linux/recovery/lib/postgresql-recovery-worker.js',
  'lib/persistence/postgresql/transfer/values.js',
  'lib/persistence/postgresql/transfer/history.js',
  'lib/persistence/postgresql/transfer/verify-pair.js',
  'scripts/postgresql/transfer-historical.js',
  'scripts/postgresql/verify-historical-pair.js',
  'scripts/postgresql/verify-historical-protection.js',
  'test/postgresql-migration-transfer-values.test.js',
  'test/postgresql-migration-transfer-guards.test.js',
  'lib/persistence/postgresql/operations/paired-development.js',
  'lib/persistence/postgresql/operations/paired-pitr.js',
  'lib/persistence/postgresql/operations/paired-bundle.js',
  'lib/persistence/postgresql/operations/paired-backup.js',
  'lib/persistence/postgresql/operations/paired-monitor.js',
  'lib/persistence/postgresql/operations/paired-retention.js',
  'lib/persistence/postgresql/operations/runtime.js',
  'server-tools/linux/lib/postgresql-operations.js',
  'scripts/postgresql/qualify-operations-runtime.js',
  'scripts/postgresql/qualify-paired-backup-api.js',
  'scripts/postgresql/qualify-paired-monitor.js',
  'test/postgresql-migration-operations.test.js',
  'scripts/postgresql/prepare-paired-offsite.js',
  'test/postgresql-migration-paired-backup.test.js',
  'scripts/postgresql/qualify-paired-recovery.js',
  'lib/persistence/postgresql/core/environment.js',
  'lib/persistence/postgresql/core/sql.js',
  'lib/persistence/postgresql/core/schema.js',
  'lib/persistence/postgresql/core/compatibility.sql',
  'lib/persistence/postgresql/core/fingerprint.js',
  'lib/persistence/postgresql/core/migrate.js',
  'lib/persistence/postgresql/core/catalog.js',
  'lib/persistence/postgresql/core/application.js',
  'lib/persistence/postgresql/sales/layout.js',
  'lib/persistence/postgresql/sales/schema.js',
  'lib/persistence/postgresql/sales/catalog.js',
  'lib/persistence/postgresql/sales/migrate.js',
  'lib/persistence/postgresql/sales/application.js',
  'scripts/postgresql/apply-sales-schema.js',
  'scripts/postgresql/validate-sales-catalog.js',
  'scripts/postgresql/validate-sales-triggers.js',
  'test-support/postgresql-migration/sales-fixture.js',
  'test-support/postgresql-migration/cash-fixture.js',
  'test/postgresql-migration-cash.test.js',
  'test-support/postgresql-migration/trade-fixture.js',
  'test/postgresql-migration-trade.test.js',
  'lib/persistence/postgresql/boundary/schema.js',
  'lib/persistence/postgresql/boundary/migrate.js',
  'lib/persistence/postgresql/boundary/catalog.js',
  'lib/persistence/postgresql/boundary/application.js',
  'lib/persistence/postgresql/reporting/catalog.js',
  'lib/persistence/postgresql/reporting/principal.js',
  'lib/persistence/postgresql/reporting/worker.js',
  'lib/persistence/postgresql/reporting/receipt-prefetch.js',
  'lib/persistence/postgresql/reporting/receipt-runtime.js',
  'lib/persistence/postgresql/reporting/worker-priority.js',
  'scripts/postgresql/apply-boundary-schema.js',
  'scripts/postgresql/validate-boundary-catalog.js',
  'scripts/postgresql/validate-reporting-catalog.js',
  'scripts/postgresql/prepare-server-qualification.sh',
  'scripts/postgresql/run-server-qualification.js',
  'scripts/postgresql/qualify-load.js',
  'scripts/postgresql/recover-interrupted-fixture.js',
  'scripts/postgresql/verify-development-state.js',
  'test-support/postgresql-migration/report-fixture.js',
  'test-support/postgresql-migration/load-articles.js',
  'test-support/postgresql-migration/aggregate-fixture.js',
  'scripts/postgresql/tune-development-pools.js',
  'test/postgresql-migration-boundary.test.js',
  'test/postgresql-migration-reporting.test.js',
  'test/postgresql-migration-connection.test.js',
  'test/postgresql-migration-immutable-validation.test.js',
  'scripts/postgresql/apply-core-schema.js',
  'scripts/postgresql/validate-core-triggers.js',
  'scripts/postgresql/validate-core-catalog.js',
  'scripts/postgresql/lock-core-catalog.js',
  'scripts/postgresql/development-environment.sh',
  'scripts/postgresql/build-inventory.js',
  'scripts/postgresql/benchmark-core.js',
  'scripts/postgresql/mark-development-environment.js',
  'scripts/postgresql/run-development.js',
  'scripts/postgresql/create-isolated-environment.sh',
  'test-support/postgresql-migration/source-schema-v09237.json',
  'test-support/postgresql-migration/sqlite-source.js',
  'test-support/postgresql-migration/core-fixture.js',
  'test-support/postgresql-migration/query-inputs.js',
  'test/postgresql-migration-inventory.test.js',
  'test/postgresql-migration-environment.test.js',
  'test/postgresql-migration-schema.test.js',
  'test/postgresql-migration-application.test.js',
  'test/postgresql-migration-queries.test.js',
]);
const MIGRATION_DEVELOPMENT_DRIVER_FILES = new Set([
  'lib/persistence/postgresql/transfer/staging.js',
  'scripts/postgresql/activation-rehearsal-step.js',
  'server-tools/linux/postgresql/migration-host.js',
  'test-support/postgresql-migration/application-export.js',
  'lib/persistence/postgresql/operations/application-export.js',
  'lib/persistence/postgresql/application-operations/access.js',
  'lib/persistence/postgresql/operations/paired-restore.js',
  'lib/persistence/postgresql/operations/runtime.js',
  'scripts/postgresql/qualify-operations-runtime.js',
  'scripts/postgresql/qualify-paired-backup-api.js',
  'scripts/postgresql/qualify-paired-monitor.js',
  'lib/persistence/postgresql/operations/paired-development.js',
  'lib/persistence/postgresql/operations/paired-pitr.js',
  'lib/persistence/postgresql/transfer/history.js',
  'scripts/postgresql/verify-historical-protection.js',
  'scripts/postgresql/validate-reporting-catalog.js',
  'scripts/postgresql/tune-development-pools.js',
  'lib/persistence/postgresql/boundary/application.js',
  'scripts/postgresql/apply-boundary-schema.js',
  'scripts/postgresql/validate-boundary-catalog.js',
  'scripts/postgresql/recover-interrupted-fixture.js',
  'scripts/postgresql/verify-development-state.js',
  'test/postgresql-migration-connection.test.js',
  'lib/persistence/postgresql/sales/application.js',
  'scripts/postgresql/apply-sales-schema.js',
  'scripts/postgresql/validate-sales-catalog.js',
  'scripts/postgresql/validate-sales-triggers.js',
  'test-support/postgresql-migration/sales-fixture.js',
  'lib/persistence/postgresql/core/application.js',
  'test-support/postgresql-migration/core-fixture.js',
  'scripts/postgresql/mark-development-environment.js',
  'scripts/postgresql/apply-core-schema.js',
  'scripts/postgresql/validate-core-triggers.js',
  'scripts/postgresql/validate-core-catalog.js',
  'test/postgresql-migration-schema.test.js',
]);
// Explicit qualification entrypoints with a fixed synthetic in-memory database
// or a source-hash-bound isolated fixture; no application or productive vault.
const ISOLATED_CASH_QUALIFICATION_CLI_FILES = new Set([
  "scripts/benchmark-cash-assigned-search.js",
  "scripts/benchmark-sales-search.js",
  "scripts/measure-cash-history-snapshot.mjs",
  "scripts/verify-compact-cash-full.mjs",
]);

const SCAN_ROOTS = Object.freeze([
  "server.js",
  "backup.js",
  "lib",
  "scripts",
  "server-tools",
  "public",
  "test",
  "test-support",
]);
const SCANNED_EXTENSIONS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".sh",
  ".in",
  ".ps1",
  ".json",
  ".example",
  ".html",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "backups",
  "coverage",
  "data",
  "node_modules",
  "release",
  "runtime",
  "test-results",
  "tmp",
  "usb-backups",
]);
const EXCLUDED_FILES = new Set(["scripts/audit-persistence-coupling.js"]);
const PHASE_2_CONTRACT_FILES = Object.freeze([
  "lib/persistence/configuration.js",
  "lib/persistence/contract.js",
  "lib/persistence/errors.js",
]);
const PHASE_2_CONTRACT_FILE_SET = new Set(PHASE_2_CONTRACT_FILES);
const PHASE_2_CONTRACT_TEST_FILES = Object.freeze([
  "test-support/persistence-contract-adapter.js",
  "test-support/persistence-provider-contract.js",
  "test/v087-persistence-provider-contract.test.js",
]);
const PHASE_2_CONTRACT_TEST_FILE_SET = new Set(PHASE_2_CONTRACT_TEST_FILES);
const PHASE_2_CLASSIFICATION = Object.freeze({
  id: "phase-2-provider-contract",
  scope: "provider-contract",
  owner: "persistence-architecture",
  targetLayer: "provider-neutral contract, configuration and error boundary",
  risk: "high",
  transactionContext: "Promise contract with a transaction-bound executor; no concrete driver",
  transitionException: "Phase 2 may define and validate the contract but may not activate PostgreSQL",
  laterPhase: "2-5",
});
const PHASE_3_SQLITE_PROVIDER_FILES = Object.freeze([
  "lib/persistence/repositories/sales-article-images.js",
  "lib/persistence/statements/sales-article-images.js",
  "lib/persistence/sqlite/sales-article-images-catalog.js",
  "lib/persistence/sqlite/operations/sales-article-images-schema.js",
  "lib/sales-article-image-routes.js",
  "lib/persistence/repositories/sales-report-jobs.js",
  "lib/persistence/statements/sales-report-jobs.js",
  "lib/persistence/sqlite/sales-report-jobs-catalog.js",
  "lib/persistence/sqlite/operations/sales-report-jobs-schema.js",
  "lib/sales-report-jobs-routes.js",
  "lib/sales-report-batch-worker.js",
  "lib/sales-report-worker.js",
  "lib/persistence/sqlite/operations/cash-inventory-schema.js",
  "lib/persistence/sqlite/operations/sales-article-search-projection-schema.js",
  "lib/persistence/sqlite/operations/portal-permission-defaults-schema.js",
  "lib/persistence/repositories/cash-snapshots.js",
  "lib/persistence/repositories/cash-publications.js",
  "lib/persistence/repositories/cash-publication-runtime.js",
  "lib/persistence/repositories/cash-history-backend.js",
  "lib/persistence/statements/cash-publications.js",
  "lib/persistence/sqlite/cash-publications-catalog.js",
  "lib/persistence/sqlite/operations/cash-publications-schema.js",
  "lib/persistence/statements/cash-snapshots.js",
  "lib/persistence/sqlite/cash-snapshots-catalog.js",
  "lib/persistence/sqlite/operations/cash-snapshots-schema.js",
  "lib/data-import-routes.js",
  "lib/data-import-jobs.js",
  "lib/data-import-job-store.js",
  "lib/persistence/repositories/data-import-runtime.js",
  "lib/persistence/repositories/data-import-mapping-runtime.js",
  "lib/persistence/repositories/sales-history-runtime.js",
  "lib/persistence/sqlite/data-import-runtime-catalog.js",
  "lib/persistence/sqlite/operations/data-import-runtime-schema.js",
  "lib/persistence/statements/data-import-runtime.js",
  "lib/persistence/statements/saturday-credit.js",
  "lib/persistence/sqlite/saturday-credit-catalog.js",
  "lib/persistence/sqlite/operations/saturday-credit-schema.js",
  "lib/persistence/repositories/saturday-credit.js",
  // Read-only route bridge, composed without a production import source.
  "lib/sales-history-routes.js",
  "lib/receipt-search-routes.js",
  "lib/branch-sales-routes.js",
  "scripts/verify-tradefoto-test-import.mjs",
  "lib/persistence/repositories/sales-history-workspace.js",
  "lib/persistence/repositories/import-history.js",
  "lib/persistence/sqlite/import-history-catalog.js",
  "lib/persistence/sqlite/operations/import-history-schema.js",
  "lib/persistence/statements/import-history.js",
  // Isolated Block-3 master-data adapters; no production import activation.
  "lib/persistence/repositories/import-master-data.js",
  "lib/persistence/sqlite/import-master-catalog.js",
  "lib/persistence/sqlite/operations/import-master-schema.js",
  "lib/persistence/statements/import-master-data.js",
  // Isolated Block-2 import foundation; not part of the application startup catalog.
  "lib/persistence/repositories/data-import.js",
  "lib/persistence/sqlite/data-import-catalog.js",
  "lib/persistence/sqlite/operations/data-import-schema.js",
  "lib/persistence/statements/data-import.js",
  "lib/persistence/application-repositories.js",
  "lib/persistence/repositories/absence-management.js",
  "lib/persistence/repositories/branding-snapshot.js",
  "lib/persistence/repositories/collective-agreements.js",
  "lib/persistence/repositories/crm-customers.js",
  "lib/persistence/repositories/custom-process-management.js",
  "lib/persistence/repositories/custom-work-rules.js",
  "lib/persistence/repositories/governance-store.js",
  "lib/persistence/repositories/integration-runtime.js",
  "lib/persistence/repositories/loan-module.js",
  "lib/persistence/repositories/mobile-auth.js",
  "lib/persistence/repositories/organization-personnel.js",
  "lib/persistence/repositories/personal-action-log.js",
  "lib/persistence/repositories/personal-notification-contacts.js",
  "lib/persistence/repositories/personnel-lifecycle.js",
  "lib/persistence/repositories/personnel-learning.js",
  "lib/persistence/repositories/portal-birthday-presentations.js",
  "lib/persistence/repositories/staff-assignment-requests.js",
  "lib/persistence/repositories/planning-settings.js",
  "lib/persistence/repositories/portal-access.js",
  "lib/persistence/repositories/runtime-recovery.js",
  "lib/persistence/repositories/sales-article-catalog.js",
  "lib/persistence/repositories/sickness-amu-management.js",
  "lib/persistence/repositories/system-center-metrics.js",
  "lib/persistence/repositories/time-tracking.js",
  "lib/persistence/repositories/ui-preferences.js",
  "lib/persistence/repositories/wifi-automation.js",
  "lib/persistence/repositories/work-rule-store.js",
  "lib/persistence/repositories/work-rule-governance.js",
  "lib/persistence/sqlite/application-catalog.js",
  "lib/persistence/sqlite/absence-management-catalog.js",
  "lib/persistence/sqlite/branding-snapshot-catalog.js",
  "lib/persistence/sqlite/collective-agreements-catalog.js",
  "lib/persistence/sqlite/crm-customers-catalog.js",
  "lib/persistence/sqlite/custom-process-management-catalog.js",
  "lib/persistence/sqlite/custom-work-rules-catalog.js",
  "lib/persistence/sqlite/governance-store-catalog.js",
  "lib/persistence/sqlite/integration-runtime-catalog.js",
  "lib/persistence/sqlite/loan-module-catalog.js",
  "lib/persistence/sqlite/mobile-auth-catalog.js",
  "lib/persistence/sqlite/operations/audit-log.js",
  "lib/persistence/sqlite/operations/central-article-loan-migration.js",
  "lib/persistence/sqlite/operations/collective-agreements-schema.js",
  "lib/persistence/sqlite/operations/crm-schema.js",
  "lib/persistence/sqlite/operations/personal-action-log-schema.js",
  "lib/persistence/sqlite/operations/application-seeding.js",
  "lib/persistence/sqlite/operations/branch-orders.js",
  "lib/persistence/sqlite/operations/application-schema.js",
  "lib/persistence/sqlite/operations/database-import.js",
  "lib/persistence/sqlite/operations/employee-location-lendings.js",
  "lib/persistence/sqlite/operations/feature-compatibility-migrations.js",
  "lib/persistence/sqlite/operations/historical-compatibility-migrations.js",
  "lib/persistence/sqlite/operations/maintenance.js",
  "lib/persistence/sqlite/operations/organization-schema-migrations.js",
  "lib/persistence/sqlite/operations/position-catalog-governance.js",
  "lib/persistence/sqlite/operations/personnel-document-history-schema.js",
  "lib/persistence/sqlite/operations/personnel-lifecycle-case-schema.js",
  "lib/persistence/sqlite/operations/personnel-lifecycle-offboarding-schema.js",
  "lib/persistence/sqlite/operations/personnel-lifecycle-onboarding-schema.js",
  "lib/persistence/sqlite/operations/personnel-lifecycle-schema.js",
  "lib/persistence/sqlite/operations/personnel-learning-competency-schema.js",
  "lib/persistence/sqlite/operations/personnel-learning-assignment-schema.js",
  "lib/persistence/sqlite/operations/personnel-learning-progress-schema.js",
  "lib/persistence/sqlite/operations/personnel-learning-schema.js",
  "lib/persistence/sqlite/operations/portal-birthday-presentation-claim-schema.js",
  "lib/persistence/sqlite/operations/portal-birthday-presentation-schema.js",
  "lib/persistence/sqlite/operations/staff-assignment-request-schema.js",
  "lib/persistence/sqlite/operations/personnel-workflow-instance-schema.js",
  "lib/persistence/sqlite/operations/personnel-workflow-schema.js",
  "lib/persistence/sqlite/operations/protected-record-migrations.js",
  "lib/persistence/sqlite/operations/sales-article-catalog-schema.js",
  "lib/persistence/sqlite/operations/startup-schema-migrations.js",
  "lib/persistence/sqlite/operations/system-diagnostics.js",
  "lib/persistence/sqlite/operations/system-center-metrics-schema.js",
  "lib/persistence/sqlite/operations/work-rule-store-schema.js",
  "lib/persistence/sqlite/organization-personnel-catalog.js",
  "lib/persistence/sqlite/personal-action-log-catalog.js",
  "lib/persistence/sqlite/personal-notification-contacts-catalog.js",
  "lib/persistence/sqlite/personnel-lifecycle-catalog.js",
  "lib/persistence/sqlite/personnel-learning-catalog.js",
  "lib/persistence/sqlite/portal-birthday-presentations.js",
  "lib/persistence/sqlite/staff-assignment-request-catalog.js",
  "lib/persistence/sqlite/planning-settings-catalog.js",
  "lib/persistence/sqlite/portal-access-catalog.js",
  "lib/persistence/sqlite/provider.js",
  "lib/persistence/sqlite/runtime-recovery-catalog.js",
  "lib/persistence/sqlite/sales-article-catalog-catalog.js",
  "lib/persistence/sqlite/sickness-amu-management-catalog.js",
  "lib/persistence/sqlite/system-center-metrics-catalog.js",
  "lib/persistence/sqlite/time-tracking-catalog.js",
  "lib/persistence/sqlite/ui-preferences-catalog.js",
  "lib/persistence/sqlite/wifi-automation-catalog.js",
  "lib/persistence/sqlite/work-rule-store-catalog.js",
  "lib/persistence/sqlite/work-rule-governance-catalog.js",
  "lib/persistence/statements/branding-snapshot.js",
  "lib/persistence/statements/absence-management.js",
  "lib/persistence/statements/collective-agreements.js",
  "lib/persistence/statements/crm-customers.js",
  "lib/persistence/statements/custom-process-management.js",
  "lib/persistence/statements/custom-work-rules.js",
  "lib/persistence/statements/governance-store.js",
  "lib/persistence/statements/integration-runtime.js",
  "lib/persistence/statements/loan-module.js",
  "lib/persistence/statements/mobile-auth.js",
  "lib/persistence/statements/organization-personnel.js",
  "lib/persistence/statements/personal-action-log.js",
  "lib/persistence/statements/personal-notification-contacts.js",
  "lib/persistence/statements/personnel-lifecycle.js",
  "lib/persistence/statements/personnel-learning.js",
  "lib/persistence/statements/portal-birthday-presentations.js",
  "lib/persistence/statements/staff-assignment-requests.js",
  "lib/persistence/statements/planning-settings.js",
  "lib/persistence/statements/portal-access.js",
  "lib/persistence/statements/runtime-recovery.js",
  "lib/persistence/statements/sales-article-catalog.js",
  "lib/persistence/statements/sickness-amu-management.js",
  "lib/persistence/statements/system-center-metrics.js",
  "lib/persistence/statements/time-tracking.js",
  "lib/persistence/statements/ui-preferences.js",
  "lib/persistence/statements/wifi-automation.js",
  "lib/persistence/statements/work-rule-store.js",
  "lib/persistence/statements/work-rule-governance.js",
]);
const PHASE_3_SQLITE_PROVIDER_FILE_SET = new Set(PHASE_3_SQLITE_PROVIDER_FILES);
const PHASE_3_SQLITE_PROVIDER_TEST_FILES = Object.freeze([
  "test/branch-sales-api.test.js",
  "test/sales-article-images.test.js",
  "test/sales-report-jobs-routes.test.js",
  "scripts/benchmark-cash-assigned-search.js",
  "scripts/benchmark-sales-search.js",
  "test/portal-permission-defaults.test.js",
  "test/sales-article-catalog-search.test.js",
  "scripts/measure-cash-history-snapshot.mjs",
  "scripts/verify-compact-cash-full.mjs",
  "test-support/cash-history-snapshot-prototype.js",
  "test/cash-history-snapshot-prototype.test.js",
  "test/cash-snapshots.test.js",
  "test/cash-publication-integration.test.js",
  "test-support/large-data-backup-qualification.mjs",
  "test-support/tradefoto-full-backup-measurement.js",
  "test/background-backup-consistency.test.js",
  "test/backup-package-runtime.test.js",
  "test/local-backup-management.test.js",
  "test/backup-recovery-keys.test.js",
  "test/full-source-backup-measurement.test.js",
  "test/data-import-runtime.test.js",
  "test/data-import-jobs.test.js",
  "test/data-import-state-counts.test.js",
  "test/saturday-credit-integration.test.js",
  "test/saturday-credit-api.test.js",
  "test/data-import-routes-ui.test.js",
  "test-support/tradefoto-block6-store.js",
  "test-support/tradefoto-block3-store.js",
  "test/tradefoto-history.test.js",
  "test/tradefoto-storage-comparison.test.js",
  "test/tradefoto-master-data.test.js",
  "test/tradefoto-crm-maintenance-import.test.js",
  "test/data-import-foundation.test.js",
  "test/data-import-payload-storage.test.js",
  "test/data-import-payload-reuse.test.js",
  "test/schedule-duty-persistence-api.test.js",
  "test/schedule-duty-colors-api.test.js",
  "test/custom-work-rules-persistence.test.js",
  "test/governance-store-persistence.test.js",
  "test/work-rule-governance-persistence.test.js",
  "test/v087-absence-management-persistence.test.js",
  "test/v087-application-seeding.test.js",
  "test/v087-application-schema-operation.test.js",
  "test/v087-branding-persistence.test.js",
  "test/v087-collective-agreements-persistence.test.js",
  "test/crm-api-contract.test.js",
  "test/crm-persistence-contract.test.js",
  "test/personal-action-log-persistence.test.js",
  "test/sales-article-catalog-persistence.test.js",
  "test/sales-article-catalog-detail-route.test.js",
  "test/sales-article-catalog-import-api.test.js",
  "test/sales-article-catalog-route.test.js",
  "test/sales-article-catalog-schema.test.js",
  "test/v09224-central-article-loan-migration.test.js",
  "test/v087-custom-process-management-persistence.test.js",
  "test/v087-integration-runtime-persistence.test.js",
  "test/v087-loan-module-persistence.test.js",
  "test/v087-mobile-auth-persistence.test.js",
  "test/v087-organization-personnel-persistence.test.js",
  "test/v09220-manager-department-rights.test.js",
  "test/personal-loan-standard-right.test.js",
  "test/v09220-branch-supervision-api.test.js",
  "test/v09220-manual-schedule-lock-api.test.js",
  "test/v09220-position-catalog-governance.test.js",
  "test/v087-planning-settings-persistence.test.js",
  "test/v087-portal-access-persistence.test.js",
  "test/personnel-lifecycle-api.test.js",
  "test/personnel-lifecycle-scoped-rights-api.test.js",
  "test/personnel-lifecycle-conversion-domain.test.js",
  "test/personnel-lifecycle-conversion-import.test.js",
  "test/personnel-lifecycle-conversion-migration.test.js",
  "test/personnel-lifecycle-case-foundation-migration.test.js",
  "test/personnel-lifecycle-case-foundation.test.js",
  "test/personnel-lifecycle-automation-api.test.js",
  "test/personnel-lifecycle-editor-api.test.js",
  "test/personnel-lifecycle-interfaces-api.test.js",
  "test/personnel-lifecycle-offboarding-api.test.js",
  "test/personnel-lifecycle-offboarding-persistence.test.js",
  "test/personnel-lifecycle-offboarding-service.test.js",
  "test/personnel-lifecycle-offboarding-sqlite-integration.test.js",
  "test/personnel-lifecycle-onboarding-preview.test.js",
  "test/personnel-lifecycle-onboarding-persistence.test.js",
  "test/personnel-lifecycle-onboarding-execution.test.js",
  "test/personnel-lifecycle-onboarding-execution-api.test.js",
  "test/personnel-lifecycle-onboarding-tasks.test.js",
  "test/personnel-lifecycle-onboarding-tasks-api.test.js",
  "test/personnel-workflow-lifecycle-onboarding-schema.test.js",
  "test/personnel-lifecycle-data-foundation.test.js",
  "test/personnel-lifecycle-scoped-rights-persistence.test.js",
  "test/personnel-learning-foundation.test.js",
  "test/personnel-learning-competency-foundation.test.js",
  "test/personnel-learning-assignment-foundation.test.js",
  "test/personnel-learning-catalog-api.test.js",
  "test/personnel-learning-catalog-persistence.test.js",
  "test/personnel-learning-rights-hierarchy.test.js",
  "test/portal-birthday-presentation-claim-api.test.js",
  "test/portal-birthday-presentation-claim-startup-migration.test.js",
  "test/portal-birthday-presentation-claim.test.js",
  "test/portal-birthday-presentation-schema.test.js",
  "test/portal-birthday-presentation-settings-api.test.js",
  "test/portal-birthday-presentation-startup-migration.test.js",
  "test/portal-birthday-presentations-persistence.test.js",
  "test/portal-birthday-theme-api.test.js",
  "test/staff-assignment-request-foundation.test.js",
  "test/staff-assignment-request-startup-migration.test.js",
  "test/cross-location-schedule-rights-api.test.js",
  "test/cross-location-schedule-view-api.test.js",
  "test/loan-document-email-delivery.test.js",
  "test/schedule-search-api.test.js",
  "test/personnel-document-history-persistence.test.js",
  "test/personnel-profile-overview-api.test.js",
  "test/personnel-profile-scoped-rights-persistence.test.js",
  "test/personnel-workflow-api.test.js",
  "test/personnel-workflow-import.test.js",
  "test/personnel-workflow-instances-api.test.js",
  "test/personnel-workflow-publications.test.js",
  "test/personnel-workflow-startup-migration.test.js",
  "test/v087-protected-record-migrations.test.js",
  "test/v087-runtime-recovery-persistence.test.js",
  "test/v087-sickness-amu-management-persistence.test.js",
  "test/v087-sqlite-operations.test.js",
  "test/v087-sqlite-persistence-provider.test.js",
  "test/v087-startup-schema-migrations.test.js",
  "test/v087-time-tracking-persistence.test.js",
  "test/v087-wifi-automation-persistence.test.js",
  "test/v088-personal-email-settings.test.js",
  "test/v091-branch-orders.test.js",
  "test/v092-branch-order-cleanup-cli.test.js",
  "test/v0921-staff-assignment-absences.test.js",
  "test/v0921-staff-assignments.test.js",
  "test/v0925-mobile-location-display.test.js",
  "test/v0925-password-reset-backend.test.js",
  "test/v0925-sliding-portal-session.test.js",
  "test/v0925-xoffi-time-import.test.js",
]);
const PHASE_3_SQLITE_PROVIDER_TEST_FILE_SET = new Set(PHASE_3_SQLITE_PROVIDER_TEST_FILES);
const PHASE_3_SQLITE_DRIVER_FILES = Object.freeze([
  "lib/persistence/sqlite/provider.js",
]);
const PHASE_3_SQLITE_DRIVER_FILE_SET = new Set(PHASE_3_SQLITE_DRIVER_FILES);
const PHASE_3_STATEMENT_FILES = Object.freeze(
  PHASE_3_SQLITE_PROVIDER_FILES.filter((file) => file.startsWith("lib/persistence/statements/")),
);
const PHASE_3_SQLITE_RAW_ACCESS_FILES = Object.freeze(
  PHASE_3_SQLITE_PROVIDER_FILES.filter((file) => (
    file === "lib/persistence/sqlite/provider.js"
    || file.startsWith("lib/persistence/sqlite/operations/")
  )),
);
const PHASE_3_SQLITE_RAW_ACCESS_FILE_SET = new Set(PHASE_3_SQLITE_RAW_ACCESS_FILES);
const PHASE_3_CLASSIFICATION = Object.freeze({
  id: "phase-3-sqlite-provider-slices",
  scope: "sqlite-provider-runtime",
  owner: "persistence-architecture",
  targetLayer: "provider-neutral repositories with SQLite-owned statement catalogs and named operations",
  risk: "high",
  transactionContext: "provider-bound transaction executors for migrated runtime slices",
  transitionException: "exactly one new node:sqlite import is allowed in the named SQLite provider module",
  laterPhase: "3",
});
const PHASE_4_PERSISTENCE_FILES = Object.freeze([
  "lib/persistence/dialects/application-manifest.js",
  "lib/persistence/dialects/contract.js",
  "lib/persistence/migrations/application-manifest.js",
  "lib/persistence/migrations/contract.js",
  "lib/persistence/migrations/runner.js",
  "lib/persistence/sqlite/migrations/adapter.js",
  "lib/persistence/sqlite/migrations/application-bindings.js",
]);
const PHASE_4_PERSISTENCE_FILE_SET = new Set(PHASE_4_PERSISTENCE_FILES);
const PHASE_4_PERSISTENCE_TEST_FILES = Object.freeze([
  "test-support/sqlite-migration-fixture.js",
  "test/v087-database-block4-application-migrations.test.js",
  "test/v087-database-block4-dialect-contract.test.js",
  "test/v087-database-block4-migration-contract.test.js",
  "test/v087-database-block4-sqlite-migration-runner.test.js",
  "test/v087-database-block4-statement-dialects.test.js",
]);
const PHASE_4_PERSISTENCE_TEST_FILE_SET = new Set(PHASE_4_PERSISTENCE_TEST_FILES);
const PHASE_4_EXPECTED_STATEMENT_COUNT = 1354;
const PHASE_4_EXPECTED_SQLITE_BASELINE_STATEMENT_COUNT = 37;
const PHASE_4_EXPECTED_DIALECT_VARIANT_COUNT = 1317;
const PHASE_4_EXPECTED_NAMED_DOLLAR_PARAMETER_STATEMENT_COUNT = 1244;
const PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT = 10;
const PHASE_4_CLASSIFICATION = Object.freeze({
  id: "phase-4-provider-sql-and-migrations",
  scope: "provider-sql-and-migration-contracts",
  owner: "persistence-architecture",
  targetLayer: "provider-neutral dialect and migration contracts with SQLite-owned executable bindings",
  risk: "high",
  transactionContext: "provider-neutral plans with provider-owned execution and rollback semantics",
  transitionException: "PostgreSQL remains a non-executable contract-only fixture without a driver or runtime provider",
  laterPhase: "4",
});
const PHASE_5_POSTGRESQL_FILES = Object.freeze([
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
const PHASE_5_POSTGRESQL_FILE_SET = new Set(PHASE_5_POSTGRESQL_FILES);
const PHASE_5_POSTGRESQL_TEST_FILES = Object.freeze([
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
const PHASE_5_POSTGRESQL_TEST_FILE_SET = new Set(PHASE_5_POSTGRESQL_TEST_FILES);
const SALES_ANALYTICS_PERSISTENCE_SLICE_FILES = Object.freeze([
  "lib/persistence/postgresql/sales-analytics-catalog.js",
  "lib/persistence/postgresql/sales-analytics-schema.js",
  "lib/persistence/repositories/sales-analytics.js",
  "lib/persistence/sqlite/operations/sales-analytics-schema.js",
  "lib/persistence/sqlite/sales-analytics-catalog.js",
  "lib/persistence/statements/sales-analytics.js",
]);
const SALES_ANALYTICS_PERSISTENCE_SLICE_FILE_SET =
  new Set(SALES_ANALYTICS_PERSISTENCE_SLICE_FILES);
const SALES_ANALYTICS_PERSISTENCE_SLICE_TEST_FILES = Object.freeze([
  "test/sales-analytics-persistence-foundation.test.js",
  "test/sales-analytics-production-hardening.test.js",
  "test/sales-analytics-tradefoto-report.test.js",
]);
const SALES_ANALYTICS_PERSISTENCE_SLICE_TEST_FILE_SET =
  new Set(SALES_ANALYTICS_PERSISTENCE_SLICE_TEST_FILES);
const PHASE_5_POSTGRESQL_RUNTIME_FILE_SET = new Set([
  ...PHASE_5_POSTGRESQL_FILES,
  ...SALES_ANALYTICS_PERSISTENCE_SLICE_FILES.filter(
    (file) => file.startsWith("lib/persistence/postgresql/"),
  ),
]);
const SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_IDS = Object.freeze([
  "sales-analytics.profiles.list",
  "sales-analytics.profiles.get",
  "sales-analytics.profile-revisions.get",
  "sales-analytics.profile-revisions.list",
  "sales-analytics.profiles.insert",
  "sales-analytics.profile-revisions.insert",
  "sales-analytics.profiles.activate-revision",
  "sales-analytics.runs.get",
  "sales-analytics.runs.get-by-idempotency-key",
  "sales-analytics.runs.list",
  "sales-analytics.runs.insert",
  "sales-analytics.staging.insert",
  "sales-analytics.staging.list",
  "sales-analytics.staging.purge-expired",
  "sales-analytics.branch-mapping-heads.get",
  "sales-analytics.branch-mapping-revisions.get",
  "sales-analytics.branch-mapping-revisions.list",
  "sales-analytics.branch-mappings.list-active",
  "sales-analytics.branch-mapping-heads.insert",
  "sales-analytics.branch-mapping-revisions.insert",
  "sales-analytics.branch-mapping-heads.activate-revision",
  "sales-analytics.reports.get",
  "sales-analytics.reports.get-by-source-sha256",
  "sales-analytics.reports.list",
  "sales-analytics.reports.insert",
  "sales-analytics.report-product-group-metrics.insert",
  "sales-analytics.report-product-group-metrics.list",
  "sales-analytics.report-total-metrics.insert",
  "sales-analytics.report-total-metrics.list",
]);
const SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_COUNT =
  SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_IDS.length;
const SALES_ANALYTICS_EXPECTED_SCHEMA_STATEMENT_IDS = Object.freeze([
  "profiles",
  "profile-revisions",
  "profiles-active-revision-fk",
  "runs",
  "runs-profile-index",
  "staging",
  "staging-expiry-index",
  "branch-mapping-heads",
  "branch-mapping-revisions",
  "branch-mapping-active-revision-fk",
  "branch-mapping-location-index",
  "aggregate-reports",
  "aggregate-reports-location-index",
  "report-product-group-metrics",
  "report-product-group-metrics-index",
  "report-total-metrics",
  "immutable-function",
  "profile-revisions-no-update",
  "runs-no-update",
  "staging-no-update",
  "branch-revisions-no-update",
  "aggregate-reports-no-update",
  "report-product-group-metrics-no-update",
  "report-total-metrics-no-update",
]);
const SALES_ANALYTICS_EXPECTED_SCHEMA_STATEMENT_COUNT =
  SALES_ANALYTICS_EXPECTED_SCHEMA_STATEMENT_IDS.length;
const PHASE_5_EXPECTED_COMPILER_VERSION = 2;
const PHASE_5_EXPECTED_PORTABLE_DIALECT_COUNT = 1239;
const PHASE_5_EXPECTED_OVERRIDE_DIALECT_COUNT = 115;
const PHASE_5_EXPECTED_UI_PREFERENCES_STATEMENT_IDS = Object.freeze([
  "ui-preferences.list-by-employee",
  "ui-preferences.get",
  "ui-preferences.upsert",
  "ui-preferences.delete",
]);
const PHASE_5_EXPECTED_UI_PREFERENCES_STATEMENT_COUNT =
  PHASE_5_EXPECTED_UI_PREFERENCES_STATEMENT_IDS.length;
const PHASE_5_EXPECTED_PLANNING_SETTINGS_STATEMENT_IDS = Object.freeze([
  "planning-settings.settings.list",
  "planning-settings.settings.upsert",
]);
const PHASE_5_EXPECTED_PLANNING_SETTINGS_STATEMENT_COUNT =
  PHASE_5_EXPECTED_PLANNING_SETTINGS_STATEMENT_IDS.length;
const PHASE_5_EXPECTED_ORGANIZATION_DEPARTMENTS_STATEMENT_IDS = Object.freeze([
  "organization-personnel.department.list",
  "organization-personnel.department.insert",
]);
const PHASE_5_EXPECTED_ORGANIZATION_DEPARTMENTS_STATEMENT_COUNT =
  PHASE_5_EXPECTED_ORGANIZATION_DEPARTMENTS_STATEMENT_IDS.length;
const PHASE_5_EXPECTED_SYSTEM_CENTER_METRICS_STATEMENT_IDS = Object.freeze([
  "system-center-metrics.oldest-interval-keys",
]);
const PHASE_5_EXPECTED_SYSTEM_CENTER_METRICS_STATEMENT_COUNT =
  PHASE_5_EXPECTED_SYSTEM_CENTER_METRICS_STATEMENT_IDS.length;
const PHASE_5_EXPECTED_DEVELOPMENT_SLICE_STATEMENT_COUNT =
  PHASE_5_EXPECTED_UI_PREFERENCES_STATEMENT_COUNT
  + PHASE_5_EXPECTED_PLANNING_SETTINGS_STATEMENT_COUNT
  + PHASE_5_EXPECTED_ORGANIZATION_DEPARTMENTS_STATEMENT_COUNT
  + PHASE_5_EXPECTED_SYSTEM_CENTER_METRICS_STATEMENT_COUNT
  + SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_COUNT;
const PHASE_5_ALLOWED_DEPENDENCIES = Object.freeze(["pg"]);
const PHASE_5_POSTGRESQL_DRIVER_FILES = Object.freeze([
  "lib/persistence/postgresql/pool.js",
]);
const PHASE_5_POSTGRESQL_DRIVER_FILE_SET = new Set(PHASE_5_POSTGRESQL_DRIVER_FILES);
const PHASE_5_CLASSIFICATION = Object.freeze({
  id: "phase-5-postgresql-non-production",
  scope: "postgresql-non-production-provider",
  owner: "persistence-architecture",
  targetLayer: "explicitly gated PostgreSQL provider, pool policy and fail-closed dialect compiler",
  risk: "critical",
  transactionContext: "pooled client per operation with provider-bound concurrent transaction executors",
  transitionException: "PostgreSQL is executable only through the development-contract gate and remains absent from server.js",
  laterPhase: "5",
});
const SALES_ANALYTICS_PERSISTENCE_CLASSIFICATION = Object.freeze({
  id: "sales-analytics-persistence-pdf-import",
  scope: "sales-analytics-sqlite-application-and-postgresql-development-slice",
  owner: "sales-analytics-and-persistence-architecture",
  targetLayer: "application-wired SQLite PDF-report persistence with provider-neutral contracts",
  risk: "critical",
  transactionContext: "explicit repository transactions in the application catalog; PostgreSQL remains separately gated",
  transitionException: "SQLite application wiring is active only for confirmed aggregate PDF reports; PostgreSQL remains a development contract",
  laterPhase: "sales-analytics-pdf-import",
});
const PHASE_6_POSTGRESQL_OPERATIONS_FILES = Object.freeze([
  "lib/backup-bundle.js",
  "lib/persistence/operations/contract.js",
  "lib/persistence/operations/mutation-quiesce.js",
  "lib/persistence/operations/recovery-assurance.js",
  "lib/persistence/postgresql/operations/backup.js",
  "lib/persistence/postgresql/operations/evidence.js",
  "lib/persistence/postgresql/operations/monitor.js",
  "lib/persistence/postgresql/operations/recovery-assurance.js",
  "lib/persistence/postgresql/operations/restore.js",
  "lib/persistence/postgresql/operations/snapshot.js",
  "lib/persistence/postgresql/operations/tools.js",
]);
const PHASE_6_POSTGRESQL_OPERATIONS_FILE_SET =
  new Set(PHASE_6_POSTGRESQL_OPERATIONS_FILES);
const PHASE_6_POSTGRESQL_OPERATIONS_TEST_FILES = Object.freeze([
  "test/v087-database-block6-backup-bundle.test.js",
  "test/v087-database-block6-mutation-quiesce.test.js",
  "test/v087-database-block6-no-cutover.test.js",
  "test/v087-database-block6-operations-contract.test.js",
  "test/v087-database-block6-postgresql-backup.test.js",
  "test/v087-database-block6-postgresql-evidence.test.js",
  "test/v087-database-block6-postgresql-monitoring.test.js",
  "test/v087-database-block6-postgresql-restore-live.test.js",
  "test/v087-database-block6-postgresql-restore.test.js",
  "test/v087-database-block6-postgresql-snapshot.test.js",
  "test/v087-database-block6-postgresql-tools.test.js",
  "test/v087-database-block6-recovery-assurance.test.js",
]);
const PHASE_6_POSTGRESQL_OPERATIONS_TEST_FILE_SET =
  new Set(PHASE_6_POSTGRESQL_OPERATIONS_TEST_FILES);
const PHASE_6_CLASSIFICATION = Object.freeze({
  id: "phase-6-postgresql-operations-non-production",
  scope: "postgresql-non-production-operations",
  owner: "persistence-and-recovery-architecture",
  targetLayer: "provider-bound backup, isolated restore, evidence, monitoring and recovery-assurance contracts",
  risk: "critical",
  transactionContext: "exported PostgreSQL snapshot and isolated empty-target restore without product cutover",
  transitionException: "development-contract operations foundation only; absent from server.js and the configured product provider list",
  laterPhase: "6",
});

const PRODUCTION_DIRECT_GROUPS = Object.freeze([
  Object.freeze({
    id: "scoped-crm-maintenance-import",
    files: Object.freeze(["scripts/import-tradefoto-crm.cjs"]),
    scope: "explicit-customer-import-maintenance",
    owner: "crm-and-import",
    targetLayer: "existing SQLite provider and audited source/CRM repositories",
    risk: "high",
    transactionContext: "bounded source apply and atomic CRM/source-binding writes; resumable review notes",
    transitionException: "only connection PRAGMAs are raw; customer writes use existing named statements, source hash and confirmed plan",
    laterPhase: "customer-import-ui",
  }),
  Object.freeze({
    id: "application-monolith",
    files: Object.freeze(["server.js"]),
    scope: "product-runtime",
    owner: "application-and-schema",
    targetLayer: "domain repositories, migration runner, SQLite runtime and operations adapters",
    risk: "critical",
    transactionContext: "many manual transaction boundaries mixed with request and migration logic",
    transitionException: "existing coupling is frozen as the Phase-1 baseline; no new raw access is allowed",
    laterPhase: "3-4",
  }),
  Object.freeze({
    id: "domain-sql-stores",
    files: Object.freeze([
      "lib/collective-agreements.js",
      "lib/governance-store.js",
      "lib/system-center-metrics.js",
      "lib/work-rules/custom-rules.js",
      "lib/work-rules/governance.js",
      "lib/work-rules/store.js",
    ]),
    scope: "product-runtime",
    owner: "domain-persistence",
    targetLayer: "domain repositories using only a transaction-bound persistence executor",
    risk: "high",
    transactionContext: "raw database handles and manual BEGIN/COMMIT/ROLLBACK in selected stores",
    transitionException: "existing injected SQLite handles remain until their vertical slice is migrated",
    laterPhase: "3-4",
  }),
  Object.freeze({
    id: "sqlite-runtime-operations",
    files: Object.freeze([
      "backup.js",
      "lib/database-lock.js",
    ]),
    scope: "product-operations",
    owner: "backup-locking",
    targetLayer: "provider-specific database operations and maintenance lease adapters",
    risk: "critical",
    transactionContext: "SQLite snapshot and exclusive lock semantics",
    transitionException: "SQLite backup-v1 and lock behavior remain unchanged and verifiable",
    laterPhase: "3-6",
  }),
  Object.freeze({
    id: "historical-source-import",
    files: Object.freeze(["lib/f18-loan-migration.js"]),
    scope: "compatibility-import",
    owner: "f18-import",
    targetLayer: "explicit SQLite source-format adapter outside the application database provider",
    risk: "medium",
    transactionContext: "read-only foreign database inspection",
    transitionException: "the historical F18 source format remains SQLite-specific",
    laterPhase: "4-5",
  }),
  Object.freeze({
    id: "development-sqlite-tools",
    files: Object.freeze([
      "scripts/cleanup-branch-order-test-data.js",
      "scripts/codespaces-runner.js",
      "scripts/set-developer.js",
    ]),
    scope: "development-tooling",
    owner: "development-environment",
    targetLayer: "provider-specific development profiles and administrative CLI",
    risk: "medium",
    transactionContext: "offline or disposable SQLite database mutation",
    transitionException: "Codespaces stays the SQLite reference profile in the current phases",
    laterPhase: "3-5",
  }),
  Object.freeze({
    id: "linux-server-operations",
    files: Object.freeze([
      "server-tools/linux/grabenplaner-bootstrap-admin.sh.in",
      "server-tools/linux/install-grabenplaner-server.sh",
      "server-tools/linux/lib/backup-snapshot.js",
      "server-tools/linux/lib/restore-backup.js",
      "server-tools/linux/lib/verify-backup.js",
      "server-tools/linux/migrate-grabenplaner-runtime-v2.sh",
      "server-tools/linux/migrate-grabenplaner-runtime-v3.sh",
      "server-tools/linux/migrate-grabenplaner-runtime-v4.sh",
      "server-tools/linux/migrate-grabenplaner-runtime-v5.sh",
      "server-tools/linux/monitor/lib/monitor-status.js",
      "server-tools/linux/offsite/lib/application-smoke.js",
      "server-tools/linux/recovery/lib/recovery-apply.js",
      "server-tools/linux/recovery/lib/recovery-verify.js",
      "server-tools/linux/test-grabenplaner-server.sh",
    ]),
    scope: "supported-linux-server-operations",
    owner: "managed-server-operations",
    targetLayer: "provider-specific snapshot, restore, verification, recovery and bootstrap adapters",
    risk: "critical",
    transactionContext: "offline snapshots, integrity checks and controlled file replacement",
    transitionException: "the complete SQLite operating path remains supported until a separate PostgreSQL path passes all gates",
    laterPhase: "3-6",
  }),
  Object.freeze({
    id: "windows-server-operations",
    files: Object.freeze([
      "server-tools/windows/Backup-Grabenplaner.ps1",
      "server-tools/windows/Restore-Grabenplaner.ps1",
      "server-tools/windows/Test-GrabenplanerServer.ps1",
    ]),
    scope: "managed-windows-server-operations",
    owner: "managed-server-operations",
    targetLayer: "provider-specific Windows server operations or an explicitly limited platform matrix",
    risk: "critical",
    transactionContext: "offline SQLite snapshot, integrity and file restore",
    transitionException: "Windows server tooling is not classified as Portable Legacy; its support boundary must be reconciled before PostgreSQL support",
    laterPhase: "3-6",
  }),
  Object.freeze({
    id: "portable-usb-legacy",
    files: Object.freeze([
      "lib/usb-profile-database.js",
      "scripts/initialize-portable-db.js",
    ]),
    scope: "portable-usb-legacy",
    owner: "legacy-delivery",
    targetLayer: "frozen SQLite-only legacy boundary, later separated from the server artifact",
    risk: "legacy",
    transactionContext: "offline SQLite copy and repair",
    transitionException: "no PostgreSQL port; preserve only the frozen Legacy compatibility contract",
    laterPhase: "separate legacy cleanup",
  }),
]);

const PRODUCTION_INDIRECT_GROUPS = Object.freeze([
  Object.freeze({
    id: "isolated-full-source-measurement",
    files: Object.freeze(["scripts/verify-tradefoto-full-import.mjs"]),
    scope: "isolated-test-only",
    owner: "import-and-recovery-qualification",
    targetLayer: "managed import runtime and isolated backup measurement with implementation provenance",
    risk: "high",
    transitionException: "only fresh encrypted test databases; source files remain read-only and no production activation",
    laterPhase: "not-applicable",
  }),
  Object.freeze({
    id: "backup-bundle-contract",
    files: Object.freeze([
      "lib/backup-maintenance.js",
      "lib/backup-commit.js",
      "lib/local-backup-archive.js",
      "lib/background-backup-process.js",
      "lib/backup-workspace.js",
      "lib/backup-recovery-keys.js",
      "scripts/manage-local-backup-archive.js",
      "scripts/run-background-backup.js",
      "server-tools/linux/lib/local-backup-archive.js",
      "server-tools/linux/offsite/grabenplaner-offsite-prepare.sh",
    ]),
    scope: "product-operations",
    owner: "backup-contract",
    targetLayer: "versioned provider-neutral backup bundle with provider-specific components",
    risk: "critical",
    transitionException: "SQLite backup schema 1 remains readable and must never be reinterpreted",
    laterPhase: "4-6",
  }),
  Object.freeze({
    id: "runtime-status-and-ui",
    files: Object.freeze([
      "lib/server-monitor-status.js",
      "lib/server-runtime.js",
      "lib/system-trust-index.js",
      "public/app.js",
    ]),
    scope: "product-runtime",
    owner: "system-center-and-readiness",
    targetLayer: "provider-neutral capability and status payload with provider details",
    risk: "high",
    transitionException: "existing SQLite check IDs remain truthful; missing provider evidence must never be reported as green",
    laterPhase: "3-6",
  }),
  Object.freeze({
    id: "function-search-projection",
    files: Object.freeze([
      "public/function-search-catalog.js",
      "public/function-search-navigation.js",
      "public/function-search-ui.js",
      "public/function-search.js",
    ]),
    scope: "product-runtime",
    owner: "navigation-and-access-projection",
    targetLayer: "provider-neutral read-only navigation catalog and permission-gated client search",
    risk: "medium",
    transitionException: "UI target descriptors are navigation metadata only and must not activate a persistence provider or database operation",
    laterPhase: "not-applicable",
  }),
  Object.freeze({
    id: "linux-server-orchestration",
    files: Object.freeze([
      "server-tools/linux/backup-grabenplaner.sh",
      "server-tools/linux/grabenplaner.env.example",
      "server-tools/linux/grabenplaner.service.in",
      "server-tools/linux/host-control/lib/host-reboot-broker.js",
      "server-tools/linux/lib/hold-database-lock.js",
      "server-tools/linux/lib/backup-metadata.js",
      "server-tools/linux/lib/deploy-policy.js",
      "server-tools/linux/lib/prune-backups.js",
      "server-tools/linux/lib/verify-package.js",
      "server-tools/linux/offsite/grabenplaner-offsite-application-smoke.sh",
      "server-tools/linux/offsite/grabenplaner-offsite-assurance.sh",
      "server-tools/linux/offsite/grabenplaner-offsite-restore-test.sh",
      "server-tools/linux/offsite/lib/offsite-restore-verify.js",
      "server-tools/linux/offsite/lib/offsite-stage.js",
      "server-tools/linux/offsite/systemd/grabenplaner-offsite-application-smoke.service.in",
      "server-tools/linux/recovery/grabenplaner-recovery.sh",
      "server-tools/linux/recovery/lib/recovery-metadata.js",
      "server-tools/linux/uninstall-grabenplaner-server.sh",
      "server-tools/linux/update-grabenplaner-server.sh",
    ]),
    scope: "supported-linux-server-operations",
    owner: "managed-server-orchestration",
    targetLayer: "provider-aware orchestration over versioned backup, restore, lock and recovery capabilities",
    risk: "critical",
    transitionException: "current scripts may call only the proven SQLite-v1 operating path",
    laterPhase: "4-6",
  }),
  Object.freeze({
    id: "server-package-boundary",
    files: Object.freeze([
      "server-tools/package/New-GrabenplanerLinuxServerPackage.ps1",
      "server-tools/server.env.example",
    ]),
    scope: "server-build-and-configuration",
    owner: "release-engineering",
    targetLayer: "provider-aware package and secret configuration contract",
    risk: "high",
    transitionException: "database files and secrets remain excluded from packages",
    laterPhase: "4-6",
  }),
  Object.freeze({
    id: "windows-server-orchestration",
    files: Object.freeze([
      "server-tools/windows/Grabenplaner.Service.xml.example",
      "server-tools/windows/Install-GrabenplanerServer.ps1",
      "server-tools/windows/New-GrabenplanerServerPackage.ps1",
      "server-tools/windows/Update-GrabenplanerServer.ps1",
    ]),
    scope: "managed-windows-server-operations",
    owner: "managed-server-orchestration",
    targetLayer: "provider-aware Windows server orchestration or an explicitly limited platform matrix",
    risk: "critical",
    transitionException: "managed Windows server support is an open product boundary, not an implicit Legacy classification",
    laterPhase: "4-6",
  }),
  Object.freeze({
    id: "portable-usb-legacy-surface",
    files: Object.freeze([
      "lib/usb-provisioning.js",
      "public/index.html",
    ]),
    scope: "portable-usb-legacy",
    owner: "legacy-delivery",
    targetLayer: "separate frozen Legacy artifact",
    risk: "legacy",
    transitionException: "the current server tree still exposes Legacy code; no PostgreSQL port is allowed",
    laterPhase: "separate legacy cleanup",
  }),
]);

const BASELINE_TEST_FILES = Object.freeze([
  "test-support/f18-backup-fixture.js",
  "test/backup-cli.test.js",
  "test/block3-personnel-rules-dashboard.test.js",
  "test/block4-collective-agreement-register.test.js",
  "test/block5-custom-work-rule-editor.test.js",
  "test/block6-custom-work-rule-evaluator.test.js",
  "test/block6-work-rule-governance.test.js",
  "test/block7-personnel-rules-completion.test.js",
  "test/database-lock.test.js",
  "test/developer-role.test.js",
  "test/portal-foundation.test.js",
  "test/v053-time-corrections.test.js",
  "test/v055-time-evaluation.test.js",
  "test/v056-wifi-foundation.test.js",
  "test/v057-codespaces-demo.test.js",
  "test/v057-wifi-automation.test.js",
  "test/v058-personnel-rights-encryption.test.js",
  "test/v059-sickness-integration.test.js",
  "test/v060-portal-mobile-foundation.test.js",
  "test/v0611-installation-features.test.js",
  "test/v0611-usb-profile-database.test.js",
  "test/v062-mobile-native-auth.test.js",
  "test/v063-import-payroll.test.js",
  "test/v064-connectors-server.test.js",
  "test/v066-rights-dashboard.test.js",
  "test/v067-process-dashboard.test.js",
  "test/v068-dashboard-validation.test.js",
  "test/v069-integration-contracts.test.js",
  "test/v071-aum-routing.test.js",
  "test/v071-cost-centers-personnel.test.js",
  "test/v071-custom-processes-notifications.test.js",
  "test/v071-dashboard-center.test.js",
  "test/v071-extended-personnel-records.test.js",
  "test/v071-page-appearance.test.js",
  "test/v071-personnel-field-rights.test.js",
  "test/v071-shift-locations.test.js",
  "test/v071-vacation-governance.test.js",
  "test/v072-production-bootstrap.test.js",
  "test/v074-linux-recovery-compatibility.test.js",
  "test/v074-linux-recovery-verify.test.js",
  "test/v077-system-center-api.test.js",
  "test/v078-linux-assurance-automation.test.js",
  "test/v078-system-center-metrics.test.js",
  "test/v079-mobile-absence-api.test.js",
  "test/v080-revocable-role-rights.test.js",
  "test/v081-work-rule-integration.test.js",
  "test/v081-work-rule-safety-regressions.test.js",
  "test/v082-governance-api.test.js",
  "test/v082-governance-recovery-assurance.test.js",
  "test/v082-immutable-trigger-migration.test.js",
  "test/v083-payroll-handoff-recovery.test.js",
  "test/v083-payroll-handoffs.test.js",
  "test/v084-product-readiness.test.js",
  "test/v085-loan-foundation.test.js",
  "test/v0853-offsite-system-center.test.js",
  "test/v0862-local-backup-compat.test.js",
  "test/v0862-server-backup-download.test.js",
  "test/v0863-location-planner.test.js",
  "test/v087-block4-loan-overview.test.js",
  "test/v087-block4-organization-accounts.test.js",
  "test/v087-block5-loan-photo-appendix.test.js",
  "test/v087-block5-loan-photo-migration.test.js",
  "test/v087-block6-work-rule-panel-state.test.js",
  "test/v087-block7-settings-appearance.test.js",
  "test/v087-block8-cost-center-migration.test.js",
  "test/v087-cost-center-types.test.js",
  "test/v087-employee-cost-center-assignment.test.js",
  "test/v087-mobile-portal-personalization.test.js",
  "test/v087-pl-plus-functional-rights.test.js",
  "test/v0885-weekly-hours.test.js",
  "test/v0885-past-week-user-preference.test.js",
  "test/v09210-team-meetings.test.js",
  "test/work-rule-store.test.js",
]);

const TEST_SPECIAL_GROUPS = Object.freeze({
  "deployment-operations-verification": new Set([
    "test/deploy-startup.test.js",
    "test/deploy-workflow.test.js",
    "test/v074-linux-monitor-status.test.js",
  ]),
  "portal-ui-preferences-integration": new Set([
    "test/v087-mobile-portal-personalization.test.js",
    "test/v0885-past-week-user-preference.test.js",
  ]),
  "historical-sqlite-fixture": new Set([
    "test-support/f18-backup-fixture.js",
    "test/portal-foundation.test.js",
    "test/v053-time-corrections.test.js",
    "test/v058-personnel-rights-encryption.test.js",
    "test/v063-import-payroll.test.js",
    "test/v071-cost-centers-personnel.test.js",
    "test/v071-shift-locations.test.js",
    "test/v082-immutable-trigger-migration.test.js",
    "test/v087-block5-loan-photo-migration.test.js",
    "test/v087-block7-settings-appearance.test.js",
    "test/v087-block8-cost-center-migration.test.js",
  ]),
  "sqlite-operations-verification": new Set([
    "test/backup-cli.test.js",
    "test/database-lock.test.js",
    "test/developer-role.test.js",
    "test/v057-codespaces-demo.test.js",
    "test/v0611-installation-features.test.js",
    "test/v072-production-bootstrap.test.js",
    "test/v074-linux-recovery-compatibility.test.js",
    "test/v074-linux-recovery-verify.test.js",
    "test/v078-linux-assurance-automation.test.js",
    "test/v082-governance-recovery-assurance.test.js",
    "test/v083-payroll-handoff-recovery.test.js",
    "test/v0853-offsite-system-center.test.js",
    "test/v0862-local-backup-compat.test.js",
    "test/v0862-server-backup-download.test.js",
  ]),
  "sqlite-store-unit": new Set([
    "test/block6-custom-work-rule-evaluator.test.js",
    "test/v078-system-center-metrics.test.js",
    "test/work-rule-store.test.js",
  ]),
  "portable-usb-legacy-test": new Set([
    "test/v0611-usb-profile-database.test.js",
  ]),
});

const BASELINE_DIRECT_PRODUCTION_DRIVER_FILES = Object.freeze([
  "backup.js",
  "lib/database-lock.js",
  "lib/f18-loan-migration.js",
  "lib/usb-profile-database.js",
  "scripts/codespaces-runner.js",
  "scripts/set-developer.js",
  "server-tools/linux/grabenplaner-bootstrap-admin.sh.in",
  "server-tools/linux/install-grabenplaner-server.sh",
  "server-tools/linux/lib/backup-snapshot.js",
  "server-tools/linux/lib/restore-backup.js",
  "server-tools/linux/lib/verify-backup.js",
  "server-tools/linux/migrate-grabenplaner-runtime-v2.sh",
  "server-tools/linux/offsite/lib/application-smoke.js",
  "server-tools/linux/recovery/lib/recovery-apply.js",
  "server-tools/linux/recovery/lib/recovery-verify.js",
  "server-tools/linux/test-grabenplaner-server.sh",
  "server-tools/windows/Backup-Grabenplaner.ps1",
  "server-tools/windows/Restore-Grabenplaner.ps1",
  "server-tools/windows/Test-GrabenplanerServer.ps1",
  "server.js",
]);

const BASELINE_DIRECT_TEST_DRIVER_FILES = Object.freeze([
  "test-support/f18-backup-fixture.js",
  "test/backup-cli.test.js",
  "test/block6-custom-work-rule-evaluator.test.js",
  "test/database-lock.test.js",
  "test/developer-role.test.js",
  "test/portal-foundation.test.js",
  "test/v053-time-corrections.test.js",
  "test/v057-codespaces-demo.test.js",
  "test/v058-personnel-rights-encryption.test.js",
  "test/v0611-usb-profile-database.test.js",
  "test/v063-import-payroll.test.js",
  "test/v071-cost-centers-personnel.test.js",
  "test/v071-shift-locations.test.js",
  "test/v072-production-bootstrap.test.js",
  "test/v074-linux-recovery-compatibility.test.js",
  "test/v074-linux-recovery-verify.test.js",
  "test/v078-linux-assurance-automation.test.js",
  "test/v078-system-center-metrics.test.js",
  "test/v082-governance-recovery-assurance.test.js",
  "test/v082-immutable-trigger-migration.test.js",
  "test/v083-payroll-handoff-recovery.test.js",
  "test/v0862-server-backup-download.test.js",
  "test/v087-block5-loan-photo-migration.test.js",
  "test/v087-block7-settings-appearance.test.js",
  "test/v087-block8-cost-center-migration.test.js",
  "test/work-rule-store.test.js",
]);
const MANAGED_LINUX_SQLITE_COMPATIBILITY_DRIVER_FILES = Object.freeze([
  "server-tools/linux/migrate-grabenplaner-runtime-v3.sh",
]);
const PHASE_3_ALLOWED_PRODUCTION_DRIVER_FILES = Object.freeze([
  ...BASELINE_DIRECT_PRODUCTION_DRIVER_FILES.filter((file) => file !== "server.js"),
  ...PHASE_3_SQLITE_DRIVER_FILES,
  ...MANAGED_LINUX_SQLITE_COMPATIBILITY_DRIVER_FILES,
  "scripts/cleanup-branch-order-test-data.js",
]);
const PHASE_3_ALLOWED_TEST_DRIVER_FILES = Object.freeze([
  "scripts/benchmark-cash-assigned-search.js",
  "test/sales-article-catalog-search.test.js",
  "scripts/benchmark-sales-search.js",
  "test/cash-publication-integration.test.js",
  "test-support/cash-history-snapshot-prototype.js",
  "test/data-import-state-counts.test.js",
  ...BASELINE_DIRECT_TEST_DRIVER_FILES.filter((file) => ![
    "test/block6-custom-work-rule-evaluator.test.js",
    "test/work-rule-store.test.js",
  ].includes(file)),
  "test/personnel-workflow-lifecycle-onboarding-schema.test.js",
  "test/v092-branch-order-cleanup-cli.test.js",
]);
const SQLITE_MAINTENANCE_CLI_FILES = new Set([
  "scripts/cleanup-branch-order-test-data.js",
]);
const SIGNALS = Object.freeze([
  { id: "directNodeSqliteImport", operation: "driver import", sqliteFeature: "node:sqlite", directDiscovery: true },
  { id: "prepareCall", pattern: String.raw`\.prepare\s*\(`, flags: "g", operation: "prepared statement", sqliteFeature: "synchronous statement API", directDiscovery: true },
  { id: "execCall", pattern: String.raw`\.exec\s*\(`, flags: "g", operation: "raw execution candidate", sqliteFeature: "synchronous execution API" },
  { id: "beginImmediate", pattern: String.raw`\bBEGIN\s+IMMEDIATE\b`, flags: "gi", operation: "transaction begin", sqliteFeature: "BEGIN IMMEDIATE", directDiscovery: true },
  { id: "beginExclusive", pattern: String.raw`\bBEGIN\s+EXCLUSIVE\b`, flags: "gi", operation: "transaction begin", sqliteFeature: "BEGIN EXCLUSIVE", directDiscovery: true },
  { id: "pragma", pattern: String.raw`\bPRAGMA\b`, flags: "gi", operation: "engine control or inspection", sqliteFeature: "PRAGMA", directDiscovery: true },
  { id: "insertOrIgnore", pattern: String.raw`\bINSERT\s+OR\s+IGNORE\b`, flags: "gi", operation: "mutation", sqliteFeature: "INSERT OR IGNORE", directDiscovery: true },
  { id: "insertOrReplace", pattern: String.raw`\bINSERT\s+OR\s+REPLACE\b`, flags: "gi", operation: "mutation", sqliteFeature: "INSERT OR REPLACE", directDiscovery: true },
  { id: "onConflict", pattern: String.raw`\bON\s+CONFLICT\b`, flags: "gi", operation: "mutation", sqliteFeature: "SQLite upsert syntax" },
  { id: "raiseAbort", pattern: String.raw`\bRAISE\s*\(\s*ABORT\b`, flags: "gi", operation: "constraint enforcement", sqliteFeature: "trigger RAISE(ABORT)" },
  { id: "autoincrement", pattern: String.raw`\bAUTOINCREMENT\b`, flags: "gi", operation: "schema definition", sqliteFeature: "AUTOINCREMENT" },
  { id: "collateNocase", pattern: String.raw`\bCOLLATE\s+NOCASE\b`, flags: "gi", operation: "comparison", sqliteFeature: "COLLATE NOCASE" },
  { id: "julianday", pattern: String.raw`\bjulianday\s*\(`, flags: "gi", operation: "date calculation", sqliteFeature: "julianday()" },
  { id: "globOperator", pattern: String.raw`\bGLOB\b`, flags: "g", operation: "comparison", sqliteFeature: "GLOB" },
  { id: "vacuumInto", pattern: String.raw`\bVACUUM\s+INTO\b`, flags: "gi", operation: "snapshot", sqliteFeature: "VACUUM INTO", directDiscovery: true },
  { id: "quickCheck", pattern: String.raw`\bquick_check\b`, flags: "gi", operation: "integrity check", sqliteFeature: "PRAGMA quick_check", directDiscovery: true },
  { id: "foreignKeyCheck", pattern: String.raw`\bforeign_key_check\b`, flags: "gi", operation: "integrity check", sqliteFeature: "PRAGMA foreign_key_check" },
  { id: "walCheckpoint", pattern: String.raw`\bwal_checkpoint\b`, flags: "gi", operation: "shutdown maintenance", sqliteFeature: "WAL checkpoint" },
  { id: "lastInsertRowid", pattern: String.raw`\blastInsertRowid\b`, flags: "g", operation: "generated key", sqliteFeature: "lastInsertRowid", directDiscovery: true },
  { id: "sqliteCatalog", pattern: String.raw`\bsqlite_(?:master|schema|sequence)\b|\bpragma_table_info\s*\(`, flags: "gi", operation: "schema inspection", sqliteFeature: "SQLite catalog", directDiscovery: true },
  { id: "schemaMigrations", pattern: String.raw`\bschema_migrations\b`, flags: "g", operation: "migration state", sqliteFeature: "application migration ledger" },
  { id: "ensureColumn", pattern: String.raw`\bensureColumn\s*\(`, flags: "g", operation: "schema migration", sqliteFeature: "PRAGMA table_info plus ALTER TABLE" },
  { id: "createTable", pattern: String.raw`\bCREATE\s+TABLE\b`, flags: "gi", operation: "schema definition", sqliteFeature: "DDL" },
  { id: "createTriggerDdl", pattern: String.raw`^\s*CREATE\s+TRIGGER\b`, flags: "gim", operation: "schema definition", sqliteFeature: "SQLite trigger" },
  { id: "createIndex", pattern: String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\b`, flags: "gi", operation: "schema definition", sqliteFeature: "index DDL" },
  { id: "alterTable", pattern: String.raw`\bALTER\s+TABLE\b`, flags: "gi", operation: "schema migration", sqliteFeature: "ALTER TABLE" },
  { id: "migrationIdDeclaration", pattern: String.raw`\b(?:const|let|var)\s+\w*MigrationId\s*=`, flags: "g", operation: "migration identity", sqliteFeature: "migration marker" },
  { id: "dbPathConfig", pattern: String.raw`\bDB_PATH\b`, flags: "g", operation: "configuration", sqliteFeature: "database file path", indirectDiscovery: true },
  { id: "databasePathReference", pattern: String.raw`\bdatabasePath\b`, flags: "g", operation: "file coupling", sqliteFeature: "database file path", indirectDiscovery: true },
  { id: "sqliteLabel", pattern: String.raw`\bSQLite\b`, flags: "gi", operation: "status or contract", sqliteFeature: "SQLite-specific behavior", indirectDiscovery: true },
  { id: "databaseFileName", pattern: String.raw`\bdienstplan\.db\b`, flags: "gi", operation: "file coupling", sqliteFeature: "fixed SQLite filename", indirectDiscovery: true },
  { id: "databaseManifestField", pattern: String.raw`databaseSha256|database_bytes|\bdatabase_file\b`, flags: "g", operation: "backup or status contract", sqliteFeature: "database-file manifest", indirectDiscovery: true },
]);

const SERVER_DOMAINS = Object.freeze([
  { start: 1, end: 1517, domain: "startup-locking-backup" },
  { start: 1518, end: 6944, domain: "schema-bootstrap-and-migrations" },
  { start: 20916, end: 21490, domain: "integrations-and-payroll" },
  { start: 21547, end: 22825, domain: "backup-restore-and-import" },
  { start: 23226, end: 23618, domain: "privacy-and-time-statements" },
  { start: 23868, end: 25107, domain: "collective-agreements-and-work-rules" },
  { start: 25130, end: 25970, domain: "organization-personnel-and-planning" },
  { start: 25995, end: 29755, domain: "identity-rights-wifi-and-system-center" },
  { start: 30041, end: 32961, domain: "loans-documents-and-photos" },
  { start: 33204, end: 36384, domain: "sickness-amu-and-absence" },
  { start: 36390, end: 36619, domain: "time-recording" },
  { start: 37061, end: 37185, domain: "portable-usb-legacy" },
  { start: 37221, end: 38179, domain: "settings-and-planning" },
  { start: 38184, end: 39718, domain: "product-readiness-pdf-and-shutdown" },
]);

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/");
}

function expandGroups(groups) {
  const entries = new Map();
  const duplicates = [];
  for (const group of groups) {
    for (const file of group.files) {
      const normalized = normalizePath(file);
      if (entries.has(normalized)) duplicates.push(normalized);
      entries.set(normalized, { ...group, files: undefined });
    }
  }
  return { entries, duplicates };
}

function listFiles(root, relativeEntry) {
  const normalized = normalizePath(relativeEntry);
  const absolute = path.join(root, relativeEntry);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return SCANNED_EXTENSIONS.has(path.extname(normalized)) ? [normalized] : [];
  const files = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    files.push(...listFiles(root, path.join(relativeEntry, entry.name)));
  }
  return files;
}

function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return low + 1;
}

function lineSnippet(text, offset) {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const newline = text.indexOf("\n", offset);
  const end = newline === -1 ? text.length : newline;
  return text.slice(start, end).trim().replace(/\s+/g, " ").slice(0, 220);
}

function schemaObject(signalId, snippet) {
  if (signalId === "schemaMigrations") return "schema_migrations";
  if (signalId === "ensureColumn") {
    const match = snippet.match(/ensureColumn\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*["'`]([^"'`]+)["'`]/);
    return match ? `${match[1]}.${match[2]}` : "";
  }
  if (signalId === "createTable") return snippet.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)/i)?.[1] || "";
  if (signalId === "createTriggerDdl") return snippet.match(/CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)/i)?.[1] || "";
  if (signalId === "createIndex") return snippet.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)/i)?.[1] || "";
  if (signalId === "alterTable") return snippet.match(/ALTER\s+TABLE\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)/i)?.[1] || "";
  return "";
}

function serverDomain(line) {
  return SERVER_DOMAINS.find((entry) => line >= entry.start && line <= entry.end)?.domain || "shared-runtime-helpers";
}

function testClassification(file) {
  for (const [id, files] of Object.entries(TEST_SPECIAL_GROUPS)) {
    if (files.has(file)) {
      return {
        id,
        scope: "provider-specific-test",
        owner: id,
        targetLayer: "provider contract, migration or provider-specific operation tests",
        risk: id.includes("legacy") ? "legacy" : "test",
        transactionContext: "fixture-controlled",
        transitionException: "direct SQLite access is limited to the explicitly named test purpose",
        laterPhase: "2-6",
      };
    }
  }
  return {
    id: "domain-integration-raw-sql",
    scope: "provider-specific-test",
    owner: "domain-integration-tests",
    targetLayer: "provider-neutral integration harness with explicitly provider-specific fixtures",
    risk: "test",
    transactionContext: "application-owned or fixture-controlled",
    transitionException: "the named integration test may inspect the current SQLite database until its slice is migrated",
    laterPhase: "2-5",
  };
}

function skipJavaScriptTrivia(text, start) {
  let index = start;
  while (index < text.length) {
    if (/\s/.test(text[index])) {
      index += 1;
      continue;
    }
    if (text[index] === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index + 2);
      return newline < 0 ? text.length : skipJavaScriptTrivia(text, newline + 1);
    }
    if (text[index] === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      return end < 0 ? text.length : skipJavaScriptTrivia(text, end + 2);
    }
    break;
  }
  return index;
}

function readJavaScriptIdentifier(text, start) {
  if (!/[A-Za-z_$]/.test(text[start] || "")) return null;
  let end = start + 1;
  while (/[A-Za-z0-9_$]/.test(text[end] || "")) end += 1;
  return { value: text.slice(start, end), start, end };
}

function readJavaScriptStringLiteral(text, start) {
  const quote = text[start];
  if (!["'", "\"", "`"].includes(quote)) return null;
  if (quote === "`") return readJavaScriptTemplateLiteral(text, start);
  let value = "";
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === quote) return {
      value,
      quote,
      start,
      end: index + 1,
    };
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escaped = text[index + 1];
    if (escaped === undefined) return null;
    if (escaped === "\n" || escaped === "\r") {
      index += escaped === "\r" && text[index + 2] === "\n" ? 2 : 1;
      continue;
    }
    const simpleEscapes = {
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "0": "\0",
    };
    if (Object.hasOwn(simpleEscapes, escaped)) {
      value += simpleEscapes[escaped];
      index += 1;
      continue;
    }
    if (escaped === "x" && /^[0-9A-Fa-f]{2}$/.test(text.slice(index + 2, index + 4))) {
      value += String.fromCodePoint(Number.parseInt(text.slice(index + 2, index + 4), 16));
      index += 3;
      continue;
    }
    if (escaped === "u") {
      const braced = /^\{([0-9A-Fa-f]{1,6})\}/.exec(text.slice(index + 2));
      const fixed = /^[0-9A-Fa-f]{4}/.exec(text.slice(index + 2));
      const hex = braced?.[1] || fixed?.[0];
      if (hex) {
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        index += braced ? braced[0].length + 1 : 5;
        continue;
      }
    }
    value += escaped;
    index += 1;
  }
  return null;
}

function previousJavaScriptToken(text, start) {
  let index = start - 1;
  while (index >= 0 && /\s/.test(text[index])) index -= 1;
  if (index < 0) return "";
  if (/[A-Za-z0-9_$]/.test(text[index])) {
    let begin = index;
    while (begin > 0 && /[A-Za-z0-9_$]/.test(text[begin - 1])) begin -= 1;
    return text.slice(begin, index + 1);
  }
  return text[index];
}

function readJavaScriptRegexLiteral(text, start) {
  if (text[start] !== "/" || ["/", "*"].includes(text[start + 1])) return null;
  const previous = previousJavaScriptToken(text, start);
  const expressionPrefixes = new Set([
    "", "(", "[", "{", ",", ";", ":", "=", "!", "?", "&", "|", "+", "-", "*", "%", "^", "~", "<", ">",
    "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of", "return", "throw", "typeof", "void", "yield",
  ]);
  if (!expressionPrefixes.has(previous)) return null;
  let inCharacterClass = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\n" || character === "\r") return null;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (character === "/" && !inCharacterClass) {
      let end = index + 1;
      while (/[A-Za-z]/.test(text[end] || "")) end += 1;
      return { start, end };
    }
  }
  return null;
}

function templateExpressionEnd(text, start) {
  let depth = 1;
  let index = start;
  while (index < text.length) {
    index = skipJavaScriptTrivia(text, index);
    const literal = readJavaScriptStringLiteral(text, index);
    if (literal) {
      index = literal.end;
      continue;
    }
    const regexLiteral = readJavaScriptRegexLiteral(text, index);
    if (regexLiteral) {
      index = regexLiteral.end;
      continue;
    }
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

function readJavaScriptTemplateLiteral(text, start) {
  if (text[start] !== "`") return null;
  const expressions = [];
  let value = "";
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === "`") {
      return {
        value: expressions.length ? null : value,
        source: text.slice(start + 1, index),
        expressions,
        quote: "`",
        start,
        end: index + 1,
      };
    }
    if (character === "$" && text[index + 1] === "{") {
      const expressionStart = index + 2;
      const expressionEnd = templateExpressionEnd(text, expressionStart);
      if (expressionEnd < 0) return null;
      expressions.push({ start: expressionStart, end: expressionEnd });
      index = expressionEnd;
      continue;
    }
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escaped = text[index + 1];
    if (escaped === undefined) return null;
    if (escaped === "\n" || escaped === "\r") {
      index += escaped === "\r" && text[index + 2] === "\n" ? 2 : 1;
      continue;
    }
    value += escaped;
    index += 1;
  }
  return null;
}

function readStaticJavaScriptStringExpression(text, start) {
  const first = readJavaScriptStringLiteral(text, skipJavaScriptTrivia(text, start));
  if (!first || typeof first.value !== "string") return null;
  let value = first.value;
  let end = first.end;
  while (true) {
    const operator = skipJavaScriptTrivia(text, end);
    if (text[operator] !== "+") return { value, start: first.start, end };
    const next = readJavaScriptStringLiteral(
      text,
      skipJavaScriptTrivia(text, operator + 1),
    );
    if (!next || typeof next.value !== "string") {
      return { value: null, start: first.start, end: next?.end || operator + 1 };
    }
    value += next.value;
    end = next.end;
  }
}

function javaScriptCallOpeningParen(text, start, allowOptional = false) {
  let index = skipJavaScriptTrivia(text, start);
  if (text[index] === "(") return index;
  if (!allowOptional || text.slice(index, index + 2) !== "?.") return -1;
  index = skipJavaScriptTrivia(text, index + 2);
  return text[index] === "(" ? index : -1;
}

function javaScriptRequireAliases(text) {
  const assignments = [];
  let index = 0;
  while (index < text.length) {
    index = skipJavaScriptTrivia(text, index);
    const regexLiteral = readJavaScriptRegexLiteral(text, index);
    if (regexLiteral) {
      index = regexLiteral.end;
      continue;
    }
    const literal = readJavaScriptStringLiteral(text, index);
    if (literal) {
      index = literal.end;
      continue;
    }
    const declaration = readJavaScriptIdentifier(text, index);
    if (!declaration) {
      index += 1;
      continue;
    }
    index = declaration.end;
    if (!["const", "let", "var"].includes(declaration.value)) continue;
    const alias = readJavaScriptIdentifier(text, skipJavaScriptTrivia(text, index));
    if (!alias) continue;
    let cursor = skipJavaScriptTrivia(text, alias.end);
    if (text[cursor] !== "=") continue;
    const source = readJavaScriptIdentifier(text, skipJavaScriptTrivia(text, cursor + 1));
    if (!source) continue;
    cursor = skipJavaScriptTrivia(text, source.end);
    if (source.value === "createRequire"
      && javaScriptCallOpeningParen(text, source.end, true) >= 0) {
      assignments.push({ alias: alias.value, source: "require" });
      index = source.end;
      continue;
    }
    if (![";", ",", "\n", "\r", ")"].includes(text[cursor] || ";")) continue;
    assignments.push({ alias: alias.value, source: source.value });
    index = source.end;
  }
  const aliases = new Set(["require"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const assignment of assignments) {
      if (aliases.has(assignment.source) && !aliases.has(assignment.alias)) {
        aliases.add(assignment.alias);
        changed = true;
      }
    }
  }
  return aliases;
}

function javaScriptNamedCallSites(text, names, baseOffset = 0) {
  const calls = [];
  let index = 0;
  while (index < text.length) {
    index = skipJavaScriptTrivia(text, index);
    const regexLiteral = readJavaScriptRegexLiteral(text, index);
    if (regexLiteral) {
      index = regexLiteral.end;
      continue;
    }
    const literal = readJavaScriptStringLiteral(text, index);
    if (literal) {
      for (const expression of literal.expressions || []) {
        calls.push(...javaScriptNamedCallSites(
          text.slice(expression.start, expression.end),
          names,
          baseOffset + expression.start,
        ));
      }
      index = literal.end;
      continue;
    }
    const identifier = readJavaScriptIdentifier(text, index);
    if (!identifier) {
      index += 1;
      continue;
    }
    const openingParen = javaScriptCallOpeningParen(text, identifier.end, true);
    if (names.has(identifier.value) && openingParen >= 0) {
      calls.push({
        name: identifier.value,
        index: baseOffset + identifier.start,
        openingParen: baseOffset + openingParen,
      });
    }
    index = identifier.end;
  }
  return calls;
}

function moduleSpecifierAfterFrom(text, start) {
  const limit = Math.min(text.length, start + 4000);
  let index = start;
  while (index < limit) {
    index = skipJavaScriptTrivia(text, index);
    if (text[index] === ";") return null;
    const literal = readJavaScriptStringLiteral(text, index);
    if (literal) {
      index = literal.end;
      continue;
    }
    const identifier = readJavaScriptIdentifier(text, index);
    if (identifier) {
      if (identifier.value === "from") {
        const specifier = readJavaScriptStringLiteral(
          text,
          skipJavaScriptTrivia(text, identifier.end),
        );
        return specifier || null;
      }
      index = identifier.end;
      continue;
    }
    index += 1;
  }
  return null;
}

function staticModuleImportIndices(text, matchesSpecifier) {
  const indices = [];
  const requireAliases = javaScriptRequireAliases(text);
  let index = 0;
  while (index < text.length) {
    index = skipJavaScriptTrivia(text, index);
    const regexLiteral = readJavaScriptRegexLiteral(text, index);
    if (regexLiteral) {
      index = regexLiteral.end;
      continue;
    }
    const literal = readJavaScriptStringLiteral(text, index);
    if (literal) {
      for (const expression of literal.expressions || []) {
        for (const nestedIndex of staticModuleImportIndices(
          text.slice(expression.start, expression.end),
          matchesSpecifier,
        )) {
          indices.push(expression.start + nestedIndex);
        }
      }
      index = literal.end;
      continue;
    }
    const identifier = readJavaScriptIdentifier(text, index);
    if (!identifier) {
      index += 1;
      continue;
    }
    if (!requireAliases.has(identifier.value)
      && !["import", "export", "eval"].includes(identifier.value)) {
      index = identifier.end;
      continue;
    }
    const afterIdentifier = skipJavaScriptTrivia(text, identifier.end);
    const callOpeningParen = javaScriptCallOpeningParen(
      text,
      identifier.end,
      requireAliases.has(identifier.value) || identifier.value === "eval",
    );
    if ((requireAliases.has(identifier.value) || identifier.value === "import")
      && callOpeningParen >= 0) {
      const specifier = readStaticJavaScriptStringExpression(
        text,
        callOpeningParen + 1,
      );
      if (typeof specifier?.value === "string" && matchesSpecifier(specifier.value)) {
        indices.push(identifier.start);
      }
      index = specifier?.end || callOpeningParen + 1;
      continue;
    }
    if (identifier.value === "eval" && callOpeningParen >= 0) {
      const script = readStaticJavaScriptStringExpression(text, callOpeningParen + 1);
      if (typeof script?.value === "string"
        && staticModuleImportIndices(script.value, matchesSpecifier).length > 0) {
        indices.push(identifier.start);
      }
      index = script?.end || callOpeningParen + 1;
      continue;
    }
    if (identifier.value === "import") {
      const sideEffectSpecifier = readJavaScriptStringLiteral(text, afterIdentifier);
      if (sideEffectSpecifier) {
        if (matchesSpecifier(sideEffectSpecifier.value)) indices.push(identifier.start);
        index = sideEffectSpecifier.end;
        continue;
      }
    }
    if (identifier.value === "export") {
      const nextIdentifier = readJavaScriptIdentifier(text, afterIdentifier);
      if (nextIdentifier && !["type"].includes(nextIdentifier.value)) {
        index = nextIdentifier.end;
        continue;
      }
    }
    const specifier = moduleSpecifierAfterFrom(text, afterIdentifier);
    if (typeof specifier?.value === "string" && matchesSpecifier(specifier.value)) {
      indices.push(identifier.start);
    }
    index = specifier?.end || identifier.end;
  }
  return indices;
}

function nodeSqliteImportIndices(text) {
  return staticModuleImportIndices(text, (specifier) => specifier === "node:sqlite");
}

function javaScriptNextTopLevelComma(text, start) {
  const closing = [];
  for (let index = start; index < text.length;) {
    index = skipJavaScriptTrivia(text, index);
    const literal = readJavaScriptStringLiteral(text, index);
    if (literal) {
      index = literal.end;
      continue;
    }
    const regexLiteral = readJavaScriptRegexLiteral(text, index);
    if (regexLiteral) {
      index = regexLiteral.end;
      continue;
    }
    const character = text[index];
    if (character === "," && closing.length === 0) return index;
    if (character === "(") closing.push(")");
    else if (character === "[") closing.push("]");
    else if (character === "{") closing.push("}");
    else if (closing.at(-1) === character) closing.pop();
    else if (character === ")" && closing.length === 0) return -1;
    index += 1;
  }
  return -1;
}

function reflectApplyModuleImportIndices(text, matchesSpecifier) {
  const indices = [];
  const requireAliases = javaScriptRequireAliases(text);
  for (let index = 0; index < text.length;) {
    index = skipJavaScriptTrivia(text, index);
    const literal = readJavaScriptStringLiteral(text, index);
    if (literal) {
      index = literal.end;
      continue;
    }
    const regexLiteral = readJavaScriptRegexLiteral(text, index);
    if (regexLiteral) {
      index = regexLiteral.end;
      continue;
    }
    const reflect = readJavaScriptIdentifier(text, index);
    if (!reflect) {
      index += 1;
      continue;
    }
    index = reflect.end;
    if (reflect.value !== "Reflect") continue;
    let cursor = skipJavaScriptTrivia(text, reflect.end);
    if (text[cursor] !== ".") continue;
    const apply = readJavaScriptIdentifier(text, skipJavaScriptTrivia(text, cursor + 1));
    if (apply?.value !== "apply") continue;
    const openingParen = javaScriptCallOpeningParen(text, apply.end);
    if (openingParen < 0) continue;
    const loader = readJavaScriptIdentifier(
      text,
      skipJavaScriptTrivia(text, openingParen + 1),
    );
    if (!loader || !requireAliases.has(loader.value)) continue;
    cursor = skipJavaScriptTrivia(text, loader.end);
    if (text[cursor] !== ",") continue;
    const secondComma = javaScriptNextTopLevelComma(text, cursor + 1);
    if (secondComma < 0) continue;
    cursor = skipJavaScriptTrivia(text, secondComma + 1);
    if (text[cursor] !== "[") continue;
    const specifier = readStaticJavaScriptStringExpression(text, cursor + 1);
    if (typeof specifier?.value === "string" && matchesSpecifier(specifier.value)) {
      indices.push(reflect.start);
    }
    index = specifier?.end || cursor + 1;
  }
  return indices;
}

function isPostgresqlDriverSpecifier(specifier) {
  return /^(?:pg(?:\/|$)|pg-promise(?:\/|$)|postgres(?:ql)?(?:\/|$)|@neondatabase\/serverless(?:\/|$)|@vercel\/postgres(?:\/|$))/i
    .test(String(specifier || ""));
}

function postgresqlDriverImportIndices(text) {
  return [...new Set([
    ...staticModuleImportIndices(text, isPostgresqlDriverSpecifier),
    ...reflectApplyModuleImportIndices(text, isPostgresqlDriverSpecifier),
  ])].sort((left, right) => left - right);
}

function isPostgresqlRuntimeArtifactPath(file) {
  return String(file || "").startsWith("lib/")
    && String(file).split("/").slice(1).some(
      (segment) => /^(?:pg|postgres|postgresql)(?:[._-]|$)/i.test(segment),
    );
}

function isPhase4MigrationRuntimeSpecifier(specifier) {
  return /(?:^|\/)(?:persistence\/)?(?:migrations\/(?:runner|application-manifest)|sqlite\/migrations\/(?:adapter|application-bindings))(?:\.js)?$/i
    .test(String(specifier || "").replaceAll("\\", "/"));
}

function phase4MigrationRuntimeImportIndices(text) {
  return staticModuleImportIndices(text, isPhase4MigrationRuntimeSpecifier);
}

function nodeExecutableArgument(text, start) {
  const argumentStart = skipJavaScriptTrivia(text, start);
  const literal = readJavaScriptStringLiteral(text, argumentStart);
  if (typeof literal?.value === "string"
    && /(?:^|[\\/])node(?:\.exe)?$/i.test(literal.value)) {
    return literal;
  }
  const processIdentifier = readJavaScriptIdentifier(text, argumentStart);
  if (processIdentifier?.value !== "process") return null;
  let index = skipJavaScriptTrivia(text, processIdentifier.end);
  if (text[index] === ".") {
    const property = readJavaScriptIdentifier(text, skipJavaScriptTrivia(text, index + 1));
    return property?.value === "execPath"
      ? { start: argumentStart, end: property.end }
      : null;
  }
  if (text[index] !== "[") return null;
  const property = readJavaScriptStringLiteral(text, skipJavaScriptTrivia(text, index + 1));
  if (property?.value !== "execPath") return null;
  index = skipJavaScriptTrivia(text, property.end);
  return text[index] === "]" ? { start: argumentStart, end: index + 1 } : null;
}

function executableTemplateModuleImportIndices(text, importIndicesForSource) {
  const indices = [];
  const childProcessCalls = javaScriptNamedCallSites(
    text,
    new Set(["spawnSync", "execSync", "execFileSync", "spawn", "execFile"]),
  );
  for (const match of childProcessCalls) {
    const callName = match.name;
    const firstArgumentStart = match.openingParen + 1;
    if (!["execSync", "exec"].includes(callName)
      && !nodeExecutableArgument(text, firstArgumentStart)) {
      continue;
    }
    const limit = Math.min(text.length, match.index + 8000);
    let index = firstArgumentStart;
    while (index < limit) {
      index = skipJavaScriptTrivia(text, index);
      const literal = readJavaScriptStringLiteral(text, index);
      if (literal) {
        const literalSource = literal.value ?? literal.source ?? "";
        if (["execSync", "exec"].includes(callName)
          && shellCommandEvalScripts(literalSource)
            .some(({ source }) => importIndicesForSource(source).length > 0)) {
          indices.push(literal.start);
        }
        if (["-e", "--eval"].includes(literal.value)) {
          const comma = skipJavaScriptTrivia(text, literal.end);
          if (text[comma] !== ",") {
            index = literal.end;
            continue;
          }
          const argumentStart = skipJavaScriptTrivia(text, comma + 1);
          const argumentLiteral = readJavaScriptStringLiteral(text, argumentStart);
          if (argumentLiteral
            && importIndicesForSource(
              argumentLiteral.value ?? argumentLiteral.source ?? "",
            ).length > 0) {
            indices.push(argumentStart);
          } else {
            const argumentIdentifier = readJavaScriptIdentifier(text, argumentStart);
            if (argumentIdentifier) {
              const declarationPattern = new RegExp(
                String.raw`\b(?:const|let|var)\s+${argumentIdentifier.value.replaceAll("$", "\\$&")}\s*=\s*`,
                "g",
              );
              let declarationLiteral = null;
              for (const declaration of text.slice(0, match.index).matchAll(declarationPattern)) {
                const candidateStart = skipJavaScriptTrivia(
                  text,
                  declaration.index + declaration[0].length,
                );
                const candidate = readJavaScriptStringLiteral(text, candidateStart);
                if (candidate) declarationLiteral = candidate;
              }
              if (declarationLiteral
                && importIndicesForSource(
                  declarationLiteral.value ?? declarationLiteral.source ?? "",
                ).length > 0) {
                indices.push(declarationLiteral.start);
              }
            }
          }
        }
        index = literal.end;
        continue;
      }
      const regexLiteral = readJavaScriptRegexLiteral(text, index);
      if (regexLiteral) {
        index = regexLiteral.end;
        continue;
      }
      if (text[index] === ")" && text[index + 1] === ";") break;
      index += 1;
    }
  }
  return indices;
}

function executableTemplateNodeSqliteImportIndices(text) {
  return executableTemplateModuleImportIndices(text, nodeSqliteImportIndices);
}

function executableTemplatePostgresqlDriverImportIndices(text) {
  return executableTemplateModuleImportIndices(text, postgresqlDriverImportIndices);
}

function readShellQuotedValue(text, start) {
  const quote = text[start];
  if (!["'", "\""].includes(quote)) return null;
  let value = "";
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      value += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote === "\"") {
      escaped = true;
      continue;
    }
    if (character === quote) return { value, start, end: index + 1 };
    value += character;
  }
  return null;
}

function shellCommandEvalScripts(command) {
  const scripts = [];
  const nodeEval = /\bnode(?:\.exe)?\b[\s\S]{0,500}?(?:^|\s)(?:-e|--eval)\s+/g;
  for (const match of command.matchAll(nodeEval)) {
    const scriptStart = match.index + match[0].length;
    const script = readShellQuotedValue(command, scriptStart);
    if (script) scripts.push({ source: script.value, start: script.start });
  }
  return scripts;
}

function maskHashComments(text) {
  const output = [...text];
  let state = "code";
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (state === "block-comment") {
      if (character === "#" && next === ">") {
        output[index] = " ";
        output[index + 1] = " ";
        index += 1;
        state = "code";
      } else if (character !== "\n" && character !== "\r") {
        output[index] = " ";
      }
      continue;
    }
    if (state === "line-comment") {
      if (character === "\n" || character === "\r") {
        state = "code";
      } else {
        output[index] = " ";
      }
      continue;
    }
    if (state === "single" || state === "double") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\" || (state === "double" && character === "`")) {
        escaped = true;
        continue;
      }
      if ((state === "single" && character === "'")
        || (state === "double" && character === "\"")) {
        state = "code";
      }
      continue;
    }
    if (character === "<" && next === "#") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 1;
      state = "block-comment";
    } else if (character === "#") {
      output[index] = " ";
      state = "line-comment";
    } else if (character === "'") {
      state = "single";
    } else if (character === "\"") {
      state = "double";
    }
  }
  return output.join("");
}

function maskHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\r\n]/g, " "));
}

function shellSegmentBefore(text, index) {
  const lineStart = Math.max(text.lastIndexOf("\n", index - 1), text.lastIndexOf("\r", index - 1)) + 1;
  const linePrefix = text.slice(lineStart, index);
  return linePrefix.split(/&&|\|\||[;|]/).at(-1)?.trim() || "";
}

function shellSegmentExecutesNode(segment) {
  return /^(?:(?:env|command|exec)\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:(?:["'][^"']*["']|[^\s]+)[\\/])?node(?:\.exe)?(?:\s|$)/i.test(segment)
    || /(?:^|\s|--|\$\()["']?\$(?:node|node_executable)["']?(?:\s|$)/i.test(segment);
}

function shellHereDocumentSources(text) {
  const sources = [];
  const opener = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1[^\r\n]*(?:\r?\n|$)/g;
  for (const match of text.matchAll(opener)) {
    if (!shellSegmentExecutesNode(shellSegmentBefore(text, match.index))) continue;
    const contentStart = match.index + match[0].length;
    const delimiter = match[2];
    const closing = new RegExp(String.raw`^[\t ]*${delimiter}[\t ]*$`, "gm");
    closing.lastIndex = contentStart;
    const endMatch = closing.exec(text);
    if (!endMatch) continue;
    sources.push({
      source: text.slice(contentStart, endMatch.index),
      start: contentStart,
    });
  }
  return sources;
}

function powershellHereStringSources(text) {
  const sources = [];
  const opener = /@(["'])[\t ]*(?:\r?\n|$)/g;
  for (const match of text.matchAll(opener)) {
    const contentStart = match.index + match[0].length;
    const quote = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const closing = new RegExp(String.raw`^[\t ]*${quote}@[\t ]*$`, "gm");
    closing.lastIndex = contentStart;
    const endMatch = closing.exec(text);
    if (!endMatch) continue;
    sources.push({
      source: text.slice(contentStart, endMatch.index),
      start: contentStart,
    });
  }
  return sources;
}

function embeddedScriptModuleImportIndices(file, text, importIndicesForSource) {
  const extension = path.extname(file);
  const masked = [".sh", ".in", ".ps1", ".example"].includes(extension)
    ? maskHashComments(text)
    : extension === ".html"
      ? maskHtmlComments(text)
      : text;
  const sources = [".sh", ".in", ".example"].includes(extension)
    ? shellHereDocumentSources(masked)
    : extension === ".ps1"
      ? powershellHereStringSources(masked)
      : [];
  for (const script of shellCommandEvalScripts(masked)) sources.push(script);
  return sources.flatMap(({ source, start }) => (
    importIndicesForSource(source).length > 0 ? [start] : []
  ));
}

function embeddedScriptNodeSqliteImportIndices(file, text) {
  return embeddedScriptModuleImportIndices(file, text, nodeSqliteImportIndices);
}

function embeddedScriptPostgresqlDriverImportIndices(file, text) {
  return embeddedScriptModuleImportIndices(file, text, postgresqlDriverImportIndices);
}

function nodeSqliteImportIndicesForFile(file, text) {
  if (/\.(?:c|m)?js$/.test(file)) {
    return [...new Set([
      ...nodeSqliteImportIndices(text),
      ...executableTemplateNodeSqliteImportIndices(text),
    ])].sort((left, right) => left - right);
  }
  return embeddedScriptNodeSqliteImportIndices(file, text);
}

function postgresqlDriverImportIndicesForFile(file, text) {
  if (/\.(?:c|m)?js$/.test(file)) {
    return [...new Set([
      ...postgresqlDriverImportIndices(text),
      ...executableTemplatePostgresqlDriverImportIndices(text),
    ])].sort((left, right) => left - right);
  }
  return embeddedScriptPostgresqlDriverImportIndices(file, text);
}

function phase4MigrationRuntimeImportIndicesForFile(file, text) {
  if (/\.(?:c|m)?js$/.test(file)) {
    return [...new Set([
      ...phase4MigrationRuntimeImportIndices(text),
      ...executableTemplateModuleImportIndices(
        text,
        phase4MigrationRuntimeImportIndices,
      ),
    ])].sort((left, right) => left - right);
  }
  return embeddedScriptModuleImportIndices(
    file,
    text,
    phase4MigrationRuntimeImportIndices,
  );
}

function scanText(file, text, classification) {
  const starts = lineStarts(text);
  const findings = [];
  const counts = {};
  for (const signal of SIGNALS) {
    const matches = signal.id === "directNodeSqliteImport"
      ? nodeSqliteImportIndicesForFile(file, text).map((index) => ({ index }))
      : [...text.matchAll(new RegExp(signal.pattern, signal.flags))];
    counts[signal.id] = matches.length;
    for (const match of matches) {
      const line = lineAt(starts, match.index);
      const snippet = lineSnippet(text, match.index);
      findings.push({
        file,
        line,
        kind: signal.id,
        operation: signal.operation,
        sqliteFeature: signal.sqliteFeature,
        domain: file === "server.js" ? serverDomain(line) : classification?.owner || "",
        schemaObject: schemaObject(signal.id, snippet),
        transactionContext: signal.id.startsWith("begin")
          ? "manual transaction boundary"
          : classification?.transactionContext || "not classified",
        owner: classification?.owner || "unclassified",
        targetLayer: classification?.targetLayer || "unclassified",
        risk: classification?.risk || "unclassified",
        transitionException: classification?.transitionException || "",
        laterPhase: classification?.laterPhase || "",
        snippet,
      });
    }
  }
  return { counts, findings };
}

function hasDiscovery(counts, key) {
  return SIGNALS.some((signal) => signal[key] && Number(counts[signal.id] || 0) > 0);
}

function sortedDifference(left, right) {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((value) => !rightSet.has(value)).sort();
}

function namedFunctionSource(text, functionName) {
  const header = new RegExp(`(?:^|\\n)(?:async\\s+)?function\\s+${functionName}\\s*\\(`, "m");
  const match = header.exec(text);
  if (!match) return "";
  const sourceStart = match.index + (text[match.index] === "\n" ? 1 : 0);
  const remainder = text.slice(sourceStart + 1);
  const nextFunction = /\n(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/m.exec(remainder);
  const sourceEnd = nextFunction
    ? sourceStart + 1 + nextFunction.index
    : text.length;
  return text.slice(sourceStart, sourceEnd);
}

function countMatches(text, pattern) {
  return [...String(text || "").matchAll(new RegExp(pattern.source, pattern.flags))].length;
}

function maskJavaScriptStringsAndComments(text) {
  const output = [...text];
  let state = "code";
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (state === "code") {
      if (character === "'" || character === "\"") {
        state = character === "'" ? "single" : "double";
        output[index] = " ";
      } else if (character === "/" && next === "/") {
        state = "line-comment";
        output[index] = " ";
        output[index + 1] = " ";
        index += 1;
      } else if (character === "/" && next === "*") {
        state = "block-comment";
        output[index] = " ";
        output[index + 1] = " ";
        index += 1;
      }
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (state === "line-comment") state = "code";
      escaped = false;
      continue;
    }
    output[index] = " ";
    if (state === "line-comment") continue;
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        output[index + 1] = " ";
        index += 1;
        state = "code";
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if ((state === "single" && character === "'") || (state === "double" && character === "\"")) {
      state = "code";
    }
  }
  return output.join("");
}

function architectureBoundaryViolationsForText(file, text) {
  const contractFiles = new Set(PHASE_2_CONTRACT_FILES);
  const providerFacadeFiles = new Set([
    "lib/persistence/contract.js",
    "lib/persistence/postgresql/provider.js",
    "lib/persistence/sqlite/provider.js",
    "lib/persistence/postgresql/boundary/application.js",
    "lib/persistence/postgresql/application.js",
  ]);
  const statementDefinitionFiles = new Set([
    "lib/persistence/contract.js",
    ...PHASE_3_STATEMENT_FILES,
    "lib/persistence/statements/sales-analytics.js",
    "lib/persistence/postgresql/boundary/catalog.js",
    "lib/persistence/postgresql/reporting/catalog.js",
    "lib/persistence/postgresql/boundary/personal-actions.js",
  ]);
  // Installed operations select the provider but never consume web-supplied
  // connection details. The application configuration gate remains separate.
  const configurationFiles = new Set(["lib/persistence/configuration.js",
    'lib/persistence/postgresql/productive-configuration.js',
    'server-tools/linux/postgresql/migration-host.js',
    'server-tools/linux/recovery/lib/postgresql-application-smoke.js',
    'lib/persistence/postgresql/rehearsal-configuration.js',
    'server-tools/linux/backup-grabenplaner.sh',
    'server-tools/linux/lib/deploy-policy.js',
    'server-tools/linux/offsite/grabenplaner-offsite-prepare.sh',
    'server-tools/linux/offsite/install-grabenplaner-offsite.sh',
    'server-tools/linux/test-grabenplaner-server.sh',
    'server-tools/linux/update-grabenplaner-server.sh',
  ]);
  const persistenceInternalFiles = new Set([
    'lib/persistence/postgresql/application.js',
    ...PHASE_2_CONTRACT_FILES,
    ...PHASE_3_SQLITE_PROVIDER_FILES,
    ...PHASE_4_PERSISTENCE_FILES,
    ...PHASE_5_POSTGRESQL_FILES,
    ...SALES_ANALYTICS_PERSISTENCE_SLICE_FILES,
    ...PHASE_6_POSTGRESQL_OPERATIONS_FILES,
  ]);
  const phase4MigrationRuntimeFiles = new Set([
    "lib/persistence/migrations/runner.js",
    "lib/persistence/sqlite/migrations/adapter.js",
    "lib/persistence/sqlite/migrations/application-bindings.js",
  ]);
  const configurationConsumers = new Set(["server.js", ...PHASE_2_CONTRACT_FILES]);
  const sqliteDriverFiles = new Set([...PHASE_3_ALLOWED_PRODUCTION_DRIVER_FILES,...HISTORICAL_SOURCE_DRIVER_FILES]);
  const rules = [
    {
      id: "provider-contract-outside-boundary",
      pattern: /\b(?:PersistenceProvider|AppDatabaseProvider)\b/g,
      allowedFiles: contractFiles,
      source: "code",
    },
    {
      id: "provider-facade-outside-boundary",
      pattern: /\bcreatePersistenceProviderFacade\b/g,
      allowedFiles: providerFacadeFiles,
      source: "code",
    },
    {
      id: "provider-statement-outside-boundary",
      pattern: /\bdefinePersistenceStatement\b/g,
      allowedFiles: statementDefinitionFiles,
      source: "code",
    },
    {
      id: "provider-runtime-config-outside-boundary",
      pattern: /\bDB_PROVIDER\b/g,
      allowedFiles: configurationFiles,
      source: "code",
    },
    {
      id: "postgresql-secret-outside-boundary",
      pattern: /\bDATABASE_URL\b/g,
      allowedFiles: configurationFiles,
      source: "code",
    },
    {
      id: "provider-runtime-config-outside-boundary",
      pattern: /\[\s*["']DB_PROVIDER["']\s*\]/g,
      allowedFiles: configurationFiles,
      source: "raw",
    },
    {
      id: "postgresql-secret-outside-boundary",
      pattern: /\[\s*["']DATABASE_URL["']\s*\]/g,
      allowedFiles: configurationFiles,
      source: "raw",
    },
    {
      id: "provider-contract-runtime-import",
      pattern: /require\(\s*["'](?:(?:[^"']*\/persistence\/)|(?:\.\.?\/))(?:contract|errors)["']\s*\)/g,
      allowedFiles: persistenceInternalFiles,
      source: "raw",
    },
    {
      id: "provider-configuration-import",
      pattern: /require\(\s*["'][^"']*\/persistence\/configuration["']\s*\)/g,
      allowedFiles: configurationConsumers,
      source: "raw",
    },
    {
      id: "sqlite-driver-import-outside-boundary",
      allowedFiles: sqliteDriverFiles,
      source: "node-sqlite-imports",
    },
    {
      id: "postgresql-driver-import",
      allowedFiles: new Set([...PHASE_5_POSTGRESQL_DRIVER_FILE_SET, ...MIGRATION_DEVELOPMENT_DRIVER_FILES]),
      source: "postgresql-driver-imports",
    },
    {
      id: "postgresql-runtime-provider",
      pattern: /\b(?:createPostgres(?:ql)?(?:Persistence)?Provider|Postgres(?:ql)?(?:Persistence)?Provider)\b/g,
      allowedFiles: new Set([...PHASE_5_POSTGRESQL_RUNTIME_FILE_SET,'lib/persistence/postgresql/core/application.js','lib/persistence/postgresql/sales/application.js']),
      source: "code",
    },
    {
      id: "phase4-application-migration-runtime-activation",
      allowedFiles: phase4MigrationRuntimeFiles,
      source: "phase4-migration-runtime-imports",
    },
    {
      id: "phase4-application-migration-runtime-activation",
      pattern: /\b(?:runMigrationManifest|createSqliteMigrationAdapter|SQLITE_APPLICATION_MIGRATION_(?:BINDINGS|HANDLERS|OPERATIONS))\b/g,
      allowedFiles: phase4MigrationRuntimeFiles,
      source: "code",
    },
  ];
  const violations = [];
  const codeText = /\.(?:c|m)?js$/.test(file) ? maskJavaScriptStringsAndComments(text) : text;
  const starts = lineStarts(text);
  for (const rule of rules) {
    if (rule.allowedFiles.has(file)) continue;
    if (rule.source === "node-sqlite-imports") {
      for (const index of nodeSqliteImportIndicesForFile(file, text)) {
        violations.push({ file, line: lineAt(starts, index), kind: rule.id });
      }
      continue;
    }
    if (rule.source === "postgresql-driver-imports") {
      for (const index of postgresqlDriverImportIndicesForFile(file, text)) {
        violations.push({ file, line: lineAt(starts, index), kind: rule.id });
      }
      continue;
    }
    if (rule.source === "phase4-migration-runtime-imports") {
      for (const index of phase4MigrationRuntimeImportIndicesForFile(file, text)) {
        violations.push({ file, line: lineAt(starts, index), kind: rule.id });
      }
      continue;
    }
    const source = rule.source === "code" ? codeText : text;
    for (const match of source.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))) {
      violations.push({ file, line: lineAt(starts, match.index), kind: rule.id });
    }
  }
  return violations;
}

function scanPhaseBoundary(root, files) {
  const violations = [];
  for (const file of files) {
    if (file.startsWith("test/") || file.startsWith("test-support/") || ISOLATED_CASH_QUALIFICATION_CLI_FILES.has(file) || EXCLUDED_FILES.has(file)) continue;
    const text = fs.readFileSync(path.join(root, file), "utf8");
    violations.push(...architectureBoundaryViolationsForText(file, text));
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const allowedDependencyNames = new Set([
    ...BASELINE_PACKAGE_DEPENDENCY_NAMES,
    ...APPLICATION_ALLOWED_DEPENDENCIES,
    ...PHASE_5_ALLOWED_DEPENDENCIES,
  ]);
  const configuredDependencyNames = [
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.devDependencies || {}),
    ...Object.keys(packageJson.optionalDependencies || {}),
    ...Object.keys(packageJson.peerDependencies || {}),
  ];
  for (const dependency of configuredDependencyNames) {
    if (!allowedDependencyNames.has(dependency)) {
      violations.push({ file: "package.json", line: 1, kind: `dependency:new:${dependency}` });
    }
  }
  const forbiddenDependencies = [
    "postgres",
    "postgresql",
    "knex",
    "sequelize",
    "typeorm",
    "prisma",
    "@prisma/client",
  ];
  for (const dependency of forbiddenDependencies) {
    if ([
      packageJson.dependencies,
      packageJson.devDependencies,
      packageJson.optionalDependencies,
      packageJson.peerDependencies,
    ].some((group) => Object.hasOwn(group || {}, dependency))) {
      violations.push({ file: "package.json", line: 1, kind: `dependency:${dependency}` });
    }
  }
  return violations;
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function inspectPhase4Persistence(root, files, phaseBoundaryViolations) {
  const missingFiles = PHASE_4_PERSISTENCE_FILES
    .filter((file) => !fs.existsSync(path.join(root, file)))
    .sort();
  const missingTestFiles = PHASE_4_PERSISTENCE_TEST_FILES
    .filter((file) => !fs.existsSync(path.join(root, file)))
    .sort();
  const moduleErrors = [];
  const bindingImplementationErrors = [];

  function safeRequire(relativeFile, label = relativeFile) {
    try {
      return require(path.join(root, relativeFile));
    } catch (error) {
      moduleErrors.push({
        file: relativeFile,
        label,
        message: String(error?.message || error),
      });
      return null;
    }
  }

  const catalogModule = safeRequire(
    "lib/persistence/sqlite/application-catalog.js",
    "SQLite-Anwendungskatalog",
  );
  const dialectModule = missingFiles.includes("lib/persistence/dialects/application-manifest.js")
    ? null
    : safeRequire(
      "lib/persistence/dialects/application-manifest.js",
      "Anwendungs-Dialektmanifest",
    );
  const migrationManifestModule = missingFiles.includes("lib/persistence/migrations/application-manifest.js")
    ? null
    : safeRequire(
      "lib/persistence/migrations/application-manifest.js",
      "Anwendungs-Migrationsmanifest",
    );
  const migrationBindingsModule = missingFiles.includes("lib/persistence/sqlite/migrations/application-bindings.js")
    ? null
    : safeRequire(
      "lib/persistence/sqlite/migrations/application-bindings.js",
      "Anwendungs-Migrationsbindungen",
    );

  const applicationCatalog = Array.isArray(catalogModule?.SQLITE_APPLICATION_CATALOG)
    ? catalogModule.SQLITE_APPLICATION_CATALOG
    : [];
  const sqliteDialectManifest = dialectModule?.SQLITE_APPLICATION_DIALECT_MANIFEST;
  const postgresqlDialectFixture = dialectModule?.POSTGRESQL_APPLICATION_DIALECT_FIXTURE;
  const sqliteDialectEntries = Array.isArray(sqliteDialectManifest?.entries)
    ? sqliteDialectManifest.entries
    : [];
  const postgresqlDialectEntries = Array.isArray(postgresqlDialectFixture?.entries)
    ? postgresqlDialectFixture.entries
    : [];

  const statementIds = applicationCatalog.map((entry) => entry?.statement?.id);
  const sqliteStatementIds = sqliteDialectEntries.map((entry) => entry?.statement?.id);
  const postgresqlStatementIds = postgresqlDialectEntries.map((entry) => entry?.statementId);
  const duplicateStatementIds = duplicateValues(statementIds);
  const duplicateSqliteStatementBindings = duplicateValues(sqliteStatementIds);
  const duplicatePostgresqlStatementBindings = duplicateValues(postgresqlStatementIds);
  const missingSqliteStatementBindings = sortedDifference(statementIds, sqliteStatementIds);
  const extraSqliteStatementBindings = sortedDifference(sqliteStatementIds, statementIds);
  const missingPostgresqlStatementBindings = sortedDifference(statementIds, postgresqlStatementIds);
  const extraPostgresqlStatementBindings = sortedDifference(postgresqlStatementIds, statementIds);
  const sqliteBaselineStatementCount = sqliteDialectEntries
    .filter((entry) => entry?.classification === "sqlite-baseline")
    .length;
  const dialectVariantStatementCount = sqliteDialectEntries
    .filter((entry) => entry?.classification === "dialect-variant")
    .length;
  const namedDollarParameterStatementCount = sqliteDialectEntries
    .filter((entry) => entry?.features?.includes("sqlite.named-dollar-parameters"))
    .length;
  const dialectMetadataViolations = [];
  const catalogById = new Map(applicationCatalog.map((entry) => [entry?.statement?.id, entry]));
  const sqliteDialectById = new Map(
    sqliteDialectEntries.map((entry) => [entry?.statement?.id, entry]),
  );
  for (const entry of sqliteDialectEntries) {
    const id = entry?.statement?.id;
    const catalogEntry = catalogById.get(id);
    const features = entry?.features;
    if (!catalogEntry
      || entry.statement !== catalogEntry.statement
      || entry.sql !== catalogEntry.sql
      || entry.returning !== catalogEntry.returning
      || entry.owner !== String(id || "").split(".")[0]
      || !Array.isArray(features)
      || (entry.classification === "sqlite-baseline" && features.length !== 0)
      || (entry.classification === "dialect-variant" && features.length === 0)
      || !["sqlite-baseline", "dialect-variant"].includes(entry.classification)) {
      dialectMetadataViolations.push(`sqlite:${id || "unknown"}`);
    }
  }
  for (const entry of postgresqlDialectEntries) {
    const sqliteEntry = sqliteDialectById.get(entry?.statementId);
    if (!sqliteEntry
      || entry.owner !== sqliteEntry.owner
      || entry.classification !== sqliteEntry.classification
      || JSON.stringify(entry.requiredFeatures) !== JSON.stringify(sqliteEntry.features)
      || entry.status !== "contract-only"
      || Object.hasOwn(entry, "sql")
      || Object.hasOwn(entry, "execute")) {
      dialectMetadataViolations.push(`postgresql:${entry?.statementId || "unknown"}`);
    }
  }
  if (sqliteDialectManifest?.dialectId !== "sqlite"
    || sqliteDialectManifest?.executable !== true) {
    dialectMetadataViolations.push("sqlite:manifest");
  }
  if (postgresqlDialectFixture?.dialectId !== "postgresql"
    || postgresqlDialectFixture?.sourceDialectId !== "sqlite"
    || postgresqlDialectFixture?.sourceFingerprint !== sqliteDialectManifest?.fingerprint
    || postgresqlDialectFixture?.status !== "contract-only"
    || postgresqlDialectFixture?.executable !== false) {
    dialectMetadataViolations.push("postgresql:fixture");
  }

  const applicationMigrationManifest = migrationManifestModule?.APPLICATION_MIGRATION_MANIFEST;
  const migrationOperationIds = Array.isArray(
    migrationManifestModule?.APPLICATION_MIGRATION_OPERATION_IDS,
  )
    ? migrationManifestModule.APPLICATION_MIGRATION_OPERATION_IDS
    : [];
  const sqliteMigrationBindings = Array.isArray(
    migrationBindingsModule?.SQLITE_APPLICATION_MIGRATION_BINDINGS?.bindings,
  )
    ? migrationBindingsModule.SQLITE_APPLICATION_MIGRATION_BINDINGS.bindings
    : [];
  const postgresqlMigrationBindings = Array.isArray(
    migrationBindingsModule?.POSTGRESQL_APPLICATION_MIGRATION_FIXTURE?.bindings,
  )
    ? migrationBindingsModule.POSTGRESQL_APPLICATION_MIGRATION_FIXTURE.bindings
    : [];
  const sqliteMigrationOperationIds = sqliteMigrationBindings
    .map((binding) => binding?.operationId);
  const postgresqlMigrationOperationIds = postgresqlMigrationBindings
    .map((binding) => binding?.operationId);
  const duplicateMigrationOperationIds = duplicateValues(migrationOperationIds);
  const duplicateSqliteMigrationBindings = duplicateValues(sqliteMigrationOperationIds);
  const duplicatePostgresqlMigrationBindings = duplicateValues(postgresqlMigrationOperationIds);
  const missingSqliteMigrationBindings = sortedDifference(
    migrationOperationIds,
    sqliteMigrationOperationIds,
  );
  const extraSqliteMigrationBindings = sortedDifference(
    sqliteMigrationOperationIds,
    migrationOperationIds,
  );
  const missingPostgresqlMigrationBindings = sortedDifference(
    migrationOperationIds,
    postgresqlMigrationOperationIds,
  );
  const extraPostgresqlMigrationBindings = sortedDifference(
    postgresqlMigrationOperationIds,
    migrationOperationIds,
  );
  const migrationMetadataViolations = [];
  const sqliteBindingFixture = migrationBindingsModule?.SQLITE_APPLICATION_MIGRATION_BINDINGS;
  const sqliteMigrationOperations = migrationBindingsModule?.SQLITE_APPLICATION_MIGRATION_OPERATIONS;
  const sqliteImplementationFingerprint = (
    migrationBindingsModule?.sqliteApplicationMigrationImplementationFingerprint
  );
  const sqliteImplementationClosure = (
    migrationBindingsModule?.sqliteApplicationMigrationImplementationClosure
  );
  const postgresqlBindingFixture = migrationBindingsModule?.POSTGRESQL_APPLICATION_MIGRATION_FIXTURE;
  const migrationByOperationId = new Map(
    (applicationMigrationManifest?.migrations || []).flatMap((migration) => (
      (migration.operations || []).map((operationId) => [operationId, migration])
    )),
  );
  if (applicationMigrationManifest?.id !== "grabenplaner.application"
    || !Array.isArray(applicationMigrationManifest?.migrations)
    || applicationMigrationManifest.migrations.length !== PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT) {
    migrationMetadataViolations.push("application:manifest");
  }
  if (sqliteBindingFixture?.providerId !== "sqlite"
    || sqliteBindingFixture?.executable !== true
    || sqliteBindingFixture?.executionBoundary !== "existing-runtime-bridge"
    || sqliteBindingFixture?.genericAdapterCompatible !== false
    || sqliteBindingFixture?.activationStatus !== "mapped-not-ledger-activated"
    || sqliteBindingFixture?.manifestFingerprint !== applicationMigrationManifest?.fingerprint) {
    migrationMetadataViolations.push("sqlite:fixture");
  }
  if (postgresqlBindingFixture?.providerId !== "postgresql"
    || postgresqlBindingFixture?.status !== "contract-only"
    || postgresqlBindingFixture?.executable !== false
    || postgresqlBindingFixture?.manifestFingerprint !== applicationMigrationManifest?.fingerprint) {
    migrationMetadataViolations.push("postgresql:fixture");
  }

  const operationsRoot = path.resolve(root, "lib/persistence/sqlite/operations");
  for (const binding of sqliteMigrationBindings) {
    if (!binding
      || typeof binding.operationId !== "string"
      || binding.migrationId !== migrationByOperationId.get(binding.operationId)?.id
      || typeof binding.modulePath !== "string"
      || typeof binding.exportName !== "string"
      || typeof binding.invocationId !== "string"
      || typeof binding.handler !== "function"
      || !Array.isArray(binding.implementationFiles)
      || binding.implementationFiles.length === 0
      || !/^[a-f0-9]{64}$/.test(String(binding.implementationFingerprint || ""))
      || binding.atomicity !== "implementation-managed"
      || binding.recoveryPolicy !== "transaction-or-verified-pre-migration-backup"
      || binding.status !== "implemented") {
      migrationMetadataViolations.push(`sqlite:${binding?.operationId || "unknown"}`);
      continue;
    }
    const operationDescriptor = sqliteMigrationOperations?.[binding.operationId];
    if (!operationDescriptor
      || JSON.stringify(Object.keys(operationDescriptor).sort())
        !== JSON.stringify(["handler", "implementationFingerprint"])
      || operationDescriptor.handler !== binding.handler
      || operationDescriptor.implementationFingerprint !== binding.implementationFingerprint
      || typeof sqliteImplementationFingerprint !== "function"
      || typeof sqliteImplementationClosure !== "function") {
      migrationMetadataViolations.push(`sqlite:${binding.operationId}:descriptor`);
      continue;
    }
    try {
      const implementationFiles = sqliteImplementationClosure(binding.modulePath)
        .map((entry) => entry.file);
      if (JSON.stringify(implementationFiles) !== JSON.stringify(binding.implementationFiles)
        || sqliteImplementationFingerprint(binding) !== binding.implementationFingerprint) {
        migrationMetadataViolations.push(`sqlite:${binding.operationId}:fingerprint`);
        continue;
      }
    } catch (error) {
      bindingImplementationErrors.push({
        operationId: binding.operationId,
        message: String(error?.message || error),
      });
      continue;
    }
    const implementationPath = path.resolve(
      root,
      "lib/persistence/sqlite/migrations",
      binding.modulePath,
    );
    const withinOperations = implementationPath === operationsRoot
      || implementationPath.startsWith(`${operationsRoot}${path.sep}`);
    if (!withinOperations) {
      bindingImplementationErrors.push({
        operationId: binding.operationId,
        message: "SQLite-Migrationsbindung liegt ausserhalb der Operationsgrenze.",
      });
      continue;
    }
    try {
      const implementation = require(implementationPath);
      if (typeof implementation?.[binding.exportName] !== "function") {
        bindingImplementationErrors.push({
          operationId: binding.operationId,
          message: `Export ${binding.exportName} ist keine Funktion.`,
        });
      }
    } catch (error) {
      bindingImplementationErrors.push({
        operationId: binding.operationId,
        message: String(error?.message || error),
      });
    }
  }
  for (const binding of postgresqlMigrationBindings) {
    if (!binding
      || binding.status !== "contract-only"
      || JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify(["operationId", "status"])) {
      migrationMetadataViolations.push(`postgresql:${binding?.operationId || "unknown"}`);
    }
  }

  const postgresqlRuntimeArtifacts = [];
  if (postgresqlDialectFixture?.executable === true) {
    postgresqlRuntimeArtifacts.push("dialect-fixture:executable");
  }
  if (postgresqlDialectEntries.some(
    (entry) => Object.hasOwn(entry || {}, "sql") || Object.hasOwn(entry || {}, "execute"),
  )) {
    postgresqlRuntimeArtifacts.push("dialect-fixture:runtime-entry");
  }
  if (postgresqlBindingFixture?.executable === true) {
    postgresqlRuntimeArtifacts.push("migration-fixture:executable");
  }
  if (postgresqlMigrationBindings.some((binding) => (
    Object.hasOwn(binding || {}, "modulePath")
    || Object.hasOwn(binding || {}, "exportName")
    || Object.hasOwn(binding || {}, "handler")
  ))) {
    postgresqlRuntimeArtifacts.push("migration-fixture:runtime-binding");
  }
  for (const file of files) {
    if (isPostgresqlRuntimeArtifactPath(file)
      && !PHASE_5_POSTGRESQL_FILE_SET.has(file)
      && !MIGRATION_DEVELOPMENT_FILES.has(file)
      && !SALES_ANALYTICS_PERSISTENCE_SLICE_FILE_SET.has(file)
      && !PHASE_6_POSTGRESQL_OPERATIONS_FILE_SET.has(file)) {
      postgresqlRuntimeArtifacts.push(`file:${file}`);
    }
  }
  for (const violation of phaseBoundaryViolations) {
    if (violation.kind === "postgresql-driver-import"
      || violation.kind === "postgresql-runtime-provider"
      || violation.kind.startsWith("dependency:pg")
      || violation.kind.startsWith("dependency:postgres")) {
      postgresqlRuntimeArtifacts.push(`${violation.file}:${violation.kind}`);
    }
  }

  const uniquePostgresqlRuntimeArtifacts = [...new Set(postgresqlRuntimeArtifacts)].sort();
  const complete = (
    missingFiles.length === 0
    && missingTestFiles.length === 0
    && moduleErrors.length === 0
    && statementIds.length === PHASE_4_EXPECTED_STATEMENT_COUNT
    && duplicateStatementIds.length === 0
    && sqliteStatementIds.length === PHASE_4_EXPECTED_STATEMENT_COUNT
    && postgresqlStatementIds.length === PHASE_4_EXPECTED_STATEMENT_COUNT
    && sqliteBaselineStatementCount === PHASE_4_EXPECTED_SQLITE_BASELINE_STATEMENT_COUNT
    && dialectVariantStatementCount === PHASE_4_EXPECTED_DIALECT_VARIANT_COUNT
    && namedDollarParameterStatementCount === PHASE_4_EXPECTED_NAMED_DOLLAR_PARAMETER_STATEMENT_COUNT
    && duplicateSqliteStatementBindings.length === 0
    && duplicatePostgresqlStatementBindings.length === 0
    && missingSqliteStatementBindings.length === 0
    && extraSqliteStatementBindings.length === 0
    && missingPostgresqlStatementBindings.length === 0
    && extraPostgresqlStatementBindings.length === 0
    && dialectMetadataViolations.length === 0
    && migrationOperationIds.length === PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT
    && duplicateMigrationOperationIds.length === 0
    && sqliteMigrationOperationIds.length === PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT
    && postgresqlMigrationOperationIds.length === PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT
    && duplicateSqliteMigrationBindings.length === 0
    && duplicatePostgresqlMigrationBindings.length === 0
    && missingSqliteMigrationBindings.length === 0
    && extraSqliteMigrationBindings.length === 0
    && missingPostgresqlMigrationBindings.length === 0
    && extraPostgresqlMigrationBindings.length === 0
    && migrationMetadataViolations.length === 0
    && bindingImplementationErrors.length === 0
    && uniquePostgresqlRuntimeArtifacts.length === 0
  );

  return {
    status: complete ? "completed" : "in-progress",
    statementCount: statementIds.length,
    sqliteStatementCount: sqliteStatementIds.length,
    postgresqlStatementCount: postgresqlStatementIds.length,
    sqliteBaselineStatementCount,
    dialectVariantStatementCount,
    namedDollarParameterStatementCount,
    migrationCount: applicationMigrationManifest?.migrations?.length || 0,
    migrationOperationCount: migrationOperationIds.length,
    sqliteMigrationBindingCount: sqliteMigrationOperationIds.length,
    postgresqlMigrationBindingCount: postgresqlMigrationOperationIds.length,
    executablePostgresqlRuntimeArtifacts: uniquePostgresqlRuntimeArtifacts.length,
    postgresqlRuntimeArtifacts: uniquePostgresqlRuntimeArtifacts,
    duplicateStatementIds,
    duplicateSqliteStatementBindings,
    duplicatePostgresqlStatementBindings,
    missingSqliteStatementBindings,
    extraSqliteStatementBindings,
    missingPostgresqlStatementBindings,
    extraPostgresqlStatementBindings,
    dialectMetadataViolations: [...new Set(dialectMetadataViolations)].sort(),
    duplicateMigrationOperationIds,
    duplicateSqliteMigrationBindings,
    duplicatePostgresqlMigrationBindings,
    missingSqliteMigrationBindings,
    extraSqliteMigrationBindings,
    missingPostgresqlMigrationBindings,
    extraPostgresqlMigrationBindings,
    migrationMetadataViolations: [...new Set(migrationMetadataViolations)].sort(),
    bindingImplementationErrors,
    missingFiles,
    missingTestFiles,
    moduleErrors,
    complete,
  };
}

function inspectPhase5Postgresql(root) {
  const missingFiles = PHASE_5_POSTGRESQL_FILES
    .filter((file) => !fs.existsSync(path.join(root, file)))
    .sort();
  const missingTestFiles = PHASE_5_POSTGRESQL_TEST_FILES
    .filter((file) => !fs.existsSync(path.join(root, file)))
    .sort();
  const missingSalesAnalyticsFiles = SALES_ANALYTICS_PERSISTENCE_SLICE_FILES
    .filter((file) => !fs.existsSync(path.join(root, file)))
    .sort();
  const missingSalesAnalyticsTestFiles = SALES_ANALYTICS_PERSISTENCE_SLICE_TEST_FILES
    .filter((file) => !fs.existsSync(path.join(root, file)))
    .sort();
  const moduleErrors = [];

  function safeRequire(relativeFile) {
    if (!fs.existsSync(path.join(root, relativeFile))) return null;
    try {
      return require(path.join(root, relativeFile));
    } catch (error) {
      moduleErrors.push({
        file: relativeFile,
        message: String(error?.message || error),
      });
      return null;
    }
  }

  const configuration = safeRequire("lib/persistence/configuration.js");
  const provider = safeRequire("lib/persistence/postgresql/provider.js");
  const policy = safeRequire("lib/persistence/postgresql/policy.js");
  const pool = safeRequire("lib/persistence/postgresql/pool.js");
  const compiler = safeRequire("lib/persistence/postgresql/dialect-compiler.js");
  const dialects = safeRequire("lib/persistence/dialects/application-manifest.js");
  const catalogContract = safeRequire(
    "lib/persistence/postgresql/catalog-contract.js",
  );
  const migrationAdapterModule = safeRequire(
    "lib/persistence/postgresql/migrations/adapter.js",
  );
  const organizationDepartmentsCatalog = safeRequire(
    "lib/persistence/postgresql/organization-departments-catalog.js",
  );
  const planningSettingsCatalog = safeRequire(
    "lib/persistence/postgresql/planning-settings-catalog.js",
  );
  const systemCenterMetricsCatalog = safeRequire(
    "lib/persistence/postgresql/system-center-metrics-catalog.js",
  );
  const uiPreferencesCatalog = safeRequire(
    "lib/persistence/postgresql/ui-preferences-catalog.js",
  );
  const salesAnalyticsPostgresqlCatalog = safeRequire(
    "lib/persistence/postgresql/sales-analytics-catalog.js",
  );
  const salesAnalyticsPostgresqlSchema = safeRequire(
    "lib/persistence/postgresql/sales-analytics-schema.js",
  );
  const salesAnalyticsRepository = safeRequire(
    "lib/persistence/repositories/sales-analytics.js",
  );
  const salesAnalyticsSqliteCatalog = safeRequire(
    "lib/persistence/sqlite/sales-analytics-catalog.js",
  );
  const salesAnalyticsSqliteSchema = safeRequire(
    "lib/persistence/sqlite/operations/sales-analytics-schema.js",
  );
  const salesAnalyticsStatements = safeRequire(
    "lib/persistence/statements/sales-analytics.js",
  );
  const sqliteApplicationCatalog = safeRequire(
    "lib/persistence/sqlite/application-catalog.js",
  );
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const serverText = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const capabilities = provider?.POSTGRESQL_CAPABILITIES;
  const defaultPolicy = policy?.DEFAULT_POSTGRESQL_POOL_POLICY;
  const dialectPlan = dialects?.POSTGRESQL_APPLICATION_DIALECT_PLAN;
  const planEntries = Array.isArray(dialectPlan?.entries) ? dialectPlan.entries : [];
  const portableDialectCount = planEntries
    .filter((entry) => entry?.strategy === "portable-generated")
    .length;
  const overrideDialectCount = planEntries
    .filter((entry) => entry?.strategy === "requires-override")
    .length;
  const planEntryByStatementId = new Map(
    planEntries.map((entry) => [entry?.statementId, entry]),
  );

  function createDevelopmentSlice(relativeFile, module, factoryName) {
    if (typeof module?.[factoryName] !== "function") return null;
    try {
      return module[factoryName]({
        schemaName: "grabenplaner_audit",
      });
    } catch (error) {
      moduleErrors.push({
        file: relativeFile,
        message: String(error?.message || error),
      });
      return null;
    }
  }

  const uiPreferencesSlice = createDevelopmentSlice(
    "lib/persistence/postgresql/ui-preferences-catalog.js",
    uiPreferencesCatalog,
    "createPostgresqlUiPreferencesSlice",
  );
  const planningSettingsSlice = createDevelopmentSlice(
    "lib/persistence/postgresql/planning-settings-catalog.js",
    planningSettingsCatalog,
    "createPostgresqlPlanningSettingsSlice",
  );
  const organizationDepartmentsSlice = createDevelopmentSlice(
    "lib/persistence/postgresql/organization-departments-catalog.js",
    organizationDepartmentsCatalog,
    "createPostgresqlOrganizationDepartmentsSlice",
  );
  const systemCenterMetricsSlice = createDevelopmentSlice(
    "lib/persistence/postgresql/system-center-metrics-catalog.js",
    systemCenterMetricsCatalog,
    "createPostgresqlSystemCenterMetricsOldestIntervalKeysSlice",
  );
  const salesAnalyticsPersistenceSlice = createDevelopmentSlice(
    "lib/persistence/postgresql/sales-analytics-catalog.js",
    salesAnalyticsPostgresqlCatalog,
    "createPostgresqlSalesAnalyticsPersistenceSlice",
  );
  const salesAnalyticsSchemaContract = createDevelopmentSlice(
    "lib/persistence/postgresql/sales-analytics-schema.js",
    salesAnalyticsPostgresqlSchema,
    "createPostgresqlSalesAnalyticsSchemaContract",
  );

  let migrationAdapter = null;
  if (typeof migrationAdapterModule?.createPostgresqlMigrationAdapter === "function") {
    try {
      migrationAdapter = migrationAdapterModule.createPostgresqlMigrationAdapter({
        expectedRole: "grabenplaner_audit_role",
        pool: {
          connect() {
            throw new Error("Audit construction must not open a PostgreSQL connection.");
          },
        },
        schemaName: "grabenplaner_audit",
        operations: {},
      });
    } catch (error) {
      moduleErrors.push({
        file: "lib/persistence/postgresql/migrations/adapter.js",
        message: String(error?.message || error),
      });
    }
  }

  function inspectDevelopmentSlice({
    relativeFile,
    slice,
    expectedSliceId,
    expectedStatementIds,
    featureProperty,
    semanticResolutionsRequired = false,
  }) {
    const sourceText = fs.existsSync(path.join(root, relativeFile))
      ? fs.readFileSync(path.join(root, relativeFile), "utf8")
      : "";
    const sourceContractDriftPinValid = (
      /const\s+EXPECTED_SOURCE_CONTRACT_FINGERPRINTS\s*=\s*Object\.freeze\(/.test(sourceText)
      && /sourceContractFingerprint\(sourceEntry\)/.test(sourceText)
      && /EXPECTED_SOURCE_CONTRACT_FINGERPRINTS\[statement\.id\]/.test(sourceText)
      && expectedStatementIds.every((statementId) => sourceText.includes(statementId))
    );
    const sourceDriftPinValid = sourceContractDriftPinValid;
    const entries = Array.isArray(slice?.entries) ? slice.entries : [];
    const provenance = Array.isArray(slice?.provenance) ? slice.provenance : [];
    const statementIds = entries.map((entry) => entry?.statement?.id);
    const executableStatementCount = entries.filter((entry) => (
      entry?.statement
      && typeof entry.sql === "string"
      && entry.sql.trim()
      && Array.isArray(entry.parameterOrder)
      && Array.isArray(entry.parameterBindings)
      && typeof entry.returning === "boolean"
    )).length;
    let description = null;
    if (slice && typeof catalogContract?.describePostgresqlDevelopmentSlice === "function") {
      try {
        description = catalogContract.describePostgresqlDevelopmentSlice(slice);
      } catch {
        description = null;
      }
    }
    const valid = Boolean(
      slice
      && slice.sliceId === expectedSliceId
      && slice.status === "development-contract"
      && slice.developmentExecutable === true
      && slice.executable === true
      && slice.applicationExecutable === false
      && slice.fullApplicationCatalog === false
      && slice.productActivation === false
      && sourceDriftPinValid
      && slice.sourcePlanFingerprint === dialectPlan?.fingerprint
      && /^[a-f0-9]{64}$/.test(String(slice.fingerprint || ""))
      && entries.length === expectedStatementIds.length
      && executableStatementCount === expectedStatementIds.length
      && JSON.stringify(statementIds) === JSON.stringify(expectedStatementIds)
      && provenance.length === expectedStatementIds.length
      && JSON.stringify(provenance.map((entry) => entry?.statementId))
        === JSON.stringify(expectedStatementIds)
      && provenance.every((entry) => (
        /^[a-f0-9]{64}$/.test(String(entry?.sourceSqlFingerprint || ""))
        && entry.sourceSqlFingerprint
          === planEntryByStatementId.get(entry?.statementId)?.sourceSqlFingerprint
        && /^[a-f0-9]{64}$/.test(String(entry?.sourceContractFingerprint || ""))
        && /^[a-f0-9]{64}$/.test(String(entry?.sqlFingerprint || ""))
        && ["portable-generated", "requires-override"].includes(entry?.sourceStrategy)
        && Array.isArray(entry?.[featureProperty])
        && (!semanticResolutionsRequired || Array.isArray(entry?.semanticResolutions))
      ))
      && description?.status === "partial-development-slice"
      && description.developmentExecutable === true
      && description.executable === true
      && description.applicationExecutable === false
      && description.fullApplicationCatalog === false
      && description.productActivation === false
      && description.statementCount === expectedStatementIds.length
    );
    return {
      valid,
      report: {
        status: slice?.status || "",
        valid,
        sourceDriftPinValid,
        sourceContractDriftPinValid,
        developmentExecutable: description?.developmentExecutable === true,
        executable: slice?.executable === true,
        applicationExecutable: description?.applicationExecutable ?? null,
        fullApplicationCatalog: slice?.fullApplicationCatalog ?? null,
        productActivation: description?.productActivation ?? null,
        statementCount: entries.length,
        expectedStatementCount: expectedStatementIds.length,
        executableStatementCount,
      },
    };
  }

  function inspectSalesAnalyticsPersistenceSlice() {
    const sourceCatalog = Array.isArray(
      salesAnalyticsSqliteCatalog?.SQLITE_SALES_ANALYTICS_CATALOG,
    )
      ? salesAnalyticsSqliteCatalog.SQLITE_SALES_ANALYTICS_CATALOG
      : [];
    const sourceStatements = salesAnalyticsStatements?.SALES_ANALYTICS_PERSISTENCE_STATEMENTS
      ? Object.values(salesAnalyticsStatements.SALES_ANALYTICS_PERSISTENCE_STATEMENTS)
      : [];
    const entries = Array.isArray(salesAnalyticsPersistenceSlice?.entries)
      ? salesAnalyticsPersistenceSlice.entries
      : [];
    const provenance = Array.isArray(salesAnalyticsPersistenceSlice?.provenance)
      ? salesAnalyticsPersistenceSlice.provenance
      : [];
    const schemaStatements = Array.isArray(salesAnalyticsSchemaContract?.statements)
      ? salesAnalyticsSchemaContract.statements
      : [];
    const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
    const schemaName = "grabenplaner_audit";
    const salesRelations = [
      "sales_import_profiles",
      "sales_import_profile_revisions",
      "sales_import_runs",
      "sales_import_staging_records",
      "sales_branch_mapping_heads",
      "sales_branch_mapping_revisions",
      "sales_aggregate_reports",
      "sales_report_product_group_metrics",
      "sales_report_total_metrics",
    ];
    const fieldSnapshot = (fields, preserveOrder) => {
      const names = preserveOrder ? Object.keys(fields || {}) : Object.keys(fields || {}).sort();
      return names.map((name) => ({ name, ...fields[name] }));
    };
    const sourceCatalogSnapshot = sourceCatalog.map(({ statement, sql, returning }) => ({
      statement: {
        id: statement?.id,
        operation: statement?.operation,
        parameters: fieldSnapshot(statement?.parameters, false),
        columns: fieldSnapshot(statement?.columns, true),
      },
      sql,
      returning,
    }));
    const sourceCatalogFingerprint = sha256(JSON.stringify(sourceCatalogSnapshot));
    const qualifyRelations = (sql) => {
      let qualified = sql;
      for (const relation of salesRelations) {
        qualified = qualified.replace(
          new RegExp(`\\b${relation}\\b`, "g"),
          `"${schemaName}"."${relation}"`,
        );
      }
      return qualified;
    };
    const entriesValid = entries.length === SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_COUNT
      && provenance.length === entries.length
      && entries.every((entry, index) => {
        const sourceEntry = sourceCatalog[index];
        const sourceStatement = sourceStatements[index];
        const proof = provenance[index];
        if (!sourceEntry || sourceEntry.statement !== sourceStatement
          || entry?.statement !== sourceStatement
          || !Object.isFrozen(entry)
          || typeof entry.sql !== "string"
          || !entry.sql.includes(`"${schemaName}".`)
          || !Array.isArray(entry.parameterOrder)
          || !Object.isFrozen(entry.parameterOrder)
          || JSON.stringify(entry.parameterOrder)
            !== JSON.stringify(Object.keys(sourceStatement.parameters).sort())
          || !Array.isArray(entry.parameterBindings)
          || !Object.isFrozen(entry.parameterBindings)
          || typeof entry.returning !== "boolean"
          || entry.returning !== sourceEntry.returning
          || !proof
          || !Object.isFrozen(proof)
          || proof.statementId !== sourceStatement.id
          || proof.sourceSqlFingerprint !== sha256(sourceEntry.sql)
          || !/^[a-f0-9]{64}$/.test(String(proof.qualifiedSqlFingerprint || ""))
          || proof.compiledSqlFingerprint !== sha256(entry.sql)
          || !Array.isArray(proof.coveredFeatures)) {
          return false;
        }
        try {
          const qualifiedSql = qualifyRelations(sourceEntry.sql);
          const compiled = compiler?.compilePostgresqlDialectEntry?.({
            statement: sourceStatement,
            sql: qualifiedSql,
            returning: sourceEntry.returning,
          });
          return compiled?.strategy === "portable-generated"
            && compiled.compiledSql === entry.sql
            && proof.qualifiedSqlFingerprint === sha256(qualifiedSql)
            && proof.compiledSqlFingerprint === compiled.compiledSqlFingerprint
            && JSON.stringify(proof.coveredFeatures)
              === JSON.stringify(compiled.coveredFeatures);
        } catch {
          return false;
        }
      });
    const statementIds = sourceStatements.map((statement) => statement?.id);
    const statementContractValid = (
      sourceStatements.length === SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_COUNT
      && sourceCatalog.length === SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_COUNT
      && JSON.stringify(statementIds)
        === JSON.stringify(SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_IDS)
      && new Set(statementIds).size === statementIds.length
    );
    const sourceCatalogFingerprintValid = Boolean(
      /^[a-f0-9]{64}$/.test(sourceCatalogFingerprint)
      && salesAnalyticsPersistenceSlice?.sourceCatalogFingerprint
        === sourceCatalogFingerprint
    );
    const sliceFingerprintValid = Boolean(
      /^[a-f0-9]{64}$/.test(String(salesAnalyticsPersistenceSlice?.fingerprint || ""))
      && salesAnalyticsPersistenceSlice.fingerprint === sha256(JSON.stringify({
        sliceId: salesAnalyticsPersistenceSlice.sliceId,
        schemaName: salesAnalyticsPersistenceSlice.schemaName,
        sourceCatalogFingerprint: salesAnalyticsPersistenceSlice.sourceCatalogFingerprint,
        entries: provenance,
      }))
    );
    const schemaIds = schemaStatements.map((statement) => statement?.id);
    const schemaFingerprintValid = Boolean(
      /^[a-f0-9]{64}$/.test(String(salesAnalyticsSchemaContract?.fingerprint || ""))
      && salesAnalyticsSchemaContract.fingerprint === sha256(JSON.stringify({
        contractVersion: salesAnalyticsSchemaContract.contractVersion,
        schemaName: salesAnalyticsSchemaContract.schemaName,
        statements: schemaStatements,
      }))
    );
    const schemaSql = schemaStatements.map((statement) => statement?.sql || "").join("\n");
    const schemaContractValid = Boolean(
      salesAnalyticsSchemaContract
      && salesAnalyticsSchemaContract.contractVersion === 3
      && salesAnalyticsSchemaContract.status === "development-contract"
      && salesAnalyticsSchemaContract.executable === true
      && salesAnalyticsSchemaContract.applicationExecutable === false
      && salesAnalyticsSchemaContract.productActivation === false
      && Object.isFrozen(salesAnalyticsSchemaContract)
      && Object.isFrozen(schemaStatements)
      && schemaStatements.length === SALES_ANALYTICS_EXPECTED_SCHEMA_STATEMENT_COUNT
      && JSON.stringify(schemaIds)
        === JSON.stringify(SALES_ANALYTICS_EXPECTED_SCHEMA_STATEMENT_IDS)
      && new Set(schemaIds).size === schemaIds.length
      && schemaStatements.every((statement) => (
        Object.isFrozen(statement)
        && typeof statement.sql === "string"
        && statement.sql.includes(`"${schemaName}".`)
      ))
      && /\bJSONB\b/.test(schemaSql)
      && /\bTIMESTAMPTZ\b/.test(schemaSql)
      && /sales_reject_immutable_mutation/.test(schemaSql)
      && schemaSql.includes(`"${schemaName}"."locations"`)
      && !/\bCREATE\s+SCHEMA\b/i.test(schemaSql)
      && schemaFingerprintValid
    );
    const applicationBoundaryFiles = [
      "server.js",
      "lib/persistence/application-repositories.js",
      "lib/persistence/sqlite/application-catalog.js",
      "lib/persistence/sqlite/operations/application-schema.js",
    ];
    const applicationBoundaryPatterns = [
      /sales-analytics-(?:catalog|schema)/g,
      /createSalesAnalyticsPersistenceRepository/g,
      /ensureSqliteSalesAnalyticsSchema/g,
      /SALES_ANALYTICS_PERSISTENCE_STATEMENTS/g,
      /SQLITE_SALES_ANALYTICS_CATALOG/g,
    ];
    const applicationSourceReferences = applicationBoundaryFiles.reduce((total, relativeFile) => {
      if (!fs.existsSync(path.join(root, relativeFile))) return total;
      const text = fs.readFileSync(path.join(root, relativeFile), "utf8");
      return total + applicationBoundaryPatterns.reduce(
        (fileTotal, pattern) => fileTotal + [...text.matchAll(pattern)].length,
        0,
      );
    }, 0);
    const applicationCatalogStatementReferences = Array.isArray(
      sqliteApplicationCatalog?.SQLITE_APPLICATION_CATALOG,
    )
      ? sqliteApplicationCatalog.SQLITE_APPLICATION_CATALOG.filter(
        (entry) => String(entry?.statement?.id || "").startsWith("sales-analytics."),
      ).length
      : -1;
    const applicationWiringReferences = applicationSourceReferences
      + Math.max(0, applicationCatalogStatementReferences);
    const repositoryContractValid = Boolean(
      typeof salesAnalyticsRepository?.createSalesAnalyticsPersistenceRepository === "function"
      && typeof salesAnalyticsSqliteSchema?.ensureSqliteSalesAnalyticsSchema === "function"
    );
    const valid = Boolean(
      salesAnalyticsPersistenceSlice
      && salesAnalyticsPersistenceSlice.sliceId === "sales-analytics-persistence"
      && salesAnalyticsPersistenceSlice.status === "development-contract"
      && salesAnalyticsPersistenceSlice.developmentExecutable === true
      && salesAnalyticsPersistenceSlice.executable === true
      && salesAnalyticsPersistenceSlice.applicationExecutable === false
      && salesAnalyticsPersistenceSlice.fullApplicationCatalog === false
      && salesAnalyticsPersistenceSlice.productActivation === false
      && salesAnalyticsPersistenceSlice.schemaName === schemaName
      && Object.isFrozen(salesAnalyticsPersistenceSlice)
      && Object.isFrozen(entries)
      && Object.isFrozen(provenance)
      && statementContractValid
      && entriesValid
      && sourceCatalogFingerprintValid
      && sliceFingerprintValid
      && schemaContractValid
      && repositoryContractValid
      && applicationCatalogStatementReferences
        === SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_COUNT
      && applicationSourceReferences >= 6
      && applicationWiringReferences
        >= SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_COUNT + 6
      && missingSalesAnalyticsFiles.length === 0
      && missingSalesAnalyticsTestFiles.length === 0
    );
    return {
      valid,
      report: {
        status: salesAnalyticsPersistenceSlice?.status || "",
        valid,
        standaloneContract: false,
        sqliteApplicationIntegrated: applicationCatalogStatementReferences
          === SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_COUNT,
        sourceCatalogFingerprintValid,
        sliceFingerprintValid,
        schemaContractValid,
        schemaFingerprintValid,
        repositoryContractValid,
        developmentExecutable: salesAnalyticsPersistenceSlice?.developmentExecutable === true,
        executable: salesAnalyticsPersistenceSlice?.executable === true,
        applicationExecutable: salesAnalyticsPersistenceSlice?.applicationExecutable ?? null,
        fullApplicationCatalog: salesAnalyticsPersistenceSlice?.fullApplicationCatalog ?? null,
        productActivation: salesAnalyticsPersistenceSlice?.productActivation ?? null,
        statementCount: entries.length,
        expectedStatementCount: SALES_ANALYTICS_EXPECTED_PERSISTENCE_STATEMENT_COUNT,
        executableStatementCount: entriesValid ? entries.length : 0,
        schemaStatementCount: schemaStatements.length,
        expectedSchemaStatementCount: SALES_ANALYTICS_EXPECTED_SCHEMA_STATEMENT_COUNT,
        applicationWiringReferences,
      },
    };
  }

  const uiPreferencesProgress = inspectDevelopmentSlice({
    relativeFile: "lib/persistence/postgresql/ui-preferences-catalog.js",
    slice: uiPreferencesSlice,
    expectedSliceId: "ui-preferences",
    expectedStatementIds: PHASE_5_EXPECTED_UI_PREFERENCES_STATEMENT_IDS,
    featureProperty: "resolvedFeatures",
  });
  const planningSettingsProgress = inspectDevelopmentSlice({
    relativeFile: "lib/persistence/postgresql/planning-settings-catalog.js",
    slice: planningSettingsSlice,
    expectedSliceId: "planning-settings.settings",
    expectedStatementIds: PHASE_5_EXPECTED_PLANNING_SETTINGS_STATEMENT_IDS,
    featureProperty: "coveredFeatures",
  });
  const organizationDepartmentsProgress = inspectDevelopmentSlice({
    relativeFile: "lib/persistence/postgresql/organization-departments-catalog.js",
    slice: organizationDepartmentsSlice,
    expectedSliceId: "organization-personnel.departments",
    expectedStatementIds: PHASE_5_EXPECTED_ORGANIZATION_DEPARTMENTS_STATEMENT_IDS,
    featureProperty: "coveredFeatures",
    semanticResolutionsRequired: true,
  });
  const systemCenterMetricsProgress = inspectDevelopmentSlice({
    relativeFile: "lib/persistence/postgresql/system-center-metrics-catalog.js",
    slice: systemCenterMetricsSlice,
    expectedSliceId: "system-center-metrics.oldest-interval-keys",
    expectedStatementIds: PHASE_5_EXPECTED_SYSTEM_CENTER_METRICS_STATEMENT_IDS,
    featureProperty: "coveredFeatures",
    semanticResolutionsRequired: true,
  });
  const salesAnalyticsPersistenceProgress = inspectSalesAnalyticsPersistenceSlice();
  const developmentSliceStatementCount = [
    uiPreferencesProgress,
    planningSettingsProgress,
    organizationDepartmentsProgress,
    systemCenterMetricsProgress,
    salesAnalyticsPersistenceProgress,
  ].reduce(
    (total, progress) => total + progress.report.executableStatementCount,
    0,
  );
  const configurationStillClosed = (
    JSON.stringify(configuration?.IMPLEMENTED_PERSISTENCE_PROVIDER_IDS) === JSON.stringify(["sqlite"])
  );
  const serverActivationReferences = [
    ...serverText.matchAll(/\b(?:open|create)Postgresql[A-Za-z0-9_]*\b/g),
    ...serverText.matchAll(/["'][^"']*\/persistence\/postgresql(?:\/[^"']*)?["']/g),
    ...serverText.matchAll(/\brequire\s*\(\s*["']pg(?:\/[^"']*)?["']\s*\)/g),
  ].length;
  // The full server is now qualified only behind the explicit Linux/private-
  // network rehearsal guard. Default and productive PostgreSQL remain closed.
  const rehearsalConfiguration = require('../lib/persistence/postgresql/rehearsal-configuration');
  const rehearsalGuardClosed = [
    { DB_PROVIDER: 'postgresql' },
    { DB_PROVIDER: 'postgresql', NODE_ENV: 'production', GRABENPLANER_POSTGRESQL_REHEARSAL: 'application-11' },
  ].every(environment => {
    try { configuration.resolvePersistenceConfiguration({ environment }); return false; }
    catch { return true; }
  }) && typeof rehearsalConfiguration.configuration === 'function';
  const providerContractValid = Boolean(
    capabilities
    && capabilities.features?.atomicTransactions === true
    && capabilities.features?.concurrentWrites === true
    && capabilities.features?.multipleAppInstances === false
    && capabilities.features?.databaseBackup === false
    && capabilities.features?.restore === false
    && capabilities.features?.pointInTimeRecovery === false
    && typeof provider.createPostgresqlPersistenceProvider === "function"
    && typeof provider.mapPostgresqlError === "function"
  );
  const policyValid = Boolean(
    defaultPolicy
    && defaultPolicy.minimumConnections === 0
    && defaultPolicy.maximumConnections === 5
    && defaultPolicy.connectionTimeoutMilliseconds === 5_000
    && defaultPolicy.idleTimeoutMilliseconds === 30_000
    && defaultPolicy.statementTimeoutMilliseconds === 30_000
    && defaultPolicy.queryTimeoutMilliseconds === 32_000
    && defaultPolicy.transactionTimeoutMilliseconds === 60_000
    && defaultPolicy.maximumConnectionLifetimeSeconds === 3_600
    && policy.POSTGRESQL_EXPERIMENTAL_PROFILE === "development-contract"
    && JSON.stringify(policy.POSTGRESQL_ROLE_PURPOSES)
      === JSON.stringify(["application", "backup", "migration", "operations"])
    && typeof policy.createPostgresqlPoolConfiguration === "function"
    && typeof pool?.openPostgresqlDevelopmentPersistence === "function"
  );
  const compilerValid = Boolean(
    compiler?.POSTGRESQL_DIALECT_COMPILER_VERSION === PHASE_5_EXPECTED_COMPILER_VERSION
    && typeof compiler?.compilePostgresqlDialectEntry === "function"
    && Array.isArray(compiler?.POSTGRESQL_DIALECT_STRATEGIES)
  );
  const dependencyValid = packageJson.dependencies?.pg === "8.22.0";
  const planValid = Boolean(
    dialectPlan
    && dialectPlan.status === "implementation-in-progress"
    && dialectPlan.executable === false
    && dialectPlan.compilerVersion === PHASE_5_EXPECTED_COMPILER_VERSION
    && planEntries.length === PHASE_4_EXPECTED_STATEMENT_COUNT
    && portableDialectCount === PHASE_5_EXPECTED_PORTABLE_DIALECT_COUNT
    && overrideDialectCount === PHASE_5_EXPECTED_OVERRIDE_DIALECT_COUNT
    && portableDialectCount + overrideDialectCount === PHASE_4_EXPECTED_STATEMENT_COUNT
    && planEntries.every((entry) => (
      (entry.strategy === "portable-generated"
        && typeof entry.sql === "string"
        && /^[a-f0-9]{64}$/.test(String(entry.compiledSqlFingerprint || "")))
      || (entry.strategy === "requires-override"
        && !Object.hasOwn(entry, "sql")
        && !Object.hasOwn(entry, "compiledSqlFingerprint"))
    ))
  );
  const applicationAcceptance = catalogContract?.POSTGRESQL_APPLICATION_ACCEPTANCE;
  let applicationCatalogGateClosed = false;
  if (typeof catalogContract?.assertFullPostgresqlApplicationCatalog === "function") {
    try {
      catalogContract.assertFullPostgresqlApplicationCatalog(dialectPlan);
    } catch (error) {
      applicationCatalogGateClosed = new RegExp(
        `0/${PHASE_4_EXPECTED_STATEMENT_COUNT}`,
      ).test(String(error?.message || error));
    }
  }
  const fullApplicationCatalogExecutable = (
    dialectPlan?.executable === true || !applicationCatalogGateClosed
  );
  const catalogContractValid = Boolean(
    catalogContract?.POSTGRESQL_CATALOG_CONTRACT_VERSION === 1
    && catalogContract.POSTGRESQL_FULL_APPLICATION_STATEMENT_COUNT
      === PHASE_4_EXPECTED_STATEMENT_COUNT
    && applicationAcceptance?.status === "closed"
    && applicationAcceptance.requiredReceiptCount === PHASE_4_EXPECTED_STATEMENT_COUNT
    && applicationAcceptance.acceptedReceiptCount === 0
    && typeof catalogContract.definePostgresqlApplicationCatalog === "function"
    && typeof catalogContract.definePostgresqlGeneratedCatalogEntry === "function"
    && typeof catalogContract.definePostgresqlOverrideCatalogEntry === "function"
    && typeof catalogContract.describePostgresqlDevelopmentSlice === "function"
    && applicationCatalogGateClosed
    && fullApplicationCatalogExecutable === false
  );
  const migrationAdapterText = fs.existsSync(
    path.join(root, "lib/persistence/postgresql/migrations/adapter.js"),
  )
    ? fs.readFileSync(
      path.join(root, "lib/persistence/postgresql/migrations/adapter.js"),
      "utf8",
    )
    : "";
  const advisoryLockSql = "SELECT pg_catalog.pg_advisory_lock($1::bigint)";
  const serializableBeginSql = "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE";
  const advisoryUnlockSql =
    "SELECT pg_catalog.pg_advisory_unlock($1::bigint) AS unlocked";
  const literalCount = (value, literal) => value.split(literal).length - 1;
  const advisoryLockStatementCount = literalCount(migrationAdapterText, advisoryLockSql);
  const serializableTransactionStatementCount = literalCount(
    migrationAdapterText,
    serializableBeginSql,
  );
  const advisoryUnlockStatementCount = literalCount(
    migrationAdapterText,
    advisoryUnlockSql,
  );
  const advisoryLockIndex = migrationAdapterText.indexOf(advisoryLockSql);
  const serializableBeginIndex = migrationAdapterText.indexOf(serializableBeginSql);
  const advisoryUnlockIndex = migrationAdapterText.indexOf(advisoryUnlockSql);
  const sessionAdvisoryLockBeforeSerializableTransaction = Boolean(
    advisoryLockStatementCount === 1
    && serializableTransactionStatementCount === 1
    && advisoryUnlockStatementCount === 1
    && advisoryLockIndex >= 0
    && advisoryLockIndex < serializableBeginIndex
    && serializableBeginIndex < advisoryUnlockIndex
  );
  const migrationAdapterValid = Boolean(
    migrationAdapter
    && migrationAdapter.providerId === "postgresql"
    && migrationAdapter.status === "development-contract"
    && migrationAdapter.expectedRole === "grabenplaner_audit_role"
    && migrationAdapter.applicationMigrationsImplemented === 0
    && migrationAdapter.productActivation === false
    && migrationAdapter.concurrencyContract?.lockFunction === "pg_advisory_lock"
    && migrationAdapter.concurrencyContract?.lockScope === "session-before-transaction"
    && migrationAdapter.concurrencyContract?.retry === false
    && migrationAdapter.securityBoundary?.artifactExecution
      === "adapter-owned-versioned-sql-bundle"
    && migrationAdapter.securityBoundary?.inheritedRoles === "rejected"
    && migrationAdapter.securityBoundary?.ledgerAccessFromArtifacts === "rejected"
    && migrationAdapter.securityBoundary?.roleRequirement
      === "dedicated-least-privilege-schema-role"
    && typeof migrationAdapter.runExclusive === "function"
    && sessionAdvisoryLockBeforeSerializableTransaction
  );
  const providerSliceComplete = (
    missingFiles.length === 0
    && missingTestFiles.length === 0
    && moduleErrors.length === 0
    && configurationStillClosed
    && (serverActivationReferences === 0 || rehearsalGuardClosed)
    && providerContractValid
    && policyValid
    && compilerValid
    && dependencyValid
    && planValid
    && catalogContractValid
    && uiPreferencesProgress.valid
    && planningSettingsProgress.valid
    && organizationDepartmentsProgress.valid
    && systemCenterMetricsProgress.valid
    && salesAnalyticsPersistenceProgress.valid
    && developmentSliceStatementCount
      === PHASE_5_EXPECTED_DEVELOPMENT_SLICE_STATEMENT_COUNT
    && migrationAdapterValid
  );

  return {
    status: "in-progress",
    providerSliceStatus: providerSliceComplete ? "completed" : "in-progress",
    providerSliceComplete,
    productionActivation: false,
    configurationStillClosed,
    serverActivationReferences,
    rehearsalGuardClosed,
    driverDependency: packageJson.dependencies?.pg || "",
    providerContractValid,
    policyValid,
    compilerValid,
    compilerVersion: compiler?.POSTGRESQL_DIALECT_COMPILER_VERSION || 0,
    dialectPlanValid: planValid,
    dialectPlanStatementCount: planEntries.length,
    portableDialectCount,
    overrideDialectCount,
    executableApplicationDialectCount: dialectPlan?.executable === true
      ? planEntries.length
      : 0,
    fullApplicationCatalogExecutable,
    catalogContract: {
      valid: catalogContractValid,
      executableSlice: false,
      applicationExecutable: fullApplicationCatalogExecutable,
      fullApplicationCatalog: false,
      acceptanceStatus: applicationAcceptance?.status || "",
      requiredReceiptCount: applicationAcceptance?.requiredReceiptCount || 0,
      acceptedReceiptCount: applicationAcceptance?.acceptedReceiptCount || 0,
    },
    uiPreferencesSlice: uiPreferencesProgress.report,
    planningSettingsSlice: planningSettingsProgress.report,
    organizationDepartmentsSlice: organizationDepartmentsProgress.report,
    systemCenterMetricsSlice: systemCenterMetricsProgress.report,
    salesAnalyticsPersistenceSlice: salesAnalyticsPersistenceProgress.report,
    developmentSlices: {
      sliceCount: 5,
      executableStatementCount: developmentSliceStatementCount,
      expectedStatementCount: PHASE_5_EXPECTED_DEVELOPMENT_SLICE_STATEMENT_COUNT,
      applicationExecutable: false,
      fullApplicationCatalog: false,
    },
    migrationAdapter: {
      status: migrationAdapter?.status || "",
      valid: migrationAdapterValid,
      sessionAdvisoryLockBeforeSerializableTransaction,
      advisoryLockStatementCount,
      serializableTransactionStatementCount,
      advisoryUnlockStatementCount,
      expectedRole: migrationAdapter?.expectedRole || "",
      artifactExecution:
        migrationAdapter?.securityBoundary?.artifactExecution || "",
      roleBoundaryEnforced: Boolean(
        migrationAdapter?.securityBoundary?.inheritedRoles === "rejected"
        && migrationAdapter?.securityBoundary?.roleRequirement
          === "dedicated-least-privilege-schema-role"
      ),
      ledgerAccessFromArtifacts:
        migrationAdapter?.securityBoundary?.ledgerAccessFromArtifacts || "",
      applicationMigrationsImplemented:
        migrationAdapter?.applicationMigrationsImplemented ?? null,
      expectedApplicationMigrationCount: PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT,
      productActivation: migrationAdapter?.productActivation ?? null,
    },
    executableMigrationBindingCount: 0,
    missingFiles,
    missingTestFiles,
    missingSalesAnalyticsFiles,
    missingSalesAnalyticsTestFiles,
    moduleErrors,
  };
}

function inspectPhase6PostgresqlOperations(root) {
  const missingFiles = PHASE_6_POSTGRESQL_OPERATIONS_FILES
    .filter((file) => !fs.existsSync(path.join(root, file)))
    .sort();
  const missingTestFiles = PHASE_6_POSTGRESQL_OPERATIONS_TEST_FILES
    .filter((file) => !fs.existsSync(path.join(root, file)))
    .sort();
  const moduleErrors = [];
  const exportContractErrors = [];
  const modules = new Map();

  function safeRequire(relativeFile) {
    if (!fs.existsSync(path.join(root, relativeFile))) return null;
    try {
      const loaded = require(path.join(root, relativeFile));
      modules.set(relativeFile, loaded);
      return loaded;
    } catch (error) {
      moduleErrors.push({
        file: relativeFile,
        message: String(error?.message || error),
      });
      return null;
    }
  }

  for (const file of PHASE_6_POSTGRESQL_OPERATIONS_FILES) safeRequire(file);
  const configuration = safeRequire("lib/persistence/configuration.js");
  const requiredExports = new Map([
    ["lib/backup-bundle.js", Object.freeze({
      BACKUP_BUNDLE_SCHEMA_VERSION: "number",
      verifyBackupBundle: "function",
      writeBackupBundleCommitMarker: "function",
    })],
    ["lib/persistence/operations/contract.js", Object.freeze({
      OPERATIONAL_CONTRACT_VERSION: "number",
      createOperationalCapabilityReport: "function",
      createPersistenceOperationsFacade: "function",
    })],
    ["lib/persistence/operations/mutation-quiesce.js", Object.freeze({
      createProtectedDocumentMutationGate: "function",
    })],
    ["lib/persistence/operations/recovery-assurance.js", Object.freeze({
      RECOVERY_ASSURANCE_SCHEMA_VERSION: "number",
      createRecoveryAssuranceReceipt: "function",
      verifyRecoveryAssuranceReceipt: "function",
    })],
    ["lib/persistence/postgresql/operations/backup.js", Object.freeze({
      createPostgresqlBackupSnapshot: "function",
    })],
    ["lib/persistence/postgresql/operations/evidence.js", Object.freeze({
      POSTGRESQL_RECOVERY_EVIDENCE_SCHEMA_VERSION: "number",
      createPostgresqlRecoveryEvidenceReader: "function",
    })],
    ["lib/persistence/postgresql/operations/monitor.js", Object.freeze({
      POSTGRESQL_MONITOR_SCHEMA_VERSION: "number",
      createPostgresqlOperationsMonitor: "function",
    })],
    ["lib/persistence/postgresql/operations/restore.js", Object.freeze({
      verifyPostgresqlBackupRestore: "function",
    })],
    ["lib/persistence/postgresql/operations/snapshot.js", Object.freeze({
      withPostgresqlExportedSnapshot: "function",
    })],
    ["lib/persistence/postgresql/operations/tools.js", Object.freeze({
      POSTGRESQL_LOGICAL_BACKUP_METHOD: "string",
      POSTGRESQL_LOGICAL_RESTORE_METHOD: "string",
      POSTGRESQL_OPERATIONAL_PROFILE: "string",
      createPostgresqlToolPolicy: "function",
    })],
  ]);

  for (const [file, expectedExports] of requiredExports) {
    const loaded = modules.get(file);
    if (!loaded) continue;
    for (const [exportName, expectedType] of Object.entries(expectedExports)) {
      if (typeof loaded[exportName] !== expectedType) {
        exportContractErrors.push({
          file,
          exportName,
          expectedType,
          actualType: typeof loaded[exportName],
        });
      }
    }
  }

  const backupBundle = modules.get("lib/backup-bundle.js");
  const operationsContract = modules.get("lib/persistence/operations/contract.js");
  const mutationQuiesce = modules.get(
    "lib/persistence/operations/mutation-quiesce.js",
  );
  const recoveryAssurance = modules.get(
    "lib/persistence/operations/recovery-assurance.js",
  );
  const postgresqlBackup = modules.get(
    "lib/persistence/postgresql/operations/backup.js",
  );
  const postgresqlEvidence = modules.get(
    "lib/persistence/postgresql/operations/evidence.js",
  );
  const postgresqlMonitor = modules.get(
    "lib/persistence/postgresql/operations/monitor.js",
  );
  const postgresqlRestore = modules.get(
    "lib/persistence/postgresql/operations/restore.js",
  );
  const postgresqlSnapshot = modules.get(
    "lib/persistence/postgresql/operations/snapshot.js",
  );
  const postgresqlTools = modules.get(
    "lib/persistence/postgresql/operations/tools.js",
  );
  const implementedProviderIds = Array.isArray(
    configuration?.IMPLEMENTED_PERSISTENCE_PROVIDER_IDS,
  )
    ? [...configuration.IMPLEMENTED_PERSISTENCE_PROVIDER_IDS]
    : [];
  const configurationStillClosed =
    JSON.stringify(implementedProviderIds) === JSON.stringify(["sqlite"]);
  const serverText = fs.existsSync(path.join(root, "server.js"))
    ? fs.readFileSync(path.join(root, "server.js"), "utf8")
    : "";
  const serverActivationReferenceDetails = [
    {
      id: "postgresql-operations-module",
      count: countMatches(serverText, /persistence\/postgresql\/operations/g),
    },
    {
      id: "postgresql-backup",
      count: countMatches(serverText, /\bcreatePostgresqlBackupSnapshot\b/g),
    },
    {
      id: "postgresql-restore",
      count: countMatches(serverText, /\bverifyPostgresqlBackupRestore\b/g),
    },
    {
      id: "postgresql-monitoring",
      count: countMatches(serverText, /\bcreatePostgresqlOperationsMonitor\b/g),
    },
    {
      id: "persistence-operations-facade",
      count: countMatches(serverText, /\bcreatePersistenceOperationsFacade\b/g),
    },
    {
      id: "protected-document-mutation-gate",
      count: countMatches(serverText, /\bcreateProtectedDocumentMutationGate\b/g),
    },
  ].filter((entry) => entry.count > 0);
  const serverActivationReferences = serverActivationReferenceDetails
    .reduce((sum, entry) => sum + entry.count, 0);
  // The default provider remains closed. The 2026 managed runtime additionally
  // reads its protected root status; neither import can activate it by itself.
  const rehearsalExportOnly = serverActivationReferences === 2
    && serverActivationReferenceDetails[0]?.id === 'postgresql-operations-module'
    && countMatches(serverText, /persistence\/postgresql\/operations\/application-export/g) === 1
    && countMatches(serverText, /persistence\/postgresql\/operations\/status/g) === 1
    && [{DB_PROVIDER:'postgresql'}, {DB_PROVIDER:'postgresql',NODE_ENV:'production',GRABENPLANER_POSTGRESQL_REHEARSAL:'application-11'}]
      .every(environment => {try{configuration.resolvePersistenceConfiguration({environment});return false;}catch{return true;}});
  const versions = {
    backupBundle: backupBundle?.BACKUP_BUNDLE_SCHEMA_VERSION ?? null,
    operationalContract: operationsContract?.OPERATIONAL_CONTRACT_VERSION ?? null,
    recoveryAssurance:
      recoveryAssurance?.RECOVERY_ASSURANCE_SCHEMA_VERSION ?? null,
    postgresqlRecoveryEvidence:
      postgresqlEvidence?.POSTGRESQL_RECOVERY_EVIDENCE_SCHEMA_VERSION ?? null,
    postgresqlMonitor:
      postgresqlMonitor?.POSTGRESQL_MONITOR_SCHEMA_VERSION ?? null,
  };
  const operationalProfile =
    postgresqlTools?.POSTGRESQL_OPERATIONAL_PROFILE || "";
  const backupMethod =
    postgresqlTools?.POSTGRESQL_LOGICAL_BACKUP_METHOD || "";
  const restoreMethod =
    postgresqlTools?.POSTGRESQL_LOGICAL_RESTORE_METHOD || "";
  const capabilities = {
    backupBundle: typeof backupBundle?.verifyBackupBundle === "function",
    backup: typeof postgresqlBackup?.createPostgresqlBackupSnapshot === "function",
    isolatedRestore:
      typeof postgresqlRestore?.verifyPostgresqlBackupRestore === "function",
    monitoring:
      typeof postgresqlMonitor?.createPostgresqlOperationsMonitor === "function",
    recoveryAssurance:
      typeof recoveryAssurance?.createRecoveryAssuranceReceipt === "function"
      && typeof recoveryAssurance?.verifyRecoveryAssuranceReceipt === "function",
    mutationQuiesce:
      typeof mutationQuiesce?.createProtectedDocumentMutationGate === "function",
    operationsFacade:
      typeof operationsContract?.createPersistenceOperationsFacade === "function",
    recoveryEvidence:
      typeof postgresqlEvidence?.createPostgresqlRecoveryEvidenceReader === "function",
    exportedSnapshot:
      typeof postgresqlSnapshot?.withPostgresqlExportedSnapshot === "function",
  };
  const operationsFoundationComplete = Boolean(
    missingFiles.length === 0
    && missingTestFiles.length === 0
    && moduleErrors.length === 0
    && exportContractErrors.length === 0
    && configurationStillClosed
    && (serverActivationReferences === 0 || rehearsalExportOnly)
    && operationalProfile === "development-contract"
    && backupMethod === "postgresql-pg-dump-custom"
    && restoreMethod === "postgresql-pg-restore-custom"
    && backupBundle?.BACKUP_BUNDLE_METHODS?.postgresql === backupMethod
    && versions.backupBundle === 2
    && versions.operationalContract === 1
    && versions.recoveryAssurance === 2
    && versions.postgresqlRecoveryEvidence === 1
    && versions.postgresqlMonitor === 1
    && Object.values(capabilities).every(Boolean)
  );

  return {
    status: "in-progress",
    operationsFoundationStatus:
      operationsFoundationComplete ? "completed" : "in-progress",
    operationsFoundationComplete,
    scope: "non-production-operations-foundation",
    productionActivation: false,
    supportApproved: false,
    cutoverImplemented: false,
    configurationStillClosed,
    implementedProviderIds,
    serverActivationReferences,
    serverActivationReferenceDetails,
    operationalProfile,
    backupMethod,
    restoreMethod,
    versions,
    capabilities,
    productionFiles: PHASE_6_POSTGRESQL_OPERATIONS_FILES,
    testFiles: PHASE_6_POSTGRESQL_OPERATIONS_TEST_FILES,
    missingFiles,
    missingTestFiles,
    moduleErrors,
    exportContractErrors,
  };
}

function scanRepository(root = REPOSITORY_ROOT) {
  const directGroups = expandGroups(PRODUCTION_DIRECT_GROUPS);
  const indirectGroups = expandGroups(PRODUCTION_INDIRECT_GROUPS);
  const baselineTests = new Set([
    ...BASELINE_TEST_FILES,
    ...TEST_SPECIAL_GROUPS["deployment-operations-verification"],
  ]);
  const classificationDuplicates = [
    ...directGroups.duplicates,
    ...indirectGroups.duplicates,
    ...[...directGroups.entries.keys()].filter((file) => indirectGroups.entries.has(file)),
    ...PHASE_2_CONTRACT_FILES.filter((file) => directGroups.entries.has(file) || indirectGroups.entries.has(file)),
    ...PHASE_2_CONTRACT_TEST_FILES.filter((file) => baselineTests.has(file)),
    ...PHASE_3_SQLITE_PROVIDER_FILES.filter((file) => (
      directGroups.entries.has(file)
      || indirectGroups.entries.has(file)
      || PHASE_2_CONTRACT_FILE_SET.has(file)
    )),
    ...PHASE_3_SQLITE_PROVIDER_TEST_FILES.filter((file) => (
      baselineTests.has(file)
      || PHASE_2_CONTRACT_TEST_FILE_SET.has(file)
    )),
    ...PHASE_4_PERSISTENCE_FILES.filter((file) => (
      directGroups.entries.has(file)
      || indirectGroups.entries.has(file)
      || PHASE_2_CONTRACT_FILE_SET.has(file)
      || PHASE_3_SQLITE_PROVIDER_FILE_SET.has(file)
    )),
    ...PHASE_4_PERSISTENCE_TEST_FILES.filter((file) => (
      baselineTests.has(file)
      || PHASE_2_CONTRACT_TEST_FILE_SET.has(file)
      || PHASE_3_SQLITE_PROVIDER_TEST_FILE_SET.has(file)
    )),
    ...PHASE_5_POSTGRESQL_FILES.filter((file) => (
      directGroups.entries.has(file)
      || indirectGroups.entries.has(file)
      || PHASE_2_CONTRACT_FILE_SET.has(file)
      || PHASE_3_SQLITE_PROVIDER_FILE_SET.has(file)
      || PHASE_4_PERSISTENCE_FILE_SET.has(file)
    )),
    ...PHASE_5_POSTGRESQL_TEST_FILES.filter((file) => (
      baselineTests.has(file)
      || PHASE_2_CONTRACT_TEST_FILE_SET.has(file)
      || PHASE_3_SQLITE_PROVIDER_TEST_FILE_SET.has(file)
      || PHASE_4_PERSISTENCE_TEST_FILE_SET.has(file)
    )),
    ...SALES_ANALYTICS_PERSISTENCE_SLICE_FILES.filter((file) => (
      directGroups.entries.has(file)
      || indirectGroups.entries.has(file)
      || PHASE_2_CONTRACT_FILE_SET.has(file)
      || PHASE_3_SQLITE_PROVIDER_FILE_SET.has(file)
      || PHASE_4_PERSISTENCE_FILE_SET.has(file)
      || PHASE_5_POSTGRESQL_FILE_SET.has(file)
    )),
    ...SALES_ANALYTICS_PERSISTENCE_SLICE_TEST_FILES.filter((file) => (
      baselineTests.has(file)
      || PHASE_2_CONTRACT_TEST_FILE_SET.has(file)
      || PHASE_3_SQLITE_PROVIDER_TEST_FILE_SET.has(file)
      || PHASE_4_PERSISTENCE_TEST_FILE_SET.has(file)
      || PHASE_5_POSTGRESQL_TEST_FILE_SET.has(file)
    )),
    ...PHASE_6_POSTGRESQL_OPERATIONS_FILES.filter((file) => (
      directGroups.entries.has(file)
      || indirectGroups.entries.has(file)
      || PHASE_2_CONTRACT_FILE_SET.has(file)
      || PHASE_3_SQLITE_PROVIDER_FILE_SET.has(file)
      || PHASE_4_PERSISTENCE_FILE_SET.has(file)
      || PHASE_5_POSTGRESQL_FILE_SET.has(file)
      || SALES_ANALYTICS_PERSISTENCE_SLICE_FILE_SET.has(file)
    )),
    ...PHASE_6_POSTGRESQL_OPERATIONS_TEST_FILES.filter((file) => (
      baselineTests.has(file)
      || PHASE_2_CONTRACT_TEST_FILE_SET.has(file)
      || PHASE_3_SQLITE_PROVIDER_TEST_FILE_SET.has(file)
      || PHASE_4_PERSISTENCE_TEST_FILE_SET.has(file)
      || PHASE_5_POSTGRESQL_TEST_FILE_SET.has(file)
      || SALES_ANALYTICS_PERSISTENCE_SLICE_TEST_FILE_SET.has(file)
    )),
  ].sort();
  const files = [...new Set(SCAN_ROOTS.flatMap((entry) => listFiles(root, entry)))]
    .filter((file) => !EXCLUDED_FILES.has(file))
    .sort();
  const records = [];
  for (const file of files) {
    const isTest = file.startsWith("test/") || file.startsWith("test-support/") || ISOLATED_CASH_QUALIFICATION_CLI_FILES.has(file);
    const classification = MIGRATION_DEVELOPMENT_FILES.has(file) ? {
      ...PHASE_5_CLASSIFICATION,
      id: 'postgresql-core-migration-development',
      transitionException: 'Explicit 2026 migration development; isolated identity and roles; no product activation',
    } : isTest
      ? (baselineTests.has(file)
        ? testClassification(file)
        : (PHASE_2_CONTRACT_TEST_FILE_SET.has(file)
          ? PHASE_2_CLASSIFICATION
          : (PHASE_3_SQLITE_PROVIDER_TEST_FILE_SET.has(file)
            ? PHASE_3_CLASSIFICATION
            : (PHASE_4_PERSISTENCE_TEST_FILE_SET.has(file)
              ? PHASE_4_CLASSIFICATION
              : (PHASE_5_POSTGRESQL_TEST_FILE_SET.has(file)
                ? PHASE_5_CLASSIFICATION
                : (SALES_ANALYTICS_PERSISTENCE_SLICE_TEST_FILE_SET.has(file)
                  ? SALES_ANALYTICS_PERSISTENCE_CLASSIFICATION
                  : (PHASE_6_POSTGRESQL_OPERATIONS_TEST_FILE_SET.has(file)
                    ? PHASE_6_CLASSIFICATION
                    : null)))))))
      : (directGroups.entries.get(file)
        || indirectGroups.entries.get(file)
        || (PHASE_2_CONTRACT_FILE_SET.has(file)
          ? PHASE_2_CLASSIFICATION
          : (PHASE_3_SQLITE_PROVIDER_FILE_SET.has(file)
            ? PHASE_3_CLASSIFICATION
            : (PHASE_4_PERSISTENCE_FILE_SET.has(file)
              ? PHASE_4_CLASSIFICATION
              : (PHASE_5_POSTGRESQL_FILE_SET.has(file)
                ? PHASE_5_CLASSIFICATION
                : (SALES_ANALYTICS_PERSISTENCE_SLICE_FILE_SET.has(file)
                  ? SALES_ANALYTICS_PERSISTENCE_CLASSIFICATION
                  : (PHASE_6_POSTGRESQL_OPERATIONS_FILE_SET.has(file)
                    ? PHASE_6_CLASSIFICATION
                    : null)))))));
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const scanned = scanText(file, text, classification);
    const direct = hasDiscovery(scanned.counts, "directDiscovery");
    const indirect = hasDiscovery(scanned.counts, "indirectDiscovery");
    if (isTest && !direct) continue;
    if (!direct && !indirect && !indirectGroups.entries.has(file)) continue;
    records.push({ file, isTest, direct, indirect, classification, ...scanned });
  }

  const productionDirect = records.filter((record) => !record.isTest && record.direct);
  const productionIndirect = records.filter((record) => !record.isTest
    && !record.direct
    && !PHASE_2_CONTRACT_FILE_SET.has(record.file)
    && !PHASE_3_SQLITE_PROVIDER_FILE_SET.has(record.file)
    && !PHASE_4_PERSISTENCE_FILE_SET.has(record.file)
    && !PHASE_5_POSTGRESQL_FILE_SET.has(record.file)
    && !SALES_ANALYTICS_PERSISTENCE_SLICE_FILE_SET.has(record.file)
    && !PHASE_6_POSTGRESQL_OPERATIONS_FILE_SET.has(record.file)
    && (record.indirect || indirectGroups.entries.has(record.file)));
  const allTestCandidates = records.filter((record) => record.isTest && record.direct);
  const testCandidates = allTestCandidates.filter((record) => (
    !PHASE_2_CONTRACT_TEST_FILE_SET.has(record.file)
    && !PHASE_3_SQLITE_PROVIDER_TEST_FILE_SET.has(record.file)
    && !PHASE_4_PERSISTENCE_TEST_FILE_SET.has(record.file)
    && !PHASE_5_POSTGRESQL_TEST_FILE_SET.has(record.file)
    && !SALES_ANALYTICS_PERSISTENCE_SLICE_TEST_FILE_SET.has(record.file)
    && !PHASE_6_POSTGRESQL_OPERATIONS_TEST_FILE_SET.has(record.file)
  ));
  const productionTotals = Object.fromEntries(SIGNALS
    .filter((signal) => Object.hasOwn(BASELINE.productionTotals, signal.id))
    .map((signal) => [
      signal.id,
      productionDirect.reduce((sum, record) => sum + Number(record.counts[signal.id] || 0), 0),
    ]));
  const legacyProductionRecords = productionDirect
    .filter((record) => (
      !MIGRATION_DEVELOPMENT_FILES.has(record.file)
      &&
      !PHASE_3_SQLITE_PROVIDER_FILE_SET.has(record.file)
      && !SQLITE_MAINTENANCE_CLI_FILES.has(record.file)
      && !PHASE_4_PERSISTENCE_FILE_SET.has(record.file)
      && !PHASE_5_POSTGRESQL_FILE_SET.has(record.file)
      && !SALES_ANALYTICS_PERSISTENCE_SLICE_FILE_SET.has(record.file)
      && !PHASE_6_POSTGRESQL_OPERATIONS_FILE_SET.has(record.file)
    ));
  const legacyProductionTotals = Object.fromEntries(SIGNALS
    .filter((signal) => Object.hasOwn(BASELINE.productionTotals, signal.id))
    .map((signal) => [
      signal.id,
      legacyProductionRecords.reduce((sum, record) => sum + Number(record.counts[signal.id] || 0), 0),
    ]));
  const serverRecord = productionDirect.find((record) => record.file === "server.js");
  const serverText = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const serverHotspot = {
    prepareCall: serverRecord?.counts.prepareCall || 0,
    dbPrepareCall: [...serverText.matchAll(/\bdb\.prepare\s*\(/g)].length,
    dbExecCall: [...serverText.matchAll(/\bdb\.exec\s*\(/g)].length,
    beginImmediate: serverRecord?.counts.beginImmediate || 0,
    createTable: serverRecord?.counts.createTable || 0,
    createTriggerDdl: serverRecord?.counts.createTriggerDdl || 0,
    createIndex: serverRecord?.counts.createIndex || 0,
    alterTable: serverRecord?.counts.alterTable || 0,
    ensureColumn: serverRecord?.counts.ensureColumn || 0,
    schemaMigrations: serverRecord?.counts.schemaMigrations || 0,
    migrationIdDeclaration: serverRecord?.counts.migrationIdDeclaration || 0,
  };
  const productionDriverFiles = productionDirect
    .filter((record) => record.counts.directNodeSqliteImport > 0)
    .map((record) => record.file)
    .sort();
  const testDriverFiles = allTestCandidates
    .filter((record) => record.counts.directNodeSqliteImport > 0)
    .map((record) => record.file)
    .sort();
  const productionRegressions = Object.entries(BASELINE.productionTotals)
    .filter(([key, maximum]) => Number(legacyProductionTotals[key] || 0) > maximum)
    .map(([key, maximum]) => ({ key, maximum, actual: legacyProductionTotals[key] }));
  const serverRegressions = Object.entries(BASELINE.serverHotspot)
    .filter(([key, maximum]) => Number(serverHotspot[key] || 0) > maximum)
    .map(([key, maximum]) => ({ key, maximum, actual: serverHotspot[key] }));
  const missingIndirectFiles = [...indirectGroups.entries.keys()]
    .filter((file) => !fs.existsSync(path.join(root, file)))
    .sort();
  const missingPhase2Files = PHASE_2_CONTRACT_FILES
    .filter((file) => !fs.existsSync(path.join(root, file)))
    .sort();
  const missingPhase2TestFiles = PHASE_2_CONTRACT_TEST_FILES
    .filter((file) => !fs.existsSync(path.join(root, file)))
    .sort();
  const missingPhase3Files = PHASE_3_SQLITE_PROVIDER_FILES
    .filter((file) => !fs.existsSync(path.join(root, file)))
    .sort();
  const missingPhase3TestFiles = PHASE_3_SQLITE_PROVIDER_TEST_FILES
    .filter((file) => !fs.existsSync(path.join(root, file)))
    .sort();
  const phase3ProviderRecords = productionDirect
    .filter((record) => PHASE_3_SQLITE_PROVIDER_FILE_SET.has(record.file));
  const phase3RawAccessLayerViolations = phase3ProviderRecords
    .filter((record) => !PHASE_3_SQLITE_RAW_ACCESS_FILE_SET.has(record.file))
    .filter((record) => (
      Number(record.counts.prepareCall || 0) > 0
      || Number(record.counts.execCall || 0) > 0
    ))
    .map((record) => record.file)
    .sort();
  const phase3ProviderDriverFiles = productionDriverFiles
    .filter((file) => PHASE_3_SQLITE_DRIVER_FILE_SET.has(file));
  const phase3ProviderDriverImports = phase3ProviderRecords
    .reduce((sum, record) => sum + Number(record.counts.directNodeSqliteImport || 0), 0);
  const uiPreferencesFunctionNames = [
    "uiPreferencesForActor",
    "saveUiPreferencesForActor",
    "locationDashboardOrderForActor",
    "saveLocationDashboardOrder",
  ];
  const uiPreferencesFunctionSources = uiPreferencesFunctionNames
    .map((name) => namedFunctionSource(serverText, name));
  const uiPreferencesFunctionsFound = uiPreferencesFunctionSources
    .filter(Boolean)
    .length;
  const uiPreferencesLegacyRawCalls = uiPreferencesFunctionSources
    .reduce((sum, source) => (
      sum
      + countMatches(source, /\bdb\.prepare\s*\(/g)
      + countMatches(source, /\bdb\.exec\s*\(/g)
    ), 0);
  const uiPreferencesRepositoryWiringComplete = (
    uiPreferencesFunctionSources.length === 4
    && /\buiPreferencesRepository\.list\s*\(/.test(uiPreferencesFunctionSources[0] || "")
    && /\buiPreferencesRepository\.saveChanges\s*\(/.test(uiPreferencesFunctionSources[1] || "")
    && /\buiPreferencesRepository\.get\s*\(/.test(uiPreferencesFunctionSources[2] || "")
    && /\buiPreferencesRepository\.upsert\s*\(/.test(uiPreferencesFunctionSources[3] || "")
    && /\bopenSqliteApplicationPersistence\s*\(\s*\{[\s\S]{0,300}\bcatalog:\s*SQLITE_APPLICATION_CATALOG\b/.test(serverText)
    && /\bcreateApplicationRepositories\s*\(\s*persistenceProvider\s*\)/.test(serverText)
    && /\buiPreferences:\s*uiPreferencesRepository\b/.test(serverText)
    && /\bawait\s+rightsDashboardThemeForActor\s*\(/.test(namedFunctionSource(serverText, "rightsDashboardPayload"))
    && /\bawait\s+locationDashboardOrderForActor\s*\(/.test(namedFunctionSource(serverText, "locationDashboardPayload"))
  );
  const uiPreferencesRoutePatterns = [
    /app\.get\(\s*["']\/api\/portal\/v1\/ui-preferences["']\s*,\s*async[\s\S]{0,500}\bawait\s+uiPreferencesForActor\s*\(/,
    /app\.put\(\s*["']\/api\/portal\/v1\/ui-preferences["']\s*,\s*async[\s\S]{0,500}\bawait\s+saveUiPreferencesForActor\s*\(/,
    /app\.get\(\s*["']\/api\/portal\/v1\/rights-dashboard["']\s*,\s*async[\s\S]{0,500}\bawait\s+rightsDashboardPayload\s*\(/,
    /app\.get\(\s*["']\/api\/portal\/v1\/dashboards\/locations["']\s*,\s*async[\s\S]{0,500}\bawait\s+locationDashboardPayload\s*\(/,
    /app\.put\(\s*["']\/api\/portal\/v1\/dashboards\/locations\/preferences["']\s*,\s*async[\s\S]{0,500}\bawait\s+saveLocationDashboardOrder\s*\(/,
    /app\.put\(\s*["']\/api\/portal\/v1\/rights-dashboard\/preferences["']\s*,\s*async[\s\S]{0,700}\bawait\s+saveUiPreferencesForActor\s*\(/,
  ];
  const uiPreferencesRoutesAwaited = uiPreferencesRoutePatterns
    .every((pattern) => pattern.test(serverText));
  const uiPreferencesSliceComplete = (
    missingPhase3Files.length === 0
    && missingPhase3TestFiles.length === 0
    && phase3ProviderDriverFiles.length === 1
    && phase3ProviderDriverImports === 1
    && uiPreferencesFunctionsFound === uiPreferencesFunctionNames.length
    && uiPreferencesLegacyRawCalls === 0
    && uiPreferencesRepositoryWiringComplete
    && uiPreferencesRoutesAwaited
  );
  const domainRuntimeFiles = new Set([
    "server.js",
    "lib/collective-agreements.js",
    "lib/governance-store.js",
    "lib/system-center-metrics.js",
    "lib/work-rules/custom-rules.js",
    "lib/work-rules/governance.js",
    "lib/work-rules/store.js",
  ]);
  const providerNeutralServerPrepareCalls = countMatches(
    serverText,
    /\brequirePersonnelLifecycleOffboardingService\(\)\.prepare\s*\(/g,
  );
  const remainingDomainRawAccess = productionDirect
    .filter((record) => domainRuntimeFiles.has(record.file))
    .reduce((sum, record) => (
      sum
      + Math.max(
        0,
        Number(record.counts.prepareCall || 0)
          - (record.file === "server.js" ? providerNeutralServerPrepareCalls : 0),
      )
      + Number(record.counts.execCall || 0)
    ), 0);
  const fullSqliteParity = remainingDomainRawAccess === 0
    && phase3RawAccessLayerViolations.length === 0;
  const phase3Progress = {
    status: fullSqliteParity ? "completed" : "in-progress",
    completedSlices: fullSqliteParity
      ? ["all-runtime-domains"]
      : uiPreferencesSliceComplete ? ["ui-preferences-runtime"] : [],
    sqliteProviderDriverFiles: phase3ProviderDriverFiles,
    sqliteProviderDriverImports: phase3ProviderDriverImports,
    uiPreferencesFunctionsFound,
    uiPreferencesLegacyRawCalls,
    uiPreferencesRepositoryWiringComplete,
    uiPreferencesRoutesAwaited,
    remainingServerDbPrepareCalls: serverHotspot.dbPrepareCall,
    remainingServerDbExecCalls: serverHotspot.dbExecCall,
    remainingDomainRawAccess,
    rawAccessLayerViolations: phase3RawAccessLayerViolations,
    legacyServerDriverImportStillPresent: Boolean(serverRecord?.counts.directNodeSqliteImport),
    fullSqliteParity,
  };
  const phaseBoundaryViolations = scanPhaseBoundary(root, files);
  const phase4Progress = inspectPhase4Persistence(root, files, phaseBoundaryViolations);
  const phase5Progress = inspectPhase5Postgresql(root);
  const phase6Progress = inspectPhase6PostgresqlOperations(root);
  if (!fullSqliteParity || phaseBoundaryViolations.length > 0) {
    phase4Progress.status = "in-progress";
    phase4Progress.complete = false;
  }
  const unknownProduction = records
    .filter((record) => !record.isTest && !record.classification && (record.direct || record.indirect))
    .map((record) => record.file)
    .sort();
  const unknownTests = allTestCandidates
    .filter((record) => !record.classification)
    .map((record) => record.file)
    .sort();
  const resolvedProductionFiles = sortedDifference(
    [...directGroups.entries.keys()],
    productionDirect.map((record) => record.file),
  );
  const resolvedTestFiles = sortedDifference(BASELINE_TEST_FILES, testCandidates.map((record) => record.file));
  const errors = [];
  if (classificationDuplicates.length) errors.push(`Doppelte Klassifikation: ${classificationDuplicates.join(", ")}`);
  if (unknownProduction.length) errors.push(`Nicht klassifizierte produktive Kopplung: ${unknownProduction.join(", ")}`);
  if (unknownTests.length) errors.push(`Nicht klassifizierte Testkopplung: ${unknownTests.join(", ")}`);
  if (missingIndirectFiles.length) errors.push(`Fehlende indirekte Inventardatei: ${missingIndirectFiles.join(", ")}`);
  if (missingPhase2Files.length) errors.push(`Fehlende Phase-2-Vertragsdatei: ${missingPhase2Files.join(", ")}`);
  if (missingPhase2TestFiles.length) errors.push(`Fehlende Phase-2-Vertragstestdatei: ${missingPhase2TestFiles.join(", ")}`);
  if (missingPhase3Files.length) errors.push(`Fehlende Phase-3-SQLite-Datei: ${missingPhase3Files.join(", ")}`);
  if (missingPhase3TestFiles.length) errors.push(`Fehlende Phase-3-SQLite-Testdatei: ${missingPhase3TestFiles.join(", ")}`);
  if (phase4Progress.missingFiles.length) {
    errors.push(`Fehlende Phase-4-Persistenzdatei: ${phase4Progress.missingFiles.join(", ")}`);
  }
  if (phase4Progress.missingTestFiles.length) {
    errors.push(`Fehlende Phase-4-Persistenztestdatei: ${phase4Progress.missingTestFiles.join(", ")}`);
  }
  if (phase5Progress.missingFiles.length) {
    errors.push(`Fehlende Phase-5-PostgreSQL-Datei: ${phase5Progress.missingFiles.join(", ")}`);
  }
  if (phase5Progress.missingTestFiles.length) {
    errors.push(`Fehlende Phase-5-PostgreSQL-Testdatei: ${phase5Progress.missingTestFiles.join(", ")}`);
  }
  if (phase5Progress.missingSalesAnalyticsFiles.length) {
    errors.push(`Fehlende Sales-Analytics-Persistenzdatei: ${
      phase5Progress.missingSalesAnalyticsFiles.join(", ")
    }`);
  }
  if (phase5Progress.missingSalesAnalyticsTestFiles.length) {
    errors.push(`Fehlende Sales-Analytics-Persistenztestdatei: ${
      phase5Progress.missingSalesAnalyticsTestFiles.join(", ")
    }`);
  }
  if (phase5Progress.moduleErrors.length) {
    errors.push(`Phase-5-Module konnten nicht sicher geladen werden: ${
      phase5Progress.moduleErrors.map((entry) => entry.file).join(", ")
    }`);
  }
  if (phase6Progress.missingFiles.length) {
    errors.push(`Fehlende Phase-6-PostgreSQL-Operationsdatei: ${
      phase6Progress.missingFiles.join(", ")
    }`);
  }
  if (phase6Progress.missingTestFiles.length) {
    errors.push(`Fehlende Phase-6-PostgreSQL-Operationstestdatei: ${
      phase6Progress.missingTestFiles.join(", ")
    }`);
  }
  if (phase6Progress.moduleErrors.length) {
    errors.push(`Phase-6-Module konnten nicht sicher geladen werden: ${
      phase6Progress.moduleErrors.map((entry) => entry.file).join(", ")
    }`);
  }
  if (phase6Progress.exportContractErrors.length) {
    errors.push(`Phase-6-Modul-Exports verletzen den Operationsvertrag: ${
      phase6Progress.exportContractErrors
        .map((entry) => `${entry.file}:${entry.exportName}`)
        .join(", ")
    }`);
  }
  if (phase4Progress.moduleErrors.length) {
    errors.push(`Phase-4-Module konnten nicht sicher geladen werden: ${
      phase4Progress.moduleErrors.map((entry) => entry.file).join(", ")
    }`);
  }
  if (phase4Progress.statementCount !== PHASE_4_EXPECTED_STATEMENT_COUNT
    || phase4Progress.sqliteStatementCount !== PHASE_4_EXPECTED_STATEMENT_COUNT
    || phase4Progress.postgresqlStatementCount !== PHASE_4_EXPECTED_STATEMENT_COUNT
    || phase4Progress.sqliteBaselineStatementCount !== PHASE_4_EXPECTED_SQLITE_BASELINE_STATEMENT_COUNT
    || phase4Progress.dialectVariantStatementCount !== PHASE_4_EXPECTED_DIALECT_VARIANT_COUNT
    || phase4Progress.namedDollarParameterStatementCount !== PHASE_4_EXPECTED_NAMED_DOLLAR_PARAMETER_STATEMENT_COUNT
    || phase4Progress.duplicateStatementIds.length
    || phase4Progress.duplicateSqliteStatementBindings.length
    || phase4Progress.duplicatePostgresqlStatementBindings.length
    || phase4Progress.missingSqliteStatementBindings.length
    || phase4Progress.extraSqliteStatementBindings.length
    || phase4Progress.missingPostgresqlStatementBindings.length
    || phase4Progress.extraPostgresqlStatementBindings.length
    || phase4Progress.dialectMetadataViolations.length) {
    errors.push("Phase-4-Statement- und Dialektbindungen sind nicht vollstaendig oder nicht eindeutig.");
  }
  if (phase4Progress.migrationCount !== PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT
    || phase4Progress.migrationOperationCount !== PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT
    || phase4Progress.sqliteMigrationBindingCount !== PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT
    || phase4Progress.postgresqlMigrationBindingCount !== PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT
    || phase4Progress.duplicateMigrationOperationIds.length
    || phase4Progress.duplicateSqliteMigrationBindings.length
    || phase4Progress.duplicatePostgresqlMigrationBindings.length
    || phase4Progress.missingSqliteMigrationBindings.length
    || phase4Progress.extraSqliteMigrationBindings.length
    || phase4Progress.missingPostgresqlMigrationBindings.length
    || phase4Progress.extraPostgresqlMigrationBindings.length
    || phase4Progress.migrationMetadataViolations.length
    || phase4Progress.bindingImplementationErrors.length) {
    errors.push("Phase-4-Migrationsmanifest und Providerbindungen sind nicht vollstaendig oder nicht ausfuehrbar.");
  }
  if (phase4Progress.executablePostgresqlRuntimeArtifacts !== 0) {
    errors.push(`Nicht benannte PostgreSQL-Runtime-Artefakte verletzen die freigegebene PostgreSQL-Grenze: ${
      phase4Progress.postgresqlRuntimeArtifacts.join(", ")
    }`);
  }
  if (!phase5Progress.providerSliceComplete) {
    errors.push("Der nicht produktive PostgreSQL-Provider-Slice ist unvollstaendig oder produktiv verdrahtet.");
  }
  if (!phase6Progress.operationsFoundationComplete) {
    errors.push("Die nicht produktive PostgreSQL-Operations-Grundlage ist unvollstaendig oder produktiv verdrahtet.");
  }
  if (productionRegressions.length) errors.push(`Produktive Kopplungswerte gestiegen: ${productionRegressions.map((entry) => entry.key).join(", ")}`);
  if (serverRegressions.length) errors.push(`server.js-Kopplungswerte gestiegen: ${serverRegressions.map((entry) => entry.key).join(", ")}`);
  const unexpectedProductionDrivers = sortedDifference(productionDriverFiles, new Set([
    ...PHASE_3_ALLOWED_PRODUCTION_DRIVER_FILES,
    // Block 9 reads a separately captured source with DatabaseSync readOnly.
    // This is an isolated migration tool, never an application fallback.
    ...HISTORICAL_SOURCE_DRIVER_FILES,
  ]));
  const unexpectedTestDrivers = sortedDifference(testDriverFiles, PHASE_3_ALLOWED_TEST_DRIVER_FILES);
  if (unexpectedProductionDrivers.length) errors.push(`Neue produktive node:sqlite-Importe: ${unexpectedProductionDrivers.join(", ")}`);
  if (unexpectedTestDrivers.length) errors.push(`Neue Test-node:sqlite-Importe: ${unexpectedTestDrivers.join(", ")}`);
  if (phase3ProviderDriverFiles.length !== 1 || phase3ProviderDriverImports !== 1) {
    errors.push("Phase 3 erlaubt exakt einen node:sqlite-Import im benannten SQLite-Provider.");
  }
  if (phase3RawAccessLayerViolations.length) {
    errors.push(`Rohe prepare-/exec-Aufrufe auÃŸerhalb benannter SQLite-Provider-/Operationsmodule: ${phase3RawAccessLayerViolations.join(", ")}`);
  }
  if (uiPreferencesFunctionsFound !== uiPreferencesFunctionNames.length) {
    errors.push("Der UI-Preferences-Runtime-Slice ist in server.js nicht vollständig nachweisbar.");
  } else if (uiPreferencesLegacyRawCalls !== 0) {
    errors.push(`Der UI-Preferences-Runtime-Slice enthält noch ${uiPreferencesLegacyRawCalls} direkte SQLite-Aufrufe.`);
  }
  if (!uiPreferencesRepositoryWiringComplete) {
    errors.push("Der UI-Preferences-Runtime-Slice ist nicht vollständig mit App-Komposition und Repository verdrahtet.");
  }
  if (!uiPreferencesRoutesAwaited) {
    errors.push("Die HTTP-Routen des UI-Preferences-Runtime-Slices warten ihre asynchronen Fachfunktionen nicht vollständig ab.");
  }
  if (phaseBoundaryViolations.length) errors.push("Provider-, SQLite-Treiber- oder PostgreSQL-Kopplung verletzt die freigegebene Persistenzgrenze.");

  return {
    generatedAt: new Date().toISOString(),
    baseline: BASELINE,
    summary: {
      productionDirectFiles: productionDirect.length,
      productionIndirectFiles: indirectGroups.entries.size,
      discoveredProductionIndirectFiles: productionIndirect.length,
      testCandidateFiles: testCandidates.length,
      productionDriverFiles: productionDriverFiles.length,
      productionJavaScriptDriverFiles: productionDriverFiles.filter((file) => file.endsWith(".js")).length,
      testDriverFiles: testDriverFiles.length,
      phase2ContractFiles: PHASE_2_CONTRACT_FILES.length - missingPhase2Files.length,
      phase2ContractTestFiles: PHASE_2_CONTRACT_TEST_FILES.length - missingPhase2TestFiles.length,
      phase3SqliteProviderFiles: PHASE_3_SQLITE_PROVIDER_FILES.length - missingPhase3Files.length,
      phase3SqliteProviderTestFiles: PHASE_3_SQLITE_PROVIDER_TEST_FILES.length - missingPhase3TestFiles.length,
      phase4PersistenceFiles: PHASE_4_PERSISTENCE_FILES.length - phase4Progress.missingFiles.length,
      phase4PersistenceTestFiles: PHASE_4_PERSISTENCE_TEST_FILES.length - phase4Progress.missingTestFiles.length,
      phase5PostgresqlFiles: PHASE_5_POSTGRESQL_FILES.length - phase5Progress.missingFiles.length,
      phase5PostgresqlTestFiles: PHASE_5_POSTGRESQL_TEST_FILES.length - phase5Progress.missingTestFiles.length,
      salesAnalyticsPersistenceFiles:
        SALES_ANALYTICS_PERSISTENCE_SLICE_FILES.length
        - phase5Progress.missingSalesAnalyticsFiles.length,
      salesAnalyticsPersistenceTestFiles:
        SALES_ANALYTICS_PERSISTENCE_SLICE_TEST_FILES.length
        - phase5Progress.missingSalesAnalyticsTestFiles.length,
      phase6PostgresqlOperationsFiles:
        PHASE_6_POSTGRESQL_OPERATIONS_FILES.length - phase6Progress.missingFiles.length,
      phase6PostgresqlOperationsTestFiles:
        PHASE_6_POSTGRESQL_OPERATIONS_TEST_FILES.length
        - phase6Progress.missingTestFiles.length,
      unknownProductionFiles: unknownProduction.length,
      unknownTestFiles: unknownTests.length,
      phaseBoundaryViolations: phaseBoundaryViolations.length,
    },
    productionTotals,
    legacyProductionTotals,
    serverHotspot,
    phase3Progress,
    phase4Progress,
    phase5Progress,
    phase6Progress,
    productionDriverFiles,
    testDriverFiles,
    unknownProduction,
    unknownTests,
    resolvedProductionFiles,
    resolvedTestFiles,
    missingIndirectFiles,
    missingPhase2Files,
    missingPhase2TestFiles,
    missingPhase3Files,
    missingPhase3TestFiles,
    productionRegressions,
    serverRegressions,
    phaseBoundaryViolations,
    classificationDuplicates,
    findings: records.flatMap((record) => record.findings),
    errors,
    ok: errors.length === 0,
  };
}

function formatSummary(report) {
  const totals = report.productionTotals;
  return [
    `Datenbank-Kopplungsinventar (Baseline ${report.baseline.sourceCommit.slice(0, 7)})`,
    `Direkt gekoppelte Produkt-/Betriebsdateien: ${report.summary.productionDirectFiles}`,
    `Indirekt inventarisierte Produkt-/Betriebsdateien: ${report.summary.productionIndirectFiles}`,
    `Explizit klassifizierte Test-/Fixture-Dateien: ${report.summary.testCandidateFiles}`,
    `Providerneutrale Phase-2-Vertragsdateien: ${report.summary.phase2ContractFiles}`,
    `Providerneutrale Phase-2-Vertragstestdateien: ${report.summary.phase2ContractTestFiles}`,
    `Phase 3: ${report.phase3Progress.status}; migrierte Slices: ${report.phase3Progress.completedSlices.join(", ") || "keine"}`,
    `Phase-3-SQLite-Dateien: ${report.summary.phase3SqliteProviderFiles}, Tests: ${report.summary.phase3SqliteProviderTestFiles}`,
    `Erlaubter SQLite-Providerimport: ${report.phase3Progress.sqliteProviderDriverImports} in ${report.phase3Progress.sqliteProviderDriverFiles.join(", ") || "keiner Datei"}`,
    `UI-Präferenzen: direkte Altaufrufe=${report.phase3Progress.uiPreferencesLegacyRawCalls}; verbleibend in server.js: db.prepare=${report.phase3Progress.remainingServerDbPrepareCalls}, db.exec=${report.phase3Progress.remainingServerDbExecCalls}`,
    `Verbleibende rohe Fachzugriffe: ${report.phase3Progress.remainingDomainRawAccess}; Layer-Verstöße: ${report.phase3Progress.rawAccessLayerViolations.length}`,
    `Phase 4: ${report.phase4Progress.status}; Statements SQLite/PostgreSQL=${report.phase4Progress.statementCount}/${report.phase4Progress.sqliteStatementCount}/${report.phase4Progress.postgresqlStatementCount}`,
    `Phase-4-SQL: SQLite-Baseline=${report.phase4Progress.sqliteBaselineStatementCount}, Dialektvarianten=${report.phase4Progress.dialectVariantStatementCount}, benannte Dollar-Parameter=${report.phase4Progress.namedDollarParameterStatementCount}`,
    `Phase-4-Migrationen: Operationen=${report.phase4Progress.migrationOperationCount}, SQLite-Bindungen=${report.phase4Progress.sqliteMigrationBindingCount}, PostgreSQL-Fixtures=${report.phase4Progress.postgresqlMigrationBindingCount}`,
    `Ausfuehrbare PostgreSQL-Runtime-Artefakte: ${report.phase4Progress.executablePostgresqlRuntimeArtifacts}`,
    `Phase 5: ${report.phase5Progress.status}; Provider-Slice=${report.phase5Progress.providerSliceStatus}; Produktivaktivierung=${report.phase5Progress.productionActivation}`,
    `Phase-5-PostgreSQL-Dateien: ${report.summary.phase5PostgresqlFiles}, Tests: ${report.summary.phase5PostgresqlTestFiles}, Treiber=${report.phase5Progress.driverDependency || "fehlt"}, Compiler=v${report.phase5Progress.compilerVersion || "fehlt"}`,
    `PostgreSQL-Dialektplan: ${report.phase5Progress.dialectPlanStatementCount} Statements, portable=${report.phase5Progress.portableDialectCount}, Override offen=${report.phase5Progress.overrideDialectCount}, ausfuehrbar=${report.phase5Progress.executableApplicationDialectCount}`,
    `PostgreSQL-Katalogvertrag: gueltig=${report.phase5Progress.catalogContract.valid}, ausfuehrbarer Slice=${report.phase5Progress.catalogContract.executableSlice}, Vollanwendung=${report.phase5Progress.catalogContract.acceptedReceiptCount}/${report.phase5Progress.catalogContract.requiredReceiptCount}`,
    `PostgreSQL-UI-Praeferenzen: ${report.phase5Progress.uiPreferencesSlice.executableStatementCount}/${report.phase5Progress.uiPreferencesSlice.expectedStatementCount} ausfuehrbar, Status=${report.phase5Progress.uiPreferencesSlice.status || "fehlt"}, Vollanwendung=${report.phase5Progress.uiPreferencesSlice.fullApplicationCatalog}`,
    `PostgreSQL-Planungseinstellungen: ${report.phase5Progress.planningSettingsSlice.executableStatementCount}/${report.phase5Progress.planningSettingsSlice.expectedStatementCount} ausfuehrbar, Status=${report.phase5Progress.planningSettingsSlice.status || "fehlt"}, Vollanwendung=${report.phase5Progress.planningSettingsSlice.fullApplicationCatalog}`,
    `PostgreSQL-Abteilungen: ${report.phase5Progress.organizationDepartmentsSlice.executableStatementCount}/${report.phase5Progress.organizationDepartmentsSlice.expectedStatementCount} ausfuehrbar, Status=${report.phase5Progress.organizationDepartmentsSlice.status || "fehlt"}, Vollanwendung=${report.phase5Progress.organizationDepartmentsSlice.fullApplicationCatalog}`,
    `PostgreSQL-System-Center-Metriken: ${report.phase5Progress.systemCenterMetricsSlice.executableStatementCount}/${report.phase5Progress.systemCenterMetricsSlice.expectedStatementCount} ausfuehrbar, Status=${report.phase5Progress.systemCenterMetricsSlice.status || "fehlt"}, Vollanwendung=${report.phase5Progress.systemCenterMetricsSlice.fullApplicationCatalog}`,
    `Sales-Analytics-Persistenzslice: ${report.phase5Progress.salesAnalyticsPersistenceSlice.executableStatementCount}/${report.phase5Progress.salesAnalyticsPersistenceSlice.expectedStatementCount} Statements, DDL=${report.phase5Progress.salesAnalyticsPersistenceSlice.schemaStatementCount}/${report.phase5Progress.salesAnalyticsPersistenceSlice.expectedSchemaStatementCount}, Anwendungsverdrahtungen=${report.phase5Progress.salesAnalyticsPersistenceSlice.applicationWiringReferences}`,
    `Sales-Analytics-Persistenzdateien: ${report.summary.salesAnalyticsPersistenceFiles}, Tests: ${report.summary.salesAnalyticsPersistenceTestFiles}, Produktivaktivierung=${report.phase5Progress.salesAnalyticsPersistenceSlice.productActivation}`,
    `PostgreSQL-Development-Slices: ${report.phase5Progress.developmentSlices.sliceCount} Slices, ${report.phase5Progress.developmentSlices.executableStatementCount}/${report.phase5Progress.developmentSlices.expectedStatementCount} Statements, Anwendungsfreigabe=${report.phase5Progress.developmentSlices.applicationExecutable}`,
    `PostgreSQL-Migrationsadapter: Status=${report.phase5Progress.migrationAdapter.status || "fehlt"}, gueltig=${report.phase5Progress.migrationAdapter.valid}, Session-Lock vor SERIALIZABLE=${report.phase5Progress.migrationAdapter.sessionAdvisoryLockBeforeSerializableTransaction}, Artefakte=${report.phase5Progress.migrationAdapter.artifactExecution || "fehlt"}, Rollenpruefung=${report.phase5Progress.migrationAdapter.roleBoundaryEnforced}, Ledgerzugriff=${report.phase5Progress.migrationAdapter.ledgerAccessFromArtifacts || "unbekannt"}, Anwendungsmigrationen=${report.phase5Progress.migrationAdapter.applicationMigrationsImplemented}/${report.phase5Progress.migrationAdapter.expectedApplicationMigrationCount}, Produktivaktivierung=${report.phase5Progress.migrationAdapter.productActivation}`,
    `Phase 6: ${report.phase6Progress.status}; Operations-Grundlage=${report.phase6Progress.operationsFoundationStatus}; Produktivaktivierung=${report.phase6Progress.productionActivation}; Cutover=${report.phase6Progress.cutoverImplemented}`,
    `Phase-6-PostgreSQL-Operationsdateien: ${report.summary.phase6PostgresqlOperationsFiles}, Tests: ${report.summary.phase6PostgresqlOperationsTestFiles}, Profil=${report.phase6Progress.operationalProfile || "fehlt"}`,
    `PostgreSQL-Betriebsmethoden: Backup=${report.phase6Progress.backupMethod || "fehlt"}, Restore=${report.phase6Progress.restoreMethod || "fehlt"}, server.js-Aktivierungen=${report.phase6Progress.serverActivationReferences}, konfigurierte Provider=${report.phase6Progress.implementedProviderIds.join(", ") || "keine"}`,
    `PostgreSQL-Recovery-Vertraege: Bundle=v${report.phase6Progress.versions.backupBundle ?? "fehlt"}, Operations=v${report.phase6Progress.versions.operationalContract ?? "fehlt"}, Assurance=v${report.phase6Progress.versions.recoveryAssurance ?? "fehlt"}, Evidence=v${report.phase6Progress.versions.postgresqlRecoveryEvidence ?? "fehlt"}, Monitoring=v${report.phase6Progress.versions.postgresqlMonitor ?? "fehlt"}`,
    `Direkte node:sqlite-Dateien: ${report.summary.productionDriverFiles} produktiv/betrieblich, ${report.summary.testDriverFiles} Test/Fixture`,
    `Aktueller lexikalischer Stand: prepare=${totals.prepareCall}, exec=${totals.execCall}, PRAGMA=${totals.pragma}, BEGIN IMMEDIATE=${totals.beginImmediate}`,
    `SQLite-Dialekt: INSERT OR IGNORE=${totals.insertOrIgnore}, ON CONFLICT=${totals.onConflict}, RAISE(ABORT)=${totals.raiseAbort}`,
    `Schema/Migration: CREATE TABLE=${totals.createTable}, CREATE TRIGGER=${totals.createTriggerDdl}, CREATE INDEX=${totals.createIndex}, ensureColumn=${totals.ensureColumn}`,
    `Unklassifiziert: produktiv=${report.summary.unknownProductionFiles}, Test=${report.summary.unknownTestFiles}`,
    `Phasengrenzverletzungen: ${report.summary.phaseBoundaryViolations}`,
    report.ok ? "Ergebnis: OK" : `Ergebnis: FEHLER\n- ${report.errors.join("\n- ")}`,
  ].join("\n");
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const report = scanRepository();
  if (args.has("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatSummary(report));
  if (args.has("--check") && !report.ok) process.exitCode = 1;
}

module.exports = {
  BASELINE,
  BASELINE_DIRECT_PRODUCTION_DRIVER_FILES,
  BASELINE_DIRECT_TEST_DRIVER_FILES,
  BASELINE_TEST_FILES,
  PHASE_2_CONTRACT_FILES,
  PHASE_2_CONTRACT_TEST_FILES,
  PHASE_3_ALLOWED_PRODUCTION_DRIVER_FILES,
  PHASE_3_ALLOWED_TEST_DRIVER_FILES,
  PHASE_3_SQLITE_DRIVER_FILES,
  PHASE_3_SQLITE_PROVIDER_FILES,
  PHASE_3_SQLITE_PROVIDER_TEST_FILES,
  PHASE_4_EXPECTED_DIALECT_VARIANT_COUNT,
  PHASE_4_EXPECTED_NAMED_DOLLAR_PARAMETER_STATEMENT_COUNT,
  PHASE_4_EXPECTED_SQLITE_BASELINE_STATEMENT_COUNT,
  PHASE_4_EXPECTED_MIGRATION_OPERATION_COUNT,
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
  PHASE_6_POSTGRESQL_OPERATIONS_FILES,
  PHASE_6_POSTGRESQL_OPERATIONS_TEST_FILES,
  PRODUCTION_DIRECT_GROUPS,
  PRODUCTION_INDIRECT_GROUPS,
  architectureBoundaryViolationsForText,
  formatSummary,
  inspectPhase6PostgresqlOperations,
  isPostgresqlRuntimeArtifactPath,
  scanRepository,
};
