"use strict";

function assertSqliteOperationsDatabase(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  return database;
}

function ensureSqliteCollectiveAgreementsSchema(database) {
  assertSqliteOperationsDatabase(database).exec(`
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
  `);
}

module.exports = {
  ensureSqliteCollectiveAgreementsSchema,
};
