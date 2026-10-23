"use strict";

// Offline interpretation of the upstream platform SBOM. Hash binding shows
// which declaration accompanies the loaded binary; it is not a vulnerability
// clearance, independent build proof or authenticity signature.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const knownVersion = "1.0.13";
const requiredSkiaLibraries = ["expat", "freetype", "brotli", "harfbuzz", "icu", "libjxl", "highway", "libjpeg-turbo", "libpng", "libwebp", "wuffs", "zlib"];

function fail(code) { throw Object.assign(new Error(code), { code }); }
function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}
function record(root, file, maximumBytes) {
  file = path.resolve(file);
  if (!within(root, file) || !within(root, fs.realpathSync.native(file))) fail("INVENTORY_CANVAS_PATH_ESCAPE");
  function directoryChain() {
    const result = [];
    for (let directory = path.dirname(file); directory !== root; directory = path.dirname(directory)) {
      if (!within(root, directory)) fail("INVENTORY_CANVAS_PATH_ESCAPE");
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVENTORY_CANVAS_CONTENT_LINK");
      result.push([directory, stat.dev, stat.ino]);
    }
    return JSON.stringify(result);
  }
  const chain = directoryChain();
  const before = fs.lstatSync(file);
  // pnpm can import ordinary package files as hard links into its store. Bind
  // the descriptor and stable link count instead of claiming sole ownership.
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes || !Number.isSafeInteger(before.nlink) || before.nlink < 1) fail("INVENTORY_CANVAS_FILE_INVALID");
  const same = stat => stat.isFile() && !stat.isSymbolicLink() && ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every(key => stat[key] === before[key]);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!same(fs.fstatSync(descriptor))) fail("INVENTORY_CANVAS_FILE_CHANGED");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count < 1) fail("INVENTORY_CANVAS_FILE_CHANGED");
      offset += count;
    }
    if (!same(fs.fstatSync(descriptor)) || !same(fs.lstatSync(file)) || directoryChain() !== chain
      || !within(root, fs.realpathSync.native(file))) fail("INVENTORY_CANVAS_FILE_CHANGED");
    return { bytes, evidence: { path: path.relative(root, file).split(path.sep).join("/"), bytes: bytes.length, sha256: sha256(bytes), observedLinkCount: before.nlink } };
  } finally { fs.closeSync(descriptor); }
}
function jsonRecord(root, file) {
  const result = record(root, file, 2 * 1024 * 1024);
  try { return { document: JSON.parse(result.bytes.toString("utf8")), evidence: result.evidence }; }
  catch { fail("INVENTORY_CANVAS_JSON_INVALID"); }
}
function text(value, maximum = 4096) { return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value); }

function canvasNativeInventory({ applicationRoot, canvasRoot, loadedBindings, platform = process.platform, architecture = process.arch, libc = null }) {
  const root = fs.realpathSync.native(path.resolve(applicationRoot));
  const modules = path.join(root, "node_modules");
  if (!within(modules, canvasRoot)) fail("INVENTORY_CANVAS_PATH_ESCAPE");
  const metadata = jsonRecord(root, path.join(canvasRoot, "package.json"));
  if (metadata.document.name !== "@napi-rs/canvas" || !text(metadata.document.version, 80)) fail("INVENTORY_CANVAS_PACKAGE_INVALID");
  if (metadata.document.version !== knownVersion) {
    return { status: "unknown", reason: "No qualified platform SBOM interpretation for this Canvas version", version: metadata.document.version,
      vulnerabilityAssessment: "not-performed", completenessClaimed: false };
  }
  const suffix = platform === "linux" ? ({ glibc: "gnu", musl: "musl" })[libc] : platform === "win32" ? "msvc" : platform === "darwin" ? "" : null;
  if (suffix === undefined || suffix === null || !["x64", "arm64"].includes(architecture)) fail("INVENTORY_CANVAS_TARGET_UNSUPPORTED");
  const target = `${platform}-${architecture}${suffix ? "-" + suffix : ""}`;
  const expectedName = "@napi-rs/canvas-" + target;
  const bindings = loadedBindings.filter(file => /^skia\..*\.node$/.test(path.basename(file)));
  if (bindings.length !== 1) fail("INVENTORY_CANVAS_BINDING_COUNT");
  const binding = bindings[0];
  if (path.basename(binding) !== "skia." + target + ".node") fail("INVENTORY_CANVAS_TARGET_MISMATCH");
  const platformRoot = path.dirname(binding);
  if (!within(modules, platformRoot)) fail("INVENTORY_CANVAS_PATH_ESCAPE");
  const platformPackage = jsonRecord(root, path.join(platformRoot, "package.json"));
  const packageDocument = platformPackage.document;
  if (packageDocument.name !== expectedName || packageDocument.version !== knownVersion || metadata.document.optionalDependencies?.[expectedName] !== knownVersion
    || packageDocument.os?.length !== 1 || packageDocument.os[0] !== platform || packageDocument.cpu?.length !== 1 || packageDocument.cpu[0] !== architecture
    || (platform === "linux" && (packageDocument.libc?.length !== 1 || packageDocument.libc[0] !== libc))) fail("INVENTORY_CANVAS_TARGET_MISMATCH");
  const binary = record(root, binding, 128 * 1024 * 1024);
  const sbom = jsonRecord(root, path.join(platformRoot, "sbom.cdx.json"));
  const document = sbom.document;
  const purl = "pkg:npm/%40napi-rs/canvas-" + target + "@" + knownVersion;
  if (document.bomFormat !== "CycloneDX" || document.specVersion !== "1.6" || document.version !== 1
    || document.metadata?.component?.name !== expectedName || document.metadata.component.version !== knownVersion
    || document.metadata.component.purl !== purl || document.metadata.component["bom-ref"] !== purl
    || !Array.isArray(document.components) || document.components.length < 2 || document.components.length > 2048) fail("INVENTORY_CANVAS_SBOM_INVALID");
  const references = new Set();
  const components = document.components.map(component => {
    if (!component || !["library", "file"].includes(component.type) || !text(component.name, 200) || !text(component["bom-ref"])
      || !text(component.purl) || references.has(component["bom-ref"])) fail("INVENTORY_CANVAS_SBOM_COMPONENT_INVALID");
    references.add(component["bom-ref"]);
    if (component.type === "library" && !text(component.version, 200)) fail("INVENTORY_CANVAS_SBOM_COMPONENT_INVALID");
    if (component.hashes !== undefined && (!Array.isArray(component.hashes) || component.hashes.length > 8
      || component.hashes.some(hash => hash.alg !== "SHA-256" || !/^[a-f0-9]{64}$/.test(hash.content)))) fail("INVENTORY_CANVAS_SBOM_HASH_INVALID");
    if (component.properties !== undefined && (!Array.isArray(component.properties) || component.properties.length > 32
      || component.properties.some(property => !text(property.name, 200) || !text(property.value)))) fail("INVENTORY_CANVAS_SBOM_PROPERTY_INVALID");
    return { type: component.type, name: component.name, version: component.version || null, purl: component.purl, bomRef: component["bom-ref"],
      hashes: component.hashes || [], properties: component.properties || [] };
  });
  const fileComponents = components.filter(component => component.type === "file");
  if (fileComponents.length !== 1 || fileComponents[0].name !== path.basename(binding) || fileComponents[0].bomRef !== path.basename(binding)
    || fileComponents[0].purl !== purl + "#" + path.basename(binding) || fileComponents[0].hashes.length !== 1
    || fileComponents[0].hashes[0].content !== binary.evidence.sha256) fail("INVENTORY_CANVAS_SBOM_BINARY_MISMATCH");
  for (const library of requiredSkiaLibraries) {
    // Upstream does not enable JXL on riscv64; that target is deliberately not
    // in this initially qualified x64/arm64 parser policy.
    const matching = components.filter(component => component.type === "library" && component.name === library);
    if (matching.length !== 1 || !/^[a-f0-9]{40}$/.test(matching[0].version)
      || !matching[0].purl.startsWith("pkg:generic/" + library + "@" + matching[0].version + "?repository_url=https%3A%2F%2F")
      || !matching[0].properties.some(property => property.name === "cdx:skia:repositoryUrl" && property.value.startsWith("https://"))) fail("INVENTORY_CANVAS_SBOM_LIBRARY_MISSING");
  }
  const dependency = document.dependencies;
  if (!Array.isArray(dependency) || dependency.length !== 1 || dependency[0].ref !== purl || !Array.isArray(dependency[0].dependsOn)
    || dependency[0].dependsOn.length !== references.size || new Set(dependency[0].dependsOn).size !== references.size
    || dependency[0].dependsOn.some(reference => !references.has(reference))) fail("INVENTORY_CANVAS_SBOM_DEPENDENCY_INVALID");
  return { status: "sbom-bound", version: knownVersion, platform, architecture, libc: platform === "linux" ? libc : null,
    platformPackage: { name: expectedName, version: knownVersion, metadata: platformPackage.evidence },
    binary: binary.evidence, upstreamSbom: { ...sbom.evidence, format: "CycloneDX", specVersion: "1.6" }, components,
    vulnerabilityAssessment: "not-performed", completenessClaimed: false,
    scope: "Upstream platform SBOM declarations bound to actual loaded binary bytes; Cargo graph may include build-only components; not a CVE clearance, signature or independent build proof" };
}

module.exports = { canvasNativeInventory };
