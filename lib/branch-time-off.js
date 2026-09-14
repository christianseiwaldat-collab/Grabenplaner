"use strict";

const BRANCH_TIME_OFF_PERMISSION = "branch_time_off:submit";

function denied(message, code = "BRANCH_TIME_OFF_SCOPE_DENIED", status = 403) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  throw error;
}

function branchTimeOffContext(session) {
  if (!session || session.sessionKind !== "organization" || session.accountType !== "branch"
    || !session.accountId || session.mustChangePassword
    || !session.permissions?.includes(BRANCH_TIME_OFF_PERMISSION)) {
    denied("ZA-Anträge sind für dieses Filialkonto nicht freigeschaltet.", "BRANCH_TIME_OFF_DISABLED");
  }
  const scopes = Array.isArray(session.scopes) ? session.scopes : [];
  if (scopes.length !== 1 || !scopes[0]?.locationId || scopes[0].departmentId) {
    denied("Für ZA-Anträge muss dem Filialkonto genau eine Filiale zugewiesen sein.");
  }
  return { session, accountId: session.accountId, locationId: String(scopes[0].locationId) };
}

function sameBranchTimeOffContext(before, after) {
  if (before.accountId !== after.accountId || before.locationId !== after.locationId
    || before.session.id !== after.session.id) {
    denied("Die Filialzuordnung hat sich geändert. Bitte das Formular neu laden.");
  }
}

function branchTimeOffEmployeeNumber(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\u0000-\u001f]/u.test(value)) {
    denied("Bitte zuerst ein Teammitglied auswählen.", "BRANCH_TIME_OFF_EMPLOYEE_REQUIRED", 400);
  }
  return value.trim();
}

function isoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function shiftDate(value, days) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function branchTimeOffPeriod(input) {
  if (!isoDate(input.dateFrom) || !isoDate(input.dateTo) || input.dateTo < input.dateFrom
    || input.dateTo > shiftDate(input.dateFrom, 365)) {
    denied("Bitte einen gültigen ZA-Zeitraum von höchstens 366 Tagen wählen.", "BRANCH_TIME_OFF_PERIOD_INVALID", 400);
  }
}

function branchTimeOffScheduleWindow(date, view = "week") {
  if (!isoDate(date) || !["week", "month"].includes(view)) {
    denied("Bitte eine gültige Woche oder einen Monat wählen.", "BRANCH_TIME_OFF_SCHEDULE_INVALID", 400);
  }
  const day = new Date(`${date}T12:00:00Z`);
  if (view === "week") {
    const from = shiftDate(date, -((day.getUTCDay() + 6) % 7));
    return { view, from, to: shiftDate(from, 6), anchor: date };
  }
  const from = `${date.slice(0, 7)}-01`;
  day.setUTCDate(1);
  day.setUTCMonth(day.getUTCMonth() + 1);
  day.setUTCDate(0);
  return { view, from, to: day.toISOString().slice(0, 10), anchor: date };
}

function branchTimeOffEmployees(rows, locationId) {
  return rows.filter(row => (row.active === true || Number(row.active) === 1)
    && String(row.home_location_id || "") === locationId)
    .map(row => ({ employeeNumber: String(row.personnel_number), fullName: String(row.full_name) }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "de-AT") || a.employeeNumber.localeCompare(b.employeeNumber));
}

function branchTimeOffSlots(data, locationId) {
  const slots = (data.slots || []).filter(slot => String(slot.locationId) === locationId)
    .map(({ startTime, endTime }) => ({ startTime, endTime }));
  const startTimes = [...new Set(slots.map(slot => slot.startTime))].sort();
  const endTimes = [...new Set(slots.map(slot => slot.endTime))].sort();
  const ownWarning = (data.warnings || []).find(w => String(w.locationId) === locationId);
  return {
    date: data.date, closed: slots.length === 0,
    reason: slots.length ? "" : ownWarning?.reason || "Für diesen Tag gibt es in dieser Filiale keine beantragbaren ZA-Zeiten.",
    start: startTimes[0] || null, end: endTimes.at(-1) || null,
    startTimes, endTimes, slots,
  };
}

module.exports = {
  BRANCH_TIME_OFF_PERMISSION, branchTimeOffContext, sameBranchTimeOffContext,
  branchTimeOffEmployeeNumber, branchTimeOffPeriod, branchTimeOffScheduleWindow,
  branchTimeOffEmployees, branchTimeOffSlots,
};
