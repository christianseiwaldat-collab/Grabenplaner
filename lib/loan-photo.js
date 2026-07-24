"use strict";

const sharp = require("sharp");

const MAX_LOAN_PHOTO_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_LOAN_PHOTO_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_LOAN_PHOTO_PIXELS = 2_000_000;
const MAX_LOAN_PHOTOS_PER_PHASE = 9;

class LoanPhotoError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = "LoanPhotoError";
    this.code = code;
    this.status = status;
  }
}

function safeBaseName(value) {
  return String(value || "Foto")
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "Foto";
}

function scaledDimensions(width, height, maximumPixels = MAX_LOAN_PHOTO_PIXELS) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  const pixels = safeWidth * safeHeight;
  if (pixels <= maximumPixels) return { width: safeWidth, height: safeHeight };
  const factor = Math.sqrt(maximumPixels / pixels);
  return {
    width: Math.max(1, Math.floor(safeWidth * factor)),
    height: Math.max(1, Math.floor(safeHeight * factor)),
  };
}

async function jpegAtQuality(image, dimensions, quality) {
  return image.clone()
    .rotate()
    .resize({
      width: dimensions.width,
      height: dimensions.height,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:2:0" })
    .toBuffer();
}

async function prepareLoanPhoto(input = {}) {
  const source = Buffer.isBuffer(input.buffer) ? Buffer.from(input.buffer) : Buffer.alloc(0);
  if (!source.length) {
    throw new LoanPhotoError("Das Foto ist leer.", "LOAN_PHOTO_EMPTY");
  }
  if (source.length > MAX_LOAN_PHOTO_INPUT_BYTES) {
    throw new LoanPhotoError(
      "Ein Foto darf vor der Aufbereitung höchstens 10 MB groß sein.",
      "LOAN_PHOTO_TOO_LARGE",
      413,
    );
  }
  let image;
  let metadata;
  try {
    image = sharp(source, { failOn: "warning", limitInputPixels: 40_000_000 });
    metadata = await image.metadata();
  } catch {
    throw new LoanPhotoError(
      "Die Datei ist kein unterstütztes oder lesbares Foto.",
      "LOAN_PHOTO_INVALID",
      415,
    );
  }
  if (!metadata.width || !metadata.height || !["jpeg", "png", "webp", "tiff", "heif"].includes(metadata.format)) {
    throw new LoanPhotoError(
      "Erlaubt sind lesbare JPG-, PNG-, WEBP-, TIFF- oder HEIF-Fotos.",
      "LOAN_PHOTO_FORMAT_UNSUPPORTED",
      415,
    );
  }
  let dimensions = scaledDimensions(metadata.width, metadata.height);
  let prepared = await jpegAtQuality(image, dimensions, 82);
  for (const quality of [74, 66, 58]) {
    if (prepared.length <= MAX_LOAN_PHOTO_OUTPUT_BYTES) break;
    prepared = await jpegAtQuality(image, dimensions, quality);
  }
  if (prepared.length > MAX_LOAN_PHOTO_OUTPUT_BYTES) {
    dimensions = scaledDimensions(dimensions.width, dimensions.height, 1_250_000);
    prepared = await jpegAtQuality(image, dimensions, 58);
  }
  if (prepared.length > MAX_LOAN_PHOTO_OUTPUT_BYTES) {
    throw new LoanPhotoError(
      "Das Foto konnte bei lesbarer Qualität nicht unter 2 MB gespeichert werden.",
      "LOAN_PHOTO_OUTPUT_TOO_LARGE",
      413,
    );
  }
  return {
    buffer: prepared,
    filename: `${safeBaseName(input.originalName).replace(/\.[^.]+$/, "") || "Foto"}.jpg`,
    mime: "image/jpeg",
    byteSize: prepared.length,
    width: dimensions.width,
    height: dimensions.height,
    originalByteSize: source.length,
  };
}

module.exports = {
  LoanPhotoError,
  MAX_LOAN_PHOTO_INPUT_BYTES,
  MAX_LOAN_PHOTO_OUTPUT_BYTES,
  MAX_LOAN_PHOTO_PIXELS,
  MAX_LOAN_PHOTOS_PER_PHASE,
  prepareLoanPhoto,
  scaledDimensions,
};
