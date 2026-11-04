"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../server-tools/linux/preflight-grabenplaner-deploy.sh"), "utf8").replace(/\r\n/g, "\n");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

test("preflight Node environment rejects inherited preloads, global search and privileged file outputs",
    { skip: !fs.existsSync(bash) }, t => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gp-preflight-root-env-"));
      t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
      const marker = path.join(temporary, "preload-executed"), warnings = path.join(temporary, "warnings"), coverage = path.join(temporary, "coverage");
      const preload = path.join(temporary, "preload.cjs");
      fs.writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');`);
      const name = "root_node";
      const implementation = source.match(new RegExp("^" + name + "\\(\\) \\{\\n[\\s\\S]*?^\\}", "m"))?.[0];
      assert.ok(implementation);
      fs.writeFileSync(path.join(temporary, "run.sh"), [
        "set -Eeuo pipefail", "IFS=$'\\n\\t'",
        "node=" + quote(process.execPath.replaceAll("\\", "/")),
        'app_dir="$PWD/installed"', implementation,
        name + " - <<'NODE'",
        "process.emitWarning('synthetic-preflight-warning');",
        "require('node:assert/strict').ok(process.execArgv.includes('--no-global-search-paths'));",
        "process.stdout.write(JSON.stringify({keys:Object.keys(process.env).sort(),nodePath:process.env.NODE_PATH||null}));",
        "NODE",
      ].join("\n"));
      const result = spawnSync(bash, ["--noprofile", "--norc", "run.sh"], {
        cwd: temporary, encoding: "utf8", windowsHide: true, timeout: 15000,
        env: { ...process.env, NODE_OPTIONS: "--require=" + JSON.stringify(preload),
          NODE_PATH: path.join(temporary, "untrusted"), NODE_REDIRECT_WARNINGS: warnings,
          NODE_V8_COVERAGE: coverage, NODE_EXTRA_CA_CERTS: path.join(temporary, "untrusted-ca"),
          UNRELATED_PRIVATE_VALUE: "synthetic-sensitive-value" },
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const observed = JSON.parse(result.stdout);
      const expectedKeys = ["HOME", "LANG", "NODE_ENV", "PATH"];
      // Git Bash must add Windows process-launch metadata after env -i.
      if (process.platform === "win32") expectedKeys.push("MSYSTEM", "SYSTEMROOT", "WINDIR");
      assert.deepEqual(observed.keys, expectedKeys.sort());
      assert.equal(observed.nodePath, null);
      for (const file of [marker, warnings, coverage]) assert.equal(fs.existsSync(file), false, file);
      assert.match(result.stderr, /synthetic-preflight-warning/);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-sensitive-value|untrusted-ca/);
    });
