"use strict";
// Standalone in the separately installed Offsite module; no Core-relative import.
function rejectLegacyDatabaseOperation() {
  const error = new Error("Historische SQLite-Pruefungen benoetigen die getrennte Offline-Recovery-Kapsel; PostgreSQL verwendet die native Paarpruefung.");
  error.code = "PG_PAIRED_MAINTENANCE_REQUIRED"; throw error;
}
if (require.main === module) {
  try { rejectLegacyDatabaseOperation(); } catch (error) { process.stderr.write(error.code + "\n"); process.exitCode = 1; }
}
module.exports = { sanitizeSmokeDatabase: rejectLegacyDatabaseOperation, verifiedApplicationSmokeResult: rejectLegacyDatabaseOperation };
