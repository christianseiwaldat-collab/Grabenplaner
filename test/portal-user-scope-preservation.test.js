"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

function actualFunction(name) {
  const start = Math.min(...[`function ${name}(`, `async function ${name}(`]
    .map(marker => source.indexOf(marker)).filter(index => index >= 0));
  assert.ok(Number.isFinite(start));
  const end = source.indexOf("\n}", start);
  assert.ok(end > start);
  return source.slice(start, end + 2);
}

function fixture(user, role = user.role) {
  const requests = [];
  const fields = {
    "[data-portal-role]": { value: role }, "[data-portal-active]": { checked: true },
    "[data-portal-password]": { value: "" },
    "[data-scope-location]": { value: "branch-A" }, "[data-scope-department]": { value: "7" },
  };
  const row = { dataset: { portalUser: user.employeeNumber }, querySelector: selector => fields[selector] };
  const context = {
    state: { portalUsers: [user], portalSession: { user: { permissions: ["users:write"] } }, portalStatus: { portalEnabled: true } },
    window: {}, loadPortalUsers: async () => {}, showToast: () => {},
    api: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { users: [] }; },
  };
  vm.runInNewContext(`${actualFunction("portalUserScopesForSave")}\n${actualFunction("savePortalUser")}\nthis.handlers = { portalUserScopesForSave, savePortalUser };`, context);
  return { row, fields, requests, handlers: context.handlers };
}

const multiUser = () => ({ employeeNumber: "SYN-planner", role: "location_planner",
  scopes: [{ locationId: "branch-A", departmentId: null }, { locationId: "branch-B", departmentId: null }, { locationId: "branch-C", departmentId: null }] });
const plain = value => JSON.parse(JSON.stringify(value));

test("ordinary account save retains all existing scopes after its account response refreshes the roster", async () => {
  const user = multiUser(), original = plain(user), f = fixture(user);
  await f.handlers.savePortalUser(f.row);
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[0].url, /\/users\/SYN-planner$/);
  assert.equal(f.requests[0].body.role, "location_planner");
  assert.match(f.requests[1].url, /\/users\/SYN-planner\/scopes$/);
  assert.deepEqual(f.requests[1].body.scopes, original.scopes);
  assert.deepEqual(user, original);
});

test("multiple department scopes also survive an unchanged department-manager save", () => {
  const user = { employeeNumber: "SYN-department", role: "department_manager",
    scopes: [{ locationId: "branch-A", departmentId: 7 }, { locationId: "branch-B", departmentId: 9 }] };
  const f = fixture(user);
  assert.deepEqual(plain(f.handlers.portalUserScopesForSave(f.row, user, user.role)), user.scopes);
});

test("single-scope assignment still uses the explicitly selected location and department", () => {
  const user = { employeeNumber: "SYN-single", role: "department_manager", scopes: [] }, f = fixture(user);
  assert.deepEqual(plain(f.handlers.portalUserScopesForSave(f.row, user, user.role)), [{ locationId: "branch-A", departmentId: "7" }]);
});

test("a genuine role change does not retain incompatible scopes implicitly", () => {
  const user = multiUser(), f = fixture(user, "department_manager");
  assert.deepEqual(plain(f.handlers.portalUserScopesForSave(f.row, user, "department_manager")), [{ locationId: "branch-A", departmentId: "7" }]);
});
