"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const html = read("public/index.html");
const app = read("public/app.js");
const styles = read("public/styles.css");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("M6-Grundgerüst bettet das Mitarbeiterprofil in Mitarbeitende ein", () => {
  const section = between(
    html,
    '<section class="personnel-administration-section active" id="personnelDirectorySection"',
    '<section class="personnel-administration-section personnel-candidates"',
  );
  assert.match(section, /id="personnelDirectoryWorkspace"/);
  assert.match(section, /id="employeeProfileWorkspace"/);
  assert.match(section, /id="employeeProfileBackButton"/);
  for (const tab of ["overview", "masterData", "documents", "onboarding", "training", "offboarding", "history"]) {
    assert.match(section, new RegExp(`data-employee-profile-tab="${tab}"`));
  }
  assert.equal((section.match(/data-employee-profile-tab=/g) || []).length, 7);
  const profile = between(section, '<section class="employee-profile-workspace', "</section>");
  assert.doesNotMatch(profile, /<form\b|type="submit"|data-(?:save|delete|create)-/i);
});

test("M6-Profilzugang ist Feature-, HR- und Zentralzugriffs-gebunden", () => {
  const access = between(
    app,
    "function canOpenEmployeeProfileFoundation()",
    "function canReadCandidatePreboarding()",
  );
  assert.match(access, /!personnelLifecycleFoundationEnabled\(\)/);
  assert.match(access, /!state\.portalStatus\?\.portalEnabled/);
  assert.match(access, /state\.portalSession\?\.user\?\.role === "hr"/);
  assert.match(access, /canReadCentralPersonnel\(\)/);

  const directory = between(app, "function renderPersonnelDirectory()", "const EMPLOYEE_PROFILE_TABS");
  assert.match(directory, /canOpenEmployeeProfileFoundation\(\)/);
  assert.match(directory, /data-central-employee-profile/);
  assert.match(directory, /data-central-edit-employee[^>]*>Stammdaten</);
  assert.match(directory, /data-central-personnel-record[^>]*>Personalakt</);
});

test("M6-Übersicht lädt ausschließlich den vereinbarten GET-Endpunkt", () => {
  const loader = between(
    app,
    "async function loadEmployeeProfileOverview(employeeNumber)",
    "function openEmployeeProfile(employeeNumber",
  );
  assert.match(loader, /api\(`\/api\/portal\/v1\/personnel-lifecycle\/employees\/\$\{encodeURIComponent\(employeeNumber\)\}\/profile\?tab=overview`\)/);
  assert.doesNotMatch(loader, /method\s*:|POST|PUT|PATCH|DELETE/);
  assert.match(loader, /employeeProfileRequestToken !== requestToken/);
  assert.match(loader, /state\.employeeProfile = null/);
});

test("M6-Client übernimmt nur die freigegebene Positivliste", () => {
  const normalization = between(
    app,
    "function normalizeEmployeeProfileOverview(payload, expectedEmployeeNumber)",
    "function employeeProfileInitials(displayName)",
  );
  assert.match(normalization, /capabilities\?\.canReadOverview !== true/);
  assert.match(normalization, /tabs\?\.overview\?\.available !== true/);
  assert.match(normalization, /employeeNumber !== String\(expectedEmployeeNumber/);
  for (const allowed of ["employeeNumber", "displayName", "active", "positionName", "costCenter", "location", "department"]) {
    assert.match(normalization, new RegExp(allowed));
  }
  for (const forbidden of ["birthDate", "bankAccount", "salary", "email", "phone", "documentHistory", "workflowInstance", "offboardingNote"]) {
    assert.doesNotMatch(normalization, new RegExp(forbidden, "i"));
  }
});

test("M6-Folgeregister bleiben neutral gesperrt und lösen keine API aus", () => {
  const rendering = between(
    app,
    "function renderEmployeeProfileContent()",
    "function renderEmployeeProfile()",
  );
  const tabSwitch = between(
    app,
    "function setEmployeeProfileTab(tab",
    "async function loadEmployeeProfileOverview(employeeNumber)",
  );
  assert.match(rendering, /selectedTab !== "overview"/);
  assert.match(rendering, /noch nicht freigeschaltet/);
  assert.match(rendering, /keine zusätzlichen Daten geladen/);
  assert.doesNotMatch(`${rendering}\n${tabSwitch}`, /\bapi\s*\(|method\s*:/);
});

test("M6-Profil bleibt auf schmalen Ansichten ohne Seitenüberlauf lesbar", () => {
  assert.match(styles, /\.employee-profile-shell \{[^}]*min-width:0;[^}]*overflow:hidden;/);
  assert.match(styles, /\.employee-profile-tabs \{[^}]*max-width:100%;[^}]*min-width:0;[^}]*overflow-x:auto;[^}]*overflow-y:hidden;/);
  assert.match(styles, /\.employee-profile-overview-grid \{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media \(max-width: 600px\) \{[\s\S]*?\.employee-profile-overview-grid \{ grid-template-columns:1fr; \}/);
});
