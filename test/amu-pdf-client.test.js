"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createAmuPdfClient,
  DEFAULT_ASSET_PATHS,
  MAXIMUM_PAGE_COUNT,
} = require("../public/amu-pdf-client");

const REFERENCE_DATE = "2026-07-14T12:00:00Z";

function localFile(bytes = 128) {
  let reads = 0;
  return {
    name: "aum.pdf",
    type: "application/pdf",
    size: bytes,
    async arrayBuffer() {
      reads += 1;
      return new Uint8Array(bytes).buffer;
    },
    reads: () => reads,
  };
}

function pdfFixture(pageDefinitions, options = {}) {
  const calls = {
    getDocument: [],
    getPage: [],
    getTextContent: [],
    render: [],
    pageCleanup: [],
    documentCleanup: 0,
    destroy: 0,
  };
  const pageFor = (pageNumber) => {
    const definition = pageDefinitions[pageNumber - 1] || {};
    const baseWidth = Number(definition.width || 600);
    const baseHeight = Number(definition.height || 800);
    return {
      getViewport({ scale }) {
        return { width: baseWidth * scale, height: baseHeight * scale };
      },
      async getTextContent() {
        calls.getTextContent.push(pageNumber);
        return { items: String(definition.text || "").split(" ").filter(Boolean).map((str) => ({ str })) };
      },
      render(context) {
        calls.render.push({ pageNumber, context });
        return { promise: Promise.resolve(), cancel() {} };
      },
      cleanup() { calls.pageCleanup.push(pageNumber); },
    };
  };
  const document = {
    numPages: options.numPages || pageDefinitions.length,
    async getPage(pageNumber) {
      calls.getPage.push(pageNumber);
      return pageFor(pageNumber);
    },
    async cleanup() { calls.documentCleanup += 1; },
  };
  const loadingTask = {
    promise: Promise.resolve(document),
    async destroy() { calls.destroy += 1; },
  };
  const pdfjs = {
    GlobalWorkerOptions: {},
    AnnotationMode: { DISABLE: 0 },
    getDocument(input) {
      calls.getDocument.push(input);
      return loadingTask;
    },
  };
  return { calls, pdfjs };
}

function canvasFixture() {
  const canvases = [];
  return {
    canvases,
    createCanvas() {
      const canvas = {
        width: 0,
        height: 0,
        renderedWidth: 0,
        renderedHeight: 0,
        getContext() { return {}; },
      };
      Object.defineProperties(canvas, {
        width: {
          get() { return this.renderedWidthValue || 0; },
          set(value) {
            this.renderedWidthValue = value;
            if (value) this.renderedWidth = value;
          },
          configurable: true,
        },
        height: {
          get() { return this.renderedHeightValue || 0; },
          set(value) {
            this.renderedHeightValue = value;
            if (value) this.renderedHeight = value;
          },
          configurable: true,
        },
      });
      canvases.push(canvas);
      return canvas;
    },
  };
}

test("verwendet ausschlie\u00dflich versionierte, gleichurspr\u00fcngliche PDF.js-v6-Pfade", () => {
  assert.deepEqual(DEFAULT_ASSET_PATHS, {
    modulePath: "/vendor/pdfjs-v6.1.200/build/pdf.min.mjs",
    workerPath: "/vendor/pdfjs-v6.1.200/build/pdf.worker.min.mjs",
    cMapUrl: "/vendor/pdfjs-v6.1.200/cmaps/",
    standardFontDataUrl: "/vendor/pdfjs-v6.1.200/standard_fonts/",
    wasmUrl: "/vendor/pdfjs-v6.1.200/wasm/",
    iccUrl: "/vendor/pdfjs-v6.1.200/iccs/",
  });
  assert.ok(Object.values(DEFAULT_ASSET_PATHS).every((value) => value.startsWith("/") && !value.startsWith("//")));
  assert.throws(() => createAmuPdfClient({ paths: { modulePath: "https://cdn.invalid/pdf.mjs" }, pdfjs: {} }), /gleichurspr/);
});

test("liest eine digitale PDF lokal und gibt nur abgeleitete Datumswerte zur\u00fcck", async () => {
  const sensitive = "Name Erika Musterfrau Versicherungsnummer 1000 010190 Diagnose vertraulich Arbeitsunf\u00e4hig von 10.07.2026 bis 17.07.2026";
  const { calls, pdfjs } = pdfFixture([{ text: sensitive }]);
  let ocrCalls = 0;
  const file = localFile();
  const client = createAmuPdfClient({
    pdfjs,
    async recognizeCanvas() { ocrCalls += 1; return {}; },
  });
  const result = await client.recognize(file, { referenceDate: REFERENCE_DATE });

  assert.equal(file.reads(), 1);
  assert.equal(result.dateFrom, "2026-07-10");
  assert.equal(result.dateTo, "2026-07-17");
  assert.equal(result.complete, true);
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.socialSecurityNumber, "1000010190");
  assert.equal(result.socialSecurityStatus, "detected");
  assert.equal(ocrCalls, 0);
  assert.equal(calls.getDocument.length, 1);
  assert.ok(calls.getDocument[0].data instanceof Uint8Array);
  assert.equal(Object.hasOwn(calls.getDocument[0], "url"), false);
  assert.equal(calls.getDocument[0].enableXfa, false);
  assert.equal(calls.getDocument[0].stopAtErrors, true);
  assert.equal(pdfjs.GlobalWorkerOptions.workerSrc, DEFAULT_ASSET_PATHS.workerPath);
  assert.doesNotMatch(JSON.stringify(result), /Erika|Diagnose|vertraulich|Arbeitsunf/i);
  assert.equal(calls.destroy, 1);
  assert.equal(calls.documentCleanup, 1);
});

test("untersucht h\u00f6chstens drei Seiten und markiert l\u00e4ngere PDFs", async () => {
  const { calls, pdfjs } = pdfFixture([
    { text: "" }, { text: "" }, { text: "" }, { text: "" }, { text: "" },
  ], { numPages: 5 });
  const client = createAmuPdfClient({
    pdfjs,
    async recognizeCanvas() {
      return { dateFrom: "", dateTo: "", fieldConfidence: {}, warnings: ["no_date_detected"] };
    },
    createCanvas: () => ({ width: 0, height: 0, getContext: () => ({}) }),
  });
  const result = await client.recognize(localFile(), { referenceDate: REFERENCE_DATE });

  assert.equal(MAXIMUM_PAGE_COUNT, 3);
  assert.deepEqual([...new Set(calls.getPage)], [1, 2, 3]);
  assert.equal(calls.getPage.includes(4), false);
  assert.equal(calls.getPage.includes(5), false);
  assert.ok(result.warnings.includes("pdf_page_limit"));
});

test("rendert Scan-Seiten seriell innerhalb der Pixel- und Breitenlimits", async () => {
  const { calls, pdfjs } = pdfFixture([{ text: "", width: 2000, height: 3000 }]);
  const canvas = canvasFixture();
  const observed = [];
  const client = createAmuPdfClient({
    pdfjs,
    createCanvas: canvas.createCanvas,
    limits: { maxCanvasWidth: 1000, maxCanvasPixels: 500_000 },
    async recognizeCanvas(target, context) {
      observed.push({ width: target.width, height: target.height, context });
      return {
        dateFrom: "2026-07-10",
        dateTo: "2026-07-17",
        confidence: 0.95,
        fieldConfidence: { dateFrom: 0.96, dateTo: 0.95 },
        complete: true,
        autoFill: true,
        requiresConfirmation: true,
      };
    },
  });
  const result = await client.recognize(localFile(), { referenceDate: REFERENCE_DATE });

  assert.equal(result.complete, true);
  assert.equal(observed.length, 1);
  assert.ok(observed[0].width <= 1000);
  assert.ok(observed[0].width * observed[0].height <= 500_000);
  assert.deepEqual(observed[0].context, { pageNumber: 1, pageCount: 1, referenceDate: REFERENCE_DATE });
  assert.equal(calls.render.length, 1);
  assert.equal(calls.render[0].context.annotationMode, 0);
  assert.equal(canvas.canvases[0].width, 0);
  assert.equal(canvas.canvases[0].height, 0);
});

test("entfernt Rohtext und Freitext auch aus einem injizierten OCR-Ergebnis", async () => {
  const { pdfjs } = pdfFixture([{ text: "" }]);
  const client = createAmuPdfClient({
    pdfjs,
    createCanvas: () => ({ width: 0, height: 0, getContext: () => ({}) }),
    async recognizeCanvas() {
      return {
        text: "Diagnose streng vertraulich",
        medicalNote: "Erika Musterfrau",
        dateFrom: "2026-07-10",
        dateTo: "2026-07-17",
        confidence: 0.9,
        fieldConfidence: { dateFrom: 0.9, dateTo: 0.9 },
        complete: true,
        autoFill: true,
        warnings: ["Diagnose vertraulich", "manual_confirmation_recommended"],
        socialSecurityNumber: "1000010190",
        socialSecurityConfidence: 0.98,
        socialSecurityStatus: "detected",
      };
    },
  });
  const serialized = JSON.stringify(await client.recognize(localFile(), { referenceDate: REFERENCE_DATE }));
  assert.doesNotMatch(serialized, /Diagnose|vertraulich|Erika|medical|text/i);
  assert.match(serialized, /1000010190/);
});

test("markiert widersprüchliche SV-Nummern in einer digitalen PDF als mehrdeutig", async () => {
  const { pdfjs } = pdfFixture([
    { text: "Versicherungsnummer 1000 010190 Arbeitsunfähig von 10.07.2026 bis 17.07.2026" },
    { text: "SV-Nr. 1009 311299" },
  ]);
  const client = createAmuPdfClient({ pdfjs });
  const result = await client.recognize(localFile(), { referenceDate: REFERENCE_DATE });

  assert.equal(result.socialSecurityNumber, "");
  assert.equal(result.socialSecurityConfidence, 0);
  assert.equal(result.socialSecurityStatus, "ambiguous");
  assert.doesNotMatch(JSON.stringify(result), /Versicherungsnummer|SV-Nr|Arbeitsunfähig/i);
});

test("weist eine zu gro\u00dfe PDF vor dem Einlesen mit manueller Ausweichm\u00f6glichkeit ab", async () => {
  const { calls, pdfjs } = pdfFixture([{ text: "" }]);
  const file = localFile(11);
  const client = createAmuPdfClient({ pdfjs, limits: { maxFileBytes: 10 } });
  await assert.rejects(
    client.recognize(file),
    (error) => error.code === "AMU_PDF_FILE_TOO_LARGE" && /manuell/.test(error.message),
  );
  assert.equal(file.reads(), 0);
  assert.equal(calls.getDocument.length, 0);
});

test("kapselt Parser- und PDF.js-Fehler ohne interne Dokumentdetails", async () => {
  const pdfjs = {
    GlobalWorkerOptions: {},
    getDocument() {
      return {
        promise: Promise.reject(new Error("Patient Erika: kaputte interne xref")),
        async destroy() {},
      };
    },
  };
  const client = createAmuPdfClient({ pdfjs });
  await assert.rejects(
    client.recognize(localFile()),
    (error) => error.code === "AMU_PDF_INVALID"
      && !/Erika|xref|Patient/.test(error.message)
      && /manuell/.test(error.message),
  );
});
