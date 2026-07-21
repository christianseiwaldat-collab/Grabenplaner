"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("v0.75.7 keeps offsite workers lifecycle-bound on Ubuntu 26.04", () => {
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
  assert.match(prepareUnit, /^RestrictRealtime=yes$/m);
  assert.match(prepareUnit, /^RestrictSUIDSGID=yes$/m);
  assert.match(prepareUnit, /^CapabilityBoundingSet=~CAP_SYS_NICE$/m);
  assert.match(prepareUnit, /^LimitRTPRIO=0$/m);
  assert.match(prepareUnit, /^LimitRTTIME=0$/m);
  assert.match(prepareUnit, /^ProtectSystem=strict$/m);
  assert.match(prepareUnit, /^PrivateDevices=yes$/m);
  assert.match(prepareUnit, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
  assert.match(prepareUnit, /^IPAddressDeny=any$/m);
  assert.match(prepareUnit, /^IPAddressAllow=127\.0\.0\.0\/8$/m);
  assert.match(prepareUnit, /^IPAddressAllow=::1\/128$/m);

  for (const unitName of [
    "grabenplaner-offsite-prepare.service.in",
    "grabenplaner-offsite-upload.service.in",
    "grabenplaner-offsite-check.service.in",
    "grabenplaner-offsite-restore-test.service.in",
  ]) {
    const unit = fs.readFileSync(
      path.join(root, "server-tools", "linux", "offsite", "systemd", unitName),
      "utf8",
    );
    assert.doesNotMatch(unit, /^(?:User|Group)=root$/m);
    assert.match(unit, /^NoNewPrivileges=yes$/m);
    assert.match(unit, /^RestrictRealtime=yes$/m);
    assert.match(unit, /^RestrictSUIDSGID=yes$/m);
  }
});
