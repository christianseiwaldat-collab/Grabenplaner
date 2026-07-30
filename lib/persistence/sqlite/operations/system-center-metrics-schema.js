"use strict";

function ensureSqliteSystemCenterMetricsSchema(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS system_center_trust_metrics (
      interval_key TEXT PRIMARY KEY,
      recorded_at TEXT NOT NULL,
      trust_score INTEGER NOT NULL,
      coverage INTEGER NOT NULL,
      trust_state TEXT NOT NULL,
      database_bytes INTEGER,
      storage_free_bytes INTEGER,
      automation_state TEXT NOT NULL,
      previous_hash TEXT,
      sample_hash TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_system_center_trust_metrics_recorded
      ON system_center_trust_metrics(recorded_at);
  `);
}

module.exports = {
  ensureSqliteSystemCenterMetricsSchema,
};
