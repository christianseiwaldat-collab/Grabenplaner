"use strict";

const { definePersistenceStatement } = require("../contract");

const DATA_ROW = Object.freeze({ data: "json" });
const RECORD_PARAMETER = Object.freeze({ data: "json" });

function queryOne(id, parameters = {}) {
  return definePersistenceStatement({
    id: `work-rule-governance.${id}`,
    operation: "queryOne",
    parameters,
    columns: DATA_ROW,
  });
}

function queryAll(id, parameters = {}) {
  return definePersistenceStatement({
    id: `work-rule-governance.${id}`,
    operation: "queryAll",
    parameters,
    columns: DATA_ROW,
  });
}

function execute(id) {
  return definePersistenceStatement({
    id: `work-rule-governance.${id}`,
    operation: "execute",
    parameters: RECORD_PARAMETER,
  });
}

const TEXT_ID = Object.freeze({ id: "text" });
const LIMIT = Object.freeze({ limit: "safe_integer" });

const WORK_RULE_GOVERNANCE_STATEMENTS = Object.freeze({
  schemaTables: queryAll("schema-tables"),
  profileVersion: queryOne("profile-version", TEXT_ID),
  previousGovernanceEvent: queryOne("previous-governance-event", {
    aggregateType: "text",
    aggregateId: "text",
  }),
  insertGovernanceEvent: execute("insert-governance-event"),
  publicationEvents: queryAll("publication-events", { publicationId: "text" }),
  assignmentEvents: queryAll("assignment-events", { revisionId: "text" }),
  assignmentRevisionsWithProfile: queryAll("assignment-revisions-with-profile"),
  businessUnit: queryOne("business-unit", TEXT_ID),
  businessUnitScopes: queryAll("business-unit-scopes", { businessUnitId: "text" }),
  activeLocation: queryOne("active-location", TEXT_ID),
  activeDepartment: queryOne("active-department", TEXT_ID),
  activeEmployee: queryOne("active-employee", TEXT_ID),
  collectiveAssignment: queryOne("collective-assignment", TEXT_ID),
  allCollectiveAssignmentEvents: queryAll("all-collective-assignment-events"),
  governedAssignmentConflictBasis: queryAll("governed-assignment-conflict-basis"),
  legacyAssignments: queryAll("legacy-assignments", { profileId: "text" }),
  latestUnreleasedDraft: queryOne("latest-unreleased-draft", { profileId: "text" }),
  publicationBySourceVersion: queryOne("publication-by-source-version", {
    sourceProfileVersionId: "text",
  }),
  releaseVersionCount: queryOne("release-version-count", { profileId: "text" }),
  publicationById: queryOne("publication-by-id", TEXT_ID),
  logicalAssignmentProfileIds: queryAll("logical-assignment-profile-ids", {
    logicalAssignmentId: "text",
  }),
  assignmentRevisionWithProfile: queryOne("assignment-revision-with-profile", TEXT_ID),
  assignmentRevisionById: queryOne("assignment-revision-by-id", TEXT_ID),
  collectiveAssignmentEvents: queryAll("collective-assignment-events", {
    assignmentId: "text",
  }),
  insertConflictRun: execute("insert-conflict-run"),
  reviewDecisions: queryAll("review-decisions", { requestId: "text" }),
  reviewRequestByClientRequestId: queryOne("review-request-by-client-request-id", {
    clientRequestId: "text",
  }),
  submittedGovernanceEvent: queryOne("submitted-governance-event", {
    aggregateId: "text",
  }),
  conflictRunById: queryOne("conflict-run-by-id", TEXT_ID),
  insertReviewRequest: execute("insert-review-request"),
  reviewRequestById: queryOne("review-request-by-id", TEXT_ID),
  reviewDecisionByActor: queryOne("review-decision-by-actor", {
    requestId: "text",
    actorEmployeeNumber: "text",
  }),
  insertReviewDecision: execute("insert-review-decision"),
  insertPublicationEvent: execute("insert-publication-event"),
  insertAssignmentEvent: execute("insert-assignment-event"),
  insertCollectiveEvent: execute("insert-collective-event"),
  publicationByReviewRequest: queryOne("publication-by-review-request", {
    reviewRequestId: "text",
  }),
  assignmentRevisionByReviewRequest: queryOne("assignment-revision-by-review-request", {
    reviewRequestId: "text",
  }),
  deactivationAssignmentEventByReview: queryOne("deactivation-assignment-event-by-review", {
    reviewRequestId: "text",
  }),
  withdrawnPublicationEventByReview: queryOne("withdrawn-publication-event-by-review", {
    reviewRequestId: "text",
  }),
  deactivatedAssignmentEventsByReview: queryAll("deactivated-assignment-events-by-review", {
    reviewRequestId: "text",
  }),
  collectiveEventByReview: queryOne("collective-event-by-review", {
    reviewRequestId: "text",
    eventType: "text",
  }),
  insertPublication: execute("insert-publication"),
  maximumAssignmentRevision: queryOne("maximum-assignment-revision", {
    logicalAssignmentId: "text",
  }),
  insertAssignmentRevision: execute("insert-assignment-revision"),
  governanceEventsForReview: queryAll("governance-events-for-review", {
    aggregateId: "text",
  }),
  listReviewRequests: queryAll("list-review-requests", LIMIT),
  listConflictRuns: queryAll("list-conflict-runs", LIMIT),
  listPublications: queryAll("list-publications", LIMIT),
  listAssignmentRevisions: queryAll("list-assignment-revisions", LIMIT),
  listCollectiveEvents: queryAll("list-collective-events", LIMIT),
  listGovernanceEvents: queryAll("list-governance-events"),
});

module.exports = {
  WORK_RULE_GOVERNANCE_STATEMENTS,
};
