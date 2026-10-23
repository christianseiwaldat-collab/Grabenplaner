"use strict";

// Retained entrypoint name; historical database execution is offline-only.
const { rejectLegacyDatabaseOperation, reportLegacyDatabaseOperation } = require("../../../../lib/retired-database-operation");
if (require.main === module) reportLegacyDatabaseOperation();
module.exports = { sanitizeSmokeDatabase: rejectLegacyDatabaseOperation, verifiedApplicationSmokeResult: rejectLegacyDatabaseOperation };
