"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const commonPath = path.join(root, "server-tools/linux/lib/common.sh");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const posixOnly = { skip: process.platform === "win32" ? "POSIX-Verhalten wird nur auf Linux/macOS ausgefuehrt." : false };

function runParser(contents) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-env-parser-"));
  const environmentFile = path.join(temporary, "grabenplaner.env");
  const injectionMarker = path.join(temporary, "injection-marker");
  fs.writeFileSync(environmentFile, contents, { mode: 0o600 });
  const script = [
    'source "$1"',
    "gp_assert_secure_env_file() { :; }",
    'gp_load_env_file "$2"',
    `printf '%s\\n' "\${SAFE_VALUE-}" "\${INJECTED-}" "\${BACKTICK-}" "\${EMPTY_VALUE-unset}"`,
  ].join("\n");
  const result = spawnSync("bash", ["-c", script, "grabenplaner-env-test", commonPath, environmentFile, injectionMarker], { encoding: "utf8" });
  return { ...result, temporary, environmentFile, injectionMarker };
}

test("v0.75 parses environment values literally without source or eval", posixOnly, (context) => {
  const result = runParser([
    "# root-only fixture",
    "SAFE_VALUE=alpha beta # literal",
    "INJECTED=$(touch \"$3\")",
    "BACKTICK=`touch \"$3\"`",
    "line_number=literal parser collision",
    "EMPTY_VALUE=",
    "",
  ].join("\n"));
  context.after(() => fs.rmSync(result.temporary, { recursive: true, force: true }));

  assert.equal(result.status, 0, result.stderr);
  const outputLines = result.stdout.replaceAll("\r\n", "\n").split("\n");
  assert.equal(outputLines.pop(), "");
  assert.deepEqual(outputLines, [
    "alpha beta # literal",
    "$(touch \"$3\")",
    "`touch \"$3\"`",
    "",
  ]);
  assert.equal(fs.existsSync(result.injectionMarker), false);
});

test("v0.75 rejects duplicate and malformed environment keys", posixOnly, (context) => {
  const duplicate = runParser("PORT=3000\nPORT=3001\n");
  const malformed = runParser("NODE_ENV=production\nNOT AN ASSIGNMENT\n");
  context.after(() => {
    fs.rmSync(duplicate.temporary, { recursive: true, force: true });
    fs.rmSync(malformed.temporary, { recursive: true, force: true });
  });

  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /doppelt vorhanden/);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /erwartet wird KEY=VALUE/);
});

test("v0.75 strict grammar accepts every existing installer environment entry", () => {
  const entries = read("server-tools/linux/grabenplaner.env.example")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"));
  const keys = [];
  for (const entry of entries) {
    const match = entry.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    assert.ok(match, `Installerwert liegt nicht als einfaches KEY=VALUE vor: ${entry}`);
    keys.push(match[1]);
  }
  assert.equal(new Set(keys).size, keys.length, "Das Installer-Template darf keine doppelten Schluessel enthalten.");
});

test("v0.75 environment files require an unlinked root-only regular file", () => {
  const common = read("server-tools/linux/lib/common.sh");
  assert.match(common, /\[\[ -f "\$requested" && ! -L "\$requested" \]\]/);
  assert.match(common, /stat --format='%u'/);
  assert.match(common, /stat --format='%g'/);
  assert.match(common, /stat --format='%a'/);
  assert.match(common, /stat --format='%h'/);
  assert.match(common, /"\$owner" == "0" && "\$group" == "0"/);
  assert.match(common, /"\$mode" == "600"/);
  assert.match(common, /"\$links" == "1"/);
  assert.doesNotMatch(common, /\bsource\s+"\$file"/);
  assert.doesNotMatch(common, /\beval\b/);
});

test("v0.75 internal-error logs use a query-free request path", () => {
  const server = read("server.js");
  assert.match(server, /status >= 500\) console\.error\(`\[\$\{requestId\}\] \$\{request\.method\} \$\{request\.path\}`/);
  assert.doesNotMatch(server, /request\.originalUrl/);
});
