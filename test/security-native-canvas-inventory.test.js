"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { canvasNativeInventory } = require("../lib/security-native-canvas-inventory");

function fixture(t, { platform = "linux", architecture = "x64", libc = "glibc" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gp-canvas-inventory-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canvasRoot = path.join(root, "node_modules", "@napi-rs", "canvas");
  const target = platform + "-" + architecture + (platform === "linux" ? (libc === "glibc" ? "-gnu" : "-musl") : platform === "win32" ? "-msvc" : "");
  const name = "@napi-rs/canvas-" + target;
  const platformRoot = path.join(root, "node_modules", ...name.split("/"));
  fs.mkdirSync(canvasRoot, { recursive: true });
  fs.mkdirSync(platformRoot, { recursive: true });
  const binding = path.join(platformRoot, "skia." + target + ".node");
  // Synthetic parser fixture: no native code is executed by this test.
  fs.writeFileSync(binding, "synthetic-native-binary");
  const packageDocument = { name, version: "1.0.13", os: [platform], cpu: [architecture], ...(platform === "linux" ? { libc: [libc] } : {}) };
  const canvasDocument = { name: "@napi-rs/canvas", version: "1.0.13", optionalDependencies: { [name]: "1.0.13" } };
  const purl = "pkg:npm/%40napi-rs/canvas-" + target + "@1.0.13";
  const components = [{ type: "file", name: path.basename(binding), "bom-ref": path.basename(binding), purl: purl + "#" + path.basename(binding),
    hashes: [{ alg: "SHA-256", content: crypto.createHash("sha256").update(fs.readFileSync(binding)).digest("hex") }] }];
  for (const library of ["expat", "freetype", "brotli", "harfbuzz", "icu", "libjxl", "highway", "libjpeg-turbo", "libpng", "libwebp", "wuffs", "zlib"]) {
    const version = "a".repeat(40);
    const componentPurl = `pkg:generic/${library}@${version}?repository_url=https%3A%2F%2Fexample.invalid%2F${library}`;
    components.push({ type: "library", name: library, version, "bom-ref": componentPurl, purl: componentPurl,
      properties: [{ name: "cdx:skia:repositoryUrl", value: "https://example.invalid/" + library }] });
  }
  const document = { bomFormat: "CycloneDX", specVersion: "1.6", version: 1, metadata: { component: { name, version: "1.0.13", purl, "bom-ref": purl } },
    components, dependencies: [{ ref: purl, dependsOn: components.map(component => component["bom-ref"]) }] };
  const write = () => {
    fs.writeFileSync(path.join(canvasRoot, "package.json"), JSON.stringify(canvasDocument));
    fs.writeFileSync(path.join(platformRoot, "package.json"), JSON.stringify(packageDocument));
    fs.writeFileSync(path.join(platformRoot, "sbom.cdx.json"), JSON.stringify(document));
  };
  write();
  const options = { applicationRoot: root, canvasRoot, loadedBindings: [binding], platform, architecture, libc };
  return { root, canvasRoot, platformRoot, binding, canvasDocument, packageDocument, document, options, write,
    observe: () => canvasNativeInventory(options) };
}

for (const target of [{ platform: "linux", libc: "glibc" }, { platform: "linux", libc: "musl" }, { platform: "win32" }, { platform: "darwin", architecture: "arm64" }]) {
  test(`Canvas inventory binds platform SBOM bytes for ${target.platform}/${target.libc || target.architecture || "x64"}`, t => {
    const state = fixture(t, target);
    const report = state.observe();
    assert.equal(report.status, "sbom-bound");
    assert.equal(report.components.length, 13);
    assert.equal(report.platformPackage.name, state.packageDocument.name);
    assert.equal(report.binary.sha256, state.document.components[0].hashes[0].content);
    assert.equal(report.vulnerabilityAssessment, "not-performed");
    assert.equal(report.completenessClaimed, false);
    assert.match(report.scope, /not a CVE clearance/);
  });
}

test("Canvas old packages retain an explicit unknown state without pretending to have an SBOM", t => {
  const state = fixture(t);
  state.canvasDocument.version = "1.0.2";
  state.write();
  fs.unlinkSync(path.join(state.platformRoot, "sbom.cdx.json"));
  const report = state.observe();
  assert.equal(report.status, "unknown");
  assert.equal(report.completenessClaimed, false);
  assert.equal(report.vulnerabilityAssessment, "not-performed");
});

const negatives = [
  ["changed binary", state => fs.appendFileSync(state.binding, "changed"), "INVENTORY_CANVAS_SBOM_BINARY_MISMATCH"],
  ["changed SBOM binary hash", state => { state.document.components[0].hashes[0].content = "0".repeat(64); state.write(); }, "INVENTORY_CANVAS_SBOM_BINARY_MISMATCH"],
  ["renamed binary reference", state => { state.document.components[0].name = "../other.node"; state.write(); }, "INVENTORY_CANVAS_SBOM_BINARY_MISMATCH"],
  ["foreign SBOM platform", state => { state.document.metadata.component.name = "@napi-rs/canvas-linux-arm64-gnu"; state.write(); }, "INVENTORY_CANVAS_SBOM_INVALID"],
  ["foreign platform metadata", state => { state.packageDocument.cpu = ["arm64"]; state.write(); }, "INVENTORY_CANVAS_TARGET_MISMATCH"],
  ["libc mismatch", state => { state.options.libc = "musl"; }, "INVENTORY_CANVAS_TARGET_MISMATCH"],
  ["unknown libc", state => { state.options.libc = null; }, "INVENTORY_CANVAS_TARGET_UNSUPPORTED"],
  ["unqualified architecture", state => { state.options.architecture = "riscv64"; }, "INVENTORY_CANVAS_TARGET_UNSUPPORTED"],
  ["missing binding", state => { state.options.loadedBindings = []; }, "INVENTORY_CANVAS_BINDING_COUNT"],
  ["additional binding", state => { state.options.loadedBindings.push(state.binding); }, "INVENTORY_CANVAS_BINDING_COUNT"],
  ["duplicate SBOM reference", state => { state.document.components.push(state.document.components[1]); state.write(); }, "INVENTORY_CANVAS_SBOM_COMPONENT_INVALID"],
  ["missing native dependency", state => { state.document.components.splice(1, 1); state.write(); }, "INVENTORY_CANVAS_SBOM_LIBRARY_MISSING"],
  ["unversioned native dependency", state => { state.document.components[1].version = "unknown"; state.write(); }, "INVENTORY_CANVAS_SBOM_LIBRARY_MISSING"],
  ["missing dependency graph edge", state => { state.document.dependencies[0].dependsOn.pop(); state.write(); }, "INVENTORY_CANVAS_SBOM_DEPENDENCY_INVALID"],
  ["duplicate graph edge", state => { state.document.dependencies[0].dependsOn[0] = state.document.dependencies[0].dependsOn[1]; state.write(); }, "INVENTORY_CANVAS_SBOM_DEPENDENCY_INVALID"],
  ["unsupported SBOM schema", state => { state.document.specVersion = "1.7"; state.write(); }, "INVENTORY_CANVAS_SBOM_INVALID"],
  ["binding package version mismatch", state => { state.packageDocument.version = "1.0.12"; state.write(); }, "INVENTORY_CANVAS_TARGET_MISMATCH"],
  ["canvas optional dependency mismatch", state => { state.canvasDocument.optionalDependencies[state.packageDocument.name] = "1.0.12"; state.write(); }, "INVENTORY_CANVAS_TARGET_MISMATCH"],
];
for (const [name, change, code] of negatives) test(`Canvas inventory rejects ${name}`, t => {
  const state = fixture(t);
  change(state);
  assert.throws(state.observe, error => error.code === code);
});

test("Canvas inventory rejects a platform SBOM outside the application tree", t => {
  const state = fixture(t);
  state.options.loadedBindings = [path.join(os.tmpdir(), "skia.linux-x64-gnu.node")];
  assert.throws(state.observe, error => error.code === "INVENTORY_CANVAS_PATH_ESCAPE");
});

test("Canvas inventory rejects a linked platform directory even if its SBOM and binary agree", t => {
  const state = fixture(t);
  const actual = path.join(state.root, "native-content");
  fs.renameSync(state.platformRoot, actual);
  fs.symlinkSync(actual, state.platformRoot, "junction");
  assert.throws(state.observe, error => error.code === "INVENTORY_CANVAS_CONTENT_LINK");
});

test("Canvas inventory bounds SBOM size before JSON parsing", t => {
  const state = fixture(t);
  fs.writeFileSync(path.join(state.platformRoot, "sbom.cdx.json"), " ".repeat(2 * 1024 * 1024 + 1));
  assert.throws(state.observe, error => error.code === "INVENTORY_CANVAS_FILE_INVALID");
});

test("Canvas inventory observes stable pnpm-style hard links without claiming sole file ownership", t => {
  const state = fixture(t);
  fs.linkSync(state.binding, path.join(state.root, "pnpm-store-hardlink"));
  const report = state.observe();
  assert.equal(report.binary.observedLinkCount, 2);
  assert.equal(report.completenessClaimed, false);
});

test("Canvas inventory rejects mutation during descriptor reading even with restored size and mtime", t => {
  const state = fixture(t);
  const before = fs.statSync(state.binding);
  const original = fs.readSync;
  let changed = false;
  t.mock.method(fs, "readSync", (descriptor, ...args) => {
    const count = original(descriptor, ...args);
    if (!changed && fs.fstatSync(descriptor).ino === before.ino) {
      changed = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      fs.writeFileSync(state.binding, "changed-native-binary!!");
      assert.equal(fs.statSync(state.binding).size, before.size);
      fs.utimesSync(state.binding, before.atime, before.mtime);
    }
    return count;
  });
  assert.throws(state.observe, error => error.code === "INVENTORY_CANVAS_FILE_CHANGED");
  assert.equal(changed, true);
});

test("Canvas inventory rejects an added hard link during descriptor reading", t => {
  const state = fixture(t);
  const inode = fs.statSync(state.binding).ino;
  const original = fs.readSync;
  let changed = false;
  t.mock.method(fs, "readSync", (descriptor, ...args) => {
    const count = original(descriptor, ...args);
    if (!changed && fs.fstatSync(descriptor).ino === inode) {
      changed = true;
      fs.linkSync(state.binding, path.join(state.root, "new-hardlink"));
    }
    return count;
  });
  assert.throws(state.observe, error => error.code === "INVENTORY_CANVAS_FILE_CHANGED");
  assert.equal(changed, true);
});

test("Canvas inventory rejects replacement by identical bytes at the pathname during descriptor reading", t => {
  const state = fixture(t);
  const before = fs.statSync(state.binding);
  const bytes = fs.readFileSync(state.binding);
  const original = fs.readSync;
  let changed = false;
  t.mock.method(fs, "readSync", (descriptor, ...args) => {
    const count = original(descriptor, ...args);
    if (!changed && fs.fstatSync(descriptor).ino === before.ino) {
      changed = true;
      fs.renameSync(state.binding, path.join(state.root, "previous-binary"));
      fs.writeFileSync(state.binding, bytes);
      fs.utimesSync(state.binding, before.atime, before.mtime);
    }
    return count;
  });
  assert.throws(state.observe, error => error.code === "INVENTORY_CANVAS_FILE_CHANGED");
  assert.equal(changed, true);
});

test("Canvas inventory rejects a pathname swapped to a symlink after opening the descriptor", { skip: process.platform === "win32" }, t => {
  const state = fixture(t);
  const inode = fs.statSync(state.binding).ino;
  const target = path.join(state.root, "replacement-native-binary");
  fs.copyFileSync(state.binding, target);
  const original = fs.readSync;
  let changed = false;
  t.mock.method(fs, "readSync", (descriptor, ...args) => {
    const count = original(descriptor, ...args);
    if (!changed && fs.fstatSync(descriptor).ino === inode) {
      changed = true;
      fs.unlinkSync(state.binding);
      fs.symlinkSync(target, state.binding);
    }
    return count;
  });
  assert.throws(state.observe, error => error.code === "INVENTORY_CANVAS_FILE_CHANGED");
  assert.equal(changed, true);
});
