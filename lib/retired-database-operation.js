"use strict";

function rejectLegacyDatabaseOperation() {
  throw Object.assign(new Error("Der GP-Server verwendet ausschließlich das PostgreSQL-Core-/Sales-Paar. Sicherungen und Wiederherstellungen erfolgen über die gemeinsame Serverwartung; alte Sicherungen werden mit der getrennten Offline-Recovery-Kapsel geprüft."), {
    code: "PG_PAIRED_MAINTENANCE_REQUIRED",
  });
}
function reportLegacyDatabaseOperation() {
  try { rejectLegacyDatabaseOperation(); }
  catch (error) { process.stderr.write(`${error.code}: ${error.message}\n`); process.exitCode = 1; }
}
module.exports = { rejectLegacyDatabaseOperation, reportLegacyDatabaseOperation };
