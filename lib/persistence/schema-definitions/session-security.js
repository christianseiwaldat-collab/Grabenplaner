"use strict";

// Canonical historical SQL definitions; this module never opens a database.
const MIGRATION_ID = "session-security-v1";
const COLUMNS = Object.freeze([
  { table: "portal_sessions", name: "authenticated_at", definition: "TEXT" },
  { table: "portal_sessions", name: "absolute_expires_at", definition: "TEXT" },
  { table: "portal_organization_sessions", name: "authenticated_at", definition: "TEXT" },
  { table: "portal_organization_sessions", name: "absolute_expires_at", definition: "TEXT" },
  { table: "portal_users", name: "password_policy_version", definition: "INTEGER NOT NULL DEFAULT 0 CHECK(password_policy_version >= 0)" },
  { table: "portal_organization_accounts", name: "password_policy_version", definition: "INTEGER NOT NULL DEFAULT 0 CHECK(password_policy_version >= 0)" },
]);
const REVOKE_SQL = Object.freeze([
  "UPDATE portal_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE revoked_at IS NULL",
  "UPDATE portal_organization_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE revoked_at IS NULL",
  "UPDATE mobile_sessions SET revoked_at=CURRENT_TIMESTAMP,revoked_reason='session_security_upgrade',updated_at=CURRENT_TIMESTAMP WHERE revoked_at IS NULL",
  "UPDATE portal_password_reset_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE revoked_at IS NULL AND used_at IS NULL",
]);


module.exports = { MIGRATION_ID, COLUMNS, REVOKE_SQL };
