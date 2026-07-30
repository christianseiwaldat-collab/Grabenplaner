"use strict";

const {
  createSqliteSchemaOperations,
} = require("./maintenance");

function runSqliteHistoricalCompatibilityMigrations(database) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  const db = database;
  const {
    columnExists,
    ensureColumn,
  } = createSqliteSchemaOperations(db);

db.exec("CREATE INDEX IF NOT EXISTS idx_time_entries_work_date ON time_entries(employee_number, work_date, entry_timestamp)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_mobile_request ON time_entries(employee_number, client_request_id) WHERE client_request_id IS NOT NULL");
db.exec("CREATE INDEX IF NOT EXISTS idx_mobile_sessions_employee ON mobile_sessions(employee_number, refresh_expires_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_mobile_sessions_expiry ON mobile_sessions(refresh_expires_at, revoked_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_mobile_mutation_receipts_expiry ON mobile_mutation_receipts(expires_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_mobile_refresh_history_consumed ON mobile_refresh_token_history(consumed_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_time_entries_location_date ON time_entries(location_id, work_date, entry_timestamp)");
db.exec("CREATE INDEX IF NOT EXISTS idx_time_corrections_context ON time_corrections(location_id, department_id, status, correction_date)");
db.exec("CREATE INDEX IF NOT EXISTS idx_time_corrections_pending_employee_date ON time_corrections(employee_number, correction_date, status)");
db.exec("CREATE INDEX IF NOT EXISTS idx_time_day_reviews_context ON time_day_reviews(location_id, department_id, work_date)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_wifi_preference_external_subject ON wifi_automation_preferences(provider_id, external_subject_hash) WHERE TRIM(COALESCE(external_subject_hash, '')) <> ''");
db.exec("CREATE INDEX IF NOT EXISTS idx_wifi_presence_employee_state ON wifi_presence_sessions(employee_number, state, observed_start_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_wifi_presence_location_state ON wifi_presence_sessions(location_id, state, observed_start_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_wifi_event_inbox_processing ON wifi_event_inbox(processing_status, received_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_wifi_suggestions_employee_date ON wifi_time_suggestions(employee_number, work_date, status)");
db.exec("CREATE INDEX IF NOT EXISTS idx_wifi_location_mapping_hash ON wifi_location_mappings(provider_id, external_location_hash)");
db.prepare("UPDATE time_entries SET work_date = SUBSTR(entry_timestamp, 1, 10) WHERE TRIM(COALESCE(work_date, '')) = ''").run();
db.prepare(`
  UPDATE time_entries
  SET location_id = (SELECT e.home_location_id FROM employees e WHERE e.personnel_number = time_entries.employee_number)
  WHERE TRIM(COALESCE(location_id, '')) = ''
`).run();
db.prepare(`
  UPDATE time_entries
  SET department_id = COALESCE(
    (SELECT s.department_id FROM shifts s
      WHERE s.employee_number = time_entries.employee_number AND s.shift_date = time_entries.work_date AND s.department_id IS NOT NULL
      ORDER BY s.start_time, s.id LIMIT 1),
    (SELECT e.preferred_department_id FROM employees e WHERE e.personnel_number = time_entries.employee_number)
  )
  WHERE department_id IS NULL
`).run();
db.prepare(`
  UPDATE time_corrections
  SET location_id = COALESCE(
    (SELECT t.location_id FROM time_entries t
      WHERE t.employee_number = time_corrections.employee_number AND t.work_date = time_corrections.correction_date
        AND TRIM(COALESCE(t.location_id, '')) <> ''
      ORDER BY t.entry_timestamp, t.id LIMIT 1),
    (SELECT e.home_location_id FROM employees e WHERE e.personnel_number = time_corrections.employee_number)
  )
  WHERE TRIM(COALESCE(location_id, '')) = ''
`).run();
db.prepare(`
  UPDATE time_corrections
  SET department_id = COALESCE(
    (SELECT t.department_id FROM time_entries t
      WHERE t.employee_number = time_corrections.employee_number AND t.work_date = time_corrections.correction_date
        AND t.department_id IS NOT NULL
      ORDER BY t.entry_timestamp, t.id LIMIT 1),
    (SELECT s.department_id FROM shifts s
      WHERE s.employee_number = time_corrections.employee_number AND s.shift_date = time_corrections.correction_date
        AND s.department_id IS NOT NULL
      ORDER BY s.start_time, s.id LIMIT 1),
    (SELECT e.preferred_department_id FROM employees e WHERE e.personnel_number = time_corrections.employee_number)
  )
  WHERE department_id IS NULL
`).run();
db.prepare(`
  UPDATE time_corrections SET requested_by = employee_number
  WHERE TRIM(COALESCE(requested_by, '')) = ''
`).run();
ensureColumn("vacation_requests", "vacation_group_id", "TEXT");
ensureColumn("vacation_requests", "location_id", "TEXT");
ensureColumn("vacation_requests", "approval_stage", "TEXT NOT NULL DEFAULT 'local'");
ensureColumn("vacation_requests", "decision_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("vacation_requests", "local_approved_by", "TEXT");
ensureColumn("vacation_requests", "local_approved_at", "TEXT");
ensureColumn("vacation_requests", "hr_approved_by", "TEXT");
ensureColumn("vacation_requests", "hr_approved_at", "TEXT");
ensureColumn("time_off_requests", "location_id", "TEXT");
ensureColumn("time_off_requests", "approval_type", "TEXT NOT NULL DEFAULT 'local'");
ensureColumn("time_off_requests", "approval_stage", "TEXT NOT NULL DEFAULT 'local'");
ensureColumn("time_off_requests", "decision_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("time_off_requests", "local_approved_by", "TEXT");
ensureColumn("time_off_requests", "local_approved_at", "TEXT");
ensureColumn("time_off_requests", "hr_approved_by", "TEXT");
ensureColumn("time_off_requests", "hr_approved_at", "TEXT");
ensureColumn("time_off_requests", "original_shifts_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("time_off_requests", "date_from", "TEXT");
ensureColumn("time_off_requests", "date_to", "TEXT");
ensureColumn("time_off_requests", "all_day", "INTEGER NOT NULL DEFAULT 0");
db.prepare("UPDATE time_off_requests SET date_from = COALESCE(date_from, request_date), date_to = COALESCE(date_to, request_date) WHERE date_from IS NULL OR date_to IS NULL").run();
ensureColumn("vacation_change_requests", "approval_stage", "TEXT NOT NULL DEFAULT 'local'");
ensureColumn("vacation_change_requests", "decision_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("vacation_change_requests", "local_approved_by", "TEXT");
ensureColumn("vacation_change_requests", "local_approved_at", "TEXT");
ensureColumn("vacation_change_requests", "hr_approved_by", "TEXT");
ensureColumn("vacation_change_requests", "hr_approved_at", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_portal_users_role_active ON portal_users(role, active)");
db.exec("CREATE INDEX IF NOT EXISTS idx_amu_local_access_mode ON amu_local_access_overrides(access_mode, updated_at)");

function rebuildGlobalDayBlocksForLocations() {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE global_day_blocks RENAME TO global_day_blocks_legacy");
    db.exec(`
      CREATE TABLE global_day_blocks (
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
    `);
    db.exec(`
      INSERT OR IGNORE INTO global_day_blocks
        (id, location_id, week_start, block_date, reason, is_public_holiday, created_at)
      SELECT id, '18', week_start, block_date, reason, is_public_holiday, created_at
      FROM global_day_blocks_legacy;
      DROP TABLE global_day_blocks_legacy;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

if (!columnExists("global_day_blocks", "location_id")) {
  rebuildGlobalDayBlocksForLocations();
}
db.exec("CREATE INDEX IF NOT EXISTS idx_global_day_blocks_location_week ON global_day_blocks(location_id, week_start)");
}

module.exports = {
  runSqliteHistoricalCompatibilityMigrations,
};
