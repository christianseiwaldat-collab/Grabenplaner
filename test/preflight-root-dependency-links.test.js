"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../server-tools/linux/preflight-grabenplaner-deploy.sh"), "utf8").replace(/\r\n/g, "\n");
const guards = [...source.matchAll(/  function trustedDependencyBinLink\(file, dependencyRoot\) \{[\s\S]*?(?=\n  for \(let directory = root;)/g)].map(match => match[0]);
const native = { skip: process.platform !== "linux" || process.getuid?.() !== 0 };

test("both preflight trust boundaries use the same narrow dependency-bin guard", () => {
  assert.equal(guards.length, 2);
  assert.equal(guards[0], guards[1]);
  assert.match(source, /const dependencyRoots = \[path\.join\(root, 'node_modules'\)\];/);
  assert.ok(source.includes("const dependencyRoots = [path.join(root, 'node_modules'), path.join(installedRoot, 'node_modules')];"));
  assert.match(source, /fs\.lstatSync\(path\.join\(root, 'node_modules'\)\); localModulesPresent = true;/);
  for (const guard of guards) new vm.Script(`(function () { ${guard}; return trusted; })`);
});

function fixture(t) {
  const root = fs.mkdtempSync("/root/gp-preflight-root-links-");
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), "/root");
    assert.match(path.basename(root), /^gp-preflight-root-links-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const app = path.join(root, "app"), modules = path.join(app, "node_modules"), bin = path.join(modules, ".bin");
  fs.mkdirSync(bin, { recursive: true, mode: 0o755 });
  const payload = path.join(modules, "pkg", "cli.js");
  fs.mkdirSync(path.dirname(payload), { mode: 0o755 });
  fs.writeFileSync(payload, "throw Error('fixture code must never be imported');\n", { mode: 0o644 });
  const link = path.join(bin, "tool");
  function symlink(target, name = link, uid = 0) {
    fs.symlinkSync(target, name);
    fs.lchownSync(name, uid, 982);
    assert.equal(fs.lstatSync(name).mode & 0o777, 0o777);
    return name;
  }
  return { root, app, modules, bin, payload, link, symlink };
}

function trusted(implementation, roots) {
  const code = `(function () { const fs = require('node:fs'), path = require('node:path');
    const dependencyRoots = roots; ${implementation}; return trusted; })()`;
  return new vm.Script(code).runInNewContext({ roots, require(name) {
    assert.ok(["node:fs", "node:path"].includes(name), "no application or fixture imports");
    return require(name);
  } });
}

function verifyBoth(f, accepted, probe = f.link) {
  const before = fs.readFileSync(f.payload);
  for (const implementation of guards) {
    const inspect = trusted(implementation, [f.modules]);
    if (accepted) { inspect(f.app, true); inspect(probe); }
    else {
      assert.throws(() => inspect(f.app, true), /unsafe|ENOENT|ELOOP|ENOTDIR/);
      assert.throws(() => inspect(probe), /unsafe|ENOENT|ELOOP|ENOTDIR/);
    }
  }
  assert.deepEqual(fs.readFileSync(f.payload), before, "tree inspection is read-only");
}

test("root-protected installed topology accepts ten top-level and one nested bin links without changing mode777", native, t => {
  const f = fixture(t);
  const names = ["mkdirp", "opencollective-postinstall", "sha.js", "fxparser", "uuid", "semver", "rimraf", "is-docker", "is-inside-container", "crc32"];
  for (const name of names) f.symlink("../pkg/cli.js", path.join(f.bin, name));
  const nestedBin = path.join(f.modules, "tesseract.js/node_modules/.bin");
  fs.mkdirSync(nestedBin, { recursive: true, mode: 0o755 });
  const nested = f.symlink("../../../pkg/cli.js", path.join(nestedBin, "opencollective-postinstall"));
  verifyBoth(f, true, nested);
  for (const link of [...names.map(name => path.join(f.bin, name)), nested]) {
    assert.equal(fs.lstatSync(link).uid, 0); assert.equal(fs.lstatSync(link).gid, 982);
    assert.equal(fs.lstatSync(link).mode & 0o777, 0o777); assert.equal(fs.lstatSync(link).nlink, 1);
  }
});

test("protected bin-to-bin link chains and absolute in-tree regular targets are accepted", native, t => {
  const f = fixture(t);
  f.symlink("tool-two"); f.symlink(f.payload, path.join(f.bin, "tool-two"));
  verifyBoth(f, true);
});

const negativeCases = {
  "relative target outside dependency root": f => {
    const outside = path.join(f.root, "outside.js"); fs.writeFileSync(outside, "outside\n"); f.symlink("../../../outside.js");
  },
  "absolute target outside dependency root": f => { f.symlink(path.join(f.root, "outside.js")); },
  "external-then-back lexical path despite final realpath inside": f => {
    f.symlink("../../node_modules/pkg/cli.js"); assert.equal(fs.realpathSync(f.link), f.payload);
  },
  "external-then-back directory link despite final realpath inside": f => {
    fs.symlinkSync(path.dirname(f.payload), path.join(f.root, "back"));
    fs.symlinkSync(path.join(f.root, "back"), path.join(f.modules, "redirect"));
    f.symlink("../redirect/cli.js"); assert.equal(fs.realpathSync(f.link), f.payload);
  },
  "dangling link": f => { f.symlink("../pkg/missing.js"); },
  "link cycle": f => { f.symlink("tool-two"); f.symlink("tool", path.join(f.bin, "tool-two")); },
  "foreign link owner": f => { f.symlink("../pkg/cli.js", f.link, 61001); },
  "hardlinked symbolic link": f => { f.symlink("../pkg/cli.js"); fs.linkSync(f.link, path.join(f.bin, "tool-two")); },
  "foreign intermediate directory owner": f => { f.symlink("../pkg/cli.js"); fs.chownSync(path.dirname(f.payload), 61001, 982); },
  "writable intermediate directory": f => { f.symlink("../pkg/cli.js"); fs.chmodSync(path.dirname(f.payload), 0o775); },
  "foreign bin directory owner": f => { f.symlink("../pkg/cli.js"); fs.chownSync(f.bin, 61001, 982); },
  "writable bin directory": f => { f.symlink("../pkg/cli.js"); fs.chmodSync(f.bin, 0o775); },
  "foreign final file owner": f => { f.symlink("../pkg/cli.js"); fs.chownSync(f.payload, 61001, 982); },
  "writable final file": f => { f.symlink("../pkg/cli.js"); fs.chmodSync(f.payload, 0o664); },
  "hardlinked final file": f => { f.symlink("../pkg/cli.js"); fs.linkSync(f.payload, path.join(f.modules, "another.js")); },
  "directory final target": f => { f.symlink("../pkg"); },
  "FIFO final target without opening it": f => {
    const fifo = path.join(f.modules, "fifo");
    const result = spawnSync("/usr/bin/mkfifo", [fifo], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
    assert.equal(result.status, 0, result.stderr); f.symlink("../fifo");
  },
  "arbitrary package directory link": f => { fs.symlinkSync("pkg", path.join(f.modules, "package-alias")); return path.join(f.modules, "package-alias"); },
  "arbitrary package file link": f => { fs.symlinkSync("cli.js", path.join(f.modules, "pkg/alias.js")); return path.join(f.modules, "pkg/alias.js"); },
  "application source link": f => { fs.symlinkSync(f.payload, path.join(f.app, "source.js")); return path.join(f.app, "source.js"); },
};
for (const [name, mutate] of Object.entries(negativeCases)) test(`dependency-bin trust rejects ${name}`, native, t => {
  const f = fixture(t), probe = mutate(f) || f.link;
  verifyBoth(f, false, probe);
});

test("each guard rejects a dangling node_modules root instead of following or skipping it", native, t => {
  const f = fixture(t);
  fs.rmSync(f.modules, { recursive: true }); fs.symlinkSync("missing-modules", f.modules);
  for (const implementation of guards) {
    const inspect = trusted(implementation, [f.modules]);
    assert.throws(() => inspect(f.app, true), /unsafe|ENOENT/);
    assert.throws(() => inspect(f.modules, true), /unsafe|ENOENT/);
  }
});

test("candidate and installed dependency roots cannot authorize cross-tree bin targets", native, t => {
  const f = fixture(t), second = path.join(f.root, "installed/node_modules");
  fs.mkdirSync(path.join(second, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(second, "pkg/cli.js"), "not imported\n");
  f.symlink(path.join(second, "pkg/cli.js"));
  const inspect = trusted(guards[1], [f.modules, second]);
  assert.throws(() => inspect(f.app, true), /unsafe/);
  assert.throws(() => inspect(f.link), /unsafe/);
});

function runActualBootstrap(f, section, installedApp = f.app) {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const rootNode = source.match(/^root_node\(\) \{\n[\s\S]*?^\}/m)?.[0];
  assert.ok(rootNode);
  const script = ["set -Eeuo pipefail", "IFS=$'\\n\\t'", `node=${quote(process.execPath)}`,
    `app_dir=${quote(installedApp)}`, `SCRIPT_DIR=${quote(path.join(f.app, "server-tools/linux"))}`,
    `data_dir=${quote(path.join(f.root, "data"))}`, `backup_dir=${quote(path.join(f.root, "backups"))}`,
    'gp_die() { printf "%s\\n" "$*" >&2; exit 42; }', rootNode, section].join("\n");
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-s"], {
    input: script, encoding: "utf8", timeout: 15000, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
}

for (const unsafe of [false, true]) test(`actual installed-tree bootstrap ${unsafe ? "rejects before verifier execution" : "admits protected bin topology then executes both verifiers"}`, native, t => {
  const f = fixture(t), marker = path.join(f.root, "verifier-loaded");
  f.symlink("../pkg/cli.js");
  const lib = path.join(f.app, "server-tools/linux/lib"); fs.mkdirSync(lib, { recursive: true });
  for (const name of ["verify-package.js", "verify-install-tree.js"]) {
    fs.writeFileSync(path.join(lib, name), `require('node:fs').appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name + "\n")});\n`);
  }
  if (unsafe) fs.chmodSync(f.bin, 0o775);
  const start = source.indexOf('installed_runtime_verifier="$app_dir/server-tools/linux/lib/verify-package.js"');
  const end = source.indexOf('if [[ "$database_provider" == postgresql ]]; then', start);
  assert.ok(start >= 0 && end > start);
  const result = runActualBootstrap(f, source.slice(start, end));
  assert.equal(result.status, unsafe ? 42 : 0, result.stderr || result.error?.message);
  if (unsafe) assert.equal(fs.existsSync(marker), false, "unsafe tree must fail before any installed verifier code");
  else assert.equal(fs.readFileSync(marker, "utf8"), "verify-package.js\nverify-install-tree.js\n");
});

for (const state of ["safe", "unsafe-bin", "unsafe-installed", "dangling-module-root"]) test(`actual candidate PostgreSQL bootstrap ${state} checks both trees before loading its runtime`, native, t => {
  const f = fixture(t), marker = path.join(f.root, "candidate-runtime-loaded");
  f.symlink("../pkg/cli.js");
  const lib = path.join(f.app, "server-tools/linux/lib"), runtime = path.join(f.app, "lib/persistence/postgresql/operations/runtime.js");
  fs.mkdirSync(lib, { recursive: true }); fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(path.join(lib, "postgresql-operations.js"), "// guarded entry path; never imported in this test\n");
  fs.writeFileSync(path.join(f.app, "package.json"), '{"private":true}\n');
  // The only imported fixture is a protected builtins-only transport sentinel.
  // It models no database, provider, application or historical test payload.
  fs.writeFileSync(runtime, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'loaded');
    module.exports={loadConfiguration(file){if(file!=='/etc/grabenplaner/postgresql-operations.json')throw Error('wrong config');
      return {sourceFiles:${JSON.stringify(path.join(f.root, "data"))},backupDirectory:${JSON.stringify(path.join(f.root, "backups"))}};},
      recoveryFilesPreflight(){return {verified:true};}};\n`);
  if (state === "unsafe-bin") fs.chmodSync(f.bin, 0o775);
  let installedApp = f.app;
  if (state === "unsafe-installed") {
    installedApp = path.join(f.root, "installed");
    const installedBin = path.join(installedApp, "node_modules/.bin");
    fs.mkdirSync(installedBin, { recursive: true }); fs.chmodSync(installedBin, 0o775);
  }
  if (state === "dangling-module-root") { fs.rmSync(f.modules, { recursive: true }); fs.symlinkSync("missing-modules", f.modules); }
  const start = source.indexOf('  postgresql_preflight="$SCRIPT_DIR/lib/postgresql-operations.js"');
  const end = source.indexOf("\nNODE", start);
  assert.ok(start >= 0 && end > start);
  const result = runActualBootstrap(f, source.slice(start, end + "\nNODE".length), installedApp);
  assert.equal(result.status, state === "safe" ? 0 : 42, result.stderr || result.error?.message);
  assert.equal(fs.existsSync(marker), state === "safe", "runtime may only load after the actual guards accept the tree");
});


const updaterSource = fs.readFileSync(path.join(__dirname, "../server-tools/linux/update-grabenplaner-server.sh"), "utf8").replace(/\r\n/g, "\n");
const updaterGuardStart = updaterSource.indexOf('root_node - "$app_dir/node_modules" <<\'NODE\' >/dev/null');
const updaterGuardEnd = updaterSource.indexOf("\nNODE", updaterGuardStart);
const updaterGuardSection = updaterSource.slice(updaterGuardStart, updaterGuardEnd + "\nNODE".length);
const updaterRootNode = updaterSource.match(/^root_node\(\) \{[^\n]+\}/m)?.[0];
const updaterIdentityLines = updaterSource.split("\n").filter(line => line.includes('postgresql_before_identity="$(root_node "$backup_app_dir/'));
const updaterGuards = [...updaterGuardSection.matchAll(/  function trustedDependencyBinLink\(file, dependencyRoot\) \{[\s\S]*?(?=\n  for \(let directory = root;)/g)].map(match => match[0]);

// Only path/rawTarget are retained from the actual installed Core5 graph,
// observed 2026-10-24T13:03:50Z (diagnostic SHA256 b28dd1f3a86f83eb48d5d59c57700dde34a6b9aaf90cd8aee7ce8e3762b35d3e).
const installedBinLinks = [
  [".bin/mkdirp", "../mkdirp/bin/cmd.js"],
  [".bin/opencollective-postinstall", "../opencollective-postinstall/index.js"],
  [".bin/sha.js", "../sha.js/bin.js"],
  [".bin/fxparser", "../fast-xml-parser/src/cli/cli.js"],
  [".bin/uuid", "../uuid/dist/esm/bin/uuid"],
  [".bin/semver", "../semver/bin/semver.js"],
  [".bin/rimraf", "../rimraf/bin.js"],
  [".bin/is-docker", "../is-docker/cli.js"],
  [".bin/is-inside-container", "../is-inside-container/cli.js"],
  [".bin/crc32", "../crc-32/bin/crc32.njs"],
  ["tesseract.js/node_modules/.bin/opencollective-postinstall", "../../../opencollective-postinstall/index.js"]
];

test("updater protects its early installed dependency boundary before any privileged application import", () => {
  assert.ok(updaterGuardStart > 0 && updaterGuardEnd > updaterGuardStart);
  assert.ok(updaterGuardEnd < updaterSource.indexOf('package="$(gp_existing_file "$package_arg"'));
  assert.ok(updaterGuardEnd < updaterSource.indexOf('old_version="$(root_node -p'));
  assert.ok(updaterRootNode?.includes("--no-global-search-paths"));
  assert.equal(updaterIdentityLines.length, 1);
  assert.equal(updaterGuards.length, 1);
  const binAlgorithm = value => value.slice(0, value.indexOf("\n  function trusted("));
  assert.equal(binAlgorithm(updaterGuards[0]), binAlgorithm(guards[0]));
  assert.ok(updaterGuardSection.includes("const dependencyRoots = [root];"), "node_modules is already the input root");
  assert.deepEqual([...updaterGuardSection.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]), ["node:fs", "node:path"]);
  assert.ok(updaterGuardSection.includes("JSON.stringify(checking).slice(0, 600)"), "diagnostics bind only a bounded path");
  assert.equal(installedBinLinks.length, 11);
});

function addInstalledBinLinks(f) {
  for (const [relative, rawTarget] of installedBinLinks) {
    const link = path.join(f.modules, relative), target = path.resolve(path.dirname(link), rawTarget);
    assert.ok(target.startsWith(f.modules + path.sep));
    fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o755 });
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    if (!fs.existsSync(target)) fs.writeFileSync(target, "throw Error('dependency command must never be imported');\n", { mode: 0o750 });
    fs.chownSync(target, 0, 982); fs.chmodSync(target, 0o750);
    f.symlink(rawTarget, link);
  }
}

function fixtureInventory(directory) {
  const result = [];
  function visit(file, relative) {
    const s = fs.lstatSync(file);
    const row = [relative, s.uid, s.gid, s.mode, s.nlink, s.size];
    if (s.isSymbolicLink()) row.push("link", fs.readlinkSync(file));
    else if (s.isFile()) row.push("file", crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    else if (s.isDirectory()) row.push("directory");
    else row.push("special");
    result.push(row);
    if (s.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.posix.join(relative, name));
  }
  visit(directory, ".");
  return result;
}

function verifyActualUpdaterGuard(f, accepted, section = updaterGuardSection) {
  const marker = path.join(f.root, "actual-updater-pg-import");
  const identityHelper = path.join(f.app, "server-tools/linux/lib/postgresql-operations.js");
  fs.mkdirSync(path.dirname(identityHelper), { recursive: true, mode: 0o755 });
  // This protected builtins-only transport sentinel has no provider, database,
  // credentials or real application behavior. The actual updater identity call
  // may import it only after the unchanged shell guard section succeeds.
  fs.writeFileSync(identityHelper, `const fs = require('node:fs');
    require('node:assert/strict').deepEqual(process.argv.slice(2), ['identity', '/etc/grabenplaner/postgresql-operations.json']);
    fs.writeFileSync(${JSON.stringify(marker)}, 'loaded'); process.stdout.write('fixture-pair-identity');\n`);
  const before = fixtureInventory(f.app);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const script = ["set -Eeuo pipefail", "IFS=$'\\n\\t'", `node=${quote(process.execPath)}`,
    `app_dir=${quote(f.app)}`, `backup_app_dir=${quote(f.app)}`,
    'gp_die() { printf "%s\\n" "$*" >&2; exit 42; }', updaterRootNode,
    section, updaterIdentityLines[0]].join("\n");
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-s"], {
    input: script, encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, accepted ? 0 : 42, result.stderr);
  if (accepted) {
    assert.equal(result.stderr, "");
    assert.equal(fs.readFileSync(marker, "utf8"), "loaded");
  } else {
    if (section === updaterGuardSection) assert.match(result.stderr, /Unsafe installed dependency tree:/);
    else {
      assert.equal(section, predecessorUpdaterGuard, "only the exact retained predecessor guard is an alternate probe");
      assert.match(result.stderr, /Error: Unsafe installed dependency tree/);
    }
    assert.match(result.stderr, /installierten privilegierten Abhaengigkeiten/);
    if (section === updaterGuardSection) assert(result.stderr.length < 1024, "rejection diagnostic must contain a bounded path, never dependency contents");
    assert.equal(fs.existsSync(marker), false, "unsafe dependencies must fail before the actual privileged PG identity entrypoint");
  }
  assert.deepEqual(fixtureInventory(f.app), before, "the actual inline guard and isolated identity sentinel preserve every dependency byte, link and mode");
}

test("actual updater early guard accepts all eleven observed raw bin links including nested Tesseract", native, t => {
  const f = fixture(t); addInstalledBinLinks(f); verifyActualUpdaterGuard(f, true);
  for (const [relative, rawTarget] of installedBinLinks) {
    const link = path.join(f.modules, relative), info = fs.lstatSync(link);
    assert.equal(fs.readlinkSync(link), rawTarget); assert.equal(info.uid, 0); assert.equal(info.gid, 982);
    assert.equal(info.mode & 0o777, 0o777); assert.equal(info.nlink, 1);
  }
});

test("actual updater early guard also accepts a protected graph without bin links", native, t => {
  verifyActualUpdaterGuard(fixture(t), true);
});

test("actual updater early guard accepts protected bin chains with absolute same-tree targets", native, t => {
  const f = fixture(t); f.symlink("tool-two"); f.symlink(f.payload, path.join(f.bin, "tool-two"));
  verifyActualUpdaterGuard(f, true);
});

// The early updater guard covers dependencies and their ancestor directories.
// The existing full preflight cases above additionally cover application files.
for (const [name, mutate] of Object.entries(negativeCases).filter(([name]) => name !== "application source link")) {
  test(`actual updater early guard rejects ${name} before privileged PG import`, native, t => {
    const f = fixture(t); mutate(f); verifyActualUpdaterGuard(f, false);
  });
}
for (const [name, mutate] of Object.entries({
  "dangling node_modules root": f => { fs.rmSync(f.modules, { recursive: true }); fs.symlinkSync("missing-modules", f.modules); },
  "foreign node_modules owner": f => { fs.chownSync(f.modules, 61001, 982); },
  "writable node_modules root": f => { fs.chmodSync(f.modules, 0o775); },
  "foreign application ancestor": f => { fs.chownSync(f.app, 61001, 982); },
  "writable application ancestor": f => { fs.chmodSync(f.app, 0o775); },
})) test(`actual updater early guard rejects ${name} before privileged PG import`, native, t => {
  const f = fixture(t); mutate(f); verifyActualUpdaterGuard(f, false);
});


// Exact early-guard shell bytes from c2223c8; this immutable predecessor probe
// reproduces the observed rejection without changing or running an old updater.
const predecessorUpdaterGuard = String.raw`root_node - "$app_dir/node_modules" <<'NODE' >/dev/null \
  || gp_die "Die installierten privilegierten Abhaengigkeiten sind nicht vollstaendig root-geschuetzt."
const fs = require('node:fs'), path = require('node:path');
const root = process.argv[2];
function trusted(file, recursive) {
  const info = fs.lstatSync(file);
  if (fs.realpathSync(file) !== file || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)
      || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw Error('Unsafe installed dependency tree');
  if (recursive && info.isDirectory()) for (const name of fs.readdirSync(file)) trusted(path.join(file, name), true);
}
for (let parent = path.dirname(root);; parent = path.dirname(parent)) { trusted(parent, false); if (parent === '/') break; }
trusted(root, true);
NODE`;

test("unchanged predecessor updater guard rejects the same eleven raw links before privileged PG import", native, t => {
  assert.equal(crypto.createHash("sha256").update(predecessorUpdaterGuard).digest("hex"), "9320faeb0e8fe9dc57841e1c975b2521d17f0af031fb64684a458c39558061f1");
  const f = fixture(t); addInstalledBinLinks(f); verifyActualUpdaterGuard(f, false, predecessorUpdaterGuard);
});
