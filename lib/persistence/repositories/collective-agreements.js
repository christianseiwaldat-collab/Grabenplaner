"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  COLLECTIVE_AGREEMENTS_STATEMENTS,
} = require("../statements/collective-agreements");

const REPOSITORIES = new WeakSet();
const SCOPE_TARGET_STATEMENTS = Object.freeze({
  cost_center: COLLECTIVE_AGREEMENTS_STATEMENTS.costCenterScopeTarget,
  location: COLLECTIVE_AGREEMENTS_STATEMENTS.locationScopeTarget,
  department: COLLECTIVE_AGREEMENTS_STATEMENTS.departmentScopeTarget,
});

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function requiredText(value, operation) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw invalidInput(operation);
  }
  return value;
}

function actorText(value, operation) {
  if (typeof value !== "string" || value.includes("\0")) throw invalidInput(operation);
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
    findAgreementByCode(code) {
      return access.queryOne(COLLECTIVE_AGREEMENTS_STATEMENTS.agreementByCode, {
        code: requiredText(code, "findAgreementByCode"),
      });
    },
    getAgreement(id) {
      return access.queryOne(COLLECTIVE_AGREEMENTS_STATEMENTS.agreementById, {
        id: requiredText(id, "getAgreement"),
      });
    },
    listAgreements() {
      return access.queryAll(COLLECTIVE_AGREEMENTS_STATEMENTS.listAgreements);
    },
    insertAgreement(agreement) {
      return access.execute(
        COLLECTIVE_AGREEMENTS_STATEMENTS.insertAgreement,
        requiredRecord(agreement, "insertAgreement"),
      );
    },
    getLinkedProfileVersion(id) {
      return access.queryOne(COLLECTIVE_AGREEMENTS_STATEMENTS.linkedProfileVersionById, {
        id: requiredText(id, "getLinkedProfileVersion"),
      });
    },
    findVersionByLabel(agreementId, versionLabel) {
      return access.queryOne(COLLECTIVE_AGREEMENTS_STATEMENTS.versionByLabel, {
        agreementId: requiredText(agreementId, "findVersionByLabel"),
        versionLabel: requiredText(versionLabel, "findVersionByLabel"),
      });
    },
    getVersionRange(id) {
      return access.queryOne(COLLECTIVE_AGREEMENTS_STATEMENTS.versionRangeById, {
        id: requiredText(id, "getVersionRange"),
      });
    },
    listVersions(agreementId = "") {
      if (!agreementId) {
        return access.queryAll(COLLECTIVE_AGREEMENTS_STATEMENTS.listVersions);
      }
      return access.queryAll(COLLECTIVE_AGREEMENTS_STATEMENTS.listVersionsByAgreement, {
        agreementId: requiredText(agreementId, "listVersions"),
      });
    },
    insertVersion(version) {
      return access.execute(
        COLLECTIVE_AGREEMENTS_STATEMENTS.insertVersion,
        requiredRecord(version, "insertVersion"),
      );
    },
    setCurrentVersion(agreementId, versionId, actor) {
      return access.execute(COLLECTIVE_AGREEMENTS_STATEMENTS.setCurrentVersion, {
        agreementId: requiredText(agreementId, "setCurrentVersion"),
        versionId: requiredText(versionId, "setCurrentVersion"),
        actor: actorText(actor, "setCurrentVersion"),
      });
    },
    findBusinessUnitByCode(code) {
      return access.queryOne(COLLECTIVE_AGREEMENTS_STATEMENTS.businessUnitByCode, {
        code: requiredText(code, "findBusinessUnitByCode"),
      });
    },
    getBusinessUnit(id) {
      return access.queryOne(COLLECTIVE_AGREEMENTS_STATEMENTS.businessUnitById, {
        id: requiredText(id, "getBusinessUnit"),
      });
    },
    getActiveBusinessUnit(id) {
      return access.queryOne(COLLECTIVE_AGREEMENTS_STATEMENTS.activeBusinessUnitById, {
        id: requiredText(id, "getActiveBusinessUnit"),
      });
    },
    listBusinessUnits(includeInactive = false) {
      if (typeof includeInactive !== "boolean") throw invalidInput("listBusinessUnits");
      return access.queryAll(includeInactive
        ? COLLECTIVE_AGREEMENTS_STATEMENTS.listBusinessUnits
        : COLLECTIVE_AGREEMENTS_STATEMENTS.listActiveBusinessUnits);
    },
    insertBusinessUnit(businessUnit) {
      return access.execute(
        COLLECTIVE_AGREEMENTS_STATEMENTS.insertBusinessUnit,
        requiredRecord(businessUnit, "insertBusinessUnit"),
      );
    },
    touchBusinessUnit(id, actor) {
      return access.execute(COLLECTIVE_AGREEMENTS_STATEMENTS.touchBusinessUnit, {
        id: requiredText(id, "touchBusinessUnit"),
        actor: actorText(actor, "touchBusinessUnit"),
      });
    },
    listBusinessUnitScopes(businessUnitId = "") {
      if (!businessUnitId) {
        return access.queryAll(COLLECTIVE_AGREEMENTS_STATEMENTS.listBusinessUnitScopes);
      }
      return access.queryAll(
        COLLECTIVE_AGREEMENTS_STATEMENTS.listBusinessUnitScopesByUnit,
        { businessUnitId: requiredText(businessUnitId, "listBusinessUnitScopes") },
      );
    },
    findActiveScopeOwner(scopeType, scopeKey) {
      return access.queryOne(COLLECTIVE_AGREEMENTS_STATEMENTS.activeScopeOwner, {
        scopeType: requiredText(scopeType, "findActiveScopeOwner"),
        scopeKey: requiredText(scopeKey, "findActiveScopeOwner"),
      });
    },
    getScopeTarget(scopeType, scopeKey) {
      const statement = SCOPE_TARGET_STATEMENTS[scopeType];
      if (!statement) throw invalidInput("getScopeTarget");
      return access.queryOne(statement, {
        scopeKey: requiredText(scopeKey, "getScopeTarget"),
      });
    },
    insertBusinessUnitScope(scope) {
      return access.execute(
        COLLECTIVE_AGREEMENTS_STATEMENTS.insertBusinessUnitScope,
        requiredRecord(scope, "insertBusinessUnitScope"),
      );
    },
    findPendingAssignment(assignment) {
      return access.queryOne(
        COLLECTIVE_AGREEMENTS_STATEMENTS.pendingAssignment,
        requiredRecord(assignment, "findPendingAssignment"),
      );
    },
    insertAssignment(assignment) {
      return access.execute(
        COLLECTIVE_AGREEMENTS_STATEMENTS.insertAssignment,
        requiredRecord(assignment, "insertAssignment"),
      );
    },
    getAssignment(id) {
      return access.queryOne(COLLECTIVE_AGREEMENTS_STATEMENTS.assignmentById, {
        id: requiredText(id, "getAssignment"),
      });
    },
    listAssignments() {
      return access.queryAll(COLLECTIVE_AGREEMENTS_STATEMENTS.listAssignments);
    },
    listAssignmentGovernanceEvents() {
      return access.queryAll(COLLECTIVE_AGREEMENTS_STATEMENTS.listAssignmentGovernanceEvents);
    },
  };
}

function createCollectiveAgreementsRepository(access) {
  assertPersistenceAccess(access);
  const methods = methodsFor(access);
  const repository = Object.freeze({
    ...methods,
    transaction(work) {
      if (typeof work !== "function" || typeof access.transaction !== "function") {
        throw invalidInput("transaction");
      }
      return access.transaction((executor) => {
        const transactionRepository = createCollectiveAgreementsRepository(executor);
        return work(transactionRepository);
      });
    },
  });
  REPOSITORIES.add(repository);
  return repository;
}

function assertCollectiveAgreementsRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new TypeError("Ein Collective-Agreements-Repository wird benötigt.");
  }
  return repository;
}

module.exports = {
  assertCollectiveAgreementsRepository,
  createCollectiveAgreementsRepository,
};
