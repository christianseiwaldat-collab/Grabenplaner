"use strict";

// An explicit restore-copy transformation, never a schema migration or app
// startup hook. A verified old checkpoint must not reactivate a lost passkey,
// an old browser/mobile session or a previously invalidated reset link.
const SCOPE = "verified-restore-copy-v1";
const statements = Object.freeze([
  ["employeeSessions", "UPDATE gp.portal_sessions SET revoked_at=$1 WHERE revoked_at IS NULL"],
  ["organizationSessions", "UPDATE gp.portal_organization_sessions SET revoked_at=$1 WHERE revoked_at IS NULL"],
  ["mobileSessions", "UPDATE gp.mobile_sessions SET revoked_at=$1,revoked_reason='backup_restore',updated_at=$1 WHERE revoked_at IS NULL"],
  ["passwordResetTokens", "UPDATE gp.portal_password_reset_tokens SET revoked_at=$1 WHERE revoked_at IS NULL AND used_at IS NULL"],
  ["passkeySubjects", "UPDATE gp.passkey_subjects SET auth_revision=auth_revision+1,updated_at=$1"],
  ["passkeyCredentials", "UPDATE gp.passkey_credentials SET revoked_at=$1,revision=revision+1 WHERE revoked_at IS NULL"],
  ["passkeyChallenges", "UPDATE gp.passkey_challenges SET consumed_at=$1 WHERE consumed_at IS NULL"],
]);

async function invalidateRestoredAuthentication(client, { scope, binding, now = new Date().toISOString() } = {}) {
  if (scope !== SCOPE || typeof now !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now)
    || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new Error("PG_RESTORE_AUTHENTICATION_SCOPE");
  await require("../core/environment").verifyEnvironment(client, { purpose: "migrator", binding });
  let started = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL ROLE gp_core_owner; SET LOCAL search_path=pg_catalog,gp"); started = true;
    await client.query("SELECT pg_advisory_xact_lock(9261207)");
    await require("../boundary/migrate").verifyCoreSchema(client, { requireVocationalSchool: true, requireSessionSecurity: true, requirePasskeys: true });
    const revoked = {};
    for (const [name, sql] of statements) {
      const result = await client.query(sql, [now]);
      if (!Number.isSafeInteger(result.rowCount) || result.rowCount < 0) throw new Error("PG_RESTORE_AUTHENTICATION_RESULT");
      revoked[name] = result.rowCount;
    }
    await client.query("COMMIT"); started = false;
    return { format: "grabenplaner-restored-authentication-v1", scope: SCOPE, invalidatedAt: now, revoked, passwordsChanged: false };
  } catch (error) { if (started) await client.query("ROLLBACK"); throw error; }
}

module.exports = { SCOPE, statements, invalidateRestoredAuthentication };
