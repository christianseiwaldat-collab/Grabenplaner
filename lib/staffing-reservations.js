"use strict";

const { createHash, randomUUID } = require("node:crypto");
const {
  insertInitialStaffAssignmentRequestHistory,
  normalizeStaffAssignmentRequestInput,
  transitionStaffAssignmentRequestHistory,
} = require("./staff-assignment-requests");

const PERMISSION = "staff_assignment_requests:reserve";
const PREFIX = "/api/portal/v1/emma/staffing-reservations";
const RESERVATION_ID = /^staff-reservation-[0-9a-f]{64}$/;
const INPUT_FIELDS = new Set([
  "idempotencyKey", "sourceLocationId", "destinationLocationId", "destinationDepartmentId",
  "periodStartDate", "periodEndDate", "timeKind", "startTime", "endTime", "requestReason",
]);

const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

function assertReservationActor(actor) {
  if (actor?.sessionKind !== "employee" || actor.employeeNumber !== "Emma" || actor.mustChangePassword
    || !actor.permissions?.includes(PERMISSION) || !actor.grantedPermissions?.includes(PERMISSION)) {
    throw failure(403, "STAFFING_RESERVATION_ACTOR_DENIED", "Für diesen Zugang ist die Filialreservierung nicht freigegeben.");
  }
  return actor;
}

function wholeBranchScopes(actor) {
  return new Set((actor.explicitScopes || [])
    .filter(scope => scope.locationId && !scope.departmentId)
    .map(scope => String(scope.locationId)));
}

function assertBranches(actor, source, destination) {
  const branches = wholeBranchScopes(actor);
  if (!branches.has(source) || !branches.has(destination)) {
    throw failure(403, "STAFFING_RESERVATION_SCOPE_DENIED", "Quell- und Zielfiliale müssen dem Zugang zugewiesen sein.");
  }
}

function isStaffingReservation(id) {
  return typeof id === "string" && RESERVATION_ID.test(id);
}

function assertReservationReviewer(actor, createdByEmployeeNumber) {
  const number = String(actor?.employeeNumber || "");
  if (actor?.sessionKind !== "employee" || !number || number === createdByEmployeeNumber
    || /^(emma|kalle)$/i.test(number)) {
    throw failure(403, "STAFFING_RESERVATION_REVIEW_DENIED", "Eine zuständige persönliche Leitung muss über diese Reservierung entscheiden.");
  }
}

function publicReservation(current) {
  return {
    id: current.requestId,
    revisionNumber: current.revisionNumber,
    status: current.status,
    active: current.status === "submitted",
    sourceLocationId: current.sourceLocationId,
    destinationLocationId: current.destinationLocationId,
    destinationDepartmentId: current.destinationDepartmentId,
    periodStartDate: current.periodStartDate,
    periodEndDate: current.periodEndDate,
    timeKind: current.timeKind,
    startTime: current.startTime,
    endTime: current.endTime,
    requestedHeadcount: 1,
  };
}

function validateCreateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !INPUT_FIELDS.has(key))
    || typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,120}$/.test(input.idempotencyKey)
    || typeof input.sourceLocationId !== "string" || typeof input.destinationLocationId !== "string"
    || input.destinationDepartmentId != null && (!Number.isSafeInteger(input.destinationDepartmentId) || input.destinationDepartmentId < 1)) {
    throw failure(400, "STAFFING_RESERVATION_INVALID", "Bitte Quellfiliale, Zielfiliale und einen eindeutigen Zeitraum angeben.");
  }
}

async function storedReservation(repository, id, actor) {
  const request = isStaffingReservation(id) ? await repository.getRequest(id) : null;
  if (!request || request.createdByEmployeeNumber !== actor.employeeNumber) {
    throw failure(404, "STAFFING_RESERVATION_NOT_FOUND", "Die Filialreservierung wurde nicht gefunden.");
  }
  const current = await repository.getLatestRevision(id);
  if (!current) throw failure(404, "STAFFING_RESERVATION_NOT_FOUND", "Die Filialreservierung wurde nicht gefunden.");
  assertBranches(actor, current.sourceLocationId, current.destinationLocationId);
  return current;
}

function createStaffingReservations({ transaction, authorize, periodForLocation }) {
  return {
    capabilities(request) {
      return transaction(async repositories => {
        const actor = assertReservationActor(await authorize(request, repositories));
        const branches = wholeBranchScopes(actor);
        const locations = await repositories.organizationPersonnel.listLocations(false);
        return {
          version: 1,
          sourceApprovalRequired: true,
          absenceApprovalHold: "source_calendar_days",
          locationIds: locations.filter(location => location.active && branches.has(String(location.id)))
            .map(location => String(location.id)).sort(),
        };
      }, { readOnly: true });
    },
    create(request, input) {
      validateCreateInput(input);
      return transaction(async repositories => {
        const actor = assertReservationActor(await authorize(request, repositories));
        const source = input.sourceLocationId.trim();
        const destination = input.destinationLocationId.trim();
        assertBranches(actor, source, destination);

        // Ordinary GP submissions generate random UUIDs. Only this route can
        // create a request in the reservation ID namespace.
        const digest = createHash("sha256")
          .update(JSON.stringify([actor.employeeNumber, input.idempotencyKey])).digest("hex");
        const id = "staff-reservation-" + digest;
        const repository = repositories.staffAssignmentRequests;
        const existing = await repository.getLatestRevision(id);
        const organization = repositories.organizationPersonnel;
        const [locations, departments] = await Promise.all([
          organization.listLocations(false), organization.listDepartments(false),
        ]);
        const sourceLocation = locations.find(location => location.active && String(location.id) === source);
        const destinationLocation = locations.find(location => location.active && String(location.id) === destination);
        if (!existing && (!sourceLocation || !destinationLocation)) {
          throw failure(409, "STAFFING_RESERVATION_TOPOLOGY_CHANGED", "Quell- oder Zielfiliale ist nicht aktiv verfügbar.");
        }
        const eligibleDepartments = departments.filter(department =>
          department.active && String(department.location_id) === destination);
        const departmentId = input.destinationDepartmentId ?? existing?.destinationDepartmentId
          ?? (eligibleDepartments.length === 1 ? Number(eligibleDepartments[0].id) : null);
        if (!departmentId) {
          throw failure(400, "STAFFING_RESERVATION_DEPARTMENT_REQUIRED", "Bitte die Zielabteilung der Filiale angeben.");
        }
        const normalized = normalizeStaffAssignmentRequestInput({
          ...input,
          sourceLocationId: source,
          destinationLocationId: destination,
          destinationDepartmentId: departmentId,
          requestReason: input.requestReason ?? "Filialunterstützung angefragt",
        }, { requestStatus: "submitted" });

        if (existing) {
          const current = await storedReservation(repository, id, actor);
          const original = (await repository.listRevisions(id))[0];
          const same = Object.keys(normalized)
            .every(key => normalized[key] === original[key]);
          if (!same) {
            throw failure(409, "STAFFING_RESERVATION_KEY_CONFLICT", "Diese Vorgangsnummer gehört bereits zu einer anderen Reservierung.");
          }
          return { created: false, reservation: publicReservation(current) };
        }

        if (!eligibleDepartments.some(department => Number(department.id) === departmentId)) {
          throw failure(409, "STAFFING_RESERVATION_TOPOLOGY_CHANGED", "Quellfiliale, Zielfiliale oder Zielabteilung ist nicht aktiv verfügbar.");
        }
        const period = await periodForLocation(destinationLocation, repositories.planningSettings);
        if (normalized.periodStartDate < period.minimum || normalized.periodEndDate > period.maximum) {
          throw failure(409, "STAFFING_RESERVATION_PERIOD_OUT_OF_RANGE", "Der gewünschte Zeitraum liegt außerhalb der verfügbaren Einsatzplanung.");
        }
        let nextId = id;
        const history = await insertInitialStaffAssignmentRequestHistory(repository, normalized, actor.employeeNumber, {
          submit: true,
          idFactory: () => {
            const result = nextId;
            nextId = randomUUID();
            return result;
          },
        });
        const reservation = publicReservation(history.current);
        await organization.insertAudit(actor.employeeNumber, "staffing-reservation.create",
          "staff_assignment_request", id, JSON.stringify(reservation));
        return { created: true, reservation };
      }, { isolation: "serializable" });
    },
    read(request, id) {
      return transaction(async repositories => {
        const actor = assertReservationActor(await authorize(request, repositories));
        return publicReservation(await storedReservation(repositories.staffAssignmentRequests, id, actor));
      }, { readOnly: true });
    },
    release(request, id, input) {
      if (!input || Object.keys(input).length !== 1
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw failure(400, "STAFFING_RESERVATION_REVISION_INVALID", "Bitte die aktuelle Reservierungsrevision angeben.");
      }
      return transaction(async repositories => {
        const actor = assertReservationActor(await authorize(request, repositories));
        const repository = repositories.staffAssignmentRequests;
        const current = await storedReservation(repository, id, actor);
        if (current.status === "withdrawn" && current.revisionNumber === input.expectedRevision + 1) {
          return publicReservation(current);
        }
        if (current.status !== "submitted" || current.revisionNumber !== input.expectedRevision) {
          throw failure(409, "STAFFING_RESERVATION_CHANGED", "Die Reservierung wurde inzwischen geändert oder bereits entschieden.");
        }
        const updated = await transitionStaffAssignmentRequestHistory(
          repository, id, "withdrawn", {}, actor.employeeNumber, { expectedRevision: input.expectedRevision },
        );
        const reservation = publicReservation(updated.current);
        await repositories.organizationPersonnel.insertAudit(actor.employeeNumber, "staffing-reservation.release",
          "staff_assignment_request", id, JSON.stringify(reservation));
        return reservation;
      }, { isolation: "serializable" });
    },
  };
}

function findStaffingReservationConflict(repository, option, previous = null) {
  const retainsCoverage = previous && previous.optionType === option.optionType && previous.employeeNumber === option.employeeNumber
    && (Boolean(previous.allDay) || !option.allDay && previous.startTime <= option.startTime && previous.endTime >= option.endTime);
  return repository.findReservationConflict({
    employeeNumber: option.employeeNumber,
    locationId: option.locationId || "",
    dateFrom: option.dateFrom,
    dateTo: option.dateTo,
    retainedFrom: retainsCoverage ? previous.dateFrom : "",
    retainedTo: retainsCoverage ? previous.dateTo : "",
  });
}

async function assertStaffingReservationAllowsAbsence(repository, option, previous) {
  if (await findStaffingReservationConflict(repository, option, previous)) {
    throw failure(409, "STAFFING_RESERVATION_ABSENCE_HOLD",
      "Für diese Tage besteht in der Filiale eine Personalreservierung. Die Freigabe ist nach Aufhebung oder Entscheidung der Reservierung möglich.");
  }
}

function writeWeekOptionWithReservationCheck(repository, option, id = null) {
  const write = target => id === null ? target.insertWeekOption(option) : target.updateWeekOption({ id, ...option });
  if (!["vacation", "time_off"].includes(option.optionType)) return write(repository);
  const mutate = async (target) => {
    const row = id === null ? null : await target.getWeekOptionById({ id });
    const previous = row && {
      optionType: row.option_type, employeeNumber: row.employee_number,
      dateFrom: row.date_from, dateTo: row.date_to, allDay: row.all_day,
      startTime: row.start_time, endTime: row.end_time,
    };
    await assertStaffingReservationAllowsAbsence(target.staffAssignmentRequests, option, previous);
    return write(target);
  };
  return typeof repository.transaction === "function" ? repository.transaction(mutate) : mutate(repository);
}

function registerStaffingReservationRoutes(app, { assertCsrf, mapError, ...dependencies }) {
  const service = createStaffingReservations(dependencies);
  const run = handler => async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      throw mapError(error);
    }
  };
  app.get(PREFIX + "/capabilities", run(async (request, response) => response.json(await service.capabilities(request))));
  app.post(PREFIX, run(async (request, response) => {
    assertCsrf(request);
    const { created, reservation } = await service.create(request, request.body);
    response.status(created ? 201 : 200).json({ reservation });
  }));
  app.get(PREFIX + "/:reservationId", run(async (request, response) => {
    response.json({ reservation: await service.read(request, request.params.reservationId) });
  }));
  app.post(PREFIX + "/:reservationId/release", run(async (request, response) => {
    assertCsrf(request);
    const reservation = await service.release(request, request.params.reservationId, request.body);
    response.json({ reservation });
  }));
}

module.exports = {
  PREFIX, PERMISSION, assertStaffingReservationAllowsAbsence, assertReservationReviewer,
  createStaffingReservations, findStaffingReservationConflict, isStaffingReservation, registerStaffingReservationRoutes,
  writeWeekOptionWithReservationCheck,
};
