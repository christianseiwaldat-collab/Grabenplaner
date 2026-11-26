"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createMobileAuthRepository,
} = require("../lib/persistence/repositories/mobile-auth");
const {
  SQLITE_MOBILE_AUTH_CATALOG,
} = require("../lib/persistence/sqlite/mobile-auth-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  MOBILE_AUTH_STATEMENTS,
} = require("../lib/persistence/statements/mobile-auth");


function sessionInput(overrides = {}) {
  return {
    id: "mobile-session",
    employeeNumber: "E18",
    accessTokenHash: "a".repeat(64),
    accessExpiresAt: "2026-07-29T12:00:00.000Z",
    refreshTokenHash: "b".repeat(64),
    refreshExpiresAt: "2026-08-29T12:00:00.000Z",
    installationIdHash: "c".repeat(64),
    platform: "android",
    deviceLabel: "Testgerät",
    appVersion: "1.0.0",
    ...overrides,
  };
}

test("Block 3/7: Mobile-Auth-Katalog deckt jedes typisierte Statement genau einmal ab", () => {
  const statements = Object.values(MOBILE_AUTH_STATEMENTS);
  assert.equal(SQLITE_MOBILE_AUTH_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_MOBILE_AUTH_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_MOBILE_AUTH_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});
