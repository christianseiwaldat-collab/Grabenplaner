"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const hostRebootClient = fs.readFileSync(
  path.join(root, "lib", "host-reboot-control-client.js"),
  "utf8",
);
const serviceUnit = fs.readFileSync(
  path.join(root, "server-tools", "linux", "grabenplaner.service.in"),
  "utf8",
);

test("VPS-Reboot ist als eigener Developer-Dialog vom Dienstneustart getrennt", () => {
  assert.match(html, /id="serverRestartTitle">Grabenplaner-Dienst neu starten</);
  assert.match(html, /id="vpsRebootModal"/);
  assert.match(html, /id="vpsRebootCurrentPassword"[^>]*autocomplete="current-password"/);
  assert.match(html, /Sicherung erstellen und VPS neu starten/);
  assert.match(app, /data-server-monitor-action="vps-reboot"/);
  assert.match(app, /confirmation:\s*"VPS_REBOOT",\s*currentPassword/);
  assert.match(app, /\/api\/portal\/v1\/server-monitor\/vps-reboot/);
});

test("Developer sieht die VPS-Aktion immer, während die Ausführung fail-closed bleibt", () => {
  assert.match(server, /const vpsRebootVisible = Boolean\(actor && actor\.role === "developer"\)/);
  assert.match(server, /canVpsReboot:\s*vpsRebootVisible && vpsRebootUnavailableReason === null/);
  assert.match(server, /VPS_REBOOT_STATUS_UNVERIFIED/);
  assert.match(server, /VPS_REBOOT_CONTROL_UNAVAILABLE/);
  assert.match(server, /VPS_REBOOT_NOT_REQUIRED/);
  assert.match(app, /monitorActions\.vpsRebootVisible === true/);
  assert.match(app, /monitorActions\.canVpsReboot !== true/);
  assert.match(app, /id="vpsRebootAvailabilityHint"/);
  assert.match(app, /vpsRebootUnavailableMessage\(monitorActions\.vpsRebootUnavailableReason\)/);
});

test("gehärtetes ProcSubset besitzt eine sichere PID-1-Ausweichmessung für die Bootgeneration", () => {
  assert.match(serviceUnit, /^ProtectKernelTunables=yes$/m);
  assert.match(serviceUnit, /^ProtectProc=invisible$/m);
  assert.match(serviceUnit, /^ProcSubset=pid$/m);
  assert.match(hostRebootClient, /PROC_ONE_STAT_PATH = "\/proc\/1\/stat"/);
  assert.match(hostRebootClient, /stat\.uid !== 0n/);
  assert.match(hostRebootClient, /stat\.gid !== 0n/);
  assert.match(hostRebootClient, /stat\.ctimeNs/);
  assert.match(hostRebootClient, /hashedBootGeneration\("proc-one", evidence\)/);
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
    /app\.post\("\/api\/portal\/v1\/server-monitor\/vps-reboot"[\s\S]*?\r?\n\}\);\r?\n\r?\napp\.post\("\/api\/system\/exit"/,
  )?.[0] || "";
  assert.match(endpoint, /actor\.role !== "developer"/);
  assert.match(endpoint, /assertVpsRebootConfirmation\(request\.body\)/);
  assert.match(endpoint, /requireBackupAdminReauthentication/);
  assert.ok(endpoint.indexOf('createDatabaseBackup("vps-reboot")')
    < endpoint.indexOf("requestControl: requestHostReboot"));
  assert.match(endpoint, /prepareControlledHostReboot/);
  assert.match(endpoint, /response\.status\(202\)\.json/);
});
