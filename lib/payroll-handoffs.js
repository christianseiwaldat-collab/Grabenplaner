"use strict";

const crypto = require("node:crypto");

const PAYROLL_HANDOFF_SCHEMA_VERSION = "grabenplaner.payroll-period.v2";
const PAYROLL_HANDOFF_GOVERNANCE_VERSION = "at-payroll-handoff-2026.1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const HANDOFF_EVENT_TYPES = Object.freeze([
  "created",
  "exported",
  "external_transfer_marked",
  "protocol_recorded",
  "superseded",
]);
const PROTOCOL_RESULTS = Object.freeze(["accepted", "warning", "not_accepted"]);

class PayrollHandoffError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PayrollHandoffError";
    this.code = code;
  }
}

function handoffError(message, code) {
  return new PayrollHandoffError(message, code);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function canonicalSha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw handoffError(`${label} muss ein Objekt sein.`, "PAYROLL_HANDOFF_OBJECT_REQUIRED");
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) {
    throw handoffError(`${label} enthält nicht unterstützte Felder: ${extras.join(", ")}.`, "PAYROLL_HANDOFF_FIELDS_INVALID");
  }
}

function requiredString(value, label, maximum = 180) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum) {
    throw handoffError(`${label} fehlt oder ist zu lang.`, "PAYROLL_HANDOFF_VALUE_INVALID");
  }
  return normalized;
}

function optionalString(value, maximum = 1000) {
  const normalized = String(value || "").trim();
  if (normalized.length > maximum) throw handoffError("Der Text ist zu lang.", "PAYROLL_HANDOFF_VALUE_INVALID");
  return normalized;
}

function isoInstant(value, label) {
  const normalized = requiredString(value, label, 40);
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw handoffError(`${label} ist kein gültiger UTC-Zeitpunkt.`, "PAYROLL_HANDOFF_INSTANT_INVALID");
  }
  return normalized;
}

function yearMonth(value) {
  const normalized = String(value || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(normalized)) {
    throw handoffError("Der Abrechnungsmonat muss im Format YYYY-MM angegeben werden.", "PAYROLL_HANDOFF_MONTH_INVALID");
  }
  return normalized;
}

function nonNegativeInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw handoffError(`${label} muss eine nichtnegative Ganzzahl sein.`, "PAYROLL_HANDOFF_NUMBER_INVALID");
  }
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = nonNegativeInteger(value, label);
  if (normalized < 1) {
    throw handoffError(`${label} muss mindestens 1 sein.`, "PAYROLL_HANDOFF_NUMBER_INVALID");
  }
  return normalized;
}

function normalizeScope(input) {
  const value = plainObject(input, "Der Übergabeumfang");
  exactKeys(value, new Set(["locationId", "departmentId"]), "Der Übergabeumfang");
  return {
    locationId: requiredString(value.locationId, "Standort-ID", 80),
    departmentId: optionalString(value.departmentId, 80),
  };
}

function normalizeStatement(input) {
  const value = plainObject(input, "Ein Monatsnachweis");
  exactKeys(value, new Set([
    "employeeId",
    "statementId",
    "statementRevision",
    "statementReceiptSha256",
    "actualMinutes",
    "breakMinutes",
    "status",
  ]), "Ein Monatsnachweis");
  if (String(value.status || "") !== "finalized") {
    throw handoffError(
      "Eine Lohnübergabe darf ausschließlich finalisierte Ist-Zeitnachweise enthalten.",
      "PAYROLL_HANDOFF_FINAL_STATEMENTS_REQUIRED",
    );
  }
  const receipt = String(value.statementReceiptSha256 || "");
  if (!SHA256_PATTERN.test(receipt)) {
    throw handoffError("Ein Monatsnachweis besitzt keinen gültigen Beleg.", "PAYROLL_HANDOFF_STATEMENT_RECEIPT_INVALID");
  }
  return {
    employeeId: requiredString(value.employeeId, "Personalnummer", 80),
    statementId: requiredString(value.statementId, "Nachweis-ID", 240),
    statementRevision: positiveInteger(value.statementRevision, "Nachweisrevision"),
    statementReceiptSha256: receipt,
    actualMinutes: nonNegativeInteger(value.actualMinutes, "Ist-Minuten"),
    breakMinutes: nonNegativeInteger(value.breakMinutes, "Pausenminuten"),
  };
}

function handoffBody(handoff) {
  const body = { ...handoff };
  delete body.receiptSha256;
  return body;
}

function handoffReceipt(handoff) {
  return canonicalSha256({
    schemaVersion: PAYROLL_HANDOFF_SCHEMA_VERSION,
    governanceVersion: PAYROLL_HANDOFF_GOVERNANCE_VERSION,
    kind: "monthly_actual_time_handoff",
    handoff: handoffBody(handoff),
  });
}

function createPayrollHandoff(input) {
  const value = plainObject(input, "Die Monatsübergabe");
  exactKeys(value, new Set([
    "handoffId",
    "month",
    "revision",
    "createdAt",
    "createdBy",
    "scope",
    "statements",
    "previousReceiptSha256",
  ]), "Die Monatsübergabe");
  const statements = Array.isArray(value.statements) ? value.statements.map(normalizeStatement) : [];
  if (!statements.length) {
    throw handoffError("Für eine Monatsübergabe ist mindestens ein finalisierter Nachweis erforderlich.", "PAYROLL_HANDOFF_EMPTY");
  }
  statements.sort((left, right) => left.employeeId.localeCompare(right.employeeId, "de", { numeric: true }));
  const employeeIds = new Set();
  for (const statement of statements) {
    if (employeeIds.has(statement.employeeId)) {
      throw handoffError("Ein Teammitglied darf in einer Übergabe nur einmal enthalten sein.", "PAYROLL_HANDOFF_EMPLOYEE_DUPLICATE");
    }
    employeeIds.add(statement.employeeId);
  }
  const previousReceiptSha256 = value.previousReceiptSha256 == null || value.previousReceiptSha256 === ""
    ? null
    : String(value.previousReceiptSha256);
  if (previousReceiptSha256 !== null && !SHA256_PATTERN.test(previousReceiptSha256)) {
    throw handoffError("Der Beleg der Vorgängerrevision ist ungültig.", "PAYROLL_HANDOFF_PREVIOUS_RECEIPT_INVALID");
  }
  const body = {
    schemaVersion: PAYROLL_HANDOFF_SCHEMA_VERSION,
    governanceVersion: PAYROLL_HANDOFF_GOVERNANCE_VERSION,
    kind: "monthly_actual_time_handoff",
    handoffId: requiredString(value.handoffId, "Übergabe-ID", 240),
    month: yearMonth(value.month),
    revision: positiveInteger(value.revision, "Übergaberevision"),
    createdAt: isoInstant(value.createdAt, "Erstellzeitpunkt"),
    createdBy: requiredString(value.createdBy, "Ersteller", 80),
    scope: normalizeScope(value.scope),
    previousReceiptSha256,
    statements,
    totals: {
      employeeCount: statements.length,
      actualMinutes: statements.reduce((sum, statement) => sum + statement.actualMinutes, 0),
      breakMinutes: statements.reduce((sum, statement) => sum + statement.breakMinutes, 0),
    },
    sourceNotice: "Ausschließlich finalisierte tatsächliche Zeitnachweise; keine Planzeiten, Entgelt- oder Beitragsberechnung.",
  };
  return { ...body, receiptSha256: handoffReceipt(body) };
}

function verifyPayrollHandoff(input) {
  try {
    const value = plainObject(input, "Die gespeicherte Monatsübergabe");
    if (value.schemaVersion !== PAYROLL_HANDOFF_SCHEMA_VERSION
      || value.governanceVersion !== PAYROLL_HANDOFF_GOVERNANCE_VERSION
      || value.kind !== "monthly_actual_time_handoff"
      || !SHA256_PATTERN.test(String(value.receiptSha256 || ""))) return false;
    const recreated = createPayrollHandoff({
      handoffId: value.handoffId,
      month: value.month,
      revision: value.revision,
      createdAt: value.createdAt,
      createdBy: value.createdBy,
      scope: value.scope,
      statements: value.statements.map((statement) => ({ ...statement, status: "finalized" })),
      previousReceiptSha256: value.previousReceiptSha256,
    });
    return canonicalSha256(recreated) === canonicalSha256(value);
  } catch {
    return false;
  }
}

function eventBody(event) {
  const body = { ...event };
  delete body.receiptSha256;
  return body;
}

function eventReceipt(event) {
  return canonicalSha256({
    governanceVersion: PAYROLL_HANDOFF_GOVERNANCE_VERSION,
    kind: "payroll_handoff_event",
    event: eventBody(event),
  });
}

function createPayrollHandoffEvent(input) {
  const value = plainObject(input, "Das Übergabeereignis");
  exactKeys(value, new Set([
    "eventId",
    "handoffId",
    "eventType",
    "actorId",
    "occurredAt",
    "handoffReceiptSha256",
    "protocolResult",
    "protocolNumber",
    "note",
    "supersededByHandoffId",
  ]), "Das Übergabeereignis");
  const eventType = String(value.eventType || "");
  if (!HANDOFF_EVENT_TYPES.includes(eventType)) {
    throw handoffError("Das Übergabeereignis ist nicht unterstützt.", "PAYROLL_HANDOFF_EVENT_TYPE_INVALID");
  }
  const handoffReceiptSha256 = String(value.handoffReceiptSha256 || "");
  if (!SHA256_PATTERN.test(handoffReceiptSha256)) {
    throw handoffError("Der Übergabebeleg des Ereignisses ist ungültig.", "PAYROLL_HANDOFF_EVENT_RECEIPT_INVALID");
  }
  let protocolResult = "";
  let protocolNumber = "";
  let note = optionalString(value.note, 1000);
  let supersededByHandoffId = "";
  if (eventType === "protocol_recorded") {
    protocolResult = String(value.protocolResult || "");
    if (!PROTOCOL_RESULTS.includes(protocolResult)) {
      throw handoffError("Das Protokollergebnis ist nicht unterstützt.", "PAYROLL_HANDOFF_PROTOCOL_RESULT_INVALID");
    }
    protocolNumber = requiredString(value.protocolNumber, "Protokollnummer", 160);
  } else if (value.protocolResult || value.protocolNumber) {
    throw handoffError("Protokolldaten sind nur für ein Protokollereignis zulässig.", "PAYROLL_HANDOFF_PROTOCOL_FIELDS_INVALID");
  }
  if (eventType === "superseded") {
    supersededByHandoffId = requiredString(value.supersededByHandoffId, "Nachfolgerevision", 240);
  } else if (value.supersededByHandoffId) {
    throw handoffError("Eine Nachfolgerevision ist nur beim Ersetzen zulässig.", "PAYROLL_HANDOFF_SUPERSESSION_INVALID");
  }
  const body = {
    governanceVersion: PAYROLL_HANDOFF_GOVERNANCE_VERSION,
    eventId: requiredString(value.eventId, "Ereignis-ID", 240),
    handoffId: requiredString(value.handoffId, "Übergabe-ID", 240),
    eventType,
    actorId: requiredString(value.actorId, "Akteur", 80),
    occurredAt: isoInstant(value.occurredAt, "Ereigniszeitpunkt"),
    handoffReceiptSha256,
    protocolResult,
    protocolNumber,
    note,
    supersededByHandoffId,
  };
  return { ...body, receiptSha256: eventReceipt(body) };
}

function verifyPayrollHandoffEvent(input) {
  try {
    const value = plainObject(input, "Das gespeicherte Übergabeereignis");
    if (value.governanceVersion !== PAYROLL_HANDOFF_GOVERNANCE_VERSION
      || !SHA256_PATTERN.test(String(value.receiptSha256 || ""))) return false;
    const recreated = createPayrollHandoffEvent({
      eventId: value.eventId,
      handoffId: value.handoffId,
      eventType: value.eventType,
      actorId: value.actorId,
      occurredAt: value.occurredAt,
      handoffReceiptSha256: value.handoffReceiptSha256,
      protocolResult: value.protocolResult,
      protocolNumber: value.protocolNumber,
      note: value.note,
      supersededByHandoffId: value.supersededByHandoffId,
    });
    return canonicalSha256(recreated) === canonicalSha256(value);
  } catch {
    return false;
  }
}

function derivePayrollHandoffState(events = []) {
  const ordered = [...events].sort((left, right) => String(left.occurredAt).localeCompare(String(right.occurredAt)));
  if (ordered.some((event) => event.eventType === "superseded")) return "superseded";
  const protocol = [...ordered].reverse().find((event) => event.eventType === "protocol_recorded");
  if (protocol?.protocolResult === "accepted") return "accepted";
  if (protocol?.protocolResult === "warning") return "accepted_with_warning";
  if (protocol?.protocolResult === "not_accepted") return "correction_required";
  if (ordered.some((event) => event.eventType === "external_transfer_marked")) return "protocol_pending";
  if (ordered.some((event) => event.eventType === "exported")) return "external_transfer_required";
  return "prepared";
}

module.exports = {
  HANDOFF_EVENT_TYPES,
  PAYROLL_HANDOFF_GOVERNANCE_VERSION,
  PAYROLL_HANDOFF_SCHEMA_VERSION,
  PROTOCOL_RESULTS,
  PayrollHandoffError,
  createPayrollHandoff,
  createPayrollHandoffEvent,
  derivePayrollHandoffState,
  verifyPayrollHandoff,
  verifyPayrollHandoffEvent,
};
