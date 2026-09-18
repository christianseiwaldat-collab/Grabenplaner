"use strict";

const { randomUUID } = require("node:crypto");
const { canonicalSha256 } = require("./work-rules/receipt");
const {
  assertPersonnelLifecycleRepository,
} = require("./persistence/repositories/personnel-lifecycle");

const APPLICATION_STATUSES = Object.freeze([
  "new",
  "screening",
  "first_interview",
  "further_interview",
  "offer",
  "accepted",
  "preboarding",
  "converted",
  "rejected",
  "withdrawn",
  "talent_pool",
  "archived",
]);

const APPLICATION_TRANSITIONS = Object.freeze({
  new: Object.freeze(["screening", "rejected", "withdrawn", "talent_pool", "archived"]),
  screening: Object.freeze(["first_interview", "rejected", "withdrawn", "talent_pool", "archived"]),
  first_interview: Object.freeze(["further_interview", "offer", "rejected", "withdrawn", "talent_pool", "archived"]),
  further_interview: Object.freeze(["offer", "rejected", "withdrawn", "talent_pool", "archived"]),
  offer: Object.freeze(["accepted", "rejected", "withdrawn", "archived"]),
  accepted: Object.freeze(["preboarding", "withdrawn", "archived"]),
  preboarding: Object.freeze(["withdrawn", "archived"]),
  converted: Object.freeze([]),
  rejected: Object.freeze(["talent_pool", "archived"]),
  withdrawn: Object.freeze(["talent_pool", "archived"]),
  talent_pool: Object.freeze(["archived"]),
  archived: Object.freeze([]),
});

const DOCUMENT_VISIBILITIES = Object.freeze([
  "hr_confidential",
  "recruiting",
  "scoped_leadership",
]);

const DOCUMENT_MEDIA_TYPES = Object.freeze([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
]);
const CANDIDATE_PHOTO_VISIBILITY = "scoped_leadership";
const CANDIDATE_PHOTO_MEDIA_TYPE = "image/jpeg";
const CANDIDATE_PHOTO_MAX_BYTES = 512 * 1024;
const MAX_APPLICATION_STATE_BYTES = 64 * 1024;

const CANDIDATE_PROFILE_PAYLOAD_KEYS = Object.freeze([
  "address",
  "birthDate",
  "citizenships",
  "email",
  "firstName",
  "lastName",
  "phone",
  "preferredLanguage",
]);
const CANDIDATE_ADDRESS_PAYLOAD_KEYS = Object.freeze([
  "city",
  "country",
  "postalCode",
  "state",
  "street",
  "supplement",
]);
const APPLICATION_PAYLOAD_KEYS = Object.freeze([
  "communicationNotes",
  "competencyRatings",
  "desiredRoleTitle",
  "employmentType",
  "internalNotes",
  "internalRating",
  "targetAreas",
  "teamFeedback",
  "teamEvaluations",
  "trialAppointments",
  "source",
  "tags",
]);
const DOCUMENT_PAYLOAD_KEYS = Object.freeze(["description", "title"]);
const DOCUMENT_VERSION_PAYLOAD_KEYS = Object.freeze(["note", "originalFilename"]);
const DOCUMENT_VERSION_STORAGE_KEY = Symbol("candidateDocumentVersionStorageKey");
const CONVERSION_INTERNAL = Symbol("candidateConversionInternal");
const CONVERSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CLOSED_OTHER_APPLICATION_STATUSES = Object.freeze(new Set([
  "archived",
  "rejected",
  "talent_pool",
  "withdrawn",
]));
const CLOSED_TEAM_EVALUATION_APPLICATION_STATUSES = Object.freeze(new Set([
  "converted",
  "rejected",
  "withdrawn",
  "talent_pool",
  "archived",
]));

const PERSONNEL_LIFECYCLE_ERROR_KINDS = Object.freeze({
  INVALID: "invalid",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  INTEGRITY: "integrity",
});

class PersonnelLifecycleError extends Error {
  constructor(message, code, kind = PERSONNEL_LIFECYCLE_ERROR_KINDS.INVALID) {
    super(message);
    this.name = "PersonnelLifecycleError";
    this.code = code;
    this.kind = kind;
  }
}

function lifecycleError(message, code, kind) {
  return new PersonnelLifecycleError(message, code, kind);
}

function plainRecord(value, label = "Eingabe") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw lifecycleError(`${label} ist ungültig.`, "PERSONNEL_LIFECYCLE_INVALID");
  }
  return value;
}

function text(value, label, maximum, { required = false } = {}) {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) {
    throw lifecycleError(`${label} fehlt.`, "PERSONNEL_LIFECYCLE_INVALID");
  }
  if (normalized.includes("\0") || normalized.length > maximum) {
    throw lifecycleError(`${label} ist ungültig.`, "PERSONNEL_LIFECYCLE_INVALID");
  }
  return normalized;
}

function nullableText(value, label, maximum) {
  const normalized = text(value, label, maximum);
  return normalized || null;
}

function isoDate(value, label) {
  const normalized = text(value, label, 10);
  if (!normalized) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw lifecycleError(`${label} muss im Format YYYY-MM-DD angegeben werden.`, "PERSONNEL_LIFECYCLE_INVALID");
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw lifecycleError(`${label} ist kein gültiges Datum.`, "PERSONNEL_LIFECYCLE_INVALID");
  }
  return normalized;
}

function nullableInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw lifecycleError(`${label} ist ungültig.`, "PERSONNEL_LIFECYCLE_INVALID");
  }
  return normalized;
}

function paginationInteger(value, label, {
  fallback,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
} = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    throw lifecycleError(`${label} ist ungültig.`, "PERSONNEL_LIFECYCLE_PAGINATION_INVALID");
  }
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw lifecycleError(`${label} ist ungültig.`, "PERSONNEL_LIFECYCLE_PAGINATION_INVALID");
  }
  return normalized;
}

function queryBoolean(value, label, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (value === "1") return true;
  if (value === "0") return false;
  throw lifecycleError(`${label} ist ungültig.`, "PERSONNEL_LIFECYCLE_PAGINATION_INVALID");
}

function expectedRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw lifecycleError(
      "Für die sichere Änderung fehlt die aktuelle Revision.",
      "PERSONNEL_LIFECYCLE_REVISION_REQUIRED",
    );
  }
  return revision;
}

function emailAddress(value) {
  const normalized = text(value, "E-Mail-Adresse", 254).toLowerCase();
  if (normalized && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw lifecycleError("Die E-Mail-Adresse ist ungültig.", "PERSONNEL_LIFECYCLE_INVALID");
  }
  return normalized;
}

function stringList(value, label, { maximumItems = 30, maximumLength = 80 } = {}) {
  const submitted = Array.isArray(value) ? value : [];
  const normalized = [...new Set(submitted
    .map((entry) => text(entry, label, maximumLength))
    .filter(Boolean))];
  if (normalized.length > maximumItems) {
    throw lifecycleError(`${label} enthält zu viele Einträge.`, "PERSONNEL_LIFECYCLE_INVALID");
  }
  return normalized;
}

function valueOrBase(value, key, base, fallback = "") {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : (base[key] ?? fallback);
}

function exactPayloadKeys(value, allowedKeys, label) {
  const record = plainRecord(value, label);
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error(`${label} enthält unerwartete Felder.`);
  }
  return record;
}

function jsonSnapshot(value, label, { maximumBytes = 64 * 1024 } = {}) {
  function clone(entry, path, depth) {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw lifecycleError(`${label} ist ungültig.`, "PERSONNEL_LIFECYCLE_CONVERSION_INVALID");
      }
      return entry;
    }
    if (depth > 12) {
      throw lifecycleError(`${label} ist zu tief verschachtelt.`, "PERSONNEL_LIFECYCLE_CONVERSION_INVALID");
    }
    if (Array.isArray(entry)) {
      if (entry.length > 500) {
        throw lifecycleError(`${label} enthält zu viele Einträge.`, "PERSONNEL_LIFECYCLE_CONVERSION_INVALID");
      }
      return entry.map((item, index) => clone(item, `${path}[${index}]`, depth + 1));
    }
    if (!entry || typeof entry !== "object"
      || ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) {
      throw lifecycleError(`${label} ist ungültig.`, "PERSONNEL_LIFECYCLE_CONVERSION_INVALID");
    }
    const keys = Object.keys(entry);
    if (keys.length > 200 || keys.some((key) => (
      !key || key.includes("\0") || ["__proto__", "constructor", "prototype"].includes(key)
    ))) {
      throw lifecycleError(`${label} ist ungültig.`, "PERSONNEL_LIFECYCLE_CONVERSION_INVALID");
    }
    return Object.fromEntries(keys.map((key) => [key, clone(entry[key], `${path}.${key}`, depth + 1)]));
  }

  const snapshot = clone(value, label, 0);
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw lifecycleError(`${label} ist zu groß.`, "PERSONNEL_LIFECYCLE_CONVERSION_INVALID");
  }
  return snapshot;
}

function conversionId(value) {
  const normalized = text(value, "Vorgangs-ID", 36, { required: true }).toLowerCase();
  if (!CONVERSION_ID_PATTERN.test(normalized)) {
    throw lifecycleError(
      "Für die Umwandlung wird eine gültige UUID-Vorgangs-ID benötigt.",
      "PERSONNEL_LIFECYCLE_CONVERSION_ID_INVALID",
    );
  }
  return normalized;
}

function sha256(value, label, code) {
  const normalized = text(value, label, 64, { required: true }).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw lifecycleError(`${label} ist ungültig.`, code);
  }
  return normalized;
}

function normalizeAddress(value = {}, base = {}) {
  const submitted = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const current = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  return {
    street: text(valueOrBase(submitted, "street", current), "Straße", 160),
    supplement: text(valueOrBase(submitted, "supplement", current), "Adresszusatz", 120),
    postalCode: text(valueOrBase(submitted, "postalCode", current), "Postleitzahl", 24),
    city: text(valueOrBase(submitted, "city", current), "Ort", 120),
    state: text(valueOrBase(submitted, "state", current), "Bundesland", 120),
    country: text(valueOrBase(submitted, "country", current, "Österreich"), "Land", 120),
  };
}

function normalizeCandidateProfile(value = {}, base = {}) {
  const submitted = plainRecord(value, "Bewerberprofil");
  const current = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  const profile = {
    firstName: text(valueOrBase(submitted, "firstName", current), "Vorname", 100, { required: true }),
    lastName: text(valueOrBase(submitted, "lastName", current), "Nachname", 100, { required: true }),
    email: emailAddress(valueOrBase(submitted, "email", current)),
    phone: text(valueOrBase(submitted, "phone", current), "Telefonnummer", 80),
    address: normalizeAddress(
      Object.prototype.hasOwnProperty.call(submitted, "address") ? submitted.address : {},
      current.address || {},
    ),
    preferredLanguage: text(
      valueOrBase(submitted, "preferredLanguage", current, "de"),
      "Bevorzugte Sprache",
      16,
    ).toLowerCase(),
  };
  if (Object.prototype.hasOwnProperty.call(submitted, "birthDate")
    || Object.prototype.hasOwnProperty.call(current, "birthDate")) {
    profile.birthDate = isoDate(
      valueOrBase(submitted, "birthDate", current, null),
      "Geburtsdatum",
    );
  }
  if (Object.prototype.hasOwnProperty.call(submitted, "citizenships")
    || Object.prototype.hasOwnProperty.call(current, "citizenships")) {
    profile.citizenships = Object.prototype.hasOwnProperty.call(submitted, "citizenships")
      ? stringList(submitted.citizenships, "Staatsangehörigkeit", {
          maximumItems: 8,
          maximumLength: 80,
        })
      : stringList(current.citizenships || [], "Staatsangehörigkeit", {
          maximumItems: 8,
          maximumLength: 80,
        });
  }
  if (!profile.email && !profile.phone) {
    throw lifecycleError(
      "Für den Bewerber wird zumindest eine E-Mail-Adresse oder Telefonnummer benötigt.",
      "PERSONNEL_LIFECYCLE_CONTACT_REQUIRED",
    );
  }
  return profile;
}

function clockTime(value, label) {
  const normalized = text(value, label, 5);
  if (!normalized) return null;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized)) {
    throw lifecycleError(`${label} muss im Format HH:MM angegeben werden.`, "PERSONNEL_LIFECYCLE_INVALID");
  }
  return normalized;
}

function normalizeTargetAreas(value) {
  const submitted = Array.isArray(value) ? value : [];
  if (submitted.length > 20) {
    throw lifecycleError("Es wurden zu viele Zielfilialen angegeben.", "PERSONNEL_LIFECYCLE_INVALID");
  }
  const seen = new Set();
  return submitted.map((entry, index) => {
    const area = plainRecord(entry, `Zielfiliale ${index + 1}`);
    const locationId = text(area.locationId, "Zielfiliale", 80, { required: true });
    const departmentId = nullableInteger(area.departmentId, "Zielabteilung", { minimum: 1 });
    const key = `${locationId}\0${departmentId ?? "*"}`;
    if (seen.has(key)) {
      throw lifecycleError("Eine Zielfiliale wurde doppelt angegeben.", "PERSONNEL_LIFECYCLE_INVALID");
    }
    seen.add(key);
    return {
      locationId,
      departmentId,
      preferred: area.preferred === true,
    };
  });
}

function preferredTargetArea(targetAreas) {
  if (!targetAreas.length) return null;
  const preferred = targetAreas.filter((area) => area.preferred);
  if (preferred.length !== 1) {
    throw lifecycleError(
      "Bei hinterlegten Zielbereichen muss genau ein Bereich als bevorzugt markiert sein.",
      "PERSONNEL_LIFECYCLE_TARGET_AREA_PREFERRED_INVALID",
    );
  }
  return preferred[0];
}

function targetAreaMatches(area, locationId, departmentId) {
  return area.locationId === locationId
    && (area.departmentId ?? null) === (departmentId ?? null);
}

function normalizeApplicationTargetScope(submitted, current, desiredLocationId, desiredDepartmentId) {
  const targetAreasSubmitted = Object.prototype.hasOwnProperty.call(submitted, "targetAreas");
  const desiredScopeSubmitted = Object.prototype.hasOwnProperty.call(submitted, "desiredLocationId")
    || Object.prototype.hasOwnProperty.call(submitted, "desiredDepartmentId");
  const currentHasTargetAreas = Object.prototype.hasOwnProperty.call(current, "targetAreas");
  const targetAreas = normalizeTargetAreas(
    targetAreasSubmitted ? submitted.targetAreas : currentHasTargetAreas ? current.targetAreas : [],
  );

  if (targetAreasSubmitted) {
    const preferred = preferredTargetArea(targetAreas);
    if (preferred) {
      return {
        desiredLocationId: preferred.locationId,
        desiredDepartmentId: preferred.departmentId,
        targetAreas,
      };
    }
    if (!desiredScopeSubmitted || !desiredLocationId) {
      return { desiredLocationId: null, desiredDepartmentId: null, targetAreas: [] };
    }
  }

  if (desiredScopeSubmitted && desiredLocationId) {
    let preferredFound = false;
    const synchronized = targetAreas.map((area) => {
      const preferred = targetAreaMatches(area, desiredLocationId, desiredDepartmentId);
      preferredFound ||= preferred;
      return { ...area, preferred };
    });
    if (!preferredFound) {
      synchronized.push({
        locationId: desiredLocationId,
        departmentId: desiredDepartmentId,
        preferred: true,
      });
    }
    return { desiredLocationId, desiredDepartmentId, targetAreas: synchronized };
  }

  if (desiredScopeSubmitted) {
    return { desiredLocationId: null, desiredDepartmentId: null, targetAreas: [] };
  }

  const preferred = preferredTargetArea(targetAreas);
  if (preferred) {
    return {
      desiredLocationId: preferred.locationId,
      desiredDepartmentId: preferred.departmentId,
      targetAreas,
    };
  }
  if (desiredLocationId) {
    return {
      desiredLocationId,
      desiredDepartmentId,
      targetAreas: [{ locationId: desiredLocationId, departmentId: desiredDepartmentId, preferred: true }],
    };
  }
  return { desiredLocationId: null, desiredDepartmentId: null, targetAreas: [] };
}

const TRIAL_APPOINTMENT_STATUSES = Object.freeze(["planned", "completed", "cancelled"]);
const TRIAL_APPOINTMENT_DIRECT_UPDATE_FIELDS = Object.freeze(new Set([
  "revision",
  "dateFrom",
  "dateTo",
  "startTime",
  "endTime",
  "locationId",
  "departmentId",
  "status",
  "note",
  "cancellationReason",
  "replacement",
]));
const TRIAL_APPOINTMENT_REPLACEMENT_FIELDS = Object.freeze(new Set([
  "dateFrom",
  "dateTo",
  "startTime",
  "endTime",
  "locationId",
  "departmentId",
  "note",
]));

function directTrialAppointmentPayload(value, label, allowedFields) {
  const submitted = plainRecord(value, label);
  if (Object.keys(submitted).some((key) => !allowedFields.has(key))) {
    throw lifecycleError(
      `${label} enthält nicht erlaubte Felder.`,
      "PERSONNEL_LIFECYCLE_TRIAL_UPDATE_INVALID",
    );
  }
  return submitted;
}

function normalizeTrialAppointments(value) {
  const submitted = Array.isArray(value) ? value : [];
  if (submitted.length > 30) {
    throw lifecycleError("Es wurden zu viele Schnuppertermine angegeben.", "PERSONNEL_LIFECYCLE_INVALID");
  }
  const seen = new Set();
  const normalized = submitted.map((entry, index) => {
    const appointment = plainRecord(entry, `Schnuppertermin ${index + 1}`);
    const id = text(appointment.id, "Schnuppertermin-ID", 80, { required: true });
    if (seen.has(id)) {
      throw lifecycleError("Eine Schnuppertermin-ID wurde doppelt angegeben.", "PERSONNEL_LIFECYCLE_INVALID");
    }
    seen.add(id);
    const dateFrom = isoDate(appointment.dateFrom, "Beginn des Schnuppertermins");
    const dateTo = isoDate(appointment.dateTo || appointment.dateFrom, "Ende des Schnuppertermins");
    if (!dateFrom || !dateTo || dateTo < dateFrom) {
      throw lifecycleError("Der Zeitraum des Schnuppertermins ist ungültig.", "PERSONNEL_LIFECYCLE_INVALID");
    }
    const startTime = clockTime(appointment.startTime, "Beginnzeit des Schnuppertermins");
    const endTime = clockTime(appointment.endTime, "Endzeit des Schnuppertermins");
    if ((!startTime && endTime)
      || (dateFrom === dateTo && startTime && endTime <= startTime)) {
      throw lifecycleError("Die Uhrzeiten des Schnuppertermins sind ungültig.", "PERSONNEL_LIFECYCLE_INVALID");
    }
    const status = text(appointment.status || "planned", "Status des Schnuppertermins", 20);
    if (!TRIAL_APPOINTMENT_STATUSES.includes(status)) {
      throw lifecycleError("Der Status des Schnuppertermins ist ungültig.", "PERSONNEL_LIFECYCLE_INVALID");
    }
    const cancellationReason = text(
      appointment.cancellationReason,
      "Absagegrund des Schnuppertermins",
      1000,
    );
    const replacementAppointmentId = nullableText(
      appointment.replacementAppointmentId,
      "Ersatztermin-ID",
      80,
    );
    const replacesAppointmentId = nullableText(
      appointment.replacesAppointmentId,
      "ID des ersetzten Schnuppertermins",
      80,
    );
    const cancelledAt = appointment.cancelledAt
      ? normalizedEvaluationTimestamp(appointment.cancelledAt, "Absagezeitpunkt")
      : null;
    const cancelledBy = nullableText(
      appointment.cancelledBy,
      "Absagende Person",
      120,
    );
    if (Boolean(cancelledAt) !== Boolean(cancelledBy)) {
      throw lifecycleError(
        "Absagezeitpunkt und absagende Person müssen gemeinsam vorliegen.",
        "PERSONNEL_LIFECYCLE_TRIAL_CANCELLATION_INVALID",
      );
    }
    if (status !== "cancelled" && (
      cancellationReason || replacementAppointmentId || cancelledAt || cancelledBy
    )) {
      throw lifecycleError(
        "Absagegrund und Ersatztermin dürfen nur bei einem abgesagten Schnuppertermin hinterlegt werden.",
        "PERSONNEL_LIFECYCLE_TRIAL_CANCELLATION_INVALID",
      );
    }
    if (replacementAppointmentId === id || replacesAppointmentId === id) {
      throw lifecycleError(
        "Ein Schnuppertermin kann nicht sich selbst ersetzen.",
        "PERSONNEL_LIFECYCLE_TRIAL_REPLACEMENT_INVALID",
      );
    }
    return {
      id,
      dateFrom,
      dateTo,
      startTime,
      endTime,
      locationId: text(appointment.locationId, "Schnupperfiliale", 80, { required: true }),
      departmentId: nullableInteger(appointment.departmentId, "Schnupperabteilung", { minimum: 1 }),
      status,
      note: text(appointment.note, "Hinweis zum Schnuppertermin", 1000),
      ...(cancellationReason ? { cancellationReason } : {}),
      ...(replacementAppointmentId ? { replacementAppointmentId } : {}),
      ...(replacesAppointmentId ? { replacesAppointmentId } : {}),
      ...(cancelledAt ? { cancelledAt, cancelledBy } : {}),
    };
  });
  const byId = new Map(normalized.map((appointment) => [appointment.id, appointment]));
  for (const appointment of normalized) {
    if (appointment.replacementAppointmentId) {
      const replacement = byId.get(appointment.replacementAppointmentId);
      if (!replacement || replacement.replacesAppointmentId !== appointment.id) {
        throw lifecycleError(
          "Der Ersatztermin ist nicht vollständig und nachvollziehbar verknüpft.",
          "PERSONNEL_LIFECYCLE_TRIAL_REPLACEMENT_INVALID",
        );
      }
    }
    if (appointment.replacesAppointmentId) {
      const cancelled = byId.get(appointment.replacesAppointmentId);
      if (!cancelled || cancelled.status !== "cancelled"
        || cancelled.replacementAppointmentId !== appointment.id) {
        throw lifecycleError(
          "Der ersetzte Schnuppertermin ist nicht vollständig und nachvollziehbar verknüpft.",
          "PERSONNEL_LIFECYCLE_TRIAL_REPLACEMENT_INVALID",
        );
      }
    }
    const visited = new Set([appointment.id]);
    let cursor = appointment;
    while (cursor.replacementAppointmentId) {
      if (visited.has(cursor.replacementAppointmentId)) {
        throw lifecycleError(
          "Die Ersatztermin-Verknüpfung enthält einen Zyklus.",
          "PERSONNEL_LIFECYCLE_TRIAL_REPLACEMENT_INVALID",
        );
      }
      visited.add(cursor.replacementAppointmentId);
      cursor = byId.get(cursor.replacementAppointmentId);
      if (!cursor) break;
    }
  }
  return normalized;
}

function normalizeSubmittedTrialAppointments(value, currentValue = []) {
  const submitted = normalizeTrialAppointments(value);
  const currentById = new Map(
    normalizeTrialAppointments(currentValue).map((appointment) => [appointment.id, appointment]),
  );
  const serverManagedFields = [
    "cancelledAt",
    "cancelledBy",
    "replacementAppointmentId",
    "replacesAppointmentId",
  ];
  for (const appointment of submitted) {
    const current = currentById.get(appointment.id) || null;
    const serverManagedChanged = serverManagedFields.some((field) => (
      (appointment[field] ?? null) !== (current?.[field] ?? null)
    ));
    const untrustedCancellation = appointment.status === "cancelled"
      && current?.status !== "cancelled";
    if (serverManagedChanged || untrustedCancellation) {
      throw lifecycleError(
        "Absagen und Ersatztermin-Verknüpfungen müssen direkt am Schnuppertermin gespeichert werden.",
        "PERSONNEL_LIFECYCLE_TRIAL_DIRECT_UPDATE_REQUIRED",
        current
          ? PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT
          : PERSONNEL_LIFECYCLE_ERROR_KINDS.INVALID,
      );
    }
  }
  return submitted;
}

function structuredApplicationEntryKey(field, entry) {
  if (field === "targetAreas") {
    return `${entry.locationId}\0${entry.departmentId ?? "*"}`;
  }
  return String(entry.id || "");
}

function structuredApplicationEntryValue(field, entry) {
  if (field === "targetAreas") {
    return JSON.stringify([
      entry.locationId,
      entry.departmentId ?? null,
      entry.preferred === true,
    ]);
  }
  return JSON.stringify([
    entry.id,
    entry.dateFrom,
    entry.dateTo,
    entry.startTime ?? null,
    entry.endTime ?? null,
    entry.locationId,
    entry.departmentId ?? null,
    entry.status,
    entry.note,
    entry.cancellationReason ?? null,
    entry.replacementAppointmentId ?? null,
    entry.replacesAppointmentId ?? null,
    entry.cancelledAt ?? null,
    entry.cancelledBy ?? null,
  ]);
}

function assertTrialAppointmentHistoryPreserved(before, after, {
  allowCancellationTransition = false,
  allowNewReplacementLink = false,
} = {}) {
  const beforeEntries = Array.isArray(before?.trialAppointments) ? before.trialAppointments : [];
  const afterById = new Map(
    (Array.isArray(after?.trialAppointments) ? after.trialAppointments : [])
      .map((entry) => [String(entry.id || ""), entry]),
  );
  for (const entry of beforeEntries) {
    const current = afterById.get(String(entry.id || ""));
    if (!current) {
      throw lifecycleError(
        "Ein bestehender Schnuppertermin darf nicht gelöscht werden. Bitte den Status nachvollziehbar ändern.",
        "PERSONNEL_LIFECYCLE_TRIAL_HISTORY_REQUIRED",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }
    if (entry.status !== "cancelled" && current.status === "cancelled"
      && !allowCancellationTransition) {
      throw lifecycleError(
        "Bitte eine Absage über die direkte Schnuppertermin-Bearbeitung speichern.",
        "PERSONNEL_LIFECYCLE_TRIAL_DIRECT_UPDATE_REQUIRED",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }
    if (entry.status === "cancelled") {
      for (const field of [
        "dateFrom",
        "dateTo",
        "startTime",
        "endTime",
        "locationId",
        "departmentId",
        "status",
        "note",
        "cancellationReason",
        "cancelledAt",
        "cancelledBy",
      ]) {
        if ((entry[field] ?? null) !== (current[field] ?? null)) {
          throw lifecycleError(
            "Eine protokollierte Absage darf nicht nachträglich überschrieben werden.",
            "PERSONNEL_LIFECYCLE_TRIAL_HISTORY_REQUIRED",
            PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
          );
        }
      }
    }
    for (const field of ["replacesAppointmentId"]) {
      if (entry[field] && current[field] !== entry[field]) {
        throw lifecycleError(
          "Eine gespeicherte Ersatztermin-Verknüpfung darf nicht mehr verändert werden.",
          "PERSONNEL_LIFECYCLE_TRIAL_HISTORY_REQUIRED",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
    }
    if (entry.replacementAppointmentId
      && current.replacementAppointmentId !== entry.replacementAppointmentId) {
      throw lifecycleError(
        "Eine gespeicherte Ersatztermin-Verknüpfung darf nicht mehr verändert werden.",
        "PERSONNEL_LIFECYCLE_TRIAL_HISTORY_REQUIRED",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }
    if (!entry.replacementAppointmentId && current.replacementAppointmentId
      && !allowNewReplacementLink) {
      throw lifecycleError(
        "Bitte einen Ersatztermin über die direkte Schnuppertermin-Bearbeitung speichern.",
        "PERSONNEL_LIFECYCLE_TRIAL_DIRECT_UPDATE_REQUIRED",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }
  }
  if (!allowCancellationTransition
    && (Array.isArray(after?.trialAppointments) ? after.trialAppointments : [])
      .some((entry) => entry.status === "cancelled"
        && !beforeEntries.some((current) => String(current.id) === String(entry.id)))) {
    throw lifecycleError(
      "Bitte eine Absage über die direkte Schnuppertermin-Bearbeitung speichern.",
      "PERSONNEL_LIFECYCLE_TRIAL_DIRECT_UPDATE_REQUIRED",
      PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
    );
  }
}

function structuredApplicationEntryWritable(access, entry) {
  if (!access || access.global) return true;
  const applicationScope = {
    desiredLocationId: entry.locationId,
    desiredDepartmentId: entry.departmentId ?? null,
  };
  return access.canReadApplication(applicationScope)
    && access.canWriteApplication(applicationScope);
}

function assertStructuredApplicationDeltaAccess(before, after, access) {
  if (!access || access.global) return;
  for (const field of ["targetAreas", "trialAppointments"]) {
    const beforeEntries = Array.isArray(before?.[field]) ? before[field] : [];
    const afterEntries = Array.isArray(after?.[field]) ? after[field] : [];
    const beforeByKey = new Map(beforeEntries.map((entry) => [
      structuredApplicationEntryKey(field, entry),
      entry,
    ]));
    const afterByKey = new Map(afterEntries.map((entry) => [
      structuredApplicationEntryKey(field, entry),
      entry,
    ]));
    for (const key of new Set([...beforeByKey.keys(), ...afterByKey.keys()])) {
      const beforeEntry = beforeByKey.get(key) || null;
      const afterEntry = afterByKey.get(key) || null;
      if (beforeEntry && afterEntry
        && structuredApplicationEntryValue(field, beforeEntry)
          === structuredApplicationEntryValue(field, afterEntry)) continue;
      if ((beforeEntry && !structuredApplicationEntryWritable(access, beforeEntry))
        || (afterEntry && !structuredApplicationEntryWritable(access, afterEntry))) {
        throw lifecycleError(
          "Schnuppertermine und Zielfilialen dürfen nur im freigegebenen eigenen Bereich geändert werden.",
          "PERSONNEL_LIFECYCLE_STRUCTURED_SCOPE_DENIED",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.FORBIDDEN,
        );
      }
    }
  }
}

function normalizeCompetencyRatings(value) {
  const submitted = Array.isArray(value) ? value : [];
  if (submitted.length > 40) {
    throw lifecycleError("Es wurden zu viele Kompetenzen angegeben.", "PERSONNEL_LIFECYCLE_INVALID");
  }
  const seen = new Set();
  return submitted.map((entry, index) => {
    const competency = plainRecord(entry, `Kompetenz ${index + 1}`);
    const id = text(competency.id, "Kompetenz-ID", 80, { required: true });
    if (seen.has(id)) {
      throw lifecycleError("Eine Kompetenz-ID wurde doppelt angegeben.", "PERSONNEL_LIFECYCLE_INVALID");
    }
    seen.add(id);
    return {
      id,
      label: text(competency.label, "Kompetenzbezeichnung", 120, { required: true }),
      rating: nullableInteger(competency.rating, "Kompetenzbewertung", { minimum: 1, maximum: 5 }),
      note: text(competency.note, "Kompetenzhinweis", 1000),
    };
  });
}

function normalizeTeamFeedback(value) {
  const submitted = Array.isArray(value) ? value : [];
  if (submitted.length > 200) {
    throw lifecycleError("Es wurden zu viele Teamrückmeldungen angegeben.", "PERSONNEL_LIFECYCLE_INVALID");
  }
  const seen = new Set();
  return submitted.map((entry, index) => {
    const feedback = plainRecord(entry, `Teamrückmeldung ${index + 1}`);
    const id = text(feedback.id, "Rückmeldungs-ID", 80, { required: true });
    if (seen.has(id)) {
      throw lifecycleError("Eine Rückmeldungs-ID wurde doppelt angegeben.", "PERSONNEL_LIFECYCLE_INVALID");
    }
    seen.add(id);
    const recordedAt = text(feedback.recordedAt, "Erfassungszeitpunkt", 40, { required: true });
    if (Number.isNaN(Date.parse(recordedAt))) {
      throw lifecycleError("Der Erfassungszeitpunkt einer Teamrückmeldung ist ungültig.", "PERSONNEL_LIFECYCLE_INVALID");
    }
    return {
      id,
      trialAppointmentId: nullableText(feedback.trialAppointmentId, "Schnuppertermin", 80),
      employeeNumber: text(feedback.employeeNumber, "Rückmeldendes Teammitglied", 120, { required: true }),
      rating: nullableInteger(feedback.rating, "Teamrückmeldung", { minimum: 1, maximum: 5 }),
      comment: text(feedback.comment, "Kommentar der Teamrückmeldung", 2000),
      recordedByEmployeeNumber: text(
        feedback.recordedByEmployeeNumber,
        "Erfassende Person",
        120,
        { required: true },
      ),
      recordedAt: new Date(recordedAt).toISOString(),
    };
  });
}

function normalizedEvaluationTimestamp(value, label, { nullable = false } = {}) {
  const normalized = nullable
    ? nullableText(value, label, 40)
    : text(value, label, 40, { required: true });
  if (normalized === null) return null;
  if (Number.isNaN(Date.parse(normalized))) {
    throw lifecycleError(`${label} ist ungültig.`, "PERSONNEL_LIFECYCLE_INVALID");
  }
  return new Date(normalized).toISOString();
}

function normalizeTeamEvaluationCriteria(value, { completed = false } = {}) {
  const submitted = Array.isArray(value) ? value : [];
  if (!submitted.length || submitted.length > 40) {
    throw lifecycleError(
      "Eine MA-Bewertung benötigt zwischen einer und 40 Kompetenzen.",
      "PERSONNEL_LIFECYCLE_INVALID",
    );
  }
  const seen = new Set();
  return submitted.map((entry, index) => {
    const criterion = plainRecord(entry, `Bewertungskriterium ${index + 1}`);
    const id = text(criterion.id, "Kriterien-ID", 80, { required: true });
    if (seen.has(id)) {
      throw lifecycleError("Eine Kriterien-ID wurde doppelt angegeben.", "PERSONNEL_LIFECYCLE_INVALID");
    }
    seen.add(id);
    const rating = nullableInteger(
      criterion.rating,
      "MA-Kompetenzbewertung",
      { minimum: 1, maximum: 5 },
    );
    const comment = text(criterion.comment, "Kommentar zur MA-Kompetenzbewertung", 1000);
    if (completed && rating === null) {
      throw lifecycleError(
        "Vor dem Absenden müssen alle Kompetenzen von 1 bis 5 bewertet werden.",
        "PERSONNEL_LIFECYCLE_TEAM_EVALUATION_INCOMPLETE",
      );
    }
    if (!completed && (rating !== null || comment)) {
      throw lifecycleError(
        "Eine noch offene MA-Bewertung darf keine vorab gespeicherten Antworten enthalten.",
        "PERSONNEL_LIFECYCLE_TEAM_EVALUATION_INVALID",
      );
    }
    return {
      id,
      label: text(criterion.label, "Kriterienbezeichnung", 120, { required: true }),
      rating,
      comment,
    };
  });
}

function normalizeTeamEvaluations(value) {
  const submitted = Array.isArray(value) ? value : [];
  if (submitted.length > 20) {
    throw lifecycleError(
      "Es wurden zu viele Personen zur MA-Bewertung zugewiesen.",
      "PERSONNEL_LIFECYCLE_INVALID",
    );
  }
  const seenIds = new Set();
  const seenEmployees = new Set();
  return submitted.map((entry, index) => {
    const evaluation = plainRecord(entry, `MA-Bewertung ${index + 1}`);
    const id = text(evaluation.id, "Bewertungs-ID", 80, { required: true });
    const employeeNumber = text(
      evaluation.employeeNumber,
      "Bewertendes Teammitglied",
      120,
      { required: true },
    );
    if (seenIds.has(id) || seenEmployees.has(employeeNumber)) {
      throw lifecycleError(
        "Eine MA-Bewertung oder bewertende Person wurde doppelt zugewiesen.",
        "PERSONNEL_LIFECYCLE_INVALID",
      );
    }
    seenIds.add(id);
    seenEmployees.add(employeeNumber);
    const submittedAt = normalizedEvaluationTimestamp(
      evaluation.submittedAt,
      "Abgabezeitpunkt der MA-Bewertung",
      { nullable: true },
    );
    return {
      id,
      trialAppointmentId: nullableText(evaluation.trialAppointmentId, "Schnuppertermin", 80),
      employeeNumber,
      assignedByEmployeeNumber: text(
        evaluation.assignedByEmployeeNumber,
        "Zuweisende Person",
        120,
        { required: true },
      ),
      assignedAt: normalizedEvaluationTimestamp(
        evaluation.assignedAt,
        "Zuweisungszeitpunkt der MA-Bewertung",
      ),
      submittedAt,
      criteria: normalizeTeamEvaluationCriteria(
        evaluation.criteria,
        { completed: Boolean(submittedAt) },
      ),
    };
  });
}

function averageRatings(values) {
  const ratings = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= 5);
  return ratings.length
    ? ratings.reduce((total, value) => total + value, 0) / ratings.length
    : null;
}

function summarizeApplicationEvaluations(application = {}) {
  const flRatings = Array.isArray(application.competencyRatings)
    ? application.competencyRatings.filter(Boolean)
    : [];
  const evaluations = Array.isArray(application.teamEvaluations)
    ? application.teamEvaluations.filter(Boolean)
    : [];
  const completed = evaluations.filter((evaluation) => Boolean(evaluation.submittedAt));
  const criteria = new Map();
  for (const rating of flRatings) {
    if (!rating?.id) continue;
    criteria.set(String(rating.id), {
      id: String(rating.id),
      label: String(rating.label || rating.id),
    });
  }
  for (const evaluation of evaluations) {
    for (const criterion of evaluation.criteria || []) {
      if (!criterion?.id || criteria.has(String(criterion.id))) continue;
      criteria.set(String(criterion.id), {
        id: String(criterion.id),
        label: String(criterion.label || criterion.id),
      });
    }
  }
  const rows = [...criteria.values()].map((criterion) => {
    const fl = flRatings.find((rating) => String(rating.id) === criterion.id) || null;
    const reviewerRatings = completed.map((evaluation) => {
      const rating = (evaluation.criteria || [])
        .find((entry) => String(entry.id) === criterion.id);
      return rating?.rating ? {
        evaluationId: evaluation.id,
        employeeNumber: evaluation.employeeNumber,
        rating: Number(rating.rating),
        comment: String(rating.comment || ""),
        submittedAt: evaluation.submittedAt,
      } : null;
    }).filter(Boolean);
    const flRating = fl?.rating ? Number(fl.rating) : null;
    const employeeAverage = averageRatings(reviewerRatings.map((rating) => rating.rating));
    const combinedAverage = flRating !== null && employeeAverage !== null
      ? averageRatings([flRating, employeeAverage])
      : null;
    return {
      ...criterion,
      flRating,
      flComment: String(fl?.note || ""),
      employeeAverage,
      combinedAverage,
      reviewerRatings,
    };
  });
  return {
    assignedCount: evaluations.length,
    completedCount: completed.length,
    pendingCount: evaluations.length - completed.length,
    flOverall: averageRatings(rows.map((row) => row.flRating)),
    employeeOverall: averageRatings(rows.map((row) => row.employeeAverage)),
    combinedOverall: averageRatings(rows.map((row) => row.combinedAverage)),
    criteria: rows,
  };
}

function normalizeSubmittedTeamEvaluationCriteria(value, snapshot) {
  const submitted = Array.isArray(value) ? value : [];
  const expected = Array.isArray(snapshot) ? snapshot : [];
  if (submitted.length !== expected.length) {
    throw lifecycleError(
      "Die Bewertungskriterien haben sich geändert. Bitte die Bewertungsseite neu laden.",
      "PERSONNEL_LIFECYCLE_TEAM_EVALUATION_CRITERIA_CONFLICT",
      PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
    );
  }
  const byId = new Map();
  submitted.forEach((entry, index) => {
    const criterion = plainRecord(entry, `Bewertungskriterium ${index + 1}`);
    const id = text(criterion.id, "Kriterien-ID", 80, { required: true });
    if (byId.has(id)) {
      throw lifecycleError("Eine Kriterien-ID wurde doppelt angegeben.", "PERSONNEL_LIFECYCLE_INVALID");
    }
    byId.set(id, criterion);
  });
  return expected.map((criterion) => {
    const answer = byId.get(String(criterion.id));
    if (!answer) {
      throw lifecycleError(
        "Die Bewertungskriterien haben sich geändert. Bitte die Bewertungsseite neu laden.",
        "PERSONNEL_LIFECYCLE_TEAM_EVALUATION_CRITERIA_CONFLICT",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }
    return {
      id: criterion.id,
      label: criterion.label,
      rating: nullableInteger(
        answer.rating,
        "MA-Kompetenzbewertung",
        { minimum: 1, maximum: 5 },
      ),
      comment: text(answer.comment, "Kommentar zur MA-Kompetenzbewertung", 1000),
    };
  }).map((criterion) => {
    if (criterion.rating === null) {
      throw lifecycleError(
        "Vor dem Absenden müssen alle Kompetenzen von 1 bis 5 bewertet werden.",
        "PERSONNEL_LIFECYCLE_TEAM_EVALUATION_INCOMPLETE",
      );
    }
    return criterion;
  });
}

function requireDataProcessingAuthorizationConfirmation(value) {
  if (value !== true) {
    throw lifecycleError(
      "Vor der Bewerberanlage muss bestätigt werden, dass die Erlaubnis zur EDV-gestützten Verarbeitung im Grabenplaner vorliegt.",
      "PERSONNEL_LIFECYCLE_DATA_PROCESSING_AUTHORIZATION_REQUIRED",
    );
  }
  return true;
}

function normalizeStoredCandidateProfile(value) {
  const submitted = exactPayloadKeys(
    value,
    CANDIDATE_PROFILE_PAYLOAD_KEYS,
    "Geschütztes Bewerberprofil",
  );
  exactPayloadKeys(
    submitted.address,
    CANDIDATE_ADDRESS_PAYLOAD_KEYS,
    "Geschützte Bewerberadresse",
  );
  return normalizeCandidateProfile(submitted);
}

function weeklyMinutes(value, base = null) {
  if (Object.prototype.hasOwnProperty.call(value, "desiredWeeklyMinutes")) {
    return nullableInteger(value.desiredWeeklyMinutes, "Gewünschtes Wochenausmaß", { maximum: 10080 });
  }
  if (Object.prototype.hasOwnProperty.call(value, "desiredWeeklyHours")) {
    if (value.desiredWeeklyHours === null || value.desiredWeeklyHours === "") return null;
    const hours = Number(value.desiredWeeklyHours);
    const minutes = Math.round(hours * 60);
    if (!Number.isFinite(hours) || hours < 0 || hours > 168 || Math.abs(minutes / 60 - hours) > 0.000001) {
      throw lifecycleError("Das gewünschte Wochenausmaß ist ungültig.", "PERSONNEL_LIFECYCLE_INVALID");
    }
    return minutes;
  }
  return base;
}

function normalizeApplication(value = {}, base = null, { trustedStored = false } = {}) {
  const submitted = plainRecord(value, "Bewerbung");
  const current = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  let desiredDepartmentId = nullableInteger(
    valueOrBase(submitted, "desiredDepartmentId", current, null),
    "Gewünschte Abteilung",
    { minimum: 1 },
  );
  let desiredLocationId = nullableText(
    valueOrBase(submitted, "desiredLocationId", current, null),
    "Gewünschter Standort",
    80,
  );
  if (desiredDepartmentId !== null && !desiredLocationId) {
    throw lifecycleError(
      "Für eine gewünschte Abteilung muss auch der Standort angegeben werden.",
      "PERSONNEL_LIFECYCLE_SCOPE_INVALID",
    );
  }
  const targetScope = normalizeApplicationTargetScope(
    submitted,
    current,
    desiredLocationId,
    desiredDepartmentId,
  );
  desiredLocationId = targetScope.desiredLocationId;
  desiredDepartmentId = targetScope.desiredDepartmentId;
  const internalRating = nullableInteger(
    valueOrBase(submitted, "internalRating", current, null),
    "Interne Bewertung",
    { minimum: 1, maximum: 5 },
  );
  const normalized = {
    desiredPositionId: nullableText(
      valueOrBase(submitted, "desiredPositionId", current, null),
      "Gewünschte Position",
      100,
    ),
    desiredLocationId,
    desiredDepartmentId,
    desiredWeeklyMinutes: weeklyMinutes(submitted, current.desiredWeeklyMinutes ?? null),
    availableFrom: isoDate(valueOrBase(submitted, "availableFrom", current, null), "Möglicher Eintritt"),
    ownerEmployeeNumber: nullableText(
      valueOrBase(submitted, "ownerEmployeeNumber", current),
      "Verantwortliche Person",
      120,
    ),
    retentionDueAt: isoDate(
      valueOrBase(submitted, "retentionDueAt", current, null),
      "Aufbewahrungsprüfung",
    ),
    protected: {
      desiredRoleTitle: text(
        valueOrBase(submitted, "desiredRoleTitle", current),
        "Gewünschte Tätigkeit",
        180,
      ),
      employmentType: text(
        valueOrBase(submitted, "employmentType", current),
        "Beschäftigungsart",
        100,
      ),
      source: text(valueOrBase(submitted, "source", current), "Quelle", 200),
      internalRating,
      internalNotes: text(
        valueOrBase(submitted, "internalNotes", current),
        "Interne Notiz",
        4000,
      ),
      communicationNotes: text(
        valueOrBase(submitted, "communicationNotes", current),
        "Kommunikationsnotiz",
        4000,
      ),
      tags: Object.prototype.hasOwnProperty.call(submitted, "tags")
        ? stringList(submitted.tags, "Tags")
        : stringList(current.tags || [], "Tags"),
    },
  };
  if (Object.prototype.hasOwnProperty.call(submitted, "targetAreas")
    || Object.prototype.hasOwnProperty.call(current, "targetAreas")
    || targetScope.targetAreas.length) {
    normalized.protected.targetAreas = targetScope.targetAreas;
  }
  for (const [key, normalizer] of [
    ["trialAppointments", (appointments) => (
      trustedStored
        ? normalizeTrialAppointments(appointments)
        : normalizeSubmittedTrialAppointments(appointments, current.trialAppointments || [])
    )],
    ["competencyRatings", normalizeCompetencyRatings],
  ]) {
    if (Object.prototype.hasOwnProperty.call(submitted, key)
      || Object.prototype.hasOwnProperty.call(current, key)) {
      normalized.protected[key] = Object.prototype.hasOwnProperty.call(submitted, key)
        ? normalizer(submitted[key])
        : normalizer(current[key] || []);
    }
  }
  if (Object.prototype.hasOwnProperty.call(current, "teamFeedback")) {
    normalized.protected.teamFeedback = normalizeTeamFeedback(current.teamFeedback || []);
  } else if (trustedStored && Object.prototype.hasOwnProperty.call(submitted, "teamFeedback")) {
    normalized.protected.teamFeedback = normalizeTeamFeedback(submitted.teamFeedback || []);
  }
  if (Object.prototype.hasOwnProperty.call(current, "teamEvaluations")) {
    normalized.protected.teamEvaluations = normalizeTeamEvaluations(current.teamEvaluations || []);
  } else if (trustedStored && Object.prototype.hasOwnProperty.call(submitted, "teamEvaluations")) {
    normalized.protected.teamEvaluations = normalizeTeamEvaluations(submitted.teamEvaluations || []);
  }
  return normalized;
}

function normalizeStoredApplicationPayload(value) {
  const submitted = exactPayloadKeys(
    value,
    APPLICATION_PAYLOAD_KEYS,
    "Geschützte Bewerbung",
  );
  return normalizeApplication(submitted, null, { trustedStored: true }).protected;
}

function normalizeStoredDocumentPayload(value) {
  const submitted = exactPayloadKeys(
    value,
    DOCUMENT_PAYLOAD_KEYS,
    "Geschütztes Bewerberdokument",
  );
  return {
    title: text(submitted.title, "Dokumenttitel", 180, { required: true }),
    description: text(submitted.description, "Dokumentbeschreibung", 2000),
  };
}

function normalizeStoredDocumentVersionPayload(value) {
  const submitted = exactPayloadKeys(
    value,
    DOCUMENT_VERSION_PAYLOAD_KEYS,
    "Geschützte Dokumentversion",
  );
  return {
    originalFilename: text(submitted.originalFilename, "Dateiname", 240, { required: true }),
    note: text(submitted.note, "Versionshinweis", 1000),
  };
}

function normalizeDocument(value = {}) {
  const submitted = plainRecord(value, "Bewerberdokument");
  return {
    categoryId: text(submitted.categoryId, "Dokumentkategorie", 80, { required: true }),
    visibility: text(submitted.visibility, "Dokumentsichtbarkeit", 40),
    applicationId: nullableText(submitted.applicationId, "Bewerbung", 80),
    documentDate: isoDate(submitted.documentDate, "Dokumentdatum"),
    expiresOn: isoDate(submitted.expiresOn, "Ablaufdatum"),
    retentionDueAt: isoDate(submitted.retentionDueAt, "Aufbewahrungsprüfung"),
    protected: {
      title: text(submitted.title, "Dokumenttitel", 180, { required: true }),
      description: text(submitted.description, "Dokumentbeschreibung", 2000),
    },
  };
}

function normalizeDocumentVersion(value = {}) {
  const submitted = plainRecord(value, "Dokumentversion");
  const storageKey = text(submitted.storageKey, "Speicherschlüssel", 180, { required: true }).toLowerCase();
  if (!/^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.amu$/.test(storageKey)) {
    throw lifecycleError("Der Speicherschlüssel der Dokumentversion ist ungültig.", "PERSONNEL_LIFECYCLE_DOCUMENT_INVALID");
  }
  const contentSha256 = text(submitted.contentSha256, "SHA-256", 64, { required: true }).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
    throw lifecycleError("Die SHA-256-Prüfsumme der Dokumentversion ist ungültig.", "PERSONNEL_LIFECYCLE_DOCUMENT_INVALID");
  }
  const sizeBytes = nullableInteger(submitted.sizeBytes, "Dateigröße", {
    minimum: 1,
    maximum: 50 * 1024 * 1024,
  });
  if (sizeBytes === null) {
    throw lifecycleError("Die Dateigröße fehlt.", "PERSONNEL_LIFECYCLE_DOCUMENT_INVALID");
  }
  const mediaType = text(submitted.mediaType, "Dateityp", 120, { required: true }).toLowerCase();
  if (!DOCUMENT_MEDIA_TYPES.includes(mediaType)) {
    throw lifecycleError("Der Dateityp der Dokumentversion ist ungültig.", "PERSONNEL_LIFECYCLE_DOCUMENT_INVALID");
  }
  return {
    storageKey,
    contentSha256,
    sizeBytes,
    mediaType,
    protected: {
      originalFilename: text(submitted.originalFilename, "Dateiname", 240, { required: true }),
      note: text(submitted.note, "Versionshinweis", 1000),
    },
  };
}

function candidateProtectionContext(row) {
  const id = String(row.id || row.candidateId || row.candidate_id || "");
  return {
    namespace: "candidate-profile",
    recordId: id,
    field: "payload",
    employeeNumber: `candidate:${id}`,
  };
}

function candidateApplicationProtectionContext(row) {
  const candidateId = String(row.candidateId || row.candidate_id || "");
  const id = String(row.id || row.applicationId || row.application_id || "");
  return {
    namespace: "candidate-application",
    recordId: id,
    field: "payload",
    employeeNumber: `candidate:${candidateId}`,
  };
}

function candidateDocumentProtectionContext(row) {
  const candidateId = String(row.candidateId || row.candidate_id || "");
  const id = String(row.id || row.documentId || row.document_id || "");
  return {
    namespace: "candidate-document",
    recordId: id,
    field: "payload",
    employeeNumber: `candidate:${candidateId}`,
  };
}

function candidateDocumentVersionProtectionContext(row) {
  const candidateId = String(row.candidateId || row.candidate_id || "");
  const documentId = String(row.documentId || row.document_id || "");
  const versionNumber = Number(row.versionNumber || row.version_number || 0);
  return {
    namespace: "candidate-document-version",
    recordId: `${documentId}:${versionNumber}`,
    field: "payload",
    employeeNumber: `candidate:${candidateId}`,
  };
}

function candidateEventProtectionContext(row) {
  const candidateId = String(row.candidateId || row.candidate_id || "");
  const id = String(row.id || row.eventId || "");
  return {
    namespace: "candidate-event",
    recordId: id,
    field: "payload",
    employeeNumber: `candidate:${candidateId}`,
  };
}

function candidateConversionProtectionContext(row) {
  const candidateId = String(row.candidateId || row.candidate_id || "");
  const id = String(row.id || row.conversionId || row.conversion_id || "");
  return {
    namespace: "candidate-conversion",
    recordId: id,
    field: "payload",
    employeeNumber: `candidate:${candidateId}`,
  };
}

function eventReceiptBody(row) {
  return {
    schemaVersion: 1,
    id: row.id,
    candidateId: row.candidateId,
    sequenceNumber: row.sequenceNumber,
    applicationId: row.applicationId || null,
    documentId: row.documentId || null,
    eventType: row.eventType,
    protectedPayload: row.protectedPayload,
    previousReceiptSha256: row.previousReceiptSha256,
    actorEmployeeNumber: row.actorEmployeeNumber,
    createdAt: row.createdAt,
  };
}

function conversionReceiptBody(row) {
  return {
    schemaVersion: 1,
    id: row.id,
    candidateId: row.candidateId,
    applicationId: row.applicationId,
    employeeNumber: row.employeeNumber,
    requestSha256: row.requestSha256,
    protectedPayload: row.protectedPayload,
    actorEmployeeNumber: row.actorEmployeeNumber,
    createdAt: row.createdAt,
  };
}

function normalizeStoredConversionPayload(value) {
  const payload = exactPayloadKeys(
    value,
    ["policies", "requestSha256", "schemaVersion", "source", "target"],
    "Geschützter Umwandlungsbeleg",
  );
  if (payload.schemaVersion !== 1) {
    throw new Error("Der geschützte Umwandlungsbeleg hat eine unbekannte Version.");
  }
  if (!SHA256_PATTERN.test(String(payload.requestSha256 || ""))) {
    throw new Error("Der geschützte Umwandlungsbeleg enthält keinen gültigen Anfragebeleg.");
  }
  const source = exactPayloadKeys(
    payload.source,
    ["application", "candidate"],
    "Quellsnapshot der Umwandlung",
  );
  const target = exactPayloadKeys(
    payload.target,
    ["employee"],
    "Zielsnapshot der Umwandlung",
  );
  const policies = exactPayloadKeys(
    payload.policies,
    ["documentTransfer", "onboarding", "portalAccess"],
    "Richtlinien der Umwandlung",
  );
  if (policies.documentTransfer !== "none"
    || policies.onboarding !== "deferred"
    || policies.portalAccess !== "none") {
    throw new Error("Der geschützte Umwandlungsbeleg enthält unzulässige Richtlinien.");
  }
  const candidate = exactPayloadKeys(
    source.candidate,
    ["id", "profile", "revision", "schemaVersion", "state"],
    "Bewerber-Quellsnapshot",
  );
  const application = exactPayloadKeys(
    source.application,
    [
      "availableFrom",
      "candidateId",
      "communicationNotes",
      "competencyRatings",
      "desiredDepartmentId",
      "desiredLocationId",
      "desiredPositionId",
      "desiredRoleTitle",
      "desiredWeeklyMinutes",
      "employmentType",
      "id",
      "internalNotes",
      "internalRating",
      "ownerEmployeeNumber",
      "retentionDueAt",
      "revision",
      "schemaVersion",
      "source",
      "status",
      "targetAreas",
      "teamFeedback",
      "teamEvaluations",
      "tags",
      "trialAppointments",
    ],
    "Bewerbungs-Quellsnapshot",
  );
  return {
    schemaVersion: 1,
    requestSha256: payload.requestSha256,
    policies: {
      documentTransfer: "none",
      onboarding: "deferred",
      portalAccess: "none",
    },
    source: {
      candidate: jsonSnapshot(candidate, "Bewerber-Quellsnapshot"),
      application: jsonSnapshot(application, "Bewerbungs-Quellsnapshot", {
        maximumBytes: MAX_APPLICATION_STATE_BYTES,
      }),
    },
    target: {
      employee: jsonSnapshot(target.employee, "Mitarbeiter-Zielsnapshot"),
    },
  };
}

function candidateStateBody(candidate) {
  return {
    schemaVersion: 1,
    id: candidate.id,
    state: candidate.state,
    profile: candidate.profile,
    revision: candidate.revision,
  };
}

function applicationStateBody(application) {
  const body = {
    schemaVersion: 1,
    id: application.id,
    candidateId: application.candidateId,
    status: application.status,
    desiredPositionId: application.desiredPositionId,
    desiredLocationId: application.desiredLocationId,
    desiredDepartmentId: application.desiredDepartmentId,
    desiredWeeklyMinutes: application.desiredWeeklyMinutes,
    availableFrom: application.availableFrom,
    ownerEmployeeNumber: application.ownerEmployeeNumber,
    retentionDueAt: application.retentionDueAt,
    desiredRoleTitle: application.desiredRoleTitle,
    employmentType: application.employmentType,
    source: application.source,
    internalRating: application.internalRating,
    internalNotes: application.internalNotes,
    communicationNotes: application.communicationNotes,
    tags: application.tags,
    revision: application.revision,
  };
  for (const key of [
    "competencyRatings",
    "targetAreas",
    "teamFeedback",
    "teamEvaluations",
    "trialAppointments",
  ]) {
    if (Object.prototype.hasOwnProperty.call(application, key)) {
      body[key] = application[key];
    }
  }
  return body;
}

function assertApplicationStateSize(application) {
  const bytes = Buffer.byteLength(JSON.stringify(applicationStateBody(application)), "utf8");
  if (bytes > MAX_APPLICATION_STATE_BYTES) {
    throw lifecycleError(
      "Die strukturierten Bewerbungsdaten sind zu umfangreich. Bitte Notizen oder Einträge kürzen.",
      "PERSONNEL_LIFECYCLE_APPLICATION_STATE_TOO_LARGE",
    );
  }
}

function documentStateBody(document) {
  return {
    schemaVersion: 1,
    id: document.id,
    candidateId: document.candidateId,
    applicationId: document.applicationId,
    categoryId: document.categoryId,
    visibility: document.visibility,
    status: document.status,
    currentVersion: document.currentVersion,
    documentDate: document.documentDate,
    expiresOn: document.expiresOn,
    retentionDueAt: document.retentionDueAt,
    title: document.title,
    description: document.description,
    versions: document.versions.map((version) => ({
      versionNumber: version.versionNumber,
      contentSha256: version.contentSha256,
      sizeBytes: version.sizeBytes,
      mediaType: version.mediaType,
      storageKey: version[DOCUMENT_VERSION_STORAGE_KEY],
      originalFilename: version.originalFilename,
      note: version.note,
      uploadedBy: version.uploadedBy,
      createdAt: version.createdAt,
    })),
    revision: document.revision,
  };
}

function stateSha256(body) {
  return canonicalSha256(body);
}

function changedStateFields(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("schemaVersion");
  return [...keys]
    .filter((key) => {
      const beforeHasKey = Object.prototype.hasOwnProperty.call(before, key);
      const afterHasKey = Object.prototype.hasOwnProperty.call(after, key);
      return beforeHasKey !== afterHasKey
        || canonicalSha256(before[key]) !== canonicalSha256(after[key]);
    })
    .sort();
}

function createPersonnelLifecycleService(repository, {
  protectJson,
  parseProtectedJson,
  createId = randomUUID,
  now = () => new Date(),
  conversionAvailable = true,
} = {}) {
  assertPersonnelLifecycleRepository(repository);
  if (typeof protectJson !== "function" || typeof parseProtectedJson !== "function"
    || typeof createId !== "function" || typeof now !== "function"
    || typeof conversionAvailable !== "boolean") {
    throw new TypeError("Für das Personalmodul fehlen sichere Laufzeitfunktionen.");
  }

  function occurredAt() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw lifecycleError("Der Ereigniszeitpunkt ist ungültig.", "PERSONNEL_LIFECYCLE_TIME_INVALID");
    }
    return date.toISOString();
  }

  function actorId(value) {
    return text(value || "system", "Bearbeitende Person", 120, { required: true });
  }

  function parsePayload(value, context, code, normalize = null) {
    try {
      const parsed = plainRecord(parseProtectedJson(value, context), "Geschützter Datensatz");
      return typeof normalize === "function" ? normalize(parsed) : parsed;
    } catch (error) {
      throw lifecycleError(
        "Geschützte Bewerberdaten konnten nicht sicher gelesen werden.",
        code,
        PERSONNEL_LIFECYCLE_ERROR_KINDS.INTEGRITY,
      );
    }
  }

  function protectPayload(value, context) {
    try {
      const protectedPayload = protectJson(value, context);
      if (typeof protectedPayload !== "string" || !protectedPayload) throw new Error("empty payload");
      return protectedPayload;
    } catch (error) {
      if (error instanceof PersonnelLifecycleError) throw error;
      throw lifecycleError(
        "Bewerberdaten konnten nicht sicher geschützt werden.",
        "PERSONNEL_LIFECYCLE_PROTECTION_UNAVAILABLE",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.INTEGRITY,
      );
    }
  }

  function serializeApplication(row) {
    const protectedFields = parsePayload(
      row.protectedPayload,
      candidateApplicationProtectionContext(row),
      "PERSONNEL_LIFECYCLE_APPLICATION_INTEGRITY_FAILED",
      normalizeStoredApplicationPayload,
    );
    const application = {
      id: row.id,
      candidateId: row.candidateId,
      status: row.status,
      desiredPositionId: row.desiredPositionId || null,
      desiredLocationId: row.desiredLocationId || null,
      desiredDepartmentId: row.desiredDepartmentId ?? null,
      desiredWeeklyMinutes: row.desiredWeeklyMinutes ?? null,
      availableFrom: row.availableFrom || null,
      ownerEmployeeNumber: row.ownerEmployeeNumber || null,
      retentionDueAt: row.retentionDueAt || null,
      desiredRoleTitle: protectedFields.desiredRoleTitle,
      employmentType: protectedFields.employmentType,
      source: protectedFields.source,
      internalRating: protectedFields.internalRating,
      internalNotes: protectedFields.internalNotes,
      communicationNotes: protectedFields.communicationNotes,
      tags: protectedFields.tags,
      revision: row.revision,
      statusChangedAt: row.statusChangedAt,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    for (const key of [
      "competencyRatings",
      "targetAreas",
      "teamFeedback",
      "teamEvaluations",
      "trialAppointments",
    ]) {
      if (Object.prototype.hasOwnProperty.call(protectedFields, key)) {
        application[key] = protectedFields[key];
      }
    }
    if (Object.prototype.hasOwnProperty.call(application, "targetAreas")) {
      const preferred = preferredTargetArea(application.targetAreas);
      const consistent = preferred
        ? targetAreaMatches(
            preferred,
            application.desiredLocationId,
            application.desiredDepartmentId,
          )
        : application.desiredLocationId === null && application.desiredDepartmentId === null;
      if (!consistent) {
        throw lifecycleError(
          "Der bevorzugte Zielbereich der Bewerbung ist nicht konsistent.",
          "PERSONNEL_LIFECYCLE_APPLICATION_INTEGRITY_FAILED",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.INTEGRITY,
        );
      }
    }
    application.evaluationSummary = summarizeApplicationEvaluations(application);
    return application;
  }

  function invalidConversionReceipt() {
    throw lifecycleError(
      "Der Umwandlungsbeleg ist nicht konsistent.",
      "PERSONNEL_LIFECYCLE_CONVERSION_INTEGRITY_FAILED",
      PERSONNEL_LIFECYCLE_ERROR_KINDS.INTEGRITY,
    );
  }

  function serializeConversion(row) {
    if (!row || !CONVERSION_ID_PATTERN.test(String(row.id || ""))
      || !SHA256_PATTERN.test(String(row.requestSha256 || ""))
      || !SHA256_PATTERN.test(String(row.receiptSha256 || ""))
      || row.receiptSha256 !== canonicalSha256(conversionReceiptBody(row))) {
      invalidConversionReceipt();
    }
    const snapshot = parsePayload(
      row.protectedPayload,
      candidateConversionProtectionContext(row),
      "PERSONNEL_LIFECYCLE_CONVERSION_INTEGRITY_FAILED",
      normalizeStoredConversionPayload,
    );
    const sourceCandidate = snapshot.source.candidate;
    const sourceApplication = snapshot.source.application;
    const targetEmployeeNumber = String(
      snapshot.target.employee.personnelNumber
        ?? snapshot.target.employee.personnel_number
        ?? "",
    );
    if (sourceCandidate.schemaVersion !== 1
      || sourceCandidate.id !== row.candidateId
      || sourceCandidate.state !== "active"
      || !Number.isSafeInteger(sourceCandidate.revision)
      || sourceCandidate.revision < 1
      || sourceApplication.schemaVersion !== 1
      || sourceApplication.id !== row.applicationId
      || sourceApplication.candidateId !== row.candidateId
      || sourceApplication.status !== "preboarding"
      || !Number.isSafeInteger(sourceApplication.revision)
      || sourceApplication.revision < 1
      || snapshot.requestSha256 !== row.requestSha256
      || targetEmployeeNumber !== row.employeeNumber) {
      invalidConversionReceipt();
    }
    const projection = {
      id: row.id,
      candidateId: row.candidateId,
      applicationId: row.applicationId,
      employeeNumber: row.employeeNumber,
      actorEmployeeNumber: row.actorEmployeeNumber,
      createdAt: row.createdAt,
    };
    Object.defineProperty(projection, CONVERSION_INTERNAL, {
      enumerable: false,
      value: Object.freeze({
        receiptSha256: row.receiptSha256,
        requestSha256: row.requestSha256,
        snapshot,
      }),
    });
    return projection;
  }

  function verifyEventRows(rows) {
    let previousReceiptSha256 = "";
    let sequenceNumber = 0;
    return rows.map((row) => {
      sequenceNumber += 1;
      const expectedReceipt = canonicalSha256(eventReceiptBody(row));
      if (row.sequenceNumber !== sequenceNumber
        || row.previousReceiptSha256 !== previousReceiptSha256
        || row.receiptSha256 !== expectedReceipt) {
        throw lifecycleError(
          "Die Bewerberhistorie ist nicht konsistent.",
          "PERSONNEL_LIFECYCLE_EVENT_INTEGRITY_FAILED",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.INTEGRITY,
        );
      }
      const detail = parsePayload(
        row.protectedPayload,
        candidateEventProtectionContext(row),
        "PERSONNEL_LIFECYCLE_EVENT_INTEGRITY_FAILED",
      );
      previousReceiptSha256 = row.receiptSha256;
      return {
        id: row.id,
        sequenceNumber: row.sequenceNumber,
        applicationId: row.applicationId || null,
        documentId: row.documentId || null,
        eventType: row.eventType,
        detail,
        previousReceiptSha256: row.previousReceiptSha256,
        receiptSha256: row.receiptSha256,
        actorEmployeeNumber: row.actorEmployeeNumber,
        createdAt: row.createdAt,
      };
    });
  }

  function verifyCurrentStateReceipts(candidate, applications, documents, history) {
    let candidateReceipt = null;
    const applicationReceipts = new Map();
    const documentReceipts = new Map();
    const invalidStateChain = () => {
      throw lifecycleError(
        "Die Zustandskette der Bewerberhistorie ist nicht konsistent.",
        "PERSONNEL_LIFECYCLE_STATE_INTEGRITY_FAILED",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.INTEGRITY,
      );
    };
    const receiptFrom = (event, key) => {
      const receipt = String(event.detail?.[key] || "");
      if (!/^[a-f0-9]{64}$/.test(receipt)) invalidStateChain();
      return receipt;
    };
    const startEntityState = (event, receipts, entityId) => {
      if (!entityId || receipts.has(entityId) || event.detail?.previousStateSha256) {
        invalidStateChain();
      }
      receipts.set(entityId, receiptFrom(event, "stateSha256"));
    };
    const advanceEntityState = (event, receipts, entityId) => {
      if (!entityId || !receipts.has(entityId)
        || receiptFrom(event, "previousStateSha256") !== receipts.get(entityId)) {
        invalidStateChain();
      }
      receipts.set(entityId, receiptFrom(event, "stateSha256"));
    };
    for (const event of history) {
      if (event.eventType === "candidate_created") {
        if (candidateReceipt !== null || event.detail?.previousStateSha256) invalidStateChain();
        candidateReceipt = receiptFrom(event, "stateSha256");
      } else if (["candidate_updated", "candidate_archived"].includes(event.eventType)) {
        if (candidateReceipt === null
          || receiptFrom(event, "previousStateSha256") !== candidateReceipt) {
          invalidStateChain();
        }
        candidateReceipt = receiptFrom(event, "stateSha256");
      } else if (event.eventType === "application_created") {
        startEntityState(event, applicationReceipts, event.applicationId);
      } else if ([
        "application_updated",
        "application_status_changed",
      ].includes(event.eventType)) {
        advanceEntityState(event, applicationReceipts, event.applicationId);
      } else if (event.eventType === "document_registered") {
        startEntityState(event, documentReceipts, event.documentId);
      } else if ([
        "document_version_added",
        "document_archived",
        "retention_review_requested",
      ].includes(event.eventType)) {
        advanceEntityState(event, documentReceipts, event.documentId);
      } else {
        invalidStateChain();
      }
    }
    const invalid = candidateReceipt === null
      || candidateReceipt !== stateSha256(candidateStateBody(candidate))
      || applications.some((application) => (
        applicationReceipts.get(application.id) !== stateSha256(applicationStateBody(application))
      ))
      || documents.some((document) => (
        documentReceipts.get(document.id) !== stateSha256(documentStateBody(document))
      ));
    if (invalid) {
      throw lifecycleError(
        "Der aktuelle Bewerberzustand stimmt nicht mit seiner Historie überein.",
        "PERSONNEL_LIFECYCLE_STATE_INTEGRITY_FAILED",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.INTEGRITY,
      );
    }
  }

  function verifyConversionRelation(candidate, conversion) {
    const convertedApplications = candidate.applications.filter(({ status }) => status === "converted");
    if (!conversion) {
      if (convertedApplications.length) invalidConversionReceipt();
      return;
    }
    const internal = conversion[CONVERSION_INTERNAL];
    const application = candidate.applications.find(({ id }) => id === conversion.applicationId);
    if (!internal || conversion.candidateId !== candidate.id
      || candidate.state !== "archived"
      || !application
      || application.status !== "converted"
      || convertedApplications.length !== 1) {
      invalidConversionReceipt();
    }

    const sourceCandidate = internal.snapshot.source.candidate;
    const sourceApplication = internal.snapshot.source.application;
    if (candidate.revision !== sourceCandidate.revision + 1
      || application.revision !== sourceApplication.revision + 1
      || candidate.archivedAt !== conversion.createdAt
      || candidate.updatedAt !== conversion.createdAt
      || candidate.updatedBy !== conversion.actorEmployeeNumber
      || application.statusChangedAt !== conversion.createdAt
      || application.updatedAt !== conversion.createdAt
      || application.updatedBy !== conversion.actorEmployeeNumber) {
      invalidConversionReceipt();
    }

    const linkedEvents = candidate.history.filter((event) => (
      event.detail?.conversionId === conversion.id
    ));
    const applicationEvent = linkedEvents.find((event) => (
      event.eventType === "application_status_changed"
      && event.applicationId === conversion.applicationId
    ));
    const candidateEvent = linkedEvents.find((event) => event.eventType === "candidate_archived");
    if (linkedEvents.length !== 2 || !applicationEvent || !candidateEvent
      || applicationEvent.sequenceNumber >= candidateEvent.sequenceNumber
      || applicationEvent.actorEmployeeNumber !== conversion.actorEmployeeNumber
      || candidateEvent.actorEmployeeNumber !== conversion.actorEmployeeNumber
      || applicationEvent.createdAt !== conversion.createdAt
      || candidateEvent.createdAt !== conversion.createdAt
      || applicationEvent.detail.from !== "preboarding"
      || applicationEvent.detail.to !== "converted"
      || applicationEvent.detail.employeeNumber !== conversion.employeeNumber
      || candidateEvent.detail.reason !== "conversion"
      || applicationEvent.detail.previousStateSha256 !== stateSha256(sourceApplication)
      || applicationEvent.detail.stateSha256 !== stateSha256(applicationStateBody(application))
      || candidateEvent.detail.previousStateSha256 !== stateSha256(sourceCandidate)
      || candidateEvent.detail.stateSha256 !== stateSha256(candidateStateBody(candidate))) {
      invalidConversionReceipt();
    }
  }

  async function appendEvent(transactionRepository, {
    candidateId,
    applicationId = null,
    documentId = null,
    eventType,
    detail,
    actor,
    createdAt,
  }) {
    const existing = await transactionRepository.listEvents(candidateId);
    verifyEventRows(existing);
    const previous = existing.at(-1) || null;
    const id = createId();
    const protectedPayload = protectPayload(
      plainRecord(detail, "Ereignisdetail"),
      candidateEventProtectionContext({ id, candidateId }),
    );
    const event = {
      id,
      candidateId,
      sequenceNumber: previous ? previous.sequenceNumber + 1 : 1,
      applicationId,
      documentId,
      eventType,
      protectedPayload,
      previousReceiptSha256: previous?.receiptSha256 || "",
      actorEmployeeNumber: actor,
      createdAt,
    };
    event.receiptSha256 = canonicalSha256(eventReceiptBody(event));
    await transactionRepository.insertEvent({
      id: event.id,
      candidateId: event.candidateId,
      sequenceNumber: event.sequenceNumber,
      applicationId: event.applicationId,
      documentId: event.documentId,
      eventType: event.eventType,
      protectedPayload: event.protectedPayload,
      previousReceiptSha256: event.previousReceiptSha256,
      receiptSha256: event.receiptSha256,
      actor,
      occurredAt: createdAt,
    });
    return event;
  }

  async function serializeDocument(repositoryForRead, row) {
    const protectedFields = parsePayload(
      row.protectedPayload,
      candidateDocumentProtectionContext(row),
      "PERSONNEL_LIFECYCLE_DOCUMENT_INTEGRITY_FAILED",
      normalizeStoredDocumentPayload,
    );
    const versionRows = await repositoryForRead.listDocumentVersions(row.id);
    const versions = versionRows.map((version) => {
      const protectedVersion = parsePayload(
        version.protectedPayload,
        candidateDocumentVersionProtectionContext({
          ...version,
          candidateId: row.candidateId,
        }),
        "PERSONNEL_LIFECYCLE_DOCUMENT_INTEGRITY_FAILED",
        normalizeStoredDocumentVersionPayload,
      );
      const projection = {
        versionNumber: version.versionNumber,
        contentSha256: version.contentSha256,
        sizeBytes: version.sizeBytes,
        mediaType: version.mediaType,
        originalFilename: protectedVersion.originalFilename,
        note: protectedVersion.note,
        uploadedBy: version.uploadedBy,
        createdAt: version.createdAt,
      };
      Object.defineProperty(projection, DOCUMENT_VERSION_STORAGE_KEY, {
        value: version.storageKey,
        enumerable: false,
      });
      return projection;
    });
    if (versions.length !== row.currentVersion
      || versions.some((version, index) => version.versionNumber !== index + 1)) {
      throw lifecycleError(
        "Die Versionshistorie eines Bewerberdokuments ist nicht konsistent.",
        "PERSONNEL_LIFECYCLE_DOCUMENT_INTEGRITY_FAILED",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.INTEGRITY,
      );
    }
    return {
      id: row.id,
      candidateId: row.candidateId,
      applicationId: row.applicationId || null,
      categoryId: row.categoryId,
      visibility: row.visibility,
      status: row.status,
      currentVersion: row.currentVersion,
      documentDate: row.documentDate || null,
      expiresOn: row.expiresOn || null,
      retentionDueAt: row.retentionDueAt || null,
      title: protectedFields.title,
      description: protectedFields.description,
      versions,
      revision: row.revision,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function candidateDetail(repositoryForRead, id) {
    const row = await repositoryForRead.getCandidate(text(id, "Bewerber-ID", 80, { required: true }));
    if (!row) return null;
    const profile = parsePayload(
      row.protectedPayload,
      candidateProtectionContext(row),
      "PERSONNEL_LIFECYCLE_CANDIDATE_INTEGRITY_FAILED",
      normalizeStoredCandidateProfile,
    );
    const [applicationRows, documentRows, eventRows, conversionRow] = await Promise.all([
      repositoryForRead.listApplications(row.id),
      repositoryForRead.listDocuments(row.id),
      repositoryForRead.listEvents(row.id),
      conversionAvailable
        ? repositoryForRead.getConversionForCandidate(row.id)
        : Promise.resolve(null),
    ]);
    const documents = await Promise.all(
      documentRows.map((document) => serializeDocument(repositoryForRead, document)),
    );
    const photo = documents.find((document) => (
      document.categoryId === "profile-photo"
        && document.visibility === CANDIDATE_PHOTO_VISIBILITY
        && document.status === "active"
        && document.currentVersion >= 1
    )) || null;
    const candidate = {
      id: row.id,
      state: row.state,
      profile,
      applications: applicationRows.map(serializeApplication),
      documents,
      photo,
      history: verifyEventRows(eventRows),
      conversion: conversionRow ? serializeConversion(conversionRow) : null,
      revision: row.revision,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      archivedAt: row.archivedAt || null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    verifyCurrentStateReceipts(candidate, candidate.applications, candidate.documents, candidate.history);
    if (conversionAvailable) verifyConversionRelation(candidate, candidate.conversion);
    return candidate;
  }

  async function candidateDetailForAccess(repositoryForRead, id, access) {
    if (!access || access.global) return candidateDetail(repositoryForRead, id);
    const candidateId = text(id, "Bewerber-ID", 80, { required: true });
    const row = await repositoryForRead.getCandidate(candidateId);
    if (!row) return null;
    const accessRows = await repositoryForRead.listApplicationAccessScopes(candidateId);
    const permittedIds = new Set(accessRows
      .filter((application) => access.canReadApplication(application))
      .map((application) => application.id));
    if (!permittedIds.size) return null;
    const verified = await candidateDetail(repositoryForRead, candidateId);
    const applications = (verified?.applications || []).filter((application) => (
      permittedIds.has(application.id) && access.canReadApplication(application)
    ));
    if (!verified || !applications.length) return null;
    return {
      id: verified.id,
      state: verified.state,
      profile: verified.profile,
      applications,
      photo: verified.photo,
      revision: verified.revision,
      archivedAt: verified.archivedAt,
      createdAt: verified.createdAt,
      updatedAt: verified.updatedAt,
    };
  }

  async function requireActiveCandidate(repositoryForRead, candidateId) {
    const candidate = await repositoryForRead.getCandidate(candidateId);
    if (!candidate) {
      throw lifecycleError(
        "Der Bewerber wurde nicht gefunden.",
        "PERSONNEL_LIFECYCLE_CANDIDATE_NOT_FOUND",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
      );
    }
    if (candidate.state !== "active") {
      throw lifecycleError(
        "Ein archivierter Bewerber kann nicht mehr verändert werden.",
        "PERSONNEL_LIFECYCLE_CANDIDATE_ARCHIVED",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }
    return candidate;
  }

  async function insertApplication(transactionRepository, candidateId, value, actor, createdAt) {
    const normalized = normalizeApplication(value);
    const id = createId();
    assertApplicationStateSize({
      id,
      candidateId,
      status: "new",
      ...normalized,
      ...normalized.protected,
      revision: 1,
    });
    const protectedPayload = protectPayload(
      normalized.protected,
      candidateApplicationProtectionContext({ id, candidateId }),
    );
    await transactionRepository.insertApplication({
      id,
      candidateId,
      status: "new",
      desiredPositionId: normalized.desiredPositionId,
      desiredLocationId: normalized.desiredLocationId,
      desiredDepartmentId: normalized.desiredDepartmentId,
      desiredWeeklyMinutes: normalized.desiredWeeklyMinutes,
      availableFrom: normalized.availableFrom,
      ownerEmployeeNumber: normalized.ownerEmployeeNumber,
      retentionDueAt: normalized.retentionDueAt,
      protectedPayload,
      actor,
      occurredAt: createdAt,
    });
    const createdApplication = serializeApplication(
      await transactionRepository.getApplication(candidateId, id),
    );
    await appendEvent(transactionRepository, {
      candidateId,
      applicationId: id,
      eventType: "application_created",
      detail: {
        status: "new",
        stateSha256: stateSha256(applicationStateBody(createdApplication)),
      },
      actor,
      createdAt,
    });
    return id;
  }

  async function createCandidate(value, actorValue = "system") {
    const submitted = plainRecord(value, "Bewerber");
    const dataProcessingAuthorizationConfirmed = requireDataProcessingAuthorizationConfirmation(
      submitted.dataProcessingAuthorizationConfirmed,
    );
    const profile = normalizeCandidateProfile(submitted.profile || submitted);
    const actor = actorId(actorValue);
    const candidateId = createId();
    const createdAt = occurredAt();
    await repository.transaction(async (transactionRepository) => {
      const protectedPayload = protectPayload(
        profile,
        candidateProtectionContext({ id: candidateId }),
      );
      await transactionRepository.insertCandidate({
        id: candidateId,
        protectedPayload,
        actor,
        occurredAt: createdAt,
      });
      await appendEvent(transactionRepository, {
        candidateId,
        eventType: "candidate_created",
        detail: {
          dataProcessingAuthorization: {
            confirmed: dataProcessingAuthorizationConfirmed,
            statementVersion: "candidate-data-processing-authorization-v1",
          },
          profileFields: Object.keys(profile).sort(),
          stateSha256: stateSha256(candidateStateBody({
            id: candidateId,
            state: "active",
            profile,
            revision: 1,
          })),
        },
        actor,
        createdAt,
      });
      if (submitted.application) {
        await insertApplication(
          transactionRepository,
          candidateId,
          submitted.application,
          actor,
          createdAt,
        );
      }
    }, { isolation: "serializable" });
    return candidateDetail(repository, candidateId);
  }

  async function updateCandidate(id, value, actorValue = "system") {
    const candidateId = text(id, "Bewerber-ID", 80, { required: true });
    const submitted = plainRecord(value, "Bewerber");
    const actor = actorId(actorValue);
    const revision = expectedRevision(submitted.revision);
    const updatedAt = occurredAt();
    await repository.transaction(async (transactionRepository) => {
      const current = await transactionRepository.getCandidate(candidateId);
      if (!current) {
        throw lifecycleError(
          "Der Bewerber wurde nicht gefunden.",
          "PERSONNEL_LIFECYCLE_CANDIDATE_NOT_FOUND",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
        );
      }
      if (current.state !== "active") {
        throw lifecycleError(
          "Ein archivierter Bewerber kann nicht geändert werden.",
          "PERSONNEL_LIFECYCLE_CANDIDATE_ARCHIVED",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
      const before = parsePayload(
        current.protectedPayload,
        candidateProtectionContext(current),
        "PERSONNEL_LIFECYCLE_CANDIDATE_INTEGRITY_FAILED",
        normalizeStoredCandidateProfile,
      );
      const profile = normalizeCandidateProfile(submitted.profile || submitted, before);
      const result = await transactionRepository.updateCandidate({
        id: candidateId,
        protectedPayload: protectPayload(profile, candidateProtectionContext(current)),
        expectedRevision: revision,
        actor,
        occurredAt: updatedAt,
      });
      if (result.rowsAffected !== 1) {
        throw lifecycleError(
          "Das Bewerberprofil wurde zwischenzeitlich geändert.",
          "PERSONNEL_LIFECYCLE_REVISION_CONFLICT",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
      await appendEvent(transactionRepository, {
        candidateId,
        eventType: "candidate_updated",
        detail: {
          changedFields: Object.keys(profile).filter((key) => (
            JSON.stringify(profile[key]) !== JSON.stringify(before[key])
          )),
          previousStateSha256: stateSha256(candidateStateBody({
            id: candidateId,
            state: current.state,
            profile: before,
            revision: current.revision,
          })),
          stateSha256: stateSha256(candidateStateBody({
            id: candidateId,
            state: current.state,
            profile,
            revision: current.revision + 1,
          })),
        },
        actor,
        createdAt: updatedAt,
      });
    }, { isolation: "serializable" });
    return candidateDetail(repository, candidateId);
  }

  async function addApplication(candidateIdValue, value, actorValue = "system") {
    const candidateId = text(candidateIdValue, "Bewerber-ID", 80, { required: true });
    const actor = actorId(actorValue);
    const createdAt = occurredAt();
    let applicationId;
    await repository.transaction(async (transactionRepository) => {
      await requireActiveCandidate(transactionRepository, candidateId);
      applicationId = await insertApplication(
        transactionRepository,
        candidateId,
        value,
        actor,
        createdAt,
      );
    }, { isolation: "serializable" });
    return (await candidateDetail(repository, candidateId)).applications
      .find((application) => application.id === applicationId);
  }

  async function updateApplication(
    candidateIdValue,
    applicationIdValue,
    value,
    actorValue = "system",
    { access = null } = {},
  ) {
    const candidateId = text(candidateIdValue, "Bewerber-ID", 80, { required: true });
    const applicationId = text(applicationIdValue, "Bewerbungs-ID", 80, { required: true });
    const submitted = plainRecord(value, "Bewerbung");
    const revision = expectedRevision(submitted.revision);
    const actor = actorId(actorValue);
    const updatedAt = occurredAt();
    await repository.transaction(async (transactionRepository) => {
      const current = await transactionRepository.getApplication(candidateId, applicationId);
      if (!current || (access && !access.global
        && (!access.canReadApplication(current) || !access.canWriteApplication(current)))) {
        throw lifecycleError(
          "Die Bewerbung wurde nicht gefunden.",
          "PERSONNEL_LIFECYCLE_APPLICATION_NOT_FOUND",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
        );
      }
      await requireActiveCandidate(transactionRepository, candidateId);
      const protectedBefore = parsePayload(
        current.protectedPayload,
        candidateApplicationProtectionContext(current),
        "PERSONNEL_LIFECYCLE_APPLICATION_INTEGRITY_FAILED",
        normalizeStoredApplicationPayload,
      );
      const beforeApplication = serializeApplication(current);
      const normalized = normalizeApplication(submitted, {
        ...current,
        ...protectedBefore,
      });
      assertTrialAppointmentHistoryPreserved(beforeApplication, normalized.protected);
      assertStructuredApplicationDeltaAccess(
        beforeApplication,
        normalized.protected,
        access,
      );
      if (access && !access.global
        && (!access.canReadApplication(normalized) || !access.canWriteApplication(normalized))) {
        throw lifecycleError(
          "Die Bewerbung muss in einem freigegebenen eigenen Zielbereich verbleiben.",
          "PERSONNEL_LIFECYCLE_STRUCTURED_SCOPE_DENIED",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.FORBIDDEN,
        );
      }
      assertApplicationStateSize({
        ...beforeApplication,
        ...normalized,
        ...normalized.protected,
        revision: current.revision + 1,
      });
      const result = await transactionRepository.updateApplication({
        id: applicationId,
        candidateId,
        desiredPositionId: normalized.desiredPositionId,
        desiredLocationId: normalized.desiredLocationId,
        desiredDepartmentId: normalized.desiredDepartmentId,
        desiredWeeklyMinutes: normalized.desiredWeeklyMinutes,
        availableFrom: normalized.availableFrom,
        ownerEmployeeNumber: normalized.ownerEmployeeNumber,
        retentionDueAt: normalized.retentionDueAt,
        protectedPayload: protectPayload(
          normalized.protected,
          candidateApplicationProtectionContext(current),
        ),
        expectedRevision: revision,
        actor,
        occurredAt: updatedAt,
      });
      if (result.rowsAffected !== 1) {
        throw lifecycleError(
          "Die Bewerbung wurde zwischenzeitlich geändert oder ist bereits abgeschlossen.",
          "PERSONNEL_LIFECYCLE_REVISION_CONFLICT",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
      const afterApplication = serializeApplication(
        await transactionRepository.getApplication(candidateId, applicationId),
      );
      const beforeState = applicationStateBody(beforeApplication);
      const afterState = applicationStateBody(afterApplication);
      await appendEvent(transactionRepository, {
        candidateId,
        applicationId,
        eventType: "application_updated",
        detail: {
          changedFields: changedStateFields(beforeState, afterState),
          previousStateSha256: stateSha256(beforeState),
          revisionBefore: revision,
          stateSha256: stateSha256(afterState),
        },
        actor,
        createdAt: updatedAt,
      });
    }, { isolation: "serializable" });
    const updated = await repository.getApplication(candidateId, applicationId);
    if (!updated || (access && !access.global
      && (!access.canReadApplication(updated) || !access.canWriteApplication(updated)))) {
      throw lifecycleError(
        "Die Bewerbung wurde nicht gefunden.",
        "PERSONNEL_LIFECYCLE_APPLICATION_NOT_FOUND",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
      );
    }
    return serializeApplication(updated);
  }

  async function updateTrialAppointment(
    candidateIdValue,
    applicationIdValue,
    trialAppointmentIdValue,
    value,
    actorValue = "system",
    { access = null } = {},
  ) {
    const candidateId = text(candidateIdValue, "Bewerber-ID", 80, { required: true });
    const applicationId = text(applicationIdValue, "Bewerbungs-ID", 80, { required: true });
    const trialAppointmentId = text(
      trialAppointmentIdValue,
      "Schnuppertermin-ID",
      80,
      { required: true },
    );
    const submitted = directTrialAppointmentPayload(
      value,
      "Schnuppertermin-Änderung",
      TRIAL_APPOINTMENT_DIRECT_UPDATE_FIELDS,
    );
    const revision = expectedRevision(submitted.revision);
    const replacementInput = submitted.replacement === undefined || submitted.replacement === null
      ? null
      : directTrialAppointmentPayload(
          submitted.replacement,
          "Ersatztermin",
          TRIAL_APPOINTMENT_REPLACEMENT_FIELDS,
        );
    const actor = actorId(actorValue);
    const updatedAt = occurredAt();
    await repository.transaction(async (transactionRepository) => {
      const current = await transactionRepository.getApplication(candidateId, applicationId);
      if (!current || (access && !access.global
        && (!access.canReadApplication(current) || !access.canWriteApplication(current)))) {
        throw lifecycleError(
          "Die Bewerbung wurde nicht gefunden.",
          "PERSONNEL_LIFECYCLE_APPLICATION_NOT_FOUND",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
        );
      }
      await requireActiveCandidate(transactionRepository, candidateId);
      const protectedBefore = parsePayload(
        current.protectedPayload,
        candidateApplicationProtectionContext(current),
        "PERSONNEL_LIFECYCLE_APPLICATION_INTEGRITY_FAILED",
        normalizeStoredApplicationPayload,
      );
      const beforeAppointments = protectedBefore.trialAppointments || [];
      const beforeAppointment = beforeAppointments.find((appointment) => (
        appointment.id === trialAppointmentId
      ));
      if (!beforeAppointment || !structuredApplicationEntryWritable(access, beforeAppointment)) {
        throw lifecycleError(
          "Der Schnuppertermin wurde nicht gefunden.",
          "PERSONNEL_LIFECYCLE_TRIAL_APPOINTMENT_NOT_FOUND",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
        );
      }
      if (replacementInput && beforeAppointment.replacementAppointmentId) {
        throw lifecycleError(
          "Für diesen Schnuppertermin ist bereits ein Ersatztermin verknüpft.",
          "PERSONNEL_LIFECYCLE_TRIAL_REPLACEMENT_EXISTS",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }

      const updatedAppointment = { ...beforeAppointment };
      for (const field of [
        "dateFrom",
        "dateTo",
        "startTime",
        "endTime",
        "locationId",
        "departmentId",
        "status",
        "note",
        "cancellationReason",
      ]) {
        if (Object.prototype.hasOwnProperty.call(submitted, field)) {
          updatedAppointment[field] = submitted[field];
        }
      }
      const becomesCancelled = beforeAppointment.status !== "cancelled"
        && String(updatedAppointment.status || "") === "cancelled";
      if (becomesCancelled) {
        updatedAppointment.cancelledAt = updatedAt;
        updatedAppointment.cancelledBy = actor;
      }

      let replacementAppointmentId = null;
      let nextAppointments = beforeAppointments.map((appointment) => (
        appointment.id === trialAppointmentId ? updatedAppointment : appointment
      ));
      if (replacementInput) {
        if (String(updatedAppointment.status || "") !== "cancelled") {
          throw lifecycleError(
            "Ein Ersatztermin kann nur mit einem abgesagten Schnuppertermin verknüpft werden.",
            "PERSONNEL_LIFECYCLE_TRIAL_REPLACEMENT_INVALID",
          );
        }
        replacementAppointmentId = createId();
        updatedAppointment.replacementAppointmentId = replacementAppointmentId;
        const replacementAppointment = {
          ...replacementInput,
          id: replacementAppointmentId,
          locationId: replacementInput.locationId ?? updatedAppointment.locationId,
          departmentId: Object.prototype.hasOwnProperty.call(replacementInput, "departmentId")
            ? replacementInput.departmentId
            : updatedAppointment.departmentId ?? null,
          status: "planned",
          replacesAppointmentId: trialAppointmentId,
        };
        nextAppointments = nextAppointments.map((appointment) => (
          appointment.id === trialAppointmentId ? updatedAppointment : appointment
        ));
        nextAppointments.push(replacementAppointment);
      }

      const beforeApplication = serializeApplication(current);
      const normalized = normalizeApplication({}, { ...current, ...protectedBefore });
      normalized.protected.trialAppointments = normalizeTrialAppointments(nextAppointments);
      assertTrialAppointmentHistoryPreserved(beforeApplication, normalized.protected, {
        allowCancellationTransition: true,
        allowNewReplacementLink: true,
      });
      assertStructuredApplicationDeltaAccess(
        beforeApplication,
        normalized.protected,
        access,
      );
      if (access && !access.global
        && (!access.canReadApplication(normalized) || !access.canWriteApplication(normalized))) {
        throw lifecycleError(
          "Die Bewerbung muss in einem freigegebenen eigenen Zielbereich verbleiben.",
          "PERSONNEL_LIFECYCLE_STRUCTURED_SCOPE_DENIED",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.FORBIDDEN,
        );
      }
      assertApplicationStateSize({
        ...beforeApplication,
        ...normalized,
        ...normalized.protected,
        revision: current.revision + 1,
      });
      const result = await transactionRepository.updateApplication({
        id: applicationId,
        candidateId,
        desiredPositionId: normalized.desiredPositionId,
        desiredLocationId: normalized.desiredLocationId,
        desiredDepartmentId: normalized.desiredDepartmentId,
        desiredWeeklyMinutes: normalized.desiredWeeklyMinutes,
        availableFrom: normalized.availableFrom,
        ownerEmployeeNumber: normalized.ownerEmployeeNumber,
        retentionDueAt: normalized.retentionDueAt,
        protectedPayload: protectPayload(
          normalized.protected,
          candidateApplicationProtectionContext(current),
        ),
        expectedRevision: revision,
        actor,
        occurredAt: updatedAt,
      });
      if (result.rowsAffected !== 1) {
        throw lifecycleError(
          "Die Bewerbung wurde zwischenzeitlich geändert oder ist bereits abgeschlossen.",
          "PERSONNEL_LIFECYCLE_REVISION_CONFLICT",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
      const afterApplication = serializeApplication(
        await transactionRepository.getApplication(candidateId, applicationId),
      );
      const afterAppointment = (afterApplication.trialAppointments || [])
        .find((appointment) => appointment.id === trialAppointmentId);
      const afterReplacementAppointment = replacementAppointmentId
        ? (afterApplication.trialAppointments || [])
            .find((appointment) => appointment.id === replacementAppointmentId)
        : null;
      const beforeState = applicationStateBody(beforeApplication);
      const afterState = applicationStateBody(afterApplication);
      await appendEvent(transactionRepository, {
        candidateId,
        applicationId,
        eventType: "application_updated",
        detail: {
          changedFields: changedStateFields(beforeState, afterState),
          operation: becomesCancelled
            ? "trial_appointment_cancelled"
            : "trial_appointment_updated",
          previousStateSha256: stateSha256(beforeState),
          revisionBefore: revision,
          stateSha256: stateSha256(afterState),
          trialAppointment: {
            id: trialAppointmentId,
            statusBefore: beforeAppointment.status,
            statusAfter: afterAppointment.status,
            before: { ...beforeAppointment },
            after: { ...afterAppointment },
            ...(becomesCancelled ? {
              cancellationReason: afterAppointment.cancellationReason || "",
              cancelledAt: afterAppointment.cancelledAt,
              cancelledBy: afterAppointment.cancelledBy,
            } : {}),
            ...(replacementAppointmentId ? {
              replacementAppointmentId,
              replacement: { ...afterReplacementAppointment },
            } : {}),
          },
        },
        actor,
        createdAt: updatedAt,
      });
    }, { isolation: "serializable" });
    const updated = await repository.getApplication(candidateId, applicationId);
    if (!updated || (access && !access.global
      && (!access.canReadApplication(updated) || !access.canWriteApplication(updated)))) {
      throw lifecycleError(
        "Die Bewerbung wurde nicht gefunden.",
        "PERSONNEL_LIFECYCLE_APPLICATION_NOT_FOUND",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
      );
    }
    return serializeApplication(updated);
  }

  async function addTeamFeedback(
    candidateIdValue,
    applicationIdValue,
    value,
    actorValue = "system",
    { access = null } = {},
  ) {
    const candidateId = text(candidateIdValue, "Bewerber-ID", 80, { required: true });
    const applicationId = text(applicationIdValue, "Bewerbungs-ID", 80, { required: true });
    const submitted = plainRecord(value, "Teamrückmeldung");
    const revision = expectedRevision(submitted.revision);
    const actor = actorId(actorValue);
    const employeeNumber = text(
      submitted.employeeNumber,
      "Rückmeldendes Teammitglied",
      120,
      { required: true },
    );
    const rating = nullableInteger(submitted.rating, "Teamrückmeldung", { minimum: 1, maximum: 5 });
    const comment = text(submitted.comment, "Kommentar der Teamrückmeldung", 2000);
    if (rating === null && !comment) {
      throw lifecycleError(
        "Für eine Teamrückmeldung wird eine Bewertung oder ein Kommentar benötigt.",
        "PERSONNEL_LIFECYCLE_INVALID",
      );
    }
    const trialAppointmentId = nullableText(
      submitted.trialAppointmentId,
      "Schnuppertermin",
      80,
    );
    const updatedAt = occurredAt();
    await repository.transaction(async (transactionRepository) => {
      const current = await transactionRepository.getApplication(candidateId, applicationId);
      if (!current || (access && !access.global
        && (!access.canReadApplication(current) || !access.canWriteApplication(current)))) {
        throw lifecycleError(
          "Die Bewerbung wurde nicht gefunden.",
          "PERSONNEL_LIFECYCLE_APPLICATION_NOT_FOUND",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
        );
      }
      await requireActiveCandidate(transactionRepository, candidateId);
      const protectedBefore = parsePayload(
        current.protectedPayload,
        candidateApplicationProtectionContext(current),
        "PERSONNEL_LIFECYCLE_APPLICATION_INTEGRITY_FAILED",
        normalizeStoredApplicationPayload,
      );
      if (trialAppointmentId && !(protectedBefore.trialAppointments || [])
        .some((appointment) => appointment.id === trialAppointmentId)) {
        throw lifecycleError(
          "Der zugeordnete Schnuppertermin wurde nicht gefunden.",
          "PERSONNEL_LIFECYCLE_TRIAL_APPOINTMENT_NOT_FOUND",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
        );
      }
      const beforeApplication = serializeApplication(current);
      const normalized = normalizeApplication({}, { ...current, ...protectedBefore });
      normalized.protected.teamFeedback = normalizeTeamFeedback([
        ...(protectedBefore.teamFeedback || []),
        {
          id: createId(),
          trialAppointmentId,
          employeeNumber,
          rating,
          comment,
          recordedByEmployeeNumber: actor,
          recordedAt: updatedAt,
        },
      ]);
      assertApplicationStateSize({
        ...beforeApplication,
        ...normalized,
        ...normalized.protected,
        revision: current.revision + 1,
      });
      const result = await transactionRepository.updateApplication({
        id: applicationId,
        candidateId,
        desiredPositionId: normalized.desiredPositionId,
        desiredLocationId: normalized.desiredLocationId,
        desiredDepartmentId: normalized.desiredDepartmentId,
        desiredWeeklyMinutes: normalized.desiredWeeklyMinutes,
        availableFrom: normalized.availableFrom,
        ownerEmployeeNumber: normalized.ownerEmployeeNumber,
        retentionDueAt: normalized.retentionDueAt,
        protectedPayload: protectPayload(
          normalized.protected,
          candidateApplicationProtectionContext(current),
        ),
        expectedRevision: revision,
        actor,
        occurredAt: updatedAt,
      });
      if (result.rowsAffected !== 1) {
        throw lifecycleError(
          "Die Bewerbung wurde zwischenzeitlich geändert.",
          "PERSONNEL_LIFECYCLE_REVISION_CONFLICT",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
      const afterApplication = serializeApplication(
        await transactionRepository.getApplication(candidateId, applicationId),
      );
      await appendEvent(transactionRepository, {
        candidateId,
        applicationId,
        eventType: "application_updated",
        detail: {
          changedFields: ["teamFeedback"],
          previousStateSha256: stateSha256(applicationStateBody(beforeApplication)),
          revisionBefore: revision,
          stateSha256: stateSha256(applicationStateBody(afterApplication)),
        },
        actor,
        createdAt: updatedAt,
      });
    }, { isolation: "serializable" });
    const updated = await repository.getApplication(candidateId, applicationId);
    if (!updated || (access && !access.global
      && (!access.canReadApplication(updated) || !access.canWriteApplication(updated)))) {
      throw lifecycleError(
        "Die Bewerbung wurde nicht gefunden.",
        "PERSONNEL_LIFECYCLE_APPLICATION_NOT_FOUND",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
      );
    }
    return serializeApplication(updated);
  }

  function teamEvaluationAssignmentProjection(candidate, application, evaluation) {
    const profile = candidate?.profile || {};
    const candidateName = [profile.firstName, profile.lastName]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" ") || "Bewerbung";
    const appointment = evaluation.trialAppointmentId
      ? (application.trialAppointments || []).find((entry) => (
          String(entry.id) === String(evaluation.trialAppointmentId)
        )) || null
      : null;
    return {
      id: evaluation.id,
      applicationRevision: application.revision,
      candidateName,
      desiredRoleTitle: String(application.desiredRoleTitle || "").trim(),
      assignedAt: evaluation.assignedAt,
      trialAppointment: appointment ? {
        dateFrom: appointment.dateFrom || null,
        dateTo: appointment.dateTo || appointment.dateFrom || null,
        startTime: appointment.startTime || null,
        endTime: appointment.endTime || null,
      } : null,
      criteria: (evaluation.criteria || []).map((criterion) => ({
        id: criterion.id,
        label: criterion.label,
      })),
    };
  }

  async function scanTeamEvaluationAssignments(employeeNumberValue, {
    evaluationId = null,
    pendingOnly = false,
  } = {}) {
    const employeeNumber = text(
      employeeNumberValue,
      "Bewertendes Teammitglied",
      120,
      { required: true },
    );
    const normalizedEvaluationId = evaluationId
      ? text(evaluationId, "Bewertungs-ID", 80, { required: true })
      : null;
    const matches = [];
    const pageSize = 100;
    let offset = 0;
    while (true) {
      const rows = await repository.listCandidates({
        includeArchived: false,
        limit: pageSize,
        offset,
      });
      // A team-assignment lookup only needs the candidate profile and its
      // applications. Loading documents, document versions, the event history
      // and conversion state for every candidate made every app start scan the
      // complete personnel-lifecycle graph. Read the minimum verified payloads
      // in parallel instead.
      const candidates = await Promise.all(rows.map(async (row) => ({
        id: row.id,
        state: row.state,
        profile: parsePayload(
          row.protectedPayload,
          candidateProtectionContext(row),
          "PERSONNEL_LIFECYCLE_CANDIDATE_INTEGRITY_FAILED",
          normalizeStoredCandidateProfile,
        ),
        applications: (await repository.listApplications(row.id)).map(serializeApplication),
      })));
      for (const candidate of candidates) {
        if (!candidate || candidate.state !== "active") continue;
        for (const application of candidate.applications || []) {
          if (CLOSED_TEAM_EVALUATION_APPLICATION_STATUSES.has(application.status)) continue;
          const evaluation = (application.teamEvaluations || []).find((entry) => (
            entry.employeeNumber === employeeNumber
              && (!normalizedEvaluationId || entry.id === normalizedEvaluationId)
              && (!pendingOnly || !entry.submittedAt)
          ));
          if (!evaluation) continue;
          matches.push({ candidate, application, evaluation });
          if (normalizedEvaluationId) return matches;
        }
      }
      if (rows.length < pageSize) break;
      offset += rows.length;
    }
    return matches;
  }

  async function listTeamEvaluationAssignments(employeeNumberValue) {
    const matches = await scanTeamEvaluationAssignments(employeeNumberValue, { pendingOnly: true });
    return matches
      .map(({ candidate, application, evaluation }) => (
        teamEvaluationAssignmentProjection(candidate, application, evaluation)
      ))
      .sort((left, right) => (
        String(left.assignedAt).localeCompare(String(right.assignedAt))
          || String(left.candidateName).localeCompare(String(right.candidateName), "de-AT")
      ));
  }

  async function assignTeamEvaluators(
    candidateIdValue,
    applicationIdValue,
    value,
    actorValue = "system",
    { access = null, eligibleEmployeeNumbers = [] } = {},
  ) {
    const candidateId = text(candidateIdValue, "Bewerber-ID", 80, { required: true });
    const applicationId = text(applicationIdValue, "Bewerbungs-ID", 80, { required: true });
    const submitted = plainRecord(value, "Zuweisung zur MA-Bewertung");
    const revision = expectedRevision(submitted.revision);
    const actor = actorId(actorValue);
    if (!Array.isArray(submitted.employeeNumbers)
      || submitted.employeeNumbers.length < 1
      || submitted.employeeNumbers.length > 20) {
      throw lifecycleError(
        "Bitte mindestens eine und höchstens 20 Personen zur Bewertung auswählen.",
        "PERSONNEL_LIFECYCLE_TEAM_EVALUATOR_INVALID",
      );
    }
    const employeeNumbers = submitted.employeeNumbers.map((entry) => (
      text(entry, "Bewertendes Teammitglied", 120, { required: true })
    ));
    if (new Set(employeeNumbers).size !== employeeNumbers.length || employeeNumbers.includes(actor)) {
      throw lifecycleError(
        "Bewertende Personen dürfen nicht doppelt zugewiesen werden; die FL-Bewertung bleibt getrennt.",
        "PERSONNEL_LIFECYCLE_TEAM_EVALUATOR_INVALID",
      );
    }
    const eligible = new Set((Array.isArray(eligibleEmployeeNumbers) ? eligibleEmployeeNumbers : [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean));
    if (employeeNumbers.some((entry) => !eligible.has(entry))) {
      throw lifecycleError(
        "Mindestens eine ausgewählte Person darf diese Bewerbung nicht bewerten.",
        "PERSONNEL_LIFECYCLE_TEAM_EVALUATOR_FORBIDDEN",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.FORBIDDEN,
      );
    }
    const trialAppointmentId = nullableText(
      submitted.trialAppointmentId,
      "Schnuppertermin",
      80,
    );
    const assignedAt = occurredAt();
    await repository.transaction(async (transactionRepository) => {
      const current = await transactionRepository.getApplication(candidateId, applicationId);
      if (!current || (access && !access.global
        && (!access.canReadApplication(current) || !access.canWriteApplication(current)))) {
        throw lifecycleError(
          "Die Bewerbung wurde nicht gefunden.",
          "PERSONNEL_LIFECYCLE_APPLICATION_NOT_FOUND",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
        );
      }
      await requireActiveCandidate(transactionRepository, candidateId);
      if (CLOSED_TEAM_EVALUATION_APPLICATION_STATUSES.has(current.status)) {
        throw lifecycleError(
          "Für eine abgeschlossene Bewerbung können keine Bewertungen mehr zugewiesen werden.",
          "PERSONNEL_LIFECYCLE_TEAM_EVALUATION_CLOSED",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
      const protectedBefore = parsePayload(
        current.protectedPayload,
        candidateApplicationProtectionContext(current),
        "PERSONNEL_LIFECYCLE_APPLICATION_INTEGRITY_FAILED",
        normalizeStoredApplicationPayload,
      );
      if (trialAppointmentId && !(protectedBefore.trialAppointments || [])
        .some((appointment) => appointment.id === trialAppointmentId)) {
        throw lifecycleError(
          "Der zugeordnete Schnuppertermin wurde nicht gefunden.",
          "PERSONNEL_LIFECYCLE_TRIAL_APPOINTMENT_NOT_FOUND",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
        );
      }
      const existing = protectedBefore.teamEvaluations || [];
      if (employeeNumbers.some((entry) => (
        existing.some((evaluation) => evaluation.employeeNumber === entry)
      ))) {
        throw lifecycleError(
          "Mindestens eine ausgewählte Person wurde dieser Bewerbung bereits zugewiesen.",
          "PERSONNEL_LIFECYCLE_TEAM_EVALUATOR_ALREADY_ASSIGNED",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
      const criteria = (protectedBefore.competencyRatings || []).map((criterion) => ({
        id: criterion.id,
        label: criterion.label,
        rating: null,
        comment: "",
      }));
      if (!criteria.length) {
        throw lifecycleError(
          "Vor der Zuweisung muss mindestens ein Bewertungskriterium vorhanden sein.",
          "PERSONNEL_LIFECYCLE_TEAM_EVALUATION_CRITERIA_MISSING",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
      const beforeApplication = serializeApplication(current);
      const normalized = normalizeApplication({}, { ...current, ...protectedBefore });
      normalized.protected.teamEvaluations = normalizeTeamEvaluations([
        ...existing,
        ...employeeNumbers.map((employeeNumber) => ({
          id: createId(),
          trialAppointmentId,
          employeeNumber,
          assignedByEmployeeNumber: actor,
          assignedAt,
          submittedAt: null,
          criteria,
        })),
      ]);
      assertApplicationStateSize({
        ...beforeApplication,
        ...normalized,
        ...normalized.protected,
        revision: current.revision + 1,
      });
      const result = await transactionRepository.updateApplication({
        id: applicationId,
        candidateId,
        desiredPositionId: normalized.desiredPositionId,
        desiredLocationId: normalized.desiredLocationId,
        desiredDepartmentId: normalized.desiredDepartmentId,
        desiredWeeklyMinutes: normalized.desiredWeeklyMinutes,
        availableFrom: normalized.availableFrom,
        ownerEmployeeNumber: normalized.ownerEmployeeNumber,
        retentionDueAt: normalized.retentionDueAt,
        protectedPayload: protectPayload(
          normalized.protected,
          candidateApplicationProtectionContext(current),
        ),
        expectedRevision: revision,
        actor,
        occurredAt: assignedAt,
      });
      if (result.rowsAffected !== 1) {
        throw lifecycleError(
          "Die Bewerbung wurde zwischenzeitlich geändert.",
          "PERSONNEL_LIFECYCLE_REVISION_CONFLICT",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
      const afterApplication = serializeApplication(
        await transactionRepository.getApplication(candidateId, applicationId),
      );
      await appendEvent(transactionRepository, {
        candidateId,
        applicationId,
        eventType: "application_updated",
        detail: {
          changedFields: ["teamEvaluations"],
          previousStateSha256: stateSha256(applicationStateBody(beforeApplication)),
          revisionBefore: revision,
          stateSha256: stateSha256(applicationStateBody(afterApplication)),
        },
        actor,
        createdAt: assignedAt,
      });
    }, { isolation: "serializable" });
    const updated = await repository.getApplication(candidateId, applicationId);
    if (!updated || (access && !access.global
      && (!access.canReadApplication(updated) || !access.canWriteApplication(updated)))) {
      throw lifecycleError(
        "Die Bewerbung wurde nicht gefunden.",
        "PERSONNEL_LIFECYCLE_APPLICATION_NOT_FOUND",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
      );
    }
    return serializeApplication(updated);
  }

  async function submitTeamEvaluation(
    evaluationIdValue,
    value,
    employeeNumberValue,
  ) {
    const evaluationId = text(evaluationIdValue, "Bewertungs-ID", 80, { required: true });
    const employeeNumber = text(
      employeeNumberValue,
      "Bewertendes Teammitglied",
      120,
      { required: true },
    );
    const submitted = plainRecord(value, "MA-Bewertung");
    const revision = expectedRevision(submitted.revision);
    const [match] = await scanTeamEvaluationAssignments(employeeNumber, { evaluationId });
    if (!match || match.evaluation.submittedAt) {
      throw lifecycleError(
        "Die offene Bewertung wurde nicht gefunden.",
        "PERSONNEL_LIFECYCLE_TEAM_EVALUATION_NOT_FOUND",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
      );
    }
    const submittedAt = occurredAt();
    let projection = null;
    await repository.transaction(async (transactionRepository) => {
      const current = await transactionRepository.getApplication(
        match.candidate.id,
        match.application.id,
      );
      if (!current) {
        throw lifecycleError(
          "Die offene Bewertung wurde nicht gefunden.",
          "PERSONNEL_LIFECYCLE_TEAM_EVALUATION_NOT_FOUND",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
        );
      }
      await requireActiveCandidate(transactionRepository, match.candidate.id);
      if (CLOSED_TEAM_EVALUATION_APPLICATION_STATUSES.has(current.status)) {
        throw lifecycleError(
          "Diese Bewertung kann nicht mehr abgegeben werden.",
          "PERSONNEL_LIFECYCLE_TEAM_EVALUATION_CLOSED",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
      const protectedBefore = parsePayload(
        current.protectedPayload,
        candidateApplicationProtectionContext(current),
        "PERSONNEL_LIFECYCLE_APPLICATION_INTEGRITY_FAILED",
        normalizeStoredApplicationPayload,
      );
      const currentEvaluation = (protectedBefore.teamEvaluations || []).find((entry) => (
        entry.id === evaluationId && entry.employeeNumber === employeeNumber && !entry.submittedAt
      ));
      if (!currentEvaluation) {
        throw lifecycleError(
          "Die offene Bewertung wurde nicht gefunden.",
          "PERSONNEL_LIFECYCLE_TEAM_EVALUATION_NOT_FOUND",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
        );
      }
      const criteria = normalizeSubmittedTeamEvaluationCriteria(
        submitted.criteria,
        currentEvaluation.criteria,
      );
      const beforeApplication = serializeApplication(current);
      const normalized = normalizeApplication({}, { ...current, ...protectedBefore });
      normalized.protected.teamEvaluations = normalizeTeamEvaluations(
        (protectedBefore.teamEvaluations || []).map((evaluation) => (
          evaluation.id === evaluationId
            ? { ...evaluation, submittedAt, criteria }
            : evaluation
        )),
      );
      assertApplicationStateSize({
        ...beforeApplication,
        ...normalized,
        ...normalized.protected,
        revision: current.revision + 1,
      });
      const result = await transactionRepository.updateApplication({
        id: current.id,
        candidateId: current.candidateId,
        desiredPositionId: normalized.desiredPositionId,
        desiredLocationId: normalized.desiredLocationId,
        desiredDepartmentId: normalized.desiredDepartmentId,
        desiredWeeklyMinutes: normalized.desiredWeeklyMinutes,
        availableFrom: normalized.availableFrom,
        ownerEmployeeNumber: normalized.ownerEmployeeNumber,
        retentionDueAt: normalized.retentionDueAt,
        protectedPayload: protectPayload(
          normalized.protected,
          candidateApplicationProtectionContext(current),
        ),
        expectedRevision: revision,
        actor: employeeNumber,
        occurredAt: submittedAt,
      });
      if (result.rowsAffected !== 1) {
        throw lifecycleError(
          "Die Bewerbung wurde zwischenzeitlich geändert. Bitte die Bewertung neu laden.",
          "PERSONNEL_LIFECYCLE_REVISION_CONFLICT",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
      const afterApplication = serializeApplication(
        await transactionRepository.getApplication(current.candidateId, current.id),
      );
      await appendEvent(transactionRepository, {
        candidateId: current.candidateId,
        applicationId: current.id,
        eventType: "application_updated",
        detail: {
          changedFields: ["teamEvaluations"],
          previousStateSha256: stateSha256(applicationStateBody(beforeApplication)),
          revisionBefore: revision,
          stateSha256: stateSha256(applicationStateBody(afterApplication)),
        },
        actor: employeeNumber,
        createdAt: submittedAt,
      });
      const completedEvaluation = afterApplication.teamEvaluations.find((entry) => (
        entry.id === evaluationId
      ));
      projection = {
        ...teamEvaluationAssignmentProjection(match.candidate, afterApplication, completedEvaluation),
        submittedAt,
      };
    }, { isolation: "serializable" });
    return projection;
  }

  async function transitionApplication(
    candidateIdValue,
    applicationIdValue,
    value,
    actorValue = "system",
    { access = null } = {},
  ) {
    const candidateId = text(candidateIdValue, "Bewerber-ID", 80, { required: true });
    const applicationId = text(applicationIdValue, "Bewerbungs-ID", 80, { required: true });
    const submitted = plainRecord(value, "Statuswechsel");
    const status = text(submitted.status, "Zielstatus", 40, { required: true });
    if (!APPLICATION_STATUSES.includes(status)) {
      throw lifecycleError("Der Bewerbungsstatus ist ungültig.", "PERSONNEL_LIFECYCLE_STATUS_INVALID");
    }
    if (status === "converted") {
      throw lifecycleError(
        "Die Umwandlung in einen Mitarbeiter ist einem eigenen, kontrollierten Folgeblock vorbehalten.",
        "PERSONNEL_LIFECYCLE_CONVERSION_NOT_AVAILABLE",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }
    const revision = expectedRevision(submitted.revision);
    const reason = text(submitted.reason, "Begründung", 500);
    if (["rejected", "withdrawn", "talent_pool", "archived"].includes(status) && !reason) {
      throw lifecycleError(
        "Für diesen Statuswechsel ist eine kurze Begründung erforderlich.",
        "PERSONNEL_LIFECYCLE_STATUS_REASON_REQUIRED",
      );
    }
    const actor = actorId(actorValue);
    const changedAt = occurredAt();
    await repository.transaction(async (transactionRepository) => {
      const current = await transactionRepository.getApplication(candidateId, applicationId);
      if (!current || (access && !access.global
        && (!access.canReadApplication(current) || !access.canWriteApplication(current)))) {
        throw lifecycleError(
          "Die Bewerbung wurde nicht gefunden.",
          "PERSONNEL_LIFECYCLE_APPLICATION_NOT_FOUND",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
        );
      }
      await requireActiveCandidate(transactionRepository, candidateId);
      if (!(APPLICATION_TRANSITIONS[current.status] || []).includes(status)) {
        throw lifecycleError(
          `Der Statuswechsel von ${current.status} nach ${status} ist nicht zulässig.`,
          "PERSONNEL_LIFECYCLE_STATUS_TRANSITION_INVALID",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
      const beforeApplication = serializeApplication(current);
      assertApplicationStateSize({
        ...beforeApplication,
        status,
        revision: current.revision + 1,
      });
      const result = await transactionRepository.updateApplicationStatus({
        id: applicationId,
        candidateId,
        status,
        expectedRevision: revision,
        actor,
        occurredAt: changedAt,
      });
      if (result.rowsAffected !== 1) {
        throw lifecycleError(
          "Die Bewerbung wurde zwischenzeitlich geändert.",
          "PERSONNEL_LIFECYCLE_REVISION_CONFLICT",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
      const afterApplication = serializeApplication(
        await transactionRepository.getApplication(candidateId, applicationId),
      );
      await appendEvent(transactionRepository, {
        candidateId,
        applicationId,
        eventType: "application_status_changed",
        detail: {
          from: current.status,
          previousStateSha256: stateSha256(applicationStateBody(beforeApplication)),
          reason,
          stateSha256: stateSha256(applicationStateBody(afterApplication)),
          to: status,
        },
        actor,
        createdAt: changedAt,
      });
    }, { isolation: "serializable" });
    const updated = await repository.getApplication(candidateId, applicationId);
    if (!updated || (access && !access.global
      && (!access.canReadApplication(updated) || !access.canWriteApplication(updated)))) {
      throw lifecycleError(
        "Die Bewerbung wurde nicht gefunden.",
        "PERSONNEL_LIFECYCLE_APPLICATION_NOT_FOUND",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
      );
    }
    return serializeApplication(updated);
  }

  async function convertCandidateInTransaction(
    candidateIdValue,
    applicationIdValue,
    value,
    actorValue,
    insertEmployee,
  ) {
    if (!conversionAvailable) {
      throw lifecycleError(
        "Die kontrollierte Umwandlung ist für diesen Datenbankstand nicht verfügbar.",
        "PERSONNEL_LIFECYCLE_CONVERSION_NOT_AVAILABLE",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }
    const candidateId = text(candidateIdValue, "Bewerber-ID", 80, { required: true });
    const applicationId = text(applicationIdValue, "Bewerbungs-ID", 80, { required: true });
    const submitted = plainRecord(value, "Umwandlung");
    const id = conversionId(submitted.id);
    const requestSha256 = sha256(
      submitted.requestSha256,
      "Anfragebeleg",
      "PERSONNEL_LIFECYCLE_CONVERSION_REQUEST_INVALID",
    );
    const employeeNumber = text(
      submitted.employeeNumber,
      "Personalnummer",
      24,
      { required: true },
    );
    if (!/^[A-Za-z0-9._-]{1,24}$/.test(employeeNumber)) {
      throw lifecycleError(
        "Die Personalnummer für die Umwandlung ist ungültig.",
        "PERSONNEL_LIFECYCLE_CONVERSION_EMPLOYEE_INVALID",
      );
    }
    if (employeeNumber.toLowerCase() === "local") {
      throw lifecycleError(
        "Diese Personalnummer ist fuer den internen lokalen Systemzugang reserviert.",
        "PERSONNEL_LIFECYCLE_CONVERSION_EMPLOYEE_RESERVED",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }
    const actor = actorId(actorValue);
    if (typeof insertEmployee !== "function") {
      throw new TypeError("Für die Umwandlung fehlt die transaktionsgebundene Mitarbeiteranlage.");
    }

    const existingRow = await repository.getConversionById(id);
    if (existingRow) {
      const existing = serializeConversion(existingRow);
      if (existingRow.requestSha256 !== requestSha256
        || existing.candidateId !== candidateId
        || existing.applicationId !== applicationId
        || existing.employeeNumber !== employeeNumber) {
        throw lifecycleError(
          "Diese Vorgangs-ID wurde bereits für eine andere Umwandlung verwendet.",
          "PERSONNEL_LIFECYCLE_CONVERSION_IDEMPOTENCY_CONFLICT",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
      const candidate = await candidateDetail(repository, candidateId);
      if (!candidate || candidate.conversion?.id !== existing.id) invalidConversionReceipt();
      return { conversion: candidate.conversion, candidate, replayed: true };
    }

    const candidate = await candidateDetail(repository, candidateId);
    if (!candidate) {
      throw lifecycleError(
        "Der Bewerber wurde nicht gefunden.",
        "PERSONNEL_LIFECYCLE_CANDIDATE_NOT_FOUND",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
      );
    }
    if (candidate.conversion) {
      throw lifecycleError(
        "Der Bewerber wurde bereits kontrolliert in einen Mitarbeiter umgewandelt.",
        "PERSONNEL_LIFECYCLE_ALREADY_CONVERTED",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }
    if (candidate.state !== "active") {
      throw lifecycleError(
        "Ein archivierter Bewerber kann nicht umgewandelt werden.",
        "PERSONNEL_LIFECYCLE_CANDIDATE_ARCHIVED",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }
    const candidateRevision = expectedRevision(submitted.candidateRevision);
    if (candidate.revision !== candidateRevision) {
      throw lifecycleError(
        "Das Bewerberprofil wurde zwischenzeitlich geändert.",
        "PERSONNEL_LIFECYCLE_REVISION_CONFLICT",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }
    const application = candidate.applications.find(({ id: currentId }) => currentId === applicationId);
    if (!application) {
      throw lifecycleError(
        "Die Bewerbung wurde nicht gefunden.",
        "PERSONNEL_LIFECYCLE_APPLICATION_NOT_FOUND",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
      );
    }
    const applicationRevision = expectedRevision(submitted.applicationRevision);
    if (application.revision !== applicationRevision) {
      throw lifecycleError(
        "Die Bewerbung wurde zwischenzeitlich geändert.",
        "PERSONNEL_LIFECYCLE_REVISION_CONFLICT",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }
    if (application.status !== "preboarding") {
      throw lifecycleError(
        "Nur eine Bewerbung im Status preboarding kann umgewandelt werden.",
        "PERSONNEL_LIFECYCLE_CONVERSION_STATUS_INVALID",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }
    const otherOpenApplication = candidate.applications.some((entry) => (
      entry.id !== applicationId && !CLOSED_OTHER_APPLICATION_STATUSES.has(entry.status)
    ));
    if (otherOpenApplication) {
      throw lifecycleError(
        "Vor der Umwandlung müssen weitere offene Bewerbungen kontrolliert abgeschlossen werden.",
        "PERSONNEL_LIFECYCLE_CONVERSION_OTHER_APPLICATION_OPEN",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }

    const employeeProposal = jsonSnapshot(
      plainRecord(submitted.employee, "Mitarbeitervorschlag"),
      "Mitarbeitervorschlag",
    );
    const sourceCandidate = jsonSnapshot(candidateStateBody(candidate), "Bewerber-Quellsnapshot");
    const sourceApplication = jsonSnapshot(
      applicationStateBody(application),
      "Bewerbungs-Quellsnapshot",
      { maximumBytes: MAX_APPLICATION_STATE_BYTES },
    );
    const callbackCandidate = jsonSnapshot(candidate, "Geprüfter Bewerber", {
      maximumBytes: 2 * 1024 * 1024,
    });
    const callbackApplication = jsonSnapshot(application, "Geprüfte Bewerbung", {
      maximumBytes: 128 * 1024,
    });
    const employeeResult = await insertEmployee(employeeProposal, {
      candidate: callbackCandidate,
      application: callbackApplication,
    });
    let employee;
    try {
      employee = jsonSnapshot(
        plainRecord(employeeResult, "Angelegter Mitarbeiter"),
        "Angelegter Mitarbeiter",
      );
    } catch (error) {
      throw lifecycleError(
        "Die transaktionsgebundene Mitarbeiteranlage lieferte keinen sicheren Zielbeleg.",
        "PERSONNEL_LIFECYCLE_CONVERSION_EMPLOYEE_INTEGRITY_FAILED",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.INTEGRITY,
      );
    }
    const insertedEmployeeNumber = String(
      employee.personnelNumber ?? employee.personnel_number ?? "",
    );
    if (insertedEmployeeNumber !== employeeNumber) {
      throw lifecycleError(
        "Die angelegte Mitarbeiteridentität stimmt nicht mit der Umwandlung überein.",
        "PERSONNEL_LIFECYCLE_CONVERSION_EMPLOYEE_INTEGRITY_FAILED",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.INTEGRITY,
      );
    }

    const createdAt = occurredAt();
    const applicationResult = await repository.updateApplicationStatus({
      id: applicationId,
      candidateId,
      status: "converted",
      expectedRevision: applicationRevision,
      actor,
      occurredAt: createdAt,
    });
    if (applicationResult.rowsAffected !== 1) {
      throw lifecycleError(
        "Die Bewerbung wurde zwischenzeitlich geändert.",
        "PERSONNEL_LIFECYCLE_REVISION_CONFLICT",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }
    const convertedApplication = serializeApplication(
      await repository.getApplication(candidateId, applicationId),
    );
    const candidateResult = await repository.archiveCandidateForConversion({
      id: candidateId,
      expectedRevision: candidateRevision,
      actor,
      occurredAt: createdAt,
    });
    if (candidateResult.rowsAffected !== 1) {
      throw lifecycleError(
        "Das Bewerberprofil wurde zwischenzeitlich geändert.",
        "PERSONNEL_LIFECYCLE_REVISION_CONFLICT",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
      );
    }

    const protectedPayload = protectPayload({
      schemaVersion: 1,
      requestSha256,
      policies: {
        documentTransfer: "none",
        onboarding: "deferred",
        portalAccess: "none",
      },
      source: {
        candidate: sourceCandidate,
        application: sourceApplication,
      },
      target: { employee },
    }, candidateConversionProtectionContext({ id, candidateId }));
    const conversion = {
      id,
      candidateId,
      applicationId,
      employeeNumber,
      requestSha256,
      protectedPayload,
      actorEmployeeNumber: actor,
      createdAt,
    };
    conversion.receiptSha256 = canonicalSha256(conversionReceiptBody(conversion));
    await repository.insertConversion(conversion);

    await appendEvent(repository, {
      candidateId,
      applicationId,
      eventType: "application_status_changed",
      detail: {
        conversionId: id,
        employeeNumber,
        from: "preboarding",
        previousStateSha256: stateSha256(sourceApplication),
        reason: "conversion",
        stateSha256: stateSha256(applicationStateBody(convertedApplication)),
        to: "converted",
      },
      actor,
      createdAt,
    });
    await appendEvent(repository, {
      candidateId,
      eventType: "candidate_archived",
      detail: {
        conversionId: id,
        employeeNumber,
        from: "active",
        previousStateSha256: stateSha256(sourceCandidate),
        reason: "conversion",
        stateSha256: stateSha256({
          ...sourceCandidate,
          state: "archived",
          revision: sourceCandidate.revision + 1,
        }),
        to: "archived",
      },
      actor,
      createdAt,
    });

    const convertedCandidate = await candidateDetail(repository, candidateId);
    if (!convertedCandidate?.conversion) invalidConversionReceipt();
    return {
      conversion: convertedCandidate.conversion,
      candidate: convertedCandidate,
      replayed: false,
    };
  }

  async function registerDocument(
    candidateIdValue,
    value,
    versionValue,
    actorValue = "system",
    { access = null } = {},
  ) {
    const candidateId = text(candidateIdValue, "Bewerber-ID", 80, { required: true });
    const document = normalizeDocument(value);
    const version = normalizeDocumentVersion(versionValue);
    const actor = actorId(actorValue);
    const createdAt = occurredAt();
    const documentId = createId();
    let registeredDocument = null;
    await repository.transaction(async (transactionRepository) => {
      await requireActiveCandidate(transactionRepository, candidateId);
      if (access && !access.global) {
        const visible = await candidateDetailForAccess(transactionRepository, candidateId, access);
        if (!visible?.applications?.some((application) => access.canWriteApplication(application))) {
          throw lifecycleError(
            "Der Bewerber wurde nicht gefunden.",
            "PERSONNEL_LIFECYCLE_CANDIDATE_NOT_FOUND",
            PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
          );
        }
      }
      const categories = await transactionRepository.listDocumentCategories({ activeOnly: true });
      const category = categories.find((entry) => (
        entry.id === document.categoryId || entry.code === document.categoryId
      ));
      if (!category) {
        throw lifecycleError("Die Dokumentkategorie wurde nicht gefunden.", "PERSONNEL_LIFECYCLE_DOCUMENT_CATEGORY_INVALID");
      }
      if (category.id === "profile-photo" && (await transactionRepository.listDocuments(candidateId))
        .some((entry) => entry.categoryId === category.id && entry.status === "active")) {
        throw lifecycleError(
          "Für diesen Bewerber ist bereits ein aktives Foto vorhanden.",
          "PERSONNEL_LIFECYCLE_PHOTO_EXISTS",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.CONFLICT,
        );
      }
      if (document.applicationId
        && !await transactionRepository.getApplication(candidateId, document.applicationId)) {
        throw lifecycleError(
          "Die zugeordnete Bewerbung wurde nicht gefunden.",
          "PERSONNEL_LIFECYCLE_APPLICATION_NOT_FOUND",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
        );
      }
      const visibility = document.visibility || category.defaultVisibility;
      if (!DOCUMENT_VISIBILITIES.includes(visibility)) {
        throw lifecycleError("Die Dokumentsichtbarkeit ist ungültig.", "PERSONNEL_LIFECYCLE_DOCUMENT_VISIBILITY_INVALID");
      }
      if (category.id === "profile-photo" && (
        visibility !== CANDIDATE_PHOTO_VISIBILITY
          || document.applicationId !== null
          || version.mediaType !== CANDIDATE_PHOTO_MEDIA_TYPE
          || version.sizeBytes > CANDIDATE_PHOTO_MAX_BYTES
      )) {
        throw lifecycleError(
          "Das Bewerberfoto verletzt die geschützten Fotoeigenschaften.",
          "PERSONNEL_LIFECYCLE_PHOTO_INVALID",
        );
      }
      await transactionRepository.insertDocument({
        id: documentId,
        candidateId,
        applicationId: document.applicationId,
        categoryId: category.id,
        visibility,
        documentDate: document.documentDate,
        expiresOn: document.expiresOn,
        retentionDueAt: document.retentionDueAt,
        protectedPayload: protectPayload(
          document.protected,
          candidateDocumentProtectionContext({ id: documentId, candidateId }),
        ),
        actor,
        occurredAt: createdAt,
      });
      await transactionRepository.insertDocumentVersion({
        documentId,
        versionNumber: 1,
        storageKey: version.storageKey,
        contentSha256: version.contentSha256,
        sizeBytes: version.sizeBytes,
        mediaType: version.mediaType,
        protectedPayload: protectPayload(
          version.protected,
          candidateDocumentVersionProtectionContext({
            documentId,
            versionNumber: 1,
            candidateId,
          }),
        ),
        actor,
        occurredAt: createdAt,
      });
      registeredDocument = await serializeDocument(
        transactionRepository,
        await transactionRepository.getDocument(candidateId, documentId),
      );
      await appendEvent(transactionRepository, {
        candidateId,
        applicationId: document.applicationId,
        documentId,
        eventType: "document_registered",
        detail: {
          categoryId: category.id,
          stateSha256: stateSha256(documentStateBody(registeredDocument)),
          visibility,
          versionNumber: 1,
        },
        actor,
        createdAt,
      });
    }, { isolation: "serializable" });
    return registeredDocument;
  }

  async function candidatePhotoFile(candidateIdValue, { access = null } = {}) {
    const candidateId = text(candidateIdValue, "Bewerber-ID", 80, { required: true });
    const candidate = await candidateDetailForAccess(repository, candidateId, access);
    if (!candidate) return null;
    const row = candidate.photo;
    if (!row) return null;
    const version = row.versions.find((entry) => entry.versionNumber === row.currentVersion);
    if (!version || row.visibility !== CANDIDATE_PHOTO_VISIBILITY
      || version.mediaType !== CANDIDATE_PHOTO_MEDIA_TYPE
      || version.sizeBytes > CANDIDATE_PHOTO_MAX_BYTES
      || !version[DOCUMENT_VERSION_STORAGE_KEY]) {
      throw lifecycleError(
        "Die Fotoversion ist nicht konsistent.",
        "PERSONNEL_LIFECYCLE_DOCUMENT_INTEGRITY_FAILED",
        PERSONNEL_LIFECYCLE_ERROR_KINDS.INTEGRITY,
      );
    }
    return {
      candidateId,
      documentId: row.id,
      versionNumber: version.versionNumber,
      storageKey: version[DOCUMENT_VERSION_STORAGE_KEY],
      contentSha256: version.contentSha256,
      sizeBytes: version.sizeBytes,
      mediaType: version.mediaType,
    };
  }

  async function addDocumentVersion(
    candidateIdValue,
    documentIdValue,
    value,
    actorValue = "system",
    { access = null } = {},
  ) {
    const candidateId = text(candidateIdValue, "Bewerber-ID", 80, { required: true });
    const documentId = text(documentIdValue, "Dokument-ID", 80, { required: true });
    const version = normalizeDocumentVersion(value);
    const actor = actorId(actorValue);
    const createdAt = occurredAt();
    let versionedDocument = null;
    await repository.transaction(async (transactionRepository) => {
      await requireActiveCandidate(transactionRepository, candidateId);
      if (access && !access.global) {
        const visible = await candidateDetailForAccess(transactionRepository, candidateId, access);
        if (!visible?.applications?.some((application) => access.canWriteApplication(application))) {
          throw lifecycleError(
            "Der Bewerber wurde nicht gefunden.",
            "PERSONNEL_LIFECYCLE_CANDIDATE_NOT_FOUND",
            PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
          );
        }
      }
      const document = await transactionRepository.getDocument(candidateId, documentId);
      if (!document || document.status !== "active") {
        throw lifecycleError(
          "Das aktive Bewerberdokument wurde nicht gefunden.",
          "PERSONNEL_LIFECYCLE_DOCUMENT_NOT_FOUND",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
        );
      }
      if (document.categoryId === "profile-photo" && (
        document.visibility !== CANDIDATE_PHOTO_VISIBILITY
          || document.applicationId !== null
          || version.mediaType !== CANDIDATE_PHOTO_MEDIA_TYPE
          || version.sizeBytes > CANDIDATE_PHOTO_MAX_BYTES
      )) {
        throw lifecycleError(
          "Das Bewerberfoto verletzt die geschützten Fotoeigenschaften.",
          "PERSONNEL_LIFECYCLE_PHOTO_INVALID",
        );
      }
      const previousDocument = await serializeDocument(transactionRepository, document);
      const versionNumber = document.currentVersion + 1;
      await transactionRepository.insertDocumentVersion({
        documentId,
        versionNumber,
        storageKey: version.storageKey,
        contentSha256: version.contentSha256,
        sizeBytes: version.sizeBytes,
        mediaType: version.mediaType,
        protectedPayload: protectPayload(
          version.protected,
          candidateDocumentVersionProtectionContext({ documentId, versionNumber, candidateId }),
        ),
        actor,
        occurredAt: createdAt,
      });
      versionedDocument = await serializeDocument(
        transactionRepository,
        await transactionRepository.getDocument(candidateId, documentId),
      );
      await appendEvent(transactionRepository, {
        candidateId,
        applicationId: document.applicationId,
        documentId,
        eventType: "document_version_added",
        detail: {
          previousStateSha256: stateSha256(documentStateBody(previousDocument)),
          stateSha256: stateSha256(documentStateBody(versionedDocument)),
          versionNumber,
        },
        actor,
        createdAt,
      });
    }, { isolation: "serializable" });
    return versionedDocument;
  }

  async function listCandidates({
    includeArchived = false,
    limit = 50,
    offset = 0,
    access = null,
  } = {}) {
    const normalizedIncludeArchived = queryBoolean(includeArchived, "Archivfilter");
    const normalizedLimit = paginationInteger(limit, "Seitengröße", {
      fallback: 50,
      minimum: 1,
      maximum: 100,
    });
    const normalizedOffset = paginationInteger(offset, "Seitennummerierung", {
      fallback: 0,
      maximum: 1_000_000,
    });
    if (access && !access.global) {
      const items = [];
      let visibleOffset = 0;
      let scanOffset = 0;
      let hasMore = false;
      const scanLimit = 100;
      scan: while (true) {
        const headers = await repository.listCandidateAccessHeaders({
          includeArchived: normalizedIncludeArchived,
          limit: scanLimit,
          offset: scanOffset,
        });
        for (const header of headers) {
          const applicationScopes = await repository.listApplicationAccessScopes(header.id);
          if (!applicationScopes.some((application) => access.canReadApplication(application))) {
            continue;
          }
          if (visibleOffset < normalizedOffset) {
            visibleOffset += 1;
            continue;
          }
          if (items.length >= normalizedLimit) {
            hasMore = true;
            break scan;
          }
          const detail = await candidateDetailForAccess(repository, header.id, access);
          if (detail) items.push(detail);
        }
        scanOffset += headers.length;
        if (headers.length < scanLimit) break;
      }
      return {
        items,
        pagination: {
          limit: normalizedLimit,
          offset: normalizedOffset,
          hasMore,
          includeArchived: normalizedIncludeArchived,
        },
      };
    }
    const rows = await repository.listCandidates({
      includeArchived: normalizedIncludeArchived,
      limit: normalizedLimit + 1,
      offset: normalizedOffset,
    });
    const hasMore = rows.length > normalizedLimit;
    const items = await Promise.all(rows.slice(0, normalizedLimit).map(async (row) => {
      const profile = parsePayload(
        row.protectedPayload,
        candidateProtectionContext(row),
        "PERSONNEL_LIFECYCLE_CANDIDATE_INTEGRITY_FAILED",
        normalizeStoredCandidateProfile,
      );
      const [applicationRows, eventRows, conversionRow, documentRows] = await Promise.all([
        repository.listApplications(row.id),
        repository.listEvents(row.id),
        conversionAvailable
          ? repository.getConversionForCandidate(row.id)
          : Promise.resolve(null),
        repository.listDocuments(row.id),
      ]);
      const applications = applicationRows.map(serializeApplication);
      const history = verifyEventRows(eventRows);
      const conversion = conversionRow ? serializeConversion(conversionRow) : null;
      const photoRow = documentRows.find((document) => (
        document.categoryId === "profile-photo"
          && document.status === "active"
          && document.currentVersion >= 1
      ));
      const photo = photoRow ? await serializeDocument(repository, photoRow) : null;
      verifyCurrentStateReceipts(
        { id: row.id, state: row.state, profile, revision: row.revision },
        applications,
        photo ? [photo] : [],
        history,
      );
      if (conversionAvailable) {
        verifyConversionRelation({
          id: row.id,
          state: row.state,
          profile,
          applications,
          documents: [],
          history,
          conversion,
          revision: row.revision,
        }, conversion);
      }
      return {
        id: row.id,
        state: row.state,
        profile: {
          firstName: profile.firstName,
          lastName: profile.lastName,
          email: profile.email,
          phone: profile.phone,
        },
        photo,
        applications: applications.map((application) => ({
          id: application.id,
          status: application.status,
          desiredPositionId: application.desiredPositionId,
          desiredLocationId: application.desiredLocationId,
          desiredDepartmentId: application.desiredDepartmentId,
          desiredWeeklyMinutes: application.desiredWeeklyMinutes,
          availableFrom: application.availableFrom,
          desiredRoleTitle: application.desiredRoleTitle,
          employmentType: application.employmentType,
          revision: application.revision,
          statusChangedAt: application.statusChangedAt,
          updatedAt: application.updatedAt,
        })),
        revision: row.revision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    }));
    return {
      items,
      pagination: {
        limit: normalizedLimit,
        offset: normalizedOffset,
        hasMore,
        includeArchived: normalizedIncludeArchived,
      },
    };
  }

  async function getCandidate(id, options = {}) {
    return candidateDetailForAccess(repository, id, options.access || null);
  }

  async function listDocumentCategories({ activeOnly = true } = {}) {
    return repository.listDocumentCategories({ activeOnly: Boolean(activeOnly) });
  }

  async function verifyIntegrity() {
    const pageSize = 100;
    let offset = 0;
    let candidates = 0;
    let applications = 0;
    let documents = 0;
    let events = 0;
    while (true) {
      const rows = await repository.listCandidates({
        includeArchived: true,
        limit: pageSize,
        offset,
      });
      for (const row of rows) {
        const detail = await candidateDetail(repository, row.id);
        applications += detail.applications.length;
        documents += detail.documents.length;
        events += detail.history.length;
      }
      candidates += rows.length;
      if (rows.length < pageSize) break;
      offset += rows.length;
    }
    return Object.freeze({
      candidates,
      applications,
      documents,
      events,
    });
  }

  return Object.freeze({
    addApplication,
    addDocumentVersion,
    addTeamFeedback,
    assignTeamEvaluators,
    candidatePhotoFile,
    convertCandidateInTransaction,
    createCandidate,
    getCandidate,
    listCandidates,
    listDocumentCategories,
    listTeamEvaluationAssignments,
    registerDocument,
    submitTeamEvaluation,
    transitionApplication,
    updateApplication,
    updateCandidate,
    updateTrialAppointment,
    verifyIntegrity,
  });
}

module.exports = {
  APPLICATION_STATUSES,
  APPLICATION_TRANSITIONS,
  DOCUMENT_VISIBILITIES,
  PERSONNEL_LIFECYCLE_ERROR_KINDS,
  PersonnelLifecycleError,
  candidateApplicationProtectionContext,
  candidateConversionProtectionContext,
  candidateDocumentProtectionContext,
  candidateDocumentVersionProtectionContext,
  candidateEventProtectionContext,
  candidateProtectionContext,
  createPersonnelLifecycleService,
  normalizeApplication,
  normalizeCandidateProfile,
  summarizeApplicationEvaluations,
};
