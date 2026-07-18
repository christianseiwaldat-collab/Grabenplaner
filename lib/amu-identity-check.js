"use strict";

const path = require("node:path");

const sharp = require("sharp");
const { createWorker, OEM, PSM } = require("tesseract.js");
const germanData = require("@tesseract.js-data/deu");

const { detectDocumentType } = require("./amu-storage");
const { extractAumDates, extractAumIdentity } = require("../public/amu-ocr-parser");

const ENGINE_VERSION = "server-ocr-v1";
const MAX_PDF_PAGES = 3;
const MAX_TEXT_CHARACTERS = 100_000;
const OCR_TIMEOUT_MS = 25_000;

function mergeIdentityResults(results = []) {
  const detected = results
    .filter((entry) => entry?.socialSecurityStatus === "detected" && /^\d{10}$/.test(String(entry.socialSecurityNumber || "")))
    .map((entry) => String(entry.socialSecurityNumber));
  const unique = [...new Set(detected)];
  if (results.some((entry) => entry?.socialSecurityStatus === "ambiguous") || unique.length > 1) {
    return { status: "not_detected", candidate: "" };
  }
  return unique.length === 1
    ? { status: "detected", candidate: unique[0] }
    : { status: "not_detected", candidate: "" };
}

function identityFromTexts(texts = []) {
  const results = [];
  for (let text of texts) {
    results.push(extractAumIdentity(String(text || "").slice(0, MAX_TEXT_CHARACTERS)));
    text = "";
  }
  return mergeIdentityResults(results);
}

function datesFromTexts(texts = []) {
  const periods = texts.map((text) => extractAumDates(String(text || "").slice(0, MAX_TEXT_CHARACTERS)))
    .filter((result) => result.complete === true
      && result.autoFillFields?.dateFrom === true
      && result.autoFillFields?.dateTo === true
      && /^\d{4}-\d{2}-\d{2}$/.test(String(result.dateFrom || ""))
      && /^\d{4}-\d{2}-\d{2}$/.test(String(result.dateTo || ""))
      && result.dateTo >= result.dateFrom)
    .map((result) => `${result.dateFrom}/${result.dateTo}`);
  const unique = [...new Set(periods)];
  return unique.length === 1
    ? { status: "detected", dateFrom: unique[0].slice(0, 10), dateTo: unique[0].slice(11) }
    : { status: "not_detected", dateFrom: "", dateTo: "" };
}

async function pdfText(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    enableXfa: false,
    isEvalSupported: false,
    useSystemFonts: false,
    stopAtErrors: true,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
  });
  let document = null;
  try {
    document = await loadingTask.promise;
    const pageCount = Math.min(MAX_PDF_PAGES, Math.max(0, Number(document.numPages) || 0));
    const parts = [];
    let characterCount = 0;
    for (let pageNumber = 1; pageNumber <= pageCount && characterCount < MAX_TEXT_CHARACTERS; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
        for (const item of Array.isArray(content.items) ? content.items : []) {
          const value = typeof item?.str === "string" ? item.str : "";
          if (!value) continue;
          const remaining = MAX_TEXT_CHARACTERS - characterCount;
          if (remaining <= 0) break;
          const part = value.slice(0, remaining);
          parts.push(part);
          characterCount += part.length + 1;
        }
      } finally {
        if (typeof page.cleanup === "function") page.cleanup();
      }
    }
    return parts.join("\n");
  } finally {
    try { if (document && typeof document.destroy === "function") await document.destroy(); } catch {}
    try { if (typeof loadingTask.destroy === "function") await loadingTask.destroy(); } catch {}
  }
}

async function preparedImage(buffer) {
  return sharp(buffer, {
    failOn: "error",
    limitInputPixels: 80 * 1000 * 1000,
    sequentialRead: true,
    page: 0,
    pages: 1,
  })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize({ width: 2200, height: 2200, fit: "inside", withoutEnlargement: true })
    .grayscale()
    .normalize()
    .png({ compressionLevel: 6 })
    .toBuffer();
}

async function withTimeout(promise, timeoutMs = OCR_TIMEOUT_MS) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("AUM identity OCR timed out"), { code: "AMU_IDENTITY_OCR_TIMEOUT" })), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function imageTexts(documents) {
  const worker = await createWorker(germanData.code, OEM.LSTM_ONLY, {
    langPath: path.resolve(germanData.langPath),
    gzip: germanData.gzip !== false,
    cacheMethod: "none",
    logger: () => {},
  });
  const texts = [];
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
    for (const document of documents) {
      const image = await preparedImage(document.buffer);
      const recognition = await withTimeout(worker.recognize(image, { rotateAuto: true }, { text: true }));
      texts.push(String(recognition?.data?.text || "").slice(0, MAX_TEXT_CHARACTERS));
    }
    return texts;
  } finally {
    try { await worker.terminate(); } catch {}
  }
}

async function derivedEvidenceFromDocuments(documents = []) {
  if (process.env.NODE_ENV === "test" && Object.prototype.hasOwnProperty.call(process.env, "GRABENPLANER_TEST_AMU_IDENTITY_TEXT")) {
    const texts = [process.env.GRABENPLANER_TEST_AMU_IDENTITY_TEXT];
    return { identity: identityFromTexts(texts), dates: datesFromTexts(texts) };
  }
  if (process.env.NODE_ENV === "test") {
    return {
      identity: { status: "not_detected", candidate: "" },
      dates: { status: "not_detected", dateFrom: "", dateTo: "" },
    };
  }

  const pdfTexts = [];
  const images = [];
  for (const document of documents.slice(0, 3)) {
    const type = detectDocumentType(document.buffer, document.originalName);
    if (type.mimeType === "application/pdf") {
      try { pdfTexts.push(await pdfText(document.buffer)); } catch { pdfTexts.push(""); }
    } else if (type.mimeType.startsWith("image/")) images.push(document);
  }
  let imageResults = [];
  if (images.length) {
    try { imageResults = await imageTexts(images); } catch { imageResults = []; }
  }
  const texts = [...pdfTexts, ...imageResults];
  const result = {
    identity: identityFromTexts(texts),
    dates: datesFromTexts(texts),
  };
  pdfTexts.fill("");
  imageResults.fill("");
  texts.fill("");
  return result;
}

async function evaluateAumEvidence(documents, { profileConfigured = false, compareCandidate } = {}) {
  const checkedAt = new Date().toISOString();
  const derived = await derivedEvidenceFromDocuments(documents);
  const candidate = derived.identity.candidate;
  let identity;
  if (!profileConfigured) {
    identity = { status: "profile_missing", checkedAt, engineVersion: ENGINE_VERSION };
  } else if (derived.identity.status !== "detected" || !candidate) {
    identity = { status: "not_detected", checkedAt, engineVersion: ENGINE_VERSION };
  } else {
    const matched = typeof compareCandidate === "function" && compareCandidate(candidate) === true;
    identity = { status: matched ? "matched" : "mismatch", checkedAt, engineVersion: ENGINE_VERSION };
  }
  derived.identity.candidate = "";
  return {
    identity,
    dates: {
      status: derived.dates.status,
      dateFrom: derived.dates.dateFrom,
      dateTo: derived.dates.dateTo,
      checkedAt,
      engineVersion: ENGINE_VERSION,
    },
  };
}

async function evaluateAumIdentity(documents, options = {}) {
  return (await evaluateAumEvidence(documents, options)).identity;
}

module.exports = {
  ENGINE_VERSION,
  datesFromTexts,
  evaluateAumEvidence,
  evaluateAumIdentity,
  identityFromTexts,
  mergeIdentityResults,
};
