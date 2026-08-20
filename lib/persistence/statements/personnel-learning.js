"use strict";

const { definePersistenceStatement } = require("../contract");

const MODULE_COLUMNS = Object.freeze({
  id: "text",
  moduleCode: "text",
  moduleType: "text",
  receiptSha256: "text",
  createdBy: "text",
  createdAt: "text",
});

const VERSION_COLUMNS = Object.freeze({
  moduleId: "text",
  versionNumber: "safe_integer",
  title: "text",
  content: "json",
  contentSha256: "text",
  scopeType: "text",
  scopeLocationId: { kind: "text", nullable: true },
  scopeDepartmentId: { kind: "safe_integer", nullable: true },
  scopeSnapshot: "json",
  scopeSnapshotSha256: "text",
  previousReceiptSha256: "text",
  receiptSha256: "text",
  createdBy: "text",
  createdAt: "text",
});

const EVENT_COLUMNS = Object.freeze({
  id: "text",
  moduleId: "text",
  sequenceNumber: "safe_integer",
  eventType: "text",
  moduleVersionNumber: { kind: "safe_integer", nullable: true },
  eventPayload: "json",
  eventPayloadSha256: "text",
  previousReceiptSha256: "text",
  receiptSha256: "text",
  actorId: "text",
  occurredAt: "text",
});

const COMPETENCY_COLUMNS = Object.freeze({
  id: "text",
  employeeNumber: "text",
  skillModuleId: "text",
  receiptSha256: "text",
  createdBy: "text",
  createdAt: "text",
});

const COMPETENCY_REVISION_COLUMNS = Object.freeze({
  competencyId: "text",
  revisionNumber: "safe_integer",
  skillModuleId: "text",
  skillVersionNumber: "safe_integer",
  competencyLevel: "safe_integer",
  trainerAuthorized: "boolean",
  active: "boolean",
  changeType: "text",
  previousReceiptSha256: "text",
  receiptSha256: "text",
  changedBy: "text",
  changedAt: "text",
});

const ASSIGNMENT_COLUMNS = Object.freeze({
  id: "text",
  processModuleId: "text",
  learnerEmployeeNumber: "text",
  receiptSha256: "text",
  createdBy: "text",
  createdAt: "text",
});

const ASSIGNMENT_REVISION_COLUMNS = Object.freeze({
  assignmentId: "text",
  revisionNumber: "safe_integer",
  processModuleId: "text",
  processVersionNumber: "safe_integer",
  active: "boolean",
  trainerBindings: "json",
  trainerBindingsSha256: "text",
  changeType: "text",
  previousReceiptSha256: "text",
  receiptSha256: "text",
  changedBy: "text",
  changedAt: "text",
});

const PROGRESS_REVISION_COLUMNS = Object.freeze({
  assignmentId: "text",
  revisionNumber: "safe_integer",
  assignmentRevisionReceiptSha256: "text",
  processModuleId: "text",
  processVersionNumber: "safe_integer",
  stepStates: "json",
  stepStatesSha256: "text",
  totalStepCount: "safe_integer",
  completedStepCount: "safe_integer",
  requiredStepCount: "safe_integer",
  requiredCompletedCount: "safe_integer",
  finalized: "boolean",
  result: "text",
  assessmentNote: "text",
  changeType: "text",
  correctionReason: "text",
  previousReceiptSha256: "text",
  receiptSha256: "text",
  actorKind: "text",
  changedBy: "text",
  changedAt: "text",
});

const PERSONNEL_LEARNING_STATEMENTS = Object.freeze({
  listModules: definePersistenceStatement({
    id: "personnel-learning.module.list",
    operation: "queryAll",
    columns: MODULE_COLUMNS,
  }),
  getModule: definePersistenceStatement({
    id: "personnel-learning.module.get",
    operation: "queryOne",
    parameters: { moduleId: "text" },
    columns: MODULE_COLUMNS,
  }),
  insertModule: definePersistenceStatement({
    id: "personnel-learning.module.insert",
    operation: "execute",
    parameters: MODULE_COLUMNS,
  }),
  listVersions: definePersistenceStatement({
    id: "personnel-learning.version.list",
    operation: "queryAll",
    parameters: { moduleId: "text" },
    columns: VERSION_COLUMNS,
  }),
  getVersion: definePersistenceStatement({
    id: "personnel-learning.version.get",
    operation: "queryOne",
    parameters: { moduleId: "text", versionNumber: "safe_integer" },
    columns: VERSION_COLUMNS,
  }),
  getLatestVersion: definePersistenceStatement({
    id: "personnel-learning.version.get-latest",
    operation: "queryOne",
    parameters: { moduleId: "text" },
    columns: VERSION_COLUMNS,
  }),
  insertVersion: definePersistenceStatement({
    id: "personnel-learning.version.insert",
    operation: "execute",
    parameters: VERSION_COLUMNS,
  }),
  listEvents: definePersistenceStatement({
    id: "personnel-learning.event.list",
    operation: "queryAll",
    parameters: { moduleId: "text" },
    columns: EVENT_COLUMNS,
  }),
  getLatestEvent: definePersistenceStatement({
    id: "personnel-learning.event.get-latest",
    operation: "queryOne",
    parameters: { moduleId: "text" },
    columns: EVENT_COLUMNS,
  }),
  insertEvent: definePersistenceStatement({
    id: "personnel-learning.event.insert",
    operation: "execute",
    parameters: EVENT_COLUMNS,
  }),
  listCompetencies: definePersistenceStatement({
    id: "personnel-learning.competency.list",
    operation: "queryAll",
    columns: COMPETENCY_COLUMNS,
  }),
  getCompetency: definePersistenceStatement({
    id: "personnel-learning.competency.get",
    operation: "queryOne",
    parameters: { employeeNumber: "text", skillModuleId: "text" },
    columns: COMPETENCY_COLUMNS,
  }),
  insertCompetency: definePersistenceStatement({
    id: "personnel-learning.competency.insert",
    operation: "execute",
    parameters: COMPETENCY_COLUMNS,
  }),
  listCompetencyRevisions: definePersistenceStatement({
    id: "personnel-learning.competency-revision.list",
    operation: "queryAll",
    columns: COMPETENCY_REVISION_COLUMNS,
  }),
  getLatestCompetencyRevision: definePersistenceStatement({
    id: "personnel-learning.competency-revision.get-latest",
    operation: "queryOne",
    parameters: { competencyId: "text" },
    columns: COMPETENCY_REVISION_COLUMNS,
  }),
  insertCompetencyRevision: definePersistenceStatement({
    id: "personnel-learning.competency-revision.insert",
    operation: "execute",
    parameters: COMPETENCY_REVISION_COLUMNS,
  }),
  listAssignments: definePersistenceStatement({
    id: "personnel-learning.assignment.list",
    operation: "queryAll",
    columns: ASSIGNMENT_COLUMNS,
  }),
  getAssignment: definePersistenceStatement({
    id: "personnel-learning.assignment.get",
    operation: "queryOne",
    parameters: { assignmentId: "text" },
    columns: ASSIGNMENT_COLUMNS,
  }),
  getAssignmentForLearner: definePersistenceStatement({
    id: "personnel-learning.assignment.get-for-learner",
    operation: "queryOne",
    parameters: { processModuleId: "text", learnerEmployeeNumber: "text" },
    columns: ASSIGNMENT_COLUMNS,
  }),
  insertAssignment: definePersistenceStatement({
    id: "personnel-learning.assignment.insert",
    operation: "execute",
    parameters: ASSIGNMENT_COLUMNS,
  }),
  listAssignmentRevisions: definePersistenceStatement({
    id: "personnel-learning.assignment-revision.list",
    operation: "queryAll",
    columns: ASSIGNMENT_REVISION_COLUMNS,
  }),
  getLatestAssignmentRevision: definePersistenceStatement({
    id: "personnel-learning.assignment-revision.get-latest",
    operation: "queryOne",
    parameters: { assignmentId: "text" },
    columns: ASSIGNMENT_REVISION_COLUMNS,
  }),
  insertAssignmentRevision: definePersistenceStatement({
    id: "personnel-learning.assignment-revision.insert",
    operation: "execute",
    parameters: ASSIGNMENT_REVISION_COLUMNS,
  }),
  listProgressRevisions: definePersistenceStatement({
    id: "personnel-learning.progress-revision.list",
    operation: "queryAll",
    columns: PROGRESS_REVISION_COLUMNS,
  }),
  getLatestProgressRevision: definePersistenceStatement({
    id: "personnel-learning.progress-revision.get-latest",
    operation: "queryOne",
    parameters: { assignmentId: "text" },
    columns: PROGRESS_REVISION_COLUMNS,
  }),
  insertProgressRevision: definePersistenceStatement({
    id: "personnel-learning.progress-revision.insert",
    operation: "execute",
    parameters: PROGRESS_REVISION_COLUMNS,
  }),
});

module.exports = {
  PERSONNEL_LEARNING_STATEMENTS,
};
