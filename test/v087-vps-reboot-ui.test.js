"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

test("VPS-Reboot ist als eigener Developer-Dialog vom Dienstneustart getrennt", () => {
  assert.match(html, /id="serverRestartTitle">Grabenplaner-Dienst neu starten</);
  assert.match(html, /id="vpsRebootModal"/);
  assert.match(html, /id="vpsRebootCurrentPassword"[^>]*autocomplete="current-password"/);
  assert.match(html, /Sicherung erstellen und VPS neu starten/);
  assert.match(app, /data-server-monitor-action="vps-reboot"/);
  assert.match(app, /confirmation:\s*"VPS_REBOOT",\s*currentPassword/);
  assert.match(app, /\/api\/portal\/v1\/server-monitor\/vps-reboot/);
});

test("VPS-Reboot wartet nur lesend auf echte Unterbrechung und wiederholt die Aktion nie", () => {
  assert.match(app, /let interruptionObserved = false/);
  assert.match(app, /newHostBootGeneration !== previousHostBootGeneration/);
  assert.match(app, /new AbortController\(\)/);
  assert.match(app, /signal: controller\.signal/);
  assert.match(app, /innerhalb von fünf Minuten nicht sicher bestätigt/);
  assert.doesNotMatch(app, /requestHostReboot|systemctl\s+reboot/);
});

test("Serverpfad verlangt Developer, Reauth und Backup vor dem Root-Broker", () => {
  const endpoint = server.match(
    /app\.post\("\/api\/portal\/v1\/server-monitor\/vps-reboot"[\s\S]*?\n\}\);\n\napp\.post\("\/api\/system\/exit"/,
  )?.[0] || "";
  assert.match(endpoint, /actor\.role !== "developer"/);
  assert.match(endpoint, /assertVpsRebootConfirmation\(request\.body\)/);
  assert.match(endpoint, /requireBackupAdminReauthentication/);
  assert.ok(endpoint.indexOf('createDatabaseBackup("vps-reboot")')
    < endpoint.indexOf("requestControl: requestHostReboot"));
  assert.match(endpoint, /prepareControlledHostReboot/);
  assert.match(endpoint, /response\.status\(202\)\.json/);
});
