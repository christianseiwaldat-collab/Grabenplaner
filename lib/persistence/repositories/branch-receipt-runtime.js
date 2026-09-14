"use strict";

const C = require("../../data-import-contract");
const { loadManagedDataImportProtection } = require("../../data-import-managed-protection");
const { BRANCH_RECEIPTS_PERMISSION, branchSalesContext, branchSalesIdentity, branchReceiptProjection } = require("../../branch-sales-access");
const { createCashPublications } = require("./cash-publications");
const { createCashHistoryBackend } = require("./cash-history-backend");
const { createReceiptWorkspace } = require("./receipt-workspace");
const { createReceiptResultStore } = require("../../receipt-result-store");
const { createReceiptSummaryStore } = require("../../receipt-summary-store");

// Read the same published, encrypted cash data through the existing repository
// contract. Organization accounts never enter personal report workers or CRM.
function createBranchReceiptRuntime({ access, vault, scopeId = "grabenplaner-main",
  today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vienna" }).format(new Date()),
  now, cashBackendFactory = createCashHistoryBackend, dispatchRead = null }) {
  const resultStore = createReceiptResultStore(), summaryStore = createReceiptSummaryStore();
  const Branch = require('../../branch-receipt-search');
  const Filters = require('../../../public/branch-receipt-filters');
  const inventories = new Map();
  let active = 0;
  return Object.freeze({ async run(getSession, work) {
    let session = await getSession();
    const identity = branchSalesIdentity(session, BRANCH_RECEIPTS_PERMISSION);
    const context = branchSalesContext(session, BRANCH_RECEIPTS_PERMISSION);
    const refresh = async () => {
      session = await getSession();
      if (branchSalesIdentity(session, BRANCH_RECEIPTS_PERMISSION) !== identity) C.fail("IMPORT_FORBIDDEN", 403);
    };
    if (active >= 3) C.fail("IMPORT_RECEIPT_SEARCH_BUSY", 503);
    active++;
    let protection;
    try {
      protection = await loadManagedDataImportProtection({ access, vault, create: false });
      await refresh();
      let workspace = null;
      if (protection) {
        const publications = createCashPublications({ access, protection, scopeId });
        const publication = await access.transaction(tx => publications.active(tx), { isolation: "serializable", readOnly: true });
        if (publication) {
          const key = publication.row.id;
          if (!inventories.has(key)) {
            if (inventories.size >= 2) inventories.delete(inventories.keys().next().value);
            const pending = Branch.inventory({ access, publication, publications });
            inventories.set(key, pending);
            pending.catch(() => { if (inventories.get(key) === pending) inventories.delete(key); });
          }
          const choices = await Branch.options({ access, publication, publications, context, metadata: await inventories.get(key) });
          const backend = Branch.backendFor({ base: cashBackendFactory({ publication, publications, scopeId }), publication, publications, choices });
          const sourceRevision = protection.digest([backend.source, backend.policy, publication.dataset.row.revision]);
          const receipts = dispatchRead ? Object.freeze(Object.fromEntries(["search", "documents"].map(operation => [operation, async query => {
            await refresh();
            // Only this verified internal principal crosses the worker boundary;
            // HTTP callers cannot supply permissions, an account or a location.
            const principal = { id: session.id, sessionKind: "organization", isEmployee: false, accountType: "branch",
              accountId: context.accountId, employeeNumber: null, permissions: [BRANCH_RECEIPTS_PERMISSION], scopes: [{ locationId: context.locationId }] };
            const result = await dispatchRead({ operation: "branch-receipt-" + operation, query, session: principal, sourceRevision });
            await refresh();
            return result;
          }]))) : createReceiptWorkspace({ access, protection, backend, getSession: () => session,
            getActor: () => ({ scopeId, ownerId: C.id("account:" + context.accountId) }), today, now,
            resultStore, summaryStore, projectionFor: session => branchReceiptProjection(session, choices), queryFor: Branch.query,
            sourceCustomer: Branch.customerReader({ protection, scopeId }) });
          workspace = Object.freeze({ receipts, sourceRevision, context: () => ({ available: true, today: today(),
            sourceId: backend.source.id, sourceLabel: backend.source.label, coverageLabel: backend.source.coverageLabel,
            location: { id: context.locationId, name: publication.data.locations.find(l => l.id === context.locationId)?.label || context.locationId },
            locations: choices.list.map(({ id, label }) => ({ id, label })), defaultLocationIds: choices.defaultIds,
            locationGroups: { stock: Filters.STOCK, internet: Filters.INTERNET } }) });
        }
      }
      const result = await work(workspace);
      await refresh();
      return result;
    } finally { protection?.destroy(); active--; }
  } });
}

module.exports = { createBranchReceiptRuntime };
