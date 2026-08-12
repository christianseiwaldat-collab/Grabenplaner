"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const hardeningRoot = path.join(root, "server-tools", "linux", "hardening");
const installerPath = path.join(hardeningRoot, "install-grabenplaner-host-hardening.sh");
const uninstallerPath = path.join(hardeningRoot, "uninstall-grabenplaner-host-hardening.sh");
const controllerPath = path.join(hardeningRoot, "grabenplaner-host-security.sh");
const commonPath = path.join(hardeningRoot, "lib", "hardening-common.sh");
const installer = fs.readFileSync(installerPath, "utf8");
const uninstaller = fs.readFileSync(uninstallerPath, "utf8");
const controller = fs.readFileSync(controllerPath, "utf8");
const common = fs.readFileSync(commonPath, "utf8");
const systemdRoot = path.join(hardeningRoot, "systemd");
const auditService = fs.readFileSync(path.join(systemdRoot, "grabenplaner-host-security-audit.service.in"), "utf8");
const auditTimer = fs.readFileSync(path.join(systemdRoot, "grabenplaner-host-security-audit.timer.in"), "utf8");
const rollbackService = fs.readFileSync(path.join(systemdRoot, "grabenplaner-host-security-rollback.service.in"), "utf8");
const rollbackTimer = fs.readFileSync(path.join(systemdRoot, "grabenplaner-host-security-rollback.timer.in"), "utf8");
const serverDocumentation = fs.readFileSync(path.join(root, "SERVERBETRIEB.md"), "utf8");

function executableLines(source) {
  return source.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function extractShellFunction(source, name) {
  const start = source.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `missing shell function ${name}`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `unterminated shell function ${name}`);
  return source.slice(start, end + 2);
}

test("v0.75 hardening installer validates then copies only contract artifacts", () => {
  const contractIndex = installer.indexOf('contract "$SOURCE_MODULE_ROOT"');
  const firstMutationIndex = installer.indexOf("hardening_secure_roots");
  assert.notEqual(contractIndex, -1);
  assert.notEqual(firstMutationIndex, -1);
  assert.ok(contractIndex < firstMutationIndex, "source contract must be checked before installation roots are changed");

  assert.match(installer, /for \(const item of value\.files\) process\.stdout\.write/);
  assert.match(installer, /copy_manifested_module "\$node" "\$SOURCE_CONTRACT_FILE"/);
  assert.match(installer, /Das kopierte Hardening-Modul weicht vom Quellvertrag ab/);
  assert.match(installer, /hardening_atomic_install "\$SOURCE_CONTRACT_FILE" "\$HARDENING_INSTALLED_CONTRACT" 0600/);
  assert.match(installer, /\*\.sh\) mode=0755/);
  assert.match(installer, /\*\) mode=0644/);
  assert.match(installer, /JSON\.stringify\(installed\) !== JSON\.stringify\(source\)/);
  assert.match(installer, /preflight_policy_only_contract_delta/);
  assert.match(installer, /previous\.moduleVersion !== 1 \|\| next\.moduleVersion !== 2/);
});

test("hardening v2 documents the non-mutating active-policy upgrade and Tailscale confirmation", () => {
  const install = serverDocumentation.indexOf("install-grabenplaner-host-hardening.sh --upgrade-active-policy");
  const audit = serverDocumentation.indexOf("grabenplaner-host-security audit", install);
  const plan = serverDocumentation.indexOf("maintenance-plan", audit);
  const adopt = serverDocumentation.indexOf("maintenance-adopt", plan);
  const confirm = serverDocumentation.indexOf("maintenance-confirm", adopt);
  assert.ok(install >= 0 && audit > install && plan > audit && adopt > plan && confirm > adopt);
  assert.match(serverDocumentation, /App-Update ersetzt ein bereits .* installiertes Sicherheitsmodul absichtlich nicht/);
  assert.match(serverDocumentation, /ohne SSH-, UFW-, APT-, Kernel- oder Journalregeln zu veraendern/);
  assert.match(serverDocumentation, /Transaktionsdateien duerfen nicht manuell geloescht/);
});

test("v0.75 installer and uninstaller hold the shared controller lock across state checks", () => {
  assert.match(common, /HARDENING_CONTROLLER_LOCK="\/run\/grabenplaner-host-security\/controller\.lock"/);
  assert.match(common, /hardening_acquire_controller_lock\(\)/);
  assert.equal((common.match(/readonly HARDENING_CONTROLLER_LOCK=/g) || []).length, 1);
  assert.equal((common.match(/hardening_acquire_controller_lock\(\)/g) || []).length, 1);
  assert.match(common, /mode="\$\{1:-fail-fast\}"/);
  assert.match(common, /flock --wait "\$timeout_seconds" "\$controller_fd"/);
  assert.match(common, /flock --nonblock "\$controller_fd"/);
  assert.match(common, /stat -c '%u:%g:%a:%h'/);
  assert.match(common, /set -o noclobber; : >"\$HARDENING_CONTROLLER_LOCK"/);
  assert.doesNotMatch(common, /chmod 0600 -- "\$HARDENING_CONTROLLER_LOCK"/);
  const installLock = installer.indexOf("hardening_acquire_controller_lock");
  const installPending = installer.indexOf('[[ ! -e "$HARDENING_PENDING_FILE"');
  const installActive = installer.indexOf('[[ ! -e "$ACTIVE_TRANSACTION_FILE"');
  const installPreflight = installer.indexOf("preflight_existing_installation", installLock);
  const installRoots = installer.indexOf("hardening_secure_roots", installLock);
  const uninstallLock = uninstaller.indexOf("hardening_acquire_controller_lock");
  const uninstallPending = uninstaller.indexOf('[[ ! -e "$HARDENING_PENDING_FILE"');
  assert.ok(installLock >= 0 && installLock < installPending && installPending < installActive);
  assert.ok(installActive < installPreflight && installActive < installRoots);
  assert.ok(uninstallLock >= 0 && uninstallLock < uninstallPending);
  assert.match(installer, /hardening_acquire_controller_lock fail-fast 0/);
  assert.match(uninstaller, /hardening_acquire_controller_lock fail-fast 0/);
  assert.doesNotMatch(installer, /flock\s+--unlock|flock\s+-u/);
  assert.doesNotMatch(uninstaller, /flock\s+--unlock|flock\s+-u/);
});

test("hardening v2 installer permits only an explicit policy-only upgrade for a confirmed active transaction", () => {
  const lock = installer.indexOf("hardening_acquire_controller_lock");
  const pending = installer.indexOf('[[ ! -e "$HARDENING_PENDING_FILE"', lock);
  const active = installer.indexOf('[[ ! -e "$ACTIVE_TRANSACTION_FILE"', lock);
  const preflight = installer.indexOf("preflight_existing_installation", lock);
  const mutation = installer.indexOf("hardening_secure_roots", lock);
  assert.match(installer, /readonly ACTIVE_TRANSACTION_FILE="\$HARDENING_STATE_ROOT\/active-transaction"/);
  assert.ok(lock >= 0 && pending > lock && active > pending);
  assert.ok(active < preflight && preflight < mutation);
  assert.match(installer, /Aktives Host-Hardening erfordert fuer ein reines Modulupgrade --upgrade-active-policy/);
  assert.match(installer, /preflight_active_policy_upgrade/);
  assert.match(installer, /state !== "confirmed"/);
  assert.match(installer, /allowedChanges = new Set/);
  assert.match(installer, /systemctl disable --now "\$HARDENING_AUDIT_TIMER"/);
  const suspend = installer.indexOf("UPGRADE_TIMER_SUSPENDED=1", installer.indexOf('systemctl disable --now "$HARDENING_AUDIT_TIMER"'));
  const serviceStop = installer.indexOf('systemctl stop "$HARDENING_AUDIT_SERVICE"', suspend);
  assert.ok(suspend >= 0 && suspend < serviceStop, "rollback protection must be armed before the audit service is stopped");
  const swapGuard = installer.indexOf("UPGRADE_SWAP_STARTED=1", serviceStop);
  const oldModuleMove = installer.indexOf('mv -- "$HARDENING_MODULE_ROOT" "$OLD_MODULE_ROOT"', swapGuard);
  assert.ok(swapGuard >= 0 && swapGuard < oldModuleMove, "rollback protection must be armed before the installed module is moved");
  assert.doesNotMatch(installer, /systemctl (?:reload|restart|stop) (?:ssh|sshd|ufw)/);
});

test("v0.75 preserves the delegated read-only status directory", () => {
  const secureRoots = common.slice(common.indexOf("hardening_secure_roots()"), common.indexOf("hardening_transaction_directory()"));
  assert.match(secureRoots, /getent group grabenplaner-monitor-status/);
  assert.match(secureRoots, /0:\$\{status_gid\}:710/);
  assert.match(secureRoots, /0:0:700/);
  assert.doesNotMatch(secureRoots, /chown .*HARDENING_STATE_ROOT/);
  assert.doesNotMatch(secureRoots, /chmod .*HARDENING_STATE_ROOT/);
});

test("v0.75 installer rejects foreign or drifted units before installation mutation", () => {
  const preflight = installer.indexOf("preflight_existing_installation");
  const roots = installer.indexOf("hardening_secure_roots");
  assert.ok(preflight >= 0 && preflight < roots);
  assert.match(installer, /FragmentPath/);
  assert.match(installer, /cmp -s -- "\$HARDENING_MODULE_ROOT\/systemd\/\$source_name" "\$installed"/);
  assert.match(installer, /Eine gleichnamige fremde Systemd-Einheit verhindert die Installation/);
});

test("v0.75 six nounset path initializations remain separate from their local declarations", () => {
  assert.match(extractShellFunction(installer, "preflight_existing_unit"),
    /local source_name="\$1" unit_name="\$2" installed fragment=""\n\s+local predecessor_expected="\$3"\n\s+installed="\$SYSTEMD_ROOT\/\$unit_name"/);
  assert.match(extractShellFunction(uninstaller, "assert_matching_unit"),
    /local source_name="\$1" unit_name="\$2" installed fragment=""\n\s+installed="\$SYSTEMD_ROOT\/\$unit_name"/);
  assert.match(extractShellFunction(controller, "record_post_apply_state"),
    /local transaction_directory="\$1" manifest temporary key target hash uid gid mode\n\s+manifest="\$transaction_directory\/post-apply\.tsv"/);
  assert.match(extractShellFunction(controller, "intended_record_for_key"),
    /local transaction_directory="\$1" key="\$2" file record\n\s+file="\$transaction_directory\/intended\/\$key\.tsv"/);
  assert.match(extractShellFunction(controller, "restore_permit_record_for_key"),
    /local transaction_directory="\$1" key="\$2" file record\n\s+file="\$transaction_directory\/restore-permits\/\$key\.tsv"/);
  assert.match(extractShellFunction(controller, "backup_file"),
    /local transaction_directory="\$1" key="\$2" target="\$3" backup metadata uid gid mode\n\s+backup="\$transaction_directory\/backups\/\$key"/);
});

test("v0.75 corrected installer, uninstaller and controller paths run under nounset", (context) => {
  const probe = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    context.skip("Bash is not installed on this test host");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);

  const fixture = [
    "set -Eeuo pipefail",
    'temporary="$(mktemp -d)"',
    "trap 'rm -rf -- \"$temporary\"' EXIT",
    'SYSTEMD_ROOT="$temporary/systemd"',
    'HARDENING_MODULE_ROOT="$temporary/module"',
    'mkdir -p -- "$SYSTEMD_ROOT" "$HARDENING_MODULE_ROOT/systemd"',
    'hardening_die() { printf \'%s\\n\' "$1" >&2; return 97; }',
    'fragment_path=""',
    'systemctl() { printf \'%s\' "$fragment_path"; }',
    extractShellFunction(installer, "preflight_existing_unit"),
    'preflight_existing_unit "fixture.service.in" "fixture.service" false',
    'printf \'fixture\\n\' >"$HARDENING_MODULE_ROOT/systemd/fixture.service.in"',
    'cp -- "$HARDENING_MODULE_ROOT/systemd/fixture.service.in" "$SYSTEMD_ROOT/fixture.service"',
    'fragment_path="$SYSTEMD_ROOT/fixture.service"',
    'stat() { printf \'0:0:644:1\\n\'; }',
    extractShellFunction(uninstaller, "assert_matching_unit"),
    'assert_matching_unit "fixture.service.in" "fixture.service"',
    extractShellFunction(controller, "record_post_apply_state"),
    'if record_post_apply_state "$temporary/missing"; then exit 81; fi',
    'private_file_is_secure() { return 1; }',
    extractShellFunction(controller, "intended_record_for_key"),
    'if intended_record_for_key "$temporary/transaction" fixture; then exit 82; fi',
    extractShellFunction(controller, "restore_permit_record_for_key"),
    'if restore_permit_record_for_key "$temporary/transaction" fixture; then exit 83; fi',
    'mkdir -p -- "$temporary/transaction/backups"',
    ': >"$temporary/transaction/hashes.tsv"',
    'chmod() { return 0; }',
    'chown() { return 0; }',
    extractShellFunction(controller, "backup_file"),
    'backup_file "$temporary/transaction" fixture "$temporary/not-present"',
  ].join("\n");
  const result = spawnSync("bash", ["-s"], { input: fixture, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("v0.75 hardening installer deploys four units but enables only the audit timer", () => {
  for (const unit of [
    "grabenplaner-host-security-audit.service.in",
    "grabenplaner-host-security-audit.timer.in",
    "grabenplaner-host-security-rollback.service.in",
    "grabenplaner-host-security-rollback.timer.in",
  ]) assert.ok(installer.includes(unit), `missing systemd artifact ${unit}`);

  assert.match(installer, /systemctl enable --now "\$HARDENING_AUDIT_TIMER"/);
  assert.match(installer, /systemctl start "\$HARDENING_AUDIT_SERVICE"/);
  assert.match(installer, /verify_initial_status/);
  assert.match(installer, /grabenplaner-host-security-status/);
  assert.match(installer, /root:\$\{status_group\}:640:1/);
  assert.doesNotMatch(installer, /systemctl enable --now "\$HARDENING_ROLLBACK_TIMER"/);
  assert.doesNotMatch(installer, /systemctl start "\$HARDENING_ROLLBACK/);
  assert.match(installer, /install_command_link "\$HARDENING_MODULE_ROOT\/grabenplaner-host-security\.sh"/);
  assert.match(installer, /install_command_link "\$HARDENING_MODULE_ROOT\/test-grabenplaner-host-hardening\.sh"/);
  assert.match(installer, /install_command_link "\$HARDENING_MODULE_ROOT\/uninstall-grabenplaner-host-hardening\.sh"/);
});

test("v0.75 timers are persistent calendar timers and services have safe execution budgets", () => {
  assert.match(auditTimer, /OnBootSec=10min/);
  assert.match(auditTimer, /OnCalendar=daily/);
  assert.match(auditTimer, /Persistent=true/);
  assert.doesNotMatch(auditTimer, /OnUnitActiveSec=/);
  assert.match(rollbackTimer, /OnCalendar=\*-\*-\* \*:\*:00/);
  assert.match(rollbackTimer, /AccuracySec=1s/);
  assert.match(rollbackTimer, /Persistent=true/);
  assert.doesNotMatch(rollbackTimer, /OnActiveSec=/);
  assert.match(auditService, /CapabilityBoundingSet=CAP_CHOWN CAP_NET_ADMIN/);
  assert.match(auditService, /TimeoutStartSec=5min/);
  assert.match(rollbackService, /TimeoutStartSec=10min/);
});

test("v0.75 failed fresh installation stops a running initial audit", () => {
  const cleanup = installer.slice(installer.indexOf("cleanup()"), installer.indexOf("trap cleanup EXIT"));
  assert.match(cleanup, /systemctl stop "\$HARDENING_AUDIT_SERVICE"/);
  assert.ok(cleanup.indexOf('systemctl stop "$HARDENING_AUDIT_SERVICE"') < cleanup.indexOf('rm -f -- "$SYSTEMD_ROOT/$unit_name"'));
});

test("v0.75 hardening installer does not mutate policies or download packages", () => {
  const lines = executableLines(installer).join("\n");
  assert.doesNotMatch(lines, /(^|\n)(ufw|iptables|nft|sshd|ssh-keygen|sysctl|apt|apt-get|dpkg|curl|wget)(?:\s|$)/);
  assert.doesNotMatch(lines, /systemctl\s+(?:restart|reload|stop)\s+(?:ssh|sshd|ufw|systemd-journald)/);
  assert.doesNotMatch(lines, />\s*\/etc\/(?:ssh|ufw|apt|sysctl|systemd\/journald)/);
});

test("v0.75 hardening uninstall refuses active or pending work and preflights every artifact", () => {
  const pendingIndex = uninstaller.indexOf('[[ ! -e "$HARDENING_PENDING_FILE"');
  const activeIndex = uninstaller.indexOf('[[ ! -e "$ACTIVE_TRANSACTION_FILE"');
  const contractIndex = uninstaller.indexOf("hardening_assert_installed_contract");
  const unitPreflightIndex = uninstaller.indexOf("assert_matching_unit \\");
  const linkPreflightIndex = uninstaller.indexOf("assert_matching_link \"$HARDENING_MODULE_ROOT/grabenplaner-host-security.sh\"");
  const stopIndex = uninstaller.indexOf('systemctl disable --now "$HARDENING_AUDIT_TIMER"');
  const removalIndex = uninstaller.indexOf('rm -rf -- "$HARDENING_MODULE_ROOT"');
  assert.ok(pendingIndex >= 0 && activeIndex > pendingIndex && activeIndex < contractIndex);
  assert.ok(contractIndex < unitPreflightIndex && unitPreflightIndex < linkPreflightIndex && linkPreflightIndex < stopIndex);
  assert.ok(stopIndex < removalIndex);
  assert.match(uninstaller, /zuerst explizit mit dem Controller zurueckgerollt/);
  assert.match(uninstaller, /Eine bestaetigte Hardening-Transaktion war nicht mehr aktiv/);
  assert.match(uninstaller, /Manuell verwaltete Host-Richtlinien wurden/);
  assert.match(uninstaller, /cmp -s --/);
  assert.match(uninstaller, /Drift fuehrt zu einem Vollabbruch/);
  assert.match(uninstaller, /FragmentPath/);
  assert.doesNotMatch(executableLines(uninstaller).join("\n"), /(^|\n)(ufw|iptables|nft|sshd|sysctl|apt|apt-get|dpkg)(?:\s|$)/);
  assert.doesNotMatch(uninstaller, /rm -rf -- "\$HARDENING_(?:STATE|TRANSACTION)_ROOT"/);
});

test("v0.75 hardening operational scripts have valid Bash syntax when Bash is available", (context) => {
  const probe = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    context.skip("Bash is not installed on this test host");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
  for (const script of [installerPath, uninstallerPath]) {
    const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(result.status, 0, `${path.basename(script)}: ${result.stderr}`);
  }
});
