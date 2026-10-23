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
