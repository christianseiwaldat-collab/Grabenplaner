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

function offboardingRuntimeShellExcluded(processExpression) {
  return `NOT EXISTS (
    SELECT 1 FROM personnel_lifecycle_offboarding_package_versions offboarding_version
    WHERE offboarding_version.runtime_process_id = ${processExpression}
  )`;
}

function offboardingRunExcluded(runExpression) {
  return `NOT EXISTS (
    SELECT 1 FROM personnel_lifecycle_offboarding_package_runs offboarding_run
    WHERE offboarding_run.run_id = ${runExpression}
  )`;
}

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

const LIFECYCLE_ONBOARDING_OPERATION_FIELDS = Object.freeze({
  operation_id: "operation.operation_id",
  case_id: "operation.case_id",
  request_sha256: "operation.request_sha256",
  preview_sha256: "operation.preview_sha256",
  result_payload: "json(operation.result_payload)",
  result_receipt_sha256: "operation.result_receipt_sha256",
  actor_id: "operation.actor_id",
  occurred_at: "operation.occurred_at",
});

const LIFECYCLE_ONBOARDING_CASE_FIELDS = Object.freeze({
  id: "lifecycle_case.id",
  case_type: "lifecycle_case.case_type",
  employment_episode_id: "lifecycle_case.employment_episode_id",
  employee_number: "episode.employee_number",
  episode_sequence_number: "episode.sequence_number",
  predecessor_case_id: "lifecycle_case.predecessor_case_id",
  state: "lifecycle_case.state",
  responsible_actor_id: "lifecycle_case.responsible_actor_id",
  scope_type: "lifecycle_case.scope_type",
  location_id: "lifecycle_case.location_id",
  department_id: "lifecycle_case.department_id",
  scope_snapshot_sha256: "lifecycle_case.scope_snapshot_sha256",
  revision: "lifecycle_case.revision",
  created_by: "lifecycle_case.created_by",
  created_at: "lifecycle_case.created_at",
  updated_by: "lifecycle_case.updated_by",
  updated_at: "lifecycle_case.updated_at",
});

const LIFECYCLE_ONBOARDING_TASK_FIELDS = Object.freeze({
  case_id: "lifecycle_case.id",
  case_type: "lifecycle_case.case_type",
  case_state: "lifecycle_case.state",
  case_revision: "lifecycle_case.revision",
  case_responsible_actor_id: "lifecycle_case.responsible_actor_id",
  case_scope_type: "lifecycle_case.scope_type",
  case_location_id: "lifecycle_case.location_id",
  case_department_id: "lifecycle_case.department_id",
  case_scope_snapshot_sha256: "lifecycle_case.scope_snapshot_sha256",
  employee_number: "episode.employee_number",
  subject_employee_number: "subject_employee.personnel_number",
  subject_display_name: "subject_employee.full_name",
  episode_state: "episode.state",
  lifecycle_assignment_id: "lifecycle_assignment.id",
  lifecycle_assignment_case_id: "lifecycle_assignment.case_id",
  lifecycle_step_reference: "lifecycle_assignment.step_reference",
  lifecycle_assignee_actor_id: "lifecycle_assignment.assignee_actor_id",
  lifecycle_predecessor_assignment_id: "lifecycle_assignment.predecessor_assignment_id",
  lifecycle_assignment_receipt_sha256: "lifecycle_assignment.receipt_sha256",
  lifecycle_assigned_by: "lifecycle_assignment.assigned_by",
  lifecycle_assigned_at: "lifecycle_assignment.assigned_at",
  assignment_binding_assignment_id: "assignment_binding.assignment_id",
  assignment_binding_package_id: "assignment_binding.package_binding_id",
  assignment_binding_run_id: "assignment_binding.run_id",
  assignment_binding_step_reference: "assignment_binding.step_reference",
  assignment_binding_receipt_sha256: "assignment_binding.receipt_sha256",
  assignment_bound_by: "assignment_binding.bound_by",
  assignment_bound_at: "assignment_binding.bound_at",
  package_binding_id: "package_binding.id",
  package_case_id: "package_binding.case_id",
  package_publication_id: "package_binding.publication_id",
  package_version_number: "package_binding.version_number",
  package_scope_snapshot_sha256: "package_binding.scope_snapshot_sha256",
  package_binding_receipt_sha256: "package_binding.receipt_sha256",
  package_bound_by: "package_binding.bound_by",
  package_bound_at: "package_binding.bound_at",
  package_run_binding_id: "package_run.package_binding_id",
  run_id: "package_run.run_id",
  run_operation_id: "package_run.run_operation_id",
  family_codes_json: "package_run.family_codes_json",
  lifecycle_review_sha256: "package_run.lifecycle_review_sha256",
  package_run_scope_snapshot_sha256: "package_run.scope_snapshot_sha256",
  package_run_receipt_sha256: "package_run.receipt_sha256",
  run_linked_by: "package_run.linked_by",
  run_linked_at: "package_run.linked_at",
  workflow_binding_run_id: "workflow_binding.run_id",
  workflow_binding_publication_id: "workflow_binding.publication_id",
  workflow_operation_id: "workflow_binding.operation_id",
  workflow_subject_type: "workflow_binding.subject_type",
  workflow_candidate_id: "workflow_binding.candidate_id",
  workflow_application_id: "workflow_binding.application_id",
  workflow_candidate_revision: "workflow_binding.candidate_revision",
  workflow_application_revision: "workflow_binding.application_revision",
  workflow_employee_number: "workflow_binding.employee_number",
  workflow_request_sha256: "workflow_binding.request_sha256",
  workflow_binding_receipt_sha256: "workflow_binding.receipt_sha256",
  workflow_started_by: "workflow_binding.started_by",
  workflow_started_at: "workflow_binding.started_at",
  run_process_id: "run.process_id",
  run_process_revision: "run.process_revision",
  run_trigger_type: "run.trigger_type",
  run_trigger_key: "run.trigger_key",
  run_status: "run.status",
  run_location_id: "run.location_id",
  run_department_id: "run.department_id",
  run_triggered_by: "run.triggered_by",
  run_activation_count: "run.activation_count",
  run_resolved_at: "run.resolved_at",
  publication_id: "publication.id",
  publication_process_id: "publication.process_id",
  publication_source_revision: "publication.source_revision",
  publication_version_number: "publication.version_number",
  publication_workflow_code: "publication.workflow_code",
  publication_workflow_type: "publication.workflow_type",
  publication_authority_level: "publication.authority_level",
  publication_requirement_kind: "publication.requirement_kind",
  publication_data_classification: "publication.data_classification",
  publication_scope_type: "publication.scope_type",
  publication_location_id: "publication.location_id",
  publication_department_id: "publication.department_id",
  publication_snapshot_json: "publication.snapshot_json",
  publication_snapshot_sha256: "publication.snapshot_sha256",
  publication_receipt_sha256: "publication.receipt_sha256",
  publication_published_by: "publication.published_by",
  publication_published_at: "publication.published_at",
  publication_archived_at: "publication_archive.archived_at",
  run_step_run_id: "run_step.run_id",
  run_step_id: "run_step.step_id",
  run_step_sort_order: "run_step.sort_order",
  run_step_status: "run_step.status",
  run_step_activated_at: "run_step.activated_at",
  run_step_completed_at: "run_step.completed_at",
  run_step_completed_by: "run_step.completed_by",
  run_step_completion_note: "run_step.completion_note",
  run_step_completion_request_id: "run_step.completion_request_id",
  workflow_assignment_run_id: "workflow_assignment.run_id",
  workflow_assignment_step_id: "workflow_assignment.step_id",
  workflow_assigned_employee_number: "workflow_assignment.employee_number",
  workflow_responsibility_type: "workflow_assignment.responsibility_type",
  workflow_responsibility_reference: "workflow_assignment.responsibility_reference",
  workflow_assignment_assigned_by: "workflow_assignment.assigned_by",
  workflow_assignment_assigned_at: "workflow_assignment.assigned_at",
  workflow_assignment_receipt_sha256: "workflow_assignment.receipt_sha256",
});

const LIFECYCLE_ONBOARDING_TASK_FROM = `
  FROM personnel_lifecycle_case_assignments lifecycle_assignment
  JOIN personnel_lifecycle_cases lifecycle_case
    ON lifecycle_case.id = lifecycle_assignment.case_id
  JOIN personnel_employment_episodes episode
    ON episode.id = lifecycle_case.employment_episode_id
  JOIN employees subject_employee
    ON subject_employee.personnel_number = episode.employee_number
  LEFT JOIN personnel_lifecycle_case_assignment_bindings assignment_binding
    ON assignment_binding.assignment_id = lifecycle_assignment.id
  LEFT JOIN personnel_lifecycle_case_package_bindings package_binding
    ON package_binding.id = assignment_binding.package_binding_id
  LEFT JOIN personnel_lifecycle_case_package_runs package_run
    ON package_run.package_binding_id = package_binding.id
  LEFT JOIN custom_process_run_bindings workflow_binding
    ON workflow_binding.run_id = package_run.run_id
  LEFT JOIN custom_process_runs run ON run.id = package_run.run_id
  LEFT JOIN custom_process_publications publication
    ON publication.id = package_binding.publication_id
  LEFT JOIN custom_process_publication_archives publication_archive
    ON publication_archive.publication_id = publication.id
  LEFT JOIN custom_process_run_steps run_step
    ON run_step.run_id = assignment_binding.run_id
    AND run_step.step_id = assignment_binding.step_reference
  LEFT JOIN custom_process_run_step_assignments workflow_assignment
    ON workflow_assignment.run_id = assignment_binding.run_id
    AND workflow_assignment.step_id = assignment_binding.step_reference
`;

const LIFECYCLE_OFFBOARDING_OPERATION_FIELDS = Object.freeze({
  operation_id: "operation.operation_id",
  case_id: "operation.case_id",
  operation_type: "operation.operation_type",
  subject_key: "operation.subject_key",
  request_sha256: "operation.request_sha256",
  plan_receipt_sha256: "operation.plan_receipt_sha256",
  protected_result_payload: "operation.protected_result_payload",
  result_receipt_sha256: "operation.result_receipt_sha256",
  actor_id: "operation.actor_id",
  occurred_at: "operation.occurred_at",
  employee_number: `(SELECT episode.employee_number
    FROM personnel_lifecycle_cases lifecycle_case
    JOIN personnel_employment_episodes episode
      ON episode.id = lifecycle_case.employment_episode_id
    WHERE lifecycle_case.id = operation.case_id)`,
});

const LIFECYCLE_OFFBOARDING_CASE_FIELDS = Object.freeze({
  id: "lifecycle_case.id",
  episode_id: "episode.id",
  case_type: "lifecycle_case.case_type",
  employment_episode_id: "COALESCE(lifecycle_case.employment_episode_id, episode.id)",
  employee_number: "episode.employee_number",
  episode_sequence_number: "episode.sequence_number",
  episode_state: "episode.state",
  episode_revision: "episode.revision",
  predecessor_case_id: "lifecycle_case.predecessor_case_id",
  state: "lifecycle_case.state",
  responsible_actor_id: "lifecycle_case.responsible_actor_id",
  scope_type: "lifecycle_case.scope_type",
  location_id: "lifecycle_case.location_id",
  department_id: "lifecycle_case.department_id",
  scope_snapshot_sha256: "lifecycle_case.scope_snapshot_sha256",
  protected_payload: "lifecycle_case.protected_payload",
  protected_plan_payload: "lifecycle_case.protected_payload",
  plan_receipt_sha256: `(SELECT preparation.plan_receipt_sha256
    FROM personnel_lifecycle_offboarding_operations preparation
    WHERE preparation.case_id = lifecycle_case.id
      AND preparation.operation_type = 'prepare'
    LIMIT 1)`,
  revision: "lifecycle_case.revision",
  created_by: "lifecycle_case.created_by",
  created_at: "lifecycle_case.created_at",
  updated_by: "lifecycle_case.updated_by",
  updated_at: "lifecycle_case.updated_at",
});

const LIFECYCLE_OFFBOARDING_VERSION_FIELDS = Object.freeze({
  id: "version.id",
  series_id: "version.series_id",
  runtime_process_id: "version.runtime_process_id",
  version_number: "version.version_number",
  predecessor_version_id: "version.predecessor_version_id",
  family_code: "version.family_code",
  path_kind: "version.path_kind",
  requirement_kind: "version.requirement_kind",
  scope_type: "version.scope_type",
  location_id: "version.location_id",
  department_id: "version.department_id",
  data_classification: "version.data_classification",
  protected_snapshot: "version.protected_snapshot",
  snapshot_sha256: "version.snapshot_sha256",
  runtime_manifest_sha256: "version.runtime_manifest_sha256",
  receipt_sha256: "version.receipt_sha256",
  published_by: "version.published_by",
  published_at: "version.published_at",
  archived_at: "archive.archived_at",
  archive_reason_code: "archive.reason_code",
});

const LIFECYCLE_OFFBOARDING_TASK_FIELDS = Object.freeze({
  case_id: "lifecycle_case.id",
  case_type: "lifecycle_case.case_type",
  case_state: "lifecycle_case.state",
  case_revision: "lifecycle_case.revision",
  case_predecessor_id: "lifecycle_case.predecessor_case_id",
  case_created_at: "lifecycle_case.created_at",
  case_updated_at: "lifecycle_case.updated_at",
  case_responsible_actor_id: "lifecycle_case.responsible_actor_id",
  case_scope_type: "lifecycle_case.scope_type",
  case_location_id: "lifecycle_case.location_id",
  case_department_id: "lifecycle_case.department_id",
  case_scope_snapshot_sha256: "lifecycle_case.scope_snapshot_sha256",
  plan_receipt_sha256: `(SELECT preparation.plan_receipt_sha256
    FROM personnel_lifecycle_offboarding_operations preparation
    WHERE preparation.case_id = lifecycle_case.id
      AND preparation.operation_type = 'prepare'
    LIMIT 1)`,
  protected_plan_payload: "lifecycle_case.protected_payload",
  employment_episode_id: "lifecycle_case.employment_episode_id",
  employee_number: "episode.employee_number",
  episode_sequence_number: "episode.sequence_number",
  episode_state: "episode.state",
  episode_revision: "episode.revision",
  assignment_id: "assignment.id",
  assignee_actor_id: "assignment.assignee_actor_id",
  assignment_receipt_sha256: "assignment.receipt_sha256",
  package_binding_id: "package_binding.id",
  package_version_id: "package_binding.package_version_id",
  family_code: "version.family_code",
  run_id: "package_run.run_id",
  run_operation_id: "package_run.run_operation_id",
  run_status: "run.status",
  run_resolved_at: "run.resolved_at",
  runtime_step_reference: "runtime_step.step_reference",
  runtime_order_reference: "runtime_step.order_reference",
  runtime_step_sort_order: "runtime_step.sort_order",
  recipient_class: "runtime_step.recipient_class",
  release_gate: "runtime_step.release_gate",
  data_classification: "runtime_step.data_classification",
  protected_payload: "runtime_step.protected_payload",
  runtime_step_receipt_sha256: "runtime_step.receipt_sha256",
  run_step_status: "run_step.status",
  run_step_activated_at: "run_step.activated_at",
  run_step_completed_at: "run_step.completed_at",
  run_step_completed_by: "run_step.completed_by",
  run_step_completion_request_id: "run_step.completion_request_id",
  termination_operation_id: "termination.operation_id",
});

const LIFECYCLE_OFFBOARDING_TASK_FROM = `
  FROM personnel_lifecycle_offboarding_assignment_bindings assignment_binding
  JOIN personnel_lifecycle_case_assignments assignment
    ON assignment.id = assignment_binding.assignment_id
  JOIN personnel_lifecycle_offboarding_package_bindings package_binding
    ON package_binding.id = assignment_binding.package_binding_id
    AND package_binding.case_id = assignment.case_id
  JOIN personnel_lifecycle_offboarding_package_versions version
    ON version.id = package_binding.package_version_id
  JOIN personnel_lifecycle_offboarding_package_runs package_run
    ON package_run.package_binding_id = package_binding.id
    AND package_run.run_id = assignment_binding.run_id
  JOIN personnel_lifecycle_offboarding_runtime_steps runtime_step
    ON runtime_step.package_binding_id = package_binding.id
    AND runtime_step.run_id = assignment_binding.run_id
    AND runtime_step.step_reference = assignment_binding.step_reference
  JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = assignment.case_id
  JOIN personnel_employment_episodes episode
    ON episode.id = lifecycle_case.employment_episode_id
  JOIN custom_process_runs run ON run.id = package_run.run_id
  JOIN custom_process_run_steps run_step
    ON run_step.run_id = runtime_step.run_id
    AND run_step.step_id = runtime_step.step_reference
  LEFT JOIN personnel_lifecycle_offboarding_run_terminations termination
    ON termination.run_id = package_run.run_id
`;

const LIFECYCLE_EPISODE_FIELDS = Object.freeze({
  id: "episode.id",
  employee_number: "episode.employee_number",
  sequence_number: "episode.sequence_number",
  predecessor_episode_id: "episode.predecessor_episode_id",
  state: "episode.state",
  revision: "episode.revision",
  created_by: "episode.created_by",
  created_at: "episode.created_at",
  updated_by: "episode.updated_by",
  updated_at: "episode.updated_at",
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
    WHERE ${offboardingRuntimeShellExcluded("p.id")}
      AND (
        json_extract($payload, '$.includeArchived') = 1
        OR p.status <> 'archived'
      )
    ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
      p.title COLLATE NOCASE, p.created_at
  `),
  entry(S.processById, `
    SELECT ${jsonObject(PROCESS_FIELDS)}
    ${PROCESS_FROM}
    WHERE p.id = json_extract($payload, '$.id')
      AND ${offboardingRuntimeShellExcluded("p.id")}
      AND (
        json_extract($payload, '$.includeArchived') = 1
        OR p.status <> 'archived'
      )
  `),
  entry(S.listAllSteps, `
    SELECT ${jsonObject(STEP_FIELDS)}
    FROM custom_process_steps s
    WHERE ${offboardingRuntimeShellExcluded("s.process_id")}
    ORDER BY s.process_id, s.sort_order, s.id
  `),
  entry(S.listProcessSteps, `
    SELECT ${jsonObject(STEP_FIELDS)}
    FROM custom_process_steps s
    WHERE s.process_id = json_extract($payload, '$.processId')
      AND ${offboardingRuntimeShellExcluded("s.process_id")}
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
    WHERE ${offboardingRuntimeShellExcluded("publication.process_id")}
      AND (
        json_extract($payload, '$.includeArchived') = 1
        OR archive.publication_id IS NULL
      )
    ORDER BY publication.process_id, publication.version_number
  `),
  entry(S.workflowPublicationById, `
    SELECT ${jsonObject(WORKFLOW_PUBLICATION_FIELDS)}
    FROM custom_process_publications publication
    LEFT JOIN custom_process_publication_archives archive
      ON archive.publication_id = publication.id
    WHERE publication.id = json_extract($payload, '$.publicationId')
      AND ${offboardingRuntimeShellExcluded("publication.process_id")}
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

  entry(S.onboardingOperationById, `
    SELECT ${jsonObject(LIFECYCLE_ONBOARDING_OPERATION_FIELDS)}
    FROM personnel_lifecycle_onboarding_operations operation
    WHERE operation.operation_id = json_extract($payload, '$.operationId')
  `),
  entry(S.onboardingCaseById, `
    SELECT ${jsonObject(LIFECYCLE_ONBOARDING_CASE_FIELDS)}
    FROM personnel_lifecycle_cases lifecycle_case
    JOIN personnel_employment_episodes episode
      ON episode.id = lifecycle_case.employment_episode_id
    WHERE lifecycle_case.id = json_extract($payload, '$.caseId')
      AND lifecycle_case.case_type = 'onboarding'
  `),
  entry(S.currentEpisodeOnboardingCaseForEmployee, `
    SELECT ${jsonObject(LIFECYCLE_ONBOARDING_CASE_FIELDS)}
    FROM personnel_lifecycle_cases lifecycle_case
    JOIN personnel_employment_episodes episode
      ON episode.id = lifecycle_case.employment_episode_id
    WHERE episode.id = (
        SELECT latest_episode.id
        FROM personnel_employment_episodes latest_episode
        WHERE latest_episode.employee_number = json_extract($payload, '$.employeeNumber')
        ORDER BY latest_episode.sequence_number DESC
        LIMIT 1
      )
      AND episode.state <> 'employment_ended'
      AND lifecycle_case.case_type = 'onboarding'
    ORDER BY lifecycle_case.created_at DESC
    LIMIT 1
  `),
  entry(S.employmentEpisodeForEmployee, `
    SELECT ${jsonObject(LIFECYCLE_EPISODE_FIELDS)}
    FROM personnel_employment_episodes episode
    WHERE episode.employee_number = json_extract($payload, '$.employeeNumber')
    ORDER BY episode.sequence_number DESC
    LIMIT 1
  `),
  entry(S.insertEmploymentEpisode, `
    INSERT INTO personnel_employment_episodes (
      id, employee_number, sequence_number, predecessor_episode_id, state,
      protected_payload, revision, created_by, created_at, updated_by, updated_at
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.sequenceNumber'),
      json_extract($payload, '$.predecessorEpisodeId'),
      'employment_active',
      COALESCE(json_extract($payload, '$.protectedPayload'), ''),
      1,
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.occurredAt'),
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.occurredAt')
    )
  `),
  entry(S.insertLifecycleCase, `
    INSERT INTO personnel_lifecycle_cases (
      id, case_type, employment_episode_id, predecessor_case_id, state,
      responsible_actor_id, scope_type, location_id, department_id,
      scope_snapshot_sha256, protected_payload, revision,
      created_by, created_at, updated_by, updated_at
    ) VALUES (
      json_extract($payload, '$.id'),
      'onboarding',
      json_extract($payload, '$.employmentEpisodeId'),
      json_extract($payload, '$.predecessorCaseId'),
      'prepared',
      json_extract($payload, '$.responsibleActorId'),
      json_extract($payload, '$.scopeType'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.departmentId'),
      json_extract($payload, '$.scopeSnapshotSha256'),
      COALESCE(json_extract($payload, '$.protectedPayload'), ''),
      1,
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.occurredAt'),
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.occurredAt')
    )
  `),
  entry(S.transitionLifecycleCase, `
    UPDATE personnel_lifecycle_cases
    SET state = json_extract($payload, '$.toState'),
        revision = revision + 1,
        updated_by = json_extract($payload, '$.actor'),
        updated_at = json_extract($payload, '$.occurredAt')
    WHERE id = json_extract($payload, '$.caseId')
      AND case_type = 'onboarding'
      AND state = json_extract($payload, '$.fromState')
      AND revision = json_extract($payload, '$.expectedRevision')
  `),
  entry(S.insertLifecycleReferenceDates, `
    INSERT INTO personnel_lifecycle_case_reference_dates (
      id, case_id, revision, previous_revision_id, protected_payload,
      receipt_sha256, changed_by, changed_at
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.caseId'),
      json_extract($payload, '$.revision'),
      json_extract($payload, '$.previousRevisionId'),
      json_extract($payload, '$.protectedPayload'),
      json_extract($payload, '$.receiptSha256'),
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.occurredAt')
    )
  `),
  entry(S.insertLifecyclePackageBinding, `
    INSERT INTO personnel_lifecycle_case_package_bindings (
      id, case_id, publication_id, version_number, scope_snapshot_sha256,
      receipt_sha256, bound_by, bound_at
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.caseId'),
      json_extract($payload, '$.publicationId'),
      json_extract($payload, '$.versionNumber'),
      json_extract($payload, '$.scopeSnapshotSha256'),
      json_extract($payload, '$.receiptSha256'),
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.occurredAt')
    )
  `),
  entry(S.insertLifecyclePackageRun, `
    INSERT INTO personnel_lifecycle_case_package_runs (
      package_binding_id, run_id, run_operation_id, family_codes_json,
      lifecycle_review_sha256, scope_snapshot_sha256, receipt_sha256,
      linked_by, linked_at
    ) VALUES (
      json_extract($payload, '$.packageBindingId'),
      json_extract($payload, '$.runId'),
      json_extract($payload, '$.runOperationId'),
      json_extract($payload, '$.familyCodesJson'),
      json_extract($payload, '$.lifecycleReviewSha256'),
      json_extract($payload, '$.scopeSnapshotSha256'),
      json_extract($payload, '$.receiptSha256'),
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.occurredAt')
    )
  `),
  entry(S.insertLifecycleAssignment, `
    INSERT INTO personnel_lifecycle_case_assignments (
      id, case_id, step_reference, assignee_actor_id,
      predecessor_assignment_id, receipt_sha256, assigned_by, assigned_at
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.caseId'),
      json_extract($payload, '$.stepReference'),
      json_extract($payload, '$.assigneeActorId'),
      json_extract($payload, '$.predecessorAssignmentId'),
      json_extract($payload, '$.receiptSha256'),
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.occurredAt')
    )
  `),
  entry(S.insertLifecycleAssignmentBinding, `
    INSERT INTO personnel_lifecycle_case_assignment_bindings (
      assignment_id, package_binding_id, run_id, step_reference,
      receipt_sha256, bound_by, bound_at
    ) VALUES (
      json_extract($payload, '$.assignmentId'),
      json_extract($payload, '$.packageBindingId'),
      json_extract($payload, '$.runId'),
      json_extract($payload, '$.stepReference'),
      json_extract($payload, '$.receiptSha256'),
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.occurredAt')
    )
  `),
  entry(S.lifecycleCaseLastEvent, `
    SELECT ${jsonObject({
      id: "event.id",
      case_id: "event.case_id",
      sequence_number: "event.sequence_number",
      event_type: "event.event_type",
      data_classification: "event.data_classification",
      protected_payload: "event.protected_payload",
      previous_receipt_sha256: "event.previous_receipt_sha256",
      receipt_sha256: "event.receipt_sha256",
      actor_id: "event.actor_id",
      occurred_at: "event.occurred_at",
    })}
    FROM personnel_lifecycle_case_events event
    JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = event.case_id
    WHERE event.case_id = json_extract($payload, '$.caseId')
      AND lifecycle_case.case_type = 'onboarding'
    ORDER BY event.sequence_number DESC
    LIMIT 1
  `),
  entry(S.lifecycleCaseEventById, `
    SELECT ${jsonObject({
      id: "event.id",
      case_id: "event.case_id",
      sequence_number: "event.sequence_number",
      event_type: "event.event_type",
      data_classification: "event.data_classification",
      protected_payload: "event.protected_payload",
      previous_receipt_sha256: "event.previous_receipt_sha256",
      receipt_sha256: "event.receipt_sha256",
      actor_id: "event.actor_id",
      occurred_at: "event.occurred_at",
    })}
    FROM personnel_lifecycle_case_events event
    JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = event.case_id
    WHERE event.id = json_extract($payload, '$.eventId')
      AND lifecycle_case.case_type = 'onboarding'
  `),
  entry(S.insertLifecycleCaseEvent, `
    INSERT INTO personnel_lifecycle_case_events (
      id, case_id, sequence_number, event_type, data_classification,
      protected_payload, previous_receipt_sha256, receipt_sha256,
      actor_id, occurred_at
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.caseId'),
      json_extract($payload, '$.sequenceNumber'),
      json_extract($payload, '$.eventType'),
      json_extract($payload, '$.dataClassification'),
      json_extract($payload, '$.protectedPayload'),
      json_extract($payload, '$.previousReceiptSha256'),
      json_extract($payload, '$.receiptSha256'),
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.occurredAt')
    )
  `),
  entry(S.insertOnboardingOperation, `
    INSERT INTO personnel_lifecycle_onboarding_operations (
      operation_id, case_id, request_sha256, preview_sha256, result_payload,
      result_receipt_sha256, actor_id, occurred_at
    ) VALUES (
      json_extract($payload, '$.operationId'),
      json_extract($payload, '$.caseId'),
      json_extract($payload, '$.requestSha256'),
      json_extract($payload, '$.previewSha256'),
      json_extract($payload, '$.resultPayload'),
      json_extract($payload, '$.resultReceiptSha256'),
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.occurredAt')
    )
  `),
  entry(S.listLifecyclePackageRuns, `
    SELECT ${jsonObject({
      package_binding_id: "package_run.package_binding_id",
      case_id: "binding.case_id",
      publication_id: "binding.publication_id",
      version_number: "binding.version_number",
      run_id: "package_run.run_id",
      run_operation_id: "package_run.run_operation_id",
      family_codes: "json(package_run.family_codes_json)",
      lifecycle_review_sha256: "package_run.lifecycle_review_sha256",
      scope_snapshot_sha256: "package_run.scope_snapshot_sha256",
      receipt_sha256: "package_run.receipt_sha256",
      linked_by: "package_run.linked_by",
      linked_at: "package_run.linked_at",
      run_status: "run.status",
    })}
    FROM personnel_lifecycle_case_package_bindings binding
    JOIN personnel_lifecycle_case_package_runs package_run
      ON package_run.package_binding_id = binding.id
    JOIN custom_process_runs run ON run.id = package_run.run_id
    WHERE binding.case_id = json_extract($payload, '$.caseId')
    ORDER BY binding.id
  `),
  entry(S.listLifecycleAssignments, `
    SELECT ${jsonObject({
      assignment_id: "assignment.id",
      case_id: "assignment.case_id",
      package_binding_id: "assignment_binding.package_binding_id",
      run_id: "assignment_binding.run_id",
      step_reference: "assignment.step_reference",
      assignee_actor_id: "assignment.assignee_actor_id",
      predecessor_assignment_id: "assignment.predecessor_assignment_id",
      assignment_receipt_sha256: "assignment.receipt_sha256",
      binding_receipt_sha256: "assignment_binding.receipt_sha256",
      assigned_by: "assignment.assigned_by",
      assigned_at: "assignment.assigned_at",
    })}
    FROM personnel_lifecycle_case_assignments assignment
    JOIN personnel_lifecycle_case_assignment_bindings assignment_binding
      ON assignment_binding.assignment_id = assignment.id
    WHERE assignment.case_id = json_extract($payload, '$.caseId')
    ORDER BY assignment_binding.package_binding_id, assignment.step_reference
  `),
  entry(S.lifecycleCaseProgress, `
    SELECT ${jsonObject({
      case_id: "lifecycle_case.id",
      state: "lifecycle_case.state",
      package_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_case_package_bindings binding
        WHERE binding.case_id = lifecycle_case.id)`,
      linked_run_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_case_package_bindings binding
        JOIN personnel_lifecycle_case_package_runs package_run
          ON package_run.package_binding_id = binding.id
        WHERE binding.case_id = lifecycle_case.id)`,
      resolved_run_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_case_package_bindings binding
        JOIN personnel_lifecycle_case_package_runs package_run
          ON package_run.package_binding_id = binding.id
        JOIN custom_process_runs run ON run.id = package_run.run_id
        WHERE binding.case_id = lifecycle_case.id AND run.status = 'resolved')`,
      assignment_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_case_assignments assignment
        WHERE assignment.case_id = lifecycle_case.id)`,
      linked_assignment_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_case_assignments assignment
        JOIN personnel_lifecycle_case_assignment_bindings assignment_binding
          ON assignment_binding.assignment_id = assignment.id
        WHERE assignment.case_id = lifecycle_case.id)`,
      total_step_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_case_package_bindings binding
        JOIN personnel_lifecycle_case_package_runs package_run
          ON package_run.package_binding_id = binding.id
        JOIN custom_process_run_steps run_step ON run_step.run_id = package_run.run_id
        WHERE binding.case_id = lifecycle_case.id)`,
      completed_step_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_case_package_bindings binding
        JOIN personnel_lifecycle_case_package_runs package_run
          ON package_run.package_binding_id = binding.id
        JOIN custom_process_run_steps run_step ON run_step.run_id = package_run.run_id
        WHERE binding.case_id = lifecycle_case.id
          AND run_step.status = 'completed')`,
      skipped_step_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_case_package_bindings binding
        JOIN personnel_lifecycle_case_package_runs package_run
          ON package_run.package_binding_id = binding.id
        JOIN custom_process_run_steps run_step ON run_step.run_id = package_run.run_id
        WHERE binding.case_id = lifecycle_case.id
          AND run_step.status = 'skipped')`,
      finished_step_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_case_package_bindings binding
        JOIN personnel_lifecycle_case_package_runs package_run
          ON package_run.package_binding_id = binding.id
        JOIN custom_process_run_steps run_step ON run_step.run_id = package_run.run_id
        WHERE binding.case_id = lifecycle_case.id
          AND run_step.status IN ('completed','skipped'))`,
    })}
    FROM personnel_lifecycle_cases lifecycle_case
    WHERE lifecycle_case.id = json_extract($payload, '$.caseId')
      AND lifecycle_case.case_type = 'onboarding'
  `),
  entry(S.listActiveLifecycleOnboardingTasks, `
    SELECT ${jsonObject(LIFECYCLE_ONBOARDING_TASK_FIELDS)}
    ${LIFECYCLE_ONBOARDING_TASK_FROM}
    WHERE lifecycle_assignment.assignee_actor_id = json_extract($payload, '$.actorId')
      AND lifecycle_case.case_type = 'onboarding'
      AND lifecycle_case.state = 'active'
    ORDER BY lifecycle_case.id, package_binding.id,
      lifecycle_assignment.step_reference, lifecycle_assignment.id
  `),
  entry(S.lifecycleOnboardingTaskContext, `
    SELECT ${jsonObject(LIFECYCLE_ONBOARDING_TASK_FIELDS)}
    ${LIFECYCLE_ONBOARDING_TASK_FROM}
    WHERE lifecycle_assignment.assignee_actor_id = json_extract($payload, '$.actorId')
      AND assignment_binding.run_id = json_extract($payload, '$.runId')
      AND assignment_binding.step_reference = json_extract($payload, '$.stepId')
      AND lifecycle_case.case_type = 'onboarding'
    ORDER BY lifecycle_assignment.id
    LIMIT 1
  `),

  entry(S.offboardingOperationById, `
    SELECT ${jsonObject(LIFECYCLE_OFFBOARDING_OPERATION_FIELDS)}
    FROM personnel_lifecycle_offboarding_operations operation
    WHERE operation.operation_id = json_extract($payload, '$.operationId')
  `),
  entry(S.offboardingCaseById, `
    SELECT ${jsonObject(LIFECYCLE_OFFBOARDING_CASE_FIELDS)}
    FROM personnel_lifecycle_cases lifecycle_case
    JOIN personnel_employment_episodes episode
      ON episode.id = lifecycle_case.employment_episode_id
    WHERE lifecycle_case.id = json_extract($payload, '$.caseId')
      AND lifecycle_case.case_type = 'offboarding'
  `),
  entry(S.currentEpisodeOffboardingCaseForEmployee, `
    SELECT ${jsonObject(LIFECYCLE_OFFBOARDING_CASE_FIELDS)}
    FROM personnel_employment_episodes episode
    LEFT JOIN personnel_lifecycle_cases lifecycle_case
      ON lifecycle_case.employment_episode_id = episode.id
      AND lifecycle_case.case_type = 'offboarding'
      AND lifecycle_case.state IN (
        'internally_prepared','communication_released','employee_informed','active'
      )
    WHERE episode.employee_number = json_extract($payload, '$.employeeNumber')
      AND episode.state IN ('employment_active','exit_in_progress')
    ORDER BY episode.sequence_number DESC, lifecycle_case.created_at DESC
    LIMIT 1
  `),
  entry(S.offboardingEmploymentContextForEmployee, `
    SELECT ${jsonObject({
      employee_number: "employee.personnel_number",
      employee_active: "employee.active",
      location_id: "employee.home_location_id",
      department_id: "employee.preferred_department_id",
      location_active: "location.active",
      department_active: "department.active",
      department_location_id: "department.location_id",
      employment_episode_id: "episode.id",
      episode_id: "episode.id",
      episode_sequence_number: "episode.sequence_number",
      predecessor_episode_id: "episode.predecessor_episode_id",
      episode_state: "episode.state",
      episode_protected_payload: "episode.protected_payload",
      episode_revision: "episode.revision",
      current_case_id: "current_case.id",
      current_case_state: "current_case.state",
      current_case_revision: "current_case.revision",
      latest_terminal_case_id: "terminal_case.id",
      latest_terminal_case_state: "terminal_case.state",
      latest_terminal_case_created_at: "terminal_case.created_at",
    })}
    FROM employees employee
    LEFT JOIN locations location ON location.id = employee.home_location_id
    LEFT JOIN departments department
      ON department.id = employee.preferred_department_id
    LEFT JOIN personnel_employment_episodes episode
      ON episode.id = (
        SELECT latest_episode.id
        FROM personnel_employment_episodes latest_episode
        WHERE latest_episode.employee_number = employee.personnel_number
        ORDER BY latest_episode.sequence_number DESC
        LIMIT 1
      )
    LEFT JOIN personnel_lifecycle_cases current_case
      ON current_case.id = (
        SELECT active_case.id
        FROM personnel_lifecycle_cases active_case
        WHERE active_case.employment_episode_id = episode.id
          AND active_case.case_type = 'offboarding'
          AND active_case.state IN (
            'internally_prepared','communication_released','employee_informed','active'
          )
        ORDER BY active_case.created_at DESC, active_case.id DESC
        LIMIT 1
      )
    LEFT JOIN personnel_lifecycle_cases terminal_case
      ON terminal_case.id = (
        SELECT latest_case.id
        FROM personnel_lifecycle_cases latest_case
        WHERE latest_case.employment_episode_id = episode.id
          AND latest_case.case_type = 'offboarding'
          AND latest_case.state IN ('completed','cancelled')
        ORDER BY latest_case.created_at DESC, latest_case.id DESC
        LIMIT 1
      )
    WHERE employee.personnel_number = json_extract($payload, '$.employeeNumber')
  `),
  entry(S.offboardingLatestReferenceDates, `
    SELECT ${jsonObject({
      id: "reference.id",
      case_id: "reference.case_id",
      revision: "reference.revision",
      previous_revision_id: "reference.previous_revision_id",
      protected_payload: "reference.protected_payload",
      receipt_sha256: "reference.receipt_sha256",
      changed_by: "reference.changed_by",
      changed_at: "reference.changed_at",
    })}
    FROM personnel_lifecycle_case_reference_dates reference
    JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = reference.case_id
    WHERE reference.case_id = json_extract($payload, '$.caseId')
      AND lifecycle_case.case_type = 'offboarding'
    ORDER BY reference.revision DESC
    LIMIT 1
  `),
  entry(S.offboardingCaseEventById, `
    SELECT ${jsonObject({
      id: "event.id",
      case_id: "event.case_id",
      sequence_number: "event.sequence_number",
      event_type: "event.event_type",
      data_classification: "event.data_classification",
      protected_payload: "event.protected_payload",
      previous_receipt_sha256: "event.previous_receipt_sha256",
      receipt_sha256: "event.receipt_sha256",
      actor_id: "event.actor_id",
      occurred_at: "event.occurred_at",
    })}
    FROM personnel_lifecycle_case_events event
    JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = event.case_id
    WHERE event.id = json_extract($payload, '$.eventId')
      AND lifecycle_case.case_type = 'offboarding'
  `),
  entry(S.offboardingCaseLastEvent, `
    SELECT ${jsonObject({
      id: "event.id",
      case_id: "event.case_id",
      sequence_number: "event.sequence_number",
      event_type: "event.event_type",
      data_classification: "event.data_classification",
      protected_payload: "event.protected_payload",
      previous_receipt_sha256: "event.previous_receipt_sha256",
      receipt_sha256: "event.receipt_sha256",
      actor_id: "event.actor_id",
      occurred_at: "event.occurred_at",
    })}
    FROM personnel_lifecycle_case_events event
    JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = event.case_id
    WHERE event.case_id = json_extract($payload, '$.caseId')
      AND lifecycle_case.case_type = 'offboarding'
    ORDER BY event.sequence_number DESC
    LIMIT 1
  `),
  entry(S.offboardingConfidentialAccessLastEvent, `
    SELECT ${jsonObject({
      id: "access_event.id",
      case_id: "access_event.case_id",
      sequence_number: "access_event.sequence_number",
      actor_id: "access_event.actor_id",
      action: "access_event.action",
      occurred_at: "access_event.occurred_at",
      result: "access_event.result",
      purpose_code: "access_event.purpose_code",
      previous_receipt_sha256: "access_event.previous_receipt_sha256",
      receipt_sha256: "access_event.receipt_sha256",
    })}
    FROM personnel_lifecycle_confidential_access_events access_event
    JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = access_event.case_id
    WHERE access_event.case_id = json_extract($payload, '$.caseId')
      AND lifecycle_case.case_type = 'offboarding'
    ORDER BY access_event.sequence_number DESC
    LIMIT 1
  `),
  entry(S.listOffboardingConfidentialAccessEvents, `
    SELECT ${jsonObject({
      id: "access_event.id",
      case_id: "access_event.case_id",
      sequence_number: "access_event.sequence_number",
      actor_id: "access_event.actor_id",
      action: "access_event.action",
      occurred_at: "access_event.occurred_at",
      result: "access_event.result",
      purpose_code: "access_event.purpose_code",
      previous_receipt_sha256: "access_event.previous_receipt_sha256",
      receipt_sha256: "access_event.receipt_sha256",
    })}
    FROM personnel_lifecycle_confidential_access_events access_event
    JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = access_event.case_id
    WHERE access_event.case_id = json_extract($payload, '$.caseId')
      AND lifecycle_case.case_type = 'offboarding'
    ORDER BY access_event.sequence_number, access_event.id
  `),
  entry(S.offboardingRuntimeProcessShellById, `
    SELECT ${jsonObject({
      id: "process.id",
      title: "process.title",
      symbol: "process.symbol",
      description: "process.description",
      category: "process.category",
      scope_type: "process.scope_type",
      location_id: "process.location_id",
      department_id: "process.department_id",
      trigger_type: "process.trigger_type",
      trigger_minimum_shortfall: "process.trigger_minimum_shortfall",
      status: "process.status",
      revision: "process.revision",
      created_by: "process.created_by",
      updated_by: "process.updated_by",
      archived_at: "process.archived_at",
    })}
    FROM custom_processes process
    WHERE process.id = json_extract($payload, '$.runtimeProcessId')
  `),
  entry(S.offboardingPackageVersionById, `
    SELECT ${jsonObject(LIFECYCLE_OFFBOARDING_VERSION_FIELDS)}
    FROM personnel_lifecycle_offboarding_package_versions version
    LEFT JOIN personnel_lifecycle_offboarding_package_version_archives archive
      ON archive.package_version_id = version.id
    WHERE version.id = json_extract($payload, '$.packageVersionId')
  `),
  entry(S.listApplicableOffboardingPackageVersions, `
    SELECT ${jsonObject(LIFECYCLE_OFFBOARDING_VERSION_FIELDS)}
    FROM personnel_lifecycle_offboarding_package_versions version
    LEFT JOIN personnel_lifecycle_offboarding_package_version_archives archive
      ON archive.package_version_id = version.id
    WHERE archive.package_version_id IS NULL
      AND (
        json_extract($payload, '$.familyCode') IS NULL
        OR version.family_code = json_extract($payload, '$.familyCode')
      )
      AND (
        json_extract($payload, '$.pathKind') IS NULL
        OR version.path_kind = 'both'
        OR version.path_kind = json_extract($payload, '$.pathKind')
      )
      AND (
        version.scope_type = 'company'
        OR (version.scope_type = 'location'
          AND version.location_id = json_extract($payload, '$.locationId'))
        OR (version.scope_type = 'department'
          AND version.location_id = json_extract($payload, '$.locationId')
          AND version.department_id = json_extract($payload, '$.departmentId'))
      )
    ORDER BY version.family_code,
      CASE version.scope_type WHEN 'department' THEN 0 WHEN 'location' THEN 1 ELSE 2 END,
      version.version_number DESC, version.id
  `),
  entry(S.listOffboardingPackageRuns, `
    SELECT ${jsonObject({
      package_binding_id: "binding.id",
      case_id: "binding.case_id",
      package_version_id: "binding.package_version_id",
      family_code: "version.family_code",
      version_number: "binding.version_number",
      binding_scope_snapshot_sha256: "binding.scope_snapshot_sha256",
      binding_receipt_sha256: "binding.receipt_sha256",
      run_id: "package_run.run_id",
      run_operation_id: "package_run.run_operation_id",
      runtime_manifest_sha256: "package_run.runtime_manifest_sha256",
      run_scope_snapshot_sha256: "package_run.scope_snapshot_sha256",
      run_receipt_sha256: "package_run.receipt_sha256",
      run_status: "run.status",
      run_resolved_at: "run.resolved_at",
      termination_operation_id: "termination.operation_id",
    })}
    FROM personnel_lifecycle_offboarding_package_bindings binding
    JOIN personnel_lifecycle_offboarding_package_versions version
      ON version.id = binding.package_version_id
    LEFT JOIN personnel_lifecycle_offboarding_package_runs package_run
      ON package_run.package_binding_id = binding.id
    LEFT JOIN custom_process_runs run ON run.id = package_run.run_id
    LEFT JOIN personnel_lifecycle_offboarding_run_terminations termination
      ON termination.run_id = package_run.run_id
    WHERE binding.case_id = json_extract($payload, '$.caseId')
    ORDER BY version.family_code, binding.id
  `),
  entry(S.listOffboardingAssignments, `
    SELECT ${jsonObject(LIFECYCLE_OFFBOARDING_TASK_FIELDS)}
    ${LIFECYCLE_OFFBOARDING_TASK_FROM}
    WHERE lifecycle_case.id = json_extract($payload, '$.caseId')
      AND lifecycle_case.case_type = 'offboarding'
    ORDER BY runtime_step.sort_order, runtime_step.step_reference, assignment.id
  `),
  entry(S.offboardingCaseProjection, `
    SELECT ${jsonObject({
      ...LIFECYCLE_OFFBOARDING_CASE_FIELDS,
      reference_id: `(SELECT reference.id
        FROM personnel_lifecycle_case_reference_dates reference
        WHERE reference.case_id = lifecycle_case.id
        ORDER BY reference.revision DESC LIMIT 1)`,
      reference_revision: `(SELECT reference.revision
        FROM personnel_lifecycle_case_reference_dates reference
        WHERE reference.case_id = lifecycle_case.id
        ORDER BY reference.revision DESC LIMIT 1)`,
      reference_protected_payload: `(SELECT reference.protected_payload
        FROM personnel_lifecycle_case_reference_dates reference
        WHERE reference.case_id = lifecycle_case.id
        ORDER BY reference.revision DESC LIMIT 1)`,
      last_event_id: `(SELECT event.id FROM personnel_lifecycle_case_events event
        WHERE event.case_id = lifecycle_case.id
        ORDER BY event.sequence_number DESC LIMIT 1)`,
      last_event_type: `(SELECT event.event_type FROM personnel_lifecycle_case_events event
        WHERE event.case_id = lifecycle_case.id
        ORDER BY event.sequence_number DESC LIMIT 1)`,
      last_event_protected_payload: `(SELECT event.protected_payload
        FROM personnel_lifecycle_case_events event
        WHERE event.case_id = lifecycle_case.id
        ORDER BY event.sequence_number DESC LIMIT 1)`,
    })}
    FROM personnel_lifecycle_cases lifecycle_case
    JOIN personnel_employment_episodes episode
      ON episode.id = lifecycle_case.employment_episode_id
    WHERE lifecycle_case.id = json_extract($payload, '$.caseId')
      AND lifecycle_case.case_type = 'offboarding'
  `),
  entry(S.offboardingCaseProgress, `
    SELECT ${jsonObject({
      case_id: "lifecycle_case.id",
      state: "lifecycle_case.state",
      package_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_offboarding_package_bindings binding
        WHERE binding.case_id = lifecycle_case.id)`,
      linked_run_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_offboarding_package_bindings binding
        JOIN personnel_lifecycle_offboarding_package_runs package_run
          ON package_run.package_binding_id = binding.id
        WHERE binding.case_id = lifecycle_case.id)`,
      resolved_run_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_offboarding_package_bindings binding
        JOIN personnel_lifecycle_offboarding_package_runs package_run
          ON package_run.package_binding_id = binding.id
        JOIN custom_process_runs run ON run.id = package_run.run_id
        WHERE binding.case_id = lifecycle_case.id AND run.status = 'resolved')`,
      total_step_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_offboarding_package_bindings binding
        JOIN personnel_lifecycle_offboarding_package_runs package_run
          ON package_run.package_binding_id = binding.id
        JOIN custom_process_run_steps run_step ON run_step.run_id = package_run.run_id
        WHERE binding.case_id = lifecycle_case.id)`,
      pending_step_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_offboarding_package_bindings binding
        JOIN personnel_lifecycle_offboarding_package_runs package_run
          ON package_run.package_binding_id = binding.id
        JOIN custom_process_run_steps run_step ON run_step.run_id = package_run.run_id
        WHERE binding.case_id = lifecycle_case.id AND run_step.status = 'pending')`,
      active_step_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_offboarding_package_bindings binding
        JOIN personnel_lifecycle_offboarding_package_runs package_run
          ON package_run.package_binding_id = binding.id
        JOIN custom_process_run_steps run_step ON run_step.run_id = package_run.run_id
        WHERE binding.case_id = lifecycle_case.id AND run_step.status = 'active')`,
      completed_step_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_offboarding_package_bindings binding
        JOIN personnel_lifecycle_offboarding_package_runs package_run
          ON package_run.package_binding_id = binding.id
        JOIN custom_process_run_steps run_step ON run_step.run_id = package_run.run_id
        WHERE binding.case_id = lifecycle_case.id AND run_step.status = 'completed')`,
      skipped_step_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_offboarding_package_bindings binding
        JOIN personnel_lifecycle_offboarding_package_runs package_run
          ON package_run.package_binding_id = binding.id
        JOIN custom_process_run_steps run_step ON run_step.run_id = package_run.run_id
        WHERE binding.case_id = lifecycle_case.id AND run_step.status = 'skipped')`,
      assignment_count: `(SELECT COUNT(*) FROM personnel_lifecycle_case_assignments assignment
        WHERE assignment.case_id = lifecycle_case.id)`,
      linked_assignment_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_case_assignments assignment
        JOIN personnel_lifecycle_offboarding_assignment_bindings assignment_binding
          ON assignment_binding.assignment_id = assignment.id
        WHERE assignment.case_id = lifecycle_case.id)`,
      termination_count: `(SELECT COUNT(*)
        FROM personnel_lifecycle_offboarding_run_terminations termination
        WHERE termination.case_id = lifecycle_case.id)`,
    })}
    FROM personnel_lifecycle_cases lifecycle_case
    WHERE lifecycle_case.id = json_extract($payload, '$.caseId')
      AND lifecycle_case.case_type = 'offboarding'
  `),
  entry(S.offboardingTimeCriticalApprovalStatus, `
    SELECT ${jsonObject({
      case_id: "lifecycle_case.id",
      case_state: "lifecycle_case.state",
      protected_payload: "lifecycle_case.protected_payload",
      approved: "CASE WHEN approval.operation_id IS NULL THEN 0 ELSE 1 END",
      approval_operation_id: "approval.operation_id",
      approval_request_sha256: "approval.request_sha256",
      approval_plan_receipt_sha256: "approval.plan_receipt_sha256",
      approval_actor_id: "approval.actor_id",
      approved_at: "approval.occurred_at",
      last_event_type: `(SELECT event.event_type FROM personnel_lifecycle_case_events event
        WHERE event.case_id = lifecycle_case.id
        ORDER BY event.sequence_number DESC LIMIT 1)`,
      last_event_protected_payload: `(SELECT event.protected_payload
        FROM personnel_lifecycle_case_events event
        WHERE event.case_id = lifecycle_case.id
        ORDER BY event.sequence_number DESC LIMIT 1)`,
    })}
    FROM personnel_lifecycle_cases lifecycle_case
    LEFT JOIN personnel_lifecycle_offboarding_operations approval
      ON approval.case_id = lifecycle_case.id
      AND approval.operation_type = 'time_critical_approval'
    WHERE lifecycle_case.id = json_extract($payload, '$.caseId')
      AND lifecycle_case.case_type = 'offboarding'
  `),
  entry(S.listActiveLifecycleOffboardingTasks, `
    SELECT ${jsonObject(LIFECYCLE_OFFBOARDING_TASK_FIELDS)}
    ${LIFECYCLE_OFFBOARDING_TASK_FROM}
    WHERE assignment.assignee_actor_id = json_extract($payload, '$.actorId')
      AND lifecycle_case.case_type = 'offboarding'
      AND lifecycle_case.state IN ('communication_released','employee_informed','active')
      AND run.status = 'open'
      AND run_step.status IN ('pending','active')
      AND termination.run_id IS NULL
    ORDER BY lifecycle_case.id, runtime_step.sort_order, runtime_step.step_reference
  `),
  entry(S.lifecycleOffboardingTaskContext, `
    SELECT ${jsonObject(LIFECYCLE_OFFBOARDING_TASK_FIELDS)}
    ${LIFECYCLE_OFFBOARDING_TASK_FROM}
    WHERE assignment.assignee_actor_id = json_extract($payload, '$.actorId')
      AND assignment_binding.run_id = json_extract($payload, '$.runId')
      AND assignment_binding.step_reference = json_extract($payload, '$.stepId')
      AND lifecycle_case.case_type = 'offboarding'
      AND lifecycle_case.state IN ('communication_released','employee_informed','active')
      AND (
        (run.status = 'open' AND run_step.status IN ('pending','active'))
        OR (run.status = 'resolved' AND run_step.status = 'completed')
      )
      AND termination.run_id IS NULL
    LIMIT 1
  `),
  entry(S.offboardingRunTerminationByRunId, `
    SELECT ${jsonObject({
      run_id: "termination.run_id",
      case_id: "termination.case_id",
      operation_id: "termination.operation_id",
      reason_code: "termination.reason_code",
      protected_payload: "termination.protected_payload",
      receipt_sha256: "termination.receipt_sha256",
      terminated_by: "termination.terminated_by",
      terminated_at: "termination.terminated_at",
    })}
    FROM personnel_lifecycle_offboarding_run_terminations termination
    WHERE termination.run_id = json_extract($payload, '$.runId')
  `),

  entry(S.insertOffboardingRuntimeProcessShell, `
    INSERT OR IGNORE INTO custom_processes (
      id, title, symbol, description, category, scope_type, location_id,
      department_id, trigger_type, trigger_minimum_shortfall, status, revision,
      created_by, updated_by
    )
    VALUES (
      json_extract($payload, '$.runtimeProcessId'),
      'Geschützter Personalprozess', 'P', '', 'other', 'company', NULL,
      NULL, 'manual', 1, 'active', json_extract($payload, '$.versionNumber'),
      json_extract($payload, '$.actor'), json_extract($payload, '$.actor')
    )
  `),
  entry(S.insertOffboardingPackageVersion, `
    INSERT OR IGNORE INTO personnel_lifecycle_offboarding_package_versions (
      id, series_id, runtime_process_id, version_number, predecessor_version_id,
      family_code, path_kind, requirement_kind, scope_type, location_id,
      department_id, data_classification, protected_snapshot, snapshot_sha256,
      runtime_manifest_sha256, receipt_sha256, published_by, published_at
    ) VALUES (
      json_extract($payload, '$.id'), json_extract($payload, '$.seriesId'),
      json_extract($payload, '$.runtimeProcessId'),
      json_extract($payload, '$.versionNumber'),
      json_extract($payload, '$.predecessorVersionId'),
      json_extract($payload, '$.familyCode'), json_extract($payload, '$.pathKind'),
      json_extract($payload, '$.requirementKind'), json_extract($payload, '$.scopeType'),
      json_extract($payload, '$.locationId'), json_extract($payload, '$.departmentId'),
      'offboarding_strict_confidential', json_extract($payload, '$.protectedSnapshot'),
      json_extract($payload, '$.snapshotSha256'),
      json_extract($payload, '$.runtimeManifestSha256'),
      json_extract($payload, '$.receiptSha256'), json_extract($payload, '$.publishedBy'),
      json_extract($payload, '$.publishedAt')
    )
  `),
  entry(S.insertOffboardingPackageVersionArchive, `
    INSERT INTO personnel_lifecycle_offboarding_package_version_archives (
      package_version_id, reason_code, protected_payload, receipt_sha256,
      archived_by, archived_at
    ) VALUES (
      json_extract($payload, '$.packageVersionId'), json_extract($payload, '$.reasonCode'),
      json_extract($payload, '$.protectedPayload'), json_extract($payload, '$.receiptSha256'),
      json_extract($payload, '$.archivedBy'), json_extract($payload, '$.archivedAt')
    )
  `),
  entry(S.insertOffboardingLifecycleCase, `
    INSERT INTO personnel_lifecycle_cases (
      id, case_type, employment_episode_id, predecessor_case_id, state,
      responsible_actor_id, scope_type, location_id, department_id,
      scope_snapshot_sha256, protected_payload, revision,
      created_by, created_at, updated_by, updated_at
    ) VALUES (
      json_extract($payload, '$.id'), 'offboarding',
      json_extract($payload, '$.employmentEpisodeId'),
      json_extract($payload, '$.predecessorCaseId'), 'internally_prepared',
      json_extract($payload, '$.responsibleActorId'), json_extract($payload, '$.scopeType'),
      json_extract($payload, '$.locationId'), json_extract($payload, '$.departmentId'),
      json_extract($payload, '$.scopeSnapshotSha256'),
      json_extract($payload, '$.protectedPayload'), 1,
      json_extract($payload, '$.actor'), json_extract($payload, '$.occurredAt'),
      json_extract($payload, '$.actor'), json_extract($payload, '$.occurredAt')
    )
  `),
  entry(S.insertOffboardingEmploymentEpisode, `
    INSERT INTO personnel_employment_episodes (
      id, employee_number, sequence_number, predecessor_episode_id, state,
      protected_payload, revision, created_by, created_at, updated_by, updated_at
    ) VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.employeeNumber'),
      json_extract($payload, '$.sequenceNumber'),
      json_extract($payload, '$.predecessorEpisodeId'),
      'employment_active',
      json_extract($payload, '$.protectedPayload'),
      1,
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.occurredAt'),
      json_extract($payload, '$.actor'),
      json_extract($payload, '$.occurredAt')
    )
  `),
  entry(S.transitionOffboardingLifecycleCase, `
    UPDATE personnel_lifecycle_cases
    SET state = json_extract($payload, '$.toState'),
        revision = revision + 1,
        updated_by = json_extract($payload, '$.actor'),
        updated_at = json_extract($payload, '$.occurredAt')
    WHERE id = json_extract($payload, '$.caseId')
      AND case_type = 'offboarding'
      AND state = json_extract($payload, '$.fromState')
      AND revision = json_extract($payload, '$.expectedRevision')
  `),
  entry(S.transitionOffboardingEmploymentEpisode, `
    UPDATE personnel_employment_episodes
    SET state = json_extract($payload, '$.toState'),
        revision = revision + 1,
        updated_by = json_extract($payload, '$.actor'),
        updated_at = json_extract($payload, '$.occurredAt')
    WHERE id = json_extract($payload, '$.episodeId')
      AND state = json_extract($payload, '$.fromState')
      AND revision = json_extract($payload, '$.expectedRevision')
  `),
  entry(S.insertOffboardingReferenceDates, `
    INSERT INTO personnel_lifecycle_case_reference_dates (
      id, case_id, revision, previous_revision_id, protected_payload,
      receipt_sha256, changed_by, changed_at
    ) VALUES (
      json_extract($payload, '$.id'), json_extract($payload, '$.caseId'),
      json_extract($payload, '$.revision'),
      COALESCE(
        json_extract($payload, '$.previousRevisionId'),
        json_extract($payload, '$.previousReferenceId')
      ),
      json_extract($payload, '$.protectedPayload'), json_extract($payload, '$.receiptSha256'),
      COALESCE(json_extract($payload, '$.changedBy'), json_extract($payload, '$.actor')),
      COALESCE(json_extract($payload, '$.changedAt'), json_extract($payload, '$.occurredAt'))
    )
  `),
  entry(S.insertOffboardingLifecycleCaseEvent, `
    INSERT INTO personnel_lifecycle_case_events (
      id, case_id, sequence_number, event_type, data_classification,
      protected_payload, previous_receipt_sha256, receipt_sha256, actor_id, occurred_at
    ) VALUES (
      json_extract($payload, '$.id'), json_extract($payload, '$.caseId'),
      json_extract($payload, '$.sequenceNumber'), json_extract($payload, '$.eventType'),
      'offboarding_strict_confidential', json_extract($payload, '$.protectedPayload'),
      COALESCE(json_extract($payload, '$.previousReceiptSha256'), ''),
      json_extract($payload, '$.receiptSha256'),
      COALESCE(json_extract($payload, '$.actor'), json_extract($payload, '$.actorId')),
      json_extract($payload, '$.occurredAt')
    )
  `),
  entry(S.insertOffboardingConfidentialAccessEvent, `
    INSERT INTO personnel_lifecycle_confidential_access_events (
      id, case_id, sequence_number, actor_id, action, occurred_at, result,
      purpose_code, previous_receipt_sha256, receipt_sha256
    ) VALUES (
      json_extract($payload, '$.id'), json_extract($payload, '$.caseId'),
      json_extract($payload, '$.sequenceNumber'),
      COALESCE(json_extract($payload, '$.actorId'), json_extract($payload, '$.actor')),
      json_extract($payload, '$.action'), json_extract($payload, '$.occurredAt'),
      json_extract($payload, '$.result'), json_extract($payload, '$.purposeCode'),
      COALESCE(json_extract($payload, '$.previousReceiptSha256'), ''),
      json_extract($payload, '$.receiptSha256')
    )
  `),
  entry(S.insertOffboardingPackageBinding, `
    INSERT INTO personnel_lifecycle_offboarding_package_bindings (
      id, case_id, package_version_id, version_number, scope_snapshot_sha256,
      receipt_sha256, bound_by, bound_at
    ) VALUES (
      json_extract($payload, '$.id'), json_extract($payload, '$.caseId'),
      json_extract($payload, '$.packageVersionId'), json_extract($payload, '$.versionNumber'),
      json_extract($payload, '$.scopeSnapshotSha256'),
      json_extract($payload, '$.receiptSha256'), json_extract($payload, '$.boundBy'),
      json_extract($payload, '$.boundAt')
    )
  `),
  entry(S.insertOffboardingRun, `
    INSERT INTO custom_process_runs (
      id, process_id, process_revision, trigger_type, trigger_key,
      location_id, department_id, triggered_by, activation_count
    ) VALUES (
      json_extract($payload, '$.id'), json_extract($payload, '$.runtimeProcessId'),
      json_extract($payload, '$.versionNumber'), 'personnel_lifecycle_offboarding',
      'personnel-offboarding:' || json_extract($payload, '$.runOperationId'),
      json_extract($payload, '$.locationId'), json_extract($payload, '$.departmentId'),
      json_extract($payload, '$.triggeredBy'), 1
    )
  `),
  entry(S.insertOffboardingPackageRun, `
    INSERT INTO personnel_lifecycle_offboarding_package_runs (
      package_binding_id, run_id, run_operation_id, runtime_manifest_sha256,
      scope_snapshot_sha256, receipt_sha256, linked_by, linked_at
    ) VALUES (
      json_extract($payload, '$.packageBindingId'), json_extract($payload, '$.runId'),
      json_extract($payload, '$.runOperationId'),
      json_extract($payload, '$.runtimeManifestSha256'),
      json_extract($payload, '$.scopeSnapshotSha256'),
      json_extract($payload, '$.receiptSha256'), json_extract($payload, '$.linkedBy'),
      json_extract($payload, '$.linkedAt')
    )
  `),
  entry(S.insertOffboardingRuntimeStep, `
    INSERT INTO personnel_lifecycle_offboarding_runtime_steps (
      package_binding_id, run_id, step_reference, order_reference, sort_order,
      recipient_class, release_gate, data_classification, protected_payload,
      receipt_sha256, created_by, created_at
    ) VALUES (
      json_extract($payload, '$.packageBindingId'), json_extract($payload, '$.runId'),
      json_extract($payload, '$.stepReference'), json_extract($payload, '$.orderReference'),
      json_extract($payload, '$.sortOrder'), json_extract($payload, '$.recipientClass'),
      json_extract($payload, '$.releaseGate'), json_extract($payload, '$.dataClassification'),
      json_extract($payload, '$.protectedPayload'), json_extract($payload, '$.receiptSha256'),
      json_extract($payload, '$.createdBy'), json_extract($payload, '$.createdAt')
    )
  `),
  entry(S.insertOffboardingRunStep, `
    INSERT INTO custom_process_run_steps (run_id, step_id, sort_order)
    VALUES (
      json_extract($payload, '$.runId'), json_extract($payload, '$.stepId'),
      json_extract($payload, '$.sortOrder')
    )
  `),
  entry(S.insertOffboardingAssignment, `
    INSERT INTO personnel_lifecycle_case_assignments (
      id, case_id, step_reference, assignee_actor_id, predecessor_assignment_id,
      receipt_sha256, assigned_by, assigned_at
    ) VALUES (
      json_extract($payload, '$.id'), json_extract($payload, '$.caseId'),
      json_extract($payload, '$.stepReference'), json_extract($payload, '$.assigneeActorId'),
      json_extract($payload, '$.predecessorAssignmentId'),
      json_extract($payload, '$.receiptSha256'), json_extract($payload, '$.assignedBy'),
      json_extract($payload, '$.assignedAt')
    )
  `),
  entry(S.insertOffboardingAssignmentBinding, `
    INSERT INTO personnel_lifecycle_offboarding_assignment_bindings (
      assignment_id, package_binding_id, run_id, step_reference,
      receipt_sha256, bound_by, bound_at
    ) VALUES (
      json_extract($payload, '$.assignmentId'), json_extract($payload, '$.packageBindingId'),
      json_extract($payload, '$.runId'), json_extract($payload, '$.stepReference'),
      json_extract($payload, '$.receiptSha256'), json_extract($payload, '$.boundBy'),
      json_extract($payload, '$.boundAt')
    )
  `),
  entry(S.insertOffboardingOperation, `
    INSERT INTO personnel_lifecycle_offboarding_operations (
      operation_id, case_id, operation_type, subject_key, request_sha256,
      plan_receipt_sha256, protected_result_payload, result_receipt_sha256,
      actor_id, occurred_at
    ) VALUES (
      json_extract($payload, '$.operationId'), json_extract($payload, '$.caseId'),
      json_extract($payload, '$.operationType'),
      COALESCE(json_extract($payload, '$.subjectKey'), ''),
      json_extract($payload, '$.requestSha256'), json_extract($payload, '$.planReceiptSha256'),
      json_extract($payload, '$.protectedResultPayload'),
      json_extract($payload, '$.resultReceiptSha256'), json_extract($payload, '$.actorId'),
      json_extract($payload, '$.occurredAt')
    )
  `),
  entry(S.completeOffboardingRunStep, `
    UPDATE custom_process_run_steps
    SET status = 'completed',
        completed_at = json_extract($payload, '$.completedAt'),
        completed_by = json_extract($payload, '$.actorId'),
        completion_note = '',
        completion_request_id = json_extract($payload, '$.completionRequestSha256'),
        updated_at = json_extract($payload, '$.completedAt')
    WHERE run_id = json_extract($payload, '$.runId')
      AND step_id = json_extract($payload, '$.stepId')
      AND status = 'active'
      AND EXISTS (
        SELECT 1
        ${LIFECYCLE_OFFBOARDING_TASK_FROM}
        WHERE assignment_binding.run_id = custom_process_run_steps.run_id
          AND assignment_binding.step_reference = custom_process_run_steps.step_id
          AND assignment.assignee_actor_id = json_extract($payload, '$.actorId')
          AND lifecycle_case.case_type = 'offboarding'
          AND lifecycle_case.state = 'active'
          AND termination.run_id IS NULL
      )
  `),
  entry(S.activateNextOffboardingRunStep, `
    UPDATE custom_process_run_steps
    SET status = 'active',
        activated_at = json_extract($payload, '$.activatedAt'),
        updated_at = json_extract($payload, '$.activatedAt')
    WHERE run_id = json_extract($payload, '$.runId')
      AND step_id = json_extract($payload, '$.stepId')
      AND status = 'pending'
      AND EXISTS (
        SELECT 1
        FROM personnel_lifecycle_offboarding_package_runs package_run
        JOIN personnel_lifecycle_offboarding_package_bindings binding
          ON binding.id = package_run.package_binding_id
        JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = binding.case_id
        WHERE package_run.run_id = custom_process_run_steps.run_id
          AND lifecycle_case.case_type = 'offboarding'
          AND lifecycle_case.state = 'active'
      )
      AND NOT EXISTS (
        SELECT 1 FROM custom_process_run_steps active_step
        WHERE active_step.run_id = custom_process_run_steps.run_id
          AND active_step.status = 'active'
      )
      AND NOT EXISTS (
        SELECT 1 FROM custom_process_run_steps prior_step
        WHERE prior_step.run_id = custom_process_run_steps.run_id
          AND prior_step.sort_order < custom_process_run_steps.sort_order
          AND prior_step.status <> 'completed'
      )
  `),
  entry(S.resolveOffboardingRun, `
    UPDATE custom_process_runs
    SET status = 'resolved', resolved_at = json_extract($payload, '$.resolvedAt'),
        updated_at = json_extract($payload, '$.resolvedAt')
    WHERE id = json_extract($payload, '$.runId')
      AND status = 'open'
      AND EXISTS (
        SELECT 1 FROM personnel_lifecycle_offboarding_package_runs package_run
        WHERE package_run.run_id = custom_process_runs.id
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM custom_process_run_steps run_step
          WHERE run_step.run_id = custom_process_runs.id
            AND run_step.status <> 'completed'
        )
        OR EXISTS (
          SELECT 1 FROM personnel_lifecycle_offboarding_run_terminations termination
          WHERE termination.run_id = custom_process_runs.id
        )
      )
  `),
  entry(S.insertOffboardingRunTermination, `
    INSERT INTO personnel_lifecycle_offboarding_run_terminations (
      run_id, case_id, operation_id, reason_code, protected_payload,
      receipt_sha256, terminated_by, terminated_at
    ) VALUES (
      json_extract($payload, '$.runId'), json_extract($payload, '$.caseId'),
      json_extract($payload, '$.operationId'), json_extract($payload, '$.reasonCode'),
      json_extract($payload, '$.protectedPayload'), json_extract($payload, '$.receiptSha256'),
      json_extract($payload, '$.terminatedBy'), json_extract($payload, '$.terminatedAt')
    )
  `),

  entry(S.runById, `
    SELECT ${jsonObject(RUN_FIELDS)}
    ${RUN_FROM}
    WHERE r.id = json_extract($payload, '$.id')
      AND NOT EXISTS (
        SELECT 1 FROM custom_process_run_bindings binding
        WHERE binding.run_id = r.id
      )
      AND ${offboardingRunExcluded("r.id")}
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
      AND ${offboardingRunExcluded("r.id")}
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
      AND ${offboardingRunExcluded("r.id")}
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
      AND ${offboardingRunExcluded("r.id")}
  `),
  entry(S.insertRun, `
    INSERT INTO custom_process_runs (
      id, process_id, process_revision, trigger_type, trigger_key,
      location_id, department_id, triggered_by
    )
    SELECT
      json_extract($payload, '$.id'),
      json_extract($payload, '$.processId'),
      json_extract($payload, '$.processRevision'),
      json_extract($payload, '$.triggerType'),
      json_extract($payload, '$.triggerKey'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.departmentId'),
      json_extract($payload, '$.triggeredBy')
    WHERE json_extract($payload, '$.triggerType') <> 'personnel_lifecycle_offboarding'
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
      AND ${offboardingRunExcluded("id")}
  `),
  entry(S.deleteRunSteps, `
    DELETE FROM custom_process_run_steps
    WHERE run_id = json_extract($payload, '$.runId')
      AND ${offboardingRunExcluded("run_id")}
  `),
  entry(S.countRunSteps, `
    SELECT ${jsonObject({ count: "COUNT(*)" })}
    FROM custom_process_run_steps rs
    WHERE rs.run_id = json_extract($payload, '$.runId')
      AND ${offboardingRunExcluded("rs.run_id")}
  `),
  entry(S.insertRunStep, `
    INSERT OR IGNORE INTO custom_process_run_steps (run_id, step_id, sort_order)
    SELECT
      json_extract($payload, '$.runId'),
      json_extract($payload, '$.stepId'),
      json_extract($payload, '$.sortOrder')
    WHERE ${offboardingRunExcluded("json_extract($payload, '$.runId')")}
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
      AND ${offboardingRunExcluded("r.id")}
  `),
  entry(S.activeRunStep, `
    SELECT ${jsonObject(RUN_STEP_FIELDS)}
    FROM custom_process_run_steps rs
    WHERE rs.run_id = json_extract($payload, '$.runId')
      AND rs.status = 'active'
      AND ${offboardingRunExcluded("rs.run_id")}
    ORDER BY rs.sort_order
    LIMIT 1
  `),
  entry(S.pendingRunStep, `
    SELECT ${jsonObject(RUN_STEP_FIELDS)}
    FROM custom_process_run_steps rs
    WHERE rs.run_id = json_extract($payload, '$.runId')
      AND rs.status = 'pending'
      AND ${offboardingRunExcluded("rs.run_id")}
    ORDER BY rs.sort_order
    LIMIT 1
  `),
  entry(S.runStepById, `
    SELECT ${jsonObject(RUN_STEP_FIELDS)}
    FROM custom_process_run_steps rs
    WHERE rs.run_id = json_extract($payload, '$.runId')
      AND rs.step_id = json_extract($payload, '$.stepId')
      AND ${offboardingRunExcluded("rs.run_id")}
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
      AND ${offboardingRunExcluded("run_id")}
  `),
  entry(S.activateRunStep, `
    UPDATE custom_process_run_steps
    SET status = 'active',
        activated_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE run_id = json_extract($payload, '$.runId')
      AND step_id = json_extract($payload, '$.stepId')
      AND status = 'pending'
      AND ${offboardingRunExcluded("run_id")}
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
      AND ${offboardingRunExcluded("run_id")}
  `),
  entry(S.skipOpenRunSteps, `
    UPDATE custom_process_run_steps
    SET status = 'skipped',
        completed_at = CURRENT_TIMESTAMP,
        completed_by = 'system',
        updated_at = CURRENT_TIMESTAMP
    WHERE run_id = json_extract($payload, '$.runId')
      AND status IN ('pending', 'active')
      AND ${offboardingRunExcluded("run_id")}
  `),
  entry(S.resolveRun, `
    UPDATE custom_process_runs
    SET status = 'resolved',
        resolved_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = json_extract($payload, '$.runId')
      AND status = 'open'
      AND ${offboardingRunExcluded("id")}
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
      AND ${offboardingRunExcluded("r.id")}
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
      AND ${offboardingRunExcluded("r.id")}
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
      AND ${offboardingRunExcluded("r.id")}
    ORDER BY COALESCE(rs.activated_at, r.created_at) DESC, r.created_at DESC
  `),
  entry(S.runStepCounts, `
    SELECT ${jsonObject({
      total: "COUNT(*)",
      finished: "SUM(CASE WHEN rs.status IN ('completed','skipped') THEN 1 ELSE 0 END)",
    })}
    FROM custom_process_run_steps rs
    WHERE rs.run_id = json_extract($payload, '$.runId')
      AND ${offboardingRunExcluded("rs.run_id")}
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
