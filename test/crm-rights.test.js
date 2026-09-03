"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  CRM_PERMISSIONS,
  CRM_PERMISSION_IDS,
  buildCrmProjection,
  resolveCrmPermissionDependencies,
} = require("../lib/crm-access");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("CRM verwendet einen eigenen, minimalen Rechtekatalog", () => {
  assert.deepEqual(CRM_PERMISSIONS, {
    ACCESS: "crm:access",
    CUSTOMERS_READ: "crm:customers:read",
    CUSTOMERS_WRITE: "crm:customers:write",
  });
  assert.deepEqual(CRM_PERMISSION_IDS, [
    "crm:access",
    "crm:customers:read",
    "crm:customers:write",
  ]);
  assert.equal(new Set(CRM_PERMISSION_IDS).size, 3);

  const permissionCatalog = between(
    server,
    "const delegablePortalPermissionCatalog = Object.freeze([",
    "const delegablePortalPermissions",
  );
  for (const permissionKey of Object.keys(CRM_PERMISSIONS)) {
    assert.match(permissionCatalog, new RegExp(`id: CRM_PERMISSIONS\\.${permissionKey}`));
  }
  const crmLines = permissionCatalog.split(/\r?\n/)
    .filter((line) => line.includes("id: CRM_PERMISSIONS."));
  assert.equal(crmLines.length, 3);
  for (const line of crmLines) {
    assert.match(line, /group: "Verkaufsverwaltung"/);
    assert.doesNotMatch(line, /"it_admin"/);
  }
});

test("CRM-Projektion bleibt ohne Arbeitsbereich oder Leserecht fail-closed", () => {
  assert.deepEqual(buildCrmProjection({ permissions: [] }), {
    workspace: false,
    read: false,
    write: false,
  });
  assert.deepEqual(buildCrmProjection({
    permissions: [CRM_PERMISSIONS.CUSTOMERS_READ, CRM_PERMISSIONS.CUSTOMERS_WRITE],
  }), {
    workspace: false,
    read: false,
    write: false,
  });
  assert.deepEqual(buildCrmProjection({
    permissions: [CRM_PERMISSIONS.ACCESS, CRM_PERMISSIONS.CUSTOMERS_WRITE],
  }), {
    workspace: true,
    read: false,
    write: false,
  });

  const readProjection = buildCrmProjection({
    permissions: [CRM_PERMISSIONS.ACCESS, CRM_PERMISSIONS.CUSTOMERS_READ],
  });
  assert.deepEqual(readProjection, { workspace: true, read: true, write: false });
  assert.equal(Object.isFrozen(readProjection), true);

  assert.deepEqual(buildCrmProjection({ permissions: CRM_PERMISSION_IDS }), {
    workspace: true,
    read: true,
    write: true,
  });
});

test("CRM-Schreibrecht hängt serverseitig von Lesen und Arbeitsbereich ab", () => {
  assert.deepEqual(resolveCrmPermissionDependencies([
    CRM_PERMISSIONS.CUSTOMERS_WRITE,
  ]), {
    valid: false,
    missing: [CRM_PERMISSIONS.CUSTOMERS_READ, CRM_PERMISSIONS.ACCESS],
  });
  assert.deepEqual(resolveCrmPermissionDependencies([
    CRM_PERMISSIONS.ACCESS,
    CRM_PERMISSIONS.CUSTOMERS_READ,
    CRM_PERMISSIONS.CUSTOMERS_WRITE,
  ]), {
    valid: true,
    missing: [],
  });

  const dependencyValidation = between(
    server,
    "function assertPortalPermissionDependencies",
    "const portalDashboardPermissionDetails",
  );
  assert.match(dependencyValidation, /resolveCrmPermissionDependencies\(\[\.\.\.projected\]\)/);
  assert.match(dependencyValidation, /if \(!crmDependencies\.valid\)/);
  assert.match(dependencyValidation, /"PORTAL_PERMISSION_DEPENDENCY"/);
});

test("CRM-Rechte werden IT- und sonstigen Builtin-Rollen nicht automatisch erweitert", () => {
  const builtinRoles = between(server, "const builtinPortalRoles = [", "const adminPortalRole");
  for (const permission of CRM_PERMISSION_IDS) {
    assert.doesNotMatch(builtinRoles, new RegExp(permission.replaceAll(":", "\\:")));
  }

  assert.match(server, /if \(String\(role \|\| ""\) === "developer"\) return true/);
  assert.match(server, /CRM_PERMISSION_IDS/);
});
