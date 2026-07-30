"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  WORK_RULE_STORE_STATEMENTS,
} = require("../statements/work-rule-store");

const REPOSITORIES = new WeakSet();

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function requiredText(value, operation) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw invalidInput(operation);
  }
  return value;
}

function requiredRecord(value, operation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInput(operation);
  }
  return value;
}

function positiveSafeInteger(value, operation) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidInput(operation);
  return value;
}

function nonnegativeSafeInteger(value, operation) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidInput(operation);
  return value;
}

function methodsFor(access) {
  return {
    upsertBuiltinProfile(profile) {
      return access.execute(
        WORK_RULE_STORE_STATEMENTS.upsertBuiltinProfile,
        requiredRecord(profile, "upsertBuiltinProfile"),
      );
    },
    insertBuiltinProfileVersion(version) {
      return access.execute(
        WORK_RULE_STORE_STATEMENTS.insertBuiltinProfileVersion,
        requiredRecord(version, "insertBuiltinProfileVersion"),
      );
    },
    getProfileVersionHash(id) {
      return access.queryOne(WORK_RULE_STORE_STATEMENTS.getProfileVersionHash, {
        id: requiredText(id, "getProfileVersionHash"),
      });
    },
    insertBuiltinAssignment(assignment) {
      return access.execute(
        WORK_RULE_STORE_STATEMENTS.insertBuiltinAssignment,
        requiredRecord(assignment, "insertBuiltinAssignment"),
      );
    },
    listProfiles() {
      return access.queryAll(WORK_RULE_STORE_STATEMENTS.listProfiles);
    },
    getProfileVersion(id) {
      return access.queryOne(WORK_RULE_STORE_STATEMENTS.getProfileVersion, {
        id: requiredText(id, "getProfileVersion"),
      });
    },
    listAssignments(includeInactive = false) {
      if (typeof includeInactive !== "boolean") throw invalidInput("listAssignments");
      return access.queryAll(includeInactive
        ? WORK_RULE_STORE_STATEMENTS.listAllAssignments
        : WORK_RULE_STORE_STATEMENTS.listActiveAssignments);
    },
    getAssignment(id) {
      return access.queryOne(WORK_RULE_STORE_STATEMENTS.getAssignment, {
        id: requiredText(id, "getAssignment"),
      });
    },
    getAssignableProfileVersion(id) {
      return access.queryOne(WORK_RULE_STORE_STATEMENTS.getAssignableProfileVersion, {
        id: requiredText(id, "getAssignableProfileVersion"),
      });
    },
    insertAssignment(assignment) {
      return access.execute(
        WORK_RULE_STORE_STATEMENTS.insertAssignment,
        requiredRecord(assignment, "insertAssignment"),
      );
    },
    insertEvaluation(evaluation) {
      return access.execute(
        WORK_RULE_STORE_STATEMENTS.insertEvaluation,
        requiredRecord(evaluation, "insertEvaluation"),
      );
    },
    getEvaluation(id) {
      return access.queryOne(WORK_RULE_STORE_STATEMENTS.getEvaluation, {
        id: requiredText(id, "getEvaluation"),
      });
    },
    listEvaluations(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw invalidInput("listEvaluations");
      }
      return access.queryAll(WORK_RULE_STORE_STATEMENTS.listEvaluations, { limit });
    },
    insertPlanningShift(shift) {
      return access.execute(
        WORK_RULE_STORE_STATEMENTS.insertPlanningShift,
        requiredRecord(shift, "insertPlanningShift"),
      );
    },
    updatePlanningShift(shift) {
      return access.execute(
        WORK_RULE_STORE_STATEMENTS.updatePlanningShift,
        requiredRecord(shift, "updatePlanningShift"),
      );
    },
    deletePlanningShift(id) {
      return access.execute(WORK_RULE_STORE_STATEMENTS.deletePlanningShift, {
        id: positiveSafeInteger(id, "deletePlanningShift"),
      });
    },
    deletePlanningShiftsForRange({ locationId, departmentId = null, dateFrom, dateTo } = {}) {
      const values = {
        locationId,
        dateFrom,
        dateTo,
      };
      if (departmentId === null || departmentId === undefined) {
        return access.execute(
          WORK_RULE_STORE_STATEMENTS.deletePlanningShiftsForLocationRange,
          values,
        );
      }
      return access.execute(
        WORK_RULE_STORE_STATEMENTS.deletePlanningShiftsForDepartmentRange,
        {
          ...values,
          departmentId: positiveSafeInteger(
            Number(departmentId),
            "deletePlanningShiftsForRange",
          ),
        },
      );
    },
    invalidatePlanningDayReview(employeeNumber, workDate) {
      return access.execute(WORK_RULE_STORE_STATEMENTS.invalidatePlanningDayReview, {
        employeeNumber: requiredText(employeeNumber, "invalidatePlanningDayReview"),
        workDate,
      });
    },
    invalidatePlanningReviewsForRange({
      locationId,
      departmentId = null,
      dateFrom,
      dateTo,
    } = {}) {
      const values = {
        locationId,
        dateFrom,
        dateTo,
      };
      if (departmentId === null || departmentId === undefined) {
        return access.execute(
          WORK_RULE_STORE_STATEMENTS.invalidatePlanningLocationReviews,
          values,
        );
      }
      return access.execute(
        WORK_RULE_STORE_STATEMENTS.invalidatePlanningDepartmentReviews,
        {
          ...values,
          departmentId: positiveSafeInteger(
            Number(departmentId),
            "invalidatePlanningReviewsForRange",
          ),
        },
      );
    },
    updateTimeOffOriginalShifts(id, originalShifts) {
      return access.execute(WORK_RULE_STORE_STATEMENTS.updateTimeOffOriginalShifts, {
        id: positiveSafeInteger(id, "updateTimeOffOriginalShifts"),
        originalShifts,
      });
    },
    insertTimeOffOption(option) {
      return access.execute(
        WORK_RULE_STORE_STATEMENTS.insertTimeOffOption,
        requiredRecord(option, "insertTimeOffOption"),
      );
    },
    deleteTimeOffOptions({ groupId, optionId = 0 } = {}) {
      return access.execute(WORK_RULE_STORE_STATEMENTS.deleteTimeOffOptions, {
        groupId: requiredText(groupId, "deleteTimeOffOptions"),
        optionId: nonnegativeSafeInteger(Number(optionId), "deleteTimeOffOptions"),
      });
    },
    deletePlanningShiftsWithinWindow(window) {
      return access.execute(
        WORK_RULE_STORE_STATEMENTS.deletePlanningShiftsWithinWindow,
        requiredRecord(window, "deletePlanningShiftsWithinWindow"),
      );
    },
    listCollectiveAgreementProfileVersions() {
      return access.queryAll(WORK_RULE_STORE_STATEMENTS.listCollectiveAgreementProfileVersions);
    },
    listExceptions(state = "") {
      if (!state) return access.queryAll(WORK_RULE_STORE_STATEMENTS.listExceptions);
      return access.queryAll(WORK_RULE_STORE_STATEMENTS.listExceptionsByState, {
        state: requiredText(state, "listExceptions"),
      });
    },
    profileVersionExists(id) {
      return access.queryOne(WORK_RULE_STORE_STATEMENTS.profileVersionExists, {
        id: requiredText(id, "profileVersionExists"),
      }).then(Boolean);
    },
    insertException(exception) {
      return access.execute(
        WORK_RULE_STORE_STATEMENTS.insertException,
        requiredRecord(exception, "insertException"),
      );
    },
    getException(id) {
      return access.queryOne(WORK_RULE_STORE_STATEMENTS.getException, {
        id: requiredText(id, "getException"),
      });
    },
    revokeException(exception) {
      return access.execute(
        WORK_RULE_STORE_STATEMENTS.revokeException,
        requiredRecord(exception, "revokeException"),
      );
    },
  };
}

function createWorkRuleStoreRepository(access) {
  assertPersistenceAccess(access);
  const repository = Object.freeze({
    ...methodsFor(access),
    ...(typeof access.transaction === "function" ? {
      transaction(work) {
        if (typeof work !== "function") throw invalidInput("transaction");
        return access.transaction((executor) => (
          work(createWorkRuleStoreRepository(executor))
        ));
      },
    } : {}),
  });
  REPOSITORIES.add(repository);
  return repository;
}

function assertWorkRuleStoreRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new TypeError("Ein Arbeitszeitregel-Repository wird benötigt.");
  }
  return repository;
}

module.exports = {
  assertWorkRuleStoreRepository,
  createWorkRuleStoreRepository,
};
