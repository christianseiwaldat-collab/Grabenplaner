"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const hostRuntimeArtifacts = [
  "server-tools/linux/host-control/lib/host-reboot-broker.js",
  "server-tools/linux/host-control/systemd/grabenplaner-host-control.socket.in",
  "server-tools/linux/host-control/systemd/grabenplaner-host-control@.service.in",
  "server-tools/linux/host-control/systemd/grabenplaner-host-reboot.service.in",
];

test("runtime schema 3 binds the exact root-managed host-control artifacts", () => {
  const schema = JSON.parse(read("server-tools", "linux", "runtime-schema.json"));
  assert.equal(schema.deploymentSchemaVersion, 3);
  assert.equal(schema.migrationPolicy, "explicit-maintenance");
  assert.equal(schema.managedArtifacts.length, 11);
  for (const relative of hostRuntimeArtifacts) assert.ok(schema.managedArtifacts.includes(relative), relative);

  const verification = spawnSync(process.execPath, [
    path.join(root, "server-tools/linux/lib/verify-package.js"),
    "--runtime-contract",
    root,
  ], { encoding: "utf8" });
  assert.equal(verification.status, 0, verification.stderr);
  const contract = JSON.parse(verification.stdout);
  assert.equal(contract.deploymentSchemaVersion, 3);
  assert.deepEqual(
    contract.managedArtifacts.filter((relative) => relative.includes("/host-control/")),
    [...hostRuntimeArtifacts].sort(),
  );
  assert.match(contract.fingerprint, /^[a-f0-9]{64}$/);
});

test("package builder and both verifiers require runtime-v3 control files", () => {
  const builder = read("server-tools", "package", "New-GrabenplanerLinuxServerPackage.ps1");
  const verifier = read("server-tools", "linux", "lib", "verify-package.js");
  const installer = read("server-tools", "linux", "install-grabenplaner-server.sh");
  for (const relative of [
    ...hostRuntimeArtifacts,
    "server-tools/linux/migrate-grabenplaner-runtime-v3.sh",
    "lib/controlled-host-reboot.js",
    "lib/host-reboot-control-client.js",
    "lib/offsite-provider-policy.js",
  ]) {
    const basename = path.posix.basename(relative).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(builder, new RegExp(basename), `Builder fordert ${relative} nicht an.`);
    assert.match(verifier, new RegExp(basename), `Verifier fordert ${relative} nicht an.`);
    assert.match(installer, new RegExp(basename), `Installer fordert ${relative} nicht an.`);
  }
  assert.match(installer, /deploymentSchemaVersion !== 3/);
  assert.match(installer, /Der Linux-Runtimevertrag v3 ist ungueltig/);
});

test("fresh install isolates host control behind one service-user-only socket group", () => {
  const installer = read("server-tools", "linux", "install-grabenplaner-server.sh");
  assert.match(installer, /readonly HOST_CONTROL_GROUP="grabenplaner-host-control"/);
  assert.match(installer, /"\$host_control_members" == "\$SERVICE_USER"/);
  assert.match(installer, /Nur der Grabenplaner-Dienstbenutzer darf Mitglied der Host-Control-Gruppe sein/);
  assert.match(installer, /HOST_CONTROL_ROOT="\/opt\/grabenplaner-host-control"/);
  assert.match(installer, /HOST_CONTROL_MODULE="\$\{HOST_CONTROL_ROOT\}\/module"/);
  assert.match(installer, /chown -R root:root -- "\$host_control_stage"/);
  assert.match(installer, /find "\$host_control_stage" -type f -exec chmod 0644/);
  assert.match(installer, /systemd-analyze verify[\s\S]*grabenplaner-host-control\.socket/);
  assert.match(installer, /systemctl enable --now grabenplaner-host-control\.socket/);
  assert.doesNotMatch(installer, /systemctl (?:enable|start|restart).*grabenplaner-host-reboot\.service/);
});

test("runtime-v3 migration is package-bound, rollback-capable, and never requests reboot", () => {
  const migration = read("server-tools", "linux", "migrate-grabenplaner-runtime-v3.sh");
  for (const required of [
    "actual_package_sha256=",
    "verify-package.js",
    "cmp --silent -- \"$SCRIPT_PATH\"",
    "old.deploymentSchemaVersion!==2",
    "next?.deploymentSchemaVersion!==3",
    "Schema 2 -> 3",
    "gp_acquire_maintenance_lock",
    "rollback_runtime()",
    "groupadd --system \"$HOST_CONTROL_GROUP\"",
    "usermod --append --groups \"$HOST_CONTROL_GROUP\"",
    "systemd-analyze verify",
    "systemctl enable --now \"$HOST_CONTROL_SOCKET_NAME\"",
    "--lock-already-held",
    "rebootTriggered:false",
  ]) assert.ok(migration.includes(required), `Migrationsvertrag fehlt: ${required}`);
  assert.ok(migration.indexOf("actual_package_sha256=") < migration.indexOf("gp_acquire_maintenance_lock"));
  assert.ok(migration.indexOf("systemd-analyze verify") < migration.indexOf("systemctl enable --now"));
  assert.doesNotMatch(migration, /systemctl (?:start|restart|enable).*"\$HOST_REBOOT_NAME"/);
  assert.doesNotMatch(migration, /\breboot\s+--|\bshutdown\s+-r/);
});

test("configured offsite source deltas require a completed provider-stable migration first", () => {
  const migration = read("server-tools", "linux", "migrate-grabenplaner-runtime-v3.sh");
  assert.match(migration, /const offsiteChanged=/);
  assert.match(migration, /offsite_source_changed="\$\{transition\[3\]:-\}"/);
  assert.match(migration, /if \[\[ "\$offsite_source_changed" == "1" \]\]/);
  assert.match(migration, /GRABENPLANER_OFFSITE_CONFIGURED:-0/);
  assert.match(migration, /Offsite-Migration zuerst/);
  assert.match(migration, /candidate_offsite_module_version/);
  assert.match(migration, /candidate_offsite_fingerprint/);
  assert.match(migration, /verify-installed-bound/);
  assert.match(migration, /installed\?\.moduleVersion!==candidate\.moduleVersion/);
  assert.match(migration, /installed\?\.fingerprint!==candidate\.fingerprint/);
  assert.match(migration, /installed\?\.schemaSha256!==candidate\.schemaSha256/);
  assert.match(migration, /canonical\(installed\.files\)!==canonical\(candidate\.files\)/);
  assert.match(migration, /stat --format='%u:%g:%a:%h' -- "\$LIVE_OFFSITE_INSTALLED_CONTRACT"/);
  assert.match(migration, /offsite_assert_bound_rclone_provider "\$credentials"/);
  assert.match(migration, /offsite_verify_repository_identity "\$credentials" "\$repository_probe"/);
  assert.match(migration, /verified_provider" == "\$GRABENPLANER_OFFSITE_PROVIDER"/);
  assert.match(migration, /Ein Providerwechsel ist in der Runtime-Migration nicht erlaubt/);
  assert.match(migration, /nicht aktiviert ist/);
  assert.ok(
    migration.indexOf("verify_configured_offsite_candidate_transition") < migration.indexOf("runtime-swap-intent"),
    "Die Offsite-Uebergangspruefung muss vor jeder Runtime-Aenderung liegen.",
  );
  assert.doesNotMatch(
    migration,
    /(?:install-grabenplaner-offsite|grabenplaner-offsite-rebind-rclone|grabenplaner-offsite-switch-target)\.sh/,
  );
});

test("runtime-v3 migration consumes the verified top-level module contracts", () => {
  const migration = read("server-tools", "linux", "migrate-grabenplaner-runtime-v3.sh");
  const transitionProgram = migration.match(
    /readarray -t transition < <\("\$node" - "\$installed_runtime" "\$manifest_result" "\$app_dir\/package\.json" <<'NODE'\r?\n([\s\S]*?)\r?\nNODE\r?\n\) \|\| gp_die/,
  )?.[1];
  assert.ok(transitionProgram, "Der ausführbare Runtime-Übergangsprüfer fehlt.");

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-runtime-v3-contract-"));
  try {
    const oldFile = path.join(temporary, "old-runtime.json");
    const verifierFile = path.join(temporary, "verifier-result.json");
    const packageFile = path.join(temporary, "package.json");
    const baseArtifacts = [
      "server-tools/linux/Caddyfile.in",
      "server-tools/linux/grabenplaner-bootstrap-admin.sh.in",
      "server-tools/linux/grabenplaner-bootstrap.service.in",
      "server-tools/linux/grabenplaner.env.example",
      "server-tools/linux/grabenplaner.service.in",
    ];
    const schema2Artifacts = [
      ...baseArtifacts,
      "server-tools/linux/grabenplaner-monitor.service.in",
      "server-tools/linux/grabenplaner-monitor.timer.in",
    ].sort();
    const schema3Artifacts = [...schema2Artifacts, ...hostRuntimeArtifacts].sort();
    fs.writeFileSync(oldFile, JSON.stringify({
      deploymentSchemaVersion: 2,
      migrationPolicy: "explicit-maintenance",
      managedArtifacts: schema2Artifacts,
      offsiteModule: { moduleVersion: 6, fingerprint: "a".repeat(64) },
      hardeningModule: { moduleVersion: 1, fingerprint: "b".repeat(64) },
    }));
    fs.writeFileSync(verifierFile, JSON.stringify({
      appVersion: "0.88.2-beta",
      runtimeContract: {
        deploymentSchemaVersion: 3,
        migrationPolicy: "explicit-maintenance",
        fingerprint: "c".repeat(64),
        managedArtifacts: schema3Artifacts,
      },
      offsiteModule: { moduleVersion: 6, fingerprint: "d".repeat(64) },
      hardeningModule: { moduleVersion: 1, fingerprint: "b".repeat(64) },
    }));
    fs.writeFileSync(packageFile, JSON.stringify({ version: "0.87.0-beta" }));

    const result = spawnSync(process.execPath, ["-", oldFile, verifierFile, packageFile], {
      encoding: "utf8",
      input: transitionProgram,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
      "0.87.0-beta",
      "0.88.2-beta",
      "c".repeat(64),
      "1",
      "6",
      "d".repeat(64),
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("runtime-v3 invokes the nested updater only from the root-protected installed tree", () => {
  const migration = read("server-tools", "linux", "migrate-grabenplaner-runtime-v3.sh");
  assert.match(
    migration,
    /bash "\$app_dir\/server-tools\/linux\/update-grabenplaner-server\.sh"/,
    "Der verschachtelte Updater muss aus dem bereits root-geschützten Runtime-Baum starten.",
  );
  assert.doesNotMatch(
    migration,
    /bash "\$extract_root\/server-tools\/linux\/update-grabenplaner-server\.sh"/,
  );
  const permissionsIndex = migration.indexOf('gp_apply_app_permissions "$work_root/linux-schema3"');
  const installIndex = migration.indexOf('mv -T -- "$work_root/linux-schema3" "$app_dir/server-tools/linux"');
  const updaterIndex = migration.indexOf('bash "$app_dir/server-tools/linux/update-grabenplaner-server.sh"');
  assert.ok(
    permissionsIndex >= 0 && installIndex > permissionsIndex && updaterIndex > installIndex,
    "Der Kandidat muss vor dem Updater-Aufruf root-geschützt in den App-Baum eingebunden sein.",
  );
});

test("nested runtime-v3 updater uses the installed root-protected offsite helper", {
  skip: process.platform === "win32",
}, () => {
  const updater = read("server-tools", "linux", "update-grabenplaner-server.sh");
  const gateBlock = updater.match(
    /(if \[\[ "\$\{GRABENPLANER_OFFSITE_CONFIGURED:-0\}" == "1" \]\]; then[\s\S]*?\r?\nfi)\r?\ncandidate_version=/,
  )?.[1];
  assert.ok(gateBlock, "Der ausführbare Offsite-Kompatibilitätsblock fehlt.");
  const harnessGateBlock = gateBlock.replace(
    'installed_offsite_receipt="/etc/grabenplaner/offsite/installed-contract.json"',
    'installed_offsite_receipt="$TEST_INSTALLED_OFFSITE_RECEIPT"',
  );
  assert.notEqual(harnessGateBlock, gateBlock, "Der Testbelegpfad konnte nicht isoliert werden.");

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-nested-updater-"));
  try {
    const candidateScriptDir = path.join(temporary, "candidate", "server-tools", "linux");
    const installedAppDir = path.join(temporary, "installed");
    const installedHelper = path.join(
      installedAppDir,
      "server-tools",
      "linux",
      "lib",
      "offsite-update-compat.js",
    );
    const installedScriptDir = path.join(installedAppDir, "server-tools", "linux");
    const candidateHelper = path.join(candidateScriptDir, "lib", "offsite-update-compat.js");
    const manifest = path.join(temporary, "manifest.json");
    const receipt = path.join(temporary, "installed-contract.json");
    const harness = path.join(temporary, "nested-updater-gate.sh");

    fs.mkdirSync(path.dirname(installedHelper), { recursive: true });
    fs.mkdirSync(path.dirname(candidateHelper), { recursive: true });
    fs.writeFileSync(
      installedHelper,
      "'use strict'; process.stdout.write('compatible\\n');\n",
    );
    fs.writeFileSync(
      candidateHelper,
      "'use strict'; process.stderr.write('build-user helper must not run\\n'); process.exit(43);\n",
    );
    fs.writeFileSync(manifest, "{}\n");
    fs.writeFileSync(receipt, "{}\n");
    fs.writeFileSync(harness, `#!/usr/bin/env bash
set -Eeuo pipefail
readonly SCRIPT_DIR="$1"
readonly app_dir="$2"
readonly node="$3"
readonly manifest_result_file="$4"
readonly TEST_INSTALLED_OFFSITE_RECEIPT="$5"
readonly service_group="grabenplaner"
readonly GRABENPLANER_OFFSITE_CONFIGURED=1
gp_die() { printf '%s\\n' "$1" >&2; exit 97; }
getent() {
  [[ "\${1:-}" == "group" && "\${2:-}" == "$service_group" ]] || return 1
  printf '%s\\n' "$service_group:x:4242:"
}
stat() {
  local format="" target="\${!#}"
  local argument
  for argument in "$@"; do
    case "$argument" in --format=*) format="\${argument#--format=}" ;; esac
  done
  case "$target" in
    "$TEST_INSTALLED_OFFSITE_RECEIPT")
      case "$format" in
        "%u:%g:%a:%h") printf '%s\\n' "0:0:600:1" ;;
        *) return 2 ;;
      esac
      ;;
    "$app_dir/server-tools/linux/lib/offsite-update-compat.js")
      case "$format" in
        "%u:%g:%h") printf '%s\\n' "0:4242:1" ;;
        "%a") printf '%s\\n' "640" ;;
        *) return 2 ;;
      esac
      ;;
    "$SCRIPT_DIR/lib/offsite-update-compat.js")
      case "$format" in
        "%u:%g:%h") printf '%s\\n' "1000:4242:1" ;;
        "%a") printf '%s\\n' "640" ;;
        *) return 2 ;;
      esac
      ;;
    *) command stat "$@" ;;
  esac
}
${harnessGateBlock}
printf '%s\\n' "nested-helper-ok"
`);

    const result = spawnSync("bash", [
      harness,
      installedScriptDir,
      installedAppDir,
      process.execPath,
      manifest,
      receipt,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "nested-helper-ok");
    assert.doesNotMatch(result.stderr, /build-user helper must not run/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("schema-3 updater rejects a damaged installed host-control contract", () => {
  const updater = read("server-tools", "linux", "update-grabenplaner-server.sh");
  assert.match(updater, /installed_runtime_schema[\s\S]*deploymentSchemaVersion/);
  assert.match(updater, /Only|Nur der Grabenplaner-Dienstbenutzer darf Mitglied der Host-Control-Gruppe sein/);
  assert.match(updater, /\/opt\/grabenplaner-host-control\/module/);
  assert.match(updater, /cmp --silent -- "\$installed_host_broker" "\$app_host_broker"/);
  assert.match(updater, /systemctl is-enabled --quiet grabenplaner-host-control\.socket/);
  assert.match(updater, /systemctl is-active --quiet grabenplaner-host-control\.socket/);
  assert.match(updater, /Ein Host-Neustart ist bereits aktiv/);
  assert.match(updater, /\.runtime-v\(2\|3\)-migration/);
});

test("runtime-v3 uninstaller removes broker, units, and narrow group but preserves data", () => {
  const uninstall = read("server-tools", "linux", "uninstall-grabenplaner-server.sh");
  assert.match(uninstall, /grabenplaner-host-control\.socket/);
  assert.match(uninstall, /grabenplaner-host-control@\.service/);
  assert.match(uninstall, /grabenplaner-host-reboot\.service/);
  assert.match(uninstall, /\/opt\/grabenplaner-host-control/);
  assert.match(uninstall, /gpasswd --delete "\$GP_DEFAULT_SERVICE_USER" "\$host_control_group"/);
  assert.match(uninstall, /groupdel "\$host_control_group"/);
  assert.doesNotMatch(uninstall, /rm -rf[^\n]*\/var\/lib\/grabenplaner(?:\s|["'])/);
});

test("runtime-v3 migration shell parses on POSIX test hosts", { skip: process.platform === "win32" }, () => {
  const result = spawnSync("bash", [
    "-n",
    path.join(root, "server-tools/linux/migrate-grabenplaner-runtime-v3.sh"),
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
