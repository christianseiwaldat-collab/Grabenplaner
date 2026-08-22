const SCHEDULE_PDF_DESIGN_CATALOG = Object.freeze([
  Object.freeze({
    id: "timeline",
    label: "Design 1 · Zeitachse",
    shortLabel: "Zeitachse",
    description: "Klare Tagestrennung mit farbigen Mitarbeitenden-Zeilen und Zeitachsen.",
  }),
  Object.freeze({
    id: "matrix",
    label: "Design 2 · Wochenmatrix",
    shortLabel: "Wochenmatrix",
    description: "Kompakte Wochenübersicht mit einer Zeile je Teammitglied und gut lesbaren Tagesfeldern.",
  }),
]);

const DEFAULT_SCHEDULE_PDF_DESIGN_IDS = Object.freeze(["timeline"]);
const MAX_ACTIVE_SCHEDULE_PDF_DESIGNS = 5;
const MIN_SCHEDULE_PDF_DESIGN_NAME_LENGTH = 3;
const MAX_SCHEDULE_PDF_DESIGN_NAME_LENGTH = 60;
const SCHEDULE_PDF_DESIGN_IDS = new Set(SCHEDULE_PDF_DESIGN_CATALOG.map(({ id }) => id));

class SchedulePdfDesignValidationError extends Error {
  constructor(message, code = "INVALID_SCHEDULE_PDF_DESIGNS") {
    super(message);
    this.name = "SchedulePdfDesignValidationError";
    this.code = code;
  }
}

function parseStoredSchedulePdfDesignIds(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeSchedulePdfDesignIds(value, { strict = false } = {}) {
  const rawIds = parseStoredSchedulePdfDesignIds(value);
  if (strict && (rawIds.length < 1 || rawIds.length > MAX_ACTIVE_SCHEDULE_PDF_DESIGNS)) {
    throw new SchedulePdfDesignValidationError("Bitte ein bis fünf Dienstplan-PDF-Designs aktivieren.");
  }

  const normalized = [];
  for (const rawId of rawIds) {
    const id = String(rawId || "").trim();
    if (!id || !SCHEDULE_PDF_DESIGN_IDS.has(id)) {
      if (strict) throw new SchedulePdfDesignValidationError("Ein ausgewähltes Dienstplan-PDF-Design ist nicht verfügbar.");
      continue;
    }
    if (normalized.includes(id)) {
      if (strict) throw new SchedulePdfDesignValidationError("Jedes Dienstplan-PDF-Design darf nur einmal gereiht werden.");
      continue;
    }
    normalized.push(id);
    if (!strict && normalized.length === MAX_ACTIVE_SCHEDULE_PDF_DESIGNS) break;
  }

  if (strict && normalized.length !== rawIds.length) {
    throw new SchedulePdfDesignValidationError("Die Dienstplan-PDF-Designauswahl ist ungültig.");
  }
  return normalized.length ? normalized : [...DEFAULT_SCHEDULE_PDF_DESIGN_IDS];
}

function parseStoredSchedulePdfDesignNames(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizedSchedulePdfDesignName(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function schedulePdfDesignNameKey(value) {
  return normalizedSchedulePdfDesignName(value).toLocaleLowerCase("de");
}

function normalizeSchedulePdfDesignNames(value, { strict = false } = {}) {
  const rawNames = parseStoredSchedulePdfDesignNames(value);
  if (strict && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new SchedulePdfDesignValidationError(
      "Die Dienstplan-PDF-Designnamen sind ungültig.",
      "INVALID_SCHEDULE_PDF_DESIGN_NAMES",
    );
  }
  const unknownIds = Object.keys(rawNames).filter((id) => !SCHEDULE_PDF_DESIGN_IDS.has(id));
  if (strict && unknownIds.length) {
    throw new SchedulePdfDesignValidationError(
      "Ein Dienstplan-PDF-Designname gehört zu keinem verfügbaren Design.",
      "INVALID_SCHEDULE_PDF_DESIGN_NAMES",
    );
  }

  const candidates = SCHEDULE_PDF_DESIGN_CATALOG.map((design) => {
    if (!Object.hasOwn(rawNames, design.id)) return { design, name: design.label, custom: false };
    const rawName = rawNames[design.id];
    const name = normalizedSchedulePdfDesignName(rawName);
    const invalidType = typeof rawName !== "string";
    const invalidControlCharacter = /[\u0000-\u001f\u007f]/u.test(String(rawName || ""));
    const length = [...name].length;
    const invalidLength = length < MIN_SCHEDULE_PDF_DESIGN_NAME_LENGTH
      || length > MAX_SCHEDULE_PDF_DESIGN_NAME_LENGTH;
    if (invalidType || invalidControlCharacter || invalidLength) {
      if (strict) {
        throw new SchedulePdfDesignValidationError(
          `Jeder Dienstplan-PDF-Designname muss zwischen ${MIN_SCHEDULE_PDF_DESIGN_NAME_LENGTH} und ${MAX_SCHEDULE_PDF_DESIGN_NAME_LENGTH} Zeichen lang und einzeilig sein.`,
          "INVALID_SCHEDULE_PDF_DESIGN_NAMES",
        );
      }
      return { design, name: design.label, custom: false };
    }
    return { design, name, custom: name !== design.label };
  });

  const duplicateNameKeys = () => {
    const counts = new Map();
    for (const candidate of candidates) {
      const key = schedulePdfDesignNameKey(candidate.name);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
  };
  let duplicates = duplicateNameKeys();
  if (strict && duplicates.size) {
    throw new SchedulePdfDesignValidationError(
      "Jeder Dienstplan-PDF-Designname muss eindeutig sein.",
      "INVALID_SCHEDULE_PDF_DESIGN_NAMES",
    );
  }
  if (!strict && duplicates.size) {
    for (const candidate of candidates) {
      if (candidate.custom && duplicates.has(schedulePdfDesignNameKey(candidate.name))) {
        candidate.name = candidate.design.label;
        candidate.custom = false;
      }
    }
    duplicates = duplicateNameKeys();
    if (duplicates.size) {
      for (const candidate of candidates) {
        candidate.name = candidate.design.label;
        candidate.custom = false;
      }
    }
  }

  return Object.fromEntries(candidates
    .filter(({ custom }) => custom)
    .map(({ design, name }) => [design.id, name]));
}

function schedulePdfDesignCatalogPayload(nameOverrides = {}) {
  const normalizedNames = normalizeSchedulePdfDesignNames(nameOverrides);
  return SCHEDULE_PDF_DESIGN_CATALOG.map((design) => ({
    ...design,
    label: normalizedNames[design.id] || design.label,
    defaultLabel: design.label,
  }));
}

function resolveSchedulePdfDesign(activeDesignIds, requestedDesignId) {
  const activeIds = normalizeSchedulePdfDesignIds(activeDesignIds);
  const requestedId = String(requestedDesignId || "").trim();
  if (!requestedId) return activeIds[0];
  if (!activeIds.includes(requestedId)) {
    throw new SchedulePdfDesignValidationError("Das gewählte Dienstplan-PDF-Design ist nicht aktiviert.");
  }
  return requestedId;
}

module.exports = {
  DEFAULT_SCHEDULE_PDF_DESIGN_IDS,
  MAX_SCHEDULE_PDF_DESIGN_NAME_LENGTH,
  MAX_ACTIVE_SCHEDULE_PDF_DESIGNS,
  MIN_SCHEDULE_PDF_DESIGN_NAME_LENGTH,
  SCHEDULE_PDF_DESIGN_CATALOG,
  SchedulePdfDesignValidationError,
  normalizeSchedulePdfDesignIds,
  normalizeSchedulePdfDesignNames,
  resolveSchedulePdfDesign,
  schedulePdfDesignCatalogPayload,
};
