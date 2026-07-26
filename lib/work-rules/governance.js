"use strict";

const { randomUUID } = require("node:crypto");
const { canonicalSha256 } = require("./receipt");
const { getWorkRuleProfileVersion } = require("./store");
const {
  customWorkRuleDefinitionFromVersion,
  customWorkRuleSemanticSha256,
  publishCustomWorkRuleDraft,
} = require("./custom-rules");

const GOVERNANCE_SCHEMA_VERSION = 1;

const SUPPORTED_CUSTOM_SCHEDULE_METRICS = Object.freeze([
  "maximum_planned_daily_minutes",
  "maximum_planned_weekly_minutes",
  "minimum_planned_rest_minutes",
  "maximum_consecutive_workdays",
  "maximum_saturdays_per_month",
  "earliest_shift_start_time",
  "latest_shift_end_time",
]);

const SUPPORTED_CUSTOM_SCHEDULE_METRIC_SET = new Set(SUPPORTED_CUSTOM_SCHEDULE_METRICS);
const GOVERNANCE_OPERATIONS = new Set([
  "publish_rule",
  "activate_assignment",
  "deactivate_assignment",
  "withdraw_publication",
  "approve_kv_assignment",
  "deactivate_kv_assignment",
]);
const OPERATION_SUBJECT_TYPES = Object.freeze({
  publish_rule: "work_rule_profile_version",
  activate_assignment: "work_rule_publication",
  deactivate_assignment: "work_rule_assignment_revision",
  withdraw_publication: "work_rule_publication",
  approve_kv_assignment: "collective_agreement_assignment",
  deactivate_kv_assignment: "collective_agreement_assignment",
});
const OPERATION_PERMISSIONS = Object.freeze({
  publish_rule: "work_rules:publish",
  activate_assignment: "work_rules:assign",
  deactivate_assignment: "work_rules:assign",
  withdraw_publication: "work_rules:publish",
  approve_kv_assignment: "collective_agreements:approve",
  deactivate_kv_assignment: "collective_agreements:approve",
});
const DECISION_PERMISSIONS = Object.freeze({
  publish_rule: "work_rules:review",
  activate_assignment: "work_rules:review",
  deactivate_assignment: "work_rules:review",
  withdraw_publication: "work_rules:review",
  approve_kv_assignment: "collective_agreements:approve",
  deactivate_kv_assignment: "collective_agreements:approve",
});
const QUALIFICATIONS = new Set(["fachlich", "organisational", "technical"]);
const ASSIGNMENT_SCOPE_TYPES = new Set([
  "installation",
  "business_unit",
  "location",
  "department",
  "employee_group",
  "employee",
]);

function governanceError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function integrityError(message) {
  return governanceError(
    message || "Die Governance-Historie konnte nicht unverändert verifiziert werden.",
    "WORK_RULE_GOVERNANCE_INTEGRITY",
    500,
  );
}

function requiredText(value, label, maximum = 500) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw governanceError(`${label} fehlt.`, "WORK_RULE_GOVERNANCE_INVALID");
  }
  if (normalized.length > maximum) {
    throw governanceError(`${label} ist zu lang.`, "WORK_RULE_GOVERNANCE_INVALID");
  }
  return normalized;
}

function optionalText(value, maximum = 1000) {
  const normalized = String(value || "").trim();
  if (normalized.length > maximum) {
    throw governanceError("Ein Governance-Feld ist zu lang.", "WORK_RULE_GOVERNANCE_INVALID");
  }
  return normalized;
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isoDate(value, label, fallback = "") {
  const normalized = String(value || fallback || "").trim();
  if (!isIsoDate(normalized)) {
    throw governanceError(`${label} muss ein gültiges Datum im Format YYYY-MM-DD sein.`, "WORK_RULE_GOVERNANCE_INVALID");
  }
  return normalized;
}

function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function occurredAt(actor = {}) {
  if (actor && typeof actor === "object" && actor.now) {
    const submitted = actor.now instanceof Date ? actor.now : new Date(actor.now);
    if (!Number.isNaN(submitted.getTime())) return submitted.toISOString();
  }
  return new Date().toISOString();
}

function addDays(value, amount) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Number(amount || 0));
  return parsed.toISOString().slice(0, 10);
}

function parseJson(value, fallback = null) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function withImmediateTransaction(db, callback) {
  if (db.isTransaction === true || db.inTransaction === true) return callback();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Keep the original failure.
    }
    throw error;
  }
}

function normalizeQualification(actor = {}) {
  const submitted = String(actor.qualification || "").trim();
  if (QUALIFICATIONS.has(submitted)) return submitted;
  if (String(actor.role || "") === "hr") return "fachlich";
  if (["developer", "it_admin"].includes(String(actor.role || ""))) return "technical";
  return "organisational";
}

function normalizeActor(actor, fallbackPermission = "") {
  const source = typeof actor === "string" ? { employeeNumber: actor } : objectValue(actor);
  const employeeNumber = requiredText(
    source.employeeNumber || source.employee_number,
    "Personalnummer des Akteurs",
    80,
  );
  return {
    employeeNumber,
    role: optionalText(source.role || "unknown", 80) || "unknown",
    permission: optionalText(
      source.permissionUsed || source.permission || fallbackPermission || "unknown",
      120,
    ) || "unknown",
    qualification: normalizeQualification(source),
    now: source.now,
  };
}

function assertGovernanceOperation(operationValue, subjectTypeValue) {
  const operation = requiredText(operationValue, "Governance-Operation", 80);
  if (!GOVERNANCE_OPERATIONS.has(operation)) {
    throw governanceError("Die Governance-Operation ist ungültig.", "WORK_RULE_GOVERNANCE_OPERATION_INVALID");
  }
  const expectedSubjectType = OPERATION_SUBJECT_TYPES[operation];
  const subjectType = requiredText(subjectTypeValue || expectedSubjectType, "Objektart", 80);
  if (subjectType !== expectedSubjectType) {
    throw governanceError(
      "Die Objektart passt nicht zur Governance-Operation.",
      "WORK_RULE_GOVERNANCE_SUBJECT_INVALID",
    );
  }
  return { operation, subjectType };
}

function tableExists(db, table) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(String(table || "")));
}

function assertGovernanceTables(db) {
  const requiredTables = [
    "work_rule_conflict_runs",
    "work_rule_review_requests",
    "work_rule_review_decisions",
    "work_rule_publications",
    "work_rule_publication_events",
    "work_rule_assignment_revisions",
    "work_rule_assignment_events",
    "collective_agreement_assignment_events",
    "work_rule_governance_events",
  ];
  if (requiredTables.some((table) => !tableExists(db, table))) {
    throw governanceError(
      "Die Datenbank enthält das Governance-Schema noch nicht vollständig.",
      "WORK_RULE_GOVERNANCE_SCHEMA_MISSING",
      503,
    );
  }
}

function canonicalScope(scope) {
  return {
    type: String(scope?.type || scope?.scopeType || ""),
    key: String(scope?.key ?? scope?.scopeKey ?? ""),
  };
}

function sortedScopes(scopes) {
  return [...new Map((Array.isArray(scopes) ? scopes : [])
    .map(canonicalScope)
    .filter((scope) => scope.type)
    .map((scope) => [`${scope.type}:${scope.key}`, scope])).values()]
    .sort((left, right) => (
      left.type.localeCompare(right.type) || left.key.localeCompare(right.key)
    ));
}

function dateRangesOverlap(leftFrom, leftTo, rightFrom, rightTo) {
  const leftEnd = leftTo || "9999-12-31";
  const rightEnd = rightTo || "9999-12-31";
  return leftFrom <= rightEnd && rightFrom <= leftEnd;
}

function conflict(code, message, detail = {}) {
  return {
    code: String(code),
    message: String(message),
    ...detail,
  };
}

function profileVersionRow(db, id) {
  return db.prepare(`
    SELECT v.id, v.profile_id, v.version, v.layer, v.status, v.valid_from, v.valid_to,
           v.content_sha256, v.created_by, v.created_at, v.published_at,
           p.status AS profile_status, p.current_version_id, p.created_by AS profile_created_by
    FROM work_rule_profile_versions v
    JOIN work_rule_profiles p ON p.id = v.profile_id
    WHERE v.id = ?
  `).get(String(id || ""));
}

function conflictReceiptCore(row) {
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    kind: "work_rule_conflict_run",
    id: row.id,
    operation: row.operation,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    baselineSha256: row.baseline_sha256,
    outcome: row.outcome,
    resultSha256: row.result_sha256,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function verifyConflictRow(row) {
  if (!row) throw integrityError("Der Konfliktprüflauf wurde nicht gefunden.");
  const result = parseJson(row.result_json, null);
  if (!result || canonicalSha256(result) !== row.result_sha256
    || canonicalSha256(conflictReceiptCore(row)) !== row.receipt_sha256) {
    throw integrityError("Der Konfliktprüflauf stimmt nicht mit seinem Prüfbeleg überein.");
  }
  return {
    id: row.id,
    operation: row.operation,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    baselineSha256: row.baseline_sha256,
    outcome: row.outcome,
    result,
    resultSha256: row.result_sha256,
    createdBy: row.created_by,
    createdAt: row.created_at,
    receiptSha256: row.receipt_sha256,
  };
}

function reviewReceiptCore(row) {
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    kind: "work_rule_review_request",
    id: row.id,
    clientRequestId: row.client_request_id,
    operation: row.operation,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    basisSha256: row.basis_sha256,
    payloadSha256: row.payload_sha256,
    riskClass: row.risk_class,
    requiredApprovals: Number(row.required_approvals),
    requiredFachlichApprovals: Number(row.required_fachlich_approvals),
    conflictRunId: row.conflict_run_id,
    reason: row.reason,
    sourceReference: row.source_reference,
    submittedBy: row.submitted_by,
    submittedRole: row.submitted_role,
    submittedPermission: row.submitted_permission,
    submittedAt: row.submitted_at,
  };
}

function verifyReviewRow(row) {
  if (!row) throw integrityError("Der Freigabeantrag wurde nicht gefunden.");
  const payload = parseJson(row.payload_json, null);
  if (!payload || canonicalSha256(payload) !== row.payload_sha256
    || canonicalSha256(reviewReceiptCore(row)) !== row.receipt_sha256) {
    throw integrityError("Der Freigabeantrag stimmt nicht mit seinem Prüfbeleg überein.");
  }
  return { row, payload };
}

function decisionReceiptCore(row) {
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    kind: "work_rule_review_decision",
    id: row.id,
    requestId: row.request_id,
    decision: row.decision,
    actorEmployeeNumber: row.actor_employee_number,
    actorRole: row.actor_role,
    permissionUsed: row.permission_used,
    qualification: row.qualification,
    reason: row.reason,
    requestReceiptSha256: row.request_receipt_sha256,
    decidedAt: row.decided_at,
  };
}

function verifyDecisionRow(row, requestReceiptSha256 = "") {
  if (!row || canonicalSha256(decisionReceiptCore(row)) !== row.receipt_sha256
    || (requestReceiptSha256 && row.request_receipt_sha256 !== requestReceiptSha256)) {
    throw integrityError("Eine Freigabeentscheidung stimmt nicht mit ihrem Prüfbeleg überein.");
  }
  return {
    id: row.id,
    requestId: row.request_id,
    decision: row.decision,
    actorEmployeeNumber: row.actor_employee_number,
    actorRole: row.actor_role,
    permissionUsed: row.permission_used,
    qualification: row.qualification,
    reason: row.reason,
    requestReceiptSha256: row.request_receipt_sha256,
    decidedAt: row.decided_at,
    receiptSha256: row.receipt_sha256,
  };
}

function publicationReceiptCore(row) {
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    kind: "work_rule_publication",
    id: row.id,
    profileId: row.profile_id,
    sourceProfileVersionId: row.source_profile_version_id,
    releasedProfileVersionId: row.released_profile_version_id,
    reviewRequestId: row.review_request_id,
    releaseNumber: Number(row.release_number),
    semanticSha256: row.semantic_sha256,
    conflictRunId: row.conflict_run_id,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
  };
}

function verifyPublicationRow(row) {
  if (!row || canonicalSha256(publicationReceiptCore(row)) !== row.receipt_sha256) {
    throw integrityError("Die Veröffentlichung stimmt nicht mit ihrem Prüfbeleg überein.");
  }
  return row;
}

function lifecycleEventReceiptCore(kind, row, subjectField) {
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    kind,
    id: row.id,
    subjectId: row[subjectField],
    eventType: row.event_type,
    effectiveOn: row.effective_on,
    reason: row.reason,
    reviewRequestId: row.review_request_id,
    actorEmployeeNumber: row.actor_employee_number,
    actorRole: row.actor_role,
    permissionUsed: row.permission_used,
    occurredAt: row.occurred_at,
  };
}

function verifyLifecycleEvent(kind, row, subjectField) {
  if (!row || canonicalSha256(lifecycleEventReceiptCore(kind, row, subjectField)) !== row.receipt_sha256) {
    throw integrityError("Ein Governance-Lebenszyklusereignis stimmt nicht mit seinem Prüfbeleg überein.");
  }
  return row;
}

function assignmentRevisionReceiptCore(row) {
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    kind: "work_rule_assignment_revision",
    id: row.id,
    logicalAssignmentId: row.logical_assignment_id,
    revision: Number(row.revision),
    publicationId: row.publication_id,
    profileVersionId: row.profile_version_id,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    expandedScopesSha256: canonicalSha256(parseJson(row.expanded_scopes_json, [])),
    scopeSha256: row.scope_sha256,
    validFrom: row.valid_from,
    validTo: row.valid_to || null,
    enforcementMode: row.enforcement_mode,
    applicabilityConfirmed: Boolean(row.applicability_confirmed),
    rationale: row.rationale,
    sourceReference: row.source_reference,
    supersedesRevisionId: row.supersedes_revision_id || null,
    reviewRequestId: row.review_request_id,
    conflictRunId: row.conflict_run_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function verifyAssignmentRevisionRow(row) {
  const scopes = parseJson(row?.expanded_scopes_json, null);
  if (!row || !Array.isArray(scopes)
    || canonicalSha256(sortedScopes(scopes)) !== row.scope_sha256
    || canonicalSha256(assignmentRevisionReceiptCore(row)) !== row.receipt_sha256) {
    throw integrityError("Die Zuordnungsrevision stimmt nicht mit ihrem Prüfbeleg überein.");
  }
  return { row, expandedScopes: sortedScopes(scopes) };
}

function collectiveEventReceiptCore(row) {
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    kind: "collective_agreement_assignment_event",
    id: row.id,
    assignmentId: row.assignment_id,
    eventType: row.event_type,
    effectiveOn: row.effective_on,
    scopeSha256: row.scope_sha256,
    reason: row.reason,
    reviewRequestId: row.review_request_id,
    actorEmployeeNumber: row.actor_employee_number,
    actorRole: row.actor_role,
    permissionUsed: row.permission_used,
    occurredAt: row.occurred_at,
  };
}

function verifyCollectiveEvent(row) {
  const scope = parseJson(row?.scope_snapshot_json, null);
  if (!row || !scope || canonicalSha256(scope) !== row.scope_sha256
    || canonicalSha256(collectiveEventReceiptCore(row)) !== row.receipt_sha256) {
    throw integrityError("Das KV-Zuordnungsereignis stimmt nicht mit seinem Prüfbeleg überein.");
  }
  return { row, scopeSnapshot: scope };
}

function governanceEventReceiptCore(row) {
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    kind: "work_rule_governance_event",
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    sequenceNo: Number(row.sequence_no),
    eventType: row.event_type,
    payloadSha256: row.payload_sha256,
    previousReceiptSha256: row.previous_receipt_sha256,
    actorEmployeeNumber: row.actor_employee_number,
    actorRole: row.actor_role,
    permissionUsed: row.permission_used,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
  };
}

function appendGovernanceEvent(db, {
  aggregateType,
  aggregateId,
  eventType,
  payload,
  actor,
  correlationId = "",
  at = occurredAt(actor),
}) {
  const previous = db.prepare(`
    SELECT sequence_no, receipt_sha256
    FROM work_rule_governance_events
    WHERE aggregate_type = ? AND aggregate_id = ?
    ORDER BY sequence_no DESC
    LIMIT 1
  `).get(aggregateType, aggregateId);
  const row = {
    id: randomUUID(),
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    sequence_no: Number(previous?.sequence_no || 0) + 1,
    event_type: eventType,
    payload_json: JSON.stringify(payload),
    payload_sha256: canonicalSha256(payload),
    previous_receipt_sha256: previous?.receipt_sha256 || "",
    actor_employee_number: actor.employeeNumber,
    actor_role: actor.role,
    permission_used: actor.permission,
    correlation_id: String(correlationId || ""),
    occurred_at: at,
  };
  row.receipt_sha256 = canonicalSha256(governanceEventReceiptCore(row));
  db.prepare(`
    INSERT INTO work_rule_governance_events
      (id, aggregate_type, aggregate_id, sequence_no, event_type,
       payload_json, payload_sha256, previous_receipt_sha256,
       actor_employee_number, actor_role, permission_used, correlation_id,
       occurred_at, receipt_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.aggregate_type,
    row.aggregate_id,
    row.sequence_no,
    row.event_type,
    row.payload_json,
    row.payload_sha256,
    row.previous_receipt_sha256,
    row.actor_employee_number,
    row.actor_role,
    row.permission_used,
    row.correlation_id,
    row.occurred_at,
    row.receipt_sha256,
  );
  return row;
}

function verifyGovernanceEventRows(rows) {
  const previousByAggregate = new Map();
  return rows.map((row) => {
    const payload = parseJson(row.payload_json, null);
    const key = `${row.aggregate_type}:${row.aggregate_id}`;
    const previous = previousByAggregate.get(key);
    if (!payload || canonicalSha256(payload) !== row.payload_sha256
      || canonicalSha256(governanceEventReceiptCore(row)) !== row.receipt_sha256
      || Number(row.sequence_no) !== Number(previous?.sequenceNo || 0) + 1
      || row.previous_receipt_sha256 !== (previous?.receiptSha256 || "")) {
      throw integrityError("Die verkettete Governance-Historie ist nicht vollständig oder wurde verändert.");
    }
    previousByAggregate.set(key, {
      sequenceNo: Number(row.sequence_no),
      receiptSha256: row.receipt_sha256,
    });
    return {
      id: row.id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      sequenceNo: Number(row.sequence_no),
      eventType: row.event_type,
      payload,
      payloadSha256: row.payload_sha256,
      previousReceiptSha256: row.previous_receipt_sha256,
      actorEmployeeNumber: row.actor_employee_number,
      actorRole: row.actor_role,
      permissionUsed: row.permission_used,
      correlationId: row.correlation_id,
      occurredAt: row.occurred_at,
      receiptSha256: row.receipt_sha256,
    };
  });
}

function publicationEvents(db, publicationId) {
  return db.prepare(`
    SELECT *
    FROM work_rule_publication_events
    WHERE publication_id = ?
    ORDER BY effective_on,
      CASE event_type
        WHEN 'published' THEN 0
        WHEN 'superseded' THEN 1
        WHEN 'withdrawn' THEN 2
        ELSE 3
      END,
      occurred_at, id
  `).all(String(publicationId || "")).map((row) => (
    verifyLifecycleEvent("work_rule_publication_event", row, "publication_id")
  ));
}

function assignmentEvents(db, revisionId) {
  return db.prepare(`
    SELECT *
    FROM work_rule_assignment_events
    WHERE assignment_revision_id = ?
    ORDER BY effective_on, occurred_at, id
  `).all(String(revisionId || "")).map((row) => (
    verifyLifecycleEvent("work_rule_assignment_event", row, "assignment_revision_id")
  ));
}

function publicationState(db, publicationId, onDate = "9999-12-31") {
  const events = publicationEvents(db, publicationId)
    .filter((event) => event.effective_on <= onDate);
  const last = events.at(-1);
  return last?.event_type || "unknown";
}

function assignmentLifecycle(db, revisionRow) {
  const events = assignmentEvents(db, revisionRow.id);
  const activation = events.find((event) => event.event_type === "activated") || null;
  const terminal = events
    .filter((event) => ["deactivated", "superseded"].includes(event.event_type))
    .sort((left, right) => (
      left.effective_on.localeCompare(right.effective_on)
      || left.occurred_at.localeCompare(right.occurred_at)
      || left.id.localeCompare(right.id)
    ))[0] || null;
  let validFrom = revisionRow.valid_from;
  if (activation && activation.effective_on > validFrom) validFrom = activation.effective_on;
  let validTo = revisionRow.valid_to || null;
  if (terminal) {
    const terminalEnd = addDays(terminal.effective_on, -1);
    if (!validTo || terminalEnd < validTo) validTo = terminalEnd;
  }
  return {
    events,
    activation,
    terminal,
    validFrom,
    validTo,
    active: Boolean(activation && (!validTo || validTo >= validFrom)),
  };
}

function listGovernedWorkRuleAssignments(db, options = {}) {
  assertGovernanceTables(db);
  const includeInactive = options.includeInactive === true;
  const rows = db.prepare(`
    SELECT r.*, v.profile_id, p.name AS profile_name
    FROM work_rule_assignment_revisions r
    JOIN work_rule_profile_versions v ON v.id = r.profile_version_id
    JOIN work_rule_profiles p ON p.id = v.profile_id
    ORDER BY r.logical_assignment_id, r.revision, r.id
  `).all();
  const result = [];
  for (const raw of rows) {
    const { row, expandedScopes } = verifyAssignmentRevisionRow(raw);
    const lifecycle = assignmentLifecycle(db, row);
    if (!includeInactive && !lifecycle.active) continue;
    const scopes = expandedScopes.length
      ? expandedScopes
      : [{ type: row.scope_type, key: row.scope_key }];
    for (const scope of scopes) {
      if (!["installation", "location", "department", "employee"].includes(scope.type)) continue;
      result.push({
        id: `${row.id}:${scope.type}:${scope.key}`,
        governedRevisionId: row.id,
        logicalAssignmentId: row.logical_assignment_id,
        revision: Number(row.revision),
        publicationId: row.publication_id,
        profileId: row.profile_id,
        profileVersionId: row.profile_version_id,
        profileName: row.profile_name,
        scopeType: scope.type,
        scopeKey: scope.type === "installation" ? "" : scope.key,
        governedScopeType: row.scope_type,
        governedScopeKey: row.scope_key,
        expandedScopes,
        validFrom: lifecycle.validFrom,
        validTo: lifecycle.validTo,
        enforcementMode: row.enforcement_mode,
        applicabilityConfirmed: Boolean(row.applicability_confirmed),
        active: lifecycle.active,
        createdBy: row.created_by,
        createdAt: row.created_at,
        receiptSha256: row.receipt_sha256,
      });
    }
  }
  return result;
}

function expandAssignmentScope(db, scopeType, scopeKey, blockers) {
  if (!ASSIGNMENT_SCOPE_TYPES.has(scopeType)) {
    blockers.push(conflict("SCOPE_UNSUPPORTED", "Der Geltungsbereich wird nicht unterstützt."));
    return [];
  }
  if (scopeType === "employee_group") {
    blockers.push(conflict(
      "EMPLOYEE_GROUP_UNSUPPORTED",
      "Beschäftigtengruppen können erst nach einer belastbaren Stammdaten-Zuordnung aktiviert werden.",
    ));
    return [];
  }
  if (scopeType === "installation") return [{ type: "installation", key: "" }];
  if (scopeType === "business_unit") {
    const unit = db.prepare(`
      SELECT id, active
      FROM collective_agreement_business_units
      WHERE id = ?
    `).get(scopeKey);
    if (!unit || !unit.active) {
      blockers.push(conflict("BUSINESS_UNIT_NOT_ACTIVE", "Der ausgewählte Betriebsteil ist nicht aktiv."));
      return [];
    }
    const scopes = db.prepare(`
      SELECT scope_type, scope_key
      FROM collective_agreement_business_unit_scopes
      WHERE business_unit_id = ?
      ORDER BY scope_type, scope_key
    `).all(scopeKey);
    if (!scopes.length) {
      blockers.push(conflict("BUSINESS_UNIT_EMPTY", "Der Betriebsteil enthält keinen prüfbaren Bereich."));
      return [];
    }
    const expanded = [];
    for (const scope of scopes) {
      if (scope.scope_type === "cost_center") {
        blockers.push(conflict(
          "COST_CENTER_SCOPE_UNSUPPORTED",
          "Kostenstellen können noch nicht verlustfrei in aktive Regelbereiche aufgelöst werden.",
          { scopeKey: String(scope.scope_key) },
        ));
        continue;
      }
      expanded.push(...expandAssignmentScope(db, scope.scope_type, String(scope.scope_key), blockers));
    }
    return sortedScopes(expanded);
  }
  const queries = {
    location: "SELECT id FROM locations WHERE CAST(id AS TEXT) = ? AND active = 1",
    department: `
      SELECT d.id
      FROM departments d
      JOIN locations l ON l.id = d.location_id
      WHERE CAST(d.id AS TEXT) = ? AND d.active = 1 AND l.active = 1
    `,
    employee: "SELECT personnel_number FROM employees WHERE personnel_number = ? AND active = 1",
  };
  if (!db.prepare(queries[scopeType]).get(scopeKey)) {
    blockers.push(conflict(
      "SCOPE_TARGET_NOT_ACTIVE",
      "Das Ziel des Geltungsbereichs wurde nicht gefunden oder ist nicht aktiv.",
      { scopeType, scopeKey },
    ));
    return [];
  }
  return [{ type: scopeType, key: scopeKey }];
}

function collectiveAssignmentSnapshot(db, assignmentId, blockers = []) {
  const assignment = db.prepare(`
    SELECT a.*, v.agreement_id, v.version_label, v.valid_from AS version_valid_from,
           v.valid_to AS version_valid_to, v.content_sha256 AS agreement_version_sha256,
           v.linked_profile_version_id, c.code AS agreement_code,
           u.code AS business_unit_code, u.active AS business_unit_active
    FROM collective_agreement_assignments a
    JOIN collective_agreement_versions v ON v.id = a.agreement_version_id
    JOIN collective_agreements c ON c.id = v.agreement_id
    JOIN collective_agreement_business_units u ON u.id = a.business_unit_id
    WHERE a.id = ?
  `).get(String(assignmentId || ""));
  if (!assignment) {
    throw governanceError("Der KV-Zuordnungsvorschlag wurde nicht gefunden.", "WORK_RULE_GOVERNANCE_SUBJECT_NOT_FOUND", 404);
  }
  if (!assignment.business_unit_active) {
    blockers.push(conflict("BUSINESS_UNIT_NOT_ACTIVE", "Der Betriebsteil ist nicht aktiv."));
  }
  const scopes = db.prepare(`
    SELECT scope_type, scope_key
    FROM collective_agreement_business_unit_scopes
    WHERE business_unit_id = ?
    ORDER BY scope_type, scope_key
  `).all(assignment.business_unit_id).map((scope) => ({
    type: scope.scope_type,
    key: String(scope.scope_key),
  }));
  if (!scopes.length) {
    blockers.push(conflict("BUSINESS_UNIT_EMPTY", "Der Betriebsteil enthält keinen dokumentierten Bereich."));
  }
  if (scopes.some((scope) => scope.type === "cost_center")) {
    blockers.push(conflict(
      "COST_CENTER_SCOPE_UNSUPPORTED",
      "Eine KV-Zuordnung über Kostenstellen kann noch nicht sicher aktiviert werden.",
    ));
  }
  const scopeSnapshot = {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    assignmentId: assignment.id,
    agreementId: assignment.agreement_id,
    agreementVersionId: assignment.agreement_version_id,
    agreementVersionSha256: assignment.agreement_version_sha256,
    businessUnitId: assignment.business_unit_id,
    scopes: sortedScopes(scopes),
    validFrom: assignment.valid_from,
    validTo: assignment.valid_to || null,
  };
  return { assignment, scopeSnapshot };
}

function effectiveCollectiveAgreementIntervals(db) {
  const rows = db.prepare(`
    SELECT *
    FROM collective_agreement_assignment_events
    ORDER BY assignment_id, effective_on, occurred_at, id
  `).all();
  const byAssignment = new Map();
  for (const row of rows) {
    const verified = verifyCollectiveEvent(row);
    const entries = byAssignment.get(row.assignment_id) || [];
    entries.push(verified);
    byAssignment.set(row.assignment_id, entries);
  }
  const intervals = [];
  for (const entries of byAssignment.values()) {
    const approvals = entries.filter((entry) => entry.row.event_type === "approved");
    const deactivations = entries.filter((entry) => entry.row.event_type === "deactivated");
    if (approvals.length > 1 || deactivations.length > 1) {
      throw integrityError("Die KV-Zuordnung enthält einen widersprüchlichen Lebenszyklus.");
    }
    const approval = approvals[0] || null;
    const deactivation = deactivations[0] || null;
    if (!approval) {
      if (deactivation) {
        throw integrityError("Eine KV-Zuordnung wurde ohne vorherige Freigabe beendet.");
      }
      continue;
    }
    if (deactivation && deactivation.row.effective_on < approval.row.effective_on) {
      throw integrityError("Das Ende einer KV-Zuordnung liegt vor ihrer Freigabe.");
    }
    const validFrom = approval.row.effective_on > approval.scopeSnapshot.validFrom
      ? approval.row.effective_on
      : approval.scopeSnapshot.validFrom;
    let validTo = approval.scopeSnapshot.validTo || null;
    if (deactivation) {
      const terminalEnd = addDays(deactivation.row.effective_on, -1);
      if (!validTo || terminalEnd < validTo) validTo = terminalEnd;
    }
    if (!validTo || validTo >= validFrom) {
      intervals.push({
        ...approval,
        deactivation,
        scopeSnapshot: {
          ...approval.scopeSnapshot,
          validFrom,
          validTo,
        },
      });
    }
  }
  return intervals;
}

function normalizeAssignmentPayload(db, publication, version, rawPayload, blockers, now) {
  const raw = objectValue(rawPayload);
  const profileScopeType = String(version.profile?.applicability?.scopeType || "installation");
  const profileScopeKey = String(version.profile?.applicability?.scopeKey || "");
  const scopeType = String(raw.scopeType || profileScopeType || "installation");
  const scopeKey = scopeType === "installation" ? "" : String(raw.scopeKey ?? profileScopeKey ?? "").trim();
  const validFrom = isoDate(raw.validFrom, "Gültig ab", version.validFrom);
  const validTo = raw.validTo
    ? isoDate(raw.validTo, "Gültig bis")
    : (version.validTo || null);
  if (validTo && validTo < validFrom) {
    blockers.push(conflict("ASSIGNMENT_DATE_INVALID", "Das Gültigkeitsende liegt vor dem Gültigkeitsbeginn."));
  }
  if (validFrom < version.validFrom || (version.validTo && (!validTo || validTo > version.validTo))) {
    blockers.push(conflict(
      "ASSIGNMENT_OUTSIDE_VERSION",
      "Die Zuordnung liegt außerhalb der Gültigkeit der veröffentlichten Fassung.",
    ));
  }
  if (scopeType !== profileScopeType
    || (scopeType !== "installation" && scopeKey !== profileScopeKey)) {
    blockers.push(conflict(
      "ASSIGNMENT_SCOPE_MISMATCH",
      "Der aktive Geltungsbereich muss exakt dem fachlich freigegebenen Regelscope entsprechen.",
      {
        approvedScope: { type: profileScopeType, key: profileScopeKey },
        requestedScope: { type: scopeType, key: scopeKey },
      },
    ));
  }
  const expandedScopes = expandAssignmentScope(db, scopeType, scopeKey, blockers);
  const enforcementMode = String(raw.enforcementMode || version.profile?.defaultEnforcementMode || "monitor");
  if (!["monitor", "enforced"].includes(enforcementMode)) {
    blockers.push(conflict("ENFORCEMENT_MODE_INVALID", "Der Durchsetzungsmodus ist ungültig."));
  }
  const applicabilityConfirmed = raw.applicabilityConfirmed === true;
  if (!applicabilityConfirmed) {
    blockers.push(conflict(
      "APPLICABILITY_NOT_CONFIRMED",
      "Der aktive Regelbetrieb benötigt eine ausdrücklich bestätigte Anwendbarkeit.",
    ));
  }
  const logicalAssignmentId = optionalText(raw.logicalAssignmentId, 160)
    || `governed:${canonicalSha256({
      publicationId: publication.id,
      scopeType,
      scopeKey,
    }).slice(0, 32)}`;
  const supersedesRevisionId = optionalText(raw.supersedesRevisionId, 160) || null;
  const effectiveOn = isoDate(raw.effectiveOn, "Aktivierungstag", validFrom || todayIso(now));
  if (effectiveOn < validFrom || (validTo && effectiveOn > validTo)) {
    blockers.push(conflict(
      "ACTIVATION_DATE_OUTSIDE_ASSIGNMENT",
      "Der Aktivierungstag liegt außerhalb des Zuordnungszeitraums.",
    ));
  }
  return {
    publicationId: publication.id,
    logicalAssignmentId,
    supersedesRevisionId,
    scopeType,
    scopeKey,
    expandedScopes,
    scopeSha256: canonicalSha256(expandedScopes),
    validFrom,
    validTo,
    effectiveOn,
    enforcementMode,
    applicabilityConfirmed,
    rationale: optionalText(raw.rationale, 2000),
    sourceReference: optionalText(raw.sourceReference, 1200),
  };
}

function customRuleDefinitionForVersion(version) {
  const rule = Array.isArray(version.rules) ? version.rules[0] : null;
  return {
    metric: rule?.condition?.metric || version.profile?.limits?.metric || "",
    reaction: rule?.enforcement || "advisory",
    severity: rule?.severity || "warning",
    scopeType: rule?.scope?.type || version.profile?.applicability?.scopeType || "installation",
    scopeKey: String(rule?.scope?.key || version.profile?.applicability?.scopeKey || ""),
    testCases: Array.isArray(rule?.testCases) ? rule.testCases : [],
  };
}

function governedAssignmentConflictBasis(db) {
  return db.prepare(`
    SELECT r.id, r.logical_assignment_id, r.revision, r.profile_version_id,
           r.scope_type, r.scope_key, r.scope_sha256, r.valid_from, r.valid_to,
           r.enforcement_mode, r.receipt_sha256,
           GROUP_CONCAT(e.receipt_sha256, ',') AS event_receipts
    FROM work_rule_assignment_revisions r
    LEFT JOIN work_rule_assignment_events e ON e.assignment_revision_id = r.id
    GROUP BY r.id
    ORDER BY r.logical_assignment_id, r.revision, r.id
  `).all().map((row) => ({
    id: row.id,
    logicalAssignmentId: row.logical_assignment_id,
    revision: Number(row.revision),
    profileVersionId: row.profile_version_id,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    scopeSha256: row.scope_sha256,
    validFrom: row.valid_from,
    validTo: row.valid_to || null,
    enforcementMode: row.enforcement_mode,
    receiptSha256: row.receipt_sha256,
    eventReceipts: String(row.event_receipts || "").split(",").filter(Boolean).sort(),
  }));
}

function addAssignmentOverlapConflicts(db, payload, profileId, blockers) {
  const governed = listGovernedWorkRuleAssignments(db, { includeInactive: false });
  for (const existing of governed) {
    if (existing.profileId !== profileId) continue;
    if (payload.supersedesRevisionId && existing.governedRevisionId === payload.supersedesRevisionId) continue;
    if (!payload.expandedScopes.some((scope) => (
      scope.type === existing.scopeType && scope.key === String(existing.scopeKey || "")
    ))) continue;
    if (!dateRangesOverlap(payload.validFrom, payload.validTo, existing.validFrom, existing.validTo)) continue;
    blockers.push(conflict(
      "ASSIGNMENT_OVERLAP",
      "Für dasselbe Regelprofil besteht im Zielbereich bereits eine überlappende aktive Zuordnung.",
      { existingRevisionId: existing.governedRevisionId },
    ));
  }
  if (!tableExists(db, "work_rule_assignments")) return;
  const legacy = db.prepare(`
    SELECT a.id, a.scope_type, a.scope_key, a.valid_from, a.valid_to, v.profile_id
    FROM work_rule_assignments a
    JOIN work_rule_profile_versions v ON v.id = a.profile_version_id
    WHERE a.active = 1 AND v.profile_id = ?
  `).all(profileId);
  for (const existing of legacy) {
    if (!payload.expandedScopes.some((scope) => (
      scope.type === existing.scope_type && scope.key === String(existing.scope_key || "")
    ))) continue;
    if (!dateRangesOverlap(payload.validFrom, payload.validTo, existing.valid_from, existing.valid_to)) continue;
    blockers.push(conflict(
      "LEGACY_ASSIGNMENT_OVERLAP",
      "Eine bestehende Alt-Zuordnung desselben Regelprofils überschneidet den Zielbereich.",
      { existingAssignmentId: existing.id },
    ));
  }
}

function buildGovernancePreview(db, input, actor = {}) {
  assertGovernanceTables(db);
  const { operation, subjectType } = assertGovernanceOperation(
    input?.operation,
    input?.subjectType,
  );
  const subjectId = requiredText(input?.subjectId, "Governance-Objekt", 180);
  const rawPayload = objectValue(input?.payload);
  const now = actor?.now ? new Date(actor.now) : new Date();
  const safeNow = Number.isNaN(now.getTime()) ? new Date() : now;
  const blockers = [];
  const warnings = [];
  let subjectAuthor = "";
  let subject = {};
  let payload = {};
  let critical = false;

  if (operation === "publish_rule") {
    const row = profileVersionRow(db, subjectId);
    if (!row) {
      throw governanceError("Die Regelfassung wurde nicht gefunden.", "WORK_RULE_GOVERNANCE_SUBJECT_NOT_FOUND", 404);
    }
    const source = customWorkRuleDefinitionFromVersion(db, subjectId);
    const version = getWorkRuleProfileVersion(db, subjectId);
    const definition = customRuleDefinitionForVersion(version);
    const latestUnreleased = db.prepare(`
      SELECT v.id
      FROM work_rule_profile_versions v
      LEFT JOIN work_rule_publications p ON p.source_profile_version_id = v.id
      WHERE v.profile_id = ? AND v.status = 'draft' AND v.version LIKE 'draft-%'
        AND p.id IS NULL
      ORDER BY CAST(SUBSTR(v.version, 7) AS INTEGER) DESC, v.created_at DESC, v.id DESC
      LIMIT 1
    `).get(row.profile_id)?.id || null;
    const existingPublication = db.prepare(`
      SELECT id FROM work_rule_publications WHERE source_profile_version_id = ?
    `).get(subjectId);
    if (row.status !== "draft" || source.versionKind !== "draft") {
      blockers.push(conflict("RULE_NOT_DRAFT", "Nur eine unveröffentlichte Entwurfsfassung kann eingereicht werden."));
    }
    if (existingPublication) {
      blockers.push(conflict("RULE_ALREADY_PUBLISHED", "Diese Entwurfsfassung wurde bereits veröffentlicht."));
    }
    if (latestUnreleased && latestUnreleased !== subjectId) {
      blockers.push(conflict(
        "RULE_DRAFT_STALE",
        "Für diese Regel liegt bereits eine neuere unveröffentlichte Entwurfsfassung vor.",
        { latestDraftVersionId: latestUnreleased },
      ));
    }
    if (!SUPPORTED_CUSTOM_SCHEDULE_METRIC_SET.has(definition.metric)) {
      warnings.push(conflict(
        "CUSTOM_METRIC_UNSUPPORTED",
        "Der Regelbaustein ist noch nicht an eine wirksame Laufzeitprüfung angebunden.",
        { metric: definition.metric },
      ));
    }
    if (definition.scopeType === "employee_group") {
      warnings.push(conflict(
        "EMPLOYEE_GROUP_UNSUPPORTED",
        "Beschäftigtengruppen können noch nicht sicher aktiviert werden.",
      ));
    }
    if (!definition.testCases.length
      || definition.testCases.some((testCase) => testCase.expected !== testCase.actual)) {
      blockers.push(conflict(
        "CUSTOM_RULE_TESTS_FAILED",
        "Positiver, negativer und unklarer Testfall sind nicht vollständig erfolgreich.",
      ));
    }
    const nextReleaseNumber = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM work_rule_profile_versions
      WHERE profile_id = ? AND version LIKE 'release-%'
    `).get(row.profile_id).count || 0) + 1;
    const publicationEffectiveOn = isoDate(
      rawPayload.effectiveOn,
      "Veröffentlichungstag",
      source.validFrom,
    );
    if (publicationEffectiveOn < source.validFrom
      || (source.validTo && publicationEffectiveOn > source.validTo)) {
      blockers.push(conflict(
        "PUBLICATION_DATE_OUTSIDE_RULE_VERSION",
        "Der Veröffentlichungstag liegt außerhalb der dokumentierten Regelfassung.",
      ));
    }
    critical = definition.reaction === "block";
    payload = {
      sourceProfileVersionId: subjectId,
      semanticSha256: customWorkRuleSemanticSha256(row.profile_id, source.definition),
      effectiveOn: publicationEffectiveOn,
    };
    subjectAuthor = row.created_by;
    subject = {
      id: row.id,
      profileId: row.profile_id,
      version: row.version,
      status: row.status,
      contentSha256: row.content_sha256,
      semanticSha256: payload.semanticSha256,
      currentProfileVersionId: row.current_version_id,
      latestUnreleasedDraftId: latestUnreleased,
      nextReleaseNumber,
      definition,
    };
  } else if (operation === "activate_assignment") {
    const publication = verifyPublicationRow(db.prepare(`
      SELECT * FROM work_rule_publications WHERE id = ?
    `).get(subjectId));
    const version = getWorkRuleProfileVersion(db, publication.released_profile_version_id);
    if (!version) throw integrityError("Die veröffentlichte Regelprofil-Version fehlt.");
    const definition = customRuleDefinitionForVersion(version);
    payload = normalizeAssignmentPayload(db, publication, version, rawPayload, blockers, safeNow);
    const activationPublicationState = publicationState(
      db,
      publication.id,
      payload.effectiveOn,
    );
    if (activationPublicationState !== "published") {
      blockers.push(conflict("PUBLICATION_NOT_ACTIVE", "Die Veröffentlichung ist nicht aktiv."));
    }
    if (!SUPPORTED_CUSTOM_SCHEDULE_METRIC_SET.has(definition.metric)) {
      blockers.push(conflict(
        "CUSTOM_METRIC_UNSUPPORTED",
        "Der Regelbaustein ist noch nicht an eine wirksame Laufzeitprüfung angebunden.",
        { metric: definition.metric },
      ));
    }
    addAssignmentOverlapConflicts(db, payload, version.profileId, blockers);
    const logicalProfileIds = db.prepare(`
      SELECT DISTINCT v.profile_id
      FROM work_rule_assignment_revisions r
      JOIN work_rule_profile_versions v ON v.id = r.profile_version_id
      WHERE r.logical_assignment_id = ?
    `).all(payload.logicalAssignmentId).map((entry) => String(entry.profile_id));
    if (logicalProfileIds.some((profileId) => profileId !== version.profileId)) {
      blockers.push(conflict(
        "LOGICAL_ASSIGNMENT_PROFILE_MISMATCH",
        "Die logische Zuordnungs-ID gehört bereits zu einem anderen Regelprofil.",
      ));
    }
    if (payload.supersedesRevisionId) {
      const superseded = db.prepare(`
        SELECT r.*, v.profile_id
        FROM work_rule_assignment_revisions r
        JOIN work_rule_profile_versions v ON v.id = r.profile_version_id
        WHERE r.id = ?
      `).get(payload.supersedesRevisionId);
      if (!superseded || superseded.logical_assignment_id !== payload.logicalAssignmentId
        || superseded.profile_id !== version.profileId) {
        blockers.push(conflict(
          "SUPERSEDED_ASSIGNMENT_INVALID",
          "Die abzulösende Revision gehört nicht zur angegebenen Zuordnung und Regel.",
        ));
      } else {
        const verifiedSuperseded = verifyAssignmentRevisionRow(superseded);
        const supersededLifecycle = assignmentLifecycle(db, verifiedSuperseded.row);
        const activeAtEffectiveOn = supersededLifecycle.activation
          && supersededLifecycle.activation.effective_on <= payload.effectiveOn
          && (!supersededLifecycle.validTo
            || supersededLifecycle.validTo >= payload.effectiveOn);
        if (!activeAtEffectiveOn || supersededLifecycle.terminal) {
          blockers.push(conflict(
            "SUPERSEDED_ASSIGNMENT_NOT_ACTIVE",
            "Die abzulösende Zuordnungsrevision ist am Ablösetag nicht unbeendet wirksam.",
          ));
        }
      }
    }
    critical = payload.enforcementMode === "enforced" || definition.reaction === "block";
    subjectAuthor = publication.published_by;
    subject = {
      id: publication.id,
      profileId: publication.profile_id,
      releasedProfileVersionId: publication.released_profile_version_id,
      semanticSha256: publication.semantic_sha256,
      publicationReceiptSha256: publication.receipt_sha256,
      publicationState: activationPublicationState,
      versionContentSha256: version.contentSha256,
      definition,
      assignments: governedAssignmentConflictBasis(db),
    };
  } else if (operation === "deactivate_assignment") {
    const verified = verifyAssignmentRevisionRow(db.prepare(`
      SELECT * FROM work_rule_assignment_revisions WHERE id = ?
    `).get(subjectId));
    const lifecycle = assignmentLifecycle(db, verified.row);
    if (!lifecycle.activation || lifecycle.terminal) {
      blockers.push(conflict(
        "ASSIGNMENT_NOT_ACTIVE",
        "Die Zuordnungsrevision ist nicht aktiv oder wurde bereits beendet.",
      ));
    }
    const effectiveOn = isoDate(rawPayload.effectiveOn, "Deaktivierungstag", todayIso(safeNow));
    if (effectiveOn < lifecycle.validFrom) {
      blockers.push(conflict(
        "DEACTIVATION_BEFORE_ACTIVATION",
        "Die Deaktivierung darf nicht vor der Aktivierung liegen.",
      ));
    }
    payload = {
      assignmentRevisionId: verified.row.id,
      effectiveOn,
    };
    critical = true;
    subjectAuthor = verified.row.created_by;
    subject = {
      id: verified.row.id,
      logicalAssignmentId: verified.row.logical_assignment_id,
      revision: Number(verified.row.revision),
      publicationId: verified.row.publication_id,
      profileVersionId: verified.row.profile_version_id,
      scopeSha256: verified.row.scope_sha256,
      validFrom: verified.row.valid_from,
      validTo: verified.row.valid_to || null,
      enforcementMode: verified.row.enforcement_mode,
      receiptSha256: verified.row.receipt_sha256,
      eventReceipts: lifecycle.events.map((event) => event.receipt_sha256),
    };
  } else if (operation === "withdraw_publication") {
    const publication = verifyPublicationRow(db.prepare(`
      SELECT * FROM work_rule_publications WHERE id = ?
    `).get(subjectId));
    const effectiveOn = isoDate(rawPayload.effectiveOn, "Rücknahmetag", todayIso(safeNow));
    const state = publicationState(db, publication.id, effectiveOn);
    if (state !== "published") {
      blockers.push(conflict("PUBLICATION_NOT_ACTIVE", "Die Veröffentlichung wurde bereits beendet."));
    }
    const activeAssignments = listGovernedWorkRuleAssignments(db, { includeInactive: false })
      .filter((assignment) => assignment.publicationId === publication.id
        && (!assignment.validTo || assignment.validTo >= effectiveOn));
    const activeAssignmentRevisionIds = [
      ...new Set(activeAssignments.map((item) => item.governedRevisionId)),
    ];
    if (activeAssignments.length) {
      warnings.push(conflict(
        "PUBLICATION_HAS_ACTIVE_ASSIGNMENTS",
        "Alle wirksamen oder künftigen Zuordnungen werden bei der Rücknahme kontrolliert beendet.",
        { assignmentRevisionIds: activeAssignmentRevisionIds },
      ));
    }
    payload = {
      publicationId: publication.id,
      effectiveOn,
      assignmentRevisionIds: activeAssignmentRevisionIds,
    };
    critical = true;
    subjectAuthor = publication.published_by;
    subject = {
      id: publication.id,
      profileId: publication.profile_id,
      releasedProfileVersionId: publication.released_profile_version_id,
      semanticSha256: publication.semantic_sha256,
      receiptSha256: publication.receipt_sha256,
      state,
      eventReceipts: publicationEvents(db, publication.id).map((event) => event.receipt_sha256),
      activeAssignmentRevisionIds,
    };
  } else {
    const { assignment, scopeSnapshot } = collectiveAssignmentSnapshot(db, subjectId, blockers);
    const existing = db.prepare(`
      SELECT *
      FROM collective_agreement_assignment_events
      WHERE assignment_id = ?
      ORDER BY effective_on, occurred_at, id
    `).all(subjectId).map(verifyCollectiveEvent);
    const approved = existing.find((entry) => entry.row.event_type === "approved") || null;
    const deactivated = existing.find((entry) => entry.row.event_type === "deactivated") || null;
    const effectiveOn = isoDate(
      rawPayload.effectiveOn,
      operation === "approve_kv_assignment" ? "Freigabetag" : "Deaktivierungstag",
      operation === "approve_kv_assignment" ? assignment.valid_from : todayIso(safeNow),
    );
    if (effectiveOn < assignment.valid_from
      || (assignment.valid_to && effectiveOn > assignment.valid_to)) {
      blockers.push(conflict(
        "KV_EFFECTIVE_DATE_OUTSIDE_ASSIGNMENT",
        "Der Wirksamkeitstag liegt außerhalb des dokumentierten Zuordnungszeitraums.",
      ));
    }
    if (assignment.valid_from < assignment.version_valid_from
      || (assignment.version_valid_to
        && (!assignment.valid_to || assignment.valid_to > assignment.version_valid_to))) {
      blockers.push(conflict(
        "KV_ASSIGNMENT_OUTSIDE_VERSION",
        "Der Zuordnungszeitraum liegt außerhalb der dokumentierten KV-Fassung.",
      ));
    }
    if (operation === "approve_kv_assignment") {
      if (approved) {
        blockers.push(conflict(
          "KV_ASSIGNMENT_ALREADY_APPROVED",
          "Die KV-Zuordnung wurde bereits entschieden und kann nicht erneut freigegeben werden.",
        ));
      }
      const candidateValidFrom = effectiveOn > scopeSnapshot.validFrom
        ? effectiveOn
        : scopeSnapshot.validFrom;
      for (const active of effectiveCollectiveAgreementIntervals(db)) {
        if (active.row.assignment_id === assignment.id) continue;
        const other = active.scopeSnapshot;
        const sameScope = scopeSnapshot.scopes.some((scope) => (
          other.scopes.some((candidate) => candidate.type === scope.type && candidate.key === scope.key)
        ));
        if (sameScope && dateRangesOverlap(
          candidateValidFrom,
          scopeSnapshot.validTo,
          other.validFrom,
          other.validTo,
        )) {
          blockers.push(conflict(
            "KV_ASSIGNMENT_OVERLAP",
            "Im selben organisatorischen Bereich ist bereits eine überlappende KV-Zuordnung freigegeben.",
            { existingAssignmentId: active.row.assignment_id },
          ));
        }
      }
    } else {
      if (!approved || deactivated) {
        blockers.push(conflict("KV_ASSIGNMENT_NOT_ACTIVE", "Die KV-Zuordnung ist nicht aktiv freigegeben."));
      }
      if (approved && effectiveOn < approved.row.effective_on) {
        blockers.push(conflict(
          "KV_DEACTIVATION_BEFORE_APPROVAL",
          "Die Deaktivierung darf nicht vor dem Freigabetag liegen.",
        ));
      }
    }
    payload = {
      assignmentId: assignment.id,
      effectiveOn,
      scopeSnapshot,
      scopeSha256: canonicalSha256(scopeSnapshot),
    };
    critical = true;
    subjectAuthor = assignment.created_by;
    subject = {
      id: assignment.id,
      agreementVersionId: assignment.agreement_version_id,
      agreementVersionSha256: assignment.agreement_version_sha256,
      agreementVersionValidFrom: assignment.version_valid_from,
      agreementVersionValidTo: assignment.version_valid_to || null,
      businessUnitId: assignment.business_unit_id,
      validFrom: assignment.valid_from,
      validTo: assignment.valid_to || null,
      scopeSha256: payload.scopeSha256,
      eventReceipts: existing.map((entry) => entry.row.receipt_sha256),
    };
  }

  const baseline = {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    operation,
    subjectType,
    subjectId,
    subject,
  };
  const baselineSha256 = canonicalSha256(baseline);
  const payloadSha256 = canonicalSha256(payload);
  const result = {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    operation,
    subjectType,
    subjectId,
    payload,
    blockers,
    warnings,
  };
  const resultSha256 = canonicalSha256(result);
  const outcome = blockers.length ? "blocked" : (warnings.length ? "warning" : "pass");
  const riskClass = critical ? "critical" : "standard";
  const requiredApprovals = critical ? 2 : 1;
  const basisSha256 = canonicalSha256({
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    operation,
    subjectType,
    subjectId,
    baselineSha256,
    payloadSha256,
    resultSha256,
  });
  return {
    operation,
    subjectType,
    subjectId,
    subjectAuthor,
    payload,
    payloadSha256,
    baseline,
    baselineSha256,
    result,
    resultSha256,
    outcome,
    riskClass,
    requiredApprovals,
    requiredFachlichApprovals: 1,
    basisSha256,
  };
}

function persistConflictRun(db, built, actor) {
  const at = occurredAt(actor);
  const row = {
    id: randomUUID(),
    operation: built.operation,
    subject_type: built.subjectType,
    subject_id: built.subjectId,
    baseline_sha256: built.baselineSha256,
    outcome: built.outcome,
    result_json: JSON.stringify(built.result),
    result_sha256: built.resultSha256,
    created_by: actor.employeeNumber,
    created_at: at,
  };
  row.receipt_sha256 = canonicalSha256(conflictReceiptCore(row));
  db.prepare(`
    INSERT INTO work_rule_conflict_runs
      (id, operation, subject_type, subject_id, baseline_sha256, outcome,
       result_json, result_sha256, created_by, created_at, receipt_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.operation,
    row.subject_type,
    row.subject_id,
    row.baseline_sha256,
    row.outcome,
    row.result_json,
    row.result_sha256,
    row.created_by,
    row.created_at,
    row.receipt_sha256,
  );
  return verifyConflictRow(row);
}

function previewWorkRuleGovernance(db, input, actorValue) {
  const operation = String(input?.operation || "");
  const actor = normalizeActor(actorValue, OPERATION_PERMISSIONS[operation] || "work_rules:read");
  return withImmediateTransaction(db, () => {
    const built = buildGovernancePreview(db, input, actor);
    const conflictRun = persistConflictRun(db, built, actor);
    return {
      ...built,
      conflictRunId: conflictRun.id,
      conflictRun,
    };
  });
}

function reviewDecisionRows(db, requestRow) {
  return db.prepare(`
    SELECT *
    FROM work_rule_review_decisions
    WHERE request_id = ?
    ORDER BY decided_at, id
  `).all(requestRow.id).map((row) => verifyDecisionRow(row, requestRow.receipt_sha256));
}

function reviewState(requestRow, decisions) {
  if (decisions.some((decision) => decision.decision === "reject")) return "rejected";
  const approvals = decisions.filter((decision) => decision.decision === "approve");
  const fachlich = approvals.filter((decision) => decision.qualification === "fachlich");
  if (approvals.length >= Number(requestRow.required_approvals)
    && fachlich.length >= Number(requestRow.required_fachlich_approvals)) {
    return "approved";
  }
  return "in_review";
}

function serializeReviewRequest(db, row) {
  const { payload } = verifyReviewRow(row);
  const decisions = reviewDecisionRows(db, row);
  const decisionState = reviewState(row, decisions);
  const state = decisionState === "rejected"
    ? decisionState
    : (finalizedArtifact(db, row) ? "applied" : decisionState);
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    operation: row.operation,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    basisSha256: row.basis_sha256,
    payload,
    payloadSha256: row.payload_sha256,
    riskClass: row.risk_class,
    requiredApprovals: Number(row.required_approvals),
    requiredFachlichApprovals: Number(row.required_fachlich_approvals),
    conflictRunId: row.conflict_run_id,
    reason: row.reason,
    sourceReference: row.source_reference,
    submittedBy: row.submitted_by,
    submittedRole: row.submitted_role,
    submittedPermission: row.submitted_permission,
    submittedAt: row.submitted_at,
    receiptSha256: row.receipt_sha256,
    decisions,
    state,
    approvalCount: decisions.filter((decision) => decision.decision === "approve").length,
    fachlichApprovalCount: decisions.filter((decision) => (
      decision.decision === "approve" && decision.qualification === "fachlich"
    )).length,
  };
}

function createWorkRuleReviewRequest(db, input, actorValue) {
  const { operation, subjectType } = assertGovernanceOperation(input?.operation, input?.subjectType);
  const actor = normalizeActor(actorValue, OPERATION_PERMISSIONS[operation]);
  const clientRequestId = requiredText(input?.clientRequestId, "Client-Vorgangs-ID", 160);
  const subjectId = requiredText(input?.subjectId, "Governance-Objekt", 180);
  const reason = requiredText(input?.reason, "Prüfbegründung", 2000);
  if (reason.length < 10) {
    throw governanceError(
      "Die Prüfbegründung muss mindestens zehn Zeichen enthalten.",
      "WORK_RULE_GOVERNANCE_REASON_REQUIRED",
    );
  }
  const sourceReference = optionalText(input?.sourceReference, 1200);
  const submittedPayloadSha256 = canonicalSha256(objectValue(input?.payload));
  return withImmediateTransaction(db, () => {
    assertGovernanceTables(db);
    const existing = db.prepare(`
      SELECT * FROM work_rule_review_requests WHERE client_request_id = ?
    `).get(clientRequestId);
    if (existing) {
      const serialized = serializeReviewRequest(db, existing);
      const submittedEventRow = db.prepare(`
        SELECT *
        FROM work_rule_governance_events
        WHERE aggregate_type = 'work_rule_review_request'
          AND aggregate_id = ?
          AND sequence_no = 1
          AND event_type = 'review_submitted'
      `).get(existing.id);
      if (!submittedEventRow) {
        throw integrityError("Der unveränderliche Einreichungsbeleg des Freigabeantrags fehlt.");
      }
      const submittedEvent = verifyGovernanceEventRows([submittedEventRow])[0];
      const originalPayloadSha256 = String(
        submittedEvent.payload.submittedPayloadSha256 || serialized.payloadSha256,
      );
      if (serialized.operation !== operation || serialized.subjectType !== subjectType
        || serialized.subjectId !== subjectId
        || existing.submitted_by !== actor.employeeNumber
        || existing.reason !== reason
        || existing.source_reference !== sourceReference
        || originalPayloadSha256 !== submittedPayloadSha256
        || (input?.basisSha256 && input.basisSha256 !== existing.basis_sha256)
        || (input?.conflictRunId && input.conflictRunId !== existing.conflict_run_id)) {
        throw governanceError(
          "Die Client-Vorgangs-ID wurde bereits mit einem anderen Inhalt verwendet.",
          "WORK_RULE_GOVERNANCE_IDEMPOTENCY_CONFLICT",
          409,
        );
      }
      return serialized;
    }

    const built = buildGovernancePreview(db, {
      operation,
      subjectType,
      subjectId,
      payload: input?.payload,
    }, actor);
    if (input?.basisSha256 && input.basisSha256 !== built.basisSha256) {
      throw governanceError(
        "Der Prüfstand hat sich geändert. Bitte die Konfliktprüfung aktualisieren.",
        "WORK_RULE_GOVERNANCE_BASIS_STALE",
        409,
      );
    }
    let conflictRun;
    if (input?.conflictRunId) {
      conflictRun = verifyConflictRow(db.prepare(`
        SELECT * FROM work_rule_conflict_runs WHERE id = ?
      `).get(String(input.conflictRunId)));
      if (conflictRun.operation !== operation || conflictRun.subjectType !== subjectType
        || conflictRun.subjectId !== subjectId
        || conflictRun.baselineSha256 !== built.baselineSha256
        || conflictRun.resultSha256 !== built.resultSha256
        || conflictRun.outcome !== built.outcome) {
        throw governanceError(
          "Der Konfliktprüflauf gehört nicht mehr zum aktuellen Prüfstand.",
          "WORK_RULE_GOVERNANCE_CONFLICT_STALE",
          409,
        );
      }
    } else {
      conflictRun = persistConflictRun(db, built, actor);
    }
    if (built.outcome === "blocked") {
      const error = governanceError(
        "Die Operation ist wegen offener Konflikte nicht freigabefähig.",
        "WORK_RULE_GOVERNANCE_CONFLICT_BLOCKED",
        409,
      );
      error.conflicts = built.result.blockers;
      throw error;
    }
    const at = occurredAt(actor);
    const row = {
      id: randomUUID(),
      client_request_id: clientRequestId,
      operation,
      subject_type: subjectType,
      subject_id: subjectId,
      basis_sha256: built.basisSha256,
      payload_json: JSON.stringify(built.payload),
      payload_sha256: built.payloadSha256,
      risk_class: built.riskClass,
      required_approvals: built.requiredApprovals,
      required_fachlich_approvals: built.requiredFachlichApprovals,
      conflict_run_id: conflictRun.id,
      reason,
      source_reference: sourceReference,
      submitted_by: actor.employeeNumber,
      submitted_role: actor.role,
      submitted_permission: actor.permission,
      submitted_at: at,
    };
    row.receipt_sha256 = canonicalSha256(reviewReceiptCore(row));
    db.prepare(`
      INSERT INTO work_rule_review_requests
        (id, client_request_id, operation, subject_type, subject_id, basis_sha256,
         payload_json, payload_sha256, risk_class, required_approvals,
         required_fachlich_approvals, conflict_run_id, reason, source_reference,
         submitted_by, submitted_role, submitted_permission, submitted_at,
         receipt_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.client_request_id,
      row.operation,
      row.subject_type,
      row.subject_id,
      row.basis_sha256,
      row.payload_json,
      row.payload_sha256,
      row.risk_class,
      row.required_approvals,
      row.required_fachlich_approvals,
      row.conflict_run_id,
      row.reason,
      row.source_reference,
      row.submitted_by,
      row.submitted_role,
      row.submitted_permission,
      row.submitted_at,
      row.receipt_sha256,
    );
    appendGovernanceEvent(db, {
      aggregateType: "work_rule_review_request",
      aggregateId: row.id,
      eventType: "review_submitted",
      payload: {
        operation,
        subjectType,
        subjectId,
        basisSha256: row.basis_sha256,
        payloadSha256: row.payload_sha256,
        riskClass: row.risk_class,
        requiredApprovals: row.required_approvals,
        requiredFachlichApprovals: row.required_fachlich_approvals,
        conflictRunId: row.conflict_run_id,
        submittedPayloadSha256,
        requestReceiptSha256: row.receipt_sha256,
      },
      actor,
      correlationId: row.id,
      at,
    });
    return serializeReviewRequest(db, row);
  });
}

function normalizeRequestCall(requestIdOrInput, inputOrActor, maybeActor) {
  if (requestIdOrInput && typeof requestIdOrInput === "object") {
    return {
      requestId: requestIdOrInput.requestId,
      input: requestIdOrInput,
      actor: inputOrActor,
    };
  }
  return {
    requestId: requestIdOrInput,
    input: objectValue(inputOrActor),
    actor: maybeActor,
  };
}

function subjectAuthor(db, requestRow) {
  if (requestRow.operation === "publish_rule") {
    return profileVersionRow(db, requestRow.subject_id)?.created_by || "";
  }
  if (requestRow.operation === "activate_assignment") {
    return db.prepare("SELECT published_by FROM work_rule_publications WHERE id = ?")
      .get(requestRow.subject_id)?.published_by || "";
  }
  if (requestRow.operation === "deactivate_assignment") {
    return db.prepare("SELECT created_by FROM work_rule_assignment_revisions WHERE id = ?")
      .get(requestRow.subject_id)?.created_by || "";
  }
  if (requestRow.operation === "withdraw_publication") {
    return db.prepare("SELECT published_by FROM work_rule_publications WHERE id = ?")
      .get(requestRow.subject_id)?.published_by || "";
  }
  return db.prepare("SELECT created_by FROM collective_agreement_assignments WHERE id = ?")
    .get(requestRow.subject_id)?.created_by || "";
}

function recordWorkRuleReviewDecision(db, requestIdOrInput, inputOrActor, maybeActor) {
  const call = normalizeRequestCall(requestIdOrInput, inputOrActor, maybeActor);
  const requestId = requiredText(call.requestId, "Freigabeantrag", 180);
  const decision = String(call.input.decision || "");
  if (!["approve", "reject"].includes(decision)) {
    throw governanceError("Die Freigabeentscheidung ist ungültig.", "WORK_RULE_GOVERNANCE_DECISION_INVALID");
  }
  return withImmediateTransaction(db, () => {
    const requestRow = db.prepare(`
      SELECT * FROM work_rule_review_requests WHERE id = ?
    `).get(requestId);
    const verifiedRequest = verifyReviewRow(requestRow);
    const actor = normalizeActor(
      call.actor,
      DECISION_PERMISSIONS[requestRow.operation] || "work_rules:review",
    );
    const rebuilt = buildGovernancePreview(db, {
      operation: requestRow.operation,
      subjectType: requestRow.subject_type,
      subjectId: requestRow.subject_id,
      payload: verifiedRequest.payload,
    }, actor);
    if (rebuilt.basisSha256 !== requestRow.basis_sha256
      || rebuilt.payloadSha256 !== requestRow.payload_sha256
      || rebuilt.outcome === "blocked") {
      const error = governanceError(
        "Der freigegebene Prüfstand ist veraltet. Bitte Konflikte neu prüfen und erneut einreichen.",
        "WORK_RULE_GOVERNANCE_BASIS_STALE",
        409,
      );
      error.conflicts = rebuilt.result.blockers;
      throw error;
    }
    const existing = db.prepare(`
      SELECT *
      FROM work_rule_review_decisions
      WHERE request_id = ? AND actor_employee_number = ?
    `).get(requestId, actor.employeeNumber);
    const reason = requiredText(call.input.reason, "Entscheidungsbegründung", 2000);
    if (reason.length < 5) {
      throw governanceError(
        "Die Entscheidungsbegründung muss mindestens fünf Zeichen enthalten.",
        "WORK_RULE_GOVERNANCE_REASON_REQUIRED",
      );
    }
    if (existing) {
      const verified = verifyDecisionRow(existing, requestRow.receipt_sha256);
      if (verified.decision !== decision || verified.reason !== reason) {
        throw governanceError(
          "Diese Person hat den Freigabeantrag bereits anders entschieden.",
          "WORK_RULE_GOVERNANCE_DECISION_CONFLICT",
          409,
        );
      }
      return serializeReviewRequest(db, requestRow);
    }
    if (reviewState(requestRow, reviewDecisionRows(db, requestRow)) !== "in_review") {
      throw governanceError(
        "Der Freigabeantrag wurde bereits abschließend entschieden.",
        "WORK_RULE_GOVERNANCE_REVIEW_CLOSED",
        409,
      );
    }
    if (decision === "approve") {
      const author = subjectAuthor(db, requestRow);
      if (actor.employeeNumber === requestRow.submitted_by
        || (author && actor.employeeNumber === author)) {
        throw governanceError(
          "Autor oder einreichende Person dürfen die eigene Operation nicht freigeben.",
          "WORK_RULE_GOVERNANCE_SELF_APPROVAL",
          403,
        );
      }
    }
    const at = occurredAt(actor);
    const row = {
      id: randomUUID(),
      request_id: requestId,
      decision,
      actor_employee_number: actor.employeeNumber,
      actor_role: actor.role,
      permission_used: actor.permission,
      qualification: actor.qualification,
      reason,
      request_receipt_sha256: requestRow.receipt_sha256,
      decided_at: at,
    };
    row.receipt_sha256 = canonicalSha256(decisionReceiptCore(row));
    db.prepare(`
      INSERT INTO work_rule_review_decisions
        (id, request_id, decision, actor_employee_number, actor_role,
         permission_used, qualification, reason, request_receipt_sha256,
         decided_at, receipt_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.request_id,
      row.decision,
      row.actor_employee_number,
      row.actor_role,
      row.permission_used,
      row.qualification,
      row.reason,
      row.request_receipt_sha256,
      row.decided_at,
      row.receipt_sha256,
    );
    appendGovernanceEvent(db, {
      aggregateType: "work_rule_review_request",
      aggregateId: requestId,
      eventType: decision === "approve" ? "review_approved" : "review_rejected",
      payload: {
        decisionId: row.id,
        decision,
        qualification: row.qualification,
        decisionReceiptSha256: row.receipt_sha256,
        requestReceiptSha256: row.request_receipt_sha256,
      },
      actor,
      correlationId: requestId,
      at,
    });
    return serializeReviewRequest(db, requestRow);
  });
}

function insertPublicationEvent(db, publication, requestRow, eventType, effectiveOn, actor, reason, at) {
  const row = {
    id: randomUUID(),
    publication_id: publication.id,
    event_type: eventType,
    effective_on: effectiveOn,
    reason,
    review_request_id: requestRow.id,
    actor_employee_number: actor.employeeNumber,
    actor_role: actor.role,
    permission_used: actor.permission,
    occurred_at: at,
  };
  row.receipt_sha256 = canonicalSha256(
    lifecycleEventReceiptCore("work_rule_publication_event", row, "publication_id"),
  );
  db.prepare(`
    INSERT INTO work_rule_publication_events
      (id, publication_id, event_type, effective_on, reason, review_request_id,
       actor_employee_number, actor_role, permission_used, occurred_at, receipt_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.publication_id,
    row.event_type,
    row.effective_on,
    row.reason,
    row.review_request_id,
    row.actor_employee_number,
    row.actor_role,
    row.permission_used,
    row.occurred_at,
    row.receipt_sha256,
  );
  return row;
}

function insertAssignmentEvent(db, revisionId, requestRow, eventType, effectiveOn, actor, reason, at) {
  const row = {
    id: randomUUID(),
    assignment_revision_id: revisionId,
    event_type: eventType,
    effective_on: effectiveOn,
    reason,
    review_request_id: requestRow.id,
    actor_employee_number: actor.employeeNumber,
    actor_role: actor.role,
    permission_used: actor.permission,
    occurred_at: at,
  };
  row.receipt_sha256 = canonicalSha256(
    lifecycleEventReceiptCore("work_rule_assignment_event", row, "assignment_revision_id"),
  );
  db.prepare(`
    INSERT INTO work_rule_assignment_events
      (id, assignment_revision_id, event_type, effective_on, reason,
       review_request_id, actor_employee_number, actor_role, permission_used,
       occurred_at, receipt_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.assignment_revision_id,
    row.event_type,
    row.effective_on,
    row.reason,
    row.review_request_id,
    row.actor_employee_number,
    row.actor_role,
    row.permission_used,
    row.occurred_at,
    row.receipt_sha256,
  );
  return row;
}

function insertCollectiveEvent(db, requestRow, payload, eventType, actor, at, reason) {
  const row = {
    id: randomUUID(),
    assignment_id: payload.assignmentId,
    event_type: eventType,
    effective_on: payload.effectiveOn,
    scope_snapshot_json: JSON.stringify(payload.scopeSnapshot),
    scope_sha256: payload.scopeSha256,
    reason,
    review_request_id: requestRow.id,
    actor_employee_number: actor.employeeNumber,
    actor_role: actor.role,
    permission_used: actor.permission,
    occurred_at: at,
  };
  row.receipt_sha256 = canonicalSha256(collectiveEventReceiptCore(row));
  db.prepare(`
    INSERT INTO collective_agreement_assignment_events
      (id, assignment_id, event_type, effective_on, scope_snapshot_json,
       scope_sha256, reason, review_request_id, actor_employee_number,
       actor_role, permission_used, occurred_at, receipt_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.assignment_id,
    row.event_type,
    row.effective_on,
    row.scope_snapshot_json,
    row.scope_sha256,
    row.reason,
    row.review_request_id,
    row.actor_employee_number,
    row.actor_role,
    row.permission_used,
    row.occurred_at,
    row.receipt_sha256,
  );
  return row;
}

function finalizedArtifact(db, requestRow) {
  if (requestRow.operation === "publish_rule") {
    const publication = db.prepare(`
      SELECT * FROM work_rule_publications WHERE review_request_id = ?
    `).get(requestRow.id);
    return publication ? { type: "publication", publication: verifyPublicationRow(publication) } : null;
  }
  if (requestRow.operation === "activate_assignment") {
    const revision = db.prepare(`
      SELECT * FROM work_rule_assignment_revisions WHERE review_request_id = ?
    `).get(requestRow.id);
    return revision ? { type: "assignment_revision", assignment: verifyAssignmentRevisionRow(revision).row } : null;
  }
  if (requestRow.operation === "deactivate_assignment") {
    const event = db.prepare(`
      SELECT * FROM work_rule_assignment_events
      WHERE review_request_id = ? AND event_type = 'deactivated'
    `).get(requestRow.id);
    return event ? {
      type: "assignment_event",
      event: verifyLifecycleEvent("work_rule_assignment_event", event, "assignment_revision_id"),
    } : null;
  }
  if (requestRow.operation === "withdraw_publication") {
    const event = db.prepare(`
      SELECT * FROM work_rule_publication_events
      WHERE review_request_id = ? AND event_type = 'withdrawn'
    `).get(requestRow.id);
    const endedAssignments = db.prepare(`
      SELECT *
      FROM work_rule_assignment_events
      WHERE review_request_id = ? AND event_type = 'deactivated'
      ORDER BY assignment_revision_id, id
    `).all(requestRow.id).map((assignmentEvent) => ({
      assignmentRevisionId: assignmentEvent.assignment_revision_id,
      event: verifyLifecycleEvent(
        "work_rule_assignment_event",
        assignmentEvent,
        "assignment_revision_id",
      ),
    }));
    return event ? {
      type: "publication_event",
      event: verifyLifecycleEvent("work_rule_publication_event", event, "publication_id"),
      endedAssignments,
    } : null;
  }
  const eventType = requestRow.operation === "approve_kv_assignment" ? "approved" : "deactivated";
  const event = db.prepare(`
    SELECT * FROM collective_agreement_assignment_events
    WHERE review_request_id = ? AND event_type = ?
  `).get(requestRow.id, eventType);
  return event ? { type: "collective_assignment_event", event: verifyCollectiveEvent(event).row } : null;
}

function finalizePublishRule(db, requestRow, payload, actor, at, reason) {
  const released = publishCustomWorkRuleDraft(db, requestRow.subject_id, actor.employeeNumber);
  if (released.semanticSha256 !== payload.semanticSha256) {
    throw integrityError("Die erzeugte Veröffentlichung weicht vom freigegebenen semantischen Stand ab.");
  }
  const row = {
    id: randomUUID(),
    profile_id: released.profileId,
    source_profile_version_id: released.sourceDraftVersionId,
    released_profile_version_id: released.releasedVersionId,
    review_request_id: requestRow.id,
    release_number: Number(String(released.releaseVersion).replace(/^release-/, "")),
    semantic_sha256: released.semanticSha256,
    conflict_run_id: requestRow.conflict_run_id,
    published_by: actor.employeeNumber,
    published_at: released.publishedAt || at,
  };
  row.receipt_sha256 = canonicalSha256(publicationReceiptCore(row));
  db.prepare(`
    INSERT INTO work_rule_publications
      (id, profile_id, source_profile_version_id, released_profile_version_id,
       review_request_id, release_number, semantic_sha256, conflict_run_id,
       published_by, published_at, receipt_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.profile_id,
    row.source_profile_version_id,
    row.released_profile_version_id,
    row.review_request_id,
    row.release_number,
    row.semantic_sha256,
    row.conflict_run_id,
    row.published_by,
    row.published_at,
    row.receipt_sha256,
  );
  const event = insertPublicationEvent(
    db,
    row,
    requestRow,
    "published",
    payload.effectiveOn,
    actor,
    reason,
    at,
  );
  appendGovernanceEvent(db, {
    aggregateType: "work_rule_publication",
    aggregateId: row.id,
    eventType: "published",
    payload: {
      sourceProfileVersionId: row.source_profile_version_id,
      releasedProfileVersionId: row.released_profile_version_id,
      semanticSha256: row.semantic_sha256,
      publicationReceiptSha256: row.receipt_sha256,
      lifecycleReceiptSha256: event.receipt_sha256,
      reviewRequestId: requestRow.id,
    },
    actor,
    correlationId: requestRow.id,
    at,
  });
  return { type: "publication", publication: row, event };
}

function finalizeActivateAssignment(db, requestRow, payload, actor, at, reason, sourceReference) {
  const publication = verifyPublicationRow(db.prepare(`
    SELECT * FROM work_rule_publications WHERE id = ?
  `).get(payload.publicationId));
  const revision = Number(db.prepare(`
    SELECT COALESCE(MAX(revision), 0) AS revision
    FROM work_rule_assignment_revisions
    WHERE logical_assignment_id = ?
  `).get(payload.logicalAssignmentId).revision || 0) + 1;
  const row = {
    id: randomUUID(),
    logical_assignment_id: payload.logicalAssignmentId,
    revision,
    publication_id: publication.id,
    profile_version_id: publication.released_profile_version_id,
    scope_type: payload.scopeType,
    scope_key: payload.scopeKey,
    expanded_scopes_json: JSON.stringify(payload.expandedScopes),
    scope_sha256: payload.scopeSha256,
    valid_from: payload.validFrom,
    valid_to: payload.validTo,
    enforcement_mode: payload.enforcementMode,
    applicability_confirmed: payload.applicabilityConfirmed ? 1 : 0,
    rationale: payload.rationale || reason,
    source_reference: payload.sourceReference || sourceReference || requestRow.source_reference,
    supersedes_revision_id: payload.supersedesRevisionId,
    review_request_id: requestRow.id,
    conflict_run_id: requestRow.conflict_run_id,
    created_by: actor.employeeNumber,
    created_at: at,
  };
  row.receipt_sha256 = canonicalSha256(assignmentRevisionReceiptCore(row));
  db.prepare(`
    INSERT INTO work_rule_assignment_revisions
      (id, logical_assignment_id, revision, publication_id, profile_version_id,
       scope_type, scope_key, expanded_scopes_json, scope_sha256, valid_from,
       valid_to, enforcement_mode, applicability_confirmed, rationale,
       source_reference, supersedes_revision_id, review_request_id,
       conflict_run_id, created_by, created_at, receipt_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.logical_assignment_id,
    row.revision,
    row.publication_id,
    row.profile_version_id,
    row.scope_type,
    row.scope_key,
    row.expanded_scopes_json,
    row.scope_sha256,
    row.valid_from,
    row.valid_to,
    row.enforcement_mode,
    row.applicability_confirmed,
    row.rationale,
    row.source_reference,
    row.supersedes_revision_id,
    row.review_request_id,
    row.conflict_run_id,
    row.created_by,
    row.created_at,
    row.receipt_sha256,
  );
  const activation = insertAssignmentEvent(
    db,
    row.id,
    requestRow,
    "activated",
    payload.effectiveOn,
    actor,
    reason,
    at,
  );
  let superseded = null;
  if (payload.supersedesRevisionId) {
    superseded = insertAssignmentEvent(
      db,
      payload.supersedesRevisionId,
      requestRow,
      "superseded",
      payload.effectiveOn,
      actor,
      reason,
      at,
    );
  }
  appendGovernanceEvent(db, {
    aggregateType: "work_rule_assignment",
    aggregateId: row.logical_assignment_id,
    eventType: "assignment_activated",
    payload: {
      assignmentRevisionId: row.id,
      revision: row.revision,
      publicationId: row.publication_id,
      profileVersionId: row.profile_version_id,
      scopeSha256: row.scope_sha256,
      enforcementMode: row.enforcement_mode,
      assignmentReceiptSha256: row.receipt_sha256,
      activationReceiptSha256: activation.receipt_sha256,
      supersededRevisionId: payload.supersedesRevisionId,
      supersededReceiptSha256: superseded?.receipt_sha256 || "",
      reviewRequestId: requestRow.id,
    },
    actor,
    correlationId: requestRow.id,
    at,
  });
  return { type: "assignment_revision", assignment: row, activation, superseded };
}

function finalizeWorkRuleReviewRequest(db, requestIdOrInput, inputOrActor, maybeActor) {
  const call = normalizeRequestCall(requestIdOrInput, inputOrActor, maybeActor);
  const requestId = requiredText(call.requestId, "Freigabeantrag", 180);
  const finalizationReason = requiredText(
    call.input.reason,
    "Vollzugsbegründung",
    2000,
  );
  if (finalizationReason.length < 5) {
    throw governanceError(
      "Die Vollzugsbegründung muss mindestens fünf Zeichen enthalten.",
      "WORK_RULE_GOVERNANCE_REASON_REQUIRED",
    );
  }
  const finalizationSourceReference = requiredText(
    call.input.sourceReference,
    "Vollzugsquelle",
    1200,
  );
  return withImmediateTransaction(db, () => {
    const requestRow = db.prepare(`
      SELECT * FROM work_rule_review_requests WHERE id = ?
    `).get(requestId);
    const verifiedRequest = verifyReviewRow(requestRow);
    const actor = normalizeActor(
      call.actor,
      OPERATION_PERMISSIONS[requestRow.operation] || "work_rules:publish",
    );
    const existing = finalizedArtifact(db, requestRow);
    if (existing) {
      const requestEvents = verifyGovernanceEventRows(db.prepare(`
        SELECT *
        FROM work_rule_governance_events
        WHERE aggregate_type = 'work_rule_review_request'
          AND aggregate_id = ?
        ORDER BY sequence_no
      `).all(requestRow.id));
      const finalizedEvent = requestEvents.find((event) => event.eventType === "review_finalized");
      if (!finalizedEvent) {
        throw integrityError("Der unveränderliche Vollzugsbeleg des Freigabeantrags fehlt.");
      }
      if (finalizedEvent.actorEmployeeNumber !== actor.employeeNumber
        || finalizedEvent.payload.finalizationReason !== finalizationReason
        || finalizedEvent.payload.finalizationSourceReference !== finalizationSourceReference
        || (call.input.basisSha256 && call.input.basisSha256 !== requestRow.basis_sha256)) {
        throw governanceError(
          "Der Freigabeantrag wurde bereits mit einem anderen Vollzugsinhalt abgeschlossen.",
          "WORK_RULE_GOVERNANCE_FINALIZATION_CONFLICT",
          409,
        );
      }
      return {
        request: serializeReviewRequest(db, requestRow),
        outcome: existing,
        idempotent: true,
      };
    }
    const decisions = reviewDecisionRows(db, requestRow);
    if (reviewState(requestRow, decisions) !== "approved") {
      throw governanceError(
        "Die erforderlichen getrennten und fachlichen Freigaben liegen noch nicht vollständig vor.",
        "WORK_RULE_GOVERNANCE_APPROVALS_INCOMPLETE",
        409,
      );
    }
    if (call.input.basisSha256 && call.input.basisSha256 !== requestRow.basis_sha256) {
      throw governanceError(
        "Der angeforderte Prüfstand stimmt nicht mit dem Freigabeantrag überein.",
        "WORK_RULE_GOVERNANCE_BASIS_STALE",
        409,
      );
    }
    const rebuilt = buildGovernancePreview(db, {
      operation: requestRow.operation,
      subjectType: requestRow.subject_type,
      subjectId: requestRow.subject_id,
      payload: verifiedRequest.payload,
    }, actor);
    if (rebuilt.basisSha256 !== requestRow.basis_sha256
      || rebuilt.payloadSha256 !== requestRow.payload_sha256
      || rebuilt.outcome === "blocked") {
      const error = governanceError(
        "Der freigegebene Prüfstand ist veraltet. Bitte Konflikte neu prüfen und erneut einreichen.",
        "WORK_RULE_GOVERNANCE_BASIS_STALE",
        409,
      );
      error.conflicts = rebuilt.result.blockers;
      throw error;
    }
    const conflictRun = verifyConflictRow(db.prepare(`
      SELECT * FROM work_rule_conflict_runs WHERE id = ?
    `).get(requestRow.conflict_run_id));
    if (conflictRun.baselineSha256 !== rebuilt.baselineSha256
      || conflictRun.resultSha256 !== rebuilt.resultSha256
      || conflictRun.outcome === "blocked") {
      throw governanceError(
        "Der freigegebene Konfliktprüflauf ist veraltet.",
        "WORK_RULE_GOVERNANCE_CONFLICT_STALE",
        409,
      );
    }
    const at = occurredAt(actor);
    let outcome;
    if (requestRow.operation === "publish_rule") {
      outcome = finalizePublishRule(
        db,
        requestRow,
        verifiedRequest.payload,
        actor,
        at,
        finalizationReason,
      );
    } else if (requestRow.operation === "activate_assignment") {
      outcome = finalizeActivateAssignment(
        db,
        requestRow,
        verifiedRequest.payload,
        actor,
        at,
        finalizationReason,
        finalizationSourceReference,
      );
    } else if (requestRow.operation === "deactivate_assignment") {
      const event = insertAssignmentEvent(
        db,
        requestRow.subject_id,
        requestRow,
        "deactivated",
        verifiedRequest.payload.effectiveOn,
        actor,
        finalizationReason,
        at,
      );
      const assignment = db.prepare(`
        SELECT logical_assignment_id FROM work_rule_assignment_revisions WHERE id = ?
      `).get(requestRow.subject_id);
      appendGovernanceEvent(db, {
        aggregateType: "work_rule_assignment",
        aggregateId: assignment.logical_assignment_id,
        eventType: "assignment_deactivated",
        payload: {
          assignmentRevisionId: requestRow.subject_id,
          effectiveOn: verifiedRequest.payload.effectiveOn,
          lifecycleReceiptSha256: event.receipt_sha256,
          reviewRequestId: requestRow.id,
        },
        actor,
        correlationId: requestRow.id,
        at,
      });
      outcome = { type: "assignment_event", event };
    } else if (requestRow.operation === "withdraw_publication") {
      const publication = verifyPublicationRow(db.prepare(`
        SELECT * FROM work_rule_publications WHERE id = ?
      `).get(requestRow.subject_id));
      const endedAssignments = [];
      for (const assignmentRevisionId of verifiedRequest.payload.assignmentRevisionIds) {
        const verifiedAssignment = verifyAssignmentRevisionRow(db.prepare(`
          SELECT * FROM work_rule_assignment_revisions WHERE id = ?
        `).get(assignmentRevisionId));
        if (verifiedAssignment.row.publication_id !== publication.id) {
          throw integrityError(
            "Die bei der Rücknahme zu beendende Zuordnung gehört nicht zur Veröffentlichung.",
          );
        }
        const assignmentEvent = insertAssignmentEvent(
          db,
          assignmentRevisionId,
          requestRow,
          "deactivated",
          verifiedRequest.payload.effectiveOn,
          actor,
          finalizationReason,
          at,
        );
        appendGovernanceEvent(db, {
          aggregateType: "work_rule_assignment",
          aggregateId: verifiedAssignment.row.logical_assignment_id,
          eventType: "assignment_deactivated_due_to_publication_withdrawal",
          payload: {
            assignmentRevisionId,
            publicationId: publication.id,
            effectiveOn: verifiedRequest.payload.effectiveOn,
            lifecycleReceiptSha256: assignmentEvent.receipt_sha256,
            reviewRequestId: requestRow.id,
          },
          actor,
          correlationId: requestRow.id,
          at,
        });
        endedAssignments.push({
          assignmentRevisionId,
          event: assignmentEvent,
        });
      }
      const event = insertPublicationEvent(
        db,
        publication,
        requestRow,
        "withdrawn",
        verifiedRequest.payload.effectiveOn,
        actor,
        finalizationReason,
        at,
      );
      appendGovernanceEvent(db, {
        aggregateType: "work_rule_publication",
        aggregateId: publication.id,
        eventType: "publication_withdrawn",
        payload: {
          publicationId: publication.id,
          effectiveOn: verifiedRequest.payload.effectiveOn,
          lifecycleReceiptSha256: event.receipt_sha256,
          assignmentDeactivationReceipts: endedAssignments.map(
            (item) => item.event.receipt_sha256,
          ),
          reviewRequestId: requestRow.id,
        },
        actor,
        correlationId: requestRow.id,
        at,
      });
      outcome = { type: "publication_event", event, endedAssignments };
    } else {
      const eventType = requestRow.operation === "approve_kv_assignment" ? "approved" : "deactivated";
      const event = insertCollectiveEvent(
        db,
        requestRow,
        verifiedRequest.payload,
        eventType,
        actor,
        at,
        finalizationReason,
      );
      appendGovernanceEvent(db, {
        aggregateType: "collective_agreement_assignment",
        aggregateId: verifiedRequest.payload.assignmentId,
        eventType: eventType === "approved" ? "kv_assignment_approved" : "kv_assignment_deactivated",
        payload: {
          assignmentId: verifiedRequest.payload.assignmentId,
          scopeSha256: verifiedRequest.payload.scopeSha256,
          effectiveOn: verifiedRequest.payload.effectiveOn,
          lifecycleReceiptSha256: event.receipt_sha256,
          reviewRequestId: requestRow.id,
        },
        actor,
        correlationId: requestRow.id,
        at,
      });
      outcome = { type: "collective_assignment_event", event };
    }
    appendGovernanceEvent(db, {
      aggregateType: "work_rule_review_request",
      aggregateId: requestRow.id,
      eventType: "review_finalized",
      payload: {
        operation: requestRow.operation,
        subjectType: requestRow.subject_type,
        subjectId: requestRow.subject_id,
        basisSha256: requestRow.basis_sha256,
        outcomeType: outcome.type,
        approvalReceiptSha256: decisions.map((decision) => decision.receiptSha256),
        finalizationReason,
        finalizationSourceReference,
      },
      actor,
      correlationId: requestRow.id,
      at,
    });
    return {
      request: serializeReviewRequest(db, requestRow),
      outcome,
      idempotent: false,
    };
  });
}

function listWorkRuleGovernance(db, options = {}) {
  assertGovernanceTables(db);
  const parsedLimit = Number(options.limit);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(500, Math.max(1, Math.trunc(parsedLimit)))
    : 100;
  const requests = db.prepare(`
    SELECT *
    FROM work_rule_review_requests
    ORDER BY submitted_at DESC, id DESC
    LIMIT ?
  `).all(limit).map((row) => serializeReviewRequest(db, row));
  const conflictRuns = db.prepare(`
    SELECT *
    FROM work_rule_conflict_runs
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(limit).map(verifyConflictRow);
  const publications = db.prepare(`
    SELECT *
    FROM work_rule_publications
    ORDER BY published_at DESC, id DESC
    LIMIT ?
  `).all(limit).map((row) => {
    verifyPublicationRow(row);
    const events = publicationEvents(db, row.id);
    return {
      id: row.id,
      profileId: row.profile_id,
      sourceProfileVersionId: row.source_profile_version_id,
      releasedProfileVersionId: row.released_profile_version_id,
      reviewRequestId: row.review_request_id,
      releaseNumber: Number(row.release_number),
      semanticSha256: row.semantic_sha256,
      conflictRunId: row.conflict_run_id,
      publishedBy: row.published_by,
      publishedAt: row.published_at,
      receiptSha256: row.receipt_sha256,
      state: events.at(-1)?.event_type || "unknown",
      events: events.map((event) => ({
        id: event.id,
        eventType: event.event_type,
        effectiveOn: event.effective_on,
        reason: event.reason,
        actorEmployeeNumber: event.actor_employee_number,
        occurredAt: event.occurred_at,
        receiptSha256: event.receipt_sha256,
      })),
    };
  });
  const assignmentRevisions = db.prepare(`
    SELECT *
    FROM work_rule_assignment_revisions
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(limit).map((raw) => {
    const { row, expandedScopes } = verifyAssignmentRevisionRow(raw);
    const lifecycle = assignmentLifecycle(db, row);
    return {
      id: row.id,
      logicalAssignmentId: row.logical_assignment_id,
      revision: Number(row.revision),
      publicationId: row.publication_id,
      profileVersionId: row.profile_version_id,
      scopeType: row.scope_type,
      scopeKey: row.scope_key,
      expandedScopes,
      scopeSha256: row.scope_sha256,
      validFrom: lifecycle.validFrom,
      validTo: lifecycle.validTo,
      enforcementMode: row.enforcement_mode,
      applicabilityConfirmed: Boolean(row.applicability_confirmed),
      active: lifecycle.active,
      supersedesRevisionId: row.supersedes_revision_id || null,
      reviewRequestId: row.review_request_id,
      conflictRunId: row.conflict_run_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      receiptSha256: row.receipt_sha256,
      events: lifecycle.events.map((event) => ({
        id: event.id,
        eventType: event.event_type,
        effectiveOn: event.effective_on,
        reason: event.reason,
        actorEmployeeNumber: event.actor_employee_number,
        occurredAt: event.occurred_at,
        receiptSha256: event.receipt_sha256,
      })),
    };
  });
  const collectiveAssignments = db.prepare(`
    SELECT *
    FROM collective_agreement_assignment_events
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?
  `).all(limit).map((row) => {
    const verified = verifyCollectiveEvent(row);
    return {
      id: row.id,
      assignmentId: row.assignment_id,
      eventType: row.event_type,
      effectiveOn: row.effective_on,
      scopeSnapshot: verified.scopeSnapshot,
      scopeSha256: row.scope_sha256,
      reason: row.reason,
      reviewRequestId: row.review_request_id,
      actorEmployeeNumber: row.actor_employee_number,
      actorRole: row.actor_role,
      permissionUsed: row.permission_used,
      occurredAt: row.occurred_at,
      receiptSha256: row.receipt_sha256,
    };
  });
  const governanceRows = db.prepare(`
    SELECT *
    FROM work_rule_governance_events
    ORDER BY aggregate_type, aggregate_id, sequence_no
  `).all();
  const events = verifyGovernanceEventRows(governanceRows)
    .sort((left, right) => (
      right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id)
    ))
    .slice(0, limit);
  return {
    generatedAt: new Date().toISOString(),
    requests,
    conflictRuns,
    publications,
    assignmentRevisions,
    assignments: listGovernedWorkRuleAssignments(db, { includeInactive: true }),
    collectiveAgreementAssignments: collectiveAssignments,
    events,
  };
}

module.exports = {
  SUPPORTED_CUSTOM_SCHEDULE_METRICS,
  createWorkRuleReviewRequest,
  finalizeWorkRuleReviewRequest,
  listGovernedWorkRuleAssignments,
  listWorkRuleGovernance,
  previewWorkRuleGovernance,
  recordWorkRuleReviewDecision,
};
