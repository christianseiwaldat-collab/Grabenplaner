"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto");
const express = require("express");
const access = require("../lib/personnel-lifecycle-access");
const { PersonnelLifecycleError, PERSONNEL_LIFECYCLE_ERROR_KINDS } = require("../lib/personnel-lifecycle");
const { canonicalSha256 } = require("../lib/work-rules");
const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  const end = source.indexOf("\n}", start);
  assert(start >= 0 && end > start, `Production function missing: ${name}`);
  return source.slice(start, end + 2);
}
const actionsStart = source.indexOf("const PERSONNEL_LIFECYCLE_ROUTE_ACTIONS = Object.freeze({");
const actionsEnd = source.indexOf("\n});", actionsStart);
assert(actionsStart >= 0 && actionsEnd > actionsStart);
const routesStart = source.indexOf("function personnelExistingEmployeeTarget(");
const routesEnd = source.indexOf('\napp.post("/api/portal/v1/personnel-lifecycle/candidates/:candidateId/applications/:applicationId/convert"', routesStart);
assert(routesStart >= 0 && routesEnd > routesStart);

function admin() {
  return { employeeNumber: "101", role: "admin", isEmployee: true, sessionKind: "employee", scopes: [],
    permissions: [...Object.values(access.PERSONNEL_LIFECYCLE_PERMISSIONS), "personnel:central:read", "personnel:central:write",
      "personnel:sensitive:read", "personnel:sensitive:write", "employees:write"] };
}
const plain = value => JSON.parse(JSON.stringify(value));
const basePath = "/api/portal/v1/personnel-lifecycle/candidates/synthetic-candidate/applications/synthetic-application";

async function fixture(t) {
  // The actual production registrations and authorization/CSRF helpers run over
  // HTTP. Persistence and the conversion domain are injected transaction spies;
  // their real mutation and receipt invariants have separate domain/API tests.
  const app = express(); app.use(express.json());
  const employees = new Map([
    ["101", { personnel_number: "101", full_name: "Synthetisch Bereitsangestellt", home_location_id: "18", preferred_department_id: 2,
      active: 1, private_email: "never-export@example.invalid", password_hash: "never-export" }],
    ["102", { personnel_number: "102", full_name: "Synthetisch Anderer", home_location_id: "11", preferred_department_id: null, active: 1 }],
  ]);
  const state = { session: admin(), employees, transactions: [], mutations: [], targetReads: 0, audits: [], denied: [], replayed: false, uniqueConflict: false,
    candidate: { id: "synthetic-candidate", revision: 1, state: "active", applications: [{ id: "synthetic-application", revision: 2, status: "talent_pool" }] } };
  app.use((request, response, next) => { request.portalSession = state.session; next(); });
  const organization = {
    async getEmployeeForUpdate(number) { state.targetReads++; return structuredClone(state.employees.get(number)); },
    async insertAudit(...args) { state.audits.push(plain(args)); },
  };
  const executor = { personnelLifecycle: Symbol("transaction-bound lifecycle repository"), organizationPersonnel: organization };
  // Bridge VM promises into the HTTP server's realm without modifying handlers.
  const routeRegistration = Object.fromEntries(["get", "post"].map(method => [method,
    (route, handler) => app[method](route, (...args) => Promise.resolve(handler(...args))),
  ]));
  const context = vm.createContext({ app: routeRegistration, crypto, Buffer, Set, Number, Object, String,
    ...access, PersonnelLifecycleError, PERSONNEL_LIFECYCLE_ERROR_KINDS, workRuleSha256: canonicalSha256,
    PORTAL_CSRF_COOKIE: "grabenplaner_csrf", PORTAL_SESSION_COOKIE: "grabenplaner_session",
    RIGHTS_ADMIN_PORTAL_ROLES: new Set(["admin", "hr", "developer"]), GLOBAL_SCOPE_PORTAL_ROLES: new Set(["admin", "hr", "developer"]),
    getPortalStatus: () => ({ portalEnabled: true }), isLoopbackRequest: () => true,
    requirePortalSession(request) {
      if (!request.portalSession) throw Object.assign(new Error("Anmeldung erforderlich"), { status: 401, code: "PORTAL_LOGIN_REQUIRED" });
      return request.portalSession;
    },
    publicPersonnelLifecycleCapabilities: snapshot => snapshot.capabilities,
    auditPersonnelLifecycleAccessDenied: async (...args) => state.denied.push(args),
    organizationPersonnelRepository: organization,
    requirePersonnelLifecycleService: () => ({ async getCandidate(id) { return id === state.candidate.id ? structuredClone(state.candidate) : null; } }),
    runPersonnelLifecycleSerializableMutation: work => work(),
    persistenceProvider: { async transaction(work, options) {
      state.transactions.push(plain(options));
      const auditsBefore = structuredClone(state.audits);
      try { return await work(executor); } catch (error) { state.audits = auditsBefore; throw error; }
    } },
    createApplicationRepositories(value) { assert.equal(value, executor); return value; },
    createPersonnelLifecycleService(repository) {
      assert.equal(repository, executor.personnelLifecycle);
      return { async convertCandidateInTransaction(candidateId, applicationId, submitted, actor, targetCallback, options) {
        state.mutations.push(plain({ candidateId, applicationId, submitted, actor, options }));
        if (!state.replayed) {
          const target = await targetCallback();
          assert.equal(target.personnelNumber, submitted.employeeNumber);
          if (state.uniqueConflict) throw Object.assign(new Error("synthetic unique conflict"), { code: "PERSISTENCE_UNIQUE_VIOLATION" });
        }
        return { replayed: state.replayed,
          candidate: { id: candidateId, revision: 2, state: "archived" },
          conversion: { id: submitted.id, candidateId, applicationId, employeeNumber: submitted.employeeNumber,
            targetMode: "existing", documentTransfer: "none", portalAccess: "none", onboarding: "deferred" } };
      } };
    },
    protectJson() { throw new Error("Route must delegate protected receipt construction to the domain"); },
    parseProtectedJson() { throw new Error("Route must delegate protected receipt parsing to the domain"); },
    own: (object, key) => Object.hasOwn(object, key),
  });
  const helpers = ["httpError", "isUniquePersistenceViolation", "sha256", "safeHashEquals", "parseCookies", "portalCsrfToken", "assertPortalCsrf",
    "portalSessionFromRequest", "sessionHasGlobalScope", "assertSessionContextScope", "sessionCanManageCentralPersonnel",
    "requirePortalAnyPermissionOrLocal", "requirePersonnelLifecycleAccess", "personnelLifecycleRouteError"];
  vm.runInContext(helpers.map(functionSource).join("\n") + "\n" + source.slice(actionsStart, actionsEnd + 4) + "\n" + source.slice(routesStart, routesEnd), context);
  app.use((error, request, response, next) => { response.status(error.status || 500).json({ code: error.code || "UNEXPECTED", error: error.message }); });
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const token = "synthetic-session-token", csrf = crypto.createHash("sha256").update(`gp-browser-csrf-v2\0${token}`).digest("hex");
  async function request(route, { method = "GET", body, includeCsrf = true, csrfValue = csrf } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${basePath}${route}`, { method,
      headers: { "Content-Type": "application/json", Cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,
        ...(includeCsrf ? { "X-CSRF-Token": csrfValue } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, payload: await response.json() };
  }
  async function preview(number = "101", options) { return request(`/existing-employee/${number}`, options); }
  async function body(number = "101") {
    const result = await preview(number); assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    return { operationId: crypto.randomUUID(), candidateRevision: 1, applicationRevision: 2, employeeNumber: number,
      employeeSnapshotSha256: result.payload.employee.snapshotSha256, confirmed: true };
  }
  return { state, request, preview, body };
}

test("existing employee preview uses real convert authorization, minimal no-store projection and active target scope", async t => {
  const f = await fixture(t), before = plain([...f.state.employees]);
  const preview = await f.preview("101", { includeCsrf: false });
  assert.equal(preview.response.status, 200); // The production CSRF helper exempts GET.
  assert.equal(preview.response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Object.keys(preview.payload.employee).sort(), ["active", "fullName", "homeLocationId", "personnelNumber", "preferredDepartmentId", "snapshotSha256"].sort());
  assert.match(preview.payload.employee.snapshotSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(preview.payload), /never-export|private_email|password_hash/);
  assert.equal((await f.preview("missing")).response.status, 404);
  f.state.employees.get("101").active = 0; assert.equal((await f.preview()).response.status, 404); f.state.employees.get("101").active = 1;
  f.state.candidate.applications = []; assert.equal((await f.preview()).response.status, 404);
  assert.deepEqual(plain([...f.state.employees]), before); assert.equal(f.state.transactions.length, 0);
});

test("link route binds reviewed identity and revisions into serializable domain mutation; replay keeps HTTP semantics", async t => {
  const f = await fixture(t), body = await f.body(), employeesBefore = plain([...f.state.employees]);
  const linked = await f.request("/link-existing-employee", { method: "POST", body });
  assert.equal(linked.response.status, 201, JSON.stringify(linked.payload));
  assert.equal(linked.payload.conversion.targetMode, "existing");
  assert.equal(linked.payload.conversion.employeeNumber, "101"); assert.equal(linked.payload.candidate.state, "archived");
  assert.equal(linked.payload.replayed, false);
  assert.deepEqual(f.state.transactions, [{ isolation: "serializable" }]);
  const forwarded = f.state.mutations[0];
  assert.equal(forwarded.candidateId, "synthetic-candidate"); assert.equal(forwarded.applicationId, "synthetic-application");
  assert.equal(forwarded.submitted.id, body.operationId); assert.equal(forwarded.submitted.candidateRevision, 1);
  assert.equal(forwarded.submitted.applicationRevision, 2); assert.equal(forwarded.actor, "101");
  assert.deepEqual(forwarded.options, { targetMode: "existing" });
  assert.deepEqual(forwarded.submitted.employee, { personnelNumber: "101" });
  assert.match(forwarded.submitted.requestSha256, /^[a-f0-9]{64}$/);
  assert.equal(f.state.audits.length, 1); assert.equal(f.state.audits[0][1], "personnel-lifecycle.candidate.link-existing");
  f.state.replayed = true;
  const replay = await f.request("/link-existing-employee", { method: "POST", body });
  assert.equal(replay.response.status, 200); assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
  assert.equal(replay.payload.replayed, true); assert.equal(f.state.audits.length, 1);
  assert.deepEqual(f.state.mutations[1].submitted, forwarded.submitted);
  f.state.session.role = "manager";
  const deniedReplay = await f.request("/link-existing-employee", { method: "POST", body });
  assert.equal(deniedReplay.response.status, 403); assert.equal(f.state.mutations.length, 2);
  assert.deepEqual(plain([...f.state.employees]), employeesBefore);
});

test("link route rejects CSRF, scoped manager, conversion denials and malformed confirmation before mutation", async t => {
  const f = await fixture(t), body = await f.body();
  const post = options => f.request("/link-existing-employee", { method: "POST", body, ...options });
  for (const options of [{ includeCsrf: false }, { csrfValue: "0".repeat(64) }]) {
    const result = await post(options); assert.equal(result.response.status, 403); assert.equal(result.payload.code, "PORTAL_CSRF_INVALID");
  }
  f.state.session.role = "manager";
  assert.equal((await post()).response.status, 403); assert.equal((await f.preview()).response.status, 403);
  for (const permission of [access.PERSONNEL_LIFECYCLE_PERMISSIONS.CANDIDATES_CONVERT, "employees:write", "personnel:sensitive:write"]) {
    f.state.session = admin(); f.state.session.permissions = f.state.session.permissions.filter(value => value !== permission);
    assert.equal((await post()).response.status, 403); assert.equal((await f.preview()).response.status, 403);
  }
  f.state.session = null; assert.equal((await post()).response.status, 401);
  f.state.session = admin();
  const invalid = [
    { confirmed: false }, { candidateRevision: 0 }, { applicationRevision: "2" }, { employeeNumber: "local" }, { extra: "unexpected" },
    ...["operationId", "employeeNumber", "employeeSnapshotSha256"].flatMap(key => [101, null, [], {}].map(value => ({ [key]: value }))),
  ];
  for (const change of invalid) {
    const result = await post({ body: { ...body, ...change } });
    assert.equal(result.response.status, 400, JSON.stringify({ change, payload: result.payload }));
    assert.equal(result.payload.code, "PERSONNEL_LIFECYCLE_EXISTING_EMPLOYEE_INPUT_INVALID");
  }
  assert.equal(f.state.transactions.length, 0); assert.equal(f.state.mutations.length, 0); assert.equal(f.state.audits.length, 0);
});

test("link route rechecks target inside transaction and rolls back its audit on an already-linked conflict", async t => {
  const f = await fixture(t), body = await f.body(), before = plain([...f.state.employees]);
  const post = change => f.request("/link-existing-employee", { method: "POST", body: { ...body, ...change } });
  const badHash = await post({ employeeSnapshotSha256: "0".repeat(64) });
  assert.equal(badHash.response.status, 409); assert.equal(badHash.payload.code, "PERSONNEL_LIFECYCLE_EMPLOYEE_CHANGED");
  const otherTarget = await post({ employeeNumber: "102" });
  assert.equal(otherTarget.response.status, 409); assert.equal(otherTarget.payload.code, "PERSONNEL_LIFECYCLE_EMPLOYEE_CHANGED");
  f.state.employees.get("101").active = 0;
  const inactive = await post(); assert.equal(inactive.response.status, 404); assert.equal(inactive.payload.code, "PERSONNEL_LIFECYCLE_EMPLOYEE_NOT_FOUND");
  f.state.employees.get("101").active = 1;
  f.state.employees.get("101").full_name = "Zwischenzeitlich geändert";
  const changed = await post(); assert.equal(changed.response.status, 409); assert.equal(changed.payload.code, "PERSONNEL_LIFECYCLE_EMPLOYEE_CHANGED");
  f.state.employees.get("101").full_name = before[0][1].full_name;
  f.state.uniqueConflict = true;
  const conflict = await post(); assert.equal(conflict.response.status, 409);
  assert.equal(conflict.payload.code, "PERSONNEL_LIFECYCLE_EMPLOYEE_NUMBER_CONFLICT");
  assert.equal(f.state.audits.length, 0, "the success audit is inside the same transaction");
  assert(f.state.transactions.every(options => options.isolation === "serializable"));
  assert.deepEqual(plain([...f.state.employees]), before);
  assert.equal(f.state.candidate.state, "active"); assert.equal(f.state.candidate.applications[0].status, "talent_pool");
});
