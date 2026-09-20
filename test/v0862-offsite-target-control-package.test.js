"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const schema = JSON.parse(read("server-tools/linux/offsite/module-schema.json"));
const selfTest = read("server-tools/linux/offsite/test-grabenplaner-offsite.sh");

const targetArtifacts = [
  "server-tools/linux/offsite/lib/offsite-target-broker.js",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-target-control.socket.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-target-control@.service.in",
];

test("offsite module v11 preserves the isolated v10 target-control artifacts", () => {
  assert.equal(schema.moduleVersion, 11);
  for (const relative of targetArtifacts) {
    assert.ok(schema.managedArtifacts.includes(relative), `${relative} fehlt im Modulvertrag`);
  }

  const contract = read("server-tools/linux/offsite/lib/offsite-contract.js");
  const compatibility = read("server-tools/linux/lib/offsite-update-compat.js");
  for (const relative of targetArtifacts.map((entry) => entry.slice("server-tools/linux/offsite/".length))) {
    assert.match(contract, new RegExp(relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(compatibility, new RegExp(relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(contract, /CURRENT_MODULE_VERSION = 11/);
  assert.match(compatibility, /SUPPORTED_MODULE_VERSIONS = new Set\(\[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11\]\)/);
});

test("target-control socket exposes only the existing isolated application group", () => {
  const socket = read("server-tools/linux/offsite/systemd/grabenplaner-offsite-target-control.socket.in");
  assert.match(socket, /^ListenStream=\/run\/grabenplaner-offsite-target-control\/request\.sock$/m);
  assert.match(socket, /^SocketUser=root$/m);
  assert.match(socket, /^SocketGroup=grabenplaner-assurance-control$/m);
  assert.match(socket, /^SocketMode=0660$/m);
  assert.match(socket, /^Accept=yes$/m);
  assert.match(socket, /^RemoveOnStop=yes$/m);
});

test("target-control broker service keeps the root and network boundary narrow", () => {
  const service = read("server-tools/linux/offsite/systemd/grabenplaner-offsite-target-control@.service.in");
  assert.match(service, /^User=root$/m);
  assert.match(service, /^Group=root$/m);
  assert.match(
    service,
    /^ExecStart=\/usr\/bin\/flock --exclusive --wait 3 \/run\/grabenplaner-offsite-target-control\/broker\.lock \/usr\/bin\/node \/opt\/grabenplaner-offsite\/module\/lib\/offsite-target-broker\.js$/m,
  );
  assert.match(service, /^StandardInput=socket$/m);
  assert.match(service, /^StandardOutput=socket$/m);
  assert.match(service, /^NoNewPrivileges=yes$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
  assert.doesNotMatch(service, /^IPAddressDeny=any$/m);
  assert.match(
    service,
    /^ReadWritePaths=\/run\/grabenplaner-offsite-target-control \/run\/grabenplaner \/run\/grabenplaner-offsite \/etc\/grabenplaner\/offsite \/var\/lib\/grabenplaner-offsite\/credentials \/var\/lib\/grabenplaner-offsite\/recovery-sets$/m,
  );
  assert.match(service, /^CapabilityBoundingSet=CAP_CHOWN CAP_SETGID CAP_SETUID$/m);
  assert.match(service, /^AmbientCapabilities=CAP_CHOWN CAP_SETGID CAP_SETUID$/m);
  assert.doesNotMatch(service, /CAP_(?:DAC_OVERRIDE|FOWNER|NET_ADMIN|SYS_ADMIN)/);
  assert.match(service, /^MemoryMax=256M$/m);
  assert.match(service, /^TimeoutStartSec=31min$/m);
  assert.match(service, /^RuntimeMaxSec=32min$/m);
});

test("target-control transport keeps the response open and the self-test proves a real list", () => {
  for (const relative of [
    "lib/offsite-target-client.js",
    "lib/recovery-assurance-control-client.js",
    "lib/host-reboot-control-client.js",
  ]) {
    assert.match(
      read(relative),
      /net\.createConnection\(\{ path: socketPath, allowHalfOpen: true \}\)/,
      `${relative} muss die Antwortseite des systemd-Sockets offen halten`,
    );
  }
  assert.match(selfTest, /offsiteTargetControlStatus\(\{ timeoutMs: 5000 \}\)/);
  assert.match(selfTest, /listManagedOffsiteFolders\(\{ timeoutMs: 60000 \}\)/);
  assert.match(selfTest, /Offsite-Ziel-Steuerungsprotokoll/);
});

test("installer and uninstaller manage the target-control socket transactionally", () => {
  const installer = read("server-tools/linux/offsite/install-grabenplaner-offsite.sh");
  const uninstaller = read("server-tools/linux/offsite/uninstall-grabenplaner-offsite.sh");

  assert.match(installer, /\[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11\]\.includes\(value\.moduleVersion\)/);
  assert.match(installer, /target_control_socket_was_enabled/);
  assert.match(installer, /target_control_socket_was_active/);
  assert.match(installer, /if \[\[ "\$validated_provider" == "google_drive" \]\]; then[\s\S]*?systemctl enable --now grabenplaner-offsite-target-control\.socket/);
  assert.match(installer, /systemctl disable --now grabenplaner-offsite-target-control\.socket/);
  assert.match(installer, /! systemctl is-enabled --quiet grabenplaner-offsite-target-control\.socket/);
  assert.match(installer, /! systemctl is-active --quiet grabenplaner-offsite-target-control\.socket/);
  assert.match(uninstaller, /'grabenplaner-offsite-target-control@\*\.service' grabenplaner-offsite-target-control\.socket/);
});
