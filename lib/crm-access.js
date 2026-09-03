"use strict";

const CRM_PERMISSIONS = Object.freeze({
  ACCESS: "crm:access",
  CUSTOMERS_READ: "crm:customers:read",
  CUSTOMERS_WRITE: "crm:customers:write",
});

const CRM_PERMISSION_IDS = Object.freeze(Object.values(CRM_PERMISSIONS));

function normalizedPermissionSet(value) {
  return new Set(Array.isArray(value) ? value.map((entry) => String(entry || "")) : []);
}

function buildCrmProjection(session) {
  const permissions = normalizedPermissionSet(session?.permissions);
  const workspace = permissions.has(CRM_PERMISSIONS.ACCESS);
  const read = workspace && permissions.has(CRM_PERMISSIONS.CUSTOMERS_READ);
  const write = read && permissions.has(CRM_PERMISSIONS.CUSTOMERS_WRITE);
  return Object.freeze({ workspace, read, write });
}

function resolveCrmPermissionDependencies(value) {
  const permissions = normalizedPermissionSet(value);
  const missing = [];
  if (permissions.has(CRM_PERMISSIONS.CUSTOMERS_WRITE)
    && !permissions.has(CRM_PERMISSIONS.CUSTOMERS_READ)) {
    missing.push(CRM_PERMISSIONS.CUSTOMERS_READ);
  }
  if ((permissions.has(CRM_PERMISSIONS.CUSTOMERS_READ)
      || permissions.has(CRM_PERMISSIONS.CUSTOMERS_WRITE))
    && !permissions.has(CRM_PERMISSIONS.ACCESS)) {
    missing.push(CRM_PERMISSIONS.ACCESS);
  }
  return Object.freeze({
    valid: missing.length === 0,
    missing: Object.freeze([...new Set(missing)]),
  });
}

module.exports = {
  CRM_PERMISSIONS,
  CRM_PERMISSION_IDS,
  buildCrmProjection,
  resolveCrmPermissionDependencies,
};
