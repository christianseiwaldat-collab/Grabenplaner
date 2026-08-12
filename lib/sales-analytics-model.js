"use strict";

const SALES_ANALYTICS_MODEL_VERSION = 3;

function deepFreeze(value, visited = new Set()) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  if (visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) deepFreeze(child, visited);
  return Object.freeze(value);
}

function field(kind, {
  required = false,
  dataClass = "base",
  persistence = "analysis",
  maxLength = null,
  decisionGates = [],
} = {}) {
  return {
    kind,
    required,
    dataClass,
    persistence,
    ...(maxLength === null ? {} : { maxLength }),
    decisionGates,
  };
}

const SALES_ANALYTICS_DECISION_GATES = deepFreeze({
  branch_mapping: {
    id: "branch_mapping",
    label: "Filialzuordnung einschließlich Sonderkennungen",
  },
  sales_currency: {
    id: "sales_currency",
    label: "Zielwährung der historischen Verkaufswerte",
  },
  sales_price_basis: {
    id: "sales_price_basis",
    label: "Brutto-/Nettobasis von Soll- und Istpreis",
  },
  return_storno_semantics: {
    id: "return_storno_semantics",
    label: "Vorzeichen-, Retouren- und Stornologik",
  },
  tax_mapping: {
    id: "tax_mapping",
    label: "Steuerzuordnung der jeweiligen Quelle",
  },
  margin_semantics: {
    id: "margin_semantics",
    label: "Währung und Berechnungsbasis der Rohertragsfelder",
  },
  snapshot_policy: {
    id: "snapshot_policy",
    label: "Snapshot-Frequenz und fachlicher Gültigkeitszeitpunkt",
  },
  retention_policy: {
    id: "retention_policy",
    label: "Aufbewahrung, Staging-Löschung und Rücknahmefrist",
  },
});

const SALES_ANALYTICS_ENTITIES = deepFreeze({
  sales_import_run: {
    id: "sales_import_run",
    importable: false,
    packageId: "import_control",
    purpose: "Nachvollziehbarer, idempotenter Trockenlauf- und späterer Importnachweis",
    fields: {
      id: field("sha256", { required: true, dataClass: "internal" }),
      profileId: field("identifier", { required: true, dataClass: "internal", maxLength: 80 }),
      entityId: field("identifier", { required: true, dataClass: "internal", maxLength: 80 }),
      contentSha256: field("sha256", { required: true, dataClass: "internal" }),
      schemaSha256: field("sha256", { required: true, dataClass: "internal" }),
      snapshotAt: field("utc_timestamp", { required: true, dataClass: "internal" }),
      status: field("identifier", { required: true, dataClass: "internal", maxLength: 40 }),
      summary: field("json", { required: true, dataClass: "internal" }),
    },
  },
  aggregated_sales_report: {
    id: "aggregated_sales_report",
    importable: true,
    packageId: "aggregated_sales_report",
    purpose: "Bestätigter, aggregierter Statistikbericht ohne Umdeutung in Einzelbelege",
    recordKey: "sourceKey",
    decisionGates: ["branch_mapping", "sales_currency", "margin_semantics"],
    fields: {
      sourceKey: field("sha256", { required: true, dataClass: "internal" }),
      sourceSystem: field("identifier", { required: true, dataClass: "internal", maxLength: 80 }),
      sourceFileSha256: field("sha256", { required: true, dataClass: "internal" }),
      extraction: field("identifier", { required: true, dataClass: "review", maxLength: 40 }),
      reviewMethod: field("identifier", { required: true, dataClass: "review", maxLength: 40 }),
      reportKind: field("identifier", { required: true, maxLength: 80 }),
      locationId: field("identifier", { required: true, dataClass: "internal", maxLength: 80 }),
      externalBranchId: field("identifier", { required: true, dataClass: "review", maxLength: 80 }),
      currency: field("identifier", { required: true, maxLength: 3, decisionGates: ["sales_currency"] }),
      periodStart: field("date", { required: true }),
      periodEnd: field("date", { required: true }),
      comparisonStart: field("date", { required: true }),
      comparisonEnd: field("date", { required: true }),
      yearToDateStart: field("date", { required: true }),
      generatedOn: field("date"),
      pageCount: field("safe_integer", { required: true, dataClass: "internal" }),
      productGroupCount: field("safe_integer", { required: true, dataClass: "internal" }),
      parserVersion: field("safe_integer", { required: true, dataClass: "internal" }),
      reconciliationStatus: field("identifier", { required: true, dataClass: "review", maxLength: 40 }),
      importedAt: field("utc_timestamp", { required: true, dataClass: "internal" }),
    },
  },
  sales_product_group_report_metric: {
    id: "sales_product_group_report_metric",
    importable: true,
    packageId: "aggregated_sales_report",
    purpose: "Gedruckte Warengruppenkennzahlen je Berichtszeitraum und Vergleichszeitraum",
    recordKey: "sourceKey",
    decisionGates: ["sales_currency", "margin_semantics"],
    fields: {
      sourceKey: field("sha256", { required: true, dataClass: "internal" }),
      reportSourceKey: field("sha256", { required: true, dataClass: "internal" }),
      externalProductGroupId: field("identifier", { required: true, maxLength: 80 }),
      historicalProductGroupName: field("text", { required: true, maxLength: 240 }),
      horizon: field("identifier", { required: true, maxLength: 40 }),
      currentQuantity: field("decimal4", { required: true }),
      comparisonQuantity: field("decimal4", { required: true }),
      currentNetRevenue: field("decimal4", { required: true, decisionGates: ["sales_currency"] }),
      comparisonNetRevenue: field("decimal4", { required: true, decisionGates: ["sales_currency"] }),
      currentGrossMargin: field("decimal4", { required: true, dataClass: "margin", decisionGates: ["sales_currency", "margin_semantics"] }),
      comparisonGrossMargin: field("decimal4", { required: true, dataClass: "margin", decisionGates: ["sales_currency", "margin_semantics"] }),
      currentCustomerCount: field("decimal4", { required: true }),
      comparisonCustomerCount: field("decimal4", { required: true }),
      currentRevenuePerCustomer: field("decimal4", { decisionGates: ["sales_currency"] }),
      comparisonRevenuePerCustomer: field("decimal4", { decisionGates: ["sales_currency"] }),
      sourcePage: field("safe_integer", { required: true, dataClass: "internal" }),
      sourceOrdinate: field("decimal4", { required: true, dataClass: "internal" }),
    },
  },
  sales_report_total_metric: {
    id: "sales_report_total_metric",
    importable: true,
    packageId: "aggregated_sales_report",
    purpose: "Gedruckte Berichtssumme zur getrennten Anzeige und Abstimmung",
    recordKey: "sourceKey",
    decisionGates: ["sales_currency", "margin_semantics"],
    fields: {
      sourceKey: field("sha256", { required: true, dataClass: "internal" }),
      reportSourceKey: field("sha256", { required: true, dataClass: "internal" }),
      horizon: field("identifier", { required: true, maxLength: 40 }),
      currentQuantity: field("decimal4", { required: true }),
      comparisonQuantity: field("decimal4", { required: true }),
      currentNetRevenue: field("decimal4", { required: true, decisionGates: ["sales_currency"] }),
      comparisonNetRevenue: field("decimal4", { required: true, decisionGates: ["sales_currency"] }),
      currentGrossMargin: field("decimal4", { required: true, dataClass: "margin", decisionGates: ["sales_currency", "margin_semantics"] }),
      comparisonGrossMargin: field("decimal4", { required: true, dataClass: "margin", decisionGates: ["sales_currency", "margin_semantics"] }),
      currentCustomerCount: field("decimal4", { required: true }),
      comparisonCustomerCount: field("decimal4", { required: true }),
      currentRevenuePerCustomer: field("decimal4", { decisionGates: ["sales_currency"] }),
      comparisonRevenuePerCustomer: field("decimal4", { decisionGates: ["sales_currency"] }),
      sourcePage: field("safe_integer", { required: true, dataClass: "internal" }),
    },
  },
  sales_receipt: {
    id: "sales_receipt",
    importable: true,
    packageId: "historical_sales",
    purpose: "Personenfreier historischer Belegkopf",
    recordKey: "sourceKey",
    decisionGates: ["branch_mapping"],
    fields: {
      sourceKey: field("sha256", { required: true, dataClass: "internal" }),
      locationId: field("identifier", { required: true, dataClass: "internal", maxLength: 80 }),
      registerId: field("identifier", { required: true, maxLength: 80 }),
      saleDate: field("date", { required: true }),
      saleTime: field("time"),
      sourceHeaderAmount: field("decimal4", {
        dataClass: "review",
        persistence: "staging_only",
        decisionGates: ["sales_currency", "sales_price_basis"],
      }),
    },
  },
  sales_line: {
    id: "sales_line",
    importable: true,
    packageId: "historical_sales",
    purpose: "Historische Verkaufsposition ohne Kunden- oder Verkäuferbezug",
    recordKey: "sourceKey",
    decisionGates: [
      "sales_currency",
      "sales_price_basis",
      "return_storno_semantics",
      "tax_mapping",
    ],
    fields: {
      sourceKey: field("sha256", { required: true, dataClass: "internal" }),
      receiptSourceKey: field("sha256", { required: true, dataClass: "internal" }),
      ean: field("identifier", { required: true, maxLength: 40 }),
      quantity: field("decimal4", { required: true, decisionGates: ["return_storno_semantics"] }),
      targetUnitPrice: field("decimal4", { decisionGates: ["sales_currency", "sales_price_basis"] }),
      actualUnitPrice: field("decimal4", { required: true, decisionGates: ["sales_currency", "sales_price_basis"] }),
      taxRate: field("decimal4", { required: true, decisionGates: ["tax_mapping"] }),
      discountRaw: field("decimal4", {
        persistence: "staging_only",
        dataClass: "review",
        decisionGates: ["sales_currency", "sales_price_basis"],
      }),
      grossMarginRaw: field("decimal4", {
        persistence: "staging_only",
        dataClass: "margin",
        decisionGates: ["sales_currency", "margin_semantics"],
      }),
      historicalArticleName: field("text", { maxLength: 240 }),
      historicalBrand: field("text", { maxLength: 160 }),
      historicalAssortment: field("text", { maxLength: 160 }),
      sourceStatusRaw: field("text", {
        persistence: "staging_only",
        dataClass: "review",
        maxLength: 160,
        decisionGates: ["return_storno_semantics"],
      }),
    },
  },
  product_snapshot: {
    id: "product_snapshot",
    importable: true,
    packageId: "product_snapshot",
    purpose: "Zeitpunktbezogener Artikelstamm ohne Rückwirkung auf historische Belege",
    recordKey: "sourceKey",
    decisionGates: ["snapshot_policy", "tax_mapping"],
    fields: {
      sourceKey: field("sha256", { required: true, dataClass: "internal" }),
      ean: field("identifier", { required: true, maxLength: 40 }),
      snapshotAt: field("utc_timestamp", { required: true, dataClass: "internal" }),
      articleName: field("text", { required: true, maxLength: 240 }),
      brand: field("text", { maxLength: 160 }),
      assortment: field("text", { maxLength: 160 }),
      productGroup: field("text", { maxLength: 160 }),
      division: field("text", { maxLength: 160 }),
      internetEnabled: field("boolean"),
      internetName: field("text", { maxLength: 240 }),
      discontinued: field("boolean"),
      specialItem: field("boolean"),
      salesPrice: field("decimal4", { decisionGates: ["sales_currency", "sales_price_basis"] }),
      internetPrice: field("decimal4", { decisionGates: ["sales_currency", "sales_price_basis"] }),
      taxRate: field("decimal4", { decisionGates: ["tax_mapping"] }),
    },
  },
  ean_alias: {
    id: "ean_alias",
    importable: true,
    packageId: "product_taxonomy",
    purpose: "Nachvollziehbare alternative EAN-Zuordnung",
    recordKey: "sourceKey",
    decisionGates: ["snapshot_policy"],
    fields: {
      sourceKey: field("sha256", { required: true, dataClass: "internal" }),
      primaryEan: field("identifier", { required: true, maxLength: 40 }),
      alternateEan: field("identifier", { required: true, maxLength: 40 }),
      rank: field("safe_integer"),
      snapshotAt: field("utc_timestamp", { required: true, dataClass: "internal" }),
    },
  },
  taxonomy_member: {
    id: "taxonomy_member",
    importable: true,
    packageId: "product_taxonomy",
    purpose: "Sortiment-, Warengruppen-, Sparten- oder Markenbegriff",
    recordKey: "sourceKey",
    decisionGates: ["snapshot_policy"],
    fields: {
      sourceKey: field("sha256", { required: true, dataClass: "internal" }),
      taxonomyKind: field("identifier", { required: true, maxLength: 40 }),
      externalId: field("identifier", { required: true, maxLength: 80 }),
      label: field("text", { required: true, maxLength: 240 }),
      parentExternalId: field("identifier", { maxLength: 80 }),
      snapshotAt: field("utc_timestamp", { required: true, dataClass: "internal" }),
    },
  },
  inventory_snapshot: {
    id: "inventory_snapshot",
    importable: true,
    packageId: "inventory_snapshot",
    purpose: "Zeitpunktbezogener Filialbestand, keine erfundene Bestandshistorie",
    recordKey: "sourceKey",
    decisionGates: ["branch_mapping", "snapshot_policy"],
    fields: {
      sourceKey: field("sha256", { required: true, dataClass: "internal" }),
      ean: field("identifier", { required: true, maxLength: 40 }),
      locationId: field("identifier", { required: true, dataClass: "internal", maxLength: 80 }),
      snapshotAt: field("utc_timestamp", { required: true, dataClass: "internal" }),
      onHand: field("decimal4", { required: true, dataClass: "inventory" }),
      ordered: field("decimal4", { dataClass: "inventory" }),
      inbound: field("decimal4", { dataClass: "inventory" }),
      branchPrice: field("decimal4", {
        dataClass: "inventory",
        decisionGates: ["sales_currency", "sales_price_basis"],
      }),
      inventoryDate: field("date", { dataClass: "inventory" }),
      stockChangedDate: field("date", { dataClass: "inventory" }),
    },
  },
  shop_product_mapping: {
    id: "shop_product_mapping",
    importable: true,
    packageId: "shop_product_mapping",
    purpose: "Technische Produktzuordnung ohne Bestellung, Kunde oder Umsatz",
    recordKey: "sourceKey",
    decisionGates: ["snapshot_policy"],
    fields: {
      sourceKey: field("sha256", { required: true, dataClass: "internal" }),
      ean: field("identifier", { required: true, maxLength: 40 }),
      shopArticleId: field("identifier", { required: true, maxLength: 120 }),
      shopVariantId: field("identifier", { maxLength: 120 }),
      snapshotAt: field("utc_timestamp", { required: true, dataClass: "internal" }),
    },
  },
});

const SALES_ANALYTICS_IMPORT_PACKAGES = deepFreeze({
  aggregated_sales_report: {
    id: "aggregated_sales_report",
    entityIds: [
      "aggregated_sales_report",
      "sales_product_group_report_metric",
      "sales_report_total_metric",
    ],
  },
  historical_sales: {
    id: "historical_sales",
    entityIds: ["sales_receipt", "sales_line"],
  },
  product_snapshot: {
    id: "product_snapshot",
    entityIds: ["product_snapshot"],
  },
  inventory_snapshot: {
    id: "inventory_snapshot",
    entityIds: ["inventory_snapshot"],
  },
  product_taxonomy: {
    id: "product_taxonomy",
    entityIds: ["ean_alias", "taxonomy_member"],
  },
  shop_product_mapping: {
    id: "shop_product_mapping",
    entityIds: ["shop_product_mapping"],
  },
});

const SALES_ANALYTICS_MODEL = deepFreeze({
  version: SALES_ANALYTICS_MODEL_VERSION,
  businessTimeZone: "Europe/Vienna",
  decimalScale: 4,
  identifiersRemainText: true,
  entities: SALES_ANALYTICS_ENTITIES,
  importPackages: SALES_ANALYTICS_IMPORT_PACKAGES,
  decisionGates: SALES_ANALYTICS_DECISION_GATES,
});

function salesAnalyticsEntity(entityId) {
  const id = String(entityId || "");
  return Object.hasOwn(SALES_ANALYTICS_ENTITIES, id) ? SALES_ANALYTICS_ENTITIES[id] : null;
}

function salesAnalyticsField(entityId, fieldId) {
  const entity = salesAnalyticsEntity(entityId);
  const id = String(fieldId || "");
  return entity && Object.hasOwn(entity.fields, id) ? entity.fields[id] : null;
}

module.exports = {
  SALES_ANALYTICS_MODEL_VERSION,
  SALES_ANALYTICS_MODEL,
  SALES_ANALYTICS_ENTITIES,
  SALES_ANALYTICS_IMPORT_PACKAGES,
  SALES_ANALYTICS_DECISION_GATES,
  salesAnalyticsEntity,
  salesAnalyticsField,
};
