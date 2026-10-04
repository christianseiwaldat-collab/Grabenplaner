"use strict";

const { canonicalSha256 } = require("./receipt");
const { RETAIL_KV_SOURCE } = require("../personnel-retail-kv");
const { getWorkRuleProfileVersion } = require("./store");
const {
  buildGovernancePreview, verifyCollectiveEvent, verifyReviewRow,
  verifyDecisionRow, verifyConflictRow, verifyGovernanceEventRows,
} = require("./governance");

// Callers receive an opaque read snapshot, never a caller-supplied approval list.
// The caller owns the shared repository transaction and its isolation level.
const SNAPSHOTS = new WeakMap();
const PROFILE_VERSION_ID = "at-retail-kv-angestellte-2026@2026.5";
const APPROVAL_PERMISSION = "collective_agreements:approve";
const APPROVAL_ROLES = new Set(["hr", "admin", "developer"]);
const unknown = reason => ({ verified: false, reason });
const isoDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const within = (date, from, to) => isoDate(date) && isoDate(from)
  && (!to || isoDate(to)) && date >= from && (!to || date <= to);
const same = (left, right) => canonicalSha256(left) === canonicalSha256(right);
const scopes = values => [...values].map(scope => ({ type: scope.type || scope.scope_type,
  key: String(scope.key ?? scope.scope_key ?? "") }))
  .sort((left, right) => left.type.localeCompare(right.type) || left.key.localeCompare(right.key));
const clone = value => JSON.parse(JSON.stringify(value));

function snapshot(data) {
  const result = Object.freeze({ schemaVersion: 1, inputSha256: canonicalSha256(data) });
  SNAPSHOTS.set(result, data);
  return result;
}

function assertSourceVersion(version, expectedProfileVersionId) {
  const saved = version?.snapshot;
  if (!saved || canonicalSha256(saved) !== version.contentSha256
    || saved.agreementId !== version.agreementId || saved.versionLabel !== version.versionLabel
    || saved.validFrom !== version.validFrom || (saved.validTo || null) !== (version.validTo || null)
    || saved.source?.sha256 !== version.sourceSha256 || saved.source?.url !== version.sourceUrl
    || saved.source?.retrievedOn !== version.sourceRetrievedOn
    || saved.applicability?.apprenticeRelevance !== version.apprenticeRelevance
    || (saved.linkedProfileVersionId || null) !== (version.linkedProfileVersionId || null)) {
    throw new Error("RETAIL_KV_BINDING_INTEGRITY");
  }
  return version.sourceState === "documented"
    && version.sourceSha256 === RETAIL_KV_SOURCE.sha256
    && version.sourceUrl === RETAIL_KV_SOURCE.url
    && version.sourceRetrievedOn === RETAIL_KV_SOURCE.retrievedOn
    && version.validFrom === RETAIL_KV_SOURCE.validFrom
    && (!version.validTo || version.validTo === RETAIL_KV_SOURCE.validTo)
    && version.linkedProfileVersionId === expectedProfileVersionId;
}

function lifecycle(events) {
  const approved = events.filter(event => event.row.event_type === "approved");
  const deactivated = events.filter(event => event.row.event_type === "deactivated");
  if (approved.length > 1 || deactivated.length > 1
    || approved.length + deactivated.length !== events.length
    || (deactivated.length && !approved.length)) throw new Error("RETAIL_KV_BINDING_INTEGRITY");
  const approval = approved[0] || null;
  const end = deactivated[0] || null;
  if (approval && (!isoDate(approval.row.effective_on)
    || !within(approval.row.effective_on, approval.scopeSnapshot.validFrom, approval.scopeSnapshot.validTo)
    || (end && (!isoDate(end.row.effective_on) || end.row.effective_on < approval.row.effective_on
      || !same(end.scopeSnapshot, approval.scopeSnapshot))))) throw new Error("RETAIL_KV_BINDING_INTEGRITY");
  return { approval, end };
}

async function approvalProof(governance, assignment, approval) {
  const requestId = approval.row.review_request_id;
  const requestRow = await governance.reviewRequestById(requestId);
  const { payload } = verifyReviewRow(requestRow);
  const [decisionRows, conflictRow, eventRows] = await Promise.all([
    governance.reviewDecisions(requestId), governance.conflictRunById(requestRow.conflict_run_id),
    governance.governanceEventsForReview(requestId),
  ]);
  const decisions = decisionRows.map(row => verifyDecisionRow(row, requestRow.receipt_sha256));
  const conflict = verifyConflictRow(conflictRow);
  const events = verifyGovernanceEventRows(eventRows);
  const submitted = events.filter(event => event.eventType === "review_submitted");
  const finalized = events.filter(event => event.eventType === "review_finalized");
  if (requestRow.operation !== "approve_kv_assignment"
    || requestRow.subject_type !== "collective_agreement_assignment"
    || requestRow.subject_id !== assignment.id || payload.assignmentId !== assignment.id
    || payload.effectiveOn !== approval.row.effective_on
    || payload.scopeSha256 !== approval.row.scope_sha256
    || !same(payload.scopeSnapshot, approval.scopeSnapshot)
    || requestRow.risk_class !== "critical" || Number(requestRow.required_approvals) !== 2
    || Number(requestRow.required_fachlich_approvals) < 1
    || requestRow.submitted_permission !== APPROVAL_PERMISSION
    || !APPROVAL_ROLES.has(requestRow.submitted_role)
    || !APPROVAL_ROLES.has(approval.row.actor_role)
    || approval.row.permission_used !== APPROVAL_PERMISSION
    || conflict.operation !== requestRow.operation || conflict.subjectId !== assignment.id
    || conflict.subjectType !== requestRow.subject_type || conflict.outcome !== "pass"
    || conflict.result.blockers?.length || conflict.resultSha256 !== canonicalSha256(conflict.result)
    || !same(conflict.result.payload, payload)
    || canonicalSha256({ schemaVersion: 1, operation: requestRow.operation,
      subjectType: requestRow.subject_type, subjectId: assignment.id,
      baselineSha256: conflict.baselineSha256, payloadSha256: requestRow.payload_sha256,
      resultSha256: conflict.resultSha256 }) !== requestRow.basis_sha256
    || submitted.length !== 1 || finalized.length !== 1
    || submitted[0].payload.requestReceiptSha256 !== requestRow.receipt_sha256
    || finalized[0].payload.basisSha256 !== requestRow.basis_sha256
    || finalized[0].payload.operation !== requestRow.operation
    || finalized[0].payload.subjectId !== assignment.id
    || finalized[0].payload.outcomeType !== "collective_assignment_event"
    || !same(finalized[0].payload.approvalReceiptSha256, decisions.map(decision => decision.receiptSha256))
    || finalized[0].actorEmployeeNumber !== approval.row.actor_employee_number) {
    throw new Error("RETAIL_KV_BINDING_INTEGRITY");
  }
  const reviewers = new Set();
  for (const decision of decisions) {
    if (decision.requestId !== requestId || decision.decision !== "approve"
      || decision.actorEmployeeNumber === requestRow.submitted_by
      || decision.actorEmployeeNumber === assignment.created_by
      || !APPROVAL_ROLES.has(decision.actorRole)
      || decision.permissionUsed !== APPROVAL_PERMISSION || decision.qualification !== "fachlich"
      || reviewers.has(decision.actorEmployeeNumber)) return { valid: false };
    reviewers.add(decision.actorEmployeeNumber);
    const recorded = events.filter(event => event.eventType === "review_approved"
      && event.payload.decisionId === decision.id
      && event.payload.decisionReceiptSha256 === decision.receiptSha256
      && event.actorEmployeeNumber === decision.actorEmployeeNumber);
    if (recorded.length !== 1) throw new Error("RETAIL_KV_BINDING_INTEGRITY");
  }
  if (reviewers.size !== 2) return { valid: false };
  if (events.filter(event => event.eventType === "review_approved").length !== decisions.length
    || events.some(event => event.eventType === "review_rejected")) throw new Error("RETAIL_KV_BINDING_INTEGRITY");
  // Rebuild the original candidate before its own completed lifecycle, retaining
  // every competing assignment and all current registry/version/scope facts.
  const replay = { ...governance };
  replay.collectiveAssignmentEvents = async id => id === assignment.id ? []
    : governance.collectiveAssignmentEvents(id);
  const rebuilt = await buildGovernancePreview(replay, {
    operation: requestRow.operation, subjectType: requestRow.subject_type,
    subjectId: assignment.id, payload,
  }, { now: requestRow.submitted_at });
  return { valid: rebuilt.outcome === "pass" && rebuilt.basisSha256 === requestRow.basis_sha256
    && rebuilt.payloadSha256 === requestRow.payload_sha256,
  receiptSha256: approval.row.receipt_sha256,
  requestReceiptSha256: requestRow.receipt_sha256,
  decisionReceiptSha256: decisions.map(decision => decision.receiptSha256),
  conflictReceiptSha256: conflict.receiptSha256,
  basisSha256: requestRow.basis_sha256,
  governanceReceiptSha256: events.map(event => event.receiptSha256) };
}

async function loadRetailKvBindingSnapshot(repositories, options = {}) {
  const expectedProfileVersionId = options.expectedProfileVersionId;
  const expectedProfileContentSha256 = options.expectedProfileContentSha256;
  if (expectedProfileVersionId !== PROFILE_VERSION_ID
    || !/^[a-f0-9]{64}$/.test(String(expectedProfileContentSha256 || ""))) {
    if (options.failOnInvalidSnapshot === true) throw new TypeError("RETAIL_KV_BINDING_PROFILE_INCOMPLETE");
    return snapshot({ error: "profile_binding_unknown" });
  }
  try {
    const { collectiveAgreements, governance, workRuleStore } = repositories;
    const [versionRows, assignmentRows, rawEvents, profile] = await Promise.all([
      collectiveAgreements.listVersions(), collectiveAgreements.listAssignments(),
      governance.allCollectiveAssignmentEvents(), getWorkRuleProfileVersion(workRuleStore, expectedProfileVersionId),
    ]);
    if (!profile || profile.contentSha256 !== expectedProfileContentSha256
      || profile.id !== expectedProfileVersionId || profile.layer !== "collective_agreement"
      || profile.status !== "published" || profile.profile.status !== "active"
      || !profile.sources.some(source => source.id === RETAIL_KV_SOURCE.id
        && source.sha256 === RETAIL_KV_SOURCE.sha256)) {
      if (options.failOnInvalidSnapshot === true) throw new TypeError("RETAIL_KV_BINDING_PROFILE_INCOMPLETE");
      return snapshot({ error: "profile_binding_unknown" });
    }
    const versions = new Map();
    for (const row of versionRows) {
      const valid = assertSourceVersion(row, expectedProfileVersionId);
      if (versions.has(row.id)) throw new Error("RETAIL_KV_BINDING_INTEGRITY");
      versions.set(row.id, { ...clone(row), sourceVerified: valid });
    }
    const byAssignment = new Map();
    for (const row of rawEvents) {
      const event = verifyCollectiveEvent(row);
      const entries = byAssignment.get(row.assignment_id) || [];
      entries.push(clone(event)); byAssignment.set(row.assignment_id, entries);
    }
    const assignments = [];
    const targets = new Map();
    for (const listed of assignmentRows) {
      const raw = await governance.collectiveAssignment(listed.id);
      if (!raw || raw.agreement_version_id !== listed.agreementVersionId
        || !versions.has(raw.agreement_version_id)) throw new Error("RETAIL_KV_BINDING_INTEGRITY");
      const version = versions.get(raw.agreement_version_id);
      const ownScopes = scopes(await governance.businessUnitScopes(raw.business_unit_id));
      const { approval, end } = lifecycle(byAssignment.get(raw.id) || []);
      const currentScope = { schemaVersion: 1, assignmentId: raw.id, agreementId: raw.agreement_id,
        agreementVersionId: raw.agreement_version_id, agreementVersionSha256: raw.agreement_version_sha256,
        businessUnitId: raw.business_unit_id, scopes: ownScopes, validFrom: raw.valid_from,
        validTo: raw.valid_to || null };
      let valid = Boolean(approval && raw.business_unit_active && ownScopes.length
        && same(currentScope, approval.scopeSnapshot)
        && version.contentSha256 === raw.agreement_version_sha256
        && within(raw.valid_from, version.validFrom, version.validTo)
        && (!version.validTo || (raw.valid_to && raw.valid_to <= version.validTo))
        && raw.linked_profile_version_id === expectedProfileVersionId);
      const approvedScopes = approval ? scopes(approval.scopeSnapshot.scopes) : [];
      const effectiveScopes = scopes([...new Map([...ownScopes, ...approvedScopes]
        .map(scope => [`${scope.type}:${scope.key}`, scope])).values()]);
      for (const scope of effectiveScopes) {
        const key = `${scope.type}:${scope.key}`;
        if (!targets.has(key)) {
          const supported = ["location", "department"].includes(scope.type);
          const target = supported ? await collectiveAgreements.getScopeTarget(scope.type, scope.key) : null;
          const active = supported ? await governance.activeScopeTarget(scope.type, scope.key) : null;
          targets.set(key, target && active ? clone(target) : null);
        }
        if (!targets.get(key)) valid = false;
      }
      let proof = { valid: false };
      if (valid && version.sourceVerified) proof = await approvalProof(governance, raw, approval);
      assignments.push({ id: raw.id, versionId: raw.agreement_version_id, valid,
        sourceVerified: version.sourceVerified, proof, scopes: ownScopes, effectiveScopes,
        apprenticeRelevance: version.apprenticeRelevance,
        eventReceiptSha256: (byAssignment.get(raw.id) || []).map(event => event.row.receipt_sha256),
        validFrom: raw.valid_from, validTo: raw.valid_to || null,
        approvalFrom: approval?.row.effective_on || null, deactivatedOn: end?.row.effective_on || null });
    }
    for (const id of byAssignment.keys()) {
      if (!assignments.some(assignment => assignment.id === id)) throw new Error("RETAIL_KV_BINDING_INTEGRITY");
    }
    return snapshot({ expectedProfileVersionId, expectedProfileContentSha256,
      assignments, targets: [...targets], versions: [...versions] });
  } catch (error) {
    // Mutation guards must never certify a digest from a failed partial read.
    // Ordinary monitor callers retain the existing conservative unknown result.
    if (options.failOnInvalidSnapshot === true) throw error;
    return snapshot({ error: "binding_integrity_unknown" });
  }
}

function scopeMatches(scope, context, targets) {
  if (scope.type === "installation") return true;
  if (scope.type === "location") return scope.key === String(context.locationId || "");
  if (scope.type === "department") {
    const target = targets.get(`department:${scope.key}`);
    return Boolean(target && target.locationId === String(context.locationId || "")
      && scope.key === String(context.departmentId || ""));
  }
  return false;
}

function scopeCouldIntersect(scope, context, targets) {
  if (scopeMatches(scope, context, targets)) return true;
  if (scope.type === "department" && !String(context.departmentId || "")) {
    return targets.get(`department:${scope.key}`)?.locationId === String(context.locationId || "");
  }
  // An unresolved active scope cannot prove that it excludes this workplace.
  return !["installation", "location", "department"].includes(scope.type)
    || !targets.get(`${scope.type}:${scope.key}`);
}

function resolveRetailKvApproval(bindingSnapshot, period, date, actualShiftContexts = []) {
  const data = SNAPSHOTS.get(bindingSnapshot);
  if (!data) return unknown("binding_snapshot_unknown");
  if (data.error) return unknown(data.error);
  if (!period || period.confirmed !== true || !["salaried", "apprentice"].includes(period.group)
    || !within(date, period.validFrom, period.validTo)) return unknown("personal_applicability_unknown");
  if (!within(date, RETAIL_KV_SOURCE.validFrom, RETAIL_KV_SOURCE.validTo)
    || period.sourceVersion !== RETAIL_KV_SOURCE.id || period.sourceSha256 !== RETAIL_KV_SOURCE.sha256) {
    return unknown("source_binding_unknown");
  }
  const assignment = data.assignments.find(value => value.id === period.approvedAssignmentId);
  if (!assignment || assignment.versionId !== period.collectiveAgreementVersionId
    || !assignment.valid || !assignment.sourceVerified || !assignment.proof.valid) {
    return unknown("approved_assignment_unknown");
  }
  if (period.group === "apprentice" && assignment.apprenticeRelevance === "no") {
    return unknown("personal_group_source_conflict");
  }
  const active = value => value.approvalFrom && date >= value.approvalFrom
    && within(date, value.validFrom, value.validTo) && (!value.deactivatedOn || date < value.deactivatedOn);
  if (!active(assignment)) return unknown("assignment_not_effective");
  if (!Array.isArray(actualShiftContexts) || !actualShiftContexts.length) return unknown("workplace_scope_unknown");
  const targets = new Map(data.targets);
  for (const context of actualShiftContexts) {
    if (!context || !String(context.locationId || "")) return unknown("workplace_scope_unknown");
    if (!assignment.scopes.some(scope => scopeMatches(scope, context, targets))) return unknown("workplace_scope_mismatch");
    for (const other of data.assignments) {
      if (other.id !== assignment.id && active(other)
        && other.effectiveScopes.some(scope => scopeCouldIntersect(scope, context, targets))) {
        return unknown("assignment_scope_ambiguous");
      }
    }
  }
  return { verified: true, reason: "verified", receiptSha256: assignment.proof.receiptSha256 };
}

module.exports = { loadRetailKvBindingSnapshot, resolveRetailKvApproval };
