"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { parseDocument } = require("htmlparser2");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const TEAM_PERMISSIONS = ["employees:read", "employees:display:write", "employees:write"];
const PREFERENCE_VIEWS = [
  "startDashboard", "filialAdministration", "planning", "requests", "timeTracking", "vacations",
  "personnelAdministration", "personnel", "salesAdministration", "salesAnalytics", "tradeInsights",
  "loans", "branchOrders", "rightsDashboard", "settings",
];

function functionSource(name, source = appSource) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(match, `Actual function is missing: ${name}`);
  const end = source.indexOf("\n}", match.index);
  assert.ok(end > match.index, `Actual function is incomplete: ${name}`);
  return source.slice(match.index, end + 2);
}

function constantSource(name, source) {
  const start = source.indexOf(`const ${name} = Object.freeze([`);
  assert.ok(start >= 0, name);
  const end = source.indexOf("]);", start);
  assert.ok(end > start, name);
  return source.slice(start, end + 3);
}

function element(id = "", dataset = {}) {
  const classes = new Set(), attributes = new Map();
  return {
    id, dataset,
    classList: {
      contains: name => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute: name => attributes.get(name) ?? null,
    querySelectorAll: () => [],
  };
}

function principalContext(permissions = [], { portalEnabled = true, role = "manager", features = {} } = {}) {
  const context = {
    state: {
      currentView: "startDashboard", personnelAdministrationTab: "dashboard",
      portalStatus: { portalEnabled, installationFeatures: features },
      portalSession: { user: { role, employeeNumber: "SYNTHETIC-ACCESS-QA", permissions: [...permissions] } },
    },
  };
  const sources = ["canAccessTeamManagement", "canReadCentralPersonnel", "canReadCentralVacations",
    "canOpenPersonnelAdministrationTab", "filialDashboardCatalog", "personnelDashboardCatalog"]
    .map(name => functionSource(name)).join("\n");
  // Unrelated catalog capabilities stay denied, so they cannot mask the gates under test.
  for (const name of new Set([...sources.matchAll(/\b(can[A-Z]\w+)\(/g)].map(match => match[1]))) {
    context[name] = () => false;
  }
  vm.createContext(context);
  vm.runInContext(sources, context);
  return context;
}

function navigationContext(permissions, options = {}) {
  const context = principalContext(permissions, options);
  const nodes = new Map(), calls = [];
  context.elements = new Proxy({}, {
    get(target, key) { return target[key] ||= nodes.get(key) || element(key); },
  });
  const settingsTab = element("settingsGeneralTab", { settingsTab: "general" });
  settingsTab.classList.toggle("active", true);
  context.document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); },
    querySelectorAll: () => [],
    querySelector: () => settingsTab,
  };
  Object.assign(context, {
    window: {}, privacyOrganizationTab: "overview", timePresenceRefreshTimer: null,
    receiptSearchWorkspace: null, tradeInsightsWorkspace: null, salesPriceLabelsWorkspace: null,
    salesArticleReportWorkspace: null, salesBwlWorkspace: null, gpDefinitionsWorkspace: null,
    employeeProfileIsOpen: () => false, accessibleDashboardModes: () => ["rights"],
    setPersonnelAdministrationTab: () => {}, setSettingsTab: () => {}, setSalesAnalyticsTab: () => {},
    activateTradeArea: () => {}, activatePrivacyOrganizationView: () => {},
  });
  context.state.crm = {};
  context.state.salesArticleCatalog = {};
  context.state.salesAnalytics = { tab: "create" };
  for (const name of ["canReadManagerRequests", "canReadManagedTimeTracking", "canOpenPersonnelAdministrationModule",
    "canOpenSalesAdministrationModule", "canAccessSalesAnalytics", "canAccessSalesArticleCatalog", "canUseSalesPriceLabels",
    "canAccessCrm", "canAccessTradeInsights", "canReadLoanManagement", "canManageBranchOrders",
    "canAccessPrivacyOrganization", "canOpenPrivacyOrganizationTab"]) context[name] = () => true;
  for (const name of ["clearUsbProvisioningPasswords", "clearPersonnelLifecycleEditorState", "clearPersonnelLifecycleAutomationState",
    "renderContextNavigation", "applyActivePageAppearance", "syncSalesArticleSearchWindow", "syncGpWindows", "syncStartDashboardVps", "loadStartDashboard",
    "loadRightsDashboard", "ensureAccessibleManagerRequestTab", "loadManagerVacationRequests", "loadLoanManagement",
    "loadBranchOrdersManagement", "renderSalesArticleCatalogResults", "syncCrmCustomerWorkspace", "loadSystemCenter", "renderGpDefinitionsAccess"]) {
    context[name] = () => { calls.push(name); };
  }
  for (const name of ["loadSalesArticleTablePreferences", "loadSalesArticleLastImport", "loadCrmPreferences"]) {
    context[name] = async () => {};
  }
  vm.runInContext(["pageViewElement", "setView"].map(name => functionSource(name)).join("\n"), context);
  return { context, calls };
}

test("Team access and its dashboard tile follow effective read/display/write rights, including local and Developer sessions", () => {
  for (const permissions of [[], ...TEAM_PERMISSIONS.map(permission => [permission]), ["sales:articles:read"]]) {
    const context = principalContext(permissions);
    const allowed = TEAM_PERMISSIONS.some(permission => permissions.includes(permission));
    assert.equal(context.canAccessTeamManagement(), allowed, JSON.stringify(permissions));
    assert.equal(context.filialDashboardCatalog().find(item => item.id === "team").available, allowed);
    assert.deepEqual(context.state.portalSession.user.permissions, permissions, "The UI must never grant or alter rights");
  }
  assert.equal(principalContext([], { portalEnabled: false }).canAccessTeamManagement(), true);
  assert.equal(principalContext(TEAM_PERMISSIONS, { role: "developer" }).canAccessTeamManagement(), true);
  assert.equal(principalContext([], { role: "developer" }).canAccessTeamManagement(), false,
    "A role label cannot replace the effective permissions supplied by the server");
});

test("Direct Team navigation uses the same gate and does not relax adjacent module restrictions", () => {
  for (const permissions of [[], ...TEAM_PERMISSIONS.map(permission => [permission])]) {
    const { context } = navigationContext(permissions);
    context.setView("personnel");
    assert.equal(context.state.currentView, permissions.length ? "personnel" : "startDashboard");
    assert.equal(context.elements.personnelView.classList.contains("active"), permissions.length > 0);
    context.canReadLoanManagement = () => false;
    context.setView("loans");
    assert.equal(context.state.currentView, "startDashboard");
    context.canOpenSalesAdministrationModule = () => false;
    context.setView("salesAdministration");
    assert.equal(context.state.currentView, "startDashboard");
    context.canAccessCrm = () => false;
    context.setView("crm");
    assert.equal(context.state.currentView, "startDashboard");
  }
  const { context } = navigationContext([], { portalEnabled: false });
  context.setView("personnel");
  assert.equal(context.state.currentView, "personnel");
});

test("Developer access consumes the server's full effective permission projection without granting rights in the UI", () => {
  // A bounded catalog fixture keeps the actual server projection independent of server startup.
  const knownPermissions = new Set([...TEAM_PERMISSIONS, "personnel:central:read", "vacation:read", "sales:articles:read"]);
  const serverContext = { allPortalPermissions: knownPermissions };
  vm.createContext(serverContext);
  vm.runInContext(functionSource("effectivePortalPermissionState", serverSource), serverContext);
  const projection = serverContext.effectivePortalPermissionState(
    "SYNTHETIC-ACCESS-QA", "developer", [], [], [...knownPermissions],
  );
  assert.deepEqual(Array.from(projection.effectivePermissions), [...knownPermissions]);
  const effectivePermissions = Array.from(projection.effectivePermissions);
  const context = principalContext(effectivePermissions, { role: "developer" });
  assert.equal(context.canAccessTeamManagement(), true);
  assert.equal(context.filialDashboardCatalog().find(item => item.id === "team").available, true);
  assert.equal(context.canReadCentralVacations(), true);
  context.state.portalStatus.installationFeatures.vacation = false;
  assert.equal(context.canReadCentralVacations(), false);
  assert.deepEqual(context.state.portalSession.user.permissions, effectivePermissions);
});

test("Team Sidebar visibility and current-view revocation follow the same freshly evaluated gate", () => {
  const visibility = functionSource("applyRoleVisibility");
  const declaration = visibility.match(/const employeeReadAccess = [^;]+;/);
  const sidebar = visibility.match(/document\.querySelectorAll\('\[data-view="personnel"\]'\)\.forEach\([^\n]+/);
  const revocation = visibility.split("\n").find(line => line.includes('state.currentView === "personnel"') && line.includes('setView("startDashboard")'));
  assert.ok(declaration && sidebar && revocation, "The Sidebar and active Team view must both reconcile access");
  const context = principalContext(["employees:read"]), button = element("filialTeamsNavButton");
  context.document = { querySelectorAll: () => [button] };
  context.setView = view => { context.state.currentView = view; };
  const reconcile = () => vm.runInContext(`{ ${declaration[0]}\n${sidebar[0]}\n${revocation}\n}`, context);
  context.state.currentView = "personnel";
  reconcile();
  assert.equal(button.classList.contains("hidden"), false);
  assert.equal(context.state.currentView, "personnel");
  context.state.portalSession.user.permissions = [];
  reconcile();
  assert.equal(button.classList.contains("hidden"), true);
  assert.equal(context.state.currentView, "startDashboard");
  context.state.portalSession.user.permissions = ["employees:display:write"];
  reconcile();
  assert.equal(button.classList.contains("hidden"), false);
  assert.equal(context.state.currentView, "startDashboard", "Restoring rights must not navigate automatically");
});

test("Disabled vacation feature closes the central vacation card and direct tab even for local and Developer sessions", () => {
  const permissions = ["personnel:central:read", "vacation:read"];
  for (const options of [{}, { role: "developer" }, { portalEnabled: false }]) {
    const context = principalContext(permissions, { ...options, features: { vacation: false } });
    assert.equal(context.canReadCentralPersonnel(), true, "Unrelated personnel access is preserved");
    assert.equal(context.canReadCentralVacations(), false);
    assert.equal(context.canOpenPersonnelAdministrationTab("vacations"), false);
    assert.equal(context.personnelDashboardCatalog().find(item => item.id === "vacations").available, false);
    context.state.portalStatus.installationFeatures.vacation = true;
    assert.equal(context.canReadCentralVacations(), true);
    assert.equal(context.canOpenPersonnelAdministrationTab("vacations"), true);
    assert.equal(context.personnelDashboardCatalog().find(item => item.id === "vacations").available, true);
  }
  for (const permissions of [[], ["personnel:central:read"], ["vacation:read"]]) {
    assert.equal(principalContext(permissions).canReadCentralVacations(), false,
      "Enabling the feature cannot substitute for either required permission");
  }
});

test("Global theme reaches every actual main view while the persisted UI/API preference contract stays at 15 views", () => {
  const context = {}, allNodes = [];
  const walk = node => { allNodes.push(node); for (const child of node.children || []) walk(child); };
  walk(parseDocument(html));
  const viewIds = allNodes.filter(node => /(?:^|\s)view(?:\s|$)/.test(node.attribs?.class || "")
    && /(?:^|\s)main-content(?:\s|$)/.test(node.parent?.attribs?.class || ""))
    .map(node => node.attribs.id);
  assert.equal(viewIds.length, 24);
  const nodes = new Map(viewIds.map(id => [id, element(id)]));
  const main = element("main"), toggle = element("sidebarDarkmodeToggle");
  const choices = [element("lightChoice", { globalThemeChoice: "light" }), element("darkChoice", { globalThemeChoice: "dark" })];
  context.elements = Object.fromEntries(nodes);
  context.state = { currentView: "crm", pageThemes: {} };
  context.document = {
    documentElement: { dataset: {} }, getElementById: id => nodes.get(id) || null,
    querySelector: selector => selector === "#sidebarDarkmodeToggle" ? toggle : selector === ".main-content" ? main : null,
    querySelectorAll: selector => selector.includes(".view") ? [...nodes.values()]
      : selector === "button[data-global-theme-choice]" ? choices : [],
  };
  vm.createContext(context);
  vm.runInContext(constantSource("UI_APPEARANCE_VIEWS", appSource) + "\n"
    + ["pageViewElement", "applyActivePageAppearance", "applyPageTheme", "applyGlobalTheme"].map(name => functionSource(name)).join("\n"), context);
  const apiContext = {};
  vm.createContext(apiContext);
  vm.runInContext(constantSource("UI_PREFERENCE_VIEWS", serverSource), apiContext);
  assert.deepEqual(Array.from(vm.runInContext("UI_APPEARANCE_VIEWS", context)), PREFERENCE_VIEWS);
  assert.deepEqual(Array.from(vm.runInContext("UI_PREFERENCE_VIEWS", apiContext)), PREFERENCE_VIEWS);
  for (const [input, expected] of [["dark", "dark"], ["light", "light"], ["invalid", "light"]]) {
    assert.equal(context.applyGlobalTheme(input), expected);
    for (const [id, node] of nodes) assert.equal(node.getAttribute("data-page-theme"), expected, id);
    assert.deepEqual(Object.keys(context.state.pageThemes).sort(), [...PREFERENCE_VIEWS].sort(),
      "The global DOM application must not add unsupported persisted preferences");
    assert.equal(main.getAttribute("data-active-page-theme"), expected);
    assert.equal(context.document.documentElement.dataset.activePageTheme, expected);
    assert.equal(nodes.get("rightsDashboardView").getAttribute("data-dashboard-theme"), expected);
    assert.equal(toggle.getAttribute("aria-checked"), String(expected === "dark"));
    for (const choice of choices) assert.equal(choice.getAttribute("aria-pressed"), String(choice.dataset.globalThemeChoice === expected));
  }
});
