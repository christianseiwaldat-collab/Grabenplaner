"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const source = fs.readFileSync(path.join(__dirname, "../server-tools/linux/offsite/install-grabenplaner-offsite.sh"), "utf8").replace(/\r\n/g, "\n");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-offsite-restart-"));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); }); return root; }

test("the real installer environment writer preserves identical configuration and updates changed provider flags", t => {
  const root = temporary(t), input = path.join(root, "input"), output = path.join(root, "output");
  const start = source.indexOf('"$OFFSITE_NODE" - "$OFFSITE_APP_ENV" "$env_temporary" "$validated_provider" <<\'NODE\'');
  assert.ok(start > 0);
  const code = source.slice(source.indexOf("\n", start) + 1, source.indexOf("\nNODE", start));
  const text = '# synthetic configuration\nPORT=3000\nGRABENPLANER_OFFSITE_CONFIGURED=1\nGRABENPLANER_OFFSITE_PROVIDER=google_drive\nGRABENPLANER_OFFSITE_STATUS_FILE=/var/lib/grabenplaner-offsite/status.json\nANOTHER_SETTING=kept\n';
  fs.writeFileSync(input, text);
  const write = provider => spawnSync(process.execPath, ["-", input, output, provider], { input: code, encoding: "utf8" });
  assert.equal(write("google_drive").status, 0); assert.equal(fs.readFileSync(output, "utf8"), text);
  assert.equal(write("backblaze_b2").status, 0);
  const changed = fs.readFileSync(output, "utf8"); assert.ok(changed.includes("ANOTHER_SETTING=kept\n"));
  assert.ok(changed.includes("GRABENPLANER_OFFSITE_PROVIDER=backblaze_b2\n")); assert.ok(!changed.includes("=google_drive"));
});

for (const scenario of ["same", "environment", "groups", "predecessor", "inactive"]) {
  test(`actual installer restart decision: ${scenario}`, { skip: !fs.existsSync(bash) }, t => {
    const root = temporary(t); fs.writeFileSync(path.join(root, "grabenplaner.env"), "before"); fs.writeFileSync(path.join(root, "current.env"), scenario === "environment" ? "changed" : "before");
    const start = source.indexOf('core_workflow="$(offsite_core_deploy_workflow');
    const end = source.indexOf('systemctl is-active --quiet "$OFFSITE_APP_SERVICE" ||', start);
    assert.ok(start > 0 && end > start);
    const block = source.slice(start, end);
    const script = `set -e\nrollback_root="$PWD"\nOFFSITE_APP_ENV="$PWD/current.env"\nOFFSITE_APP_USER=fixture\nOFFSITE_APP_SERVICE=fixture\ninstalled_module_version=7\napp_restart_started=0\napp_groups_before='1 2'\n` +
      `offsite_core_deploy_workflow() { printf '${scenario === "predecessor" ? "current" : "legacy-full"}'; }\n` +
      `id() { printf '${scenario === "groups" ? "1 2 3" : "1 2"}'; }\nsystemctl() { return ${scenario === "inactive" ? "1" : "0"}; }\n` +
      `offsite_info() { :; }\ngp_stop_service() { printf 'stop\\n'; }\ngp_start_service() { printf 'start\\n'; }\n` + block + '\nprintf "attempted=%s\\n" "$app_restart_started"';
    const result = spawnSync(bash, ["--noprofile", "--norc", "-s"], { cwd: root, input: script, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, scenario === "same" ? "attempted=0\n" : "stop\nstart\nattempted=1\n");
  });
}
