"use strict";

const { randomUUID } = require("node:crypto");

const { canonicalSha256 } = require("./work-rules/receipt");

const STAFF_ASSIGNMENT_REQUEST_STATUSES = Object.freeze([
  "draft",
  "submitted",
  "accepted",
  "rejected",
  "withdrawn",
  "cancelled",
  "expired",
]);

const STAFF_ASSIGNMENT_REQUEST_TIME_KINDS = Object.freeze([
  "hourly",
  "full_day",
  "multi_day",
]);

const STAFF_ASSIGNMENT_REQUEST_ACTIONS = Object.freeze([
  "created",
  "revised",
  "submitted",
  "accepted",
  "rejected",
  "withdrawn",
  "cancelled",
  "expired",
]);

const ACTION_STATUS = Object.freeze({
  created: "draft",
  revised: "draft",
  submitted: "submitted",
  accepted: "accepted",
  rejected: "rejected",
  withdrawn: "withdrawn",
  cancelled: "cancelled",
  expired: "expired",
});

const ALLOWED_TRANSITIONS = Object.freeze({
  draft: Object.freeze(["revised", "submitted", "withdrawn", "expired"]),
  submitted: Object.freeze(["accepted", "rejected", "withdrawn", "expired"]),
  accepted: Object.freeze(["cancelled"]),
  rejected: Object.freeze([]),
  withdrawn: Object.freeze([]),
  cancelled: Object.freeze([]),
  expired: Object.freeze([]),
});

const STATUS_SET = new Set(STAFF_ASSIGNMENT_REQUEST_STATUSES);
const TIME_KIND_SET = new Set(STAFF_ASSIGNMENT_REQUEST_TIME_KINDS);
const ACTION_SET = new Set(STAFF_ASSIGNMENT_REQUEST_ACTIONS);
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

class StaffAssignmentRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StaffAssignmentRequestError";
    this.code = code;
  }
}

function invalid(code, message) {
  throw new StaffAssignmentRequestError(code, message);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("STAFF_ASSIGNMENT_REQUEST_INVALID", `${label} ist ungültig.`);
  }
  return value;
}

function text(value, { label, minimum = 0, maximum = 2000 } = {}) {
  if (typeof value !== "string") {
    invalid("STAFF_ASSIGNMENT_REQUEST_INVALID", `${label} muss als Text übermittelt werden.`);
  }
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length < minimum || normalized.length > maximum || normalized.includes("\0")) {
    invalid(
      "STAFF_ASSIGNMENT_REQUEST_INVALID",
      `${label} muss zwischen ${minimum} und ${maximum} Zeichen lang sein.`,
    );
  }
  return normalized;
}

function identifier(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  return text(String(value ?? ""), { label, minimum: 1, maximum: 120 });
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    invalid("STAFF_ASSIGNMENT_REQUEST_INVALID", `${label} ist ungültig.`);
  }
  return normalized;
}

function calendarDate(value, label) {
  const normalized = String(value ?? "").trim();
  const match = DATE_PATTERN.exec(normalized);
  if (!match) invalid("STAFF_ASSIGNMENT_REQUEST_PERIOD_INVALID", `${label} ist ungültig.`);
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) {
    invalid("STAFF_ASSIGNMENT_REQUEST_PERIOD_INVALID", `${label} ist ungültig.`);
  }
  return normalized;
}

function timeOfDay(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  const normalized = String(value ?? "").trim();
  if (!TIME_PATTERN.test(normalized)) {
    invalid("STAFF_ASSIGNMENT_REQUEST_PERIOD_INVALID", `${label} ist ungültig.`);
  }
  return normalized;
}

function status(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!STATUS_SET.has(normalized)) {
    invalid("STAFF_ASSIGNMENT_REQUEST_STATUS_INVALID", "Der Anfragestatus ist ungültig.");
  }
  return normalized;
}

function action(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!ACTION_SET.has(normalized)) {
    invalid("STAFF_ASSIGNMENT_REQUEST_TRANSITION_INVALID", "Die Statusänderung ist ungültig.");
  }
  return normalized;
}

function normalizedTimeKind(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!TIME_KIND_SET.has(normalized)) {
    invalid("STAFF_ASSIGNMENT_REQUEST_PERIOD_INVALID", "Die Zeitart ist ungültig.");
  }
  return normalized;
}

function normalizeStaffAssignmentRequestInput(value, {
  requestStatus = "draft",
  requireReason = requestStatus !== "draft",
} = {}) {
  const input = record(value, "Die Anfrage");
  const normalizedStatus = status(requestStatus);
  const sourceLocationId = identifier(input.sourceLocationId, "Die Quellfiliale");
  const destinationLocationId = identifier(input.destinationLocationId, "Die Zielfiliale");
  if (sourceLocationId === destinationLocationId) {
    invalid(
      "STAFF_ASSIGNMENT_REQUEST_SCOPE_INVALID",
      "Quell- und Zielfiliale müssen unterschiedlich sein.",
    );
  }
  const timeKind = normalizedTimeKind(input.timeKind);
  const periodStartDate = calendarDate(input.periodStartDate, "Das Startdatum");
  const periodEndDate = calendarDate(input.periodEndDate, "Das Enddatum");
  if (periodEndDate < periodStartDate) {
    invalid("STAFF_ASSIGNMENT_REQUEST_PERIOD_INVALID", "Der Zeitraum ist ungültig.");
  }
  let startTime = null;
  let endTime = null;
  if (timeKind === "hourly") {
    if (periodStartDate !== periodEndDate) {
      invalid(
        "STAFF_ASSIGNMENT_REQUEST_PERIOD_INVALID",
        "Eine stundenweise Anfrage muss innerhalb eines Tages liegen.",
      );
    }
    startTime = timeOfDay(input.startTime, "Die Startzeit");
    endTime = timeOfDay(input.endTime, "Die Endzeit");
    if (endTime <= startTime) {
      invalid("STAFF_ASSIGNMENT_REQUEST_PERIOD_INVALID", "Die Uhrzeitspanne ist ungültig.");
    }
    if (Number(startTime.slice(3)) % 15 !== 0 || Number(endTime.slice(3)) % 15 !== 0) {
      invalid(
        "STAFF_ASSIGNMENT_REQUEST_PERIOD_INVALID",
        "Start- und Endzeit müssen im 15-Minuten-Raster liegen.",
      );
    }
  } else {
    startTime = timeOfDay(input.startTime, "Die Startzeit", { nullable: true });
    endTime = timeOfDay(input.endTime, "Die Endzeit", { nullable: true });
    if (startTime !== null || endTime !== null
      || (timeKind === "full_day" && periodStartDate !== periodEndDate)
      || (timeKind === "multi_day" && periodStartDate >= periodEndDate)) {
      invalid("STAFF_ASSIGNMENT_REQUEST_PERIOD_INVALID", "Der Tageszeitraum ist ungültig.");
    }
  }
  const confirmedEmployeeNumber = identifier(
    input.confirmedEmployeeNumber,
    "Das bestätigte Teammitglied",
    { nullable: true },
  );
  if (["accepted", "cancelled"].includes(normalizedStatus) !== Boolean(confirmedEmployeeNumber)) {
    invalid(
      "STAFF_ASSIGNMENT_REQUEST_CONFIRMED_EMPLOYEE_INVALID",
      "Ein bestätigtes Teammitglied ist nur bei angenommenen oder stornierten Anfragen zulässig und dann erforderlich.",
    );
  }
  return Object.freeze({
    sourceLocationId,
    destinationLocationId,
    destinationDepartmentId: positiveInteger(
      input.destinationDepartmentId,
      "Die Zielabteilung",
    ),
    periodStartDate,
    periodEndDate,
    timeKind,
    startTime,
    endTime,
    preferredEmployeeNumber: identifier(
      input.preferredEmployeeNumber,
      "Das bevorzugte Teammitglied",
      { nullable: true },
    ),
    confirmedEmployeeNumber,
    requestReason: text(String(input.requestReason ?? ""), {
      label: "Die Begründung",
      minimum: requireReason ? 1 : 0,
      maximum: 2000,
    }),
    decisionReason: text(String(input.decisionReason ?? ""), {
      label: "Die Entscheidungsbegründung",
      minimum: normalizedStatus === "rejected" ? 1 : 0,
      maximum: 2000,
    }),
  });
}

function requestReceiptBody(row) {
  return Object.freeze({
    schemaVersion: 1,
    id: identifier(row.id, "Die Anfrage-ID"),
    createdByEmployeeNumber: identifier(
      row.createdByEmployeeNumber ?? row.created_by_employee_number,
      "Der Ersteller",
    ),
    createdAt: identifier(row.createdAt ?? row.created_at, "Der Erstellzeitpunkt"),
  });
}

function requestReceiptSha256(row) {
  return canonicalSha256(requestReceiptBody(row));
}

function revisionReceiptBody(row) {
  const revisionStatus = status(row.status);
  const normalized = normalizeStaffAssignmentRequestInput({
    sourceLocationId: row.sourceLocationId ?? row.source_location_id,
    destinationLocationId: row.destinationLocationId ?? row.destination_location_id,
    destinationDepartmentId: row.destinationDepartmentId ?? row.destination_department_id,
    periodStartDate: row.periodStartDate ?? row.period_start_date,
    periodEndDate: row.periodEndDate ?? row.period_end_date,
    timeKind: row.timeKind ?? row.time_kind,
    startTime: row.startTime ?? row.start_time,
    endTime: row.endTime ?? row.end_time,
    preferredEmployeeNumber: row.preferredEmployeeNumber ?? row.preferred_employee_number,
    confirmedEmployeeNumber: row.confirmedEmployeeNumber ?? row.confirmed_employee_number,
    requestReason: row.requestReason ?? row.request_reason,
    decisionReason: row.decisionReason ?? row.decision_reason,
  }, { requestStatus: revisionStatus });
  return Object.freeze({
    schemaVersion: 1,
    requestId: identifier(row.requestId ?? row.request_id, "Die Anfrage-ID"),
    revisionNumber: positiveInteger(
      row.revisionNumber ?? row.revision_number,
      "Die Revision",
    ),
    status: revisionStatus,
    ...normalized,
    previousReceiptSha256: String(
      row.previousReceiptSha256 ?? row.previous_receipt_sha256 ?? "",
    ),
    changedByEmployeeNumber: identifier(
      row.changedByEmployeeNumber ?? row.changed_by_employee_number,
      "Der Bearbeiter",
    ),
    changedAt: identifier(row.changedAt ?? row.changed_at, "Der Änderungszeitpunkt"),
  });
}

function revisionReceiptSha256(row) {
  return canonicalSha256(revisionReceiptBody(row));
}

function eventPayloadFor({ action: actionValue, fromStatus, toStatus, revisionNumber, revisionReceipt }) {
  const normalizedAction = action(actionValue);
  return Object.freeze({
    schemaVersion: 1,
    action: normalizedAction,
    fromStatus: fromStatus === null ? null : status(fromStatus),
    toStatus: status(toStatus),
    revisionNumber: positiveInteger(revisionNumber, "Die Revision"),
    revisionReceiptSha256: identifier(revisionReceipt, "Der Revisionsnachweis"),
  });
}

function eventReceiptBody(row) {
  const payload = record(row.eventPayload ?? row.event_payload, "Der Ereignisnachweis");
  const rawFromStatus = Object.hasOwn(row, "fromStatus")
    ? row.fromStatus : row.from_status;
  return Object.freeze({
    schemaVersion: 1,
    id: identifier(row.id, "Die Ereignis-ID"),
    requestId: identifier(row.requestId ?? row.request_id, "Die Anfrage-ID"),
    sequenceNumber: positiveInteger(
      row.sequenceNumber ?? row.sequence_number,
      "Die Ereignisnummer",
    ),
    requestRevisionNumber: positiveInteger(
      row.requestRevisionNumber ?? row.request_revision_number,
      "Die Ereignisrevision",
    ),
    eventType: action(row.eventType ?? row.event_type),
    fromStatus: rawFromStatus === null ? null : status(rawFromStatus),
    toStatus: status(row.toStatus ?? row.to_status),
    eventPayloadSha256: canonicalSha256(payload),
    previousReceiptSha256: String(
      row.previousReceiptSha256 ?? row.previous_receipt_sha256 ?? "",
    ),
    actorEmployeeNumber: identifier(
      row.actorEmployeeNumber ?? row.actor_employee_number,
      "Der Ereignisakteur",
    ),
    occurredAt: identifier(row.occurredAt ?? row.occurred_at, "Der Ereigniszeitpunkt"),
  });
}

function eventReceiptSha256(row) {
  return canonicalSha256(eventReceiptBody(row));
}

function assertTransition(fromStatusValue, actionValue) {
  const fromStatus = status(fromStatusValue);
  const normalizedAction = action(actionValue);
  if (!(ALLOWED_TRANSITIONS[fromStatus] || []).includes(normalizedAction)) {
    invalid(
      "STAFF_ASSIGNMENT_REQUEST_TRANSITION_INVALID",
      `Die Statusänderung ${normalizedAction} ist aus ${fromStatus} nicht zulässig.`,
    );
  }
  return Object.freeze({
    action: normalizedAction,
    fromStatus,
    toStatus: ACTION_STATUS[normalizedAction],
  });
}

function revisionInputFromCurrent(current, changes, nextStatus) {
  return normalizeStaffAssignmentRequestInput({
    sourceLocationId: changes.sourceLocationId ?? current.sourceLocationId,
    destinationLocationId: changes.destinationLocationId ?? current.destinationLocationId,
    destinationDepartmentId:
      changes.destinationDepartmentId ?? current.destinationDepartmentId,
    periodStartDate: changes.periodStartDate ?? current.periodStartDate,
    periodEndDate: changes.periodEndDate ?? current.periodEndDate,
    timeKind: changes.timeKind ?? current.timeKind,
    startTime: Object.hasOwn(changes, "startTime") ? changes.startTime : current.startTime,
    endTime: Object.hasOwn(changes, "endTime") ? changes.endTime : current.endTime,
    preferredEmployeeNumber: Object.hasOwn(changes, "preferredEmployeeNumber")
      ? changes.preferredEmployeeNumber : current.preferredEmployeeNumber,
    confirmedEmployeeNumber: Object.hasOwn(changes, "confirmedEmployeeNumber")
      ? changes.confirmedEmployeeNumber : current.confirmedEmployeeNumber,
    requestReason: Object.hasOwn(changes, "requestReason")
      ? changes.requestReason : current.requestReason,
    decisionReason: Object.hasOwn(changes, "decisionReason")
      ? changes.decisionReason : current.decisionReason,
  }, { requestStatus: nextStatus });
}

async function insertInitialStaffAssignmentRequestHistory(repository, input, actorEmployeeNumber, {
  submit = false,
  idFactory = randomUUID,
  now = () => new Date().toISOString(),
} = {}) {
  if (!repository || typeof repository.insertRequest !== "function"
    || typeof repository.insertRevision !== "function"
    || typeof repository.insertEvent !== "function") {
    throw new TypeError("Ein schreibbares Repository für Einsatzanfragen wird benötigt.");
  }
  if (typeof idFactory !== "function" || typeof now !== "function") {
    throw new TypeError("ID- und Zeitquelle müssen Funktionen sein.");
  }
  const actor = identifier(actorEmployeeNumber, "Der Ersteller");
  const normalized = normalizeStaffAssignmentRequestInput(input, {
    requestStatus: submit ? "submitted" : "draft",
    requireReason: submit,
  });
  const requestId = identifier(idFactory(), "Die Anfrage-ID");
  const createdAt = identifier(now(), "Der Erstellzeitpunkt");
  const requestRow = {
    id: requestId,
    createdByEmployeeNumber: actor,
    createdAt,
  };
  requestRow.receiptSha256 = requestReceiptSha256(requestRow);

  const draftRevision = {
    requestId,
    revisionNumber: 1,
    status: "draft",
    ...normalizeStaffAssignmentRequestInput(normalized, {
      requestStatus: "draft",
      requireReason: false,
    }),
    previousReceiptSha256: "",
    changedByEmployeeNumber: actor,
    changedAt: createdAt,
  };
  draftRevision.receiptSha256 = revisionReceiptSha256(draftRevision);
  const createdPayload = eventPayloadFor({
    action: "created",
    fromStatus: null,
    toStatus: "draft",
    revisionNumber: 1,
    revisionReceipt: draftRevision.receiptSha256,
  });
  const createdEvent = {
    id: identifier(idFactory(), "Die Ereignis-ID"),
    requestId,
    sequenceNumber: 1,
    requestRevisionNumber: 1,
    eventType: "created",
    fromStatus: null,
    toStatus: "draft",
    eventPayload: createdPayload,
    eventPayloadSha256: canonicalSha256(createdPayload),
    previousReceiptSha256: "",
    actorEmployeeNumber: actor,
    occurredAt: createdAt,
  };
  createdEvent.receiptSha256 = eventReceiptSha256(createdEvent);

  await repository.insertRequest(requestRow);
  await repository.insertRevision(draftRevision);
  await repository.insertEvent(createdEvent);

  if (submit) {
    const submittedAt = identifier(now(), "Der Einreichzeitpunkt");
    const submittedRevision = {
      ...draftRevision,
      revisionNumber: 2,
      status: "submitted",
      previousReceiptSha256: draftRevision.receiptSha256,
      changedAt: submittedAt,
    };
    submittedRevision.receiptSha256 = revisionReceiptSha256(submittedRevision);
    const submittedPayload = eventPayloadFor({
      action: "submitted",
      fromStatus: "draft",
      toStatus: "submitted",
      revisionNumber: 2,
      revisionReceipt: submittedRevision.receiptSha256,
    });
    const submittedEvent = {
      id: identifier(idFactory(), "Die Ereignis-ID"),
      requestId,
      sequenceNumber: 2,
      requestRevisionNumber: 2,
      eventType: "submitted",
      fromStatus: "draft",
      toStatus: "submitted",
      eventPayload: submittedPayload,
      eventPayloadSha256: canonicalSha256(submittedPayload),
      previousReceiptSha256: createdEvent.receiptSha256,
      actorEmployeeNumber: actor,
      occurredAt: submittedAt,
    };
    submittedEvent.receiptSha256 = eventReceiptSha256(submittedEvent);
    await repository.insertRevision(submittedRevision);
    await repository.insertEvent(submittedEvent);
  }

  const [request, revisions, events] = await Promise.all([
    repository.getRequest(requestId),
    repository.listRevisions(requestId),
    repository.listEvents(requestId),
  ]);
  return Object.freeze({
    request,
    current: revisions.at(-1) || null,
    revisions: Object.freeze(revisions),
    events: Object.freeze(events),
  });
}

async function staffAssignmentRequestHistory(repository, requestId) {
  const normalizedId = identifier(requestId, "Die Anfrage-ID");
  const requestRow = await repository.getRequest(normalizedId);
  if (!requestRow) return null;
  const revisions = await repository.listRevisions(normalizedId);
  const events = await repository.listEvents(normalizedId);
  return Object.freeze({
    request: requestRow,
    current: revisions.at(-1) || null,
    revisions: Object.freeze(revisions),
    events: Object.freeze(events),
  });
}

async function transitionStaffAssignmentRequestHistory(
  repository,
  requestId,
  actionValue,
  changes,
  actorEmployeeNumber,
  {
    expectedRevision,
    idFactory = randomUUID,
    now = () => new Date().toISOString(),
  } = {},
) {
  if (!repository || typeof repository.getLatestRevision !== "function"
    || typeof repository.getLatestEvent !== "function"
    || typeof repository.insertRevision !== "function"
    || typeof repository.insertEvent !== "function") {
    throw new TypeError("Ein schreibbares Repository für Einsatzanfragen wird benötigt.");
  }
  if (typeof idFactory !== "function" || typeof now !== "function") {
    throw new TypeError("ID- und Zeitquelle müssen Funktionen sein.");
  }
  const normalizedId = identifier(requestId, "Die Anfrage-ID");
  const actor = identifier(actorEmployeeNumber, "Der Bearbeiter");
  const patch = changes === undefined ? {} : record(changes, "Die Änderungen");
  const current = await repository.getLatestRevision(normalizedId);
  const latestEvent = await repository.getLatestEvent(normalizedId);
  if (!current || !latestEvent) {
    invalid("STAFF_ASSIGNMENT_REQUEST_NOT_FOUND", "Die Einsatzanfrage wurde nicht gefunden.");
  }
  const currentRevision = positiveInteger(current.revisionNumber, "Die aktuelle Revision");
  if (expectedRevision !== undefined
    && positiveInteger(expectedRevision, "Die erwartete Revision") !== currentRevision) {
    invalid(
      "STAFF_ASSIGNMENT_REQUEST_REVISION_CONFLICT",
      "Die Einsatzanfrage wurde zwischenzeitlich geändert.",
    );
  }
  const transitionState = assertTransition(current.status, actionValue);
  if (transitionState.action !== "revised") {
    const mutableKeys = Object.keys(patch).filter((key) => ![
      "confirmedEmployeeNumber",
      "decisionReason",
    ].includes(key));
    if (mutableKeys.length) {
      invalid(
        "STAFF_ASSIGNMENT_REQUEST_TRANSITION_INVALID",
        "Fachdaten dürfen nur im Entwurf geändert werden.",
      );
    }
  }
  const normalized = revisionInputFromCurrent(current, patch, transitionState.toStatus);
  const revisionNumber = currentRevision + 1;
  const changedAt = identifier(now(), "Der Änderungszeitpunkt");
  const revision = {
    requestId: normalizedId,
    revisionNumber,
    status: transitionState.toStatus,
    ...normalized,
    previousReceiptSha256: identifier(
      current.receiptSha256,
      "Der vorherige Revisionsnachweis",
    ),
    changedByEmployeeNumber: actor,
    changedAt,
  };
  revision.receiptSha256 = revisionReceiptSha256(revision);
  const eventPayload = eventPayloadFor({
    action: transitionState.action,
    fromStatus: transitionState.fromStatus,
    toStatus: transitionState.toStatus,
    revisionNumber,
    revisionReceipt: revision.receiptSha256,
  });
  const event = {
    id: identifier(idFactory(), "Die Ereignis-ID"),
    requestId: normalizedId,
    sequenceNumber: revisionNumber,
    requestRevisionNumber: revisionNumber,
    eventType: transitionState.action,
    fromStatus: transitionState.fromStatus,
    toStatus: transitionState.toStatus,
    eventPayload,
    eventPayloadSha256: canonicalSha256(eventPayload),
    previousReceiptSha256: identifier(
      latestEvent.receiptSha256,
      "Der vorherige Ereignisnachweis",
    ),
    actorEmployeeNumber: actor,
    occurredAt: changedAt,
  };
  event.receiptSha256 = eventReceiptSha256(event);
  await repository.insertRevision(revision);
  await repository.insertEvent(event);
  return staffAssignmentRequestHistory(repository, normalizedId);
}

function createStaffAssignmentRequestLifecycleService(repository, {
  idFactory = randomUUID,
  now = () => new Date().toISOString(),
} = {}) {
  if (!repository || typeof repository.transaction !== "function") {
    throw new TypeError("Ein transaktionales Repository für Einsatzanfragen wird benötigt.");
  }
  if (typeof idFactory !== "function" || typeof now !== "function") {
    throw new TypeError("ID- und Zeitquelle müssen Funktionen sein.");
  }

  async function history(requestId, scopedRepository = repository) {
    return staffAssignmentRequestHistory(scopedRepository, requestId);
  }

  async function createDraft(input, actorEmployeeNumber) {
    return repository.transaction((tx) => insertInitialStaffAssignmentRequestHistory(
      tx,
      input,
      actorEmployeeNumber,
      { idFactory, now },
    ), { isolation: "serializable" });
  }

  async function createSubmitted(input, actorEmployeeNumber) {
    return repository.transaction((tx) => insertInitialStaffAssignmentRequestHistory(
      tx,
      input,
      actorEmployeeNumber,
      { submit: true, idFactory, now },
    ), { isolation: "serializable" });
  }

  async function transition(requestId, actionValue, changes, actorEmployeeNumber, {
    expectedRevision,
  } = {}) {
    return repository.transaction((tx) => transitionStaffAssignmentRequestHistory(
      tx,
      requestId,
      actionValue,
      changes,
      actorEmployeeNumber,
      { expectedRevision, idFactory, now },
    ), { isolation: "serializable" });
  }

  return Object.freeze({
    createDraft,
    createSubmitted,
    getHistory: history,
    reviseDraft: (id, changes, actor, options) => transition(
      id, "revised", changes, actor, options,
    ),
    submit: (id, actor, options) => transition(id, "submitted", {}, actor, options),
    accept: (id, changes, actor, options) => transition(
      id, "accepted", changes, actor, options,
    ),
    reject: (id, changes, actor, options) => transition(
      id, "rejected", changes, actor, options,
    ),
    withdraw: (id, changes, actor, options) => transition(
      id, "withdrawn", changes, actor, options,
    ),
    cancel: (id, changes, actor, options) => transition(
      id, "cancelled", changes, actor, options,
    ),
    expire: (id, changes, actor, options) => transition(
      id, "expired", changes, actor, options,
    ),
  });
}

module.exports = {
  ALLOWED_TRANSITIONS,
  STAFF_ASSIGNMENT_REQUEST_ACTIONS,
  STAFF_ASSIGNMENT_REQUEST_STATUSES,
  STAFF_ASSIGNMENT_REQUEST_TIME_KINDS,
  StaffAssignmentRequestError,
  assertStaffAssignmentRequestTransition: assertTransition,
  createStaffAssignmentRequestLifecycleService,
  insertInitialStaffAssignmentRequestHistory,
  staffAssignmentRequestHistory,
  transitionStaffAssignmentRequestHistory,
  eventPayloadForStaffAssignmentRequest: eventPayloadFor,
  staffAssignmentRequestEventReceiptBody: eventReceiptBody,
  staffAssignmentRequestEventReceiptSha256: eventReceiptSha256,
  staffAssignmentRequestReceiptBody: requestReceiptBody,
  staffAssignmentRequestReceiptSha256: requestReceiptSha256,
  staffAssignmentRequestRevisionReceiptBody: revisionReceiptBody,
  staffAssignmentRequestRevisionReceiptSha256: revisionReceiptSha256,
  normalizeStaffAssignmentRequestInput,
};
