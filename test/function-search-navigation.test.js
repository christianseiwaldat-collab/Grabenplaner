const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { FUNCTION_SEARCH_CATALOG } = require("../public/function-search-catalog");
const {
  FUNCTION_SEARCH_NAVIGATION_VERSION,
  HIGHLIGHT_CLASS,
  openFunctionSearchDisclosure,
  revealFunctionSearchAncestors,
  functionSearchTargetIsHidden,
  functionSearchDomGateIsAvailable,
  presentFunctionSearchTarget,
} = require("../public/function-search-navigation");

const publicPath = path.join(__dirname, "..", "public");
const indexHtml = fs.readFileSync(path.join(publicPath, "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(publicPath, "styles.css"), "utf8");
const appSource = fs.readFileSync(path.join(publicPath, "app.js"), "utf8");
const navigationSource = fs.readFileSync(path.join(publicPath, "function-search-navigation.js"), "utf8");

class FakeClassList {
  constructor(values = []) {
    this.values = new Set(values);
  }

  contains(value) { return this.values.has(value); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
}

class FakeElement {
  constructor({ id = "", tagName = "DIV", classes = [], hidden = false, disabled = false, type = "" } = {}) {
    this.id = id;
    this.tagName = tagName;
    this.classList = new FakeClassList(classes);
    this.hidden = hidden;
    this.disabled = disabled;
    this.type = type;
    this.open = false;
    this.parentElement = null;
    this.children = [];
    this.attributes = new Map();
    this.focusCalls = [];
    this.scrollCalls = [];
    this.isConnected = true;
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  focus(options) { this.focusCalls.push(options); }
  scrollIntoView(options) { this.scrollCalls.push(options); }

  closest(selectorList) {
    const selectors = String(selectorList || "").split(",").map((value) => value.trim()).filter(Boolean);
    let current = this;
    while (current) {
      if (selectors.some((selector) => (
        selector.startsWith(".")
          ? current.classList.contains(selector.slice(1))
          : String(current.tagName || "").toLowerCase() === selector.toLowerCase()
      ))) return current;
      current = current.parentElement;
    }
    return null;
  }
}

function fakeDocument(elements, reducedMotion = false) {
  const byId = new Map(elements.filter((element) => element.id).map((element) => [element.id, element]));
  return {
    defaultView: { matchMedia: () => ({ matches: reducedMotion }) },
    getElementById: (id) => byId.get(id) || null,
  };
}

function fakeGateDocument(elements) {
  const body = new FakeElement({ tagName: "BODY" });
  elements.forEach((element) => body.append(element));
  const byId = new Map();
  const index = (element) => {
    if (element.id) byId.set(element.id, element);
    element.children.forEach(index);
  };
  index(body);
  return {
    body,
    getElementById: (id) => byId.get(id) || null,
  };
}

test("Block-4-Navigation ist versioniert, getrennt und aktionsfrei", () => {
  assert.equal(FUNCTION_SEARCH_NAVIGATION_VERSION, 1);
  assert.equal(HIGHLIGHT_CLASS, "function-search-target-highlight");
  assert.equal(typeof openFunctionSearchDisclosure, "function");
  assert.equal(typeof revealFunctionSearchAncestors, "function");
  assert.equal(typeof functionSearchTargetIsHidden, "function");
  assert.equal(typeof functionSearchDomGateIsAvailable, "function");
  assert.equal(typeof presentFunctionSearchTarget, "function");
  assert.doesNotMatch(navigationSource, /\.click\s*\(|\.submit\s*\(|showModal\s*\(|dispatchEvent\s*\(|location\.(?:assign|replace)/);
});

test("DOM-Gates bleiben bei fehlenden, getrennten oder berechtigt verborgenen Elementen fail-closed", () => {
  const visible = new FakeElement({ id: "visibleGate" });
  const hidden = new FakeElement({ id: "hiddenGate", classes: ["hidden"] });
  const hiddenParent = new FakeElement({ classes: ["permission-hidden", "hidden"] });
  hiddenParent.append(new FakeElement({ id: "hiddenByParent" }));
  const collapsedNavigation = new FakeElement({ classes: ["nav-module-children", "hidden"] });
  collapsedNavigation.append(new FakeElement({ id: "collapsedNavigationGate" }));
  const collapsedSettings = new FakeElement({ classes: ["settings-field-disclosure-body", "hidden"] });
  collapsedSettings.append(new FakeElement({ id: "collapsedSettingsGate" }));
  const template = new FakeElement({ tagName: "TEMPLATE" });
  template.append(new FakeElement({ id: "templateGate" }));
  const documentRef = fakeGateDocument([
    visible,
    hidden,
    hiddenParent,
    collapsedNavigation,
    collapsedSettings,
    template,
  ]);

  assert.equal(functionSearchDomGateIsAvailable("visibleGate", { document: documentRef }), true);
  assert.equal(functionSearchDomGateIsAvailable("hiddenGate", { document: documentRef }), false);
  assert.equal(functionSearchDomGateIsAvailable("hiddenByParent", { document: documentRef }), false);
  assert.equal(functionSearchDomGateIsAvailable("collapsedNavigationGate", { document: documentRef }), true);
  assert.equal(functionSearchDomGateIsAvailable("collapsedSettingsGate", { document: documentRef }), true);
  assert.equal(functionSearchDomGateIsAvailable("templateGate", { document: documentRef }), false);
  assert.equal(functionSearchDomGateIsAvailable("missingGate", { document: documentRef }), false);
  assert.equal(functionSearchDomGateIsAvailable("../unsafe", { document: documentRef }), false);
  assert.equal(functionSearchDomGateIsAvailable("visibleGate", { document: null }), false);

  const detached = new FakeElement({ id: "detachedGate" });
  detached.isConnected = false;
  documentRef.getElementById = (id) => id === "detachedGate" ? detached : null;
  assert.equal(functionSearchDomGateIsAvailable("detachedGate", { document: documentRef }), false);
});

test("Alle 102 Katalogziele lassen sich ausschließlich anhand ihrer stabilen IDs präsentieren", () => {
  assert.equal(FUNCTION_SEARCH_CATALOG.length, 102);
  for (const entry of FUNCTION_SEARCH_CATALOG) {
    const elements = [];
    const byId = new Map();
    for (const revealId of entry.target.revealIds || []) {
      const reveal = new FakeElement({ id: revealId, tagName: "DETAILS" });
      elements.push(reveal);
      byId.set(revealId, reveal);
    }
    let focus = byId.get(entry.target.focusId);
    if (!focus) {
      focus = new FakeElement({ id: entry.target.focusId });
      elements.push(focus);
    }
    const scheduled = [];
    const result = presentFunctionSearchTarget(entry.target, {
      document: fakeDocument(elements),
      setTimeout: (callback) => scheduled.push(callback),
    });
    assert.equal(result.ok, true, entry.id);
    assert.equal(focus.focusCalls.length, 1, entry.id);
    assert.equal(focus.scrollCalls.length, 1, entry.id);
    assert.equal(focus.classList.contains(HIGHLIGHT_CLASS), true, entry.id);
    result.cleanup();
    assert.equal(focus.classList.contains(HIGHLIGHT_CLASS), false, entry.id);
    scheduled.forEach((callback) => callback());
  }
});

test("Details und automatisch eingeklappte Einstellungskarten werden ohne Klick geöffnet", () => {
  const details = new FakeElement({ id: "detailsTarget", tagName: "DETAILS" });
  const card = new FakeElement({ id: "settingsCard", classes: ["settings-field-disclosure"] });
  const summary = card.append(new FakeElement({ tagName: "BUTTON", classes: ["settings-field-disclosure-summary"] }));
  const body = card.append(new FakeElement({ classes: ["settings-field-disclosure-body"], hidden: true }));
  const focus = body.append(new FakeElement({ id: "focusTarget", tagName: "INPUT" }));
  details.append(card);

  const result = presentFunctionSearchTarget({
    kind: "navigation",
    view: "settings",
    revealIds: ["detailsTarget"],
    focusId: "focusTarget",
  }, {
    document: fakeDocument([details, card, summary, body, focus]),
    setTimeout: () => 1,
  });

  assert.equal(result.ok, true);
  assert.equal(details.open, true);
  assert.equal(body.hidden, false);
  assert.equal(card.classList.contains("open"), true);
  assert.equal(summary.getAttribute("aria-expanded"), "true");
  assert.equal(focus.focusCalls.length, 1);
});

test("Verborgene, fehlende und ungültige Ziele bleiben fail-closed", () => {
  const hiddenParent = new FakeElement({ classes: ["hidden"] });
  const hiddenTarget = hiddenParent.append(new FakeElement({ id: "hiddenTarget" }));
  assert.equal(functionSearchTargetIsHidden(hiddenTarget), true);
  assert.equal(presentFunctionSearchTarget({ kind: "navigation", view: "planning", focusId: "hiddenTarget" }, {
    document: fakeDocument([hiddenTarget]),
  }).reason, "hidden-focus-target");
  assert.equal(hiddenTarget.focusCalls.length, 0);

  assert.equal(presentFunctionSearchTarget({ kind: "navigation", view: "planning", focusId: "missingTarget" }, {
    document: fakeDocument([]),
  }).reason, "missing-focus-target");
  assert.equal(presentFunctionSearchTarget({ kind: "action", focusId: "focusTarget" }, {
    document: fakeDocument([]),
  }).reason, "invalid-target");
  assert.equal(presentFunctionSearchTarget({ kind: "navigation", focusId: "focusTarget", revealIds: ["../unsafe"] }, {
    document: fakeDocument([]),
  }).reason, "invalid-reveal-target");
});

test("Deaktivierte Felder markieren das exakte Ziel und fokussieren den sicheren Strukturcontainer", () => {
  const card = new FakeElement({ id: "readOnlyCard", classes: ["settings-card"] });
  const target = card.append(new FakeElement({ id: "disabledField", tagName: "INPUT", disabled: true }));
  const result = presentFunctionSearchTarget({ kind: "navigation", view: "settings", focusId: "disabledField" }, {
    document: fakeDocument([card, target]),
    setTimeout: () => 1,
  });
  assert.equal(result.ok, true);
  assert.equal(target.scrollCalls.length, 1);
  assert.equal(target.focusCalls.length, 0);
  assert.equal(card.focusCalls.length, 1);
  assert.equal(card.getAttribute("tabindex"), "-1");
  result.cleanup();
  assert.equal(card.hasAttribute("tabindex"), false);
});

test("Scrollen respektiert reduzierte Bewegung und die Markierung räumt sich begrenzt auf", () => {
  const regular = new FakeElement({ id: "regularTarget" });
  const reduced = new FakeElement({ id: "reducedTarget" });
  const durations = [];
  presentFunctionSearchTarget({ kind: "navigation", view: "planning", focusId: "regularTarget" }, {
    document: fakeDocument([regular], false),
    highlightDuration: 9000,
    setTimeout: (_callback, duration) => durations.push(duration),
  });
  presentFunctionSearchTarget({ kind: "navigation", view: "planning", focusId: "reducedTarget" }, {
    document: fakeDocument([reduced], true),
    setTimeout: () => 1,
  });
  assert.equal(regular.scrollCalls[0].behavior, "smooth");
  assert.equal(reduced.scrollCalls[0].behavior, "auto");
  assert.deepEqual(durations, [6000]);
});

test("App setzt jede Zielart über bestehende sichere Zustandsfunktionen und prüft danach den Zielzustand", () => {
  assert.match(appSource, /setView\(target\.view\)/);
  assert.match(appSource, /setPersonnelAdministrationTab\(target\.personnelAdministrationTab\)/);
  assert.match(appSource, /setPersonnelTab\(target\.personnelTab\)/);
  assert.match(appSource, /setSettingsTab\(target\.settingsTab\)/);
  assert.match(appSource, /setRightsDashboardMode\(target\.dashboardMode\)/);
  assert.match(appSource, /setManagerRequestKindTab\(target\.requestKind\)/);
  assert.match(appSource, /restoreRememberedOverallContext\(target\.view\)/);
  assert.match(appSource, /if \(state\.currentView !== target\.view\) return false;/);
  assert.match(appSource, /if \(state\.personnelAdministrationTab !== target\.personnelAdministrationTab\) return false;/);
  assert.match(appSource, /if \(state\.rightsDashboardMode !== target\.dashboardMode\) return false;/);
});

test("Auswahl wird vor und nach Layoutwechsel erneut auf Zugriffsrechte geprüft", () => {
  const start = appSource.indexOf("async function navigateToFunctionSearchEntry");
  const end = appSource.indexOf("function handleFunctionSearchResultSelection", start);
  const navigationBlock = appSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(navigationBlock, /const entry = availableFunctionSearchNavigationEntry\(entryId\)/);
  assert.match(navigationBlock, /const currentEntry = availableFunctionSearchNavigationEntry\(entry\.id\)/);
  assert.match(navigationBlock, /if \(currentEntry !== entry \|\| state\.currentView !== entry\.target\.view\) return false;/);
  assert.match(navigationBlock, /closeMobileNavigation\(\{ restoreFocus: false \}\)/);
  assert.match(navigationBlock, /await waitForFunctionSearchTargetLayout\(\)/);
  assert.match(navigationBlock, /presentFunctionSearchTarget\(entry\.target/);
  assert.match(navigationBlock, /functionSearchController\?\.clear\(\)/);
  assert.doesNotMatch(navigationBlock, /\.click\s*\(|\.submit\s*\(|showModal\s*\(/);
  assert.match(appSource, /catalogApi\.availableFunctionSearchEntry\(entryId, functionSearchAccessOptions\(\)\)/);
  assert.match(appSource, /navigationApi\.functionSearchDomGateIsAvailable\(gateId, \{ document \}\)/);
});

test("Zielmarkierung ist sichtbar, scrollfest und bei reduzierter Bewegung statisch", () => {
  assert.match(stylesSource, /@keyframes function-search-target-pulse/);
  assert.match(stylesSource, /\.function-search-target-highlight \{[^}]*scroll-margin-block:96px 36px;[^}]*outline:3px solid var\(--coral\)/);
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\) \{\s*\.function-search-target-highlight \{ animation:none; \}/);
});

test("Navigationsskript lädt nach der UI und vor der Anwendung", () => {
  const uiScript = indexHtml.indexOf('<script src="/function-search-ui.js"></script>');
  const navigationScript = indexHtml.indexOf('<script src="/function-search-navigation.js"></script>');
  const appScript = indexHtml.indexOf('<script src="/app.js"></script>');
  assert.ok(uiScript >= 0 && navigationScript > uiScript && appScript > navigationScript);
});
