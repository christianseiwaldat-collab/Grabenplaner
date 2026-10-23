"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const assert = require("node:assert/strict"), test = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const common = fs.readFileSync(path.join(__dirname, "../server-tools/linux/lib/common.sh"), "utf8");
const selected = ["gp_apply_app_permissions", "gp_seal_build_tree"].map(name => {
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
