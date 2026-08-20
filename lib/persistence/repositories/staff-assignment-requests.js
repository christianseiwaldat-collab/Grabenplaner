"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  STAFF_ASSIGNMENT_REQUEST_STATEMENTS: S,
} = require("../statements/staff-assignment-requests");

const REPOSITORIES = new WeakSet();

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function requiredText(value, operation) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
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

function methodsFor(access) {
  return {
    listRequests() {
      return access.queryAll(S.listRequests, {});
    },
    getRequest(requestId) {
      return access.queryOne(S.getRequest, {
        requestId: requiredText(requestId, "getRequest"),
      });
    },
    insertRequest(request) {
      return access.execute(S.insertRequest, requiredRecord(request, "insertRequest"));
    },
    listRevisions(requestId) {
      return access.queryAll(S.listRevisions, {
        requestId: requiredText(requestId, "listRevisions"),
      });
    },
    getLatestRevision(requestId) {
      return access.queryOne(S.getLatestRevision, {
        requestId: requiredText(requestId, "getLatestRevision"),
      });
    },
    insertRevision(revision) {
      return access.execute(S.insertRevision, requiredRecord(revision, "insertRevision"));
    },
    listEvents(requestId) {
      return access.queryAll(S.listEvents, {
        requestId: requiredText(requestId, "listEvents"),
      });
    },
    getLatestEvent(requestId) {
      return access.queryOne(S.getLatestEvent, {
        requestId: requiredText(requestId, "getLatestEvent"),
      });
    },
    insertEvent(event) {
      return access.execute(S.insertEvent, requiredRecord(event, "insertEvent"));
    },
    insertBoundAssignment(assignment) {
      return access.execute(
        S.insertBoundAssignment,
        requiredRecord(assignment, "insertBoundAssignment"),
      );
    },
  };
}

function createStaffAssignmentRequestRepository(access) {
  assertPersistenceAccess(access);
  const repository = Object.freeze({
    ...methodsFor(access),
    ...(typeof access.transaction === "function" ? {
      transaction(work, options) {
        if (typeof work !== "function") throw invalidInput("transaction");
        return access.transaction(
          (executor) => work(createStaffAssignmentRequestRepository(executor)),
          options,
        );
      },
    } : {}),
  });
  REPOSITORIES.add(repository);
  return repository;
}

function assertStaffAssignmentRequestRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new TypeError("Ein Repository für standortübergreifende Einsatzanfragen wird benötigt.");
  }
  return repository;
}

module.exports = {
  assertStaffAssignmentRequestRepository,
  createStaffAssignmentRequestRepository,
};
