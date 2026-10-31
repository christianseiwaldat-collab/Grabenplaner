"use strict";

// Exact infrastructure relations, not a suffix exception. A newly encountered
// relation remains subject to the empty-business-data refusal until reviewed.
const technical = Object.freeze({
  core: new Set([
    "gp.environment_contract", "gp.core_migration_history", "gp.boundary_migration_history",
    "gp.trade_annotations_migration_history", "gp.learning_runs_migration_history",
    "gp.xoffi_snapshots_migration_history", "gp.vocational_school_migration_history",
    "gp.session_security_migration_history", "gp.passkeys_migration_history", "gp.schema_migrations",
  ]),
  sales: new Set([
    "gp.environment_contract", "gp.sales_migration_history", "gp.migration_fixture_owner",
    "gp.import_delete_migration_history", "gp.import_delete_performance_history",
    "gp.import_history_snapshots_migration_history",
    "gp.import_history_attestations_migration_history",
  ]),
});

function isTechnicalRelation(domain, schema, table) {
  return technical[domain]?.has(schema + "." + table) === true;
}

module.exports = { isTechnicalRelation };
