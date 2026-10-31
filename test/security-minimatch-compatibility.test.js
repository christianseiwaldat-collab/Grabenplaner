"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createRequire } = require("node:module"), { spawnSync } = require("node:child_process");
function consumer(...chain) {
  let parent = require;
  for (const name of chain) parent = createRequire(parent.resolve(name));
  return parent;
}
const excel = consumer("exceljs"), archiver = consumer("exceljs", "archiver");
const utils = consumer("exceljs", "archiver", "archiver-utils");
const glob = utils("glob");
const {checkGlobCompatibilityPolicy} = require("../scripts/security/verify-patch.cjs");
const registered = require("../scripts/security/patch-policy.json");
function policyFixture() {
  const policy = registered.compatibilityPatches[0], policies = [registered,...registered.securityBackports,...registered.compatibilityPatches];
  return {policy, context:{patchHash:policy.patchSha256,packageJsonHash:policy.packageJsonSha256,licenseHash:policy.licenseSha256,
    treeHash:policy.installedTreeSha256,fileCount:policy.installedFileCount,regressionHash:policy.regressionTestSha256,
    installedHashes:Object.fromEntries(Object.entries(policy.installedFiles).map(([file,hashes]) => [file,hashes.afterSha256])),
    minimatchVersion:policy.minimatchVersion,registeredPolicies:policies,
    workspace: "patchedDependencies:\n" + policies.map(p => `  '${p.package}@${p.version}': ${p.patch}\n`).join(""),
    lock: "patchedDependencies:\n" + policies.map(p => `  '${p.package}@${p.version}': ${p.patchSha256}\n`).join("")
      + `\npackages:\n  glob@7.2.3:\n    resolution: {integrity: ${policy.originalTarballIntegrity}}\n\nsnapshots:\n`,
  }};
}
test("glob compatibility approval is bounded and never waives an advisory", () => {
  const {policy,context} = policyFixture();
  assert.doesNotThrow(() => checkGlobCompatibilityPolicy(policy,context,new Date("2026-10-31")));
  for (const date of ["2026-10-30","2026-12-01"]) assert.throws(() => checkGlobCompatibilityPolicy(policy,context,new Date(date)));
  assert.throws(() => checkGlobCompatibilityPolicy({...policy,advisoryExceptions:["GHSA-fixture"]},context,new Date("2026-10-31")));
});
for (const key of ["patchHash","packageJsonHash","licenseHash","treeHash","fileCount","regressionHash","minimatchVersion","workspace","lock"]) {
  test(`glob compatibility approval rejects ${key} drift`, () => {
    const {policy,context} = policyFixture();
    context[key] = key === "workspace" || key === "lock" ? context[key].replace("glob@7.2.3", "glob@7.2.4") : context[key] + "changed";
    assert.throws(() => checkGlobCompatibilityPolicy(policy,context,new Date("2026-10-31")));
  });
}
test("glob compatibility approval rejects changed or missing patched files", () => {
  const {policy,context} = policyFixture();
  context.installedHashes["glob.js"] = policy.installedFiles["glob.js"].beforeSha256;
  assert.throws(() => checkGlobCompatibilityPolicy(policy,context,new Date("2026-10-31")));
  delete context.installedHashes["sync.js"];
  assert.throws(() => checkGlobCompatibilityPolicy(policy,context,new Date("2026-10-31")));
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-glob-compat-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  for (const relative of ["a.txt", "b.csv", ".hidden.txt", "sub/c.txt", "sub/skip.txt", "sub/nested/d.txt", "other/e.txt"]) {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, relative);
  }
  return root;
}
const normalize = entries => entries.map(entry => entry.replaceAll("\\", "/")).sort();
test("all four ExcelJS dependency paths resolve the fixed minimatch", () => {
  for (const chain of [
    ["exceljs","archiver","archiver-utils","glob"],
    ["exceljs","archiver","zip-stream","archiver-utils","glob"],
    ["exceljs","unzipper","fstream","rimraf","glob"],
    ["exceljs","archiver","readdir-glob"],
  ]) assert.equal(consumer(...chain)("minimatch/package.json").version, "11.0.3");
});
test("sync and callback glob preserve matching, exclusions, dotfiles and nonmatches", async t => {
  const cwd = fixture(t);
  for (const [pattern, options, expected] of [
    ["*.txt", {}, ["a.txt"]],
    ["*.txt", {dot:true}, [".hidden.txt", "a.txt"]],
    [".hidden.*", {}, [".hidden.txt"]],
    ["**/*.txt", {ignore:["sub/skip.txt","other/**"]}, ["a.txt","sub/c.txt","sub/nested/d.txt"]],
    ["{a,b}.{txt,csv}", {}, ["a.txt","b.csv"]],
    ["@(a|b).*", {}, ["a.txt","b.csv"]],
    ["[ab].*", {}, ["a.txt","b.csv"]],
    ["missing/**/*.txt", {}, []],
    ["**/*.txt", {nodir:true,matchBase:true}, ["a.txt","other/e.txt","sub/c.txt","sub/nested/d.txt","sub/skip.txt"]],
  ]) {
    const opts = {cwd, ...options};
    assert.deepEqual(normalize(glob.sync(pattern, opts)), expected.sort(), pattern);
    const found = await new Promise((resolve,reject) => glob(pattern,opts,(error,files) => error ? reject(error) : resolve(files)));
    assert.deepEqual(normalize(found), expected.sort(), pattern);
  }
  assert.equal(glob.hasMagic("*.txt"), true); assert.equal(glob.hasMagic("a.txt"), false);
  assert.deepEqual(normalize(archiver("archiver-utils").file.expand({cwd}, ["**/*.txt", "!sub/**", "!other/**"])), ["a.txt"]);
});
test("archive glob selects only requested files and preserves their contents", async t => {
  const cwd = fixture(t), zip = excel("archiver")("zip"), chunks = [];
  zip.on("data", chunk => chunks.push(chunk));
  const ended = new Promise((resolve,reject) => { zip.on("end",resolve); zip.on("error",reject); });
  zip.glob("**/*.txt", {cwd,ignore:["sub/skip.txt","other/**"]});
  await zip.finalize(); await ended;
  const archive = await excel("unzipper").Open.buffer(Buffer.concat(chunks));
  assert.deepEqual(archive.files.map(file => file.path).sort(), ["a.txt","sub/c.txt","sub/nested/d.txt"]);
  for (const file of archive.files) assert.equal((await file.buffer()).toString(), file.path);
});
test("legacy rimraf wildcard removes only selected synthetic files", async t => {
  const cwd = fixture(t), rimraf = consumer("exceljs","unzipper","fstream")("rimraf");
  rimraf.sync(path.join(cwd, "*.txt").replaceAll("\\", "/"));
  assert.equal(fs.existsSync(path.join(cwd,"a.txt")), false);
  assert.equal(fs.existsSync(path.join(cwd,".hidden.txt")), true);
  await new Promise((resolve,reject) => rimraf(path.join(cwd,"sub","*.txt").replaceAll("\\", "/"),error => error ? reject(error) : resolve()));
  assert.equal(fs.existsSync(path.join(cwd,"sub/c.txt")), false);
  assert.equal(fs.existsSync(path.join(cwd,"sub/nested/d.txt")), true);
  assert.equal(fs.existsSync(path.join(cwd,"b.csv")), true);
});
test("application XLSX export and import retain values, types and formula protection", async () => {
  const {createXlsxBuffer,inspectTabularBuffer} = require("../lib/tabular-data");
  const bytes = await createXlsxBuffer([{id:"name",label:"Name"},{id:"hours",label:"Stunden",type:"number"}], [{name:"Prüfung Ä",hours:7.5},{name:"=1+1",hours:0}]);
  const read = await inspectTabularBuffer(bytes, {fileName:"test.xlsx"});
  assert.equal(read.format,"xlsx");
  assert.equal(read.sheets[0].rows[1][0].text,"Prüfung Ä");
  assert.equal(read.sheets[0].rows[1][1].text,"7.5");
  assert.equal(read.sheets[0].rows[2][0].formula,false);
  assert.match(read.sheets[0].rows[2][0].text,/^'=1\+1$/);
});
test("streaming Excel writer retains ZIP compatibility", async t => {
  const cwd = fixture(t), filename = path.join(cwd,"stream.xlsx"), ExcelJS = require("exceljs");
  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({filename});
  const sheet = writer.addWorksheet("Test"); sheet.addRow(["Prüfung",42]).commit(); await writer.commit();
  const read = new ExcelJS.Workbook(); await read.xlsx.readFile(filename);
  assert.equal(read.getWorksheet("Test").getCell("B1").value,42);
});
test("XLSX rejects malformed, traversing, encrypted and oversized archives before decoding", async () => {
  const {inspectTabularBuffer,createXlsxBuffer} = require("../lib/tabular-data");
  await assert.rejects(inspectTabularBuffer(Buffer.from("PKbroken"),{fileName:"test.xlsx"}), {code:"XLSX_ARCHIVE_INVALID"});
  const original = await createXlsxBuffer([{id:"x",label:"X"}],[{x:"test"}]);
  const directory = original.indexOf(Buffer.from([0x50,0x4b,0x01,0x02])); assert.ok(directory > 0);
  for (const [change, code] of [
    [buffer => buffer.write("../",directory+46,"utf8"), "XLSX_ARCHIVE_PATH_INVALID"],
    [buffer => buffer.writeUInt16LE(1,directory+8), "XLSX_ARCHIVE_UNSUPPORTED"],
    [buffer => buffer.writeUInt32LE(33*1024*1024,directory+24), "XLSX_UNCOMPRESSED_LIMIT"],
  ]) {
    const buffer = Buffer.from(original); change(buffer);
    await assert.rejects(inspectTabularBuffer(buffer,{fileName:"test.xlsx"}), {code});
  }
});
test("upstream pattern amplification regression finishes within bounded resources", () => {
  const result = spawnSync(process.execPath, ["--no-global-search-paths","--max-old-space-size=192",path.resolve(__dirname,"../test-support/security-audit/ops-dependency-remediation.probe.cjs"),"minimatch-optimization"], {
    encoding:"utf8", timeout:15000, maxBuffer:4096, windowsHide:true,
  });
  assert.ifError(result.error); assert.equal(result.status,0,result.stderr); assert.equal(result.stdout,"completed");
});
