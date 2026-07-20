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
const commonPath = path.join(hardeningRoot, "lib", "hardening-common.sh");
const installer = fs.readFileSync(installerPath, "utf8");
const uninstaller = fs.readFileSync(uninstallerPath, "utf8");
const common = fs.readFileSync(commonPath, "utf8");
const systemdRoot = path.join(hardeningRoot, "systemd");
const auditService = fs.readFileSync(path.join(systemdRoot, "grabenplaner-host-security-audit.service.in"), "utf8");
const auditTimer = fs.readFileSync(path.join(systemdRoot, "grabenplaner-host-security-audit.timer.in"), "utf8");
const rollbackService = fs.readFileSync(path.join(systemdRoot, "grabenplaner-host-security-rollback.service.in"), "utf8");
const rollbackTimer = fs.readFileSync(path.join(systemdRoot, "grabenplaner-host-security-rollback.timer.in"), "utf8");

function executableLines(source) {
  return source.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function shellFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return shellFiles(target);
    return entry.isFile() && /\.sh(?:\.in)?$/.test(entry.name) ? [target] : [];
  });
}

function sameDeclarationDependencies(source) {
  const findings = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const declaration = line.match(/^\s*(?:local|readonly)\s+(.+)$/)?.[1];
    if (!declaration) return;

    for (const assignment of declaration.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)) {
      const name = assignment[1];
      const remainder = declaration.slice(assignment.index + assignment[0].length);
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const reference = new RegExp(`\\$(?:${escaped}(?![A-Za-z0-9_])|\\{${escaped}(?:[^A-Za-z0-9_]|$))`);
      if (reference.test(remainder)) findings.push({ line: index + 1, name, source: line.trim() });
    }
  });
  return findings;
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
  const uninstallLock = uninstaller.indexOf("hardening_acquire_controller_lock");
  const uninstallPending = uninstaller.indexOf('[[ ! -e "$HARDENING_PENDING_FILE"');
  assert.ok(installLock >= 0 && installLock < installPending);
  assert.ok(uninstallLock >= 0 && uninstallLock < uninstallPending);
  assert.match(installer, /hardening_acquire_controller_lock fail-fast 0/);
  assert.match(uninstaller, /hardening_acquire_controller_lock fail-fast 0/);
  assert.doesNotMatch(installer, /flock\s+--unlock|flock\s+-u/);
  assert.doesNotMatch(uninstaller, /flock\s+--unlock|flock\s+-u/);
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

test("v0.75 hardening shell declarations do not use variables initialized earlier in the same command", () => {
  const findings = shellFiles(hardeningRoot).flatMap((file) => sameDeclarationDependencies(fs.readFileSync(file, "utf8"))
    .map((finding) => `${path.relative(root, file)}:${finding.line}: ${finding.name} in ${finding.source}`));
  assert.deepEqual(findings, []);
});

test("v0.75 installer preflight runs under nounset before any installation mutation", (context) => {
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
    'systemctl() { return 0; }',
    extractShellFunction(installer, "preflight_existing_unit"),
    'preflight_existing_unit "fixture.service.in" "fixture.service" false',
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
