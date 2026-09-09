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
        tableSort: "netRevenue_current_desc",
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
    salesMetricAbsoluteChange,
    formatSalesMetricChange,
    salesAnalyticsParetoEntries,
    salesAnalyticsShareEntries,
    salesAnalyticsPeriods,
    salesReportDateRangeInvalid,
    filteredSalesAnalyticsReports,
    salesReportSeriesSelectionValidation,
    sortSalesAnalyticsGroups,
  };`, context);
  return { context, functions: context.result };
}

function preferenceFunctions() {
  const source = between(
    app,
    "const SALES_ANALYTICS_CHART_TYPE_IDS",
    "const state =",
  );
  const context = {};
  vm.runInNewContext(`${source}\n;globalThis.result = {
    normalizeSalesAnalyticsFilenamePrefix,
    normalizeSalesAnalyticsPdfOptions,
    normalizeSalesAnalyticsPreferences,
  };`, context);
  return context.result;
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
  assert.match(styles, /\.sales-analytics-desktop-workspace > \* \{ min-width:1120px; \}/);
  assert.doesNotMatch(view, /sales.*mobile|mobile.*sales/i);
  assert.match(view, /id="salesReportHorizon"><option value="year_to_date">Jahr bis Berichtsende<\/option><option value="period">Berichtszeitraum<\/option>/);
  assert.match(app, /horizon: "year_to_date"/);
  assert.match(app, /previewHorizon: "period"/);
  assert.match(app, /const horizon = series \? "period" : state\.salesAnalytics\.horizon/);
  const seriesAnalysis = between(app, "async function analyzeSalesReportSeries()", "async function downloadSalesAnalyticsChartsPdf");
  assert.doesNotMatch(seriesAnalysis, /salesAnalytics\.horizon\s*=/);
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
  assert.match(app, /comparison <= 0\) return null/);
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
  assert.equal(functions.salesMetricRelativeChange(-50, -100), null);
  assert.equal(functions.formatSalesMetricChange(25, 0), "Kein Prozentvergleich");
  assert.equal(functions.formatSalesMetricChange(-50, -100), "Kein Prozentvergleich");
  assert.equal(functions.formatSalesMetricChange(0, 0), "±0,0 %");
  assert.equal(functions.salesMetricAbsoluteChange(125, 100), 25);
  assert.equal(functions.salesMetricAbsoluteChange(-5, 10), -15);
  assert.equal(functions.salesMetricAbsoluteChange(null, 10), null);
  context.state.salesAnalytics.dateFrom = "2026-08-01";
  assert.equal(functions.salesReportDateRangeInvalid(), true);
  assert.equal(functions.filteredSalesAnalyticsReports().length, 0);
});

test("Absolute Abweichung und Pareto-Auswertung bleiben bei Null- und Negativwerten fachlich stabil", () => {
  const { functions } = analysisFunctions();
  const rows = functions.salesAnalyticsParetoEntries([
    { id: "a", current: 60 },
    { id: "b", current: 30 },
    { id: "c", current: 10 },
    { id: "negative", current: -20 },
    { id: "missing", current: null },
  ], 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "a");
  assert.equal(rows[0].share, 60);
  assert.equal(rows[0].cumulativeShare, 60);
  assert.equal(rows[1].id, "b");
  assert.equal(rows[1].share, 30);
  assert.equal(rows[1].cumulativeShare, 90);
  assert.equal(rows[1].total, 100);
  assert.match(app, /chartType === "absolute_change"/);
  assert.match(app, /chartType === "pareto"/);
  assert.match(styles, /\.sales-chart-pareto-marker/);
});

test("Anteilsgrafik erklärt bei Top-N den vollständigen Rest", () => {
  const { functions } = analysisFunctions();
  const rows = functions.salesAnalyticsShareEntries([
    { group: { externalProductGroupId: "A", label: "A" }, current: 60 },
    { group: { externalProductGroupId: "B", label: "B" }, current: 30 },
    { group: { externalProductGroupId: "C", label: "C" }, current: 10 },
    { group: { externalProductGroupId: "D", label: "Negativ" }, current: -5 },
  ], 2);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].group.externalProductGroupId, "REST");
  assert.equal(rows[2].current, 10);
  assert.equal(rows[2].share, 10);
  assert.equal(rows.reduce((sum, row) => sum + row.share, 0), 100);
});

test("Persönliche PDF-Exportoptionen sind allowlisted, begrenzt und sicher normalisiert", () => {
  const functions = preferenceFunctions();
  const normalized = functions.normalizeSalesAnalyticsPdfOptions({
    orientation: "diagonal",
    charts: ["pareto", "unbekannt", "pareto", "absolute_change"],
    topN: 99,
    includeKpis: true,
    includeTable: true,
    filenamePrefix: " ../../Umsatz:<2026>?* ",
  });
  assert.equal(normalized.orientation, "landscape");
  assert.equal(Array.from(normalized.charts).join(","), "pareto,absolute_change");
  assert.equal(normalized.topN, 20);
  assert.equal(normalized.includeKpis, true);
  assert.equal(normalized.includeTable, true);
  assert.doesNotMatch(normalized.filenamePrefix, /[<>:"/\\|?*]/);
  assert.equal(
    Object.keys(normalized).sort().join(","),
    "charts,filenamePrefix,includeKpis,includeTable,orientation,topN",
  );

  const defaults = functions.normalizeSalesAnalyticsPreferences({});
  assert.equal(defaults.horizon, "year_to_date");
  assert.equal(defaults.chartMetric, "netRevenue");
  assert.equal(Array.from(defaults.pdf.charts).join(","), "ranking,change,absolute_change,share,pareto");
  assert.equal(defaults.pdf.includeKpis, true);
});

test("PDF-Dialog bietet nur den vereinbarten Analyseumfang und speichert kontobezogen", () => {
  const modal = between(
    html,
    '<dialog class="modal wide-modal sales-pdf-options-modal"',
    '<dialog class="modal wide-modal employee-modal"',
  );
  for (const id of [
    "salesReportPdfOrientation",
    "salesReportPdfTopN",
    "salesReportPdfIncludeKpis",
    "salesReportPdfIncludeTable",
    "salesReportPdfFilenamePrefix",
    "salesReportPdfExportButton",
  ]) assert.match(modal, new RegExp(`id="${id}"`));
  for (const chartId of ["ranking", "change", "absolute_change", "share", "pareto"]) {
    assert.match(modal, new RegExp(`value="${chartId}" data-sales-pdf-chart`));
  }
  assert.doesNotMatch(modal, /Branding|Logo|RGB|Farbe/i);
  assert.match(app, /api\("\/api\/sales-analytics\/preferences"\)/);
  assert.match(app, /method: "PUT"/);
  assert.match(app, /optionsVersion: 1/);
  assert.match(app, /function syncSalesAnalyticsActorState\(\)/);
  assert.match(app, /syncSalesAnalyticsActorState\(\);/);
  assert.match(app, /actorKey !== currentSalesAnalyticsActorKey\(\)/);
  assert.match(app, /preferencesRequestId/);
  assert.match(app, /seriesRequestId: 0/);
  assert.match(app, /horizon: "year_to_date"/);
  assert.match(app, /pdfOptions: normalizeSalesAnalyticsPdfOptions\(\)/);
  assert.match(app, /const horizon = series \? "period" : state\.salesAnalytics\.horizon/);
  assert.match(app, /charts\.length \? charts : \[\.\.\.SALES_ANALYTICS_PDF_DEFAULTS\.charts\]/);
  assert.match(styles, /\.sales-pdf-options-grid/);
});

test("Asynchrone Verkaufsanalyse-Antworten bleiben an den aktuellen Actor gebunden", () => {
  const guardedFunctions = [
    between(app, "async function loadSalesReportDetail", "function applySalesAnalyticsPreferences"),
    between(app, "async function loadSalesAnalytics({", "async function inspectSalesReportPdf"),
    between(app, "async function inspectSalesReportPdf", "async function discardSalesReportPreview"),
    between(app, "async function applySalesReportPreview", "function clearSalesReportSeries"),
    between(app, "async function analyzeSalesReportSeries", "async function downloadSalesAnalyticsChartsPdf"),
    between(app, "async function downloadSalesAnalyticsChartsPdf", "async function submitSalesAnalyticsPdfOptions"),
    between(app, "async function submitSalesAnalyticsPdfOptions", "function setView(view)"),
  ];
  for (const functionSource of guardedFunctions) {
    assert.match(functionSource, /const actorKey = currentSalesAnalyticsActorKey\(\)/);
    assert.match(functionSource, /salesAnalyticsActorIsCurrent\(actorKey\)/);
    const firstAwait = functionSource.indexOf("await ");
    assert.ok(
      firstAwait >= 0
        && /(?:salesAnalyticsActorIsCurrent\(actorKey\)|requestIsCurrent\(\))/.test(functionSource.slice(firstAwait)),
      "Nach der asynchronen Grenze muss der Actor erneut geprüft werden.",
    );
  }
  const actorGuard = between(app, "function salesAnalyticsActorIsCurrent", "function resetSalesAnalyticsActorState");
  assert.match(actorGuard, /state\.salesAnalytics\.actorKey === actorKey[\s\S]*currentSalesAnalyticsActorKey\(\) === actorKey/);
  const actorReset = between(app, "function resetSalesAnalyticsActorState", "function syncSalesAnalyticsActorState");
  assert.match(actorReset, /preferencesRequestId \+= 1/);
  assert.match(actorReset, /seriesRequestId \+= 1/);
  assert.match(actorReset, /reports: \[\][\s\S]*selectedReport: null[\s\S]*pdfOptions: normalizeSalesAnalyticsPdfOptions\(\)/);
  const download = between(app, "async function downloadSalesAnalyticsChartsPdf", "async function submitSalesAnalyticsPdfOptions");
  assert.match(download, /beforeSave: requestIsCurrent/);
});

test("Session-Timeout neutralisiert Verkaufsanalysedaten vor dem Login-Gate", () => {
  const gate = between(app, "function showLoginGate(message", "function hideLoginGate()");
  const clearSessionAt = gate.indexOf("state.portalSession = null");
  const resetAt = gate.indexOf('resetSalesAnalyticsActorState("")');
  const revealAt = gate.indexOf('elements.loginGate?.classList.remove("hidden")');
  assert.ok(clearSessionAt >= 0 && resetAt > clearSessionAt && resetAt < revealAt,
    "Sitzung und Verkaufsdaten müssen vor Anzeige des Login-Gates neutralisiert werden.");
});

test("Gespeicherte Verkaufsanalyse-Präferenzen werden erst nach Actor- und Request-Guard angewendet", () => {
  const loadPreferences = between(
    app,
    "async function loadSalesAnalyticsPreferences()",
    "function salesAnalyticsPreferencePayload",
  );
  const loadGuard = loadPreferences.indexOf("actorKey !== currentSalesAnalyticsActorKey()");
  const loadApply = loadPreferences.indexOf("applySalesAnalyticsPreferences(payload)");
  assert.ok(loadGuard >= 0 && loadGuard < loadApply,
    "Geladene Präferenzen dürfen erst nach Actor- und Request-ID-Prüfung angewendet werden.");
  assert.match(loadPreferences, /requestId !== state\.salesAnalytics\.preferencesRequestId/);

  const submitPreferences = between(
    app,
    "async function submitSalesAnalyticsPdfOptions",
    "function setView(view)",
  );
  const saveAwait = submitPreferences.indexOf("await saveSalesAnalyticsPreferences(options)");
  const submitGuard = submitPreferences.indexOf("!salesAnalyticsActorIsCurrent(actorKey)", saveAwait);
  const submitApply = submitPreferences.indexOf("applySalesAnalyticsPreferences(saved)", saveAwait);
  assert.ok(saveAwait >= 0 && submitGuard > saveAwait && submitGuard < submitApply,
    "Gespeicherte Präferenzen dürfen nach dem PUT erst nach dem vollständigen Guard angewendet werden.");
  assert.match(submitPreferences, /requestId !== state\.salesAnalytics\.preferencesRequestId/);
  const applyPreferences = between(app, "function applySalesAnalyticsPreferences", "function currentSalesAnalyticsActorKey");
  assert.doesNotMatch(applyPreferences, /state\.salesAnalytics\.(?:horizon|chartType|chartMetric)\s*=/);
  const preferencePayload = between(app, "function salesAnalyticsPreferencePayload", "async function saveSalesAnalyticsPreferences");
  assert.match(preferencePayload, /horizon: "year_to_date"/);
  assert.match(preferencePayload, /chartType: "ranking"/);
  assert.match(preferencePayload, /chartMetric: "netRevenue"/);
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
  context.state.salesAnalytics.tableSort = "netRevenue_current_desc";
  assert.equal(functions.sortSalesAnalyticsGroups(groups, "period")[0].externalProductGroupId, "100");
  context.state.salesAnalytics.tableSort = "netRevenue_change_desc";
  assert.equal(functions.sortSalesAnalyticsGroups(groups, "period")[0].externalProductGroupId, "200");
});

test("Rohertrag bleibt in Karten, Diagramm, Tabelle und Sortierung rechteabhängig", () => {
  assert.match(app, /detail\?\.rights\?\.grossMargin === true/);
  assert.match(app, /salesAnalyticsMetricDefinitions\(hasGrossMargin\)/);
  assert.match(app, /hasGrossMargin \? \["grossMargin_current", "grossMargin_comparison"\]/);
  assert.match(app, /hasGrossMargin \? \[\{ label: "Rohertrag", columns: \[/);
  assert.match(app, /if \(hasGrossMargin\) metrics\.splice\(1, 0, SALES_ANALYTICS_MARGIN_METRIC\)/);
  assert.doesNotMatch(html, /option value="grossMargin"/);
});

test("Breite Detailtabelle ist durchsuchbar, sortierbar und zeigt beide Zeiträume", () => {
  const view = between(html, '<section id="salesAnalyticsView"', '<section id="personnelView"');
  for (const id of [
    "salesReportGroupSearch",
    "salesReportTableCount",
    "salesReportTableHead",
    "salesReportTableBody",
  ]) assert.match(view, new RegExp(`id="${id}"`));
  assert.match(app, /Aktuell \$\{salesPeriodLabel\(periods\.current\)\}/);
  assert.match(app, /Vergleich \$\{salesPeriodLabel\(periods\.comparison\)\}/);
  assert.match(app, /toLocaleLowerCase\("de"\)\.includes\(normalizedSearch\)/);
  assert.match(app, /function sortSalesAnalyticsGroups\(groups, horizon, hasGrossMargin\)/);
  assert.match(app, /button\.dataset\.salesTableSort = sortKey/);
  assert.match(app, /cell\.setAttribute\("aria-sort"/);
  assert.match(app, /salesReportTableHead\?\.addEventListener\("click"/);
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
