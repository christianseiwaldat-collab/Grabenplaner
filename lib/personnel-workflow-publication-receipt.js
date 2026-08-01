"use strict";

function personnelWorkflowPublicationReceiptBody(row) {
  return {
    schemaVersion: 1,
    id: row.id,
    processId: row.process_id,
    sourceRevision: Number(row.source_revision),
    versionNumber: Number(row.version_number),
    workflowCode: row.workflow_code,
    workflowType: row.workflow_type,
    authorityLevel: row.authority_level,
    requirementKind: row.requirement_kind,
    dataClassification: row.data_classification,
    scope: {
      type: row.scope_type,
      locationId: row.location_id || null,
      departmentId: Number(row.department_id || 0) || null,
    },
    snapshotSha256: row.snapshot_sha256,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
  };
}

module.exports = {
  personnelWorkflowPublicationReceiptBody,
};
