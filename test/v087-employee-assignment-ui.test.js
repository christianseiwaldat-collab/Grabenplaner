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

test("v0.87 Block 2 UI: Mitarbeiteranlage beginnt bei der Kostenstelle", () => {
  const modal = between(html, '<dialog class="modal wide-modal employee-modal" id="employeeModal">', '<dialog class="modal" id="costCenterModal">');
  assert.match(modal, /id="employeeCostCenter" required/);
  assert.match(modal, /id="employeePosition" required/);
  assert.match(modal, /id="employeeCostCenterHint"/);
  assert.match(modal, /id="employeePositionHint"/);
  assert.match(modal, /id="employeePreferredDepartmentHint"/);
  assert.doesNotMatch(modal, /employeeHomeLocation|Stammfiliale/);

  const assignment = between(app, "function updateEmployeeAssignmentOptions(", "function canEditEmployeeAccessProfile");
  assert.match(assignment, /type\.positionIds\.map\(String\)/);
  assert.match(assignment, /employeePositionTypeIds\(position\)\.includes\(typeId\)/);
  assert.match(assignment, /employeeCostCenterLocation\(center\)/);
  assert.match(assignment, /Standort \$\{location\.id\} · \$\{location\.name\} wird automatisch/);

  const save = between(app, "async function saveEmployee(event)", "function canManageTimeTrackingSettings");
  assert.match(save, /costCenterId:\s*elements\.employeeCostCenter\.value/);
  assert.doesNotMatch(save, /homeLocationId:/);
  assert.match(app, /elements\.employeeCostCenter\.addEventListener\("change", \(\) => updateEmployeeAssignmentOptions\(\)\)/);
  const open = between(app, "function openEmployeeModal(", "function shiftRuleFindingsForCandidate");
  assert.match(open, /if \(!employee && !centralPersonnelWrite\)/);
  assert.match(open, /scopedLocation\?\.cost_center_id/);
});

test("v0.87 Block 2 UI: Personalaktbereiche bleiben standardmäßig eingeklappt", () => {
  const modal = between(html, '<dialog class="modal wide-modal employee-modal" id="employeeModal">', '<dialog class="modal" id="costCenterModal">');
  assert.equal((modal.match(/data-employee-form-section=/g) || []).length, 2);
  assert.equal((modal.match(/<details class="protected-record-section(?:\s|")/g) || []).length, 4);
  assert.match(modal, /<details class="employee-access-profile full-width" id="employeeAccessProfile">/);
  assert.doesNotMatch(modal, /<details[^>]*\sopen(?:\s|>)/);

  const open = between(app, "function openEmployeeModal(", "function shiftRuleFindingsForCandidate");
  assert.match(open, /querySelectorAll\("details"\)\.forEach\(\(section\) => \{ section\.open = false; \}\)/);
  assert.match(app, /employeeForm\.addEventListener\("invalid", \(event\) => \{\s*event\.target\.closest\("details"\)\?\.setAttribute\("open", ""\)/);
  assert.match(styles, /\.employee-form-section\s*\{/);
  assert.match(styles, /\.protected-record-section\s*>\s*summary/);
});

test("v0.87 Block 2 UI: eigenständiger Personalakt merkt nur den geöffneten Arbeitsbereich", () => {
  const details = between(app, "function personnelRecordDetails(", "function personnelDocumentDate");
  assert.match(details, /personnelRecordOpenSections\.has\(title\)/);
  assert.match(details, /data-personnel-record-section=/);
  assert.doesNotMatch(details, /class="personnel-record-details \$\{className\}" open/);
  const open = between(app, "async function openPersonnelRecord(", "async function savePersonnelRecord");
  assert.match(open, /const freshDialog = !elements\.personnelRecordModal\.open/);
  assert.match(open, /state\.personnelRecordOpenSections\.clear\(\)/);
  assert.match(app, /personnelRecordContent\?\.addEventListener\("toggle"/);
});

test("v0.87 Block 2 UI: Personalimport verwendet ebenfalls die Kostenstelle als Vorgabe", () => {
  assert.match(html, /id="personnelImportDefaultCostCenter"/);
  assert.doesNotMatch(html, /personnelImportDefaultLocation/);
  const defaults = between(app, "function populatePersonnelImportDefaults()", "function setPersonnelImportStep");
  assert.match(defaults, /currentLocation\?\.costCenterId/);
  assert.match(defaults, /updatePersonnelImportAssignmentDefaults/);
  const assignment = between(app, "function updatePersonnelImportAssignmentDefaults(", "function updatePersonnelImportSourceFields");
  assert.match(assignment, /String\(item\.costCenterId \|\| ""\) === costCenterId/);
  assert.match(assignment, /position\.costCenterTypeIds/);
  const configuration = between(app, "function currentPersonnelImportConfiguration()", "function actionLabel");
  assert.match(configuration, /costCenterId:\s*elements\.personnelImportDefaultCostCenter\.value/);
  assert.doesNotMatch(configuration, /homeLocationId:/);
  const mapping = between(app, "function currentPersonnelImportMapping()", "function currentPersonnelImportConfiguration");
  assert.match(mapping, /legacyPersonnelImportMapping/);
});
