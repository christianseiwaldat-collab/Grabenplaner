"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  normalizePortalBirthdayPresentationId,
} = require("../../portal-birthday-presentations");
const {
  PORTAL_BIRTHDAY_PRESENTATION_STATEMENTS: S,
} = require("../statements/portal-birthday-presentations");

const REPOSITORIES = new WeakSet();

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function strictRecord(value, keys, operation) {
  if (!isPlainRecord(value)
    || Object.keys(value).some((key) => !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(value, key))) {
    throw invalidInput(operation);
  }
  return value;
}

function employeeNumber(value, operation) {
  if (typeof value !== "string"
    || !value.trim()
    || value !== value.trim()
    || value.length > 120
    || value.includes("\0")) {
    throw invalidInput(operation);
  }
  return value;
}

function expectedRevision(value, operation, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw invalidInput(operation);
  return value;
}

function utcTimestamp(value, operation) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw invalidInput(operation);
  }
  try {
    if (new Date(value).toISOString() !== value) throw invalidInput(operation);
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw invalidInput(operation);
  }
  return value;
}

function presentationId(value, operation) {
  try {
    return normalizePortalBirthdayPresentationId(value);
  } catch {
    throw invalidInput(operation);
  }
}

function receiptSha256(value, operation) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw invalidInput(operation);
  }
  return value;
}

function claimPresentationId(value, operation) {
  const normalized = presentationId(value, operation);
  if (normalized === "off") throw invalidInput(operation);
  return normalized;
}

function eventYear(value, operation) {
  if (!Number.isSafeInteger(value) || value < 2000 || value > 9999) {
    throw invalidInput(operation);
  }
  return value;
}

function methodsFor(access) {
  return {
    getPolicy() {
      return access.queryOne(S.getPolicy, {});
    },
    updatePolicy(value) {
      const input = strictRecord(
        value,
        ["enabled", "expectedRevision", "updatedAt"],
        "updatePolicy",
      );
      if (typeof input.enabled !== "boolean") throw invalidInput("updatePolicy");
      return access.execute(S.updatePolicy, {
        enabled: input.enabled,
        expectedRevision: expectedRevision(input.expectedRevision, "updatePolicy"),
        updatedAt: utcTimestamp(input.updatedAt, "updatePolicy"),
      });
    },
    listAssignments() {
      return access.queryAll(S.listAssignments, {});
    },
    getAssignment(value) {
      return access.queryOne(S.getAssignment, {
        employeeNumber: employeeNumber(value, "getAssignment"),
      });
    },
    insertAssignment(value) {
      const input = strictRecord(
        value,
        ["employeeNumber", "presentationId", "updatedAt"],
        "insertAssignment",
      );
      return access.execute(S.insertAssignment, {
        employeeNumber: employeeNumber(input.employeeNumber, "insertAssignment"),
        presentationId: presentationId(input.presentationId, "insertAssignment"),
        updatedAt: utcTimestamp(input.updatedAt, "insertAssignment"),
      });
    },
    updateAssignment(value) {
      const input = strictRecord(
        value,
        ["employeeNumber", "presentationId", "expectedRevision", "updatedAt"],
        "updateAssignment",
      );
      return access.execute(S.updateAssignment, {
        employeeNumber: employeeNumber(input.employeeNumber, "updateAssignment"),
        presentationId: presentationId(input.presentationId, "updateAssignment"),
        expectedRevision: expectedRevision(input.expectedRevision, "updateAssignment"),
        updatedAt: utcTimestamp(input.updatedAt, "updateAssignment"),
      });
    },
    claimEvent(value) {
      const input = strictRecord(
        value,
        [
          "employeeNumber", "eventYear", "presentationId", "policyRevision",
          "assignmentRevision", "receiptSha256",
        ],
        "claimEvent",
      );
      return access.execute(S.claimEvent, {
        employeeNumber: employeeNumber(input.employeeNumber, "claimEvent"),
        eventYear: eventYear(input.eventYear, "claimEvent"),
        presentationId: claimPresentationId(input.presentationId, "claimEvent"),
        policyRevision: expectedRevision(input.policyRevision, "claimEvent"),
        assignmentRevision: expectedRevision(input.assignmentRevision, "claimEvent"),
        receiptSha256: receiptSha256(input.receiptSha256, "claimEvent"),
      });
    },
    listClaimsForEmployee(value) {
      return access.queryAll(S.listClaimsForEmployee, {
        employeeNumber: employeeNumber(value, "listClaimsForEmployee"),
      });
    },
  };
}

function createPortalBirthdayPresentationsRepository(access) {
  assertPersistenceAccess(access);
  const repository = Object.freeze({
    ...methodsFor(access),
    ...(typeof access.transaction === "function" ? {
      transaction(work, options) {
        if (typeof work !== "function") throw invalidInput("transaction");
        return access.transaction(
          (executor) => work(createPortalBirthdayPresentationsRepository(executor)),
          options,
        );
      },
    } : {}),
  });
  REPOSITORIES.add(repository);
  return repository;
}

function assertPortalBirthdayPresentationsRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new TypeError("Ein Repository für Portal-Geburtstagsdarstellungen wird benötigt.");
  }
  return repository;
}

module.exports = {
  assertPortalBirthdayPresentationsRepository,
  createPortalBirthdayPresentationsRepository,
};
