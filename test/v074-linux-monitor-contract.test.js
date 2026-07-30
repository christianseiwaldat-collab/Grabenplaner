"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const bash = [
  process.platform === "win32"
    ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe")
    : "bash",
  process.platform === "win32" && process.env["ProgramFiles(x86)"]
    ? path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe")
    : "",
].find((candidate) => candidate && spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0) || "";

test("current runtime contract retains the monitor units after later explicit migrations", () => {
  const schema = JSON.parse(read("server-tools", "linux", "runtime-schema.json"));
  assert.equal(schema.deploymentSchemaVersion, 3);
  assert.equal(schema.migrationPolicy, "explicit-maintenance");
  assert.deepEqual(schema.managedArtifacts.filter((item) => item.includes("grabenplaner-monitor")), [
    "server-tools/linux/grabenplaner-monitor.service.in",
    "server-tools/linux/grabenplaner-monitor.timer.in",
  ]);

  const verification = spawnSync(process.execPath, [
    path.join(root, "server-tools/linux/lib/verify-package.js"), "--runtime-contract", root,
  ], { encoding: "utf8" });
  assert.equal(verification.status, 0, verification.stderr);
  const contract = JSON.parse(verification.stdout);
  assert.equal(contract.deploymentSchemaVersion, 3);
  assert.equal(contract.managedArtifacts.length, 11);

  const updater = read("server-tools", "linux", "update-grabenplaner-server.sh");
  assert.match(updater, /migration-required:\$\{installed\.deploymentSchemaVersion\}->\$\{candidate\.deploymentSchemaVersion\}/);
  assert.match(updater, /bitte die freigegebene Servermigration ausfuehren/);
});

test("v0.74 installer creates the protected status reader group and manages monitor units idempotently", () => {
  const installer = read("server-tools", "linux", "install-grabenplaner-server.sh");
  for (const required of [
    "grabenplaner-monitor-status",
    "/var/lib/grabenplaner-monitor",
    "monitor/lib/monitor-status.js",
    "grabenplaner-monitor.service.in",
    "grabenplaner-monitor.timer.in",
    "usermod --append --groups",
    "install -d -o root -g \"$MONITOR_STATUS_GROUP\" -m 0750",
    "systemctl enable --now grabenplaner-monitor.timer",
  ]) assert.ok(installer.includes(required), `Installervertrag fehlt: ${required}`);
  assert.match(installer, /--status-file "\$MONITOR_STATUS_FILE" --status-gid "\$monitor_status_gid" initialize/);
  assert.match(installer, /systemd-analyze verify "\$APP_UNIT" "\$BOOTSTRAP_UNIT" "\$MONITOR_UNIT" "\$MONITOR_TIMER"/);
});

test("v0.74 monitor service is hardened and timer runs every five minutes", () => {
  const service = read("server-tools", "linux", "grabenplaner-monitor.service.in");
  const timer = read("server-tools", "linux", "grabenplaner-monitor.timer.in");
  for (const directive of [
    "User=root",
    "Type=oneshot",
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "CapabilityBoundingSet=",
    "ReadWritePaths=/var/lib/grabenplaner-monitor /run/grabenplaner-monitor /run/grabenplaner",
  ]) assert.match(service, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(timer, /OnCalendar=\*:0\/5/);
  assert.match(timer, /Persistent=true/);
  assert.doesNotMatch(service, /EnvironmentFile=/);
});

test("v0.74 monitor executes the existing bounded server test and permits restart only from live status", () => {
  const monitor = read("server-tools", "linux", "monitor", "run-grabenplaner-monitor.sh");
  const statusHelper = read("server-tools", "linux", "monitor", "lib", "monitor-status.js");
  assert.match(monitor, /test-grabenplaner-server\.sh/);
  assert.match(monitor, /--monitor-mode/);
  assert.match(statusHelper, /consecutiveLiveFailures/);
  assert.match(statusHelper, /failures >= 3/);
  assert.match(statusHelper, /RESTART_COOLDOWN_MS = 30 \* 60 \* 1000/);
  assert.match(monitor, /restart-attempt/);
  assert.match(monitor, /systemctl restart "\$APP_SERVICE"/);
  assert.match(monitor, /restart-result --successful/);
  assert.match(monitor, /error --code MONITOR_RUN_FAILED/);
  assert.doesNotMatch(monitor, /systemctl restart.*ready|systemctl restart.*backup|systemctl restart.*offsite/i);
});

test("v0.86.2 controlled dashboard restart remains coupled to backup and systemd recovery", () => {
  const server = read("server.js");
  const service = read("server-tools/linux/grabenplaner.service.in");
  assert.match(service, /^StartLimitIntervalSec=300$/m);
  assert.match(service, /^StartLimitBurst=5$/m);
  assert.match(service, /^Restart=on-failure$/m);
  assert.match(service, /^RestartSec=10s$/m);
  assert.match(server, /process\.env\.INVOCATION_ID/);
  assert.match(server, /body\.confirmation !== "SERVER_RESTART"/);
  assert.match(server, /SERVER_MONITOR_RESTART_COOLDOWN_MS = 5 \* 60 \* 1000/);
  assert.match(server, /createDatabaseBackup\("server-monitor-restart"\);[\s\S]{0,1200}?exitCode: 75/);
  assert.match(server, /SERVER_MONITOR_CONTROL_ROLES = new Set\(\["admin", "it_admin", "developer"\]\)/);
});

test("v0.74 keeps monitor output schema-complete when the public HTTPS response is unavailable", () => {
  const health = read("server-tools/linux/test-grabenplaner-server.sh");
  assert.doesNotMatch(health, /check_fail "HTTPS-Sicherheitsheader"/);
  for (const label of [
    "HSTS",
    "Content-Security-Policy",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Cross-Origin-Opener-Policy",
    "Cross-Origin-Resource-Policy",
    "X-Permitted-Cross-Domain-Policies",
  ]) {
    assert.match(health, new RegExp(`check_fail "${label}" "Antwort konnte nicht gelesen werden"`));
  }
});

test("v0.86 Linux diagnostics enforce the complete public security-header contract", () => {
  const health = read("server-tools/linux/test-grabenplaner-server.sh");
  assert.match(health, /csp_has_exact_directive/);
  for (const expected of [
    "max-age=31536000;[[:space:]]*includeSubDomains",
    "X-Content-Type-Options:[[:space:]]*nosniff[[:space:]]*$",
    "X-Frame-Options:[[:space:]]*DENY",
    "Referrer-Policy:[[:space:]]*no-referrer",
    "Permissions-Policy:[[:space:]]*camera=\\(\\),[[:space:]]*microphone=\\(\\),[[:space:]]*geolocation=\\(\\)",
    "Cross-Origin-Opener-Policy:[[:space:]]*same-origin",
    "Cross-Origin-Resource-Policy:[[:space:]]*same-origin",
    "X-Permitted-Cross-Domain-Policies:[[:space:]]*none",
  ]) {
    assert.ok(health.includes(expected), `Headerpruefung fehlt: ${expected}`);
  }
  for (const directive of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
    assert.ok(health.includes(directive), `Content-Security-Policy prueft ${directive} nicht.`);
  }
});

test("v0.86 Linux diagnostics reject CSP directive substring appendages", {
  skip: !bash,
}, () => {
  const health = read("server-tools/linux/test-grabenplaner-server.sh").replace(/\r\n/g, "\n");
  const functionStart = health.indexOf("csp_has_exact_directive()");
  const functionEnd = health.indexOf("\n\nfor unit in", functionStart);
  assert.notEqual(functionStart, -1, "Exakte CSP-Prueffunktion fehlt.");
  assert.notEqual(functionEnd, -1, "Ende der CSP-Prueffunktion fehlt.");
  const functionSource = health.slice(functionStart, functionEnd).trim();
  const harness = [
    functionSource,
    "valid=\"default-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'\"",
    "frame_suffix=\"default-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none' https://evil.example\"",
    "form_suffix=\"default-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self' https://evil.example; frame-ancestors 'none'\"",
    "if csp_has_exact_directive \"$valid\" \"frame-ancestors 'none'\"; then printf 'valid=accepted\\n'; else printf 'valid=rejected\\n'; fi",
    "if csp_has_exact_directive \"$frame_suffix\" \"frame-ancestors 'none'\"; then printf 'frame=accepted\\n'; else printf 'frame=rejected\\n'; fi",
    "if csp_has_exact_directive \"$form_suffix\" \"form-action 'self'\"; then printf 'form=accepted\\n'; else printf 'form=rejected\\n'; fi",
    "",
  ].join("\n");
  const result = spawnSync(bash, ["-s"], {
    input: harness,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), [
    "valid=accepted",
    "frame=rejected",
    "form=rejected",
  ].join("\n"));
});

test("v0.74 rejects backup timestamps more than five minutes in the future", () => {
  const health = read("server-tools/linux/test-grabenplaner-server.sh");
  assert.match(health, /age_seconds < -300/);
  assert.match(health, /Zeitstempel liegt unplausibel in der Zukunft/);
  assert.match(health, /age_seconds < 0 \)\) && age_seconds=0/);
});

test("v0.74 uninstaller removes monitor units and command but deliberately preserves status data", () => {
  const uninstall = read("server-tools", "linux", "uninstall-grabenplaner-server.sh");
  assert.match(uninstall, /grabenplaner-monitor\.timer/);
  assert.match(uninstall, /grabenplaner-monitor\.service/);
  assert.match(uninstall, /\[grabenplaner-monitor\]=/);
  assert.match(uninstall, /Monitorstatus bleiben erhalten/);
  assert.doesNotMatch(uninstall, /rm\s+-[^\n]*\/var\/lib\/grabenplaner-monitor/);
});

test("v0.74 grabenplaner-test has a local monitor mode without five-minute remote repository traffic", () => {
  const script = read("server-tools", "linux", "test-grabenplaner-server.sh");
  assert.match(script, /--monitor-mode/);
  assert.match(script, /Monitor-Statusschutz/);
  assert.match(script, /Dienst \$unit/);
  assert.match(script, /offsite_status_reader/);
  assert.match(script, /readOffsiteBackupStatus/);
  assert.match(script, /offsite_timer_ok/);
  assert.ok(script.indexOf('"$monitor_mode" -eq 1') < script.indexOf('"$offsite_test_command"'));
});

test("v0.80 gives sandboxed Caddy validation private writable runtime storage", () => {
  const script = read("server-tools/linux/test-grabenplaner-server.sh");
  assert.match(script, /RUNTIME_DIRECTORY/);
  assert.match(script, /HOME="\$RUNTIME_DIRECTORY"/);
  assert.match(script, /XDG_CONFIG_HOME="\$RUNTIME_DIRECTORY\/caddy-config"/);
  assert.match(script, /XDG_DATA_HOME="\$RUNTIME_DIRECTORY\/caddy-data"/);
  assert.match(script, /caddy adapt --config "\$caddyfile" --adapter caddyfile/);
  assert.match(script, /delete entry\.writer/);
  assert.match(script, /caddy validate --config "\$caddy_validation_config"/);
  assert.doesNotMatch(script, /caddy validate --config "\$caddy_validation_config" --adapter json/);
  assert.match(script, /caddy_validation_ok/);
});
