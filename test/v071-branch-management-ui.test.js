"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("v0.71 Block 7 UI: Filialverwaltung fasst Teams, Dienst- und Urlaubsplanung barrierearm zusammen", () => {
  const navigation = between(html, '<section class="nav-module" id="filialManagementNav"', '<section class="nav-module hidden" id="personnelAdministrationNav"');
  assert.match(navigation, /aria-label="Filialverwaltung"/);
  assert.match(navigation, /id="filialManagementToggle"[^>]*data-nav-toggle="filialManagement"[^>]*aria-controls="filialManagementNavChildren"[^>]*aria-expanded="true"/);
  assert.match(navigation, /id="filialManagementNavChildren"/);
  assert.match(navigation, /<button[^>]*data-view="personnel"[^>]*id="filialTeamsNavButton"/);
  assert.match(navigation, /data-nav-toggle="planning"[^>]*aria-controls="planningNavChildren"/);
  assert.match(navigation, /<button[^>]*data-view="planning"[^>]*id="planningNavButton"/);
  assert.match(navigation, /data-nav-toggle="vacations"[^>]*aria-controls="vacationNavChildren"/);
  assert.match(navigation, /<button[^>]*data-view="vacations"[^>]*id="vacationsNavButton"/);
  assert.ok(navigation.indexOf("filialTeamsNavButton") < navigation.indexOf("planningNavButton"));
  assert.ok(navigation.indexOf("planningNavButton") < navigation.indexOf("vacationsNavButton"));
  assert.match(app, /setNavigationCurrent\(elements\.filialTeamsNavButton, state\.currentView === "personnel"\)/);
  assert.match(app, /setNavigationCurrent\(elements\.planningNavButton, state\.currentView === "planning"\)/);
  assert.match(app, /setNavigationCurrent\(elements\.vacationsNavButton, state\.currentView === "vacations"\)/);
});

test("v0.71 Block 7 UI: alle Navigationsgruppen verwenden dieselbe Toggle-Map", () => {
  const groups = between(app, "function navigationGroups()", "function setNavigationCurrent");
  assert.match(groups, /filialManagement:\s*\{\s*toggle:\s*elements\.filialManagementToggle,\s*children:\s*elements\.filialManagementNavChildren\s*\}/);
  assert.match(groups, /planning:\s*\{[^}]*children:\s*elements\.planningNavChildren\s*\}/);
  assert.match(groups, /vacations:\s*\{[^}]*children:\s*elements\.vacationNavChildren\s*\}/);
  const handler = between(app, 'document.querySelector(".main-nav").addEventListener("click"', 'document.querySelectorAll("[data-close]")');
  assert.match(handler, /const group = navigationGroups\(\)\[key\]/);
  assert.match(handler, /localStorage\.setItem\(`grabenplaner-nav-\$\{key\}`/);
  assert.match(handler, /toggle\.setAttribute\("aria-expanded", String\(opening\)\)/);
});

test("v0.71 Block 7 UI: bestehende Views und View-Deep-Links bleiben kompatibel", () => {
  for (const view of ["planning", "vacations", "personnel"]) {
    assert.match(html, new RegExp(`id="${view}View"[^>]*class="view`));
    assert.match(html, new RegExp(`data-view="${view}"`));
  }
  const requestedView = between(app, "function applyRequestedView()", "function setSettingsTab");
  assert.match(requestedView, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(requestedView, /parameters\.get\("view"\)/);
  assert.match(requestedView, /\["planning", "requests", "timeTracking", "vacations", "personnelAdministration", "personnel", "loans", "branchOrders", "rightsDashboard", "settings"\]\.includes\(requestedView\)/);
  assert.match(requestedView, /setView\(requestedView\)/);
});

test("v0.71 Block 7 UI: zentrale Urlaube sind ein eigener lesender Personalverwaltungs-Tab", () => {
  assert.match(html, /id="centralVacationsTab"[^>]*role="tab"[^>]*aria-controls="centralVacationSection"[^>]*data-personnel-administration-tab="vacations"/);
  const section = between(html, '<section class="personnel-administration-section" id="centralVacationSection"', "</section>");
  assert.match(section, /role="tabpanel"[^>]*aria-labelledby="centralVacationsTab"/);
  for (const id of ["centralVacationSummary", "centralVacationSearch", "centralVacationCostCenterFilter", "centralVacationYear", "centralVacationList"]) {
    assert.match(section, new RegExp(`id="${id}"`));
  }
  assert.match(section, /ohne die Planungsregeln der Filialen zu umgehen/);
  assert.match(app, /api\(`\/api\/personnel-vacations\?year=\$\{encodeURIComponent\(year\)\}`\)/);
  assert.match(app, /if \(normalized === "vacations"\) loadCentralVacations\(\)/);
  for (const action of ["saveVacation", "saveVacationEntitlements", "deleteVacation", "decideVacationRequest"]) {
    const start = `async function ${action}`;
    const startIndex = app.indexOf(start);
    const nextFunction = app.indexOf("\nasync function ", startIndex + start.length);
    assert.notEqual(startIndex, -1, `${action} fehlt`);
    const actionSource = app.slice(startIndex, nextFunction === -1 ? app.length : nextFunction);
    assert.match(actionSource, /state\.centralVacationLoadedYear = null/);
  }
});

test("v0.71 Block 7 UI: jede Filiale zeigt ihre Kostenstelle und nur Berechtigte ändern sie", () => {
  assert.match(html, /id="locationCostCenterField"[\s\S]*?<select id="locationCostCenter" required>/);
  assert.match(html, /id="locationCostCenterReadonly"[\s\S]*?nur von der Personalleitung oder Administration geändert/);
  assert.match(app, /function ensureLocationCostCenters\(\)/);
  assert.match(app, /api\("\/api\/cost-centers\?includeInactive=1"\)/);
  assert.match(app, /const canEdit = canWriteCostCenters\(\)/);
  assert.match(app, /const costCenterSettings = canWriteCostCenters\(\) \? \{ costCenterId: elements\.locationCostCenter\.value \} : \{\}/);
  assert.match(app, /\.\.\.costCenterSettings/);
});

test("v0.71 Block 7 UI: globale Dienstplanung behält Standort und kennt filialfremde Mitarbeitende", () => {
  const candidates = between(app, "function canUseAllEmployeesForShiftPlanning()", "function openShiftModal");
  assert.match(candidates, /\["developer", "it_admin", "admin", "hr"\]\.includes/);
  assert.match(candidates, /canUseAllEmployeesForShiftPlanning\(\) \? state\.allEmployees : scopedEmployees/);
  assert.match(candidates, /zugeordneter Standort \$\{homeLocation\}/);
  assert.match(candidates, /String\(employee\.personnel_number\) === selected/);
  const saveShift = between(app, "async function saveShift(event)", "async function saveOption(event)");
  assert.match(saveShift, /employeeNumber: document\.querySelector\("#shiftEmployee"\)\.value/);
  assert.match(saveShift, /locationId: state\.locationId/);
  assert.match(saveShift, /departmentId: elements\.shiftDepartment\.value/);
  const mobileSchedule = between(server, "function mobileSchedulePayload", "function portalStatusForSession");
  assert.match(mobileSchedule, /planningSettingsRepository\.listMobileScheduleShifts/);
  assert.match(mobileSchedule, /employeeNumber: session\.employeeNumber/);
  assert.match(mobileSchedule, /locationId: shift\.location_id/);
  assert.match(mobileSchedule, /locationName: shift\.location_name/);
});

test("v0.71 Block 7 UI: Navigation und zentrale Urlaubstabelle reagieren auf kleinere Ansichten", () => {
  assert.match(styles, /\.nav-module \{ display:grid; min-width:0; \}/);
  assert.match(styles, /\.nav-module-children \{[^}]*border-left:/);
  assert.match(styles, /\.main-nav \{[^}]*overflow-x:clip;[^}]*overflow-y:\s*auto;/);
  assert.match(styles, /@media \(max-width: 820px\) \{[\s\S]*?\.sidebar \{[^}]*position:fixed;[^}]*transform:translateX\(-105%\);[^}]*\}[\s\S]*?\.main-nav \{[^}]*display:grid;[^}]*overflow-x:clip;[^}]*overflow-y:auto;/);
  assert.match(styles, /@media \(max-width: 600px\) \{[\s\S]*?\.main-nav \{ display:grid; width:100%; overflow-x:clip; \}[\s\S]*?\.nav-module \{ width:100%; \}/);
  assert.doesNotMatch(styles, /@media \(max-width: 820px\) \{[\s\S]*?\.main-nav \{[^}]*overflow-x:auto;/);
  assert.match(html, /class="personnel-directory-table central-vacation-table"/);
  assert.match(styles, /@media \(max-width:1180px\) \{[\s\S]*?\.personnel-directory-table thead \{ display:none; \}[\s\S]*?\.personnel-directory-table tr \{ display:grid;/);
});
