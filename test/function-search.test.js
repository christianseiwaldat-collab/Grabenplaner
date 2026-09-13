const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const catalogApi = require("../public/function-search-catalog");
const {
  FUNCTION_SEARCH_VERSION,
  FUNCTION_SEARCH_ALIAS_GROUPS,
  normalizeFunctionSearchText,
  tokenizeFunctionSearchText,
  expandedFunctionSearchQuery,
  damerauLevenshteinDistance,
  createFunctionSearchIndex,
  searchFunctionEntries,
  searchAvailableFunctions,
} = require("../public/function-search");

const allGateIds = new Set(catalogApi.FUNCTION_SEARCH_CATALOG.flatMap((item) => item.access.gateIds));
const fullAccess = { authenticated: true, availableGateIds: allGateIds };

function resultIds(query, access = fullAccess, options = {}) {
  return searchAvailableFunctions(query, access, options).map((result) => result.id);
}

test("Suchlogik ist versioniert und besitzt einen umfangreichen unveränderlichen Aliasbestand", () => {
  assert.equal(FUNCTION_SEARCH_VERSION, 1);
  assert.ok(FUNCTION_SEARCH_ALIAS_GROUPS.length >= 65);
  assert.ok(FUNCTION_SEARCH_ALIAS_GROUPS.reduce((sum, group) => sum + group.terms.length, 0) >= 225);
  assert.equal(Object.isFrozen(FUNCTION_SEARCH_ALIAS_GROUPS), true);
  assert.equal(Object.isFrozen(FUNCTION_SEARCH_ALIAS_GROUPS[0]), true);
  assert.equal(Object.isFrozen(FUNCTION_SEARCH_ALIAS_GROUPS[0].terms), true);
});

test("Normalisierung behandelt Großschreibung, Umlaute, Eszett, Trennzeichen und ASCII-Eingaben einheitlich", () => {
  assert.equal(
    normalizeFunctionSearchText("  Persönliche Begrüßungen & Wi-Fi / Größe  "),
    "persoenliche begruessungen und wi fi groesse",
  );
  assert.equal(normalizeFunctionSearchText("Straße"), "strasse");
  assert.deepEqual(tokenizeFunctionSearchText("ZA / Urlaub"), ["za", "urlaub"]);
});

test("Abkürzungen, deutsche Begriffe und mehrteilige englische Synonyme werden zu Suchgruppen erweitert", () => {
  const units = expandedFunctionSearchQuery("Bitte ZA für MA");
  assert.deepEqual(units.map((unit) => unit.query), ["za", "ma"]);
  assert.ok(units[0].terms.includes("zeitausgleich"));
  assert.ok(units[1].terms.includes("mitarbeitende"));

  const humanResources = expandedFunctionSearchQuery("Human Resources Einstellungen");
  assert.deepEqual(humanResources.map((unit) => unit.query), ["human resources", "einstellungen"]);
  assert.ok(humanResources[0].terms.includes("personalleitung"));
});

test("Damerau-Levenshtein erkennt einfache Tippfehler und Buchstabendreher begrenzt", () => {
  assert.equal(damerauLevenshteinDistance("urlab", "urlaub", 1), 1);
  assert.equal(damerauLevenshteinDistance("kalneder", "kalender", 1), 1);
  assert.equal(damerauLevenshteinDistance("backup", "backup", 1), 0);
  assert.ok(damerauLevenshteinDistance("abcdef", "uvwxyz", 1) > 1);
});

test("Präzise deutsche Suchen, Abkürzungen und Fachbegriffe liefern das richtige Feinziel zuerst", () => {
  const cases = new Map([
    ["ZA Sperre", "vacation.request-blackouts"],
    ["KW Regelprüfung", "planning.rule-assessment"],
    ["xoffi Stundenkonto", "planning.xoffi-import"],
    ["Mitarbeiter importieren", "settings.personnel-import"],
    ["FL Vertretung", "settings.vacation-delegation"],
    ["KV", "personnel.collective-agreements"],
    ["TradeFoto PDF", "sales.report-import"],
    ["DB Sicherung", "settings.database-backups"],
    ["ACCDB", "settings.database-imports"],
    ["persoenliche begruessungen", "settings.greetings"],
    ["mobile Leitung", "settings.mobile-leadership"],
    ["Lohnverrechnung Export", "settings.payroll-export"],
    ["grafischer workflow editor", "personnel.lifecycle-editor"],
  ]);
  cases.forEach((expected, query) => assert.equal(resultIds(query)[0], expected, query));
});

test("Jede exakte Funktionsbezeichnung gewinnt gegen alle anderen Katalogziele", () => {
  catalogApi.FUNCTION_SEARCH_CATALOG.forEach((item) => {
    assert.equal(resultIds(item.label, fullAccess, { limit: 5 })[0], item.id, item.label);
  });
});

test("Jedes katalogisierte Synonym ist für sein eigenes Funktionsziel tatsächlich suchbar", () => {
  catalogApi.FUNCTION_SEARCH_CATALOG.forEach((item) => {
    item.synonyms.forEach((synonym) => {
      const results = searchFunctionEntries(synonym, [item], { limit: 1 });
      assert.equal(results[0]?.id, item.id, `${item.id}: ${synonym}`);
    });
  });
});

test("Natürliche Suchsätze ignorieren reine Bedienwörter, behalten aber die fachliche Absicht", () => {
  const cases = new Map([
    ["Wo kann ich ZA sperren?", "vacation.request-blackouts"],
    ["Ich möchte Mitarbeiter importieren", "settings.personnel-import"],
    ["Neue Antragssperre anlegen", "vacation.request-blackouts"],
    ["Passwort zurücksetzen", "settings.portal-users"],
    ["Backup erstellen", "settings.database-backups"],
  ]);
  cases.forEach((expected, query) => assert.equal(resultIds(query)[0], expected, query));
});

test("Tippfehler bleiben fehlertolerant, ohne die Rangfolge gleich guter Ziele zufällig zu machen", () => {
  assert.equal(resultIds("Urlabskalender")[0], "vacation.overview");
  assert.equal(resultIds("Mitarbeitr import")[0], "settings.personnel-import");

  const first = resultIds("Wiederherstellung", fullAccess, { limit: 10 });
  const second = resultIds("Wiederherstellung", fullAccess, { limit: 10 });
  assert.deepEqual(first, second);
  assert.deepEqual(first.slice(0, 3), [
    "settings.restore-guidance",
    "settings.database-backups",
    "settings.backup-import",
  ]);
});

test("Mehrwortsuche verlangt für jeden relevanten Suchbegriff einen Treffer", () => {
  const ids = resultIds("TradeFoto PDF", fullAccess, { limit: 10 });
  assert.deepEqual(ids, ["sales.report-import", "sales.pdf-analytics", "sales.report-archive"]);
  assert.equal(ids.includes("settings.pdf"), false);
  assert.equal(ids.includes("settings.loans"), false);
});

test("Relevanzschwelle entfernt schwache Teilworttreffer, kann für Diagnosen aber abgesenkt werden", () => {
  const precise = resultIds("Urlaubssperre", fullAccess, { limit: 25 });
  assert.deepEqual(precise, ["vacation.request-blackouts"]);

  const diagnostic = resultIds("Urlaubssperre", fullAccess, {
    limit: 25,
    minimumScore: 0,
    minimumRelativeScore: 0,
  });
  assert.ok(diagnostic.length > precise.length);
});

test("Leere, einstellige oder reine Bedienphrasen liefern keine Treffer", () => {
  for (const query of ["", " ", "x", "bitte öffnen", "wo finde ich die funktion"]) {
    assert.deepEqual(resultIds(query), [], query);
  }
});

test("Suchergebnisse sind begrenzt und enthalten unveränderte Katalogeinträge samt Matchmetadaten", () => {
  const results = searchAvailableFunctions("Einstellungen", fullAccess, { limit: 3 });
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => Object.isFrozen(result)));
  assert.ok(results.every((result) => Object.isFrozen(result.matchedTerms)));
  assert.ok(results.every((result) => result.entry === catalogApi.FUNCTION_SEARCH_CATALOG.find((item) => item.id === result.id)));
  assert.ok(results.every((result) => Number.isInteger(result.score) && result.score > 0));
});

test("Index überspringt ungültige und doppelte Einträge, ohne den Eingabekatalog zu verändern", () => {
  const source = catalogApi.FUNCTION_SEARCH_CATALOG.slice(0, 2);
  const duplicate = { ...source[0] };
  const malformed = { id: "broken", label: "Defekt" };
  const index = createFunctionSearchIndex([...source, duplicate, malformed]);

  assert.equal(index.length, 2);
  assert.equal(index[0].entry, source[0]);
  assert.equal(Object.isFrozen(index), true);
  assert.equal(source.length, 2);
});

test("Low-Level-Suche gibt ausschließlich Einträge aus der übergebenen Teilmenge zurück", () => {
  const subset = catalogApi.FUNCTION_SEARCH_CATALOG.filter((item) => item.id === "vacation.request-blackouts");
  const results = searchFunctionEntries("Urlaub", subset, { limit: 25 });
  assert.deepEqual(results.map((result) => result.id), ["vacation.request-blackouts"]);
});

test("Berechtigte Suche bleibt ohne Sitzung oder vollständige Gates fail-closed", () => {
  assert.deepEqual(searchAvailableFunctions("xoffi", {}, { limit: 25 }), []);
  assert.deepEqual(searchAvailableFunctions("xoffi", { availableGateIds: allGateIds }, { limit: 25 }), []);
  assert.deepEqual(searchAvailableFunctions("xoffi", {
    authenticated: true,
    availableGateIds: ["planningNavButton"],
  }, { limit: 25 }), []);
  assert.deepEqual(resultIds("xoffi", {
    authenticated: true,
    availableGateIds: ["planningNavButton", "xoffiImportButton"],
  }), ["planning.xoffi-import"]);
});

test("Browser lädt Katalog, Suchlogik und Suchoberfläche in sicherer Reihenfolge vor app.js", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const catalogScript = html.indexOf('<script src="/function-search-catalog.js"></script>');
  const searchScript = html.indexOf('<script src="/function-search.js"></script>');
  const uiScript = html.indexOf('<script src="/function-search-ui.js"></script>');
  const navigationScript = html.indexOf('<script src="/function-search-navigation.js"></script>');
  const appScript = html.indexOf('<script src="/app.js"></script>');

  assert.ok(catalogScript >= 0);
  assert.ok(searchScript > catalogScript);
  assert.ok(uiScript > searchScript);
  assert.ok(navigationScript > uiScript);
  assert.ok(appScript > navigationScript);
  assert.equal(html.includes("functionSearchInput"), true);
  assert.equal(html.includes("functionSearchResults"), true);
});
