"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const P = require("../lib/passkey-protocol");
const crypto = require("node:crypto");
const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
const fragment = source.slice(source.indexOf("function assertPasskeyAccount("), source.indexOf("async function rotatePasskeySession("));
function fixture() {
  const state = { session: { id: "synthetic-session", sessionKind: "employee", employeeNumber: "EX-USER", permissions: [], scopes: [{ locationId: "EX-11" }], role: "employee" },
    actor: { active: true, employee_active: true, employee_number: "EX-USER", password_hash: "synthetic-current-hash", password_policy_version: 1 },
    account: { id: "synthetic-target", login_name: "EX-BRANCH", account_type: "branch", locationIds: ["EX-11"] } };
  const sandbox = { Date, passkeyProtocol: P, PORTAL_PASSWORD_POLICY_VERSION: 1,
    RIGHTS_ADMIN_PORTAL_ROLES: new Set(["admin"]), BRANCH_ACCOUNT_PASSWORD_MANAGE_PERMISSION: "organization_accounts:password:manage",
    isReservedEmployeePrincipal: id => id === "system", httpError: (status, message, code) => Object.assign(Error(message), { status, code }),
    loadPortalSessionFromRequest: async () => structuredClone(state.session), sessionHasGlobalScope: session => session.role === "admin",
    assertManagedBranchAccountPasswordScope: (session, account) => {
      if (account.account_type !== "branch" || account.locationIds.some(id => !session.scopes.some(scope => scope.locationId === id))) throw P.failure("PORTAL_SCOPE_DENIED", 403);
    } };
  vm.runInNewContext(fragment, sandbox);
  const repos = { portalAccess: { getEmployeeLogin: async () => structuredClone(state.actor), getOrganizationLogin: async () => ({ ...state.actor, employee_number: "EX-BRANCH" }) },
    organizationPersonnel: { getOrganizationAccount: async () => structuredClone(state.account) } };
  return { state, context: (accountId, operation) => sandbox.passkeyContextFor({}, repos, { accountId, operation }), account: sandbox.assertPasskeyAccount };
}
test("Passkey management requires a current personal account with accepted password policy", async () => {
  const f = fixture(); const personal = await f.context(); assert.equal(personal.principalId, "EX-USER");
  f.state.session.sessionKind = "organization";
  await assert.rejects(f.context(), { code: "PORTAL_AUTH_REQUIRED" }); f.state.session.sessionKind = "employee";
  for (const fields of [{ active: false }, { employee_active: false }, { locked_until: "2999-01-01T00:00:00.000Z" }, { password_hash: "" }]) {
    const previous = { ...f.state.actor }; Object.assign(f.state.actor, fields); await assert.rejects(f.context()); f.state.actor = previous;
  }
  f.state.actor.password_policy_version = 0;
  await assert.rejects(f.context(), { code: "PASSKEY_PASSWORD_POLICY_REQUIRED" });
});
test("Branch management checks every target scope; terminals require central personal administration", async () => {
  const f = fixture();
  await assert.rejects(f.context("target"), { code: "PORTAL_PERMISSION_DENIED" });
  f.state.session.permissions = ["organization_accounts:password:manage"];
  assert.equal((await f.context("target")).kind, "organization");
  f.state.account.locationIds.push("EX-OTHER");
  await assert.rejects(f.context("target"), { code: "PORTAL_SCOPE_DENIED" });
  f.state.account.account_type = "terminal"; f.state.account.locationIds = ["EX-11"];
  await assert.rejects(f.context("target"), { code: "PORTAL_SCOPE_DENIED" });
  f.state.session.role = "admin"; f.state.session.permissions = ["users:write"];
  assert.equal((await f.context("target")).principalId, f.state.account.id);
});
test("Password, role, session and effective scope changes alter the enrollment authority binding", async () => {
  const f = fixture(), base = (await f.context()).authorityHash;
  for (const [object, key, value] of [[f.state.actor, "password_hash", "new"], [f.state.session, "id", "new-session"],
    [f.state.session, "role", "admin"], [f.state.session, "scopes", [{ locationId: "EX-NEW" }]], [f.state.session, "permissions", ["users:write"]]]) {
    const previous = object[key]; object[key] = value; assert.notEqual((await f.context()).authorityHash, base); object[key] = previous;
  }
});
test("Managed organizational keys can be inspected and revoked while a target requires a password update", async () => {
  const f = fixture(); f.state.session.role = "admin"; f.state.session.permissions = ["users:write"];
  f.state.account.must_change_password = true;
  await assert.rejects(f.context("target"), { code: "PASSKEY_PASSWORD_POLICY_REQUIRED" });
  assert.equal((await f.context("target", "list")).kind, "organization");
  assert.equal((await f.context("target", "revoke")).kind, "organization");
});

const passwordRouteStart = source.indexOf('app.put("/api/portal/v1/me/password", async (request, response) => {');
const passwordRouteEnd = source.indexOf("\nasync function ownPortalSchedule(", passwordRouteStart);
assert(passwordRouteStart >= 0 && passwordRouteEnd > passwordRouteStart);
function passwordResponseFixture({ transactionFailure = false, readFailure = false } = {}) {
  const originalError = Error(transactionFailure ? "Synthetic transaction rejected" : "Synthetic postcommit read unavailable");
  const lifetime = { authenticatedAt: "2026-10-25T10:00:00.000Z", absoluteExpiresAt: "2099-10-25T18:00:00.000Z", expiresAt: "2099-10-25T17:00:00.000Z" };
  const session = { id: "synthetic-old-session", employeeNumber: "SYNTHETIC-101", sessionKind: "employee", isEmployee: true, role: "employee", ...lifetime };
  const state = { committed: false, cookies: [], headers: {}, events: [], followupReads: 0 };
  const repositories = { portalAccess: {
    async changeEmployeePassword() { state.events.push("password-update"); return { rowsAffected: 1 }; },
    async revokeEmployeeSessionsForEmployee() {}, async revokePasswordResetTokensForEmployee() {}, async insertEmployeeSession() {},
  }, organizationPersonnel: { async revokeMobileSessions() {}, async insertAudit() {} } };
  let handler;
  const context = { crypto, Date, Object, PORTAL_PASSWORD_POLICY_VERSION: 1, PORTAL_SESSION_COOKIE: "grabenplaner_session", PORTAL_CSRF_COOKIE: "grabenplaner_csrf",
    app: { put(route, callback) { assert.equal(route, "/api/portal/v1/me/password"); handler = callback; } },
    requirePortalSession: () => session, assertPortalCsrf() {}, passkeyAuthenticationModule: { reauthenticationBodyValid: () => true },
    organizationPersonnelRepository: { async getPortalUserAccountProjection() { return { password_hash: "synthetic-current-hash" }; } },
    verifyPortalPassword: async () => true, hashPortalPassword: async () => "synthetic-new-hash", persistenceProvider: {}, createApplicationRepositories() {},
    httpError: (status, message, code) => Object.assign(Error(message), { status, code }), portalActorId: () => session.employeeNumber,
    sha256: token => crypto.createHash("sha256").update(token).digest("hex"), portalSessionTimeoutMinutes: () => 30,
    portalCsrfToken: token => crypto.createHash("sha256").update("synthetic-csrf:" + token).digest("hex"), browserSessionLifetime: () => lifetime,
    async runLoginTransaction(_provider, _factory, work) {
      const result = await work(repositories); if (transactionFailure) throw originalError;
      state.committed = true; state.events.push("commit"); return result;
    },
    async loadPortalSessionFromRequest(_request, options) {
      if (options.repository) return session;
      state.followupReads++; state.events.push("followup-read"); assert(state.committed);
      assert.equal(state.cookies.length, 2); assert.equal(state.headers["X-GP-Session-Changed"], "1");
      if (readFailure) throw originalError; return { ...session, id: "synthetic-new-session", mustChangePassword: false };
    },
    issuePortalSessionCookies(_request, _response, token, absoluteExpiresAt) {
      assert(state.committed); assert.equal(absoluteExpiresAt, lifetime.absoluteExpiresAt);
      state.cookies.push("grabenplaner_session=" + token, "grabenplaner_csrf=" + context.portalCsrfToken(token)); state.events.push("cookies");
    }, publicPortalUser: value => value,
  };
  vm.runInNewContext(source.slice(passwordRouteStart, passwordRouteEnd), context);
  const request = { body: { currentPassword: "synthetic-old-password", newPassword: "synthetic-new-password" }, headers: { cookie: "grabenplaner_session=synthetic-old" } };
  const response = { setHeader(name, value) { state.headers[name] = value; state.events.push("header"); }, json(value) { state.body = value; } };
  return { state, originalError, request, run: () => handler(request, response), lifetime };
}

test("the actual password-change handler exposes committed cookies and rotation header before a failing follow-up read", async () => {
  const f = passwordResponseFixture({ readFailure: true }); await assert.rejects(f.run(), error => error === f.originalError);
  assert.deepEqual(f.state.events.slice(-4), ["commit", "cookies", "header", "followup-read"]);
  assert.equal(f.state.headers["X-GP-Session-Changed"], "1"); assert.equal(f.state.cookies.length, 2);
  assert.notEqual(f.request.portalSession.id, "synthetic-old-session"); assert.equal(f.request.portalSession.absoluteExpiresAt, f.lifetime.absoluteExpiresAt);
  assert.equal(f.state.body, undefined);
});

test("a rejected password-change transaction never exposes new cookies, headers or a replacement session", async () => {
  const f = passwordResponseFixture({ transactionFailure: true }); await assert.rejects(f.run(), error => error === f.originalError);
  assert.equal(f.state.committed, false); assert.deepEqual(f.state.cookies, []); assert.deepEqual(f.state.headers, {});
  assert.equal(f.state.followupReads, 0); assert.equal(f.request.portalSession, undefined); assert.equal(f.state.body, undefined);
});

test("normal password-change success has the same committed rotation signal and preserved absolute deadline", async () => {
  const f = passwordResponseFixture(); await f.run(); assert.equal(f.state.headers["X-GP-Session-Changed"], "1");
  assert.equal(f.state.cookies.length, 2); assert.equal(f.state.followupReads, 1); assert.equal(f.state.body.sessionChanged, true);
  assert.equal(f.state.body.user.employeeNumber, "SYNTHETIC-101"); assert.equal(f.state.body.user.absoluteExpiresAt, f.lifetime.absoluteExpiresAt);
});
