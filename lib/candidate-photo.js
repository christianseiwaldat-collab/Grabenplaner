"use strict";

const sharp = require("sharp");

const MAX_CANDIDATE_PHOTO_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_CANDIDATE_PHOTO_OUTPUT_BYTES = 512 * 1024;
const MAX_CANDIDATE_PHOTO_EDGE = 768;

class CandidatePhotoError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = "CandidatePhotoError";
    this.code = code;
    this.status = status;
  }
}

function safePhotoName(value) {
  return String(value || "Bewerberfoto")
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "Bewerberfoto";
}

async function renderCandidatePhoto(image, edge, quality) {
  return image.clone()
    .rotate()
    .resize({
      width: edge,
      height: edge,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:2:0" })
    .toBuffer({ resolveWithObject: true });
}

async function prepareCandidatePhoto(input = {}) {
  const source = Buffer.isBuffer(input.buffer) ? Buffer.from(input.buffer) : Buffer.alloc(0);
  if (!source.length) {
    throw new CandidatePhotoError("Das Bewerberfoto ist leer.", "CANDIDATE_PHOTO_EMPTY");
  }
  if (source.length > MAX_CANDIDATE_PHOTO_INPUT_BYTES) {
    throw new CandidatePhotoError(
      "Das Bewerberfoto darf höchstens 10 MB groß sein.",
      "CANDIDATE_PHOTO_TOO_LARGE",
      413,
    );
  }
  let image;
  let metadata;
  try {
    image = sharp(source, { failOn: "warning", limitInputPixels: 40_000_000 });
    metadata = await image.metadata();
  } catch {
    throw new CandidatePhotoError(
      "Die Datei ist kein unterstütztes oder lesbares Foto.",
      "CANDIDATE_PHOTO_INVALID",
      415,
    );
  }
  if (!metadata.width || !metadata.height
    || !["jpeg", "png", "webp", "tiff"].includes(metadata.format)) {
    throw new CandidatePhotoError(
      "Erlaubt sind lesbare JPG-, PNG-, WEBP- oder TIFF-Fotos.",
      "CANDIDATE_PHOTO_FORMAT_UNSUPPORTED",
      415,
    );
  }
  let rendered = await renderCandidatePhoto(image, MAX_CANDIDATE_PHOTO_EDGE, 82);
  for (const quality of [74, 66, 58]) {
    if (rendered.data.length <= MAX_CANDIDATE_PHOTO_OUTPUT_BYTES) break;
    rendered = await renderCandidatePhoto(image, MAX_CANDIDATE_PHOTO_EDGE, quality);
  }
  if (rendered.data.length > MAX_CANDIDATE_PHOTO_OUTPUT_BYTES) {
    rendered = await renderCandidatePhoto(image, 512, 58);
  }
  if (rendered.data.length > MAX_CANDIDATE_PHOTO_OUTPUT_BYTES) {
    throw new CandidatePhotoError(
      "Das Bewerberfoto konnte bei lesbarer Qualität nicht klein genug gespeichert werden.",
      "CANDIDATE_PHOTO_OUTPUT_TOO_LARGE",
      413,
    );
  }
  const baseName = safePhotoName(input.originalName).replace(/\.[^.]+$/, "") || "Bewerberfoto";
  return {
    buffer: rendered.data,
    filename: `${baseName}.jpg`,
    mime: "image/jpeg",
    byteSize: rendered.data.length,
    width: rendered.info.width,
    height: rendered.info.height,
    originalByteSize: source.length,
  };
}

module.exports = {
  CandidatePhotoError,
  MAX_CANDIDATE_PHOTO_INPUT_BYTES,
  MAX_CANDIDATE_PHOTO_OUTPUT_BYTES,
  MAX_CANDIDATE_PHOTO_EDGE,
  prepareCandidatePhoto,
};
