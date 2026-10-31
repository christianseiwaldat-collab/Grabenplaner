"use strict";
const { createHash } = require("node:crypto");

function eventReceiptBody(row) {
  return {
    schemaVersion: 1,
    id: String(row.id || ""),
    documentId: String(row.document_id ?? row.documentId ?? ""),
    sequenceNumber: Number(row.sequence_number ?? row.sequenceNumber ?? 0),
    eventType: String(row.event_type ?? row.eventType ?? ""),
    previousReceiptSha256: String(
      row.previous_receipt_sha256 ?? row.previousReceiptSha256 ?? "",
    ),
    actorEmployeeNumber: String(
      row.actor_employee_number ?? row.actorEmployeeNumber ?? "",
    ),
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
  };
}

function eventReceiptSha256(row) {
  return createHash("sha256")
    .update(JSON.stringify(eventReceiptBody(row)))
    .digest("hex");
}

module.exports = { eventReceiptBody, eventReceiptSha256 };
