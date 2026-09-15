"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  PERSONNEL_LEARNING_STATEMENTS: S,
} = require("../statements/personnel-learning");

const {S: R} = require("../statements/personnel-learning-runs");

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

function positiveInteger(value, operation) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw invalidInput(operation);
  return normalized;
}

function requiredRecord(value, operation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput(operation);
  return value;
}

function methodsFor(access) {
  return {
    listAllVersions() { return access.queryAll(R.listAllVersions,{}); },
    listAllEvents() { return access.queryAll(R.listAllEvents,{}); },
    listRequirements() { return access.queryAll(R.listRequirements,{}); },
    insertRequirement(row) { return access.execute(R.insertRequirement,requiredRecord(row,"insertRequirement")); },
    listTeamPeople(filters) { return access.queryAll(R.listTeamPeople,filters); },
    countTeamPeople(filters) { return access.queryOne(R.countTeamPeople,filters); },
    async teamData(employeeNumbers) { const names=["teamCompetencies","teamCompetencyRevisions","teamAssignments","teamAssignmentRevisions","teamProgressRevisions"]; const rows=await Promise.all(names.map(name=>access.queryAll(R[name],{employeeNumbers})));return Object.fromEntries(names.map((name,i)=>[name,rows[i]])); },
    listAssessmentRecords(assignmentId) { return access.queryAll(R.listAssessmentRecords,{assignmentId:requiredText(assignmentId,"listAssessmentRecords")}); },
    getAssessmentRecord(id) { return access.queryOne(R.getAssessmentRecord,{id:requiredText(id,"getAssessmentRecord")}); },
    insertAssessmentRecord(row) { return access.execute(R.insertAssessmentRecord,requiredRecord(row,"insertAssessmentRecord")); },
    listSchedules() { return access.queryAll(R.listSchedules, {}); },
    getSchedule(assignmentId) { return access.queryOne(R.getSchedule, {assignmentId:requiredText(assignmentId,"getSchedule")}); },
    insertSchedule(row) { return access.execute(R.insertSchedule, requiredRecord(row,"insertSchedule")); },
    listModules() {
      return access.queryAll(S.listModules, {});
    },
    getModule(moduleId) {
      return access.queryOne(S.getModule, {
        moduleId: requiredText(moduleId, "getModule"),
      });
    },
    insertModule(module) {
      return access.execute(S.insertModule, requiredRecord(module, "insertModule"));
    },
    listVersions(moduleId) {
      return access.queryAll(S.listVersions, {
        moduleId: requiredText(moduleId, "listVersions"),
      });
    },
    getVersion(moduleId, versionNumber) {
      return access.queryOne(S.getVersion, {
        moduleId: requiredText(moduleId, "getVersion"),
        versionNumber: positiveInteger(versionNumber, "getVersion"),
      });
    },
    getLatestVersion(moduleId) {
      return access.queryOne(S.getLatestVersion, {
        moduleId: requiredText(moduleId, "getLatestVersion"),
      });
    },
    insertVersion(version) {
      return access.execute(S.insertVersion, requiredRecord(version, "insertVersion"));
    },
    listEvents(moduleId) {
      return access.queryAll(S.listEvents, {
        moduleId: requiredText(moduleId, "listEvents"),
      });
    },
    getLatestEvent(moduleId) {
      return access.queryOne(S.getLatestEvent, {
        moduleId: requiredText(moduleId, "getLatestEvent"),
      });
    },
    insertEvent(event) {
      return access.execute(S.insertEvent, requiredRecord(event, "insertEvent"));
    },
    listCompetencies() {
      return access.queryAll(S.listCompetencies, {});
    },
    getCompetency(employeeNumber, skillModuleId) {
      return access.queryOne(S.getCompetency, {
        employeeNumber: requiredText(employeeNumber, "getCompetency"),
        skillModuleId: requiredText(skillModuleId, "getCompetency"),
      });
    },
    insertCompetency(competency) {
      return access.execute(
        S.insertCompetency,
        requiredRecord(competency, "insertCompetency"),
      );
    },
    listCompetencyRevisions() {
      return access.queryAll(S.listCompetencyRevisions, {});
    },
    getLatestCompetencyRevision(competencyId) {
      return access.queryOne(S.getLatestCompetencyRevision, {
        competencyId: requiredText(
          competencyId,
          "getLatestCompetencyRevision",
        ),
      });
    },
    insertCompetencyRevision(revision) {
      return access.execute(
        S.insertCompetencyRevision,
        requiredRecord(revision, "insertCompetencyRevision"),
      );
    },
    listAssignments() {
      return access.queryAll(R.listAssignments, {});
    },
    getAssignment(assignmentId) {
      return access.queryOne(R.getAssignment, {
        assignmentId: requiredText(assignmentId, "getAssignment"),
      });
    },
    getAssignmentForLearner(processModuleId, learnerEmployeeNumber) {
      return access.queryOne(R.getAssignmentForLearner, {
        processModuleId: requiredText(
          processModuleId,
          "getAssignmentForLearner",
        ),
        learnerEmployeeNumber: requiredText(
          learnerEmployeeNumber,
          "getAssignmentForLearner",
        ),
      });
    },
    insertAssignment(assignment) {
      return access.execute(
        String(assignment.id).startsWith("learning-run:") ? R.insertAssignment : S.insertAssignment,
        requiredRecord(assignment, "insertAssignment"),
      );
    },
    listAssignmentRevisions() {
      return access.queryAll(R.listAssignmentRevisions, {});
    },
    getLatestAssignmentRevision(assignmentId) {
      return access.queryOne(R.getLatestAssignmentRevision, {
        assignmentId: requiredText(
          assignmentId,
          "getLatestAssignmentRevision",
        ),
      });
    },
    insertAssignmentRevision(revision) {
      return access.execute(
        String(revision.assignmentId).startsWith("learning-run:") ? R.insertAssignmentRevision : S.insertAssignmentRevision,
        requiredRecord(revision, "insertAssignmentRevision"),
      );
    },
    listProgressRevisions() {
      return access.queryAll(R.listProgressRevisions, {});
    },
    getLatestProgressRevision(assignmentId) {
      return access.queryOne(R.getLatestProgressRevision, {
        assignmentId: requiredText(
          assignmentId,
          "getLatestProgressRevision",
        ),
      });
    },
    insertProgressRevision(revision) {
      return access.execute(
        String(revision.assignmentId).startsWith("learning-run:") ? R.insertProgressRevision : S.insertProgressRevision,
        requiredRecord(revision, "insertProgressRevision"),
      );
    },
  };
}

function createPersonnelLearningRepository(access) {
  assertPersistenceAccess(access);
  const repository = Object.freeze({
    ...methodsFor(access),
    ...(typeof access.transaction === "function" ? {
      transaction(work, options) {
        if (typeof work !== "function") throw invalidInput("transaction");
        return access.transaction(
          (executor) => work(createPersonnelLearningRepository(executor)),
          options,
        );
      },
    } : {}),
  });
  REPOSITORIES.add(repository);
  return repository;
}

function assertPersonnelLearningRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new TypeError("Ein Repository für Schulungs- und Wissensprozesse wird benötigt.");
  }
  return repository;
}

module.exports = {
  assertPersonnelLearningRepository,
  createPersonnelLearningRepository,
};
