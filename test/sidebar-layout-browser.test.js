"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { root, read, functionSource, screenshotDirectory } = require("../test-support/learning-workspace-ui");
const options = { skip: process.env.GP_WINDOW_BROWSER_TEST !== "1", timeout: 90000 };
const app = read("app.js");
const names = ["navigationGroups", "setNavigationCurrent", "applyNavigationGroupState", "renderContextNavigation", "pageViewElement", "setView", "applyRequestedView", "currentAdministrationRoute", "mobileNavigationFocusableElements", "openMobileNavigation", "closeMobileNavigation"];
const top = app.slice(app.indexOf("const sidebarNavigationGroups"), app.indexOf("let sidebarLayout"));
function handler(start, end) {
  const from = app.indexOf(start), to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return app.slice(from, to);
}
const events = handler('document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener', 'document.getElementById("salesAnalyticsTabs")')
  + handler('document.querySelector(".main-nav").addEventListener("click",', 'document.querySelectorAll("[data-close]")');
const source = top + "\n" + names.map(name => functionSource(name)).join("\n") + "\n" + events + "\nwindow.sidebarGroupsForTest=()=>sidebarNavigationGroups;";

// Real shell markup and real routing/disclosure handlers; workspace loading is
// stubbed so this focused test never reads or writes a business database.
async function fixture({ mobile = false } = {}) {
  const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}), args: ["--no-first-run"] });
  const page = await browser.newPage(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(7000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}/`;
  await page.route("**/*", route => route.request().resourceType() === "document" && route.request().url().startsWith(url) ? route.continue() : route.abort());
  async function load(route = "?view=startDashboard") {
    await page.goto(url + route);
    await page.addStyleTag({ path: path.join(root, "public", "styles.css") });
    for (const name of ["sidebar-layout.js", "navigation-history.js"]) await page.addScriptTag({ path: path.join(root, "public", name) });
    await page.evaluate(({ source }) => {
      window.elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
      window.state = { currentView: "startDashboard", portalStatus: { portalEnabled: true },
        portalSession: { authenticated: true, user: { employeeNumber: "BEISPIEL-A", accountId: "A", role: "developer", salesHistory: { read: true } } },
        personnelAdministrationTab: "dashboard", personnelTab: "employees", requestKindTab: "vacation", locationId: "18", departmentId: "", salesAnalytics: { tab: "create" }, salesArticleCatalog: {}, crm: {} };
      window.locationsForTest = [{ id: "18", name: "Beispiel Nord" }, { id: "23", name: "Beispiel Süd" }];
      window.activeLocations = () => locationsForTest;
      window.escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
      window.logisticsTab = "purchasing"; window.privacyOrganizationTab = "overview"; window.tradeInsightsTab = "repairs";
      window.mobileNavigationMedia = matchMedia("(max-width: 820px), (max-width: 1100px) and (pointer: coarse)");
      window.mobileNavigationPreviousFocus = null; window.timePresenceRefreshTimer = null;
      for (const name of ["receiptSearchWorkspace", "salesArticleReportWorkspace", "salesBwlWorkspace", "gpDefinitionsWorkspace", "tradeInsightsWorkspace", "tradeOrdersWorkspace", "salesPriceLabelsWorkspace"]) window[name] = null;
      window.denied = new Set();
      for (const name of ["canReadManagerRequests", "canReadManagedTimeTracking", "canOpenPersonnelAdministrationModule", "canAccessTeamManagement", "canOpenSalesAdministrationModule", "canAccessSalesAnalytics", "canAccessSalesArticleCatalog", "canReadSalesArticleReport", "canReadSalesBwl", "canUseGpDefinitions", "canUseSalesPriceLabels", "canAccessCrm", "canAccessTradeInsights", "canReadTradeMovements", "canReadLoanManagement", "canManageBranchOrders", "canAccessPrivacyOrganization", "canOpenPrivacyOrganizationTab", "canReadSystemCenter"]) window[name] = () => !denied.has(name);
      for (const name of ["clearUsbProvisioningPasswords", "pausePersonnelLifecycleEditor", "pauseEmployeeProfile", "resumeEmployeeProfile", "clearPersonnelLifecycleAutomationState", "applyActivePageAppearance", "syncSalesArticleSearchWindow", "syncGpWindows", "syncStartDashboardVps", "loadStartDashboard", "loadRightsDashboard", "ensureAccessibleManagerRequestTab", "loadManagerVacationRequests", "loadLoanManagement", "loadBranchOrdersManagement", "renderSalesArticleCatalogResults", "loadSalesArticleCatalogDetail", "syncCrmCustomerWorkspace", "activatePrivacyOrganizationView", "activateTradeArea", "activateSalesArticleReport", "activateSalesBwl", "activateGpDefinitions", "renderGpDefinitionsAccess", "loadPlanningView", "refreshTimeTrackingView", "initializeTimeSummaryDates", "initializeTimeReviewDate"]) window[name] = () => {};
      for (const name of ["loadSalesArticleTablePreferences", "loadSalesArticleLastImport", "loadCrmPreferences"]) window[name] = async () => {};
      window.restoreRememberedOverallContext = window.planningContextNeedsReload = window.employeeProfileIsOpen = () => false;
      window.accessibleDashboardModes = () => ["rights"];
      window.normalizePrivacyOrganizationTab = tab => tab; window.firstAccessiblePrivacyOrganizationTab = () => "overview";
      window.GrabenplanerTradeInsights = { normalizeTab: tab => tab };
      window.setPersonnelAdministrationTab = tab => { state.personnelAdministrationTab = tab; };
      window.setPersonnelTab = tab => { state.personnelTab = tab; };
      window.setSalesAnalyticsTab = tab => { state.salesAnalytics.tab = tab; };
      window.setRightsDashboardMode = mode => { state.rightsDashboardMode = mode; };
      window.setSettingsTab = () => {};
      window.rememberOverallContext = () => {};
      window.setDefaultContext = () => {};
      window.functionSearchSettingsTabButton = () => null;
      document.querySelectorAll(".main-nav .hidden").forEach(node => node.classList.remove("hidden"));
      elements.loginGate.classList.add("hidden");
      (0, eval)(source);
      window.grabenplanerNavigation = GrabenplanerNavigationHistory.create({ window, app: "admin", keys: ["view", "section", "kind", "dashboard", "process", "location", "department"], read: currentAdministrationRoute, apply: () => applyRequestedView({ fromHistory: true }) });
      applyRequestedView({ loadContext: false }); grabenplanerNavigation.start();
      window.layoutForTest = GrabenplanerSidebarLayout.mount({ window, document, sidebar: elements.mainSidebar, handle: elements.sidebarResizeHandle, mobileMedia: mobileNavigationMedia });
      if (mobileNavigationMedia.matches) closeMobileNavigation({ restoreFocus: false });
    }, { source });
  }
  async function click(selector) {
    if (mobile) await page.evaluate(() => openMobileNavigation());
    if (mobile) await page.locator(selector).tap(); else await page.locator(selector).click();
    await page.waitForTimeout(10);
  }
  return { page, errors, load, click, async close() { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
}
async function current(page, selector) {
  assert.equal(await page.locator('.main-nav [aria-current="page"]').count(), 1);
  assert.equal(await page.locator(selector).getAttribute("aria-current"), "page");
}

test("Sidebar desktop: Verkauf, all module leaves, direct entry, history and per-account manual disclosures", options, async () => {
  const f = await fixture();
  try {
    await f.load("?view=articleReport");
    await current(f.page, "#salesArticleReportNavButton");
    assert.equal(await f.page.locator("#salesAdministrationToggle").getAttribute("aria-expanded"), "true");
    for (const selector of ["#salesBwlNavButton", "#salesArticleCatalogNavButton", "#salesArticleReportNavButton"]) {
      await f.click(selector); await current(f.page, selector);
      assert.equal(await f.page.locator("#salesAdministrationNavChildren").isVisible(), true);
    }
    await f.page.goBack(); await current(f.page, "#salesArticleCatalogNavButton");
    await f.page.goForward(); await current(f.page, "#salesArticleReportNavButton");
    await f.click("#personnelAdministrationToggle");
    await f.click("#salesBwlNavButton");
    assert.equal(await f.page.locator("#personnelAdministrationNavChildren").isVisible(), true);
    assert.equal(await f.page.locator("#salesBwlNavButton").textContent(), "▤BWL-Tools");
    await f.click("#salesAdministrationToggle");
    await f.page.evaluate(() => renderContextNavigation());
    assert.equal(await f.page.locator("#salesAdministrationNavChildren").isVisible(), false);
    await f.load("?view=articleReport");
    assert.equal(await f.page.locator("#personnelAdministrationNavChildren").isVisible(), true);
    assert.equal(await f.page.locator("#salesAdministrationNavChildren").isVisible(), true);
    const routes = await f.page.locator('.main-nav .nav-item[data-view]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, view: node.dataset.view })));
    for (const route of routes) {
      // Reach the existing child through its disclosure, then use the real click.
      await f.page.evaluate(id => {
        const node = document.getElementById(id);
        for (const [key, group] of Object.entries(navigationGroups())) if (group.children?.contains(node)) sidebarGroupsForTest().setOpen(key, true);
        renderContextNavigation();
      }, route.id);
      await f.click("#" + route.id);
      if (route.view === "logistics") await current(f.page, route.id === "logisticsOrdersNavButton" ? "#logisticsOrdersNavButton" : "#logisticsPurchasingNavButton");
      else if (route.id === "privacyOrganizationNavButton") await current(f.page, "#privacyOrganizationOverviewNavButton");
      else if (route.view === "planning") await current(f.page, '.nav-child[data-context-view="planning"][data-location-id="18"]');
      else if (route.view === "vacations") await current(f.page, '.nav-child[data-context-view="vacations"][data-location-id="18"]');
      else await current(f.page, "#" + route.id);
      assert.equal(await f.page.evaluate(() => sidebarGroupsForTest().navigationPath(state.currentView).every(key => sidebarGroupsForTest().isOpen(key))), true);
    }
    await f.page.evaluate(() => { state.portalSession.user = { employeeNumber: "BEISPIEL-B", accountId: "B" }; setView("startDashboard"); });
    for (const selector of ["#salesAdministrationNavChildren", "#personnelAdministrationNavChildren", "#logisticsNavChildren"]) assert.equal(await f.page.locator(selector).isVisible(), false);
    await f.page.evaluate(() => { denied.add("canReadSalesArticleReport"); setView("articleReport"); });
    await current(f.page, "#startDashboardNavButton");
    assert.equal(await f.page.locator("#salesAdministrationNavChildren").isVisible(), false);
    assert.deepEqual(f.errors, []);
    await f.page.screenshot({ path: path.join(screenshotDirectory(), "sidebar-desktop.png") });
  } finally { await f.close(); }
});

test("Sidebar 390px touch: route selection closes only the mobile drawer and keeps its active ancestor", options, async () => {
  const f = await fixture({ mobile: true });
  try {
    await f.load("?view=articleReport");
    await f.click("#salesBwlNavButton"); await current(f.page, "#salesBwlNavButton");
    assert.equal(await f.page.evaluate(() => document.body.classList.contains("mobile-navigation-open")), false);
    await f.page.evaluate(() => openMobileNavigation());
    assert.equal(await f.page.locator("#salesAdministrationNavChildren").isVisible(), true);
    await f.click("#salesArticleReportNavButton"); await current(f.page, "#salesArticleReportNavButton");
    await f.page.goBack(); await current(f.page, "#salesBwlNavButton");
    await f.page.evaluate(() => openMobileNavigation());
    assert.equal(await f.page.locator("#salesAdministrationNavChildren").isVisible(), true);
    await f.page.locator("#salesAdministrationToggle").tap();
    await f.page.evaluate(() => renderContextNavigation());
    assert.equal(await f.page.locator("#salesAdministrationNavChildren").isVisible(), false);
    assert.deepEqual(f.errors, []);
    await f.page.screenshot({ path: path.join(screenshotDirectory(), "sidebar-mobile.png") });
  } finally { await f.close(); }
});
