"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  SALES_ANALYTICS_MODEL,
  SALES_ANALYTICS_ENTITIES,
  SALES_ANALYTICS_IMPORT_PACKAGES,
  salesAnalyticsEntity,
  salesAnalyticsField,
} = require("../lib/sales-analytics-model");
const {
  SALES_IMPORT_CONTRACT_VERSION,
  SALES_IMPORT_PREVIEW_ROW_LIMIT,
  SALES_SOURCE_ADAPTERS,
  SalesImportContractError,
  createSalesImportPreview,
  isProhibitedSourceField,
  normalizeSalesImportProfile,
  normalizeSalesImportSource,
  salesSourceSchemaSha256,
} = require("../lib/sales-analytics-import");

const root = path.resolve(__dirname, "..");
const contract = fs.readFileSync(
  path.join(root, "docs", "VERKAUFSANALYSEN-DATENMODELL-IMPORTFUNDAMENT-v0.1.md"),
  "utf8",
);

function receiptMapping(overrides = {}) {
  return {
    sourceKey: {
      sources: ["Bonnr", "Filialid", "Kassenid", "Bondatum"],
      transform: "sha256_key",
    },
    locationId: { sources: ["Filialid"], transform: "branch_map" },
    registerId: { sources: ["Kassenid"], transform: "identifier_text" },
    saleDate: { sources: ["Bondatum"], transform: "date_dmy" },
    saleTime: { sources: ["Bonzeit"], transform: "time_hms" },
    sourceHeaderAmount: { sources: ["RechnungsBetrag"], transform: "decimal4_de" },
    ...overrides,
  };
}

function profileInput({ mapping = receiptMapping(), branchMappings = { 1: "location-01" }, resolvedDecisions = [] } = {}) {
  const sourceFields = [...new Set(Object.values(mapping).flatMap((entry) => entry.sources || []))];
  return {
    contractVersion: SALES_IMPORT_CONTRACT_VERSION,
    id: "receipt-profile-v1",
    name: "Synthetisches Belegprofil",
    entityId: "sales_receipt",
    sourceSchemaSha256: salesSourceSchemaSha256(sourceFields),
    mapping,
    branchMappings,
    resolvedDecisions,
  };
}

function sourceInput(sourceSchemaSha256, overrides = {}) {
  return {
    adapterId: "structured_rows",
    contentSha256: "b".repeat(64),
    sourceSchemaSha256,
    snapshotAt: "2026-08-03T10:00:00.000Z",
    timeZone: "Europe/Vienna",
    ...overrides,
  };
}

function receiptRow(overrides = {}) {
  return {
    Bonnr: "100",
    Filialid: "1",
    Kassenid: "01",
    Bondatum: "02.01.2020",
    Bonzeit: "09:05",
    RechnungsBetrag: "",
    ...overrides,
  };
}

test("Block 4: kanonisches Modell trennt Importkontrolle, Verkaufsfakten und Snapshots", () => {
  assert.equal(SALES_ANALYTICS_MODEL.version, 3);
  assert.equal(SALES_ANALYTICS_MODEL.businessTimeZone, "Europe/Vienna");
  assert.equal(SALES_ANALYTICS_MODEL.decimalScale, 4);
  assert.equal(SALES_ANALYTICS_MODEL.identifiersRemainText, true);
  assert.deepEqual(Object.keys(SALES_ANALYTICS_IMPORT_PACKAGES), [
    "aggregated_sales_report",
    "historical_sales",
    "product_snapshot",
    "inventory_snapshot",
    "product_taxonomy",
    "shop_product_mapping",
  ]);
  assert.deepEqual(SALES_ANALYTICS_IMPORT_PACKAGES.historical_sales.entityIds, [
    "sales_receipt",
    "sales_line",
  ]);
  assert.deepEqual(SALES_ANALYTICS_IMPORT_PACKAGES.aggregated_sales_report.entityIds, [
    "aggregated_sales_report",
    "sales_product_group_report_metric",
    "sales_report_total_metric",
  ]);
  assert.equal(salesAnalyticsEntity("aggregated_sales_report").packageId, "aggregated_sales_report");
  assert.equal(salesAnalyticsField("aggregated_sales_report", "extraction").dataClass, "review");
  assert.equal(salesAnalyticsField("aggregated_sales_report", "reviewMethod").dataClass, "review");
  assert.equal(salesAnalyticsField("sales_product_group_report_metric", "currentGrossMargin").dataClass, "margin");
  assert.equal(salesAnalyticsEntity("sales_import_run").importable, false);
  assert.equal(salesAnalyticsEntity("sales_receipt").packageId, "historical_sales");
  assert.equal(salesAnalyticsEntity("product_snapshot").packageId, "product_snapshot");
  assert.equal(salesAnalyticsField("sales_line", "actualUnitPrice").kind, "decimal4");
  assert.equal(salesAnalyticsField("sales_line", "grossMarginRaw").dataClass, "margin");
  assert.equal(salesAnalyticsField("inventory_snapshot", "onHand").dataClass, "inventory");
  assert.equal(salesAnalyticsEntity("unknown"), null);
  assert.equal(salesAnalyticsField("sales_line", "customerId"), null);
  assert.equal(Object.isFrozen(SALES_ANALYTICS_MODEL), true);
  assert.equal(Object.isFrozen(SALES_ANALYTICS_ENTITIES.sales_line.fields), true);
});

test("Block 4: Produktzuordnung erzeugt weder Shopbestellungen noch Shopumsatz", () => {
  assert.deepEqual(Object.keys(SALES_ANALYTICS_ENTITIES.shop_product_mapping.fields), [
    "sourceKey",
    "ean",
    "shopArticleId",
    "shopVariantId",
    "snapshotAt",
  ]);
  assert.equal(Object.hasOwn(SALES_ANALYTICS_ENTITIES, "customer"), false);
  assert.equal(Object.hasOwn(SALES_ANALYTICS_ENTITIES.sales_line.fields, "sellerId"), false);
  assert.equal(Object.hasOwn(SALES_ANALYTICS_ENTITIES.sales_line.fields, "employeeId"), false);
  assert.equal(Object.hasOwn(SALES_ANALYTICS_ENTITIES.sales_line.fields, "commission"), false);
});

test("Block 7: externe Datenadapter bleiben gesperrt und lokale OCR bleibt bestätigungspflichtig", () => {
  assert.deepEqual(SALES_SOURCE_ADAPTERS.structured_rows, {
    id: "structured_rows",
    status: "foundation_ready",
    readsExternalSource: false,
    proposalOnly: false,
    humanConfirmationRequired: false,
  });
  assert.equal(SALES_SOURCE_ADAPTERS.access_snapshot.status, "adapter_pending");
  assert.equal(SALES_SOURCE_ADAPTERS.csv_file.status, "adapter_pending");
  assert.equal(SALES_SOURCE_ADAPTERS.xlsx_file.status, "adapter_pending");
  assert.equal(SALES_SOURCE_ADAPTERS.sql_view.status, "adapter_pending");
  assert.equal(SALES_SOURCE_ADAPTERS.https_api.status, "adapter_pending");
  assert.deepEqual(SALES_SOURCE_ADAPTERS.report_ocr, {
    id: "report_ocr",
    status: "local_review_ready",
    readsExternalSource: true,
    proposalOnly: true,
    humanConfirmationRequired: true,
  });
  assert.deepEqual(SALES_SOURCE_ADAPTERS.tradefoto_pdf_report, {
    id: "tradefoto_pdf_report",
    status: "text_and_local_ocr_ready",
    readsExternalSource: true,
    proposalOnly: true,
    humanConfirmationRequired: true,
  });
  assert.equal(Object.isFrozen(SALES_SOURCE_ADAPTERS.report_ocr), true);
});

test("Block 4: Profil ist allowlist-basiert, versionsgebunden und unveränderlich", () => {
  const normalized = normalizeSalesImportProfile(profileInput());
  assert.equal(normalized.contractVersion, 1);
  assert.equal(normalized.entityId, "sales_receipt");
  assert.deepEqual(normalized.sourceFields, [
    "Bondatum",
    "Bonnr",
    "Bonzeit",
    "Filialid",
    "Kassenid",
    "RechnungsBetrag",
  ]);
  assert.equal(normalized.branchMappings["1"], "location-01");
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.mapping), true);
  assert.equal(Object.isFrozen(normalized.mapping.sourceKey.sources), true);
});

test("Block 4: Vorschau trennt akzeptiert, Prüfbedarf, Fehler und Dublette ohne Rohwert im Fehler", () => {
  const profile = profileInput();
  const source = sourceInput(profile.sourceSchemaSha256);
  const preview = createSalesImportPreview({
    profile,
    source,
    rows: [
      receiptRow(),
      receiptRow({ Bonnr: "200", Filialid: "99" }),
      receiptRow({ Bonnr: "300", RechnungsBetrag: 2.5 }),
      receiptRow(),
    ],
  });

  assert.equal(preview.mode, "dry_run");
  assert.equal(preview.persistence, "none");
  assert.equal(preview.canCommit, false);
  assert.match(preview.idempotencyKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(preview.summary, {
    total: 4,
    accepted: 1,
    needsReview: 1,
    rejected: 1,
    duplicate: 1,
  });
  assert.deepEqual(preview.records.map((record) => record.status), [
    "accepted",
    "needs_review",
    "rejected",
    "duplicate",
  ]);
  assert.deepEqual(preview.unresolvedDecisionIds, [
    "branch_mapping",
    "sales_currency",
    "sales_price_basis",
  ]);
  assert.equal(preview.records[0].data.registerId, "01");
  assert.equal(preview.records[0].data.saleDate, "2020-01-02");
  assert.equal(preview.records[0].data.saleTime, "09:05:00");
  assert.match(preview.records[0].data.sourceKey, /^[a-f0-9]{64}$/);
  assert.equal(preview.records[1].data.locationId, null);
  assert.equal(preview.records[2].issues[0].code, "SALES_IMPORT_BINARY_FLOAT_FORBIDDEN");
  assert.equal(preview.records[3].issues[0].code, "SALES_IMPORT_DUPLICATE_RECORD");
  assert.equal(JSON.stringify(preview.issues).includes("2.5"), false);
  assert.equal(JSON.stringify(preview.issues).includes("Bonnr"), false);
  assert.equal(Object.isFrozen(preview), true);
  assert.equal(Object.isFrozen(preview.records[0].data), true);
});

test("Block 4: Dezimalwerte bleiben vierstellig und JavaScript-Gleitkommazahlen sind verboten", () => {
  const mapping = receiptMapping();
  const profile = profileInput({ mapping });
  const preview = createSalesImportPreview({
    profile,
    source: sourceInput(profile.sourceSchemaSha256),
    rows: [receiptRow({ RechnungsBetrag: "1234,5" })],
  });
  assert.equal(preview.records[0].status, "needs_review");
  assert.equal(preview.records[0].data.sourceHeaderAmount, "1234.5000");
  assert.equal(preview.records[0].issues[0].code, "SALES_IMPORT_STAGING_FIELD_PRESENT");
});

test("Block 4: Sonderfilialen werden nur nach ausdrücklicher Zuordnung übernommen", () => {
  const profile = profileInput({
    branchMappings: { 1: "location-01", 99: "location-online-review" },
  });
  const preview = createSalesImportPreview({
    profile,
    source: sourceInput(profile.sourceSchemaSha256),
    rows: [receiptRow({ Filialid: "99" })],
  });
  assert.equal(preview.records[0].status, "accepted");
  assert.equal(preview.records[0].data.locationId, "location-online-review");
});

test("Block 4: unbekannte Spalten und geschützte Quellenfelder bleiben fail-closed", () => {
  assert.equal(isProhibitedSourceField("KUND_NR"), true);
  assert.equal(isProhibitedSourceField("VerkäuferID"), true);
  assert.equal(isProhibitedSourceField("Personalkennziffer"), true);
  assert.equal(isProhibitedSourceField("IBAN"), true);
  assert.equal(isProhibitedSourceField("Verkaufspreis"), false);

  const prohibitedMapping = receiptMapping({
    sourceKey: { sources: ["KUND_NR"], transform: "sha256_key" },
  });
  assert.throws(
    () => normalizeSalesImportProfile(profileInput({ mapping: prohibitedMapping })),
    (error) => error instanceof SalesImportContractError
      && error.code === "SALES_IMPORT_PROHIBITED_SOURCE_FIELD",
  );

  const profile = profileInput();
  const preview = createSalesImportPreview({
    profile,
    source: sourceInput(profile.sourceSchemaSha256),
    rows: [{ ...receiptRow(), KUND_NR: "never-returned" }],
  });
  assert.equal(preview.summary.rejected, 1);
  assert.deepEqual(preview.records[0].data, {});
  assert.equal(preview.records[0].issues[0].code, "SALES_IMPORT_ROW_SCHEMA_MISMATCH");
  assert.equal(JSON.stringify(preview).includes("never-returned"), false);

  assert.throws(
    () => normalizeSalesImportProfile({ ...profile, password: "not-allowed" }),
    (error) => error instanceof SalesImportContractError
      && error.code === "SALES_IMPORT_PROFILE_INVALID",
  );
});

test("Block 4: Schemaabweichung und nicht implementierte Adapter brechen vor der Vorschau ab", () => {
  const profile = profileInput();
  assert.throws(
    () => createSalesImportPreview({
      profile,
      source: sourceInput("c".repeat(64)),
      rows: [receiptRow()],
    }),
    (error) => error instanceof SalesImportContractError
      && error.code === "SALES_IMPORT_SOURCE_SCHEMA_MISMATCH",
  );

  for (const adapterId of ["access_snapshot", "csv_file", "xlsx_file", "sql_view", "https_api", "report_ocr"]) {
    assert.throws(
      () => createSalesImportPreview({
        profile,
        source: sourceInput(profile.sourceSchemaSha256, {
          adapterId,
          proposalConfirmed: adapterId === "report_ocr",
        }),
        rows: [receiptRow()],
      }),
      (error) => error instanceof SalesImportContractError
        && error.code === "SALES_IMPORT_ADAPTER_NOT_READY"
        && error.details.adapterId === adapterId,
      adapterId,
    );
  }
});

test("Block 4: Vorschaugrenze, Zeitzone und Quellmetadaten sind strikt", () => {
  const profile = profileInput();
  assert.equal(SALES_IMPORT_PREVIEW_ROW_LIMIT, 1000);
  assert.throws(
    () => normalizeSalesImportSource(sourceInput(profile.sourceSchemaSha256, { timeZone: "UTC" })),
    (error) => error.code === "SALES_IMPORT_TIME_ZONE_INVALID",
  );
  assert.throws(
    () => normalizeSalesImportSource({
      ...sourceInput(profile.sourceSchemaSha256),
      localPath: "C:\\source\\dump.accdb",
    }),
    (error) => error.code === "SALES_IMPORT_SOURCE_INVALID",
  );
  assert.throws(
    () => createSalesImportPreview({
      profile,
      source: sourceInput(profile.sourceSchemaSha256),
      rows: Array.from({ length: SALES_IMPORT_PREVIEW_ROW_LIMIT + 1 }, () => receiptRow()),
    }),
    (error) => error.code === "SALES_IMPORT_PREVIEW_ROW_LIMIT",
  );
});

test("Block-4-Dokument hält Persistenz-, Echtdaten- und OCR-Grenze fest", () => {
  assert.match(contract, /^# Verkaufsanalysen · Datenmodell und Importfundament v0\.1/m);
  assert.match(contract, /\| Block \| 4 · Datenmodell und Importfundament \|/);
  assert.match(contract, /keine produktive Datenbankmigration/);
  assert.match(contract, /keinen echten Access-, CSV-, XLSX-, SQL-, API- oder OCR-Adapter/);
  assert.match(contract, /`report_ocr`/);
  assert.match(contract, /menschlich bestätigt/);
  assert.match(contract, /keine Quelldatei geöffnet und keine Echtdaten übernommen/);
  assert.match(contract, /Desktop-Fachbereich/);
});
