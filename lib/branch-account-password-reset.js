"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { normalizePersonalEmailAddress } = require("./personal-email-address");

const SETTING_PREFIX = "branch_account_password_reset_";
const LOGIN_POLICY = Object.freeze({ max_failed_login_attempts: 5, account_lock_minutes: 30 });

function isBranchAccountPasswordResetSettingKey(key) {
  return typeof key === "string" && key.startsWith(SETTING_PREFIX);
}

function normalizeRecoveryEmail(value) {
  const email = normalizePersonalEmailAddress(value);
  return email && !/[<>,:;"()[\]\\]/.test(email) ? email : "";
}

const settingKey = accountId => SETTING_PREFIX + accountId;
const tokenHash = token => createHash("sha256").update(token).digest("hex");

function recoverySettings(rows) {
  const records = new Map();
  for (const row of rows) {
    if (!isBranchAccountPasswordResetSettingKey(row.key)) continue;
    try {
      const value = JSON.parse(row.value);
      const email = normalizeRecoveryEmail(value?.email);
      if (email) records.set(row.key.slice(SETTING_PREFIX.length), { ...value, email });
    } catch {
      // A malformed credential setting is unavailable for password recovery.
    }
  }
  return records;
}

function writeRecoverySetting(repository, accountId, value) {
  return repository.upsertPortalSetting({ key: settingKey(accountId), value: JSON.stringify(value) });
}

function accountFingerprint(account, email) {
  return tokenHash(JSON.stringify([
    account.id, account.login_name, account.password_hash, account.scopes_json, email,
  ]));
}

function activeBranchAccount(account) {
  return account?.account_type === "branch" && Boolean(account.active) && Boolean(account.password_hash);
}

async function setRecoveryEmail(repository, accountId, email, { revoke = false } = {}) {
  const current = recoverySettings(await repository.listPortalSettings()).get(accountId);
  const nextEmail = email ?? current?.email ?? "";
  if ((current?.email || "") !== nextEmail || (revoke && current?.pending)) {
    await writeRecoverySetting(repository, accountId, { email: nextEmail });
  }
}

function createBranchAccountPasswordReset({
  repositories,
  transaction,
  sendPasswordReset,
  resetUrl,
  hashPassword,
  passwordPolicyVersion,
  invalidToken,
  requestWindowMs,
  maxRequests,
  tokenTtlMs,
  clock = Date.now,
}) {
  async function issue(loginName) {
    const rawToken = randomBytes(32).toString("base64url");
    const hash = tokenHash(rawToken);
    const issued = await transaction(async ({ portalAccess, organizationPersonnel, planningSettings }) => {
      const login = await portalAccess.getOrganizationLogin({ loginName });
      if (!login) return null;
      const account = await organizationPersonnel.getOrganizationAccount(login.account_id);
      if (!activeBranchAccount(account)) return null;
      const record = recoverySettings(await planningSettings.listPortalSettings()).get(account.id);
      if (!record) return null;
      const now = clock();
      const recent = (Array.isArray(record.requests) ? record.requests : [])
        .filter(time => Number.isSafeInteger(time) && time > now - requestWindowMs && time <= now);
      if (recent.length >= maxRequests) return null;
      const pending = { hash, expiresAt: now + tokenTtlMs, fingerprint: accountFingerprint(account, record.email) };
      await writeRecoverySetting(planningSettings, account.id, { email: record.email, requests: [...recent, now], pending });
      return { accountId: account.id, email: record.email };
    });
    if (!issued) return false;

    let action = "portal.password-reset.requested";
    try {
      await sendPasswordReset({ recipient: issued.email, resetUrl: resetUrl(rawToken) });
    } catch {
      action = "portal.password-reset.delivery-failed";
      await transaction(async ({ planningSettings }) => {
        const record = recoverySettings(await planningSettings.listPortalSettings()).get(issued.accountId);
        if (record?.pending?.hash === hash) {
          await writeRecoverySetting(planningSettings, issued.accountId, { email: record.email, requests: record.requests });
        }
      });
    }
    await repositories.organizationPersonnel.insertAudit("password-reset-public", action,
      "portal_organization_account", issued.accountId);
    return action === "portal.password-reset.requested";
  }

  async function availableToken({ organizationPersonnel, planningSettings }, hash) {
    const now = clock();
    const records = recoverySettings(await planningSettings.listPortalSettings());
    const match = [...records].find(([, record]) => record.pending?.hash === hash && record.pending.expiresAt > now);
    if (!match) return null;
    const [accountId, record] = match;
    const account = await organizationPersonnel.getOrganizationAccount(accountId);
    if (!activeBranchAccount(account) || accountFingerprint(account, record.email) !== record.pending.fingerprint) return null;
    return { account, record };
  }

  async function complete({ tokenHash: hash, newPassword, browserSession }) {
    const initial = await availableToken(repositories, hash);
    if (!initial) throw invalidToken();
    const passwordHash = await hashPassword(newPassword, {
      loginName: initial.account.login_name, displayName: initial.account.display_name,
    });
    await transaction(async currentRepositories => {
      const current = await availableToken(currentRepositories, hash);
      if (!current || current.account.id !== initial.account.id) throw invalidToken();
      const { organizationPersonnel, planningSettings, portalAccess } = currentRepositories;
      const accountId = current.account.id;
      const changed = await organizationPersonnel.updateOrganizationAccountPassword(
        accountId, passwordHash, "password-reset-public", passwordPolicyVersion,
      );
      if (!changed.rowsAffected) throw invalidToken();
      await organizationPersonnel.revokePasskeys("organization", accountId);
      await portalAccess.revokeOrganizationSessionsForAccount({ accountId });
      if (browserSession?.id && browserSession.sessionKind !== "organization") {
        await portalAccess.revokeEmployeeSessionById({ id: browserSession.id });
      } else if (browserSession?.id && browserSession.accountId !== accountId) {
        await portalAccess.revokeOrganizationSessionById({ id: browserSession.id });
      }
      await writeRecoverySetting(planningSettings, accountId, {
        email: current.record.email, requests: current.record.requests,
      });
      await organizationPersonnel.insertAudit("password-reset-public", "portal.password-reset.completed",
        "portal_organization_account", accountId);
    });
  }

  return Object.freeze({ issue, complete });
}

module.exports = {
  SETTING_PREFIX,
  LOGIN_POLICY,
  isBranchAccountPasswordResetSettingKey,
  normalizeRecoveryEmail,
  recoverySettings,
  setRecoveryEmail,
  createBranchAccountPasswordReset,
};
