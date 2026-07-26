"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-block6-governance-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { app, db, releaseInstanceLockForTests } = subject;

const AUTHOR = "block6-author";
const REVIEWER_ONE = "block6-review-1";
const REVIEWER_TWO = "block6-review-2";
const VALID_FROM = "2032-01-01";
const SOURCE_REFERENCE = "BLOCK6-GOVERNANCE-TEST-2026";
const KV_VALID_FROM = "2020-01-01";
const KV_VALID_TO = "2020-12-31";
const KV_FUTURE_VALID_FROM = "2098-01-01";
const KV_FUTURE_VALID_TO = "2098-12-31";
const KV_SOURCE_REFERENCE = "BLOCK6-KV-GOVERNANCE-TEST-2026";

let httpServer;
let baseUrl;
let authorSession;
let reviewerOneSession;
let reviewerTwoSession;
let locationId;
let mainDraft;
let mainPublication;
let mainAssignment;
let collectiveAgreement;
let collectiveAgreementVersion;
let collectiveAgreementBusinessUnit;
let collectiveAgreementAssignment;

function createSession(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return {
    cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

function insertEmployee(personnelNumber, name, roleLocationId, costCenterId) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id, cost_center_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, 1)
  `).run(personnelNumber, name, name.split(" ")[0], roleLocationId, costCenterId || null);
}

async function request(route, {
  method = "GET",
  body,
  session = authorSession,
} = {}) {
  const headers = {
    Accept: "application/json",
    Cookie: session.cookie,
  };
  if (!["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { response, payload };
}

function mainRulePayload(overrides = {}) {
  return {
    code: "BLOCK6-MAIN",
    title: "Block 6 daily scheduling ceiling",
    description: "Versioned internal scheduling rule used to verify the complete governance lifecycle.",
    ruleType: "company_rule",
    topic: "working_time",
    scopeType: "location",
    scopeKey: locationId,
    validFrom: VALID_FROM,
    validTo: null,
    metric: "maximum_planned_daily_minutes",
    threshold: 480,
    severity: "critical",
    reaction: "block",
    message: "The planned daily working time exceeds the internally approved maximum.",
    responsibleUnit: "Personalleitung",
    sourceTitle: "Block 6 governance test source",
    sourceReference: SOURCE_REFERENCE,
    sourceUrl: "https://example.invalid/block6-governance",
    sourceNote: "Internal test fixture without legal assessment.",
    testCases: {
      positiveValue: 480,
      negativeValue: 481,
    },
    status: "draft",
    enforcementMode: "monitor",
    ...overrides,
  };
}

function collectiveAgreementVersionPayload(overrides = {}) {
  return {
    versionLabel: "2020",
    validFrom: KV_VALID_FROM,
    validTo: KV_VALID_TO,
    externalPublishedOn: "2019-12-15",
    sourceTitle: "Official Block 6 collective agreement test source",
    sourceUrl: "https://example.invalid/collective-agreement-2020.pdf",
    sourceRetrievedOn: "2026-07-26",
    sourceSha256: "c".repeat(64),
    sourceNote: "External source fixture; no copied agreement text and no legal assessment.",
    contractingParties: ["Employer test party", "Employee test party"],
    territorialScope: "Austria",
    functionalScope: "Block 6 integration scope",
    personalScope: "Employees assigned to the documented business unit",
    employeeGroups: ["Employees", "Apprentices"],
    workTimeParametersNote: "Only documented parameters with an external source may be linked.",
    classificationNote: "Classification remains a separate professional decision.",
    apprenticeRelevance: "yes",
    apprenticeNote: "Youth protection remains an additional statutory rule layer.",
    ...overrides,
  };
}

function governanceInput(operation, subjectType, subjectId, payload) {
  return {
    operation,
    subjectType,
    subjectId,
    payload,
  };
}

async function previewGovernance(input, session = authorSession) {
  const result = await request("/api/work-rules/governance/preview", {
    method: "POST",
    body: input,
    session,
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return result.payload.preview;
}

async function submitGovernance(input, preview, {
  session = authorSession,
  reason = "Independent governance review requested for the immutable test basis.",
  sourceReference = SOURCE_REFERENCE,
} = {}) {
  return request("/api/work-rules/governance/requests", {
    method: "POST",
    session,
    body: {
      ...input,
      clientRequestId: crypto.randomUUID(),
      basisSha256: preview.basisSha256,
      conflictRunId: preview.conflictRunId,
      reason,
      sourceReference,
    },
  });
}

async function decide(requestId, session, reason) {
  return request(
    `/api/work-rules/governance/requests/${encodeURIComponent(requestId)}/decisions`,
    {
      method: "POST",
      session,
      body: {
        decision: "approve",
        reason,
      },
    },
  );
}

async function finalize(requestId, basisSha256, session = authorSession) {
  return request(
    `/api/work-rules/governance/requests/${encodeURIComponent(requestId)}/finalize`,
    {
      method: "POST",
      session,
      body: {
        basisSha256,
        reason: "Apply the independently reviewed and checksum-bound governance operation.",
        sourceReference: SOURCE_REFERENCE,
      },
    },
  );
}

async function approveWithTwoReviewers(reviewRequest) {
  const first = await decide(
    reviewRequest.id,
    reviewerOneSession,
    "First independent professional review completed.",
  );
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.request.state, "in_review");
  assert.equal(first.payload.request.approvalCount, 1);
  assert.equal(first.payload.request.fachlichApprovalCount, 1);

  const premature = await finalize(reviewRequest.id, reviewRequest.basisSha256);
  assert.equal(premature.response.status, 409, JSON.stringify(premature.payload));
  assert.equal(premature.payload.code, "WORK_RULE_GOVERNANCE_APPROVALS_INCOMPLETE");

  const second = await decide(
    reviewRequest.id,
    reviewerTwoSession,
    "Second independent professional review completed.",
  );
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  assert.equal(second.payload.request.state, "approved");
  assert.equal(second.payload.request.approvalCount, 2);
  assert.equal(second.payload.request.fachlichApprovalCount, 2);
  return second.payload.request;
}

async function publishWithIndependentReview(draft, {
  warningCodes = [],
  expectedApprovals = 1,
} = {}) {
  const input = governanceInput(
    "publish_rule",
    "work_rule_profile_version",
    draft.currentVersionId,
    { effectiveOn: VALID_FROM },
  );
  const preview = await previewGovernance(input);
  assert.equal(preview.requiredApprovals, expectedApprovals);
  assert.equal(preview.requiredFachlichApprovals, 1);
  for (const code of warningCodes) {
    assert.ok(preview.result.warnings.some((entry) => entry.code === code), JSON.stringify(preview));
  }

  const submitted = await submitGovernance(input, preview);
  assert.equal(submitted.response.status, 201, JSON.stringify(submitted.payload));
  const reviewRequest = submitted.payload.request;

  if (expectedApprovals === 2) {
    await approveWithTwoReviewers(reviewRequest);
  } else {
    const approved = await decide(
      reviewRequest.id,
      reviewerOneSession,
      "Independent professional review completed.",
    );
    assert.equal(approved.response.status, 200, JSON.stringify(approved.payload));
    assert.equal(approved.payload.request.state, "approved");
    assert.equal(approved.payload.request.approvalCount, 1);
    assert.equal(approved.payload.request.fachlichApprovalCount, 1);
  }

  const applied = await finalize(reviewRequest.id, reviewRequest.basisSha256);
  assert.equal(applied.response.status, 200, JSON.stringify(applied.payload));
  assert.equal(applied.payload.result.request.state, "applied");
  assert.equal(applied.payload.result.outcome.type, "publication");
  return {
    preview,
    request: reviewRequest,
    publication: applied.payload.result.outcome.publication,
    governance: applied.payload.governance,
  };
}

test.before(async () => {
  const location = db.prepare(`
    SELECT id, cost_center_id
    FROM locations
    WHERE active = 1
    ORDER BY id
    LIMIT 1
  `).get();
  locationId = String(location.id);
  insertEmployee(AUTHOR, "Helena Rule Author", locationId, location.cost_center_id);
  insertEmployee(REVIEWER_ONE, "Rita Review One", locationId, location.cost_center_id);
  insertEmployee(REVIEWER_TWO, "Tanja Review Two", locationId, location.cost_center_id);
  authorSession = createSession(AUTHOR, "hr");
  reviewerOneSession = createSession(REVIEWER_ONE, "hr");
  reviewerTwoSession = createSession(REVIEWER_TWO, "hr");

  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try {
    db.close();
  } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
});

test("Block 6: critical publication rejects self-approval and requires two independent professional approvals", async () => {
  const created = await request("/api/work-rules/drafts", {
    method: "POST",
    body: mainRulePayload(),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  mainDraft = created.payload.draft;

  const input = governanceInput(
    "publish_rule",
    "work_rule_profile_version",
    mainDraft.currentVersionId,
    { effectiveOn: VALID_FROM },
  );
  const preview = await previewGovernance(input);
  assert.equal(preview.outcome, "pass");
  assert.equal(preview.riskClass, "critical");
  assert.equal(preview.requiredApprovals, 2);
  assert.equal(preview.requiredFachlichApprovals, 1);

  const submitted = await submitGovernance(input, preview);
  assert.equal(submitted.response.status, 201, JSON.stringify(submitted.payload));
  const reviewRequest = submitted.payload.request;
  assert.equal(reviewRequest.state, "in_review");
  assert.equal(reviewRequest.requiredApprovals, 2);

  const selfApproval = await decide(
    reviewRequest.id,
    authorSession,
    "The author must not approve this request.",
  );
  assert.equal(selfApproval.response.status, 403, JSON.stringify(selfApproval.payload));
  assert.equal(selfApproval.payload.code, "WORK_RULE_GOVERNANCE_SELF_APPROVAL");

  const approved = await approveWithTwoReviewers(reviewRequest);
  assert.deepEqual(
    approved.decisions.map((decision) => decision.actorEmployeeNumber).sort(),
    [REVIEWER_ONE, REVIEWER_TWO].sort(),
  );
  assert.ok(approved.decisions.every((decision) => decision.qualification === "fachlich"));

  const finalized = await finalize(reviewRequest.id, reviewRequest.basisSha256);
  assert.equal(finalized.response.status, 200, JSON.stringify(finalized.payload));
  assert.equal(finalized.payload.result.request.state, "applied");
  assert.equal(finalized.payload.result.outcome.type, "publication");
  mainPublication = finalized.payload.result.outcome.publication;
  assert.equal(mainPublication.source_profile_version_id, mainDraft.currentVersionId);
  assert.match(mainPublication.released_profile_version_id, /@release-1$/);
  assert.notEqual(mainPublication.released_profile_version_id, mainDraft.currentVersionId);
});

test("Block 6: activation requires confirmed applicability and enforced mode requires two approvals", async () => {
  const unconfirmedInput = governanceInput(
    "activate_assignment",
    "work_rule_publication",
    mainPublication.id,
    {
      logicalAssignmentId: "block6-main-assignment",
      scopeType: "location",
      scopeKey: locationId,
      validFrom: VALID_FROM,
      validTo: null,
      effectiveOn: VALID_FROM,
      enforcementMode: "enforced",
      applicabilityConfirmed: false,
      rationale: "Applicability deliberately omitted for the negative integration case.",
      sourceReference: SOURCE_REFERENCE,
    },
  );
  const unconfirmedPreview = await previewGovernance(unconfirmedInput);
  assert.equal(unconfirmedPreview.outcome, "blocked");
  assert.ok(unconfirmedPreview.result.blockers.some((entry) => (
    entry.code === "APPLICABILITY_NOT_CONFIRMED"
  )), JSON.stringify(unconfirmedPreview));
  const unconfirmedSubmit = await submitGovernance(unconfirmedInput, unconfirmedPreview);
  assert.equal(unconfirmedSubmit.response.status, 409, JSON.stringify(unconfirmedSubmit.payload));
  assert.equal(unconfirmedSubmit.payload.code, "WORK_RULE_GOVERNANCE_CONFLICT_BLOCKED");

  const activationInput = {
    ...unconfirmedInput,
    payload: {
      ...unconfirmedInput.payload,
      applicabilityConfirmed: true,
      rationale: "Applicability was independently confirmed for the selected location.",
    },
  };
  const activationPreview = await previewGovernance(activationInput);
  assert.equal(activationPreview.outcome, "pass");
  assert.equal(activationPreview.riskClass, "critical");
  assert.equal(activationPreview.requiredApprovals, 2);
  assert.equal(activationPreview.requiredFachlichApprovals, 1);

  const submitted = await submitGovernance(activationInput, activationPreview);
  assert.equal(submitted.response.status, 201, JSON.stringify(submitted.payload));
  await approveWithTwoReviewers(submitted.payload.request);
  const finalized = await finalize(
    submitted.payload.request.id,
    submitted.payload.request.basisSha256,
  );
  assert.equal(finalized.response.status, 200, JSON.stringify(finalized.payload));
  assert.equal(finalized.payload.result.outcome.type, "assignment_revision");
  mainAssignment = finalized.payload.result.outcome.assignment;
  assert.equal(mainAssignment.enforcement_mode, "enforced");
  assert.equal(mainAssignment.applicability_confirmed, 1);
  assert.equal(mainAssignment.scope_type, "location");
  assert.equal(String(mainAssignment.scope_key), locationId);

  const governance = await request("/api/work-rules/governance");
  assert.equal(governance.response.status, 200, JSON.stringify(governance.payload));
  const active = governance.payload.assignmentRevisions.find((entry) => entry.id === mainAssignment.id);
  assert.ok(active, JSON.stringify(governance.payload.assignmentRevisions));
  assert.equal(active.active, true);
  assert.equal(active.applicabilityConfirmed, true);
  assert.equal(active.enforcementMode, "enforced");

  const directAssignment = await request("/api/work-rules/assignments", {
    method: "POST",
    body: {
      profileVersionId: mainPublication.released_profile_version_id,
      scopeType: "location",
      scopeKey: locationId,
      validFrom: VALID_FROM,
      enforcementMode: "monitor",
      applicabilityConfirmed: true,
    },
  });
  assert.equal(directAssignment.response.status, 409, JSON.stringify(directAssignment.payload));
  assert.equal(directAssignment.payload.code, "WORK_RULE_DIRECT_ASSIGNMENT_DISABLED");
});

test("Block 6: unsupported metric and employee group may be published but are blocked at activation", async () => {
  const created = await request("/api/work-rules/drafts", {
    method: "POST",
    body: mainRulePayload({
      code: "BLOCK6-UNSUPPORTED-GROUP",
      title: "Unsupported group vacation lead time",
      topic: "vacation",
      scopeType: "employee_group",
      scopeKey: "apprentices",
      metric: "minimum_vacation_request_lead_days",
      threshold: 14,
      severity: "warning",
      reaction: "acknowledge",
      message: "The requested vacation begins inside the internal planning lead time.",
      testCases: {
        positiveValue: 21,
        negativeValue: 7,
      },
    }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const unsupportedDraft = created.payload.draft;
  const published = await publishWithIndependentReview(unsupportedDraft, {
    warningCodes: ["CUSTOM_METRIC_UNSUPPORTED", "EMPLOYEE_GROUP_UNSUPPORTED"],
    expectedApprovals: 1,
  });
  assert.equal(published.preview.outcome, "warning");

  const activationInput = governanceInput(
    "activate_assignment",
    "work_rule_publication",
    published.publication.id,
    {
      logicalAssignmentId: "block6-unsupported-group-assignment",
      scopeType: "employee_group",
      scopeKey: "apprentices",
      validFrom: VALID_FROM,
      validTo: null,
      effectiveOn: VALID_FROM,
      enforcementMode: "monitor",
      applicabilityConfirmed: true,
      rationale: "Negative integration fixture for an unsupported runtime scope and metric.",
      sourceReference: SOURCE_REFERENCE,
    },
  );
  const preview = await previewGovernance(activationInput);
  assert.equal(preview.outcome, "blocked");
  const blockerCodes = new Set(preview.result.blockers.map((entry) => entry.code));
  assert.ok(blockerCodes.has("CUSTOM_METRIC_UNSUPPORTED"), JSON.stringify(preview));
  assert.ok(blockerCodes.has("EMPLOYEE_GROUP_UNSUPPORTED"), JSON.stringify(preview));

  const submitted = await submitGovernance(activationInput, preview);
  assert.equal(submitted.response.status, 409, JSON.stringify(submitted.payload));
  assert.equal(submitted.payload.code, "WORK_RULE_GOVERNANCE_CONFLICT_BLOCKED");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM work_rule_assignment_revisions WHERE publication_id = ?")
      .get(published.publication.id).count,
    0,
  );
});

test("Block 6: a changed draft makes a previously previewed basis stale", async () => {
  const created = await request("/api/work-rules/drafts", {
    method: "POST",
    body: mainRulePayload({
      code: "BLOCK6-STALE",
      title: "Stale basis integration rule",
      severity: "warning",
      reaction: "advisory",
    }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const staleDraft = created.payload.draft;
  const input = governanceInput(
    "publish_rule",
    "work_rule_profile_version",
    staleDraft.currentVersionId,
    { effectiveOn: VALID_FROM },
  );
  const stalePreview = await previewGovernance(input);
  assert.equal(stalePreview.outcome, "pass");

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const revised = await request(
    `/api/work-rules/drafts/${encodeURIComponent(staleDraft.id)}/revisions`,
    {
      method: "POST",
      body: mainRulePayload({
        code: "BLOCK6-STALE",
        title: "Stale basis integration rule",
        threshold: 420,
        severity: "warning",
        reaction: "advisory",
        testCases: {
          positiveValue: 420,
          negativeValue: 421,
        },
      }),
    },
  );
  assert.equal(revised.response.status, 201, JSON.stringify(revised.payload));
  assert.notEqual(revised.payload.draft.currentVersionId, staleDraft.currentVersionId);

  const staleSubmission = await submitGovernance(input, stalePreview);
  assert.equal(staleSubmission.response.status, 409, JSON.stringify(staleSubmission.payload));
  assert.equal(staleSubmission.payload.code, "WORK_RULE_GOVERNANCE_BASIS_STALE");
});

test("Block 6: governance artifacts are immutable and withdrawal deactivates the active assignment", async () => {
  assert.throws(
    () => db.prepare(`
      UPDATE work_rule_publications
      SET semantic_sha256 = semantic_sha256
      WHERE id = ?
    `).run(mainPublication.id),
    /immutable/i,
  );
  assert.throws(
    () => db.prepare(`
      UPDATE work_rule_assignment_revisions
      SET rationale = rationale
      WHERE id = ?
    `).run(mainAssignment.id),
    /immutable/i,
  );
  assert.throws(
    () => db.prepare(`
      UPDATE work_rule_review_requests
      SET reason = reason
      WHERE id = ?
    `).run(mainAssignment.review_request_id),
    /immutable/i,
  );

  const input = governanceInput(
    "withdraw_publication",
    "work_rule_publication",
    mainPublication.id,
    { effectiveOn: VALID_FROM },
  );
  const preview = await previewGovernance(input);
  assert.equal(preview.outcome, "warning");
  assert.equal(preview.riskClass, "critical");
  assert.equal(preview.requiredApprovals, 2);
  assert.ok(preview.result.warnings.some((entry) => (
    entry.code === "PUBLICATION_HAS_ACTIVE_ASSIGNMENTS"
      && entry.assignmentRevisionIds.includes(mainAssignment.id)
  )), JSON.stringify(preview));

  const submitted = await submitGovernance(input, preview);
  assert.equal(submitted.response.status, 201, JSON.stringify(submitted.payload));
  await approveWithTwoReviewers(submitted.payload.request);
  const finalized = await finalize(
    submitted.payload.request.id,
    submitted.payload.request.basisSha256,
  );
  assert.equal(finalized.response.status, 200, JSON.stringify(finalized.payload));
  assert.equal(finalized.payload.result.outcome.type, "publication_event");
  assert.equal(finalized.payload.result.outcome.event.event_type, "withdrawn");
  assert.deepEqual(
    finalized.payload.result.outcome.endedAssignments.map((entry) => entry.assignmentRevisionId),
    [mainAssignment.id],
  );

  const governance = await request("/api/work-rules/governance");
  assert.equal(governance.response.status, 200, JSON.stringify(governance.payload));
  const publication = governance.payload.publications.find((entry) => entry.id === mainPublication.id);
  const assignment = governance.payload.assignmentRevisions.find((entry) => entry.id === mainAssignment.id);
  assert.equal(publication.state, "withdrawn");
  assert.equal(assignment.active, false);
  assert.ok(assignment.events.some((entry) => entry.eventType === "deactivated"));
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM work_rule_assignment_events
      WHERE assignment_revision_id = ? AND event_type = 'deactivated'
    `).get(mainAssignment.id).count,
    1,
  );
});

test("Block 6: restoring a published version creates a new draft without changing the release", async () => {
  const restored = await request(
    `/api/work-rules/drafts/${encodeURIComponent(mainDraft.id)}/versions/${
      encodeURIComponent(mainPublication.released_profile_version_id)
    }/restore`,
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(restored.response.status, 201, JSON.stringify(restored.payload));
  const restoredDraft = restored.payload.draft;
  assert.equal(restoredDraft.id, mainDraft.id);
  assert.equal(restoredDraft.lifecycleStatus, "draft");
  assert.equal(restoredDraft.currentVersion.status, "draft");
  assert.equal(restoredDraft.currentVersion.versionKind, "draft");
  assert.match(restoredDraft.currentVersionId, /@draft-2$/);
  assert.notEqual(restoredDraft.currentVersionId, mainDraft.currentVersionId);
  assert.notEqual(restoredDraft.currentVersionId, mainPublication.released_profile_version_id);
  assert.equal(restoredDraft.effectiveVersionId, mainPublication.released_profile_version_id);

  const releaseRow = db.prepare(`
    SELECT status, content_sha256
    FROM work_rule_profile_versions
    WHERE id = ?
  `).get(mainPublication.released_profile_version_id);
  assert.equal(releaseRow.status, "published");
  assert.match(releaseRow.content_sha256, /^[a-f0-9]{64}$/);
});

test("Block 6: KV preparation binds version, business unit and effective-date boundaries", async () => {
  const createdAgreement = await request("/api/collective-agreements", {
    method: "POST",
    body: {
      code: "BLOCK6-KV",
      title: "Block 6 collective agreement",
      shortTitle: "Block 6 KV",
      jurisdiction: "AT",
      note: "Registry fixture without a blanket legal applicability statement.",
      version: collectiveAgreementVersionPayload(),
    },
  });
  assert.equal(createdAgreement.response.status, 201, JSON.stringify(createdAgreement.payload));
  collectiveAgreement = createdAgreement.payload.agreement;
  collectiveAgreementVersion = collectiveAgreement.versions.find((entry) => (
    entry.id === collectiveAgreement.currentVersionId
  ));
  assert.ok(collectiveAgreementVersion, JSON.stringify(collectiveAgreement));
  assert.equal(collectiveAgreementVersion.validFrom, KV_VALID_FROM);
  assert.equal(collectiveAgreementVersion.validTo, KV_VALID_TO);

  const createdBusinessUnit = await request("/api/collective-agreements/business-units", {
    method: "POST",
    body: {
      code: "BLOCK6-KV-BU",
      name: "Block 6 future business unit",
      legalEntityName: "Block 6 Test GmbH",
      description: "Explicit organizational scope for the KV governance integration test.",
      scopes: [{ scopeType: "location", scopeKey: locationId }],
    },
  });
  assert.equal(createdBusinessUnit.response.status, 201, JSON.stringify(createdBusinessUnit.payload));
  collectiveAgreementBusinessUnit = createdBusinessUnit.payload.businessUnit;
  assert.deepEqual(
    collectiveAgreementBusinessUnit.scopes.map((entry) => [entry.scopeType, entry.scopeKey]),
    [["location", locationId]],
  );

  for (const invalidRange of [
    { validFrom: "2019-12-31", validTo: KV_VALID_TO },
    { validFrom: KV_VALID_FROM, validTo: null },
    { validFrom: KV_VALID_FROM, validTo: "2021-01-01" },
  ]) {
    const invalidAssignment = await request("/api/collective-agreements/assignments", {
      method: "POST",
      body: {
        agreementVersionId: collectiveAgreementVersion.id,
        businessUnitId: collectiveAgreementBusinessUnit.id,
        ...invalidRange,
        rationale: "This deliberately invalid range must not leave the documented KV version.",
        referenceNote: KV_SOURCE_REFERENCE,
        reviewState: "review_pending",
      },
    });
    assert.equal(invalidAssignment.response.status, 400, JSON.stringify(invalidAssignment.payload));
    assert.equal(invalidAssignment.payload.code, "COLLECTIVE_AGREEMENT_INVALID");
    assert.match(invalidAssignment.payload.error, /KV-Fassung|außerhalb/i);
  }

  const prepared = await request("/api/collective-agreements/assignments", {
    method: "POST",
    body: {
      agreementVersionId: collectiveAgreementVersion.id,
      businessUnitId: collectiveAgreementBusinessUnit.id,
      validFrom: KV_VALID_FROM,
      validTo: KV_VALID_TO,
      rationale: "Future-dated assignment proposed for an independent professional governance review.",
      referenceNote: KV_SOURCE_REFERENCE,
      reviewState: "review_pending",
    },
  });
  assert.equal(prepared.response.status, 201, JSON.stringify(prepared.payload));
  collectiveAgreementAssignment = prepared.payload.assignment;
  assert.equal(collectiveAgreementAssignment.reviewState, "review_pending");
  assert.equal(collectiveAgreementAssignment.createdBy, AUTHOR);

  for (const effectiveOn of ["2019-12-31", "2021-01-01"]) {
    const invalidInput = governanceInput(
      "approve_kv_assignment",
      "collective_agreement_assignment",
      collectiveAgreementAssignment.id,
      { effectiveOn },
    );
    const invalidPreview = await previewGovernance(invalidInput);
    assert.equal(invalidPreview.outcome, "blocked");
    assert.ok(invalidPreview.result.blockers.some((entry) => (
      entry.code === "KV_EFFECTIVE_DATE_OUTSIDE_ASSIGNMENT"
    )), JSON.stringify(invalidPreview));
    const invalidSubmission = await submitGovernance(invalidInput, invalidPreview, {
      sourceReference: KV_SOURCE_REFERENCE,
    });
    assert.equal(invalidSubmission.response.status, 409, JSON.stringify(invalidSubmission.payload));
    assert.equal(invalidSubmission.payload.code, "WORK_RULE_GOVERNANCE_CONFLICT_BLOCKED");
  }
});

test("Block 6: KV approval and deactivation require two independent decisions and update the registry", async () => {
  const approvalInput = governanceInput(
    "approve_kv_assignment",
    "collective_agreement_assignment",
    collectiveAgreementAssignment.id,
    { effectiveOn: KV_VALID_FROM },
  );
  const approvalPreview = await previewGovernance(approvalInput);
  assert.equal(approvalPreview.outcome, "pass");
  assert.equal(approvalPreview.riskClass, "critical");
  assert.equal(approvalPreview.requiredApprovals, 2);
  assert.equal(approvalPreview.requiredFachlichApprovals, 1);
  assert.equal(approvalPreview.payload.effectiveOn, KV_VALID_FROM);

  const submittedApproval = await submitGovernance(approvalInput, approvalPreview, {
    reason: "Submit the future KV assignment for two independent professional decisions.",
    sourceReference: KV_SOURCE_REFERENCE,
  });
  assert.equal(submittedApproval.response.status, 201, JSON.stringify(submittedApproval.payload));
  const approvalRequest = submittedApproval.payload.request;

  const selfApproval = await decide(
    approvalRequest.id,
    authorSession,
    "The author must not approve the own KV assignment.",
  );
  assert.equal(selfApproval.response.status, 403, JSON.stringify(selfApproval.payload));
  assert.equal(selfApproval.payload.code, "WORK_RULE_GOVERNANCE_SELF_APPROVAL");

  const approvedRequest = await approveWithTwoReviewers(approvalRequest);
  assert.equal(approvedRequest.state, "approved");
  assert.equal(approvedRequest.fachlichApprovalCount, 2);
  const finalizedApproval = await finalize(
    approvalRequest.id,
    approvalRequest.basisSha256,
  );
  assert.equal(finalizedApproval.response.status, 200, JSON.stringify(finalizedApproval.payload));
  assert.equal(finalizedApproval.payload.result.outcome.type, "collective_assignment_event");
  assert.equal(finalizedApproval.payload.result.outcome.event.event_type, "approved");
  assert.equal(finalizedApproval.payload.result.outcome.event.effective_on, KV_VALID_FROM);

  const approvedRegistry = await request("/api/collective-agreements/registry");
  assert.equal(approvedRegistry.response.status, 200, JSON.stringify(approvedRegistry.payload));
  const approvedAssignment = approvedRegistry.payload.assignments.find((entry) => (
    entry.id === collectiveAgreementAssignment.id
  ));
  assert.ok(approvedAssignment, JSON.stringify(approvedRegistry.payload.assignments));
  assert.equal(approvedAssignment.reviewState, "review_pending");
  assert.equal(approvedAssignment.governanceState, "approved");
  assert.equal(approvedAssignment.governanceEffectiveOn, KV_VALID_FROM);
  assert.equal(approvedAssignment.governanceCurrentEffectiveOn, KV_VALID_FROM);
  assert.equal(approvedAssignment.governancePlannedEventType, null);
  assert.equal(approvedRegistry.payload.summary.approvedAssignments, 1);
  assert.equal(approvedRegistry.payload.summary.deactivatedAssignments, 0);

  const tooEarlyDeactivationInput = governanceInput(
    "deactivate_kv_assignment",
    "collective_agreement_assignment",
    collectiveAgreementAssignment.id,
    { effectiveOn: "2019-12-31" },
  );
  const tooEarlyDeactivation = await previewGovernance(tooEarlyDeactivationInput);
  assert.equal(tooEarlyDeactivation.outcome, "blocked");
  const earlyBlockers = new Set(
    tooEarlyDeactivation.result.blockers.map((entry) => entry.code),
  );
  assert.ok(earlyBlockers.has("KV_EFFECTIVE_DATE_OUTSIDE_ASSIGNMENT"));
  assert.ok(earlyBlockers.has("KV_DEACTIVATION_BEFORE_APPROVAL"));

  const tooLateDeactivationInput = governanceInput(
    "deactivate_kv_assignment",
    "collective_agreement_assignment",
    collectiveAgreementAssignment.id,
    { effectiveOn: "2021-01-01" },
  );
  const tooLateDeactivation = await previewGovernance(tooLateDeactivationInput);
  assert.equal(tooLateDeactivation.outcome, "blocked");
  assert.ok(tooLateDeactivation.result.blockers.some((entry) => (
    entry.code === "KV_EFFECTIVE_DATE_OUTSIDE_ASSIGNMENT"
  )), JSON.stringify(tooLateDeactivation));

  const deactivationInput = governanceInput(
    "deactivate_kv_assignment",
    "collective_agreement_assignment",
    collectiveAgreementAssignment.id,
    { effectiveOn: KV_VALID_TO },
  );
  const deactivationPreview = await previewGovernance(deactivationInput);
  assert.equal(deactivationPreview.outcome, "pass");
  assert.equal(deactivationPreview.riskClass, "critical");
  assert.equal(deactivationPreview.requiredApprovals, 2);
  assert.equal(deactivationPreview.requiredFachlichApprovals, 1);
  assert.equal(deactivationPreview.payload.effectiveOn, KV_VALID_TO);

  const submittedDeactivation = await submitGovernance(
    deactivationInput,
    deactivationPreview,
    {
      reason: "Submit the future KV deactivation for two independent professional decisions.",
      sourceReference: KV_SOURCE_REFERENCE,
    },
  );
  assert.equal(
    submittedDeactivation.response.status,
    201,
    JSON.stringify(submittedDeactivation.payload),
  );
  const deactivationRequest = submittedDeactivation.payload.request;
  await approveWithTwoReviewers(deactivationRequest);
  const finalizedDeactivation = await finalize(
    deactivationRequest.id,
    deactivationRequest.basisSha256,
  );
  assert.equal(
    finalizedDeactivation.response.status,
    200,
    JSON.stringify(finalizedDeactivation.payload),
  );
  assert.equal(finalizedDeactivation.payload.result.outcome.type, "collective_assignment_event");
  assert.equal(finalizedDeactivation.payload.result.outcome.event.event_type, "deactivated");
  assert.equal(finalizedDeactivation.payload.result.outcome.event.effective_on, KV_VALID_TO);

  const deactivatedRegistry = await request("/api/collective-agreements/registry");
  assert.equal(deactivatedRegistry.response.status, 200, JSON.stringify(deactivatedRegistry.payload));
  const deactivatedAssignment = deactivatedRegistry.payload.assignments.find((entry) => (
    entry.id === collectiveAgreementAssignment.id
  ));
  assert.ok(deactivatedAssignment, JSON.stringify(deactivatedRegistry.payload.assignments));
  assert.equal(deactivatedAssignment.reviewState, "review_pending");
  assert.equal(deactivatedAssignment.governanceState, "deactivated");
  assert.equal(deactivatedAssignment.governanceEffectiveOn, KV_VALID_TO);
  assert.equal(deactivatedAssignment.governanceCurrentEffectiveOn, KV_VALID_TO);
  assert.equal(deactivatedAssignment.governancePlannedEventType, null);
  assert.equal(deactivatedRegistry.payload.summary.approvedAssignments, 0);
  assert.equal(deactivatedRegistry.payload.summary.deactivatedAssignments, 1);

  const events = db.prepare(`
    SELECT event_type, effective_on
    FROM collective_agreement_assignment_events
    WHERE assignment_id = ?
    ORDER BY effective_on, occurred_at, id
  `).all(collectiveAgreementAssignment.id).map((entry) => ({
    event_type: entry.event_type,
    effective_on: entry.effective_on,
  }));
  assert.deepEqual(events, [
    { event_type: "approved", effective_on: KV_VALID_FROM },
    { event_type: "deactivated", effective_on: KV_VALID_TO },
  ]);
  assert.equal(
    db.prepare("SELECT review_state FROM collective_agreement_assignments WHERE id = ?")
      .get(collectiveAgreementAssignment.id).review_state,
    "review_pending",
  );
});

test("Block 6: a future KV approval remains explicitly planned until its effective date", async () => {
  const futureVersion = await request(
    `/api/collective-agreements/${encodeURIComponent(collectiveAgreement.id)}/versions`,
    {
      method: "POST",
      body: collectiveAgreementVersionPayload({
        versionLabel: "2098",
        validFrom: KV_FUTURE_VALID_FROM,
        validTo: KV_FUTURE_VALID_TO,
        externalPublishedOn: "2097-12-15",
        sourceUrl: "https://example.invalid/collective-agreement-2098.pdf",
        sourceSha256: "d".repeat(64),
      }),
    },
  );
  assert.equal(futureVersion.response.status, 201, JSON.stringify(futureVersion.payload));
  const version = futureVersion.payload.agreement.versions.find((entry) => (
    entry.id === futureVersion.payload.agreement.currentVersionId
  ));
  assert.ok(version, JSON.stringify(futureVersion.payload.agreement));

  const futureProposal = await request("/api/collective-agreements/assignments", {
    method: "POST",
    body: {
      agreementVersionId: version.id,
      businessUnitId: collectiveAgreementBusinessUnit.id,
      validFrom: KV_FUTURE_VALID_FROM,
      validTo: KV_FUTURE_VALID_TO,
      rationale: "Future assignment used to verify the registry's planned governance state.",
      referenceNote: KV_SOURCE_REFERENCE,
      reviewState: "review_pending",
    },
  });
  assert.equal(futureProposal.response.status, 201, JSON.stringify(futureProposal.payload));
  const futureAssignment = futureProposal.payload.assignment;

  const approvalInput = governanceInput(
    "approve_kv_assignment",
    "collective_agreement_assignment",
    futureAssignment.id,
    { effectiveOn: KV_FUTURE_VALID_FROM },
  );
  const approvalPreview = await previewGovernance(approvalInput);
  assert.equal(approvalPreview.outcome, "pass");
  assert.equal(approvalPreview.requiredApprovals, 2);
  const submitted = await submitGovernance(approvalInput, approvalPreview, {
    reason: "Submit the future KV assignment for two independent professional decisions.",
    sourceReference: KV_SOURCE_REFERENCE,
  });
  assert.equal(submitted.response.status, 201, JSON.stringify(submitted.payload));
  await approveWithTwoReviewers(submitted.payload.request);
  const finalized = await finalize(
    submitted.payload.request.id,
    submitted.payload.request.basisSha256,
  );
  assert.equal(finalized.response.status, 200, JSON.stringify(finalized.payload));
  assert.equal(finalized.payload.result.outcome.event.event_type, "approved");
  assert.equal(finalized.payload.result.outcome.event.effective_on, KV_FUTURE_VALID_FROM);

  const registry = await request("/api/collective-agreements/registry");
  assert.equal(registry.response.status, 200, JSON.stringify(registry.payload));
  const planned = registry.payload.assignments.find((entry) => entry.id === futureAssignment.id);
  assert.ok(planned, JSON.stringify(registry.payload.assignments));
  assert.equal(planned.governanceState, "approval_planned");
  assert.equal(planned.governanceEffectiveOn, KV_FUTURE_VALID_FROM);
  assert.equal(planned.governanceCurrentEffectiveOn, null);
  assert.equal(planned.governancePlannedEventType, "approved");
  assert.equal(registry.payload.summary.plannedAssignments, 1);
  assert.equal(registry.payload.summary.approvedAssignments, 0);
  assert.equal(registry.payload.summary.deactivatedAssignments, 1);
  assert.ok(
    new Date(`${planned.governanceEffectiveOn}T00:00:00.000Z`)
      > new Date(registry.payload.generatedAt),
    "A future approval must retain its effective date and stay in the planned state.",
  );
});
