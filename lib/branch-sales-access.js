"use strict";

const BRANCH_ARTICLES_PERMISSION = "branch_articles:read";
const BRANCH_RECEIPTS_PERMISSION = "branch_receipts:read";

function branchSalesContext(session, permission) {
  if (![BRANCH_ARTICLES_PERMISSION, BRANCH_RECEIPTS_PERMISSION].includes(permission)
    || !session || session.sessionKind !== "organization" || session.accountType !== "branch"
    || session.isEmployee !== false || !session.accountId || session.mustChangePassword
    || !session.permissions?.includes(permission)) {
    throw Object.assign(new Error("Diese Suche ist für das Filialkonto nicht freigeschaltet."),
      { code: "BRANCH_SALES_DISABLED", status: 403 });
  }
  const scopes = Array.isArray(session.scopes) ? session.scopes : [];
  if (scopes.length !== 1 || !scopes[0]?.locationId || scopes[0].departmentId) {
    throw Object.assign(new Error("Für diese Suche muss dem Filialkonto genau eine Filiale zugewiesen sein."),
      { code: "BRANCH_SALES_SCOPE_DENIED", status: 403 });
  }
  return { accountId: session.accountId, locationId: String(scopes[0].locationId), sessionId: session.id };
}

function branchSalesIdentity(session, permission) {
  const context = branchSalesContext(session, permission);
  return JSON.stringify([context.accountId, context.sessionId, context.locationId, permission]);
}

// Internal composition contracts. They never grant the personal sales workspace
// or impersonate an employee, and are never accepted from HTTP input.
const branchArticleProjection = Object.freeze({
  workspace: true, read: true, pricesRead: true, costsRead: false, write: false, import: false,
});
function branchReceiptProjection(session, choices = null) {
  const { locationId } = branchSalesContext(session, BRANCH_RECEIPTS_PERMISSION);
  return Object.freeze({ read: true, sellers: true, customerPurchases: true,
    finance: false, unassigned: false, company: false, locationIds: Object.freeze(choices ? choices.list.map(l => l.id) : [locationId]),
    ...(choices ? { receiptSourceIds: choices.list.map(l => l.id), receiptDefaultIds: choices.defaultIds } : {}) });
}

module.exports = { BRANCH_ARTICLES_PERMISSION, BRANCH_RECEIPTS_PERMISSION,
  branchSalesContext, branchSalesIdentity, branchArticleProjection, branchReceiptProjection };
