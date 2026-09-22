"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("v0.73 exposes redacted offsite diagnostics only through the protected server diagnostics", () => {
  const server = read("server.js");
  assert.match(server, /require\("\.\/lib\/offsite-backup-status"\)/);
  assert.match(server, /GRABENPLANER_OFFSITE_CONFIGURED/);
  assert.match(server, /requirePortalAdminOrLocal\(request, "system:diagnostics:technical"\)[\s\S]*response\.json\(\(await serverDiagnostics\(\)\)\)/);
  assert.match(server, /const diagnosticsAllowed = [^\n]+system:diagnostics:technical/);
  assert.match(server, /serverDiagnostics: diagnosticsAllowed \? diagnosticSnapshot : null/);
  assert.match(server, /backups:\s*\{[\s\S]*offsite,/);
  assert.match(server, /Das verschlüsselte Offsite-Backup ist noch nicht eingerichtet/);

  const readinessExpression = server.match(/ready:\s*startupIntegrity[\s\S]*?serviceControlToken\.length >= 32\)\),/);
  assert.ok(readinessExpression, "Readiness-Ausdruck fehlt");
  assert.doesNotMatch(readinessExpression[0], /offsite|monitor/i);
  assert.match(
    server,
    /response\.status\(diagnostics\.ready \? 200 : 503\)\.json\(\{[\s\S]*ok: diagnostics\.ready,[\s\S]*hostBootGeneration,[\s\S]*\}\)/,
  );
});

test("v0.73 renders backup age, repository check, full check and isolated restore without internal paths", () => {
  const client = read("public/app.js");
  const styles = read("public/styles.css");
  const html = read("public/index.html");

  assert.match(client, /if \(!offsite\?\.applicable\) return ""/);
  assert.match(client, /Repository-Prüfung/);
  assert.match(client, /Vollständiger Monatscheck/);
  assert.match(client, /Isolierter Test-Restore/);
  assert.match(client, /offsite\?\.agesHours\?\.repositoryCheck/);
  assert.match(client, /String\(offsite\?\.summary/);
  assert.match(client, /14\)\} Tagesstände/);
  assert.doesNotMatch(client, /offsite\?\.(?:repository|statusPath|account|token|password)/);
  assert.match(styles, /\.offsite-diagnostics/);
  assert.match(styles, /data-active-page-theme="dark"[\s\S]+\.offsite-diagnostics/);
  assert.match(html, /verschlüsselte Offsite-(?:Backups|Kopien)/);
});
