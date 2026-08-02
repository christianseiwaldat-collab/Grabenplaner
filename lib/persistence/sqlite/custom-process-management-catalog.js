"use strict";

const {
  CUSTOM_PROCESS_MANAGEMENT_STATEMENTS: S,
} = require("../statements/custom-process-management");

function entry(statement, sql, returning = false) {
  return Object.freeze({ statement, sql, returning });
}

function jsonObject(fields) {
  return `json_object(${Object.entries(fields)
    .flatMap(([name, expression]) => [`'${name}'`, expression])
    .join(", ")}) AS data`;
}

const ACCESS_SCOPES = `json(COALESCE((
  SELECT json_group_array(json_object(
    'locationId', scope.location_id,
    'departmentId', scope.department_id
  ))
  FROM portal_access_scopes scope
  WHERE scope.employee_number = u.employee_number
  ORDER BY scope.location_id, scope.department_id
), '[]'))`;

const RECIPIENT_FIELDS = Object.freeze({
  employee_number: "u.employee_number",
  full_name: "e.full_name",
  role: "u.role",
  role_permissions: "COALESCE(r.permissions, '[]')",
  granted_permissions: `COALESCE((
    SELECT json_group_array(grant_row.permission)
    FROM portal_permission_grants grant_row
    WHERE grant_row.employee_number = u.employee_number
  ), '[]')`,
  denied_permissions: `COALESCE((
    SELECT json_group_array(denial.permission)
    FROM portal_permission_denials denial
    WHERE denial.employee_number = u.employee_number
  ), '[]')`,
  permission_scopes: `COALESCE((
    SELECT json_group_array(json_object(
      'permission', permission_scope.permission,
      'locationId', permission_scope.location_id,
      'departmentId', NULLIF(permission_scope.department_id, 0),
      'approvedBy', permission_scope.approved_by
    ))
    FROM portal_permission_scope_grants permission_scope
    JOIN locations permission_location
      ON permission_location.id = permission_scope.location_id
      AND permission_location.active = 1
    LEFT JOIN departments permission_department
      ON permission_department.id = permission_scope.department_id
      AND permission_department.location_id = permission_scope.location_id
      AND permission_department.active = 1
    WHERE permission_scope.employee_number = u.employee_number
      AND (
        permission_scope.department_id = 0
        OR permission_department.id IS NOT NULL
      )
  ), '[]')`,
  home_location_id: "e.home_location_id",
  preferred_department_id: "e.preferred_department_id",
  access_scopes: ACCESS_SCOPES,
});

const PROCESS_FIELDS = Object.freeze({
  id: "p.id",
  title: "p.title",
  symbol: "p.symbol",
  description: "p.description",
  category: "p.category",
  scope_type: "p.scope_type",
  location_id: "p.location_id",
  department_id: "p.department_id",
  trigger_type: "p.trigger_type",
  trigger_minimum_shortfall: "p.trigger_minimum_shortfall",
  status: "p.status",
  revision: "p.revision",
  created_by: "p.created_by",
  updated_by: "p.updated_by",
  archived_at: "p.archived_at",
  created_at: "p.created_at",
  updated_at: "p.updated_at",
  scope_location_name: "scope_location.name",
  scope_location_active: "scope_location.active",
  scope_department_name: "scope_department.name",
  scope_department_active: "scope_department.active",
  scope_department_location_id: "scope_department.location_id",
  scope_department_location_name: "department_location.name",
  scope_department_location_active: "department_location.active",
});

const PROCESS_FROM = `
  FROM custom_processes p
  LEFT JOIN locations scope_location ON scope_location.id = p.location_id
  LEFT JOIN departments scope_department ON scope_department.id = p.department_id
  LEFT JOIN locations department_location ON department_location.id = scope_department.location_id
`;

const STEP_FIELDS = Object.freeze({
  id: "s.id",
  process_id: "s.process_id",
  sort_order: "s.sort_order",
  step_type: "s.step_type",
  title: "s.title",
  description: "s.description",
  responsibility_type: "s.responsibility_type",
  responsibility_reference: "s.responsibility_reference",
  responsibility_label: "s.responsibility_label",
  condition_type: "s.condition_type",
  condition_text: "s.condition_text",
  notification_channels: "s.notification_channels",
  created_at: "s.created_at",
  updated_at: "s.updated_at",
});

const RUN_FIELDS = Object.freeze({
  id: "r.id",
  process_id: "r.process_id",
  process_revision: "r.process_revision",
  trigger_type: "r.trigger_type",
  trigger_key: "r.trigger_key",
  status: "r.status",
  location_id: "r.location_id",
  department_id: "r.department_id",
  triggered_by: "r.triggered_by",
  activation_count: "r.activation_count",
  resolved_at: "r.resolved_at",
  created_at: "r.created_at",
  updated_at: "r.updated_at",
  run_location_name: "run_location.name",
  run_department_name: "run_department.name",
  run_department_location_name: "run_department_location.name",
});

const RUN_FROM = `
  FROM custom_process_runs r
  LEFT JOIN locations run_location ON run_location.id = r.location_id
  LEFT JOIN departments run_department ON run_department.id = r.department_id
  LEFT JOIN locations run_department_location
    ON run_department_location.id = run_department.location_id
`;

const WORKFLOW_PUBLICATION_FIELDS = Object.freeze({
  id: "publication.id",
  process_id: "publication.process_id",
  source_revision: "publication.source_revision",
  version_number: "publication.version_number",
  workflow_code: "publication.workflow_code",
  workflow_type: "publication.workflow_type",
  authority_level: "publication.authority_level",
  requirement_kind: "publication.requirement_kind",
  data_classification: "publication.data_classification",
  scope_type: "publication.scope_type",
  location_id: "publication.location_id",
  department_id: "publication.department_id",
  snapshot_json: "publication.snapshot_json",
  snapshot_sha256: "publication.snapshot_sha256",
  receipt_sha256: "publication.receipt_sha256",
  published_by: "publication.published_by",
  published_at: "publication.published_at",
  archived_at: "archive.archived_at",
});

const PERSONNEL_WORKFLOW_INSTANCE_FIELDS = Object.freeze({
  ...RUN_FIELDS,
  publication_id: "binding.publication_id",
  operation_id: "binding.operation_id",
  subject_type: "binding.subject_type",
  candidate_id: "binding.candidate_id",
  application_id: "binding.application_id",
  candidate_revision: "binding.candidate_revision",
  application_revision: "binding.application_revision",
  employee_number: "binding.employee_number",
  request_sha256: "binding.request_sha256",
  binding_receipt_sha256: "binding.receipt_sha256",
  started_by: "binding.started_by",
  started_at: "binding.started_at",
  workflow_code: "publication.workflow_code",
  workflow_type: "publication.workflow_type",
  version_number: "publication.version_number",
  authority_level: "publication.authority_level",
  requirement_kind: "publication.requirement_kind",
  data_classification: "publication.data_classification",
  publication_scope_type: "publication.scope_type",
  publication_location_id: "publication.location_id",
  publication_department_id: "publication.department_id",
  snapshot_json: "publication.snapshot_json",
  snapshot_sha256: "publication.snapshot_sha256",
  publication_receipt_sha256: "publication.receipt_sha256",
  published_by: "publication.published_by",
  published_at: "publication.published_at",
  publication_archived_at: "archive.archived_at",
});

const RUN_STEP_FIELDS = Object.freeze({
  run_id: "rs.run_id",
  step_id: "rs.step_id",
  sort_order: "rs.sort_order",
  status: "rs.status",
  activated_at: "rs.activated_at",
  completed_at: "rs.completed_at",
  completed_by: "rs.completed_by",
  completion_note: "rs.completion_note",
  completion_request_id: "rs.completion_request_id",
  created_at: "rs.created_at",
  updated_at: "rs.updated_at",
});

const PREFERENCE_FIELDS = Object.freeze({
  employee_number: "preference.employee_number",
  channel: "preference.channel",
  enabled: "preference.enabled",
  process_notifications_enabled: "preference.process_notifications_enabled",
  earliest_time: "preference.earliest_time",
  protected_destination: "preference.protected_destination",
  verified_at: "preference.verified_at",
  verification_hash: "preference.verification_hash",
  verification_salt: "preference.verification_salt",
  verification_expires_at: "preference.verification_expires_at",
  verification_attempts: "preference.verification_attempts",
  verification_sent_at: "preference.verification_sent_at",
  updated_at: "preference.updated_at",
});

const OUTBOUND_JOB_FIELDS = Object.freeze({
  id: "job.id",
  recipient_lookup: "job.recipient_lookup",
  channel: "job.channel",
  entity_lookup: "job.entity_lookup",
  protected_payload: "job.protected_payload",
  not_before: "job.not_before",
  status: "job.status",
  attempts: "job.attempts",
  last_error_code: "job.last_error_code",
  sent_at: "job.sent_at",
  purge_after: "job.purge_after",
  created_at: "job.created_at",
  updated_at: "job.updated_at",
  dedupe_lookup: "job.dedupe_lookup",
});

const SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG = Object.freeze([
  entry(S.activeLocation, `
    SELECT ${jsonObject({ id: "l.id", name: "l.name" })}
    FROM locations l
    WHERE l.id = json_extract($payload, '$.locationId')
      AND l.active = 1
  `),
  entry(S.activeDepartment, `
    SELECT ${jsonObject({
      id: "d.id",
      name: "d.name",
      location_id: "d.location_id",
      location_name: "l.name",
      min_staff: "d.min_staff",
    })}
    FROM departments d
    JOIN locations l ON l.id = d.location_id
    WHERE d.id = json_extract($payload, '$.departmentId')
      AND d.active = 1
      AND l.active = 1
  `),
  entry(S.responsibilityCandidate, `
    SELECT ${jsonObject(RECIPIENT_FIELDS)}
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    LEFT JOIN portal_roles r ON r.id = u.role
    WHERE u.employee_number = json_extract($payload, '$.employeeNumber')
      AND u.active = 1
      AND e.active = 1
      AND TRIM(COALESCE(u.password_hash, '')) <> ''
  `),
  entry(S.listRecipientCandidates, `
    SELECT ${jsonObject(RECIPIENT_FIELDS)}
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    LEFT JOIN portal_roles r ON r.id = u.role
    WHERE u.active = 1
      AND e.active = 1
      AND TRIM(COALESCE(u.password_hash, '')) <> ''
    ORDER BY u.employee_number COLLATE NOCASE
  `),
  entry(S.listActiveLocations, `
    SELECT ${jsonObject({ id: "l.id", name: "l.name" })}
    FROM locations l
    WHERE l.active = 1
    ORDER BY l.id COLLATE NOCASE
  `),
  entry(S.activeDepartmentStaffing, `
    SELECT ${jsonObject({
      id: "d.id",
      location_id: "d.location_id",
      min_staff: "d.min_staff",
    })}
    FROM departments d
    JOIN locations l ON l.id = d.location_id
    WHERE d.id = json_extract($payload, '$.departmentId')
      AND d.location_id = json_extract($payload, '$.locationId')
      AND d.active = 1
      AND l.active = 1
  `),
  entry(S.scopeIsActive, `
    SELECT ${jsonObject({
      active: `CASE
        WHEN json_extract($payload, '$.type') = 'company' THEN 1
        WHEN json_extract($payload, '$.type') = 'location' THEN EXISTS (
          SELECT 1 FROM locations l
          WHERE l.id = json_extract($payload, '$.locationId') AND l.active = 1
        )
        WHEN json_extract($payload, '$.type') = 'department' THEN EXISTS (
          SELECT 1
          FROM departments d
          JOIN locations l ON l.id = d.location_id
          WHERE d.id = json_extract($payload, '$.departmentId')
            AND d.location_id = json_extract($payload, '$.locationId')
            AND d.active = 1
            AND l.active = 1
        )
        ELSE 0
      END`,
    })}
  `),

  entry(S.listProcesses, `
    SELECT ${jsonObject(PROCESS_FIELDS)}
    ${PROCESS_FROM}
    WHERE json_extract($payload, '$.includeArchived') = 1
       OR p.status <> 'archived'
    ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
      p.title COLLATE NOCASE, p.created_at
  `),
  entry(S.processById, `
    SELECT ${jsonObject(PROCESS_FIELDS)}
    ${PROCESS_FROM}
    WHERE p.id = json_extract($payload, '$.id')
      AND (
        json_extract($payload, '$.includeArchived') = 1
        OR p.status <> 'archived'
      )
  `),
  entry(S.listAllSteps, `
    SELECT ${jsonObject(STEP_FIELDS)}
    FROM custom_process_steps s
    ORDER BY s.process_id, s.sort_order, s.id
  `),
  entry(S.listProcessSteps, `
    SELECT ${jsonObject(STEP_FIELDS)}
    FROM custom_process_steps s
    WHERE s.process_id = json_extract($payload, '$.processId')
    ORDER BY s.sort_order, s.id
  `),
  entry(S.conflictingStep, `
    SELECT ${jsonObject({ id: "s.id", process_id: "s.process_id" })}
    FROM custom_process_steps s
    WHERE s.id IN (
      SELECT value FROM json_each(json_extract($payload, '$.stepIds'))
    )
      AND (
        COALESCE(json_extract($payload, '$.processId'), '') = ''
        OR s.process_id <> json_extract($payload, '$.processId')
      )
    LIMIT 1
  `),
  entry(S.insertProcess, `
    INSERT INTO custom_processes (
      id, title, symbol, description, category, scope_type, location_id,
      department_id, trigger_type, trigger_minimum_shortfall, status,
      created_by, updated_by
    )
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.title'),
      json_extract($payload, '$.symbol'),
      json_extract($payload, '$.description'),
      json_extract($payload, '$.category'),
      json_extract($payload, '$.scopeType'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.departmentId'),
      json_extract($payload, '$.triggerType'),
      json_extract($payload, '$.triggerMinimumShortfall'),
      json_extract($payload, '$.status'),
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.actor')
    )
  `),
  entry(S.updateProcess, `
    UPDATE custom_processes
    SET title = json_extract($payload, '$.title'),
        symbol = json_extract($payload, '$.symbol'),
        description = json_extract($payload, '$.description'),
        category = json_extract($payload, '$.category'),
        scope_type = json_extract($payload, '$.scopeType'),
        location_id = json_extract($payload, '$.locationId'),
        department_id = json_extract($payload, '$.departmentId'),
        trigger_type = json_extract($payload, '$.triggerType'),
        trigger_minimum_shortfall = json_extract($payload, '$.triggerMinimumShortfall'),
        status = json_extract($payload, '$.status'),
        revision = revision + 1,
        updated_by = json_extract($payload, '$.actor'),
        archived_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND revision = json_extract($payload, '$.revision')
      AND status <> 'archived'
  `),
  entry(S.setProcessStatus, `
    UPDATE custom_processes
    SET status = json_extract($payload, '$.status'),
        revision = revision + 1,
        updated_by = json_extract($payload, '$.actor'),
        archived_at = CASE
          WHEN json_extract($payload, '$.status') = 'archived' THEN CURRENT_TIMESTAMP
          ELSE NULL
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND revision = json_extract($payload, '$.revision')
      AND status <> 'archived'
  `),
  entry(S.deleteProcessSteps, `
    DELETE FROM custom_process_steps
    WHERE process_id = json_extract($payload, '$.processId')
  `),
  entry(S.insertProcessStep, `
    INSERT INTO custom_process_steps (
      id, process_id, sort_order, step_type, title, description,
      responsibility_type, responsibility_reference, responsibility_label,
      condition_type, condition_text, notification_channels
    )
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.processId'),
      json_extract($payload, '$.sortOrder'),
      json_extract($payload, '$.type'),
      json_extract($payload, '$.title'),
      json_extract($payload, '$.description'),
      json_extract($payload, '$.responsibilityType'),
      json_extract($payload, '$.responsibilityReference'),
      json_extract($payload, '$.responsibilityLabel'),
      json_extract($payload, '$.conditionType'),
      json_extract($payload, '$.conditionText'),
      json_extract($payload, '$.notificationChannels')
    )
  `),

  entry(S.processRevision, `
    SELECT ${jsonObject({
      process_id: "revision.process_id",
      revision: "revision.revision",
      snapshot_json: "revision.snapshot_json",
      created_by: "revision.created_by",
      created_at: "revision.created_at",
    })}
    FROM custom_process_revisions revision
    WHERE revision.process_id = json_extract($payload, '$.processId')
      AND revision.revision = json_extract($payload, '$.revision')
  `),
  entry(S.processRevisionExists, `
    SELECT ${jsonObject({ exists: "1" })}
    FROM custom_process_revisions revision
    WHERE revision.process_id = json_extract($payload, '$.processId')
      AND revision.revision = json_extract($payload, '$.revision')
  `),
  entry(S.insertProcessRevision, `
    INSERT OR IGNORE INTO custom_process_revisions (
      process_id, revision, snapshot_json, created_by
    )
    VALUES (
      json_extract($payload, '$.processId'),
      json_extract($payload, '$.revision'),
      json_extract($payload, '$.snapshotJson'),
      json_extract($payload, '$.actor')
    )
  `),

  entry(S.listWorkflowPublications, `
    SELECT ${jsonObject(WORKFLOW_PUBLICATION_FIELDS)}
    FROM custom_process_publications publication
    LEFT JOIN custom_process_publication_archives archive
      ON archive.publication_id = publication.id
    WHERE json_extract($payload, '$.includeArchived') = 1
       OR archive.publication_id IS NULL
    ORDER BY publication.process_id, publication.version_number
  `),
  entry(S.workflowPublicationById, `
    SELECT ${jsonObject(WORKFLOW_PUBLICATION_FIELDS)}
    FROM custom_process_publications publication
    LEFT JOIN custom_process_publication_archives archive
      ON archive.publication_id = publication.id
    WHERE publication.id = json_extract($payload, '$.publicationId')
  `),
  entry(S.insertWorkflowPublication, `
    INSERT INTO custom_process_publications (
      id, process_id, source_revision, version_number, workflow_code,
      workflow_type, authority_level, requirement_kind, data_classification,
      scope_type, location_id, department_id, snapshot_json, snapshot_sha256,
      receipt_sha256, published_by, published_at
    )
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.processId'),
      json_extract($payload, '$.sourceRevision'),
      json_extract($payload, '$.versionNumber'),
      json_extract($payload, '$.workflowCode'),
      json_extract($payload, '$.workflowType'),
      json_extract($payload, '$.authorityLevel'),
      json_extract($payload, '$.requirementKind'),
      json_extract($payload, '$.dataClassification'),
      json_extract($payload, '$.scopeType'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.departmentId'),
      json_extract($payload, '$.snapshotJson'),
      json_extract($payload, '$.snapshotSha256'),
      json_extract($payload, '$.receiptSha256'),
      json_extract($payload, '$.publishedBy'),
      json_extract($payload, '$.publishedAt')
    )
  `),
  entry(S.insertWorkflowPublicationArchive, `
    INSERT INTO custom_process_publication_archives (
      publication_id, reason, archived_by, archived_at
    )
    VALUES (
      json_extract($payload, '$.publicationId'),
      json_extract($payload, '$.reason'),
      json_extract($payload, '$.archivedBy'),
      json_extract($payload, '$.archivedAt')
    )
  `),
  entry(S.processHasWorkflowPublications, `
    SELECT ${jsonObject({ exists: "1" })}
    FROM custom_process_publications publication
    WHERE publication.process_id = json_extract($payload, '$.processId')
    LIMIT 1
  `),

  entry(S.personnelWorkflowCandidateSubject, `
    SELECT ${jsonObject({
      subject_type: "'candidate'",
      candidate_id: "candidate.id",
      candidate_revision: "candidate.revision",
      candidate_state: "candidate.state",
      application_id: "application.id",
      application_revision: "application.revision",
      application_status: "application.status",
      location_id: "application.desired_location_id",
      department_id: "application.desired_department_id",
      location_active: "location.active",
      department_active: "department.active",
      department_location_id: "department.location_id",
    })}
    FROM candidates candidate
    JOIN candidate_applications application
      ON application.candidate_id = candidate.id
    LEFT JOIN locations location
      ON location.id = application.desired_location_id
    LEFT JOIN departments department
      ON department.id = application.desired_department_id
    WHERE candidate.id = json_extract($payload, '$.candidateId')
      AND application.id = json_extract($payload, '$.applicationId')
  `),
  entry(S.personnelWorkflowEmployeeSubject, `
    SELECT ${jsonObject({
      subject_type: "'employee'",
      employee_number: "employee.personnel_number",
      employee_active: "employee.active",
      location_id: "employee.home_location_id",
      department_id: "employee.preferred_department_id",
      location_active: "location.active",
      department_active: "department.active",
      department_location_id: "department.location_id",
    })}
    FROM employees employee
    LEFT JOIN locations location ON location.id = employee.home_location_id
    LEFT JOIN departments department
      ON department.id = employee.preferred_department_id
    WHERE employee.personnel_number = json_extract($payload, '$.employeeNumber')
  `),
  entry(S.runBindingByOperationId, `
    SELECT ${jsonObject(PERSONNEL_WORKFLOW_INSTANCE_FIELDS)}
    FROM custom_process_run_bindings binding
    JOIN custom_process_runs r ON r.id = binding.run_id
    JOIN custom_process_publications publication
      ON publication.id = binding.publication_id
    LEFT JOIN custom_process_publication_archives archive
      ON archive.publication_id = publication.id
    LEFT JOIN locations run_location ON run_location.id = r.location_id
    LEFT JOIN departments run_department ON run_department.id = r.department_id
    LEFT JOIN locations run_department_location
      ON run_department_location.id = run_department.location_id
    WHERE binding.operation_id = json_extract($payload, '$.operationId')
  `),
  entry(S.personnelWorkflowInstanceById, `
    SELECT ${jsonObject(PERSONNEL_WORKFLOW_INSTANCE_FIELDS)}
    FROM custom_process_run_bindings binding
    JOIN custom_process_runs r ON r.id = binding.run_id
    JOIN custom_process_publications publication
      ON publication.id = binding.publication_id
    LEFT JOIN custom_process_publication_archives archive
      ON archive.publication_id = publication.id
    LEFT JOIN locations run_location ON run_location.id = r.location_id
    LEFT JOIN departments run_department ON run_department.id = r.department_id
    LEFT JOIN locations run_department_location
      ON run_department_location.id = run_department.location_id
    WHERE binding.run_id = json_extract($payload, '$.id')
  `),
  entry(S.insertRunBinding, `
    INSERT INTO custom_process_run_bindings (
      run_id, publication_id, operation_id, subject_type,
      candidate_id, application_id, candidate_revision, application_revision,
      employee_number, request_sha256, receipt_sha256, started_by, started_at
    ) VALUES (
      json_extract($payload, '$.runId'),
      json_extract($payload, '$.publicationId'),
      json_extract($payload, '$.operationId'),
      json_extract($payload, '$.subjectType'),
      json_extract($payload, '$.candidateId'),
      json_extract($payload, '$.applicationId'),
      json_extract($payload, '$.candidateRevision'),
      json_extract($payload, '$.applicationRevision'),
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.requestSha256'),
      json_extract($payload, '$.receiptSha256'),
      json_extract($payload, '$.startedBy'),
      json_extract($payload, '$.startedAt')
    )
  `),
  entry(S.insertRunStepAssignment, `
    INSERT INTO custom_process_run_step_assignments (
      run_id, step_id, employee_number, responsibility_type,
      responsibility_reference, assigned_by, assigned_at, receipt_sha256
    ) VALUES (
      json_extract($payload, '$.runId'),
      json_extract($payload, '$.stepId'),
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.responsibilityType'),
      json_extract($payload, '$.responsibilityReference'),
      json_extract($payload, '$.assignedBy'),
      json_extract($payload, '$.assignedAt'),
      json_extract($payload, '$.receiptSha256')
    )
  `),
  entry(S.listRunStepAssignments, `
    SELECT ${jsonObject({
      run_id: "assignment.run_id",
      step_id: "assignment.step_id",
      employee_number: "assignment.employee_number",
      responsibility_type: "assignment.responsibility_type",
      responsibility_reference: "assignment.responsibility_reference",
      assigned_by: "assignment.assigned_by",
      assigned_at: "assignment.assigned_at",
      receipt_sha256: "assignment.receipt_sha256",
    })}
    FROM custom_process_run_step_assignments assignment
    WHERE assignment.run_id = json_extract($payload, '$.runId')
      AND (
        json_extract($payload, '$.stepId') IS NULL
        OR assignment.step_id = json_extract($payload, '$.stepId')
      )
    ORDER BY assignment.step_id
  `),
  entry(S.listPersonnelWorkflowInstances, `
    SELECT ${jsonObject({
      ...PERSONNEL_WORKFLOW_INSTANCE_FIELDS,
      active_step_id: "active_step.step_id",
      active_step_status: "active_step.status",
      active_step_sort_order: "active_step.sort_order",
      active_step_activated_at: "active_step.activated_at",
      assigned_employee_number: "active_assignment.employee_number",
      finished_steps: "(SELECT COUNT(*) FROM custom_process_run_steps finished WHERE finished.run_id = r.id AND finished.status IN ('completed','skipped'))",
      total_steps: "(SELECT COUNT(*) FROM custom_process_run_steps total WHERE total.run_id = r.id)",
    })}
    FROM custom_process_run_bindings binding
    JOIN custom_process_runs r ON r.id = binding.run_id
    JOIN custom_process_publications publication
      ON publication.id = binding.publication_id
    LEFT JOIN custom_process_publication_archives archive
      ON archive.publication_id = publication.id
    LEFT JOIN custom_process_run_steps active_step
      ON active_step.run_id = r.id AND active_step.status = 'active'
    LEFT JOIN custom_process_run_step_assignments active_assignment
      ON active_assignment.run_id = active_step.run_id
      AND active_assignment.step_id = active_step.step_id
    LEFT JOIN locations run_location ON run_location.id = r.location_id
    LEFT JOIN departments run_department ON run_department.id = r.department_id
    LEFT JOIN locations run_department_location
      ON run_department_location.id = run_department.location_id
    ORDER BY binding.started_at DESC, binding.run_id DESC
  `),
  entry(S.listActivePersonnelWorkflowTaskRuns, `
    SELECT ${jsonObject({
      ...PERSONNEL_WORKFLOW_INSTANCE_FIELDS,
      step_id: "run_step.step_id",
      step_status: "run_step.status",
      activated_at: "run_step.activated_at",
      sort_order: "run_step.sort_order",
      assigned_employee_number: "assignment.employee_number",
      assignment_responsibility_type: "assignment.responsibility_type",
      assignment_responsibility_reference: "assignment.responsibility_reference",
      assignment_assigned_at: "assignment.assigned_at",
    })}
    FROM custom_process_run_bindings binding
    JOIN custom_process_runs r ON r.id = binding.run_id
    JOIN custom_process_publications publication
      ON publication.id = binding.publication_id
    LEFT JOIN custom_process_publication_archives archive
      ON archive.publication_id = publication.id
    JOIN custom_process_run_steps run_step
      ON run_step.run_id = r.id AND run_step.status = 'active'
    JOIN custom_process_run_step_assignments assignment
      ON assignment.run_id = run_step.run_id
      AND assignment.step_id = run_step.step_id
      AND assignment.employee_number = json_extract($payload, '$.employeeNumber')
    LEFT JOIN locations run_location ON run_location.id = r.location_id
    LEFT JOIN departments run_department ON run_department.id = r.department_id
    LEFT JOIN locations run_department_location
      ON run_department_location.id = run_department.location_id
    WHERE r.status = 'open'
    ORDER BY COALESCE(run_step.activated_at, binding.started_at) DESC, r.id DESC
  `),

  entry(S.runById, `
    SELECT ${jsonObject(RUN_FIELDS)}
    ${RUN_FROM}
    WHERE r.id = json_extract($payload, '$.id')
      AND NOT EXISTS (
        SELECT 1 FROM custom_process_run_bindings binding
        WHERE binding.run_id = r.id
      )
  `),
  entry(S.openRunForExternalJob, `
    SELECT ${jsonObject(RUN_FIELDS)}
    ${RUN_FROM}
    WHERE r.id = json_extract($payload, '$.runId')
      AND r.process_id = json_extract($payload, '$.processId')
      AND r.status = 'open'
      AND NOT EXISTS (
        SELECT 1 FROM custom_process_run_bindings binding
        WHERE binding.run_id = r.id
      )
  `),
  entry(S.listOpenRunsForProcess, `
    SELECT ${jsonObject(RUN_FIELDS)}
    ${RUN_FROM}
    WHERE r.process_id = json_extract($payload, '$.processId')
      AND r.status = 'open'
      AND NOT EXISTS (
        SELECT 1 FROM custom_process_run_bindings binding
        WHERE binding.run_id = r.id
      )
    ORDER BY r.created_at, r.id
  `),
  entry(S.runByTriggerKey, `
    SELECT ${jsonObject(RUN_FIELDS)}
    ${RUN_FROM}
    WHERE r.trigger_key = json_extract($payload, '$.triggerKey')
      AND NOT EXISTS (
        SELECT 1 FROM custom_process_run_bindings binding
        WHERE binding.run_id = r.id
      )
  `),
  entry(S.insertRun, `
    INSERT INTO custom_process_runs (
      id, process_id, process_revision, trigger_type, trigger_key,
      location_id, department_id, triggered_by
    )
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.processId'),
      json_extract($payload, '$.processRevision'),
      json_extract($payload, '$.triggerType'),
      json_extract($payload, '$.triggerKey'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.departmentId'),
      json_extract($payload, '$.triggeredBy')
    )
  `),
  entry(S.reopenRun, `
    UPDATE custom_process_runs
    SET status = 'open',
        activation_count = activation_count + 1,
        resolved_at = NULL,
        triggered_by = json_extract($payload, '$.triggeredBy'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND status = 'resolved'
  `),
  entry(S.deleteRunSteps, `
    DELETE FROM custom_process_run_steps
    WHERE run_id = json_extract($payload, '$.runId')
  `),
  entry(S.countRunSteps, `
    SELECT ${jsonObject({ count: "COUNT(*)" })}
    FROM custom_process_run_steps rs
    WHERE rs.run_id = json_extract($payload, '$.runId')
  `),
  entry(S.insertRunStep, `
    INSERT OR IGNORE INTO custom_process_run_steps (run_id, step_id, sort_order)
    VALUES (
      json_extract($payload, '$.runId'),
      json_extract($payload, '$.stepId'),
      json_extract($payload, '$.sortOrder')
    )
  `),
  entry(S.openRunById, `
    SELECT ${jsonObject(RUN_FIELDS)}
    ${RUN_FROM}
    WHERE r.id = json_extract($payload, '$.id')
      AND r.status = 'open'
      AND NOT EXISTS (
        SELECT 1 FROM custom_process_run_bindings binding
        WHERE binding.run_id = r.id
      )
  `),
  entry(S.activeRunStep, `
    SELECT ${jsonObject(RUN_STEP_FIELDS)}
    FROM custom_process_run_steps rs
    WHERE rs.run_id = json_extract($payload, '$.runId')
      AND rs.status = 'active'
    ORDER BY rs.sort_order
    LIMIT 1
  `),
  entry(S.pendingRunStep, `
    SELECT ${jsonObject(RUN_STEP_FIELDS)}
    FROM custom_process_run_steps rs
    WHERE rs.run_id = json_extract($payload, '$.runId')
      AND rs.status = 'pending'
    ORDER BY rs.sort_order
    LIMIT 1
  `),
  entry(S.runStepById, `
    SELECT ${jsonObject(RUN_STEP_FIELDS)}
    FROM custom_process_run_steps rs
    WHERE rs.run_id = json_extract($payload, '$.runId')
      AND rs.step_id = json_extract($payload, '$.stepId')
  `),
  entry(S.completeSystemRunStep, `
    UPDATE custom_process_run_steps
    SET status = 'completed',
        activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
        completed_at = CURRENT_TIMESTAMP,
        completed_by = 'system',
        updated_at = CURRENT_TIMESTAMP
    WHERE run_id = json_extract($payload, '$.runId')
      AND step_id = json_extract($payload, '$.stepId')
      AND status = 'pending'
  `),
  entry(S.activateRunStep, `
    UPDATE custom_process_run_steps
    SET status = 'active',
        activated_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE run_id = json_extract($payload, '$.runId')
      AND step_id = json_extract($payload, '$.stepId')
      AND status = 'pending'
  `),
  entry(S.completeRunStep, `
    UPDATE custom_process_run_steps
    SET status = json_extract($payload, '$.status'),
        completed_at = CURRENT_TIMESTAMP,
        completed_by = json_extract($payload, '$.actor'),
        completion_note = json_extract($payload, '$.note'),
        completion_request_id = json_extract($payload, '$.idempotencyKey'),
        updated_at = CURRENT_TIMESTAMP
    WHERE run_id = json_extract($payload, '$.runId')
      AND step_id = json_extract($payload, '$.stepId')
      AND status = 'active'
  `),
  entry(S.skipOpenRunSteps, `
    UPDATE custom_process_run_steps
    SET status = 'skipped',
        completed_at = CURRENT_TIMESTAMP,
        completed_by = 'system',
        updated_at = CURRENT_TIMESTAMP
    WHERE run_id = json_extract($payload, '$.runId')
      AND status IN ('pending', 'active')
  `),
  entry(S.resolveRun, `
    UPDATE custom_process_runs
    SET status = 'resolved',
        resolved_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.runId')
      AND status = 'open'
  `),
  entry(S.listOpenStaffingRuns, `
    SELECT ${jsonObject(RUN_FIELDS)}
    ${RUN_FROM}
    JOIN custom_processes process ON process.id = r.process_id
    WHERE r.status = 'open'
      AND r.trigger_type = 'staffing_shortfall'
      AND NOT EXISTS (
        SELECT 1 FROM custom_process_run_bindings binding
        WHERE binding.run_id = r.id
      )
    ORDER BY r.created_at, r.id
  `),
  entry(S.listOpenRuns, `
    SELECT ${jsonObject(RUN_FIELDS)}
    ${RUN_FROM}
    WHERE r.status = 'open'
      AND NOT EXISTS (
        SELECT 1 FROM custom_process_run_bindings binding
        WHERE binding.run_id = r.id
      )
    ORDER BY r.created_at, r.id
  `),
  entry(S.listActiveTaskRuns, `
    SELECT ${jsonObject({
      ...RUN_FIELDS,
      step_id: "rs.step_id",
      step_status: "rs.status",
      activated_at: "rs.activated_at",
      sort_order: "rs.sort_order",
    })}
    ${RUN_FROM}
    JOIN custom_process_run_steps rs
      ON rs.run_id = r.id
      AND rs.status = 'active'
    WHERE r.status = 'open'
      AND NOT EXISTS (
        SELECT 1 FROM custom_process_run_bindings binding
        WHERE binding.run_id = r.id
      )
    ORDER BY COALESCE(rs.activated_at, r.created_at) DESC, r.created_at DESC
  `),
  entry(S.runStepCounts, `
    SELECT ${jsonObject({
      total: "COUNT(*)",
      finished: "SUM(CASE WHEN rs.status IN ('completed','skipped') THEN 1 ELSE 0 END)",
    })}
    FROM custom_process_run_steps rs
    WHERE rs.run_id = json_extract($payload, '$.runId')
  `),

  entry(S.insertPortalNotification, `
    INSERT OR IGNORE INTO portal_notifications (
      id, recipient_employee_number, event_type, title, message, target,
      entity_type, entity_id, dedupe_key
    )
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.recipient'),
      json_extract($payload, '$.eventType'),
      json_extract($payload, '$.title'),
      json_extract($payload, '$.message'),
      json_extract($payload, '$.target'),
      json_extract($payload, '$.entityType'),
      json_extract($payload, '$.entityId'),
      json_extract($payload, '$.dedupeKey')
    )
  `),
  entry(S.markRunNotificationsRead, `
    UPDATE portal_notifications
    SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE entity_type = 'custom_process_run'
      AND entity_id = json_extract($payload, '$.runId')
  `),
  entry(S.markTaskNotificationRead, `
    UPDATE portal_notifications
    SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE recipient_employee_number = json_extract($payload, '$.recipient')
      AND dedupe_key = json_extract($payload, '$.dedupeKey')
  `),

  entry(S.listNotificationPreferences, `
    SELECT ${jsonObject(PREFERENCE_FIELDS)}
    FROM sickness_notification_preferences preference
    WHERE preference.employee_number = json_extract($payload, '$.employeeNumber')
    ORDER BY preference.channel
  `),
  entry(S.notificationPreference, `
    SELECT ${jsonObject(PREFERENCE_FIELDS)}
    FROM sickness_notification_preferences preference
    WHERE preference.employee_number = json_extract($payload, '$.employeeNumber')
      AND preference.channel = json_extract($payload, '$.channel')
  `),
  entry(S.listEnabledStaffingPreferences, `
    SELECT ${jsonObject(PREFERENCE_FIELDS)}
    FROM sickness_notification_preferences preference
    WHERE preference.employee_number = json_extract($payload, '$.employeeNumber')
      AND preference.enabled = 1
      AND preference.verified_at IS NOT NULL
    ORDER BY preference.channel
  `),
  entry(S.upsertNotificationPreference, `
    INSERT INTO sickness_notification_preferences (
      employee_number, channel, enabled, process_notifications_enabled,
      earliest_time, protected_destination, verified_at, verification_hash,
      verification_salt, verification_expires_at, verification_attempts,
      verification_sent_at, updated_at
    )
    VALUES (
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.channel'),
      json_extract($payload, '$.enabled'),
      json_extract($payload, '$.processEnabled'),
      json_extract($payload, '$.earliestTime'),
      json_extract($payload, '$.protectedDestination'),
      json_extract($payload, '$.verifiedAt'),
      json_extract($payload, '$.verificationHash'),
      json_extract($payload, '$.verificationSalt'),
      json_extract($payload, '$.verificationExpiresAt'),
      json_extract($payload, '$.verificationAttempts'),
      json_extract($payload, '$.verificationSentAt'),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(employee_number, channel) DO UPDATE SET
      enabled = excluded.enabled,
      process_notifications_enabled = excluded.process_notifications_enabled,
      earliest_time = excluded.earliest_time,
      protected_destination = excluded.protected_destination,
      verified_at = excluded.verified_at,
      verification_hash = excluded.verification_hash,
      verification_salt = excluded.verification_salt,
      verification_expires_at = excluded.verification_expires_at,
      verification_attempts = excluded.verification_attempts,
      verification_sent_at = excluded.verification_sent_at,
      updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.startNotificationVerification, `
    INSERT INTO sickness_notification_preferences (
      employee_number, channel, enabled, earliest_time, protected_destination,
      verified_at, verification_hash, verification_salt,
      verification_expires_at, verification_attempts, verification_sent_at,
      updated_at
    )
    VALUES (
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.channel'),
      0,
      json_extract($payload, '$.earliestTime'),
      json_extract($payload, '$.protectedDestination'),
      NULL,
      json_extract($payload, '$.verificationHash'),
      json_extract($payload, '$.verificationSalt'),
      json_extract($payload, '$.verificationExpiresAt'),
      0,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(employee_number, channel) DO UPDATE SET
      enabled = 0,
      earliest_time = excluded.earliest_time,
      protected_destination = excluded.protected_destination,
      verified_at = NULL,
      verification_hash = excluded.verification_hash,
      verification_salt = excluded.verification_salt,
      verification_expires_at = excluded.verification_expires_at,
      verification_attempts = 0,
      verification_sent_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.clearNotificationVerification, `
    UPDATE sickness_notification_preferences
    SET verification_hash = '',
        verification_salt = '',
        verification_expires_at = NULL,
        verification_attempts = 0,
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND channel = json_extract($payload, '$.channel')
  `),
  entry(S.updateNotificationVerificationAttempts, `
    UPDATE sickness_notification_preferences
    SET verification_attempts = json_extract($payload, '$.attempts'),
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND channel = json_extract($payload, '$.channel')
  `),
  entry(S.confirmNotificationVerification, `
    UPDATE sickness_notification_preferences
    SET enabled = 1,
        verified_at = CURRENT_TIMESTAMP,
        verification_hash = '',
        verification_salt = '',
        verification_expires_at = NULL,
        verification_attempts = 0,
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND channel = json_extract($payload, '$.channel')
  `),

  entry(S.insertOutboundJob, `
    INSERT OR IGNORE INTO outbound_notification_jobs (
      id, recipient_lookup, channel, entity_lookup, protected_payload,
      not_before, purge_after, dedupe_lookup
    )
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.recipientLookup'),
      json_extract($payload, '$.channel'),
      json_extract($payload, '$.entityLookup'),
      json_extract($payload, '$.protectedPayload'),
      json_extract($payload, '$.notBefore'),
      json_extract($payload, '$.purgeAfter'),
      json_extract($payload, '$.dedupeLookup')
    )
  `),
  entry(S.outboundJobByDedupe, `
    SELECT ${jsonObject(OUTBOUND_JOB_FIELDS)}
    FROM outbound_notification_jobs job
    WHERE job.dedupe_lookup = json_extract($payload, '$.dedupeLookup')
  `),
  entry(S.listDueOutboundJobs, `
    SELECT ${jsonObject(OUTBOUND_JOB_FIELDS)}
    FROM outbound_notification_jobs job
    WHERE job.status = 'pending'
      AND job.not_before <= json_extract($payload, '$.now')
    ORDER BY job.not_before, job.created_at
    LIMIT 20
  `),
  entry(S.claimOutboundJob, `
    UPDATE outbound_notification_jobs
    SET status = 'processing',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND status = 'pending'
  `),
  entry(S.rearmOutboundJob, `
    UPDATE outbound_notification_jobs
    SET recipient_lookup = json_extract($payload, '$.recipientLookup'),
        channel = json_extract($payload, '$.channel'),
        entity_lookup = json_extract($payload, '$.entityLookup'),
        protected_payload = json_extract($payload, '$.protectedPayload'),
        not_before = json_extract($payload, '$.notBefore'),
        status = 'pending',
        attempts = 0,
        last_error_code = '',
        sent_at = NULL,
        purge_after = json_extract($payload, '$.purgeAfter'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
      AND status NOT IN ('pending', 'processing')
  `),
  entry(S.cancelOutboundJob, `
    UPDATE outbound_notification_jobs
    SET status = 'cancelled',
        purge_after = json_extract($payload, '$.purgeAfter'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.cancelOutboundJobsByEntity, `
    UPDATE outbound_notification_jobs
    SET status = 'cancelled',
        purge_after = json_extract($payload, '$.purgeAfter'),
        updated_at = CURRENT_TIMESTAMP
    WHERE entity_lookup = json_extract($payload, '$.entityLookup')
      AND status = 'pending'
  `),
  entry(S.markOutboundJobSent, `
    UPDATE outbound_notification_jobs
    SET status = 'sent',
        attempts = attempts + 1,
        last_error_code = '',
        sent_at = CURRENT_TIMESTAMP,
        purge_after = json_extract($payload, '$.purgeAfter'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),
  entry(S.markOutboundJobFailed, `
    UPDATE outbound_notification_jobs
    SET status = json_extract($payload, '$.status'),
        attempts = json_extract($payload, '$.attempts'),
        last_error_code = json_extract($payload, '$.errorCode'),
        not_before = json_extract($payload, '$.notBefore'),
        purge_after = json_extract($payload, '$.purgeAfter'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.id')
  `),

  entry(S.insertAudit, `
    INSERT INTO audit_log (actor, action, entity_type, entity_id, detail)
    VALUES (
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.action'),
      json_extract($payload, '$.entityType'),
      json_extract($payload, '$.entityId'),
      json_extract($payload, '$.detail')
    )
  `),
]);

module.exports = {
  SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,
};
