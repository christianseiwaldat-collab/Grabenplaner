"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const common = read("server-tools", "linux", "lib", "common.sh");
const offsiteCommon = read(
  "server-tools",
  "linux",
  "offsite",
  "lib",
  "offsite-common.sh",
);
const prepare = read(
  "server-tools",
  "linux",
  "offsite",
  "grabenplaner-offsite-prepare.sh",
);
const prepareService = read(
  "server-tools",
  "linux",
  "offsite",
  "systemd",
  "grabenplaner-offsite-prepare.service.in",
);
const uploadService = read(
  "server-tools",
  "linux",
  "offsite",
  "systemd",
  "grabenplaner-offsite-upload.service.in",
);
const monitor = read(
  "server-tools",
  "linux",
  "monitor",
  "run-grabenplaner-monitor.sh",
);
const monitorService = read(
  "server-tools",
  "linux",
  "grabenplaner-monitor.service.in",
);
const moduleSchema = JSON.parse(read(
  "server-tools",
  "linux",
  "offsite",
  "module-schema.json",
));
const installer = read(
  "server-tools",
  "linux",
  "offsite",
  "install-grabenplaner-offsite.sh",
);

test("v0.86: nightly prepare waits only for bounded maintenance-lock contention", () => {
  assert.match(prepare, /readonly OFFSITE_MAINTENANCE_LOCK_WAIT_SECONDS=300/);
  assert.match(
    prepare,
    /offsite_acquire_maintenance_lock_with_wait "\$OFFSITE_MAINTENANCE_LOCK_WAIT_SECONDS"/,
  );
  assert.match(prepare, /\(\( lock_already_held == 1 \)\)[\s\S]*offsite_acquire_maintenance_lock_with_wait/);
  assert.doesNotMatch(prepare, /gp_acquire_maintenance_lock/);
  assert.match(
    offsiteCommon,
    /offsite_acquire_maintenance_lock_with_wait\(\)[\s\S]*if ! flock --nonblock 9; then[\s\S]*flock --wait "\$wait_seconds" 9/,
  );
  assert.match(prepareService, /^TimeoutStartSec=30min$/m);
});

test("v0.86: v5 prepare remains compatible with the installed v4 and rollback core helper", () => {
  const legacyCoreHelper = common.match(
    /gp_acquire_maintenance_lock\(\) \{[\s\S]*?\n\}\n\ngp_systemd_unit_exists\(\)/,
  )?.[0] || "";
  assert.match(legacyCoreHelper, /flock --nonblock 9/);
  assert.doesNotMatch(legacyCoreHelper, /wait_seconds|flock --wait/);
  assert.match(offsiteCommon, /readonly OFFSITE_MAINTENANCE_LOCK="\/run\/grabenplaner\/maintenance\.lock"/);
  assert.match(offsiteCommon, /wait_seconds" =~ \^\[1-9\]\[0-9\]\*\$[\s\S]*wait_seconds" -le 3600/);
  assert.match(offsiteCommon, /realpath --canonicalize-missing -- "\$requested_lock_path"/);
  assert.match(offsiteCommon, /lock_owner" == "0"[\s\S]*lock_group" == "0"[\s\S]*lock_links" == "1"/);

  const sourceCoreIndex = prepare.indexOf('source "$core_common"');
  const moduleLockIndex = prepare.indexOf("offsite_acquire_maintenance_lock_with_wait");
  assert.ok(sourceCoreIndex >= 0);
  assert.ok(moduleLockIndex > sourceCoreIndex);
  assert.doesNotMatch(
    prepare.slice(sourceCoreIndex, moduleLockIndex),
    /gp_acquire_maintenance_lock/,
  );
});

test("v0.86: monitor collision is shorter than the prepare wait and upload remains dependency-bound", () => {
  const waitSeconds = Number(
    prepare.match(/OFFSITE_MAINTENANCE_LOCK_WAIT_SECONDS=(\d+)/)?.[1],
  );
  const monitorMinutes = Number(
    monitorService.match(/^TimeoutStartSec=(\d+)min$/m)?.[1],
  );
  assert.equal(waitSeconds, 300);
  assert.equal(monitorMinutes, 4);
  assert.ok(waitSeconds > monitorMinutes * 60);
  assert.match(monitor, /if ! flock --nonblock 7; then[\s\S]*Serverpruefung wird[\s\S]*exit 0/);
  assert.match(uploadService, /^After=.*grabenplaner-offsite-prepare\.service$/m);
  assert.match(uploadService, /^Requires=grabenplaner-offsite-prepare\.service$/m);
});

test("v0.86: bounded lock wait does not turn genuine prepare errors into success", () => {
  assert.match(prepare, /^set -Eeuo pipefail$/m);
  assert.doesNotMatch(prepareService, /^SuccessExitStatus=/m);
  assert.doesNotMatch(prepareService, /^Restart=/m);
  assert.doesNotMatch(prepare, /\|\|\s*true[^\n]*gp_acquire_maintenance_lock/);
});

test("v0.86: the target-control change preserves the explicit v4 to v6 offsite migration", () => {
  assert.equal(moduleSchema.moduleVersion, 6);
  assert.match(installer, /\[1, 2, 3, 4, 5, 6\]\.includes\(value\.moduleVersion\)/);
  assert.match(installer, /installed_module_version >= 1 && installed_module_version <= 5/);
  assert.match(installer, /kontrolliert auf v6 migriert/);
});

test("v0.86: maintenance-lock helper really waits for a short holder", {
  skip: process.platform === "win32",
}, (context) => {
  if (spawnSync("flock", ["--version"], { encoding: "utf8" }).status !== 0) {
    context.skip("util-linux flock is unavailable");
    return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-offsite-lock-wait-"));
  const lock = path.join(temporary, "maintenance.lock");
  const ready = path.join(temporary, "holder.ready");
  const script = String.raw`
set -Eeuo pipefail
offsite_common_path="$1"
legacy_common_path="$2"
lock_path="$3"
ready_path="$4"
: >"$lock_path"
chmod 0600 -- "$lock_path"
(
  exec 8<>"$lock_path"
  flock --exclusive 8
  : >"$ready_path"
  sleep 1
) &
holder_pid=$!
trap 'kill "$holder_pid" >/dev/null 2>&1 || true; wait "$holder_pid" >/dev/null 2>&1 || true' EXIT
while [[ ! -e "$ready_path" ]]; do sleep 0.02; done
source "$offsite_common_path"
source "$legacy_common_path"
stat() {
  case "$1" in
    --format=%u|--format=%g) printf '0\n' ;;
    --format=%h) printf '1\n' ;;
    --format=%a) printf '755\n' ;;
    *) command stat "$@" ;;
  esac
}
offsite_acquire_maintenance_lock_with_wait 3 "$lock_path"
printf '%s\n' acquired
wait "$holder_pid"
trap - EXIT
`;
  try {
    const result = spawnSync("bash", [
      "-c",
      script,
      "block7-offsite-lock-test",
      path.join(root, "server-tools/linux/offsite/lib/offsite-common.sh"),
      path.join(root, "server-tools/linux/lib/common.sh"),
      lock,
      ready,
    ], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^acquired$/m);
    assert.match(result.stderr, /Warte bis zu 3 Sekunden/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("v0.86: maintenance-lock helper fails after its bounded wait", {
  skip: process.platform === "win32",
}, (context) => {
  if (spawnSync("flock", ["--version"], { encoding: "utf8" }).status !== 0) {
    context.skip("util-linux flock is unavailable");
    return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-offsite-lock-timeout-"));
  const lock = path.join(temporary, "maintenance.lock");
  const ready = path.join(temporary, "holder.ready");
  const script = String.raw`
set -Eeuo pipefail
offsite_common_path="$1"
legacy_common_path="$2"
lock_path="$3"
ready_path="$4"
: >"$lock_path"
chmod 0600 -- "$lock_path"
(
  exec 8<>"$lock_path"
  flock --exclusive 8
  : >"$ready_path"
  sleep 5
) &
holder_pid=$!
trap 'kill "$holder_pid" >/dev/null 2>&1 || true; wait "$holder_pid" >/dev/null 2>&1 || true' EXIT
while [[ ! -e "$ready_path" ]]; do sleep 0.02; done
source "$offsite_common_path"
source "$legacy_common_path"
stat() {
  case "$1" in
    --format=%u|--format=%g) printf '0\n' ;;
    --format=%h) printf '1\n' ;;
    --format=%a) printf '755\n' ;;
    *) command stat "$@" ;;
  esac
}
offsite_acquire_maintenance_lock_with_wait 1 "$lock_path"
`;
  try {
    const result = spawnSync("bash", [
      "-c",
      script,
      "block7-offsite-lock-test",
      path.join(root, "server-tools/linux/offsite/lib/offsite-common.sh"),
      path.join(root, "server-tools/linux/lib/common.sh"),
      lock,
      ready,
    ], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /nicht innerhalb des begrenzten Wartefensters/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
