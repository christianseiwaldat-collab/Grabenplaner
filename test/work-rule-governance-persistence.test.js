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
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
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

async function createFixture(code) {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: [
      ...SQLITE_CUSTOM_WORK_RULES_CATALOG,
      ...SQLITE_WORK_RULE_GOVERNANCE_CATALOG,
    ],
  });
  ensureGovernanceSchema(application.database);
  const repository = createWorkRuleGovernanceRepository(application.provider);
  const draft = await createCustomWorkRuleDraft(
    repository.customWorkRules,
    draftPayload(code),
    "AUTHOR-1",
  );
  return {
    ...application,
    draft,
    repository,
    async close() {
      await application.provider.close();
      application.database.close();
    },
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

test("Regel-Governance: Vorschau, Vier-Augen-Freigabe und Vollzug laufen providerneutral", async () => {
  const fixture = await createFixture("GOVERNANCE-PUBLISH");
  try {
    const approved = await prepareApprovedRequest(fixture, "client-request-1");
    assert.equal(approved.state, "approved");

    const result = await finalizeWorkRuleReviewRequest(
      fixture.repository,
      approved.id,
      {
        reason: "Freigaben geprÃ¼ft und kontrolliert vollzogen.",
        sourceReference: "Governance-Test 2026",
        basisSha256: approved.basisSha256,
      },
      actor("PUBLISH-1"),
    );
    assert.equal(result.idempotent, false);
    assert.equal(result.outcome.type, "publication");

    const registry = await listWorkRuleGovernance(fixture.repository);
    assert.equal(registry.publications.length, 1);
    assert.equal(registry.requests[0].state, "applied");
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS count
        FROM work_rule_profile_versions
        WHERE version LIKE 'release-%'
      `).get().count,
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("Regel-Governance: Publikation und Custom-Rule-Fassung rollen atomar zurÃ¼ck", async () => {
  const fixture = await createFixture("GOVERNANCE-ROLLBACK");
  try {
    const approved = await prepareApprovedRequest(fixture, "client-request-rollback");
    fixture.database.exec(`
      CREATE TRIGGER reject_governance_publication
      BEFORE INSERT ON work_rule_publications
      BEGIN
        SELECT RAISE(ABORT, 'forced publication failure');
      END;
    `);

    await assert.rejects(
      finalizeWorkRuleReviewRequest(
        fixture.repository,
        approved.id,
        {
          reason: "Dieser Vollzug wird kontrolliert zurÃ¼ckgerollt.",
          sourceReference: "Governance-Rollback-Test 2026",
          basisSha256: approved.basisSha256,
        },
        actor("PUBLISH-ROLLBACK"),
      ),
    );

    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS count
        FROM work_rule_profile_versions
        WHERE version LIKE 'release-%'
      `).get().count,
      0,
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT status
        FROM work_rule_profiles
        WHERE id = 'custom:GOVERNANCE-ROLLBACK'
      `).get().status,
      "draft",
    );
    assert.equal(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM work_rule_publications")
        .get().count,
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("Regel-Governance: Zuordnung, Deaktivierung und RÃ¼cknahme bewahren den Lebenszyklus", async () => {
  const fixture = await createFixture("GOVERNANCE-LIFECYCLE");
  try {
    const publicationRequest = await prepareApprovedRequest(
      fixture,
      "client-lifecycle-publication",
    );
    const publicationResult = await finalizeWorkRuleReviewRequest(
      fixture.repository,
      publicationRequest.id,
      {
        reason: "Die Regel wird fÃ¼r den Lebenszyklustest verÃ¶ffentlicht.",
        sourceReference: "Governance-Lebenszyklus 2026",
        basisSha256: publicationRequest.basisSha256,
      },
      actor("PUBLISH-LIFECYCLE"),
    );
    const publicationId = publicationResult.outcome.publication.id;

    const assignmentRequest = await approveOperation(
      fixture,
      {
        operation: "activate_assignment",
        subjectType: "work_rule_publication",
        subjectId: publicationId,
        payload: {
          scopeType: "installation",
          scopeKey: "",
          validFrom: "2026-08-01",
          effectiveOn: "2026-08-01",
          enforcementMode: "monitor",
          applicabilityConfirmed: true,
          rationale: "Kontrollierter Test der wirksamen Regelzuordnung.",
        },
      },
      "client-lifecycle-assignment",
    );
    const assignmentResult = await finalizeWorkRuleReviewRequest(
      fixture.repository,
      assignmentRequest.id,
      {
        reason: "Die dokumentierte Zuordnung wird kontrolliert aktiviert.",
        sourceReference: "Governance-Lebenszyklus 2026",
        basisSha256: assignmentRequest.basisSha256,
      },
      actor("PUBLISH-ASSIGNMENT"),
    );
    const assignmentId = assignmentResult.outcome.assignment.id;

    const criticalReviewers = [
      actor("REVIEW-FACHLICH", "fachlich"),
      actor("REVIEW-ORGANISATIONAL", "organisational"),
    ];
    const deactivationRequest = await approveOperation(
      fixture,
      {
        operation: "deactivate_assignment",
        subjectType: "work_rule_assignment_revision",
        subjectId: assignmentId,
        payload: { effectiveOn: "2026-08-02" },
      },
      "client-lifecycle-deactivation",
      criticalReviewers,
    );
    const deactivationResult = await finalizeWorkRuleReviewRequest(
      fixture.repository,
      deactivationRequest.id,
      {
        reason: "Die dokumentierte Zuordnung wird kontrolliert beendet.",
        sourceReference: "Governance-Lebenszyklus 2026",
        basisSha256: deactivationRequest.basisSha256,
      },
      actor("PUBLISH-DEACTIVATION"),
    );
    assert.equal(deactivationResult.outcome.type, "assignment_event");

    const withdrawalRequest = await approveOperation(
      fixture,
      {
        operation: "withdraw_publication",
        subjectType: "work_rule_publication",
        subjectId: publicationId,
        payload: { effectiveOn: "2026-08-03" },
      },
      "client-lifecycle-withdrawal",
      [
        actor("REVIEW-WITHDRAWAL-FACHLICH", "fachlich"),
        actor("REVIEW-WITHDRAWAL-ORG", "organisational"),
      ],
    );
    const withdrawalResult = await finalizeWorkRuleReviewRequest(
      fixture.repository,
      withdrawalRequest.id,
      {
        reason: "Die dokumentierte VerÃ¶ffentlichung wird kontrolliert beendet.",
        sourceReference: "Governance-Lebenszyklus 2026",
        basisSha256: withdrawalRequest.basisSha256,
      },
      actor("PUBLISH-WITHDRAWAL"),
    );
    assert.equal(withdrawalResult.outcome.type, "publication_event");

    const registry = await listWorkRuleGovernance(fixture.repository);
    assert.equal(registry.assignmentRevisions.length, 1);
    assert.equal(
      registry.assignmentRevisions[0].events.at(-1).eventType,
      "deactivated",
    );
    assert.equal(registry.publications[0].state, "withdrawn");
  } finally {
    await fixture.close();
  }
});

test("Regel-Governance: KV-Zuordnung wird mit Scope-Snapshot freigegeben und beendet", async () => {
  const fixture = await createFixture("GOVERNANCE-KV");
  try {
    fixture.database.exec(`
      CREATE TABLE collective_agreements (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL
      );
      CREATE TABLE collective_agreement_versions (
        id TEXT PRIMARY KEY,
        agreement_id TEXT NOT NULL,
        version_label TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        content_sha256 TEXT NOT NULL,
        linked_profile_version_id TEXT
      );
      CREATE TABLE collective_agreement_business_units (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        active INTEGER NOT NULL
      );
      CREATE TABLE collective_agreement_business_unit_scopes (
        id TEXT PRIMARY KEY,
        business_unit_id TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_key TEXT NOT NULL
      );
      CREATE TABLE collective_agreement_assignments (
        id TEXT PRIMARY KEY,
        agreement_version_id TEXT NOT NULL,
        business_unit_id TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        review_state TEXT NOT NULL,
        rationale TEXT NOT NULL,
        reference_note TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO collective_agreements (id, code)
      VALUES ('agreement-1', 'KV-TEST');
      INSERT INTO collective_agreement_versions (
        id, agreement_id, version_label, valid_from, valid_to,
        content_sha256, linked_profile_version_id
      )
      VALUES (
        'agreement-version-1', 'agreement-1', '2026', '2026-08-01', NULL,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NULL
      );
      INSERT INTO collective_agreement_business_units (id, code, active)
      VALUES ('business-unit-1', 'BU-1', 1);
      INSERT INTO collective_agreement_business_unit_scopes (
        id, business_unit_id, scope_type, scope_key
      )
      VALUES ('scope-1', 'business-unit-1', 'location', '18');
      INSERT INTO collective_agreement_assignments (
        id, agreement_version_id, business_unit_id, valid_from, valid_to,
        review_state, rationale, reference_note, created_by, created_at
      )
      VALUES (
        'kv-assignment-1', 'agreement-version-1', 'business-unit-1',
        '2026-08-01', NULL, 'review_pending',
        'Dokumentierte Testzuordnung', 'KV-Test 2026', 'KV-AUTHOR',
        '2026-08-01T07:00:00.000Z'
      );
    `);

    const reviewers = [
      actor("KV-REVIEW-FACHLICH", "fachlich"),
      actor("KV-REVIEW-ORG", "organisational"),
    ];
    const approvalRequest = await approveOperation(
      fixture,
      {
        operation: "approve_kv_assignment",
        subjectType: "collective_agreement_assignment",
        subjectId: "kv-assignment-1",
        payload: { effectiveOn: "2026-08-01" },
      },
      "client-kv-approval",
      reviewers,
    );
    const approval = await finalizeWorkRuleReviewRequest(
      fixture.repository,
      approvalRequest.id,
      {
        reason: "Die KV-Zuordnung wird kontrolliert freigegeben.",
        sourceReference: "KV-Governance-Test 2026",
        basisSha256: approvalRequest.basisSha256,
      },
      actor("KV-PUBLISH-APPROVAL"),
    );
    assert.equal(approval.outcome.event.event_type, "approved");

    const deactivationRequest = await approveOperation(
      fixture,
      {
        operation: "deactivate_kv_assignment",
        subjectType: "collective_agreement_assignment",
        subjectId: "kv-assignment-1",
        payload: { effectiveOn: "2026-08-02" },
      },
      "client-kv-deactivation",
      [
        actor("KV-DEACT-FACHLICH", "fachlich"),
        actor("KV-DEACT-ORG", "organisational"),
      ],
    );
    const deactivation = await finalizeWorkRuleReviewRequest(
      fixture.repository,
      deactivationRequest.id,
      {
        reason: "Die KV-Zuordnung wird kontrolliert beendet.",
        sourceReference: "KV-Governance-Test 2026",
        basisSha256: deactivationRequest.basisSha256,
      },
      actor("KV-PUBLISH-DEACTIVATION"),
    );
    assert.equal(deactivation.outcome.event.event_type, "deactivated");

    const registry = await listWorkRuleGovernance(fixture.repository);
    assert.deepEqual(
      registry.collectiveAgreementAssignments
        .map(({ eventType }) => eventType)
        .sort(),
      ["approved", "deactivated"],
    );
    assert.deepEqual(
      registry.collectiveAgreementAssignments[0].scopeSnapshot.scopes,
      [{ type: "location", key: "18" }],
    );
  } finally {
    await fixture.close();
  }
});
