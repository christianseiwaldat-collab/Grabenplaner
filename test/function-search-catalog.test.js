const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  FUNCTION_SEARCH_CATALOG_VERSION,
  FUNCTION_SEARCH_CATALOG,
  validateFunctionSearchCatalog,
  functionSearchEntryIsAvailable,
  availableFunctionSearchEntries,
  availableFunctionSearchEntry,
} = require("../public/function-search-catalog");

const indexPath = path.join(__dirname, "..", "public", "index.html");
const indexHtml = fs.readFileSync(indexPath, "utf8");
const indexIds = new Set(Array.from(indexHtml.matchAll(/\sid="([^"]+)"/g), (match) => match[1]));
const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
Array.from(appSource.matchAll(/\.id\s*=\s*"([^"]+)"/g), (match) => match[1]).forEach((id) => indexIds.add(id));

test("Funktionskatalog ist versioniert, umfangreich und strukturell gültig", () => {
  assert.equal(FUNCTION_SEARCH_CATALOG_VERSION, 1);
  assert.ok(FUNCTION_SEARCH_CATALOG.length >= 85);
  assert.deepEqual(validateFunctionSearchCatalog(), { valid: true, errors: [] });

  const synonymCount = FUNCTION_SEARCH_CATALOG.reduce((sum, item) => sum + item.synonyms.length, 0);
  assert.ok(synonymCount >= FUNCTION_SEARCH_CATALOG.length * 6);
  assert.ok(FUNCTION_SEARCH_CATALOG.every((item) => item.path.length >= 2));
});

test("Katalog und verschachtelte Ziel- sowie Zugriffsdaten sind unveränderlich", () => {
  const first = FUNCTION_SEARCH_CATALOG[0];
  assert.equal(Object.isFrozen(FUNCTION_SEARCH_CATALOG), true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.path), true);
  assert.equal(Object.isFrozen(first.synonyms), true);
  assert.equal(Object.isFrozen(first.access), true);
  assert.equal(Object.isFrozen(first.access.gateIds), true);
  assert.equal(Object.isFrozen(first.target), true);
});

test("Berechtigungsfilter bleibt ohne bestätigte Sitzung und Gates fail-closed", () => {
  const allGateIds = new Set(FUNCTION_SEARCH_CATALOG.flatMap((item) => item.access.gateIds));

  assert.deepEqual(availableFunctionSearchEntries(), []);
  assert.deepEqual(availableFunctionSearchEntries({ authenticated: true }), []);
  assert.deepEqual(availableFunctionSearchEntries({ availableGateIds: allGateIds }), []);
  assert.equal(
    availableFunctionSearchEntries({ authenticated: true, availableGateIds: allGateIds }).length,
    FUNCTION_SEARCH_CATALOG.length,
  );
});

test("Ein Eintrag ist nur verfügbar, wenn jedes bestehende UI-Gate freigegeben ist", () => {
  const item = FUNCTION_SEARCH_CATALOG.find((candidate) => candidate.id === "planning.temporary-assignment");
  assert.ok(item);

  assert.equal(functionSearchEntryIsAvailable(item, {
    authenticated: true,
    availableGateIds: ["planningNavButton"],
  }), false);
  assert.equal(functionSearchEntryIsAvailable(item, {
    authenticated: true,
    availableGateIds: ["planningNavButton", "employeeLendingButton"],
  }), true);
  assert.equal(functionSearchEntryIsAvailable(item, {
    authenticated: true,
    isGateAvailable: (gateId) => gateId === "planningNavButton",
  }), false);
  assert.equal(functionSearchEntryIsAvailable(item, {
    authenticated: true,
    isGateAvailable: () => { throw new Error("unavailable"); },
  }), false);
});

test("Ein Ziel wird anhand seiner stabilen ID nur mit erneut bestätigtem Zugriff aufgelöst", () => {
  const item = FUNCTION_SEARCH_CATALOG.find((candidate) => candidate.id === "planning.xoffi-import");
  assert.ok(item);
  assert.equal(availableFunctionSearchEntry("planning.xoffi-import", {
    authenticated: true,
    availableGateIds: ["planningNavButton", "xoffiImportButton"],
  }), item);
  assert.equal(availableFunctionSearchEntry("planning.xoffi-import", {
    authenticated: true,
    availableGateIds: ["planningNavButton"],
  }), null);
  assert.equal(availableFunctionSearchEntry("planning.xoffi-import", { authenticated: false }), null);
  assert.equal(availableFunctionSearchEntry("unknown.target", {
    authenticated: true,
    isGateAvailable: () => true,
  }), null);
  assert.equal(availableFunctionSearchEntry(null, {
    authenticated: true,
    isGateAvailable: () => true,
  }), null);
});

test("Jedes Gate und jedes Feinziel verweist auf eine vorhandene stabile DOM-ID", () => {
  const missing = [];
  FUNCTION_SEARCH_CATALOG.forEach((item) => {
    const referencedIds = [
      ...item.access.gateIds,
      item.target.focusId,
      ...(item.target.revealIds || []),
    ];
    referencedIds.forEach((id) => {
      if (!indexIds.has(id)) missing.push(`${item.id}: ${id}`);
    });
  });
  assert.deepEqual(missing, []);
});

test("Ziele beschreiben ausschließlich Navigation und keine auszuführenden Aktionen", () => {
  const forbiddenTargetKeys = new Set(["action", "click", "event", "href", "method", "payload", "submit", "url", "value"]);
  FUNCTION_SEARCH_CATALOG.forEach((item) => {
    assert.equal(item.target.kind, "navigation");
    Object.keys(item.target).forEach((key) => assert.equal(forbiddenTargetKeys.has(key), false, `${item.id}: ${key}`));
  });
});

test("Validator weist doppelte IDs, unbekannte Aktionen und fehlende Gates zurück", () => {
  const valid = FUNCTION_SEARCH_CATALOG[0];
  const malformed = [
    valid,
    {
      ...valid,
      target: { ...valid.target, action: "submit" },
      access: { gateIds: [] },
    },
  ];
  const validation = validateFunctionSearchCatalog(malformed);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((message) => message.includes("id ist doppelt")));
  assert.ok(validation.errors.some((message) => message.includes("kein erlaubtes Navigationsfeld")));
  assert.ok(validation.errors.some((message) => message.includes("gateIds muss mindestens")));
});

test("Browser lädt den Katalog vor Suchoberfläche und Anwendung", () => {
  const catalogScript = indexHtml.indexOf('<script src="/function-search-catalog.js"></script>');
  const uiScript = indexHtml.indexOf('<script src="/function-search-ui.js"></script>');
  const navigationScript = indexHtml.indexOf('<script src="/function-search-navigation.js"></script>');
  const appScript = indexHtml.indexOf('<script src="/app.js"></script>');

  assert.ok(catalogScript >= 0);
  assert.ok(uiScript > catalogScript);
  assert.ok(navigationScript > uiScript);
  assert.ok(appScript > navigationScript);
  assert.equal(indexHtml.includes("functionSearchInput"), true);
  assert.equal(indexHtml.includes("functionSearchResults"), true);
});
