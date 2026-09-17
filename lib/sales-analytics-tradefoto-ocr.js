"use strict";

const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const path = require("node:path");

const germanData = require("@tesseract.js-data/deu");
const { createWorker, OEM, PSM } = require("tesseract.js");

const {
  TRADEFOTO_REPORT_EXTRACTIONS,
  TRADEFOTO_REPORT_MAX_BYTES,
  TradeFotoReportError,
  trustTradeFotoReportPages,
} = require("./sales-analytics-tradefoto-report");

const TRADEFOTO_OCR_ENGINE_VERSION = "local-tesseract-v7-deu-1";
const TRADEFOTO_OCR_MAX_PAGES = 30;
const TRADEFOTO_OCR_MAX_CANVAS_PIXELS = 8_000_000;
const TRADEFOTO_OCR_MAX_CANVAS_WIDTH = 3_200;
const TRADEFOTO_OCR_MAX_TOTAL_WORDS = 60_000;
const TRADEFOTO_OCR_MAX_WORDS_PER_PAGE = 8_000;
const TRADEFOTO_OCR_PAGE_TIMEOUT_MS = 45_000;
const TRADEFOTO_OCR_MAX_QUEUED_JOBS = 2;

let queuedJobs = 0;
let ocrQueue = Promise.resolve();

function ocrError(code, details = {}) {
  return new TradeFotoReportError(code, details);
}

function cleanOcrText(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeNumericOcrToken(value, x) {
  let text = cleanOcrText(value);
  const numericZone = x < 50 || x > 120;
  if (!numericZone || !/[0-9OoQqIl|SsBbDd]/.test(text)
    || !/^[0-9OoQqIl|SsBbDd.,'’`´+\-]+$/.test(text)) {
    return text;
  }
  text = text
    .replace(/[OoQq]/g, "0")
    .replace(/[Dd]/g, "0")
    .replace(/[Il|]/g, "1")
    .replace(/[Ss]/g, "5")
    .replace(/[Bb]/g, "8")
    .replace(/['’`´]/g, "");
  return text;
}

function finiteBbox(value) {
  if (!value || typeof value !== "object") return null;
  const x0 = Number(value.x0);
  const y0 = Number(value.y0);
  const x1 = Number(value.x1);
  const y1 = Number(value.y1);
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

function wordsFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const lines = [];
  for (const block of blocks) {
    for (const paragraph of Array.isArray(block?.paragraphs) ? block.paragraphs : []) {
      for (const line of Array.isArray(paragraph?.lines) ? paragraph.lines : []) {
        const words = (Array.isArray(line?.words) ? line.words : [])
          .map((word) => ({
            text: cleanOcrText(word?.text),
            confidence: Number(word?.confidence),
            bbox: finiteBbox(word?.bbox),
          }))
          .filter((word) => word.text && word.text.length <= 80 && word.bbox);
        if (!words.length) continue;
        const lineBox = finiteBbox(line?.bbox) || {
          x0: Math.min(...words.map((word) => word.bbox.x0)),
          y0: Math.min(...words.map((word) => word.bbox.y0)),
          x1: Math.max(...words.map((word) => word.bbox.x1)),
          y1: Math.max(...words.map((word) => word.bbox.y1)),
        };
        lines.push({ lineBox, words });
      }
    }
  }
  return lines;
}

function pageItemsFromRecognition(blocks, { pageHeight, scale }) {
  const items = [];
  for (const line of wordsFromBlocks(blocks)) {
    const y = pageHeight - ((line.lineBox.y0 + line.lineBox.y1) / 2 / scale);
    for (const word of line.words) {
      if (items.length >= TRADEFOTO_OCR_MAX_WORDS_PER_PAGE) {
        throw ocrError("TRADEFOTO_REPORT_OCR_WORD_LIMIT", {
          maximumWordsPerPage: TRADEFOTO_OCR_MAX_WORDS_PER_PAGE,
        });
      }
      const x = word.bbox.x0 / scale;
      const width = (word.bbox.x1 - word.bbox.x0) / scale;
      items.push(Object.freeze({
        text: normalizeNumericOcrToken(word.text, x),
        x,
        y,
        width,
        confidence: Number.isFinite(word.confidence)
          ? Math.max(0, Math.min(100, word.confidence))
          : 0,
      }));
    }
  }
  const merged = [];
  for (const item of items.sort((left, right) => (
    Math.abs(left.y - right.y) <= 1 ? left.x - right.x : right.y - left.y
  ))) {
    const previous = merged[merged.length - 1];
    const previousRight = previous ? previous.x + previous.width : 0;
    if (previous
      && Math.abs(previous.y - item.y) <= 1
      && previous.x >= 20 && previous.x < 50
      && item.x >= 20 && item.x < 50
      && /^\d{1,3}$/.test(previous.text)
      && /^\d{1,3}$/.test(item.text)
      && `${previous.text}${item.text}`.length <= 4
      && item.x - previousRight <= 6) {
      merged[merged.length - 1] = Object.freeze({
        text: `${previous.text}${item.text}`,
        x: previous.x,
        y: previous.y,
        width: Math.max(previousRight, item.x + item.width) - previous.x,
        confidence: Math.min(previous.confidence, item.confidence),
      });
    } else {
      merged.push(item);
    }
  }
  return merged;
}

function renderViewport(page) {
  const base = page.getViewport({ scale: 1 });
  const width = Number(base?.width);
  const height = Number(base?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw ocrError("TRADEFOTO_REPORT_OCR_PAGE_INVALID");
  }
  const widthScale = TRADEFOTO_OCR_MAX_CANVAS_WIDTH / width;
  const pixelScale = Math.sqrt(TRADEFOTO_OCR_MAX_CANVAS_PIXELS / (width * height));
  const scale = Math.max(0.5, Math.min(300 / 72, widthScale, pixelScale));
  return { base, scale, viewport: page.getViewport({ scale }) };
}

function localPdfAssetPath(relativePath) {
  const packageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  // PDF.js' NodeBinaryDataFactory passes this string to fs.readFile, which
  // accepts a filesystem path but not a string containing a file: URL.
  return `${path.join(packageRoot, relativePath).replaceAll("\\", "/")}/`;
}

function localCanvasFactory() {
  try {
    const pdfRequire = createRequire(require.resolve("pdfjs-dist/package.json"));
    const canvas = pdfRequire("@napi-rs/canvas");
    if (!canvas || typeof canvas.createCanvas !== "function") throw new Error("canvas-unavailable");
    return canvas.createCanvas;
  } catch {
    throw ocrError("TRADEFOTO_REPORT_OCR_UNAVAILABLE", { component: "canvas" });
  }
}

async function withTimeout(promise, timeoutMs, code) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(ocrError(code, { timeoutMs })), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runSerializedOcr(work) {
  if (queuedJobs >= TRADEFOTO_OCR_MAX_QUEUED_JOBS) {
    throw ocrError("TRADEFOTO_REPORT_OCR_BUSY", {
      maximumQueuedJobs: TRADEFOTO_OCR_MAX_QUEUED_JOBS,
    });
  }
  queuedJobs += 1;
  const run = ocrQueue.then(work);
  ocrQueue = run.catch(() => {});
  try {
    return await run;
  } finally {
    queuedJobs -= 1;
  }
}

async function inspectTradeFotoOcrReportBuffer(
  buffer,
  { fileName = "TradeFoto-Statistik.pdf" } = {},
) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5 || buffer.length > TRADEFOTO_REPORT_MAX_BYTES) {
    throw ocrError("TRADEFOTO_REPORT_FILE_SIZE_INVALID", {
      maximumBytes: TRADEFOTO_REPORT_MAX_BYTES,
    });
  }
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw ocrError("TRADEFOTO_REPORT_PDF_INVALID");
  }
  const sourceFileSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  return runSerializedOcr(async () => {
    const createCanvas = localCanvasFactory();
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    let loadingTask = null;
    let pdf = null;
    let worker = null;
    let totalWords = 0;
    let confidenceTotal = 0;
    let confidenceCount = 0;
    let lowConfidenceWordCount = 0;
    try {
      loadingTask = pdfjs.getDocument({
        data: new Uint8Array(buffer),
        disableWorker: true,
        disableFontFace: true,
        enableXfa: false,
        isEvalSupported: false,
        useSystemFonts: false,
        stopAtErrors: true,
        disableRange: true,
        disableStream: true,
        disableAutoFetch: true,
        maxImageSize: TRADEFOTO_OCR_MAX_CANVAS_PIXELS * 2,
        canvasMaxAreaInBytes: TRADEFOTO_OCR_MAX_CANVAS_PIXELS * 4,
        cMapUrl: localPdfAssetPath("cmaps"),
        cMapPacked: true,
        standardFontDataUrl: localPdfAssetPath("standard_fonts"),
        wasmUrl: localPdfAssetPath("wasm"),
        iccUrl: localPdfAssetPath("iccs"),
      });
      pdf = await loadingTask.promise;
      if (!Number.isSafeInteger(pdf.numPages)
        || pdf.numPages < 1
        || pdf.numPages > TRADEFOTO_OCR_MAX_PAGES) {
        throw ocrError("TRADEFOTO_REPORT_OCR_PAGE_COUNT_INVALID", {
          maximumPages: TRADEFOTO_OCR_MAX_PAGES,
        });
      }

      worker = await createWorker(germanData.code, OEM.LSTM_ONLY, {
        langPath: path.resolve(germanData.langPath),
        gzip: germanData.gzip !== false,
        cacheMethod: "none",
        logger: () => {},
      });
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
      });

      const pages = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        let page = null;
        let canvas = null;
        let png = null;
        try {
          page = await pdf.getPage(pageNumber);
          const { base, scale, viewport } = renderViewport(page);
          canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw ocrError("TRADEFOTO_REPORT_OCR_UNAVAILABLE", { component: "context" });
          await page.render({
            canvasContext: context,
            viewport,
            background: "#ffffff",
            annotationMode: pdfjs.AnnotationMode?.DISABLE ?? 0,
          }).promise;
          png = await canvas.encode("png");
          const recognition = await withTimeout(
            worker.recognize(png, { rotateAuto: false }, { text: false, blocks: true }),
            TRADEFOTO_OCR_PAGE_TIMEOUT_MS,
            "TRADEFOTO_REPORT_OCR_TIMEOUT",
          );
          const items = pageItemsFromRecognition(recognition?.data?.blocks, {
            pageHeight: base.height,
            scale,
          });
          totalWords += items.length;
          if (totalWords > TRADEFOTO_OCR_MAX_TOTAL_WORDS) {
            throw ocrError("TRADEFOTO_REPORT_OCR_WORD_LIMIT", {
              maximumWords: TRADEFOTO_OCR_MAX_TOTAL_WORDS,
            });
          }
          for (const item of items) {
            confidenceTotal += item.confidence;
            confidenceCount += 1;
            if (item.confidence < 70) lowConfidenceWordCount += 1;
          }
          pages.push({
            width: base.width,
            height: base.height,
            items,
          });
        } finally {
          if (png) png.fill(0);
          if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
          }
          try { page?.cleanup(); } catch {}
        }
      }

      try {
        return trustTradeFotoReportPages(pages, {
          fileName,
          contentSha256: sourceFileSha256,
          byteLength: buffer.length,
          extraction: TRADEFOTO_REPORT_EXTRACTIONS.OCR,
          ocrAverageConfidence: confidenceCount ? confidenceTotal / confidenceCount : 0,
          ocrLowConfidenceWordCount: lowConfidenceWordCount,
          ocrEngineVersion: TRADEFOTO_OCR_ENGINE_VERSION,
        });
      } catch (error) {
        if (error instanceof TradeFotoReportError) {
          throw ocrError("TRADEFOTO_REPORT_OCR_RECOGNITION_INCOMPLETE", {
            parserCode: error.code,
          });
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof TradeFotoReportError) throw error;
      if (String(error?.name || "").includes("Password")) {
        throw ocrError("TRADEFOTO_REPORT_PASSWORD_PROTECTED");
      }
      throw ocrError("TRADEFOTO_REPORT_OCR_FAILED", {
        engineCode: cleanOcrText(error?.code || error?.name || "OCR_ERROR").slice(0, 80),
      });
    } finally {
      try { await worker?.terminate(); } catch {}
      try { await pdf?.cleanup(); } catch {}
      try { await loadingTask?.destroy(); } catch {}
    }
  });
}

module.exports = {
  TRADEFOTO_OCR_ENGINE_VERSION,
  TRADEFOTO_OCR_MAX_CANVAS_PIXELS,
  TRADEFOTO_OCR_MAX_PAGES,
  inspectTradeFotoOcrReportBuffer,
  normalizeNumericOcrToken,
  pageItemsFromRecognition,
  wordsFromBlocks,
};
