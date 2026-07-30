"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  WORK_RULE_GOVERNANCE_STATEMENTS,
} = require("../statements/work-rule-governance");
const {
  createCustomWorkRulesRepository,
} = require("./custom-work-rules");

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

function safeLimit(value, operation) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
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
  const queryOne = async (statement, parameters) => unwrap(
    await access.queryOne(statement, parameters),
  );
  const queryAll = async (statement, parameters) => unwrapAll(
    await access.queryAll(statement, parameters),
  );
  const execute = (statement, data, operation) => access.execute(statement, {
    data: requiredRecord(data, operation),
  });

  return {
    schemaTables: () => queryAll(WORK_RULE_GOVERNANCE_STATEMENTS.schemaTables),
    profileVersion: (id) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.profileVersion,
      { id: requiredText(id, "profileVersion") },
    ),
    previousGovernanceEvent: (aggregateType, aggregateId) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.previousGovernanceEvent,
      {
        aggregateType: requiredText(aggregateType, "previousGovernanceEvent"),
        aggregateId: requiredText(aggregateId, "previousGovernanceEvent"),
      },
    ),
    insertGovernanceEvent: (data) => execute(
      WORK_RULE_GOVERNANCE_STATEMENTS.insertGovernanceEvent,
      data,
      "insertGovernanceEvent",
    ),
    publicationEvents: (publicationId) => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.publicationEvents,
      { publicationId: requiredText(publicationId, "publicationEvents") },
    ),
    assignmentEvents: (revisionId) => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.assignmentEvents,
      { revisionId: requiredText(revisionId, "assignmentEvents") },
    ),
    assignmentRevisionsWithProfile: () => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.assignmentRevisionsWithProfile,
    ),
    businessUnit: (id) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.businessUnit,
      { id: requiredText(id, "businessUnit") },
    ),
    businessUnitScopes: (businessUnitId) => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.businessUnitScopes,
      { businessUnitId: requiredText(businessUnitId, "businessUnitScopes") },
    ),
    activeScopeTarget(scopeType, id) {
      const statement = {
        location: WORK_RULE_GOVERNANCE_STATEMENTS.activeLocation,
        department: WORK_RULE_GOVERNANCE_STATEMENTS.activeDepartment,
        employee: WORK_RULE_GOVERNANCE_STATEMENTS.activeEmployee,
      }[scopeType];
      if (!statement) throw invalidInput("activeScopeTarget");
      return queryOne(statement, { id: requiredText(id, "activeScopeTarget") });
    },
    collectiveAssignment: (id) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.collectiveAssignment,
      { id: requiredText(id, "collectiveAssignment") },
    ),
    allCollectiveAssignmentEvents: () => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.allCollectiveAssignmentEvents,
    ),
    governedAssignmentConflictBasis: () => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.governedAssignmentConflictBasis,
    ),
    legacyAssignments: (profileId) => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.legacyAssignments,
      { profileId: requiredText(profileId, "legacyAssignments") },
    ),
    latestUnreleasedDraft: (profileId) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.latestUnreleasedDraft,
      { profileId: requiredText(profileId, "latestUnreleasedDraft") },
    ),
    publicationBySourceVersion: (sourceProfileVersionId) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.publicationBySourceVersion,
      {
        sourceProfileVersionId: requiredText(
          sourceProfileVersionId,
          "publicationBySourceVersion",
        ),
      },
    ),
    releaseVersionCount: (profileId) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.releaseVersionCount,
      { profileId: requiredText(profileId, "releaseVersionCount") },
    ),
    publicationById: (id) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.publicationById,
      { id: requiredText(id, "publicationById") },
    ),
    logicalAssignmentProfileIds: (logicalAssignmentId) => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.logicalAssignmentProfileIds,
      {
        logicalAssignmentId: requiredText(
          logicalAssignmentId,
          "logicalAssignmentProfileIds",
        ),
      },
    ),
    assignmentRevisionWithProfile: (id) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.assignmentRevisionWithProfile,
      { id: requiredText(id, "assignmentRevisionWithProfile") },
    ),
    assignmentRevisionById: (id) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.assignmentRevisionById,
      { id: requiredText(id, "assignmentRevisionById") },
    ),
    collectiveAssignmentEvents: (assignmentId) => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.collectiveAssignmentEvents,
      { assignmentId: requiredText(assignmentId, "collectiveAssignmentEvents") },
    ),
    insertConflictRun: (data) => execute(
      WORK_RULE_GOVERNANCE_STATEMENTS.insertConflictRun,
      data,
      "insertConflictRun",
    ),
    reviewDecisions: (requestId) => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.reviewDecisions,
      { requestId: requiredText(requestId, "reviewDecisions") },
    ),
    reviewRequestByClientRequestId: (clientRequestId) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.reviewRequestByClientRequestId,
      { clientRequestId: requiredText(clientRequestId, "reviewRequestByClientRequestId") },
    ),
    submittedGovernanceEvent: (aggregateId) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.submittedGovernanceEvent,
      { aggregateId: requiredText(aggregateId, "submittedGovernanceEvent") },
    ),
    conflictRunById: (id) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.conflictRunById,
      { id: requiredText(id, "conflictRunById") },
    ),
    insertReviewRequest: (data) => execute(
      WORK_RULE_GOVERNANCE_STATEMENTS.insertReviewRequest,
      data,
      "insertReviewRequest",
    ),
    reviewRequestById: (id) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.reviewRequestById,
      { id: requiredText(id, "reviewRequestById") },
    ),
    reviewDecisionByActor: (requestId, actorEmployeeNumber) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.reviewDecisionByActor,
      {
        requestId: requiredText(requestId, "reviewDecisionByActor"),
        actorEmployeeNumber: requiredText(
          actorEmployeeNumber,
          "reviewDecisionByActor",
        ),
      },
    ),
    insertReviewDecision: (data) => execute(
      WORK_RULE_GOVERNANCE_STATEMENTS.insertReviewDecision,
      data,
      "insertReviewDecision",
    ),
    insertPublicationEvent: (data) => execute(
      WORK_RULE_GOVERNANCE_STATEMENTS.insertPublicationEvent,
      data,
      "insertPublicationEvent",
    ),
    insertAssignmentEvent: (data) => execute(
      WORK_RULE_GOVERNANCE_STATEMENTS.insertAssignmentEvent,
      data,
      "insertAssignmentEvent",
    ),
    insertCollectiveEvent: (data) => execute(
      WORK_RULE_GOVERNANCE_STATEMENTS.insertCollectiveEvent,
      data,
      "insertCollectiveEvent",
    ),
    publicationByReviewRequest: (reviewRequestId) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.publicationByReviewRequest,
      { reviewRequestId: requiredText(reviewRequestId, "publicationByReviewRequest") },
    ),
    assignmentRevisionByReviewRequest: (reviewRequestId) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.assignmentRevisionByReviewRequest,
      {
        reviewRequestId: requiredText(
          reviewRequestId,
          "assignmentRevisionByReviewRequest",
        ),
      },
    ),
    deactivationAssignmentEventByReview: (reviewRequestId) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.deactivationAssignmentEventByReview,
      {
        reviewRequestId: requiredText(
          reviewRequestId,
          "deactivationAssignmentEventByReview",
        ),
      },
    ),
    withdrawnPublicationEventByReview: (reviewRequestId) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.withdrawnPublicationEventByReview,
      {
        reviewRequestId: requiredText(
          reviewRequestId,
          "withdrawnPublicationEventByReview",
        ),
      },
    ),
    deactivatedAssignmentEventsByReview: (reviewRequestId) => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.deactivatedAssignmentEventsByReview,
      {
        reviewRequestId: requiredText(
          reviewRequestId,
          "deactivatedAssignmentEventsByReview",
        ),
      },
    ),
    collectiveEventByReview: (reviewRequestId, eventType) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.collectiveEventByReview,
      {
        reviewRequestId: requiredText(reviewRequestId, "collectiveEventByReview"),
        eventType: requiredText(eventType, "collectiveEventByReview"),
      },
    ),
    insertPublication: (data) => execute(
      WORK_RULE_GOVERNANCE_STATEMENTS.insertPublication,
      data,
      "insertPublication",
    ),
    maximumAssignmentRevision: (logicalAssignmentId) => queryOne(
      WORK_RULE_GOVERNANCE_STATEMENTS.maximumAssignmentRevision,
      {
        logicalAssignmentId: requiredText(
          logicalAssignmentId,
          "maximumAssignmentRevision",
        ),
      },
    ),
    insertAssignmentRevision: (data) => execute(
      WORK_RULE_GOVERNANCE_STATEMENTS.insertAssignmentRevision,
      data,
      "insertAssignmentRevision",
    ),
    governanceEventsForReview: (aggregateId) => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.governanceEventsForReview,
      { aggregateId: requiredText(aggregateId, "governanceEventsForReview") },
    ),
    listReviewRequests: (limit) => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.listReviewRequests,
      { limit: safeLimit(limit, "listReviewRequests") },
    ),
    listConflictRuns: (limit) => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.listConflictRuns,
      { limit: safeLimit(limit, "listConflictRuns") },
    ),
    listPublications: (limit) => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.listPublications,
      { limit: safeLimit(limit, "listPublications") },
    ),
    listAssignmentRevisions: (limit) => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.listAssignmentRevisions,
      { limit: safeLimit(limit, "listAssignmentRevisions") },
    ),
    listCollectiveEvents: (limit) => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.listCollectiveEvents,
      { limit: safeLimit(limit, "listCollectiveEvents") },
    ),
    listGovernanceEvents: () => queryAll(
      WORK_RULE_GOVERNANCE_STATEMENTS.listGovernanceEvents,
    ),
  };
}

function createWorkRuleGovernanceRepository(access) {
  assertPersistenceAccess(access);
  const repository = Object.freeze({
    ...methodsFor(access),
    customWorkRules: createCustomWorkRulesRepository(access),
    ...(typeof access.transaction === "function" ? {
      transaction(work) {
        if (typeof work !== "function") throw invalidInput("transaction");
        return access.transaction((executor) => (
          work(createWorkRuleGovernanceRepository(executor))
        ));
      },
    } : {}),
  });
  REPOSITORIES.add(repository);
  return repository;
}

function assertWorkRuleGovernanceRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new TypeError("Ein Repository fÃ¼r Regel-Governance wird benÃ¶tigt.");
  }
  return repository;
}

module.exports = {
  assertWorkRuleGovernanceRepository,
  createWorkRuleGovernanceRepository,
};
