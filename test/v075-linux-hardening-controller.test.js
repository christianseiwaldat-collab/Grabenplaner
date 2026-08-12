"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const controllerPath = path.join(root, "server-tools", "linux", "hardening", "grabenplaner-host-security.sh");
const controller = fs.readFileSync(controllerPath, "utf8");
const common = fs.readFileSync(path.join(root, "server-tools", "linux", "hardening", "lib", "hardening-common.sh"), "utf8");

function section(start, end) {
  const startIndex = controller.indexOf(`${start}() {`);
  const endIndex = controller.indexOf(`\n${end}() {`, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Abschnitt ${start} wurde nicht gefunden.`);
  return controller.slice(startIndex, endIndex);
}

test("v0.75 controller defaults to a read-only audit and exposes explicit transaction commands", () => {
  assert.match(controller, /local command="\$\{1:-audit\}"/);
  for (const command of [
    "audit", "plan", "apply", "confirm",
    "maintenance-plan", "maintenance-adopt", "maintenance-confirm", "maintenance-cancel", "maintenance-revoke",
    "rollback", "rollback-pending",
  ]) {
    assert.match(controller, new RegExp(`\\n    ${command.replace("-", "\\-")}\\)`));
  }
  const audit = section("audit_command", "plan_command");
  assert.match(audit, /exec "\$HARDENING_AUDIT_COMMAND" "\$@"/);
  assert.doesNotMatch(audit, /ufw allow|ufw --force enable|systemctl reload|sysctl --system|hardening_atomic_install/);
  assert.doesNotMatch(controller, /grabenplaner-host-security-status/);
  assert.doesNotMatch(controller, /HARDENING_STATUS_FILE/);
  const refresh = section("refresh_audit_status", "start_rollback_guard");
  assert.match(refresh, /"\$HARDENING_AUDIT_COMMAND" --write-status/);
});

test("v0.75 controller never resets UFW or deletes foreign firewall rules", () => {
  assert.doesNotMatch(controller, /\bufw\s+(?:--force\s+)?reset\b/);
  assert.doesNotMatch(controller, /\bufw\s+delete\b/);
  assert.match(controller, /ufw --dry-run allow proto tcp from "\$source" to any port "\$port"/);
  assert.match(controller, /ufw allow proto tcp from "\$source" to any port "\$port"/);
  assert.match(controller, /restore_file "\$transaction_directory" ufw-user/);
  assert.match(controller, /restore_file "\$transaction_directory" ufw-user6/);
  assert.match(controller, /backup_file "\$transaction_directory" ufw-default "\$UFW_DEFAULT"/);
  assert.match(controller, /restore_file "\$transaction_directory" ufw-default "\$UFW_DEFAULT"/);
  for (const policy of ["default deny incoming", "default allow outgoing", "default deny routed", "logging low"]) {
    assert.ok(controller.includes(`ufw ${policy}`), `UFW-Policy fehlt: ${policy}`);
  }
});

test("v0.75 arms rollback before mutation and allows SSH before UFW activation", () => {
  const apply = section("apply_command", "load_transaction_session_policy");
  const preflight = apply.indexOf("configured_preflight");
  const timer = apply.indexOf('start_rollback_guard "$transaction_id"');
  const firewall = apply.indexOf('apply_ufw_rules "$transaction_directory"');
  const templates = apply.indexOf('install_managed_templates "$transaction_directory"');
  assert.ok(preflight >= 0 && timer > preflight && firewall > timer && templates > firewall);

  const guard = section("start_rollback_guard", "apply_ufw_rules");
  assert.match(guard, /systemctl enable --now "\$HARDENING_ROLLBACK_TIMER"/);
  assert.match(guard, /\bsync\b/);
  assert.match(controller, /systemctl disable --now "\$HARDENING_ROLLBACK_TIMER"/);
  assert.doesNotMatch(controller, /systemctl (?:start|stop) "\$HARDENING_ROLLBACK_TIMER"/);

  const ufw = section("apply_ufw_rules", "install_managed_templates");
  const activation = ufw.indexOf("ufw --force enable");
  for (const prerequisite of [
    'ufw allow proto tcp from "$source"', "ufw default deny incoming",
    "ufw default allow outgoing", "ufw default deny routed", "ufw logging low",
  ]) assert.ok(ufw.indexOf(prerequisite) >= 0 && ufw.indexOf(prerequisite) < activation, `${prerequisite} muss vor UFW enable liegen.`);

  const confirm = section("confirm_command", "rollback_command");
  const rollback = section("rollback_transaction", "rollback_on_failed_apply");
  assert.match(confirm, /systemctl disable --now "\$HARDENING_ROLLBACK_TIMER"[\s\S]*?\bsync\b/);
  assert.match(rollback, /systemctl disable --now "\$HARDENING_ROLLBACK_TIMER"[\s\S]*?\bsync\b/);
  assert.match(confirm, /systemctl enable --now "\$HARDENING_ROLLBACK_TIMER"[\s\S]*?sync/);
});

test("v0.75 journald migration refuses foreign old or new targets before mutation", () => {
  const preflight = section("configured_preflight", "write_private_value");
  assert.match(preflight, /cmp -s -- "\$TEMPLATE_ROOT\/60-grabenplaner-journald\.conf" "\$JOURNALD_DROPIN"/);
  assert.match(preflight, /cmp -s -- "\$TEMPLATE_ROOT\/60-grabenplaner-journald\.conf" "\$JOURNALD_LEGACY_DROPIN"/);
  assert.match(preflight, /fremd oder veraendert/);
  assert.doesNotMatch(preflight, /rm -f|hardening_atomic_install|systemctl restart/);
});

test("v0.75 validates SSH syntax and effective policy before reload without changing its port", () => {
  const install = section("install_managed_templates", "restore_host_configuration");
  const syntax = install.indexOf("sshd -t");
  const effective = install.indexOf("sshd_effective_configuration");
  const reload = install.indexOf("systemctl reload ssh.service");
  assert.ok(syntax >= 0 && effective > syntax && reload > effective);
  assert.match(install, /sshd_effective_has_exact_port "\$effective" "\$CONFIG_SSH_PORT"/);
  const exactPort = section("sshd_effective_has_exact_port", "sshd_validate_and_require_port");
  assert.match(exactPort, /count \+= 1/);
  assert.match(exactPort, /count == 1 && !invalid/);
  assert.match(controller, /"\$requested_port" == "\$server_port"/);
  assert.doesNotMatch(controller, /systemctl (?:try-)?restart (?:ssh|sshd)/);
  assert.doesNotMatch(controller, /(?:^|\s)Port\s+[0-9]+/m);
  assert.match(controller, /sshd -T -C "user=\$admin,addr=\$client_ip,laddr=\$server_ip,lport=\$server_port"/);
  assert.doesNotMatch(controller, /sshd -T(?! -C)/);
  for (const directive of [
    "permitrootlogin no", "pubkeyauthentication yes", "passwordauthentication no",
    "kbdinteractiveauthentication no", "authenticationmethods publickey", "permitemptypasswords no",
    "x11forwarding no", "allowagentforwarding no", "allowtcpforwarding local", "gatewayports no",
    "permittunnel no", "permituserenvironment no", "maxauthtries 3", "logingracetime 30",
    "clientaliveinterval 300", "clientalivecountmax 2", "loglevel verbose", "strictmodes yes",
  ]) assert.ok(controller.includes(`'${directive}'`), `Effektive SSH-Pruefung fehlt: ${directive}`);
});

test("v0.75 validates APT and migrates journald priority transactionally in both directions", () => {
  const install = section("install_managed_templates", "restore_host_configuration");
  assert.match(install, /validate_effective_apt_configuration/);
  assert.match(controller, /apt-config dump/);
  assert.match(controller, /APT muss exakt Security und ESM-Security verwenden/);
  assert.match(install, /systemctl restart systemd-journald\.service/);
  assert.match(controller, /JOURNALD_LEGACY_DROPIN="\/etc\/systemd\/journald\.conf\.d\/60-grabenplaner-journald\.conf"/);
  assert.match(controller, /JOURNALD_DROPIN="\/etc\/systemd\/journald\.conf\.d\/zz-grabenplaner-journald\.conf"/);
  assert.match(controller, /validateJournaldConfiguration/);
  assert.match(controller, /LC_ALL=C SYSTEMD_COLORS=0 SYSTEMD_PAGER=cat systemd-analyze cat-config/);
  const intendedNew = install.indexOf("record_intended_file_state \"$transaction_directory\" journald");
  const intendedLegacy = install.indexOf("record_intended_absent_state \"$transaction_directory\" journald-legacy");
  const journal = install.indexOf("write_apply_journal \"$transaction_directory\" journald_in_progress");
  const installNew = install.indexOf('hardening_atomic_install "$TEMPLATE_ROOT/60-grabenplaner-journald.conf" "$JOURNALD_DROPIN"');
  const validateLegacy = install.indexOf('cmp -s -- "$TEMPLATE_ROOT/60-grabenplaner-journald.conf"');
  const removeLegacy = install.indexOf('rm -f -- "$JOURNALD_LEGACY_DROPIN"');
  const validateEffective = install.indexOf("validate_effective_journald_configuration");
  assert.ok(intendedNew >= 0 && intendedLegacy > intendedNew && journal > intendedLegacy
    && installNew > journal && validateLegacy > installNew && removeLegacy > validateLegacy
    && validateEffective > removeLegacy);
  const backup = section("backup_host_configuration", "restore_parent_is_secure");
  assert.match(backup, /backup_file "\$transaction_directory" journald "\$JOURNALD_DROPIN"/);
  assert.match(backup, /backup_file "\$transaction_directory" journald-legacy "\$JOURNALD_LEGACY_DROPIN"/);
  const restore = section("restore_host_configuration", "rollback_transaction");
  assert.match(restore, /systemctl restart systemd-journald\.service/);
  assert.ok(
    restore.indexOf('restore_file "$transaction_directory" journald "$JOURNALD_DROPIN"')
      < restore.indexOf('restore_file "$transaction_directory" journald-legacy "$JOURNALD_LEGACY_DROPIN"'),
  );
  assert.match(controller, /apt-config awk cmp/);
  assert.match(controller, /sshd ssh-keygen stat sudo sync sysctl systemctl systemd-analyze ufw/);
});

test("v0.75 requires admin key, sudo and a newly opened second SSH session", () => {
  assert.match(controller, /sudo -n -l -U "\$admin"/);
  assert.match(controller, /authorized_keys/);
  assert.match(controller, /"\$\{SUDO_USER:-\}" == "\$admin"/);
  assert.match(controller, /SSH_TTY/);
  assert.match(controller, /SSH_CONNECTION/);
  assert.match(controller, /SESSION_CONNECTION_FINGERPRINT=.*SSH_CONNECTION/);
  assert.match(controller, /first-connection\.sha256/);
  assert.match(controller, /ssh_connection_is_independent "\$SESSION_CONNECTION_FINGERPRINT" "\$first_connection"/);
  assert.match(controller, /eigenstaendige neue SSH-Verbindung/);
  assert.match(controller, /policy_validate_transaction "\$first_connection"/);
  assert.match(controller, /policy_validate_session "\$SESSION_CLIENT_IP" "\$@"/);
  assert.match(controller, /SESSION_FINGERPRINT/);
  assert.match(controller, /"\$SESSION_FINGERPRINT" != "\$first_session"/);
  assert.match(controller, /policy_validate_transaction "\$first_session"/);
  assert.match(controller, /confirmation-not-before-epoch/);
  assert.match(controller, /"\$tty_epoch" -gt "\$confirmation_not_before_epoch"/);
  assert.match(controller, /transactionId":"%s"/);
  assert.match(controller, /\^\[0-9a-f\]\{64\}\$/);
});

test("hardening v3 adopts SSH maintenance policy without changing UFW and confirms over Tailscale", () => {
  const adopt = section("maintenance_adopt_command", "maintenance_confirm_command");
  const confirm = section("maintenance_confirm_command", "maintenance_cancel_command");
  assert.match(adopt, /validate_effective_maintenance_ufw_policy/);
  assert.match(adopt, /current_ufw_added_sha256/);
  assert.match(controller, /ufwChanged":false/);
  assert.doesNotMatch(adopt, /\bufw\s+(?:allow|delete|reset|enable|disable|reload|default|logging)\b/);
  assert.match(confirm, /session_uses_maintenance_interface/);
  assert.match(confirm, /Tailscale-SSH-Schnittstelle/);
  assert.match(confirm, /ssh_connection_is_independent/);
  assert.match(confirm, /current_ufw_hash.*MAINTENANCE_UFW_ADDED_SHA256/s);
  assert.match(controller, /validateMaintenanceSources/);
  assert.match(controller, /validateSshInterfaces/);
  assert.match(controller, /ACTIVE_MAINTENANCE_POLICY_FILE/);
  assert.match(controller, /aktive SSH-Wartungspolicy muss vor einem Host-Rollback/);
});

test("hardening v3 binds the confirmed server address to an address on tailscale0", (context) => {
  const probe = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    context.skip("Bash is not installed on this test host");
    return;
  }
  const policyPath = path.join(root, "server-tools", "linux", "hardening", "lib", "hardening-policy.js");
  const script = [
    'POLICY_FILE="$1"',
    'NODE_BINARY="$2"',
    'hardening_node() { printf \'%s\\n\' "$NODE_BINARY"; }',
    'policy_validate_interfaces() { [[ "$#" -eq 1 && "$1" == tailscale0 ]]; }',
    'ip() {',
    '  case "$*" in',
    '    "-o link show dev tailscale0") printf \'3: tailscale0: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1280\\n\' ;;',
    '    "-o address show dev tailscale0") printf \'3: tailscale0 inet 100.64.0.8/32 scope global tailscale0\\n3: tailscale0 inet6 2001:db8::5/128 scope global\\n\' ;;',
    '    *) return 1 ;;',
    '  esac',
    '}',
    section("session_server_address_uses_interface", "session_uses_maintenance_interface"),
    'session_server_address_uses_interface 100.64.0.8 tailscale0',
    'session_server_address_uses_interface 2001:db8::5 tailscale0',
    '! session_server_address_uses_interface 100.64.0.9 tailscale0',
    '! session_server_address_uses_interface 100.64.0.8 eth0',
  ].join("\n");
  const nodeBinary = process.execPath.replaceAll("\\", "/");
  const result = spawnSync("bash", ["-c", script, "test", policyPath, nodeBinary], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("v0.75 keeps backups and hashes root-only and public status redacted", () => {
  assert.match(controller, /install -d -o root -g root -m 0700 -- "\$transaction_directory\/backups"/);
  assert.match(controller, /install -o root -g root -m 0600 -- "\$target" "\$backup"/);
  assert.match(controller, /sha256sum --binary/);
  assert.match(controller, /chmod 0600 -- "\$metadata"/);

  const publicStatus = section("command_json", "require_controller_dependencies");
  assert.match(publicStatus, /sourceCount/);
  assert.match(publicStatus, /clientMatched/);
  assert.doesNotMatch(publicStatus, /admin|username|clientIp|sourceCidr|transactionId/i);
  const statusRefresh = section("refresh_audit_status", "start_rollback_guard");
  assert.doesNotMatch(statusRefresh, /CONFIG_ADMIN|SESSION_CLIENT_IP|CONFIG_SOURCES|transaction_id/i);
});

test("v0.75 rejects policy stacking and records an exact post-apply state", () => {
  const apply = section("apply_command", "load_transaction_session_policy");
  assert.match(apply, /! -e "\$ACTIVE_TRANSACTION_FILE"/);
  assert.doesNotMatch(controller, /previous-active/);
  const install = apply.indexOf('install_managed_templates "$transaction_directory"');
  const postState = apply.indexOf('record_post_apply_state "$transaction_directory"');
  const confirmationBoundary = apply.indexOf('write_private_value "$transaction_directory/confirmation-not-before-epoch"');
  const pending = apply.indexOf('write_transaction_state "$transaction_directory" pending_confirmation');
  assert.ok(install >= 0 && postState > install && confirmationBoundary > postState && pending > confirmationBoundary);

  const record = section("record_post_apply_state", "backup_file");
  assert.match(record, /post-apply\.tsv/);
  assert.match(record, /sha256sum --binary/);
  assert.match(record, /chown root:root/);
  assert.match(record, /chmod 0600/);
  assert.match(record, /\bsync\b/);
});

test("v0.75 rollback fully preflights drift and aggregates restore failures", () => {
  const preflight = section("preflight_rollback_transaction", "write_transaction_state");
  assert.match(preflight, /post-apply\.tsv/);
  assert.match(preflight, /hashes\.tsv/);
  assert.match(preflight, /private_file_is_secure "\$transaction_directory\/confirmation-not-before-epoch"/);
  assert.match(preflight, /file_matches_manifest_record/);
  assert.match(preflight, /state" == rollback_in_progress/);
  assert.match(preflight, /private_file_is_secure/);

  const rollback = section("rollback_transaction", "rollback_on_failed_apply");
  const verify = rollback.indexOf('preflight_rollback_transaction "$transaction_directory" "$state"');
  const progress = rollback.indexOf('write_transaction_state "$transaction_directory" rollback_in_progress');
  const restore = rollback.indexOf('restore_host_configuration "$transaction_directory"');
  assert.ok(verify >= 0 && progress > verify && restore > progress);
  assert.match(rollback, /if ! restore_host_configuration/);
  assert.match(rollback, /write_transaction_state "\$transaction_directory" rolled_back/);

  const restoreSection = section("restore_host_configuration", "finalize_rollback_success");
  for (const key of ["ssh", "sysctl", "journald", "journald-legacy", "unattended", "auto-upgrades", "ufw-user", "ufw-user6", "ufw-config", "ufw-default"]) {
    assert.ok(restoreSection.includes(`restore_file "$transaction_directory" ${key}`), `Best-effort-Restore fehlt: ${key}`);
  }
  assert.match(restoreSection, /errors \+= 1/g);
  assert.match(restoreSection, /if \(\(errors > 0\)\)/);
});

test("v0.75 restores files atomically and accepts only transaction-bound states", () => {
  const restore = section("restore_file", "transaction_state");
  const create = restore.indexOf('mktemp "$parent/.grabenplaner-restore-${key}.XXXXXXXX"');
  const install = restore.indexOf('install -o "$uid" -g "$gid" -m "$mode" -- "$backup" "$temporary"');
  const fileSync = restore.indexOf('sync -f "$temporary"');
  const revalidate = restore.indexOf('current_target_is_restore_permitted', fileSync);
  const tempRevalidate = restore.indexOf('file_matches_manifest_record "$temporary" "$record"', revalidate);
  const replace = restore.indexOf('mv -fT -- "$temporary" "$target"');
  const directorySync = restore.indexOf('sync -f "$parent"', replace);
  assert.ok(create >= 0 && install > create && fileSync > install && revalidate > fileSync
    && tempRevalidate > revalidate && replace > tempRevalidate && directorySync > replace);
  assert.match(restore, /restore_parent_is_secure "\$parent"/g);
  assert.match(restore, /file_matches_manifest_record "\$temporary" "\$record"/);
  assert.match(restore, /rm -f -- "\$target"[\s\S]*?sync -f "\$parent"[\s\S]*?! -e "\$target"/);

  const allowed = section("current_target_is_restore_permitted", "restore_file");
  assert.match(allowed, /post-apply\.tsv/);
  assert.match(allowed, /intended\/\$key\.tsv/);
  assert.match(allowed, /state" == rollback_in_progress/);
  assert.match(allowed, /restore_permit_record_for_key/);

  const preflight = section("preflight_rollback_transaction", "write_transaction_state");
  assert.match(preflight, /record_restore_permitted_current_state/);
  assert.match(preflight, /restore_permit_record_for_key/);
  assert.match(preflight, /file_matches_manifest_record "\$target" "\$permit_record"/);

  const records = section("validate_manifest_record", "file_matches_manifest_record");
  assert.match(records, /"\$uid" == 0/);
  assert.match(records, /8#\$mode & 022/);
  const backup = section("backup_file", "backup_host_configuration");
  assert.match(backup, /"\$uid" == 0/);
  assert.match(backup, /8#\$mode & 022/);
});

test("v0.75 confirmation is crash-safe and automatic rollback obeys a persistent deadline", () => {
  const confirm = section("confirm_command", "rollback_command");
  const active = confirm.indexOf('write_private_value "$ACTIVE_TRANSACTION_FILE" "$transaction_id"');
  const confirmed = confirm.indexOf('write_transaction_state "$transaction_directory" confirmed', active);
  const firstSync = confirm.indexOf("sync", confirmed);
  const removePending = confirm.indexOf('rm -f -- "$HARDENING_PENDING_FILE"', firstSync);
  const secondSync = confirm.indexOf("sync", removePending);
  const disable = confirm.indexOf('systemctl disable --now "$HARDENING_ROLLBACK_TIMER"', secondSync);
  assert.ok(active >= 0 && confirmed > active && firstSync > confirmed && removePending > firstSync && secondSync > removePending && disable > secondSync);

  const automatic = section("rollback_pending_command", "usage");
  assert.match(automatic, /hardening_acquire_controller_lock automatic "\$AUTOMATIC_ROLLBACK_LOCK_WAIT_SECONDS"/);
  assert.match(automatic, /rollback-deadline-epoch/);
  assert.match(automatic, /now_epoch < deadline_epoch/);
  assert.match(automatic, /rollback_transaction "\$transaction_id" \|\| return 1/);
  assert.doesNotMatch(controller, /systemd-run|--on-active/);
});

test("v0.75 validates the complete SSH trust chain", () => {
  const admin = section("admin_key_sudo_preflight", "sshd_effective_configuration");
  assert.match(admin, /\[\[ -d "\$home" && ! -L "\$home" \]\]/);
  assert.match(admin, /8#\$mode & 022/);
  assert.match(admin, /stat --format='%h'/);
  assert.match(admin, /ssh-keygen -l -f "\$authorized_keys"/);
  assert.match(admin, /NF != 2/);
  assert.ok(controller.includes("'strictmodes yes'"));
  assert.match(controller, /policy_validate_sources "\$\{CONFIG_SOURCES\[@\]\}"/);
});

test("v0.75 atomically persists private markers and journals every mutation group", () => {
  assert.match(common, /hardening_atomic_private_write\(\)/);
  assert.match(common, /mktemp "\$parent\/\.grabenplaner-private/);
  assert.match(common, /mv -f -- "\$temporary" "\$destination"[\s\S]*?\bsync\b/);
  const privateWrite = section("write_private_value", "read_private_value");
  assert.match(privateWrite, /hardening_atomic_private_write/);
  const stateWrite = section("write_transaction_state", "refresh_audit_status");
  assert.match(stateWrite, /hardening_atomic_private_write/);

  const apply = section("apply_command", "load_transaction_session_policy");
  const journal = apply.indexOf('write_apply_journal "$transaction_directory" ufw_in_progress');
  const firstUfw = apply.indexOf('apply_ufw_rules "$transaction_directory"');
  const intended = apply.indexOf('record_intended_current_state "$transaction_directory"', firstUfw);
  assert.ok(journal >= 0 && firstUfw > journal && intended > firstUfw,
    "Das WAL muss schon vor der ersten UFW-Mutation dauerhaft sein.");
  for (const phase of ["ssh_in_progress", "sysctl_in_progress", "journald_in_progress", "apt_in_progress"]) {
    assert.ok(controller.includes(`write_apply_journal "$transaction_directory" ${phase}`), `WAL-Phase fehlt: ${phase}`);
  }
  const preflight = section("preflight_rollback_transaction", "write_transaction_state");
  assert.match(preflight, /journal" == ufw_in_progress/);
  assert.match(preflight, /UFW_TRANSITION_BASELINE_FILE="\$transaction_directory\/ufw-added-before"/);
  assert.match(preflight, /validate_ufw_support_file_transition/);
});

test("v0.75 gates UFW, APT, sysctl and journald before confirmation", () => {
  const confirm = section("confirm_command", "rollback_command");
  const drift = confirm.indexOf('preflight_rollback_transaction "$transaction_directory" pending_confirmation');
  for (const validation of [
    "validate_effective_ufw_policy complete", "validate_effective_apt_configuration",
    "validate_effective_sysctl_configuration", "validate_effective_journald_configuration",
  ]) assert.ok(confirm.indexOf(validation) > drift, `${validation} muss nach der Driftpruefung liegen.`);
  const restore = section("restore_host_configuration", "finalize_rollback_success");
  const ufwRecheck = restore.indexOf('preflight_rollback_transaction "$transaction_directory" rollback_in_progress');
  const ufwRestore = restore.indexOf('restore_file "$transaction_directory" ufw-user');
  assert.ok(ufwRecheck >= 0 && ufwRestore > ufwRecheck);
  assert.match(controller, /apt-daily\.timer apt-daily-upgrade\.timer/);
  assert.match(controller, /root_readonly_configuration_file "\$UFW_DEFAULT"/);
  assert.match(controller, /ufwDefaults:/);
  assert.match(controller, /systemd-analyze cat-config systemd\/journald\.conf/);
  assert.match(controller, /sysctl -n "\$key"/);
});

test("v0.75 controller has valid Bash syntax on POSIX test hosts", { skip: process.platform === "win32" }, () => {
  const result = spawnSync("bash", ["-n", controllerPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("v0.75 pure Bash guards reject a second SSH port and unsafe predecessor records", (context) => {
  const probe = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    context.skip("Bash is not installed on this test host");
    return;
  }
  const script = [
    'source "$1"',
    'sshd_effective_has_exact_port $\'port 22\\nstrictmodes yes\' 22',
    '! sshd_effective_has_exact_port $\'port 22\\nport 2222\' 22',
    '! sshd_effective_has_exact_port $\'port 2222\' 22',
    `good=$'ssh\\tpresent\\t${"0".repeat(64)}\\t0\\t0\\t640'`,
    `bad_uid=$'ssh\\tpresent\\t${"0".repeat(64)}\\t1000\\t0\\t640'`,
    `bad_mode=$'ssh\\tpresent\\t${"0".repeat(64)}\\t0\\t0\\t662'`,
    'validate_manifest_record "$good" ssh',
    '! validate_manifest_record "$bad_uid" ssh',
    '! validate_manifest_record "$bad_mode" ssh',
  ].join("\n");
  const result = spawnSync("bash", ["-c", script, "test", controllerPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("v0.75 confirmation rejects a reused SSH connection fingerprint", (context) => {
  const probe = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    context.skip("Bash is not installed on this test host");
    return;
  }
  const firstConnection = "1".repeat(64);
  const independentConnection = "2".repeat(64);
  const script = [
    'source "$1"',
    `first_connection=${firstConnection}`,
    `independent_connection=${independentConnection}`,
    '! ssh_connection_is_independent "$first_connection" "$first_connection"',
    'ssh_connection_is_independent "$independent_connection" "$first_connection"',
    '! ssh_connection_is_independent invalid "$first_connection"',
  ].join("\n");
  const result = spawnSync("bash", ["-c", script, "test", controllerPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
