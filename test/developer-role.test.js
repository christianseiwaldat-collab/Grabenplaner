const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("Developer-Rolle erhält dauerhaft den vollständigen bekannten App-Rechtekatalog", () => {
  assert.match(serverSource, /if \(String\(role \|\| ""\) === "developer"\) return true/);
  assert.match(
    serverSource,
    /addBuiltinRolePermissions\(\s*"developer",\s*\[\s*\.\.\.delegablePortalPermissionCatalog\.map\(\(permission\) => permission\.id\),\s*\.\.\.portalGlobalPermissionIds,\s*\]\s*\)/,
  );
  assert.doesNotMatch(
    serverSource,
    /addBuiltinRolePermissions\(\s*"(?:it_admin|admin|hr)",\s*delegablePortalPermissionCatalog\.map/,
  );
});
