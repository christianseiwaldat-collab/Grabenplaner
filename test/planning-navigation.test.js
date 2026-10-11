"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createGroups } = require("../public/sidebar-layout");

function navigation(locations, role = "manager") {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { classes, attributes: {}, innerHTML: "", dataset: {}, querySelectorAll: () => [],
        classList: { contains: name => classes.has(name), toggle(name, on) { on ? classes.add(name) : classes.delete(name); } },
        setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } });
    }
    return nodes.get(id);
  }
  const context = vm.createContext({
    elements: new Proxy({}, { get: (_, id) => node(id) }),
    state: { currentView: "planning", locationId: "18", departmentId: "", portalSession: { user: { role } } },
    privacyOrganizationTab: "overview", sidebarNavigationGroups: createGroups(), activeLocations: () => locations,
    currentAdministrationRoute: () => ({ view: "planning" }),
    document: { getElementById: node, querySelector: selector => selector === ".main-nav" ? null : node(selector) },
    requestAnimationFrame: callback => callback(),
    escapeHtml: value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]),
  });
  vm.runInContext(source.slice(source.indexOf("function navigationGroups()"), source.indexOf("function schedulePdfDesignCatalog(")), context);
  return { context, node, render: () => context.renderContextNavigation() };
}

test("A selected planning context is the sole current planning page and retains exact route identifiers", () => {
  const h = navigation([{ id: "18", name: "Beispiel Nord" }, { id: "23", name: "Beispiel Süd" }]);
  h.render();
  assert.equal(h.node("planningNavButton").attributes["aria-current"], undefined);
  assert.equal(h.node("planningNavButton").classes.has("contains-active"), true);
  const html = h.node("planningNavChildren").innerHTML;
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(html, /aria-current="page" data-context-view="planning" data-location-id="18" data-department-id=""/);
  assert.match(html, /<strong>Beispiel Nord<\/strong><small>Gesamtplan<\/small>/);
  h.context.state.locationId = "23"; h.render();
  assert.match(h.node("planningNavChildren").innerHTML, /aria-current="page" data-context-view="planning" data-location-id="23"/);
});

test("A single planning context keeps the parent as current and removes obsolete nested choices", () => {
  const h = navigation([{ id: "18", name: "Beispiel" }]); h.render();
  assert.equal(h.node("planningNavButton").attributes["aria-current"], "page");
  assert.equal(h.node("planningNavButton").classes.has("contains-active"), false);
  assert.equal(h.node("planningNavChildren").innerHTML, "");
  assert.equal(h.node("planningNavChildren").classes.has("hidden"), true);
});

test("Department planning contexts preserve the authorized department route and escape visible and tooltip names", () => {
  const h = navigation([{ id: "18", name: 'Beispiel <Nord> "', departments: [{ id: "HW", name: "Hardware" }, { id: "F&V", name: "Foto & Verkauf" }] }], "department_manager");
  h.context.state.departmentId = "F&V"; h.render();
  const html = h.node("planningNavChildren").innerHTML;
  assert.equal((html.match(/data-context-view="planning"/g) || []).length, 2);
  assert.match(html, /aria-current="page" data-context-view="planning" data-location-id="18" data-department-id="F&amp;V"/);
  assert.match(html, /<strong>Beispiel &lt;Nord&gt; &quot;<\/strong><small>Foto &amp; Verkauf<\/small>/);
  assert.doesNotMatch(html, /Gesamtplan|<Nord>/);
});
