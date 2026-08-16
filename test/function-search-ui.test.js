const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  FUNCTION_SEARCH_UI_VERSION,
  nextFunctionSearchActiveIndex,
  functionSearchOptionId,
  createFunctionSearchUi,
} = require("../public/function-search-ui");

const publicPath = path.join(__dirname, "..", "public");
const indexHtml = fs.readFileSync(path.join(publicPath, "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(publicPath, "styles.css"), "utf8");
const appSource = fs.readFileSync(path.join(publicPath, "app.js"), "utf8");
const uiSource = fs.readFileSync(path.join(publicPath, "function-search-ui.js"), "utf8");

test("Block-3-UI ist versioniert und validiert ihre zwingenden Anschlüsse", () => {
  assert.equal(FUNCTION_SEARCH_UI_VERSION, 1);
  assert.equal(typeof createFunctionSearchUi, "function");
  assert.throws(() => createFunctionSearchUi(), /benötigt Eingabe/);
  assert.equal(functionSearchOptionId("settings.backup & restore"), "function-search-option-settings-backup-restore");
  assert.ok(functionSearchOptionId("x".repeat(200)).length <= 113);
});

test("Tastaturindex bleibt für Pfeile, Start und Ende deterministisch begrenzt", () => {
  assert.equal(nextFunctionSearchActiveIndex(-1, 3, "ArrowDown"), 0);
  assert.equal(nextFunctionSearchActiveIndex(-1, 3, "ArrowUp"), 2);
  assert.equal(nextFunctionSearchActiveIndex(0, 3, "ArrowUp"), 0);
  assert.equal(nextFunctionSearchActiveIndex(2, 3, "ArrowDown"), 2);
  assert.equal(nextFunctionSearchActiveIndex(2, 3, "Home"), 0);
  assert.equal(nextFunctionSearchActiveIndex(0, 3, "End"), 2);
  assert.equal(nextFunctionSearchActiveIndex(0, 0, "ArrowDown"), -1);
});

test("Suchfeld steht semantisch direkt unter der angemeldeten Person und vor der Hauptnavigation", () => {
  const sessionIndex = indexHtml.indexOf('id="sidebarSessionInfo"');
  const searchIndex = indexHtml.indexOf('id="functionSearch"');
  const navigationIndex = indexHtml.indexOf('<nav class="main-nav"');
  assert.ok(sessionIndex >= 0 && searchIndex > sessionIndex && navigationIndex > searchIndex);

  assert.match(indexHtml, /<section class="function-search hidden" id="functionSearch" aria-label="Funktionen durchsuchen">/);
  assert.match(indexHtml, /<label class="visually-hidden" for="functionSearchInput">Funktion suchen<\/label>/);
  assert.match(indexHtml, /id="functionSearchInput"[\s\S]*?type="search"[\s\S]*?role="combobox"/);
  assert.match(indexHtml, /placeholder="Suche"/);
  assert.match(indexHtml, /aria-autocomplete="list"/);
  assert.match(indexHtml, /aria-controls="functionSearchResults"/);
  assert.match(indexHtml, /aria-expanded="false"/);
  assert.match(indexHtml, /id="functionSearchStatus" role="status" aria-live="polite"/);
  assert.match(indexHtml, /id="functionSearchResults" role="listbox"/);
});

test("UI-Skript lädt zwischen Suchlogik und App und erzeugt Treffer ohne HTML-Injektion", () => {
  const catalogScript = indexHtml.indexOf('/function-search-catalog.js');
  const searchScript = indexHtml.indexOf('/function-search.js');
  const uiScript = indexHtml.indexOf('/function-search-ui.js');
  const navigationScript = indexHtml.indexOf('/function-search-navigation.js');
  const appScript = indexHtml.indexOf('/app.js');
  assert.ok(catalogScript < searchScript && searchScript < uiScript && uiScript < navigationScript && navigationScript < appScript);

  assert.match(uiSource, /documentRef\.createElement\("button"\)/);
  assert.match(uiSource, /label\.textContent = result\?\.entry\?\.label/);
  assert.match(uiSource, /path\.textContent = Array\.isArray/);
  assert.doesNotMatch(uiSource, /\.innerHTML\s*=/);
});

test("Treffer-Popover ist platzsparend, scrollbar, fokussiert und mobil berührbar", () => {
  assert.match(stylesSource, /\.function-search \{[^}]*position:relative;[^}]*flex:0 0 auto;/);
  assert.match(stylesSource, /\.function-search-field:focus-within \{/);
  assert.match(stylesSource, /\.function-search-popover \{[^}]*position:absolute;[^}]*max-height:clamp\([^}]*overflow-y:auto;/);
  assert.match(stylesSource, /\.function-search-option:hover,\.function-search-option\[aria-selected="true"\]/);

  const mobileStyles = stylesSource.slice(
    stylesSource.indexOf("@media (max-width: 820px)"),
    stylesSource.indexOf("@media (max-width: 600px)"),
  );
  assert.match(mobileStyles, /\.function-search-field \{ min-height:46px;/);
  assert.match(mobileStyles, /\.function-search input \{ height:44px;/);
  assert.match(mobileStyles, /\.function-search-option \{ min-height:54px;/);
  assert.match(mobileStyles, /\.function-search-popover \{ max-height:clamp\(180px,48dvh,400px\);/);
});

test("App filtert Treffer fail-closed über Sitzung und sämtliche projizierten UI-Gates", () => {
  assert.match(appSource, /state\.portalSession\?\.authenticated === true/);
  assert.match(appSource, /!document\.body\.classList\.contains\("portal-locked"\)/);
  assert.match(appSource, /function functionSearchAccessOptions\(\) \{[\s\S]*?authenticated: functionSearchIsAuthenticated\(\),[\s\S]*?isGateAvailable: functionSearchGateAvailable/);
  assert.match(appSource, /searchApi\.searchAvailableFunctions\(query, functionSearchAccessOptions\(\), \{ limit: 8 \}\)/);
  assert.match(appSource, /window\.GrabenplanerFunctionSearchNavigation/);
  assert.match(appSource, /navigationApi\.functionSearchDomGateIsAvailable\(gateId, \{ document \}\)/);
  assert.doesNotMatch(appSource, /FUNCTION_SEARCH_CATALOG/);
  assert.doesNotMatch(appSource, /availableGateIds/);
});

test("Treffer-UI bleibt navigationsneutral und gibt ausschließlich die stabile ID an Block 4 weiter", () => {
  assert.match(appSource, /new CustomEvent\("grabenplaner:function-search-result-selected"/);
  assert.match(appSource, /detail: Object\.freeze\(\{ id: entry\.id \}\)/);
  assert.equal((appSource.match(/grabenplaner:function-search-result-selected/g) || []).length, 2);
  assert.match(appSource, /addEventListener\("grabenplaner:function-search-result-selected", handleFunctionSearchResultSelection\)/);
  assert.doesNotMatch(uiSource, /\bsetView\s*\(/);
  assert.doesNotMatch(uiSource, /entry\??\.target|result\??\.entry\??\.target/);
  assert.doesNotMatch(uiSource, /\.click\s*\(|\.submit\s*\(|location\.(?:assign|replace)/);
});

test("Tastaturbedienung umfasst Treffersteuerung, Schließen und globalen Suchfokus", () => {
  assert.match(uiSource, /\["ArrowDown", "ArrowUp", "Home", "End"\]/);
  assert.match(uiSource, /event\.key === "Enter"/);
  assert.match(uiSource, /event\.key === "Escape"/);
  assert.match(uiSource, /input\.setAttribute\("aria-activedescendant", activeOption\.id\)/);
  assert.match(appSource, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(appSource, /mobileNavigationMedia\.matches\) openMobileNavigation\(\)/);
  assert.match(appSource, /document\.addEventListener\("keydown", focusFunctionSearchFromShortcut\)/);
});
