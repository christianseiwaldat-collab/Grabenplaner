"use strict";

const fs = require("node:fs");
const { PassThrough } = require("node:stream");

const PDFDocument = require("pdfkit");
const sharp = require("sharp");

const DEFAULT_COLORS = Object.freeze({
  primary: "#205b49",
  secondary: "#dfece6",
  accent: "#f4c952",
  text: "#17222e",
  background: "#f7f4ed",
});

const CONDITION_LABELS = Object.freeze({
  new: "Neu / neuwertig",
  good: "Gut",
  used: "Gebraucht",
  damaged: "Beschädigt",
});

function plainText(value, maximum = 500) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\p{Extended_Pictographic}|\uFE0F/gu, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function color(value, fallback) {
  const candidate = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(candidate) ? candidate : fallback;
}

function displayDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : "-";
}

function displayTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat("de-AT", {
    timeZone: "Europe/Vienna",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function participant(value = {}) {
  return {
    employeeNumber: plainText(value.employeeNumber, 40),
    name: plainText(value.name, 140),
  };
}

function normalizeSpec(input = {}) {
  const type = input.type === "return" ? "return" : "issue";
  const items = (Array.isArray(input.items) ? input.items : []).slice(0, 5).map((item, index) => ({
    position: Number(item.position || index + 1),
    articleNumber: plainText(item.articleNumber, 6),
    description: plainText(item.description, 300),
    serialNumber: plainText(item.serialNumber, 100),
    condition: plainText(type === "return" ? item.conditionReturn : item.conditionOut, 40),
    note: plainText(item.note, 500),
  }));
  if (!input.loanId || !input.location?.name || !input.borrower?.employeeNumber || !items.length) {
    const error = new Error("Für den Leihbeleg fehlen Pflichtangaben.");
    error.code = "LOAN_PDF_SPEC_INVALID";
    throw error;
  }
  const rawColors = input.branding?.colors || {};
  return {
    type,
    loanId: plainText(input.loanId, 80),
    revision: Math.max(1, Number(input.revision || 1)),
    createdAt: String(input.createdAt || new Date().toISOString()),
    issuedAt: String(input.issuedAt || ""),
    returnedAt: String(input.returnedAt || ""),
    dueDate: String(input.dueDate || ""),
    note: plainText(input.note, 1000),
    confirmationNote: plainText(input.confirmationNote, 500),
    location: {
      id: plainText(input.location.id, 30),
      name: plainText(input.location.name, 140),
    },
    borrower: participant(input.borrower),
    recordedBy: participant(input.recordedBy),
    witness: participant(input.witness),
    items,
    branding: {
      companyName: plainText(input.branding?.companyName || "Grabenplaner", 140) || "Grabenplaner",
      logo: input.branding?.logo || null,
      colors: {
        primary: color(rawColors.primary, DEFAULT_COLORS.primary),
        secondary: color(rawColors.secondary, DEFAULT_COLORS.secondary),
        accent: color(rawColors.accent, DEFAULT_COLORS.accent),
        text: color(rawColors.text, DEFAULT_COLORS.text),
        background: color(rawColors.background, DEFAULT_COLORS.background),
      },
    },
  };
}

async function logoBuffer(input) {
  if (!input) return null;
  let source;
  if (Buffer.isBuffer(input)) source = Buffer.from(input);
  else if (input instanceof Uint8Array) source = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  else if (typeof input === "string" && !/^(?:https?:|data:|file:)/i.test(input)) {
    source = await fs.promises.readFile(input);
  } else {
    return null;
  }
  if (!source.length || source.length > 15 * 1024 * 1024) return null;
  try {
    return await sharp(source, { failOn: "warning", limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1000, height: 260, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  } catch {
    return null;
  }
}

function render(spec, preparedLogo) {
  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    const chunks = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    output.once("error", reject);
    output.once("end", () => resolve(Buffer.concat(chunks)));

    const title = spec.type === "return" ? "Rücknahmebeleg" : "Ausgabebeleg";
    const doc = new PDFDocument({
      size: "A4",
      layout: "portrait",
      margin: 0,
      compress: true,
      info: {
        Title: `${title} ${spec.loanId}`,
        Author: "Grabenplaner",
        Subject: `Leihvorgang - Revision ${spec.revision}`,
        CreationDate: new Date(spec.createdAt),
        ModDate: new Date(spec.createdAt),
      },
    });
    doc.once("error", reject);
    doc.pipe(output);

    const width = doc.page.width;
    const height = doc.page.height;
    const left = 42;
    const contentWidth = width - left * 2;
    const colors = spec.branding.colors;

    doc.rect(0, 0, width, height).fill(colors.background);
    doc.rect(0, 0, width, 116).fill(colors.primary);
    if (preparedLogo) {
      doc.image(preparedLogo, left, 24, { fit: [150, 54], align: "left", valign: "center" });
    } else {
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(15)
        .text(spec.branding.companyName, left, 38, { width: 175, ellipsis: true });
    }
    const titleWidth = width - 277;
    let titleFontSize = 23;
    doc.font("Helvetica-Bold");
    while (titleFontSize > 17 && doc.fontSize(titleFontSize).widthOfString(title) > titleWidth) {
      titleFontSize -= 0.5;
    }
    doc.fillColor("#ffffff").fontSize(titleFontSize)
      .text(title, 235, 28, { width: width - 277, align: "right" });
    doc.fillColor("#ffffff").font("Helvetica").fontSize(8.5)
      .text(`Beleg ${spec.loanId} · Revision ${spec.revision}`, 235, 63, {
        width: width - 277,
        align: "right",
        ellipsis: true,
      });
    doc.fillColor(colors.accent).rect(width - left - 72, 88, 72, 5).fill();

    function detail(label, value, x, y, itemWidth) {
      doc.fillColor("#69757c").font("Helvetica-Bold").fontSize(7.3)
        .text(label.toUpperCase(), x, y, { width: itemWidth });
      doc.fillColor(colors.text).font("Helvetica").fontSize(9.3)
        .text(value || "-", x, y + 13, { width: itemWidth, ellipsis: true });
    }

    const detailsY = 140;
    const colGap = 16;
    const colWidth = (contentWidth - colGap) / 2;
    doc.roundedRect(left, 128, contentWidth, 110, 10).fill("#ffffff");
    detail("Standort", `${spec.location.id} · ${spec.location.name}`, left + 16, detailsY, colWidth - 16);
    detail("Ausleihende Person", `${spec.borrower.employeeNumber} · ${spec.borrower.name}`, left + colWidth + colGap, detailsY, colWidth - 16);
    detail("Ausgabe", displayTimestamp(spec.issuedAt), left + 16, detailsY + 43, colWidth - 16);
    detail(
      spec.type === "return" ? "Rücknahme" : "Geplante Rückgabe",
      spec.type === "return" ? displayTimestamp(spec.returnedAt) : displayDate(spec.dueDate),
      left + colWidth + colGap,
      detailsY + 43,
      colWidth - 16,
    );

    let y = 260;
    doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(13).text("Artikel", left, y);
    y += 24;
    const columns = [
      { label: "Pos.", x: left, width: 32 },
      { label: "Art.-Nr.", x: left + 34, width: 52 },
      { label: "Bezeichnung", x: left + 88, width: 214 },
      { label: "Seriennummer", x: left + 304, width: 91 },
      { label: "Zustand", x: left + 397, width: 114 },
    ];
    doc.roundedRect(left, y, contentWidth, 23, 7).fill(colors.secondary);
    for (const column of columns) {
      doc.fillColor(colors.primary).font("Helvetica-Bold").fontSize(7.2)
        .text(column.label.toUpperCase(), column.x + 5, y + 8, { width: column.width - 7, ellipsis: true });
    }
    y += 28;

    for (const item of spec.items) {
      const rowHeight = 58;
      doc.roundedRect(left, y, contentWidth, rowHeight, 7).fill("#ffffff");
      const values = [
        String(item.position),
        item.articleNumber,
        item.description,
        item.serialNumber || "-",
        CONDITION_LABELS[item.condition] || item.condition || "-",
      ];
      columns.forEach((column, index) => {
        doc.fillColor(colors.text)
          .font(index === 2 ? "Helvetica-Bold" : "Helvetica")
          .fontSize(index === 2 ? 8.5 : 8)
          .text(values[index], column.x + 5, y + 9, {
            width: column.width - 8,
            height: index === 2 ? 27 : 17,
            ellipsis: true,
          });
      });
      if (item.note) {
        doc.fillColor("#69757c").font("Helvetica").fontSize(7)
          .text(`Hinweis: ${item.note}`, left + 93, y + 39, {
            width: contentWidth - 103,
            height: 11,
            ellipsis: true,
          });
      }
      y += rowHeight + 7;
    }

    const participantY = Math.max(y + 9, 632);
    doc.roundedRect(left, participantY, contentWidth, 77, 9).fill(colors.secondary);
    detail(
      spec.type === "return" ? "Rücknahme erfasst durch" : "Ausgabe erfasst durch",
      `${spec.recordedBy.employeeNumber || "-"} · ${spec.recordedBy.name || "-"}`,
      left + 16,
      participantY + 13,
      colWidth - 16,
    );
    detail(
      spec.type === "return" ? "Gegenprüfung durch" : "Belegstatus",
      spec.type === "return"
        ? `${spec.witness.employeeNumber || "-"} · ${spec.witness.name || "-"}`
        : "Ausgabe abgeschlossen",
      left + colWidth + colGap,
      participantY + 13,
      colWidth - 16,
    );

    const notes = [spec.note, spec.confirmationNote].filter(Boolean).join(" · ");
    if (notes) {
      doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(7.4)
        .text("BEMERKUNG", left + 16, participantY + 51, { width: 72 });
      doc.fillColor(colors.text).font("Helvetica").fontSize(7.4)
        .text(notes, left + 91, participantY + 51, {
          width: contentWidth - 107,
          height: 16,
          ellipsis: true,
        });
    }

    const footerY = height - 54;
    doc.moveTo(left, footerY).lineTo(width - left, footerY)
      .lineWidth(0.6).strokeColor(colors.secondary).stroke();
    doc.fillColor("#69757c").font("Helvetica").fontSize(7)
      .text("Automatisch und unverändert im Grabenplaner erzeugt.", left, footerY + 13, {
        width: contentWidth / 2,
      });
    doc.text(`Erstellt: ${displayTimestamp(spec.createdAt)}`, width / 2, footerY + 13, {
      width: contentWidth / 2,
      align: "right",
    });
    doc.end();
  });
}

async function renderLoanPdf(input = {}) {
  const spec = normalizeSpec(input);
  const preparedLogo = await logoBuffer(spec.branding.logo);
  return render(spec, preparedLogo);
}

module.exports = {
  CONDITION_LABELS,
  normalizeLoanPdfSpec: normalizeSpec,
  renderLoanPdf,
};
