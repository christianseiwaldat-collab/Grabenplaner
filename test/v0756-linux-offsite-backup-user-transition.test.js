"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("v0.75.6 keeps the backup worker bound to the hardened preparation service", () => {
  const backup = fs.readFileSync(
    path.join(root, "server-tools", "linux", "backup-grabenplaner.sh"),
    "utf8",
  );
  const prepareUnit = fs.readFileSync(
    path.join(root, "server-tools", "linux", "offsite", "systemd", "grabenplaner-offsite-prepare.service.in"),
    "utf8",
  );

  assert.match(backup, /gp_require_command runuser/);
  assert.doesNotMatch(backup, /gp_require_command systemd-run/);
  assert.match(backup, /runuser --user "\$service_user" -- env -i/);
  assert.doesNotMatch(backup, /systemd-run /);

  assert.match(prepareUnit, /^NoNewPrivileges=yes$/m);
  assert.doesNotMatch(prepareUnit, /^RestrictRealtime=/m);
  assert.match(prepareUnit, /^RestrictSUIDSGID=yes$/m);
  assert.match(prepareUnit, /^CapabilityBoundingSet=~CAP_SYS_NICE$/m);
  assert.match(prepareUnit, /^LimitRTPRIO=0$/m);
  assert.match(prepareUnit, /^LimitRTTIME=0$/m);
  assert.match(prepareUnit, /^ProtectSystem=strict$/m);
  assert.match(prepareUnit, /^PrivateDevices=yes$/m);
  assert.match(prepareUnit, /^IPAddressDeny=any$/m);
});
