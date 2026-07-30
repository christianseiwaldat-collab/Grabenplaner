"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("v0.80 USB-WebUI uebernimmt entzogene Grundrechte und explizite Bereiche", () => {
  assert.match(appSource, /employee\.portal_access\?\.deniedPermissions/);
  assert.match(appSource, /employee\.portal_access\?\.scopes/);
  assert.match(appSource, /data-usb-base-permission/);
  assert.match(appSource, /data-usb-scope-mode/);
  assert.match(appSource, /deniedPermissions:\s*\[\.\.\.row\.querySelectorAll/);
  assert.match(appSource, /scopes:\s*usbScopesFromRow\(row\)/);
  assert.match(serverSource, /async function validateUsbEmployees/);
  assert.match(serverSource, /const \[employeeRows, positionRows, portalRoles\] = await Promise\.all\(/);
  assert.match(serverSource, /let scopes = Array\.isArray\(input\.scopes\)/);
});

test("v0.80 USB-WebUI trennt Grundrechte und Zusatzrechte", () => {
  assert.match(appSource, /function usbRolePermissionOptions/);
  assert.match(appSource, /data-usb-additional-permission/);
  assert.match(appSource, />Grundrechte</);
  assert.match(appSource, />Zusatzrechte</);
});
