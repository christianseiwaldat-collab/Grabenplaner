"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  PERSONNEL_LIFECYCLE_STATEMENTS: S,
} = require("../statements/personnel-lifecycle");

const REPOSITORIES = new WeakSet();

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function identifier(value, operation) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw invalidInput(operation);
  }
  return value.trim();
}

function record(value, operation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInput(operation);
  }
  return value;
}

function boolean(value, operation) {
  if (typeof value !== "boolean") throw invalidInput(operation);
  return value;
}

function safeInteger(value, operation, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidInput(operation);
  }
  return value;
}

function methodsFor(access) {
  return {
    getCandidate(id) {
      return access.queryOne(S.candidateById, { id: identifier(id, "getCandidate") });
    },
    listCandidates({ includeArchived = false, limit = 100, offset = 0 } = {}) {
      return access.queryAll(S.listCandidates, {
        includeArchived: boolean(includeArchived, "listCandidates"),
        limit: safeInteger(limit, "listCandidates", { minimum: 1, maximum: 1000 }),
        offset: safeInteger(offset, "listCandidates", { maximum: 1_000_000 }),
      });
    },
    listCandidateAccessHeaders({ includeArchived = false, limit = 100, offset = 0 } = {}) {
      return access.queryAll(S.listCandidateAccessHeaders, {
        includeArchived: boolean(includeArchived, "listCandidateAccessHeaders"),
        limit: safeInteger(limit, "listCandidateAccessHeaders", { minimum: 1, maximum: 1000 }),
        offset: safeInteger(offset, "listCandidateAccessHeaders", { maximum: 1_000_000 }),
      });
    },
    insertCandidate(candidate) {
      return access.execute(S.insertCandidate, record(candidate, "insertCandidate"));
    },
    updateCandidate(candidate) {
      return access.execute(S.updateCandidate, record(candidate, "updateCandidate"));
    },
    archiveCandidateForConversion(transition) {
      return access.execute(
        S.archiveCandidateForConversion,
        record(transition, "archiveCandidateForConversion"),
      );
    },
    getApplication(candidateId, id) {
      return access.queryOne(S.applicationById, {
        candidateId: identifier(candidateId, "getApplication"),
        id: identifier(id, "getApplication"),
      });
    },
    listApplications(candidateId) {
      return access.queryAll(S.listApplications, {
        candidateId: identifier(candidateId, "listApplications"),
      });
    },
    listApplicationAccessScopes(candidateId) {
      return access.queryAll(S.listApplicationAccessScopes, {
        candidateId: identifier(candidateId, "listApplicationAccessScopes"),
      });
    },
    insertApplication(application) {
      return access.execute(S.insertApplication, record(application, "insertApplication"));
    },
    updateApplication(application) {
      return access.execute(S.updateApplication, record(application, "updateApplication"));
    },
    updateApplicationStatus(transition) {
      return access.execute(
        S.updateApplicationStatus,
        record(transition, "updateApplicationStatus"),
      );
    },
    getConversionById(id) {
      return access.queryOne(S.conversionById, {
        id: identifier(id, "getConversionById"),
      });
    },
    getConversionForCandidate(candidateId) {
      return access.queryOne(S.conversionForCandidate, {
        candidateId: identifier(candidateId, "getConversionForCandidate"),
      });
    },
    insertConversion(conversion) {
      return access.execute(S.insertConversion, record(conversion, "insertConversion"));
    },
    listDocumentCategories({ activeOnly = true } = {}) {
      return access.queryAll(S.listDocumentCategories, {
        activeOnly: boolean(activeOnly, "listDocumentCategories"),
      });
    },
    getDocument(candidateId, id) {
      return access.queryOne(S.documentById, {
        candidateId: identifier(candidateId, "getDocument"),
        id: identifier(id, "getDocument"),
      });
    },
    listDocuments(candidateId) {
      return access.queryAll(S.listDocuments, {
        candidateId: identifier(candidateId, "listDocuments"),
      });
    },
    insertDocument(document) {
      return access.execute(S.insertDocument, record(document, "insertDocument"));
    },
    insertDocumentVersion(version) {
      return access.execute(
        S.insertDocumentVersion,
        record(version, "insertDocumentVersion"),
      );
    },
    listDocumentVersions(documentId) {
      return access.queryAll(S.listDocumentVersions, {
        documentId: identifier(documentId, "listDocumentVersions"),
      });
    },
    insertEvent(event) {
      return access.execute(S.insertEvent, record(event, "insertEvent"));
    },
    listEvents(candidateId) {
      return access.queryAll(S.listEvents, {
        candidateId: identifier(candidateId, "listEvents"),
      });
    },
  };
}

function createPersonnelLifecycleRepository(access) {
  assertPersistenceAccess(access);
  const repository = Object.freeze({
    ...methodsFor(access),
    transaction(work, options) {
      if (typeof work !== "function" || typeof access.transaction !== "function") {
        throw invalidInput("transaction");
      }
      return access.transaction((executor) => (
        work(createPersonnelLifecycleRepository(executor))
      ), options);
    },
  });
  REPOSITORIES.add(repository);
  return repository;
}

function assertPersonnelLifecycleRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new TypeError("Ein Personnel-Lifecycle-Repository wird benoetigt.");
  }
  return repository;
}

module.exports = {
  assertPersonnelLifecycleRepository,
  createPersonnelLifecycleRepository,
};
