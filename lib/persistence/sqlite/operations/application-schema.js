"use strict";

const {
  ensureSqliteWorkRuleStoreSchema,
} = require("./work-rule-store-schema");
const {
  ensureSqlitePersonnelLifecycleSchema,
  ensureSqlitePersonnelLifecycleScopedRightsSchema,
} = require("./personnel-lifecycle-schema");
const {
  ensureSqlitePersonnelWorkflowSchema,
} = require("./personnel-workflow-schema");
const {
  ensureSqlitePersonnelWorkflowInstanceSchema,
} = require("./personnel-workflow-instance-schema");
const {
  ensureSqlitePersonnelLifecycleCaseSchema,
} = require("./personnel-lifecycle-case-schema");
const {
  ensureSqlitePersonnelLifecycleOnboardingSchema,
  inspectSqlitePersonnelLifecycleOnboardingSchema,
} = require("./personnel-lifecycle-onboarding-schema");
const {
  ensureSqlitePersonnelLifecycleOffboardingSchema,
} = require("./personnel-lifecycle-offboarding-schema");
const {
  ensureSqlitePersonnelDocumentHistorySchema,
} = require("./personnel-document-history-schema");
const {
  ensureSqlitePersonnelLearningSchema,
} = require("./personnel-learning-schema");
const {
  ensureSqlitePersonnelLearningCompetencySchema,
} = require("./personnel-learning-competency-schema");
const {
  ensureSqlitePersonnelLearningAssignmentSchema,
} = require("./personnel-learning-assignment-schema");
const {
  ensureSqlitePersonnelLearningProgressSchema,
} = require("./personnel-learning-progress-schema");
const {
  ensureSqliteStaffAssignmentRequestSchema,
} = require("./staff-assignment-request-schema");
const {
  ensureSqlitePortalBirthdayPresentationSchema,
} = require("./portal-birthday-presentation-schema");
const {
  ensureSqlitePortalBirthdayPresentationClaimSchema,
} = require("./portal-birthday-presentation-claim-schema");
const {
  ensureSqliteSalesAnalyticsSchema,
} = require("./sales-analytics-schema");

const PERSONAL_NOTIFICATION_CONTACT_COLUMNS = Object.freeze([
  Object.freeze({ name: "employee_number", type: "TEXT", notNull: 0, primaryKey: 1, defaultValue: null }),
  Object.freeze({ name: "email_target_fingerprint", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: "''" }),
  Object.freeze({ name: "phone_target_fingerprint", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: "''" }),
  Object.freeze({ name: "email_verified_at", type: "TEXT", notNull: 0, primaryKey: 0, defaultValue: null }),
  Object.freeze({ name: "phone_verified_at", type: "TEXT", notNull: 0, primaryKey: 0, defaultValue: null }),
  Object.freeze({ name: "email_enabled", type: "INTEGER", notNull: 1, primaryKey: 0, defaultValue: "0" }),
  Object.freeze({ name: "sms_enabled", type: "INTEGER", notNull: 1, primaryKey: 0, defaultValue: "0" }),
  Object.freeze({ name: "whatsapp_enabled", type: "INTEGER", notNull: 1, primaryKey: 0, defaultValue: "0" }),
  Object.freeze({ name: "earliest_time", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: "'08:00'" }),
  Object.freeze({ name: "verification_target", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: "''" }),
  Object.freeze({ name: "verification_channel", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: "''" }),
  Object.freeze({ name: "verification_target_fingerprint", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: "''" }),
  Object.freeze({ name: "verification_hash", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: "''" }),
  Object.freeze({ name: "verification_salt", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: "''" }),
  Object.freeze({ name: "verification_generation", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: "''" }),
  Object.freeze({ name: "verification_expires_at", type: "TEXT", notNull: 0, primaryKey: 0, defaultValue: null }),
  Object.freeze({ name: "verification_attempts", type: "INTEGER", notNull: 1, primaryKey: 0, defaultValue: "0" }),
  Object.freeze({ name: "verification_sent_at", type: "TEXT", notNull: 0, primaryKey: 0, defaultValue: null }),
  Object.freeze({ name: "verification_rate_window_started_at", type: "TEXT", notNull: 0, primaryKey: 0, defaultValue: null }),
  Object.freeze({ name: "verification_rate_count", type: "INTEGER", notNull: 1, primaryKey: 0, defaultValue: "0" }),
  Object.freeze({ name: "created_at", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: "CURRENT_TIMESTAMP" }),
  Object.freeze({ name: "updated_at", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: "CURRENT_TIMESTAMP" }),
]);

function normalizedSqliteDefault(value) {
  if (value === null || value === undefined) return null;
  let normalized = String(value).trim();
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized.toUpperCase();
}

function inspectSqlitePersonalNotificationContactsSchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  const table = database.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'personal_notification_contacts'
    LIMIT 1
  `).get();
  if (!table) {
    return Object.freeze({ exists: false, valid: false, issues: Object.freeze(["table_missing"]) });
  }

  const issues = [];
  const columns = database.prepare("PRAGMA table_info(personal_notification_contacts)").all();
  const columnsByName = new Map(columns.map((column) => [String(column.name || ""), column]));
  for (const expected of PERSONAL_NOTIFICATION_CONTACT_COLUMNS) {
    const actual = columnsByName.get(expected.name);
    if (!actual) {
      issues.push(`column_missing:${expected.name}`);
      continue;
    }
    if (String(actual.type || "").trim().toUpperCase() !== expected.type) {
      issues.push(`column_type:${expected.name}`);
    }
    if (Number(actual.notnull || 0) !== expected.notNull) {
      issues.push(`column_nullability:${expected.name}`);
    }
    if (Number(actual.pk || 0) !== expected.primaryKey) {
      issues.push(`column_primary_key:${expected.name}`);
    }
    if (normalizedSqliteDefault(actual.dflt_value) !== normalizedSqliteDefault(expected.defaultValue)) {
      issues.push(`column_default:${expected.name}`);
    }
  }
  if (columns.length !== PERSONAL_NOTIFICATION_CONTACT_COLUMNS.length) {
    issues.push("column_shape");
  }
  if (columns.filter((column) => Number(column.pk || 0) > 0).length !== 1) {
    issues.push("primary_key_shape");
  }

  const foreignKeys = database.prepare("PRAGMA foreign_key_list(personal_notification_contacts)").all();
  const employeeForeignKeyValid = foreignKeys.some((foreignKey) => (
    String(foreignKey.table || "") === "employees"
    && String(foreignKey.from || "") === "employee_number"
    && String(foreignKey.to || "") === "personnel_number"
    && String(foreignKey.on_update || "").toUpperCase() === "CASCADE"
    && String(foreignKey.on_delete || "").toUpperCase() === "CASCADE"
  ));
  if (!employeeForeignKeyValid) issues.push("employee_foreign_key");

  const tableSql = String(table.sql || "");
  for (const column of ["email_enabled", "sms_enabled", "whatsapp_enabled"]) {
    const pattern = new RegExp(`CHECK\\s*\\(\\s*(?:"${column}"|${column})\\s+IN\\s*\\(\\s*0\\s*,\\s*1\\s*\\)\\s*\\)`, "i");
    if (!pattern.test(tableSql)) issues.push(`${column}_check`);
  }
  if (!/CHECK\s*\(\s*(?:"verification_target"|verification_target)\s+IN\s*\(\s*''\s*,\s*'email'\s*,\s*'phone'\s*\)\s*\)/i.test(tableSql)) {
    issues.push("verification_target_check");
  }
  if (!/CHECK\s*\(\s*(?:"verification_channel"|verification_channel)\s+IN\s*\(\s*''\s*,\s*'email'\s*,\s*'sms'\s*,\s*'whatsapp'\s*\)\s*\)/i.test(tableSql)) {
    issues.push("verification_channel_check");
  }
  if (!/CHECK\s*\(\s*(?:"earliest_time"|earliest_time)\s+GLOB\s+'\[0-2\]\[0-9\]:\[0-5\]\[0-9\]'/i.test(tableSql)) {
    issues.push("earliest_time_check");
  }

  return Object.freeze({
    exists: true,
    valid: issues.length === 0,
    issues: Object.freeze(issues),
  });
}

function inspectSqlitePersonalNotificationContactRows(database) {
  const schema = inspectSqlitePersonalNotificationContactsSchema(database);
  if (!schema.valid) return Object.freeze({ valid: false, count: 0, issues: schema.issues });
  const rows = database.prepare(`
    SELECT *
    FROM personal_notification_contacts
    ORDER BY employee_number
  `).all();
  const issues = [];
  const fingerprintValid = (value) => value === "" || /^[0-9a-f]{64}$/.test(String(value || ""));
  for (const row of rows) {
    const employeeNumber = String(row.employee_number || "");
    const prefix = employeeNumber ? `row:${employeeNumber}` : "row:missing_employee";
    if (!employeeNumber) issues.push(prefix);
    if (!fingerprintValid(row.email_target_fingerprint)) issues.push(`${prefix}:email_fingerprint`);
    if (!fingerprintValid(row.phone_target_fingerprint)) issues.push(`${prefix}:phone_fingerprint`);
    if (!fingerprintValid(row.verification_target_fingerprint)) issues.push(`${prefix}:verification_fingerprint`);
    if (row.email_verified_at && !row.email_target_fingerprint) issues.push(`${prefix}:email_verification_without_target`);
    if (row.phone_verified_at && !row.phone_target_fingerprint) issues.push(`${prefix}:phone_verification_without_target`);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(row.earliest_time || ""))) {
      issues.push(`${prefix}:earliest_time`);
    }
    const pending = Boolean(row.verification_target);
    if (pending) {
      const expectedFingerprint = row.verification_target === "email"
        ? row.email_target_fingerprint : row.phone_target_fingerprint;
      const channelMatches = row.verification_target === "email"
        ? row.verification_channel === "email"
        : ["sms", "whatsapp"].includes(row.verification_channel);
      if (!channelMatches || !row.verification_target_fingerprint
        || row.verification_target_fingerprint !== expectedFingerprint
        || !row.verification_generation || !row.verification_hash || !row.verification_salt
        || !row.verification_expires_at) {
        issues.push(`${prefix}:verification_state`);
      }
    } else if (row.verification_channel || row.verification_target_fingerprint
      || row.verification_generation || row.verification_hash || row.verification_salt
      || row.verification_expires_at || Number(row.verification_attempts || 0) !== 0) {
      issues.push(`${prefix}:orphaned_verification_state`);
    }
  }
  return Object.freeze({
    valid: issues.length === 0,
    count: rows.length,
    issues: Object.freeze(issues),
  });
}

const PERSONAL_NOTIFICATION_CONTACTS_CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS personal_notification_contacts (
    employee_number TEXT PRIMARY KEY,
    email_target_fingerprint TEXT NOT NULL DEFAULT '',
    phone_target_fingerprint TEXT NOT NULL DEFAULT '',
    email_verified_at TEXT,
    phone_verified_at TEXT,
    email_enabled INTEGER NOT NULL DEFAULT 0 CHECK(email_enabled IN (0,1)),
    sms_enabled INTEGER NOT NULL DEFAULT 0 CHECK(sms_enabled IN (0,1)),
    whatsapp_enabled INTEGER NOT NULL DEFAULT 0 CHECK(whatsapp_enabled IN (0,1)),
    earliest_time TEXT NOT NULL DEFAULT '08:00'
      CHECK(earliest_time GLOB '[0-2][0-9]:[0-5][0-9]'
        AND CAST(SUBSTR(earliest_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23),
    verification_target TEXT NOT NULL DEFAULT '' CHECK(verification_target IN ('','email','phone')),
    verification_channel TEXT NOT NULL DEFAULT '' CHECK(verification_channel IN ('','email','sms','whatsapp')),
    verification_target_fingerprint TEXT NOT NULL DEFAULT '',
    verification_hash TEXT NOT NULL DEFAULT '',
    verification_salt TEXT NOT NULL DEFAULT '',
    verification_generation TEXT NOT NULL DEFAULT '',
    verification_expires_at TEXT,
    verification_attempts INTEGER NOT NULL DEFAULT 0,
    verification_sent_at TEXT,
    verification_rate_window_started_at TEXT,
    verification_rate_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
      ON UPDATE CASCADE ON DELETE CASCADE
  );
`;

function assertSqliteOperationsDatabase(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  return database;
}

function ensureSqliteApplicationSchema(database) {
  const sqliteDatabase = assertSqliteOperationsDatabase(database);
  ensureSqliteWorkRuleStoreSchema(sqliteDatabase);
  sqliteDatabase.exec(`
    CREATE TABLE IF NOT EXISTS cost_center_types (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL COLLATE NOCASE UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_branch INTEGER NOT NULL DEFAULT 0 CHECK(is_branch IN (0,1)),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      builtin INTEGER NOT NULL DEFAULT 0 CHECK(builtin IN (0,1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cost_centers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL COLLATE NOCASE UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'other'
        CHECK(type IN ('branch','administration','production','other')),
      cost_center_type_id TEXT,
      description TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cost_center_type_id) REFERENCES cost_center_types(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cost_center_id TEXT,
      min_staff INTEGER NOT NULL DEFAULT 0,
      day_settings_json TEXT NOT NULL DEFAULT '',
      time_tracking_enabled INTEGER NOT NULL DEFAULT 0,
      time_tracking_access_mode TEXT NOT NULL DEFAULT 'anywhere',
      time_tracking_allowed_networks TEXT NOT NULL DEFAULT '',
      time_tracking_variance_minutes INTEGER NOT NULL DEFAULT 15,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cost_center_id) REFERENCES cost_centers(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS location_branding (
      location_id TEXT PRIMARY KEY,
      kit_id TEXT NOT NULL DEFAULT 'custom',
      company_name TEXT NOT NULL DEFAULT '',
      logo_url TEXT NOT NULL DEFAULT '/assets/grabenplaner-logo.svg',
      icon_url TEXT NOT NULL DEFAULT '/assets/webicon.svg',
      logo_alt TEXT NOT NULL DEFAULT 'Grabenplaner',
      admin_email TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT NOT NULL,
      name TEXT NOT NULL,
      min_staff INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(location_id, name),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS employees (
      personnel_number TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      nickname TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#0b84c6',
      contracted_hours REAL NOT NULL DEFAULT 38.5,
      target_workdays_per_week INTEGER NOT NULL DEFAULT 5,
      preferred_day_off TEXT,
      fixed_workdays TEXT NOT NULL DEFAULT '',
      position_id TEXT NOT NULL DEFAULT 'verkaufsmitarbeiter',
      time_confirmation_level TEXT NOT NULL DEFAULT 'C',
      sickness_without_aum_enabled INTEGER NOT NULL DEFAULT 0,
      home_location_id TEXT,
      preferred_department_id INTEGER,
      cost_center_id TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (home_location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE SET NULL,
      FOREIGN KEY (preferred_department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE SET NULL,
      FOREIGN KEY (cost_center_id) REFERENCES cost_centers(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    DROP TRIGGER IF EXISTS trg_employees_reserved_principal_insert;
    DROP TRIGGER IF EXISTS trg_employees_reserved_principal_update;

    CREATE TRIGGER trg_employees_reserved_principal_insert
    BEFORE INSERT ON employees
    WHEN LOWER(TRIM(
      NEW.personnel_number,
      CHAR(9) || CHAR(10) || CHAR(11) || CHAR(12) || CHAR(13) || CHAR(32)
    )) = 'local'
    BEGIN
      SELECT RAISE(ABORT, 'employee principal local is reserved');
    END;

    CREATE TRIGGER trg_employees_reserved_principal_update
    BEFORE UPDATE OF personnel_number ON employees
    WHEN LOWER(TRIM(
      NEW.personnel_number,
      CHAR(9) || CHAR(10) || CHAR(11) || CHAR(12) || CHAR(13) || CHAR(32)
    )) = 'local'
    BEGIN
      SELECT RAISE(ABORT, 'employee principal local is reserved');
    END;

    CREATE TABLE IF NOT EXISTS articles (
      article_number TEXT PRIMARY KEY
        CHECK(length(article_number) = 6 AND article_number NOT GLOB '*[^0-9]*'),
      description TEXT NOT NULL DEFAULT '',
      source_provider TEXT NOT NULL DEFAULT 'manual'
        CHECK(source_provider IN ('manual','shopware_storefront','import')),
      source_product_number TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      source_fetched_at TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_articles_active_description
      ON articles(active, description, article_number);

    CREATE TABLE IF NOT EXISTS article_identifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_number TEXT NOT NULL,
      identifier_type TEXT NOT NULL
        CHECK(identifier_type IN ('ean8','upca','ean13','gtin14')),
      identifier_value TEXT NOT NULL
        CHECK(length(identifier_value) BETWEEN 8 AND 14
          AND identifier_value NOT GLOB '*[^0-9]*'),
      source_provider TEXT NOT NULL DEFAULT 'manual'
        CHECK(source_provider IN ('manual','shopware_storefront','import')),
      verified_at TEXT,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(identifier_type, identifier_value),
      FOREIGN KEY (article_number) REFERENCES articles(article_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_article_identifiers_article
      ON article_identifiers(article_number, identifier_type, identifier_value);

    CREATE TABLE IF NOT EXISTS loan_location_settings (
      location_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      article_lookup_enabled INTEGER NOT NULL DEFAULT 0 CHECK(article_lookup_enabled IN (0,1)),
      article_lookup_provider TEXT NOT NULL DEFAULT 'none'
        CHECK(article_lookup_provider IN ('none','shopware_storefront')),
      article_lookup_base_url TEXT NOT NULL DEFAULT '',
      document_recipient_employee_number TEXT,
      document_email_enabled INTEGER NOT NULL DEFAULT 0 CHECK(document_email_enabled IN (0,1)),
      document_recipient_email TEXT NOT NULL DEFAULT '',
      photo_pdf_output_mode TEXT NOT NULL DEFAULT 'grayscale'
        CHECK(photo_pdf_output_mode IN ('grayscale','blackwhite')),
      photo_original_retention TEXT NOT NULL DEFAULT 'retain'
        CHECK(photo_original_retention IN ('retain','delete')),
      branch_overview_columns TEXT NOT NULL DEFAULT '["borrowerName","description","articleNumber","serialNumber","dueDate"]',
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (document_recipient_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS loans (
      id TEXT PRIMARY KEY,
      legacy_id INTEGER,
      location_id TEXT NOT NULL,
      borrower_employee_number TEXT NOT NULL,
      created_by_employee_number TEXT NOT NULL,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','issued','returned','cancelled')),
      notes TEXT NOT NULL DEFAULT '',
      issued_at TEXT,
      returned_at TEXT,
      return_recorded_by_employee_number TEXT,
      return_witness_employee_number TEXT,
      borrower_return_confirmed INTEGER NOT NULL DEFAULT 0
        CHECK(borrower_return_confirmed IN (0,1)),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (borrower_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (created_by_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (return_recorded_by_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE SET NULL,
      FOREIGN KEY (return_witness_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_loans_borrower_status
      ON loans(borrower_employee_number, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_loans_location_status
      ON loans(location_id, status, created_at);

    CREATE TABLE IF NOT EXISTS loan_items (
      id TEXT PRIMARY KEY,
      loan_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 5),
      article_number TEXT NOT NULL,
      description_snapshot TEXT NOT NULL,
      serial_number TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity = 1),
      condition_out TEXT NOT NULL DEFAULT '',
      condition_return TEXT NOT NULL DEFAULT '',
      item_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(loan_id, position),
      FOREIGN KEY (loan_id) REFERENCES loans(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (article_number) REFERENCES articles(article_number)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_loan_items_article
      ON loan_items(article_number, loan_id);

    CREATE TABLE IF NOT EXISTS loan_return_confirmations (
      id TEXT PRIMARY KEY,
      loan_id TEXT NOT NULL,
      requested_by_employee_number TEXT NOT NULL,
      witness_employee_number TEXT NOT NULL,
      expected_revision INTEGER NOT NULL CHECK(expected_revision >= 1),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','confirmed','rejected','expired','cancelled')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      responded_at TEXT,
      response_note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (loan_id) REFERENCES loans(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (requested_by_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (witness_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_return_confirmations_pending
      ON loan_return_confirmations(loan_id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_loan_return_confirmations_witness
      ON loan_return_confirmations(witness_employee_number, status, requested_at);

    CREATE TABLE IF NOT EXISTS loan_return_preparations (
      loan_id TEXT PRIMARY KEY,
      requested_by_employee_number TEXT NOT NULL,
      expected_revision INTEGER NOT NULL CHECK(expected_revision >= 1),
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      prepared_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(loan_id) REFERENCES loans(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY(requested_by_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_loan_return_preparations_requester
      ON loan_return_preparations(requested_by_employee_number, updated_at);

    CREATE TABLE IF NOT EXISTS loan_documents (
      id TEXT PRIMARY KEY,
      loan_id TEXT NOT NULL,
      document_type TEXT NOT NULL CHECK(document_type IN ('issue','return')),
      loan_revision INTEGER NOT NULL CHECK(loan_revision >= 1),
      storage_key TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      detected_mime TEXT NOT NULL DEFAULT 'application/pdf'
        CHECK(detected_mime = 'application/pdf'),
      byte_size INTEGER NOT NULL CHECK(byte_size > 0),
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
      created_by_employee_number TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(loan_id, document_type, loan_revision),
      FOREIGN KEY (loan_id) REFERENCES loans(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (created_by_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_loan_documents_loan
      ON loan_documents(loan_id, created_at, document_type);

    CREATE TRIGGER IF NOT EXISTS trg_loan_documents_immutable_update
    BEFORE UPDATE ON loan_documents
    BEGIN
      SELECT RAISE(ABORT, 'loan documents are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_loan_documents_immutable_delete
    BEFORE DELETE ON loan_documents
    BEGIN
      SELECT RAISE(ABORT, 'loan documents are immutable');
    END;

    CREATE TABLE IF NOT EXISTS loan_photos (
      id TEXT PRIMARY KEY,
      loan_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('issue','return')),
      position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 9),
      storage_key TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      detected_mime TEXT NOT NULL DEFAULT 'image/jpeg'
        CHECK(detected_mime = 'image/jpeg'),
      byte_size INTEGER NOT NULL CHECK(byte_size > 0),
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
      pixel_width INTEGER NOT NULL CHECK(pixel_width > 0),
      pixel_height INTEGER NOT NULL CHECK(pixel_height > 0),
      original_retained INTEGER NOT NULL DEFAULT 1 CHECK(original_retained IN (0,1)),
      original_deleted_at TEXT,
      original_deletion_reason TEXT NOT NULL DEFAULT '',
      created_by_employee_number TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(loan_id, phase, position),
      FOREIGN KEY (loan_id) REFERENCES loans(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (created_by_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_loan_photos_loan
      ON loan_photos(loan_id, phase, position);

    CREATE TRIGGER IF NOT EXISTS trg_loan_photos_immutable_update
    BEFORE UPDATE ON loan_photos
    BEGIN
      SELECT RAISE(ABORT, 'loan photos are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_loan_photos_immutable_delete
    BEFORE DELETE ON loan_photos
    BEGIN
      SELECT RAISE(ABORT, 'loan photos are immutable');
    END;

    CREATE TABLE IF NOT EXISTS loan_photo_attachments (
      id TEXT PRIMARY KEY,
      loan_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('issue','return')),
      attachment_revision INTEGER NOT NULL CHECK(attachment_revision >= 1),
      source_photo_count INTEGER NOT NULL CHECK(source_photo_count BETWEEN 1 AND 9),
      source_photo_ids_json TEXT NOT NULL DEFAULT '[]',
      source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint) = 64),
      output_mode TEXT NOT NULL CHECK(output_mode IN ('grayscale','blackwhite')),
      original_retention TEXT NOT NULL CHECK(original_retention IN ('retain','delete')),
      storage_key TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      detected_mime TEXT NOT NULL DEFAULT 'application/pdf'
        CHECK(detected_mime = 'application/pdf'),
      byte_size INTEGER NOT NULL CHECK(byte_size > 0),
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
      created_by_employee_number TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(loan_id, phase, attachment_revision),
      FOREIGN KEY (loan_id) REFERENCES loans(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (created_by_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_loan_photo_attachments_loan
      ON loan_photo_attachments(loan_id, phase, attachment_revision);

    CREATE TRIGGER IF NOT EXISTS trg_loan_photo_attachments_immutable_update
    BEFORE UPDATE ON loan_photo_attachments
    BEGIN
      SELECT RAISE(ABORT, 'loan photo attachments are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_loan_photo_attachments_immutable_delete
    BEFORE DELETE ON loan_photo_attachments
    BEGIN
      SELECT RAISE(ABORT, 'loan photo attachments are immutable');
    END;

    CREATE TABLE IF NOT EXISTS loan_document_deliveries (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('internal','email')),
      recipient_employee_number TEXT,
      recipient_address TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('sent','failed')),
      error_code TEXT NOT NULL DEFAULT '',
      attempted_by_employee_number TEXT,
      attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (document_id) REFERENCES loan_documents(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (recipient_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE SET NULL,
      FOREIGN KEY (attempted_by_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_loan_document_deliveries_document
      ON loan_document_deliveries(document_id, attempted_at, channel);

    CREATE TRIGGER IF NOT EXISTS trg_loan_document_deliveries_immutable_update
    BEFORE UPDATE ON loan_document_deliveries
    BEGIN
      SELECT RAISE(ABORT, 'loan document deliveries are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_loan_document_deliveries_immutable_delete
    BEFORE DELETE ON loan_document_deliveries
    BEGIN
      SELECT RAISE(ABORT, 'loan document deliveries are immutable');
    END;

    CREATE TABLE IF NOT EXISTS loan_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_id TEXT NOT NULL,
      actor_employee_number TEXT,
      event_type TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (loan_id) REFERENCES loans(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (actor_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_loan_events_loan_revision
      ON loan_events(loan_id, revision, created_at);

    CREATE TRIGGER IF NOT EXISTS trg_loan_events_immutable_update
    BEFORE UPDATE ON loan_events
    BEGIN
      SELECT RAISE(ABORT, 'loan events are immutable');
    END;

    CREATE TABLE IF NOT EXISTS loan_migration_runs (
      id TEXT PRIMARY KEY,
      source_system TEXT NOT NULL CHECK(source_system = 'f18-lagerware'),
      source_fingerprint TEXT NOT NULL UNIQUE CHECK(length(source_fingerprint) = 64),
      source_version TEXT NOT NULL DEFAULT '',
      source_created_at TEXT,
      location_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed' CHECK(status = 'completed'),
      employee_count INTEGER NOT NULL DEFAULT 0 CHECK(employee_count >= 0),
      loan_count INTEGER NOT NULL DEFAULT 0 CHECK(loan_count >= 0),
      item_count INTEGER NOT NULL DEFAULT 0 CHECK(item_count >= 0),
      photo_count INTEGER NOT NULL DEFAULT 0 CHECK(photo_count >= 0),
      open_loan_count INTEGER NOT NULL DEFAULT 0 CHECK(open_loan_count >= 0),
      returned_loan_count INTEGER NOT NULL DEFAULT 0 CHECK(returned_loan_count >= 0),
      warnings_json TEXT NOT NULL DEFAULT '[]',
      imported_by_employee_number TEXT,
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_system, location_id),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS loan_migration_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      source_loan_id INTEGER NOT NULL,
      source_record_hash TEXT NOT NULL CHECK(length(source_record_hash) = 64),
      target_loan_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, source_loan_id),
      FOREIGN KEY (run_id) REFERENCES loan_migration_runs(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (target_loan_id) REFERENCES loans(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_loan_migration_runs_location
      ON loan_migration_runs(location_id, completed_at);

    CREATE TRIGGER IF NOT EXISTS trg_loan_migration_runs_immutable_update
    BEFORE UPDATE ON loan_migration_runs
    BEGIN
      SELECT RAISE(ABORT, 'loan migration runs are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_loan_migration_runs_immutable_delete
    BEFORE DELETE ON loan_migration_runs
    BEGIN
      SELECT RAISE(ABORT, 'loan migration runs are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_loan_migration_records_immutable_update
    BEFORE UPDATE ON loan_migration_records
    BEGIN
      SELECT RAISE(ABORT, 'loan migration records are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_loan_migration_records_immutable_delete
    BEFORE DELETE ON loan_migration_records
    BEGIN
      SELECT RAISE(ABORT, 'loan migration records are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_loan_events_immutable_delete
    BEFORE DELETE ON loan_events
    BEGIN
      SELECT RAISE(ABORT, 'loan events are immutable');
    END;

    CREATE TABLE IF NOT EXISTS personnel_sensitive_records (
      employee_number TEXT PRIMARY KEY,
      social_security_lookup TEXT NOT NULL DEFAULT '',
      protected_payload TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_personnel_sensitive_sv_lookup
      ON personnel_sensitive_records(social_security_lookup)
      WHERE TRIM(social_security_lookup) <> '';

    CREATE TABLE IF NOT EXISTS personnel_record_documents (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      protected_payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_by TEXT,
      deleted_at TEXT,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_personnel_record_documents_employee
      ON personnel_record_documents(employee_number, status, created_at);

    CREATE TABLE IF NOT EXISTS personnel_field_permissions (
      role_id TEXT NOT NULL,
      field_key TEXT NOT NULL,
      access_level TEXT NOT NULL CHECK (access_level IN ('hidden','read','write')),
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (role_id, field_key),
      CHECK (role_id IN ('manager','department_manager'))
    );

    CREATE INDEX IF NOT EXISTS idx_personnel_field_permissions_role
      ON personnel_field_permissions(role_id, field_key);

    CREATE INDEX IF NOT EXISTS idx_cost_centers_active_sort
      ON cost_centers(active, sort_order, code);

    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      builtin INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
      employment_classification TEXT NOT NULL DEFAULT 'standard'
        CHECK(employment_classification IN ('standard','apprentice')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_by TEXT,
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS cost_center_type_positions (
      cost_center_type_id TEXT NOT NULL,
      position_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (cost_center_type_id, position_id),
      FOREIGN KEY (cost_center_type_id) REFERENCES cost_center_types(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (position_id) REFERENCES positions(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_cost_center_types_active_sort
      ON cost_center_types(active, sort_order, name);

    CREATE INDEX IF NOT EXISTS idx_cost_center_type_positions_position
      ON cost_center_type_positions(position_id, cost_center_type_id);

    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      location_id TEXT,
      department_id INTEGER,
      shift_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      area TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(shift_date);
    CREATE INDEX IF NOT EXISTS idx_shifts_employee ON shifts(employee_number);

    CREATE TABLE IF NOT EXISTS employee_location_lendings (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      home_location_id TEXT NOT NULL,
      destination_location_id TEXT NOT NULL,
      destination_department_id INTEGER,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 1 CHECK (all_day IN (0, 1)),
      start_time TEXT,
      end_time TEXT,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      cancelled_by TEXT,
      cancelled_at TEXT,
      CHECK (home_location_id <> destination_location_id),
      CHECK (date_to >= date_from),
      CHECK (
        (all_day = 1 AND start_time IS NULL AND end_time IS NULL)
        OR
        (all_day = 0 AND date_from = date_to AND start_time IS NOT NULL
          AND end_time IS NOT NULL AND end_time > start_time)
      ),
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (home_location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (destination_location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (destination_department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_employee_location_lendings_employee_period
      ON employee_location_lendings(employee_number, status, date_from, date_to);
    CREATE INDEX IF NOT EXISTS idx_employee_location_lendings_home_period
      ON employee_location_lendings(home_location_id, status, date_from, date_to);
    CREATE INDEX IF NOT EXISTS idx_employee_location_lendings_destination_period
      ON employee_location_lendings(destination_location_id, status, date_from, date_to);

    CREATE TRIGGER IF NOT EXISTS trg_employee_location_lendings_department_insert
    BEFORE INSERT ON employee_location_lendings
    WHEN NEW.destination_department_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM departments
        WHERE id = NEW.destination_department_id
          AND location_id = NEW.destination_location_id
          AND active = 1
      )
    BEGIN
      SELECT RAISE(ABORT, 'EMPLOYEE_LENDING_DEPARTMENT_INVALID');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_employee_location_lendings_department_update
    BEFORE UPDATE OF destination_location_id, destination_department_id ON employee_location_lendings
    WHEN NEW.destination_department_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM departments
        WHERE id = NEW.destination_department_id
          AND location_id = NEW.destination_location_id
          AND active = 1
      )
    BEGIN
      SELECT RAISE(ABORT, 'EMPLOYEE_LENDING_DEPARTMENT_INVALID');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_employee_location_lendings_overlap_insert
    BEFORE INSERT ON employee_location_lendings
    WHEN NEW.status = 'active' AND EXISTS (
      SELECT 1
      FROM employee_location_lendings existing
      WHERE existing.employee_number = NEW.employee_number
        AND existing.status = 'active'
        AND julianday(
          NEW.date_from || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.start_time END
        ) < julianday(
          existing.date_to || ' ' || CASE WHEN existing.all_day = 1 THEN '00:00' ELSE existing.end_time END,
          CASE WHEN existing.all_day = 1 THEN '+1 day' ELSE '+0 day' END
        )
        AND julianday(
          existing.date_from || ' ' || CASE WHEN existing.all_day = 1 THEN '00:00' ELSE existing.start_time END
        ) < julianday(
          NEW.date_to || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.end_time END,
          CASE WHEN NEW.all_day = 1 THEN '+1 day' ELSE '+0 day' END
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'EMPLOYEE_LENDING_OVERLAP');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_employee_location_lendings_overlap_update
    BEFORE UPDATE OF employee_number, date_from, date_to, all_day, start_time, end_time, status
      ON employee_location_lendings
    WHEN NEW.status = 'active' AND EXISTS (
      SELECT 1
      FROM employee_location_lendings existing
      WHERE existing.id <> NEW.id
        AND existing.employee_number = NEW.employee_number
        AND existing.status = 'active'
        AND julianday(
          NEW.date_from || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.start_time END
        ) < julianday(
          existing.date_to || ' ' || CASE WHEN existing.all_day = 1 THEN '00:00' ELSE existing.end_time END,
          CASE WHEN existing.all_day = 1 THEN '+1 day' ELSE '+0 day' END
        )
        AND julianday(
          existing.date_from || ' ' || CASE WHEN existing.all_day = 1 THEN '00:00' ELSE existing.start_time END
        ) < julianday(
          NEW.date_to || ' ' || CASE WHEN NEW.all_day = 1 THEN '00:00' ELSE NEW.end_time END,
          CASE WHEN NEW.all_day = 1 THEN '+1 day' ELSE '+0 day' END
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'EMPLOYEE_LENDING_OVERLAP');
    END;

    CREATE TABLE IF NOT EXISTS week_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      group_id TEXT,
      week_start TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      option_type TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      credited_minutes_per_day INTEGER,
      all_day INTEGER NOT NULL DEFAULT 1,
      start_time TEXT,
      end_time TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_week_options_week ON week_options(week_start);

    CREATE TABLE IF NOT EXISTS global_day_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT NOT NULL DEFAULT '01',
      week_start TEXT NOT NULL,
      block_date TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      is_public_holiday INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(location_id, block_date),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_global_day_blocks_week ON global_day_blocks(week_start);

    CREATE TABLE IF NOT EXISTS vacation_entitlements (
      employee_number TEXT NOT NULL,
      year INTEGER NOT NULL,
      days REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, year),
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pdf_settings (
      scope_type TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_key TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (scope_type, location_id, department_key, key),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schedule_notes (
      location_id TEXT NOT NULL,
      department_key TEXT NOT NULL DEFAULT '',
      week_start TEXT NOT NULL,
      note_text TEXT NOT NULL DEFAULT '',
      note_html TEXT NOT NULL DEFAULT '',
      font_size TEXT NOT NULL DEFAULT 'medium',
      bold INTEGER NOT NULL DEFAULT 0,
      italic INTEGER NOT NULL DEFAULT 0,
      underline INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (location_id, department_key, week_start),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schedule_manual_locks (
      location_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0,1)),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (location_id, week_start),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_manual_locks_week
      ON schedule_manual_locks(week_start, location_id);

    CREATE TABLE IF NOT EXISTS portal_users (
      employee_number TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'employee',
      role_locked INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      password_changed_at TEXT,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      builtin INTEGER NOT NULL DEFAULT 0,
      permissions TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS portal_sessions (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_password_reset_tokens (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      email_fingerprint TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_organization_accounts (
      id TEXT PRIMARY KEY,
      login_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'branch'
        CHECK(account_type IN ('branch','terminal')),
      password_hash TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      must_change_password INTEGER NOT NULL DEFAULT 1 CHECK(must_change_password IN (0,1)),
      last_login_at TEXT,
      password_changed_at TEXT,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS portal_organization_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES portal_organization_accounts(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_organization_account_permissions (
      account_id TEXT NOT NULL,
      permission TEXT NOT NULL,
      granted_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (account_id, permission),
      FOREIGN KEY (account_id) REFERENCES portal_organization_accounts(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_organization_account_scopes (
      account_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id INTEGER NOT NULL DEFAULT 0 CHECK(department_id = 0),
      assigned_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (account_id, location_id, department_id),
      FOREIGN KEY (account_id) REFERENCES portal_organization_accounts(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_user_preferences (
      employee_number TEXT NOT NULL,
      preference_key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, preference_key),
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mobile_sessions (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      access_token_hash TEXT NOT NULL UNIQUE,
      access_expires_at TEXT NOT NULL,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      previous_refresh_token_hash TEXT,
      refresh_expires_at TEXT NOT NULL,
      installation_id_hash TEXT NOT NULL,
      platform TEXT NOT NULL,
      device_label TEXT NOT NULL DEFAULT '',
      app_version TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      revoked_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mobile_refresh_token_history (
      session_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      consumed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id, token_hash),
      FOREIGN KEY (session_id) REFERENCES mobile_sessions(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS maintenance_cleanup_receipts (
      operation_id TEXT PRIMARY KEY,
      cleanup_kind TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL UNIQUE
        CHECK(length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
      receipt_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL
        CHECK(length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
      created_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS trg_maintenance_cleanup_receipts_immutable_update
    BEFORE UPDATE ON maintenance_cleanup_receipts
    BEGIN
      SELECT RAISE(ABORT, 'maintenance cleanup receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_maintenance_cleanup_receipts_immutable_delete
    BEFORE DELETE ON maintenance_cleanup_receipts
    BEGIN
      SELECT RAISE(ABORT, 'maintenance cleanup receipts are immutable');
    END;

    CREATE TABLE IF NOT EXISTS mobile_mutation_receipts (
      employee_number TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('in_progress','completed')),
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      action_completed_at TEXT,
      http_status INTEGER,
      response_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (employee_number, idempotency_key),
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_access_scopes (
      employee_number TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id INTEGER NOT NULL DEFAULT 0,
      assigned_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, location_id, department_id),
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_permission_grants (
      employee_number TEXT NOT NULL,
      permission TEXT NOT NULL,
      granted_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, permission),
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_permission_denials (
      employee_number TEXT NOT NULL,
      permission TEXT NOT NULL,
      denied_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, permission),
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS amu_local_access_overrides (
      employee_number TEXT PRIMARY KEY,
      access_mode TEXT NOT NULL DEFAULT 'inherit'
        CHECK(access_mode IN ('inherit','allow','deny')),
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vacation_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS time_off_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      location_id TEXT,
      origin_location_id TEXT,
      review_department_id INTEGER,
      lending_id TEXT,
      request_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      traffic_light TEXT NOT NULL DEFAULT 'yellow',
      check_reason TEXT NOT NULL DEFAULT '',
      option_id INTEGER,
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (option_id) REFERENCES week_options(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS vacation_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      vacation_group_id TEXT NOT NULL,
      request_type TEXT NOT NULL,
      original_date_from TEXT NOT NULL,
      original_date_to TEXT NOT NULL,
      requested_date_from TEXT,
      requested_date_to TEXT,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS time_off_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      location_id TEXT,
      origin_location_id TEXT,
      review_department_id INTEGER,
      lending_id TEXT,
      original_request_id INTEGER NOT NULL,
      request_type TEXT NOT NULL,
      requested_date_from TEXT,
      requested_date_to TEXT,
      requested_all_day INTEGER NOT NULL DEFAULT 0,
      requested_start_time TEXT,
      requested_end_time TEXT,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending_local',
      approval_type TEXT NOT NULL DEFAULT 'local',
      approval_stage TEXT NOT NULL DEFAULT 'local',
      decision_note TEXT NOT NULL DEFAULT '',
      local_approved_by TEXT,
      local_approved_at TEXT,
      hr_approved_by TEXT,
      hr_approved_at TEXT,
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (original_request_id) REFERENCES time_off_requests(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS request_blackouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT NOT NULL,
      department_id INTEGER,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      block_vacation INTEGER NOT NULL DEFAULT 1,
      block_time_off INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS request_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_kind TEXT NOT NULL,
      request_id INTEGER NOT NULL,
      stage TEXT NOT NULL DEFAULT 'local',
      action TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS approval_delegations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT NOT NULL,
      delegate_employee_number TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (delegate_employee_number) REFERENCES employees(personnel_number) ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      location_id TEXT,
      department_id INTEGER,
      work_date TEXT NOT NULL DEFAULT '',
      entry_type TEXT NOT NULL,
      entry_timestamp TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'portal',
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      voided_at TEXT,
      voided_by TEXT,
      void_reason TEXT NOT NULL DEFAULT '',
      correction_id INTEGER,
      client_request_id TEXT,
      mobile_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE SET NULL,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS xoffi_time_imports (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL,
      department_id INTEGER,
      department_key INTEGER NOT NULL DEFAULT 0 CHECK (
        (department_id IS NULL AND department_key = 0)
        OR (department_id IS NOT NULL AND department_key = department_id)
      ),
      week_start TEXT NOT NULL,
      week_end TEXT NOT NULL CHECK (week_end = date(week_start, '+6 days')),
      source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
      source_file_name TEXT NOT NULL DEFAULT '',
      ocr_engine_version TEXT NOT NULL,
      use_as_actual INTEGER NOT NULL DEFAULT 1 CHECK (use_as_actual IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
      imported_by TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      superseded_by_import_id TEXT,
      superseded_by TEXT,
      superseded_at TEXT,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (superseded_by_import_id) REFERENCES xoffi_time_imports(id)
        ON UPDATE CASCADE ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );

    CREATE TABLE IF NOT EXISTS xoffi_time_employee_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id TEXT NOT NULL,
      employee_number TEXT NOT NULL,
      source_name TEXT NOT NULL,
      match_confidence INTEGER NOT NULL DEFAULT 0 CHECK (match_confidence BETWEEN 0 AND 100),
      weekly_actual_minutes INTEGER NOT NULL DEFAULT 0 CHECK (weekly_actual_minutes BETWEEN 0 AND 10080),
      weekly_valued_minutes INTEGER NOT NULL DEFAULT 0 CHECK (weekly_valued_minutes BETWEEN 0 AND 20160),
      weekly_surcharge_minutes INTEGER NOT NULL DEFAULT 0 CHECK (weekly_surcharge_minutes BETWEEN 0 AND 10080),
      closing_balance_minutes INTEGER CHECK (closing_balance_minutes BETWEEN -600000 AND 600000),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (import_id, employee_number),
      FOREIGN KEY (import_id) REFERENCES xoffi_time_imports(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS xoffi_time_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_row_id INTEGER NOT NULL,
      work_date TEXT NOT NULL,
      actual_minutes INTEGER NOT NULL DEFAULT 0 CHECK (actual_minutes BETWEEN 0 AND 1440),
      valued_minutes INTEGER NOT NULL DEFAULT 0 CHECK (valued_minutes BETWEEN 0 AND 2880),
      surcharge_minutes INTEGER NOT NULL DEFAULT 0 CHECK (surcharge_minutes BETWEEN 0 AND 1440),
      intervals_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(intervals_json) AND json_type(intervals_json) = 'array'),
      absence_code TEXT NOT NULL DEFAULT '' CHECK (absence_code IN ('', 'vacation', 'sick')),
      ocr_confidence INTEGER NOT NULL DEFAULT 0 CHECK (ocr_confidence BETWEEN 0 AND 100),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (employee_row_id, work_date),
      FOREIGN KEY (employee_row_id) REFERENCES xoffi_time_employee_rows(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS time_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      location_id TEXT,
      department_id INTEGER,
      correction_date TEXT NOT NULL,
      requested_change TEXT NOT NULL DEFAULT '',
      request_note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at TEXT,
      decision_note TEXT NOT NULL DEFAULT '',
      requested_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS time_day_reviews (
      employee_number TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id INTEGER,
      department_key INTEGER NOT NULL DEFAULT 0,
      work_date TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT NOT NULL,
      reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      evaluation_version TEXT NOT NULL DEFAULT 'v1',
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, work_date, department_key),
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS wifi_automation_preferences (
      employee_number TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      provider_id TEXT,
      external_subject_hash TEXT,
      opted_in_at TEXT,
      opted_out_at TEXT,
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wifi_presence_sessions (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      location_id TEXT NOT NULL,
      provider_id TEXT NOT NULL DEFAULT '',
      correlation_hash TEXT NOT NULL DEFAULT '',
      observed_start_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      disconnect_observed_at TEXT,
      observed_end_at TEXT,
      state TEXT NOT NULL DEFAULT 'observing',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wifi_event_inbox (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      external_event_hash TEXT NOT NULL,
      event_type TEXT NOT NULL,
      external_subject_hash TEXT NOT NULL,
      location_reference_hash TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      payload_fingerprint TEXT NOT NULL DEFAULT '',
      processing_status TEXT NOT NULL DEFAULT 'pending',
      presence_session_id TEXT,
      processed_at TEXT,
      processing_error TEXT NOT NULL DEFAULT '',
      UNIQUE(provider_id, external_event_hash),
      FOREIGN KEY (presence_session_id) REFERENCES wifi_presence_sessions(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS wifi_location_mappings (
      provider_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      external_location_hash TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider_id, location_id),
      UNIQUE(provider_id, external_location_hash),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wifi_time_suggestions (
      id TEXT PRIMARY KEY,
      presence_session_id TEXT NOT NULL,
      employee_number TEXT NOT NULL,
      location_id TEXT NOT NULL,
      work_date TEXT NOT NULL,
      suggested_start_at TEXT NOT NULL,
      suggested_end_at TEXT NOT NULL,
      confirmation_level_snapshot TEXT NOT NULL DEFAULT 'C',
      minimum_presence_minutes_snapshot INTEGER NOT NULL DEFAULT 5,
      absence_grace_minutes_snapshot INTEGER NOT NULL DEFAULT 30,
      confirmation_due_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      confirmed_start_at TEXT,
      confirmed_end_at TEXT,
      confirmed_break_start_at TEXT,
      confirmed_break_end_at TEXT,
      confirmed_by TEXT,
      confirmed_at TEXT,
      rejected_by TEXT,
      rejected_at TEXT,
      rejection_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (presence_session_id) REFERENCES wifi_presence_sessions(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      UNIQUE(presence_session_id, work_date)
    );

    CREATE TABLE IF NOT EXISTS portal_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS portal_notifications (
      id TEXT PRIMARY KEY,
      recipient_employee_number TEXT NOT NULL,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      dedupe_key TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (recipient_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS amu_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision INTEGER NOT NULL DEFAULT 1,
      sickness_case_id INTEGER,
      employee_number TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id INTEGER,
      incapacity_from TEXT NOT NULL,
      incapacity_to TEXT NOT NULL,
      employee_note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'submitted',
      submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by TEXT,
      reviewed_at TEXT,
      review_note TEXT NOT NULL DEFAULT '',
      retention_until TEXT,
      withdrawn_at TEXT,
      protected_payload TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE SET NULL,
      FOREIGN KEY (sickness_case_id) REFERENCES sickness_cases(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS amu_documents (
      id TEXT PRIMARY KEY,
      report_id INTEGER NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      original_filename TEXT NOT NULL,
      detected_mime TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      scan_status TEXT NOT NULL DEFAULT 'pending',
      encryption_key_id TEXT NOT NULL,
      encryption_iv TEXT NOT NULL,
      encryption_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_by TEXT,
      deleted_at TEXT,
      purged_at TEXT,
      protected_payload TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (report_id) REFERENCES amu_reports(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sickness_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision INTEGER NOT NULL DEFAULT 1,
      employee_lookup TEXT NOT NULL,
      status_lookup TEXT NOT NULL,
      protected_payload TEXT NOT NULL,
      purge_after TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS protected_case_events (
      id TEXT PRIMARY KEY,
      entity_kind TEXT NOT NULL CHECK(entity_kind IN ('sickness','amu')),
      entity_id INTEGER NOT NULL,
      action_lookup TEXT NOT NULL,
      actor_lookup TEXT NOT NULL,
      protected_payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sickness_alerts (
      id TEXT PRIMARY KEY,
      sickness_case_id INTEGER NOT NULL,
      status_lookup TEXT NOT NULL,
      protected_payload TEXT NOT NULL,
      purge_after TEXT NOT NULL,
      dedupe_lookup TEXT NOT NULL UNIQUE,
      FOREIGN KEY (sickness_case_id) REFERENCES sickness_cases(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sickness_notification_preferences (
      employee_number TEXT NOT NULL,
      channel TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      process_notifications_enabled INTEGER NOT NULL DEFAULT 0,
      earliest_time TEXT NOT NULL DEFAULT '08:00',
      protected_destination TEXT NOT NULL DEFAULT '',
      verified_at TEXT,
      verification_hash TEXT NOT NULL DEFAULT '',
      verification_salt TEXT NOT NULL DEFAULT '',
      verification_expires_at TEXT,
      verification_attempts INTEGER NOT NULL DEFAULT 0,
      verification_sent_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, channel),
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    ${PERSONAL_NOTIFICATION_CONTACTS_CREATE_SQL}

    CREATE TABLE IF NOT EXISTS outbound_notification_jobs (
      id TEXT PRIMARY KEY,
      recipient_lookup TEXT NOT NULL,
      channel TEXT NOT NULL,
      entity_lookup TEXT NOT NULL,
      protected_payload TEXT NOT NULL,
      not_before TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT NOT NULL DEFAULT '',
      sent_at TEXT,
      purge_after TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      dedupe_lookup TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS integration_profiles (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL CHECK(direction IN ('import', 'export')),
      kind TEXT NOT NULL CHECK(kind IN ('personnel', 'payroll')),
      name TEXT NOT NULL COLLATE NOCASE,
      format TEXT NOT NULL CHECK(format IN ('csv', 'xlsx')),
      configuration_json TEXT NOT NULL DEFAULT '{}',
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(direction, kind, name)
    );

    CREATE TABLE IF NOT EXISTS integration_runs (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('import', 'export')),
      kind TEXT NOT NULL CHECK(kind IN ('personnel', 'payroll')),
      format TEXT NOT NULL CHECK(format IN ('csv', 'xlsx')),
      content_sha256 TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'completed',
      total_count INTEGER NOT NULL DEFAULT 0,
      created_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      actor_employee_number TEXT NOT NULL DEFAULT '',
      options_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (profile_id) REFERENCES integration_profiles(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS integration_connections (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('personnel_sql_source', 'payroll_https_target')),
      name TEXT NOT NULL COLLATE NOCASE,
      provider TEXT NOT NULL,
      configuration_json TEXT NOT NULL DEFAULT '{}',
      protected_credentials TEXT NOT NULL DEFAULT '',
      credential_key_id TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      last_test_status TEXT NOT NULL DEFAULT '',
      last_test_at TEXT,
      last_error_code TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(kind, name)
    );

    CREATE TABLE IF NOT EXISTS integration_deliveries (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      profile_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id TEXT NOT NULL DEFAULT '',
      connection_revision INTEGER NOT NULL DEFAULT 1,
      connection_fingerprint TEXT NOT NULL DEFAULT '',
      payload_sha256 TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'delivered', 'rejected', 'unknown')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      http_status INTEGER,
      error_code TEXT NOT NULL DEFAULT '',
      actor_employee_number TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (connection_id) REFERENCES integration_connections(id) ON DELETE RESTRICT,
      FOREIGN KEY (profile_id) REFERENCES integration_profiles(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS payroll_handoffs (
      id TEXT PRIMARY KEY,
      period_month TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      supersedes_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(period_month, location_id, department_id, revision),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (supersedes_id) REFERENCES payroll_handoffs(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS payroll_handoff_events (
      id TEXT PRIMARY KEY,
      handoff_id TEXT NOT NULL,
      event_type TEXT NOT NULL
        CHECK(event_type IN ('created','exported','external_transfer_marked','protocol_recorded','superseded')),
      payload_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (handoff_id) REFERENCES payroll_handoffs(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS product_readiness_evidence (
      id TEXT PRIMARY KEY,
      check_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('pass','fail')),
      payload_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      observed_by TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_readiness_acceptances (
      id TEXT PRIMARY KEY,
      discipline TEXT NOT NULL CHECK(discipline IN ('technical','operational')),
      decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
      release_version TEXT NOT NULL,
      basis_sha256 TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      decided_by TEXT NOT NULL,
      decided_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_product_readiness_evidence_latest
      ON product_readiness_evidence(check_id, observed_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_product_readiness_acceptances_latest
      ON product_readiness_acceptances(discipline, decided_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS custom_processes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      symbol TEXT NOT NULL DEFAULT 'P',
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'other'
        CHECK(category IN ('personnel_absence','time_payroll','customer_service','goods_equipment','administration_it','other')),
      scope_type TEXT NOT NULL DEFAULT 'company'
        CHECK(scope_type IN ('company','location','department')),
      location_id TEXT,
      department_id INTEGER,
      trigger_type TEXT NOT NULL DEFAULT 'manual'
        CHECK(trigger_type IN ('manual','staffing_shortfall')),
      trigger_minimum_shortfall INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','active','archived')),
      revision INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS custom_process_steps (
      id TEXT PRIMARY KEY,
      process_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      step_type TEXT NOT NULL
        CHECK(step_type IN ('actor','system','decision','approval','finish')),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      responsibility_type TEXT NOT NULL DEFAULT 'system'
        CHECK(responsibility_type IN ('system','role','employee')),
      responsibility_reference TEXT NOT NULL DEFAULT '',
      responsibility_label TEXT NOT NULL DEFAULT '',
      condition_type TEXT NOT NULL DEFAULT 'always'
        CHECK(condition_type IN ('always','when','optional')),
      condition_text TEXT NOT NULL DEFAULT '',
      notification_channels TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(process_id, sort_order),
      FOREIGN KEY (process_id) REFERENCES custom_processes(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS custom_process_revisions (
      process_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (process_id, revision),
      FOREIGN KEY (process_id) REFERENCES custom_processes(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS custom_process_runs (
      id TEXT PRIMARY KEY,
      process_id TEXT NOT NULL,
      process_revision INTEGER NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open','resolved')),
      location_id TEXT,
      department_id INTEGER,
      triggered_by TEXT NOT NULL DEFAULT '',
      activation_count INTEGER NOT NULL DEFAULT 1,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (process_id) REFERENCES custom_processes(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS custom_process_run_steps (
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','active','completed','skipped')),
      activated_at TEXT,
      completed_at TEXT,
      completed_by TEXT NOT NULL DEFAULT '',
      completion_note TEXT NOT NULL DEFAULT '',
      completion_request_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (run_id, step_id),
      FOREIGN KEY (run_id) REFERENCES custom_process_runs(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collective_agreements (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      short_title TEXT NOT NULL DEFAULT '',
      jurisdiction TEXT NOT NULL DEFAULT 'AT',
      review_state TEXT NOT NULL DEFAULT 'review_pending'
        CHECK(review_state IN ('review_pending','approved','retired')),
      current_version_id TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collective_agreement_versions (
      id TEXT PRIMARY KEY,
      agreement_id TEXT NOT NULL,
      version_label TEXT NOT NULL,
      source_state TEXT NOT NULL DEFAULT 'documented'
        CHECK(source_state IN ('documented','superseded','withdrawn')),
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      external_published_on TEXT,
      source_title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_retrieved_on TEXT NOT NULL,
      source_sha256 TEXT NOT NULL DEFAULT '',
      source_note TEXT NOT NULL DEFAULT '',
      contracting_parties_json TEXT NOT NULL DEFAULT '[]',
      territorial_scope TEXT NOT NULL DEFAULT '',
      functional_scope TEXT NOT NULL DEFAULT '',
      personal_scope TEXT NOT NULL DEFAULT '',
      employee_groups_json TEXT NOT NULL DEFAULT '[]',
      work_time_parameters_note TEXT NOT NULL DEFAULT '',
      classification_note TEXT NOT NULL DEFAULT '',
      apprentice_relevance TEXT NOT NULL DEFAULT 'unknown'
        CHECK(apprentice_relevance IN ('yes','no','unknown')),
      apprentice_note TEXT NOT NULL DEFAULT '',
      successor_note TEXT NOT NULL DEFAULT '',
      linked_profile_version_id TEXT,
      snapshot_json TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(agreement_id, version_label),
      FOREIGN KEY (agreement_id) REFERENCES collective_agreements(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (linked_profile_version_id) REFERENCES work_rule_profile_versions(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS collective_agreement_business_units (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      legal_entity_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collective_agreement_business_unit_scopes (
      id TEXT PRIMARY KEY,
      business_unit_id TEXT NOT NULL,
      scope_type TEXT NOT NULL
        CHECK(scope_type IN ('cost_center','location','department')),
      scope_key TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(business_unit_id, scope_type, scope_key),
      UNIQUE(scope_type, scope_key),
      FOREIGN KEY (business_unit_id) REFERENCES collective_agreement_business_units(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS collective_agreement_assignments (
      id TEXT PRIMARY KEY,
      agreement_version_id TEXT NOT NULL,
      business_unit_id TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      review_state TEXT NOT NULL DEFAULT 'review_pending'
        CHECK(review_state IN ('review_pending')),
      rationale TEXT NOT NULL,
      reference_note TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agreement_version_id) REFERENCES collective_agreement_versions(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (business_unit_id) REFERENCES collective_agreement_business_units(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS work_rule_exceptions (
      id TEXT PRIMARY KEY,
      evaluation_id TEXT NOT NULL,
      finding_fingerprint TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      profile_version_id TEXT NOT NULL,
      exception_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'active'
        CHECK(state IN ('active','revoked','expired')),
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_by TEXT,
      revoked_at TEXT,
      FOREIGN KEY (evaluation_id) REFERENCES work_rule_evaluation_runs(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (profile_version_id) REFERENCES work_rule_profile_versions(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS work_rule_conflict_runs (
      id TEXT PRIMARY KEY,
      operation TEXT NOT NULL
        CHECK(operation IN (
          'publish_rule','activate_assignment','deactivate_assignment',
          'withdraw_publication','approve_kv_assignment','deactivate_kv_assignment'
        )),
      subject_type TEXT NOT NULL
        CHECK(subject_type IN (
          'work_rule_profile_version','work_rule_publication',
          'work_rule_assignment_revision','collective_agreement_assignment'
        )),
      subject_id TEXT NOT NULL,
      baseline_sha256 TEXT NOT NULL,
      outcome TEXT NOT NULL
        CHECK(outcome IN ('pass','warning','blocked')),
      result_json TEXT NOT NULL,
      result_sha256 TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_rule_review_requests (
      id TEXT PRIMARY KEY,
      client_request_id TEXT NOT NULL UNIQUE,
      operation TEXT NOT NULL
        CHECK(operation IN (
          'publish_rule','activate_assignment','deactivate_assignment',
          'withdraw_publication','approve_kv_assignment','deactivate_kv_assignment'
        )),
      subject_type TEXT NOT NULL
        CHECK(subject_type IN (
          'work_rule_profile_version','work_rule_publication',
          'work_rule_assignment_revision','collective_agreement_assignment'
        )),
      subject_id TEXT NOT NULL,
      basis_sha256 TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      risk_class TEXT NOT NULL
        CHECK(risk_class IN ('standard','critical')),
      required_approvals INTEGER NOT NULL
        CHECK(required_approvals IN (1,2)),
      required_fachlich_approvals INTEGER NOT NULL DEFAULT 1
        CHECK(required_fachlich_approvals BETWEEN 1 AND required_approvals),
      conflict_run_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      source_reference TEXT NOT NULL DEFAULT '',
      submitted_by TEXT NOT NULL,
      submitted_role TEXT NOT NULL,
      submitted_permission TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      FOREIGN KEY (conflict_run_id) REFERENCES work_rule_conflict_runs(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS work_rule_review_decisions (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      decision TEXT NOT NULL
        CHECK(decision IN ('approve','reject')),
      actor_employee_number TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      permission_used TEXT NOT NULL,
      qualification TEXT NOT NULL
        CHECK(qualification IN ('fachlich','organisational','technical')),
      reason TEXT NOT NULL,
      request_receipt_sha256 TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      UNIQUE(request_id, actor_employee_number),
      FOREIGN KEY (request_id) REFERENCES work_rule_review_requests(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS work_rule_publications (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      source_profile_version_id TEXT NOT NULL UNIQUE,
      released_profile_version_id TEXT NOT NULL UNIQUE,
      review_request_id TEXT NOT NULL UNIQUE,
      release_number INTEGER NOT NULL,
      semantic_sha256 TEXT NOT NULL,
      conflict_run_id TEXT NOT NULL,
      published_by TEXT NOT NULL,
      published_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      FOREIGN KEY (profile_id) REFERENCES work_rule_profiles(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (source_profile_version_id) REFERENCES work_rule_profile_versions(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (released_profile_version_id) REFERENCES work_rule_profile_versions(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (review_request_id) REFERENCES work_rule_review_requests(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (conflict_run_id) REFERENCES work_rule_conflict_runs(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS work_rule_publication_events (
      id TEXT PRIMARY KEY,
      publication_id TEXT NOT NULL,
      event_type TEXT NOT NULL
        CHECK(event_type IN ('published','withdrawn','superseded')),
      effective_on TEXT NOT NULL,
      reason TEXT NOT NULL,
      review_request_id TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      permission_used TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      UNIQUE(publication_id, event_type, review_request_id),
      FOREIGN KEY (publication_id) REFERENCES work_rule_publications(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (review_request_id) REFERENCES work_rule_review_requests(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS work_rule_assignment_revisions (
      id TEXT PRIMARY KEY,
      logical_assignment_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      publication_id TEXT NOT NULL,
      profile_version_id TEXT NOT NULL,
      scope_type TEXT NOT NULL
        CHECK(scope_type IN (
          'installation','business_unit','location','department',
          'employee_group','employee'
        )),
      scope_key TEXT NOT NULL DEFAULT '',
      expanded_scopes_json TEXT NOT NULL,
      scope_sha256 TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      enforcement_mode TEXT NOT NULL DEFAULT 'monitor'
        CHECK(enforcement_mode IN ('monitor','enforced')),
      applicability_confirmed INTEGER NOT NULL DEFAULT 0,
      rationale TEXT NOT NULL,
      source_reference TEXT NOT NULL DEFAULT '',
      supersedes_revision_id TEXT,
      review_request_id TEXT NOT NULL UNIQUE,
      conflict_run_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      UNIQUE(logical_assignment_id, revision),
      FOREIGN KEY (publication_id) REFERENCES work_rule_publications(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (profile_version_id) REFERENCES work_rule_profile_versions(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (supersedes_revision_id) REFERENCES work_rule_assignment_revisions(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (review_request_id) REFERENCES work_rule_review_requests(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (conflict_run_id) REFERENCES work_rule_conflict_runs(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS work_rule_assignment_events (
      id TEXT PRIMARY KEY,
      assignment_revision_id TEXT NOT NULL,
      event_type TEXT NOT NULL
        CHECK(event_type IN ('activated','deactivated','superseded')),
      effective_on TEXT NOT NULL,
      reason TEXT NOT NULL,
      review_request_id TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      permission_used TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      UNIQUE(assignment_revision_id, event_type, review_request_id),
      FOREIGN KEY (assignment_revision_id) REFERENCES work_rule_assignment_revisions(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (review_request_id) REFERENCES work_rule_review_requests(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS collective_agreement_assignment_events (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL,
      event_type TEXT NOT NULL
        CHECK(event_type IN ('approved','deactivated')),
      effective_on TEXT NOT NULL,
      scope_snapshot_json TEXT NOT NULL,
      scope_sha256 TEXT NOT NULL,
      reason TEXT NOT NULL,
      review_request_id TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      permission_used TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      UNIQUE(assignment_id, event_type, review_request_id),
      FOREIGN KEY (assignment_id) REFERENCES collective_agreement_assignments(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (review_request_id) REFERENCES work_rule_review_requests(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS work_rule_governance_events (
      id TEXT PRIMARY KEY,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      sequence_no INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      previous_receipt_sha256 TEXT NOT NULL DEFAULT '',
      actor_employee_number TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      permission_used TEXT NOT NULL,
      correlation_id TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      UNIQUE(aggregate_type, aggregate_id, sequence_no)
    );

    -- Governance-Historien bewahren die zum Ereignis gehörende Personalnummer
    -- selbst dann, wenn ein Stammdatensatz außerhalb der Anwendung entfernt
    -- wurde. Die Anwendung selbst deaktiviert Personen kontrolliert.
    CREATE TABLE IF NOT EXISTS vacation_account_revisions (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      leave_year INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed'
        CHECK(status IN ('draft','confirmed','superseded')),
      total_days REAL NOT NULL,
      eu_minimum_days REAL NOT NULL,
      national_additional_days REAL NOT NULL,
      weekly_workdays REAL NOT NULL,
      leave_year_start TEXT NOT NULL,
      leave_year_end TEXT NOT NULL,
      expiry_candidate_on TEXT,
      expiry_status TEXT NOT NULL DEFAULT 'manual_review'
        CHECK(expiry_status IN ('not_due','manual_review','documented','not_applicable')),
      calculation_json TEXT NOT NULL,
      sources_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      supersedes_id TEXT,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(employee_number, leave_year, revision),
      FOREIGN KEY (supersedes_id) REFERENCES vacation_account_revisions(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS vacation_account_events (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      leave_year INTEGER NOT NULL,
      account_revision_id TEXT NOT NULL,
      event_type TEXT NOT NULL
        CHECK(event_type IN ('opening','entitlement','carryover','consumption','correction','expiry_review','notice')),
      tranche_type TEXT NOT NULL DEFAULT 'unallocated'
        CHECK(tranche_type IN ('eu_minimum','national_additional','unallocated')),
      amount_days REAL NOT NULL DEFAULT 0,
      effective_on TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}',
      receipt_sha256 TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_revision_id) REFERENCES vacation_account_revisions(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS vacation_history_events (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      employee_number TEXT NOT NULL,
      action TEXT NOT NULL
        CHECK(action IN ('created','replaced','deleted','approved','cancelled')),
      snapshot_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS time_record_statements (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL
        CHECK(status IN ('draft','reviewed','needs_correction','finalized','superseded')),
      source_sha256 TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      supersedes_id TEXT,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(employee_number, period_start, period_end, revision),
      FOREIGN KEY (supersedes_id) REFERENCES time_record_statements(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS time_record_statement_events (
      id TEXT PRIMARY KEY,
      statement_id TEXT NOT NULL,
      event_type TEXT NOT NULL
        CHECK(event_type IN ('created','finalized','superseded','provided','downloaded')),
      actor_employee_number TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}',
      receipt_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (statement_id) REFERENCES time_record_statements(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS retention_policy_versions (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','active','retired')),
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      duration_days INTEGER,
      start_trigger TEXT NOT NULL,
      disposition TEXT NOT NULL DEFAULT 'manual_review'
        CHECK(disposition IN ('manual_review','delete','anonymize','archive')),
      legal_basis TEXT NOT NULL DEFAULT '',
      source_json TEXT NOT NULL DEFAULT '[]',
      configuration_json TEXT NOT NULL DEFAULT '{}',
      receipt_sha256 TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(category, version)
    );

    CREATE TABLE IF NOT EXISTS retention_preview_runs (
      id TEXT PRIMARY KEY,
      as_of TEXT NOT NULL,
      result_json TEXT NOT NULL,
      result_sha256 TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS legal_holds (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      subject_employee_number TEXT,
      reason TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      released_by TEXT,
      released_at TEXT
    );

    CREATE TABLE IF NOT EXISTS privacy_requests (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      request_type TEXT NOT NULL
        CHECK(request_type IN ('access','rectification','erasure','restriction','portability','objection')),
      status TEXT NOT NULL DEFAULT 'received'
        CHECK(status IN ('received','identity_pending','in_review','extended','approved','partially_approved','rejected','fulfilled','partially_fulfilled','withdrawn')),
      identity_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(identity_status IN ('pending','verified','insufficient')),
      received_at TEXT NOT NULL,
      due_at TEXT NOT NULL,
      extended_due_at TEXT,
      assigned_to TEXT NOT NULL DEFAULT '',
      protected_payload TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS privacy_request_events (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL DEFAULT '',
      protected_payload TEXT NOT NULL,
      previous_receipt_sha256 TEXT NOT NULL DEFAULT '',
      receipt_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (request_id) REFERENCES privacy_requests(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS privacy_export_receipts (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      employee_number TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'json',
      content_sha256 TEXT NOT NULL,
      categories_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      downloaded_at TEXT,
      FOREIGN KEY (request_id) REFERENCES privacy_requests(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      app_version TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_vacation_requests_employee ON vacation_requests(employee_number, status);
    CREATE INDEX IF NOT EXISTS idx_time_off_requests_employee ON time_off_requests(employee_number, status, request_date);
    CREATE INDEX IF NOT EXISTS idx_vacation_change_requests_employee ON vacation_change_requests(employee_number, status);
    CREATE INDEX IF NOT EXISTS idx_time_off_change_requests_employee ON time_off_change_requests(employee_number, status);
    CREATE INDEX IF NOT EXISTS idx_request_blackouts_range ON request_blackouts(location_id, date_from, date_to, active);
    CREATE INDEX IF NOT EXISTS idx_request_decisions_request ON request_decisions(request_kind, request_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_approval_delegations_range ON approval_delegations(location_id, date_from, date_to, active);
    CREATE INDEX IF NOT EXISTS idx_time_entries_employee_date ON time_entries(employee_number, entry_timestamp);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_xoffi_time_imports_active_week
      ON xoffi_time_imports(location_id, week_start, department_key) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_xoffi_time_imports_location_week
      ON xoffi_time_imports(location_id, week_start DESC, imported_at DESC);
    CREATE INDEX IF NOT EXISTS idx_xoffi_time_rows_employee
      ON xoffi_time_employee_rows(employee_number, import_id);
    CREATE INDEX IF NOT EXISTS idx_xoffi_time_days_date
      ON xoffi_time_days(work_date, employee_row_id);
    CREATE INDEX IF NOT EXISTS idx_time_corrections_employee ON time_corrections(employee_number, status);
    CREATE INDEX IF NOT EXISTS idx_portal_notifications_recipient ON portal_notifications(recipient_employee_number, read_at, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_notifications_dedupe ON portal_notifications(recipient_employee_number, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_amu_reports_employee ON amu_reports(employee_number, status, submitted_at);
    CREATE INDEX IF NOT EXISTS idx_amu_reports_location ON amu_reports(location_id, status, submitted_at);
    CREATE INDEX IF NOT EXISTS idx_amu_reports_retention ON amu_reports(retention_until, status);
    CREATE INDEX IF NOT EXISTS idx_amu_documents_report ON amu_documents(report_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_sickness_cases_employee ON sickness_cases(employee_lookup, status_lookup, created_at);
    CREATE INDEX IF NOT EXISTS idx_sickness_cases_retention ON sickness_cases(purge_after, status_lookup);
    CREATE INDEX IF NOT EXISTS idx_sickness_alerts_case ON sickness_alerts(sickness_case_id, status_lookup);
    CREATE INDEX IF NOT EXISTS idx_sickness_alerts_retention ON sickness_alerts(purge_after, status_lookup);
    CREATE INDEX IF NOT EXISTS idx_outbound_notification_jobs_due ON outbound_notification_jobs(status, not_before, created_at);
    CREATE INDEX IF NOT EXISTS idx_outbound_notification_jobs_retention ON outbound_notification_jobs(purge_after, status);
    CREATE INDEX IF NOT EXISTS idx_integration_profiles_kind ON integration_profiles(direction, kind, active, name);
    CREATE INDEX IF NOT EXISTS idx_integration_runs_started ON integration_runs(started_at DESC, direction, kind);
    CREATE INDEX IF NOT EXISTS idx_integration_runs_actor ON integration_runs(actor_employee_number, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_portal_permission_denials_employee ON portal_permission_denials(employee_number, permission);
    CREATE INDEX IF NOT EXISTS idx_integration_connections_kind ON integration_connections(kind, active, name);
    CREATE INDEX IF NOT EXISTS idx_integration_deliveries_started ON integration_deliveries(started_at DESC, status);
    CREATE INDEX IF NOT EXISTS idx_integration_deliveries_connection ON integration_deliveries(connection_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payroll_handoffs_period
      ON payroll_handoffs(period_month DESC, location_id, department_id, revision DESC);
    CREATE INDEX IF NOT EXISTS idx_payroll_handoff_events
      ON payroll_handoff_events(handoff_id, occurred_at, id);
    CREATE INDEX IF NOT EXISTS idx_custom_processes_status ON custom_processes(status, updated_at, title);
    CREATE INDEX IF NOT EXISTS idx_custom_processes_scope ON custom_processes(scope_type, location_id, department_id, status);
    CREATE INDEX IF NOT EXISTS idx_custom_process_steps_process ON custom_process_steps(process_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_custom_process_revisions_process ON custom_process_revisions(process_id, revision DESC);
    CREATE INDEX IF NOT EXISTS idx_custom_process_runs_process ON custom_process_runs(process_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_custom_process_run_steps_status ON custom_process_run_steps(run_id, status, sort_order);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_work_rule_versions_profile_validity
      ON work_rule_profile_versions(profile_id, status, valid_from, valid_to);
    CREATE INDEX IF NOT EXISTS idx_work_rule_assignments_scope_validity
      ON work_rule_assignments(scope_type, scope_key, active, valid_from, valid_to);
    CREATE INDEX IF NOT EXISTS idx_collective_agreement_versions_validity
      ON collective_agreement_versions(agreement_id, valid_from DESC, valid_to);
    CREATE INDEX IF NOT EXISTS idx_collective_agreement_business_unit_scopes
      ON collective_agreement_business_unit_scopes(scope_type, scope_key, business_unit_id);
    CREATE INDEX IF NOT EXISTS idx_collective_agreement_assignments_review
      ON collective_agreement_assignments(business_unit_id, review_state, valid_from, valid_to);
    CREATE INDEX IF NOT EXISTS idx_work_rule_evaluations_period
      ON work_rule_evaluation_runs(target_type, period_from, period_to, created_at);
    CREATE INDEX IF NOT EXISTS idx_work_rule_exceptions_finding
      ON work_rule_exceptions(finding_fingerprint, state, valid_from, valid_to);
    CREATE INDEX IF NOT EXISTS idx_work_rule_review_requests_subject
      ON work_rule_review_requests(subject_type, subject_id, submitted_at);
    CREATE INDEX IF NOT EXISTS idx_work_rule_review_decisions_request
      ON work_rule_review_decisions(request_id, decided_at);
    CREATE INDEX IF NOT EXISTS idx_work_rule_publications_profile
      ON work_rule_publications(profile_id, release_number DESC);
    CREATE INDEX IF NOT EXISTS idx_work_rule_assignment_revisions_scope
      ON work_rule_assignment_revisions(scope_type, scope_key, valid_from, valid_to);
    CREATE INDEX IF NOT EXISTS idx_work_rule_assignment_events_revision
      ON work_rule_assignment_events(assignment_revision_id, effective_on, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_collective_agreement_assignment_events_assignment
      ON collective_agreement_assignment_events(assignment_id, effective_on, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_work_rule_governance_events_aggregate
      ON work_rule_governance_events(aggregate_type, aggregate_id, sequence_no);
    CREATE INDEX IF NOT EXISTS idx_vacation_account_employee_year
      ON vacation_account_revisions(employee_number, leave_year, revision DESC);
    CREATE INDEX IF NOT EXISTS idx_vacation_account_events_employee
      ON vacation_account_events(employee_number, leave_year, effective_on);
    CREATE INDEX IF NOT EXISTS idx_vacation_history_employee
      ON vacation_history_events(employee_number, created_at);
    CREATE INDEX IF NOT EXISTS idx_time_record_statements_employee_period
      ON time_record_statements(employee_number, period_start, period_end, revision DESC);
    CREATE INDEX IF NOT EXISTS idx_time_record_statement_events
      ON time_record_statement_events(statement_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_retention_policy_category
      ON retention_policy_versions(category, version DESC);
    CREATE INDEX IF NOT EXISTS idx_legal_holds_scope
      ON legal_holds(category, subject_employee_number, active, valid_from, valid_to);
    CREATE INDEX IF NOT EXISTS idx_privacy_requests_employee
      ON privacy_requests(employee_number, status, received_at);
    CREATE INDEX IF NOT EXISTS idx_privacy_requests_due
      ON privacy_requests(status, due_at, extended_due_at);
    CREATE INDEX IF NOT EXISTS idx_privacy_request_events
      ON privacy_request_events(request_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_privacy_export_receipts
      ON privacy_export_receipts(request_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_portal_users_role_active ON portal_users(role, active);
    CREATE INDEX IF NOT EXISTS idx_portal_sessions_employee ON portal_sessions(employee_number, expires_at);
    CREATE INDEX IF NOT EXISTS idx_portal_sessions_expiry ON portal_sessions(expires_at, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_portal_password_reset_employee
      ON portal_password_reset_tokens(employee_number, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_portal_password_reset_expiry
      ON portal_password_reset_tokens(expires_at, used_at, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_portal_organization_accounts_active
      ON portal_organization_accounts(active, login_name);
    CREATE INDEX IF NOT EXISTS idx_portal_organization_sessions_account
      ON portal_organization_sessions(account_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_portal_organization_sessions_expiry
      ON portal_organization_sessions(expires_at, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_portal_organization_scopes_location
      ON portal_organization_account_scopes(location_id, account_id);
    CREATE INDEX IF NOT EXISTS idx_mobile_sessions_employee ON mobile_sessions(employee_number, refresh_expires_at);
    CREATE INDEX IF NOT EXISTS idx_mobile_sessions_expiry ON mobile_sessions(refresh_expires_at, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_mobile_refresh_history_consumed ON mobile_refresh_token_history(consumed_at);
    CREATE INDEX IF NOT EXISTS idx_portal_permission_grants_employee ON portal_permission_grants(employee_number, permission);

    CREATE TRIGGER IF NOT EXISTS trg_vacation_account_revisions_immutable_update
    BEFORE UPDATE ON vacation_account_revisions
    BEGIN
      SELECT RAISE(ABORT, 'vacation account revisions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_vacation_account_revisions_immutable_delete
    BEFORE DELETE ON vacation_account_revisions
    BEGIN
      SELECT RAISE(ABORT, 'vacation account revisions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_vacation_account_events_immutable_update
    BEFORE UPDATE ON vacation_account_events
    BEGIN
      SELECT RAISE(ABORT, 'vacation account events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_vacation_account_events_immutable_delete
    BEFORE DELETE ON vacation_account_events
    BEGIN
      SELECT RAISE(ABORT, 'vacation account events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_vacation_history_events_immutable_update
    BEFORE UPDATE ON vacation_history_events
    BEGIN
      SELECT RAISE(ABORT, 'vacation history events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_vacation_history_events_immutable_delete
    BEFORE DELETE ON vacation_history_events
    BEGIN
      SELECT RAISE(ABORT, 'vacation history events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_xoffi_time_imports_no_delete
    BEFORE DELETE ON xoffi_time_imports
    BEGIN
      SELECT RAISE(ABORT, 'xoffi time imports are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_xoffi_time_imports_revision_guard
    BEFORE UPDATE ON xoffi_time_imports
    WHEN OLD.status <> 'active'
      OR NEW.status <> 'superseded'
      OR NEW.id <> OLD.id
      OR NEW.location_id <> OLD.location_id
      OR NOT (NEW.department_id IS OLD.department_id)
      OR NEW.department_key <> OLD.department_key
      OR NEW.week_start <> OLD.week_start
      OR NEW.week_end <> OLD.week_end
      OR NEW.source_sha256 <> OLD.source_sha256
      OR NEW.source_file_name <> OLD.source_file_name
      OR NEW.ocr_engine_version <> OLD.ocr_engine_version
      OR NEW.use_as_actual <> OLD.use_as_actual
      OR NEW.imported_by <> OLD.imported_by
      OR NEW.imported_at <> OLD.imported_at
      OR NEW.superseded_by_import_id IS NULL
      OR NEW.superseded_by IS NULL
      OR NEW.superseded_at IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'xoffi time imports allow only immutable supersession');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_xoffi_time_days_week_guard
    BEFORE INSERT ON xoffi_time_days
    WHEN NOT EXISTS (
      SELECT 1
      FROM xoffi_time_employee_rows r
      JOIN xoffi_time_imports i ON i.id = r.import_id
      WHERE r.id = NEW.employee_row_id
        AND NEW.work_date BETWEEN i.week_start AND i.week_end
    )
    BEGIN
      SELECT RAISE(ABORT, 'xoffi time day is outside import week');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_xoffi_time_employee_rows_immutable_update
    BEFORE UPDATE ON xoffi_time_employee_rows
    BEGIN
      SELECT RAISE(ABORT, 'xoffi time employee rows are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_xoffi_time_employee_rows_immutable_delete
    BEFORE DELETE ON xoffi_time_employee_rows
    BEGIN
      SELECT RAISE(ABORT, 'xoffi time employee rows are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_xoffi_time_days_immutable_update
    BEFORE UPDATE ON xoffi_time_days
    BEGIN
      SELECT RAISE(ABORT, 'xoffi time days are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_xoffi_time_days_immutable_delete
    BEFORE DELETE ON xoffi_time_days
    BEGIN
      SELECT RAISE(ABORT, 'xoffi time days are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_time_record_statements_immutable_update
    BEFORE UPDATE ON time_record_statements
    BEGIN
      SELECT RAISE(ABORT, 'time record statements are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_time_record_statements_immutable_delete
    BEFORE DELETE ON time_record_statements
    BEGIN
      SELECT RAISE(ABORT, 'time record statements are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_time_record_statement_events_immutable_update
    BEFORE UPDATE ON time_record_statement_events
    BEGIN
      SELECT RAISE(ABORT, 'time record statement events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_time_record_statement_events_immutable_delete
    BEFORE DELETE ON time_record_statement_events
    BEGIN
      SELECT RAISE(ABORT, 'time record statement events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_payroll_handoffs_immutable_update
    BEFORE UPDATE ON payroll_handoffs
    BEGIN
      SELECT RAISE(ABORT, 'payroll handoffs are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_payroll_handoffs_immutable_delete
    BEFORE DELETE ON payroll_handoffs
    BEGIN
      SELECT RAISE(ABORT, 'payroll handoffs are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_payroll_handoff_events_immutable_update
    BEFORE UPDATE ON payroll_handoff_events
    BEGIN
      SELECT RAISE(ABORT, 'payroll handoff events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_payroll_handoff_events_immutable_delete
    BEFORE DELETE ON payroll_handoff_events
    BEGIN
      SELECT RAISE(ABORT, 'payroll handoff events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_product_readiness_evidence_immutable_update
    BEFORE UPDATE ON product_readiness_evidence
    BEGIN
      SELECT RAISE(ABORT, 'product readiness evidence is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_product_readiness_evidence_immutable_delete
    BEFORE DELETE ON product_readiness_evidence
    BEGIN
      SELECT RAISE(ABORT, 'product readiness evidence is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_product_readiness_acceptances_immutable_update
    BEFORE UPDATE ON product_readiness_acceptances
    BEGIN
      SELECT RAISE(ABORT, 'product readiness acceptances are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_product_readiness_acceptances_immutable_delete
    BEFORE DELETE ON product_readiness_acceptances
    BEGIN
      SELECT RAISE(ABORT, 'product readiness acceptances are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_retention_policy_versions_immutable_update
    BEFORE UPDATE ON retention_policy_versions
    BEGIN
      SELECT RAISE(ABORT, 'retention policy versions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_retention_policy_versions_immutable_delete
    BEFORE DELETE ON retention_policy_versions
    BEGIN
      SELECT RAISE(ABORT, 'retention policy versions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_retention_preview_runs_immutable_update
    BEFORE UPDATE ON retention_preview_runs
    BEGIN
      SELECT RAISE(ABORT, 'retention preview runs are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_retention_preview_runs_immutable_delete
    BEFORE DELETE ON retention_preview_runs
    BEGIN
      SELECT RAISE(ABORT, 'retention preview runs are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_privacy_request_events_immutable_update
    BEFORE UPDATE ON privacy_request_events
    BEGIN
      SELECT RAISE(ABORT, 'privacy request events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_privacy_request_events_immutable_delete
    BEFORE DELETE ON privacy_request_events
    BEGIN
      SELECT RAISE(ABORT, 'privacy request events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_collective_agreement_versions_immutable_update
    BEFORE UPDATE ON collective_agreement_versions
    BEGIN
      SELECT RAISE(ABORT, 'collective agreement versions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_collective_agreement_versions_immutable_delete
    BEFORE DELETE ON collective_agreement_versions
    BEGIN
      SELECT RAISE(ABORT, 'collective agreement versions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_collective_agreement_assignments_immutable_update
    BEFORE UPDATE ON collective_agreement_assignments
    BEGIN
      SELECT RAISE(ABORT, 'collective agreement assignment proposals are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_collective_agreement_assignments_immutable_delete
    BEFORE DELETE ON collective_agreement_assignments
    BEGIN
      SELECT RAISE(ABORT, 'collective agreement assignment proposals are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_collective_agreement_business_unit_scopes_immutable_update
    BEFORE UPDATE ON collective_agreement_business_unit_scopes
    BEGIN
      SELECT RAISE(ABORT, 'collective agreement business unit scopes are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_collective_agreement_business_unit_scopes_immutable_delete
    BEFORE DELETE ON collective_agreement_business_unit_scopes
    BEGIN
      SELECT RAISE(ABORT, 'collective agreement business unit scopes are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_conflict_runs_immutable_update
    BEFORE UPDATE ON work_rule_conflict_runs
    BEGIN
      SELECT RAISE(ABORT, 'work rule conflict runs are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_conflict_runs_immutable_delete
    BEFORE DELETE ON work_rule_conflict_runs
    BEGIN
      SELECT RAISE(ABORT, 'work rule conflict runs are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_review_requests_immutable_update
    BEFORE UPDATE ON work_rule_review_requests
    BEGIN
      SELECT RAISE(ABORT, 'work rule review requests are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_review_requests_immutable_delete
    BEFORE DELETE ON work_rule_review_requests
    BEGIN
      SELECT RAISE(ABORT, 'work rule review requests are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_review_decisions_immutable_update
    BEFORE UPDATE ON work_rule_review_decisions
    BEGIN
      SELECT RAISE(ABORT, 'work rule review decisions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_review_decisions_immutable_delete
    BEFORE DELETE ON work_rule_review_decisions
    BEGIN
      SELECT RAISE(ABORT, 'work rule review decisions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_publications_immutable_update
    BEFORE UPDATE ON work_rule_publications
    BEGIN
      SELECT RAISE(ABORT, 'work rule publications are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_publications_immutable_delete
    BEFORE DELETE ON work_rule_publications
    BEGIN
      SELECT RAISE(ABORT, 'work rule publications are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_publication_events_immutable_update
    BEFORE UPDATE ON work_rule_publication_events
    BEGIN
      SELECT RAISE(ABORT, 'work rule publication events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_publication_events_immutable_delete
    BEFORE DELETE ON work_rule_publication_events
    BEGIN
      SELECT RAISE(ABORT, 'work rule publication events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_assignment_revisions_immutable_update
    BEFORE UPDATE ON work_rule_assignment_revisions
    BEGIN
      SELECT RAISE(ABORT, 'work rule assignment revisions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_assignment_revisions_immutable_delete
    BEFORE DELETE ON work_rule_assignment_revisions
    BEGIN
      SELECT RAISE(ABORT, 'work rule assignment revisions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_assignment_events_immutable_update
    BEFORE UPDATE ON work_rule_assignment_events
    BEGIN
      SELECT RAISE(ABORT, 'work rule assignment events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_assignment_events_immutable_delete
    BEFORE DELETE ON work_rule_assignment_events
    BEGIN
      SELECT RAISE(ABORT, 'work rule assignment events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_collective_agreement_assignment_events_immutable_update
    BEFORE UPDATE ON collective_agreement_assignment_events
    BEGIN
      SELECT RAISE(ABORT, 'collective agreement assignment events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_collective_agreement_assignment_events_immutable_delete
    BEFORE DELETE ON collective_agreement_assignment_events
    BEGIN
      SELECT RAISE(ABORT, 'collective agreement assignment events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_governance_events_immutable_update
    BEFORE UPDATE ON work_rule_governance_events
    BEGIN
      SELECT RAISE(ABORT, 'work rule governance events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_governance_events_immutable_delete
    BEFORE DELETE ON work_rule_governance_events
    BEGIN
      SELECT RAISE(ABORT, 'work rule governance events are immutable');
    END;

  `);
  ensureSqlitePersonnelLifecycleSchema(sqliteDatabase);
  ensureSqlitePersonnelDocumentHistorySchema(sqliteDatabase);
  ensureSqlitePersonnelLifecycleScopedRightsSchema(sqliteDatabase);
  ensureSqlitePersonnelWorkflowSchema(sqliteDatabase);
  ensureSqlitePersonnelWorkflowInstanceSchema(sqliteDatabase);
  const onboardingSchema = inspectSqlitePersonnelLifecycleOnboardingSchema(sqliteDatabase);
  if (onboardingSchema.absent) ensureSqlitePersonnelLifecycleCaseSchema(sqliteDatabase);
  ensureSqlitePersonnelLifecycleOnboardingSchema(sqliteDatabase);
  ensureSqlitePersonnelLifecycleOffboardingSchema(sqliteDatabase);
  ensureSqlitePersonnelWorkflowInstanceSchema(sqliteDatabase);
  ensureSqlitePersonnelLearningSchema(sqliteDatabase);
  ensureSqlitePersonnelLearningCompetencySchema(sqliteDatabase);
  ensureSqlitePersonnelLearningAssignmentSchema(sqliteDatabase);
  ensureSqlitePersonnelLearningProgressSchema(sqliteDatabase);
  ensureSqliteStaffAssignmentRequestSchema(sqliteDatabase);
  ensureSqlitePortalBirthdayPresentationSchema(sqliteDatabase);
  ensureSqlitePortalBirthdayPresentationClaimSchema(sqliteDatabase);
  ensureSqliteSalesAnalyticsSchema(sqliteDatabase);
}

module.exports = {
  PERSONAL_NOTIFICATION_CONTACTS_CREATE_SQL,
  ensureSqliteApplicationSchema,
  inspectSqlitePersonalNotificationContactRows,
  inspectSqlitePersonalNotificationContactsSchema,
};
