"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const test = require("node:test");

const PDFDocument = require("pdfkit");

const {
  TRADEFOTO_REPORT_MAX_TEXT_ITEM_CHARACTERS,
  TRADEFOTO_REPORT_MAX_TEXT_ITEMS_PER_PAGE,
  TradeFotoReportError,
  assertTradeFotoReportPreview,
  inspectTradeFotoReportBuffer,
  parseTradeFotoReportPages,
  reviewTradeFotoOcrPreview,
} = require("../lib/sales-analytics-tradefoto-report");
const {
  inspectTradeFotoOcrReportBuffer,
} = require("../lib/sales-analytics-tradefoto-ocr");
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

const repositoryRoot = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(repositoryRoot, "server.js"), "utf8");
const reportImportContract = fs.readFileSync(
  path.join(repositoryRoot, "docs", "VERKAUFSANALYSEN-PDF-BERICHTSIMPORT-v0.1.md"),
  "utf8",
);
const ocrPartnerContract = fs.readFileSync(
  path.join(repositoryRoot, "docs", "VERKAUFSANALYSEN-OCR-PARTNERIMPORT-v0.1.md"),
  "utf8",
);
const salesHtml = fs.readFileSync(path.join(repositoryRoot, "public", "index.html"), "utf8");
const salesApp = fs.readFileSync(path.join(repositoryRoot, "public", "app.js"), "utf8");

function pdfBuffer(render) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 0,
      compress: false,
    });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
    render(document);
    document.end();
  });
}

function rightAligned(document, value, right, y, width = 70) {
  document.text(String(value), right - width, y, {
    width,
    align: "right",
    lineBreak: false,
  });
}

function reportRow(document, y, edges, values) {
  rightAligned(document, values.quantityCurrent, edges.quantityCurrent, y);
  rightAligned(document, values.quantityComparison, edges.quantityComparison, y);
  rightAligned(document, values.netRevenueCurrent, edges.netRevenueCurrent, y);
  rightAligned(document, values.netRevenueComparison, edges.netRevenueComparison, y);
  rightAligned(document, values.grossMarginCurrent, edges.grossMarginCurrent, y);
  rightAligned(document, values.grossMarginComparison, edges.grossMarginComparison, y);
  rightAligned(document, values.customerCountCurrent, edges.customerCountCurrent, y);
  rightAligned(document, values.customerCountComparison, edges.customerCountComparison, y);
  rightAligned(document, values.revenuePerCustomerCurrent, edges.revenuePerCustomerCurrent, y);
  rightAligned(document, values.revenuePerCustomerComparison, edges.revenuePerCustomerComparison, y);
}

async function syntheticTradeFotoReport() {
  const groupEdges = {
    quantityCurrent: 178.3,
    quantityComparison: 226.9,
    netRevenueCurrent: 350.8,
    netRevenueComparison: 406.1,
    grossMarginCurrent: 519.6,
    grossMarginComparison: 568.3,
    customerCountCurrent: 676.9,
    customerCountComparison: 720,
    revenuePerCustomerCurrent: 766.2,
    revenuePerCustomerComparison: 808.6,
  };
  const totalEdges = {
    quantityCurrent: 186.6,
    quantityComparison: 234.1,
    netRevenueCurrent: 356.9,
    netRevenueComparison: 414.1,
    grossMarginCurrent: 525.7,
    grossMarginComparison: 574.6,
    customerCountCurrent: 678.6,
    customerCountComparison: 723.5,
    revenuePerCustomerCurrent: 767.8,
    revenuePerCustomerComparison: 811.2,
  };
  const period = {
    quantityCurrent: "2",
    quantityComparison: "1",
    netRevenueCurrent: "100,00",
    netRevenueComparison: "80,00",
    grossMarginCurrent: "25,00",
    grossMarginComparison: "20,00",
    customerCountCurrent: "2,00",
    customerCountComparison: "1,00",
    revenuePerCustomerCurrent: "50,00",
    revenuePerCustomerComparison: "80,00",
  };
  const yearToDate = {
    quantityCurrent: "10",
    quantityComparison: "8",
    netRevenueCurrent: "500,00",
    netRevenueComparison: "400,00",
    grossMarginCurrent: "125,00",
    grossMarginComparison: "100,00",
    customerCountCurrent: "8,00",
    customerCountComparison: "7,00",
    revenuePerCustomerCurrent: "62,50",
    revenuePerCustomerComparison: "57,14",
  };
  return pdfBuffer((document) => {
    document.font("Helvetica").fontSize(8);
    document.text("Warengruppenvergleich netto Filiale: 18", 29, 18, { lineBreak: false });
    document.text("*GsJahr ab: 01.01.26", 29, 35, { lineBreak: false });
    document.text("Menge Umsatz Rohertrag KundenAnzahl Umsatz/Kunde", 160, 35, { lineBreak: false });
    document.text("01.07.26-", 140, 67, { lineBreak: false });
    document.text("01.07.25-", 186, 67, { lineBreak: false });
    document.text("31.07.26", 140, 78, { lineBreak: false });
    document.text("31.07.25", 186, 78, { lineBreak: false });
    document.text("101", 29.3, 104, { lineBreak: false });
    document.text("Synthetische Kameras", 54.4, 104, { lineBreak: false });
    reportRow(document, 104, groupEdges, period);
    reportRow(document, 126.55, groupEdges, yearToDate);
    reportRow(document, 150.4, totalEdges, period);
    reportRow(document, 172.95, totalEdges, yearToDate);
    document.text("Seite: 1 von 1", 29, 555, { lineBreak: false });
    document.text("03.08.26", 760, 555, { lineBreak: false });
  });
}

async function rasterOnlyPdf(sourcePdf) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfRequire = createRequire(require.resolve("pdfjs-dist/package.json"));
  const { createCanvas } = pdfRequire("@napi-rs/canvas");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(sourcePdf),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl: `${path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts").replaceAll("\\", "/")}/`,
  });
  try {
    const source = await loadingTask.promise;
    const page = await source.getPage(1);
    try {
      const viewport = page.getViewport({ scale: 4 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport,
        background: "#ffffff",
      }).promise;
      const image = await canvas.encode("png");
      try {
        return await pdfBuffer((document) => {
          document.image(image, 0, 0, {
            width: document.page.width,
            height: document.page.height,
          });
        });
      } finally {
        image.fill(0);
        canvas.width = 0;
        canvas.height = 0;
      }
    } finally {
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
}

test("TradeFoto-PDF: Textkoordinaten ergeben einen bestätigungspflichtigen Aggregatbericht", async () => {
  const pdf = await syntheticTradeFotoReport();
  const preview = await inspectTradeFotoReportBuffer(pdf, { fileName: "synthetisch.pdf" });
  assert.equal(assertTradeFotoReportPreview(preview), preview);
  assert.equal(preview.source.contentSha256, crypto.createHash("sha256").update(pdf).digest("hex"));
  assert.equal(preview.source.originalRetained, false);
  assert.equal(preview.report.externalBranchId, "18");
  assert.deepEqual(preview.report.periods.period, {
    start: "2026-07-01",
    end: "2026-07-31",
  });
  assert.equal(preview.report.currency, null);
  assert.equal(preview.report.currencyConfirmationRequired, true);
  assert.equal(preview.productGroups.length, 1);
  assert.equal(preview.productGroups[0].label, "Synthetische Kameras");
  assert.equal(preview.productGroups[0].horizons.period.current.netRevenue, "100.0000");
  assert.equal(preview.totals.horizons.yearToDate.comparison.grossMargin, "100.0000");
  assert.equal(preview.reconciliation.status, "match");
  assert.equal(preview.issues.length, 0);
});

test("TradeFoto-PDF: fehlende Textschicht wird fail-closed an den OCR-Fallback verwiesen", async () => {
  const pdf = await pdfBuffer((document) => {
    document.rect(20, 20, 300, 200).fill("#dddddd");
  });
  await assert.rejects(
    () => inspectTradeFotoReportBuffer(pdf),
    (error) => error instanceof TradeFotoReportError
      && error.code === "TRADEFOTO_REPORT_TEXT_LAYER_REQUIRED"
      && error.details.ocrFallbackAvailable === true,
  );
});

test("TradeFoto-PDF: überkomplexe Textschichten werden vor der fachlichen Auswertung begrenzt", () => {
  const layoutItem = Object.freeze({ text: "x", x: 1, y: 1, width: 1 });
  assert.throws(
    () => parseTradeFotoReportPages([{
      height: 100,
      width: 100,
      items: Array(TRADEFOTO_REPORT_MAX_TEXT_ITEMS_PER_PAGE + 1).fill(layoutItem),
    }]),
    (error) => error instanceof TradeFotoReportError
      && error.code === "TRADEFOTO_REPORT_COMPLEXITY_LIMIT"
      && error.details.reason === "text_items_per_page",
  );
  assert.throws(
    () => parseTradeFotoReportPages([{
      height: 100,
      width: 100,
      items: [{
        ...layoutItem,
        text: "x".repeat(TRADEFOTO_REPORT_MAX_TEXT_ITEM_CHARACTERS + 1),
      }],
    }]),
    (error) => error instanceof TradeFotoReportError
      && error.code === "TRADEFOTO_REPORT_COMPLEXITY_LIMIT"
      && error.details.reason === "text_item_characters",
  );
});

test("TradeFoto-PDF: OCR rendert nicht eingebettete Standardschriften aus lokalen Paketdateien", async () => {
  const preview = await inspectTradeFotoOcrReportBuffer(await syntheticTradeFotoReport(), {
    fileName: "synthetische-standardschrift.pdf",
  });
  assert.equal(preview.report.externalBranchId, "18");
  assert.equal(preview.productGroups[0].externalProductGroupId, "101");
  assert.equal(preview.productGroups[0].horizons.period.current.netRevenue, "100.0000");
  assert.equal(preview.confirmation.ocrReviewRequired, true);
});

test("TradeFoto-PDF: lokale OCR erkennt eine reine Rasterseite nur als bearbeitbaren Vorschlag", async () => {
  const scannedPdf = await rasterOnlyPdf(await syntheticTradeFotoReport());
  await assert.rejects(
    () => inspectTradeFotoReportBuffer(scannedPdf),
    (error) => error instanceof TradeFotoReportError
      && error.code === "TRADEFOTO_REPORT_TEXT_LAYER_REQUIRED",
  );
  const preview = await inspectTradeFotoOcrReportBuffer(scannedPdf, {
    fileName: "synthetischer-scan.pdf",
  });
  assert.equal(assertTradeFotoReportPreview(preview), preview);
  assert.equal(preview.source.extraction, "local_ocr_coordinates");
  assert.equal(preview.source.originalRetained, false);
  assert.equal(preview.source.ocrReviewed, false);
  assert.equal(preview.confirmation.ocrReviewRequired, true);
  assert.equal(preview.report.externalBranchId, "18");
  assert.equal(preview.productGroups.length, 1);
  assert.equal(preview.productGroups[0].externalProductGroupId, "101");
  assert.equal(preview.productGroups[0].horizons.period.current.netRevenue, "100.0000");

  const reviewed = reviewTradeFotoOcrPreview(preview, {
    report: {
      externalBranchId: preview.report.externalBranchId,
      generatedOn: preview.report.generatedOn,
      periods: preview.report.periods,
    },
    productGroups: preview.productGroups.map((group) => ({
      externalProductGroupId: group.externalProductGroupId,
      label: group.label,
      horizons: group.horizons,
    })),
    totals: { horizons: preview.totals.horizons },
  });
  assert.equal(reviewed.source.ocrReviewed, true);
  assert.equal(reviewed.confirmation.ocrReviewed, true);
  assert.equal(reviewed.reconciliation.status, "match");

  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_SALES_ANALYTICS_CATALOG,
  });
  application.database.exec(`
    CREATE TABLE locations (id TEXT PRIMARY KEY);
    INSERT INTO locations (id) VALUES ('18');
  `);
  ensureSqliteSalesAnalyticsSchema(application.database);
  const repository = createSalesAnalyticsPersistenceRepository(application.provider);
  const input = {
    locationId: "18",
    currency: "EUR",
    confirmed: true,
    actor: "252",
    timestamp: "2026-08-03T12:00:00.000Z",
  };
  try {
    await assert.rejects(
      () => repository.recordConfirmedTradeFotoReport({ ...input, preview }),
      (error) => error?.code === "PERSISTENCE_STATEMENT_INVALID",
    );
    const stored = await repository.recordConfirmedTradeFotoReport({ ...input, preview: reviewed });
    assert.equal(stored.report.extraction, "local_ocr_coordinates");
    assert.equal(stored.report.reviewMethod, "ocr_human_confirmed");
  } finally {
    await application.provider.close();
    application.database.close();
  }
});

test("TradeFoto-PDF: bestätigter Bericht, Zuordnung und Kennzahlen werden atomar und idempotent gespeichert", async () => {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_SALES_ANALYTICS_CATALOG,
  });
  application.database.exec(`
    CREATE TABLE locations (id TEXT PRIMARY KEY);
    INSERT INTO locations (id) VALUES ('18'), ('19');
  `);
  ensureSqliteSalesAnalyticsSchema(application.database);
  const repository = createSalesAnalyticsPersistenceRepository(application.provider);
  try {
    const pdf = await syntheticTradeFotoReport();
    const preview = await inspectTradeFotoReportBuffer(pdf);
    const input = {
      preview,
      locationId: "18",
      currency: "EUR",
      confirmed: true,
      actor: "252",
      timestamp: "2026-08-03T12:00:00.000Z",
    };
    const first = await repository.recordConfirmedTradeFotoReport(input);
    const second = await repository.recordConfirmedTradeFotoReport(input);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.report.id, first.report.id);
    assert.equal(first.report.extraction, "pdf_text_coordinates");
    assert.equal(first.report.reviewMethod, "source_text_confirmed");
    assert.equal(first.report.locationId, "18");
    assert.equal(first.report.currency, "EUR");
    const bundle = await repository.getReportBundle(first.report.id);
    assert.equal(bundle.productGroupMetrics.length, 2);
    assert.equal(bundle.totals.length, 2);
    assert.equal(bundle.productGroupMetrics[0].currentNetRevenue, "100.0000");
    const mappings = await repository.listActiveBranchMappings("tradefoto_report");
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0].externalBranchId, "18");
    assert.equal(mappings[0].locationId, "18");
    await assert.rejects(
      () => repository.recordConfirmedTradeFotoReport({ ...input, locationId: "19" }),
      (error) => error?.code === "PERSISTENCE_CONTRACT_VIOLATION"
        && error.operation === "tradefoto-report-reuse-conflict",
    );
    const variantPdf = Buffer.concat([pdf, Buffer.from("\n% Block-9-Variante\n")]);
    const variantPreview = await inspectTradeFotoReportBuffer(variantPdf);
    await assert.rejects(
      () => repository.recordConfirmedTradeFotoReport({ ...input, preview: variantPreview }),
      (error) => error?.code === "PERSISTENCE_CONTRACT_VIOLATION"
        && error.operation === "tradefoto-report-period-conflict",
    );
    assert.equal((await repository.listReports({ locationId: "18" })).length, 1);
    assert.throws(
      () => application.database.prepare(`
        UPDATE sales_aggregate_reports SET currency = 'USD' WHERE id = ?
      `).run(first.report.id),
      /immutable/,
    );
  } finally {
    await application.provider.close();
    application.database.close();
  }
});

test("TradeFoto-PDF: API, Desktop-Prüfung und Nachfolgedokument halten OCR-Grenzen fest", () => {
  for (const route of [
    "/api/sales-analytics/report-import/context",
    "/api/sales-analytics/report-import/inspect",
    "/api/sales-analytics/report-import/apply",
    "/api/sales-analytics/reports",
  ]) assert.match(serverSource, new RegExp(route.replaceAll("/", "\\/")));
  assert.match(serverSource, /express\.raw\([\s\S]{0,180}limit:\s*"15mb"/);
  assert.match(serverSource, /inspectTradeFotoOcrReportBuffer/);
  assert.match(serverSource, /reviewTradeFotoOcrPreview/);
  assert.match(serverSource, /text_layout_with_local_ocr_review/);
  assert.match(serverSource, /TRADEFOTO_REPORT_COMPLEXITY_LIMIT/);
  assert.match(serverSource, /SALES_ANALYTICS_REPORT_PERIOD_CONFLICT/);
  assert.match(serverSource, /SALES_ANALYTICS_REPORT_REUSE_CONFLICT/);
  assert.match(serverSource, /sales\.report\.pdf\.rejected/);
  assert.match(serverSource, /originalRetained:\s*false/);
  assert.match(salesHtml, /id="salesReportOcrReview"/);
  assert.match(salesHtml, /id="salesReportPreviewHorizon"/);
  assert.match(salesApp, /requestBody\.ocrReview = salesOcrReviewPayload/);
  assert.match(salesApp, /local_ocr_coordinates/);
  assert.match(reportImportContract, /kein optional installierbares Modul/i);
  assert.match(reportImportContract, /ursprüngliche PDF-Datei[\s\S]{0,100}weder als Datei noch als Blob/i);
  assert.match(reportImportContract, /OCR-Fallback ist mit diesem Stand noch nicht freigegeben/i);
  assert.match(reportImportContract, /0\/979/);
  assert.match(ocrPartnerContract, /lokal eingelesen/i);
  assert.match(ocrPartnerContract, /rohe OCR-Text werden nicht persistiert/i);
  assert.match(ocrPartnerContract, /ocr_human_confirmed/);
  assert.match(ocrPartnerContract, /keine mobile Fachansicht/i);
  assert.match(ocrPartnerContract, /kein Commit, Push, Release oder VPS-Deployment/i);
});
