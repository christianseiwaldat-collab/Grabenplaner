"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("v0.75.6 creates the backup snapshot in a separate unprivileged systemd unit", () => {
  const backup = fs.readFileSync(
    path.join(root, "server-tools", "linux", "backup-grabenplaner.sh"),
    "utf8",
  );
  const prepareUnit = fs.readFileSync(
    path.join(root, "server-tools", "linux", "offsite", "systemd", "grabenplaner-offsite-prepare.service.in"),
    "utf8",
  );

  assert.match(backup, /gp_require_command systemd-run/);
  assert.doesNotMatch(backup, /runuser --user "\$service_user"/);
  assert.match(backup, /systemd-run --quiet --wait --pipe --collect/);
  assert.match(backup, /--uid="\$service_user" --gid="\$service_group" --working-directory="\$data_dir"/);
  assert.match(backup, /--setenv=PATH=\/usr\/local\/bin:\/usr\/bin:\/bin --setenv=NODE_ENV=production/);
  for (const property of [
    "NoNewPrivileges=yes",
    "PrivateDevices=yes",
    "PrivateTmp=yes",
    "ProtectHome=yes",
    "RestrictAddressFamilies=AF_UNIX",
    "IPAddressDeny=any",
    "LockPersonality=yes",
    "RestrictRealtime=yes",
    "RestrictSUIDSGID=yes",
    "SystemCallArchitectures=native",
    "UMask=0077",
  ]) {
    assert.match(backup, new RegExp(`--property=${property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }

  assert.match(prepareUnit, /^NoNewPrivileges=yes$/m);
  assert.match(prepareUnit, /^RestrictRealtime=yes$/m);
  assert.match(prepareUnit, /^RestrictSUIDSGID=yes$/m);
});
