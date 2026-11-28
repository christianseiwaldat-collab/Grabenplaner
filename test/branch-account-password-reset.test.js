"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
const branchReset = require("../lib/branch-account-password-reset");
const { publicSettingsRows, publicSettingsObject } = require("../lib/privacy-organization-settings");
const { loginFailureParameters } = require("../lib/portal-login-security");

function fixture() {
  const account = {
    id: "test-branch-18", login_name: "fil18", display_name: "Grabenweg",
    account_type: "branch", active: 1, password_hash: "original",
    scopes_json: '[{"locationId":"18"}]', locked_until: "2099-01-01T00:00:00.000Z", failed_login_attempts: 5,
  };
  const settings = new Map();
  const mail = [];
  const audits = [];
  const revoked = [];
  let now = Date.parse("2026-11-24T13:00:00.000Z");
  const repositories = {
    planningSettings: {
      async listPortalSettings() {
        return [...settings].map(([key, value]) => ({ key, value }));
      },
      async upsertPortalSetting({ key, value }) { settings.set(key, value); },
    },
    portalAccess: {
      async getOrganizationLogin({ loginName }) {
        return loginName === account.login_name ? { account_id: account.id } : null;
      },
      async revokeOrganizationSessionsForAccount({ accountId }) { revoked.push(["sessions", accountId]); },
    },
    organizationPersonnel: {
      async getOrganizationAccount(id) { return id === account.id ? { ...account } : null; },
      async updateOrganizationAccountPassword(id, hash, actor, policyVersion) {
        assert.equal(id, account.id);
        assert.equal(actor, "password-reset-public");
        assert.equal(policyVersion, 1);
        Object.assign(account, { password_hash: hash, locked_until: null, failed_login_attempts: 0 });
        return { rowsAffected: 1 };
      },
      async revokePasskeys(kind, id) { revoked.push([kind, id]); },
      async insertAudit(...event) { audits.push(event); },
    },
  };
  let mailUnavailable = false;
  const service = branchReset.createBranchAccountPasswordReset({
    repositories,
    transaction: work => work(repositories),
    async sendPasswordReset(message) {
      mail.push(message);
      if (mailUnavailable) throw new Error("synthetic mail failure");
    },
    resetUrl: rawToken => "https://gp.example.test/portal.html#password-reset=" + rawToken,
    async hashPassword(password, context) {
      assert.deepEqual(context, { loginName: "fil18", displayName: "Grabenweg" });
      return "new hash for " + password;
    },
    passwordPolicyVersion: 1,
    invalidToken: () => new Error("invalid token"),
    requestWindowMs: 15 * 60_000,
    maxRequests: 3,
    tokenTtlMs: 30 * 60_000,
    clock: () => now,
  });
  return {
    account, settings, mail, audits, revoked, service, repositories,
    configure: email => branchReset.setRecoveryEmail(repositories.planningSettings, account.id, email),
    advance: minutes => { now += minutes * 60_000; },
    failMail: () => { mailUnavailable = true; },
    token: message => new URL(message.resetUrl).hash.slice("#password-reset=".length),
    async reset(message) {
      const token = this.token(message);
      const tokenHash = createHash("sha256").update(token).digest("hex");
      return service.complete({ tokenHash, newPassword: "synthetic new password" });
    },
  };
}

test("branch lock follows the fifth failed password and lasts 30 minutes", () => {
  const now = new Date("2026-11-24T13:44:16.503Z");
  const result = loginFailureParameters({ account_id: "test-branch-18" }, branchReset.LOGIN_POLICY, now);
  assert.equal(result.maximum, 5);
  assert.equal(result.lockedUntil, "2026-11-24T14:14:16.503Z");
});

test("only a configured active branch receives an email and a reset unlocks it once", async () => {
  const f = fixture();
  assert.equal(await f.service.issue("fil18"), false);
  await f.configure("grabenweg@example.test");
  assert.equal(await f.service.issue("wrong-branch"), false);
  assert.equal(await f.service.issue("fil18"), true);
  assert.equal(f.mail.length, 1);
  assert.equal(f.mail[0].recipient, "grabenweg@example.test");
  assert.match(f.token(f.mail[0]), /^[A-Za-z0-9_-]{43}$/);
  assert(![...f.settings.values()][0].includes(f.token(f.mail[0])));
  await f.reset(f.mail[0]);
  assert.equal(f.account.password_hash, "new hash for synthetic new password");
  assert.equal(f.account.locked_until, null);
  assert.equal(f.account.failed_login_attempts, 0);
  assert.deepEqual(f.revoked, [["organization", "test-branch-18"], ["sessions", "test-branch-18"]]);
  assert.equal(f.audits.at(-1)[1], "portal.password-reset.completed");
  await assert.rejects(() => f.reset(f.mail[0]), /invalid token/);
});

test("expired links and links issued before a change of mailbox or scope fail", async () => {
  const f = fixture();
  await f.configure("original@example.test");
  await f.service.issue("fil18");
  f.advance(30);
  await assert.rejects(() => f.reset(f.mail[0]), /invalid token/);

  await f.service.issue("fil18");
  await f.configure("replacement@example.test");
  await assert.rejects(() => f.reset(f.mail[1]), /invalid token/);

  await f.service.issue("fil18");
  f.account.scopes_json = '[{"locationId":"13"}]';
  await assert.rejects(() => f.reset(f.mail[2]), /invalid token/);
  assert.equal(f.account.password_hash, "original");
});

test("mail failure revokes the link and persists the normal reset rate limit", async () => {
  const f = fixture();
  await f.configure("grabenweg@example.test");
  f.failMail();
  for (let request = 0; request < 4; request++) {
    assert.equal(await f.service.issue("fil18"), false);
  }
  assert.equal(f.mail.length, 3);
  assert.equal(f.audits.at(-1)[1], "portal.password-reset.delivery-failed");
  await assert.rejects(() => f.reset(f.mail[0]), /invalid token/);
  f.account.active = 0;
  f.advance(16);
  assert.equal(await f.service.issue("fil18"), false);
  assert.equal(f.mail.length, 3);
});

test("recovery settings stay private and reject multi-address recipients", async () => {
  const f = fixture();
  await f.configure("grabenweg@example.test");
  assert.deepEqual(publicSettingsRows(await f.repositories.planningSettings.listPortalSettings()), []);
  assert.deepEqual(publicSettingsObject(Object.fromEntries(f.settings)), {});
  assert.equal(branchReset.normalizeRecoveryEmail("first,second@example.test"), "");
  assert.equal(branchReset.normalizeRecoveryEmail("address@EXAMPLE.TEST"), "address@example.test");
});
