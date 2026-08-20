"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  ABSENCE_MANAGEMENT_STATEMENTS,
  REQUEST_KINDS,
} = require("../statements/absence-management");
const {
  createWorkRuleStoreRepository,
} = require("./work-rule-store");

const REPOSITORIES = new WeakSet();

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function text(value, operation) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw invalidInput(operation);
  }
  return value;
}

function integer(value, operation) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidInput(operation);
  return value;
}

function record(value, operation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInput(operation);
  }
  return value;
}

function unwrap(row) {
  return row?.data || null;
}

function unwrapAll(rows) {
  return rows.map(({ data }) => data);
}

function methodsFor(access) {
  const one = async (statement, parameters) => unwrap(
    await access.queryOne(statement, parameters),
  );
  const all = async (statement, parameters) => unwrapAll(
    await access.queryAll(statement, parameters),
  );
  const oneRecord = (statement, data, operation) => one(statement, {
    data: record(data, operation),
  });
  const allRecord = (statement, data, operation) => all(statement, {
    data: record(data, operation),
  });
  const execute = async (statement, data, operation) => {
    const result = await access.execute(statement, {
      data: record(data, operation),
    });
    return Object.freeze({
      rowsAffected: result.rowsAffected,
      rows: unwrapAll(result.returnedRows),
    });
  };

  const methods = {
    listBlackouts: (activeOnly = false) => all(
      activeOnly
        ? ABSENCE_MANAGEMENT_STATEMENTS.listActiveBlackouts
        : ABSENCE_MANAGEMENT_STATEMENTS.listBlackouts,
    ),
    duplicateBlackout: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.duplicateBlackout,
      data,
      "duplicateBlackout",
    ),
    matchingBlackouts: (requestType, data) => allRecord(
      requestType === "time_off"
        ? ABSENCE_MANAGEMENT_STATEMENTS.matchingTimeOffBlackout
        : ABSENCE_MANAGEMENT_STATEMENTS.matchingVacationBlackout,
      data,
      "matchingBlackouts",
    ),
    blackoutById: (id) => one(
      ABSENCE_MANAGEMENT_STATEMENTS.blackoutById,
      { id: integer(id, "blackoutById") },
    ),
    insertBlackout: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.insertBlackout,
      data,
      "insertBlackout",
    ),
    updateBlackout: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.updateBlackout,
      data,
      "updateBlackout",
    ),
    deleteBlackout: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.deleteBlackout,
      data,
      "deleteBlackout",
    ),

    reviewerRecipients(stage, data = {}) {
      return stage === "hr"
        ? all(ABSENCE_MANAGEMENT_STATEMENTS.reviewersHr)
        : allRecord(
          ABSENCE_MANAGEMENT_STATEMENTS.reviewersLocal,
          data,
          "reviewerRecipients",
        );
    },
    insertNotification: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.insertNotification,
      data,
      "insertNotification",
    ),
    notificationByDedupe: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.notificationByDedupe,
      data,
      "notificationByDedupe",
    ),
    reactivateNotification: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.reactivateNotification,
      data,
      "reactivateNotification",
    ),
    resolveReviewNotifications(kind, id, stage = "") {
      return execute(
        stage
          ? ABSENCE_MANAGEMENT_STATEMENTS.resolveReviewNotificationsForStage
          : ABSENCE_MANAGEMENT_STATEMENTS.resolveReviewNotifications,
        { kind, id: String(id), stage },
        "resolveReviewNotifications",
      );
    },
    portalNotifications: (employeeNumber) => all(
      ABSENCE_MANAGEMENT_STATEMENTS.portalNotifications,
      { employeeNumber: text(employeeNumber, "portalNotifications") },
    ),
    portalUnreadCount: (employeeNumber) => one(
      ABSENCE_MANAGEMENT_STATEMENTS.portalUnreadCount,
      { employeeNumber: text(employeeNumber, "portalUnreadCount") },
    ),
    mobileNotifications: (data, unreadOnly = false) => allRecord(
      unreadOnly
        ? ABSENCE_MANAGEMENT_STATEMENTS.mobileUnreadNotifications
        : ABSENCE_MANAGEMENT_STATEMENTS.mobileNotifications,
      data,
      "mobileNotifications",
    ),
    mobileUnreadCount: (employeeNumber) => one(
      ABSENCE_MANAGEMENT_STATEMENTS.portalUnreadCount,
      { employeeNumber: text(employeeNumber, "mobileUnreadCount") },
    ),
    markNotificationRead: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.markNotificationRead,
      data,
      "markNotificationRead",
    ),
    markAllNotificationsRead: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.markAllNotificationsRead,
      data,
      "markAllNotificationsRead",
    ),

    insertRequestDecision: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.insertRequestDecision,
      data,
      "insertRequestDecision",
    ),
    requestDecisions: (data) => allRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.requestDecisions,
      data,
      "requestDecisions",
    ),
    insertAudit: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.insertAudit,
      data,
      "insertAudit",
    ),

    vacationHistory: (employeeNumber) => all(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationHistory,
      { employeeNumber: text(employeeNumber, "vacationHistory") },
    ),
    timeOffHistory: (employeeNumber) => all(
      ABSENCE_MANAGEMENT_STATEMENTS.timeOffHistory,
      { employeeNumber: text(employeeNumber, "timeOffHistory") },
    ),
    vacationChangeHistory: (employeeNumber) => all(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationChangeHistory,
      { employeeNumber: text(employeeNumber, "vacationChangeHistory") },
    ),
    timeOffChangeHistory: (employeeNumber) => all(
      ABSENCE_MANAGEMENT_STATEMENTS.timeOffChangeHistory,
      { employeeNumber: text(employeeNumber, "timeOffChangeHistory") },
    ),
    approvedTimeOff: (data) => allRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.approvedTimeOff,
      data,
      "approvedTimeOff",
    ),
    pendingTimeOffChanges: (employeeNumber) => all(
      ABSENCE_MANAGEMENT_STATEMENTS.pendingTimeOffChanges,
      { employeeNumber: text(employeeNumber, "pendingTimeOffChanges") },
    ),
    pendingVacationChanges: (employeeNumber) => all(
      ABSENCE_MANAGEMENT_STATEMENTS.pendingVacationChanges,
      { employeeNumber: text(employeeNumber, "pendingVacationChanges") },
    ),
    approvedVacationRows: (data) => allRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.approvedVacationRows,
      data,
      "approvedVacationRows",
    ),
    pendingAbsenceForLocation: (data) => allRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.pendingAbsenceForLocation,
      data,
      "pendingAbsenceForLocation",
    ),
    pendingTimeOffForRange: (data) => allRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.pendingTimeOffForRange,
      data,
      "pendingTimeOffForRange",
    ),
    vacationRequestSources: () => all(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationRequestSources,
    ),

    openVacationForOwner: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.openVacationForOwner,
      data,
      "openVacationForOwner",
    ),
    openTimeOffForOwner: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.openTimeOffForOwner,
      data,
      "openTimeOffForOwner",
    ),
    openVacationChangeForOwner: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.openVacationChangeForOwner,
      data,
      "openVacationChangeForOwner",
    ),
    openTimeOffChangeForOwner: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.openTimeOffChangeForOwner,
      data,
      "openTimeOffChangeForOwner",
    ),
    approvedTimeOffForOwner: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.approvedTimeOffForOwner,
      data,
      "approvedTimeOffForOwner",
    ),
    vacationOverlap: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationOverlap,
      data,
      "vacationOverlap",
    ),
    pendingVacationChange: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.pendingVacationChange,
      data,
      "pendingVacationChange",
    ),
    pendingTimeOffChange: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.pendingTimeOffChange,
      data,
      "pendingTimeOffChange",
    ),
    timeOffRangeOverlap: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.timeOffRangeOverlap,
      data,
      "timeOffRangeOverlap",
    ),
    timeOffPointOverlap: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.timeOffPointOverlap,
      data,
      "timeOffPointOverlap",
    ),

    insertVacationRequest: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.insertVacationRequest,
      data,
      "insertVacationRequest",
    ),
    insertTimeOffRequest: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.insertTimeOffRequest,
      data,
      "insertTimeOffRequest",
    ),
    insertVacationChange: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.insertVacationChange,
      data,
      "insertVacationChange",
    ),
    insertTimeOffChange: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.insertTimeOffChange,
      data,
      "insertTimeOffChange",
    ),
    updateVacationRequest: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.updateVacationRequest,
      data,
      "updateVacationRequest",
    ),
    updateTimeOffRequest: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.updateTimeOffRequest,
      data,
      "updateTimeOffRequest",
    ),
    withdrawVacationRequest: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.withdrawVacationRequest,
      data,
      "withdrawVacationRequest",
    ),
    withdrawTimeOffRequest: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.withdrawTimeOffRequest,
      data,
      "withdrawTimeOffRequest",
    ),
    withdrawVacationChange: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.withdrawVacationChange,
      data,
      "withdrawVacationChange",
    ),
    withdrawTimeOffChange: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.withdrawTimeOffChange,
      data,
      "withdrawTimeOffChange",
    ),

    employeeHomeLocation: (employeeNumber) => one(
      ABSENCE_MANAGEMENT_STATEMENTS.employeeHomeLocation,
      { employeeNumber: text(employeeNumber, "employeeHomeLocation") },
    ),
    employeeReviewScope: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.employeeReviewScope,
      data,
      "employeeReviewScope",
    ),
    activeEmployeeLendingsForRange: (data) => allRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.activeEmployeeLendingsForRange,
      data,
      "activeEmployeeLendingsForRange",
    ),
    locationTimeOffConfiguration: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.locationTimeOffConfiguration,
      data,
      "locationTimeOffConfiguration",
    ),

    vacationEmployeeContext: (employeeNumber) => one(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationEmployeeContext,
      { employeeNumber: text(employeeNumber, "vacationEmployeeContext") },
    ),
    vacationEntryEmployee: (employeeNumber) => one(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationEntryEmployee,
      { employeeNumber: text(employeeNumber, "vacationEntryEmployee") },
    ),
    vacationEntryOverlap: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationEntryOverlap,
      data,
      "vacationEntryOverlap",
    ),
    vacationEntryShiftConflict: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationEntryShiftConflict,
      data,
      "vacationEntryShiftConflict",
    ),
    vacationOptionsForDate: (date) => all(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationOptionsForDate,
      { date },
    ),
    vacationCapacityEmployees: (locationId) => all(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationCapacityEmployees,
      { locationId: text(locationId, "vacationCapacityEmployees") },
    ),
    vacationShiftsForDate: (data) => allRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationShiftsForDate,
      data,
      "vacationShiftsForDate",
    ),
    departmentStaffing: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.departmentStaffing,
      data,
      "departmentStaffing",
    ),
    plannedShiftOnDate: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.plannedShiftOnDate,
      data,
      "plannedShiftOnDate",
    ),
    timeOffOptionsOnDate: (data) => allRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.timeOffOptionsOnDate,
      data,
      "timeOffOptionsOnDate",
    ),
    coveringShift: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.coveringShift,
      data,
      "coveringShift",
    ),
    overlappingShift: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.overlappingShift,
      data,
      "overlappingShift",
    ),
    staffingAtLocation: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.staffingAtLocation,
      data,
      "staffingAtLocation",
    ),
    staffingAtDepartment: (data) => oneRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.staffingAtDepartment,
      data,
      "staffingAtDepartment",
    ),
    departmentById: (id) => one(
      ABSENCE_MANAGEMENT_STATEMENTS.departmentById,
      { id: integer(id, "departmentById") },
    ),
    shiftsForTimeOffRange: (data) => allRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.shiftsForTimeOffRange,
      data,
      "shiftsForTimeOffRange",
    ),
    shiftsForTimeOffPeriod: (data) => allRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.shiftsForTimeOffPeriod,
      data,
      "shiftsForTimeOffPeriod",
    ),
    shiftsWithinOriginalWindow: (data) => allRecord(
      ABSENCE_MANAGEMENT_STATEMENTS.shiftsWithinOriginalWindow,
      data,
      "shiftsWithinOriginalWindow",
    ),
    workRuleEvaluationEmployee: (employeeNumber) => one(
      ABSENCE_MANAGEMENT_STATEMENTS.workRuleEvaluationEmployee,
      { employeeNumber: text(employeeNumber, "workRuleEvaluationEmployee") },
    ),

    vacationRowsByNumericId: (id) => all(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationRowsByNumericId,
      { id: integer(id, "vacationRowsByNumericId") },
    ),
    vacationRowsByGroupId: (groupId) => all(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationRowsByGroupId,
      { groupId: text(groupId, "vacationRowsByGroupId") },
    ),
    vacationExistsByNumericId: (id) => one(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationExistsByNumericId,
      { id: integer(id, "vacationExistsByNumericId") },
    ),
    vacationExistsByGroupId: (groupId) => one(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationExistsByGroupId,
      { groupId: text(groupId, "vacationExistsByGroupId") },
    ),
    vacationEmployeeByGroupId: (groupId) => one(
      ABSENCE_MANAGEMENT_STATEMENTS.vacationEmployeeByGroupId,
      { groupId: text(groupId, "vacationEmployeeByGroupId") },
    ),
    insertVacationOption: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.insertVacationOption,
      data,
      "insertVacationOption",
    ),
    deleteVacationByNumericId: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.deleteVacationByNumericId,
      data,
      "deleteVacationByNumericId",
    ),
    deleteVacationByGroupId: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.deleteVacationByGroupId,
      data,
      "deleteVacationByGroupId",
    ),
    insertVacationHistory: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.insertVacationHistory,
      data,
      "insertVacationHistory",
    ),

    finalizeVacationRequest: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.finalizeVacationRequest,
      data,
      "finalizeVacationRequest",
    ),
    finalizeTimeOffRequest: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.finalizeTimeOffRequest,
      data,
      "finalizeTimeOffRequest",
    ),
    cancelOriginalTimeOff: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.cancelOriginalTimeOff,
      data,
      "cancelOriginalTimeOff",
    ),
    replaceOriginalTimeOff: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.replaceOriginalTimeOff,
      data,
      "replaceOriginalTimeOff",
    ),
    setOriginalTimeOffOption: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.setOriginalTimeOffOption,
      data,
      "setOriginalTimeOffOption",
    ),
    finalizeTimeOffChange: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.finalizeTimeOffChange,
      data,
      "finalizeTimeOffChange",
    ),
    finalizeVacationChange: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.finalizeVacationChange,
      data,
      "finalizeVacationChange",
    ),
    updateVacationRequestGroup: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.updateVacationRequestGroup,
      data,
      "updateVacationRequestGroup",
    ),
    cancelVacationRequestGroup: (data) => execute(
      ABSENCE_MANAGEMENT_STATEMENTS.cancelVacationRequestGroup,
      data,
      "cancelVacationRequestGroup",
    ),
  };

  for (const kind of REQUEST_KINDS) {
    methods[`requestById${kind[0].toUpperCase()}${kind.slice(1)}`] = (id) => one(
      ABSENCE_MANAGEMENT_STATEMENTS.requestById[kind],
      { id: integer(id, `requestById.${kind}`) },
    );
    methods[`reviewRequests${kind[0].toUpperCase()}${kind.slice(1)}`] = () => all(
      ABSENCE_MANAGEMENT_STATEMENTS.reviewRequests[kind],
    );
    for (const [transition, statement] of Object.entries(
      ABSENCE_MANAGEMENT_STATEMENTS.requestTransitions[kind],
    )) {
      methods[
        `transition${kind[0].toUpperCase()}${kind.slice(1)}${transition[0].toUpperCase()}${transition.slice(1)}`
      ] = (data) => execute(statement, data, `requestTransition.${kind}.${transition}`);
    }
  }
  return methods;
}

function createAbsenceManagementRepository(access) {
  assertPersistenceAccess(access);
  const repository = Object.freeze({
    ...methodsFor(access),
    workRules: createWorkRuleStoreRepository(access),
    ...(typeof access.transaction === "function" ? {
      transaction(work) {
        if (typeof work !== "function") throw invalidInput("transaction");
        return access.transaction((executor) => (
          work(createAbsenceManagementRepository(executor))
        ));
      },
    } : {}),
  });
  REPOSITORIES.add(repository);
  return repository;
}

function assertAbsenceManagementRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new TypeError("Ein Repository für Abwesenheiten wird benötigt.");
  }
  return repository;
}

module.exports = {
  assertAbsenceManagementRepository,
  createAbsenceManagementRepository,
};
