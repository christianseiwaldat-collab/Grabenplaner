"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createSicknessAmuManagementRepository,
} = require("../lib/persistence/repositories/sickness-amu-management");
const {
  SQLITE_SICKNESS_AMU_MANAGEMENT_CATALOG,
} = require("../lib/persistence/sqlite/sickness-amu-management-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  SICKNESS_AMU_MANAGEMENT_STATEMENTS,
} = require("../lib/persistence/statements/sickness-amu-management");


test("Block 3/7: Krankheits-, AUM- und Personalakt-Katalog ist vollstaendig", () => {
  const statements = Object.values(SICKNESS_AMU_MANAGEMENT_STATEMENTS);
  assert.equal(SQLITE_SICKNESS_AMU_MANAGEMENT_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_SICKNESS_AMU_MANAGEMENT_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_SICKNESS_AMU_MANAGEMENT_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});

test("Block 3/7: Serverpfad enthaelt keine rohen Tabellenzugriffe des Fachbereichs", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.doesNotMatch(
    source,
    /\b(?:sickness_cases|sickness_alerts|protected_case_events|sickness_notification_preferences|sickness_notification_verifications|outbound_notification_jobs|amu_reports|amu_documents|personnel_record_documents)\b/,
  );
  assert.match(source, /sicknessAmuManagementRepository/);
});
