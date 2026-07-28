"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const sharp = require("sharp");

const {
  LoanPhotoPdfError,
  MAX_LOAN_PHOTO_PDF_PHOTOS,
  MAX_LOAN_PHOTO_PDF_INPUT_BYTES,
  MAX_LOAN_PHOTO_PDF_BYTES,
  PDF_IMAGES_PER_PAGE,
  assertLoanPhotoPdfSize,
  prepareLoanPhotoPdfImage,
  renderLoanPhotoPdf,
} = require("../lib/loan-photo-pdf");

async function coloredPhoto(index, { metadata = false } = {}) {
  const colors = [
    { r: 214, g: 48, b: 49 },
    { r: 30, g: 132, b: 73 },
    { r: 41, g: 98, b: 171 },
    { r: 245, g: 176, b: 65 },
    { r: 133, g: 78, b: 162 },
  ];
  let pipeline = sharp({
    create: {
      width: 980 + (index * 17),
      height: 620 + (index * 11),
      channels: 3,
      background: colors[index % colors.length],
    },
  }).jpeg({ quality: 91 });
  if (metadata) pipeline = pipeline.withMetadata({ orientation: 6, density: 300 });
  return pipeline.toBuffer();
}

async function pdfTextAndPages(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: Uint8Array.from(buffer),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(" "));
      page.cleanup();
    }
    return { pageCount: document.numPages, pages };
  } finally {
    await loadingTask.destroy();
  }
}

test("Leihfoto-PDF bewahrt Reihenfolge, beschriftet Bilder und setzt zwei Fotos je A4-Seite", async () => {
  const photos = [];
  for (let index = 0; index < 5; index += 1) {
    photos.push({
      buffer: await coloredPhoto(index),
      position: index + 3,
      filename: `Reihenfolge-${index + 1}.jpg`,
    });
  }

  const result = await renderLoanPhotoPdf({
    photos,
    phase: "issue",
    outputMode: "grayscale",
    titleContext: {
      location: { id: "18", name: "Testfiliale" },
      loanId: "loan-test-42",
    },
  });
  assert.equal(result.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(result.length <= MAX_LOAN_PHOTO_PDF_BYTES);

  const inspected = await pdfTextAndPages(result);
  assert.equal(PDF_IMAGES_PER_PAGE, 2);
  assert.equal(inspected.pageCount, 3);
  assert.match(inspected.pages[0], /Leihfoto-Beilage - Ausgabe/);
  assert.match(inspected.pages[0], /18 - Testfiliale/);
  assert.match(inspected.pages[0], /Leihvorgang loan-test-42/);
  assert.match(inspected.pages[0], /Foto 3 - Reihenfolge-1\.jpg/);
  assert.match(inspected.pages[0], /Foto 4 - Reihenfolge-2\.jpg/);
  assert.match(inspected.pages[1], /Foto 5 - Reihenfolge-3\.jpg/);
  assert.match(inspected.pages[1], /Foto 6 - Reihenfolge-4\.jpg/);
  assert.match(inspected.pages[2], /Foto 7 - Reihenfolge-5\.jpg/);
});

test("Graustufen-Ausgabe entfernt Bildmetadaten und enthält nur einen Farbkanal", async () => {
  const source = await coloredPhoto(0, { metadata: true });
  const prepared = await prepareLoanPhotoPdfImage(source, "grayscale");
  const metadata = await sharp(prepared.buffer).metadata();

  assert.equal(prepared.mime, "image/jpeg");
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.space, "b-w");
  assert.equal(metadata.channels, 1);
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.xmp, undefined);
});

test("Schwarzweiß-Ausgabe enthält nach dem Dekodieren ausschließlich binäre Pixelwerte", async () => {
  const gradient = await sharp(Buffer.from(`
    <svg width="800" height="500" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g"><stop stop-color="#111"/><stop offset="1" stop-color="#eee"/></linearGradient></defs>
      <rect width="800" height="500" fill="url(#g)"/>
    </svg>
  `)).png().toBuffer();
  const prepared = await prepareLoanPhotoPdfImage(gradient, "blackwhite");
  const raw = await sharp(prepared.buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  const values = new Set(raw.data);

  assert.equal(prepared.mime, "image/png");
  assert.equal(raw.info.channels, 1);
  assert.deepEqual([...values].sort((left, right) => left - right), [0, 255]);

  const pdf = await renderLoanPhotoPdf({
    photos: [{ buffer: gradient, position: 1, filename: "Rueckgabe.png" }],
    phase: "return",
    outputMode: "blackwhite",
  });
  const inspected = await pdfTextAndPages(pdf);
  assert.equal(inspected.pageCount, 1);
  assert.match(inspected.pages[0], /Leihfoto-Beilage - Rückgabe/);
  assert.match(inspected.pages[0], /Geschützte Schwarzweiß-Beilage/);
});

test("Generator erzwingt Phase, Modus, Anzahl, Eingangs- und Ausgangsgröße mit stabilen Fehlercodes", async () => {
  const source = await coloredPhoto(0);
  await assert.rejects(
    renderLoanPhotoPdf({ photos: [{ buffer: source }], phase: "draft" }),
    { name: "LoanPhotoPdfError", code: "LOAN_PHOTO_PDF_PHASE_INVALID", status: 400 },
  );
  await assert.rejects(
    renderLoanPhotoPdf({ photos: [{ buffer: source }], phase: "issue", outputMode: "color" }),
    { name: "LoanPhotoPdfError", code: "LOAN_PHOTO_PDF_OUTPUT_MODE_INVALID", status: 400 },
  );
  await assert.rejects(
    renderLoanPhotoPdf({ photos: [], phase: "issue" }),
    { name: "LoanPhotoPdfError", code: "LOAN_PHOTO_PDF_PHOTOS_REQUIRED", status: 400 },
  );
  await assert.rejects(
    renderLoanPhotoPdf({
      photos: Array.from({ length: MAX_LOAN_PHOTO_PDF_PHOTOS + 1 }, () => ({ buffer: source })),
      phase: "issue",
    }),
    { name: "LoanPhotoPdfError", code: "LOAN_PHOTO_PDF_TOO_MANY_PHOTOS", status: 413 },
  );
  await assert.rejects(
    renderLoanPhotoPdf({
      photos: [{ buffer: Buffer.alloc(MAX_LOAN_PHOTO_PDF_INPUT_BYTES + 1) }],
      phase: "issue",
    }),
    { name: "LoanPhotoPdfError", code: "LOAN_PHOTO_PDF_PHOTO_TOO_LARGE", status: 413 },
  );
  await assert.rejects(
    renderLoanPhotoPdf({ photos: [{ buffer: Buffer.from("kein bild") }], phase: "issue" }),
    { name: "LoanPhotoPdfError", code: "LOAN_PHOTO_PDF_PHOTO_INVALID", status: 415 },
  );

  assert.throws(
    () => assertLoanPhotoPdfSize(Buffer.alloc(MAX_LOAN_PHOTO_PDF_BYTES + 1)),
    { name: "LoanPhotoPdfError", code: "LOAN_PHOTO_PDF_OUTPUT_TOO_LARGE", status: 413 },
  );
  assert.ok(new LoanPhotoPdfError("test", "TEST", 409) instanceof Error);
});
