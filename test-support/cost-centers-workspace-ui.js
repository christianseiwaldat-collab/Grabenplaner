"use strict";
const path = require("node:path"), assert = require("node:assert/strict");
const { root, read, section, dialog, functionSource, screenshotDirectory } = require("./learning-workspace-ui");

function bindings() {
  const app = read("app.js").replace(/\r\n/g, "\n");
  const single = prefix => {
    const line = app.split("\n").find(value => value.startsWith(prefix));
    assert.ok(line, prefix); return line;
  };
  const block = prefix => {
    const start = app.indexOf(prefix), end = app.indexOf("\n});", start);
    assert.ok(start >= 0 && end > start, prefix); return app.slice(start, end + 4);
  };
  return [
    single('elements.addCostCenterButton?.addEventListener("click"'),
    single('elements.addCostCenterTypeButton?.addEventListener("click"'),
    single('elements.costCenterType?.addEventListener("change"'),
    single('elements.costCenterTypePositionSearch?.addEventListener("input"'),
    block('elements.costCenterTypePositionOptions?.addEventListener("change"'),
    block('elements.costCenterList?.addEventListener("click"'),
    block('elements.costCenterTypeList?.addEventListener("click"'),
    single('document.querySelectorAll("[data-close]").forEach'),
  ].join("\n");
}

async function prepare(page, { write = true, dark = false, zoom = 1 } = {}) {
  page.setDefaultTimeout(6000);
  const errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
  const markup = '<!doctype html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="personnelAdministrationView" class="synthetic-cost-centers view active">' + section("costCenterSection") + '</main>' + ["costCenterModal", "costCenterTypeModal"].map(id => dialog(id)).join("") + '</body></html>';
  await page.route("http://127.0.0.1:34129/cost-centers-test", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: markup }));
  await page.goto("http://127.0.0.1:34129/cost-centers-test");
  for (const name of ["styles.css", "cost-centers-workspace.css", "mobile-refinements.css", "gp-window.css"]) await page.addStyleTag({ path: path.join(root, "public", name) });
  // Only the surrounding application shell is replaced. The section, dialogs,
  // renderers, permission function, filters and open/change bindings are real.
  await page.addStyleTag({ content: '.synthetic-cost-centers{max-width:1320px;margin:24px auto;padding:0 24px;box-sizing:border-box}#costCenterSection{display:block!important}@media(max-width:700px){.synthetic-cost-centers{padding:0 12px;margin:16px auto}}' });
  for (const name of ["gp-window-preferences.js", "gp-window.js"]) await page.addScriptTag({ path: path.join(root, "public", name) });
  const names = ["pageViewElement", "applyActivePageAppearance", "applyPageTheme", "applyGlobalTheme", "salesArticleSearchWindowScale", "canWriteCostCenters", "costCenterTypeByKey", "costCenterTypeLabel", "renderCostCenterTypes", "renderCostCenters", "setupCostCenterFilters", "populateCostCenterTypeSelect", "syncCostCenterTypeHint", "openCostCenterModal", "updateCostCenterTypePositionCount", "renderCostCenterTypePositionOptions", "openCostCenterTypeModal"];
  const themeViews = read("app.js").match(/const UI_APPEARANCE_VIEWS = Object\.freeze\(\[[\s\S]*?\]\);/);
  assert.ok(themeViews);
  const accessLines = read("app.js").split(/\r?\n/).filter(line => /^\s*elements\.addCostCenter(?:Type)?Button\?\.classList\.toggle\("hidden", !costCenterWriteAccess\);/.test(line));
  assert.equal(accessLines.length, 2);
  await page.evaluate(({ source, events, access, write, zoom, dark }) => {
    const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    window.escapeHtml = window.escapeHtmlAttribute = escape;
    window.elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
    const positions = Array.from({ length: 26 }, (_, index) => ({ id: "SYN-P" + index, name: index ? "Beispielposition " + (index + 1) + " mit Kundenberatung und Verantwortung" : "Filialleitung", sort_order: index }));
    const type = (id, code, name, active, isBranch, positionIds) => ({ id, code, name, active, isBranch, description: "Synthetischer Organisationstyp für die lokale Prüfung.", positions: [], positionIds, sortOrder: 1, isDefault: true, costCenterCount: 2, locationCount: isBranch ? 2 : 0 });
    window.state = {
      currentView: "personnelAdministration", globalTheme: "light", pageThemes: {},
      portalStatus: { portalEnabled: true }, portalSession: { user: { employeeNumber: "SYN-ONLY", permissions: write ? ["cost_centers:read", "cost_centers:write"] : ["cost_centers:read"] } },
      positions, costCenterTypePositionSelection: new Set(),
      costCenterTypes: [type("SYN-B", "branch", "Filiale", true, true, positions.map(p => p.id)), type("SYN-V", "administration", "Verwaltung", true, false, [positions[0].id]), type("SYN-L", "production", "Lager und Logistik", true, false, []), type("SYN-O", "other", "Sonstige", true, false, []), type("SYN-A", "archive", "Historischer Bereich", false, false, [])],
      costCenters: [
        { id: "SYN-18", code: "18", name: "Beispiel Innenstadt", description: "Beratung & Service", typeId: "SYN-B", active: true, employee_count: 12, location_count: 1 },
        { id: "SYN-19", code: "19", name: "Beispiel Nord", description: "Ehemalige Filiale", typeId: "SYN-B", active: false, employee_count: 0, location_count: 0 },
        { id: "SYN-27", code: "27", name: "Beispiel Süd", description: "Beratung", typeId: "SYN-B", active: true, employee_count: 8, location_count: 1 },
        { id: "SYN-LAGER", code: "LAGER", name: "Zentrale Warenannahme", description: "Logistik & Versand", typeId: "SYN-L", active: true, employee_count: 3, location_count: 0 },
        { id: "SYN-VERW", code: "VERW", name: "Verwaltung", description: "Personal, Planung und Organisation", typeId: "SYN-V", active: true, employee_count: 2, location_count: 0 },
        { id: "SYN-LONG", code: "VERWALTUNGSLAGERKOSTENSTELLE01", name: "Beispielbereich mit besonders langer Bezeichnung für Warenlogistik und überregionale Personalverwaltung", description: "Historischer Bereich mit <Beispieltext> & erhaltenen Zuordnungen.", typeId: "SYN-A", active: false, employee_count: 0, location_count: 0 },
      ],
    };
    (0, eval)(source);
    applyGlobalTheme(dark ? "dark" : "light");
    document.documentElement.dataset.appFontScalePercent = String(zoom * 100);
    document.documentElement.style.setProperty("--app-font-scale", String(zoom));
    document.documentElement.style.setProperty("--app-font-scale-inverse", String(1 / zoom));
    window.manager = GpWindow.installDocument(document, { actorKey: () => "SYN-ONLY", canUse: () => true, scale: salesArticleSearchWindowScale, readPreferences: async () => ({ version: 1, windows: {} }), writePreferences: async () => {} });
    window.refreshCostCenterAccess = () => { const costCenterWriteAccess = canWriteCostCenters(); eval(access); renderCostCenters(); renderCostCenterTypes(); };
    refreshCostCenterAccess(); setupCostCenterFilters(); (0, eval)(events);
    // This fixture never submits production mutations; saving is outside its scope.
    document.querySelectorAll("dialog form").forEach(form => form.addEventListener("submit", event => event.preventDefault()));
  }, { source: themeViews[0] + "\n" + names.map(name => functionSource(name)).join("\n"), events: bindings(), access: accessLines.join("\n"), write, zoom, dark });
  return { errors, requests };
}

module.exports = { prepare, screenshotDirectory };
