"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sharp = require("sharp");

const {
  createAmuStorage,
  detectDocumentType,
} = require("../lib/amu-storage");
const {
  imageToA4Pdf,
  prepareAmuDocument,
} = require("../lib/amu-processing");

const roots = [];

function temporaryDirectory(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `grabenplaner-amu-processing-${label}-`));
  roots.push(directory);
  return directory;
}

function pdfBuffer(extraBytes = 0) {
  return Buffer.concat([
    Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF", "ascii"),
    Buffer.alloc(extraBytes, 0x20),
  ]);
}

async function sourceImage(format = "jpeg") {
  const svg = Buffer.from(`
    <svg width="1800" height="2400" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g"><stop stop-color="#fff"/><stop offset="1" stop-color="#557799"/></linearGradient></defs>
      <rect width="1800" height="2400" fill="url(#g)"/>
      <rect x="90" y="120" width="1620" height="2160" rx="24" fill="#fff" stroke="#111" stroke-width="8"/>
      <text x="180" y="360" font-size="96" fill="#111">Arbeitsunfähigkeitsmeldung</text>
      <text x="180" y="560" font-size="70" fill="#333">Testdokument mit gut lesbarer Schrift</text>
      <path d="M180 740 H1600 M180 900 H1600 M180 1060 H1600 M180 1220 H1600" stroke="#335577" stroke-width="12"/>
    </svg>
  `, "utf8");
  const pipeline = sharp(svg);
  if (format === "png") return pipeline.png().toBuffer();
  if (format === "webp") return pipeline.webp({ quality: 92 }).toBuffer();
  if (format === "tiff") return pipeline.tiff({ quality: 90 }).toBuffer();
  return pipeline.jpeg({ quality: 94 }).toBuffer();
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test("WEBP und TIFF werden anhand ihrer Magic Bytes erkannt", async () => {
  const webp = await sourceImage("webp");
  const tiff = await sourceImage("tiff");
  assert.equal(detectDocumentType(webp, "aufnahme.webp").mimeType, "image/webp");
  assert.equal(detectDocumentType(tiff, "aufnahme.tif").mimeType, "image/tiff");
});

test("Bilder werden gedreht, maßvoll komprimiert und als A4-PDF ausgegeben", async () => {
  const jpeg = await sourceImage("jpeg");
  const result = await imageToA4Pdf(jpeg, { maxBytes: 500 * 1024, grayscale: true });
  assert.equal(result.buffer.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(result.byteSize <= 500 * 1024);
  assert.ok(result.longEdge >= 900);
  assert.ok(result.quality >= 55);
  assert.equal(result.grayscale, true);
});

test("EXIF-Ausrichtung von Handyfotos wird vor dem PDF-Export angewendet", async () => {
  const source = await sharp({
    create: { width: 1200, height: 600, channels: 3, background: "#f7f7f7" },
  }).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();
  const result = await prepareAmuDocument({
    buffer: source,
    originalName: "handyfoto.jpg",
    maxStoredBytes: 300 * 1024,
  });
  assert.ok(result.processing.height > result.processing.width);
});

test("JPEG, PNG, WEBP und TIFF werden über dieselbe robuste Pipeline konvertiert", async () => {
  for (const format of ["jpeg", "png", "webp", "tiff"]) {
    const input = await sourceImage(format);
    const result = await prepareAmuDocument({
      buffer: input,
      originalName: `krankmeldung.${format}`,
      maxStoredBytes: 700 * 1024,
      grayscale: false,
    });
    assert.equal(result.converted, true, format);
    assert.equal(result.detectedMime, "application/pdf", format);
    assert.equal(result.originalFilename, "krankmeldung.pdf", format);
    assert.equal(result.buffer.subarray(0, 5).toString("ascii"), "%PDF-", format);
    assert.ok(result.byteSize <= 700 * 1024, format);
  }
});

test("Originalscan läuft vor der Bildkonvertierung und erhält das unveränderte Bild", async () => {
  const source = await sourceImage("png");
  const scanned = [];
  const result = await prepareAmuDocument({
    buffer: source,
    originalName: "Handyfoto.png",
    maxStoredBytes: 700 * 1024,
    scanOriginal: async (document) => {
      scanned.push(document);
      return { available: true, clean: true, engine: "test" };
    },
  });
  assert.equal(scanned.length, 1);
  assert.strictEqual(scanned[0].buffer, source);
  assert.equal(scanned[0].originalName, "Handyfoto.png");
  assert.equal(result.scanResult.engine, "test");
});

test("PDFs bleiben bytegenau unverändert und werden bei Überschreitung nicht unlesbar komprimiert", async () => {
  const source = pdfBuffer();
  const result = await prepareAmuDocument({ buffer: source, originalName: "AUM.PDF", maxStoredBytes: 1024 });
  assert.strictEqual(result.buffer, source);
  assert.equal(result.originalFilename, "AUM.pdf");
  assert.equal(result.converted, false);

  await assert.rejects(
    prepareAmuDocument({ buffer: pdfBuffer(2048), originalName: "zu-gross.pdf", maxStoredBytes: 1024 }),
    { code: "AMU_DOCUMENT_STORAGE_LIMIT_EXCEEDED" },
  );
});

test("Ein unrealistisch kleines Speicherlimit liefert einen klaren Fehler statt unlesbarer Qualität", async () => {
  const source = await sourceImage("jpeg");
  await assert.rejects(
    imageToA4Pdf(source, { maxBytes: 500, grayscale: true }),
    { code: "AMU_DOCUMENT_TOO_LARGE_AFTER_PROCESSING" },
  );
});

test("AMU-Speicher akzeptiert konfigurierbare Limits und scanBuffer hinterlässt keinen Klartext", async () => {
  const root = temporaryDirectory("scan");
  const scans = [];
  const storage = createAmuStorage({
    rootDirectory: root,
    encryptionKeys: { primary: Buffer.alloc(32, 3) },
    activeKeyId: "primary",
    maxDocumentBytes: 12 * 1024 * 1024,
    requireScanner: true,
    scanner: async (filePath) => {
      scans.push(fs.readFileSync(filePath));
      return { available: true, clean: true, engine: "test-scanner" };
    },
  });
  const source = pdfBuffer(10 * 1024 * 1024);
  const scanned = await storage.scanBuffer({ buffer: source, originalName: "gross.pdf" });
  assert.equal(scanned.clean, true);
  assert.equal(scans.length, 1);
  assert.deepEqual(scans[0], source);
  assert.deepEqual(fs.readdirSync(path.join(root, "tmp")), []);
  assert.deepEqual(fs.readdirSync(path.join(root, "blobs")), []);
  assert.equal(storage.diagnostics().maxDocumentBytes, 12 * 1024 * 1024);

  await assert.rejects(
    storage.scanBuffer({ buffer: source, originalName: "gross.pdf", maxBytes: 1024 }),
    { code: "AMU_DOCUMENT_TOO_LARGE" },
  );
});
