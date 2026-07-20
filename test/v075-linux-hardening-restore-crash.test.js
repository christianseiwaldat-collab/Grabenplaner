"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const controllerPath = path.join(root, "server-tools", "linux", "hardening", "grabenplaner-host-security.sh");

test("v0.75 SIGKILL during restore leaves an exact old/restored file and retry is idempotent", {
  skip: process.platform === "win32",
  timeout: 45_000,
}, (context) => {
  const sudo = process.getuid?.() === 0 ? null : "sudo";
  if (sudo) {
    const probe = spawnSync(sudo, ["-n", "true"], { encoding: "utf8" });
    if (probe.status !== 0) {
      context.skip("Passwordless sudo is unavailable for the root-owned restore fixture.");
      return;
    }
  }

  const script = String.raw`
set -Eeuo pipefail
controller="$1"
source "$controller"

base="$(mktemp -d /tmp/grabenplaner-restore-test.XXXXXXXX)"
trap 'rm -rf -- "$base"' EXIT
parent="$base/etc"
transaction="$base/transaction"
mkdir -p -- "$parent" "$transaction/backups"
chmod 0755 -- "$parent"
chmod 0700 -- "$transaction" "$transaction/backups"

target="$parent/policy.conf"
backup="$transaction/backups/ssh"
dd if=/dev/zero of="$backup" bs=1M count=128 status=none
chmod 0600 -- "$backup"
chown root:root -- "$backup"
cp -- "$backup" "$target"
printf X | dd of="$target" bs=1 seek=0 conv=notrunc status=none
chmod 0640 -- "$target"
chown root:root -- "$target"

backup_hash="$(sha256sum --binary -- "$backup" | awk '{print tolower($1)}')"
current_hash="$(sha256sum --binary -- "$target" | awk '{print tolower($1)}')"
printf 'ssh\tpresent\t%s\t0\t0\t640\n' "$backup_hash" >"$transaction/hashes.tsv"
printf 'ssh\tpresent\t%s\t0\t0\t640\n' "$current_hash" >"$transaction/post-apply.tsv"
chmod 0600 -- "$transaction/hashes.tsv" "$transaction/post-apply.tsv"
chown root:root -- "$transaction/hashes.tsv" "$transaction/post-apply.tsv"
backup_record="$(cat "$transaction/hashes.tsv")"
current_record="$(cat "$transaction/post-apply.tsv")"

restore_file "$transaction" ssh "$target" &
restore_pid=$!
killed=0
for _ in $(seq 1 20000); do
  if compgen -G "$parent/.grabenplaner-restore-ssh.*" >/dev/null; then
    if kill -KILL "$restore_pid" 2>/dev/null; then killed=1; fi
    break
  fi
  kill -0 "$restore_pid" 2>/dev/null || break
done
if ((killed == 0)) && kill -0 "$restore_pid" 2>/dev/null; then
  kill -KILL "$restore_pid"
  killed=1
fi
wait "$restore_pid" 2>/dev/null || true
((killed == 1))

file_matches_manifest_record "$target" "$current_record" \
  || file_matches_manifest_record "$target" "$backup_record"
restore_file "$transaction" ssh "$target"
file_matches_manifest_record "$target" "$backup_record"
restore_file "$transaction" ssh "$target"
file_matches_manifest_record "$target" "$backup_record"

absent_transaction="$base/absent-transaction"
mkdir -p -- "$absent_transaction/backups"
chmod 0700 -- "$absent_transaction" "$absent_transaction/backups"
printf 'ssh\tabsent\t-\t0\t0\t0\n' >"$absent_transaction/hashes.tsv"
printf 'ssh\tpresent\t%s\t0\t0\t640\n' "$backup_hash" >"$absent_transaction/post-apply.tsv"
chmod 0600 -- "$absent_transaction/hashes.tsv" "$absent_transaction/post-apply.tsv"
chown root:root -- "$absent_transaction/hashes.tsv" "$absent_transaction/post-apply.tsv"
cp -- "$backup" "$target"
chmod 0640 -- "$target"
restore_file "$absent_transaction" ssh "$target"
[[ ! -e "$target" && ! -L "$target" ]]
restore_file "$absent_transaction" ssh "$target"
[[ ! -e "$target" && ! -L "$target" ]]

# Ubuntu does not create /etc/systemd/journald.conf.d by default. If apply
# fails before the journald stage, both the absent target and its parent are
# already the exact predecessor and rollback must remain idempotent.
missing_parent="$base/etc/systemd/journald.conf.d"
missing_target="$missing_parent/60-grabenplaner-journald.conf"
missing_transaction="$base/missing-parent-transaction"
mkdir -p -- "$base/etc/systemd" "$missing_transaction/backups"
chmod 0755 -- "$base/etc/systemd"
chmod 0700 -- "$missing_transaction" "$missing_transaction/backups"
printf 'journald\tabsent\t-\t0\t0\t0\n' >"$missing_transaction/hashes.tsv"
chmod 0600 -- "$missing_transaction/hashes.tsv"
chown root:root -- "$missing_transaction/hashes.tsv"
[[ ! -e "$missing_parent" && ! -L "$missing_parent" ]]
restore_file "$missing_transaction" journald "$missing_target"
restore_file "$missing_transaction" journald "$missing_target"
[[ ! -e "$missing_parent" && ! -L "$missing_parent" ]]

mkdir -p -- "$base/redirected-parent"
ln -s -- "$base/redirected-parent" "$missing_parent"
if restore_file "$missing_transaction" journald "$missing_target"; then
  echo "restore unexpectedly trusted a symlinked missing parent" >&2
  exit 1
fi
rm -f -- "$missing_parent"
chmod 0777 -- "$base/etc/systemd"
if restore_file "$missing_transaction" journald "$missing_target"; then
  echo "restore unexpectedly trusted a writable existing ancestor" >&2
  exit 1
fi
chmod 0755 -- "$base/etc/systemd"
ln -s -- "$base/does-not-exist" "$missing_parent"
if restore_file "$missing_transaction" journald "$missing_target"; then
  echo "restore unexpectedly trusted a dangling parent symlink" >&2
  exit 1
fi
`;

  const command = sudo || "bash";
  const args = sudo ? ["-n", "bash", "-s", "--", controllerPath] : ["-s", "--", controllerPath];
  const result = spawnSync(command, args, {
    input: script,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
