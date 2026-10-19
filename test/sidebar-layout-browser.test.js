"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { root, read, functionSource, screenshotDirectory } = require("../test-support/learning-workspace-ui");
const options = { skip: process.env.GP_WINDOW_BROWSER_TEST !== "1", timeout: 90000 };
const app = read("app.js");
const names = ["navigationGroups", "setNavigationCurrent", "applyNavigationGroupState", "renderContextNavigation", "pageViewElement", "setView", "applyRequestedView", "currentAdministrationRoute", "normalizeTechnicalSecurityTab", "mobileNavigationFocusableElements", "openMobileNavigation", "closeMobileNavigation"];
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
async function fixture({ mobile = false, width = mobile ? 390 : 1440 } = {}) {
  const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}), args: ["--no-first-run"] });
  const page = await browser.newPage(mobile ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width, height: 1000 } });
  page.setDefaultTimeout(7000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}/`;
  await page.route("**/*", route => route.request().resourceType() === "document" && route.request().url().startsWith(url) ? route.continue() : route.abort());
  async function load(route = "?view=startDashboard") {
    await page.goto(url + route);
    // Preserve the production cascade: mobile-refinements.css can override the
    // shared navigation grid, so a styles.css-only fixture misses real defects.
    for (const match of html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"]+)"[^>]*>/g)) {
      const file = match[1] === "vendor/quill/quill.snow.css"
        ? path.join(root, "node_modules", "quill", "dist", "quill.snow.css") : path.join(root, "public", match[1]);
      await page.addStyleTag({ path: file });
    }
    for (const name of ["sidebar-layout.js", "navigation-history.js"]) await page.addScriptTag({ path: path.join(root, "public", name) });
    await page.evaluate(({ source }) => {
      window.elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
      window.state = { currentView: "startDashboard", portalStatus: { portalEnabled: true },
        portalSession: { authenticated: true, user: { employeeNumber: "BEISPIEL-A", accountId: "A", role: "developer", salesHistory: { read: true } } },
        personnelAdministrationTab: "dashboard", personnelTab: "employees", requestKindTab: "vacation", locationId: "18", departmentId: "", salesAnalytics: { tab: "create" }, salesArticleCatalog: {}, crm: {} };
      window.locationsForTest = [{ id: "18", name: "Beispiel Nord" }, { id: "23", name: "Beispiel Süd" }];
      window.activeLocations = () => locationsForTest;
      window.escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
      window.logisticsTab = "purchasing"; window.privacyOrganizationTab = "overview"; window.technicalSecurityTab = "sast"; window.tradeInsightsTab = "repairs";
      window.mobileNavigationMedia = matchMedia("(max-width: 820px), (max-width: 1100px) and (pointer: coarse)");
      window.mobileNavigationPreviousFocus = null; window.timePresenceRefreshTimer = null;
      for (const name of ["receiptSearchWorkspace", "salesArticleReportWorkspace", "salesBwlWorkspace", "gpDefinitionsWorkspace", "tradeInsightsWorkspace", "tradeOrdersWorkspace", "salesPriceLabelsWorkspace"]) window[name] = null;
      window.denied = new Set();
      window.canReadSecurityAuditsWorkspace = () => !denied.has('canReadSecurityAuditsWorkspace');
      for (const name of ["canReadManagerRequests", "canReadManagedTimeTracking", "canOpenPersonnelAdministrationModule", "canAccessTeamManagement", "canOpenSalesAdministrationModule", "canAccessSalesAnalytics", "canAccessSalesArticleCatalog", "canReadSalesArticleReport", "canReadSalesBwl", "canUseGpDefinitions", "canUseSalesPriceLabels", "canAccessCrm", "canAccessTradeInsights", "canReadTradeMovements", "canReadLoanManagement", "canManageBranchOrders", "canAccessPrivacyOrganization", "canOpenPrivacyOrganizationTab", "canReadSystemCenter"]) window[name] = () => !denied.has(name);
      for (const name of ["clearUsbProvisioningPasswords", "pausePersonnelLifecycleEditor", "pauseEmployeeProfile", "resumeEmployeeProfile", "clearPersonnelLifecycleAutomationState", "applyActivePageAppearance", "syncSalesArticleSearchWindow", "syncGpWindows", "syncStartDashboardVps", "loadStartDashboard", "loadRightsDashboard", "ensureAccessibleManagerRequestTab", "loadManagerVacationRequests", "loadLoanManagement", "loadBranchOrdersManagement", "renderSalesArticleCatalogResults", "loadSalesArticleCatalogDetail", "syncCrmCustomerWorkspace", "activatePrivacyOrganizationView", "activateTechnicalSecurityView", "activateTradeArea", "activateSalesArticleReport", "activateSalesBwl", "activateGpDefinitions", "renderGpDefinitionsAccess", "loadPlanningView", "refreshTimeTrackingView", "initializeTimeSummaryDates", "initializeTimeReviewDate"]) window[name] = () => {};
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
      document.body.classList.remove("session-pending");
      elements.loginGate.classList.add("hidden");
      (0, eval)(source);
      window.grabenplanerNavigation = GrabenplanerNavigationHistory.create({ window, app: "admin", keys: ["view", "section", "kind", "dashboard", "process", "location", "department"], read: currentAdministrationRoute, apply: () => applyRequestedView({ fromHistory: true }) });
      applyRequestedView({ loadContext: false }); grabenplanerNavigation.start();
      window.layoutForTest = GrabenplanerSidebarLayout.mount({ window, document, sidebar: elements.mainSidebar, handle: elements.sidebarResizeHandle, mobileMedia: mobileNavigationMedia });
      if (mobileNavigationMedia.matches) closeMobileNavigation({ restoreFocus: false });
    }, { source });
  }
  async function click(selector) {
    await page.evaluate(() => { if (mobileNavigationMedia.matches) openMobileNavigation(); });
    if (mobile) await page.locator(selector).tap(); else await page.locator(selector).click();
    await page.waitForTimeout(10);
  }
  return { page, errors, load, click, async close() { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
}
async function current(page, selector) {
  assert.equal(await page.locator('.main-nav [aria-current="page"]').count(), 1);
  assert.equal(await page.locator(selector).getAttribute("aria-current"), "page", selector);
  const marker = await page.locator(selector).evaluate(element => {
    if (!element.matches(".nav-module-route,.nav-child")) return null;
    const probe = document.createElement("span"); probe.style.color = "var(--coral)"; element.append(probe);
    const coral = getComputedStyle(probe).color; probe.remove();
    const style = getComputedStyle(element), dot = getComputedStyle(element, "::before");
    return { coral, color: dot.backgroundColor, background: style.backgroundColor, radius: Number.parseFloat(style.borderRadius) };
  });
  if (marker) {
    assert.equal(marker.color, marker.coral, "Active marker: " + selector);
    assert.notEqual(marker.background, "rgba(0, 0, 0, 0)", "Active highlight: " + selector);
    assert.ok(marker.radius >= 7, "Rounded active highlight: " + selector);
  }
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
      else if (route.id === "technicalSecurityNavButton") await current(f.page, "#securitySastNavButton");
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

async function treeGeometry(page) {
  return page.evaluate(() => {
    const sidebar = document.getElementById("mainSidebar"), probe = document.createElement("span");
    probe.style.color = "var(--coral)"; sidebar.append(probe);
    const coral = getComputedStyle(probe).color; probe.remove();
    const shown = element => !element.closest(".hidden,[hidden]");
    const number = value => Number.parseFloat(value) || 0;
    const rows = [...sidebar.querySelectorAll(".nav-module-route,.nav-child,.nav-submodule > .nav-branch > .nav-item")].filter(shown).map(element => {
      const style = getComputedStyle(element), dot = getComputedStyle(element, "::before"), bounds = element.getBoundingClientRect();
      const group = element.closest(".nav-children,.nav-module-children"), parent = element.closest(".nav-branch");
      const owner = parent ? parent.parentElement : element, line = getComputedStyle(owner, parent ? "::before" : "::after");
      const ownerBounds = owner.getBoundingClientRect(), siblings = [...group.children].filter(shown);
      const scale = Number.parseFloat(getComputedStyle(document.body).zoom) || 1;
      const lineX = ownerBounds.left + (number(line.left) + number(line.width) / 2) * scale;
      const dotX = bounds.left + number(dot.left) * scale, dotY = bounds.top + bounds.height / 2;
      const lineTop = ownerBounds.top + number(line.top) * scale, lineBottom = lineTop + number(line.height) * scale;
      const label = element.querySelector("span:not(.nav-symbol)") || element;
      const range = document.createRange(); range.selectNodeContents(label);
      const labelRects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
      const labelBounds = label.getBoundingClientRect(), badge = element.querySelector(".nav-count:not(.hidden)");
      const badgeBounds = badge?.getBoundingClientRect();
      return { id: element.id || element.dataset.contextView + ":" + element.dataset.locationId, active: element.matches(".active,.contains-active"),
        line: { content: line.content, width: number(line.width), color: line.backgroundColor },
        last: siblings.at(-1) === owner, endDistance: Math.abs(lineBottom - dotY),
        continuation: parent && siblings.at(-1) === owner ? getComputedStyle(owner, "::after").content : null,
        dot: { content: dot.content, width: number(dot.width), height: number(dot.height), radius: dot.borderRadius, color: dot.backgroundColor, pointer: dot.pointerEvents },
        alignment: Math.abs(dotX - lineX), radius: number(style.borderRadius), background: style.backgroundColor,
        height: bounds.height / scale, textLines: new Set(labelRects.map(rect => Math.round(rect.top))).size,
        textFits: labelRects.every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1),
        labelWidth: labelBounds.width, badgeFits: !badgeBounds || badgeBounds.left >= labelBounds.right - 1 && badgeBounds.right <= bounds.right + 1,
        iconHidden: !element.querySelector(".nav-symbol") || getComputedStyle(element.querySelector(".nav-symbol")).display === "none" };
    });
    const branches = [...sidebar.querySelectorAll(".nav-submodule")].filter(shown).map(element => {
      const parent = element.querySelector(":scope > .nav-branch > .nav-item"), group = element.querySelector(":scope > .nav-children");
      const children = [...group.children].filter(shown), elbow = getComputedStyle(parent, "::after"), bounds = parent.getBoundingClientRect();
      const scale = Number.parseFloat(getComputedStyle(document.body).zoom) || 1, first = children[0];
      const childDot = first && getComputedStyle(first, "::before"), dot = getComputedStyle(parent, "::before");
      const elbowX = bounds.left + number(elbow.left) * scale, elbowY = bounds.top + (number(elbow.top) + .5) * scale;
      return { id: parent.id, visibleChildren: children.length, content: elbow.content,
        horizontal: number(elbow.borderTopWidth), vertical: number(elbow.borderRightWidth),
        originX: Math.abs(elbowX + .5 * scale - (bounds.left + number(dot.left) * scale)),
        originY: Math.abs(elbowY - (bounds.top + bounds.height / 2)),
        stemX: first ? Math.abs(elbowX + (number(elbow.width) - .5) * scale - (first.getBoundingClientRect().left + number(childDot.left) * scale)) : null,
        joinsFirst: first ? Math.abs(bounds.top + (number(elbow.top) + number(elbow.height)) * scale - first.getBoundingClientRect().top) : null };
    });
    return { coral, rows, branches, sidebarFits: sidebar.getBoundingClientRect().right <= innerWidth + 1 };
  });
}

function assertTreeEnds(geometry, context) {
  for (const row of geometry.rows.filter(row => row.last)) {
    assert.ok(row.endDistance <= 1, "Line ends at the last visible point: " + context + " " + row.id + " " + row.endDistance);
    if (row.continuation !== null) assert.equal(row.continuation, "none", "No outer tail below the last parent: " + row.id);
  }
  for (const branch of geometry.branches) {
    if (!branch.visibleChildren) { assert.equal(branch.content, "none", "No dangling branch: " + branch.id); continue; }
    assert.equal(branch.content, '""', context + " " + branch.id);
    assert.ok(branch.horizontal >= .5 && branch.horizontal <= 1); assert.ok(branch.vertical >= .5 && branch.vertical <= 1);
    for (const key of ["originX", "originY", "stemX", "joinsFirst"]) assert.ok(branch[key] <= 1, "Connected elbow " + key + ": " + context + " " + branch.id + " " + branch[key]);
  }
}

test("Sidebar tree: every module and context shares visible markers across mobile widths, resizing and GP zoom", options, async () => {
  const captures = [];
  for (const mobile of [false, true]) {
    const f = await fixture({ mobile });
    try {
      await f.load("?view=planning&location=18");
      const cases = mobile
        ? [{ width: 320, zoom: 1 }, { width: 390, zoom: 1 }, { width: 390, zoom: 1.5 }]
        : [{ width: 1440, sidebar: 200, zoom: 1 }, { width: 1440, sidebar: 240, zoom: 1.5 }, { width: 1920, sidebar: 380, zoom: 2 }];
      for (const size of cases) {
        await f.page.setViewportSize({ width: size.width, height: mobile ? 844 : 1100 });
        await f.page.evaluate(({ zoom, sidebar }) => {
          document.documentElement.style.setProperty("--app-font-scale", zoom);
          document.documentElement.style.setProperty("--app-font-scale-inverse", 1 / zoom);
          layoutForTest.refresh();
          if (sidebar) {
            const handle = document.getElementById("sidebarResizeHandle");
            handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
            for (let width = 200; width < sidebar; width += 10) handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
          }
          for (const key of Object.keys(navigationGroups())) sidebarGroupsForTest().setOpen(key, true);
          document.querySelectorAll(".main-nav .nav-count").forEach(node => { node.textContent = "999"; node.classList.remove("hidden"); });
          renderContextNavigation();
          if (mobileNavigationMedia.matches) openMobileNavigation();
        }, size);
        await f.page.waitForTimeout(220);
        const geometry = await treeGeometry(f.page), context = JSON.stringify({ mobile, ...size });
        assert.equal(geometry.sidebarFits, true, context);
        assert.ok(geometry.rows.length >= 35, "All groups and both dynamic context lists must be measured");
        for (const row of geometry.rows) {
          const label = context + " " + row.id;
          assert.equal(row.line.content, '""', label); assert.equal(row.line.width, 1, label);
          assert.notEqual(row.line.color, "rgba(0, 0, 0, 0)", label);
          assert.equal(row.dot.content, '""', label); assert.equal(row.dot.width, row.active ? 8 : 5, label); assert.equal(row.dot.height, row.active ? 8 : 5, label);
          assert.equal(row.dot.radius, "50%", label); assert.equal(row.dot.pointer, "none", label);
          assert.ok(row.alignment <= 1, "Dot must sit on its own parent line: " + label + " " + row.alignment);
          assert.ok(row.radius >= 7, label); assert.equal(row.iconHidden, true, label);
          if (mobile) assert.ok(row.height >= 44, "Touch height: " + label);
          if (row.active) assert.equal(row.dot.color, geometry.coral, label);
          else assert.notEqual(row.dot.color, geometry.coral, label);
          if (row.id === "branchOrdersManagementNavButton") {
            assert.equal(row.textLines, 1, "Filialbestellungen must remain one line: " + label);
            assert.equal(row.textFits, true, "Filialbestellungen must remain fully visible: " + label);
            assert.ok(row.labelWidth >= 100, "Label must not inherit the old 22px icon column: " + label);
          }
          assert.equal(row.badgeFits, true, "Count badge must not overlap the label: " + label);
        }
        assertTreeEnds(geometry, context);
        await current(f.page, '.nav-child[data-context-view="planning"][data-location-id="18"]');
        captures.push({ mobile, ...size, geometry });
        await f.page.locator("#branchOrdersManagementNavButton").scrollIntoViewIfNeeded();
        await f.page.screenshot({ path: path.join(screenshotDirectory(), `sidebar-tree-${mobile ? "mobile" : "desktop"}-${size.width}-${size.sidebar || "drawer"}-zoom-${size.zoom}.png`) });
      }
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
  fs.writeFileSync(path.join(screenshotDirectory(), "sidebar-tree-geometry.json"), JSON.stringify(captures, null, 2) + "\n");
});

test("Sidebar tree: disclosure, hidden permissions and current route remain independent of decorative markers", options, async () => {
  const f = await fixture({ mobile: true, width: 320 });
  try {
    await f.load("?view=planning&location=18");
    await f.click('[data-nav-toggle="vacations"]');
    await f.click('.nav-child[data-context-view="vacations"][data-location-id="23"]');
    await current(f.page, '.nav-child[data-context-view="vacations"][data-location-id="23"]');
    assert.equal(await f.page.evaluate(() => state.locationId), "23");
    await f.page.evaluate(() => openMobileNavigation());
    await f.page.locator('[data-nav-toggle="vacations"]').tap();
    await f.page.evaluate(() => renderContextNavigation());
    assert.equal(await f.page.locator("#vacationNavChildren").isVisible(), false);
    assert.equal(await f.page.locator('[data-nav-toggle="vacations"]').getAttribute("aria-expanded"), "false");
    await f.page.goBack();
    await current(f.page, '.nav-child[data-context-view="planning"][data-location-id="18"]');
    await f.page.evaluate(() => {
      denied.add("canReadSalesArticleReport");
      document.getElementById("salesArticleReportNavButton").classList.add("hidden");
      document.getElementById("privacyOrganizationNav").classList.add("hidden");
      sidebarGroupsForTest().setOpen("salesAdministration", true);
      sidebarGroupsForTest().setOpen("privacyOrganization", true);
      setView("articleReport"); renderContextNavigation(); openMobileNavigation();
    });
    await current(f.page, "#startDashboardNavButton");
    assert.equal(await f.page.locator("#salesArticleReportNavButton").isVisible(), false);
    assert.equal(await f.page.locator("#privacyOrganizationNav").isVisible(), false);
    assert.equal(await f.page.locator("#privacyOrganizationNavChildren").isVisible(), false);
    await f.page.evaluate(() => {
      document.getElementById("requestsNavButton").classList.add("attention");
      sidebarGroupsForTest().setOpen("personnelAdministration", true); renderContextNavigation();
    });
    await f.click("#requestsNavButton"); await current(f.page, "#requestsNavButton");
    await f.page.evaluate(() => openMobileNavigation());
    const warning = await f.page.locator("#requestsNavButton").evaluate(element => ({
      color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor,
    }));
    assert.deepEqual(warning, { color: "rgb(111, 82, 16)", background: "rgb(255, 240, 184)" });
    await f.page.locator("#personnelAdministrationToggle").focus();
    await f.page.keyboard.press("Enter");
    assert.equal(await f.page.locator("#personnelAdministrationNavChildren").isVisible(), false);
    assert.equal(await f.page.locator("#personnelAdministrationToggle").getAttribute("aria-expanded"), "false");
    await f.page.keyboard.press("Enter");
    assert.equal(await f.page.locator("#personnelAdministrationNavChildren").isVisible(), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("Sidebar tree ends follow hidden rows, a single child and the last expanded parent", options, async () => {
  for (const mobile of [false, true]) {
    const f = await fixture({ mobile, width: mobile ? 320 : 1440 });
    try {
      await f.load("?view=planning&location=18");
      await f.page.evaluate(() => {
        for (const key of Object.keys(navigationGroups())) sidebarGroupsForTest().setOpen(key, true);
        renderContextNavigation();
        if (mobileNavigationMedia.matches) openMobileNavigation();
        const sales = document.getElementById("salesAdministrationNavChildren");
        [...sales.children].slice(-2).forEach(row => row.classList.add("hidden"));
        const planning = document.getElementById("planningNavChildren");
        planning.lastElementChild.hidden = true;
      });
      let geometry = await treeGeometry(f.page);
      assert.equal(await f.page.locator("#planningNavChildren > [hidden]").isVisible(), false);
      assertTreeEnds(geometry, "hidden last rows, mobile=" + mobile);
      assert.equal(geometry.rows.find(row => row.id === "salesBwlNavButton").last, true);
      assert.equal(geometry.rows.find(row => row.id === "vacationsNavButton").last, true);
      assert.equal(geometry.branches.find(row => row.id === "planningNavButton").visibleChildren, 1);
      await f.page.evaluate(() => {
        const sales = document.getElementById("salesAdministrationNavChildren");
        [...sales.children].forEach(row => row.classList.toggle("hidden", row.id !== "salesArticleCatalogNavButton"));
        document.querySelectorAll("#vacationNavChildren > *").forEach(row => row.hidden = true);
        document.getElementById("planningNavChildren").replaceChildren();
      });
      geometry = await treeGeometry(f.page);
      assertTreeEnds(geometry, "single route and empty child groups, mobile=" + mobile);
      const only = geometry.rows.find(row => row.id === "salesArticleCatalogNavButton");
      assert.equal(only.last, true); assert.ok(only.endDistance <= 1);
      assert.ok(geometry.branches.every(branch => branch.visibleChildren === 0));
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});

test("Developer tree uses centered active points and stops at the last visible standard or workspace child", options, async () => {
  for (const mobile of [false, true]) {
    const f = await fixture({ mobile, width: mobile ? 390 : 1440 });
    try {
      await f.load("?view=gpDefinitions");
      for (const name of ["gp-definitions-registry.js", "gp-definitions.js"]) await f.page.addScriptTag({ path: path.join(root, "public", name) });
      await f.page.evaluate(() => {
        gpDefinitionsWorkspace = GpDefinitions.mount(document.getElementById("gpDefinitionsWorkspace"), {
          canUse: () => true, key: () => "synthetic-developer",
          loadWorkspaces: async () => [
            { id: "image-gp", title: "image.GP", url: "/api/portal/v1/private-workspaces/image-gp/page" },
            { id: "image-create", parentId: "image-gp", title: "Bild erstellen", url: "/api/portal/v1/private-workspaces/image-create/page" },
            { id: "image-gallery", parentId: "image-gp", title: "Galerie", url: "/api/portal/v1/private-workspaces/image-gallery/page" }
          ]
        });
        gpDefinitionsWorkspace.activate();
      });
      await f.page.locator('[data-gp-private-workspace="image-gallery"]').waitFor();
      await f.page.locator('[data-gp-definition-topic="sidebar"]').click();
      for (const hidden of [false, true]) {
        await f.page.evaluate(hidden => {
          document.querySelectorAll(".gp-definitions-menu-children").forEach(group => { group.lastElementChild.hidden = hidden; });
        }, hidden);
        if (hidden) for (const row of await f.page.locator(".gp-definitions-menu-children > [hidden]").all()) assert.equal(await row.isVisible(), false);
        const groups = await f.page.locator(".gp-definitions-menu-children").evaluateAll(groups => groups.map(group => {
          const rows = [...group.children].filter(row => !row.hidden && !row.classList.contains("hidden"));
          const last = rows.at(-1), bounds = last.getBoundingClientRect(), line = getComputedStyle(last, "::after");
          const selected = rows.find(row => row.classList.contains("is-selected")), dot = selected && getComputedStyle(selected, "::before");
          return { id: group.id, endDistance: Math.abs(parseFloat(line.top) + parseFloat(line.height) - bounds.height / 2),
            selectedWidth: dot ? parseFloat(dot.width) : null, selectedHeight: dot ? parseFloat(dot.height) : null,
            selectedCenter: selected ? Math.abs(parseFloat(dot.top) - selected.getBoundingClientRect().height / 2) : null };
        }));
        assert.equal(groups.length, 2);
        for (const group of groups) {
          assert.ok(group.endDistance <= 1, "Developer visible end: " + group.id);
          if (group.selectedWidth !== null) {
            assert.equal(group.selectedWidth, 8); assert.equal(group.selectedHeight, 8); assert.ok(group.selectedCenter <= 1);
          }
        }
      }
      await f.page.locator(".gp-definitions-topics").screenshot({ path: path.join(screenshotDirectory(), "developer-tree-" + (mobile ? "mobile" : "desktop") + ".png") });
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});
