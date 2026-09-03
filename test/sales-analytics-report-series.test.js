"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  SALES_ANALYTICS_REPORT_SERIES_MAX_REPORTS,
  SalesAnalyticsReportSeriesError,
  aggregateSalesAnalyticsReportSeries,
  classifySalesAnalyticsReportArchive,
  normalizeSalesAnalyticsReportSeriesIds,
} = require("../lib/sales-analytics-report-series");

const root = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const appSource = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function metric({
  quantity = ["10.0000", "8.0000"],
  netRevenue = ["100.0000", "80.0000"],
  grossMargin = ["25.0000", "20.0000"],
  customerCount = ["2.0000", "2.0000"],
  includeGrossMargin = true,
} = {}) {
  return {
    quantity: { current: quantity[0], comparison: quantity[1] },
    netRevenue: { current: netRevenue[0], comparison: netRevenue[1] },
    customerCount: { current: customerCount[0], comparison: customerCount[1] },
    revenuePerCustomer: { current: "50.0000", comparison: "40.0000" },
    ...(includeGrossMargin ? {
      grossMargin: { current: grossMargin[0], comparison: grossMargin[1] },
    } : {}),
  };
}

function bundle(index, {
  locationId = "18",
  period = ["2026-08-01", "2026-08-17"],
  comparison = ["2025-08-01", "2025-08-17"],
  label = "Kameras",
  values = {},
  includeGrossMargin = true,
} = {}) {
  const valuesMetric = metric({ ...values, includeGrossMargin });
  return {
    report: {
      id: digest(`series-report-${index}`),
      sourceSystem: "tradefoto_report",
      reportKind: "product_group_net",
      locationId,
      currency: "EUR",
      periods: {
        period: { start: period[0], end: period[1] },
        comparison: { start: comparison[0], end: comparison[1] },
      },
    },
    productGroups: [{
      externalProductGroupId: "101",
      label,
      horizons: { period: valuesMetric },
    }],
    totals: { period: valuesMetric },
    rights: { grossMargin: includeGrossMargin },
  };
}

test("Block 10: Archiv markiert echte Intervallüberschneidungen nur innerhalb derselben Datenreihe", () => {
  const reports = [
    bundle("archive-a").report,
    bundle("archive-b", { period: ["2026-08-10", "2026-08-31"] }).report,
    bundle("archive-c", { period: ["2026-08-18", "2026-08-31"] }).report,
    bundle("archive-d", { locationId: "19", period: ["2026-08-01", "2026-08-31"] }).report,
  ];
  const archive = classifySalesAnalyticsReportArchive(reports);
  assert.equal(archive[reports[0].id].durationDays, 17);
  assert.equal(archive[reports[0].id].overlapCount, 1);
  assert.deepEqual(archive[reports[0].id].overlapReportIds, [reports[1].id]);
  assert.equal(archive[reports[2].id].overlapCount, 1);
  assert.equal(archive[reports[3].id].overlapCount, 0);
});

test("Block 10: überschneidungsfreie PDFs werden exakt summiert und nicht additive Werte neu berechnet", () => {
  const first = bundle("sum-a");
  const second = bundle("sum-b", {
    period: ["2026-08-18", "2026-08-31"],
    comparison: ["2025-08-18", "2025-08-31"],
    label: "Foto & Kamera",
    values: {
      quantity: ["20.0000", "12.0000"],
      netRevenue: ["200.0000", "120.0000"],
      grossMargin: ["50.0000", "30.0000"],
      customerCount: ["4.0000", "4.0000"],
    },
  });
  const result = aggregateSalesAnalyticsReportSeries([second, first]);
  assert.equal(result.selection.reportCount, 2);
  assert.deepEqual(result.selection.period, { start: "2026-08-01", end: "2026-08-31" });
  assert.equal(result.selection.coverageDays, 31);
  assert.equal(result.selection.spanDays, 31);
  assert.equal(result.selection.gapDays, 0);
  assert.equal(result.selection.coverageStatus, "contiguous");
  assert.equal(result.selection.comparisonAligned, true);
  assert.equal(result.totals.period.netRevenue.current, "300.0000");
  assert.equal(result.totals.period.netRevenue.comparison, "200.0000");
  assert.equal(result.totals.period.revenuePerCustomer.current, "50.0000");
  assert.equal(result.totals.period.revenuePerCustomer.comparison, "33.3333");
  assert.equal(result.dailyAverages.period.netRevenue.current, "9.6774");
  assert.equal(result.productGroups[0].label, "Foto & Kamera");
  assert.deepEqual(result.productGroups[0].labelVariants, ["Foto & Kamera", "Kameras"]);
  assert.equal(result.productGroups[0].reportCount, 2);
  assert.equal(result.points.length, 2);
  assert.equal(Object.isFrozen(result), true);
});

test("Block 10: Lücken bleiben sichtbar und werden nicht als vollständiger Zeitraum ausgegeben", () => {
  const result = aggregateSalesAnalyticsReportSeries([
    bundle("gap-a", { period: ["2026-08-01", "2026-08-10"], comparison: ["2025-08-01", "2025-08-10"] }),
    bundle("gap-b", { period: ["2026-08-15", "2026-08-20"], comparison: ["2025-08-15", "2025-08-20"] }),
  ]);
  assert.equal(result.selection.coverageDays, 16);
  assert.equal(result.selection.spanDays, 20);
  assert.equal(result.selection.gapDays, 4);
  assert.equal(result.selection.coverageStatus, "gapped");
  assert.deepEqual(result.selection.gaps, [{ start: "2026-08-11", end: "2026-08-14", days: 4 }]);
});

test("Block 10: aktuelle und Vergleichszeiträume werden unabhängig fail-closed auf Überschneidung geprüft", () => {
  assert.throws(
    () => aggregateSalesAnalyticsReportSeries([
      bundle("overlap-a"),
      bundle("overlap-b", { period: ["2026-08-17", "2026-08-31"], comparison: ["2025-08-17", "2025-08-31"] }),
    ]),
    (error) => error instanceof SalesAnalyticsReportSeriesError
      && error.code === "SALES_ANALYTICS_REPORT_SERIES_OVERLAP",
  );
  assert.throws(
    () => aggregateSalesAnalyticsReportSeries([
      bundle("comparison-a"),
      bundle("comparison-b", { period: ["2026-08-18", "2026-08-31"], comparison: ["2025-08-17", "2025-08-31"] }),
    ]),
    (error) => error instanceof SalesAnalyticsReportSeriesError
      && error.code === "SALES_ANALYTICS_REPORT_SERIES_COMPARISON_OVERLAP",
  );
});

test("Block 10: Filialen, Quellen und Rohertragsprojektion bleiben getrennt", () => {
  assert.throws(
    () => aggregateSalesAnalyticsReportSeries([
      bundle("location-a"),
      bundle("location-b", { locationId: "19", period: ["2026-08-18", "2026-08-31"] }),
    ]),
    (error) => error instanceof SalesAnalyticsReportSeriesError
      && error.code === "SALES_ANALYTICS_REPORT_SERIES_MIXED_LOCATION",
  );
  const withoutMargin = aggregateSalesAnalyticsReportSeries([
    bundle("redacted", { includeGrossMargin: false }),
  ]);
  assert.equal(withoutMargin.rights.grossMargin, false);
  assert.equal("grossMargin" in withoutMargin.totals.period, false);
  assert.equal(JSON.stringify(withoutMargin).includes("25.0000"), false);
});

test("Block 10: Serienauswahl ist eindeutig, begrenzt und vollständig serverseitig verdrahtet", () => {
  const id = digest("selection");
  assert.deepEqual(normalizeSalesAnalyticsReportSeriesIds([id]), [id]);
  assert.throws(
    () => normalizeSalesAnalyticsReportSeriesIds([id, id]),
    (error) => error.code === "SALES_ANALYTICS_REPORT_SERIES_SELECTION_INVALID",
  );
  assert.throws(
    () => normalizeSalesAnalyticsReportSeriesIds(
      Array.from({ length: SALES_ANALYTICS_REPORT_SERIES_MAX_REPORTS + 1 }, (_, index) => digest(index)),
    ),
    (error) => error.code === "SALES_ANALYTICS_REPORT_SERIES_SELECTION_INVALID",
  );
  assert.match(serverSource, /\/api\/sales-analytics\/report-series\/analyze/);
  assert.match(serverSource, /salesAnalyticsRequestContext\(request, \{ csrf: true \}\)/);
  assert.match(serverSource, /assertSalesAnalyticsLocation\(projection, bundle\.report\.locationId\)/);
  assert.match(serverSource, /bundles\.push\(publicSalesAnalyticsReportBundle\(bundle, projection\)\)/);
  assert.match(serverSource, /reports: salesAnalyticsArchiveProjection\(reports\)/);
  assert.match(serverSource, /Cache-Control", "private, no-store"/);
  assert.match(serverSource, /sales\.report\.series\.analyze/);
  assert.match(serverSource, /sales\.report\.series\.rejected/);
  assert.match(serverSource, /aggregateSalesAnalyticsReportSeries/);
  assert.match(htmlSource, /id="salesReportArchive"/);
  assert.match(htmlSource, /id="salesReportSeriesAnalyzeButton"/);
  assert.match(htmlSource, /id="salesReportCoverageChart"/);
  assert.match(htmlSource, /id="salesReportArchiveBody"/);
  assert.match(appSource, /function analyzeSalesReportSeries\(\)/);
  assert.match(appSource, /const reportIds = reports\.map/);
  assert.match(appSource, /body: JSON\.stringify\(\{ reportIds \}\)/);
  assert.match(appSource, /requestId !== state\.salesAnalytics\.seriesRequestId/);
  assert.match(appSource, /Ø je Abdeckungstag:/);
});
