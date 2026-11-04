"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { canvasNativeInventory } = require("../lib/security-native-canvas-inventory");

const root = path.resolve(__dirname, "..");
const pdfRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
const pdfRequire = createRequire(path.join(pdfRoot, "package.json"));
const canvas = pdfRequire("@napi-rs/canvas");
const canvasRoot = path.dirname(pdfRequire.resolve("@napi-rs/canvas/package.json"));
const metadata = JSON.parse(fs.readFileSync(path.join(canvasRoot, "package.json"), "utf8"));
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const pixel = (surface, x = 0, y = 0) => [...surface.getContext("2d").getImageData(x, y, 1, 1).data];
const font = path.join(root, "public", "fonts", "price-labels", "fira-sans", "Regular.ttf");

async function binarySbom() {
  const bindings = Object.keys(require.cache).filter(file => /[/\\]@napi-rs[/\\]canvas-[^/\\]+[/\\]skia\.[^/\\]+\.node$/.test(file));
  assert.equal(bindings.length, 1, "Exactly one native platform binding must be loaded");
  const binary = fs.realpathSync(bindings[0]);
  const packageRoot = path.dirname(binary);
  const platformPackage = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(platformPackage.version, metadata.version);
  assert.equal(metadata.optionalDependencies[platformPackage.name], metadata.version);
  const sbomBytes = fs.readFileSync(path.join(packageRoot, "sbom.cdx.json"));
  const sbom = JSON.parse(sbomBytes);
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.metadata.component.name, platformPackage.name);
  assert.equal(sbom.metadata.component.version, metadata.version);
  const binaryEntries = sbom.components.filter(component => component.type === "file" && component.name === path.basename(binary));
  assert.equal(binaryEntries.length, 1);
  assert.equal(binaryEntries[0].hashes.find(hash => hash.alg === "SHA-256")?.content, sha256(fs.readFileSync(binary)), "Upstream platform SBOM must bind the actual loaded binary");
  const libraries = sbom.components.filter(component => component.type === "library");
  for (const name of ["expat", "freetype", "harfbuzz", "icu", "libjpeg-turbo", "libpng", "libwebp", "zlib"]) {
    const component = libraries.find(value => value.name === name);
    assert.ok(component, `Missing bundled library ${name}`);
    assert.match(component.version, /^[a-f0-9]{40}$/);
    assert.ok(component.properties.some(property => property.name === "cdx:skia:repositoryUrl" && property.value.startsWith("https://")));
  }
  const observed = canvasNativeInventory({ applicationRoot: root, canvasRoot,
    loadedBindings: bindings, libc: process.platform === "linux" ? (process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl") : null });
  assert.equal(observed.status, "sbom-bound");
  assert.equal(observed.components.length, sbom.components.length);
  assert.equal(observed.binary.sha256, sha256(fs.readFileSync(binary)));
  assert.equal(observed.vulnerabilityAssessment, "not-performed");
  return { platformPackage: platformPackage.name, binarySha256: sha256(fs.readFileSync(binary)), sbomSha256: sha256(sbomBytes), libraryComponents: libraries.length, releaseInventoryStatus: observed.status };
}

async function malformedRaster() {
  const valid = canvas.createCanvas(4, 4);
  valid.getContext("2d").fillRect(0, 0, 4, 4);
  const png = await valid.encode("png");
  const truncated = [
    Buffer.alloc(0),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    png.subarray(0, 24),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]),
    Buffer.from("GIF89a\x04\x00\x04\x00\x80\x00\x00", "binary"),
  ];
  for (const bytes of truncated) await assert.rejects(() => canvas.loadImage(bytes));
  // A rejected parser input must not poison a subsequent valid decode.
  const decoded = await canvas.loadImage(png);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 4);
  return { rejectedInputs: truncated.length, validDecodeAfterRejection: true };
}

async function encodeLifetime() {
  let surface = canvas.createCanvas(16, 16);
  let context = surface.getContext("2d");
  context.fillStyle = "#ff0000";
  context.fillRect(0, 0, 16, 16);
  const redSnapshot = surface.encode("png");
  context.fillStyle = "#0000ff";
  context.fillRect(0, 0, 16, 16);
  const blueSnapshot = surface.encode("png");
  context = null;
  surface = null;
  global.gc();
  for (const [pending, expected] of [[redSnapshot, [255, 0, 0, 255]], [blueSnapshot, [0, 0, 255, 255]]]) {
    const decoded = await canvas.loadImage(await pending);
    const target = canvas.createCanvas(16, 16);
    target.getContext("2d").drawImage(decoded, 0, 0);
    assert.deepEqual(pixel(target), expected, "Async encode must retain the call-time snapshot and native surface");
  }
  return { snapshots: 2, forcedGarbageCollection: true };
}

async function patternGc() {
  const surface = canvas.createCanvas(16, 16);
  const context = surface.getContext("2d");
  let source = canvas.createCanvas(2, 2);
  source.getContext("2d").fillStyle = "#00ff00";
  source.getContext("2d").fillRect(0, 0, 2, 2);
  let pattern = context.createPattern(source, "repeat");
  context.fillStyle = pattern;
  context.save();
  context.fillStyle = "#ff0000";
  pattern = null;
  source = null;
  global.gc();
  context.restore();
  context.fillRect(0, 0, 16, 16);
  assert.deepEqual(pixel(surface), [0, 255, 0, 255], "Restoring a saved pattern after GC must retain native ownership");
  assert.ok((await surface.encode("png")).length > 0);
  return { restoredSavedPatternAfterGc: true };
}

async function localFont() {
  assert.ok(canvas.GlobalFonts.registerFromPath(font, "GP Native Qualification"));
  const surface = canvas.createCanvas(640, 120);
  const context = surface.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, surface.width, surface.height);
  context.fillStyle = "#000000";
  context.font = '28px "GP Native Qualification"';
  const text = "Prüfung ÄÖÜ äöü ß € 123,45";
  const metrics = context.measureText(text);
  assert.ok(Number.isFinite(metrics.width) && metrics.width > 100 && metrics.width < surface.width);
  context.fillText(text, 10, 60);
  const pixels = context.getImageData(0, 0, surface.width, surface.height).data;
  let darkPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 128 && pixels[index + 1] < 128 && pixels[index + 2] < 128) darkPixels += 1;
  assert.ok(darkPixels > 200, "The versioned local font must actually render glyphs");
  return { fontSha256: sha256(fs.readFileSync(font)), darkPixels, measuredWidth: metrics.width };
}

async function pdfRender() {
  const PDFDocument = require("pdfkit");
  const bytes = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [360, 160], margin: 20, compress: false });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.font("Helvetica").fontSize(18).text("GP Standardfont 123,45");
    doc.addPage().font(font).fontSize(18).text("GP Prüfung ÄÖÜ äöü ß Euro");
    doc.end();
  });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const asset = name => path.join(pdfRoot, name).split(path.sep).join("/") + "/";
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, isEvalSupported: false, enableXfa: false, stopAtErrors: true,
    standardFontDataUrl: asset("standard_fonts"), cMapUrl: asset("cmaps"), cMapPacked: true, wasmUrl: asset("wasm"), iccUrl: asset("iccs") });
  try {
    const document = await task.promise;
    assert.equal(document.numPages, 2);
    for (let number = 1; number <= 2; number += 1) {
      const page = await document.getPage(number);
      try {
        const text = (await page.getTextContent()).items.map(item => item.str || "").join(" ");
        assert.match(text, number === 1 ? /GP Standardfont 123,45/ : /GP Prüfung ÄÖÜ äöü ß Euro/);
        const viewport = page.getViewport({ scale: 2 });
        const surface = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvasContext: surface.getContext("2d"), viewport, background: "#ffffff", annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
        const png = await surface.encode("png");
        const image = await canvas.loadImage(png);
        assert.equal(image.width, 720);
        assert.equal(image.height, 320);
        const pixels = surface.getContext("2d").getImageData(0, 0, surface.width, surface.height).data;
        assert.ok(pixels.some((value, index) => index % 4 !== 3 && value < 128), "PDF text must produce visible raster content");
        surface.width = 0;
        surface.height = 0;
      } finally { page.cleanup(); }
    }
  } finally { await task.destroy(); }
  return { pages: 2, standardFontAndEmbeddedFont: true, networkAssetsRequired: false };
}

const scenarios = { "binary-sbom": binarySbom, "malformed-raster": malformedRaster, "encode-lifetime": encodeLifetime, "pattern-gc": patternGc, "local-font": localFont, "pdf-render": pdfRender };
const scenario = process.argv[2];
assert.equal(scenario, process.env.GP_CANVAS_QUALIFICATION_SCENARIO);
assert.equal(metadata.version, "1.0.13");
assert.equal(typeof global.gc, "function");
assert.ok(Object.hasOwn(scenarios, scenario));
scenarios[scenario]().then(details => {
  console.log("GP_CANVAS_QUALIFICATION " + JSON.stringify({ scenario, passed: true, version: metadata.version, platform: process.platform, architecture: process.arch, ...details }));
}).catch(error => { console.error(error); process.exitCode = 1; });
