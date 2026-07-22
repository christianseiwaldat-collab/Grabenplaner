"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const installer = fs.readFileSync(path.join(root, "server-tools", "linux", "offsite", "install-grabenplaner-offsite.sh"), "utf8");
const rebind = fs.readFileSync(path.join(root, "server-tools", "linux", "offsite", "grabenplaner-offsite-rebind-rclone.sh"), "utf8");

function embeddedNode(source, declaration) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `Node-Pruefung fehlt: ${declaration}`);
  const end = source.indexOf("\nNODE", start);
  assert.ok(end > start, "Node-Heredoc ist unvollstaendig");
  return source.slice(start, end);
}

const installerValidation = embeddedNode(installer, 'const fs = require("node:fs");\nconst [restic, config, password]');
const rebindValidation = embeddedNode(rebind, 'const fs = require("node:fs");\nconst [configFile, passwordFile]');

function validate(script, configValue, kind) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-rclone-format-"));
  try {
    const config = path.join(temporary, "rclone.conf");
    const password = path.join(temporary, "rclone-config-password");
    fs.writeFileSync(config, configValue);
    fs.writeFileSync(password, `${"p".repeat(64)}\n`);
    const args = ["-"];
    if (kind === "installer") {
      const restic = path.join(temporary, "restic-password");
      fs.writeFileSync(restic, `${"r".repeat(64)}\n`);
      args.push(restic, config, password);
    } else {
      args.push(config, password);
    }
    return spawnSync(process.execPath, args, { input: script, encoding: "utf8" }).status;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

for (const [name, script, kind] of [
  ["Installer", installerValidation, "installer"],
  ["rclone-Neuanbindung", rebindValidation, "rebind"],
]) {
  test(`v0.78.2: ${name} akzeptiert den offiziellen verschluesselten rclone-Vorspann`, () => {
    assert.equal(validate(script, `# Encrypted rclone configuration File\n\nRCLONE_ENCRYPT_V0:\n${"A".repeat(96)}\n`, kind), 0);
    assert.equal(validate(script, `RCLONE_ENCRYPT_V0:\n${"B".repeat(96)}\n`, kind), 0);
    assert.equal(validate(script, `  # zulaessiger Kommentar\r\n \r\nRCLONE_ENCRYPT_V0:\r\n${"C".repeat(96)}\r\n`, kind), 0);
  });

  test(`v0.78.2: ${name} weist Klartext vor dem Verschluesselungsmarker ab`, () => {
    assert.notEqual(validate(script, `[gpdrive]\ntype = drive\nRCLONE_ENCRYPT_V0:\n${"D".repeat(96)}\n`, kind), 0);
    assert.notEqual(validate(script, `Erlaeuterung ohne Kommentar\nRCLONE_ENCRYPT_V0:\n${"E".repeat(96)}\n`, kind), 0);
    assert.notEqual(validate(script, `[gpdrive]\ntype = drive\n${"F".repeat(96)}\n`, kind), 0);
  });
}
