"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { AsyncLocalStorage } = require("node:async_hooks");
const test = require("node:test");
const { createPortalSessionRenewal } = require("../lib/portal-session-renewal");
const { isLocalSystemSession } = require("../lib/personnel-lifecycle-access");
const source = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8").replaceAll("\r\n", "\n");
function actualFunction(name) {
  let start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, name);
  if (source.slice(start - 6, start) === "async ") start -= 6;
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, name);
  return source.slice(start, end + 3);
}

const instant = Date.parse("2026-10-24T00:00:00Z");
class FixedDate extends Date {
  constructor(value) { super(value === undefined ? instant : value); }
  static now() { return instant; }
}

function loader(kind, { activity = true, coalesced = false, route = "/api/synthetic", afterWrite } = {}) {
  let state = "active", reads = 0, writes = 0;
  let row = { id: "synthetic-session", employee_number: "synthetic-person", role: "hr", permissions: ["users:write"],
    expires_at: new Date(instant + (coalesced ? 30 : 1) * 60000).toISOString(),
    authenticated_at: new Date(instant - 10 * 60000).toISOString(), absolute_expires_at: new Date(instant + 3600000).toISOString(),
    last_seen_at: new Date(instant - 60000).toISOString(), personnel_field_permissions: {}, access_scopes: [],
    account_id: "synthetic-account", login_name: "Synthetic", account_type: "branch", display_name: "Synthetic account" };
  const read = async requested => {
    if (requested !== kind) return null;
    reads++;
    return state === "active" ? { ...row } : null;
  };
  const write = async () => {
    writes++;
    row = { ...row, expires_at: new Date(instant + 30 * 60000).toISOString(), permissions: [] };
    state = afterWrite || "active";
    return { rowsAffected: 1 };
  };
  const repository = { getEmployeeSessionByToken: () => read("employee"), getOrganizationSessionByToken: () => read("organization"),
    touchEmployeeSession: write, touchOrganizationSession: write };
  const context = vm.createContext({ Date: FixedDate, portalAccessRepository: repository,
    parseCookies: () => ({ token: "synthetic-token" }), PORTAL_SESSION_COOKIE: "token", sha256: value => value,
    portalSessionTimeoutMinutes: () => 30, viennaTodayIso: () => "2026-10-24", isReservedEmployeePrincipal: () => false,
    isSessionTimeValid: value => Date.parse(value.expires_at) > instant && Date.parse(value.absolute_expires_at) > instant,
    sessionPortalAccessScopeProjection: () => ({ explicitScopes: [], scopes: [] }),
    effectivePortalPermissionState: (_number, _role, permissions) => ({ effectivePermissions: permissions, rolePermissions: permissions,
      grantedPermissions: [], deniedPermissions: [] }),
    browserSessionLifetime: () => ({ expiresAt: new Date(instant + 30 * 60000).toISOString(), idleMinutes: 30,
      authenticatedAt: row.authenticated_at, absoluteExpiresAt: row.absolute_expires_at, privileged: false }),
    sessionInstant: Date.parse, renewPortalSession: createPortalSessionRenewal(), normalizeTimeConfirmationLevel: value => value,
    normalizedManagerAmuAccessMode: () => "inherit", parsePersonnelFieldPermissionProjection: value => value,
    parsePortalPermissionScopes: () => [], portalAccessScopesForPrincipal: () => [],
    normalizedOrganizationAccountPermissions: (_type, permissions) => permissions, parsePortalPermissions: value => value,
    organizationAccountRoleName: () => "Synthetic organization", Object });
  vm.runInContext(actualFunction("loadPortalSessionFromRequest"), context);
  const request = { headers: activity ? { "x-gp-user-activity": "1" } : {}, originalUrl: route };
  return { run: options => context.loadPortalSessionFromRequest(request, options), counts: () => ({ reads, writes }) };
}

test("actual employee and organization loaders adopt authority read after a successful renewal", async () => {
  for (const kind of ["employee", "organization"]) {
    const fixture = loader(kind);
    const session = await fixture.run();
    assert.deepEqual(Array.from(session.permissions), [], kind);
    assert.deepEqual(fixture.counts(), { reads: 2, writes: 1 });
    assert.equal(session.id, "synthetic-session");
  }
});

test("unchanged expiry, background reads, session route and explicit touch:false keep the single-read path", async () => {
  for (const kind of ["employee", "organization"]) for (const options of [
    { activity: false }, { coalesced: true }, { route: "/api/portal/v1/session" }, { touch: false },
  ]) {
    const fixture = loader(kind, options);
    assert.ok(await fixture.run(options.touch === false ? { touch: false } : undefined));
    assert.deepEqual(fixture.counts(), { reads: 1, writes: 0 }, kind + " " + JSON.stringify(options));
  }
});

test("renewal cannot revive a disabled, deleted, revoked or expired actor/session", async () => {
  for (const kind of ["employee", "organization"]) for (const afterWrite of ["disabled", "deleted", "revoked", "expired"]) {
    const fixture = loader(kind, { afterWrite });
    assert.equal(await fixture.run(), null, kind + " " + afterWrite);
    assert.deepEqual(fixture.counts(), { reads: 2, writes: 1 });
  }
});

function completion(current) {
  const requestContext = new AsyncLocalStorage(), calls = [];
  const previous = { id: "old-session", sessionKind: "employee", employeeNumber: "synthetic-self", role: "admin",
    permissions: ["users:write"], scopes: [{ locationId: "18" }] };
  const request = { portalSession: previous, portalSessionLoaded: true };
  const authorizationRepository = {};
  const context = vm.createContext({ Object, String, isLocalSystemSession, persistenceRequestContext: requestContext,
    portalUsersForAdmin: () => { throw new Error("DENIED_PROJECTION_MUST_NOT_READ_USERS"); },
    getPortalRoles: () => { throw new Error("DENIED_PROJECTION_MUST_NOT_READ_ROLES"); },
    applicationPersistence: { ready: Promise.resolve({ authorizationRepositories: { portalAccess: authorizationRepository } }) },
    loadPortalSessionFromRequest: async (actual, options) => {
      assert.equal(actual, request); assert.equal(options.touch, false); assert.equal(options.repository, authorizationRepository);
      assert.ok(requestContext.getStore()); calls.push("authority-refresh"); return current;
    },
    refreshConfiguredAdminSnapshot: async () => { assert.equal(requestContext.getStore(), undefined); calls.push("admin-cache"); },
    reconcileOpenAmuResponsibilities: async actor => {
      assert.equal(requestContext.getStore(), undefined); assert.equal(actor, "synthetic-self");
      await Promise.resolve(); assert.equal(requestContext.getStore(), undefined); calls.push("amu-reconcile");
    } });
  vm.runInContext(["deniedPortalSessionProjection", "completeCommittedPortalUserMutation", "authorizePersistenceOperation",
    "portalUsersForActor", "portalRolesForUserAdministrationActor"].map(actualFunction).join("\n"), context);
  const outcome = { changed: true, actor: previous };
  return { previous, request, requestContext, calls, outcome,
    run: committed => context.completeCommittedPortalUserMutation(committed, request, "synthetic-self", outcome),
    authorized: () => context.authorizePersistenceOperation({ readOnly: true }),
    projections: actor => Promise.all([context.portalUsersForActor(actor), context.portalRolesForUserAdministrationActor(actor)]) };
}

test("post-commit self-demotion adopts fresh authority and confines the two service effects to their own context", async () => {
  const current = { id: "old-session", sessionKind: "employee", employeeNumber: "synthetic-self", role: "employee", permissions: [] };
  const fixture = completion(current), store = { request: fixture.request };
  await fixture.requestContext.run(store, async () => {
    let release;
    const commit = new Promise(resolve => { release = resolve; });
    const finished = fixture.run(commit);
    await Promise.resolve(); assert.deepEqual(fixture.calls, []);
    release();
    assert.equal(await finished, current); assert.equal(fixture.request.portalSession, current);
    assert.equal(fixture.requestContext.getStore(), store, "service scope must not escape into the response");
    assert.deepEqual(fixture.calls, ["authority-refresh", "admin-cache", "amu-reconcile"]);
  });
  await fixture.requestContext.run({ nextRequest: true }, async () => {
    await Promise.resolve(); assert.equal(fixture.requestContext.getStore().nextRequest, true);
  });
});

test("post-commit revoked/deleted/expired sessions keep an immutable non-null deny-all actor", async () => {
  for (const current of [null, { id: "different-session", sessionKind: "employee", employeeNumber: "synthetic-self" },
    { id: "old-session", sessionKind: "employee", employeeNumber: "different-person" }]) {
    const fixture = completion(current);
    const actor = await fixture.requestContext.run({ request: fixture.request }, () => fixture.run(Promise.resolve()));
    assert.ok(actor); assert.equal(Object.isFrozen(actor), true);
    assert.equal(fixture.request.portalSession, actor); assert.equal(fixture.request.portalSessionLoaded, true);
    for (const key of ["permissions", "rolePermissions", "grantedPermissions", "deniedPermissions", "scopes", "explicitScopes", "permissionScopes"]) {
      assert.equal(Object.isFrozen(actor[key]), true); assert.deepEqual(Array.from(actor[key]), []);
    }
    assert.equal(actor.role, ""); assert.equal(actor.mustChangePassword, true);
    assert.equal(actor.id, fixture.previous.id);
    assert.equal(isLocalSystemSession(actor), false, "retired employee authority cannot become a local-system principal");
    const projections = await fixture.projections(actor);
    assert.ok(projections.every(rows => rows.length === 0), "deny-all users/roles return before any database read");
    assert.equal(await fixture.requestContext.run({ request: fixture.request }, () => fixture.authorized()), false,
      "the unchanged real commit guard must reject retired authority, including read-only work");
  }
});

test("failed/rolled-back and unchanged user mutations run neither post-commit refresh nor service effects", async () => {
  for (const failure of [new Error("synthetic rollback"), new Error("synthetic authorization changed")]) {
    const fixture = completion(null);
    await assert.rejects(fixture.run(Promise.reject(failure)), error => error === failure);
    assert.deepEqual(fixture.calls, []); assert.equal(fixture.request.portalSession, fixture.previous);
  }
  const fixture = completion(null); fixture.outcome.changed = false;
  assert.equal(await fixture.run(Promise.resolve()), fixture.previous); assert.deepEqual(fixture.calls, []);
});
