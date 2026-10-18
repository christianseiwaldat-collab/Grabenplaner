"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createApplicationRepositories } = require("../../lib/persistence/application-repositories");
const { loginFailureParameters, runLoginTransaction, acceptVerifiedLogin } = require("../../lib/portal-login-security");
const NOW = new Date("2026-10-18T12:00:00.000Z");
const OLD_HASH = "synthetic-credential-generation-1";
const NEW_HASH = "synthetic-credential-generation-2";

async function withFixture(kind, work) {
  if (kind === "postgresql") {
    for (const purpose of ["APP", "MIGRATOR"]) {
      const url = new URL(process.env[`GP_CORE_${purpose}_URL`]);
      assert.equal(url.hostname, "127.0.0.1");
      assert.equal(url.pathname, "/gp_migration_core");
    }
    return require("../postgresql-migration/core-fixture").withCoreFixture(async f => {
      await f.migrator.query("SET ROLE gp_core_owner; SET search_path=pg_catalog,gp");
      return work(await model(f.postgres, (sql, values = []) => f.migrator.query(sql, values),
        async (sql, values = []) => (await f.migrator.query(sql, values)).rows));
    });
  }
  const { openSqliteApplicationPersistence } = require("../../lib/persistence/sqlite/provider");
  const { SQLITE_APPLICATION_CATALOG } = require("../../lib/persistence/sqlite/application-catalog");
  const { ensureSqliteApplicationSchema } = require("../../lib/persistence/sqlite/operations/application-schema");
  const app = openSqliteApplicationPersistence({ databasePath: ":memory:", catalog: SQLITE_APPLICATION_CATALOG });
  try {
    ensureSqliteApplicationSchema(app.database);
    app.database.exec(`INSERT INTO locations(id,name,active) VALUES('18','Synthetic',1);
      INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,active) VALUES('00001','Synthetic','Synthetic','18',1);
      INSERT INTO portal_users(employee_number,password_hash,role,active) VALUES('00001','synthetic','employee',1);`);
    const sql = value => value.replace(/\$\d+/g, "?");
    return await work(await model(app.provider,
      async (query, values = []) => app.database.prepare(sql(query)).run(...values),
      async (query, values = []) => app.database.prepare(sql(query)).all(...values)));
  } finally { await app.provider.close(); app.database.close(); }
}

async function model(provider, execute, all) {
  await execute(`INSERT INTO portal_organization_accounts(id,login_name,display_name,account_type,password_hash,active)
    VALUES('audit-org','audit-org','Synthetic organization','branch','synthetic',1)`);
  const repositories = createApplicationRepositories(provider);
  const target = channel => channel === "organization"
    ? { table: "portal_organization_accounts", idColumn: "id", id: "audit-org", login: "audit-org", sessionTable: "portal_organization_sessions", sessionId: "account_id" }
    : { table: "portal_users", idColumn: "employee_number", id: "00001", login: "00001", sessionTable: channel === "mobile" ? "mobile_sessions" : "portal_sessions", sessionId: "employee_number" };
  async function reset(channel, { attempts = 0, lockedUntil = null, passwordHash = OLD_HASH } = {}) {
    const t = target(channel);
    await execute(`UPDATE ${t.table} SET password_hash=$1, failed_login_attempts=$2, locked_until=$3, active=1 WHERE ${t.idColumn}=$4`, [passwordHash, attempts, lockedUntil, t.id]);
    await execute("UPDATE employees SET active=1 WHERE personnel_number='00001'");
    for (const table of ["portal_sessions", "mobile_sessions", "portal_organization_sessions"]) await execute(`DELETE FROM ${table}`);
  }
  const snapshot = async channel => {
    const user = await (channel === "organization"
      ? repositories.portalAccess.getOrganizationLogin({ loginName: target(channel).login })
      : repositories.portalAccess.getEmployeeLogin({ loginName: target(channel).login }));
    assert.ok(user, `Synthetic ${channel} login fixture must exist before scheduling concurrent work`);
    return user;
  };
  const failure = (channel, user, options = {}) => {
    const params = loginFailureParameters(user, { max_failed_login_attempts: options.maximum || 5, account_lock_minutes: 15 }, options.now || NOW);
    const repo = options.repository || repositories.portalAccess;
    return channel === "organization" ? repo.updateOrganizationLoginFailure(params) : repo.updateEmployeeLoginFailure(params);
  };
  async function login(channel, user, { beforeCommit, failInsert = false, now = NOW } = {}) {
    return runLoginTransaction(provider, createApplicationRepositories, async repos => {
      const status = await acceptVerifiedLogin(repos.portalAccess, { user, organization: channel === "organization", now });
      if (status !== "accepted") return status;
      const id = randomUUID();
      const expiresAt = "2026-10-18T20:00:00.000Z";
      const origin = { authenticatedAt: NOW.toISOString(), absoluteExpiresAt: "2026-10-19T00:00:00.000Z" };
      if (channel === "organization") {
        await repos.portalAccess.revokeOrganizationSessionsForAccount({ accountId: user.account_id });
        await repos.portalAccess.insertOrganizationSession({ id, accountId: user.account_id, tokenHash: id, expiresAt, ...origin });
      } else if (channel === "mobile") {
        await repos.mobileAuth.revokeDeviceSessions({ employeeNumber: user.employee_number, installationIdHash: "synthetic-device" });
        await repos.mobileAuth.insertSession({ id, employeeNumber: user.employee_number, accessTokenHash: id,
          accessExpiresAt: expiresAt, refreshTokenHash: "refresh-" + id, refreshExpiresAt: expiresAt,
          installationIdHash: "synthetic-device", platform: "android", deviceLabel: "Synthetic", appVersion: "1.0" });
      } else {
        await repos.portalAccess.revokeEmployeeSessionsForEmployee({ employeeNumber: user.employee_number });
        await repos.portalAccess.insertEmployeeSession({ id, employeeNumber: user.employee_number, tokenHash: id, expiresAt, ...origin });
      }
      if (failInsert) throw new Error("synthetic session failure");
      await beforeCommit?.();
      return status;
    });
  }
  async function passwordReset(channel, beforeCommit) {
    return runLoginTransaction(provider, createApplicationRepositories, async repos => {
      if (channel === "organization") {
        await repos.organizationPersonnel.updateOrganizationAccountPassword("audit-org", NEW_HASH, "synthetic");
        await repos.portalAccess.revokeOrganizationSessionsForAccount({ accountId: "audit-org" });
      } else {
        await repos.portalAccess.updatePasswordFromReset({ employeeNumber: "00001", passwordHash: NEW_HASH, changedAt: NOW.toISOString() });
        await repos.portalAccess.revokeEmployeeSessionsForEmployee({ employeeNumber: "00001" });
        await repos.portalAccess.revokeMobileSessionsForPasswordReset({ employeeNumber: "00001" });
      }
      await beforeCommit?.();
    });
  }
  async function activeSessions(channel) {
    const t = target(channel);
    return Number((await all(`SELECT COUNT(*) AS count FROM ${t.sessionTable} WHERE ${t.sessionId}=$1 AND revoked_at IS NULL`, [t.id]))[0].count);
  }
  return { provider, repositories, execute, all, target, reset, snapshot, failure, login, passwordReset, activeSessions };
}

module.exports = { withFixture, NOW, OLD_HASH, NEW_HASH };
