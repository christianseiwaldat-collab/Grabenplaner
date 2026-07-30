"use strict";

function assertSqliteOperationsDatabase(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benötigt.");
  }
  return database;
}

function ensureSqliteWorkRuleStoreSchema(database) {
  assertSqliteOperationsDatabase(database).exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS work_rule_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      jurisdiction TEXT NOT NULL DEFAULT 'AT',
      sector TEXT NOT NULL DEFAULT 'general',
      builtin INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','active','retired')),
      current_version_id TEXT,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS work_rule_profile_versions (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      version TEXT NOT NULL,
      layer TEXT NOT NULL
        CHECK(layer IN ('law','sector','collective_agreement','company','contract')),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','published','retired')),
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      rules_json TEXT NOT NULL,
      sources_json TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      published_at TEXT,
      UNIQUE(profile_id, version),
      FOREIGN KEY (profile_id) REFERENCES work_rule_profiles(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS work_rule_assignments (
      id TEXT PRIMARY KEY,
      profile_version_id TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'installation'
        CHECK(scope_type IN ('installation','location','department','employee')),
      scope_key TEXT NOT NULL DEFAULT '',
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      enforcement_mode TEXT NOT NULL DEFAULT 'monitor'
        CHECK(enforcement_mode IN ('monitor','enforced')),
      applicability_confirmed INTEGER NOT NULL DEFAULT 0,
      confirmed_by TEXT NOT NULL DEFAULT '',
      confirmed_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_version_id) REFERENCES work_rule_profile_versions(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS work_rule_evaluation_runs (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL
        CHECK(target_type IN ('planned_schedule','actual_time')),
      scope_type TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      period_from TEXT NOT NULL,
      period_to TEXT NOT NULL,
      profile_version_ids_json TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      result_sha256 TEXT NOT NULL,
      result_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      outcome TEXT NOT NULL
        CHECK(outcome IN ('pass','attention','manual_review','blocked')),
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_profile_versions_immutable_update
    BEFORE UPDATE ON work_rule_profile_versions
    BEGIN
      SELECT RAISE(ABORT, 'work rule profile versions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_profile_versions_immutable_delete
    BEFORE DELETE ON work_rule_profile_versions
    BEGIN
      SELECT RAISE(ABORT, 'work rule profile versions are immutable');
    END;
  `);
}

function ensureSqliteWorkRuleEvaluationReceiptTriggers(database) {
  assertSqliteOperationsDatabase(database).exec(`
    CREATE TRIGGER IF NOT EXISTS trg_work_rule_evaluations_immutable_update
    BEFORE UPDATE ON work_rule_evaluation_runs
    BEGIN
      SELECT RAISE(ABORT, 'work rule evaluation receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_rule_evaluations_immutable_delete
    BEFORE DELETE ON work_rule_evaluation_runs
    BEGIN
      SELECT RAISE(ABORT, 'work rule evaluation receipts are immutable');
    END;
  `);
}

function dropSqliteWorkRuleEvaluationReceiptTriggers(database) {
  assertSqliteOperationsDatabase(database).exec(`
    DROP TRIGGER IF EXISTS trg_work_rule_evaluations_immutable_update;
    DROP TRIGGER IF EXISTS trg_work_rule_evaluations_immutable_delete;
  `);
}

module.exports = {
  dropSqliteWorkRuleEvaluationReceiptTriggers,
  ensureSqliteWorkRuleEvaluationReceiptTriggers,
  ensureSqliteWorkRuleStoreSchema,
};
