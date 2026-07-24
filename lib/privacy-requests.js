"use strict";

const { canonicalSha256 } = require("./work-rules/receipt");
const {
  OFFICIAL_RETENTION_SOURCES,
  normalizeGovernanceSource,
} = require("./retention-policy");

const PRIVACY_REQUEST_GOVERNANCE_NOTICE = [
  "Dieses Modul unterstützt die nachvollziehbare Bearbeitung von Betroffenenanfragen.",
  "Es trifft keine automatische rechtliche Entscheidung und führt insbesondere",
  "keine Löschung oder Datenübertragung aus. Fristen, Identität, Ausnahmen und",
  "Entscheidungsgrundlagen müssen durch eine berechtigte Person geprüft werden.",
].join(" ");

const OFFICIAL_PRIVACY_SOURCES = Object.freeze({
  eu_gdpr: OFFICIAL_RETENTION_SOURCES.eu_gdpr,
  at_dsg: OFFICIAL_RETENTION_SOURCES.at_dsg,
});

const PRIVACY_REQUEST_TYPES = Object.freeze([
  "access",
  "rectification",
  "erasure",
  "restriction",
  "portability",
  "objection",
]);
const PRIVACY_REQUEST_CHANNELS = Object.freeze(["portal", "email", "letter", "in_person", "other"]);
const PRIVACY_IDENTITY_STATUSES = Object.freeze(["pending", "verified", "insufficient"]);
const PRIVACY_REQUEST_STATUSES = Object.freeze([
  "received",
  "identity_pending",
  "in_review",
  "extended",
  "approved",
  "partially_approved",
  "rejected",
  "fulfilled",
  "partially_fulfilled",
  "withdrawn",
]);
const PRIVACY_DECISION_OUTCOMES = Object.freeze(["approved", "partially_approved", "rejected"]);
const PRIVACY_REQUEST_TRANSITIONS = Object.freeze({
  received: Object.freeze(["identity_pending", "in_review", "withdrawn"]),
  identity_pending: Object.freeze(["in_review", "withdrawn"]),
  in_review: Object.freeze(["extended", "approved", "partially_approved", "rejected", "withdrawn"]),
  extended: Object.freeze(["approved", "partially_approved", "rejected", "withdrawn"]),
  approved: Object.freeze(["fulfilled", "withdrawn"]),
  partially_approved: Object.freeze(["partially_fulfilled", "withdrawn"]),
  rejected: Object.freeze([]),
  fulfilled: Object.freeze([]),
  partially_fulfilled: Object.freeze([]),
  withdrawn: Object.freeze([]),
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;
const ZERO_RECEIPT = "0".repeat(64);

class PrivacyRequestError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = "PrivacyRequestError";
    this.code = code;
  }
}

function requestError(message, code) {
  return new PrivacyRequestError(message, code);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label, code = "PRIVACY_OBJECT_INVALID") {
  if (!isPlainObject(value)) throw requestError(`${label} muss ein Objekt sein.`, code);
  return value;
}

function assertExactKeys(value, allowed, label, code = "PRIVACY_FIELDS_INVALID") {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw requestError(`${label} enthält nicht unterstützte Felder: ${unexpected.sort().join(", ")}.`, code);
  }
}

function requiredString(value, label, { maximum = 500, identifier = false } = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum || (identifier && !IDENTIFIER_PATTERN.test(normalized))) {
    throw requestError(`${label} ist ungültig.`, "PRIVACY_STRING_INVALID");
  }
  return normalized;
}

function optionalString(value, label, options = {}) {
  if (value === undefined || value === null || value === "") return "";
  return requiredString(value, label, options);
}

function enumValue(value, allowed, label, code = "PRIVACY_ENUM_INVALID") {
  const normalized = String(value || "").trim();
  if (!allowed.includes(normalized)) throw requestError(`${label} ist nicht unterstützt.`, code);
  return normalized;
}

function isoInstant(value, label) {
  const normalized = value instanceof Date ? value.toISOString() : String(value || "").trim();
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized)) {
    throw requestError(`${label} muss eine eindeutige Zeitzone enthalten.`, "PRIVACY_TIMESTAMP_INVALID");
  }
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) {
    throw requestError(`${label} ist ungültig.`, "PRIVACY_TIMESTAMP_INVALID");
  }
  return parsed.toISOString();
}

function compareInstant(left, right) {
  return new Date(left).getTime() - new Date(right).getTime();
}

function integer(value, label, { minimum = 1, maximum = 2 } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw requestError(`${label} muss eine ganze Zahl zwischen ${minimum} und ${maximum} sein.`, "PRIVACY_INTEGER_INVALID");
  }
  return normalized;
}

function normalizeScope(input, label = "Der Antragsumfang") {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) {
    throw requestError(`${label} muss zwischen einem und 100 Einträgen enthalten.`, "PRIVACY_SCOPE_INVALID");
  }
  const normalized = input.map((item) => requiredString(item, "Ein Umfangseintrag", {
    maximum: 128,
    identifier: true,
  }));
  if (new Set(normalized).size !== normalized.length) {
    throw requestError(`${label} darf keine doppelten Einträge enthalten.`, "PRIVACY_SCOPE_DUPLICATE");
  }
  return normalized.sort();
}

function utcDaysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addUtcCalendarMonths(timestamp, months) {
  const source = new Date(isoInstant(timestamp, "Der Ausgangszeitpunkt"));
  const absoluteMonth = (source.getUTCFullYear() * 12) + source.getUTCMonth() + months;
  const targetYear = Math.floor(absoluteMonth / 12);
  const targetMonth = absoluteMonth % 12;
  const targetDay = Math.min(source.getUTCDate(), utcDaysInMonth(targetYear, targetMonth));
  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    targetDay,
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  )).toISOString();
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function eventReceipt(requestId, event) {
  const unsigned = { ...event };
  delete unsigned.receiptSha256;
  return canonicalSha256({
    schemaVersion: 1,
    kind: "privacy_request_event",
    requestId,
    event: unsigned,
  });
}

function appendEvent(request, { type, at, actor, detail }) {
  const events = request.events.map(jsonClone);
  const normalizedAt = isoInstant(at, "Der Ereigniszeitpunkt");
  const previous = events.at(-1);
  if (previous && compareInstant(normalizedAt, previous.at) < 0) {
    throw requestError("Ereignisse dürfen nicht rückdatiert werden.", "PRIVACY_EVENT_ORDER_INVALID");
  }
  const event = {
    sequence: events.length + 1,
    type: requiredString(type, "Der Ereignistyp", { maximum: 128, identifier: true }),
    at: normalizedAt,
    actor: requiredString(actor, "Die handelnde Person", { maximum: 128, identifier: true }),
    detail: jsonClone(assertPlainObject(detail, "Die Ereignisdetails", "PRIVACY_EVENT_DETAIL_INVALID")),
    previousReceiptSha256: previous?.receiptSha256 || ZERO_RECEIPT,
  };
  events.push({ ...event, receiptSha256: eventReceipt(request.id, event) });
  return events;
}

function unsignedRequest(request) {
  const unsigned = jsonClone(request);
  delete unsigned.receiptSha256;
  return unsigned;
}

function stateReceipt(request) {
  return canonicalSha256({
    schemaVersion: 1,
    kind: "privacy_request_state",
    request: unsignedRequest(request),
  });
}

function signRequest(request) {
  return { ...request, receiptSha256: stateReceipt(request) };
}

function assertTransition(from, to) {
  if (!(PRIVACY_REQUEST_TRANSITIONS[from] || []).includes(to)) {
    throw requestError(`Der Statuswechsel von ${from} nach ${to} ist nicht zulässig.`, "PRIVACY_STATUS_TRANSITION_INVALID");
  }
}

function normalizeIdentity(input) {
  const identity = assertPlainObject(input, "Der Identitätsstatus", "PRIVACY_IDENTITY_INVALID");
  assertExactKeys(
    identity,
    new Set(["status", "assessedAt", "assessedBy", "reasonCode"]),
    "Der Identitätsstatus",
    "PRIVACY_IDENTITY_FIELDS_INVALID",
  );
  const status = enumValue(identity.status, PRIVACY_IDENTITY_STATUSES, "Der Identitätsstatus");
  const assessedAt = identity.assessedAt ? isoInstant(identity.assessedAt, "Der Identitäts-Prüfzeitpunkt") : null;
  const assessedBy = optionalString(identity.assessedBy, "Die prüfende Person", {
    maximum: 128,
    identifier: true,
  });
  const reasonCode = optionalString(identity.reasonCode, "Der Identitäts-Grundcode", {
    maximum: 128,
    identifier: true,
  });
  if (status === "pending" && (assessedAt || assessedBy || reasonCode)) {
    throw requestError("Ein ausstehender Identitätsstatus darf keine Prüfdaten enthalten.", "PRIVACY_IDENTITY_PENDING_INVALID");
  }
  if (status !== "pending" && (!assessedAt || !assessedBy || !reasonCode)) {
    throw requestError("Ein bewerteter Identitätsstatus benötigt Zeitpunkt, Person und Grundcode.", "PRIVACY_IDENTITY_ASSESSMENT_INCOMPLETE");
  }
  return { status, assessedAt, assessedBy, reasonCode };
}

function normalizeDeadline(input) {
  const deadline = assertPlainObject(input, "Die Frist", "PRIVACY_DEADLINE_INVALID");
  assertExactKeys(
    deadline,
    new Set([
      "initialTargetAt", "extensionMonths", "extendedTargetAt", "extensionReasonCode",
      "extensionReason", "extensionNotifiedAt", "extensionActor",
    ]),
    "Die Frist",
    "PRIVACY_DEADLINE_FIELDS_INVALID",
  );
  const initialTargetAt = isoInstant(deadline.initialTargetAt, "Das ursprüngliche Fristziel");
  const extensionMonths = Number(deadline.extensionMonths);
  if (!Number.isSafeInteger(extensionMonths) || extensionMonths < 0 || extensionMonths > 2) {
    throw requestError("Die Fristverlängerung darf höchstens zwei Monate betragen.", "PRIVACY_EXTENSION_LIMIT");
  }
  const extendedTargetAt = deadline.extendedTargetAt
    ? isoInstant(deadline.extendedTargetAt, "Das verlängerte Fristziel")
    : null;
  const extensionReasonCode = optionalString(deadline.extensionReasonCode, "Der Verlängerungs-Grundcode", {
    maximum: 128,
    identifier: true,
  });
  const extensionReason = optionalString(deadline.extensionReason, "Die Verlängerungsbegründung", { maximum: 2000 });
  const extensionNotifiedAt = deadline.extensionNotifiedAt
    ? isoInstant(deadline.extensionNotifiedAt, "Der Mitteilungszeitpunkt")
    : null;
  const extensionActor = optionalString(deadline.extensionActor, "Die verantwortliche Person", {
    maximum: 128,
    identifier: true,
  });
  if (extensionMonths === 0 && (
    extendedTargetAt || extensionReasonCode || extensionReason || extensionNotifiedAt || extensionActor
  )) {
    throw requestError("Ohne Fristverlängerung dürfen keine Verlängerungsdaten vorhanden sein.", "PRIVACY_EXTENSION_STATE_INVALID");
  }
  if (extensionMonths > 0 && (
    !extendedTargetAt || !extensionReasonCode || !extensionReason || !extensionNotifiedAt || !extensionActor
  )) {
    throw requestError("Eine Fristverlängerung muss vollständig dokumentiert sein.", "PRIVACY_EXTENSION_INCOMPLETE");
  }
  return {
    initialTargetAt,
    extensionMonths,
    extendedTargetAt,
    extensionReasonCode,
    extensionReason,
    extensionNotifiedAt,
    extensionActor,
  };
}

function normalizeRefusal(input) {
  const refusal = assertPlainObject(input, "Eine Ablehnung", "PRIVACY_REFUSAL_INVALID");
  assertExactKeys(
    refusal,
    new Set(["scopeItem", "reasonCode", "reason", "sources"]),
    "Die Ablehnung",
    "PRIVACY_REFUSAL_FIELDS_INVALID",
  );
  if (!Array.isArray(refusal.sources) || refusal.sources.length === 0 || refusal.sources.length > 20) {
    throw requestError("Eine Ablehnung benötigt mindestens eine dokumentierte Quelle.", "PRIVACY_REFUSAL_SOURCES_INVALID");
  }
  let sources;
  try {
    sources = refusal.sources.map(normalizeGovernanceSource);
  } catch (error) {
    throw requestError(`Eine Entscheidungsquelle ist ungültig: ${error.message}`, "PRIVACY_DECISION_SOURCE_INVALID");
  }
  return {
    scopeItem: requiredString(refusal.scopeItem, "Der abgelehnte Umfang", { maximum: 128, identifier: true }),
    reasonCode: requiredString(refusal.reasonCode, "Der Ablehnungs-Grundcode", {
      maximum: 128,
      identifier: true,
    }),
    reason: requiredString(refusal.reason, "Die Ablehnungsbegründung", { maximum: 2000 }),
    sources,
  };
}

function normalizeDecision(input) {
  if (input === null) return null;
  const decision = assertPlainObject(input, "Die Entscheidung", "PRIVACY_DECISION_INVALID");
  assertExactKeys(
    decision,
    new Set([
      "outcome", "decidedAt", "decidedBy", "approvedScope", "refusals", "summary",
      "automatic", "humanReviewRequired",
    ]),
    "Die Entscheidung",
    "PRIVACY_DECISION_FIELDS_INVALID",
  );
  if (!Array.isArray(decision.refusals) || decision.refusals.length > 100) {
    throw requestError("Die Teilablehnungen müssen als Liste angegeben werden.", "PRIVACY_REFUSALS_INVALID");
  }
  if (decision.automatic !== false || decision.humanReviewRequired !== true) {
    throw requestError("Datenschutzentscheidungen müssen als menschlich geprüft und nicht automatisch gekennzeichnet sein.", "PRIVACY_DECISION_AUTOMATION_INVALID");
  }
  return {
    outcome: enumValue(decision.outcome, PRIVACY_DECISION_OUTCOMES, "Das Entscheidungsergebnis"),
    decidedAt: isoInstant(decision.decidedAt, "Der Entscheidungszeitpunkt"),
    decidedBy: requiredString(decision.decidedBy, "Die entscheidende Person", {
      maximum: 128,
      identifier: true,
    }),
    approvedScope: Array.isArray(decision.approvedScope) && decision.approvedScope.length
      ? normalizeScope(decision.approvedScope, "Der genehmigte Umfang")
      : [],
    refusals: decision.refusals.map(normalizeRefusal),
    summary: optionalString(decision.summary, "Die Entscheidungszusammenfassung", { maximum: 2000 }),
    automatic: false,
    humanReviewRequired: true,
  };
}

function assertEventChain(requestId, events) {
  if (!Array.isArray(events) || events.length === 0 || events.length > 1000) {
    throw requestError("Der Bearbeitungsverlauf ist ungültig.", "PRIVACY_EVENTS_INVALID");
  }
  let previousReceipt = ZERO_RECEIPT;
  let previousAt = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = assertPlainObject(events[index], "Ein Verlaufseintrag", "PRIVACY_EVENT_INVALID");
    assertExactKeys(
      event,
      new Set(["sequence", "type", "at", "actor", "detail", "previousReceiptSha256", "receiptSha256"]),
      "Der Verlaufseintrag",
      "PRIVACY_EVENT_FIELDS_INVALID",
    );
    if (event.sequence !== index + 1) throw requestError("Die Ereignisfolge ist nicht lückenlos.", "PRIVACY_EVENT_SEQUENCE_INVALID");
    requiredString(event.type, "Der Ereignistyp", { maximum: 128, identifier: true });
    requiredString(event.actor, "Die handelnde Person", { maximum: 128, identifier: true });
    const at = isoInstant(event.at, "Der Ereigniszeitpunkt");
    assertPlainObject(event.detail, "Die Ereignisdetails", "PRIVACY_EVENT_DETAIL_INVALID");
    if (previousAt && compareInstant(at, previousAt) < 0) {
      throw requestError("Die Ereignisfolge ist zeitlich nicht monoton.", "PRIVACY_EVENT_ORDER_INVALID");
    }
    if (event.previousReceiptSha256 !== previousReceipt || event.receiptSha256 !== eventReceipt(requestId, event)) {
      throw requestError("Die Ereignisbelegkette ist ungültig.", "PRIVACY_EVENT_RECEIPT_INVALID");
    }
    previousAt = at;
    previousReceipt = event.receiptSha256;
  }
}

function assertRequestStructure(input) {
  const request = assertPlainObject(input, "Die Betroffenenanfrage", "PRIVACY_REQUEST_INVALID");
  assertExactKeys(
    request,
    new Set([
      "schemaVersion", "id", "type", "subjectId", "scope", "receivedAt", "channel", "status",
      "identity", "deadline", "decision", "completion", "events", "receiptSha256",
    ]),
    "Die Betroffenenanfrage",
    "PRIVACY_REQUEST_FIELDS_INVALID",
  );
  if (request.schemaVersion !== 1) throw requestError("Die Schema-Version ist nicht unterstützt.", "PRIVACY_SCHEMA_INVALID");
  const id = requiredString(request.id, "Die Anfrage-ID", { maximum: 128, identifier: true });
  enumValue(request.type, PRIVACY_REQUEST_TYPES, "Der Anfragetyp");
  requiredString(request.subjectId, "Die Betroffenen-ID", { maximum: 128, identifier: true });
  normalizeScope(request.scope);
  const receivedAt = isoInstant(request.receivedAt, "Der Eingangszeitpunkt");
  enumValue(request.channel, PRIVACY_REQUEST_CHANNELS, "Der Eingangskanal");
  const status = enumValue(request.status, PRIVACY_REQUEST_STATUSES, "Der Bearbeitungsstatus");
  const identity = normalizeIdentity(request.identity);
  const deadline = normalizeDeadline(request.deadline);
  if (identity.assessedAt && compareInstant(identity.assessedAt, receivedAt) < 0) {
    throw requestError("Die Identitätsprüfung darf nicht vor dem Eingang liegen.", "PRIVACY_IDENTITY_TIME_INVALID");
  }
  if (identity.status === "pending" && !["received", "withdrawn"].includes(request.status)) {
    throw requestError("Ein offener Identitätsstatus passt nicht zum Bearbeitungsstatus.", "PRIVACY_IDENTITY_STATUS_MISMATCH");
  }
  if (identity.status === "insufficient" && !["identity_pending", "withdrawn"].includes(request.status)) {
    throw requestError("Eine unzureichende Identitätsprüfung muss als ausstehend geführt werden.", "PRIVACY_IDENTITY_STATUS_MISMATCH");
  }
  if (identity.status === "verified" && ["received", "identity_pending"].includes(request.status)) {
    throw requestError("Eine bestätigte Identität muss in die fachliche Prüfung übergehen.", "PRIVACY_IDENTITY_STATUS_MISMATCH");
  }
  if (deadline.initialTargetAt !== addUtcCalendarMonths(receivedAt, 1)) {
    throw requestError("Das ursprüngliche Fristziel muss einen Kalendermonat nach Eingang liegen.", "PRIVACY_INITIAL_DEADLINE_INVALID");
  }
  if (deadline.extensionMonths > 0) {
    if (deadline.extendedTargetAt !== addUtcCalendarMonths(deadline.initialTargetAt, deadline.extensionMonths)) {
      throw requestError("Das verlängerte Fristziel stimmt nicht mit der dokumentierten Verlängerung überein.", "PRIVACY_EXTENDED_DEADLINE_INVALID");
    }
    if (compareInstant(deadline.extensionNotifiedAt, deadline.initialTargetAt) > 0) {
      throw requestError("Die Fristverlängerung wurde nach dem ursprünglichen Fristziel mitgeteilt.", "PRIVACY_EXTENSION_NOTICE_LATE");
    }
    if (compareInstant(deadline.extensionNotifiedAt, receivedAt) < 0) {
      throw requestError("Die Fristverlängerung darf nicht vor dem Eingang mitgeteilt werden.", "PRIVACY_EXTENSION_NOTICE_INVALID");
    }
    if (!["extended", "approved", "partially_approved", "rejected", "fulfilled", "partially_fulfilled", "withdrawn"].includes(request.status)) {
      throw requestError("Die dokumentierte Verlängerung passt nicht zum Bearbeitungsstatus.", "PRIVACY_EXTENSION_STATUS_MISMATCH");
    }
  } else if (request.status === "extended") {
    throw requestError("Der Status verlängert benötigt eine dokumentierte Fristverlängerung.", "PRIVACY_EXTENSION_MISSING");
  }
  const decision = normalizeDecision(request.decision);
  const decidedStatuses = ["approved", "partially_approved", "rejected", "fulfilled", "partially_fulfilled"];
  if (decidedStatuses.includes(status) && !decision) {
    throw requestError("Der Bearbeitungsstatus benötigt eine dokumentierte Entscheidung.", "PRIVACY_DECISION_MISSING");
  }
  if (decision && ![...decidedStatuses, "withdrawn"].includes(status)) {
    throw requestError("Die Entscheidung passt nicht zum Bearbeitungsstatus.", "PRIVACY_DECISION_STATUS_INVALID");
  }
  if (decision && identity.status !== "verified") {
    throw requestError("Eine Entscheidung setzt eine bestätigte Identität voraus.", "PRIVACY_IDENTITY_REQUIRED");
  }
  if (decision) {
    if (compareInstant(decision.decidedAt, receivedAt) < 0) {
      throw requestError("Die Entscheidung darf nicht vor dem Eingang liegen.", "PRIVACY_DECISION_TIME_INVALID");
    }
    scopeCoverage(request.scope, decision.approvedScope, decision.refusals, decision.outcome);
  }
  if (decision && status !== "withdrawn") {
    const expectedOutcome = ["approved", "fulfilled"].includes(status)
      ? "approved"
      : ["partially_approved", "partially_fulfilled"].includes(status)
        ? "partially_approved"
        : "rejected";
    if (decision.outcome !== expectedOutcome) {
      throw requestError("Das Entscheidungsergebnis passt nicht zum Bearbeitungsstatus.", "PRIVACY_DECISION_STATUS_INVALID");
    }
  }
  const completion = request.completion;
  if (completion !== null) {
    const value = assertPlainObject(completion, "Der Abschlussnachweis", "PRIVACY_COMPLETION_INVALID");
    assertExactKeys(
      value,
      new Set(["completedAt", "completedBy", "reference"]),
      "Der Abschlussnachweis",
      "PRIVACY_COMPLETION_FIELDS_INVALID",
    );
    isoInstant(value.completedAt, "Der Abschlusszeitpunkt");
    requiredString(value.completedBy, "Die abschließende Person", { maximum: 128, identifier: true });
    requiredString(value.reference, "Der Abschlussnachweis", { maximum: 500 });
    if (decision && compareInstant(value.completedAt, decision.decidedAt) < 0) {
      throw requestError("Der Abschluss darf nicht vor der Entscheidung liegen.", "PRIVACY_COMPLETION_TIME_INVALID");
    }
    if (!["fulfilled", "partially_fulfilled"].includes(status)) {
      throw requestError("Ein Abschlussnachweis ist nur bei erfüllten Anfragen zulässig.", "PRIVACY_COMPLETION_STATUS_INVALID");
    }
  } else if (["fulfilled", "partially_fulfilled"].includes(status)) {
    throw requestError("Eine erfüllte Anfrage benötigt einen Abschlussnachweis.", "PRIVACY_COMPLETION_MISSING");
  }
  assertEventChain(id, request.events);
  return request;
}

function verifyPrivacyRequest(input) {
  try {
    const request = assertRequestStructure(input);
    return SHA256_PATTERN.test(String(request.receiptSha256 || ""))
      && request.receiptSha256 === stateReceipt(request);
  } catch {
    return false;
  }
}

function verifiedRequest(input) {
  if (!verifyPrivacyRequest(input)) {
    throw requestError("Der Beleg der Betroffenenanfrage ist ungültig.", "PRIVACY_REQUEST_RECEIPT_INVALID");
  }
  return jsonClone(input);
}

function createPrivacyRequest(input) {
  const value = assertPlainObject(input, "Die neue Betroffenenanfrage", "PRIVACY_REQUEST_INPUT_INVALID");
  assertExactKeys(
    value,
    new Set(["schemaVersion", "id", "type", "subjectId", "scope", "receivedAt", "channel"]),
    "Die neue Betroffenenanfrage",
    "PRIVACY_REQUEST_INPUT_FIELDS_INVALID",
  );
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
    throw requestError("Die Schema-Version ist nicht unterstützt.", "PRIVACY_SCHEMA_INVALID");
  }
  const id = requiredString(value.id, "Die Anfrage-ID", { maximum: 128, identifier: true });
  const type = enumValue(value.type, PRIVACY_REQUEST_TYPES, "Der Anfragetyp");
  const subjectId = requiredString(value.subjectId, "Die Betroffenen-ID", { maximum: 128, identifier: true });
  const scope = normalizeScope(value.scope);
  const receivedAt = isoInstant(value.receivedAt, "Der Eingangszeitpunkt");
  const channel = enumValue(value.channel, PRIVACY_REQUEST_CHANNELS, "Der Eingangskanal");
  const base = {
    schemaVersion: 1,
    id,
    type,
    subjectId,
    scope,
    receivedAt,
    channel,
    status: "received",
    identity: {
      status: "pending",
      assessedAt: null,
      assessedBy: "",
      reasonCode: "",
    },
    deadline: {
      initialTargetAt: addUtcCalendarMonths(receivedAt, 1),
      extensionMonths: 0,
      extendedTargetAt: null,
      extensionReasonCode: "",
      extensionReason: "",
      extensionNotifiedAt: null,
      extensionActor: "",
    },
    decision: null,
    completion: null,
    events: [],
  };
  base.events = appendEvent(base, {
    type: "request_received",
    at: receivedAt,
    actor: "data_subject",
    detail: { type, channel, scope },
  });
  return signRequest(base);
}

function setPrivacyRequestIdentity(input, assessment) {
  const request = verifiedRequest(input);
  if (!["received", "identity_pending"].includes(request.status)) {
    throw requestError("Die Identitätsprüfung ist in diesem Status nicht mehr zulässig.", "PRIVACY_IDENTITY_STATUS_INVALID");
  }
  const value = assertPlainObject(assessment, "Die Identitätsprüfung", "PRIVACY_IDENTITY_INPUT_INVALID");
  assertExactKeys(
    value,
    new Set(["status", "assessedAt", "assessedBy", "reasonCode"]),
    "Die Identitätsprüfung",
    "PRIVACY_IDENTITY_INPUT_FIELDS_INVALID",
  );
  const status = enumValue(value.status, ["verified", "insufficient"], "Das Prüfergebnis");
  const assessedAt = isoInstant(value.assessedAt, "Der Prüfzeitpunkt");
  if (compareInstant(assessedAt, request.receivedAt) < 0) {
    throw requestError("Die Identitätsprüfung darf nicht vor dem Eingang liegen.", "PRIVACY_IDENTITY_TIME_INVALID");
  }
  const assessedBy = requiredString(value.assessedBy, "Die prüfende Person", {
    maximum: 128,
    identifier: true,
  });
  const reasonCode = requiredString(value.reasonCode, "Der Prüfgrundcode", {
    maximum: 128,
    identifier: true,
  });
  const nextStatus = status === "verified" ? "in_review" : "identity_pending";
  if (request.status !== nextStatus) assertTransition(request.status, nextStatus);
  request.status = nextStatus;
  request.identity = { status, assessedAt, assessedBy, reasonCode };
  request.events = appendEvent(request, {
    type: status === "verified" ? "identity_verified" : "identity_insufficient",
    at: assessedAt,
    actor: assessedBy,
    detail: { status, reasonCode },
  });
  return signRequest(request);
}

function extendPrivacyRequestDeadline(input, extension) {
  const request = verifiedRequest(input);
  if (request.status !== "in_review" || request.identity.status !== "verified") {
    throw requestError("Eine Fristverlängerung setzt eine laufende Prüfung und bestätigte Identität voraus.", "PRIVACY_EXTENSION_STATUS_INVALID");
  }
  if (request.deadline.extensionMonths !== 0) {
    throw requestError("Eine Fristverlängerung wurde bereits dokumentiert.", "PRIVACY_EXTENSION_ALREADY_SET");
  }
  const value = assertPlainObject(extension, "Die Fristverlängerung", "PRIVACY_EXTENSION_INPUT_INVALID");
  assertExactKeys(
    value,
    new Set(["months", "reasonCode", "reason", "notifiedAt", "actor"]),
    "Die Fristverlängerung",
    "PRIVACY_EXTENSION_INPUT_FIELDS_INVALID",
  );
  const months = integer(value.months, "Die Fristverlängerung", { minimum: 1, maximum: 2 });
  const notifiedAt = isoInstant(value.notifiedAt, "Der Mitteilungszeitpunkt");
  if (compareInstant(notifiedAt, request.receivedAt) < 0) {
    throw requestError("Die Verlängerungsmitteilung darf nicht vor dem Eingang liegen.", "PRIVACY_EXTENSION_NOTICE_INVALID");
  }
  if (compareInstant(notifiedAt, request.deadline.initialTargetAt) > 0) {
    throw requestError("Die Verlängerungsmitteilung muss spätestens bis zum ursprünglichen Monatsziel dokumentiert sein.", "PRIVACY_EXTENSION_NOTICE_LATE");
  }
  const actor = requiredString(value.actor, "Die verantwortliche Person", {
    maximum: 128,
    identifier: true,
  });
  const reasonCode = requiredString(value.reasonCode, "Der Verlängerungs-Grundcode", {
    maximum: 128,
    identifier: true,
  });
  const reason = requiredString(value.reason, "Die Verlängerungsbegründung", { maximum: 2000 });
  assertTransition(request.status, "extended");
  request.status = "extended";
  request.deadline = {
    ...request.deadline,
    extensionMonths: months,
    extendedTargetAt: addUtcCalendarMonths(request.deadline.initialTargetAt, months),
    extensionReasonCode: reasonCode,
    extensionReason: reason,
    extensionNotifiedAt: notifiedAt,
    extensionActor: actor,
  };
  request.events = appendEvent(request, {
    type: "deadline_extended",
    at: notifiedAt,
    actor,
    detail: {
      months,
      reasonCode,
      extendedTargetAt: request.deadline.extendedTargetAt,
    },
  });
  return signRequest(request);
}

function scopeCoverage(requestScope, approvedScope, refusals, outcome) {
  const requested = new Set(requestScope);
  const approved = new Set(approvedScope);
  const refused = new Set(refusals.map((item) => item.scopeItem));
  if (approved.size !== approvedScope.length || refused.size !== refusals.length) {
    throw requestError("Genehmigte oder abgelehnte Umfangseinträge dürfen nicht doppelt vorkommen.", "PRIVACY_DECISION_SCOPE_DUPLICATE");
  }
  for (const item of [...approved, ...refused]) {
    if (!requested.has(item)) throw requestError("Die Entscheidung enthält einen nicht beantragten Umfang.", "PRIVACY_DECISION_SCOPE_UNKNOWN");
  }
  for (const item of approved) {
    if (refused.has(item)) throw requestError("Ein Umfang darf nicht gleichzeitig genehmigt und abgelehnt werden.", "PRIVACY_DECISION_SCOPE_CONFLICT");
  }
  if ([...requested].some((item) => !approved.has(item) && !refused.has(item))) {
    throw requestError("Die Entscheidung muss jeden beantragten Umfang abdecken.", "PRIVACY_DECISION_SCOPE_INCOMPLETE");
  }
  if (outcome === "approved" && (approved.size !== requested.size || refused.size !== 0)) {
    throw requestError("Eine vollständige Genehmigung darf keine Ablehnungen enthalten.", "PRIVACY_DECISION_APPROVAL_INVALID");
  }
  if (outcome === "partially_approved" && (approved.size === 0 || refused.size === 0)) {
    throw requestError("Eine Teilgenehmigung benötigt genehmigte und begründet abgelehnte Anteile.", "PRIVACY_DECISION_PARTIAL_INVALID");
  }
  if (outcome === "rejected" && (approved.size !== 0 || refused.size !== requested.size)) {
    throw requestError("Eine vollständige Ablehnung muss den gesamten Umfang begründet abdecken.", "PRIVACY_DECISION_REJECTION_INVALID");
  }
}

function decidePrivacyRequest(input, decisionInput) {
  const request = verifiedRequest(input);
  if (!["in_review", "extended"].includes(request.status) || request.identity.status !== "verified") {
    throw requestError("Eine Entscheidung setzt eine laufende Prüfung und bestätigte Identität voraus.", "PRIVACY_DECISION_STATUS_INVALID");
  }
  const value = assertPlainObject(decisionInput, "Die Entscheidung", "PRIVACY_DECISION_INPUT_INVALID");
  assertExactKeys(
    value,
    new Set(["outcome", "decidedAt", "decidedBy", "approvedScope", "refusals", "summary"]),
    "Die Entscheidung",
    "PRIVACY_DECISION_INPUT_FIELDS_INVALID",
  );
  const outcome = enumValue(value.outcome, PRIVACY_DECISION_OUTCOMES, "Das Entscheidungsergebnis");
  const decidedAt = isoInstant(value.decidedAt, "Der Entscheidungszeitpunkt");
  const decidedBy = requiredString(value.decidedBy, "Die entscheidende Person", {
    maximum: 128,
    identifier: true,
  });
  const approvedScope = Array.isArray(value.approvedScope) && value.approvedScope.length
    ? normalizeScope(value.approvedScope, "Der genehmigte Umfang")
    : [];
  if (!Array.isArray(value.refusals) || value.refusals.length > 100) {
    throw requestError("Ablehnungen müssen als Liste angegeben werden.", "PRIVACY_REFUSALS_INVALID");
  }
  const refusals = value.refusals.map(normalizeRefusal);
  scopeCoverage(request.scope, approvedScope, refusals, outcome);
  const summary = optionalString(value.summary, "Die Entscheidungszusammenfassung", { maximum: 2000 });
  assertTransition(request.status, outcome);
  request.status = outcome;
  request.decision = {
    outcome,
    decidedAt,
    decidedBy,
    approvedScope,
    refusals,
    summary,
    automatic: false,
    humanReviewRequired: true,
  };
  request.events = appendEvent(request, {
    type: `request_${outcome}`,
    at: decidedAt,
    actor: decidedBy,
    detail: {
      outcome,
      approvedScope,
      refusedScope: refusals.map((item) => item.scopeItem),
    },
  });
  return signRequest(request);
}

function completePrivacyRequest(input, completionInput) {
  const request = verifiedRequest(input);
  const target = request.status === "approved"
    ? "fulfilled"
    : request.status === "partially_approved"
      ? "partially_fulfilled"
      : null;
  if (!target) {
    throw requestError("Nur genehmigte oder teilweise genehmigte Anfragen können erfüllt werden.", "PRIVACY_COMPLETION_STATUS_INVALID");
  }
  const value = assertPlainObject(completionInput, "Der Abschlussnachweis", "PRIVACY_COMPLETION_INPUT_INVALID");
  assertExactKeys(
    value,
    new Set(["completedAt", "completedBy", "reference"]),
    "Der Abschlussnachweis",
    "PRIVACY_COMPLETION_INPUT_FIELDS_INVALID",
  );
  const completedAt = isoInstant(value.completedAt, "Der Abschlusszeitpunkt");
  const completedBy = requiredString(value.completedBy, "Die abschließende Person", {
    maximum: 128,
    identifier: true,
  });
  const reference = requiredString(value.reference, "Der Abschlussnachweis", { maximum: 500 });
  assertTransition(request.status, target);
  request.status = target;
  request.completion = { completedAt, completedBy, reference };
  request.events = appendEvent(request, {
    type: `request_${target}`,
    at: completedAt,
    actor: completedBy,
    detail: { reference },
  });
  return signRequest(request);
}

function withdrawPrivacyRequest(input, withdrawalInput) {
  const request = verifiedRequest(input);
  assertTransition(request.status, "withdrawn");
  const value = assertPlainObject(withdrawalInput, "Die Rücknahme", "PRIVACY_WITHDRAWAL_INPUT_INVALID");
  assertExactKeys(
    value,
    new Set(["at", "actor", "reasonCode"]),
    "Die Rücknahme",
    "PRIVACY_WITHDRAWAL_INPUT_FIELDS_INVALID",
  );
  const at = isoInstant(value.at, "Der Rücknahmezeitpunkt");
  const actor = requiredString(value.actor, "Die handelnde Person", { maximum: 128, identifier: true });
  const reasonCode = requiredString(value.reasonCode, "Der Rücknahme-Grundcode", {
    maximum: 128,
    identifier: true,
  });
  request.status = "withdrawn";
  request.events = appendEvent(request, {
    type: "request_withdrawn",
    at,
    actor,
    detail: { reasonCode },
  });
  return signRequest(request);
}

function allowedPrivacyRequestTransitions(status) {
  return [...(PRIVACY_REQUEST_TRANSITIONS[enumValue(
    status,
    PRIVACY_REQUEST_STATUSES,
    "Der Bearbeitungsstatus",
  )] || [])];
}

module.exports = {
  OFFICIAL_PRIVACY_SOURCES,
  PRIVACY_DECISION_OUTCOMES,
  PRIVACY_IDENTITY_STATUSES,
  PRIVACY_REQUEST_CHANNELS,
  PRIVACY_REQUEST_GOVERNANCE_NOTICE,
  PRIVACY_REQUEST_STATUSES,
  PRIVACY_REQUEST_TRANSITIONS,
  PRIVACY_REQUEST_TYPES,
  PrivacyRequestError,
  addUtcCalendarMonths,
  allowedPrivacyRequestTransitions,
  completePrivacyRequest,
  createPrivacyRequest,
  decidePrivacyRequest,
  extendPrivacyRequestDeadline,
  setPrivacyRequestIdentity,
  verifyPrivacyRequest,
  withdrawPrivacyRequest,
};
