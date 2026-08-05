"use strict";

const { createHash } = require("node:crypto");

function parseJson(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    canonicalValue(value[key]),
  ]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function canonicalSha256(value) {
  return sha256(canonicalJson(value));
}

function previewReceiptBody(preview) {
  return canonicalValue({
    schemaVersion: 1,
    contractVersion: preview?.contractVersion || null,
    caseType: preview?.caseType || null,
    subject: {
      employeeNumber: preview?.subject?.employeeNumber || null,
      active: preview?.subject?.active === true,
    },
    scope: {
      type: preview?.scope?.type || null,
      locationId: preview?.scope?.locationId || null,
      departmentId: Number(preview?.scope?.departmentId || 0) || null,
    },
    requiredPackageFamilies: [
      ...(preview?.packageResolution?.requiredPackageFamilies || []),
    ].sort(),
    packages: [...(preview?.packageResolution?.packages || [])]
      .map((entry) => ({
        publicationId: entry.publicationId,
        processId: entry.processId,
        sourceRevision: Number(entry.sourceRevision),
        versionNumber: Number(entry.versionNumber),
        workflowCode: entry.workflowCode,
        authorityLevel: entry.authorityLevel,
        requirementKind: entry.requirementKind,
        scope: {
          type: entry.scope?.type || null,
          locationId: entry.scope?.locationId || null,
          departmentId: Number(entry.scope?.departmentId || 0) || null,
        },
        reviewStatus: entry.reviewStatus,
        assignments: [...(entry.assignments || [])]
          .map((assignment) => ({
            stepReference: assignment.stepReference,
            sortOrder: Number(assignment.sortOrder),
            responsibility: {
              type: assignment.responsibility?.type || null,
              reference: assignment.responsibility?.reference || "",
            },
            state: assignment.state,
            eligibleActorIds: [...(assignment.eligibleRecipients || [])]
              .map(({ actorId }) => actorId)
              .sort(),
          }))
          .sort((left, right) => left.sortOrder - right.sortOrder
            || left.stepReference.localeCompare(right.stepReference)),
      }))
      .sort((left, right) => left.publicationId.localeCompare(right.publicationId)),
    conflicts: [...(preview?.packageResolution?.conflicts || [])]
      .map((entry) => ({
        kind: entry.kind,
        value: entry.value,
        publicationIds: [...(entry.publicationIds || [])].sort(),
      }))
      .sort((left, right) => left.kind.localeCompare(right.kind)
        || left.value.localeCompare(right.value)),
  });
}

function previewSha256(preview) {
  return canonicalSha256(previewReceiptBody(preview));
}

function deterministicUuidV4(...parts) {
  const bytes = Buffer.from(
    sha256(parts.map((part) => String(part ?? "")).join("\0")),
    "hex",
  ).subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function personnelLifecyclePackageRunReceiptBody(row) {
  return {
    schemaVersion: 1,
    packageBindingId: row.package_binding_id,
    runId: row.run_id,
    runOperationId: row.run_operation_id,
    familyCodes: parseJson(row.family_codes_json, []),
    lifecycleReviewSha256: row.lifecycle_review_sha256,
    scopeSnapshotSha256: row.scope_snapshot_sha256,
    linkedBy: row.linked_by,
    linkedAt: row.linked_at,
  };
}

function personnelLifecycleAssignmentBindingReceiptBody(row) {
  return {
    schemaVersion: 1,
    assignmentId: row.assignment_id,
    packageBindingId: row.package_binding_id,
    runId: row.run_id,
    stepReference: row.step_reference,
    boundBy: row.bound_by,
    boundAt: row.bound_at,
  };
}

function personnelLifecyclePackageBindingReceiptBody(row) {
  return {
    schemaVersion: 1,
    id: row.id,
    caseId: row.case_id,
    publicationId: row.publication_id,
    versionNumber: Number(row.version_number),
    scopeSnapshotSha256: row.scope_snapshot_sha256,
    boundBy: row.bound_by,
    boundAt: row.bound_at,
  };
}

function personnelLifecycleAssignmentReceiptBody(row) {
  return {
    schemaVersion: 1,
    id: row.id,
    caseId: row.case_id,
    packageBindingId: row.package_binding_id,
    runId: row.run_id,
    stepReference: row.step_reference,
    assigneeActorId: row.assignee_actor_id,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at,
  };
}

function personnelLifecycleCaseEventReceiptBody(row) {
  return {
    schemaVersion: 1,
    id: row.id,
    caseId: row.case_id,
    sequenceNumber: Number(row.sequence_number),
    eventType: row.event_type,
    dataClassification: row.data_classification,
    protectedPayloadSha256: sha256(row.protected_payload),
    previousReceiptSha256: row.previous_receipt_sha256,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
  };
}

function personnelLifecycleOnboardingOperationReceiptBody(row) {
  return {
    schemaVersion: 1,
    operationId: row.operation_id,
    caseId: row.case_id,
    requestSha256: row.request_sha256,
    previewSha256: row.preview_sha256,
    result: parseJson(row.result_payload, null),
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
  };
}

module.exports = {
  canonicalJson,
  canonicalSha256,
  deterministicUuidV4,
  personnelLifecycleAssignmentReceiptBody,
  personnelLifecycleAssignmentBindingReceiptBody,
  personnelLifecycleCaseEventReceiptBody,
  personnelLifecycleOnboardingOperationReceiptBody,
  personnelLifecyclePackageBindingReceiptBody,
  personnelLifecyclePackageRunReceiptBody,
  previewReceiptBody,
  previewSha256,
  sha256,
};
