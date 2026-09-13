"use strict";

const C = require("./data-import-contract");
const { normalizeSalesArticleSearch, SalesArticleCatalogError } = require("./sales-article-catalog");
const { createReceiptInfoPdf } = require("./receipt-info-pdf");
const { BRANCH_ARTICLES_PERMISSION: ARTICLES, BRANCH_RECEIPTS_PERMISSION: RECEIPTS,
  branchSalesContext, branchSalesIdentity, branchArticleProjection } = require("./branch-sales-access");

function registerBranchSalesRoutes(app, { catalog, receipts, requireSession, refreshSession, assertCsrf }) {
  const route = (permission, work, pdf = false) => async (request, response) => {
    response.set({ "Cache-Control": "private, no-store", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" });
    try {
      const session = requireSession(request, permission);
      const context = branchSalesContext(session, permission), identity = branchSalesIdentity(session, permission);
      if (request.method !== "GET") assertCsrf(request);
      const fresh = async () => {
        const current = await refreshSession(request);
        if (branchSalesIdentity(current, permission) !== identity) C.fail("IMPORT_FORBIDDEN", 403);
        return current;
      };
      await fresh();
      const result = await work({ request, context, fresh });
      await fresh();
      if (pdf) response.type("application/pdf").attachment("Beleginformation-keine-Rechnung.pdf").send(result);
      else response.json(result);
    } catch (error) {
      const status = error.code === "IMPORT_FORBIDDEN" ? 403
        : error.code === "IMPORT_HISTORY_RESULTS_CHANGED" ? 409
          : error instanceof SalesArticleCatalogError ? 400 : error.status >= 400 && error.status < 600 ? error.status : 500;
      const messages = {
        IMPORT_HISTORY_NOT_ACTIVATED: "Ein freigegebener Kassenstand ist noch nicht verfügbar.",
        IMPORT_HISTORY_DATE_RANGE: "Bitte einen gültigen Zeitraum bis heute wählen.",
        IMPORT_HISTORY_RESULTS_CHANGED: "Der Datenstand oder die Suche hat sich geändert. Bitte erneut suchen.",
        IMPORT_HISTORY_CURSOR: "Die Suche ist abgelaufen. Bitte erneut suchen.",
        IMPORT_RECEIPT_QUERY: "Bitte höchstens zehn Suchbegriffe eingeben.",
        IMPORT_RECEIPT_SELECTION: "Bitte einen Beleg auswählen.",
        IMPORT_RECEIPT_EXPORT_LIMIT: "Dieser Beleg ist für den PDF-Download zu umfangreich.",
        IMPORT_RECEIPT_SEARCH_BUSY: "Die Belegsuche ist gerade ausgelastet. Bitte kurz warten und erneut versuchen.",
        IMPORT_HISTORY_ANALYSIS_BUSY: "Die Belegsuche ist gerade ausgelastet. Bitte kurz warten und erneut versuchen.",
        IMPORT_REPORT_WORKER_TIMEOUT: "Die Suche hat zu lange gedauert. Bitte den Zeitraum eingrenzen und erneut suchen.",
      };
      response.status(status).json({ code: status === 500 ? "BRANCH_SALES_FAILED" : error.code || "BRANCH_SALES_INVALID",
        error: status === 403 ? "Die Suche oder dieser Beleg ist für das Filialkonto nicht freigegeben."
          : status === 401 ? "Bitte erneut anmelden."
            : messages[error.code] || (error instanceof SalesArticleCatalogError ? error.message
              : status === 400 ? "Bitte die Suchangaben prüfen." : "Die Daten konnten nicht gelesen werden. Bitte erneut versuchen.") });
    }
  };
  const base = "/api/portal/v1";
  app.get(base + "/branch-articles", route(ARTICLES, async ({ request }) => {
    C.exact(request.query, ["query", "identifier", "status", "offset"]);
    const search = normalizeSalesArticleSearch({ ...request.query, limit: 20, sort: "articleNumber", direction: "asc" });
    const result = await catalog.search({ query: search.query, identifier: search.identifier, status: search.status,
      offset: search.offset, limit: search.limit, sort: search.sort, direction: search.direction }, branchArticleProjection);
    // Explicit public fields also protect against future additions to the shared repository.
    return { ...result, items: result.items.map(row => ({ articleNumber: row.articleNumber, description: row.description,
      primaryIdentifier: row.primaryIdentifier, active: row.active, retailGross: row.retailGross, internetGross: row.internetGross })) };
  }));
  const receiptWork = (work, pdf = false) => route(RECEIPTS, ({ request, context, fresh }) => receipts.run(fresh, async workspace => {
    if (!workspace?.receipts && !request.path.endsWith("/context")) C.fail("IMPORT_HISTORY_NOT_ACTIVATED", 503);
    return work({ request, context, workspace });
  }), pdf);
  app.get(base + "/branch-receipts/context", receiptWork(({ request, workspace }) => {
    C.exact(request.query, []);
    return workspace?.context() || { available: false };
  }));
  app.post(base + "/branch-receipts/search", receiptWork(({ request, context, workspace }) => {
    C.exact(request.body, ["dateFrom", "dateTo", "query", "receipt", "cursor"]);
    return workspace.receipts.search({ ...request.body, sourceId: "compact-cash", kind: "receipts",
      locationId: context.locationId, sort: "date", direction: "desc", limit: 20 });
  }));
  const selection = request => {
    C.exact(request.body, ["ids"]);
    if (!Array.isArray(request.body.ids) || request.body.ids.length !== 1) C.fail("IMPORT_RECEIPT_SELECTION");
    return { ids: request.body.ids };
  };
  app.post(base + "/branch-receipts/documents", receiptWork(({ request, workspace }) => workspace.receipts.documents(selection(request))));
  app.post(base + "/branch-receipts/export.pdf", receiptWork(async ({ request, workspace }) =>
    createReceiptInfoPdf(await workspace.receipts.documents(selection(request))), true));
}

module.exports = { registerBranchSalesRoutes };
