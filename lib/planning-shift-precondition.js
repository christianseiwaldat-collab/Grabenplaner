"use strict";

const crypto = require("node:crypto");

const FIELDS = Object.freeze([
  "id", "employee_number", "location_id", "department_id", "duty_code",
  "shift_date", "start_time", "end_time", "area", "note",
]);

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function unavailable() {
  return failure(503, "SHIFT_REVISION_UNAVAILABLE", "Der aktuelle Dienststand kann nicht sicher geprüft werden.");
}

function positiveIntegerString(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) throw unavailable();
    return String(value);
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw unavailable();
  // Check the decimal magnitude before parsing; leading zeros preserve identity.
  const decimal = value.replace(/^0+/, "");
  if (!decimal || decimal.length > 16) throw unavailable();
  const number = Number(decimal);
  if (!Number.isSafeInteger(number) || number <= 0) throw unavailable();
  return String(number);
}

function requiredString(value) {
  if (typeof value !== "string" || value.length === 0) throw unavailable();
  return value;
}

function nullableString(value) {
  if (value !== null && typeof value !== "string") throw unavailable();
  return value;
}

function canonicalPlanningShift(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw unavailable();
  const values = {};
  try {
    for (const field of FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(row, field);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw unavailable();
      values[field] = descriptor.value;
    }
  } catch {
    throw unavailable();
  }
  // Key order and raw nullable/string values are part of the revision contract.
  return {
    id: positiveIntegerString(values.id),
    employee_number: requiredString(values.employee_number),
    location_id: requiredString(values.location_id),
    department_id: values.department_id === null ? null : positiveIntegerString(values.department_id),
    duty_code: nullableString(values.duty_code),
    shift_date: requiredString(values.shift_date),
    start_time: requiredString(values.start_time),
    end_time: requiredString(values.end_time),
    area: nullableString(values.area),
    note: nullableString(values.note),
  };
}

function canonicalRevision(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function planningShiftRevision(row) {
  return canonicalRevision(canonicalPlanningShift(row));
}

function assertExpectedPlanningShiftRevision(row, expectedRevision) {
  if (expectedRevision === undefined) return null;
  if (typeof expectedRevision !== "string" || expectedRevision.length !== 64 || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw failure(400, "SHIFT_REVISION_INVALID", "Die Dienststand-Kennung ist ungültig.");
  }
  const canonical = canonicalPlanningShift(row);
  if (canonicalRevision(canonical) !== expectedRevision) {
    throw failure(409, "SHIFT_REVISION_CONFLICT", "Der Dienst wurde inzwischen geändert. Bitte den Dienstplan neu laden.");
  }
  return canonical;
}

module.exports = {
  canonicalPlanningShift,
  planningShiftRevision,
  assertExpectedPlanningShiftRevision,
};
