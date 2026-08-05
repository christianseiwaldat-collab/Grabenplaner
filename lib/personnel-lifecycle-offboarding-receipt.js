"use strict";

const { createHash } = require("node:crypto");

const PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION = 1;
const PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION = "o5-v0.1";

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

function personnelLifecycleOffboardingRequestReceiptBody(operationType, request) {
  return canonicalValue({
    schemaVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION,
    contractVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION,
    operationType,
    request,
  });
}

function personnelLifecycleOffboardingRequestSha256(operationType, request) {
  return canonicalSha256(
    personnelLifecycleOffboardingRequestReceiptBody(operationType, request),
  );
}

function personnelLifecycleOffboardingProtectedPlanReceiptBody(value) {
  return {
    schemaVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION,
    contractVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION,
    operationId: value?.operationId || null,
    employeeNumberSha256: sha256(value?.employeeNumber || ""),
    protectedPlanSha256: canonicalSha256(value?.protectedPlan || null),
    runtimeManifestSha256: canonicalSha256(value?.runtimeManifest || null),
  };
}

function personnelLifecycleOffboardingProtectedPlanReceiptSha256(value) {
  return canonicalSha256(personnelLifecycleOffboardingProtectedPlanReceiptBody(value));
}

function personnelLifecycleOffboardingOperationReceiptBody(row) {
  const protectedResultPayload = row?.protected_result_payload
    ?? row?.result_payload
    ?? null;
  return {
    schemaVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION,
    contractVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION,
    operationId: row?.operation_id || null,
    operationType: row?.operation_type || null,
    caseId: row?.case_id || null,
    requestSha256: row?.request_sha256 || null,
    planReceiptSha256: row?.plan_receipt_sha256 || null,
    protectedResultSha256: protectedResultPayload === null
      ? null
      : sha256(protectedResultPayload),
    actorId: row?.actor_id || null,
    occurredAt: row?.occurred_at || null,
  };
}

function personnelLifecycleOffboardingOperationReceiptSha256(row) {
  return canonicalSha256(personnelLifecycleOffboardingOperationReceiptBody(row));
}

function personnelLifecycleOffboardingCaseEventReceiptBody(row) {
  return {
    schemaVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION,
    contractVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION,
    id: row?.id || null,
    caseId: row?.case_id || null,
    sequenceNumber: Number(row?.sequence_number || 0),
    eventType: row?.event_type || null,
    dataClassification: row?.data_classification || null,
    protectedPayloadSha256: sha256(row?.protected_payload || ""),
    previousReceiptSha256: row?.previous_receipt_sha256 || null,
    actorId: row?.actor_id || null,
    occurredAt: row?.occurred_at || null,
  };
}

function personnelLifecycleOffboardingCaseEventReceiptSha256(row) {
  return canonicalSha256(personnelLifecycleOffboardingCaseEventReceiptBody(row));
}

function receiptField(row, snakeName, camelName) {
  return row?.[snakeName] ?? row?.[camelName];
}

function personnelLifecycleOffboardingPackageVersionReceiptBody(row) {
  const protectedSnapshot = receiptField(row, "protected_snapshot", "protectedSnapshot");
  return {
    schemaVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION,
    contractVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION,
    id: receiptField(row, "id", "id") || null,
    seriesId: receiptField(row, "series_id", "seriesId") || null,
    runtimeProcessId: receiptField(row, "runtime_process_id", "runtimeProcessId") || null,
    versionNumber: Number(receiptField(row, "version_number", "versionNumber") || 0),
    predecessorVersionId: receiptField(
      row,
      "predecessor_version_id",
      "predecessorVersionId",
    ) ?? null,
    familyCode: receiptField(row, "family_code", "familyCode") || null,
    pathKind: receiptField(row, "path_kind", "pathKind") || null,
    requirementKind: receiptField(row, "requirement_kind", "requirementKind") || null,
    scopeType: receiptField(row, "scope_type", "scopeType") || null,
    locationId: receiptField(row, "location_id", "locationId") ?? null,
    departmentId: receiptField(row, "department_id", "departmentId") ?? null,
    dataClassification: receiptField(
      row,
      "data_classification",
      "dataClassification",
    ) || null,
    protectedSnapshotSha256: sha256(protectedSnapshot || ""),
    snapshotSha256: receiptField(row, "snapshot_sha256", "snapshotSha256") || null,
    runtimeManifestSha256: receiptField(
      row,
      "runtime_manifest_sha256",
      "runtimeManifestSha256",
    ) || null,
    publishedBy: receiptField(row, "published_by", "publishedBy") || null,
    publishedAt: receiptField(row, "published_at", "publishedAt") || null,
  };
}

function personnelLifecycleOffboardingPackageVersionReceiptSha256(row) {
  return canonicalSha256(personnelLifecycleOffboardingPackageVersionReceiptBody(row));
}

function personnelLifecycleOffboardingConfidentialAccessReceiptBody(row) {
  return {
    schemaVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION,
    contractVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION,
    id: receiptField(row, "id", "id") || null,
    caseId: receiptField(row, "case_id", "caseId") || null,
    sequenceNumber: Number(receiptField(row, "sequence_number", "sequenceNumber") || 0),
    previousReceiptSha256: receiptField(
      row,
      "previous_receipt_sha256",
      "previousReceiptSha256",
    ) || null,
    actorId: receiptField(row, "actor_id", "actorId") || null,
    action: receiptField(row, "action", "action") || null,
    result: receiptField(row, "result", "result") || null,
    purposeCode: receiptField(row, "purpose_code", "purposeCode") || null,
    occurredAt: receiptField(row, "occurred_at", "occurredAt") || null,
  };
}

function personnelLifecycleOffboardingConfidentialAccessReceiptSha256(row) {
  return canonicalSha256(personnelLifecycleOffboardingConfidentialAccessReceiptBody(row));
}

function personnelLifecycleOffboardingScopeSnapshotBody(value) {
  return {
    type: receiptField(value, "scope_type", "type")
      ?? receiptField(value, "scope_type", "scopeType")
      ?? null,
    locationId: receiptField(value, "location_id", "locationId") ?? null,
    departmentId: receiptField(value, "department_id", "departmentId") === null
      || receiptField(value, "department_id", "departmentId") === undefined
      ? null
      : Number(receiptField(value, "department_id", "departmentId")),
  };
}

function personnelLifecycleOffboardingScopeSnapshotSha256(value) {
  return canonicalSha256(personnelLifecycleOffboardingScopeSnapshotBody(value));
}

function personnelLifecycleOffboardingReferenceDatesReceiptBody(row) {
  return {
    schemaVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION,
    contractVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION,
    id: receiptField(row, "id", "id") || null,
    caseId: receiptField(row, "case_id", "caseId") || null,
    revision: Number(receiptField(row, "revision", "revision") || 0),
    previousRevisionId: receiptField(
      row,
      "previous_revision_id",
      "previousRevisionId",
    ) || null,
    protectedPayloadSha256: sha256(receiptField(
      row,
      "protected_payload",
      "protectedPayload",
    ) || ""),
    changedBy: receiptField(row, "changed_by", "changedBy") || null,
    changedAt: receiptField(row, "changed_at", "changedAt") || null,
  };
}

function personnelLifecycleOffboardingReferenceDatesReceiptSha256(row) {
  return canonicalSha256(personnelLifecycleOffboardingReferenceDatesReceiptBody(row));
}

function personnelLifecycleOffboardingPackageVersionArchiveReceiptBody(row) {
  return {
    schemaVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION,
    contractVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION,
    packageVersionId: receiptField(row, "package_version_id", "packageVersionId") || null,
    reasonCode: receiptField(row, "reason_code", "reasonCode") || null,
    protectedPayloadSha256: sha256(receiptField(
      row,
      "protected_payload",
      "protectedPayload",
    ) || ""),
    archivedBy: receiptField(row, "archived_by", "archivedBy") || null,
    archivedAt: receiptField(row, "archived_at", "archivedAt") || null,
  };
}

function personnelLifecycleOffboardingPackageVersionArchiveReceiptSha256(row) {
  return canonicalSha256(personnelLifecycleOffboardingPackageVersionArchiveReceiptBody(row));
}

function personnelLifecycleOffboardingPackageBindingReceiptBody(row) {
  return {
    schemaVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION,
    contractVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION,
    id: receiptField(row, "id", "id") || null,
    caseId: receiptField(row, "case_id", "caseId") || null,
    packageVersionId: receiptField(row, "package_version_id", "packageVersionId") || null,
    versionNumber: Number(receiptField(row, "version_number", "versionNumber") || 0),
    scopeSnapshotSha256: receiptField(
      row,
      "scope_snapshot_sha256",
      "scopeSnapshotSha256",
    ) || null,
    boundBy: receiptField(row, "bound_by", "boundBy") || null,
    boundAt: receiptField(row, "bound_at", "boundAt") || null,
  };
}

function personnelLifecycleOffboardingPackageBindingReceiptSha256(row) {
  return canonicalSha256(personnelLifecycleOffboardingPackageBindingReceiptBody(row));
}

function personnelLifecycleOffboardingPackageRunReceiptBody(row) {
  return {
    schemaVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION,
    contractVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION,
    packageBindingId: receiptField(row, "package_binding_id", "packageBindingId") || null,
    runId: receiptField(row, "run_id", "runId") || null,
    runOperationId: receiptField(row, "run_operation_id", "runOperationId") || null,
    runtimeManifestSha256: receiptField(
      row,
      "runtime_manifest_sha256",
      "runtimeManifestSha256",
    ) || null,
    scopeSnapshotSha256: receiptField(
      row,
      "scope_snapshot_sha256",
      "scopeSnapshotSha256",
    ) || null,
    linkedBy: receiptField(row, "linked_by", "linkedBy") || null,
    linkedAt: receiptField(row, "linked_at", "linkedAt") || null,
  };
}

function personnelLifecycleOffboardingPackageRunReceiptSha256(row) {
  return canonicalSha256(personnelLifecycleOffboardingPackageRunReceiptBody(row));
}

function personnelLifecycleOffboardingRuntimeStepReceiptBody(row) {
  return {
    schemaVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION,
    contractVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION,
    packageBindingId: receiptField(row, "package_binding_id", "packageBindingId") || null,
    runId: receiptField(row, "run_id", "runId") || null,
    stepReference: receiptField(row, "step_reference", "stepReference") || null,
    orderReference: receiptField(row, "order_reference", "orderReference") || null,
    sortOrder: Number(receiptField(row, "sort_order", "sortOrder") || 0),
    recipientClass: receiptField(row, "recipient_class", "recipientClass") || null,
    releaseGate: receiptField(row, "release_gate", "releaseGate") || null,
    dataClassification: receiptField(
      row,
      "data_classification",
      "dataClassification",
    ) || null,
    protectedPayloadSha256: sha256(receiptField(
      row,
      "protected_payload",
      "protectedPayload",
    ) || ""),
    createdBy: receiptField(row, "created_by", "createdBy") || null,
    createdAt: receiptField(row, "created_at", "createdAt") || null,
  };
}

function personnelLifecycleOffboardingRuntimeStepReceiptSha256(row) {
  return canonicalSha256(personnelLifecycleOffboardingRuntimeStepReceiptBody(row));
}

function personnelLifecycleOffboardingAssignmentReceiptBody(row) {
  return {
    schemaVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION,
    contractVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION,
    id: receiptField(row, "id", "id") || null,
    caseId: receiptField(row, "case_id", "caseId") || null,
    packageBindingId: receiptField(row, "package_binding_id", "packageBindingId") || null,
    runId: receiptField(row, "run_id", "runId") || null,
    stepReference: receiptField(row, "step_reference", "stepReference") || null,
    assigneeActorId: receiptField(row, "assignee_actor_id", "assigneeActorId") || null,
    predecessorAssignmentId: receiptField(
      row,
      "predecessor_assignment_id",
      "predecessorAssignmentId",
    ) || null,
    assignedBy: receiptField(row, "assigned_by", "assignedBy") || null,
    assignedAt: receiptField(row, "assigned_at", "assignedAt") || null,
  };
}

function personnelLifecycleOffboardingAssignmentReceiptSha256(row) {
  return canonicalSha256(personnelLifecycleOffboardingAssignmentReceiptBody(row));
}

function personnelLifecycleOffboardingAssignmentBindingReceiptBody(row) {
  return {
    schemaVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION,
    contractVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION,
    assignmentId: receiptField(row, "assignment_id", "assignmentId") || null,
    packageBindingId: receiptField(row, "package_binding_id", "packageBindingId") || null,
    runId: receiptField(row, "run_id", "runId") || null,
    stepReference: receiptField(row, "step_reference", "stepReference") || null,
    boundBy: receiptField(row, "bound_by", "boundBy") || null,
    boundAt: receiptField(row, "bound_at", "boundAt") || null,
  };
}

function personnelLifecycleOffboardingAssignmentBindingReceiptSha256(row) {
  return canonicalSha256(personnelLifecycleOffboardingAssignmentBindingReceiptBody(row));
}

function personnelLifecycleOffboardingRunTerminationReceiptBody(row) {
  return {
    schemaVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION,
    contractVersion: PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION,
    runId: receiptField(row, "run_id", "runId") || null,
    caseId: receiptField(row, "case_id", "caseId") || null,
    operationId: receiptField(row, "operation_id", "operationId") || null,
    reasonCode: receiptField(row, "reason_code", "reasonCode") || null,
    protectedPayloadSha256: sha256(receiptField(
      row,
      "protected_payload",
      "protectedPayload",
    ) || ""),
    terminatedBy: receiptField(row, "terminated_by", "terminatedBy") || null,
    terminatedAt: receiptField(row, "terminated_at", "terminatedAt") || null,
  };
}

function personnelLifecycleOffboardingRunTerminationReceiptSha256(row) {
  return canonicalSha256(personnelLifecycleOffboardingRunTerminationReceiptBody(row));
}

module.exports = {
  PERSONNEL_LIFECYCLE_OFFBOARDING_RECEIPT_SCHEMA_VERSION,
  PERSONNEL_LIFECYCLE_OFFBOARDING_CONTRACT_VERSION,
  canonicalJson,
  canonicalSha256,
  canonicalValue,
  deterministicUuidV4,
  personnelLifecycleOffboardingCaseEventReceiptBody,
  personnelLifecycleOffboardingCaseEventReceiptSha256,
  personnelLifecycleOffboardingAssignmentBindingReceiptBody,
  personnelLifecycleOffboardingAssignmentBindingReceiptSha256,
  personnelLifecycleOffboardingAssignmentReceiptBody,
  personnelLifecycleOffboardingAssignmentReceiptSha256,
  personnelLifecycleOffboardingConfidentialAccessReceiptBody,
  personnelLifecycleOffboardingConfidentialAccessReceiptSha256,
  personnelLifecycleOffboardingOperationReceiptBody,
  personnelLifecycleOffboardingOperationReceiptSha256,
  personnelLifecycleOffboardingPackageVersionReceiptBody,
  personnelLifecycleOffboardingPackageVersionReceiptSha256,
  personnelLifecycleOffboardingPackageVersionArchiveReceiptBody,
  personnelLifecycleOffboardingPackageVersionArchiveReceiptSha256,
  personnelLifecycleOffboardingPackageBindingReceiptBody,
  personnelLifecycleOffboardingPackageBindingReceiptSha256,
  personnelLifecycleOffboardingPackageRunReceiptBody,
  personnelLifecycleOffboardingPackageRunReceiptSha256,
  personnelLifecycleOffboardingProtectedPlanReceiptBody,
  personnelLifecycleOffboardingProtectedPlanReceiptSha256,
  personnelLifecycleOffboardingRequestReceiptBody,
  personnelLifecycleOffboardingRequestSha256,
  personnelLifecycleOffboardingReferenceDatesReceiptBody,
  personnelLifecycleOffboardingReferenceDatesReceiptSha256,
  personnelLifecycleOffboardingRunTerminationReceiptBody,
  personnelLifecycleOffboardingRunTerminationReceiptSha256,
  personnelLifecycleOffboardingRuntimeStepReceiptBody,
  personnelLifecycleOffboardingRuntimeStepReceiptSha256,
  personnelLifecycleOffboardingScopeSnapshotBody,
  personnelLifecycleOffboardingScopeSnapshotSha256,
  sha256,
};
