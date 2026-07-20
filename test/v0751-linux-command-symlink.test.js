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

test("v0.75.1 core commands execute help directly and reject foreign command symlinks early", (context) => {
  const probe = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    context.skip("Bash is not installed on this test host");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-local-sbin-"));
  try {
    for (const [command, relative] of commands) {
      const target = path.join(linuxRoot, relative);
      const direct = spawnSync("bash", [target, "--help"], { encoding: "utf8" });
      assert.equal(direct.status, 0, `${command} direct: ${direct.stderr || direct.stdout}`);

      const link = path.join(temporary, `grabenplaner-${command}`);
      fs.symlinkSync(target, link);
      const linked = spawnSync("bash", [link, "--help"], { encoding: "utf8" });
      assert.notEqual(linked.status, 0, `${command} accepted a foreign command target`);
      assert.match(linked.stderr, /zeigt nicht auf die erwartete Grabenplaner-Installation/);
      assert.doesNotMatch(linked.stderr, /local-sbin-.*lib\/common\.sh/);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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
