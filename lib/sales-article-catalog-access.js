"use strict";

const {
  SALES_ARTICLE_PRICE_TYPES,
} = require("./sales-article-catalog");

const SALES_ARTICLE_CATALOG_PERMISSIONS = Object.freeze({
  ACCESS: "sales:articles:access",
  READ: "sales:articles:read",
  PRICES_READ: "sales:articles:prices:read",
  COSTS_READ: "sales:articles:costs:read",
  WRITE: "sales:articles:write",
  IMPORT: "sales:articles:import",
});

const SALES_ARTICLE_CATALOG_PERMISSION_IDS = Object.freeze(
  Object.values(SALES_ARTICLE_CATALOG_PERMISSIONS),
);

const SALES_ARTICLE_PRICE_GROUPS = Object.freeze({
  PRICES: Object.freeze([
    "upe",
    "future_upe",
    "sales",
    "wholesale",
    "internet_1",
    "internet_2",
    "internet_3",
    "internet_4",
    "internet_5",
    "deposit",
  ]),
  COSTS: Object.freeze([
    "average_purchase",
    "list_purchase",
    "invoice_purchase",
    "net_net_purchase",
    "order_purchase",
    "future_purchase",
    "calculation",
    "zdek",
    "dek_a",
    "special",
    "other",
  ]),
});

const ARTICLE_PRICE_GROUP_BY_TYPE = new Map([
  ...SALES_ARTICLE_PRICE_GROUPS.PRICES.map((priceType) => [priceType, "prices"]),
  ...SALES_ARTICLE_PRICE_GROUPS.COSTS.map((priceType) => [priceType, "costs"]),
]);
const groupedPriceTypes = [...ARTICLE_PRICE_GROUP_BY_TYPE.keys()].sort();
const knownPriceTypes = [...SALES_ARTICLE_PRICE_TYPES].sort();
if (ARTICLE_PRICE_GROUP_BY_TYPE.size !== SALES_ARTICLE_PRICE_TYPES.length
  || groupedPriceTypes.some((priceType, index) => priceType !== knownPriceTypes[index])) {
  throw new Error("Die Artikelpreis-Rechteprojektion deckt den Preisartenkatalog nicht eindeutig ab.");
}

function normalizedPermissionSet(value) {
  return new Set(Array.isArray(value) ? value.map((entry) => String(entry || "")) : []);
}

function buildSalesArticleCatalogProjection(session = {}) {
  const permissions = normalizedPermissionSet(session.permissions);
  const workspace = permissions.has(SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS);
  const read = workspace && permissions.has(SALES_ARTICLE_CATALOG_PERMISSIONS.READ);
  return Object.freeze({
    workspace,
    read,
    pricesRead: read && permissions.has(SALES_ARTICLE_CATALOG_PERMISSIONS.PRICES_READ),
    costsRead: read && permissions.has(SALES_ARTICLE_CATALOG_PERMISSIONS.COSTS_READ),
    write: read && permissions.has(SALES_ARTICLE_CATALOG_PERMISSIONS.WRITE),
    import: read && permissions.has(SALES_ARTICLE_CATALOG_PERMISSIONS.IMPORT),
  });
}

function resolveSalesArticleCatalogPermissionDependencies(value) {
  const permissions = normalizedPermissionSet(value);
  const hasReadPermission = permissions.has(SALES_ARTICLE_CATALOG_PERMISSIONS.READ);
  const hasSpecializedReadPermission = permissions.has(
    SALES_ARTICLE_CATALOG_PERMISSIONS.PRICES_READ,
  ) || permissions.has(SALES_ARTICLE_CATALOG_PERMISSIONS.COSTS_READ);
  const hasWritePermission = permissions.has(SALES_ARTICLE_CATALOG_PERMISSIONS.WRITE);
  const hasImportPermission = permissions.has(SALES_ARTICLE_CATALOG_PERMISSIONS.IMPORT);
  const missing = [];
  if ((hasReadPermission || hasSpecializedReadPermission || hasWritePermission || hasImportPermission)
    && !permissions.has(SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS)) {
    missing.push(SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS);
  }
  if ((hasSpecializedReadPermission || hasWritePermission || hasImportPermission)
    && !hasReadPermission) {
    missing.push(SALES_ARTICLE_CATALOG_PERMISSIONS.READ);
  }
  return Object.freeze({
    valid: missing.length === 0,
    missing: Object.freeze(missing),
  });
}

function salesArticlePriceGroup(priceType) {
  return ARTICLE_PRICE_GROUP_BY_TYPE.get(String(priceType || "")) || null;
}

module.exports = {
  SALES_ARTICLE_CATALOG_PERMISSIONS,
  SALES_ARTICLE_CATALOG_PERMISSION_IDS,
  SALES_ARTICLE_PRICE_GROUPS,
  buildSalesArticleCatalogProjection,
  resolveSalesArticleCatalogPermissionDependencies,
  salesArticlePriceGroup,
};
