"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const root = path.resolve(__dirname, "..");
const updater = fs.readFileSync(path.join(root, "server-tools/linux/update-grabenplaner-server.sh"), "utf8").replace(/\r\n/g, "\n");
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const start = updater.indexOf("  # Candidate dependencies are not installed yet.");
const end = updater.indexOf("\nfi", start);
assert.ok(start > 0 && end > start);
const gate = updater.slice(start, end);

test("PostgreSQL path binding precedes all costly or disruptive update operations", () => {
  const binding = updater.indexOf('"$extract_root/server-tools/linux/lib/postgresql-operations.js" check-paths');
  assert.ok(binding > start && binding < end);
  for (const operation of [
    '"$extract_root/server-tools/linux/lib/postgresql-operations.js" recovery-files-preflight',
    "install --prod --frozen-lockfile", "\nscan_candidate_with_clamav\n",
    'gp_stop_service "$service" 150', 'gp_begin_update_backup_ownership "$database"',
  ]) {
    assert.ok(updater.indexOf(operation, binding) > binding, operation);
  }
});

for (const scenario of ["correct", "previous-wrong-backup-directory", "wrong-data-directory"]) {
  test("real updater gate and operations helper validate configured paths: " + scenario,
    { skip: process.platform !== "linux" }, t => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gp-deploy-path-binding-"));
      t.after(() => {
        assert.equal(path.dirname(fs.realpathSync(temporary)), fs.realpathSync(os.tmpdir()));
        fs.rmSync(temporary, { recursive: true, force: true });
      });
      const write = (relative, content) => {
        const file = path.join(temporary, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      };
      // Execute the shipped check-paths action. Only configuration loading and
      // recovery-file traversal use synthetic data; no production DB is opened.
      write("candidate/server-tools/linux/lib/postgresql-operations.js",
        fs.readFileSync(path.join(root, "server-tools/linux/lib/postgresql-operations.js")));
      write("installed/node_modules/path-binding-fixture/index.js", "module.exports={sourceFiles:'/var/lib/grabenplaner',backupDirectory:'/var/backups/grabenplaner-postgresql'};");
      write("candidate/lib/persistence/postgresql/operations/runtime.js", `
exports.loadConfiguration = file => {
  require('node:assert/strict').equal(file, '/etc/grabenplaner/postgresql-operations.json');
  return require('path-binding-fixture');
};
exports.recoveryFilesPreflight = () => {
  require('node:fs').appendFileSync(process.env.TEST_EVENTS, 'recovery-files\\n');
  return {verified:true};
};
`);
      for (const file of ["paired-monitor.js", "paired-retention.js"]) {
        write("candidate/lib/persistence/postgresql/operations/" + file, "module.exports={};");
      }
      write("run.sh", [
        "set -Eeuo pipefail", "IFS=$'\\n\\t'",
        "node=" + quote(process.execPath), 'app_dir="$PWD/installed"', 'extract_root="$PWD/candidate"',
        "data_dir=" + quote(scenario === "wrong-data-directory" ? "/wrong-data" : "/var/lib/grabenplaner"),
        "backup_dir=" + quote(scenario === "previous-wrong-backup-directory" ? "/var/backups/grabenplaner" : "/var/backups/grabenplaner-postgresql"),
        "gp_die() { printf '%s\\n' \"$*\" >&2; exit 42; }",
        gate,
        "printf 'continue\\n' >> \"$TEST_EVENTS\"",
      ].join("\n"));
      const eventsFile = path.join(temporary, "events");
      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "run.sh"], {
        cwd: temporary, encoding: "utf8", timeout: 15000,
        env: { ...process.env, NODE_PATH: "", TEST_EVENTS: eventsFile },
      });
      const events = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8") : "";
      if (scenario === "correct") {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(events, "recovery-files\ncontinue\n");
      } else {
        assert.equal(result.status, 42, result.stderr);
        assert.match(result.stderr, /PG_OPERATIONS_PATH_BINDING/);
        assert.match(result.stderr, /vor Abhaengigkeiten, Virenscan und Dienststopp/);
        assert.equal(events, "");
      }
    });
}
