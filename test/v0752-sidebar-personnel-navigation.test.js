"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("v0.75.2 Navigation: Personalverwaltung bündelt ausschließlich berechtigte Fachbereiche", () => {
  const navigation = between(html, '<section class="nav-module hidden" id="personnelAdministrationNav"', "</nav>");
  assert.match(navigation, /id="personnelAdministrationToggle"[^>]*data-nav-toggle="personnelAdministration"[^>]*aria-controls="personnelAdministrationNavChildren"/);
  assert.match(navigation, /id="personnelAdministrationToggle"[^>]*aria-label="Unterpunkte der Personalverwaltung ein- oder ausklappen"/);
  assert.match(navigation, /<button(?=[^>]*id="personnelDashboardNavButton")(?=[^>]*data-view="personnelAdministration")(?=[^>]*data-personnel-administration-route="dashboard")[^>]*>/);
  assert.match(navigation, /<button(?=[^>]*id="personnelDirectoryNavButton")(?=[^>]*data-personnel-administration-route="employees")[^>]*>/);
  assert.match(navigation, /<button(?=[^>]*id="positionManagementNavButton")(?=[^>]*data-personnel-administration-route="positions")[^>]*>/);
  assert.match(navigation, /id="requestsNavButton"/);
  assert.match(navigation, /id="timeTrackingNavButton"/);
  assert.match(navigation, /<button(?=[^>]*id="costCentersNavButton")(?=[^>]*data-personnel-administration-route="costCenters")[^>]*>/);
  assert.match(navigation, /<button(?=[^>]*id="customWorkRulesNavButton")(?=[^>]*data-personnel-administration-route="ruleDrafts")[^>]*>/);
  assert.match(navigation, /<button(?=[^>]*id="collectiveAgreementsNavButton")(?=[^>]*data-personnel-administration-route="collectiveAgreements")[^>]*>/);
  assert.match(navigation, /<button(?=[^>]*id="centralVacationsNavButton")(?=[^>]*data-personnel-administration-route="vacations")[^>]*>/);
  assert.ok(navigation.indexOf("personnelDirectoryNavButton") < navigation.indexOf("requestsNavButton"));
  assert.ok(navigation.indexOf("requestsNavButton") < navigation.indexOf("timeTrackingNavButton"));
  assert.ok(navigation.indexOf("timeTrackingNavButton") < navigation.indexOf("costCentersNavButton"));
  assert.ok(navigation.indexOf("costCentersNavButton") < navigation.indexOf("customWorkRulesNavButton"));
  assert.ok(navigation.indexOf("customWorkRulesNavButton") < navigation.indexOf("collectiveAgreementsNavButton"));
  assert.ok(navigation.indexOf("collectiveAgreementsNavButton") < navigation.indexOf("centralVacationsNavButton"));
});

test("v0.75.2 Navigation: zentrale Punkte folgen ihren eigenen Leserechten", () => {
  const accessHelpers = between(app, "function canReadCentralPersonnel()", "function applyRoleVisibility()");
  const costCenterHelper = between(accessHelpers, "function canReadCostCenters()", "function canWriteCostCenters()");
  assert.match(costCenterHelper, /cost_centers:read/);
  assert.doesNotMatch(costCenterHelper, /canReadCentralPersonnel/);
  assert.match(accessHelpers, /function canReadCentralVacations\(\)[\s\S]*?canReadCentralPersonnel\(\)[\s\S]*?vacation:read/);
  assert.match(accessHelpers, /function managerRequestTabAvailability\(\)[\s\S]*?vacation:read[\s\S]*?sickness:read[\s\S]*?amu:local:manage/);
  assert.match(accessHelpers, /function canReadManagerRequests\(\)[\s\S]*?accessibleManagerRequestTabs\(\)\.length > 0/);
  assert.match(accessHelpers, /function canReadManagedTimeTracking\(\)[\s\S]*?time:read[\s\S]*?time:review/);

  const visibility = between(app, "function applyRoleVisibility()", "async function bootstrapApplication()");
  assert.match(visibility, /personnelDirectoryNavButton\?\.classList\.toggle\("hidden", !centralPersonnelReadAccess\)/);
  assert.match(visibility, /positionManagementNavButton\?\.classList\.toggle\("hidden", !positionWriteAccess\)/);
  assert.match(visibility, /costCentersNavButton\?\.classList\.toggle\("hidden", !costCenterReadAccess\)/);
  assert.match(visibility, /centralVacationsNavButton\?\.classList\.toggle\("hidden", !centralVacationReadAccess\)/);
  assert.match(visibility, /requestsNavButton\?\.classList\.toggle\("hidden", !requestReadAccess\)/);
  assert.match(visibility, /timeTrackingNavButton\?\.classList\.toggle\("hidden", !timeReadAccess\)/);
  assert.match(visibility, /personnelModuleAccess = personnelAdministrationViewAccess \|\| requestReadAccess \|\| timeReadAccess/);
});

test("v0.75.2 Navigation: Personal-Unterseiten sind aufklappbar, adressierbar und eindeutig aktiv", () => {
  const groups = between(app, "function navigationGroups()", "function setNavigationCurrent");
  assert.match(groups, /personnelAdministration:\s*\{\s*toggle:\s*elements\.personnelAdministrationToggle,\s*children:\s*elements\.personnelAdministrationNavChildren\s*\}/);
  const contextualNavigation = between(app, "function renderContextNavigation()", "function renderHeader()");
  assert.match(contextualNavigation, /\["personnelAdministration", "requests", "timeTracking"\]\.includes\(state\.currentView\)/);
  assert.match(contextualNavigation, /state\.personnelAdministrationTab === "dashboard"/);
  assert.match(contextualNavigation, /state\.personnelAdministrationTab === "employees"/);
  assert.match(contextualNavigation, /state\.personnelAdministrationTab === "positions"/);
  assert.match(contextualNavigation, /state\.personnelAdministrationTab === "costCenters"/);
  assert.match(contextualNavigation, /state\.personnelAdministrationTab === "ruleDrafts"/);
  assert.match(contextualNavigation, /state\.personnelAdministrationTab === "collectiveAgreements"/);
  assert.match(contextualNavigation, /state\.personnelAdministrationTab === "vacations"/);
  const requestedView = between(app, "function applyRequestedView()", "function setSettingsTab");
  assert.match(requestedView, /parameters\.get\("section"\)/);
  assert.match(requestedView, /\["dashboard", "employees", "positions", "applications", "workflows", "learning", "tasks", "costCenters", "ruleDrafts", "collectiveAgreements", "vacations"\]\.includes\(requestedSection\)/);
});

test("v0.75.2 Navigation: Teamstatus entfällt und Einstellungen bleiben außerhalb des Scrollmenüs erreichbar", () => {
  assert.doesNotMatch(html, /sidebar-summary|sidebarEmployeeCount|Aktive Teammitglieder/);
  const afterNavigation = html.slice(html.indexOf("</nav>"), html.indexOf('<div class="sidebar-actions"'));
  assert.match(afterNavigation, /class="sidebar-settings-shortcut"/);
  assert.match(afterNavigation, /<button(?=[^>]*id="settingsNavButton")(?=[^>]*data-view="settings")[^>]*>/);
  assert.match(styles, /\.sidebar-settings-shortcut \{ flex: 0 0 auto; margin-top: 8px; \}/);
  assert.doesNotMatch(app, /sidebarEmployeeCount/);
});
