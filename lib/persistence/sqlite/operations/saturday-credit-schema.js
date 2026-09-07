"use strict";
function ensureSqliteSaturdayCreditSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS saturday_credit_records (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('cutover','assignment','valuation')),
      employee_number TEXT NOT NULL, effective_date TEXT NOT NULL,
      payload TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_saturday_credit_employee_date ON saturday_credit_records(employee_number,kind,effective_date,created_at);
    CREATE TRIGGER IF NOT EXISTS trg_saturday_credit_immutable_update BEFORE UPDATE ON saturday_credit_records
    BEGIN SELECT RAISE(ABORT, 'Saturday credit records are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_saturday_credit_immutable_delete BEFORE DELETE ON saturday_credit_records
    BEGIN SELECT RAISE(ABORT, 'Saturday credit records are immutable'); END;
  `);
}
module.exports = { ensureSqliteSaturdayCreditSchema };
