"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const unitRoot = path.join(root, "server-tools", "linux", "host-control", "systemd");
const read = (name) => fs.readFileSync(path.join(unitRoot, name), "utf8");

test("host reboot socket is group-scoped and accepts bounded broker instances", () => {
  const socket = read("grabenplaner-host-control.socket.in");
  assert.match(socket, /^ListenStream=\/run\/grabenplaner-host-control\/request\.sock$/m);
  assert.match(socket, /^SocketUser=root$/m);
  assert.match(socket, /^SocketGroup=grabenplaner-host-control$/m);
  assert.match(socket, /^SocketMode=0660$/m);
  assert.match(socket, /^DirectoryMode=0755$/m);
  assert.match(socket, /^Accept=yes$/m);
  assert.match(socket, /^MaxConnections=2$/m);
  assert.doesNotMatch(socket, /ListenStream=(?:0\.0\.0\.0|\[::\]|[0-9]+$)/m);
});

test("host reboot broker unit is root-only, locked and limited to the Unix socket", () => {
  const service = read("grabenplaner-host-control@.service.in");
  assert.match(service, /^User=root$/m);
  assert.match(service, /^Group=root$/m);
  assert.match(
    service,
    /^ExecStartPre=\{\{NODE_EXECUTABLE\}\} \/opt\/grabenplaner-host-control\/module\/lib\/host-reboot-broker\.js --ensure-maintenance-lock$/m,
  );
  assert.match(
    service,
    /^ExecStart=\/usr\/bin\/flock --exclusive --wait 3 \/run\/grabenplaner-host-control\/broker\.lock \{\{NODE_EXECUTABLE\}\} \/opt\/grabenplaner-host-control\/module\/lib\/host-reboot-broker\.js$/m,
  );
  assert.match(service, /^StandardInput=socket$/m);
  assert.match(service, /^StandardOutput=socket$/m);
  assert.match(service, /^NoNewPrivileges=yes$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^ProtectControlGroups=yes$/m);
  assert.match(service, /^RestrictAddressFamilies=AF_UNIX$/m);
  assert.match(service, /^IPAddressDeny=any$/m);
  assert.match(service, /^CapabilityBoundingSet=$/m);
  assert.match(service, /^StateDirectory=grabenplaner-host-control$/m);
  assert.match(service, /^RuntimeDirectory=grabenplaner-host-control grabenplaner$/m);
  assert.match(
    service,
    /^ReadWritePaths=\/run\/grabenplaner-host-control \/var\/lib\/grabenplaner-host-control$/m,
  );
  assert.match(
    service,
    /^ReadOnlyPaths=\/var\/lib\/grabenplaner\/backups \/var\/lib\/grabenplaner-host-security$/m,
  );
  assert.doesNotMatch(service, /\/bin\/(?:ba)?sh|\s-c\s|sudo|pkexec/);
});

test("host reboot worker holds the central maintenance lock through one fixed reboot", () => {
  const service = read("grabenplaner-host-reboot.service.in");
  assert.match(service, /^ConditionPathExists=\/run\/reboot-required$/m);
  assert.match(service, /^ExecCondition=\/usr\/bin\/test -f \/run\/reboot-required$/m);
  assert.match(
    service,
    /^ExecStart=\/usr\/bin\/flock --exclusive --nonblock \/run\/grabenplaner\/maintenance\.lock \{\{NODE_EXECUTABLE\}\} \/opt\/grabenplaner-host-control\/module\/lib\/host-reboot-broker\.js --execute-pending-reboot$/m,
  );
  assert.match(service, /^NoNewPrivileges=yes$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^RestrictAddressFamilies=AF_UNIX$/m);
  assert.match(service, /^IPAddressDeny=any$/m);
  assert.match(service, /^CapabilityBoundingSet=$/m);
  assert.doesNotMatch(service, /^\[Install\]$/m);
  assert.doesNotMatch(service, /shutdown|poweroff|halt|\/bin\/(?:ba)?sh|\s-c\s|ExecStartPre/);
});
