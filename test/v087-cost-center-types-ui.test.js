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

test("v0.87 Kostenstellentypen UI: Typen und Positionssets sind direkt verwaltbar", () => {
  for (const id of [
    "addCostCenterTypeButton",
    "costCenterTypeList",
    "costCenterTypeModal",
    "costCenterTypeForm",
    "costCenterTypeCode",
    "costCenterTypeName",
    "costCenterTypeIsBranch",
    "costCenterTypeActive",
    "costCenterTypePositionSearch",
    "costCenterTypePositionOptions",
    "costCenterTypePositionCount",
    "deactivateCostCenterTypeButton",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} fehlt`);
  }
  assert.match(app, /function normalizeCostCenterType\(/);
  assert.match(app, /function costCenterTypeByKey\(/);
  assert.match(app, /function renderCostCenterTypes\(/);
  assert.match(app, /function openCostCenterTypeModal\(/);
  assert.match(app, /async function saveCostCenterType\(/);
  assert.match(app, /positionIds:\s*\[\.\.\.state\.costCenterTypePositionSelection\]/);
  assert.match(app, /api\(id \? `\/api\/cost-center-types\/\$\{encodeURIComponent\(id\)\}` : "\/api\/cost-center-types"/);
  assert.match(styles, /\.cost-center-type-list \{[^}]*grid-template-columns:/);
  assert.match(styles, /\.cost-center-type-position-options \{[^}]*grid-template-columns:/);
});

test("v0.87 Kostenstellentypen UI: Kostenstellen verwenden den Serverkatalog statt fixer Auswahlwerte", () => {
  const modal = between(html, '<dialog class="modal" id="costCenterModal">', '<dialog class="modal wide-modal" id="costCenterTypeModal">');
  assert.match(modal, /<select id="costCenterType" required><\/select>/);
  assert.doesNotMatch(modal, /value="branch"|value="administration"|value="production"|value="other"/);
  assert.match(app, /apiList\(costCenterPayload, \["types", "costCenterTypes", "cost_center_types"\]\)/);
  assert.match(app, /function populateCostCenterTypeSelect\(/);
  assert.match(app, /costCenterTypeId:\s*elements\.costCenterType\.value/);
  assert.match(app, /costCenterTypeLabel\(center\)/);
});

test("v0.87 Kostenstellentypen UI: Standortauswahl zeigt nur freie aktive Filialkostenstellen", () => {
  const selector = between(app, "function populateLocationCostCenter(", "function resetLocationForm()");
  assert.match(selector, /\.filter\(\(center\) => center\.isBranch\)/);
  assert.match(selector, /\.filter\(\(center\) => !center\.locationId \|\| String\(center\.id\) === String\(selectedId\)\)/);
  assert.match(selector, /\.filter\(\(center\) => center\.active \|\| String\(center\.id\) === String\(selectedId\)\)/);
  assert.match(app, /Bitte zuerst eine freie, aktive Filialkostenstelle anlegen\./);
});

test("v0.87 Kostenstellentypen UI: Schreibaktionen bleiben an cost_centers:write gebunden", () => {
  assert.match(app, /elements\.addCostCenterTypeButton\?\.classList\.toggle\("hidden", !costCenterWriteAccess\)/);
  assert.match(app, /if \(!canWriteCostCenters\(\) \|\| !elements\.costCenterTypeModal\) return/);
  assert.match(app, /if \(!canWriteCostCenters\(\)\) return/);
  assert.match(app, /elements\.costCenterTypeList\?\.addEventListener\("click"/);
});
