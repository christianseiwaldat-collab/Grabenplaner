"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const schema = JSON.parse(read("server-tools/linux/offsite/module-schema.json"));
const installer = read("server-tools/linux/offsite/install-grabenplaner-offsite.sh");
const uninstaller = read("server-tools/linux/offsite/uninstall-grabenplaner-offsite.sh");
const selfTest = read("server-tools/linux/offsite/test-grabenplaner-offsite.sh");
const common = read("server-tools/linux/offsite/lib/offsite-common.sh");
const broker = read("server-tools/linux/offsite/lib/assurance-control-broker.js");
const socketUnit = read("server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance-control.socket.in");
const serviceUnit = read("server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance-control@.service.in");
const packageBuilder = read("server-tools/package/New-GrabenplanerLinuxServerPackage.ps1");

test("offsite module v9 retains the complete fixed RAS control bridge", () => {
  assert.equal(schema.moduleVersion, 9);
  for (const relative of [
    "server-tools/linux/offsite/lib/assurance-control-broker.js",
    "server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance-control.socket.in",
    "server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance-control@.service.in",
  ]) assert.ok(schema.managedArtifacts.includes(relative), `Fehlt im Modulvertrag: ${relative}`);
  for (const leaf of [
    "assurance-control-broker.js",
    "grabenplaner-offsite-assurance-control.socket.in",
    "grabenplaner-offsite-assurance-control@.service.in",
  ]) assert.match(packageBuilder, new RegExp(leaf.replaceAll(".", "\\.")), `Fehlt im Linux-Paketbauer: ${leaf}`);
  assert.match(broker, /const ASSURANCE_UNIT = "grabenplaner-offsite-assurance@manual-admin-ui\.service"/);
  assert.doesNotMatch(broker, /sudo|pkexec|polkit|execSync|shell:\s*true/i);
  assert.doesNotMatch(serviceUnit, /%i.*ExecStart|ExecStart=.*%i/);
});

test("systemd exposes only a group-scoped Unix socket and a hardened root broker", () => {
  assert.match(socketUnit, /ListenStream=\/run\/grabenplaner-assurance-control\/request\.sock/);
  assert.match(socketUnit, /SocketUser=root/);
  assert.match(socketUnit, /SocketGroup=grabenplaner-assurance-control/);
  assert.match(socketUnit, /SocketMode=0660/);
  assert.match(socketUnit, /DirectoryMode=0755/);
  assert.match(socketUnit, /Accept=yes/);
  assert.match(serviceUnit, /User=root[\s\S]*Group=root/);
  assert.match(serviceUnit, /NoNewPrivileges=yes/);
  assert.match(serviceUnit, /ProtectSystem=strict/);
  assert.match(serviceUnit, /RestrictAddressFamilies=AF_UNIX/);
  assert.match(serviceUnit, /IPAddressDeny=any/);
  assert.match(serviceUnit, /CapabilityBoundingSet=\s*$/m);
  assert.match(serviceUnit, /ReadWritePaths=\/run\/grabenplaner-assurance-control/);
});

test("installer retains the transactional privilege bridge and rollback removes the new privilege", () => {
  assert.match(common, /OFFSITE_CONTROL_GROUP="grabenplaner-assurance-control"/);
  assert.match(common, /control_members" == "\$OFFSITE_APP_USER"/);
  assert.match(installer, /OFFSITE_CONTROL_GROUP/);
  assert.match(installer, /groupadd --system "\$OFFSITE_CONTROL_GROUP"/);
  assert.match(installer, /usermod --append --groups "\$OFFSITE_CONTROL_GROUP" "\$OFFSITE_APP_USER"/);
  assert.match(installer, /rollback_control_group/);
  assert.match(installer, /gpasswd --delete "\$OFFSITE_APP_USER" "\$OFFSITE_CONTROL_GROUP"/);
  assert.match(installer, /groupdel "\$OFFSITE_CONTROL_GROUP"/);
  assert.match(installer, /systemctl enable --now[\s\S]*grabenplaner-offsite-assurance-control\.socket/);
  assert.match(installer, /control_socket_was_enabled/);
  assert.match(installer, /control_socket_was_active/);
});

test("uninstaller and self-test close and verify the RAS privilege boundary", () => {
  assert.match(uninstaller, /grabenplaner-offsite-assurance-control\.socket/);
  assert.match(uninstaller, /offsite_assert_control_group_isolation/);
  assert.match(uninstaller, /gpasswd --delete "\$OFFSITE_APP_USER" "\$OFFSITE_CONTROL_GROUP"/);
  assert.match(uninstaller, /groupdel "\$OFFSITE_CONTROL_GROUP"/);
  assert.match(selfTest, /offsite_assert_control_group_isolation/);
  assert.match(selfTest, /RAS-Socketrechte/);
  assert.match(selfTest, /recoveryAssuranceControlStatus/);
  assert.doesNotMatch(selfTest, /start-manual-assurance/);
});

test("manual-admin-ui is a closed trigger in writer, reader and runner", () => {
  for (const relative of [
    "server-tools/linux/offsite/grabenplaner-offsite-assurance.sh",
    "server-tools/linux/offsite/lib/assurance-history.js",
    "lib/recovery-assurance-status.js",
  ]) assert.match(read(relative), /manual-admin-ui/, `Trigger fehlt: ${relative}`);
});
