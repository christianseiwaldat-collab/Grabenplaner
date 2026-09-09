"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

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

test("offener Sicherheitsneustart wird eindeutig vom Dienstneustart abgegrenzt", () => {
  assert.match(
    fs.readFileSync(path.join(root, "lib", "host-security-status.js"), "utf8"),
    /vollständiger kontrollierter Neustart des Ubuntu-VPS[^.]*\. Ein Neustart des Grabenplaner-Dienstes genügt nicht\./,
  );
  assert.match(app, /vollständiger Ubuntu-VPS-Neustart erforderlich/);
  assert.match(app, /Vollständiger kontrollierter Ubuntu-VPS-Neustart im Wartungsfenster erforderlich/);
  assert.match(app, /Ein Neustart des Grabenplaner-Dienstes genügt nicht und lässt den Sicherheitsneustart offen/);
  assert.match(html, /Ein Neustart des Grabenplaner-Dienstes beseitigt keinen offenen Ubuntu-Sicherheitsneustart/);
  assert.match(html, /Dieser geschützte Vorgang startet den vollständigen Ubuntu-VPS kontrolliert neu/);
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

test("gehärtetes ProcSubset erhält die Boot-ID als systemd-Credential mit sicherem Fallback", () => {
  assert.match(serviceUnit, /^ProtectKernelTunables=yes$/m);
  assert.match(serviceUnit, /^ProtectProc=invisible$/m);
  assert.match(serviceUnit, /^ProcSubset=pid$/m);
  assert.match(serviceUnit, /^LoadCredential=host-boot-id:\/proc\/sys\/kernel\/random\/boot_id$/m);
  assert.ok(
    serviceUnit.indexOf("LoadCredential=host-boot-id:") < serviceUnit.indexOf("ProtectProc=invisible"),
  );
  assert.match(hostRebootClient, /CREDENTIALS_DIRECTORY/);
  assert.match(hostRebootClient, /readCredentialBootId/);
  assert.match(hostRebootClient, /MAX_BOOT_ID_CREDENTIAL_BYTES/);
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
  assert.ok(endpoint.indexOf("hostSecurity.lastErrorCode") < endpoint.indexOf('createDatabaseBackup("vps-reboot")'));
  assert.match(endpoint, /response\.status\(202\)\.json/);
});

test("reboot capabilities require a current audit and preserve role and pending-operation gates", () => {
  const start = server.indexOf("function serverMonitorActionCapabilities(");
  const end = server.indexOf("function serverStatusForActor(", start);
  const capabilities = vm.runInNewContext(`${server.slice(start, end)}; serverMonitorActionCapabilities`, {
    serverManagedRestartAvailable: true,
    currentServerMonitorRestartCooldownSeconds: () => 0,
    currentHostManagedRebootAvailable: () => true,
    hostManagedRebootRequested: false,
    SERVER_MONITOR_CONTROL_ROLES: new Set(["developer"]),
  });
  const actor = { role: "developer", permissions: ["system:write", "system:diagnostics:technical"] };
  const verified = { hostSecurityConfigured: true, hostSecurityStatusAvailable: true, hostRebootRequired: true };
  assert.equal(capabilities(actor, verified).canVpsReboot, true);
  for (const code of ["HOST_SECURITY_STATUS_STALE", "HOST_SECURITY_STATUS_TIMESTAMP_FUTURE"]) {
    const result = capabilities(actor, { ...verified, hostSecurityStatusErrorCode: code });
    assert.equal(result.canVpsReboot, false);
    assert.equal(result.vpsRebootUnavailableReason, "VPS_REBOOT_STATUS_UNVERIFIED");
  }
  for (const condition of [
    { managedHostRebootAvailable: false }, { hostSecurityStatusAvailable: false },
    { hostSecurityPendingConfirmation: true }, { hostRebootInProgress: true }, { hostRebootRequired: false },
  ]) assert.equal(capabilities(actor, { ...verified, ...condition }).canVpsReboot, false);
  assert.equal(capabilities({ ...actor, role: "admin" }, verified).canVpsReboot, false);
  assert.equal(capabilities({ ...actor, permissions: [] }, verified).canVpsReboot, false);
  assert.match(server.slice(end, server.indexOf("function assertServerRestartConfirmation", end)), /hostSecurityStatusErrorCode: diagnostics\?\.hostSecurity\?\.lastErrorCode/);
});

test("host card distinguishes maintenance, unknown checks and unavailable status", () => {
  const start = app.indexOf("function renderHostSecurityDiagnostics(");
  const end = app.indexOf("function canManageOffsiteFolders(", start);
  const render = vm.runInNewContext(`${app.slice(start, end)}; renderHostSecurityDiagnostics`, {
    state: {}, escapeHtml: value => String(value), diagnosticTimestamp: value => String(value), diagnosticAge: () => "",
    hostSecurityCheckLabels: { publicPorts: "Trennung öffentlicher und interner Ports" },
    vpsRebootUnavailableMessage: () => "Gesperrt",
  });
  const reboot = { configured: true, statusAvailable: true, state: "warning", rebootRequired: true, failedChecks: [], unknownChecks: [] };
  assert.match(render(reboot), /Wartung nötig/);
  const incomplete = render({ ...reboot, unknownChecks: ["publicPorts"] });
  assert.match(incomplete, /Nicht bestätigt: Trennung öffentlicher und interner Ports/);
  assert.doesNotMatch(incomplete, /Einzelprüfungen beim letzten Audit bestanden|Wartung nötig/);
  const missing = render({ configured: true, statusAvailable: false, state: "error" });
  assert.match(missing, /Prüfergebnis nicht verfügbar/);
  assert.doesNotMatch(missing, /keine offene Sicherheitstransaktion|derzeit nicht erforderlich/);
});
