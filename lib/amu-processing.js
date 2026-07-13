"use strict";

const path = require("node:path");

const PDFDocument = require("pdfkit");
const sharp = require("sharp");

const {
  MAX_DOCUMENT_BYTES,
  detectDocumentType,
  sanitizeOriginalFilename,
} = require("./amu-storage");

const DEFAULT_STORED_MAX_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_PIXELS = 80 * 1000 * 1000;
const A4_MARGIN_POINTS = 28.35;
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/tiff"]);

class AmuProcessingError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = "AmuProcessingError";
    this.code = code;
  }
}

function processingError(message, code, cause) {
  return new AmuProcessingError(message, code, cause ? { cause } : undefined);
}

function positiveByteLimit(value, fallback, optionName) {
  const parsed = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw processingError(
      `Das Größenlimit „${optionName}“ ist ungültig.`,
      "AMU_PROCESSING_OPTIONS_INVALID",
    );
  }
  return parsed;
}

function outputPdfFilename(originalName) {
  const sanitized = sanitizeOriginalFilename(originalName);
  const stem = path.basename(sanitized, path.extname(sanitized)).replace(/[. ]+$/g, "") || "Dokument";
  return `${stem.slice(0, 116)}.pdf`;
}

function renderImagePdf(jpegBuffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const document = new PDFDocument({
      autoFirstPage: false,
      compress: true,
      info: {
        Title: "Arbeitsunfähigkeitsmeldung",
        Creator: "Grabenplaner",
        Producer: "Grabenplaner",
      },
    });
    document.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    document.once("error", reject);
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.addPage({ size: "A4", margin: A4_MARGIN_POINTS });
    const availableWidth = document.page.width - (2 * A4_MARGIN_POINTS);
    const availableHeight = document.page.height - (2 * A4_MARGIN_POINTS);
    document.image(jpegBuffer, A4_MARGIN_POINTS, A4_MARGIN_POINTS, {
      fit: [availableWidth, availableHeight],
      align: "center",
      valign: "center",
    });
    document.end();
  });
}

function compressionCandidates(sourceLongEdge, maxLongEdge) {
  const tiers = [
    [3200, 90],
    [2800, 84],
    [2400, 82],
    [2200, 77],
    [1900, 74],
    [1650, 70],
    [1450, 67],
    [1250, 63],
    [1050, 59],
    [900, 55],
  ];
  const cap = Math.max(1, Math.min(sourceLongEdge, maxLongEdge));
  const seen = new Set();
  return tiers.map(([longEdge, quality]) => ({ longEdge: Math.min(cap, longEdge), quality }))
    .filter((candidate) => {
      const key = `${candidate.longEdge}:${candidate.quality}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function imageToA4Pdf(buffer, {
  maxBytes = DEFAULT_STORED_MAX_BYTES,
  grayscale = false,
  maxLongEdge = 3200,
} = {}) {
  const storedLimit = positiveByteLimit(maxBytes, DEFAULT_STORED_MAX_BYTES, "maxBytes");
  const dimensionLimit = Number(maxLongEdge);
  if (!Number.isSafeInteger(dimensionLimit) || dimensionLimit < 900 || dimensionLimit > 8000) {
    throw processingError("Die maximale Bildabmessung ist ungültig.", "AMU_PROCESSING_OPTIONS_INVALID");
  }

  let metadata;
  try {
    metadata = await sharp(buffer, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
      page: 0,
      pages: 1,
    }).metadata();
  } catch (error) {
    throw processingError(
      "Das Bild ist beschädigt, unlesbar oder hat eine zu hohe Auflösung.",
      "AMU_IMAGE_PROCESSING_FAILED",
      error,
    );
  }
  if (!metadata.width || !metadata.height) {
    throw processingError("Die Bildabmessungen konnten nicht gelesen werden.", "AMU_IMAGE_PROCESSING_FAILED");
  }

  const orientationSwapsSides = [5, 6, 7, 8].includes(Number(metadata.orientation));
  const displayedWidth = orientationSwapsSides ? metadata.height : metadata.width;
  const displayedHeight = orientationSwapsSides ? metadata.width : metadata.height;
  const sourceLongEdge = Math.max(displayedWidth, displayedHeight);
  let smallestAttempt = null;

  for (const candidate of compressionCandidates(sourceLongEdge, dimensionLimit)) {
    try {
      let pipeline = sharp(buffer, {
        failOn: "error",
        limitInputPixels: MAX_INPUT_PIXELS,
        sequentialRead: true,
        page: 0,
        pages: 1,
      })
        .rotate()
        .flatten({ background: "#ffffff" })
        .resize({
          width: candidate.longEdge,
          height: candidate.longEdge,
          fit: "inside",
          withoutEnlargement: true,
          kernel: sharp.kernel.lanczos3,
        });
      if (grayscale) pipeline = pipeline.grayscale();
      const rendered = await pipeline
        .jpeg({
          quality: candidate.quality,
          chromaSubsampling: grayscale ? "4:4:4" : "4:2:0",
          optimizeCoding: true,
        })
        .toBuffer({ resolveWithObject: true });
      const pdfBuffer = await renderImagePdf(rendered.data);
      const attempt = {
        buffer: pdfBuffer,
        byteSize: pdfBuffer.length,
        quality: candidate.quality,
        longEdge: Math.max(rendered.info.width, rendered.info.height),
        width: rendered.info.width,
        height: rendered.info.height,
        grayscale: Boolean(grayscale),
      };
      if (!smallestAttempt || attempt.byteSize < smallestAttempt.byteSize) smallestAttempt = attempt;
      if (pdfBuffer.length <= storedLimit) return attempt;
    } catch (error) {
      if (error instanceof AmuProcessingError) throw error;
      throw processingError("Das Bild konnte nicht sicher in PDF umgewandelt werden.", "AMU_IMAGE_PROCESSING_FAILED", error);
    }
  }

  const smallestText = smallestAttempt
    ? ` Die kleinste lesbare Fassung wäre ${Math.ceil(smallestAttempt.byteSize / 1024)} KiB groß.`
    : "";
  throw processingError(
    `Das Bild kann bei lesbarer Qualität nicht unter dem eingestellten Speicherlimit abgelegt werden.${smallestText}`,
    "AMU_DOCUMENT_TOO_LARGE_AFTER_PROCESSING",
  );
}

async function prepareAmuDocument({
  buffer,
  originalName = "Dokument",
  convertImagesToPdf = true,
  grayscale = false,
  maxInputBytes = MAX_DOCUMENT_BYTES,
  maxStoredBytes = DEFAULT_STORED_MAX_BYTES,
  maxLongEdge = 3200,
  scanOriginal = null,
} = {}) {
  const inputLimit = positiveByteLimit(maxInputBytes, MAX_DOCUMENT_BYTES, "maxInputBytes");
  const storedLimit = positiveByteLimit(maxStoredBytes, DEFAULT_STORED_MAX_BYTES, "maxStoredBytes");
  const type = detectDocumentType(buffer, originalName, { maxBytes: inputLimit });

  if (type.mimeType === "application/pdf") {
    if (buffer.length > storedLimit) {
      throw processingError(
        "Die PDF-Datei ist größer als das eingestellte Speicherlimit und wird nicht automatisch verändert.",
        "AMU_DOCUMENT_STORAGE_LIMIT_EXCEEDED",
      );
    }
    return {
      buffer,
      originalFilename: type.safeFilename,
      detectedMime: type.mimeType,
      extension: type.extension,
      byteSize: buffer.length,
      sourceMime: type.mimeType,
      sourceByteSize: buffer.length,
      converted: false,
      grayscale: false,
      scanResult: null,
      processing: null,
    };
  }

  if (!IMAGE_MIME_TYPES.has(type.mimeType)) {
    throw processingError("Der Dokumenttyp kann nicht verarbeitet werden.", "AMU_DOCUMENT_TYPE_UNSUPPORTED");
  }

  let scanResult = null;
  if (typeof scanOriginal === "function") {
    scanResult = await scanOriginal({ buffer, originalName, maxBytes: inputLimit });
  }

  if (!convertImagesToPdf) {
    if (buffer.length > storedLimit) {
      throw processingError(
        "Die Bilddatei ist größer als das eingestellte Speicherlimit.",
        "AMU_DOCUMENT_STORAGE_LIMIT_EXCEEDED",
      );
    }
    return {
      buffer,
      originalFilename: type.safeFilename,
      detectedMime: type.mimeType,
      extension: type.extension,
      byteSize: buffer.length,
      sourceMime: type.mimeType,
      sourceByteSize: buffer.length,
      converted: false,
      grayscale: false,
      scanResult,
      processing: null,
    };
  }

  const converted = await imageToA4Pdf(buffer, {
    maxBytes: storedLimit,
    grayscale,
    maxLongEdge,
  });
  return {
    buffer: converted.buffer,
    originalFilename: outputPdfFilename(type.safeFilename),
    detectedMime: "application/pdf",
    extension: "pdf",
    byteSize: converted.byteSize,
    sourceMime: type.mimeType,
    sourceByteSize: buffer.length,
    converted: true,
    grayscale: converted.grayscale,
    scanResult,
    processing: {
      quality: converted.quality,
      longEdge: converted.longEdge,
      width: converted.width,
      height: converted.height,
    },
  };
}

module.exports = {
  AmuProcessingError,
  DEFAULT_STORED_MAX_BYTES,
  imageToA4Pdf,
  prepareAmuDocument,
};
