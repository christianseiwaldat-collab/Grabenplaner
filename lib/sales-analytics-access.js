"use strict";

const SALES_ANALYTICS_PERMISSIONS = Object.freeze({
  ACCESS: "sales:analytics:access",
  LOCATION_READ: "sales:analytics:location:read",
  COMPANY_READ: "sales:analytics:company:read",
  ONLINE_READ: "sales:analytics:online:read",
  INVENTORY_READ: "sales:analytics:inventory:read",
  MARGIN_READ: "sales:analytics:margin:read",
  IMPORT_MANAGE: "sales:analytics:imports:manage",
});

const SALES_ANALYTICS_PERMISSION_IDS = Object.freeze(
  Object.values(SALES_ANALYTICS_PERMISSIONS),
);

function fullLocationIds(scopes = []) {
  if (!Array.isArray(scopes)) return [];
  return [...new Set(scopes
    .filter((scope) => !Number(scope?.departmentId ?? scope?.department_id ?? 0))
    .map((scope) => String(scope?.locationId ?? scope?.location_id ?? "").trim())
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "de-AT"));
}

function buildSalesAnalyticsProjection(session = {}) {
  const permissions = new Set(
    Array.isArray(session?.permissions)
      ? session.permissions.filter((permission) => typeof permission === "string")
      : [],
  );
  const workspace = permissions.has(SALES_ANALYTICS_PERMISSIONS.ACCESS);
  if (!workspace) {
    return Object.freeze({
      workspace: false,
      locationMode: "none",
      locationIds: Object.freeze([]),
      company: false,
      onlineShop: false,
      inventory: false,
      grossMargin: false,
      importManagement: false,
      hasDataProjection: false,
    });
  }

  const company = permissions.has(SALES_ANALYTICS_PERMISSIONS.COMPANY_READ);
  const locationIds = company
    ? []
    : permissions.has(SALES_ANALYTICS_PERMISSIONS.LOCATION_READ)
      ? fullLocationIds(session.scopes)
      : [];
  const locationData = company || locationIds.length > 0;
  const onlineShop = permissions.has(SALES_ANALYTICS_PERMISSIONS.ONLINE_READ);

  const grossMargin = locationData && permissions.has(SALES_ANALYTICS_PERMISSIONS.MARGIN_READ);
  return Object.freeze({
    workspace: true,
    locationMode: company ? "company" : locationIds.length ? "scoped" : "none",
    locationIds: Object.freeze(locationIds),
    company,
    onlineShop,
    inventory: locationData && permissions.has(SALES_ANALYTICS_PERMISSIONS.INVENTORY_READ),
    grossMargin,
    importManagement: grossMargin
      && permissions.has(SALES_ANALYTICS_PERMISSIONS.IMPORT_MANAGE),
    hasDataProjection: locationData || onlineShop,
  });
}

module.exports = {
  SALES_ANALYTICS_PERMISSIONS,
  SALES_ANALYTICS_PERMISSION_IDS,
  buildSalesAnalyticsProjection,
};
