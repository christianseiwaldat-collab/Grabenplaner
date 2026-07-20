"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const client = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

test("v0.75 exposes only the redacted host-security status in server diagnostics", () => {
  assert.match(server, /readHostSecurityStatus/);
  assert.match(server, /hostSecurity:\s*\{/);
  assert.match(server, /pendingConfirmation: hostSecurity\.pendingConfirmation === true/);
  assert.match(server, /failedChecks: Array\.isArray\(hostSecurity\.failedChecks\)/);
  assert.doesNotMatch(server, /hostSecurity:\s*\{[^}]*CONFIG_ADMIN/s);
  assert.doesNotMatch(server, /hostSecurity:\s*\{[^}]*CONFIG_SOURCES/s);
});

test("v0.75 host-security findings are visible but never become a readiness dependency", () => {
  assert.match(server, /HOST_SECURITY_ATTENTION/);
  assert.match(server, /Ubuntu-Host-Sicherheit prüfen/);
  const readinessStart = server.indexOf("ready: startupIntegrity");
  const readinessEnd = server.indexOf("\n    mode:", readinessStart);
  assert.ok(readinessStart > 0 && readinessEnd > readinessStart);
  const readiness = server.slice(readinessStart, readinessEnd);
  assert.doesNotMatch(readiness, /hostSecurity/);
  assert.match(client, /function renderHostSecurityDiagnostics/);
  assert.match(client, /keine offene Sicherheitstransaktion/);
  assert.match(client, /im Wartungsfenster erforderlich/);
});
