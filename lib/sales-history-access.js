"use strict";
const { buildSalesAnalyticsProjection, SALES_ANALYTICS_PERMISSIONS: A } = require('./sales-analytics-access');
const { buildCrmProjection, CRM_PERMISSIONS: C } = require('./crm-access');
const SALES_HISTORY_PERMISSIONS = Object.freeze({
  READ: 'sales:history:read', SELLERS: 'sales:history:sellers:read',
  CUSTOMER_PURCHASES: 'crm:purchases:read', FINANCE: 'sales:history:finance:read',
  UNASSIGNED: 'sales:history:unassigned:read',
});
function buildSalesHistoryProjection(session = {}) {
  session = session || {};
  const p = new Set(Array.isArray(session.permissions) ? session.permissions : []), sales = buildSalesAnalyticsProjection(session), crm = buildCrmProjection(session);
  const personal = session.isEmployee !== false && session.sessionKind !== 'organization' && !!session.employeeNumber && !session.mustChangePassword;
  const read = personal && sales.workspace && (sales.company || sales.locationIds.length > 0) && p.has(SALES_HISTORY_PERMISSIONS.READ);
  return Object.freeze({ read, sellers: read && p.has(SALES_HISTORY_PERMISSIONS.SELLERS),
    customerPurchases: read && crm.read && p.has(SALES_HISTORY_PERMISSIONS.CUSTOMER_PURCHASES),
    finance: read && p.has(SALES_HISTORY_PERMISSIONS.FINANCE), unassigned: read && sales.company && p.has(SALES_HISTORY_PERMISSIONS.UNASSIGNED),
    company: read && sales.company, locationIds: Object.freeze(read ? [...sales.locationIds] : []) });
}
function salesHistoryPermissionDependencies(permissions) {
  const p = new Set(permissions), missing = new Set(), H = SALES_HISTORY_PERMISSIONS;
  for (const permission of Object.values(H)) if (p.has(permission)) {
    if (!p.has(H.READ)) missing.add(H.READ);
    if (!p.has(A.ACCESS)) missing.add(A.ACCESS);
    if (!p.has(A.LOCATION_READ) && !p.has(A.COMPANY_READ)) missing.add(A.LOCATION_READ);
  }
  if (p.has(H.CUSTOMER_PURCHASES)) for (const permission of [C.ACCESS, C.CUSTOMERS_READ]) if (!p.has(permission)) missing.add(permission);
  if (p.has(H.UNASSIGNED) && !p.has(A.COMPANY_READ)) missing.add(A.COMPANY_READ);
  return { valid: missing.size === 0, missing: [...missing] };
}
const SALES_HISTORY_PERMISSION_CATALOG = Object.freeze([
  [SALES_HISTORY_PERMISSIONS.READ, 'Einzelverkäufe lesen', 'Geschützte Belegpositionen ausschließlich in freigegebenen Filialen; kein Kunden- oder Mitarbeiterzugriff.'],
  [SALES_HISTORY_PERMISSIONS.SELLERS, 'Verkäuferbezogene Verkaufsanalysen lesen', 'Positions- und Belegverkäufer getrennt nach bestätigter Personalzuordnung auswerten.'],
  [SALES_HISTORY_PERMISSIONS.CUSTOMER_PURCHASES, 'Kundenkäufe in der Kundenkartei lesen', 'Nur bestätigte CRM-Verknüpfungen und freigegebene Filialen; benötigt zusätzlich das CRM-Leserecht.'],
  [SALES_HISTORY_PERMISSIONS.FINANCE, 'Kassenjournal und Tagesberichte lesen', 'Finanzhistorie getrennt von Einzelverkäufen und nur innerhalb freigegebener Filialen lesen.'],
  [SALES_HISTORY_PERMISSIONS.UNASSIGNED, 'Historie ohne bestätigte Filialzuordnung lesen', 'Besonders geschützte Prüfansicht; benötigt zusätzlich das Gesamtfirmenrecht.'],
].map(([id, label, description]) => Object.freeze({ id, label, description, group: 'Verkaufsverwaltung', warningLevel: 'critical',
  eligibleRoles: Object.freeze(['manager', 'admin', 'developer']), scopeBehavior: id === SALES_HISTORY_PERMISSIONS.UNASSIGNED ? 'global' : 'organizational' })));
module.exports = { SALES_HISTORY_PERMISSIONS, SALES_HISTORY_PERMISSION_CATALOG, buildSalesHistoryProjection, salesHistoryPermissionDependencies };
