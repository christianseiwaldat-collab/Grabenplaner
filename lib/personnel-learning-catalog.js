"use strict";

const PERSONNEL_LEARNING_MODULE_TYPES = Object.freeze(["training", "knowledge"]);
const PERSONNEL_LEARNING_VERIFICATION_MODES = Object.freeze([
  "trainer_confirmation",
  "self_confirmation",
  "knowledge_check",
  "practical_check",
]);
const PERSONNEL_LEARNING_SCOPE_TYPES = Object.freeze([
  "organization",
  "location",
  "department",
]);

const MODULE_TYPE_SET = new Set(PERSONNEL_LEARNING_MODULE_TYPES);
const VERIFICATION_MODE_SET = new Set(PERSONNEL_LEARNING_VERIFICATION_MODES);
const SCOPE_TYPE_SET = new Set(PERSONNEL_LEARNING_SCOPE_TYPES);

class PersonnelLearningCatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PersonnelLearningCatalogError";
    this.code = code;
  }
}

function invalid(code, message) {
  throw new PersonnelLearningCatalogError(code, message);
}

function plainRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizedText(value, {
  label,
  min = 0,
  max,
  preserveWhitespace = false,
} = {}) {
  if (typeof value !== "string") {
    invalid("PERSONNEL_LEARNING_TEMPLATE_INVALID", `${label} muss als Text übermittelt werden.`);
  }
  const normalized = preserveWhitespace
    ? value.replace(/\r\n?/g, "\n").trim()
    : value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max || normalized.includes("\0")) {
    invalid(
      "PERSONNEL_LEARNING_TEMPLATE_INVALID",
      `${label} muss zwischen ${min} und ${max} Zeichen lang sein.`,
    );
  }
  return normalized;
}

function normalizedModuleCode(value) {
  const code = normalizedText(String(value ?? ""), {
    label: "Der Prozesscode",
    min: 2,
    max: 80,
  }).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(code)) {
    invalid(
      "PERSONNEL_LEARNING_MODULE_CODE_INVALID",
      "Der Prozesscode darf nur Kleinbuchstaben, Ziffern, Punkt, Bindestrich und Unterstrich enthalten.",
    );
  }
  return code;
}

function normalizedModuleType(value) {
  const moduleType = String(value || "").trim().toLowerCase();
  if (!MODULE_TYPE_SET.has(moduleType)) {
    invalid("PERSONNEL_LEARNING_MODULE_TYPE_INVALID", "Bitte eine gültige Prozessart auswählen.");
  }
  return moduleType;
}

function normalizedScope(value) {
  if (!plainRecord(value)) {
    invalid("PERSONNEL_LEARNING_SCOPE_INVALID", "Bitte einen gültigen Geltungsbereich auswählen.");
  }
  const type = String(value.type || "").trim().toLowerCase();
  if (!SCOPE_TYPE_SET.has(type)) {
    invalid("PERSONNEL_LEARNING_SCOPE_INVALID", "Bitte einen gültigen Geltungsbereich auswählen.");
  }
  if (type === "organization") {
    return Object.freeze({ type, locationId: null, departmentId: null });
  }
  const locationId = normalizedText(String(value.locationId ?? ""), {
    label: "Die Filiale",
    min: 1,
    max: 80,
  });
  if (type === "location") {
    return Object.freeze({ type, locationId, departmentId: null });
  }
  const departmentId = Number(value.departmentId);
  if (!Number.isSafeInteger(departmentId) || departmentId < 1) {
    invalid("PERSONNEL_LEARNING_SCOPE_INVALID", "Bitte eine gültige Abteilung auswählen.");
  }
  return Object.freeze({ type, locationId, departmentId });
}

function normalizedTags(value) {
  const tags = value === undefined ? [] : value;
  if (!Array.isArray(tags) || tags.length > 12) {
    invalid("PERSONNEL_LEARNING_TEMPLATE_INVALID", "Es sind höchstens zwölf Schlagwörter zulässig.");
  }
  const seen = new Set();
  return Object.freeze(tags.map((tag) => normalizedText(tag, {
    label: "Ein Schlagwort",
    min: 1,
    max: 40,
  })).filter((tag) => {
    const key = tag.toLocaleLowerCase("de-AT");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function normalizedSteps(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 40) {
    invalid(
      "PERSONNEL_LEARNING_TEMPLATE_INVALID",
      "Eine Prozessvorlage benötigt zwischen einem und vierzig geordneten Schritten.",
    );
  }
  const ids = new Set();
  return Object.freeze(value.map((entry, index) => {
    if (!plainRecord(entry)) {
      invalid("PERSONNEL_LEARNING_TEMPLATE_INVALID", `Schritt ${index + 1} ist ungültig.`);
    }
    const fallbackId = `step-${String(index + 1).padStart(2, "0")}`;
    const stepId = normalizedText(String(entry.stepId ?? entry.id ?? fallbackId), {
      label: `Die Kennung von Schritt ${index + 1}`,
      min: 2,
      max: 80,
    }).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._:-]{1,79}$/.test(stepId) || ids.has(stepId)) {
      invalid(
        "PERSONNEL_LEARNING_TEMPLATE_INVALID",
        `Die Kennung von Schritt ${index + 1} ist ungültig oder doppelt vorhanden.`,
      );
    }
    ids.add(stepId);
    return Object.freeze({
      stepId,
      title: normalizedText(entry.title, {
        label: `Der Titel von Schritt ${index + 1}`,
        min: 2,
        max: 120,
      }),
      instruction: normalizedText(String(entry.instruction ?? ""), {
        label: `Die Anleitung von Schritt ${index + 1}`,
        min: 0,
        max: 1200,
        preserveWhitespace: true,
      }),
      completionCriteria: normalizedText(String(entry.completionCriteria ?? ""), {
        label: `Das Abschlusskriterium von Schritt ${index + 1}`,
        min: 0,
        max: 600,
        preserveWhitespace: true,
      }),
      required: entry.required !== false,
    });
  }));
}

function normalizePersonnelLearningTemplateInput(value, {
  moduleCode = null,
  moduleType = null,
} = {}) {
  if (!plainRecord(value)) {
    invalid("PERSONNEL_LEARNING_TEMPLATE_INVALID", "Bitte eine gültige Prozessvorlage übermitteln.");
  }
  const verificationMode = String(value.verificationMode || "").trim().toLowerCase();
  if (!VERIFICATION_MODE_SET.has(verificationMode)) {
    invalid(
      "PERSONNEL_LEARNING_TEMPLATE_INVALID",
      "Bitte eine gültige Form der Abschlussprüfung auswählen.",
    );
  }
  const estimatedMinutes = Number(value.estimatedMinutes);
  if (!Number.isSafeInteger(estimatedMinutes) || estimatedMinutes < 5 || estimatedMinutes > 1440) {
    invalid(
      "PERSONNEL_LEARNING_TEMPLATE_INVALID",
      "Die geplante Dauer muss zwischen 5 und 1.440 Minuten liegen.",
    );
  }
  const content = Object.freeze({
    schemaVersion: 1,
    summary: normalizedText(String(value.summary ?? ""), {
      label: "Die Kurzbeschreibung",
      min: 0,
      max: 600,
      preserveWhitespace: true,
    }),
    objective: normalizedText(value.objective, {
      label: "Das Lernziel",
      min: 3,
      max: 800,
      preserveWhitespace: true,
    }),
    estimatedMinutes,
    verificationMode,
    tags: normalizedTags(value.tags),
    steps: normalizedSteps(value.steps),
    versionNote: normalizedText(String(value.versionNote ?? ""), {
      label: "Der Versionshinweis",
      min: 0,
      max: 300,
      preserveWhitespace: true,
    }),
  });
  return Object.freeze({
    moduleCode: normalizedModuleCode(moduleCode ?? value.moduleCode),
    moduleType: normalizedModuleType(moduleType ?? value.moduleType),
    title: normalizedText(value.title, {
      label: "Der Prozesstitel",
      min: 3,
      max: 200,
    }),
    content,
    scope: normalizedScope(value.scope),
  });
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (plainRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, stableJsonValue(value[key])]));
  }
  return value;
}

function stableJsonStringify(value) {
  return JSON.stringify(stableJsonValue(value));
}

function scopeFromVersion(version) {
  if (!version) return null;
  return Object.freeze({
    type: String(version.scopeType ?? version.scope_type ?? ""),
    locationId: version.scopeLocationId ?? version.scope_location_id ?? null,
    departmentId: Number(
      version.scopeDepartmentId ?? version.scope_department_id ?? 0,
    ) || null,
  });
}

function personnelLearningScopeAccess(access, scopeValue, { manage = false } = {}) {
  const scope = normalizedScope(scopeValue);
  if (access?.localSystem === true || access?.plPlus === true) return true;
  if (manage && scope.type === "organization") return false;
  const organizationScope = access?.organizationScope || null;
  if (!organizationScope?.locationId) return false;
  if (scope.type === "organization") return !manage;
  if (scope.locationId !== organizationScope.locationId) return false;
  if (access.role === "manager") return true;
  if (access.role !== "department_manager") return false;
  if (!manage && scope.type === "location") return true;
  return scope.type === "department"
    && Number(scope.departmentId) === Number(organizationScope.departmentId);
}

function buildPersonnelLearningModuleState({ module, versions, events } = {}) {
  if (!module || !Array.isArray(versions) || !versions.length || !Array.isArray(events)) {
    invalid("PERSONNEL_LEARNING_HISTORY_INVALID", "Die Prozesshistorie ist unvollständig.");
  }
  const orderedVersions = [...versions].sort((left, right) => (
    Number(left.versionNumber ?? left.version_number)
      - Number(right.versionNumber ?? right.version_number)
  ));
  const orderedEvents = [...events].sort((left, right) => (
    Number(left.sequenceNumber ?? left.sequence_number)
      - Number(right.sequenceNumber ?? right.sequence_number)
  ));
  const versionByNumber = new Map(orderedVersions.map((version) => [
    Number(version.versionNumber ?? version.version_number),
    version,
  ]));
  const publishedEvents = orderedEvents.filter((event) => (
    String(event.eventType ?? event.event_type) === "published"
  ));
  const lastPublishedEvent = publishedEvents.at(-1) || null;
  const publishedVersionNumber = Number(
    lastPublishedEvent?.moduleVersionNumber ?? lastPublishedEvent?.module_version_number ?? 0,
  ) || null;
  const lifecycleEvent = orderedEvents.filter((event) => (
    ["archived", "restored"].includes(String(event.eventType ?? event.event_type))
  )).at(-1) || null;
  const archived = String(lifecycleEvent?.eventType ?? lifecycleEvent?.event_type ?? "")
    === "archived";
  const latestVersion = orderedVersions.at(-1);
  const latestVersionNumber = Number(
    latestVersion.versionNumber ?? latestVersion.version_number,
  );
  const publishedVersion = publishedVersionNumber
    ? versionByNumber.get(publishedVersionNumber) || null
    : null;
  const currentEvent = orderedEvents.at(-1) || null;
  return Object.freeze({
    archived,
    status: archived
      ? "archived"
      : !publishedVersion
        ? "draft"
        : latestVersionNumber > publishedVersionNumber
          ? "published_with_draft"
          : "published",
    latestVersion,
    latestVersionNumber,
    publishedVersion,
    publishedVersionNumber,
    currentEvent,
    currentEventReceipt: String(
      currentEvent?.receiptSha256 ?? currentEvent?.receipt_sha256 ?? "",
    ),
    versions: Object.freeze(orderedVersions),
    events: Object.freeze(orderedEvents),
  });
}

module.exports = {
  PERSONNEL_LEARNING_MODULE_TYPES,
  PERSONNEL_LEARNING_SCOPE_TYPES,
  PERSONNEL_LEARNING_VERIFICATION_MODES,
  PersonnelLearningCatalogError,
  buildPersonnelLearningModuleState,
  normalizePersonnelLearningTemplateInput,
  normalizePersonnelLearningScope: normalizedScope,
  normalizePersonnelLearningTags: normalizedTags,
  normalizePersonnelLearningText: normalizedText,
  normalizedModuleCode,
  personnelLearningScopeAccess,
  scopeFromVersion,
  stableJsonStringify,
};
