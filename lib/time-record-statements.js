"use strict";

const { canonicalSha256 } = require("./work-rules/receipt");

const TIME_RECORD_GOVERNANCE_VERSION = "at-time-record-statements-2026.1";
const TIME_RECORD_SCHEMA_VERSION = 1;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const ACTUAL_EVENT_TYPES = Object.freeze(["clock_in", "break_start", "break_end", "clock_out"]);
const ACTUAL_EVENT_SOURCES = Object.freeze([
  "employee",
  "manager",
  "time_terminal",
  "imported_actual",
  "system_actual",
]);
const REVIEW_DECISIONS = Object.freeze(["approved", "needs_correction"]);

const OFFICIAL_TIME_RECORD_SOURCES = deepFreeze([
  {
    id: "at-azg-26",
    authority: "Republik Oesterreich",
    title: "Arbeitszeitgesetz (AZG) - Paragraph 26",
    url: "https://ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=26",
    jurisdiction: "AT",
    reference: "Aufzeichnungspflicht und monatliche kostenlose Uebermittlung auf nachweisliches Verlangen",
    checkedAt: "2026-07-23",
  },
  {
    id: "at-arbeitsinspektion-arbeitszeitaufzeichnung",
    authority: "Arbeitsinspektion Oesterreich",
    title: "Aushang und Aufzeichnung der Arbeitszeit",
    url: "https://www.arbeitsinspektion.gv.at/Arbeitszeit-_Arbeitsruhe/Arbeitszeit_/Aushang_und_Aufzeichnung_der_Arbeitszeit.html",
    jurisdiction: "AT",
    reference: "Tatsaechliche Arbeitszeit, Beginn, Ende, Pausen und betriebliche Einsicht",
    checkedAt: "2026-07-23",
  },
  {
    id: "at-usp-arbeitszeitaufzeichnungen",
    authority: "Unternehmensserviceportal der Republik Oesterreich",
    title: "Arbeitszeitaufzeichnungen",
    url: "https://www.usp.gv.at/themen/mitarbeiter-und-gesundheit/urlaub-und-arbeitszeit/weitere-informationen-zu-urlaub-und-arbeitszeit/arbeitszeitaufzeichnungen.html",
    jurisdiction: "AT",
    reference: "Mindestaufbewahrung von einem Jahr; mögliche längere Fristen aus anderen Vorschriften",
    checkedAt: "2026-07-23",
  },
]);

class TimeRecordStatementError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = "TimeRecordStatementError";
    this.code = code;
  }
}

function timeError(message, code) {
  return new TimeRecordStatementError(message, code);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label, code = "TIME_RECORD_OBJECT_INVALID") {
  if (!isPlainObject(value)) throw timeError(`${label} must be a plain object.`, code);
  return value;
}

function assertExactKeys(value, allowed, label, code = "TIME_RECORD_FIELDS_INVALID") {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw timeError(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}.`, code);
  }
}

function requiredString(value, label, { maximum = 500, identifier = false } = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum || (identifier && !IDENTIFIER_PATTERN.test(normalized))) {
    throw timeError(`${label} is invalid.`, "TIME_RECORD_STRING_INVALID");
  }
  return normalized;
}

function optionalString(value, label, { maximum = 1000 } = {}) {
  if (value === undefined || value === null || value === "") return "";
  return requiredString(value, label, { maximum });
}

function isoDate(value, label) {
  const normalized = String(value || "").trim();
  const match = DATE_PATTERN.exec(normalized);
  if (!match) throw timeError(`${label} must use YYYY-MM-DD.`, "TIME_RECORD_DATE_INVALID");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw timeError(`${label} is not a valid calendar date.`, "TIME_RECORD_DATE_INVALID");
  }
  return normalized;
}

function yearMonth(value, label) {
  const normalized = String(value || "").trim();
  const match = MONTH_PATTERN.exec(normalized);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
    throw timeError(`${label} must use YYYY-MM.`, "TIME_RECORD_MONTH_INVALID");
  }
  return normalized;
}

function isoInstant(value, label) {
  const normalized = String(value || "").trim();
  if (!INSTANT_PATTERN.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw timeError(`${label} must be an ISO 8601 timestamp with a timezone.`, "TIME_RECORD_INSTANT_INVALID");
  }
  return normalized;
}

function enumValue(value, allowed, label) {
  const normalized = String(value || "").trim();
  if (!allowed.includes(normalized)) {
    throw timeError(`${label} is unsupported.`, "TIME_RECORD_ENUM_INVALID");
  }
  return normalized;
}

function officialSourceMetadata() {
  return OFFICIAL_TIME_RECORD_SOURCES.map((source) => ({ ...source }));
}

function minutesBetween(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 60_000);
}

function eventHash(body) {
  return canonicalSha256({
    schemaVersion: TIME_RECORD_SCHEMA_VERSION,
    governanceVersion: TIME_RECORD_GOVERNANCE_VERSION,
    kind: "actual_time_event",
    event: body,
  });
}

function ledgerBody(ledger) {
  const body = { ...ledger };
  delete body.receiptSha256;
  return body;
}

function ledgerHash(ledger) {
  return canonicalSha256({
    schemaVersion: TIME_RECORD_SCHEMA_VERSION,
    governanceVersion: TIME_RECORD_GOVERNANCE_VERSION,
    kind: "actual_time_ledger",
    ledger: ledgerBody(ledger),
  });
}

function createActualTimeLedger(input) {
  const value = assertPlainObject(input, "Actual-time ledger");
  assertExactKeys(value, new Set(["ledgerId", "employeeId", "createdAt"]), "Actual-time ledger");
  const ledger = {
    schemaVersion: TIME_RECORD_SCHEMA_VERSION,
    governanceVersion: TIME_RECORD_GOVERNANCE_VERSION,
    ledgerId: requiredString(value.ledgerId, "Ledger ID", { identifier: true }),
    employeeId: requiredString(value.employeeId, "Employee ID", { identifier: true }),
    revision: 1,
    createdAt: isoInstant(value.createdAt, "Ledger creation time"),
    previousReceiptSha256: null,
    events: [],
    sources: officialSourceMetadata(),
  };
  return { ...ledger, receiptSha256: ledgerHash(ledger) };
}

function normalizeActualEventInput(input, employeeId, sequence, previousEventSha256) {
  const value = assertPlainObject(input, "Actual time event");
  assertExactKeys(
    value,
    new Set(["eventId", "type", "workDate", "occurredAt", "recordedAt", "source", "actorId", "note"]),
    "Actual time event",
  );
  const body = {
    eventId: requiredString(value.eventId, "Event ID", { identifier: true }),
    sequence,
    employeeId,
    recordKind: "actual",
    type: enumValue(value.type, ACTUAL_EVENT_TYPES, "Actual event type"),
    workDate: isoDate(value.workDate, "Work date"),
    occurredAt: isoInstant(value.occurredAt, "Event time"),
    recordedAt: isoInstant(value.recordedAt, "Recording time"),
    source: enumValue(value.source, ACTUAL_EVENT_SOURCES, "Actual event source"),
    actorId: requiredString(value.actorId, "Actor ID", { identifier: true }),
    note: optionalString(value.note, "Event note"),
    supersedesEventId: "",
    replacement: null,
    reason: "",
    previousEventSha256,
  };
  return { ...body, eventSha256: eventHash(body) };
}

function normalizeCorrectionInput(input, ledger, sequence, previousEventSha256) {
  const value = assertPlainObject(input, "Actual-time correction");
  assertExactKeys(
    value,
    new Set(["correctionId", "targetEventId", "replacement", "recordedAt", "actorId", "reason"]),
    "Actual-time correction",
  );
  const replacement = assertPlainObject(value.replacement, "Correction replacement");
  assertExactKeys(
    replacement,
    new Set(["type", "workDate", "occurredAt", "source", "note"]),
    "Correction replacement",
  );
  const body = {
    eventId: requiredString(value.correctionId, "Correction ID", { identifier: true }),
    sequence,
    employeeId: ledger.employeeId,
    recordKind: "correction",
    type: "correction",
    workDate: isoDate(replacement.workDate, "Replacement work date"),
    occurredAt: isoInstant(replacement.occurredAt, "Replacement event time"),
    recordedAt: isoInstant(value.recordedAt, "Correction recording time"),
    source: "correction",
    actorId: requiredString(value.actorId, "Actor ID", { identifier: true }),
    note: "",
    supersedesEventId: requiredString(value.targetEventId, "Correction target", { identifier: true }),
    replacement: {
      type: enumValue(replacement.type, ACTUAL_EVENT_TYPES, "Replacement event type"),
      workDate: isoDate(replacement.workDate, "Replacement work date"),
      occurredAt: isoInstant(replacement.occurredAt, "Replacement event time"),
      source: enumValue(replacement.source, ACTUAL_EVENT_SOURCES, "Replacement source"),
      note: optionalString(replacement.note, "Replacement note"),
    },
    reason: requiredString(value.reason, "Correction reason", { maximum: 1000 }),
    previousEventSha256,
  };
  return { ...body, eventSha256: eventHash(body) };
}

function normalizeStoredLedger(input) {
  const value = assertPlainObject(input, "Stored actual-time ledger");
  assertExactKeys(
    value,
    new Set([
      "schemaVersion", "governanceVersion", "ledgerId", "employeeId", "revision", "createdAt",
      "previousReceiptSha256", "events", "sources", "receiptSha256",
    ]),
    "Stored actual-time ledger",
  );
  if (value.schemaVersion !== TIME_RECORD_SCHEMA_VERSION || value.governanceVersion !== TIME_RECORD_GOVERNANCE_VERSION) {
    throw timeError("The actual-time ledger version is unsupported.", "TIME_RECORD_LEDGER_VERSION_INVALID");
  }
  if (!Array.isArray(value.events) || !Array.isArray(value.sources)) {
    throw timeError("Stored events and sources must be arrays.", "TIME_RECORD_LEDGER_INVALID");
  }
  return value;
}

function verifyActualTimeLedger(input) {
  try {
    const ledger = normalizeStoredLedger(input);
    if (!SHA256_PATTERN.test(String(ledger.receiptSha256 || "")) || ledger.receiptSha256 !== ledgerHash(ledger)) return false;
    if (ledger.revision !== ledger.events.length + 1) return false;
    let previous = null;
    const ids = new Set();
    for (let index = 0; index < ledger.events.length; index += 1) {
      const event = ledger.events[index];
      if (!isPlainObject(event) || ids.has(event.eventId)) return false;
      if (event.sequence !== index + 1 || event.employeeId !== ledger.employeeId || event.previousEventSha256 !== previous) return false;
      const body = { ...event };
      delete body.eventSha256;
      if (!SHA256_PATTERN.test(String(event.eventSha256 || "")) || event.eventSha256 !== eventHash(body)) return false;
      if (event.recordKind === "correction" && !ids.has(event.supersedesEventId)) return false;
      ids.add(event.eventId);
      previous = event.eventSha256;
    }
    effectiveActualEvents(ledger);
    return true;
  } catch {
    return false;
  }
}

function appendEvent(ledger, event) {
  const next = {
    ...ledgerBody(ledger),
    revision: ledger.revision + 1,
    previousReceiptSha256: ledger.receiptSha256,
    events: [...ledger.events.map((item) => ({ ...item })), event],
  };
  return { ...next, receiptSha256: ledgerHash(next) };
}

function appendActualTimeEvent(inputLedger, inputEvent) {
  const ledger = normalizeStoredLedger(inputLedger);
  if (!verifyActualTimeLedger(ledger)) throw timeError("The current actual-time ledger failed receipt verification.", "TIME_RECORD_LEDGER_TAMPERED");
  if (ledger.events.some(({ eventId }) => eventId === inputEvent?.eventId)) {
    throw timeError("Actual-time event IDs must be unique.", "TIME_RECORD_EVENT_DUPLICATE");
  }
  const event = normalizeActualEventInput(
    inputEvent,
    ledger.employeeId,
    ledger.events.length + 1,
    ledger.events.at(-1)?.eventSha256 || null,
  );
  return appendEvent(ledger, event);
}

function effectiveActualEvents(inputLedger) {
  const ledger = normalizeStoredLedger(inputLedger);
  const effective = new Map();
  const superseded = new Set();
  for (const event of ledger.events) {
    if (event.recordKind === "actual") {
      effective.set(event.eventId, {
        eventId: event.eventId,
        originalEventId: event.eventId,
        sequence: event.sequence,
        type: event.type,
        workDate: event.workDate,
        occurredAt: event.occurredAt,
        recordedAt: event.recordedAt,
        source: event.source,
        actorId: event.actorId,
        note: event.note,
        correctionChain: [],
      });
      continue;
    }
    if (event.recordKind !== "correction" || !effective.has(event.supersedesEventId) || superseded.has(event.supersedesEventId)) {
      throw timeError("A correction must supersede a currently effective actual event.", "TIME_RECORD_CORRECTION_TARGET_INVALID");
    }
    const previous = effective.get(event.supersedesEventId);
    effective.delete(event.supersedesEventId);
    superseded.add(event.supersedesEventId);
    effective.set(event.eventId, {
      eventId: event.eventId,
      originalEventId: previous.originalEventId,
      sequence: event.sequence,
      type: event.replacement.type,
      workDate: event.replacement.workDate,
      occurredAt: event.replacement.occurredAt,
      recordedAt: event.recordedAt,
      source: event.replacement.source,
      actorId: event.actorId,
      note: event.replacement.note,
      correctionChain: [...previous.correctionChain, event.eventId],
    });
  }
  return [...effective.values()].sort((left, right) => (
    left.occurredAt.localeCompare(right.occurredAt) || left.sequence - right.sequence
  ));
}

function appendActualTimeCorrection(inputLedger, inputCorrection) {
  const ledger = normalizeStoredLedger(inputLedger);
  if (!verifyActualTimeLedger(ledger)) throw timeError("The current actual-time ledger failed receipt verification.", "TIME_RECORD_LEDGER_TAMPERED");
  if (ledger.events.some(({ eventId }) => eventId === inputCorrection?.correctionId)) {
    throw timeError("Correction IDs must be unique.", "TIME_RECORD_EVENT_DUPLICATE");
  }
  const currentEffectiveIds = new Set(effectiveActualEvents(ledger).map(({ eventId }) => eventId));
  if (!currentEffectiveIds.has(String(inputCorrection?.targetEventId || ""))) {
    throw timeError("A correction must target a currently effective actual event.", "TIME_RECORD_CORRECTION_TARGET_INVALID");
  }
  const event = normalizeCorrectionInput(
    inputCorrection,
    ledger,
    ledger.events.length + 1,
    ledger.events.at(-1)?.eventSha256 || null,
  );
  return appendEvent(ledger, event);
}

function dayStatement(workDate, events) {
  const sorted = [...events].sort((left, right) => (
    left.occurredAt.localeCompare(right.occurredAt) || left.sequence - right.sequence
  ));
  const issues = [];
  const sessions = [];
  const breaks = [];
  let state = "off";
  let sessionStart = null;
  let breakStart = null;
  let totalMinutes = 0;
  for (const event of sorted) {
    if (event.type === "clock_in") {
      if (state !== "off") {
        issues.push({ code: "unexpected_clock_in", eventId: event.eventId });
        continue;
      }
      sessionStart = event.occurredAt;
      state = "working";
      continue;
    }
    if (event.type === "break_start") {
      if (state !== "working") {
        issues.push({ code: "unexpected_break_start", eventId: event.eventId });
        continue;
      }
      breakStart = event.occurredAt;
      state = "break";
      continue;
    }
    if (event.type === "break_end") {
      if (state !== "break") {
        issues.push({ code: "unexpected_break_end", eventId: event.eventId });
        continue;
      }
      const durationMinutes = minutesBetween(breakStart, event.occurredAt);
      if (durationMinutes < 0) issues.push({ code: "negative_break", eventId: event.eventId });
      else breaks.push({ startAt: breakStart, endAt: event.occurredAt, durationMinutes });
      breakStart = null;
      state = "working";
      continue;
    }
    if (event.type === "clock_out") {
      if (state === "break") {
        const breakDurationMinutes = minutesBetween(breakStart, event.occurredAt);
        if (breakDurationMinutes < 0) issues.push({ code: "negative_break", eventId: event.eventId });
        else breaks.push({ startAt: breakStart, endAt: event.occurredAt, durationMinutes: breakDurationMinutes });
        breakStart = null;
      } else if (state !== "working") {
        issues.push({ code: "unexpected_clock_out", eventId: event.eventId });
        continue;
      }
      const durationMinutes = minutesBetween(sessionStart, event.occurredAt);
      if (durationMinutes < 0) issues.push({ code: "negative_session", eventId: event.eventId });
      else {
        sessions.push({ startAt: sessionStart, endAt: event.occurredAt, durationMinutes });
        totalMinutes += durationMinutes;
      }
      sessionStart = null;
      state = "off";
    }
  }
  if (state === "working") issues.push({ code: "missing_clock_out", eventId: sorted.at(-1)?.eventId || "" });
  if (state === "break") issues.push({ code: "open_break_and_missing_clock_out", eventId: sorted.at(-1)?.eventId || "" });
  const breakMinutes = breaks.reduce((sum, entry) => sum + entry.durationMinutes, 0);
  const actualMinutes = Math.max(0, totalMinutes - breakMinutes);
  return {
    workDate,
    beginningAt: sessions[0]?.startAt || sessionStart || "",
    endingAt: sessions.at(-1)?.endAt || "",
    sessions,
    breaks,
    breakMinutes,
    actualMinutes,
    eventIds: sorted.map(({ eventId }) => eventId),
    complete: issues.length === 0 && sessions.length > 0 && state === "off",
    issues,
  };
}

function statementBody(statement) {
  const body = { ...statement };
  delete body.receiptSha256;
  return body;
}

function statementHash(statement) {
  return canonicalSha256({
    schemaVersion: TIME_RECORD_SCHEMA_VERSION,
    governanceVersion: TIME_RECORD_GOVERNANCE_VERSION,
    kind: "monthly_actual_time_statement",
    statement: statementBody(statement),
  });
}

function buildMonthlyStatement({
  statementId,
  ledger,
  month,
  createdAt,
  revision = 1,
  previousReceiptSha256 = null,
  supersedesReceiptSha256 = null,
  supersedeReason = "",
}) {
  const effective = effectiveActualEvents(ledger).filter(({ workDate }) => workDate.startsWith(`${month}-`));
  const byDate = new Map();
  for (const event of effective) {
    if (!byDate.has(event.workDate)) byDate.set(event.workDate, []);
    byDate.get(event.workDate).push(event);
  }
  const days = [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, events]) => dayStatement(date, events));
  const issues = days.flatMap((day) => day.issues.map((issue) => ({ workDate: day.workDate, ...issue })));
  if (days.length === 0) issues.push({ workDate: "", code: "no_actual_events", eventId: "" });
  const body = {
    schemaVersion: TIME_RECORD_SCHEMA_VERSION,
    governanceVersion: TIME_RECORD_GOVERNANCE_VERSION,
    statementId,
    employeeId: ledger.employeeId,
    month,
    revision,
    status: "draft",
    completeness: issues.length ? "incomplete" : "complete",
    createdAt,
    previousReceiptSha256,
    supersedesReceiptSha256,
    supersedeReason,
    ledgerId: ledger.ledgerId,
    ledgerRevision: ledger.revision,
    ledgerReceiptSha256: ledger.receiptSha256,
    days,
    issues,
    totals: {
      actualMinutes: days.reduce((sum, day) => sum + day.actualMinutes, 0),
      breakMinutes: days.reduce((sum, day) => sum + day.breakMinutes, 0),
    },
    review: {
      decision: "pending",
      reviewedBy: "",
      reviewedAt: "",
      note: "",
    },
    finalization: {
      finalizedBy: "",
      finalizedAt: "",
    },
    sources: officialSourceMetadata(),
  };
  return { ...body, receiptSha256: statementHash(body) };
}

function createMonthlyTimeRecordStatement(input) {
  const value = assertPlainObject(input, "Monthly time-record statement");
  assertExactKeys(value, new Set(["statementId", "ledger", "month", "createdAt"]), "Monthly time-record statement");
  const ledger = normalizeStoredLedger(value.ledger);
  if (!verifyActualTimeLedger(ledger)) throw timeError("The actual-time ledger failed receipt verification.", "TIME_RECORD_LEDGER_TAMPERED");
  return buildMonthlyStatement({
    statementId: requiredString(value.statementId, "Statement ID", { identifier: true }),
    ledger,
    month: yearMonth(value.month, "Statement month"),
    createdAt: isoInstant(value.createdAt, "Statement creation time"),
  });
}

function normalizeStoredStatement(input) {
  const value = assertPlainObject(input, "Stored monthly time-record statement");
  assertExactKeys(
    value,
    new Set([
      "schemaVersion", "governanceVersion", "statementId", "employeeId", "month", "revision", "status",
      "completeness", "createdAt", "previousReceiptSha256", "supersedesReceiptSha256", "supersedeReason",
      "ledgerId", "ledgerRevision", "ledgerReceiptSha256", "days", "issues", "totals", "review",
      "finalization", "sources", "receiptSha256",
    ]),
    "Stored monthly time-record statement",
  );
  if (value.schemaVersion !== TIME_RECORD_SCHEMA_VERSION || value.governanceVersion !== TIME_RECORD_GOVERNANCE_VERSION) {
    throw timeError("The statement version is unsupported.", "TIME_RECORD_STATEMENT_VERSION_INVALID");
  }
  return value;
}

function verifyMonthlyTimeRecordStatement(input) {
  try {
    const statement = normalizeStoredStatement(input);
    return SHA256_PATTERN.test(String(statement.receiptSha256 || ""))
      && statement.receiptSha256 === statementHash(statement);
  } catch {
    return false;
  }
}

function revisedStatement(statement, changes) {
  const next = {
    ...statementBody(statement),
    ...changes,
    revision: statement.revision + 1,
    previousReceiptSha256: statement.receiptSha256,
  };
  return { ...next, receiptSha256: statementHash(next) };
}

function reviewMonthlyTimeRecordStatement(inputStatement, inputReview) {
  const statement = normalizeStoredStatement(inputStatement);
  if (!verifyMonthlyTimeRecordStatement(statement)) throw timeError("The monthly statement failed receipt verification.", "TIME_RECORD_STATEMENT_TAMPERED");
  if (statement.status === "finalized") throw timeError("A finalized statement cannot be reviewed again.", "TIME_RECORD_STATEMENT_FINALIZED");
  const review = assertPlainObject(inputReview, "Statement review");
  assertExactKeys(review, new Set(["decision", "reviewedBy", "reviewedAt", "note"]), "Statement review");
  const decision = enumValue(review.decision, REVIEW_DECISIONS, "Review decision");
  if (decision === "approved" && statement.completeness !== "complete") {
    throw timeError("An incomplete monthly statement cannot be approved.", "TIME_RECORD_STATEMENT_INCOMPLETE");
  }
  return revisedStatement(statement, {
    status: decision === "approved" ? "reviewed" : "needs_correction",
    review: {
      decision,
      reviewedBy: requiredString(review.reviewedBy, "Reviewer ID", { identifier: true }),
      reviewedAt: isoInstant(review.reviewedAt, "Review time"),
      note: optionalString(review.note, "Review note"),
    },
  });
}

function finalizeMonthlyTimeRecordStatement(inputStatement, inputFinalization) {
  const statement = normalizeStoredStatement(inputStatement);
  if (!verifyMonthlyTimeRecordStatement(statement)) throw timeError("The monthly statement failed receipt verification.", "TIME_RECORD_STATEMENT_TAMPERED");
  if (statement.completeness !== "complete" || statement.status !== "reviewed" || statement.review?.decision !== "approved") {
    throw timeError("Only a complete, approved statement can be finalized.", "TIME_RECORD_FINALIZATION_UNSAFE");
  }
  const finalization = assertPlainObject(inputFinalization, "Statement finalization");
  assertExactKeys(finalization, new Set(["finalizedBy", "finalizedAt"]), "Statement finalization");
  return revisedStatement(statement, {
    status: "finalized",
    finalization: {
      finalizedBy: requiredString(finalization.finalizedBy, "Finalizer ID", { identifier: true }),
      finalizedAt: isoInstant(finalization.finalizedAt, "Finalization time"),
    },
  });
}

function supersedeMonthlyTimeRecordStatement(inputStatement, input) {
  const statement = normalizeStoredStatement(inputStatement);
  if (!verifyMonthlyTimeRecordStatement(statement)) throw timeError("The monthly statement failed receipt verification.", "TIME_RECORD_STATEMENT_TAMPERED");
  const value = assertPlainObject(input, "Statement supersession");
  assertExactKeys(value, new Set(["ledger", "createdAt", "actorId", "reason"]), "Statement supersession");
  const ledger = normalizeStoredLedger(value.ledger);
  if (!verifyActualTimeLedger(ledger)) throw timeError("The replacement ledger failed receipt verification.", "TIME_RECORD_LEDGER_TAMPERED");
  if (ledger.employeeId !== statement.employeeId) {
    throw timeError("A replacement ledger must belong to the same employee.", "TIME_RECORD_EMPLOYEE_MISMATCH");
  }
  const actorId = requiredString(value.actorId, "Superseding actor", { identifier: true });
  const reason = requiredString(value.reason, "Supersession reason", { maximum: 1000 });
  return buildMonthlyStatement({
    statementId: statement.statementId,
    ledger,
    month: statement.month,
    createdAt: isoInstant(value.createdAt, "Supersession time"),
    revision: statement.revision + 1,
    previousReceiptSha256: statement.receiptSha256,
    supersedesReceiptSha256: statement.receiptSha256,
    supersedeReason: `${reason} [actor:${actorId}]`,
  });
}

module.exports = {
  ACTUAL_EVENT_SOURCES,
  ACTUAL_EVENT_TYPES,
  OFFICIAL_TIME_RECORD_SOURCES,
  TIME_RECORD_GOVERNANCE_VERSION,
  TIME_RECORD_SCHEMA_VERSION,
  TimeRecordStatementError,
  appendActualTimeCorrection,
  appendActualTimeEvent,
  createActualTimeLedger,
  createMonthlyTimeRecordStatement,
  effectiveActualEvents,
  finalizeMonthlyTimeRecordStatement,
  officialSourceMetadata,
  reviewMonthlyTimeRecordStatement,
  supersedeMonthlyTimeRecordStatement,
  verifyActualTimeLedger,
  verifyMonthlyTimeRecordStatement,
};
