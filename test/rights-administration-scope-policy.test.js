"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const matches = [...serverSource.matchAll(/^async function normalizeRightsScopesForTarget\([^\n]+\) \{[\s\S]*?^\}/gm)];
assert.equal(matches.length, 1, "Compile the actual unique server policy, not a test implementation");
const policySource = matches[0][0];
const clone = value => JSON.parse(JSON.stringify(value));

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function fixture({ storedScopes = [] } = {}) {
  const calls = { stored: [], locations: [], departments: [] };
  const activeLocations = new Set(["05", "11", "18"]);
  const departments = new Map([
    [501, { locationId: "05", active: true }],
    [1101, { locationId: "11", active: true }],
    [1801, { locationId: "18", active: true }],
    [599, { locationId: "05", active: false }],
  ]);
  const context = vm.createContext({
    GLOBAL_SCOPE_PORTAL_ROLES: new Set(["developer", "it_admin", "admin", "hr"]),
    httpError,
    normalizeLocationId(value) {
      const id = String(value || "").trim();
      if (!/^\d{2}$/.test(id)) throw httpError(400, "Invalid location identifier");
      return id;
    },
    normalizeDepartmentId(value, allowEmpty = true) {
      if ((value === undefined || value === null || value === "") && allowEmpty) return null;
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) throw httpError(400, "Invalid department identifier");
      return id;
    },
    async explicitPortalAccessScopesForEmployee(number) {
      calls.stored.push(number);
      return storedScopes;
    },
    async validateActiveLocationExists(id) {
      calls.locations.push(id);
      if (id === "99") throw httpError(409, "Archived location", "PORTAL_SCOPE_LOCATION_INACTIVE");
      if (!activeLocations.has(id)) throw httpError(404, "Unknown location");
      return { id, active: true };
    },
    async validateActiveDepartmentExists(id, locationId) {
      calls.departments.push({ id, locationId });
      const department = departments.get(id);
      if (!department) throw httpError(404, "Unknown department");
      if (department.locationId !== locationId) throw httpError(400, "Department belongs to another location");
      if (!department.active) throw httpError(409, "Archived department", "PORTAL_SCOPE_DEPARTMENT_INACTIVE");
      return { id, location_id: locationId, active: true };
    },
    isLocalSystemSession: actor => Boolean(actor?.sessionKind === "local" || actor?.localSystem),
    sessionHasGlobalScope: actor => Boolean(actor && ["developer", "it_admin", "admin", "hr"].includes(actor.role)),
  });
  vm.runInContext(policySource + "\nthis.normalize = normalizeRightsScopesForTarget;", context);
  return { calls, normalize: async (...args) => clone(await context.normalize(...args)) };
}

function independentPlanner(extra = {}) {
  return {
    employeeNumber: "synthetic-administration-planner", configured: true, role: "location_planner",
    homeLocationId: "", sessionKind: "employee", isEmployee: true, ...extra,
  };
}

function developer(extra = {}) {
  return {
    employeeNumber: "synthetic-scope-developer", role: "developer", sessionKind: "employee",
    isEmployee: true, permissions: ["rights:write"], scopes: [], ...extra,
  };
}

const schedulePermissions = freeze(["schedule:read", "schedule:write"]);
const threeLocations = freeze(["05", "11", "18"].map(locationId => ({ locationId, departmentId: null })));
const homeOnly = freeze([{ locationId: "18", departmentId: null }]);
const rejected = (work, code = "PORTAL_SCOPE_HOME_LOCATION_REQUIRED", status = 403) =>
  assert.rejects(work, error => error.status === status && error.code === code);

test("a Developer explicitly assigns several active locations to a configured independent personal planner", async () => {
  const { normalize, calls } = fixture();
  assert.deepEqual(await normalize(independentPlanner(), threeLocations, schedulePermissions, developer()), threeLocations);
  assert.deepEqual(calls.locations, ["05", "11", "18"]);
  assert.deepEqual(calls.stored, []);
});

test("the real policy normalizes and deduplicates exact location/department pairs", async () => {
  const { normalize } = fixture();
  const result = await normalize(independentPlanner(), [
    { locationId: " 05 ", departmentId: "501" },
    { locationId: "05", departmentId: 501 },
    { locationId: "05", departmentId: null },
    { locationId: "18", departmentId: "" },
  ], schedulePermissions, developer());
  assert.deepEqual(result, [
    { locationId: "05", departmentId: 501 },
    { locationId: "05", departmentId: null },
    { locationId: "18", departmentId: null },
  ]);
});

test("a rights-only edit validates stored scopes and never mutates denials, grants or input scopes", async () => {
  const storedScopes = freeze(clone(threeLocations));
  const target = freeze(independentPlanner({
    deniedPermissions: ["employees:read", "personnel:phone:read"],
    grantedPermissions: ["schedule:read", "schedule:write"], scopes: clone(threeLocations),
  }));
  const before = clone(target);
  const { normalize, calls } = fixture({ storedScopes });
  assert.deepEqual(await normalize(target, undefined, schedulePermissions, developer()), threeLocations);
  assert.deepEqual(calls.stored, [target.employeeNumber]);
  assert.deepEqual(target, before);
  assert.deepEqual(storedScopes, threeLocations);
});

for (const actor of [
  null,
  { role: "admin", employeeNumber: "synthetic-admin" },
  { role: "hr", employeeNumber: "synthetic-hr" },
  { role: "it_admin", employeeNumber: "synthetic-it-admin" },
  { role: "manager", employeeNumber: "synthetic-local-manager", scopes: clone(homeOnly) },
  { role: "employee", employeeNumber: "synthetic-employee", scopes: clone(homeOnly) },
  { role: "admin", employeeNumber: "local", sessionKind: "local", localSystem: true },
]) {
  test(`an independent multi-location planner exception is denied to ${actor?.sessionKind || actor?.role || "missing actor"}`, async () => {
    const { normalize } = fixture();
    await rejected(() => normalize(independentPlanner(), threeLocations, schedulePermissions, actor));
  });
}

for (const [label, extra] of [
  ["unconfigured target", { configured: false }],
  ["missing employee identity", { employeeNumber: "" }],
  ["ordinary employee role", { role: "employee" }],
  ["manager role", { role: "manager" }],
  ["organization session marker", { sessionKind: "organization" }],
  ["non-employee marker", { isEmployee: false }],
]) {
  test(`a Developer cannot use the exception for ${label}`, async () => {
    const { normalize } = fixture();
    await rejected(() => normalize(independentPlanner(extra), threeLocations, schedulePermissions, developer()));
  });
}

test("an omitted actor does not inherit the Developer exception", async () => {
  const { normalize } = fixture();
  await rejected(() => normalize(independentPlanner(), threeLocations, schedulePermissions));
});

test("a branch-bound planner retains the existing own-home-location restriction", async () => {
  const { normalize } = fixture();
  const target = independentPlanner({ homeLocationId: "18" });
  assert.deepEqual(await normalize(target, homeOnly, schedulePermissions, developer()), homeOnly);
  await rejected(() => normalize(target, threeLocations, schedulePermissions, developer()));
});

test("missing or stored-empty scopes never invent a location for an independent planner", async () => {
  const { normalize } = fixture();
  await rejected(() => normalize(independentPlanner(), [], schedulePermissions, developer()), "PORTAL_SCOPE_REQUIRED", 400);
  await rejected(() => normalize(independentPlanner(), undefined, schedulePermissions, developer()), "PORTAL_SCOPE_REQUIRED", 400);
});

test("archived and unknown locations remain rejected even for the Developer exception", async () => {
  const { normalize } = fixture();
  await rejected(() => normalize(independentPlanner(), [{ locationId: "99" }], schedulePermissions, developer()), "PORTAL_SCOPE_LOCATION_INACTIVE", 409);
  await assert.rejects(() => normalize(independentPlanner(), [{ locationId: "77" }], schedulePermissions, developer()), error => error.status === 404);
});

test("invalid identifiers, wrong-location departments and archived departments remain rejected", async () => {
  const { normalize } = fixture();
  for (const scope of [
    { locationId: "../18" }, { locationId: "05", departmentId: -1 },
    { locationId: "05", departmentId: 1101 },
  ]) {
    await assert.rejects(() => normalize(independentPlanner(), [scope], schedulePermissions, developer()), error => error.status === 400);
  }
  await rejected(() => normalize(independentPlanner(), [{ locationId: "05", departmentId: 599 }], schedulePermissions, developer()), "PORTAL_SCOPE_DEPARTMENT_INACTIVE", 409);
});

test("existing whole-home and preferred-department fallbacks remain unchanged", async () => {
  const { normalize } = fixture();
  assert.deepEqual(await normalize(independentPlanner({ homeLocationId: "18" }), [], schedulePermissions, { role: "admin" }), homeOnly);
  assert.deepEqual(await normalize(independentPlanner({ role: "employee", homeLocationId: "18", preferredDepartmentId: 1801 }), [], schedulePermissions),
    [{ locationId: "18", departmentId: 1801 }]);
  await rejected(() => normalize(independentPlanner({ role: "employee", homeLocationId: "18" }), [], schedulePermissions), "PORTAL_SCOPE_REQUIRED", 400);
});

test("global target roles still reject explicit scopes and need no location fallback", async () => {
  const { normalize, calls } = fixture();
  for (const role of ["developer", "it_admin", "admin", "hr"]) {
    const target = independentPlanner({ role });
    assert.deepEqual(await normalize(target, [], schedulePermissions, developer()), []);
    await rejected(() => normalize(target, threeLocations, schedulePermissions, developer()), "PORTAL_SCOPE_GLOBAL_ROLE", 400);
  }
  assert.deepEqual(calls.locations, []);
  assert.deepEqual(calls.stored, []);
});

test("the same actual policy rejects a demoted actor or newly branch-bound target at the live recheck", async () => {
  const { normalize } = fixture();
  const target = independentPlanner();
  const scopes = await normalize(target, threeLocations, schedulePermissions, developer());
  await rejected(() => normalize(target, scopes, schedulePermissions, developer({ role: "admin" })));
  await rejected(() => normalize({ ...target, homeLocationId: "18" }, scopes, schedulePermissions, developer()));
});

test("the rights transaction rechecks current actor and target even for rights-only changes before writes", () => {
  const start = serverSource.indexOf('app.put("/api/portal/v1/rights/:employeeNumber",');
  assert.ok(start >= 0);
  const next = /\napp\.(?:get|post|put|patch|delete)\(/g;
  next.lastIndex = start + 1;
  const end = next.exec(serverSource)?.index ?? serverSource.length;
  const route = serverSource.slice(start, end);
  const transaction = route.indexOf("await personnelLifecycleSerializableTransaction(async (organization) => {");
  assert.ok(transaction >= 0, "Expected the actual serializable rights transaction");
  const live = route.slice(transaction);
  const recheck = live.match(/await normalizeRightsScopesForTarget\(\s*liveTargetAccess,\s*scopes,\s*projectedPermissions,\s*liveLearningActor,\s*organization,?\s*\);/);
  assert.ok(recheck, "Recheck the actual live authority instead of the earlier actor");
  const nearestScopeConditional = live.lastIndexOf("if (scopesInputProvided)", recheck.index);
  assert.equal(nearestScopeConditional, -1, "Rights-only changes must not skip the independent-planner recheck");
  assert.match(live.slice(0, recheck.index), /assertLivePortalRoutePermission\(liveLearningActor,\s*"rights:write"/);
  for (const write of ["organization.insertPermissionGrant(", "organization.insertPermissionDenial(", "organization.insertAccessScope("]) {
    const at = live.indexOf(write);
    assert.ok(at > recheck.index, `The live policy must precede ${write}`);
  }
});

test("the actual scope normalizer keeps all reads on its bound transaction repository", async () => {
  const names = ["explicitPortalAccessScopesForEmployee", "validateLocationExists", "validateActiveLocationExists",
    "validateDepartmentExists", "validateActiveDepartmentExists", "normalizeRightsScopesForTarget"];
  const implementations = names.map(name => {
    const matches = [...serverSource.matchAll(new RegExp("^async function " + name + "\\([\\s\\S]*?^\\}", "gm"))];
    assert.equal(matches.length, 1, name);
    return matches[0][0];
  });
  const calls = [];
  const bound = {
    async listPortalAccessScopes(number) { calls.push(["stored", number]); return [{ location_id: "18", department_id: 1801 }]; },
    async listLocations(all) { calls.push(["locations", all]); return [{ id: "18", active: true }]; },
    async listDepartments(all) { calls.push(["departments", all]); return [{ id: 1801, location_id: "18", active: true }]; },
  };
  const global = new Proxy({}, { get() { throw Error("PERSISTENCE_TRANSACTION_STATE_INVALID(queryAll)"); } });
  const context = vm.createContext({
    organizationPersonnelRepository: global, GLOBAL_SCOPE_PORTAL_ROLES: new Set(["developer", "it_admin", "admin", "hr"]),
    httpError, normalizeLocationId: value => String(value),
    normalizeDepartmentId: value => value == null || value === "" ? null : Number(value),
  });
  vm.runInContext(implementations.join("\n") + "\nthis.normalize = normalizeRightsScopesForTarget;", context);
  const target = independentPlanner({ homeLocationId: "18" });
  const expected = [{ locationId: "18", departmentId: 1801 }];
  assert.deepEqual(clone(await context.normalize(target, expected, schedulePermissions, developer(), bound)), expected);
  assert.deepEqual(clone(await context.normalize(target, undefined, schedulePermissions, developer(), bound)), expected);
  assert.deepEqual(calls, [["locations", true], ["departments", true], ["stored", target.employeeNumber],
    ["locations", true], ["departments", true]]);
  await assert.rejects(() => context.normalize(target, expected, schedulePermissions, developer()),
    /PERSISTENCE_TRANSACTION_STATE_INVALID/, "The old unbound call must reproduce the PostgreSQL admission failure");
  const archived = { ...bound, async listLocations() { return [{ id: "18", active: false }]; } };
  await assert.rejects(() => context.normalize(target, expected, schedulePermissions, developer(), archived),
    error => error.status === 409 && error.code === "PORTAL_SCOPE_LOCATION_INACTIVE");
  const archivedDepartment = { ...bound, async listDepartments() { return [{ id: 1801, location_id: "18", active: false }]; } };
  await assert.rejects(() => context.normalize(target, expected, schedulePermissions, developer(), archivedDepartment),
    error => error.status === 409 && error.code === "PORTAL_SCOPE_DEPARTMENT_INACTIVE");
});
