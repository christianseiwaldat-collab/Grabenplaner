"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("v0.74 separates redacted status and technical diagnostics permissions", () => {
  const server = read("server.js");
  assert.match(server, /id: "system:diagnostics:read"/);
  assert.match(server, /id: "system:diagnostics:technical"/);
  assert.match(server, /app\.get\("\/api\/server-status"[\s\S]*serverStatusForActor\(serverDiagnostics\(\), actor\)/);
  assert.match(server, /app\.get\("\/api\/server-diagnostics"[\s\S]*"system:diagnostics:technical"/);
  assert.match(server, /serverStatus: statusAllowed \? serverStatusForActor\(diagnosticSnapshot, request\.portalSession\) : null/);
  assert.match(server, /serverDiagnostics: diagnosticsAllowed \? diagnosticSnapshot : null/);
  const summary = server.match(/function serverStatusSummary[\s\S]*?function sendReadiness/)?.[0] || "";
  for (const forbidden of ["dataRoot", "appDirectory", "externalDirectory", "rootDirectory", "process.pid", "listenHost"]) {
    assert.doesNotMatch(summary, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("v0.74 renders global alerts, split live-ready state and supervised recovery guidance", () => {
  const html = read("public/index.html");
  const client = read("public/app.js");
  const styles = read("public/styles.css");
  assert.match(html, /id="serverAlertBanner"/);
  assert.match(html, /class="settings-card full-settings-card server-diagnostics-card hidden" id="serverDiagnosticsCard"/);
  assert.match(html, /class="settings-card full-settings-card hidden" id="databaseBackupSettingsCard"/);
  assert.match(html, /class="settings-card full-settings-card hidden" id="backupImportCard"/);
  assert.match(html, /id="backupRestoreGuidanceCard"/);
  assert.match(html, /Wiederherstellung im Wartungsfenster/);
  assert.match(html, /System &amp; Backups/);
  assert.doesNotMatch(html.match(/<section id="backupSettings"[\s\S]*?<section id="usbProvisioningSettings"/)?.[0] || "", /Windows-Dienststopp|lokale PC-Sicherung|Lokaler Backup-Ordner am PC/);
  assert.match(client, /function renderGlobalServerAlert/);
  assert.match(client, /Prozess erreichbar/);
  assert.match(client, /Nicht betriebsbereit/);
  assert.match(client, /backupImportAccess = !serverActive/);
  assert.match(client, /system:diagnostics:technical/);
  assert.match(client, /\/api\/backup\/settings/);
  assert.match(styles, /\.server-alert-banner/);
  assert.match(styles, /\.diagnostic-readiness-grid/);
  assert.match(styles, /\.recovery-diagnostics/);
});
