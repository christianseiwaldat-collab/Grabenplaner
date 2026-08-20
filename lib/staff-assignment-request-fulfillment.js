"use strict";

const {
  StaffAssignmentRequestError,
} = require("./staff-assignment-requests");

const STAFF_ASSIGNMENT_REQUEST_ASSIGNMENT_PREFIX = "staff-assignment-request:";

function conflict(code, message) {
  throw new StaffAssignmentRequestError(code, message);
}

function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function datesInRange(dateFrom, dateTo) {
  const dates = [];
  for (let date = dateFrom; date <= dateTo; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function assignmentInterval(value) {
  const dateFrom = String(value.dateFrom ?? value.date_from ?? "");
  const dateTo = String(value.dateTo ?? value.date_to ?? dateFrom);
  const allDay = Boolean(value.allDay ?? value.all_day)
    || (dateFrom && dateTo && dateFrom !== dateTo);
  if (allDay) {
    return {
      start: `${dateFrom}T00:00`,
      end: `${addDays(dateTo, 1)}T00:00`,
    };
  }
  return {
    start: `${dateFrom}T${value.startTime ?? value.start_time}`,
    end: `${dateTo}T${value.endTime ?? value.end_time}`,
  };
}

function shiftInterval(row) {
  return {
    start: `${row.shift_date}T${row.start_time}`,
    end: `${row.shift_date}T${row.end_time}`,
  };
}

function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

function contains(outer, inner) {
  return outer.start <= inner.start && inner.end <= outer.end;
}

function staffAssignmentRequestAssignmentId(requestId) {
  const normalized = String(requestId || "").trim();
  if (!normalized || normalized.includes("\0")) {
    conflict(
      "STAFF_ASSIGNMENT_REQUEST_INVALID",
      "Die Einsatzanfrage besitzt keine gültige Bindungs-ID.",
    );
  }
  return `${STAFF_ASSIGNMENT_REQUEST_ASSIGNMENT_PREFIX}${normalized}`;
}

function staffAssignmentRequestIdFromAssignmentId(assignmentId) {
  const normalized = String(assignmentId || "");
  if (!normalized.startsWith(STAFF_ASSIGNMENT_REQUEST_ASSIGNMENT_PREFIX)) return null;
  const requestId = normalized.slice(STAFF_ASSIGNMENT_REQUEST_ASSIGNMENT_PREFIX.length);
  return requestId && !requestId.includes("\0") ? requestId : null;
}

function boundAssignmentFromRequest({
  requestId,
  current,
  confirmedEmployeeNumber,
  actorEmployeeNumber,
  timestamp,
}) {
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    conflict("STAFF_ASSIGNMENT_REQUEST_INVALID", "Die Einsatzanfrage ist ungültig.");
  }
  const employeeNumber = String(confirmedEmployeeNumber || "").trim();
  const actor = String(actorEmployeeNumber || "").trim();
  const occurredAt = String(timestamp || "").trim();
  if (!employeeNumber || !actor || !occurredAt) {
    conflict(
      "STAFF_ASSIGNMENT_REQUEST_INVALID",
      "Die Einsatzbindung enthält unvollständige Pflichtangaben.",
    );
  }
  const hourly = current.timeKind === "hourly";
  return Object.freeze({
    id: staffAssignmentRequestAssignmentId(requestId),
    employeeNumber,
    homeLocationId: String(current.sourceLocationId || ""),
    destinationLocationId: String(current.destinationLocationId || ""),
    destinationDepartmentId: Number(current.destinationDepartmentId),
    dateFrom: String(current.periodStartDate || ""),
    dateTo: String(current.periodEndDate || ""),
    allDay: !hourly,
    startTime: hourly ? String(current.startTime || "") : null,
    endTime: hourly ? String(current.endTime || "") : null,
    note: "",
    actor,
    timestamp: occurredAt,
  });
}

function pendingVacationChangeOverlaps(row, requested) {
  if (String(row.request_type || "") !== "change") return false;
  const dateFrom = String(row.requested_date_from || "");
  const dateTo = String(row.requested_date_to || "");
  return Boolean(dateFrom && dateTo) && overlaps(
    requested,
    assignmentInterval({ dateFrom, dateTo, allDay: true }),
  );
}

function pendingTimeOffChangeOverlaps(row, requested) {
  if (String(row.request_type || "") !== "change") return false;
  const dateFrom = String(row.requested_date_from || "");
  const dateTo = String(row.requested_date_to || "");
  if (!dateFrom || !dateTo) return false;
  return overlaps(requested, assignmentInterval({
    dateFrom,
    dateTo,
    allDay: Boolean(row.requested_all_day) || dateFrom !== dateTo,
    startTime: row.requested_start_time,
    endTime: row.requested_end_time,
  }));
}

async function assertStaffAssignmentRequestAssignmentAvailable(
  assignment,
  absenceRepository,
) {
  if (!absenceRepository
    || typeof absenceRepository.activeEmployeeLendingsForRange !== "function"
    || typeof absenceRepository.timeOffOptionsOnDate !== "function"
    || typeof absenceRepository.vacationOverlap !== "function"
    || typeof absenceRepository.timeOffRangeOverlap !== "function"
    || typeof absenceRepository.timeOffPointOverlap !== "function"
    || typeof absenceRepository.pendingVacationChanges !== "function"
    || typeof absenceRepository.pendingTimeOffChanges !== "function"
    || typeof absenceRepository.shiftsForTimeOffRange !== "function") {
    throw new TypeError("Ein vollständiges Abwesenheits-Repository wird benötigt.");
  }
  const requested = assignmentInterval(assignment);
  const dates = datesInRange(assignment.dateFrom, assignment.dateTo);
  const [
    activeAssignments,
    optionsByDate,
    vacationRequest,
    timeOffRequest,
    vacationChanges,
    timeOffChanges,
    shifts,
  ] = await Promise.all([
    absenceRepository.activeEmployeeLendingsForRange({
      employeeNumber: assignment.employeeNumber,
      dateFrom: assignment.dateFrom,
      dateTo: assignment.dateTo,
    }),
    Promise.all(dates.map((date) => absenceRepository.timeOffOptionsOnDate({
      employeeNumber: assignment.employeeNumber,
      date,
    }))),
    absenceRepository.vacationOverlap({
      employeeNumber: assignment.employeeNumber,
      excludeId: 0,
      dateFrom: assignment.dateFrom,
      dateTo: assignment.dateTo,
    }),
    assignment.allDay
      ? absenceRepository.timeOffRangeOverlap({
        employeeNumber: assignment.employeeNumber,
        excludeId: 0,
        dateFrom: assignment.dateFrom,
        dateTo: assignment.dateTo,
      })
      : absenceRepository.timeOffPointOverlap({
        employeeNumber: assignment.employeeNumber,
        excludeId: 0,
        date: assignment.dateFrom,
        startTime: assignment.startTime,
        endTime: assignment.endTime,
      }),
    absenceRepository.pendingVacationChanges(assignment.employeeNumber),
    absenceRepository.pendingTimeOffChanges(assignment.employeeNumber),
    absenceRepository.shiftsForTimeOffRange({
      employeeNumber: assignment.employeeNumber,
      dateFrom: assignment.dateFrom,
      dateTo: assignment.dateTo,
      locationId: null,
    }),
  ]);

  if ((activeAssignments || []).some((row) => overlaps(requested, assignmentInterval(row)))) {
    conflict(
      "EMPLOYEE_LENDING_OVERLAP",
      "Für das Teammitglied besteht in diesem Zeitraum bereits ein temporärer Filialeinsatz.",
    );
  }

  const approvedAbsence = optionsByDate.flat().find((row) => (
    ["vacation", "time_off"].includes(String(row.option_type || ""))
      && overlaps(requested, assignmentInterval(row))
  ));
  if (approvedAbsence) {
    const type = approvedAbsence.option_type === "vacation" ? "Urlaub" : "Zeitausgleich";
    conflict(
      "EMPLOYEE_LENDING_APPROVED_ABSENCE_CONFLICT",
      `Für diesen Zeitraum ist bereits genehmigter ${type} eingetragen.`,
    );
  }

  const pendingChange = (vacationChanges || []).some((row) => (
    pendingVacationChangeOverlaps(row, requested)
  )) || (timeOffChanges || []).some((row) => pendingTimeOffChangeOverlaps(row, requested));
  if (vacationRequest || timeOffRequest || pendingChange) {
    conflict(
      "EMPLOYEE_LENDING_PENDING_ABSENCE_REQUEST_CONFLICT",
      "Für diesen Zeitraum besteht noch ein offener Urlaubs- oder ZA-Antrag. Bitte den Antrag zuerst abschließen.",
    );
  }

  const incompatibleShift = (shifts || [])
    .filter((row) => overlaps(requested, shiftInterval(row)))
    .find((row) => (
      String(row.location_id || "") !== assignment.destinationLocationId
      || Number(row.department_id || 0) !== Number(assignment.destinationDepartmentId || 0)
      || !contains(requested, shiftInterval(row))
    ));
  if (incompatibleShift) {
    conflict(
      "EMPLOYEE_LENDING_SHIFT_CONFLICT",
      "Ein bestehender Dienst ist nicht vollständig durch den vorgesehenen Filialeinsatz abgedeckt.",
    );
  }
  return assignment;
}

module.exports = {
  STAFF_ASSIGNMENT_REQUEST_ASSIGNMENT_PREFIX,
  assertStaffAssignmentRequestAssignmentAvailable,
  boundAssignmentFromRequest,
  staffAssignmentRequestAssignmentId,
  staffAssignmentRequestIdFromAssignmentId,
};
