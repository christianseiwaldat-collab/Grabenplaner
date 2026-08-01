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

const CANDIDATE_PROFILE_PAYLOAD_KEYS = Object.freeze([
  "address",
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
  "desiredRoleTitle",
  "employmentType",
  "internalNotes",
  "internalRating",
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

const PERSONNEL_LIFECYCLE_ERROR_KINDS = Object.freeze({
  INVALID: "invalid",
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
  if (!profile.email && !profile.phone) {
    throw lifecycleError(
      "Für den Bewerber wird zumindest eine E-Mail-Adresse oder Telefonnummer benötigt.",
      "PERSONNEL_LIFECYCLE_CONTACT_REQUIRED",
    );
  }
  return profile;
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

function normalizeApplication(value = {}, base = null) {
  const submitted = plainRecord(value, "Bewerbung");
  const current = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  const desiredDepartmentId = nullableInteger(
    valueOrBase(submitted, "desiredDepartmentId", current, null),
    "Gewünschte Abteilung",
    { minimum: 1 },
  );
  const desiredLocationId = nullableText(
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
  const internalRating = nullableInteger(
    valueOrBase(submitted, "internalRating", current, null),
    "Interne Bewertung",
    { minimum: 1, maximum: 5 },
  );
  return {
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
}

function normalizeStoredApplicationPayload(value) {
  const submitted = exactPayloadKeys(
    value,
    APPLICATION_PAYLOAD_KEYS,
    "Geschützte Bewerbung",
  );
  return normalizeApplication(submitted).protected;
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
      "tags",
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
      application: jsonSnapshot(application, "Bewerbungs-Quellsnapshot"),
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
  return {
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
    .filter((key) => canonicalSha256(before[key]) !== canonicalSha256(after[key]))
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
    return {
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
    const candidate = {
      id: row.id,
      state: row.state,
      profile,
      applications: applicationRows.map(serializeApplication),
      documents,
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
    const applicationRows = (await Promise.all([...permittedIds]
      .map((applicationId) => repositoryForRead.getApplication(candidateId, applicationId))))
      .filter((application) => application
        && access.canReadApplication(application));
    if (!applicationRows.length) return null;
    const profile = parsePayload(
      row.protectedPayload,
      candidateProtectionContext(row),
      "PERSONNEL_LIFECYCLE_CANDIDATE_INTEGRITY_FAILED",
      normalizeStoredCandidateProfile,
    );
    return {
      id: row.id,
      state: row.state,
      profile,
      applications: applicationRows.map(serializeApplication),
      revision: row.revision,
      archivedAt: row.archivedAt || null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
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
    const sourceApplication = jsonSnapshot(applicationStateBody(application), "Bewerbungs-Quellsnapshot");
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

  async function registerDocument(candidateIdValue, value, versionValue, actorValue = "system") {
    const candidateId = text(candidateIdValue, "Bewerber-ID", 80, { required: true });
    const document = normalizeDocument(value);
    const version = normalizeDocumentVersion(versionValue);
    const actor = actorId(actorValue);
    const createdAt = occurredAt();
    const documentId = createId();
    await repository.transaction(async (transactionRepository) => {
      await requireActiveCandidate(transactionRepository, candidateId);
      const categories = await transactionRepository.listDocumentCategories({ activeOnly: true });
      const category = categories.find((entry) => (
        entry.id === document.categoryId || entry.code === document.categoryId
      ));
      if (!category) {
        throw lifecycleError("Die Dokumentkategorie wurde nicht gefunden.", "PERSONNEL_LIFECYCLE_DOCUMENT_CATEGORY_INVALID");
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
      const registeredDocument = await serializeDocument(
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
    return serializeDocument(repository, await repository.getDocument(candidateId, documentId));
  }

  async function addDocumentVersion(candidateIdValue, documentIdValue, value, actorValue = "system") {
    const candidateId = text(candidateIdValue, "Bewerber-ID", 80, { required: true });
    const documentId = text(documentIdValue, "Dokument-ID", 80, { required: true });
    const version = normalizeDocumentVersion(value);
    const actor = actorId(actorValue);
    const createdAt = occurredAt();
    await repository.transaction(async (transactionRepository) => {
      await requireActiveCandidate(transactionRepository, candidateId);
      const document = await transactionRepository.getDocument(candidateId, documentId);
      if (!document || document.status !== "active") {
        throw lifecycleError(
          "Das aktive Bewerberdokument wurde nicht gefunden.",
          "PERSONNEL_LIFECYCLE_DOCUMENT_NOT_FOUND",
          PERSONNEL_LIFECYCLE_ERROR_KINDS.NOT_FOUND,
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
      const versionedDocument = await serializeDocument(
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
    return serializeDocument(repository, await repository.getDocument(candidateId, documentId));
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
      const [applicationRows, eventRows, conversionRow] = await Promise.all([
        repository.listApplications(row.id),
        repository.listEvents(row.id),
        conversionAvailable
          ? repository.getConversionForCandidate(row.id)
          : Promise.resolve(null),
      ]);
      const applications = applicationRows.map(serializeApplication);
      const history = verifyEventRows(eventRows);
      const conversion = conversionRow ? serializeConversion(conversionRow) : null;
      verifyCurrentStateReceipts(
        { id: row.id, state: row.state, profile, revision: row.revision },
        applications,
        [],
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
    convertCandidateInTransaction,
    createCandidate,
    getCandidate,
    listCandidates,
    listDocumentCategories,
    registerDocument,
    transitionApplication,
    updateApplication,
    updateCandidate,
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
};
