"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process"), test = require("node:test");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

for (const file of ["update-grabenplaner-server.sh", "migrate-grabenplaner-runtime-v6.sh"]) {
  const source = fs.readFileSync(path.join(__dirname, "../server-tools/linux", file), "utf8");
    test(file + " isolates privileged Node preloads, global module lookup, output files and unrelated secrets",
      { skip: !fs.existsSync(bash) }, t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-runtime-root-env-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const marker = path.join(root, "root-preload-executed"), warnings = path.join(root, "privileged-warnings"), coverage = path.join(root, "privileged-coverage");
        const preload = path.join(root, "untrusted-preload.cjs");
        fs.writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'untrusted root code');`);
        const name = "root_node";
        const implementation = source.match(new RegExp("^" + name + "\\(\\) \\{[^\\n]+\\}", "m"))?.[0]; assert.ok(implementation);
        fs.writeFileSync(path.join(root, "probe.sh"), ["set -Eeuo pipefail", "node=" + quote(process.execPath.replaceAll("\\", "/")),
          'app_dir="$PWD/installed"', implementation, name + " - <<'NODE'", "process.emitWarning('synthetic-runtime-warning');",
          "process.stdout.write(JSON.stringify({ keys:Object.keys(process.env).sort(), globalPaths:require('node:module').globalPaths, nodePath:process.env.NODE_PATH||null }));", "NODE"].join("\n"));
        const result = spawnSync(bash, ["--noprofile", "--norc", "probe.sh"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 15000,
          env: { ...process.env, NODE_OPTIONS: "--require=" + JSON.stringify(preload), NODE_PATH: path.join(root, "untrusted-modules"),
            NODE_REDIRECT_WARNINGS: warnings, NODE_V8_COVERAGE: coverage, NODE_EXTRA_CA_CERTS: path.join(root, "untrusted-ca"),
            UNRELATED_PRIVATE_VALUE: "synthetic-sensitive-runtime-value" } });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        const value = JSON.parse(result.stdout), expected = ["HOME", "LANG", "NODE_ENV", "PATH"];
        if (process.platform === "win32") expected.push("MSYSTEM", "SYSTEMROOT", "WINDIR");
        assert.deepEqual(value.keys, expected.sort());
        assert.equal(value.nodePath, null); assert.deepEqual(value.globalPaths, []);
        for (const target of [marker, warnings, coverage]) assert.equal(fs.existsSync(target), false, target);
        assert.match(result.stderr, /synthetic-runtime-warning/); assert.doesNotMatch(result.stdout + result.stderr, /synthetic-sensitive-runtime-value|untrusted-ca/);
      });
}
