"use strict";

const crypto = require("node:crypto");

class EmployeeLocationLendingError extends Error {
  constructor(message, code = "EMPLOYEE_LENDING_INVALID", status = 400, details = null) {
    super(message);
    this.name = "EmployeeLocationLendingError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function interval(value) {
  if (Boolean(value.allDay ?? value.all_day)) {
    return {
      start: `${value.dateFrom ?? value.date_from}T00:00`,
      end: `${addDays(value.dateTo ?? value.date_to, 1)}T00:00`,
    };
  }
  return {
    start: `${value.dateFrom ?? value.date_from}T${value.startTime ?? value.start_time}`,
    end: `${value.dateTo ?? value.date_to}T${value.endTime ?? value.end_time}`,
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

function publicRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    employeeNumber: String(row.employee_number),
    employeeName: String(row.employee_name || row.full_name || ""),
    homeLocationId: String(row.home_location_id),
    homeLocationName: String(row.home_location_name || ""),
    destinationLocationId: String(row.destination_location_id),
    destinationLocationName: String(row.destination_location_name || ""),
    destinationDepartmentId: Number(row.destination_department_id || 0) || null,
    destinationDepartmentName: String(row.destination_department_name || ""),
    dateFrom: String(row.date_from),
    dateTo: String(row.date_to),
    allDay: Boolean(row.all_day),
    startTime: row.start_time || null,
    endTime: row.end_time || null,
    note: String(row.note || ""),
    status: String(row.status),
    revision: Number(row.revision),
    createdBy: String(row.created_by || ""),
    createdAt: row.created_at || null,
    updatedBy: String(row.updated_by || ""),
    updatedAt: row.updated_at || null,
    cancelledBy: row.cancelled_by || null,
    cancelledAt: row.cancelled_at || null,
  };
}

function apiRow(row) {
  if (!row) return null;
  const {
    createdBy: _createdBy,
    updatedBy: _updatedBy,
    cancelledBy: _cancelledBy,
    ...projected
  } = row;
  return projected;
}

function createSqliteEmployeeLocationLendingOperations(db) {
  const selectProjection = `
    SELECT lending.*,
      employee.full_name AS employee_name,
      home.name AS home_location_name,
      destination.name AS destination_location_name,
      department.name AS destination_department_name
    FROM employee_location_lendings lending
    JOIN employees employee ON employee.personnel_number = lending.employee_number
    JOIN locations home ON home.id = lending.home_location_id
    JOIN locations destination ON destination.id = lending.destination_location_id
    LEFT JOIN departments department ON department.id = lending.destination_department_id
  `;

  const getStatement = db.prepare(`${selectProjection} WHERE lending.id = ?`);
  const employeeStatement = db.prepare(`
    SELECT personnel_number, full_name, nickname, home_location_id, preferred_department_id, active
    FROM employees
    WHERE personnel_number = ?
  `);
  const locationStatement = db.prepare(`
    SELECT id, name, active
    FROM locations
    WHERE id = ?
  `);
  const departmentStatement = db.prepare(`
    SELECT id, location_id, name, active
    FROM departments
    WHERE id = ?
  `);
  const absencesStatement = db.prepare(`
    SELECT id, option_type, date_from, date_to, all_day, start_time, end_time
    FROM week_options
    WHERE employee_number = ?
      AND option_type IN ('vacation', 'time_off')
      AND date_from <= ?
      AND date_to >= ?
    ORDER BY date_from, start_time, id
  `);
  const pendingVacationRequestsStatement = db.prepare(`
    SELECT id, date_from, date_to
    FROM vacation_requests
    WHERE employee_number = ?
      AND status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
      AND date_from <= ?
      AND date_to >= ?
    ORDER BY date_from, id
  `);
  const pendingTimeOffRequestsStatement = db.prepare(`
    SELECT id, lending_id,
      COALESCE(date_from, request_date) AS date_from,
      COALESCE(date_to, request_date) AS date_to,
      COALESCE(all_day, 0) AS all_day,
      start_time,
      end_time
    FROM time_off_requests
    WHERE employee_number = ?
      AND status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
      AND COALESCE(date_from, request_date) <= ?
      AND COALESCE(date_to, request_date) >= ?
    ORDER BY COALESCE(date_from, request_date), start_time, id
  `);
  const pendingVacationChangeRequestsStatement = db.prepare(`
    SELECT id, requested_date_from AS date_from, requested_date_to AS date_to
    FROM vacation_change_requests
    WHERE employee_number = ?
      AND request_type = 'change'
      AND status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
      AND requested_date_from IS NOT NULL
      AND requested_date_to IS NOT NULL
      AND requested_date_from <= ?
      AND requested_date_to >= ?
    ORDER BY requested_date_from, id
  `);
  const pendingTimeOffChangeRequestsStatement = db.prepare(`
    SELECT id, requested_date_from AS date_from, requested_date_to AS date_to,
      CASE WHEN COALESCE(requested_all_day, 0) = 1
        OR requested_date_from <> requested_date_to THEN 1 ELSE 0 END AS all_day,
      requested_start_time AS start_time,
      requested_end_time AS end_time
    FROM time_off_change_requests
    WHERE employee_number = ?
      AND request_type = 'change'
      AND status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
      AND requested_date_from IS NOT NULL
      AND requested_date_to IS NOT NULL
      AND requested_date_from <= ?
      AND requested_date_to >= ?
    ORDER BY requested_date_from, requested_start_time, id
  `);
  const shiftsStatement = db.prepare(`
    SELECT id, employee_number, location_id, department_id, shift_date, start_time, end_time
    FROM shifts
    WHERE employee_number = ?
      AND shift_date BETWEEN ? AND ?
    ORDER BY shift_date, start_time, id
  `);
  const activeLendingsStatement = db.prepare(`
    SELECT *
    FROM employee_location_lendings
    WHERE employee_number = ?
      AND status = 'active'
      AND id <> ?
      AND date_from <= ?
      AND date_to >= ?
    ORDER BY date_from, start_time, id
  `);
  const linkedTimeOffStatement = db.prepare(`
    SELECT 'request' AS source, id, status
    FROM time_off_requests
    WHERE lending_id = ?
      AND status NOT IN ('withdrawn', 'rejected', 'cancelled')
    UNION ALL
    SELECT 'change' AS source, id, status
    FROM time_off_change_requests
    WHERE lending_id = ?
      AND request_type = 'change'
      AND status IN ('pending', 'pending_local', 'preliminary_local', 'pending_hr')
    LIMIT 1
  `);
  const insertStatement = db.prepare(`
    INSERT INTO employee_location_lendings (
      id, employee_number, home_location_id, destination_location_id,
      destination_department_id, date_from, date_to, all_day, start_time,
      end_time, note, status, revision, created_by, created_at, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)
  `);
  const updateStatement = db.prepare(`
    UPDATE employee_location_lendings
    SET destination_location_id = ?, destination_department_id = ?, date_from = ?,
      date_to = ?, all_day = ?, start_time = ?, end_time = ?, note = ?,
      revision = revision + 1, updated_by = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND status = 'active'
  `);
  const cancelStatement = db.prepare(`
    UPDATE employee_location_lendings
    SET status = 'cancelled', revision = revision + 1, updated_by = ?, updated_at = ?,
      cancelled_by = ?, cancelled_at = ?
    WHERE id = ? AND revision = ? AND status = 'active'
  `);

  function lendingError(error) {
    if (error instanceof EmployeeLocationLendingError) return error;
    const message = String(error?.message || error || "");
    if (message.includes("EMPLOYEE_LENDING_OVERLAP")) {
      return new EmployeeLocationLendingError(
        "Für das Teammitglied besteht in diesem Zeitraum bereits ein temporärer Filialeinsatz.",
        "EMPLOYEE_LENDING_OVERLAP",
        409,
      );
    }
    if (message.includes("EMPLOYEE_LENDING_DEPARTMENT_INVALID")) {
      return new EmployeeLocationLendingError(
        "Die Zielabteilung ist für die gewählte Filiale nicht verfügbar.",
        "EMPLOYEE_LENDING_DEPARTMENT_INVALID",
        400,
      );
    }
    if (message.includes("EMPLOYEE_LENDING_SHIFT_CONFLICT")) {
      return new EmployeeLocationLendingError(
        "Ein bestehender Dienst ist nicht vollständig durch den vorgesehenen Filialeinsatz abgedeckt.",
        "EMPLOYEE_LENDING_SHIFT_CONFLICT",
        409,
      );
    }
    if (message.includes("FOREIGN KEY constraint failed")) {
      return new EmployeeLocationLendingError(
        "Mitarbeiter, Filiale oder Abteilung wurde nicht gefunden.",
        "EMPLOYEE_LENDING_REFERENCE_INVALID",
        400,
      );
    }
    return error;
  }

  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw lendingError(error);
    }
  }

  function getRaw(id) {
    return getStatement.get(String(id || "")) || null;
  }

  function employee(employeeNumber) {
    return employeeStatement.get(String(employeeNumber || "")) || null;
  }

  function activeLocations() {
    return db.prepare(`
      SELECT id, name
      FROM locations
      WHERE active = 1
      ORDER BY name COLLATE NOCASE, id
    `).all().map((row) => ({ id: String(row.id), name: String(row.name) }));
  }

  function activeCandidates() {
    return db.prepare(`
      SELECT personnel_number, full_name, nickname, home_location_id, preferred_department_id
      FROM employees
      WHERE active = 1 AND home_location_id IS NOT NULL AND TRIM(home_location_id) <> ''
      ORDER BY full_name COLLATE NOCASE, personnel_number
    `).all().map((row) => ({
      employeeNumber: String(row.personnel_number),
      fullName: String(row.full_name),
      nickname: String(row.nickname || ""),
      homeLocationId: String(row.home_location_id),
      preferredDepartmentId: Number(row.preferred_department_id || 0) || null,
    }));
  }

  function activeDepartments() {
    return db.prepare(`
      SELECT id, location_id, name
      FROM departments
      WHERE active = 1
      ORDER BY location_id, sort_order, name COLLATE NOCASE, id
    `).all().map((row) => ({
      id: Number(row.id),
      locationId: String(row.location_id),
      name: String(row.name),
    }));
  }

  function assignmentsOverlappingShift(employeeNumber, shiftDate, startTime, endTime) {
    const shift = { shift_date: shiftDate, start_time: startTime, end_time: endTime };
    return activeLendingsStatement
      .all(String(employeeNumber || ""), "", shiftDate, shiftDate)
      .filter((row) => overlaps(interval(row), shiftInterval(shift)));
  }

  function coverageForShift(employeeNumber, locationId, shiftDate, startTime, endTime) {
    const shift = { shift_date: shiftDate, start_time: startTime, end_time: endTime };
    const row = assignmentsOverlappingShift(employeeNumber, shiftDate, startTime, endTime)
      .find((entry) => String(entry.destination_location_id) === String(locationId)
        && contains(interval(entry), shiftInterval(shift)));
    return publicRow(row || null);
  }

  function overlapForShift(employeeNumber, shiftDate, startTime, endTime) {
    return publicRow(assignmentsOverlappingShift(employeeNumber, shiftDate, startTime, endTime)[0] || null);
  }

  function overlapForPeriod(value) {
    const requested = interval(value);
    const row = activeLendingsStatement
      .all(String(value.employeeNumber || ""), "", value.dateTo, value.dateFrom)
      .find((entry) => overlaps(requested, interval(entry)));
    return publicRow(row || null);
  }

  function validateReferences(value) {
    const employeeRow = employee(value.employeeNumber);
    if (!employeeRow || !employeeRow.active) {
      throw new EmployeeLocationLendingError(
        "Das aktive Teammitglied wurde nicht gefunden.",
        "EMPLOYEE_LENDING_EMPLOYEE_NOT_FOUND",
        404,
      );
    }
    const homeLocationId = String(employeeRow.home_location_id || "");
    if (!homeLocationId) {
      throw new EmployeeLocationLendingError(
        "Das Teammitglied besitzt keine Stammfiliale.",
        "EMPLOYEE_LENDING_HOME_LOCATION_REQUIRED",
        409,
      );
    }
    const home = locationStatement.get(homeLocationId);
    const destination = locationStatement.get(value.destinationLocationId);
    if (!home?.active || !destination?.active) {
      throw new EmployeeLocationLendingError(
        "Stamm- oder Zielfiliale ist nicht aktiv.",
        "EMPLOYEE_LENDING_LOCATION_INACTIVE",
        400,
      );
    }
    if (homeLocationId === String(value.destinationLocationId)) {
      throw new EmployeeLocationLendingError(
        "Stamm- und Zielfiliale müssen unterschiedlich sein.",
        "EMPLOYEE_LENDING_SAME_LOCATION",
        400,
      );
    }
    if (value.destinationDepartmentId) {
      const department = departmentStatement.get(value.destinationDepartmentId);
      if (!department?.active || String(department.location_id) !== String(value.destinationLocationId)) {
        throw new EmployeeLocationLendingError(
          "Die Zielabteilung ist für die gewählte Filiale nicht verfügbar.",
          "EMPLOYEE_LENDING_DEPARTMENT_INVALID",
          400,
        );
      }
    }
    return { employee: employeeRow, homeLocationId };
  }

  function assertNoLendingOverlap(value, excludeId = "") {
    const requested = interval(value);
    const conflict = activeLendingsStatement
      .all(value.employeeNumber, String(excludeId || ""), value.dateTo, value.dateFrom)
      .find((row) => overlaps(requested, interval(row)));
    if (conflict) {
      throw new EmployeeLocationLendingError(
        "Für das Teammitglied besteht in diesem Zeitraum bereits ein temporärer Filialeinsatz.",
        "EMPLOYEE_LENDING_OVERLAP",
        409,
        { lendingId: String(conflict.id) },
      );
    }
  }

  function assertNoAbsenceConflict(value) {
    const requested = interval(value);
    const conflict = absencesStatement
      .all(value.employeeNumber, value.dateTo, value.dateFrom)
      .find((row) => overlaps(requested, interval(row)));
    if (!conflict) return;
    const type = conflict.option_type === "vacation" ? "Urlaub" : "Zeitausgleich";
    throw new EmployeeLocationLendingError(
      `Für diesen Zeitraum ist bereits genehmigter ${type} eingetragen.`,
      "EMPLOYEE_LENDING_APPROVED_ABSENCE_CONFLICT",
      409,
      { optionId: Number(conflict.id), optionType: String(conflict.option_type) },
    );
  }

  function assertNoPendingAbsenceRequestConflict(value, excludeLendingId = "") {
    const requested = interval(value);
    const vacationConflict = pendingVacationRequestsStatement
      .all(value.employeeNumber, value.dateTo, value.dateFrom)
      .find((row) => overlaps(requested, interval({ ...row, all_day: 1 })));
    const timeOffConflict = pendingTimeOffRequestsStatement
      .all(value.employeeNumber, value.dateTo, value.dateFrom)
      .find((row) => (!excludeLendingId || String(row.lending_id || "") !== String(excludeLendingId))
        && overlaps(requested, interval(row)));
    const vacationChangeConflict = pendingVacationChangeRequestsStatement
      .all(value.employeeNumber, value.dateTo, value.dateFrom)
      .find((row) => overlaps(requested, interval({ ...row, all_day: 1 })));
    const timeOffChangeConflict = pendingTimeOffChangeRequestsStatement
      .all(value.employeeNumber, value.dateTo, value.dateFrom)
      .find((row) => overlaps(requested, interval(row)));
    const conflict = vacationConflict || timeOffConflict
      || vacationChangeConflict || timeOffChangeConflict;
    if (!conflict) return;
    const requestType = vacationConflict ? "vacation"
      : timeOffConflict ? "time_off"
        : vacationChangeConflict ? "vacation_change" : "time_off_change";
    throw new EmployeeLocationLendingError(
      "Für diesen Zeitraum besteht noch ein offener Urlaubs- oder ZA-Antrag. Bitte den Antrag zuerst abschließen.",
      "EMPLOYEE_LENDING_PENDING_ABSENCE_REQUEST_CONFLICT",
      409,
      {
        requestId: Number(conflict.id),
        requestType,
      },
    );
  }

  function overlappingShifts(value) {
    const requested = interval(value);
    return shiftsStatement
      .all(value.employeeNumber, value.dateFrom, value.dateTo)
      .filter((row) => overlaps(requested, shiftInterval(row)));
  }

  function assertCompatibleExistingShifts(value) {
    const requested = interval(value);
    const conflict = overlappingShifts(value)
      .find((row) => String(row.location_id || "") !== String(value.destinationLocationId)
        || (value.destinationDepartmentId
          && Number(row.department_id || 0) !== Number(value.destinationDepartmentId))
        || !contains(requested, shiftInterval(row)));
    if (!conflict) return;
    throw new EmployeeLocationLendingError(
      "Ein bestehender Dienst ist nicht vollständig durch den vorgesehenen Filialeinsatz abgedeckt.",
      "EMPLOYEE_LENDING_SHIFT_CONFLICT",
      409,
      { shiftId: Number(conflict.id), locationId: String(conflict.location_id || "") },
    );
  }

  function assertUpdateKeepsDestinationShifts(existing, value) {
    const oldInterval = interval(existing);
    const newInterval = interval(value);
    const orphaned = shiftsStatement
      .all(existing.employee_number, existing.date_from, existing.date_to)
      .filter((row) => String(row.location_id || "") === String(existing.destination_location_id))
      .filter((row) => overlaps(oldInterval, shiftInterval(row)))
      .find((row) => String(value.destinationLocationId) !== String(existing.destination_location_id)
        || !contains(newInterval, shiftInterval(row)));
    if (!orphaned) return;
    throw new EmployeeLocationLendingError(
      "Die Änderung würde einen bereits geplanten Dienst in der bisherigen Zielfiliale außerhalb des Einsatzzeitraums zurücklassen.",
      "EMPLOYEE_LENDING_TARGET_SHIFT_ORPHANED",
      409,
      { shiftId: Number(orphaned.id) },
    );
  }

  function assertCancellationKeepsNoDestinationShifts(existing) {
    const oldInterval = interval(existing);
    const targetShift = shiftsStatement
      .all(existing.employee_number, existing.date_from, existing.date_to)
      .filter((row) => String(row.location_id || "") === String(existing.destination_location_id))
      .find((row) => overlaps(oldInterval, shiftInterval(row)));
    if (!targetShift) return;
    throw new EmployeeLocationLendingError(
      "Vor dem Stornieren müssen die Dienste in der Zielfiliale entfernt oder umgeplant werden.",
      "EMPLOYEE_LENDING_TARGET_SHIFT_EXISTS",
      409,
      { shiftId: Number(targetShift.id) },
    );
  }

  function assignmentContextChanged(existing, value) {
    return String(existing.destination_location_id) !== String(value.destinationLocationId)
      || Number(existing.destination_department_id || 0) !== Number(value.destinationDepartmentId || 0)
      || String(existing.date_from) !== String(value.dateFrom)
      || String(existing.date_to) !== String(value.dateTo)
      || Boolean(existing.all_day) !== Boolean(value.allDay)
      || String(existing.start_time || "") !== String(value.startTime || "")
      || String(existing.end_time || "") !== String(value.endTime || "");
  }

  function assertNoLinkedTimeOff(existing, value = null) {
    if (value && !assignmentContextChanged(existing, value)) return;
    const linked = linkedTimeOffStatement.get(existing.id, existing.id);
    if (!linked) return;
    throw new EmployeeLocationLendingError(
      "Der Filialeinsatz ist mit einem offenen oder genehmigten Zeitausgleich verknüpft. Bitte schließen Sie den ZA-Vorgang zuerst ab.",
      "EMPLOYEE_LENDING_TIME_OFF_REFERENCE_EXISTS",
      409,
      { requestType: String(linked.source), requestId: Number(linked.id) },
    );
  }

  function list(filters = {}) {
    const clauses = [];
    const parameters = [];
    if (filters.status) {
      clauses.push("lending.status = ?");
      parameters.push(String(filters.status));
    }
    if (filters.dateFrom) {
      clauses.push("lending.date_to >= ?");
      parameters.push(String(filters.dateFrom));
    }
    if (filters.dateTo) {
      clauses.push("lending.date_from <= ?");
      parameters.push(String(filters.dateTo));
    }
    if (filters.employeeNumber) {
      clauses.push("lending.employee_number = ?");
      parameters.push(String(filters.employeeNumber));
    }
    if (filters.locationIds?.length) {
      const ids = [...new Set(filters.locationIds.map(String))];
      clauses.push(`(lending.home_location_id IN (${ids.map(() => "?").join(",")}) OR lending.destination_location_id IN (${ids.map(() => "?").join(",")}))`);
      parameters.push(...ids, ...ids);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`${selectProjection}${where} ORDER BY lending.date_from DESC, lending.created_at DESC, lending.id`)
      .all(...parameters).map(publicRow).map(apiRow);
  }

  function create(value) {
    return transaction(() => {
      const references = validateReferences(value);
      const normalized = { ...value, homeLocationId: references.homeLocationId };
      assertNoLendingOverlap(normalized);
      assertNoAbsenceConflict(normalized);
      assertNoPendingAbsenceRequestConflict(normalized);
      assertCompatibleExistingShifts(normalized);
      const id = value.id || crypto.randomUUID();
      const timestamp = value.timestamp || new Date().toISOString();
      insertStatement.run(
        id,
        normalized.employeeNumber,
        normalized.homeLocationId,
        normalized.destinationLocationId,
        normalized.destinationDepartmentId || null,
        normalized.dateFrom,
        normalized.dateTo,
        normalized.allDay ? 1 : 0,
        normalized.allDay ? null : normalized.startTime,
        normalized.allDay ? null : normalized.endTime,
        normalized.note || "",
        normalized.actor,
        timestamp,
        normalized.actor,
        timestamp,
      );
      return apiRow(publicRow(getRaw(id)));
    });
  }

  function update(id, value) {
    return transaction(() => {
      const existing = getRaw(id);
      if (!existing) {
        throw new EmployeeLocationLendingError("Der temporäre Filialeinsatz wurde nicht gefunden.", "EMPLOYEE_LENDING_NOT_FOUND", 404);
      }
      if (existing.status !== "active") {
        throw new EmployeeLocationLendingError("Ein stornierter Filialeinsatz kann nicht mehr geändert werden.", "EMPLOYEE_LENDING_CANCELLED", 409);
      }
      if (Number(existing.revision) !== Number(value.revision)) {
        throw new EmployeeLocationLendingError("Der Filialeinsatz wurde zwischenzeitlich geändert.", "EMPLOYEE_LENDING_REVISION_CONFLICT", 409);
      }
      if (value.employeeNumber && String(value.employeeNumber) !== String(existing.employee_number)) {
        throw new EmployeeLocationLendingError("Das Teammitglied eines bestehenden Filialeinsatzes kann nicht ausgetauscht werden.", "EMPLOYEE_LENDING_EMPLOYEE_IMMUTABLE", 400);
      }
      const normalized = { ...value, employeeNumber: String(existing.employee_number) };
      const references = validateReferences(normalized);
      if (String(references.homeLocationId) !== String(existing.home_location_id)) {
        throw new EmployeeLocationLendingError("Die Stammfiliale hat sich seit der Erfassung geändert.", "EMPLOYEE_LENDING_HOME_LOCATION_CHANGED", 409);
      }
      assertNoLendingOverlap(normalized, existing.id);
      const contextChanged = assignmentContextChanged(existing, normalized);
      if (contextChanged) {
        assertNoAbsenceConflict(normalized);
        assertNoPendingAbsenceRequestConflict(normalized, existing.id);
        assertNoLinkedTimeOff(existing, normalized);
      }
      assertCompatibleExistingShifts(normalized);
      assertUpdateKeepsDestinationShifts(existing, normalized);
      const timestamp = value.timestamp || new Date().toISOString();
      const outcome = updateStatement.run(
        normalized.destinationLocationId,
        normalized.destinationDepartmentId || null,
        normalized.dateFrom,
        normalized.dateTo,
        normalized.allDay ? 1 : 0,
        normalized.allDay ? null : normalized.startTime,
        normalized.allDay ? null : normalized.endTime,
        normalized.note || "",
        normalized.actor,
        timestamp,
        existing.id,
        value.revision,
      );
      if (Number(outcome.changes) !== 1) {
        throw new EmployeeLocationLendingError("Der Filialeinsatz wurde zwischenzeitlich geändert.", "EMPLOYEE_LENDING_REVISION_CONFLICT", 409);
      }
      return apiRow(publicRow(getRaw(existing.id)));
    });
  }

  function cancel(id, value) {
    return transaction(() => {
      const existing = getRaw(id);
      if (!existing) {
        throw new EmployeeLocationLendingError("Der temporäre Filialeinsatz wurde nicht gefunden.", "EMPLOYEE_LENDING_NOT_FOUND", 404);
      }
      if (existing.status !== "active") {
        throw new EmployeeLocationLendingError("Der Filialeinsatz wurde bereits storniert.", "EMPLOYEE_LENDING_CANCELLED", 409);
      }
      if (Number(existing.revision) !== Number(value.revision)) {
        throw new EmployeeLocationLendingError("Der Filialeinsatz wurde zwischenzeitlich geändert.", "EMPLOYEE_LENDING_REVISION_CONFLICT", 409);
      }
      assertCancellationKeepsNoDestinationShifts(existing);
      assertNoLinkedTimeOff(existing);
      const timestamp = value.timestamp || new Date().toISOString();
      const outcome = cancelStatement.run(value.actor, timestamp, value.actor, timestamp, existing.id, value.revision);
      if (Number(outcome.changes) !== 1) {
        throw new EmployeeLocationLendingError("Der Filialeinsatz wurde zwischenzeitlich geändert.", "EMPLOYEE_LENDING_REVISION_CONFLICT", 409);
      }
      return apiRow(publicRow(getRaw(existing.id)));
    });
  }

  return Object.freeze({
    activeCandidates,
    activeDepartments,
    activeLocations,
    cancel,
    coverageForShift,
    create,
    employee,
    get: (id) => apiRow(publicRow(getRaw(id))),
    list,
    overlapForPeriod,
    overlapForShift,
    update,
  });
}

module.exports = {
  EmployeeLocationLendingError,
  createSqliteEmployeeLocationLendingOperations,
};
