"use strict";

function personnelWorkflowInstanceReceiptBody(row) {
  return {
    schemaVersion: 1,
    runId: row.run_id,
    publicationId: row.publication_id,
    operationId: row.operation_id,
    subject: {
      type: row.subject_type,
      candidateId: row.candidate_id || null,
      applicationId: row.application_id || null,
      candidateRevision: Number(row.candidate_revision || 0) || null,
      applicationRevision: Number(row.application_revision || 0) || null,
      employeeNumber: row.employee_number || null,
    },
    scope: {
      locationId: row.location_id || null,
      departmentId: Number(row.department_id || 0) || null,
    },
    requestSha256: row.request_sha256,
    startedBy: row.started_by,
    startedAt: row.started_at,
  };
}

function personnelWorkflowTaskAssignmentReceiptBody(row) {
  return {
    schemaVersion: 1,
    runId: row.run_id,
    stepId: row.step_id,
    employeeNumber: row.employee_number,
    responsibilityType: row.responsibility_type,
    responsibilityReference: row.responsibility_reference,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at,
  };
}

module.exports = {
  personnelWorkflowInstanceReceiptBody,
  personnelWorkflowTaskAssignmentReceiptBody,
};
