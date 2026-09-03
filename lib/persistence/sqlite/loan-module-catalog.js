"use strict";

const {
  LOAN_MODULE_STATEMENTS: S,
} = require("../statements/loan-module");

function entry(statement, sql, returning = false) {
  return Object.freeze({ statement, sql, returning });
}

function jsonObject(fields) {
  return `json_object(${Object.entries(fields)
    .flatMap(([name, expression]) => [`'${name}'`, expression])
    .join(", ")}) AS data`;
}

const LOCATION_SETTING_FIELDS = Object.freeze({
  location_id: "l.id",
  location_name: "l.name",
  location_active: "l.active",
  enabled: "COALESCE(s.enabled, 0)",
  article_lookup_enabled: "COALESCE(s.article_lookup_enabled, 0)",
  article_lookup_provider: "COALESCE(s.article_lookup_provider, 'none')",
  article_lookup_base_url: "COALESCE(s.article_lookup_base_url, '')",
  document_recipient_employee_number: "COALESCE(s.document_recipient_employee_number, '')",
  document_email_enabled: "COALESCE(s.document_email_enabled, 0)",
  document_recipient_email: "COALESCE(s.document_recipient_email, '')",
  photo_pdf_output_mode: "COALESCE(s.photo_pdf_output_mode, 'grayscale')",
  photo_original_retention: "COALESCE(s.photo_original_retention, 'retain')",
  branch_overview_columns: "COALESCE(s.branch_overview_columns, '[\"borrowerName\",\"description\",\"articleNumber\",\"serialNumber\",\"dueDate\"]')",
  document_recipient_full_name: "recipient.full_name",
  document_recipient_nickname: "recipient.nickname",
  updated_by: "s.updated_by",
  updated_at: "s.updated_at",
});

const ARTICLE_FIELDS = Object.freeze({
  article_number: "article.article_number",
  product_id: "article.product_id",
  current_revision: "article.current_revision",
  description: "revision.description",
  source_provider: `COALESCE(NULLIF(origin_source.source_provider, ''), CASE
    WHEN article.source_system = 'manual.loan' THEN 'manual'
    WHEN article.source_system = 'shopware.storefront' THEN 'shopware_storefront'
    ELSE 'import'
  END)`,
  source_product_number: `COALESCE(
    NULLIF(origin_source.source_product_number, ''),
    origin_source.source_article_key,
    ''
  )`,
  source_url: "COALESCE(origin_source.source_url, '')",
  source_fetched_at: "revision.source_updated_at",
  revision_source_system: `(
    SELECT import_snapshot.source_system
    FROM sales_article_import_snapshots import_snapshot
    WHERE import_snapshot.id = revision.source_snapshot_id
  )`,
  active: "revision.active",
  created_at: "article.created_at",
  updated_at: "article.updated_at",
  identifiers: `json(COALESCE((
    SELECT json_group_array(json_object(
      'identifier_type', identifier.identifier_type,
      'identifier_value', identifier.identifier_value,
      'source_provider', COALESCE(NULLIF(identifier.source_provider, ''), 'import'),
      'verified_at', identifier.verified_at
    ))
    FROM sales_article_identifiers identifier
    WHERE identifier.product_id = article.product_id
      AND identifier.source_snapshot_id = revision.source_snapshot_id
    ORDER BY identifier.identifier_type, identifier.identifier_value
  ), '[]'))`,
});

const ARTICLE_JOIN = `
  FROM sales_articles article
  JOIN sales_article_revisions revision
    ON revision.product_id = article.product_id
   AND revision.revision = article.current_revision
  LEFT JOIN sales_article_source_links origin_source
    ON origin_source.product_id = article.product_id
   AND origin_source.source_system = article.source_system
   AND origin_source.source_article_key = article.source_article_key
`;

const MIGRATION_RUN_FIELDS = Object.freeze({
  id: "run.id",
  source_system: "run.source_system",
  source_fingerprint: "run.source_fingerprint",
  source_version: "run.source_version",
  source_created_at: "run.source_created_at",
  location_id: "run.location_id",
  status: "run.status",
  employee_count: "run.employee_count",
  loan_count: "run.loan_count",
  item_count: "run.item_count",
  photo_count: "run.photo_count",
  open_loan_count: "run.open_loan_count",
  returned_loan_count: "run.returned_loan_count",
  warnings_json: "run.warnings_json",
  imported_by_employee_number: "run.imported_by_employee_number",
  completed_at: "run.completed_at",
  location_name: "location.name",
});

const LOAN_FIELDS = Object.freeze({
  id: "l.id",
  legacy_id: "l.legacy_id",
  location_id: "l.location_id",
  borrower_employee_number: "l.borrower_employee_number",
  created_by_employee_number: "l.created_by_employee_number",
  due_date: "l.due_date",
  status: "l.status",
  notes: "l.notes",
  issued_at: "l.issued_at",
  returned_at: "l.returned_at",
  return_recorded_by_employee_number: "l.return_recorded_by_employee_number",
  return_witness_employee_number: "l.return_witness_employee_number",
  borrower_return_confirmed: "l.borrower_return_confirmed",
  revision: "l.revision",
  created_at: "l.created_at",
  updated_at: "l.updated_at",
  location_name: "location.name",
  borrower_full_name: "borrower.full_name",
  borrower_nickname: "borrower.nickname",
  creator_full_name: "creator.full_name",
  creator_nickname: "creator.nickname",
  witness_full_name: "witness.full_name",
  witness_nickname: "witness.nickname",
});

const LOAN_JOIN = `
  FROM loans l
  JOIN locations location ON location.id = l.location_id
  JOIN employees borrower ON borrower.personnel_number = l.borrower_employee_number
  JOIN employees creator ON creator.personnel_number = l.created_by_employee_number
  LEFT JOIN employees witness ON witness.personnel_number = l.return_witness_employee_number
`;

const CONFIRMATION_FIELDS = Object.freeze({
  id: "confirmation.id",
  loan_id: "confirmation.loan_id",
  requested_by_employee_number: "confirmation.requested_by_employee_number",
  witness_employee_number: "confirmation.witness_employee_number",
  expected_revision: "confirmation.expected_revision",
  status: "confirmation.status",
  payload_json: "confirmation.payload_json",
  requested_at: "confirmation.requested_at",
  expires_at: "confirmation.expires_at",
  responded_at: "confirmation.responded_at",
  response_note: "confirmation.response_note",
  updated_at: "confirmation.updated_at",
  requester_full_name: "requester.full_name",
  requester_nickname: "requester.nickname",
  witness_full_name: "witness.full_name",
  witness_nickname: "witness.nickname",
});

const CONFIRMATION_JOIN = `
  FROM loan_return_confirmations confirmation
  JOIN employees requester
    ON requester.personnel_number = confirmation.requested_by_employee_number
  JOIN employees witness
    ON witness.personnel_number = confirmation.witness_employee_number
`;

const RETURN_PREPARATION_FIELDS = Object.freeze({
  loan_id: "preparation.loan_id",
  requested_by_employee_number: "preparation.requested_by_employee_number",
  expected_revision: "preparation.expected_revision",
  payload_json: "preparation.payload_json",
  prepared_at: "preparation.prepared_at",
  updated_at: "preparation.updated_at",
  requester_full_name: "requester.full_name",
  requester_nickname: "requester.nickname",
});

const SQLITE_LOAN_MODULE_CATALOG = Object.freeze([
  entry(S.firstActiveLocation, `
    SELECT ${jsonObject({ id: "id" })}
    FROM locations
    WHERE active = 1
    ORDER BY id
    LIMIT 1
  `),
  entry(S.getLocationSetting, `
    SELECT ${jsonObject(LOCATION_SETTING_FIELDS)}
    FROM locations l
    LEFT JOIN loan_location_settings s ON s.location_id = l.id
    LEFT JOIN employees recipient
      ON recipient.personnel_number = s.document_recipient_employee_number
    WHERE l.id = json_extract($payload, '$.locationId')
  `),
  entry(S.listLocationSettings, `
    SELECT ${jsonObject(LOCATION_SETTING_FIELDS)}
    FROM locations l
    LEFT JOIN loan_location_settings s ON s.location_id = l.id
    LEFT JOIN employees recipient
      ON recipient.personnel_number = s.document_recipient_employee_number
    ORDER BY l.id
  `),
  entry(S.getDocumentRecipientCandidate, `
    SELECT ${jsonObject({
      employee_number: "u.employee_number",
      role: "u.role",
      active: "u.active",
      permissions: "r.permissions",
      home_location_id: "e.home_location_id",
      preferred_department_id: "e.preferred_department_id",
      granted_permissions: `json(COALESCE((
        SELECT json_group_array(g.permission)
        FROM portal_permission_grants g
        WHERE g.employee_number = u.employee_number
      ), '[]'))`,
      denied_permissions: `json(COALESCE((
        SELECT json_group_array(d.permission)
        FROM portal_permission_denials d
        WHERE d.employee_number = u.employee_number
      ), '[]'))`,
      access_scopes: `json(COALESCE((
        SELECT json_group_array(json_object(
          'locationId', scope.location_id,
          'departmentId', NULLIF(scope.department_id, 0)
        ))
        FROM portal_access_scopes scope
        WHERE scope.employee_number = u.employee_number
      ), '[]'))`,
    })}
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    LEFT JOIN portal_roles r ON r.id = u.role
    WHERE u.employee_number = json_extract($payload, '$.employeeNumber')
      AND u.active = 1
      AND e.active = 1
  `),
  entry(S.upsertLocationSetting, `
    INSERT INTO loan_location_settings
      (location_id, enabled, article_lookup_enabled, article_lookup_provider,
       article_lookup_base_url, document_recipient_employee_number,
       document_email_enabled, document_recipient_email, photo_pdf_output_mode,
       photo_original_retention, branch_overview_columns, created_by, updated_by, updated_at)
    VALUES (
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.enabled'),
      json_extract($payload, '$.articleLookupEnabled'),
      json_extract($payload, '$.articleLookupProvider'),
      json_extract($payload, '$.articleLookupBaseUrl'),
      json_extract($payload, '$.documentRecipientEmployeeNumber'),
      json_extract($payload, '$.documentEmailEnabled'),
      json_extract($payload, '$.documentRecipientEmail'),
      json_extract($payload, '$.photoPdfOutputMode'),
      json_extract($payload, '$.photoOriginalRetention'),
      json_extract($payload, '$.branchOverviewColumns'),
      json_extract($payload, '$.actorEmployeeNumber'),
      json_extract($payload, '$.actorEmployeeNumber'),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(location_id) DO UPDATE SET
      enabled = excluded.enabled,
      article_lookup_enabled = excluded.article_lookup_enabled,
      article_lookup_provider = excluded.article_lookup_provider,
      article_lookup_base_url = excluded.article_lookup_base_url,
      document_recipient_employee_number = excluded.document_recipient_employee_number,
      document_email_enabled = excluded.document_email_enabled,
      document_recipient_email = excluded.document_recipient_email,
      photo_pdf_output_mode = excluded.photo_pdf_output_mode,
      photo_original_retention = excluded.photo_original_retention,
      branch_overview_columns = excluded.branch_overview_columns,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `),
  entry(S.updateBranchOverviewColumns, `
    INSERT INTO loan_location_settings
      (location_id, branch_overview_columns, created_by, updated_by, updated_at)
    VALUES (
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.branchOverviewColumns'),
      json_extract($payload, '$.actorEmployeeNumber'),
      json_extract($payload, '$.actorEmployeeNumber'),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(location_id) DO UPDATE SET
      branch_overview_columns = excluded.branch_overview_columns,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `),

  entry(S.getArticle, `
    SELECT ${jsonObject(ARTICLE_FIELDS)}
    ${ARTICLE_JOIN}
    WHERE article.article_number = json_extract($payload, '$.articleNumber')
  `),
  entry(S.getArticleByIdentifier, `
    SELECT ${jsonObject(ARTICLE_FIELDS)}
    ${ARTICLE_JOIN}
    WHERE article.product_id = (
      SELECT owner.product_id
      FROM sales_article_identifier_owners owner
      WHERE owner.canonical_gtin14 = substr(
        '00000000000000' || json_extract($payload, '$.identifierValue'),
        -14,
        14
      )
    )
  `),
  entry(S.searchArticles, `
    SELECT ${jsonObject(ARTICLE_FIELDS)}
    ${ARTICLE_JOIN}
    WHERE revision.active = 1
      AND (
        article.article_number LIKE json_extract($payload, '$.articlePrefix')
        OR revision.description LIKE json_extract($payload, '$.descriptionPattern') COLLATE NOCASE
        OR EXISTS (
          SELECT 1
          FROM sales_article_identifiers identifier
          WHERE identifier.product_id = article.product_id
            AND identifier.identifier_value LIKE json_extract($payload, '$.identifierPrefix')
        )
      )
    ORDER BY CASE
      WHEN article.article_number = json_extract($payload, '$.exactArticleNumber') THEN 0
      ELSE 1
    END, revision.description, article.article_number
    LIMIT 20
  `),
  entry(S.getActiveArticle, `
    SELECT ${jsonObject({
      product_id: "article.product_id",
      current_revision: "article.current_revision",
      article_number: "article.article_number",
      description: "revision.description",
      active: "revision.active",
    })}
    FROM sales_articles article
    JOIN sales_article_revisions revision
      ON revision.product_id = article.product_id
     AND revision.revision = article.current_revision
    WHERE article.article_number = json_extract($payload, '$.articleNumber')
  `),
  entry(S.listOpenOverviewItems, `
    SELECT ${jsonObject({
      article_number: "item.article_number_snapshot",
      description_snapshot: "item.description_snapshot",
      serial_number: "item.serial_number",
      due_date: "loan.due_date",
      borrower_employee_number: "loan.borrower_employee_number",
      borrower_full_name: "borrower.full_name",
      borrower_nickname: "borrower.nickname",
    })}
    FROM loans loan
    JOIN loan_items item ON item.loan_id = loan.id
    JOIN employees borrower ON borrower.personnel_number = loan.borrower_employee_number
    WHERE loan.location_id = json_extract($payload, '$.locationId')
      AND loan.status = 'issued'
    ORDER BY item.description_snapshot COLLATE NOCASE,
             item.article_number_snapshot, item.serial_number, item.position
  `),

  entry(S.listMigrationRuns, `
    SELECT ${jsonObject(MIGRATION_RUN_FIELDS)}
    FROM loan_migration_runs run
    JOIN locations location ON location.id = run.location_id
    ORDER BY run.completed_at DESC, run.id DESC
  `),
  entry(S.getMigrationRun, `
    SELECT ${jsonObject(MIGRATION_RUN_FIELDS)}
    FROM loan_migration_runs run
    JOIN locations location ON location.id = run.location_id
    WHERE run.id = json_extract($payload, '$.runId')
  `),
  entry(S.getF18MigrationRunForLocation, `
    SELECT ${jsonObject(MIGRATION_RUN_FIELDS)}
    FROM loan_migration_runs run
    JOIN locations location ON location.id = run.location_id
    WHERE run.source_system = 'f18-lagerware'
      AND run.location_id = json_extract($payload, '$.locationId')
  `),
  entry(S.listMigrationTargetEmployees, `
    SELECT ${jsonObject({
      personnel_number: "personnel_number",
      full_name: "full_name",
      nickname: "nickname",
      active: "active",
    })}
    FROM employees
    ORDER BY personnel_number
  `),
  entry(S.insertMigrationRun, `
    INSERT INTO loan_migration_runs
      (id, source_system, source_fingerprint, source_version, source_created_at,
       location_id, status, employee_count, loan_count, item_count, photo_count,
       open_loan_count, returned_loan_count, warnings_json,
       imported_by_employee_number, completed_at)
    VALUES (
      json_extract($payload, '$.id'),
      'f18-lagerware',
      json_extract($payload, '$.sourceFingerprint'),
      json_extract($payload, '$.sourceVersion'),
      json_extract($payload, '$.sourceCreatedAt'),
      json_extract($payload, '$.locationId'),
      'completed',
      json_extract($payload, '$.employeeCount'),
      json_extract($payload, '$.loanCount'),
      json_extract($payload, '$.itemCount'),
      json_extract($payload, '$.photoCount'),
      json_extract($payload, '$.openLoanCount'),
      json_extract($payload, '$.returnedLoanCount'),
      json_extract($payload, '$.warningsJson'),
      json_extract($payload, '$.importedByEmployeeNumber'),
      json_extract($payload, '$.completedAt')
    )
  `),
  entry(S.insertImportedLoan, `
    INSERT INTO loans
      (id, legacy_id, location_id, borrower_employee_number, created_by_employee_number,
       due_date, status, notes, issued_at, returned_at, return_recorded_by_employee_number,
       return_witness_employee_number, borrower_return_confirmed, revision, created_at, updated_at)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.legacyId'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.borrowerEmployeeNumber'),
      json_extract($payload, '$.createdByEmployeeNumber'),
      json_extract($payload, '$.dueDate'),
      json_extract($payload, '$.status'),
      json_extract($payload, '$.notes'),
      json_extract($payload, '$.issuedAt'),
      json_extract($payload, '$.returnedAt'),
      json_extract($payload, '$.returnRecordedByEmployeeNumber'),
      json_extract($payload, '$.returnWitnessEmployeeNumber'),
      json_extract($payload, '$.borrowerReturnConfirmed'),
      json_extract($payload, '$.revision'),
      json_extract($payload, '$.createdAt'),
      json_extract($payload, '$.updatedAt')
    )
  `),
  entry(S.insertMigrationRecord, `
    INSERT INTO loan_migration_records
      (run_id, source_loan_id, source_record_hash, target_loan_id, created_at)
    VALUES (
      json_extract($payload, '$.runId'),
      json_extract($payload, '$.sourceLoanId'),
      json_extract($payload, '$.sourceRecordHash'),
      json_extract($payload, '$.targetLoanId'),
      json_extract($payload, '$.createdAt')
    )
  `),

  entry(S.getEmployee, `
    SELECT ${jsonObject({
      personnel_number: "personnel_number",
      full_name: "full_name",
      nickname: "nickname",
      home_location_id: "home_location_id",
      preferred_department_id: "preferred_department_id",
      active: "active",
    })}
    FROM employees
    WHERE personnel_number = json_extract($payload, '$.employeeNumber')
      AND (
        json_extract($payload, '$.activeOnly') = 0
        OR active = 1
      )
  `),
  entry(S.getLoan, `
    SELECT ${jsonObject(LOAN_FIELDS)}
    ${LOAN_JOIN}
    WHERE l.id = json_extract($payload, '$.loanId')
  `),
  entry(S.listLoans, `
    SELECT ${jsonObject(LOAN_FIELDS)}
    ${LOAN_JOIN}
    WHERE (
      (json_extract($payload, '$.scope') = 'location'
        AND l.location_id = json_extract($payload, '$.locationId'))
      OR
      (json_extract($payload, '$.scope') = 'mine'
        AND l.borrower_employee_number = json_extract($payload, '$.employeeNumber'))
    )
      AND (
        json_extract($payload, '$.status') = 'all'
        OR (json_extract($payload, '$.status') = 'open' AND l.status = 'issued')
        OR (json_extract($payload, '$.status') = 'history' AND l.status IN ('returned','cancelled'))
      )
    ORDER BY CASE WHEN l.status = 'issued' THEN 0 ELSE 1 END,
             COALESCE(l.returned_at, l.issued_at, l.created_at) DESC
    LIMIT 100
  `),
  entry(S.listManagementLoans, `
    SELECT ${jsonObject(LOAN_FIELDS)}
    ${LOAN_JOIN}
    WHERE (
      json_extract($payload, '$.locationId') = ''
      OR l.location_id = json_extract($payload, '$.locationId')
    )
    ORDER BY CASE WHEN l.status = 'issued' THEN 0 ELSE 1 END,
             COALESCE(l.due_date, l.returned_at, l.issued_at, l.created_at)
    LIMIT 250
  `),
  entry(S.listTeamMembers, `
    SELECT ${jsonObject({
      personnel_number: "employee.personnel_number",
      full_name: "employee.full_name",
      nickname: "employee.nickname",
      portal_open: `EXISTS (
        SELECT 1
        FROM portal_sessions session
        WHERE session.employee_number = employee.personnel_number
          AND session.revoked_at IS NULL
          AND julianday(session.expires_at) > julianday('now')
          AND julianday(session.last_seen_at) >= julianday(
            'now',
            json_extract($payload, '$.minimumLastSeenModifier')
          )
      )`,
    })}
    FROM employees employee
    WHERE employee.active = 1
      AND employee.home_location_id = json_extract($payload, '$.locationId')
    ORDER BY CAST(employee.personnel_number AS INTEGER), employee.personnel_number
  `),
  entry(S.hasLivePortalSession, `
    SELECT ${jsonObject({ found: "1" })}
    FROM portal_sessions
    WHERE employee_number = json_extract($payload, '$.employeeNumber')
      AND revoked_at IS NULL
      AND julianday(expires_at) > julianday('now')
      AND julianday(last_seen_at) >= julianday(
        'now',
        json_extract($payload, '$.minimumLastSeenModifier')
      )
    LIMIT 1
  `),

  entry(S.expireReturnConfirmations, `
    UPDATE loan_return_confirmations
    SET status = 'expired',
        responded_at = COALESCE(responded_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'pending'
      AND julianday(expires_at) <= julianday('now')
  `),
  entry(S.getReturnConfirmation, `
    SELECT ${jsonObject(CONFIRMATION_FIELDS)}
    ${CONFIRMATION_JOIN}
    WHERE confirmation.id = json_extract($payload, '$.confirmationId')
  `),
  entry(S.getPendingReturnConfirmation, `
    SELECT ${jsonObject(CONFIRMATION_FIELDS)}
    ${CONFIRMATION_JOIN}
    WHERE confirmation.loan_id = json_extract($payload, '$.loanId')
      AND confirmation.status = 'pending'
      AND julianday(confirmation.expires_at) > julianday('now')
    LIMIT 1
  `),
  entry(S.listPendingReturnConfirmations, `
    SELECT ${jsonObject(CONFIRMATION_FIELDS)}
    ${CONFIRMATION_JOIN}
    WHERE confirmation.witness_employee_number = json_extract($payload, '$.employeeNumber')
      AND confirmation.status = 'pending'
      AND julianday(confirmation.expires_at) > julianday('now')
    ORDER BY confirmation.requested_at
  `),
  entry(S.getPendingWitnessPayload, `
    SELECT ${jsonObject({ payload_json: "payload_json" })}
    FROM loan_return_confirmations
    WHERE loan_id = json_extract($payload, '$.loanId')
      AND witness_employee_number = json_extract($payload, '$.employeeNumber')
      AND status = 'pending'
      AND julianday(expires_at) > julianday('now')
    LIMIT 1
  `),
  entry(S.getReturnPreparation, `
    SELECT ${jsonObject(RETURN_PREPARATION_FIELDS)}
    FROM loan_return_preparations preparation
    JOIN employees requester
      ON requester.personnel_number = preparation.requested_by_employee_number
    WHERE preparation.loan_id = json_extract($payload, '$.loanId')
  `),
  entry(S.upsertReturnPreparation, `
    INSERT INTO loan_return_preparations
      (loan_id, requested_by_employee_number, expected_revision, payload_json,
       prepared_at, updated_at)
    VALUES (
      json_extract($payload, '$.loanId'),
      json_extract($payload, '$.requestedByEmployeeNumber'),
      json_extract($payload, '$.expectedRevision'),
      json_extract($payload, '$.payloadJson'),
      json_extract($payload, '$.preparedAt'),
      json_extract($payload, '$.updatedAt')
    )
    ON CONFLICT(loan_id) DO UPDATE SET
      requested_by_employee_number = excluded.requested_by_employee_number,
      expected_revision = excluded.expected_revision,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `),
  entry(S.deleteReturnPreparation, `
    DELETE FROM loan_return_preparations
    WHERE loan_id = json_extract($payload, '$.loanId')
  `),
  entry(S.insertReturnConfirmation, `
    INSERT INTO loan_return_confirmations
      (id, loan_id, requested_by_employee_number, witness_employee_number,
       expected_revision, status, payload_json, requested_at, expires_at, updated_at)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.loanId'),
      json_extract($payload, '$.requestedByEmployeeNumber'),
      json_extract($payload, '$.witnessEmployeeNumber'),
      json_extract($payload, '$.expectedRevision'),
      'pending',
      json_extract($payload, '$.payloadJson'),
      json_extract($payload, '$.requestedAt'),
      json_extract($payload, '$.expiresAt'),
      json_extract($payload, '$.requestedAt')
    )
  `),
  entry(S.cancelReturnConfirmation, `
    UPDATE loan_return_confirmations
    SET status = 'cancelled',
        responded_at = json_extract($payload, '$.respondedAt'),
        response_note = json_extract($payload, '$.responseNote'),
        updated_at = json_extract($payload, '$.respondedAt')
    WHERE id = json_extract($payload, '$.confirmationId')
      AND status = 'pending'
  `),
  entry(S.rejectReturnConfirmation, `
    UPDATE loan_return_confirmations
    SET status = 'rejected',
        responded_at = json_extract($payload, '$.respondedAt'),
        response_note = json_extract($payload, '$.responseNote'),
        updated_at = json_extract($payload, '$.respondedAt')
    WHERE id = json_extract($payload, '$.confirmationId')
      AND status = 'pending'
  `),
  entry(S.confirmReturnConfirmation, `
    UPDATE loan_return_confirmations
    SET status = 'confirmed',
        responded_at = json_extract($payload, '$.respondedAt'),
        response_note = json_extract($payload, '$.responseNote'),
        updated_at = json_extract($payload, '$.respondedAt')
    WHERE id = json_extract($payload, '$.confirmationId')
      AND status = 'pending'
  `),

  entry(S.listLoanItems, `
    SELECT ${jsonObject({
      id: "id",
      position: "position",
      product_id: "product_id",
      product_revision_snapshot: "product_revision_snapshot",
      article_number: "article_number_snapshot",
      description_snapshot: "description_snapshot",
      serial_number: "serial_number",
      quantity: "quantity",
      condition_out: "condition_out",
      condition_return: "condition_return",
      item_note: "item_note",
      created_at: "created_at",
      updated_at: "updated_at",
    })}
    FROM loan_items
    WHERE loan_id = json_extract($payload, '$.loanId')
    ORDER BY position
  `),
  entry(S.listLoanEvents, `
    SELECT ${jsonObject({
      id: "id",
      actor_employee_number: "actor_employee_number",
      event_type: "event_type",
      revision: "revision",
      payload_json: "payload_json",
      created_at: "created_at",
    })}
    FROM loan_events
    WHERE loan_id = json_extract($payload, '$.loanId')
    ORDER BY revision, id
  `),
  entry(S.listLoanDocuments, `
    SELECT ${jsonObject({
      id: "document.id",
      loan_id: "document.loan_id",
      document_type: "document.document_type",
      loan_revision: "document.loan_revision",
      filename: "document.filename",
      detected_mime: "document.detected_mime",
      byte_size: "document.byte_size",
      sha256: "document.sha256",
      created_by_employee_number: "document.created_by_employee_number",
      created_at: "document.created_at",
      deliveries: `json(COALESCE((
        SELECT json_group_array(json_object(
          'id', delivery.id,
          'document_id', delivery.document_id,
          'channel', delivery.channel,
          'recipient_employee_number', delivery.recipient_employee_number,
          'recipient_address', delivery.recipient_address,
          'status', delivery.status,
          'error_code', delivery.error_code,
          'attempted_by_employee_number', delivery.attempted_by_employee_number,
          'attempted_at', delivery.attempted_at
        ))
        FROM loan_document_deliveries delivery
        WHERE delivery.document_id = document.id
        ORDER BY delivery.attempted_at, delivery.id
      ), '[]'))`,
    })}
    FROM loan_documents document
    WHERE document.loan_id = json_extract($payload, '$.loanId')
    ORDER BY document.loan_revision,
      CASE document.document_type WHEN 'issue' THEN 0 ELSE 1 END,
      document.created_at
  `),
  entry(S.getLoanDocument, `
    SELECT ${jsonObject({
      id: "document.id",
      loan_id: "document.loan_id",
      document_type: "document.document_type",
      loan_revision: "document.loan_revision",
      storage_key: "document.storage_key",
      filename: "document.filename",
      detected_mime: "document.detected_mime",
      byte_size: "document.byte_size",
      sha256: "document.sha256",
      created_by_employee_number: "document.created_by_employee_number",
      created_at: "document.created_at",
      location_id: "loan.location_id",
      borrower_employee_number: "loan.borrower_employee_number",
      return_recorded_by_employee_number: "loan.return_recorded_by_employee_number",
      return_witness_employee_number: "loan.return_witness_employee_number",
      deliveries: `json(COALESCE((
        SELECT json_group_array(json_object(
          'id', delivery.id,
          'document_id', delivery.document_id,
          'channel', delivery.channel,
          'recipient_employee_number', delivery.recipient_employee_number,
          'recipient_address', delivery.recipient_address,
          'status', delivery.status,
          'error_code', delivery.error_code,
          'attempted_by_employee_number', delivery.attempted_by_employee_number,
          'attempted_at', delivery.attempted_at
        ))
        FROM loan_document_deliveries delivery
        WHERE delivery.document_id = document.id
      ), '[]'))`,
    })}
    FROM loan_documents document
    JOIN loans loan ON loan.id = document.loan_id
    WHERE document.id = json_extract($payload, '$.documentId')
  `),
  entry(S.listLoanPhotos, `
    SELECT ${jsonObject({
      id: "id",
      loan_id: "loan_id",
      phase: "phase",
      position: "position",
      filename: "filename",
      detected_mime: "detected_mime",
      byte_size: "byte_size",
      sha256: "sha256",
      pixel_width: "pixel_width",
      pixel_height: "pixel_height",
      original_retained: "original_retained",
      original_deleted_at: "original_deleted_at",
      original_deletion_reason: "original_deletion_reason",
      created_by_employee_number: "created_by_employee_number",
      created_at: "created_at",
    })}
    FROM loan_photos
    WHERE loan_id = json_extract($payload, '$.loanId')
    ORDER BY CASE phase WHEN 'issue' THEN 0 ELSE 1 END, position
  `),
  entry(S.getLoanPhoto, `
    SELECT ${jsonObject({
      id: "photo.id",
      loan_id: "photo.loan_id",
      phase: "photo.phase",
      position: "photo.position",
      storage_key: "photo.storage_key",
      filename: "photo.filename",
      detected_mime: "photo.detected_mime",
      byte_size: "photo.byte_size",
      sha256: "photo.sha256",
      pixel_width: "photo.pixel_width",
      pixel_height: "photo.pixel_height",
      original_retained: "photo.original_retained",
      original_deleted_at: "photo.original_deleted_at",
      original_deletion_reason: "photo.original_deletion_reason",
      created_by_employee_number: "photo.created_by_employee_number",
      created_at: "photo.created_at",
      location_id: "loan.location_id",
      borrower_employee_number: "loan.borrower_employee_number",
      return_recorded_by_employee_number: "loan.return_recorded_by_employee_number",
      return_witness_employee_number: "loan.return_witness_employee_number",
    })}
    FROM loan_photos photo
    JOIN loans loan ON loan.id = photo.loan_id
    WHERE photo.id = json_extract($payload, '$.photoId')
  `),
  entry(S.listLoanPhotoAttachments, `
    SELECT ${jsonObject({
      id: "id",
      loan_id: "loan_id",
      phase: "phase",
      attachment_revision: "attachment_revision",
      source_photo_count: "source_photo_count",
      source_photo_ids_json: "source_photo_ids_json",
      source_fingerprint: "source_fingerprint",
      output_mode: "output_mode",
      original_retention: "original_retention",
      filename: "filename",
      detected_mime: "detected_mime",
      byte_size: "byte_size",
      sha256: "sha256",
      created_by_employee_number: "created_by_employee_number",
      created_at: "created_at",
    })}
    FROM loan_photo_attachments
    WHERE loan_id = json_extract($payload, '$.loanId')
    ORDER BY CASE phase WHEN 'issue' THEN 0 ELSE 1 END, attachment_revision
  `),
  entry(S.getLoanPhotoAttachment, `
    SELECT ${jsonObject({
      id: "attachment.id",
      loan_id: "attachment.loan_id",
      phase: "attachment.phase",
      attachment_revision: "attachment.attachment_revision",
      source_photo_count: "attachment.source_photo_count",
      source_photo_ids_json: "attachment.source_photo_ids_json",
      source_fingerprint: "attachment.source_fingerprint",
      output_mode: "attachment.output_mode",
      original_retention: "attachment.original_retention",
      storage_key: "attachment.storage_key",
      filename: "attachment.filename",
      detected_mime: "attachment.detected_mime",
      byte_size: "attachment.byte_size",
      sha256: "attachment.sha256",
      created_by_employee_number: "attachment.created_by_employee_number",
      created_at: "attachment.created_at",
      location_id: "loan.location_id",
      borrower_employee_number: "loan.borrower_employee_number",
      return_recorded_by_employee_number: "loan.return_recorded_by_employee_number",
      return_witness_employee_number: "loan.return_witness_employee_number",
    })}
    FROM loan_photo_attachments attachment
    JOIN loans loan ON loan.id = attachment.loan_id
    WHERE attachment.id = json_extract($payload, '$.attachmentId')
  `),
  entry(S.listLoanDocumentDeliveries, `
    SELECT ${jsonObject({
      id: "id",
      document_id: "document_id",
      channel: "channel",
      recipient_employee_number: "recipient_employee_number",
      recipient_address: "recipient_address",
      status: "status",
      error_code: "error_code",
      attempted_by_employee_number: "attempted_by_employee_number",
      attempted_at: "attempted_at",
    })}
    FROM loan_document_deliveries
    WHERE document_id = json_extract($payload, '$.documentId')
    ORDER BY attempted_at, id
  `),
  entry(S.listFallbackDocumentRecipients, `
    SELECT ${jsonObject({
      employee_number: "u.employee_number",
      role: "u.role",
      permissions: "r.permissions",
      home_location_id: "e.home_location_id",
      preferred_department_id: "e.preferred_department_id",
      granted_permissions: `json(COALESCE((
        SELECT json_group_array(g.permission)
        FROM portal_permission_grants g
        WHERE g.employee_number = u.employee_number
      ), '[]'))`,
      denied_permissions: `json(COALESCE((
        SELECT json_group_array(d.permission)
        FROM portal_permission_denials d
        WHERE d.employee_number = u.employee_number
      ), '[]'))`,
      access_scopes: `json(COALESCE((
        SELECT json_group_array(json_object(
          'locationId', scope.location_id,
          'departmentId', NULLIF(scope.department_id, 0)
        ))
        FROM portal_access_scopes scope
        WHERE scope.employee_number = u.employee_number
      ), '[]'))`,
    })}
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    LEFT JOIN portal_roles r ON r.id = u.role
    WHERE u.active = 1
      AND e.active = 1
      AND TRIM(u.password_hash) <> ''
    ORDER BY CASE u.role
      WHEN 'developer' THEN 0
      WHEN 'admin' THEN 1
      WHEN 'it_admin' THEN 2
      WHEN 'hr' THEN 3
      ELSE 4
    END, CAST(u.employee_number AS INTEGER), u.employee_number
  `),
  entry(S.countLoanPhotos, `
    SELECT ${jsonObject({ count: "COUNT(*)" })}
    FROM loan_photos
    WHERE loan_id = json_extract($payload, '$.loanId')
      AND phase = json_extract($payload, '$.phase')
  `),
  entry(S.nextPhotoAttachmentRevision, `
    SELECT ${jsonObject({ revision: "COALESCE(MAX(attachment_revision), 0) + 1" })}
    FROM loan_photo_attachments
    WHERE loan_id = json_extract($payload, '$.loanId')
      AND phase = json_extract($payload, '$.phase')
  `),

  entry(S.insertLoanDocumentDelivery, `
    INSERT INTO loan_document_deliveries
      (id, document_id, channel, recipient_employee_number, recipient_address,
       status, error_code, attempted_by_employee_number)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.documentId'),
      json_extract($payload, '$.channel'),
      json_extract($payload, '$.recipientEmployeeNumber'),
      json_extract($payload, '$.recipientAddress'),
      json_extract($payload, '$.status'),
      json_extract($payload, '$.errorCode'),
      json_extract($payload, '$.attemptedByEmployeeNumber')
    )
  `),
  entry(S.insertLoanPhoto, `
    INSERT INTO loan_photos
      (id, loan_id, phase, position, storage_key, filename, detected_mime,
       byte_size, sha256, pixel_width, pixel_height, original_retained,
       original_deleted_at, original_deletion_reason, created_by_employee_number, created_at)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.loanId'),
      json_extract($payload, '$.phase'),
      json_extract($payload, '$.position'),
      json_extract($payload, '$.storageKey'),
      json_extract($payload, '$.filename'),
      json_extract($payload, '$.detectedMime'),
      json_extract($payload, '$.byteSize'),
      json_extract($payload, '$.sha256'),
      json_extract($payload, '$.pixelWidth'),
      json_extract($payload, '$.pixelHeight'),
      json_extract($payload, '$.originalRetained'),
      json_extract($payload, '$.originalDeletedAt'),
      json_extract($payload, '$.originalDeletionReason'),
      json_extract($payload, '$.createdByEmployeeNumber'),
      json_extract($payload, '$.createdAt')
    )
  `),
  entry(S.insertLoanPhotoAttachment, `
    INSERT INTO loan_photo_attachments
      (id, loan_id, phase, attachment_revision, source_photo_count,
       source_photo_ids_json, source_fingerprint, output_mode, original_retention,
       storage_key, filename, detected_mime, byte_size, sha256,
       created_by_employee_number, created_at)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.loanId'),
      json_extract($payload, '$.phase'),
      json_extract($payload, '$.attachmentRevision'),
      json_extract($payload, '$.sourcePhotoCount'),
      json_extract($payload, '$.sourcePhotoIdsJson'),
      json_extract($payload, '$.sourceFingerprint'),
      json_extract($payload, '$.outputMode'),
      json_extract($payload, '$.originalRetention'),
      json_extract($payload, '$.storageKey'),
      json_extract($payload, '$.filename'),
      json_extract($payload, '$.detectedMime'),
      json_extract($payload, '$.byteSize'),
      json_extract($payload, '$.sha256'),
      json_extract($payload, '$.createdByEmployeeNumber'),
      json_extract($payload, '$.createdAt')
    )
  `),
  entry(S.insertLoanDocument, `
    INSERT INTO loan_documents
      (id, loan_id, document_type, loan_revision, storage_key, filename,
       detected_mime, byte_size, sha256, created_by_employee_number, created_at)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.loanId'),
      json_extract($payload, '$.documentType'),
      json_extract($payload, '$.loanRevision'),
      json_extract($payload, '$.storageKey'),
      json_extract($payload, '$.filename'),
      json_extract($payload, '$.detectedMime'),
      json_extract($payload, '$.byteSize'),
      json_extract($payload, '$.sha256'),
      json_extract($payload, '$.createdByEmployeeNumber'),
      json_extract($payload, '$.createdAt')
    )
  `),
  entry(S.insertLoanEvent, `
    INSERT INTO loan_events
      (loan_id, actor_employee_number, event_type, revision, payload_json)
    VALUES (
      json_extract($payload, '$.loanId'),
      json_extract($payload, '$.actorEmployeeNumber'),
      json_extract($payload, '$.eventType'),
      json_extract($payload, '$.revision'),
      json_extract($payload, '$.payloadJson')
    )
  `),
  entry(S.insertLoan, `
    INSERT INTO loans
      (id, location_id, borrower_employee_number, created_by_employee_number,
       due_date, status, notes, issued_at, revision, created_at, updated_at)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.locationId'),
      json_extract($payload, '$.borrowerEmployeeNumber'),
      json_extract($payload, '$.createdByEmployeeNumber'),
      json_extract($payload, '$.dueDate'),
      'issued',
      json_extract($payload, '$.notes'),
      json_extract($payload, '$.issuedAt'),
      1,
      json_extract($payload, '$.issuedAt'),
      json_extract($payload, '$.issuedAt')
    )
  `),
  entry(S.insertLoanItem, `
    INSERT INTO loan_items
      (id, loan_id, position, product_id, product_revision_snapshot,
       article_number_snapshot, description_snapshot, serial_number, quantity,
       condition_out, condition_return, item_note, created_at, updated_at)
    VALUES (
      json_extract($payload, '$.id'),
      json_extract($payload, '$.loanId'),
      json_extract($payload, '$.position'),
      json_extract($payload, '$.productId'),
      json_extract($payload, '$.productRevisionSnapshot'),
      json_extract($payload, '$.articleNumber'),
      json_extract($payload, '$.descriptionSnapshot'),
      json_extract($payload, '$.serialNumber'),
      1,
      json_extract($payload, '$.conditionOut'),
      json_extract($payload, '$.conditionReturn'),
      json_extract($payload, '$.itemNote'),
      json_extract($payload, '$.createdAt'),
      json_extract($payload, '$.updatedAt')
    )
  `),

  entry(S.updateManagedLoan, `
    UPDATE loans
    SET due_date = json_extract($payload, '$.dueDate'),
        notes = json_extract($payload, '$.notes'),
        revision = revision + 1,
        updated_at = json_extract($payload, '$.updatedAt')
    WHERE id = json_extract($payload, '$.loanId')
      AND status = json_extract($payload, '$.status')
      AND revision = json_extract($payload, '$.expectedRevision')
  `),
  entry(S.updateManagedLoanItem, `
    UPDATE loan_items
    SET serial_number = json_extract($payload, '$.serialNumber'),
        condition_out = json_extract($payload, '$.conditionOut'),
        condition_return = json_extract($payload, '$.conditionReturn'),
        item_note = json_extract($payload, '$.itemNote'),
        updated_at = json_extract($payload, '$.updatedAt')
    WHERE loan_id = json_extract($payload, '$.loanId')
      AND position = json_extract($payload, '$.position')
  `),
  entry(S.closeManagedLoan, `
    UPDATE loans
    SET due_date = json_extract($payload, '$.dueDate'),
        status = 'returned',
        returned_at = json_extract($payload, '$.returnedAt'),
        return_recorded_by_employee_number = json_extract($payload, '$.actorEmployeeNumber'),
        return_witness_employee_number = NULL,
        borrower_return_confirmed = 0,
        notes = json_extract($payload, '$.notes'),
        revision = revision + 1,
        updated_at = json_extract($payload, '$.returnedAt')
    WHERE id = json_extract($payload, '$.loanId')
      AND status = 'issued'
      AND revision = json_extract($payload, '$.expectedRevision')
  `),
  entry(S.reopenManagedLoan, `
    UPDATE loans
    SET status = 'issued',
        returned_at = NULL,
        return_recorded_by_employee_number = NULL,
        return_witness_employee_number = NULL,
        borrower_return_confirmed = 0,
        revision = revision + 1,
        updated_at = json_extract($payload, '$.updatedAt')
    WHERE id = json_extract($payload, '$.loanId')
      AND status IN ('returned','cancelled')
      AND revision = json_extract($payload, '$.expectedRevision')
  `),
  entry(S.clearLoanItemReturnConditions, `
    UPDATE loan_items
    SET condition_return = '',
        updated_at = json_extract($payload, '$.updatedAt')
    WHERE loan_id = json_extract($payload, '$.loanId')
  `),
  entry(S.markLoanReturned, `
    UPDATE loans
    SET status = 'returned',
        returned_at = json_extract($payload, '$.returnedAt'),
        return_recorded_by_employee_number = json_extract($payload, '$.recordedByEmployeeNumber'),
        return_witness_employee_number = json_extract($payload, '$.witnessEmployeeNumber'),
        borrower_return_confirmed = json_extract($payload, '$.borrowerReturnConfirmed'),
        revision = revision + 1,
        updated_at = json_extract($payload, '$.returnedAt')
    WHERE id = json_extract($payload, '$.loanId')
      AND status = 'issued'
      AND revision = json_extract($payload, '$.expectedRevision')
  `),
  entry(S.updateLoanItemReturnCondition, `
    UPDATE loan_items
    SET condition_return = json_extract($payload, '$.conditionReturn'),
        updated_at = json_extract($payload, '$.updatedAt')
    WHERE loan_id = json_extract($payload, '$.loanId')
      AND position = json_extract($payload, '$.position')
  `),
  entry(S.markConfirmationNotificationsRead, `
    UPDATE portal_notifications
    SET read_at = COALESCE(read_at, json_extract($payload, '$.readAt'))
    WHERE entity_type = 'loan_return_confirmation'
      AND entity_id = json_extract($payload, '$.confirmationId')
  `),
  entry(S.markRecipientConfirmationNotificationRead, `
    UPDATE portal_notifications
    SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE recipient_employee_number = json_extract($payload, '$.employeeNumber')
      AND entity_type = 'loan_return_confirmation'
      AND entity_id = json_extract($payload, '$.confirmationId')
  `),

  entry(S.listProtectedLoanDocuments, `
    SELECT ${jsonObject({
      id: "id",
      storage_key: "storage_key",
      byte_size: "byte_size",
      sha256: "sha256",
      detected_mime: "detected_mime",
      filename: "filename",
    })}
    FROM loan_documents
  `),
  entry(S.listProtectedLoanPhotos, `
    SELECT ${jsonObject({
      id: "id",
      storage_key: "storage_key",
      byte_size: "byte_size",
      sha256: "sha256",
      detected_mime: "detected_mime",
      filename: "filename",
    })}
    FROM loan_photos
    WHERE original_retained = 1
  `),
  entry(S.listProtectedLoanPhotoAttachments, `
    SELECT ${jsonObject({
      id: "id",
      storage_key: "storage_key",
      byte_size: "byte_size",
      sha256: "sha256",
      detected_mime: "detected_mime",
      filename: "filename",
    })}
    FROM loan_photo_attachments
  `),
  entry(S.listLoanDocumentStorageKeys, `
    SELECT ${jsonObject({ storage_key: "storage_key" })}
    FROM loan_documents
  `),
  entry(S.listLoanPhotoStorageKeys, `
    SELECT ${jsonObject({ storage_key: "storage_key" })}
    FROM loan_photos
    WHERE original_retained = 1
  `),
  entry(S.listLoanPhotoAttachmentStorageKeys, `
    SELECT ${jsonObject({ storage_key: "storage_key" })}
    FROM loan_photo_attachments
  `),
]);

module.exports = {
  SQLITE_LOAN_MODULE_CATALOG,
};
