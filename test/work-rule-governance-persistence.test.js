"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createWorkRuleGovernanceRepository,
} = require("../lib/persistence/repositories/work-rule-governance");
const {
  SQLITE_CUSTOM_WORK_RULES_CATALOG,
} = require("../lib/persistence/sqlite/custom-work-rules-catalog");
const {
  SQLITE_WORK_RULE_GOVERNANCE_CATALOG,
} = require("../lib/persistence/sqlite/work-rule-governance-catalog");
const {
  ensureSqliteWorkRuleStoreSchema,
} = require("../lib/persistence/sqlite/operations/work-rule-store-schema");
const {
  createCustomWorkRuleDraft,
} = require("../lib/work-rules/custom-rules");
const {
  createWorkRuleReviewRequest,
  finalizeWorkRuleReviewRequest,
  listWorkRuleGovernance,
  previewWorkRuleGovernance,
  recordWorkRuleReviewDecision,
} = require("../lib/work-rules/governance");

function ensureGovernanceSchema(database) {
  ensureSqliteWorkRuleStoreSchema(database);
  database.exec(`
    CREATE TABLE work_rule_conflict_runs (
      id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      baseline_sha256 TEXT NOT NULL,
      outcome TEXT NOT NULL,
      result_json TEXT NOT NULL,
      result_sha256 TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL
    );
    CREATE TABLE work_rule_review_requests (
      id TEXT PRIMARY KEY,
      client_request_id TEXT NOT NULL UNIQUE,
      operation TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      basis_sha256 TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      risk_class TEXT NOT NULL,
      required_approvals INTEGER NOT NULL,
      required_fachlich_approvals INTEGER NOT NULL,
      conflict_run_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      source_reference TEXT NOT NULL,
      submitted_by TEXT NOT NULL,
      submitted_role TEXT NOT NULL,
      submitted_permission TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL
    );
    CREATE TABLE work_rule_review_decisions (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      permission_used TEXT NOT NULL,
      qualification TEXT NOT NULL,
      reason TEXT NOT NULL,
      request_receipt_sha256 TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      UNIQUE(request_id, actor_employee_number)
    );
    CREATE TABLE work_rule_publications (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      source_profile_version_id TEXT NOT NULL UNIQUE,
      released_profile_version_id TEXT NOT NULL UNIQUE,
      review_request_id TEXT NOT NULL UNIQUE,
      release_number INTEGER NOT NULL,
      semantic_sha256 TEXT NOT NULL,
      conflict_run_id TEXT NOT NULL,
      published_by TEXT NOT NULL,
      published_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL
    );
    CREATE TABLE work_rule_publication_events (
      id TEXT PRIMARY KEY,
      publication_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      effective_on TEXT NOT NULL,
      reason TEXT NOT NULL,
      review_request_id TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      permission_used TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      UNIQUE(publication_id, event_type, review_request_id)
    );
    CREATE TABLE work_rule_assignment_revisions (
      id TEXT PRIMARY KEY,
      logical_assignment_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      publication_id TEXT NOT NULL,
      profile_version_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      expanded_scopes_json TEXT NOT NULL,
      scope_sha256 TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      enforcement_mode TEXT NOT NULL,
      applicability_confirmed INTEGER NOT NULL,
      rationale TEXT NOT NULL,
      source_reference TEXT NOT NULL,
      supersedes_revision_id TEXT,
      review_request_id TEXT NOT NULL UNIQUE,
      conflict_run_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      UNIQUE(logical_assignment_id, revision)
    );
    CREATE TABLE work_rule_assignment_events (
      id TEXT PRIMARY KEY,
      assignment_revision_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      effective_on TEXT NOT NULL,
      reason TEXT NOT NULL,
      review_request_id TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      permission_used TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      UNIQUE(assignment_revision_id, event_type, review_request_id)
    );
    CREATE TABLE collective_agreement_assignment_events (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      effective_on TEXT NOT NULL,
      scope_snapshot_json TEXT NOT NULL,
      scope_sha256 TEXT NOT NULL,
      reason TEXT NOT NULL,
      review_request_id TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      permission_used TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      UNIQUE(assignment_id, event_type, review_request_id)
    );
    CREATE TABLE work_rule_governance_events (
      id TEXT PRIMARY KEY,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      sequence_no INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      previous_receipt_sha256 TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      permission_used TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      UNIQUE(aggregate_type, aggregate_id, sequence_no)
    );
  `);
}

function draftPayload(code) {
  return {
    code,
    title: "Dokumentierte Planungsgrenze",
    description: "Dokumentierte betriebliche Planungsgrenze fÃ¼r den Governance-Test.",
    ruleType: "company_rule",
    topic: "working_time",
    scopeType: "installation",
    scopeKey: "",
    validFrom: "2026-08-01",
    validTo: "",
    metric: "maximum_planned_daily_minutes",
    threshold: 480,
    severity: "warning",
    reaction: "advisory",
    message: "Die dokumentierte Planungsgrenze wurde Ã¼berschritten.",
    responsibleUnit: "Personalverwaltung",
    sourceTitle: "Interne Arbeitszeitregel",
    sourceReference: "BV-AZ-2026, Abschnitt 3",
    sourceUrl: "",
    sourceNote: "Freigabe erfolgt Ã¼ber den Governance-Workflow.",
    testCases: {
      positiveValue: 480,
      negativeValue: 481,
    },
  };
}

function actor(employeeNumber, qualification = "organisational") {
  return {
    employeeNumber,
    role: "hr",
    qualification,
    now: "2026-08-01T08:00:00.000Z",
  };
}


async function prepareApprovedRequest(fixture, clientRequestId) {
  const { draft, repository } = fixture;
  const operation = {
    operation: "publish_rule",
    subjectType: "work_rule_profile_version",
    subjectId: draft.currentVersionId,
    payload: {},
  };
  const preview = await previewWorkRuleGovernance(
    repository,
    operation,
    actor("SUBMIT-1"),
  );
  const request = await createWorkRuleReviewRequest(
    repository,
    {
      ...operation,
      clientRequestId,
      basisSha256: preview.basisSha256,
      conflictRunId: preview.conflictRunId,
      reason: "Die dokumentierte Regel soll fachlich freigegeben werden.",
      sourceReference: "Governance-Test 2026",
    },
    actor("SUBMIT-1"),
  );
  return recordWorkRuleReviewDecision(
    repository,
    request.id,
    {
      decision: "approve",
      reason: "Fachlich nachvollziehbar freigegeben.",
    },
    actor("REVIEW-1", "fachlich"),
  );
}

async function approveOperation(
  fixture,
  operation,
  clientRequestId,
  reviewers = [actor("REVIEW-1", "fachlich")],
) {
  const submitter = actor(`SUBMIT-${clientRequestId}`);
  const preview = await previewWorkRuleGovernance(
    fixture.repository,
    operation,
    submitter,
  );
  let request = await createWorkRuleReviewRequest(
    fixture.repository,
    {
      ...operation,
      clientRequestId,
      basisSha256: preview.basisSha256,
      conflictRunId: preview.conflictRunId,
      reason: "Die dokumentierte Operation soll kontrolliert freigegeben werden.",
      sourceReference: `Governance-Test ${clientRequestId}`,
    },
    submitter,
  );
  for (const reviewer of reviewers) {
    request = await recordWorkRuleReviewDecision(
      fixture.repository,
      request.id,
      {
        decision: "approve",
        reason: "Die dokumentierte Operation ist nachvollziehbar.",
      },
      reviewer,
    );
  }
  return request;
}

test("Regel-Governance: Fachmodul enthÃ¤lt weder Treiberzugriff noch SQL", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "lib", "work-rules", "governance.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /\bdb\b|\.prepare\s*\(|\.exec\s*\(/);
  assert.doesNotMatch(
    source,
    /\b(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/i,
  );
});
