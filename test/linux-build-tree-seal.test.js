"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const assert = require("node:assert/strict"), test = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const common = fs.readFileSync(path.join(__dirname, "../server-tools/linux/lib/common.sh"), "utf8");
const selected = ["gp_apply_app_permissions", "gp_seal_build_tree", "gp_verify_sealed_zip"].map(name => {
  const body = common.match(new RegExp("^" + name + "\\(\\) \\{[\\s\\S]*?^\\}", "m"))?.[0]; assert(body); return body;
}).join("\n");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-root-seal-")); fs.chmodSync(root, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "build"), target = path.join(root, "sealed");
  fs.mkdirSync(path.join(source, "server-tools/linux/lib"), { recursive: true, mode: 0o755 });
  for (const name of ["server-tools/linux/update-grabenplaner-server.sh", "server-tools/linux/lib/common.sh", "program.js"]) {
    fs.writeFileSync(path.join(source, name), "approved bytes\n", { mode: 0o644 });
  }
  return { root, source, target };
}
function seal({ source, target }) {
  return spawnSync("bash", ["-e", "-s", "--", source, target], { encoding: "utf8", input: `set -Eeuo pipefail\ngp_log() { printf '%s\\n' "$*" >&2; }\n${selected}\ngp_seal_build_tree "$1" "$2" root\n` });
}
const rootLinux = process.platform === "linux" && process.getuid?.() === 0;
function commandFixture(values, {
  name = "seal-fixture", command = "seal-fixture", relative = "bin/command.cjs",
  body = `#!/usr/bin/env node\nconsole.log('fixture command');\n`,
  bin = { [command]: relative }, metadata = {}, modules = "node_modules", link,
} = {}) {
  const packageRoot = path.join(values.source, modules, name);
  const executable = path.join(packageRoot, relative);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, body, { mode: 0o755 });
  const manifest = path.join(packageRoot, "package.json");
  fs.writeFileSync(manifest, JSON.stringify({ name, bin, ...metadata }) + "\n");
  const commandRoot = path.join(values.source, modules, ".bin");
  fs.mkdirSync(commandRoot, { recursive: true });
  const commandPath = path.join(commandRoot, command);
  fs.symlinkSync(link ?? path.posix.relative(
    path.posix.join(modules, ".bin"), path.posix.join(modules, name, relative)), commandPath);
  return { packageRoot, executable, manifest, commandPath };
}
function assertSealingRefused(values) {
  const result = seal(values);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(values.target), false, "invalid dependency tree must never be published");
}
test("declared npm command links become portable regular shims preserving CommonJS entry, imports and arguments", {
  skip: !rootLinux,
}, t => {
  const values = fixture(t);
  commandFixture(values, {
    body: `#!/usr/bin/env node\nconst path = require('node:path'); console.log(JSON.stringify({ main: require.main === module, sibling: require('./relative.cjs'), argv: process.argv.slice(2), entry: path.basename(process.argv[1]) }));\n`,
  });
  fs.writeFileSync(path.join(values.source, "node_modules/seal-fixture/bin/relative.cjs"), "module.exports = 'relative sibling';\n");
  const result = seal(values); assert.equal(result.status, 0, result.stderr);
  const moved = path.join(values.root, "moved-candidate"); fs.renameSync(values.target, moved);
  const shim = path.join(moved, "node_modules/.bin/seal-fixture");
  const info = fs.lstatSync(shim);
  assert(info.isFile()); assert(!info.isSymbolicLink()); assert.equal(info.nlink, 1); assert.equal(info.uid, 0);
  assert.equal(info.mode & 0o022, 0); assert(info.mode & 0o111);
  const args = ["space argument", "literal $() ; ' %s", "--switch"];
  for (const invocation of [
    { executable: shim, cwd: values.root },
    { executable: "./seal-fixture", cwd: path.dirname(shim) },
    { executable: "seal-fixture", cwd: values.root, env: { ...process.env, PATH: path.dirname(shim) + path.delimiter + process.env.PATH } },
  ]) {
    const run = spawnSync(invocation.executable, args, { encoding: "utf8", cwd: invocation.cwd, env: invocation.env });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { main: true, sibling: "relative sibling", argv: args, entry: "command.cjs" });
  }
  assert.equal(fs.lstatSync(path.join(values.source, "node_modules/.bin/seal-fixture")).isSymbolicLink(), true);
});
test("the fixed spaced Node shebang remains executable after sealing and moving with CommonJS, stdin and literal arguments", {
  skip: !rootLinux,
}, t => {
  const values = fixture(t);
  const files = commandFixture(values, {
    name: "sha.js", command: "sha.js", relative: "bin.js", bin: "./bin.js", metadata: { version: "2.4.12" },
    body: `#! /usr/bin/env node\nconst fs = require('node:fs'); console.log(JSON.stringify({ main: require.main === module, sibling: require('./relative.cjs'), argv: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }));\n`,
  });
  assert.equal(fs.readFileSync(files.executable, "utf8").split("\n", 1)[0], "#! /usr/bin/env node");
  fs.writeFileSync(path.join(files.packageRoot, "relative.cjs"), "module.exports = 'spaced shebang sibling';\n");
  const result = seal(values); assert.equal(result.status, 0, result.stderr);
  const moved = path.join(values.root, "moved-spaced-shebang-candidate"); fs.renameSync(values.target, moved);
  const shim = path.join(moved, "node_modules/.bin/sha.js"), info = fs.lstatSync(shim);
  assert(info.isFile()); assert(!info.isSymbolicLink()); assert.equal(info.nlink, 1); assert.equal(info.uid, 0);
  assert.equal(info.mode & 0o022, 0); assert(info.mode & 0o111);
  const args = ["space argument", "literal $() ; ' %s", "--switch"], input = "stdin survives the move\n$() ; literal input\n";
  for (const invocation of [
    { executable: shim, cwd: values.root },
    { executable: "sha.js", cwd: moved, env: { ...process.env, PATH: path.dirname(shim) + path.delimiter + process.env.PATH } },
  ]) {
    const run = spawnSync(invocation.executable, args, { encoding: "utf8", input, cwd: invocation.cwd, env: invocation.env });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { main: true, sibling: "spaced shebang sibling", argv: args, stdin: input });
  }
  assert.equal(fs.lstatSync(files.commandPath).isSymbolicLink(), true);
});
test("npm command sealing selects the package boundary before a nested ESM type-only manifest", {
  skip: !rootLinux,
}, t => {
  const values = fixture(t);
  commandFixture(values, {
    name: "esm-fixture", command: "esm-fixture", relative: "dist/esm/bin/command",
    body: `#!/usr/bin/env node\nimport { sibling } from './relative.js'; console.log(JSON.stringify({ sibling, argv: process.argv.slice(2), url: import.meta.url.endsWith('/dist/esm/bin/command') }));\n`,
  });
  fs.writeFileSync(path.join(values.source, "node_modules/esm-fixture/dist/esm/package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(values.source, "node_modules/esm-fixture/dist/esm/bin/relative.js"), "export const sibling = 'esm sibling';\n");
  const result = seal(values); assert.equal(result.status, 0, result.stderr);
  const run = spawnSync(path.join(values.target, "node_modules/.bin/esm-fixture"), ["esm argument"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { sibling: "esm sibling", argv: ["esm argument"], url: true });
});
test("sealing validates dependency bytes without running their declared command", {
  skip: !rootLinux,
}, t => {
  const values = fixture(t), marker = path.join(values.root, "command-executed");
  commandFixture(values, { body: `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran explicitly');\n` });
  const result = seal(values); assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false);
  const run = spawnSync(path.join(values.target, "node_modules/.bin/seal-fixture"), [], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr); assert.equal(fs.readFileSync(marker, "utf8"), "ran explicitly");
});
test("declared string bins, scoped packages and nested npm command directories remain executable", {
  skip: !rootLinux,
}, t => {
  const values = fixture(t);
  commandFixture(values, { name: "string-fixture", command: "string-fixture", bin: "./bin/command.cjs", body: "#!/usr/bin/env node\nconsole.log('string bin');\n" });
  commandFixture(values, { name: "@scope/scoped-fixture", command: "scoped-fixture", bin: "bin/command.cjs", modules: "node_modules/parent/node_modules", body: "#!/usr/bin/env node\nconsole.log('scoped nested bin');\n" });
  const result = seal(values); assert.equal(result.status, 0, result.stderr);
  for (const [relative, expected] of [
    ["node_modules/.bin/string-fixture", "string bin"],
    ["node_modules/parent/node_modules/.bin/scoped-fixture", "scoped nested bin"],
  ]) {
    const run = spawnSync(path.join(values.target, relative), [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout.trim(), expected);
  }
});
test("the regular npm command shim forwards SIGTERM directly to the Node entry process", {
  skip: !rootLinux, timeout: 15000,
}, async t => {
  const values = fixture(t);
  commandFixture(values, { body: "#!/usr/bin/env node\nconsole.log('READY'); setInterval(() => {}, 1000);\n" });
  const result = seal(values); assert.equal(result.status, 0, result.stderr);
  const child = spawn(path.join(values.target, "node_modules/.bin/seal-fixture"), [], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let output = "", errors = "";
  child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { errors += value; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("command did not start: " + errors)), 8000);
    child.once("error", reject);
    child.once("exit", () => { if (!output.includes("READY")) { clearTimeout(timer); reject(new Error("command exited before ready: " + errors)); } });
    child.stdout.on("data", () => { if (output.includes("READY")) { clearTimeout(timer); resolve(); } });
  });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.equal(child.kill("SIGTERM"), true);
  assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
});
test("npm command sealing rejects undeclared, mismatched and duplicate bin declarations", {
  skip: !rootLinux,
}, async t => {
  for (const kind of ["undeclared", "wrong-target", "wrong-package-name", "duplicate-bin", "duplicate-command"]) {
    await t.test(kind, t => {
      const values = fixture(t), files = commandFixture(values);
      if (kind === "undeclared") fs.writeFileSync(files.manifest, '{"name":"seal-fixture","bin":{"other":"bin/command.cjs"}}\n');
      if (kind === "wrong-target") fs.writeFileSync(files.manifest, '{"name":"seal-fixture","bin":{"seal-fixture":"different.cjs"}}\n');
      if (kind === "wrong-package-name") fs.writeFileSync(files.manifest, '{"name":"other-package","bin":{"seal-fixture":"bin/command.cjs"}}\n');
      if (kind === "duplicate-bin") fs.writeFileSync(files.manifest, '{"name":"seal-fixture","bin":{},"bin":{"seal-fixture":"bin/command.cjs"}}\n');
      if (kind === "duplicate-command") fs.writeFileSync(files.manifest, '{"name":"seal-fixture","bin":{"seal-fixture":"different.cjs","seal-fixture":"bin/command.cjs"}}\n');
      assertSealingRefused(values);
    });
  }
});
test("npm command sealing rejects escaping, chained, misplaced and linked executable inodes", {
  skip: !rootLinux,
}, async t => {
  for (const kind of ["escape", "absolute", "link-chain", "non-bin-link", "hardlinked-executable", "hardlinked-link", "non-executable", "shell-shebang", "spaced-shell-shebang", "spaced-env-argument", "missing-shebang", "shell-alias", "shell-link", "missing-target", "directory-target", "fifo-target"]) {
    await t.test(kind, t => {
      const values = fixture(t), files = commandFixture(values);
      if (kind === "escape" || kind === "absolute") {
        const outside = path.join(values.root, "outside.cjs");
        fs.writeFileSync(outside, "#!/usr/bin/env node\nconsole.log('must not execute');\n", { mode: 0o755 });
        fs.unlinkSync(files.commandPath); fs.symlinkSync(kind === "absolute" ? outside : "../../../outside.cjs", files.commandPath);
      }
      if (kind === "link-chain") { fs.renameSync(files.executable, files.executable + ".actual"); fs.symlinkSync("command.cjs.actual", files.executable); }
      if (kind === "non-bin-link") fs.symlinkSync("node_modules/seal-fixture/bin/command.cjs", path.join(values.source, "outside-bin"));
      if (kind === "hardlinked-executable") fs.linkSync(files.executable, files.executable + ".second");
      if (kind === "hardlinked-link") fs.linkSync(files.commandPath, files.commandPath + "-second");
      if (kind === "non-executable") fs.chmodSync(files.executable, 0o644);
      if (kind === "shell-shebang") fs.writeFileSync(files.executable, "#!/bin/sh\nprintf unexpected\\n\n");
      if (kind === "spaced-shell-shebang") fs.writeFileSync(files.executable, "#! /bin/sh\nprintf unexpected\\n\n");
      if (kind === "spaced-env-argument") fs.writeFileSync(files.executable, "#! /usr/bin/env node --trace-warnings\nconsole.log('interpreter arguments must be rejected');\n");
      if (kind === "missing-shebang") fs.writeFileSync(files.executable, "console.log('not a direct executable');\n");
      if (kind === "shell-alias") fs.renameSync(files.commandPath, files.commandPath + ";touch-unexpected");
      if (kind === "shell-link") { fs.unlinkSync(files.commandPath); fs.symlinkSync("../seal-fixture/bin/command.cjs;touch-unexpected", files.commandPath); }
      if (kind === "missing-target") fs.unlinkSync(files.executable);
      if (kind === "directory-target") { fs.unlinkSync(files.executable); fs.mkdirSync(files.executable); }
      if (kind === "fifo-target") { fs.unlinkSync(files.executable); assert.equal(spawnSync("mkfifo", [files.executable]).status, 0); }
      assertSealingRefused(values);
    });
  }
});
test("a held unprivileged writer FD cannot modify the fresh root-sealed candidate inode", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0,
}, async t => {
  const values = fixture(t), actor = spawnSync("id", ["-u", "nobody"], { encoding: "utf8" });
  assert.equal(actor.status, 0, actor.stderr); const uid = Number(actor.stdout.trim()); assert(uid > 0);
  const file = path.join(values.source, "program.js"); fs.chownSync(file, uid, 0);
  const child = spawn("runuser", ["--user", "nobody", "--", process.execPath, "-e", `const fs=require('node:fs'); const fd=fs.openSync(process.argv[1],'r+'); console.log('OPEN');process.stdin.once('data',()=>{fs.writeSync(fd,Buffer.from('mutated bytes!\\n'),0,15,0);fs.closeSync(fd);console.log('WRITTEN');});`, file], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "", errors = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { errors += bytes; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("writer did not open fixture: " + errors)), 10000);
    child.stdout.on("data", () => { if (output.includes("OPEN")) { clearTimeout(timer); resolve(); } });
    child.once("error", reject);
  });
  const result = seal(values); assert.equal(result.status, 0, result.stderr);
  const sealed = path.join(values.target, "program.js"); assert.notEqual(fs.statSync(sealed).ino, fs.statSync(file).ino);
  child.stdin.end("write"); const exit = await new Promise(resolve => child.once("exit", resolve));
  assert.equal(exit, 0, errors); assert.match(output, /WRITTEN/);
  assert.notEqual(fs.readFileSync(file, "utf8"), "approved bytes\n");
  assert.equal(fs.readFileSync(sealed, "utf8"), "approved bytes\n");
  assert.equal(fs.statSync(sealed).uid, 0); assert.equal(fs.statSync(sealed).mode & 0o022, 0);
});
test("root sealing rejects a symlinked candidate before publishing a target", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0,
}, t => {
  const values = fixture(t); fs.symlinkSync("/etc/passwd", path.join(values.source, "untrusted-link"));
  const result = seal(values); assert.notEqual(result.status, 0); assert.equal(fs.existsSync(values.target), false);
});
test("root sealing rejects FIFOs and hard-linked files without blocking or publishing", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0,
}, t => {
  for (const type of ["fifo", "hardlink"]) {
    const values = fixture(t), entry = path.join(values.source, "untrusted-" + type);
    if (type === "fifo") assert.equal(spawnSync("mkfifo", [entry]).status, 0);
    else fs.linkSync(path.join(values.source, "program.js"), entry);
    const result = seal(values); assert.notEqual(result.status, 0); assert.equal(fs.existsSync(values.target), false);
  }
});
test("an actively exchanged build directory cannot copy private root files into dependency output", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0, timeout: 120000,
}, async t => {
  const values = fixture(t), actor = spawnSync("id", ["-u", "nobody"], { encoding: "utf8" });
  assert.equal(actor.status, 0); const uid = Number(actor.stdout.trim()); assert(uid > 0);
  const privateRoot = path.join(values.root, "root-private"), secret = "PRIVATE-ROOT-" + require("node:crypto").randomBytes(24).toString("hex");
  fs.mkdirSync(privateRoot, { mode: 0o700 }); fs.writeFileSync(path.join(privateRoot, "must-never-copy"), secret, { mode: 0o600 });
  const parent = path.join(values.source, "node_modules"), child = path.join(parent, "package");
  fs.mkdirSync(child, { recursive: true }); fs.chownSync(parent, uid, 0); fs.chownSync(child, uid, 0);
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(child, "fixture-" + i), "public fixture bytes\n");
  const attacker = spawn("/usr/bin/python3", ["-I", "-c", `import os,sys\np,secret=sys.argv[1:]\nnormal=p+'/package'; parked=p+'/parked'\nprint('READY',flush=True)\nwhile True:\n try:\n  os.rename(normal,parked)\n  os.symlink(secret,normal)\n  os.unlink(normal)\n  os.rename(parked,normal)\n except FileNotFoundError: pass\n`, parent, privateRoot], { uid, gid: 0, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (attacker.exitCode === null) attacker.kill("SIGKILL"); });
  let output = "", errors = ""; attacker.stdout.on("data", data => { output += data; }); attacker.stderr.on("data", data => { errors += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("directory exchange did not start: " + errors)), 10000);
    attacker.stdout.on("data", () => { if (output.includes("READY")) { clearTimeout(timer); resolve(); } });
    attacker.once("error", reject);
  });
  for (let i = 0; i < 8; i++) {
    const target = path.join(values.root, "sealed-" + i); seal({ ...values, target });
    function noSecret(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) noSecret(file);
        else if (entry.isFile()) assert.notEqual(fs.readFileSync(file, "utf8"), secret, "root-private bytes escaped into sealed output");
      }
    }
    for (const entry of fs.readdirSync(values.root)) {
      if (entry.startsWith(".root-seal.") || entry.startsWith("sealed-")) noSecret(path.join(values.root, entry));
    }
    assert.equal(attacker.exitCode, null, errors);
  }
  attacker.kill("SIGKILL"); await new Promise(resolve => attacker.once("exit", resolve));
});
function packageFixture(values) {
  const verifier = path.join(values.source, "server-tools/linux/lib/verify-package.js"), manifest = path.join(values.source, "grabenplaner-server-manifest.json");
  fs.writeFileSync(verifier, "require('node:fs').writeFileSync(process.argv[2],'APPROVED');\n");
  fs.writeFileSync(manifest, '{"approved":true}\n');
  const archive = path.join(values.root, "original.zip");
  const packed = spawnSync("/usr/bin/python3", ["-I", "-", values.source, archive], { encoding: "utf8", input: `from pathlib import Path\nimport sys,zipfile\nroot=Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w') as output:\n for file in sorted(root.rglob('*')):\n  if file.is_file(): output.write(file,file.relative_to(root).as_posix())\n` });
  assert.equal(packed.status, 0, packed.stderr); return { verifier, manifest, archive };
}
function verifyAndExecute(values, archive, dependencies = "0") {
  const marker = path.join(values.root, "root-code-executed");
  const result = spawnSync("bash", ["-e", "-s", "--", archive, values.target, marker, process.execPath, dependencies], {
    encoding: "utf8", input: `set -Eeuo pipefail\ngp_log() { printf '%s\\n' "$*" >&2; }\n${selected}\ngp_verify_sealed_zip "$1" "$2" "$5"\n"$4" "$2/server-tools/linux/lib/verify-package.js" "$3"\n`,
  });
  return { result, marker };
}
test("root executes a sealed verifier only after exact original ZIP bytes match", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0,
}, t => {
  const values = fixture(t), { archive } = packageFixture(values); assert.equal(seal(values).status, 0);
  const { result, marker } = verifyAndExecute(values, archive);
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.readFileSync(marker, "utf8"), "APPROVED");
});
test("build-account modification of both verifier and manifest before sealing never executes root candidate code", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0,
}, t => {
  const values = fixture(t), { verifier, manifest, archive } = packageFixture(values);
  const actor = spawnSync("id", ["-u", "nobody"], { encoding: "utf8" }); assert.equal(actor.status, 0, actor.stderr);
  for (const file of [verifier, manifest]) fs.chownSync(file, Number(actor.stdout.trim()), 0);
  const mutation = spawnSync("runuser", ["--user", "nobody", "--", process.execPath, "-e", `const fs=require('node:fs');fs.writeFileSync(process.argv[1],"require('node:fs').writeFileSync(process.argv[2],'UNTRUSTED');\\n");fs.writeFileSync(process.argv[2],'{"approved":false}\\n');`, verifier, manifest], { encoding: "utf8" });
  assert.equal(mutation.status, 0, mutation.stderr); assert.equal(seal(values).status, 0);
  const { result, marker } = verifyAndExecute(values, archive);
  assert.notEqual(result.status, 0); assert.equal(fs.existsSync(marker), false);
});
test("post-install ZIP binding allows only the dependency subtree and rejects other added files", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0,
}, t => {
  const values = fixture(t), { archive } = packageFixture(values);
  fs.mkdirSync(path.join(values.source, "node_modules/example"), { recursive: true }); fs.writeFileSync(path.join(values.source, "node_modules/example/index.js"), "module.exports={};\n");
  assert.equal(seal(values).status, 0);
  const allowed = verifyAndExecute(values, archive, "1"); assert.equal(allowed.result.status, 0, allowed.result.stderr);
  fs.unlinkSync(allowed.marker); fs.writeFileSync(path.join(values.target, "unexpected-root-code.js"), "unreviewed\n");
  const refused = verifyAndExecute(values, archive, "1"); assert.notEqual(refused.result.status, 0); assert.equal(fs.existsSync(refused.marker), false);
});
