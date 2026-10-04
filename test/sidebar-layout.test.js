"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createGroups, mount } = require("../public/sidebar-layout");

test("Navigation restores only the active path, including the planning branch", () => {
  const groups = createGroups();
  groups.sync("planning:93", "planning");
  assert.equal(groups.isOpen("filialManagement"), true);
  assert.equal(groups.isOpen("planning"), true);
  for (const key of ["vacations", "personnelAdministration", "salesAdministration"]) assert.equal(groups.isOpen(key), false);
  groups.setOpen("personnelAdministration", true);
  groups.setOpen("planning", false);
  groups.sync("planning:93", "planning");
  assert.equal(groups.isOpen("personnelAdministration"), true, "A background render must preserve manual disclosure");
  assert.equal(groups.isOpen("planning"), false);
  groups.reset();
  groups.sync("planning:93", "planning");
  assert.equal(groups.isOpen("planning"), true, "Re-login must reveal the restored destination");
  assert.equal(groups.isOpen("personnelAdministration"), false);
});

test("Route changes open their own module and leave unrelated modules closed", () => {
  const groups = createGroups();
  for (const [view, open] of [["requests", "personnelAdministration"], ["articleCatalog", "salesAdministration"], ["crm", "salesAdministration"], ["logistics", "logistics"], ["settings", null]]) {
    groups.sync(view, view);
    for (const key of ["filialManagement", "personnelAdministration", "salesAdministration", "logistics", "planning", "vacations"]) {
      assert.equal(groups.isOpen(key), key === open, `${view}: ${key}`);
    }
  }
});

function surface({ stored = null, zoom = 1, viewport = 1600, viewportHeight = 900, bannerHeight = 0, blockedStorage = false } = {}) {
  function target() {
    const handlers = new Map();
    return {
      addEventListener(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
      fire(name, args = {}) { const event = { preventDefault() {}, ...args }; for (const handler of handlers.get(name) || []) handler(event); },
    };
  }
  const attributes = {}, classes = new Set(), style = { "--deployment-banner-height": `${bannerHeight}px` };
  const handle = Object.assign(target(), {
    focus() {}, setAttribute(key, value) { attributes[key] = value; },
    setPointerCapture(id) { this.capture = id; }, hasPointerCapture(id) { return this.capture === id; },
    releasePointerCapture(id) { delete this.capture; this.fire("lostpointercapture", { pointerId: id }); },
  });
  const mobileMedia = Object.assign(target(), { matches: false });
  const win = Object.assign(target(), {
    innerWidth: viewport, innerHeight: viewportHeight,
    getComputedStyle: () => ({ zoom, getPropertyValue: key => style[key] || "" }),
    localStorage: { getItem() { if (blockedStorage) throw new Error("disabled"); return stored; }, setItem(key, value) { if (blockedStorage) throw new Error("disabled"); stored = value; } },
  });
  const doc = {
    body: { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } },
    documentElement: { style: { setProperty(key, value) { style[key] = value; } } },
  };
  const controller = mount({ window: win, document: doc, sidebar: {}, handle, mobileMedia });
  return { win, handle, mobileMedia, controller, attributes, classes, style, stored: () => stored, width: () => Number(attributes["aria-valuenow"]) };
}

test("Resizing accounts for GP zoom, captures the pointer and saves only the finished width", () => {
  const s = surface({ zoom: 2, viewport: 2400 });
  s.handle.fire("pointerdown", { button: 0, pointerId: 1, clientX: 480 });
  s.handle.fire("pointermove", { pointerId: 2, clientX: 800 });
  assert.equal(s.width(), 240, "Ignore another pointer");
  s.handle.fire("pointermove", { pointerId: 1, clientX: 600 });
  assert.equal(s.width(), 300);
  assert.equal(s.stored(), null);
  s.handle.fire("pointerup", { pointerId: 1 });
  assert.equal(s.stored(), "300");
  assert.equal(s.classes.has("sidebar-resizing"), false);
  assert.equal(surface({ stored: s.stored() }).width(), 300);
});

test("Escape, a cancelled pointer and a switch to the mobile menu abandon the drag", () => {
  for (const cancel of [s => s.handle.fire("keydown", { key: "Escape" }), s => s.handle.fire("pointercancel", { pointerId: 1 }), s => { s.mobileMedia.matches = true; s.mobileMedia.fire("change"); }]) {
    const s = surface({ stored: "280" });
    s.handle.fire("pointerdown", { button: 0, pointerId: 1, clientX: 280 });
    s.handle.fire("pointermove", { pointerId: 1, clientX: 360 });
    cancel(s);
    assert.equal(s.width(), 280);
    assert.equal(s.stored(), "280");
    assert.equal(s.classes.size, 0);
  }
});

test("Keyboard resizing is bounded, survives unavailable storage and restores after a smaller window", () => {
  const s = surface({ stored: "360" });
  s.win.innerWidth = 900; s.win.fire("resize");
  assert.equal(s.width(), 360);
  s.win.innerWidth = 840; s.win.fire("resize");
  assert.equal(s.width(), 360);
  s.handle.fire("keydown", { key: "End" });
  assert.equal(s.width(), 378);
  s.win.innerWidth = 600; s.win.fire("resize");
  assert.equal(s.width(), 270);
  assert.equal(s.stored(), "378", "Temporary viewport constraints must not overwrite the preference");
  s.win.innerWidth = 1600; s.win.fire("resize");
  assert.equal(s.width(), 378);
  s.handle.fire("keydown", { key: "Home" });
  assert.equal(s.width(), 200);
  s.handle.fire("keydown", { key: "ArrowLeft" });
  assert.equal(s.width(), 200);
  s.handle.fire("keydown", { key: "ArrowRight", shiftKey: true });
  assert.equal(s.width(), 201);
  s.handle.fire("dblclick");
  assert.equal(s.width(), 240);
  const blocked = surface({ blockedStorage: true });
  blocked.handle.fire("keydown", { key: "ArrowRight" });
  assert.equal(blocked.width(), 250);
  assert.equal(surface({ stored: "not-a-number" }).width(), 240);
});

test("Sidebar fills the visible viewport with GP zoom, a changing banner and a narrow menu", () => {
  const s = surface({ zoom: 1.5, viewport: 1500, viewportHeight: 960, bannerHeight: 60 });
  const rendered = name => Number.parseFloat(s.style[name]) * 1.5;
  assert.equal(rendered("--sidebar-top"), 60);
  assert.equal(rendered("--sidebar-height"), 900);
  assert.equal(rendered("--sidebar-top") + rendered("--sidebar-height"), 960);
  s.style["--deployment-banner-height"] = "0px";
  s.controller.refreshViewport();
  assert.equal(rendered("--sidebar-height"), 960);
  s.win.innerHeight = 600;
  s.win.innerWidth = 390;
  s.mobileMedia.matches = true;
  s.win.fire("resize");
  assert.equal(rendered("--sidebar-height"), 600);
  assert.equal(rendered("--sidebar-mobile-width"), 348);
});

test("Logistik opens its child path and marks only Einkauf / Lieferstände as the current page", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const functions = source.slice(source.indexOf("function navigationGroups()"), source.indexOf("function schedulePdfDesignCatalog("));
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set(), attributes = {};
      nodes.set(id, {
        classes, attributes, dataset: {}, querySelectorAll: () => [],
        classList: { contains: name => classes.has(name), toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
        setAttribute(name, value) { attributes[name] = value; }, removeAttribute(name) { delete attributes[name]; },
      });
    }
    return nodes.get(id);
  }
  const context = {
    elements: new Proxy({}, { get: (_, id) => node(id) }),
    state: { currentView: "logistics", portalSession: null }, privacyOrganizationTab: "overview",
    sidebarNavigationGroups: createGroups(), activeLocations: () => [],
    currentAdministrationRoute: () => ({ view: "logistics", section: "purchasing" }),
    document: { getElementById: node, querySelector: selector => selector === ".main-nav" ? null : node(selector) },
    requestAnimationFrame: callback => callback(),
  };
  vm.createContext(context); vm.runInContext(functions, context);
  context.renderContextNavigation();
  assert.equal(node("logisticsNavButton").attributes["aria-current"], undefined);
  assert.equal(node("logisticsNavButton").classes.has("active"), false);
  assert.equal(node("logisticsPurchasingNavButton").attributes["aria-current"], "page");
  assert.equal(node("logisticsPurchasingNavButton").classes.has("active"), true);
  assert.equal(node("logisticsNavChildren").classes.has("hidden"), false);
  context.sidebarNavigationGroups.setOpen("logistics", false);
  context.renderContextNavigation();
  assert.equal(node("logisticsNavChildren").classes.has("hidden"), true, "Background renders preserve manual disclosure");
});
