"use strict";

const {
  WORK_RULE_GOVERNANCE_STATEMENTS,
} = require("../statements/work-rule-governance");

function jsonRow(columns) {
  return `json_object(${columns.map(([key, expression]) => (
    `'${key}', ${expression}`
  )).join(", ")})`;
}

function entry(statement, sql) {
  return Object.freeze({ statement, sql, returning: false });
}

const PROFILE_VERSION_ROW = [
  ["id", "v.id"],
  ["profile_id", "v.profile_id"],
  ["version", "v.version"],
  ["layer", "v.layer"],
  ["status", "v.status"],
  ["valid_from", "v.valid_from"],
  ["valid_to", "v.valid_to"],
  ["content_sha256", "v.content_sha256"],
  ["created_by", "v.created_by"],
  ["created_at", "v.created_at"],
  ["published_at", "v.published_at"],
  ["profile_status", "p.status"],
  ["current_version_id", "p.current_version_id"],
  ["profile_created_by", "p.created_by"],
];
const GOVERNANCE_EVENT_ROW = [
  ["id", "e.id"],
  ["aggregate_type", "e.aggregate_type"],
  ["aggregate_id", "e.aggregate_id"],
  ["sequence_no", "e.sequence_no"],
  ["event_type", "e.event_type"],
  ["payload_json", "e.payload_json"],
  ["payload_sha256", "e.payload_sha256"],
  ["previous_receipt_sha256", "e.previous_receipt_sha256"],
  ["actor_employee_number", "e.actor_employee_number"],
  ["actor_role", "e.actor_role"],
  ["permission_used", "e.permission_used"],
  ["correlation_id", "e.correlation_id"],
  ["occurred_at", "e.occurred_at"],
  ["receipt_sha256", "e.receipt_sha256"],
];
const PUBLICATION_EVENT_ROW = [
  ["id", "e.id"],
  ["publication_id", "e.publication_id"],
  ["event_type", "e.event_type"],
  ["effective_on", "e.effective_on"],
  ["reason", "e.reason"],
  ["review_request_id", "e.review_request_id"],
  ["actor_employee_number", "e.actor_employee_number"],
  ["actor_role", "e.actor_role"],
  ["permission_used", "e.permission_used"],
  ["occurred_at", "e.occurred_at"],
  ["receipt_sha256", "e.receipt_sha256"],
];
const ASSIGNMENT_EVENT_ROW = [
  ["id", "e.id"],
  ["assignment_revision_id", "e.assignment_revision_id"],
  ["event_type", "e.event_type"],
  ["effective_on", "e.effective_on"],
  ["reason", "e.reason"],
  ["review_request_id", "e.review_request_id"],
  ["actor_employee_number", "e.actor_employee_number"],
  ["actor_role", "e.actor_role"],
  ["permission_used", "e.permission_used"],
  ["occurred_at", "e.occurred_at"],
  ["receipt_sha256", "e.receipt_sha256"],
];
const ASSIGNMENT_REVISION_ROW = [
  ["id", "r.id"],
  ["logical_assignment_id", "r.logical_assignment_id"],
  ["revision", "r.revision"],
  ["publication_id", "r.publication_id"],
  ["profile_version_id", "r.profile_version_id"],
  ["scope_type", "r.scope_type"],
  ["scope_key", "r.scope_key"],
  ["expanded_scopes_json", "r.expanded_scopes_json"],
  ["scope_sha256", "r.scope_sha256"],
  ["valid_from", "r.valid_from"],
  ["valid_to", "r.valid_to"],
  ["enforcement_mode", "r.enforcement_mode"],
  ["applicability_confirmed", "r.applicability_confirmed"],
  ["rationale", "r.rationale"],
  ["source_reference", "r.source_reference"],
  ["supersedes_revision_id", "r.supersedes_revision_id"],
  ["review_request_id", "r.review_request_id"],
  ["conflict_run_id", "r.conflict_run_id"],
  ["created_by", "r.created_by"],
  ["created_at", "r.created_at"],
  ["receipt_sha256", "r.receipt_sha256"],
];
const COLLECTIVE_EVENT_ROW = [
  ["id", "e.id"],
  ["assignment_id", "e.assignment_id"],
  ["event_type", "e.event_type"],
  ["effective_on", "e.effective_on"],
  ["scope_snapshot_json", "e.scope_snapshot_json"],
  ["scope_sha256", "e.scope_sha256"],
  ["reason", "e.reason"],
  ["review_request_id", "e.review_request_id"],
  ["actor_employee_number", "e.actor_employee_number"],
  ["actor_role", "e.actor_role"],
  ["permission_used", "e.permission_used"],
  ["occurred_at", "e.occurred_at"],
  ["receipt_sha256", "e.receipt_sha256"],
];
const PUBLICATION_ROW = [
  ["id", "p.id"],
  ["profile_id", "p.profile_id"],
  ["source_profile_version_id", "p.source_profile_version_id"],
  ["released_profile_version_id", "p.released_profile_version_id"],
  ["review_request_id", "p.review_request_id"],
  ["release_number", "p.release_number"],
  ["semantic_sha256", "p.semantic_sha256"],
  ["conflict_run_id", "p.conflict_run_id"],
  ["published_by", "p.published_by"],
  ["published_at", "p.published_at"],
  ["receipt_sha256", "p.receipt_sha256"],
];
const CONFLICT_RUN_ROW = [
  ["id", "c.id"],
  ["operation", "c.operation"],
  ["subject_type", "c.subject_type"],
  ["subject_id", "c.subject_id"],
  ["baseline_sha256", "c.baseline_sha256"],
  ["outcome", "c.outcome"],
  ["result_json", "c.result_json"],
  ["result_sha256", "c.result_sha256"],
  ["created_by", "c.created_by"],
  ["created_at", "c.created_at"],
  ["receipt_sha256", "c.receipt_sha256"],
];
const REVIEW_REQUEST_ROW = [
  ["id", "r.id"],
  ["client_request_id", "r.client_request_id"],
  ["operation", "r.operation"],
  ["subject_type", "r.subject_type"],
  ["subject_id", "r.subject_id"],
  ["basis_sha256", "r.basis_sha256"],
  ["payload_json", "r.payload_json"],
  ["payload_sha256", "r.payload_sha256"],
  ["risk_class", "r.risk_class"],
  ["required_approvals", "r.required_approvals"],
  ["required_fachlich_approvals", "r.required_fachlich_approvals"],
  ["conflict_run_id", "r.conflict_run_id"],
  ["reason", "r.reason"],
  ["source_reference", "r.source_reference"],
  ["submitted_by", "r.submitted_by"],
  ["submitted_role", "r.submitted_role"],
  ["submitted_permission", "r.submitted_permission"],
  ["submitted_at", "r.submitted_at"],
  ["receipt_sha256", "r.receipt_sha256"],
];
const REVIEW_DECISION_ROW = [
  ["id", "d.id"],
  ["request_id", "d.request_id"],
  ["decision", "d.decision"],
  ["actor_employee_number", "d.actor_employee_number"],
  ["actor_role", "d.actor_role"],
  ["permission_used", "d.permission_used"],
  ["qualification", "d.qualification"],
  ["reason", "d.reason"],
  ["request_receipt_sha256", "d.request_receipt_sha256"],
  ["decided_at", "d.decided_at"],
  ["receipt_sha256", "d.receipt_sha256"],
];
const COLLECTIVE_ASSIGNMENT_ROW = [
  ["id", "a.id"],
  ["agreement_version_id", "a.agreement_version_id"],
  ["business_unit_id", "a.business_unit_id"],
  ["valid_from", "a.valid_from"],
  ["valid_to", "a.valid_to"],
  ["review_state", "a.review_state"],
  ["rationale", "a.rationale"],
  ["reference_note", "a.reference_note"],
  ["created_by", "a.created_by"],
  ["created_at", "a.created_at"],
  ["agreement_id", "v.agreement_id"],
  ["version_label", "v.version_label"],
  ["version_valid_from", "v.valid_from"],
  ["version_valid_to", "v.valid_to"],
  ["agreement_version_sha256", "v.content_sha256"],
  ["linked_profile_version_id", "v.linked_profile_version_id"],
  ["agreement_code", "c.code"],
  ["business_unit_code", "u.code"],
  ["business_unit_active", "u.active"],
];

const SQLITE_WORK_RULE_GOVERNANCE_CATALOG = Object.freeze([
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.schemaTables, `
    SELECT json_object('name', m.name) AS data
    FROM sqlite_master m
    WHERE m.type = 'table'
    ORDER BY m.name
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.profileVersion, `
    SELECT ${jsonRow(PROFILE_VERSION_ROW)} AS data
    FROM work_rule_profile_versions v
    JOIN work_rule_profiles p ON p.id = v.profile_id
    WHERE v.id = $id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.previousGovernanceEvent, `
    SELECT json_object(
      'sequence_no', e.sequence_no,
      'receipt_sha256', e.receipt_sha256
    ) AS data
    FROM work_rule_governance_events e
    WHERE e.aggregate_type = $aggregateType AND e.aggregate_id = $aggregateId
    ORDER BY e.sequence_no DESC
    LIMIT 1
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.insertGovernanceEvent, `
    INSERT INTO work_rule_governance_events
      (id, aggregate_type, aggregate_id, sequence_no, event_type,
       payload_json, payload_sha256, previous_receipt_sha256,
       actor_employee_number, actor_role, permission_used, correlation_id,
       occurred_at, receipt_sha256)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.aggregate_type'),
      json_extract($data, '$.aggregate_id'),
      json_extract($data, '$.sequence_no'),
      json_extract($data, '$.event_type'),
      json_extract($data, '$.payload_json'),
      json_extract($data, '$.payload_sha256'),
      json_extract($data, '$.previous_receipt_sha256'),
      json_extract($data, '$.actor_employee_number'),
      json_extract($data, '$.actor_role'),
      json_extract($data, '$.permission_used'),
      json_extract($data, '$.correlation_id'),
      json_extract($data, '$.occurred_at'),
      json_extract($data, '$.receipt_sha256')
    )
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.publicationEvents, `
    SELECT ${jsonRow(PUBLICATION_EVENT_ROW)} AS data
    FROM work_rule_publication_events e
    WHERE e.publication_id = $publicationId
    ORDER BY e.effective_on,
      CASE e.event_type
        WHEN 'published' THEN 0
        WHEN 'superseded' THEN 1
        WHEN 'withdrawn' THEN 2
        ELSE 3
      END,
      e.occurred_at, e.id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.assignmentEvents, `
    SELECT ${jsonRow(ASSIGNMENT_EVENT_ROW)} AS data
    FROM work_rule_assignment_events e
    WHERE e.assignment_revision_id = $revisionId
    ORDER BY e.effective_on, e.occurred_at, e.id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.assignmentRevisionsWithProfile, `
    SELECT ${jsonRow([
      ...ASSIGNMENT_REVISION_ROW,
      ["profile_id", "v.profile_id"],
      ["profile_name", "p.name"],
    ])} AS data
    FROM work_rule_assignment_revisions r
    JOIN work_rule_profile_versions v ON v.id = r.profile_version_id
    JOIN work_rule_profiles p ON p.id = v.profile_id
    ORDER BY r.logical_assignment_id, r.revision, r.id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.businessUnit, `
    SELECT json_object('id', u.id, 'active', u.active) AS data
    FROM collective_agreement_business_units u
    WHERE u.id = $id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.businessUnitScopes, `
    SELECT json_object(
      'scope_type', s.scope_type,
      'scope_key', s.scope_key
    ) AS data
    FROM collective_agreement_business_unit_scopes s
    WHERE s.business_unit_id = $businessUnitId
    ORDER BY s.scope_type, s.scope_key
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.activeLocation, `
    SELECT json_object('id', CAST(l.id AS TEXT)) AS data
    FROM locations l
    WHERE CAST(l.id AS TEXT) = $id AND l.active = 1
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.activeDepartment, `
    SELECT json_object('id', CAST(d.id AS TEXT)) AS data
    FROM departments d
    JOIN locations l ON l.id = d.location_id
    WHERE CAST(d.id AS TEXT) = $id AND d.active = 1 AND l.active = 1
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.activeEmployee, `
    SELECT json_object('id', e.personnel_number) AS data
    FROM employees e
    WHERE e.personnel_number = $id AND e.active = 1
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.collectiveAssignment, `
    SELECT ${jsonRow(COLLECTIVE_ASSIGNMENT_ROW)} AS data
    FROM collective_agreement_assignments a
    JOIN collective_agreement_versions v ON v.id = a.agreement_version_id
    JOIN collective_agreements c ON c.id = v.agreement_id
    JOIN collective_agreement_business_units u ON u.id = a.business_unit_id
    WHERE a.id = $id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.allCollectiveAssignmentEvents, `
    SELECT ${jsonRow(COLLECTIVE_EVENT_ROW)} AS data
    FROM collective_agreement_assignment_events e
    ORDER BY e.assignment_id, e.effective_on, e.occurred_at, e.id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.governedAssignmentConflictBasis, `
    SELECT ${jsonRow([
      ["id", "r.id"],
      ["logical_assignment_id", "r.logical_assignment_id"],
      ["revision", "r.revision"],
      ["profile_version_id", "r.profile_version_id"],
      ["scope_type", "r.scope_type"],
      ["scope_key", "r.scope_key"],
      ["scope_sha256", "r.scope_sha256"],
      ["valid_from", "r.valid_from"],
      ["valid_to", "r.valid_to"],
      ["enforcement_mode", "r.enforcement_mode"],
      ["receipt_sha256", "r.receipt_sha256"],
      ["event_receipts", "GROUP_CONCAT(e.receipt_sha256, ',')"],
    ])} AS data
    FROM work_rule_assignment_revisions r
    LEFT JOIN work_rule_assignment_events e ON e.assignment_revision_id = r.id
    GROUP BY r.id
    ORDER BY r.logical_assignment_id, r.revision, r.id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.legacyAssignments, `
    SELECT json_object(
      'id', a.id,
      'scope_type', a.scope_type,
      'scope_key', a.scope_key,
      'valid_from', a.valid_from,
      'valid_to', a.valid_to,
      'profile_id', v.profile_id
    ) AS data
    FROM work_rule_assignments a
    JOIN work_rule_profile_versions v ON v.id = a.profile_version_id
    WHERE a.active = 1 AND v.profile_id = $profileId
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.latestUnreleasedDraft, `
    SELECT json_object('id', v.id) AS data
    FROM work_rule_profile_versions v
    LEFT JOIN work_rule_publications p ON p.source_profile_version_id = v.id
    WHERE v.profile_id = $profileId
      AND v.status = 'draft'
      AND v.version LIKE 'draft-%'
      AND p.id IS NULL
    ORDER BY CAST(SUBSTR(v.version, 7) AS INTEGER) DESC, v.created_at DESC, v.id DESC
    LIMIT 1
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.publicationBySourceVersion, `
    SELECT ${jsonRow(PUBLICATION_ROW)} AS data
    FROM work_rule_publications p
    WHERE p.source_profile_version_id = $sourceProfileVersionId
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.releaseVersionCount, `
    SELECT json_object('count', COUNT(*)) AS data
    FROM work_rule_profile_versions v
    WHERE v.profile_id = $profileId AND v.version LIKE 'release-%'
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.publicationById, `
    SELECT ${jsonRow(PUBLICATION_ROW)} AS data
    FROM work_rule_publications p
    WHERE p.id = $id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.logicalAssignmentProfileIds, `
    SELECT json_object('profile_id', v.profile_id) AS data
    FROM (
      SELECT DISTINCT versions.profile_id
      FROM work_rule_assignment_revisions revisions
      JOIN work_rule_profile_versions versions
        ON versions.id = revisions.profile_version_id
      WHERE revisions.logical_assignment_id = $logicalAssignmentId
    ) v
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.assignmentRevisionWithProfile, `
    SELECT ${jsonRow([
      ...ASSIGNMENT_REVISION_ROW,
      ["profile_id", "v.profile_id"],
    ])} AS data
    FROM work_rule_assignment_revisions r
    JOIN work_rule_profile_versions v ON v.id = r.profile_version_id
    WHERE r.id = $id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.assignmentRevisionById, `
    SELECT ${jsonRow(ASSIGNMENT_REVISION_ROW)} AS data
    FROM work_rule_assignment_revisions r
    WHERE r.id = $id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.collectiveAssignmentEvents, `
    SELECT ${jsonRow(COLLECTIVE_EVENT_ROW)} AS data
    FROM collective_agreement_assignment_events e
    WHERE e.assignment_id = $assignmentId
    ORDER BY e.effective_on, e.occurred_at, e.id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.insertConflictRun, `
    INSERT INTO work_rule_conflict_runs
      (id, operation, subject_type, subject_id, baseline_sha256, outcome,
       result_json, result_sha256, created_by, created_at, receipt_sha256)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.operation'),
      json_extract($data, '$.subject_type'),
      json_extract($data, '$.subject_id'),
      json_extract($data, '$.baseline_sha256'),
      json_extract($data, '$.outcome'),
      json_extract($data, '$.result_json'),
      json_extract($data, '$.result_sha256'),
      json_extract($data, '$.created_by'),
      json_extract($data, '$.created_at'),
      json_extract($data, '$.receipt_sha256')
    )
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.reviewDecisions, `
    SELECT ${jsonRow(REVIEW_DECISION_ROW)} AS data
    FROM work_rule_review_decisions d
    WHERE d.request_id = $requestId
    ORDER BY d.decided_at, d.id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.reviewRequestByClientRequestId, `
    SELECT ${jsonRow(REVIEW_REQUEST_ROW)} AS data
    FROM work_rule_review_requests r
    WHERE r.client_request_id = $clientRequestId
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.submittedGovernanceEvent, `
    SELECT ${jsonRow(GOVERNANCE_EVENT_ROW)} AS data
    FROM work_rule_governance_events e
    WHERE e.aggregate_type = 'work_rule_review_request'
      AND e.aggregate_id = $aggregateId
      AND e.sequence_no = 1
      AND e.event_type = 'review_submitted'
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.conflictRunById, `
    SELECT ${jsonRow(CONFLICT_RUN_ROW)} AS data
    FROM work_rule_conflict_runs c
    WHERE c.id = $id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.insertReviewRequest, `
    INSERT INTO work_rule_review_requests
      (id, client_request_id, operation, subject_type, subject_id, basis_sha256,
       payload_json, payload_sha256, risk_class, required_approvals,
       required_fachlich_approvals, conflict_run_id, reason, source_reference,
       submitted_by, submitted_role, submitted_permission, submitted_at,
       receipt_sha256)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.client_request_id'),
      json_extract($data, '$.operation'),
      json_extract($data, '$.subject_type'),
      json_extract($data, '$.subject_id'),
      json_extract($data, '$.basis_sha256'),
      json_extract($data, '$.payload_json'),
      json_extract($data, '$.payload_sha256'),
      json_extract($data, '$.risk_class'),
      json_extract($data, '$.required_approvals'),
      json_extract($data, '$.required_fachlich_approvals'),
      json_extract($data, '$.conflict_run_id'),
      json_extract($data, '$.reason'),
      json_extract($data, '$.source_reference'),
      json_extract($data, '$.submitted_by'),
      json_extract($data, '$.submitted_role'),
      json_extract($data, '$.submitted_permission'),
      json_extract($data, '$.submitted_at'),
      json_extract($data, '$.receipt_sha256')
    )
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.reviewRequestById, `
    SELECT ${jsonRow(REVIEW_REQUEST_ROW)} AS data
    FROM work_rule_review_requests r
    WHERE r.id = $id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.reviewDecisionByActor, `
    SELECT ${jsonRow(REVIEW_DECISION_ROW)} AS data
    FROM work_rule_review_decisions d
    WHERE d.request_id = $requestId
      AND d.actor_employee_number = $actorEmployeeNumber
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.insertReviewDecision, `
    INSERT INTO work_rule_review_decisions
      (id, request_id, decision, actor_employee_number, actor_role,
       permission_used, qualification, reason, request_receipt_sha256,
       decided_at, receipt_sha256)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.request_id'),
      json_extract($data, '$.decision'),
      json_extract($data, '$.actor_employee_number'),
      json_extract($data, '$.actor_role'),
      json_extract($data, '$.permission_used'),
      json_extract($data, '$.qualification'),
      json_extract($data, '$.reason'),
      json_extract($data, '$.request_receipt_sha256'),
      json_extract($data, '$.decided_at'),
      json_extract($data, '$.receipt_sha256')
    )
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.insertPublicationEvent, `
    INSERT INTO work_rule_publication_events
      (id, publication_id, event_type, effective_on, reason, review_request_id,
       actor_employee_number, actor_role, permission_used, occurred_at, receipt_sha256)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.publication_id'),
      json_extract($data, '$.event_type'),
      json_extract($data, '$.effective_on'),
      json_extract($data, '$.reason'),
      json_extract($data, '$.review_request_id'),
      json_extract($data, '$.actor_employee_number'),
      json_extract($data, '$.actor_role'),
      json_extract($data, '$.permission_used'),
      json_extract($data, '$.occurred_at'),
      json_extract($data, '$.receipt_sha256')
    )
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.insertAssignmentEvent, `
    INSERT INTO work_rule_assignment_events
      (id, assignment_revision_id, event_type, effective_on, reason,
       review_request_id, actor_employee_number, actor_role, permission_used,
       occurred_at, receipt_sha256)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.assignment_revision_id'),
      json_extract($data, '$.event_type'),
      json_extract($data, '$.effective_on'),
      json_extract($data, '$.reason'),
      json_extract($data, '$.review_request_id'),
      json_extract($data, '$.actor_employee_number'),
      json_extract($data, '$.actor_role'),
      json_extract($data, '$.permission_used'),
      json_extract($data, '$.occurred_at'),
      json_extract($data, '$.receipt_sha256')
    )
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.insertCollectiveEvent, `
    INSERT INTO collective_agreement_assignment_events
      (id, assignment_id, event_type, effective_on, scope_snapshot_json,
       scope_sha256, reason, review_request_id, actor_employee_number,
       actor_role, permission_used, occurred_at, receipt_sha256)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.assignment_id'),
      json_extract($data, '$.event_type'),
      json_extract($data, '$.effective_on'),
      json_extract($data, '$.scope_snapshot_json'),
      json_extract($data, '$.scope_sha256'),
      json_extract($data, '$.reason'),
      json_extract($data, '$.review_request_id'),
      json_extract($data, '$.actor_employee_number'),
      json_extract($data, '$.actor_role'),
      json_extract($data, '$.permission_used'),
      json_extract($data, '$.occurred_at'),
      json_extract($data, '$.receipt_sha256')
    )
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.publicationByReviewRequest, `
    SELECT ${jsonRow(PUBLICATION_ROW)} AS data
    FROM work_rule_publications p
    WHERE p.review_request_id = $reviewRequestId
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.assignmentRevisionByReviewRequest, `
    SELECT ${jsonRow(ASSIGNMENT_REVISION_ROW)} AS data
    FROM work_rule_assignment_revisions r
    WHERE r.review_request_id = $reviewRequestId
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.deactivationAssignmentEventByReview, `
    SELECT ${jsonRow(ASSIGNMENT_EVENT_ROW)} AS data
    FROM work_rule_assignment_events e
    WHERE e.review_request_id = $reviewRequestId
      AND e.event_type = 'deactivated'
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.withdrawnPublicationEventByReview, `
    SELECT ${jsonRow(PUBLICATION_EVENT_ROW)} AS data
    FROM work_rule_publication_events e
    WHERE e.review_request_id = $reviewRequestId
      AND e.event_type = 'withdrawn'
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.deactivatedAssignmentEventsByReview, `
    SELECT ${jsonRow(ASSIGNMENT_EVENT_ROW)} AS data
    FROM work_rule_assignment_events e
    WHERE e.review_request_id = $reviewRequestId
      AND e.event_type = 'deactivated'
    ORDER BY e.assignment_revision_id, e.id
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.collectiveEventByReview, `
    SELECT ${jsonRow(COLLECTIVE_EVENT_ROW)} AS data
    FROM collective_agreement_assignment_events e
    WHERE e.review_request_id = $reviewRequestId
      AND e.event_type = $eventType
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.insertPublication, `
    INSERT INTO work_rule_publications
      (id, profile_id, source_profile_version_id, released_profile_version_id,
       review_request_id, release_number, semantic_sha256, conflict_run_id,
       published_by, published_at, receipt_sha256)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.profile_id'),
      json_extract($data, '$.source_profile_version_id'),
      json_extract($data, '$.released_profile_version_id'),
      json_extract($data, '$.review_request_id'),
      json_extract($data, '$.release_number'),
      json_extract($data, '$.semantic_sha256'),
      json_extract($data, '$.conflict_run_id'),
      json_extract($data, '$.published_by'),
      json_extract($data, '$.published_at'),
      json_extract($data, '$.receipt_sha256')
    )
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.maximumAssignmentRevision, `
    SELECT json_object(
      'revision',
      COALESCE(MAX(r.revision), 0)
    ) AS data
    FROM work_rule_assignment_revisions r
    WHERE r.logical_assignment_id = $logicalAssignmentId
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.insertAssignmentRevision, `
    INSERT INTO work_rule_assignment_revisions
      (id, logical_assignment_id, revision, publication_id, profile_version_id,
       scope_type, scope_key, expanded_scopes_json, scope_sha256, valid_from,
       valid_to, enforcement_mode, applicability_confirmed, rationale,
       source_reference, supersedes_revision_id, review_request_id,
       conflict_run_id, created_by, created_at, receipt_sha256)
    VALUES (
      json_extract($data, '$.id'),
      json_extract($data, '$.logical_assignment_id'),
      json_extract($data, '$.revision'),
      json_extract($data, '$.publication_id'),
      json_extract($data, '$.profile_version_id'),
      json_extract($data, '$.scope_type'),
      json_extract($data, '$.scope_key'),
      json_extract($data, '$.expanded_scopes_json'),
      json_extract($data, '$.scope_sha256'),
      json_extract($data, '$.valid_from'),
      json_extract($data, '$.valid_to'),
      json_extract($data, '$.enforcement_mode'),
      json_extract($data, '$.applicability_confirmed'),
      json_extract($data, '$.rationale'),
      json_extract($data, '$.source_reference'),
      json_extract($data, '$.supersedes_revision_id'),
      json_extract($data, '$.review_request_id'),
      json_extract($data, '$.conflict_run_id'),
      json_extract($data, '$.created_by'),
      json_extract($data, '$.created_at'),
      json_extract($data, '$.receipt_sha256')
    )
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.governanceEventsForReview, `
    SELECT ${jsonRow(GOVERNANCE_EVENT_ROW)} AS data
    FROM work_rule_governance_events e
    WHERE e.aggregate_type = 'work_rule_review_request'
      AND e.aggregate_id = $aggregateId
    ORDER BY e.sequence_no
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.listReviewRequests, `
    SELECT ${jsonRow(REVIEW_REQUEST_ROW)} AS data
    FROM work_rule_review_requests r
    ORDER BY r.submitted_at DESC, r.id DESC
    LIMIT $limit
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.listConflictRuns, `
    SELECT ${jsonRow(CONFLICT_RUN_ROW)} AS data
    FROM work_rule_conflict_runs c
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT $limit
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.listPublications, `
    SELECT ${jsonRow(PUBLICATION_ROW)} AS data
    FROM work_rule_publications p
    ORDER BY p.published_at DESC, p.id DESC
    LIMIT $limit
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.listAssignmentRevisions, `
    SELECT ${jsonRow(ASSIGNMENT_REVISION_ROW)} AS data
    FROM work_rule_assignment_revisions r
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT $limit
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.listCollectiveEvents, `
    SELECT ${jsonRow(COLLECTIVE_EVENT_ROW)} AS data
    FROM collective_agreement_assignment_events e
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT $limit
  `),
  entry(WORK_RULE_GOVERNANCE_STATEMENTS.listGovernanceEvents, `
    SELECT ${jsonRow(GOVERNANCE_EVENT_ROW)} AS data
    FROM work_rule_governance_events e
    ORDER BY e.aggregate_type, e.aggregate_id, e.sequence_no
  `),
]);

module.exports = {
  SQLITE_WORK_RULE_GOVERNANCE_CATALOG,
};
