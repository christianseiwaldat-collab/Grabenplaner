"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const { FUNCTION_SEARCH_CATALOG } = require("../public/function-search-catalog");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Ausschnitt fehlt: ${start}`);
  return source.slice(startIndex, endIndex);
}

test("v0.92.20 Positionsverwaltung ist ein eigener berechtigter Personalbereich", () => {
  assert.match(html, /<button(?=[^>]*id="positionManagementNavButton")(?=[^>]*data-personnel-administration-route="positions")[^>]*>/);
  assert.match(html, /id="positionManagementTab"[^>]*data-personnel-administration-tab="positions"/);
  const section = between(html, '<section class="personnel-administration-section position-management-section"', '<section class="personnel-administration-section" id="costCenterSection"');
  for (const id of ["positionForm", "positionSearch", "positionTableHead", "positionList"]) {
    assert.match(section, new RegExp(`id="${id}"`));
  }
  for (const key of ["name", "activeEmployeeCount", "employeeCount"]) {
    assert.match(section, new RegExp(`data-position-sort="${key}"`));
  }
  assert.match(section, /Eine Position vermittelt keine Benutzerrechte/);
  assert.doesNotMatch(html, /id="positionSettingsCard"/);

  const access = between(app, "function canReadCentralPersonnel()", "function canReadCentralVacations()");
  assert.match(access, /function canManagePositions\(\)[\s\S]*?positions:write/);
  const visibility = between(app, "function applyRoleVisibility()", "async function bootstrapApplication()");
  assert.match(visibility, /positionManagementNavButton\?\.classList\.toggle\("hidden", !positionWriteAccess\)/);
  assert.match(visibility, /positionManagementTab\?\.classList\.toggle\("hidden", !positionWriteAccess\)/);
  assert.doesNotMatch(visibility, /positionSettingsCard/);
  assert.match(server, /id: "positions:write"[\s\S]*?group: "Personalverwaltung"/);
  assert.match(server, /Positionen selbst vergeben keine Benutzerrechte/);
});

test("v0.92.20 Positionsliste sucht, sortiert und bietet kompakte Textaktionen", () => {
  const renderer = between(app, "function renderPositions()", "function renderSchedulePdfDesignSettings");
  assert.match(renderer, /const canEdit = canManagePositions\(\)/);
  assert.match(renderer, /state\.positionSearch/);
  assert.match(renderer, /state\.positionSort/);
  assert.match(renderer, /localeCompare/);
  assert.match(renderer, /class="position-text-action"[^>]*data-edit-position/);
  assert.match(renderer, /class="position-text-action danger"[^>]*data-delete-position/);
  assert.doesNotMatch(renderer, /position\.builtin|>Fix</);
  assert.match(styles, /\.position-management-table \{[^}]*min-width:680px;[^}]*border-collapse:collapse;/);
  assert.match(styles, /\.position-text-action \{[^}]*background:transparent;[^}]*font-size:8\.5px;/);

  const searchEntry = FUNCTION_SEARCH_CATALOG.find((entry) => entry.id === "personnel.positions");
  assert.ok(searchEntry);
  assert.deepEqual(searchEntry.path, ["Personalverwaltung", "Positionsverwaltung"]);
  assert.equal(searchEntry.target.personnelAdministrationTab, "positions");
  assert.deepEqual(searchEntry.access.gateIds, ["positionManagementNavButton"]);
  assert.equal(FUNCTION_SEARCH_CATALOG.some((entry) => entry.id === "settings.positions"), false);
});

test("v0.92.20 Löschdialog warnt groß rot und sperrt belegte Positionen vor dem API-Aufruf", () => {
  const dialog = between(html, '<dialog class="modal position-delete-modal"', '<dialog class="modal" id="shiftModal"');
  assert.match(dialog, /id="positionDeleteWarning"[^>]*role="alert"/);
  assert.match(dialog, /id="positionDeleteActiveCount"/);
  assert.match(dialog, /id="positionDeleteHistoryCount"/);
  assert.match(dialog, /id="confirmPositionDeleteButton"/);

  const deletion = between(app, "function positionAssignmentCounts", "async function saveShift");
  assert.match(deletion, /const blocked = counts\.active > 0/);
  assert.match(deletion, /confirmPositionDeleteButton\.disabled = blocked/);
  assert.match(deletion, /positionAssignmentCounts\(position\)\.active > 0/);
  assert.match(deletion, /method: "DELETE"/);
  assert.doesNotMatch(deletion, /\bconfirm\s*\(/);
  assert.match(styles, /\.position-delete-warning \{[^}]*border:2px solid #cf4b38;/);
  assert.match(styles, /\.position-delete-warning\.blocked \{/);
});
