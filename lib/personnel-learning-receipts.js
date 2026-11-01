"use strict";

const { createHash } = require("node:crypto");

function sha256Text(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function moduleReceiptBody(row) {
  return {
    schemaVersion: 1,
    id: String(row.id || ""),
    moduleCode: String(row.module_code ?? row.moduleCode ?? ""),
    moduleType: String(row.module_type ?? row.moduleType ?? ""),
    createdBy: String(row.created_by ?? row.createdBy ?? ""),
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
  };
}

function moduleReceiptSha256(row) {
  return sha256Text(JSON.stringify(moduleReceiptBody(row)));
}

function moduleVersionReceiptBody(row) {
  const departmentId = row.scope_department_id ?? row.scopeDepartmentId;
  return {
    schemaVersion: 1,
    moduleId: String(row.module_id ?? row.moduleId ?? ""),
    versionNumber: Number(row.version_number ?? row.versionNumber ?? 0),
    title: String(row.title || ""),
    contentSha256: String(row.content_sha256 ?? row.contentSha256 ?? ""),
    scopeType: String(row.scope_type ?? row.scopeType ?? ""),
    scopeLocationId: String(row.scope_location_id ?? row.scopeLocationId ?? ""),
    scopeDepartmentId: departmentId === null || departmentId === undefined
      ? null : Number(departmentId),
    scopeSnapshotSha256: String(
      row.scope_snapshot_sha256 ?? row.scopeSnapshotSha256 ?? "",
    ),
    previousReceiptSha256: String(
      row.previous_receipt_sha256 ?? row.previousReceiptSha256 ?? "",
    ),
    createdBy: String(row.created_by ?? row.createdBy ?? ""),
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
  };
}

function moduleVersionReceiptSha256(row) {
  return sha256Text(JSON.stringify(moduleVersionReceiptBody(row)));
}

function moduleEventReceiptBody(row) {
  const versionNumber = row.module_version_number ?? row.moduleVersionNumber;
  return {
    schemaVersion: 1,
    id: String(row.id || ""),
    moduleId: String(row.module_id ?? row.moduleId ?? ""),
    sequenceNumber: Number(row.sequence_number ?? row.sequenceNumber ?? 0),
    eventType: String(row.event_type ?? row.eventType ?? ""),
    moduleVersionNumber: versionNumber === null || versionNumber === undefined
      ? null : Number(versionNumber),
    eventPayloadSha256: String(
      row.event_payload_sha256 ?? row.eventPayloadSha256 ?? "",
    ),
    previousReceiptSha256: String(
      row.previous_receipt_sha256 ?? row.previousReceiptSha256 ?? "",
    ),
    actorId: String(row.actor_id ?? row.actorId ?? ""),
    occurredAt: String(row.occurred_at ?? row.occurredAt ?? ""),
  };
}

function moduleEventReceiptSha256(row) {
  return sha256Text(JSON.stringify(moduleEventReceiptBody(row)));
}

module.exports = {
  sha256Text,
  moduleReceiptBody,
  moduleReceiptSha256,
  moduleVersionReceiptBody,
  moduleVersionReceiptSha256,
  moduleEventReceiptBody,
  moduleEventReceiptSha256,
};
