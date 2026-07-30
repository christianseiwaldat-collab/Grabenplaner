"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  CUSTOM_WORK_RULE_STATEMENTS,
} = require("../statements/custom-work-rules");

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

function methodsFor(access) {
  return {
    getActiveBusinessUnit(id) {
      return access.queryOne(CUSTOM_WORK_RULE_STATEMENTS.getActiveBusinessUnit, {
        id: requiredText(id, "getActiveBusinessUnit"),
      });
    },
    getActiveLocation(id) {
      return access.queryOne(CUSTOM_WORK_RULE_STATEMENTS.getActiveLocation, {
        id: requiredText(id, "getActiveLocation"),
      });
    },
    getActiveDepartment(id) {
      return access.queryOne(CUSTOM_WORK_RULE_STATEMENTS.getActiveDepartment, {
        id: requiredText(id, "getActiveDepartment"),
      });
    },
    getProfileVersion(id) {
      return access.queryOne(CUSTOM_WORK_RULE_STATEMENTS.getProfileVersion, {
        id: requiredText(id, "getProfileVersion"),
      });
    },
    insertProfileVersion(version) {
      return access.execute(
        CUSTOM_WORK_RULE_STATEMENTS.insertProfileVersion,
        requiredRecord(version, "insertProfileVersion"),
      );
    },
    getProfileStatus(id) {
      return access.queryOne(CUSTOM_WORK_RULE_STATEMENTS.getProfileStatus, {
        id: requiredText(id, "getProfileStatus"),
      });
    },
    touchActiveProfile(id, updatedBy) {
      return access.execute(CUSTOM_WORK_RULE_STATEMENTS.touchActiveProfile, {
        id: requiredText(id, "touchActiveProfile"),
        updatedBy: String(updatedBy || ""),
      });
    },
    updateDraftProfile(profile) {
      return access.execute(
        CUSTOM_WORK_RULE_STATEMENTS.updateDraftProfile,
        requiredRecord(profile, "updateDraftProfile"),
      );
    },
    async profileExists(id) {
      const row = await access.queryOne(CUSTOM_WORK_RULE_STATEMENTS.profileExists, {
        id: requiredText(id, "profileExists"),
      });
      return row?.exists === true;
    },
    insertProfile(profile) {
      return access.execute(
        CUSTOM_WORK_RULE_STATEMENTS.insertProfile,
        requiredRecord(profile, "insertProfile"),
      );
    },
    getProfileForRevision(id) {
      return access.queryOne(CUSTOM_WORK_RULE_STATEMENTS.getProfileForRevision, {
        id: requiredText(id, "getProfileForRevision"),
      });
    },
    async countDraftVersions(profileId) {
      const row = await access.queryOne(CUSTOM_WORK_RULE_STATEMENTS.countDraftVersions, {
        profileId: requiredText(profileId, "countDraftVersions"),
      });
      return row?.count || 0;
    },
    getCustomProfile(id) {
      return access.queryOne(CUSTOM_WORK_RULE_STATEMENTS.getCustomProfile, {
        id: requiredText(id, "getCustomProfile"),
      });
    },
    listProfileVersionMetadata(profileId) {
      return access.queryAll(CUSTOM_WORK_RULE_STATEMENTS.listProfileVersionMetadata, {
        profileId: requiredText(profileId, "listProfileVersionMetadata"),
      });
    },
    async publicationRegistryAvailable() {
      const row = await access.queryOne(
        CUSTOM_WORK_RULE_STATEMENTS.publicationRegistryAvailable,
      );
      return row?.available === true;
    },
    listPublications(profileId) {
      return access.queryAll(CUSTOM_WORK_RULE_STATEMENTS.listPublications, {
        profileId: requiredText(profileId, "listPublications"),
      });
    },
    getVersionMetadata(id) {
      return access.queryOne(CUSTOM_WORK_RULE_STATEMENTS.getVersionMetadata, {
        id: requiredText(id, "getVersionMetadata"),
      });
    },
    async countReleaseVersions(profileId) {
      const row = await access.queryOne(CUSTOM_WORK_RULE_STATEMENTS.countReleaseVersions, {
        profileId: requiredText(profileId, "countReleaseVersions"),
      });
      return row?.count || 0;
    },
    activatePublishedProfile(profile) {
      return access.execute(
        CUSTOM_WORK_RULE_STATEMENTS.activatePublishedProfile,
        requiredRecord(profile, "activatePublishedProfile"),
      );
    },
    listCustomProfileIds() {
      return access.queryAll(CUSTOM_WORK_RULE_STATEMENTS.listCustomProfileIds);
    },
  };
}

function createCustomWorkRulesRepository(access) {
  assertPersistenceAccess(access);
  const repository = Object.freeze({
    ...methodsFor(access),
    ...(typeof access.transaction === "function" ? {
      transaction(work) {
        if (typeof work !== "function") throw invalidInput("transaction");
        return access.transaction((executor) => (
          work(createCustomWorkRulesRepository(executor))
        ));
      },
    } : {}),
  });
  REPOSITORIES.add(repository);
  return repository;
}

function assertCustomWorkRulesRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new TypeError("Ein Repository für eigene Arbeitszeitregeln wird benötigt.");
  }
  return repository;
}

module.exports = {
  assertCustomWorkRulesRepository,
  createCustomWorkRulesRepository,
};
