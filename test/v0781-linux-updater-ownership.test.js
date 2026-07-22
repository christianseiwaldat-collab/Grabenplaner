const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("v0.78.1: Linux-Updater prueft den Helper gegen seine eigene Dienstgruppe", () => {
  const updater = fs.readFileSync(
    path.join(root, "server-tools", "linux", "update-grabenplaner-server.sh"),
    "utf8",
  );
  const common = fs.readFileSync(path.join(root, "server-tools", "linux", "lib", "common.sh"), "utf8");

  assert.match(common, /chown -R "root:\$group" -- "\$path"/);
  assert.match(common, /find "\$path" -type f ! -perm \/111 -exec chmod 0640/);
  assert.match(updater, /service_group_gid="\$\(getent group "\$service_group"/);
  assert.match(updater, /Dienstgruppe[^\n]+kann nicht aufgeloest werden/);
  assert.match(updater, /\[\[ "\$service_group_gid" =~ \^\[0-9\]\+\$ \]\]/);
  assert.match(updater, /\[\[ -f "\$offsite_gate_helper" && ! -L "\$offsite_gate_helper"/);
  assert.match(updater, /stat --format='%u:%g:%h' -- "\$offsite_gate_helper"\)" == "0:\$service_group_gid:1"/);
  assert.doesNotMatch(updater, /offsite_gate_helper[\s\S]{0,300}"0:0:1"/);
  assert.match(updater, /8#\$offsite_gate_helper_mode & 022/);
});
