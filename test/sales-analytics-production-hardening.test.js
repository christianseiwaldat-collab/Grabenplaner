"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-sales-hardening-"));
const databasePath = path.join(root, "data", "dienstplan.db");
const backupDirectory = path.join(root, "backups");
process.env.DB_PATH = databasePath;
process.env.BACKUP_DIR = backupDirectory;
process.env.GRABENPLANER_DATA_DIR = root;
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.NODE_ENV = "test";

const {
  createDatabaseBackupToDirectory,
  db,
  releaseInstanceLockForTests,
} = require("../server");
const {
  createSalesAnalyticsPersistenceRepository,
} = require("../lib/persistence/repositories/sales-analytics");
const {
  SQLITE_SALES_ANALYTICS_CATALOG,
} = require("../lib/persistence/sqlite/sales-analytics-catalog");
const {
  ensureSqliteSalesAnalyticsSchema,
} = require("../lib/persistence/sqlite/operations/sales-analytics-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function insertReport(database, {
  index,
  locationId,
  productGroupCount = 1,
  timestamp = "2026-08-03T12:00:00.000Z",
}) {
  const id = digest(`sales-report-${index}`);
  database.prepare(`
    INSERT INTO sales_aggregate_reports (
      id,
      source_system,
      source_file_sha256,
      parser_version,
      extraction,
      review_method,
      report_kind,
      external_branch_id,
      location_id,
      currency,
      period_start,
      period_end,
      comparison_start,
      comparison_end,
      year_to_date_start,
      year_to_date_comparison_start,
      generated_on,
      page_count,
      product_group_count,
      issue_count,
      reconciliation_status,
      imported_by,
      imported_at
    ) VALUES (
      ?, 'tradefoto_report', ?, 2, 'pdf_text_coordinates', 'source_text_confirmed',
      'product_group_net', ?, ?, 'EUR', '2026-07-01', '2026-07-31',
      '2025-07-01', '2025-07-31', '2026-01-01', '2025-01-01', '2026-08-03',
      1, ?, 0, 'match', '252', ?
    )
  `).run(
    id,
    digest(`sales-source-${index}`),
    `branch-${index}`,
    locationId,
    productGroupCount,
    timestamp,
  );
  return id;
}

function insertProductGroupMetric(database, reportId, horizon, groupIndex) {
  database.prepare(`
    INSERT INTO sales_report_product_group_metrics (
      report_id,
      horizon,
      external_product_group_id,
      product_group_label,
      current_quantity,
      comparison_quantity,
      current_net_revenue,
      comparison_net_revenue,
      current_gross_margin,
      comparison_gross_margin,
      current_customer_count,
      comparison_customer_count,
      current_revenue_per_customer,
      comparison_revenue_per_customer,
      source_page,
      source_ordinate
    ) VALUES (
      ?, ?, ?, ?, '1.0000', '1.0000', '100.0000', '90.0000', '25.0000',
      '20.0000', '1.0000', '1.0000', '100.0000', '90.0000', 1, '100.0000'
    )
  `).run(reportId, horizon, String(groupIndex).padStart(4, "0"), `Warengruppe ${groupIndex}`);
}

function insertTotalMetric(database, reportId, horizon) {
  database.prepare(`
    INSERT INTO sales_report_total_metrics (
      report_id,
      horizon,
      current_quantity,
      comparison_quantity,
      current_net_revenue,
      comparison_net_revenue,
      current_gross_margin,
      comparison_gross_margin,
      current_customer_count,
      comparison_customer_count,
      current_revenue_per_customer,
      comparison_revenue_per_customer,
      source_page
    ) VALUES (
      ?, ?, '2000.0000', '2000.0000', '200000.0000', '180000.0000',
      '50000.0000', '40000.0000', '2000.0000', '2000.0000', '100.0000',
      '90.0000', 1
    )
  `).run(reportId, horizon);
}

test.after(() => {
  db.close();
  releaseInstanceLockForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

test("Verkaufsanalysen: Sicherung und Wiederherstellung erhalten Berichte, Kennzahlen und Schutztrigger", async () => {
  const locationId = "sales-backup-location";
  db.prepare("INSERT INTO locations (id, name) VALUES (?, ?)")
    .run(locationId, "Verkaufsanalyse Sicherung");
  const reportId = insertReport(db, { index: "backup", locationId });
  insertProductGroupMetric(db, reportId, "period", 101);
  insertProductGroupMetric(db, reportId, "year_to_date", 101);
  insertTotalMetric(db, reportId, "period");
  insertTotalMetric(db, reportId, "year_to_date");

  const backup = createDatabaseBackupToDirectory(
    backupDirectory,
    "sales-analytics-production-hardening",
    "external",
  );
  assert.equal(backup.verified, true);
  assert.equal(backup.committed, true);
  assert.ok(fs.existsSync(backup.marker));

  const backupApplication = openSqliteApplicationPersistence({
    databasePath: backup.path,
    catalog: [],
  });
  const backupDatabase = backupApplication.database;
  try {
    assert.equal(Object.values(backupDatabase.prepare("PRAGMA integrity_check").get())[0], "ok");
    assert.deepEqual(backupDatabase.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(
      backupDatabase.prepare("SELECT COUNT(*) AS count FROM sales_aggregate_reports WHERE id = ?")
        .get(reportId).count,
      1,
    );
    assert.equal(
      backupDatabase.prepare("SELECT COUNT(*) AS count FROM sales_report_product_group_metrics WHERE report_id = ?")
        .get(reportId).count,
      2,
    );
  } finally {
    await backupApplication.provider.close();
    backupDatabase.close();
  }

  const restoredPath = path.join(root, "restored-sales.db");
  fs.copyFileSync(backup.path, restoredPath);
  const restoredApplication = openSqliteApplicationPersistence({
    databasePath: restoredPath,
    catalog: [],
  });
  const restoredDatabase = restoredApplication.database;
  try {
    restoredDatabase.exec("PRAGMA foreign_keys = ON");
    assert.equal(Object.values(restoredDatabase.prepare("PRAGMA integrity_check").get())[0], "ok");
    assert.deepEqual(restoredDatabase.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(
      restoredDatabase.prepare("SELECT COUNT(*) AS count FROM sales_report_total_metrics WHERE report_id = ?")
        .get(reportId).count,
      2,
    );
    assert.throws(
      () => restoredDatabase.prepare(`
        UPDATE sales_aggregate_reports SET currency = 'USD' WHERE id = ?
      `).run(reportId),
      /sales-aggregate-report-immutable/,
    );
  } finally {
    await restoredApplication.provider.close();
    restoredDatabase.close();
  }
});

test("Verkaufsanalysen: große, aber erlaubte Berichtsmengen bleiben begrenzt abrufbar", async () => {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_SALES_ANALYTICS_CATALOG,
  });
  application.database.exec(`
    CREATE TABLE locations (id TEXT PRIMARY KEY);
    INSERT INTO locations (id) VALUES ('sales-volume-location');
  `);
  ensureSqliteSalesAnalyticsSchema(application.database);
  const repository = createSalesAnalyticsPersistenceRepository(application.provider);
  let selectedReportId;
  try {
    application.database.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 500; index += 1) {
        const reportId = insertReport(application.database, {
          index: `volume-${index}`,
          locationId: "sales-volume-location",
          productGroupCount: index === 0 ? 2_000 : 1,
          timestamp: `2026-08-03T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
        });
        if (index === 0) selectedReportId = reportId;
      }
      for (let groupIndex = 1; groupIndex <= 2_000; groupIndex += 1) {
        insertProductGroupMetric(application.database, selectedReportId, "period", groupIndex);
        insertProductGroupMetric(application.database, selectedReportId, "year_to_date", groupIndex);
      }
      insertTotalMetric(application.database, selectedReportId, "period");
      insertTotalMetric(application.database, selectedReportId, "year_to_date");
      application.database.exec("COMMIT");
    } catch (error) {
      application.database.exec("ROLLBACK");
      throw error;
    }

    const indexes = application.database.prepare("PRAGMA index_list('sales_aggregate_reports')")
      .all().map((row) => row.name);
    assert.ok(indexes.includes("idx_sales_aggregate_reports_location_period"));
    assert.ok(indexes.includes("idx_sales_aggregate_reports_natural_key"));

    const startedAt = performance.now();
    const reports = await repository.listReports({
      locationId: "sales-volume-location",
      limit: 200,
    });
    const bundle = await repository.getReportBundle(selectedReportId);
    const elapsedMs = performance.now() - startedAt;
    assert.equal(reports.length, 200);
    assert.equal(bundle.productGroupMetrics.length, 4_000);
    assert.equal(bundle.totals.length, 2);
    assert.ok(elapsedMs < 10_000, `Abruf dauerte ${Math.round(elapsedMs)} ms`);
    await assert.rejects(
      () => repository.listReports({ locationId: "sales-volume-location", limit: 501 }),
      (error) => error?.code === "PERSISTENCE_STATEMENT_INVALID",
    );
  } finally {
    await application.provider.close();
    application.database.close();
  }
});
