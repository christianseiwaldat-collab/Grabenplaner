"use strict";

const path = require("node:path");

const PDFDocument = require("pdfkit");
const sharp = require("sharp");

const MAX_LOAN_PHOTO_PDF_PHOTOS = 9;
const MAX_LOAN_PHOTO_PDF_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_LOAN_PHOTO_PDF_BYTES = 8 * 1024 * 1024;
const MAX_LOAN_PHOTO_PDF_INPUT_PIXELS = 40_000_000;
const PDF_IMAGES_PER_PAGE = 2;
const PDF_IMAGE_MAX_WIDTH = 1400;
const PDF_IMAGE_MAX_HEIGHT = 900;
const OUTPUT_MODES = Object.freeze(["grayscale", "blackwhite"]);

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const PAGE_MARGIN = 32;
const CONTENT_TOP = 98;
const CONTENT_BOTTOM = 48;
const SLOT_GAP = 18;
const SLOT_LABEL_HEIGHT = 20;

class LoanPhotoPdfError extends Error {
  constructor(message, code, status = 400, options = {}) {
    super(message, options);
    this.name = "LoanPhotoPdfError";
    this.code = code;
    this.status = status;
  }
}

function photoPdfError(message, code, status, cause) {
  return new LoanPhotoPdfError(message, code, status, cause ? { cause } : undefined);
}

function plainText(value, maximum = 160) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function safeFilename(value, fallback = "Foto") {
  let filename = plainText(value, 240).replaceAll("\\", "/").split("/").pop() || fallback;
  filename = filename
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/^[. ]+|[. ]+$/g, "")
    .trim();
  if (!filename) filename = fallback;
  if (filename.length <= 120) return filename;
  const extension = path.extname(filename).slice(0, 16);
  return `${filename.slice(0, Math.max(1, 120 - extension.length)).trim()}${extension}`;
}

function normalizeTitleContext(input = {}) {
  const location = input.location && typeof input.location === "object" ? input.location : {};
  return Object.freeze({
    locationId: plainText(input.locationId ?? location.id, 30),
    locationName: plainText(input.locationName ?? location.name, 140),
    loanId: plainText(input.loanId, 80),
    subtitle: plainText(input.subtitle, 180),
    createdAt: plainText(input.createdAt, 40),
  });
}

function titleContextLine(context) {
  const location = [context.locationId, context.locationName].filter(Boolean).join(" - ");
  return [
    location,
    context.loanId ? `Leihvorgang ${context.loanId}` : "",
    context.subtitle,
    context.createdAt ? `Stand ${context.createdAt}` : "",
  ].filter(Boolean).join(" | ");
}

function normalizePhotoBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.alloc(0);
}

function normalizeSpec(input = {}) {
  const phase = String(input.phase || "");
  if (!["issue", "return"].includes(phase)) {
    throw photoPdfError(
      "Für die Foto-PDF muss Ausgabe oder Rückgabe angegeben werden.",
      "LOAN_PHOTO_PDF_PHASE_INVALID",
      400,
    );
  }
  const outputMode = String(input.outputMode || "grayscale");
  if (!OUTPUT_MODES.includes(outputMode)) {
    throw photoPdfError(
      "Für die Foto-PDF sind nur Graustufen oder Schwarzweiß zulässig.",
      "LOAN_PHOTO_PDF_OUTPUT_MODE_INVALID",
      400,
    );
  }
  if (!Array.isArray(input.photos) || input.photos.length < 1) {
    throw photoPdfError(
      "Für die Foto-PDF ist mindestens ein Foto erforderlich.",
      "LOAN_PHOTO_PDF_PHOTOS_REQUIRED",
      400,
    );
  }
  if (input.photos.length > MAX_LOAN_PHOTO_PDF_PHOTOS) {
    throw photoPdfError(
      `Eine Foto-PDF darf höchstens ${MAX_LOAN_PHOTO_PDF_PHOTOS} Fotos enthalten.`,
      "LOAN_PHOTO_PDF_TOO_MANY_PHOTOS",
      413,
    );
  }
  const photos = input.photos.map((photo, index) => {
    const buffer = normalizePhotoBuffer(photo?.buffer);
    if (!buffer.length) {
      throw photoPdfError(
        `Foto ${index + 1} ist leer oder ungültig.`,
        "LOAN_PHOTO_PDF_PHOTO_INVALID",
        415,
      );
    }
    if (buffer.length > MAX_LOAN_PHOTO_PDF_INPUT_BYTES) {
      throw photoPdfError(
        `Foto ${index + 1} darf höchstens 2 MiB groß sein.`,
        "LOAN_PHOTO_PDF_PHOTO_TOO_LARGE",
        413,
      );
    }
    const requestedPosition = Number(photo?.position);
    return Object.freeze({
      buffer,
      position: Number.isSafeInteger(requestedPosition) && requestedPosition > 0
        ? requestedPosition
        : index + 1,
      filename: safeFilename(photo?.filename, `Foto-${index + 1}`),
    });
  });
  return Object.freeze({
    phase,
    outputMode,
    photos: Object.freeze(photos),
    titleContext: normalizeTitleContext(input.titleContext),
  });
}

async function prepareLoanPhotoPdfImage(buffer, outputMode = "grayscale") {
  if (!OUTPUT_MODES.includes(outputMode)) {
    throw photoPdfError(
      "Für die Foto-PDF sind nur Graustufen oder Schwarzweiß zulässig.",
      "LOAN_PHOTO_PDF_OUTPUT_MODE_INVALID",
      400,
    );
  }
  const source = normalizePhotoBuffer(buffer);
  if (!source.length) {
    throw photoPdfError("Das Foto ist leer oder ungültig.", "LOAN_PHOTO_PDF_PHOTO_INVALID", 415);
  }
  if (source.length > MAX_LOAN_PHOTO_PDF_INPUT_BYTES) {
    throw photoPdfError(
      "Ein Foto für die PDF darf höchstens 2 MiB groß sein.",
      "LOAN_PHOTO_PDF_PHOTO_TOO_LARGE",
      413,
    );
  }
  try {
    let pipeline = sharp(source, {
      failOn: "warning",
      limitInputPixels: MAX_LOAN_PHOTO_PDF_INPUT_PIXELS,
      sequentialRead: true,
      page: 0,
      pages: 1,
    })
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize({
        width: PDF_IMAGE_MAX_WIDTH,
        height: PDF_IMAGE_MAX_HEIGHT,
        fit: "inside",
        withoutEnlargement: true,
        kernel: sharp.kernel.lanczos3,
      })
      .toColourspace("b-w");

    if (outputMode === "blackwhite") {
      pipeline = pipeline
        .threshold(168)
        .png({
          compressionLevel: 9,
          palette: true,
          colours: 2,
          dither: 0,
        });
    } else {
      pipeline = pipeline.jpeg({
        quality: 78,
        chromaSubsampling: "4:4:4",
        optimizeCoding: true,
      });
    }
    const rendered = await pipeline.toBuffer({ resolveWithObject: true });
    return Object.freeze({
      buffer: rendered.data,
      width: Number(rendered.info.width),
      height: Number(rendered.info.height),
      mime: outputMode === "blackwhite" ? "image/png" : "image/jpeg",
      outputMode,
    });
  } catch (error) {
    if (error instanceof LoanPhotoPdfError) throw error;
    throw photoPdfError(
      "Ein Leihfoto ist beschädigt, unlesbar oder hat eine zu hohe Auflösung.",
      "LOAN_PHOTO_PDF_PHOTO_INVALID",
      415,
      error,
    );
  }
}

function assertLoanPhotoPdfSize(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw photoPdfError(
      "Die Foto-PDF konnte nicht erzeugt werden.",
      "LOAN_PHOTO_PDF_RENDER_FAILED",
      500,
    );
  }
  if (buffer.length > MAX_LOAN_PHOTO_PDF_BYTES) {
    throw photoPdfError(
      "Die Foto-PDF überschreitet das sichere Größenlimit von 8 MiB.",
      "LOAN_PHOTO_PDF_OUTPUT_TOO_LARGE",
      413,
    );
  }
  return buffer;
}

function renderPreparedPdf(spec, preparedPhotos) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const finishWithError = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof LoanPhotoPdfError ? error : photoPdfError(
        "Die Foto-PDF konnte nicht sicher erzeugt werden.",
        "LOAN_PHOTO_PDF_RENDER_FAILED",
        500,
        error,
      ));
    };
    try {
      const phaseLabel = spec.phase === "return" ? "Rückgabe" : "Ausgabe";
      const pageCount = Math.ceil(preparedPhotos.length / PDF_IMAGES_PER_PAGE);
      const document = new PDFDocument({
        autoFirstPage: false,
        compress: true,
        info: {
          Title: `Leihfoto-Beilage - ${phaseLabel}`,
          Creator: "Grabenplaner",
          Producer: "Grabenplaner",
        },
      });
      document.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      document.once("error", finishWithError);
      document.once("end", () => {
        if (settled) return;
        try {
          settled = true;
          resolve(assertLoanPhotoPdfSize(Buffer.concat(chunks)));
        } catch (error) {
          reject(error);
        }
      });

      const contextLine = titleContextLine(spec.titleContext);
      const availableHeight = A4_HEIGHT - CONTENT_TOP - CONTENT_BOTTOM - SLOT_GAP;
      const slotHeight = availableHeight / PDF_IMAGES_PER_PAGE;
      const slotWidth = A4_WIDTH - (2 * PAGE_MARGIN);

      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        document.addPage({ size: "A4", margin: 0 });
        document.fillColor("#17222e").font("Helvetica-Bold").fontSize(16)
          .text(`Leihfoto-Beilage - ${phaseLabel}`, PAGE_MARGIN, PAGE_MARGIN, {
            width: slotWidth - 100,
            lineBreak: false,
          });
        document.fillColor("#66737a").font("Helvetica").fontSize(8)
          .text(`Seite ${pageIndex + 1} von ${pageCount}`, A4_WIDTH - PAGE_MARGIN - 100, PAGE_MARGIN + 4, {
            width: 100,
            align: "right",
            lineBreak: false,
          });
        if (contextLine) {
          document.fillColor("#46545b").font("Helvetica").fontSize(8.5)
            .text(contextLine, PAGE_MARGIN, PAGE_MARGIN + 28, {
              width: slotWidth,
              height: 20,
              ellipsis: true,
            });
        }
        document.moveTo(PAGE_MARGIN, CONTENT_TOP - 13)
          .lineTo(A4_WIDTH - PAGE_MARGIN, CONTENT_TOP - 13)
          .lineWidth(0.7)
          .strokeColor("#cad3d7")
          .stroke();

        for (let slotIndex = 0; slotIndex < PDF_IMAGES_PER_PAGE; slotIndex += 1) {
          const photoIndex = (pageIndex * PDF_IMAGES_PER_PAGE) + slotIndex;
          const photo = preparedPhotos[photoIndex];
          if (!photo) break;
          const slotY = CONTENT_TOP + (slotIndex * (slotHeight + SLOT_GAP));
          const imageY = slotY + SLOT_LABEL_HEIGHT;
          const imageHeight = slotHeight - SLOT_LABEL_HEIGHT;
          const label = `Foto ${photo.position} - ${photo.filename}`;

          document.fillColor("#17222e").font("Helvetica-Bold").fontSize(9)
            .text(label, PAGE_MARGIN + 5, slotY + 3, {
              width: slotWidth - 10,
              height: SLOT_LABEL_HEIGHT - 3,
              ellipsis: true,
              lineBreak: false,
            });
          document.roundedRect(PAGE_MARGIN, imageY, slotWidth, imageHeight, 5)
            .lineWidth(0.8)
            .fillAndStroke("#f5f7f7", "#cad3d7");
          document.image(photo.buffer, PAGE_MARGIN + 7, imageY + 7, {
            fit: [slotWidth - 14, imageHeight - 14],
            align: "center",
            valign: "center",
          });
        }
        document.fillColor("#66737a").font("Helvetica").fontSize(7)
          .text(
            spec.outputMode === "blackwhite"
              ? "Geschützte Schwarzweiß-Beilage"
              : "Geschützte Graustufen-Beilage",
            PAGE_MARGIN,
            A4_HEIGHT - 30,
            { width: slotWidth, align: "center", lineBreak: false },
          );
      }
      document.end();
    } catch (error) {
      finishWithError(error);
    }
  });
}

async function renderLoanPhotoPdf({
  photos,
  phase,
  outputMode = "grayscale",
  titleContext = {},
} = {}) {
  const spec = normalizeSpec({ photos, phase, outputMode, titleContext });
  const preparedPhotos = [];
  for (const photo of spec.photos) {
    const prepared = await prepareLoanPhotoPdfImage(photo.buffer, spec.outputMode);
    preparedPhotos.push(Object.freeze({
      ...prepared,
      position: photo.position,
      filename: photo.filename,
    }));
  }
  return renderPreparedPdf(spec, preparedPhotos);
}

module.exports = {
  LoanPhotoPdfError,
  MAX_LOAN_PHOTO_PDF_PHOTOS,
  MAX_LOAN_PHOTO_PDF_INPUT_BYTES,
  MAX_LOAN_PHOTO_PDF_BYTES,
  MAX_LOAN_PHOTO_PDF_INPUT_PIXELS,
  OUTPUT_MODES,
  PDF_IMAGES_PER_PAGE,
  normalizeLoanPhotoPdfSpec: normalizeSpec,
  normalizeLoanPhotoPdfTitleContext: normalizeTitleContext,
  prepareLoanPhotoPdfImage,
  assertLoanPhotoPdfSize,
  renderLoanPhotoPdf,
};
