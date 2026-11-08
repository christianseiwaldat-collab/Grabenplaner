"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const HELPER = path.resolve(__dirname, "../server-tools/linux/lib/private-workspace-preflight.py");
const PYTHON = process.platform === "win32" ? "python" : "/usr/bin/python3";
const rootOnly = process.platform === "linux" && process.getuid() === 0;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function cli(helper, args) {
  const result = spawnSync(PYTHON, ["-I", "-B", helper, ...args], { encoding: "utf8", timeout: 5000 });
  result.stderr = String(result.stderr || "").replace(/\r\n/g, "\n"); return result;
}
function parse(bytes) {
  const code = "import importlib.util,sys,json; s=importlib.util.spec_from_file_location('checked',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\ntry:\n r=m.parse_bindings(sys.stdin.buffer.read()); print(json.dumps({'rows':len(r)}))\nexcept (m.CheckFailure,ValueError,UnicodeError,RecursionError) as e:\n print(str(e) if isinstance(e,m.CheckFailure) else 'PRIVATE_WORKSPACE_FORMAT',file=sys.stderr); sys.exit(1)\n";
  const result = spawnSync(PYTHON, ["-I", "-B", "-c", code, HELPER], { input: bytes, encoding: "utf8", timeout: 5000 });
  result.stderr = String(result.stderr || "").replace(/\r\n/g, "\n"); return result;
}
function metadataRow(manifest = "a".repeat(64)) {
  return { gpVersion: "0.92.101-beta", sourceCommit: "b".repeat(40), manifestSha256: manifest,
    files: [{ file: "package.json", bytes: 2, sha256: sha("{}") }],
    codeRoot: "/opt/private/releases/exact", codeFiles: [{ file: "module.cjs", bytes: 2, sha256: sha("{}") }] };
}
const wrapper = rows => `// Genuine declaration shape; JavaScript must never run.\nconst bindings=${JSON.stringify(rows)},codeFiles=${JSON.stringify(rows.at(-1)?.codeFiles || [])};\nthrow Error('EXECUTED_PRIVATE_MODULE');\n`;

test("private workspace absent or blank is optional; invalid CLI stays sanitized", () => {
  for (const module of [null, "", "   "]) {
    const args = ["--installed-app", "/not-present/current", "--candidate-app", "/not-present/candidate"];
    if (module !== null) args.push("--module", module);
    const r = cli(HELPER, args); assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { configured: false, dataOnly: true, format: "gp-private-workspace-preflight-v1", verified: true });
  }
  const bad = cli(HELPER, ["--unknown", "DO_NOT_ECHO_THIS"]);
  assert.equal(bad.status, 1); assert.equal(bad.stderr, "PRIVATE_WORKSPACE_PREFLIGHT_ARGS\n"); assert.equal(bad.stdout, "");
});

test("known binding JSON parses without running any configured JavaScript", () => {
  const r = parse(wrapper([metadataRow()])); assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), { rows: 1 });
});

test("ambiguous or malformed binding data fails without including private data", () => {
  const row = metadataRow();
  const cases = [wrapper([row, row]), wrapper([{ ...row, files: [{ ...row.files[0], file: "../escape" }] }]),
    wrapper([{ ...row, files: [{ ...row.files[0], file: "." }] }]),
    wrapper([{ ...row, files: [{ ...row.files[0], file: "sub\\escape" }] }]),
    wrapper([{ ...row, files: [{ ...row.files[0], bytes: true }] }]),
    wrapper([{ ...row, files: [{ ...row.files[0], sha256: "not-a-digest" }] }]),
    wrapper([{ ...row, codeFiles: [row.codeFiles[0], row.codeFiles[0]] }]),
    wrapper([row]).replace('"gpVersion":', '"gpVersion":"DO_NOT_ECHO_THIS","gpVersion":'),
    wrapper([row]).replace('"bytes":2', '"bytes":NaN'),
    wrapper([row]).replace("const bindings=", "const bindings=DO_NOT_ECHO_THIS"),
    wrapper([row]) + "const bindings=[];", wrapper([row]).replace("];", "] DO_NOT_ECHO_THIS;"),
    wrapper([row]).replace(",codeFiles=", ";otherFiles="),
    wrapper([row]).replace(",codeFiles=", ",otherFiles="),
    wrapper([row]).replace(",codeFiles=", ",codeFiles=DO_NOT_ECHO_THIS")];
  for (const bytes of cases) {
    const r = parse(bytes); assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /^PRIVATE_WORKSPACE_[A-Z_]+\n$/); assert.doesNotMatch(r.stderr, /DO_NOT_ECHO_THIS|escape|Traceback/);
  }
});

function fixture(t) {
  const root = fs.mkdtempSync("/root/gp-private-preflight-"); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function directory(p, group = 0) { fs.mkdirSync(p, { recursive: true, mode: 0o750 }); fs.chownSync(p, 0, group); fs.chmodSync(p, 0o750); }
  function write(p, bytes, group = 0) { directory(path.dirname(p), group); fs.writeFileSync(p, bytes); fs.chownSync(p, 0, group); fs.chmodSync(p, 0o640); }
  const current = path.join(root, "current"), candidate = path.join(root, "candidate"), codeRoot = path.join(root, "private/releases/exact");
  directory(current, 65534); directory(candidate); directory(codeRoot);
  const sentinel = path.join(root, "must-never-exist"), code = "throw Error('DO_NOT_EXECUTE_PRIVATE_PAYLOAD');\n";
  write(path.join(codeRoot, "module.cjs"), code, 65534);
  const codeFiles = [{ file: "module.cjs", bytes: Buffer.byteLength(code), sha256: sha(code) }];
  const rows = [];
  for (const [app, version, commit, group] of [[current, "0.92.100-beta", "a".repeat(40), 65534], [candidate, "0.92.101-beta", "b".repeat(40), 0]]) {
    const packageBytes = JSON.stringify({ version }), js = "// exact fixture\n";
    write(path.join(app, "package.json"), packageBytes, group); write(path.join(app, "public/app.js"), js, group);
    const files = [{ path: "package.json", bytes: Buffer.byteLength(packageBytes), sha256: sha(packageBytes) }, { path: "public/app.js", bytes: Buffer.byteLength(js), sha256: sha(js) }];
    const manifest = JSON.stringify({ format: "grabenplaner-server-package", schemaVersion: 1, appVersion: version, sourceCommit: commit, files });
    write(path.join(app, "grabenplaner-server-manifest.json"), manifest, group);
    rows.push({ gpVersion: version, sourceCommit: commit, manifestSha256: sha(manifest), files: files.map(({ path: file, ...pin }) => ({ file, ...pin })), codeRoot, codeFiles: structuredClone(codeFiles) });
  }
  const module = path.join(root, "private/module.cjs"), helper = path.join(root, "tools/check.py");
  write(helper, fs.readFileSync(HELPER));
  const publish = () => write(module, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'executed');\n${wrapper(rows)}`, 65534);
  publish();
  const run = () => cli(helper, ["--module", module, "--installed-app", current, "--candidate-app", candidate]);
  return { root, current, candidate, codeRoot, module, helper, rows, publish, run, write, sentinel };
}
function rejected(result, code) { assert.equal(result.status, 1, result.stdout); assert.equal(result.stdout, ""); assert.equal(result.stderr, code + "\n"); }

test("root fixture verifies exact current/candidate and private pins with service-group 0640 metadata", { skip: !rootOnly }, t => {
  const f = fixture(t), before = fs.readFileSync(f.module), r = f.run(); assert.equal(r.status, 0, r.stderr);
  const proof = JSON.parse(r.stdout); assert.equal(proof.configured, true); assert.equal(proof.verified, true); assert.equal(proof.dataOnly, true);
  assert.equal(proof.gpFileBindings, 2); assert.equal(proof.privateFiles, 1); assert.equal(proof.privateCodeUnchanged, true);
  assert.equal(proof.installedManifestSha256, f.rows[0].manifestSha256); assert.equal(proof.candidateManifestSha256, f.rows[1].manifestSha256);
  assert.deepEqual(fs.readFileSync(f.module), before); assert.equal(fs.existsSync(f.sentinel), false);
});

test("root fixture missing current and candidate bindings are distinct early failures", { skip: !rootOnly }, t => {
  const f = fixture(t), rows = structuredClone(f.rows);
  f.rows.splice(1, 1); f.publish(); rejected(f.run(), "PRIVATE_WORKSPACE_BINDING_MISSING_CANDIDATE");
  f.rows.splice(0, 1, rows[1]); f.publish(); rejected(f.run(), "PRIVATE_WORKSPACE_BINDING_MISSING_CURRENT");
  assert.equal(fs.existsSync(f.sentinel), false);
});

test("root fixture checks GP manifest identity, actual files and declared pins", { skip: !rootOnly }, t => {
  const f = fixture(t), original = structuredClone(f.rows[1]);
  f.rows[1].sourceCommit = "c".repeat(40); f.publish(); rejected(f.run(), "PRIVATE_WORKSPACE_GP_IDENTITY");
  f.rows[1] = structuredClone(original); f.rows[1].files[0].sha256 = "c".repeat(64); f.publish(); rejected(f.run(), "PRIVATE_WORKSPACE_GP_FILE_PIN");
  f.rows[1] = structuredClone(original); f.publish(); f.write(path.join(f.candidate, "public/app.js"), "// exact fixturE\n"); rejected(f.run(), "PRIVATE_WORKSPACE_GP_FILE_PIN");
  const manifestFile = path.join(f.candidate, "grabenplaner-server-manifest.json"), manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  for (const schema of [undefined, 2, true]) {
    f.write(manifestFile, JSON.stringify({ ...manifest, schemaVersion: schema })); rejected(f.run(), "PRIVATE_WORKSPACE_GP_MANIFEST");
  }
});

test("root fixture private code pin and current/candidate private identity must remain exact", { skip: !rootOnly }, t => {
  const f = fixture(t), original = structuredClone(f.rows[1]);
  f.rows[1].codeRoot = path.join(f.root, "other"); f.publish(); rejected(f.run(), "PRIVATE_WORKSPACE_PRIVATE_CODE_CHANGED");
  f.rows[1] = structuredClone(original); f.rows[1].codeFiles[0].sha256 = "d".repeat(64); f.publish(); rejected(f.run(), "PRIVATE_WORKSPACE_PRIVATE_CODE_CHANGED");
  f.rows[1] = structuredClone(original); f.publish(); f.write(path.join(f.codeRoot, "module.cjs"), "throw Error('DO_NOT_EXECUTE_PRIVATE_PAYLoAD');\n"); rejected(f.run(), "PRIVATE_WORKSPACE_PRIVATE_FILE_PIN");
});

test("root fixture rejects unsafe owners, writable parents, links and missing configured module", { skip: !rootOnly }, t => {
  const f = fixture(t), original = fs.readFileSync(f.module);
  fs.chownSync(f.module, 1000, 1000); rejected(f.run(), "PRIVATE_WORKSPACE_PERMISSIONS"); fs.chownSync(f.module, 0, 65534);
  fs.chmodSync(f.module, 0o660); rejected(f.run(), "PRIVATE_WORKSPACE_PERMISSIONS"); fs.chmodSync(f.module, 0o640);
  fs.chmodSync(path.dirname(f.module), 0o770); rejected(f.run(), "PRIVATE_WORKSPACE_PERMISSIONS"); fs.chmodSync(path.dirname(f.module), 0o750);
  const link = path.join(f.root, "hardlink"); fs.linkSync(f.module, link); rejected(f.run(), "PRIVATE_WORKSPACE_PERMISSIONS"); fs.unlinkSync(link);
  fs.unlinkSync(f.module); fs.symlinkSync(path.join(f.codeRoot, "module.cjs"), f.module); rejected(f.run(), "PRIVATE_WORKSPACE_CANONICAL_PATH"); fs.unlinkSync(f.module);
  rejected(f.run(), "PRIVATE_WORKSPACE_PREFLIGHT_IO"); f.write(f.module, original, 65534);
});

test("root fixture rejects unsafe GP/private file metadata before reading or executing payloads", { skip: !rootOnly }, t => {
  const f = fixture(t), file = path.join(f.codeRoot, "module.cjs"), before = fs.readFileSync(file);
  fs.chownSync(file, 1000, 1000); rejected(f.run(), "PRIVATE_WORKSPACE_PERMISSIONS"); fs.chownSync(file, 0, 65534);
  fs.chmodSync(file, 0o660); rejected(f.run(), "PRIVATE_WORKSPACE_PERMISSIONS"); fs.chmodSync(file, 0o640);
  fs.unlinkSync(file); fs.symlinkSync(path.join(f.candidate, "package.json"), file); rejected(f.run(), "PRIVATE_WORKSPACE_CANONICAL_PATH"); fs.unlinkSync(file); f.write(file, before, 65534);
  fs.unlinkSync(file); const fifo = spawnSync("/usr/bin/mkfifo", [file], { encoding: "utf8" }); assert.equal(fifo.status, 0, fifo.stderr);
  rejected(f.run(), "PRIVATE_WORKSPACE_PERMISSIONS"); fs.unlinkSync(file); f.write(file, before, 65534);
  fs.chmodSync(path.join(f.candidate, "grabenplaner-server-manifest.json"), 0o666); rejected(f.run(), "PRIVATE_WORKSPACE_PERMISSIONS");
  assert.equal(fs.existsSync(f.sentinel), false);
});
