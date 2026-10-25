"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const { exactFile, targetPath } = require("../test-support/passkeys-browser/prepare.cjs");
const root = path.resolve(__dirname, ".."), pin = require("../test-support/passkeys-browser/browser-lock.json");
test("Passkey browser artifacts reject changed bytes and indirect paths", t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gp-browser-tool-")); t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const file = path.join(temporary, "browser"), bytes = Buffer.from("synthetic executable bytes"); fs.writeFileSync(file, bytes);
  const expected = { bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  assert.equal(exactFile(file, expected), file); fs.writeFileSync(file, Buffer.from("changed executable bytes!"));
  assert.throws(() => exactFile(file, expected));
  fs.writeFileSync(file, bytes);
  const linked = path.join(temporary, "linked"); fs.linkSync(file, linked); assert.throws(() => exactFile(linked, expected));
});
test("Passkey browser preparation remains in a new canonical temporary directory", t => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gp-browser-target-"))); t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const fresh = path.join(temporary, "fresh"); assert.equal(targetPath(fresh, temporary), fresh);
  assert.throws(() => targetPath(root, temporary)); fs.mkdirSync(fresh); assert.throws(() => targetPath(fresh, temporary));
});
test("Passkey browser dependency supply is separately frozen and excluded from the product graph", () => {
  const product = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); assert.equal(product.dependencies.playwright, undefined);
  const tool = require("../test-support/passkeys-browser/package.json"); assert.equal(tool.packageManager, "pnpm@11.7.0");
  assert.deepEqual(tool.dependencies, { playwright: "1.64.1" }); assert.equal(pin.playwright, tool.dependencies.playwright);
  assert.match(fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"), /^packages:\r?\n  - '\.'/);
  const lock = fs.readFileSync(path.join(root, "test-support/passkeys-browser/pnpm-lock.yaml"), "utf8");
  assert.match(lock, /playwright-core@1\.64\.1:/); assert.match(lock, /sha512-/); assert.doesNotMatch(lock, /(?:^|[\s{])(?:https?:\/\/|file:|link:)/);
});
test("CI rejects browser/upgrade execution outside its explicit full first shard before accessing any database", () => {
  const runner = path.join(root, "test-support/postgresql-migration/ci-stock-import-delete.js");
  for (const args of [["--passkeys-browser"], ["--full", "--application-shard", "2/3", "--passkeys-browser"],
    ["--full", "--application-shard", "1/3", "--passkeys-browser", "--passkeys-browser"],
    ["--bootstrap-only", "--bootstrap-before-passkeys", "--passkeys-browser"]]) {
    const result = spawnSync(process.execPath, [runner, ...args], { cwd: root, env: { ...process.env, TEST_POSTGRESQL_URL: "" }, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /Passkeys browser qualification requires explicit full shard 1\/3/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|password authentication|Invalid URL/);
  }
});
test("CI permanently requires old-schema restore, native FIDO and the unchanged complete application suite", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /if: matrix\.shard == '1\/3'/); assert.match(workflow, /install -y --no-install-recommends postgresql-18/);
  assert.match(workflow, /arguments\+=\(--passkeys-browser\)/); assert.match(workflow, /node test-support\/passkeys-browser\/write-ci-environment\.cjs/);
  const runner = fs.readFileSync(path.join(root, "test-support/postgresql-migration/ci-stock-import-delete.js"), "utf8");
  assert.match(runner, /delete env\.GP_WINDOW_BROWSER_TEST/); assert.match(runner, /delete env\.GP_PASSKEYS_UPGRADE_FIXTURE/);
  assert.match(runner, /delete env\.GP_SECURITY_AUTH_BROWSER_TEST/); assert.match(runner, /GP_SECURITY_AUTH_BROWSER_TEST:'1'/);
  assert.match(runner, /test\/passkeys-upgrade-restore-postgresql\.test\.js/); assert.match(runner, /GP_PASSKEYS_UPGRADE_FIXTURE:'before-passkeys-v1'/);
  assert.match(runner, /const upgradeCommand=\[.*'--test-timeout=420000'/);
  assert.match(workflow, /test\/passkey-key-policy\.test\.js/);
  for (const file of ["passkey-protocol-browser", "passkeys-management-browser", "passkey-auth-browser", "passkey-application-api", "security-reauthentication-ui"]) assert(runner.includes(`test/${file}.test.js`));
  assert.match(runner, /'--test-timeout=180000',\.\.\.\(shard\?\['--test-shard='\+shard\]:\[\]\)/);
});
