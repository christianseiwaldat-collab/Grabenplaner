"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/contract");
const {
  createPortalBirthdayPresentationsRepository,
} = require("../lib/persistence/repositories/portal-birthday-presentations");
const {
  SQLITE_PORTAL_BIRTHDAY_PRESENTATION_CATALOG,
} = require("../lib/persistence/sqlite/portal-birthday-presentations");
const {
  ensureSqlitePortalBirthdayPresentationSchema,
  inspectSqlitePortalBirthdayPresentationRows,
} = require("../lib/persistence/sqlite/operations/portal-birthday-presentation-schema");
const {
  ensureSqlitePortalBirthdayPresentationClaimSchema,
  inspectSqlitePortalBirthdayPresentationClaimRows,
} = require("../lib/persistence/sqlite/operations/portal-birthday-presentation-claim-schema");
const {
  PORTAL_BIRTHDAY_PRESENTATION_STATEMENTS,
} = require("../lib/persistence/statements/portal-birthday-presentations");


test("Statement- und SQLite-Katalog sind typisiert, vollständig und isoliert", () => {
  assert.deepEqual(Object.keys(PORTAL_BIRTHDAY_PRESENTATION_STATEMENTS).sort(), [
    "claimEvent",
    "getAssignment",
    "getPolicy",
    "insertAssignment",
    "listAssignments",
    "listClaimsForEmployee",
    "updateAssignment",
    "updatePolicy",
  ]);
  assert.equal(SQLITE_PORTAL_BIRTHDAY_PRESENTATION_CATALOG.length, 8);
  assert.equal(new Set(SQLITE_PORTAL_BIRTHDAY_PRESENTATION_CATALOG
    .map(({ statement }) => statement.id)).size, 8);
  assert.equal(Object.isFrozen(SQLITE_PORTAL_BIRTHDAY_PRESENTATION_CATALOG), true);
});
