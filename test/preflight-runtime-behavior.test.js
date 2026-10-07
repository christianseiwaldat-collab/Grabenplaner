"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const source = fs.readFileSync(path.join(__dirname, "../server-tools/linux/preflight-grabenplaner-deploy.sh"), "utf8").replace(/\r\n/g, "\n");
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const section = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-preflight-behavior-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    write(relative, content) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
    run(script, env = {}) {
      fs.writeFileSync(path.join(root, "run.sh"), [
        "set -Eeuo pipefail", "IFS=$'\\n\\t'",
        "node=" + quote(process.execPath.replaceAll("\\", "/")),
        "gp_die() { printf '%s\\n' \"$*\" >&2; exit 42; }",
        "gp_info() { :; }", script,
      ].join("\n"));
      return spawnSync(bash, ["--noprofile", "--norc", "run.sh"], { cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true, env: { ...process.env, ...env } });
    },
  };
}

const common = fs.readFileSync(path.join(__dirname, "../server-tools/linux/lib/common.sh"), "utf8").replace(/\r\n/g, "\n");
const sharedTmpCheck = common.match(/^gp_assert_shared_tmp\(\) \{\n[\s\S]*?^\}/m)?.[0];
assert.ok(sharedTmpCheck, "shared /tmp check exists");

for (const scenario of ["mode-0700", "mode-0777", "mode-3777", "wrong-owner", "wrong-group", "file", "link",
  "green", "installed-offsite", "configured-offsite", "missing-offsite-account", "app-write-denied", "app-search-denied",
  "build-write-denied", "build-search-denied", "offsite-write-denied", "offsite-search-denied"]) {
  test("shared /tmp shell preflight: " + scenario, { skip: !fs.existsSync(bash) }, t => {
    const f = fixture(t), directory = path.join(f.root, "shared tmp");
    fs.mkdirSync(directory);
    let probe = directory;
    if (scenario === "file") { probe = path.join(f.root, "tmp file"); fs.writeFileSync(probe, "not a directory"); }
    if (scenario === "link") {
      probe = path.join(f.root, "tmp link");
      fs.symlinkSync(directory, probe, process.platform === "win32" ? "junction" : "dir");
    }
    const hasOffsite = scenario.includes("offsite"), installed = scenario === "installed-offsite";
    if (installed) f.write("installed-contract.json", "{}");
    const metadata = scenario === "mode-0700" ? "0:0:700" : scenario === "mode-0777" ? "0:0:777"
      : scenario === "mode-3777" ? "0:0:3777" : scenario === "wrong-owner" ? "1000:0:1777"
        : scenario === "wrong-group" ? "0:1000:1777" : "0:0:1777";
    const deniedAccount = scenario.startsWith("app-") ? "app-fixture" : scenario.startsWith("build-") ? "build-fixture"
      : scenario.startsWith("offsite-") ? "grabenplaner-offsite" : "";
    const deniedAccess = scenario.endsWith("write-denied") ? "-w" : scenario.endsWith("search-denied") ? "-x" : "";
    const checks = sharedTmpCheck.replaceAll('"/tmp"', '"$TMP_FIXTURE"')
      .replaceAll('"/etc/grabenplaner/offsite/installed-contract.json"', '"$OFFSITE_CONTRACT_FIXTURE"');
    const result = f.run([
      "TMP_FIXTURE=" + quote(probe.replaceAll("\\", "/")),
      'OFFSITE_CONTRACT_FIXTURE="$PWD/installed-contract.json"',
      "GRABENPLANER_OFFSITE_CONFIGURED=" + (hasOffsite && !installed ? "1" : "0"),
      'stat() { [[ "$1" == --format=%u:%g:%a && "$2" == -- && "$3" == "$TMP_FIXTURE" ]] || exit 90; printf "%s\\n" ' + quote(metadata) + '; }',
      'getent() { [[ "$1" == passwd ]] || exit 91; printf "%s\\n" "$2" >> accounts; [[ "$2" != ' + quote(scenario === "missing-offsite-account" ? "grabenplaner-offsite" : "") + ' ]]; }',
      // Execute native permission-test syntax; model the account switch and an
      // effective ACL denial, which Unix ownership cannot express on Windows.
      'runuser() {',
      ' [[ "$1" == --user && "$3" == -- && "$4" == test && "$6" == "$TMP_FIXTURE" ]] || exit 92;',
      ' printf "%s:%s\\n" "$2" "$5" >> access;',
      ' test "$5" "$6" || return "$?";',
      ' [[ "$2:$5" != ' + quote(deniedAccount + ":" + deniedAccess) + ' ]]',
      '}',
      'chmod() { printf "chmod\\n" >> mutations; exit 93; }',
      'chown() { printf "chown\\n" >> mutations; exit 94; }',
      checks,
      'gp_assert_shared_tmp app-fixture build-fixture',
      'printf "next-deploy-phase\\n"',
    ].join("\n"));
    assert.ifError(result.error);
    const readLines = name => fs.existsSync(path.join(f.root, name)) ? fs.readFileSync(path.join(f.root, name), "utf8").trim().split("\n") : [];
    assert.equal(fs.existsSync(path.join(f.root, "mutations")), false, "preflight never repairs /tmp");
    const structuralFailure = ["mode-0700", "mode-0777", "mode-3777", "wrong-owner", "wrong-group", "file", "link"].includes(scenario);
    if (structuralFailure) {
      assert.equal(result.status, 42, result.stderr);
      assert.deepEqual(readLines("accounts"), []);
      assert.deepEqual(readLines("access"), []);
      assert.equal(result.stdout, "");
    } else {
      const accounts = ["app-fixture", "build-fixture", ...(hasOffsite ? ["grabenplaner-offsite"] : [])];
      const reachedAccounts = deniedAccount ? accounts.slice(0, accounts.indexOf(deniedAccount) + 1) : accounts;
      assert.deepEqual(readLines("accounts"), reachedAccounts);
      const expectedAccess = [];
      for (const account of accounts) {
        if (scenario === "missing-offsite-account" && account === "grabenplaner-offsite") break;
        for (const access of ["-w", "-x"]) {
          expectedAccess.push(account + ":" + access);
          if (account === deniedAccount && access === deniedAccess) break;
        }
        if (account === deniedAccount) break;
      }
      assert.deepEqual(readLines("access"), expectedAccess);
      if (scenario.endsWith("denied") || scenario === "missing-offsite-account") {
        assert.equal(result.status, 42, result.stderr);
        assert.match(result.stderr, scenario === "missing-offsite-account" ? /Konto fehlt/ : /nicht schreiben oder durchsuchen/);
        assert.equal(result.stdout, "");
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "next-deploy-phase\n");
      }
    }
  });
}

for (const scenario of ["enough", "low", "invalid"]) {
  test("preflight shell parses filesystem blocks with restricted IFS: " + scenario, { skip: !fs.existsSync(bash) }, t => {
    const f = fixture(t);
    const blocks = scenario === "invalid" ? "invalid" : scenario === "low" ? "1000 4096" : "20000000 4096";
    const result = f.run([
      "app_dir=/installed/app", "data_dir=/data", "backup_probe=/backups", "build_cache=/cache",
      "minimum_free_bytes=75161927680",
      "stat() {",
      "  if [[ \"$2\" == '--format=%i' ]]; then printf 'device-1\\n';",
      "  else printf '" + blocks + "\\n'; printf 'probe\\n' >> probes; fi",
      "}",
      section("free_bytes_for() {", 'checked_at="'),
      "printf '%s\\n' \"$available\"",
    ].join("\n"));
    if (scenario === "enough") {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "81920000000");
      assert.equal(fs.readFileSync(path.join(f.root, "probes"), "utf8"), "probe\n", "one probe per device");
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, scenario === "low" ? /weniger als/ : /nicht pruefbar/);
    }
  });
}

for (const scenario of ["old-installed-helper", "unsafe-candidate", "wrong-data-root", "wrong-backup-root", "invalid-recovery-files", "failed-installed-contract"]) {
  test("preflight validates candidate recovery code and installed contracts: " + scenario, { skip: !fs.existsSync(bash) }, t => {
    const f = fixture(t);
    f.write("installed/server-tools/linux/lib/verify-package.js", "require('node:fs').appendFileSync(process.env.TEST_EVENTS,'installed-contract\\n'); process.exit(" + (scenario === "failed-installed-contract" ? 1 : 0) + ");");
    f.write("installed/server-tools/linux/lib/verify-install-tree.js", "require('node:fs').appendFileSync(process.env.TEST_EVENTS,'installed-tree\\n');");
    f.write("installed/server-tools/linux/lib/postgresql-operations.js", "throw Error('old installed helper has no recovery-files-preflight');");
    f.write("installed/node_modules/preflight-installed-dependency/index.js", "module.exports=true;");
    f.write("candidate/package.json", "{}");
    f.write("candidate/server-tools/linux/lib/postgresql-operations.js", "// Sibling identifies candidate source root.\n");
    f.write("candidate/lib/persistence/postgresql/operations/runtime.js", [
      "require('preflight-installed-dependency');",
      "exports.loadConfiguration = file => {",
      " require('node:assert/strict').equal(file,'/etc/grabenplaner/postgresql-operations.json');",
      " return {sourceFiles:" + (scenario === "wrong-data-root" ? "'/wrong-data'" : "process.env.TEST_DATA")
        + ",backupDirectory:" + (scenario === "wrong-backup-root" ? "'/wrong-backup'" : "process.env.TEST_BACKUP") + "};",
      "};",
      "exports.recoveryFilesPreflight = root => {",
      " require('node:assert/strict').equal(root,process.env.TEST_DATA);",
      scenario === "invalid-recovery-files" ? "throw Error('PG_PAIR_COMPONENT_PATH secret-value');" : "require('node:fs').appendFileSync(process.env.TEST_EVENTS,'candidate-recovery\\n'); return {verified:true};",
      "};",
    ].join("\n"));
    // Model Linux uid/mode bits only; shell, files and module resolution are real.
    f.write("linux-stat.cjs", [
      "const fs=require('node:fs'), stat=fs.lstatSync;",
      "fs.lstatSync = function(file) {",
      " const value=stat.call(this,file);",
      " value.uid=" + (scenario === "unsafe-candidate" ? "String(file).endsWith('runtime.js')?1000:0" : "0") + ";",
      " value.mode=value.isDirectory()?0o40755:0o100644;",
      " return value;",
      "};",
    ].join("\n"));
    const result = f.run([
      'app_dir="$PWD/installed"',
      'SCRIPT_DIR="$PWD/candidate/server-tools/linux"',
      'data_dir="$TEST_DATA"',
      'backup_dir="$TEST_BACKUP"',
      "database_provider=postgresql",
      section('installed_runtime_verifier="', '# The optional module'),
    ].join("\n"), {
      NODE_OPTIONS: "--require=" + JSON.stringify(path.join(f.root, "linux-stat.cjs")),
      TEST_EVENTS: path.join(f.root, "events"), TEST_DATA: "/synthetic-data", TEST_BACKUP: "/synthetic-backups",
    });
    const events = fs.existsSync(path.join(f.root, "events")) ? fs.readFileSync(path.join(f.root, "events"), "utf8") : "";
    assert.match(events, /^installed-contract\n/);
    if (scenario === "old-installed-helper") {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(events, "installed-contract\ninstalled-tree\ncandidate-recovery\n");
    } else {
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(events, /candidate-recovery/);
    }
    assert.doesNotMatch(result.stdout + result.stderr, /secret-value/);
    if (["wrong-data-root", "wrong-backup-root"].includes(scenario)) {
      assert.match(result.stderr, /PG_OPERATIONS_PATH_BINDING/);
    }
  });
}

for (const scenario of ["green", "restore-failed", "restore-missing", "backup-failed", "no-module", "configured-missing-module", "symlink-status", "invalid-status"]) {
  test("preflight fails closed on protected Offsite status: " + scenario, { skip: !fs.existsSync(bash) }, t => {
    const f = fixture(t);
    const status = {
      format: "grabenplaner-offsite-backup-status", schemaVersion: 2, configured: true, state: "ok",
      lastSuccessAt: "2026-01-01T00:00:00Z", lastFullCheckAt: "2026-01-01T00:00:00Z", lastRestoreTestAt: "2026-01-01T00:00:00Z",
      unresolvedFailures: { backup: false, fullCheck: false, restoreTest: false },
      lastError: { summary: "do-not-print-private-status" },
    };
    if (scenario === "restore-failed") { status.unresolvedFailures.restoreTest = true; status.state = "error"; }
    if (scenario === "backup-failed") status.unresolvedFailures.backup = true;
    if (scenario === "restore-missing") status.lastRestoreTestAt = null;
    if (!["no-module", "configured-missing-module"].includes(scenario)) f.write("contract.json", JSON.stringify({ format: "grabenplaner-linux-offsite-installed-contract", schemaVersion: 1, moduleVersion: 10 }));
    f.write("status.json", scenario === "invalid-status" ? "malformed do-not-print-private-status" : JSON.stringify(status));
    f.write("offsite-fixture.cjs", [
      "const fs=require('node:fs'), path=require('node:path');",
      "const files=new Map([",
      " ['/etc/grabenplaner/offsite/installed-contract.json',path.join(__dirname,'contract.json')],",
      " ['/var/lib/grabenplaner-offsite/status.json',path.join(__dirname,'status.json')],",
      "]);",
      "const stat=fs.lstatSync, realpath=fs.realpathSync, open=fs.openSync;",
      "fs.lstatSync = function(file) {",
      " const value=stat.call(this,files.get(file)||file);",
      " if(files.has(file)) { value.uid=0; value.mode=0o100640; }",
      scenario === "symlink-status" ? "if(String(file).endsWith('/status.json'))value.isSymbolicLink=()=>true;" : "",
      " return value;",
      "};",
      "fs.realpathSync = function(file) { return files.has(file)?file:realpath.call(this,file); };",
      "fs.openSync = function(file,...args) { return open.call(this,files.get(file)||file,...args); };",
    ].join("\n"));
    const result = f.run(section('# The optional module', 'free_bytes_for() {'), {
      NODE_OPTIONS: "--require=" + JSON.stringify(path.join(f.root, "offsite-fixture.cjs")),
      GRABENPLANER_OFFSITE_CONFIGURED: scenario === "no-module" ? "0" : "1",
    });
    if (["green", "no-module"].includes(scenario)) assert.equal(result.status, 0, result.stderr);
    else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Recovery Assurance abschliessen/);
    }
    assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-private-status/);
  });
}
