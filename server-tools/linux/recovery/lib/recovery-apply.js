"use strict";

// The historical filesystem apply is available only in the immutable offline
// preservation capsule. Current servers must restore PostgreSQL as a pair.
function legacyOfflineRequired() {
  throw Object.assign(new Error("RECOVERY_LEGACY_OFFLINE_REQUIRED: PostgreSQL benoetigt eine gekoppelte Wiederherstellung. Alte SQLite-Sicherungen ausschliesslich mit der archivierten Offline-Recovery in einer isolierten neuen Umgebung wiederherstellen."), { code: "RECOVERY_LEGACY_OFFLINE_REQUIRED" });
}
if (require.main === module) {
  try { legacyOfflineRequired(); }
  catch (error) { process.stderr.write(JSON.stringify({ event: "recovery-apply-rejected", code: error.code }) + "\n"); process.exitCode = 1; }
}
module.exports = { applyRecovery: legacyOfflineRequired, assertSqliteRecoveryTarget: legacyOfflineRequired };
