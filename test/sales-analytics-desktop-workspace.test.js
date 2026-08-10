"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const contract = fs.readFileSync(
  path.join(root, "docs", "VERKAUFSANALYSEN-DESKTOP-ARBEITSBEREICH-v0.1.md"),
  "utf8",
);

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

function analysisFunctions(initialSalesAnalytics = {}) {
  const source = between(
    app,
    "const SALES_ANALYTICS_PUBLIC_METRICS",
    "function renderSalesAnalytics()",
  );
  const context = {
    state: {
      salesAnalytics: {
        reports: [],
        locationFilter: "",
        dateFrom: "",
        dateTo: "",
        tableSort: "netRevenue_desc",
        archiveSelection: [],
        reportSeries: null,
        ...initialSalesAnalytics,
      },
    },
    elements: {},
    formatSalesDecimal: (value) => String(value),
    salesAnalyticsLocationName: (id) => `Filiale ${id}`,
    salesPeriodLabel: (period) => `${period?.start || ""}-${period?.end || ""}`,
  };
  vm.runInNewContext(`${source}\n;globalThis.result = {
    salesAnalyticsMetricDefinitions,
    salesMetricRelativeChange,
    formatSalesMetricChange,
    salesAnalyticsPeriods,
    salesReportDateRangeInvalid,
    filteredSalesAnalyticsReports,
    salesReportSeriesSelectionValidation,
    sortSalesAnalyticsGroups,
  };`, context);
  return { context, functions: context.result };
}

test("Desktop-Arbeitsbereich enthält Bereichs-, Datums- und Horizontfilter", () => {
  const view = between(html, '<section id="salesAnalyticsView"', '<section id="personnelView"');
  for (const id of [
    "salesReportLocationFilter",
    "salesReportDateFrom",
    "salesReportDateTo",
    "salesReportSelect",
    "salesReportHorizon",
    "salesReportResetFilters",
  ]) assert.match(view, new RegExp(`id="${id}"`));
  assert.match(app, /function filteredSalesAnalyticsReports\(\)/);
  assert.match(app, /periodEnd >= state\.salesAnalytics\.dateFrom/);
  assert.match(app, /periodStart <= state\.salesAnalytics\.dateTo/);
  assert.match(app, /Das Von-Datum muss vor oder am Bis-Datum liegen/);
  assert.match(styles, /\.sales-analytics-topbar,\.sales-analytics-desktop-workspace \{ min-width:1120px; \}/);
  assert.doesNotMatch(view, /sales.*mobile|mobile.*sales/i);
});

test("KPI-Karten und Diagramm stellen aktuelle und verglichene Werte getrennt dar", () => {
  const view = between(html, '<section id="salesAnalyticsView"', '<section id="personnelView"');
  assert.match(view, /id="salesReportKpis"/);
  assert.match(view, /id="salesReportChartMetric"/);
  assert.match(view, /id="salesReportChartLegend"/);
  assert.match(app, /SALES_ANALYTICS_PUBLIC_METRICS/);
  assert.match(app, /metric\?\.\[metricId\]\?\.\[side\]/);
  assert.match(app, /formatSalesMetricChange\(current, comparison\)/);
  assert.match(app, /\["current", entry\.current\], \["comparison", entry\.comparison\]/);
  assert.match(app, /comparison === 0\) return null/);
  assert.match(styles, /\.sales-chart-bar\.comparison/);
});

test("Datumsfilter und Vergleichsrechnung verhalten sich an den Grenzfällen deterministisch", () => {
  const reports = [
    { id: "a", locationId: "18", periods: { period: { start: "2026-06-01", end: "2026-06-30" } } },
    { id: "b", locationId: "18", periods: { period: { start: "2026-07-01", end: "2026-07-31" } } },
    { id: "c", locationId: "19", periods: { period: { start: "2026-07-01", end: "2026-07-31" } } },
  ];
  const { context, functions } = analysisFunctions({
    reports,
    locationFilter: "18",
    dateFrom: "2026-07-01",
    dateTo: "2026-07-31",
  });
  assert.equal(functions.filteredSalesAnalyticsReports().map((report) => report.id).join(","), "b");
  assert.equal(functions.salesMetricRelativeChange(125, 100), 25);
  assert.equal(functions.salesMetricRelativeChange(25, 0), null);
  assert.equal(functions.formatSalesMetricChange(25, 0), "Kein Prozentvergleich");
  assert.equal(functions.formatSalesMetricChange(0, 0), "±0,0 %");
  context.state.salesAnalytics.dateFrom = "2026-08-01";
  assert.equal(functions.salesReportDateRangeInvalid(), true);
  assert.equal(functions.filteredSalesAnalyticsReports().length, 0);
});

test("Berichtsarchiv erkennt Teilzeiträume, Lücken und unzulässige Überschneidungen", () => {
  const report = (id, locationId, start, end, comparisonStart, comparisonEnd) => ({
    id,
    locationId,
    sourceSystem: "tradefoto_pdf",
    reportKind: "product_group_statistics",
    currency: "EUR",
    periods: {
      period: { start, end },
      comparison: comparisonStart && comparisonEnd
        ? { start: comparisonStart, end: comparisonEnd }
        : null,
    },
  });
  const reports = [
    report("a", "18", "2026-07-01", "2026-07-17", "2025-07-01", "2025-07-17"),
    report("b", "18", "2026-07-18", "2026-07-31", "2025-07-18", "2025-07-31"),
  ];
  const { context, functions } = analysisFunctions({
    reports,
    archiveSelection: ["a", "b"],
    dateFrom: "2026-07-10",
    dateTo: "2026-07-20",
  });

  assert.equal(functions.filteredSalesAnalyticsReports().map((entry) => entry.id).join(","), "a,b");
  const contiguous = functions.salesReportSeriesSelectionValidation();
  assert.equal(contiguous.ok, true);
  assert.equal(contiguous.code, "contiguous");
  assert.equal(contiguous.coverageDays, 31);
  assert.equal(contiguous.spanDays, 31);
  assert.equal(contiguous.gapDays, 0);
  assert.equal(contiguous.comparisonAligned, true);

  context.state.salesAnalytics.reports[1].periods.period.start = "2026-07-17";
  assert.match(functions.salesReportSeriesSelectionValidation().message, /überschneiden sich/i);

  context.state.salesAnalytics.reports[1].periods.period.start = "2026-07-18";
  context.state.salesAnalytics.reports[1].periods.comparison.start = "2025-07-17";
  assert.match(functions.salesReportSeriesSelectionValidation().message, /Vergleichszeiträume überschneiden sich/i);

  context.state.salesAnalytics.reports[1].periods.comparison.start = "2025-07-18";
  context.state.salesAnalytics.reports[1].locationId = "19";
  assert.match(functions.salesReportSeriesSelectionValidation().message, /derselben (?:GP-)?Filiale/i);
});

test("Horizont, Kennzahlenrecht und Sortierung verwenden die ausgewählte Berichtssicht", () => {
  const { context, functions } = analysisFunctions();
  const detail = {
    report: {
      periods: {
        period: { start: "2026-07-01", end: "2026-07-31" },
        comparison: { start: "2025-07-01", end: "2025-07-31" },
        yearToDate: { start: "2026-01-01", end: "2026-07-31" },
        yearToDateComparison: { start: "2025-01-01", end: "2025-07-31" },
      },
    },
  };
  assert.equal(functions.salesAnalyticsPeriods(detail, "year_to_date").current.start, "2026-01-01");
  assert.equal(functions.salesAnalyticsMetricDefinitions(false).some((metric) => metric.id === "grossMargin"), false);
  assert.equal(functions.salesAnalyticsMetricDefinitions(true).some((metric) => metric.id === "grossMargin"), true);
  const groups = [
    { externalProductGroupId: "200", label: "B", horizons: { period: { netRevenue: { current: "10", comparison: "5" } } } },
    { externalProductGroupId: "100", label: "A", horizons: { period: { netRevenue: { current: "30", comparison: "40" } } } },
  ];
  context.state.salesAnalytics.tableSort = "netRevenue_desc";
  assert.equal(functions.sortSalesAnalyticsGroups(groups, "period")[0].externalProductGroupId, "100");
  context.state.salesAnalytics.tableSort = "change_desc";
  assert.equal(functions.sortSalesAnalyticsGroups(groups, "period")[0].externalProductGroupId, "200");
});

test("Rohertrag bleibt in Karten, Diagramm, Tabelle und Sortierung rechteabhängig", () => {
  assert.match(app, /detail\?\.rights\?\.grossMargin === true/);
  assert.match(app, /salesAnalyticsMetricDefinitions\(hasGrossMargin\)/);
  assert.match(app, /hasGrossMargin \? \[\{ value: "margin_desc"/);
  assert.match(app, /hasGrossMargin \? \[\{ label: "Rohertrag", columns: 2 \}\]/);
  assert.match(app, /if \(hasGrossMargin\) metrics\.splice\(1, 0, SALES_ANALYTICS_MARGIN_METRIC\)/);
  assert.doesNotMatch(html, /option value="grossMargin"/);
});

test("Breite Detailtabelle ist durchsuchbar, sortierbar und zeigt beide Zeiträume", () => {
  const view = between(html, '<section id="salesAnalyticsView"', '<section id="personnelView"');
  for (const id of [
    "salesReportGroupSearch",
    "salesReportTableSort",
    "salesReportTableCount",
    "salesReportTableHead",
    "salesReportTableBody",
  ]) assert.match(view, new RegExp(`id="${id}"`));
  assert.match(app, /Aktuell \$\{salesPeriodLabel\(periods\.current\)\}/);
  assert.match(app, /Vergleich \$\{salesPeriodLabel\(periods\.comparison\)\}/);
  assert.match(app, /toLocaleLowerCase\("de"\)\.includes\(normalizedSearch\)/);
  assert.match(app, /function sortSalesAnalyticsGroups\(groups, horizon\)/);
  assert.match(styles, /\.sales-report-analysis-table th:first-child,\.sales-report-analysis-table td:first-child \{ position:sticky/);
});

test("Block-8-Vertrag hält Datenquellen- und Ausrollgrenzen fest", () => {
  assert.match(contract, /keine künstlich berechnete Unternehmenssumme/i);
  assert.match(contract, /ohne Rohertragsrecht fehlen Rohertragswerte in der API-Antwort/i);
  assert.match(contract, /direkte Access-Datenbankanbindung oder Hintergrundsynchronisation/i);
  assert.match(contract, /Onlineshopumsätze ohne katalogisierte Bestell- oder Umsatzquelle/i);
  assert.match(contract, /keine mobile Fachansicht oder mobile Abnahme/i);
  assert.match(contract, /Commit, Push, Release oder VPS-Deployment/i);
  assert.match(app, /api\(`\/api\/sales-analytics\/reports\/\$\{encodeURIComponent\(requestedId\)\}`\)/);
});
