(function attachFunctionSearch(root, factory) {
  "use strict";

  const catalogApi = typeof module === "object" && module.exports
    ? require("./function-search-catalog")
    : root?.GrabenplanerFunctionSearchCatalog;
  const api = factory(catalogApi);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.GrabenplanerFunctionSearch = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createFunctionSearchModule(catalogApi) {
  "use strict";

  const FUNCTION_SEARCH_VERSION = 1;
  const DEFAULT_RESULT_LIMIT = 10;
  const MAX_RESULT_LIMIT = 25;
  const DEFAULT_MINIMUM_SCORE = 80;
  const DEFAULT_MINIMUM_RELATIVE_SCORE = 0.2;
  const MAX_QUERY_LENGTH = 160;
  const MAX_QUERY_UNITS = 10;
  const NOISE_TOKENS = new Set([
    "aendern", "am", "an", "anlegen", "anzeigen", "auf", "aufrufen", "bearbeiten", "bei", "bitte", "brauche",
    "das", "dem", "den", "der", "des", "die", "ein", "eine", "einem", "einen", "einer", "einrichten", "einstellen",
    "erstellen", "finde", "finden", "fuer", "funktion", "funktionen", "gibt", "hinzufuegen", "ich", "im", "in", "kann",
    "konfigurieren", "loeschen", "machen", "mit", "moechte", "neu", "neue", "neuen", "oder", "oeffne", "oeffnen",
    "seite", "speichern", "starten", "suchen", "und", "verwalten", "von", "will", "wo", "wie", "zeigen", "zu",
    "zum", "zur",
  ]);

  const FUNCTION_SEARCH_ALIAS_GROUPS = [
    { id: "employees", terms: ["MA", "Mitarbeiter", "Mitarbeitende", "Teammitglied", "Teammitglieder", "Employee", "Employees"] },
    { id: "branch-management", terms: ["FL", "Filialleitung", "Filialleiter", "Filialleiterin", "Standortleitung"] },
    { id: "department-management", terms: ["AL", "Abteilungsleitung", "Abteilungsleiter", "Abteilungsleiterin"] },
    { id: "human-resources", terms: ["PL", "Personalleitung", "Personalleiter", "Personalleiterin", "HR", "Human Resources"] },
    { id: "time-off", terms: ["ZA", "Zeitausgleich", "Freizeitausgleich", "Stundenabbau", "Time off"] },
    { id: "medical-certificate", terms: ["AUM", "Arbeitsunfähigkeitsmeldung", "Krankschreibung", "Attest", "Medical certificate"] },
    { id: "calendar-week", terms: ["KW", "Kalenderwoche", "Calendar week"] },
    { id: "collective-agreement", terms: ["KV", "Kollektivvertrag", "Tarifvertrag", "Collective agreement"] },
    { id: "privacy-law", terms: ["DSGVO", "Datenschutzgrundverordnung", "GDPR"] },
    { id: "database", terms: ["DB", "Datenbank", "Database", "SQLite"] },
    { id: "wireless", terms: ["WLAN", "WiFi", "Wi-Fi", "Wireless"] },
    { id: "payroll", terms: ["Lohnverrechnung", "Payroll", "Gehaltsabrechnung", "Lohnabrechnung"] },
    { id: "sales", terms: ["Verkauf", "Sales", "Umsatz", "Verkaufszahlen"] },
    { id: "vacation", terms: ["Urlaub", "Ferien", "Vacation", "Leave"] },
    { id: "schedule", terms: ["Dienstplan", "Schichtplan", "Einsatzplan", "Roster"] },
    { id: "settings", terms: ["Einstellungen", "Konfiguration", "Settings", "Configuration"] },
    { id: "permissions", terms: ["Rechte", "Berechtigung", "Berechtigungen", "Permissions", "Zugriffsrechte"] },
    { id: "request", terms: ["Antrag", "Ansuchen", "Request"] },
    { id: "backup", terms: ["Backup", "Sicherung", "Datensicherung"] },
    { id: "restore", terms: ["Restore", "Wiederherstellung", "Recovery"] },
    { id: "interface", terms: ["Schnittstelle", "Interface", "API"] },
    { id: "import", terms: ["Import", "Einlesen", "Datenübernahme"] },
    { id: "export", terms: ["Export", "Download", "Herunterladen"] },
    { id: "pdf", terms: ["PDF", "Druckansicht", "Print"] },
    { id: "ocr", terms: ["OCR", "Texterkennung", "Bilderkennung"] },
    { id: "offsite", terms: ["Offsite", "Externes Backup", "Remote Backup", "Cloud Backup"] },
    { id: "mobile", terms: ["Mobile", "Mobil", "Handy", "Smartphone"] },
    { id: "portal", terms: ["Portal", "Mitarbeiterportal", "Employee portal"] },
    { id: "location", terms: ["Filiale", "Standort", "Niederlassung", "Branch", "Location"] },
    { id: "department", terms: ["Abteilung", "Department", "Fachbereich"] },
    { id: "presence", terms: ["Anwesenheit", "Präsenz", "Presence", "Live-Status"] },
    { id: "sick-leave", terms: ["Krankenstand", "Krankmeldung", "Sick leave"] },
    { id: "loan", terms: ["Leihe", "Ausleihe", "Ausleihen", "Loan"] },
    { id: "order", terms: ["Bestellung", "Warenbestellung", "Order"] },
    { id: "workflow", terms: ["Workflow", "Prozessablauf", "Prozesskette"] },
    { id: "application", terms: ["Bewerbung", "Kandidatur", "Recruiting"] },
    { id: "cost-center", terms: ["Kostenstelle", "Cost center"] },
    { id: "rules", terms: ["Regelwerk", "Regelprofil", "Rules"] },
    { id: "trust-level", terms: ["Vertrauensstufe", "Trust level", "Kontrollstufe"] },
    { id: "greeting", terms: ["Begrüßung", "Greeting", "Willkommen"] },
    { id: "user-account", terms: ["Benutzerkonto", "User account", "Login", "Zugang"] },
    { id: "diagnostics", terms: ["Diagnose", "Diagnostics", "Systemcheck"] },
    { id: "usb", terms: ["USB", "USB-Stick", "Speicherstick"] },
    { id: "saturday", terms: ["Samstag", "Saturday"] },
    { id: "break", terms: ["Pause", "Break", "Ruhepause"] },
    { id: "branding", terms: ["Branding", "Corporate Design", "Firmenauftritt"] },
    { id: "time-correction", terms: ["Zeitkorrektur", "Stempelkorrektur", "Time correction"] },
    { id: "monthly-record", terms: ["Monatsnachweis", "Stundenzettel", "Timesheet"] },
    { id: "delegation", terms: ["Vertretung", "Stellvertretung", "Delegation"] },
    { id: "rule-check", terms: ["Regelprüfung", "Planprüfung", "Validation"] },
    { id: "vacation-balance", terms: ["Resturlaub", "Urlaubsguthaben", "Resttage", "Vacation balance"] },
    { id: "request-blackout", terms: ["Urlaubssperre", "Antragssperre", "Sperrzeitraum", "Blackout period"] },
    { id: "temporary-assignment", terms: ["Filialeinsatz", "Aushilfe", "Standortübergreifender Einsatz", "Temporary assignment"] },
    { id: "date-range", terms: ["Zeitraum", "Datumsbereich", "Date range"] },
    { id: "archive", terms: ["Archiv", "Historie", "History"] },
    { id: "server", terms: ["Server", "VPS", "Host"] },
    { id: "graphical-editor", terms: ["Grafischer Editor", "Prozesseditor", "Workflow editor"] },
    { id: "wage-code", terms: ["Lohnart", "Wage code", "Pay code"] },
    { id: "working-time", terms: ["Arbeitszeit", "Work time", "Working hours"] },
    { id: "time-balance", terms: ["Stundenkonto", "Zeitsaldo", "Time balance"] },
    { id: "start-view", terms: ["Startansicht", "Wiedereinstieg", "Letzte Ansicht"] },
    { id: "font-size", terms: ["Schriftgröße", "Textgröße", "Font size"] },
    { id: "opening-hours", terms: ["Öffnungszeiten", "Geschäftszeiten", "Opening hours"] },
    { id: "day-review", terms: ["Tagesprüfung", "Tageskontrolle", "Day review"] },
    { id: "personnel-record", terms: ["Personalakt", "Personalakte", "Personnel record"] },
    { id: "data-request", terms: ["Datenanfrage", "Datenauskunft", "Betroffenenanfrage", "Data subject request"] },
    { id: "retention", terms: ["Aufbewahrung", "Löschfrist", "Retention"] },
    { id: "business-unit", terms: ["Warengruppe", "Produktgruppe", "Product group"] },
  ];

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.getOwnPropertyNames(value).forEach((key) => deepFreeze(value[key]));
    return Object.freeze(value);
  }

  function normalizeFunctionSearchText(value) {
    return String(value ?? "")
      .slice(0, MAX_QUERY_LENGTH * 4)
      .toLocaleLowerCase("de-AT")
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " und ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function tokenizeFunctionSearchText(value) {
    const normalized = normalizeFunctionSearchText(value);
    if (!normalized) return [];
    return normalized.split(" ").filter(Boolean);
  }

  function buildAliasIndex(groups) {
    const aliases = new Map();
    let maximumWords = 1;
    groups.forEach((group) => {
      if (!group || typeof group.id !== "string" || !Array.isArray(group.terms) || group.terms.length < 2) {
        throw new Error("Eine Synonymgruppe der Funktionssuche ist ungültig.");
      }
      const terms = [];
      const groupTerms = new Set();
      group.terms.forEach((term) => {
        const normalized = normalizeFunctionSearchText(term);
        if (!normalized || groupTerms.has(normalized)) {
          throw new Error(`Synonymgruppe ${group.id} enthält einen leeren oder doppelten Begriff.`);
        }
        if (aliases.has(normalized)) {
          throw new Error(`Suchbegriff „${normalized}“ gehört zu mehreren Synonymgruppen.`);
        }
        groupTerms.add(normalized);
        terms.push(normalized);
        maximumWords = Math.max(maximumWords, normalized.split(" ").length);
      });
      const frozenTerms = Object.freeze(terms);
      terms.forEach((term) => aliases.set(term, frozenTerms));
    });
    return { aliases, maximumWords };
  }

  const aliasIndex = buildAliasIndex(FUNCTION_SEARCH_ALIAS_GROUPS);

  function expandedFunctionSearchQuery(value) {
    const normalized = normalizeFunctionSearchText(value).slice(0, MAX_QUERY_LENGTH);
    if (normalized.length < 2) return [];
    const tokens = normalized.split(" ").filter(Boolean);
    const units = [];
    let index = 0;
    while (index < tokens.length && units.length < MAX_QUERY_UNITS) {
      let phrase = "";
      let aliases = null;
      let consumed = 1;
      const maximumLength = Math.min(aliasIndex.maximumWords, tokens.length - index);
      for (let length = maximumLength; length >= 1; length -= 1) {
        const candidate = tokens.slice(index, index + length).join(" ");
        const candidateAliases = aliasIndex.aliases.get(candidate);
        if (candidateAliases) {
          phrase = candidate;
          aliases = candidateAliases;
          consumed = length;
          break;
        }
      }
      if (!phrase) phrase = tokens[index];
      index += consumed;
      if (!aliases && NOISE_TOKENS.has(phrase)) continue;
      units.push(Object.freeze({
        query: phrase,
        terms: aliases || Object.freeze([phrase]),
      }));
    }
    return Object.freeze(units);
  }

  function damerauLevenshteinDistance(leftValue, rightValue, maximum = Number.POSITIVE_INFINITY) {
    const left = String(leftValue || "");
    const right = String(rightValue || "");
    if (left === right) return 0;
    if (!left) return right.length;
    if (!right) return left.length;
    if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
    let previousPrevious = null;
    let previous = Array.from({ length: right.length + 1 }, (_item, position) => position);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const current = [leftIndex];
      let rowMinimum = current[0];
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
        let distance = Math.min(
          current[rightIndex - 1] + 1,
          previous[rightIndex] + 1,
          previous[rightIndex - 1] + substitutionCost,
        );
        if (
          previousPrevious
          && leftIndex > 1
          && rightIndex > 1
          && left[leftIndex - 1] === right[rightIndex - 2]
          && left[leftIndex - 2] === right[rightIndex - 1]
        ) {
          distance = Math.min(distance, previousPrevious[rightIndex - 2] + 1);
        }
        current[rightIndex] = distance;
        rowMinimum = Math.min(rowMinimum, distance);
      }
      if (rowMinimum > maximum) return maximum + 1;
      previousPrevious = previous;
      previous = current;
    }
    return previous[right.length];
  }

  function fuzzyMaximum(term) {
    if (term.length < 4) return 0;
    if (term.length < 9) return 1;
    return 2;
  }

  function createIndexedField(kind, value, weight) {
    const normalized = normalizeFunctionSearchText(value);
    if (!normalized) return null;
    return Object.freeze({
      kind,
      normalized,
      tokens: Object.freeze(normalized.split(" ").filter(Boolean)),
      weight,
    });
  }

  function createFunctionSearchIndex(entries) {
    if (!Array.isArray(entries)) return Object.freeze([]);
    const seen = new Set();
    const indexed = [];
    entries.forEach((item) => {
      if (!item || typeof item.id !== "string" || seen.has(item.id)) return;
      if (!Array.isArray(item.path) || !Array.isArray(item.synonyms)) return;
      seen.add(item.id);
      const fields = [];
      const addField = (kind, value, weight) => {
        const field = createIndexedField(kind, value, weight);
        if (field) fields.push(field);
      };
      addField("label", item.label, 180);
      item.path.forEach((segment) => addField("path", segment, 145));
      addField("path", item.path.join(" "), 135);
      item.synonyms.forEach((synonym) => addField("synonym", synonym, 120));
      addField("description", item.description, 48);
      addField("id", item.id.replace(/[.-]/g, " "), 30);
      indexed.push(Object.freeze({ entry: item, fields: Object.freeze(fields) }));
    });
    return Object.freeze(indexed);
  }

  function phraseScore(term, field) {
    if (field.normalized === term) return { score: field.weight * 4, kind: "exact" };
    if (term.length >= 3 && field.normalized.startsWith(`${term} `)) return { score: field.weight * 3.1, kind: "phrase-prefix" };
    if (term.length >= 3 && field.normalized.endsWith(` ${term}`)) return { score: field.weight * 2.8, kind: "phrase-suffix" };
    if (term.length >= 3 && field.normalized.includes(` ${term} `)) return { score: field.weight * 2.65, kind: "phrase" };
    if (term.length >= 4 && field.normalized.includes(term)) return { score: field.weight * 2.2, kind: "substring" };
    return { score: 0, kind: "none" };
  }

  function tokenScore(term, field) {
    if (term.includes(" ")) return { score: 0, kind: "none" };
    let best = { score: 0, kind: "none" };
    const maximumDistance = fuzzyMaximum(term);
    field.tokens.forEach((token) => {
      let candidate = { score: 0, kind: "none" };
      if (token === term) {
        candidate = { score: field.weight * 1.8, kind: "token" };
      } else if (term.length >= 3 && token.startsWith(term)) {
        candidate = { score: field.weight * 1.35, kind: "prefix" };
      } else if (token.length >= 6 && term.startsWith(token) && token.length / term.length >= 0.65) {
        candidate = { score: field.weight * 1.1, kind: "expanded-prefix" };
      } else if (term.length >= 4 && token.includes(term)) {
        candidate = { score: field.weight, kind: "compound" };
      } else if (token.length >= 5 && term.includes(token) && token.length / term.length >= 0.45) {
        candidate = { score: field.weight * 0.86, kind: "expanded-compound" };
      } else if (maximumDistance > 0 && Math.abs(token.length - term.length) <= maximumDistance) {
        const distance = damerauLevenshteinDistance(term, token, maximumDistance);
        if (distance <= maximumDistance) {
          candidate = { score: field.weight * (distance === 1 ? 0.82 : 0.62), kind: "fuzzy" };
        }
      }
      if (candidate.score > 0 && field.tokens.length > 1) candidate.score *= 0.97;
      if (candidate.score > best.score) best = candidate;
    });
    return best;
  }

  function bestUnitScore(unit, fields) {
    let best = { score: 0, field: "", kind: "none", term: "" };
    unit.terms.forEach((term) => {
      const aliasFactor = term === unit.query ? 1 : 0.86;
      fields.forEach((field) => {
        const phrase = phraseScore(term, field);
        const token = tokenScore(term, field);
        const candidate = phrase.score >= token.score ? phrase : token;
        const score = candidate.score * aliasFactor;
        if (score > best.score) best = { score, field: field.kind, kind: candidate.kind, term };
      });
    });
    return best;
  }

  function fullQueryBonus(normalizedQuery, fields) {
    let bonus = 0;
    fields.forEach((field) => {
      if (field.normalized === normalizedQuery) {
        const factor = field.kind === "label" ? 5.8 : field.kind === "path" ? 4.8 : field.kind === "synonym" ? 4.4 : 1.6;
        bonus = Math.max(bonus, field.weight * factor);
      } else if (normalizedQuery.length >= 4 && field.normalized.startsWith(normalizedQuery)) {
        const factor = field.kind === "label" ? 3.6 : field.kind === "path" ? 3 : field.kind === "synonym" ? 2.7 : 1.2;
        bonus = Math.max(bonus, field.weight * factor);
      } else if (normalizedQuery.length >= 5 && field.normalized.includes(normalizedQuery)) {
        const factor = field.kind === "label" ? 2.4 : field.kind === "path" ? 2.1 : field.kind === "synonym" ? 2 : 0.8;
        bonus = Math.max(bonus, field.weight * factor);
      }
    });
    return bonus;
  }

  function normalizedLimit(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_RESULT_LIMIT;
    return Math.min(MAX_RESULT_LIMIT, Math.max(1, Math.floor(numeric)));
  }

  function boundedNumber(value, fallback, minimum, maximum) {
    if (value === undefined || value === null || value === "") return fallback;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(maximum, Math.max(minimum, numeric));
  }

  function searchFunctionEntries(query, entries, options = {}) {
    const normalizedQuery = normalizeFunctionSearchText(query).slice(0, MAX_QUERY_LENGTH);
    const units = expandedFunctionSearchQuery(normalizedQuery);
    if (!units.length || !Array.isArray(entries) || !entries.length) return [];
    const index = createFunctionSearchIndex(entries);
    const results = [];
    index.forEach((indexedItem) => {
      const matches = units.map((unit) => bestUnitScore(unit, indexedItem.fields));
      if (matches.some((match) => match.score <= 0)) return;
      const unitScore = matches.reduce((sum, match) => sum + match.score, 0);
      const weakestScore = Math.min(...matches.map((match) => match.score));
      const allInStrongFields = matches.every((match) => ["label", "path", "synonym"].includes(match.field));
      const score = unitScore
        + fullQueryBonus(normalizedQuery, indexedItem.fields)
        + (units.length > 1 && allInStrongFields ? 90 : 0)
        + (weakestScore * 0.12);
      const strongest = matches.slice().sort((left, right) => right.score - left.score)[0];
      results.push(Object.freeze({
        id: indexedItem.entry.id,
        entry: indexedItem.entry,
        score: Math.round(score),
        matchedTerms: Object.freeze(matches.map((match) => match.term)),
        strongestField: strongest.field,
        strongestMatch: strongest.kind,
      }));
    });
    const sorted = results.sort((left, right) => right.score - left.score
        || left.entry.label.localeCompare(right.entry.label, "de-AT", { sensitivity: "base" })
        || left.id.localeCompare(right.id, "de-AT"));
    const minimumScore = boundedNumber(options.minimumScore, DEFAULT_MINIMUM_SCORE, 0, 10000);
    const relativeScore = boundedNumber(options.minimumRelativeScore, DEFAULT_MINIMUM_RELATIVE_SCORE, 0, 1);
    const relevanceFloor = Math.max(minimumScore, (sorted[0]?.score || 0) * relativeScore);
    return sorted
      .filter((result) => result.score >= relevanceFloor)
      .slice(0, normalizedLimit(options.limit));
  }

  function searchAvailableFunctions(query, accessOptions = {}, searchOptions = {}) {
    if (typeof catalogApi?.availableFunctionSearchEntries !== "function") return [];
    const availableEntries = catalogApi.availableFunctionSearchEntries(accessOptions);
    return searchFunctionEntries(query, availableEntries, searchOptions);
  }

  deepFreeze(FUNCTION_SEARCH_ALIAS_GROUPS);

  return Object.freeze({
    FUNCTION_SEARCH_VERSION,
    FUNCTION_SEARCH_ALIAS_GROUPS,
    normalizeFunctionSearchText,
    tokenizeFunctionSearchText,
    expandedFunctionSearchQuery,
    damerauLevenshteinDistance,
    createFunctionSearchIndex,
    searchFunctionEntries,
    searchAvailableFunctions,
  });
}));
