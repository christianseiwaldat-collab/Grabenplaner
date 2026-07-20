"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const auditPath = path.join(root, "server-tools", "linux", "hardening", "test-grabenplaner-host-hardening.sh");
const audit = fs.readFileSync(auditPath, "utf8");
const commonPath = path.join(root, "server-tools", "linux", "hardening", "lib", "hardening-common.sh");
const common = fs.readFileSync(commonPath, "utf8");
const unattendedPath = path.join(root, "server-tools", "linux", "hardening", "templates", "60grabenplaner-unattended-upgrades");
const unattended = fs.readFileSync(unattendedPath, "utf8");

const statusKeys = [
  "ssh",
  "firewall",
  "publicPorts",
  "automaticUpdates",
  "sysctl",
  "journald",
  "accountProtection",
  "secretFiles",
  "failedUnits",
  "timeSync",
];

test("v0.75 audit covers every required host security area", () => {
  for (const fragment of [
    "sshd", "ufw status verbose", "ss -H -ltn", "apt-config dump", "apt-daily.timer", "apt-daily-upgrade.timer",
    'Unattended-Upgrade::Automatic-Reboot "false";',
    "sysctl -n", "systemd-analyze cat-config systemd/journald.conf",
    "getent passwd", "grabenplaner.env", "/var/run/reboot-required",
    "systemctl --failed", "NTPSynchronized",
  ]) assert.ok(audit.includes(fragment), `missing audit fragment: ${fragment}`);
  assert.match(audit, /printf 'OK: %s/);
  assert.match(audit, /printf 'WARN: %s/);
  assert.match(audit, /printf 'FEHLER: %s/);
});

test("v0.75 machine status has a fixed redacted schema", () => {
  for (const field of [
    '"format": "grabenplaner-host-security-status"',
    '"schemaVersion": 1',
    '\\"checkedAt\\"',
    '\\"state\\"',
    '\\"configured\\"',
    '\\"pendingConfirmation\\"',
    '\\"rebootRequired\\"',
    '"checks": {',
  ]) assert.ok(audit.includes(field), `missing status field: ${field}`);
  for (const key of statusKeys) {
    assert.ok(audit.includes(`\\"${key}\\": \${CHECK_VALUE[${key}]}`), `missing fixed status check ${key}`);
  }
  assert.match(audit, /state=ok/);
  assert.match(audit, /state=warning/);
  assert.match(audit, /state=error/);
  assert.match(audit, /reader_group="\$STATUS_READER_GROUP"/);
  assert.match(audit, /file_mode=0640/);
  assert.match(audit, /directory_mode=0710/);
  assert.match(audit, /file_mode=0600/);
  assert.match(audit, /directory_mode=0700/);

  const statusWriter = audit.slice(audit.indexOf("write_status_file()"), audit.indexOf("while [[ $# -gt 0 ]]"));
  for (const forbidden of ["path", "port", "user", "username", "ipAddress", "message", "details", "errors", "warnings"]) {
    assert.equal(statusWriter.includes(`\\"${forbidden}\\"`), false, `status must not expose ${forbidden}`);
  }
});

test("v0.75 audit is read-only unless explicitly writing its redacted status", () => {
  assert.match(audit, /--write-status/);
  assert.match(audit, /hardening_require_root/);
  assert.match(audit, /hardening_assert_installed_contract/);
  assert.doesNotMatch(audit, /systemctl\s+(?:enable|disable|start|stop|restart|reload|daemon-reload)/);
  assert.doesNotMatch(audit, /(^|\n)\s*(?:ufw|iptables|nft|apt|apt-get|dpkg|sysctl)\s+(?:allow|deny|delete|enable|disable|install|remove|upgrade|apply|-p)/m);
  assert.doesNotMatch(audit, />\s*\/etc\//);
  assert.match(audit, /mv -fT -- "\$temporary" "\$HARDENING_STATUS_FILE"/);
  assert.match(audit, /write_status_file "\$state" "\$CONFIGURED" "\$PENDING_CONFIRMATION"/);
  const writeBranch = audit.slice(audit.lastIndexOf("if [[ $WRITE_STATUS -eq 1 ]]"));
  assert.match(writeBranch, /write_status_file[\s\S]*exit 0[\s\S]*\[\[ \$ERROR_COUNT -eq 0 && \$WARNING_COUNT -eq 0 \]\]/);
});

test("v0.75 serializes atomic status writes without taking the controller lock", () => {
  assert.match(common, /HARDENING_STATUS_LOCK="\/run\/grabenplaner-host-security\/status\.lock"/);
  assert.match(common, /hardening_acquire_status_lock\(\)/);
  assert.match(common, /set -o noclobber; : >"\$HARDENING_STATUS_LOCK"/);
  assert.match(common, /stat -c '%u:%g:%a:%h'.*HARDENING_STATUS_LOCK/s);
  assert.match(common, /flock --wait "\$timeout_seconds" "\$status_fd"/);
  assert.match(audit, /hardening_acquire_status_lock 120/);
  assert.doesNotMatch(audit, /hardening_acquire_controller_lock/);
  assert.match(audit, /AUDIT_CHECKED_AT="\$\(date --utc/);
  assert.match(audit, /currentEpoch >= candidateEpoch/);
  assert.match(audit, /sync -f "\$temporary"/);
  assert.match(audit, /mv -fT -- "\$temporary" "\$HARDENING_STATUS_FILE"/);
  assert.match(audit, /sync -f "\$HARDENING_STATE_ROOT"/);
});

test("v0.75 audit derives configured state from safe root-only transactions", () => {
  assert.match(audit, /ACTIVE_TRANSACTION_FILE/);
  assert.match(audit, /validate_transaction_reference "\$HARDENING_PENDING_FILE" pending_confirmation/);
  assert.match(audit, /validate_transaction_reference "\$ACTIVE_TRANSACTION_FILE" confirmed/);
  assert.match(audit, /private_regular_file/);
  assert.match(audit, /0:0:600:1/);
  assert.match(audit, /private_transaction_directory/);
  assert.match(audit, /0:0:700/);
  assert.match(audit, /policy\.isValidPort\(port\)/);
  assert.match(audit, /policy\.isValidAdminUsername\(admin\)/);
  assert.match(audit, /policy\.parseIpAddress\(clientIp\)/);
  assert.match(audit, /policy\.parseIpAddress\(serverIp\)/);
  assert.match(audit, /policy\.validateSession\(\{ clientIp, allowedSources: sources \}\)/);
  assert.match(audit, /policy\.parseCidr\(source\)/);
  assert.match(audit, /CONFIGURED=false/);
  assert.doesNotMatch(audit, /write_status_file "\$state" true/);
});

test("v0.75 firewall audit combines UFW transaction rules with listener isolation", () => {
  assert.match(audit, /validate_transaction_ufw_policy/);
  assert.match(audit, /ufw show added/);
  assert.match(audit, /ufw status verbose/);
  assert.match(audit, /UFW_DEFAULT_FILE="\/etc\/default\/ufw"/);
  assert.match(audit, /root_readonly_config_file "\$UFW_DEFAULT_FILE"/);
  assert.match(audit, /policy\.validateUfwPolicy/);
  assert.match(audit, /ufwDefaults:/);
  assert.match(audit, /requireComplete: true/);
  assert.match(audit, /TRANSACTION_SSH_PORT/);
  assert.match(audit, /TRANSACTION_SOURCES/);
  assert.match(audit, /127\.0\.0\.1:3000/);
  assert.match(audit, /\[::1\]:3000/);
  assert.match(audit, /found && !unsafe/);
  assert.match(audit, /internal_port_is_loopback_only/);
  assert.doesNotMatch(audit, /transaction_ssh_rules_present/);
});

test("v0.75 SSH audit uses the exact validated transaction connection context", () => {
  assert.match(audit, /read_private_scalar "\$admin_file" admin/);
  assert.match(audit, /read_private_scalar "\$client_file" client_ip/);
  assert.match(audit, /read_private_scalar "\$server_file" server_ip/);
  assert.match(audit, /-T -C/);
  assert.match(audit, /user=\$TRANSACTION_ADMIN,addr=\$TRANSACTION_CLIENT_IP,laddr=\$TRANSACTION_SERVER_IP,lport=\$TRANSACTION_SSH_PORT/);
  assert.match(audit, /TRANSACTION_MARKER_PRESENT/);
  assert.match(audit, /\$1 == "port" \{ count \+= 1;/);
  assert.match(audit, /count == 1 && !invalid/);
  for (const directive of [
    "permitrootlogin no", "pubkeyauthentication yes", "passwordauthentication no",
    "kbdinteractiveauthentication no", "authenticationmethods publickey", "permitemptypasswords no",
    "x11forwarding no", "allowagentforwarding no", "allowtcpforwarding local", "gatewayports no",
    "permittunnel no", "permituserenvironment no", "maxauthtries 3", "logingracetime 30",
    "clientaliveinterval 300", "clientalivecountmax 2", "loglevel verbose", "strictmodes yes",
  ]) assert.ok(audit.includes(`'${directive}'`), `SSH-Auditpruefung fehlt: ${directive}`);
});

test("v0.75 account audit separates runtime and build groups", () => {
  assert.match(audit, /runtime_groups=" \$\(id -nG grabenplaner/);
  assert.match(audit, /build_groups=" \$\(id -nG grabenplaner-build/);
  assert.match(audit, /\$runtime_groups" == \*" grabenplaner-build "/);
  assert.match(audit, /\$build_groups" == \*" grabenplaner "/);
});

test("v0.75 unattended upgrades permit only security and ESM security origins", () => {
  assert.match(unattended, /#clear Unattended-Upgrade::Allowed-Origins;/);
  assert.match(unattended, /#clear Unattended-Upgrade::Origins-Pattern;/);
  assert.match(unattended, /\$\{distro_codename\}-security/);
  assert.match(unattended, /\$\{distro_codename\}-apps-security/);
  assert.match(unattended, /\$\{distro_codename\}-infra-security/);
  assert.doesNotMatch(unattended, /"\$\{distro_id\}:\$\{distro_codename\}";/);
  assert.match(audit, /mapfile -t origins/);
  assert.match(audit, /\$\{#origins\[@\]\} -ne 3/);
  assert.match(audit, /UbuntuESMApps:/);
  assert.match(audit, /UbuntuESM:/);
  assert.match(audit, /Origins-Pattern/);
  assert.match(audit, /Remove-Unused-Dependencies "false"/);
  assert.match(audit, /systemctl is-enabled --quiet "\$timer"/);
  assert.match(audit, /systemctl is-active --quiet "\$timer"/);
  assert.ok(
    audit.lastIndexOf("hardening_validate_os") < audit.lastIndexOf("discover_transaction_configuration"),
    "Ubuntu release metadata must be validated before expanded origin values are evaluated.",
  );
});

test("v0.75 journald audit evaluates the Journal section with last assignment wins", () => {
  assert.match(audit, /\^\\\[Journal\\\]\[\[:space:\]\]\*\$/);
  assert.match(audit, /section="Journal"/);
  assert.match(audit, /section == "Journal"/);
  assert.match(audit, /value=substr/);
  assert.match(audit, /systemctl is-active --quiet systemd-journald\.service/);
});

test("v0.75 audit script has valid Bash syntax when Bash is available", (context) => {
  const probe = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    context.skip("Bash is not installed on this test host");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
  const result = spawnSync("bash", ["-n", auditPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
