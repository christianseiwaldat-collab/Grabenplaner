"use strict";

const TIME_ZONE = "Europe/Vienna";
const DAY_MS = 24 * 60 * 60 * 1000;
const TEMPLATE_GROUPS = Object.freeze([
  "morning",
  "daytime",
  "evening",
  "vacationReturn",
  "sicknessActive",
  "sicknessReturn",
]);

const DEFAULT_TEMPLATES = Object.freeze({
  morning: Object.freeze([
    "Guten Morgen, {name}! Ich wünsche dir einen angenehmen Start in den Arbeitstag.",
    "{greeting}, {name}! Schön, dass du da bist.",
    "Einen guten Morgen, {name}, und einen gelungenen Start in den Tag!",
  ]),
  daytime: Object.freeze([
    "Hallo, {name}! Ich wünsche dir einen angenehmen Arbeitstag.",
    "Schön, dass du da bist, {name}. Hab einen guten Tag!",
    "Willkommen, {name}! Ich wünsche dir einen gelungenen Tag.",
  ]),
  evening: Object.freeze([
    "Guten Abend, {name}! Ich wünsche dir einen angenehmen Dienst.",
    "Schön, dass du da bist, {name}. Komm gut durch den Abend!",
    "Willkommen, {name}! Ich wünsche dir einen guten weiteren Arbeitstag.",
  ]),
  vacationReturn: Object.freeze([
    "Willkommen zurück, {name}! Ich wünsche dir einen entspannten und guten Wiedereinstieg.",
    "Schön, dass du wieder da bist, {name}. Starte gut und in deinem Tempo in den Tag.",
    "Willkommen zurück, {name}! Ich wünsche dir einen angenehmen ersten Arbeitstag.",
  ]),
  sicknessActive: Object.freeze([
    "Für heute wünschen wir dir gute Erholung und alles Gute, {name}.",
    "Nimm dir die nötige Ruhe, {name}. Wir wünschen dir alles Gute.",
    "Wir wünschen dir für heute viel Ruhe und gute Erholung, {name}.",
  ]),
  sicknessReturn: Object.freeze([
    "Schön, dass du wieder da bist, {name}. Starte gut und in deinem Tempo in den Tag.",
    "Willkommen zurück, {name}! Ich wünsche dir einen angenehmen Wiedereinstieg.",
    "Alles Gute für deinen heutigen Wiedereinstieg, {name}, und einen angenehmen Tag.",
  ]),
});

const DEFAULT_PORTAL_GREETING_SETTINGS = Object.freeze({
  enabled: false,
  vacationMinimumCalendarDays: 14,
  vacationReturnWorkdays: 3,
  sicknessReturnWorkdays: 2,
  templates: DEFAULT_TEMPLATES,
});

class PortalGreetingValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PortalGreetingValidationError";
    this.code = code;
  }
}

function validationError(message, code) {
  return new PortalGreetingValidationError(message, code);
}

function booleanSetting(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  throw validationError(`${label} muss aktiviert oder deaktiviert sein.`, "PORTAL_GREETING_BOOLEAN_INVALID");
}

function integerSetting(value, fallback, { label, minimum, maximum }) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw validationError(
      `${label} muss eine ganze Zahl zwischen ${minimum} und ${maximum} sein.`,
      "PORTAL_GREETING_NUMBER_INVALID",
    );
  }
  return parsed;
}

function normalizedTemplate(value, group, index) {
  if (typeof value !== "string") {
    throw validationError(
      `Vorlage ${index + 1} in ${group} muss Text enthalten.`,
      "PORTAL_GREETING_TEMPLATE_INVALID",
    );
  }
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > 240 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw validationError(
      `Vorlage ${index + 1} in ${group} muss zwischen 1 und 240 Zeichen enthalten.`,
      "PORTAL_GREETING_TEMPLATE_INVALID",
    );
  }
  const unsupportedPlaceholder = [...text.matchAll(/\{([^}]+)\}/gu)]
    .some((match) => !["name", "greeting"].includes(match[1]));
  if (/\{\{|\}\}|\$\{|%[a-z]/iu.test(text) || unsupportedPlaceholder || /(^|[^\w])\{(?!name\}|greeting\})/u.test(text)) {
    throw validationError(
      `Vorlage ${index + 1} in ${group} darf nur {name} und {greeting} als Platzhalter enthalten.`,
      "PORTAL_GREETING_TEMPLATE_PLACEHOLDER_INVALID",
    );
  }
  return text;
}

function normalizeTemplates(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw validationError("Begrüßungsvorlagen müssen gruppiert angegeben werden.", "PORTAL_GREETING_TEMPLATES_INVALID");
  }
  const templates = {};
  for (const group of TEMPLATE_GROUPS) {
    const source = input[group] === undefined ? DEFAULT_TEMPLATES[group] : input[group];
    if (!Array.isArray(source) || source.length < 1 || source.length > 20) {
      throw validationError(
        `${group} muss zwischen 1 und 20 Vorlagen enthalten.`,
        "PORTAL_GREETING_TEMPLATE_GROUP_INVALID",
      );
    }
    templates[group] = source.map((value, index) => normalizedTemplate(value, group, index));
  }
  return templates;
}

function validatePortalGreetingSettings(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw validationError("Begrüßungseinstellungen müssen als Objekt angegeben werden.", "PORTAL_GREETING_SETTINGS_INVALID");
  }
  return {
    enabled: booleanSetting(input.enabled, DEFAULT_PORTAL_GREETING_SETTINGS.enabled, "Die Begrüßungsfunktion"),
    vacationMinimumCalendarDays: integerSetting(
      input.vacationMinimumCalendarDays,
      DEFAULT_PORTAL_GREETING_SETTINGS.vacationMinimumCalendarDays,
      { label: "Die Mindestdauer des Urlaubs", minimum: 1, maximum: 366 },
    ),
    vacationReturnWorkdays: integerSetting(
      input.vacationReturnWorkdays,
      DEFAULT_PORTAL_GREETING_SETTINGS.vacationReturnWorkdays,
      { label: "Die Rückkehrtage nach Urlaub", minimum: 0, maximum: 10 },
    ),
    sicknessReturnWorkdays: integerSetting(
      input.sicknessReturnWorkdays,
      DEFAULT_PORTAL_GREETING_SETTINGS.sicknessReturnWorkdays,
      { label: "Die Rückkehrtage nach Genesung", minimum: 0, maximum: 10 },
    ),
    templates: normalizeTemplates(input.templates || {}),
  };
}

function validDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseDateKey(value, label) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw validationError(`${label} muss im Format JJJJ-MM-TT angegeben werden.`, "PORTAL_GREETING_DATE_INVALID");
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (!validDateParts(parts.year, parts.month, parts.day)) {
    throw validationError(`${label} ist ungültig.`, "PORTAL_GREETING_DATE_INVALID");
  }
  return parts;
}

function dateKey(parts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function dateOrdinal(parts) {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS);
}

const viennaFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function currentParts(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return { ...parseDateKey(value.trim(), "Der Begrüßungstag"), hour: 12 };
  }
  const instant = value === undefined ? new Date() : value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    throw validationError("Der Begrüßungszeitpunkt ist ungültig.", "PORTAL_GREETING_TIMESTAMP_INVALID");
  }
  const result = {};
  for (const part of viennaFormatter.formatToParts(instant)) {
    if (part.type !== "literal") result[part.type] = Number(part.value);
  }
  return { year: result.year, month: result.month, day: result.day, hour: result.hour };
}

function normalizeWorkdays(values, endedOn, label) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    throw validationError(`${label} müssen als Liste angegeben werden.`, "PORTAL_GREETING_WORKDAYS_INVALID");
  }
  const endOrdinal = dateOrdinal(endedOn);
  const ordinals = values.map((value, index) => {
    const parsed = parseDateKey(value, `${label} ${index + 1}`);
    const ordinal = dateOrdinal(parsed);
    if (ordinal <= endOrdinal) {
      throw validationError(`${label} müssen nach dem Abwesenheitsende liegen.`, "PORTAL_GREETING_WORKDAYS_INVALID");
    }
    return ordinal;
  });
  const unique = [...new Set(ordinals)].sort((left, right) => left - right);
  if (unique.length !== ordinals.length) {
    throw validationError(`${label} dürfen keine doppelten Tage enthalten.`, "PORTAL_GREETING_WORKDAYS_INVALID");
  }
  return unique;
}

function returnWindow(event, currentOrdinal, limit, label) {
  if (!event || limit === 0) return null;
  const endedOn = parseDateKey(event.endedOn, `${label}-Ende`);
  const workdays = normalizeWorkdays(event.returnWorkdays, endedOn, `${label}-Arbeitstage`);
  const index = workdays.indexOf(currentOrdinal);
  if (index < 0 || index >= limit) return null;
  const validOrdinal = workdays[Math.min(limit, workdays.length) - 1];
  const validDate = new Date(validOrdinal * DAY_MS);
  return {
    endedOn,
    validUntil: dateKey({
      year: validDate.getUTCFullYear(),
      month: validDate.getUTCMonth() + 1,
      day: validDate.getUTCDate(),
    }),
  };
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function greetingWord(hour) {
  if (hour < 11) return "Guten Morgen";
  if (hour >= 17) return "Guten Abend";
  return "Hallo";
}

function greetingResult({ kind, templateGroup, templates, dateOrdinal: ordinal, stableKey, name, hour }) {
  const options = templates[templateGroup];
  const index = (ordinal + stableHash(stableKey)) % options.length;
  const safeName = String(name || "").replace(/\s+/g, " ").trim().slice(0, 80) || "du";
  return {
    id: `${kind}-${index + 1}`,
    text: options[index]
      .replaceAll("{name}", safeName)
      .replaceAll("{greeting}", greetingWord(hour)),
    kind,
    validUntil: dateKey({
      year: new Date(ordinal * DAY_MS).getUTCFullYear(),
      month: new Date(ordinal * DAY_MS).getUTCMonth() + 1,
      day: new Date(ordinal * DAY_MS).getUTCDate(),
    }),
    enabled: true,
  };
}

function generalTemplateGroup(hour) {
  if (hour < 11) return "morning";
  if (hour >= 17) return "evening";
  return "daytime";
}

function disabledResult() {
  return {
    id: "disabled",
    text: "",
    kind: "disabled",
    validUntil: null,
    enabled: false,
  };
}

function resolvePortalGreeting({ at, stableKey = "", name = "", settings = {}, vacation = null, sickness = null } = {}) {
  const normalized = validatePortalGreetingSettings(settings);
  if (!normalized.enabled) return disabledResult();

  const current = currentParts(at);
  const currentDate = dateKey(current);
  const currentOrdinal = dateOrdinal(current);
  const base = {
    templates: normalized.templates,
    dateOrdinal: currentOrdinal,
    stableKey,
    name,
    hour: current.hour,
    validUntil: currentDate,
  };

  if (sickness?.active === true) {
    return greetingResult({ ...base, kind: "encouragement", templateGroup: "sicknessActive" });
  }

  if (sickness?.endedOn) {
    const window = returnWindow(sickness, currentOrdinal, normalized.sicknessReturnWorkdays, "Genesungs-Rückkehr");
    if (window) {
      return greetingResult({
        ...base,
        kind: "welcome_back",
        templateGroup: "sicknessReturn",
      });
    }
  }

  if (vacation?.startedOn && vacation?.endedOn) {
    const startedOn = parseDateKey(vacation.startedOn, "Urlaubsbeginn");
    const window = returnWindow(vacation, currentOrdinal, normalized.vacationReturnWorkdays, "Urlaubs-Rückkehr");
    if (window) {
      const calendarDays = dateOrdinal(window.endedOn) - dateOrdinal(startedOn) + 1;
      if (calendarDays >= normalized.vacationMinimumCalendarDays) {
        return greetingResult({
          ...base,
          kind: "welcome_back",
          templateGroup: "vacationReturn",
        });
      }
    }
  }

  const templateGroup = generalTemplateGroup(current.hour);
  return greetingResult({ ...base, kind: "general", templateGroup });
}

module.exports = {
  DEFAULT_PORTAL_GREETING_SETTINGS,
  DEFAULT_TEMPLATES,
  PortalGreetingValidationError,
  TIME_ZONE,
  resolvePortalGreeting,
  validatePortalGreetingSettings,
};
