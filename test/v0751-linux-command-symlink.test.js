"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const linuxRoot = path.join(root, "server-tools", "linux");
const commands = [
  ["backup", "backup-grabenplaner.sh"],
  ["monitor", "monitor/run-grabenplaner-monitor.sh"],
  ["stop", "stop-grabenplaner-server.sh"],
  ["test", "test-grabenplaner-server.sh"],
  ["update", "update-grabenplaner-server.sh"],
  ["uninstall", "uninstall-grabenplaner-server.sh"],
];

test("v0.75.1 every core command resolves its canonical installed script before sourcing libraries", () => {
  for (const [command, relative] of commands) {
    const source = fs.readFileSync(path.join(linuxRoot, relative), "utf8");
    const expected = `/opt/grabenplaner/app/server-tools/linux/${relative}`;
    assert.match(source, /SCRIPT_PATH="\$\(readlink -f -- "\$SCRIPT_SOURCE"/);
    assert.ok(source.includes(`EXPECTED_COMMAND_TARGET="${expected}"`), command);
    assert.match(source, /\[\[ -n "\$SCRIPT_PATH" && -f "\$SCRIPT_PATH" && ! -L "\$SCRIPT_PATH" \]\]/);
    assert.match(source, /\[\[ ! -L "\$SCRIPT_SOURCE" \|\| "\$SCRIPT_PATH" == "\$EXPECTED_COMMAND_TARGET" \]\]/);
    assert.ok(source.indexOf("readlink -f") < source.indexOf("source \"$SCRIPT_DIR"), command);
    assert.doesNotMatch(source, /SCRIPT_DIR="\$\(cd -- "\$\(dirname -- "\$\{BASH_SOURCE\[0\]\}"\)"/);
  }

  const installer = fs.readFileSync(path.join(linuxRoot, "install-grabenplaner-server.sh"), "utf8");
  assert.match(installer, /\[\[ -f "\$command_source" && ! -L "\$command_source" \]\]/);
});

test("v0.75.1 protected core commands execute help and reject foreign symlinks and writable parents", {
  skip: process.platform !== "linux",
}, () => {
  // The real entrypoints reject runner-owned checkouts before even --help.
  // Create fresh Root-owned copies below /root; never alter the checkout or
  // installed product paths. No service, configuration or database is used.
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const files = [...new Set([...commands.map(([, relative]) => relative), "lib/common.sh", "lib/postgresql-maintenance.sh"])];
  const script = `set -Eeuo pipefail
umask 077
[[ "$(id -u)" == 0 ]]
for parent in / /root; do
  [[ -d "$parent" && ! -L "$parent" && "$(stat --format=%u -- "$parent")" == 0 ]]
  mode="$(stat --format=%a -- "$parent")"; (( (8#$mode & 022) == 0 ))
done
temporary="$(mktemp --directory --tmpdir=/root gp-command-help.XXXXXXXX)"
identity="$(stat --format='%d:%i' -- "$temporary")"
cleanup() {
  [[ "$temporary" == /root/gp-command-help.* && "$(dirname -- "$temporary")" == /root && ! -L "$temporary" ]]
  [[ "$(stat --format='%u:%d:%i' -- "$temporary")" == "0:$identity" ]]
  rm -rf -- "$temporary"
}
trap cleanup EXIT
${files.map(relative => `mkdir -p -- "$temporary/${path.posix.dirname(relative)}"
cp -- ${quote(path.join(linuxRoot, relative))} "$temporary/${relative}"
chown 0:0 -- "$temporary/${relative}"
chmod 0640 -- "$temporary/${relative}"
cmp -- ${quote(path.join(linuxRoot, relative))} "$temporary/${relative}"`).join("\n")}
mkdir -- "$temporary/aliases"
${commands.map(([command, relative]) => `bash "$temporary/${relative}" --help >"$temporary/output" 2>"$temporary/error"
ln -s -- "$temporary/${relative}" "$temporary/aliases/grabenplaner-${command}"
if bash "$temporary/aliases/grabenplaner-${command}" --help >"$temporary/output" 2>"$temporary/error"; then exit 31; fi
grep -q 'zeigt nicht auf die erwartete Grabenplaner-Installation' "$temporary/error"
printf '%s\\n' '${command}: direct-help and foreign-link guards passed'`).join("\n")}
mkdir -- "$temporary/unsafe"
chmod 0777 -- "$temporary/unsafe"
${["backup-grabenplaner.sh", "update-grabenplaner-server.sh", "lib/common.sh", "lib/postgresql-maintenance.sh"].map(relative => `mkdir -p -- "$temporary/unsafe/${path.posix.dirname(relative)}"
cp -- "$temporary/${relative}" "$temporary/unsafe/${relative}"
chown 0:0 -- "$temporary/unsafe/${relative}"
chmod 0640 -- "$temporary/unsafe/${relative}"`).join("\n")}
for command in backup-grabenplaner.sh update-grabenplaner-server.sh; do
  if bash "$temporary/unsafe/$command" --help >"$temporary/output" 2>"$temporary/error"; then exit 32; fi
  grep -Eq 'root-geschuetzt|fremdschreibbar' "$temporary/error"
done
printf '%s\\n' 'writable-parent guards passed'
`;
  const rootUser = process.getuid?.() === 0;
  const result = spawnSync(rootUser ? "/bin/bash" : "sudo", rootUser ? ["-s"] : ["-n", "/bin/bash", "-s"], {
    input: script, encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  for (const [command] of commands) assert.match(result.stdout, new RegExp(`${command}: direct-help and foreign-link guards passed`));
  assert.match(result.stdout, /writable-parent guards passed/);
});

test("v0.75.1 optional symlink commands already use canonical or absolute installed roots", () => {
  for (const relative of [
    "offsite/grabenplaner-offsite-pre-update.sh",
    "offsite/grabenplaner-offsite-prepare.sh",
    "offsite/test-grabenplaner-offsite.sh",
    "offsite/uninstall-grabenplaner-offsite.sh",
    "hardening/test-grabenplaner-host-hardening.sh",
    "hardening/uninstall-grabenplaner-host-hardening.sh",
  ]) {
    const source = fs.readFileSync(path.join(linuxRoot, relative), "utf8");
    assert.match(source, /SCRIPT_PATH="\$\(readlink -f -- "\$\{BASH_SOURCE\[0\]\}"\)"/);
  }

  const controller = fs.readFileSync(path.join(linuxRoot, "hardening/grabenplaner-host-security.sh"), "utf8");
  assert.match(controller, /source \/opt\/grabenplaner-hardening\/module\/lib\/hardening-common\.sh/);
  const recovery = fs.readFileSync(path.join(linuxRoot, "recovery/grabenplaner-recovery.sh"), "utf8");
  assert.match(recovery, /OFFSITE_COMMON="\/opt\/grabenplaner-offsite\/module\/lib\/offsite-common\.sh"/);
  assert.match(recovery, /\[\[ -f "\$OFFSITE_COMMON" && ! -L "\$OFFSITE_COMMON" \]\]/);
});
