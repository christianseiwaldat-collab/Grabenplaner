"use strict";

const crypto = require("node:crypto");
const { PassThrough } = require("node:stream");

const PDFDocument = require("pdfkit");

const MAX_BRANCH_ORDER_PDF_BYTES = 512 * 1024;

class BranchOrderPdfError extends Error {
  constructor(message, code = "BRANCH_ORDER_PDF_INVALID", status = 400) {
    super(message);
    this.name = "BranchOrderPdfError";
    this.code = code;
    this.status = status;
  }
}

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

function filenamePart(value, fallback) {
  const normalized = plainText(value, 120)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("de-AT", {
    timeZone: "Europe/Vienna",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatQuantity(value) {
  return new Intl.NumberFormat("de-AT", { maximumFractionDigits: 3 }).format(Number(value));
}

function normalizedOrderSpec(input = {}) {
  const lines = (Array.isArray(input.lines) ? input.lines : []).map((line, index) => ({
    groupTitle: plainText(line?.groupTitle, 120) || "Warengruppe",
    itemTitle: plainText(line?.itemTitle, 180),
    quantity: Number(line?.quantity),
    unit: plainText(line?.unit, 40),
    note: plainText(line?.note, 500),
    sortOrder: Number.isFinite(Number(line?.sortOrder)) ? Number(line.sortOrder) : index + 1,
  }));
  const orderId = plainText(input.id, 120);
  const locationName = plainText(input.location?.name, 140);
  const employeeName = plainText(input.employee?.fullName, 140);
  const employeeNumber = plainText(input.employee?.employeeNumber, 80);
  const calendarWeek = Number(input.calendarWeek);
  if (!orderId || !locationName || !employeeName || !employeeNumber || !Number.isInteger(calendarWeek)
    || calendarWeek < 1 || calendarWeek > 53 || !lines.length
    || lines.some((line) => !line.itemTitle || !line.unit || !Number.isFinite(line.quantity) || line.quantity <= 0)) {
    throw new BranchOrderPdfError("Für den Bestellnachweis fehlen gültige Bestelldaten.");
  }
  return {
    id: orderId,
    location: {
      id: plainText(input.location?.id, 40),
      name: locationName,
    },
    employee: {
      employeeNumber,
      fullName: employeeName,
    },
    calendarWeek,
    weekStart: plainText(input.weekStart, 20),
    submittedAt: String(input.submittedAt || ""),
    submittedByLogin: plainText(input.submittedByLogin, 80),
    lines: lines.sort((left, right) => left.groupTitle.localeCompare(right.groupTitle, "de")
      || left.sortOrder - right.sortOrder
      || left.itemTitle.localeCompare(right.itemTitle, "de")),
  };
}

function buildBranchOrderPdfFilename(input = {}) {
  const locationId = filenamePart(input.location?.id, "Filiale");
  const calendarWeek = Number(input.calendarWeek);
  const orderId = filenamePart(String(input.id || "").slice(0, 12), "Bestellung");
  return `Filialbestellung-${locationId}-KW${String(calendarWeek || "").padStart(2, "0")}-${orderId}.pdf`;
}

function assertPdfSize(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_BRANCH_ORDER_PDF_BYTES) {
    throw new BranchOrderPdfError(
      "Der Bestellnachweis überschreitet die zulässige Größe.",
      "BRANCH_ORDER_PDF_TOO_LARGE",
      413,
    );
  }
  return buffer;
}

function renderBranchOrderPdf(input = {}) {
  const spec = normalizedOrderSpec(input);
  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    const chunks = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    output.once("error", reject);
    output.once("end", () => {
      try {
        resolve(assertPdfSize(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });

    const doc = new PDFDocument({
      size: "A4",
      layout: "portrait",
      margin: 0,
      autoFirstPage: false,
      compress: true,
      info: {
        Title: `Filialbestellung KW ${spec.calendarWeek} - ${spec.location.name}`,
        Author: "Grabenplaner",
        Subject: `Gespeicherter Bestellnachweis ${spec.id}`,
        CreationDate: new Date(spec.submittedAt || Date.now()),
        ModDate: new Date(spec.submittedAt || Date.now()),
      },
    });
    doc.once("error", reject);
    doc.pipe(output);

    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const left = 38;
    const right = 38;
    const contentWidth = pageWidth - left - right;
    const colors = {
      green: "#205b49",
      greenSoft: "#dfece6",
      text: "#17222e",
      muted: "#65756e",
      paper: "#fffdfa",
      row: "#f7faf8",
      line: "#d8e2dd",
      accent: "#ee735b",
    };
    let y = 0;
    let pageNumber = 0;

    function footer() {
      doc.fillColor(colors.muted).font("Helvetica").fontSize(7.2)
        .text(`Grabenplaner - gespeicherter Bestellnachweis - Bestell-ID ${spec.id}`, left, pageHeight - 31, {
          width: contentWidth - 70,
          ellipsis: true,
        });
      doc.fillColor(colors.muted).font("Helvetica-Bold").fontSize(7.2)
        .text(`Seite ${pageNumber}`, pageWidth - right - 58, pageHeight - 31, {
          width: 58,
          align: "right",
        });
    }

    function startPage() {
      if (pageNumber) footer();
      doc.addPage();
      pageNumber += 1;
      doc.rect(0, 0, pageWidth, pageHeight).fill(colors.paper);
      doc.rect(0, 0, pageWidth, 108).fill(colors.green);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10)
        .text("GRABENPLANER", left, 28, { width: 160 });
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(24)
        .text("Filialbestellung", left, 51, { width: contentWidth, align: "right" });
      doc.fillColor(colors.accent).rect(pageWidth - right - 92, 89, 92, 4).fill();

      const cardY = 132;
      doc.roundedRect(left, cardY, contentWidth, 112, 11).fill("#ffffff");
      function detail(label, value, x, detailY, width) {
        doc.fillColor(colors.muted).font("Helvetica-Bold").fontSize(7.2)
          .text(label.toUpperCase(), x, detailY, { width });
        doc.fillColor(colors.text).font("Helvetica").fontSize(9.4)
          .text(value || "-", x, detailY + 13, { width, height: 19, ellipsis: true });
      }
      const column = (contentWidth - 30) / 2;
      detail("Filiale", `${spec.location.id ? `${spec.location.id} - ` : ""}${spec.location.name}`, left + 16, cardY + 15, column);
      detail("Kalenderwoche", `KW ${spec.calendarWeek}${spec.weekStart ? ` - Woche ab ${spec.weekStart}` : ""}`, left + 16 + column + 14, cardY + 15, column);
      detail("Bestellung für", `${spec.employee.fullName} - MA-Nr. ${spec.employee.employeeNumber}`, left + 16, cardY + 60, column);
      detail("Erfasst am", formatTimestamp(spec.submittedAt), left + 16 + column + 14, cardY + 60, column);
      y = 271;
    }

    function ensureSpace(height) {
      if (y + height <= pageHeight - 54) return;
      startPage();
    }

    function groupHeading(title) {
      ensureSpace(33);
      doc.roundedRect(left, y, contentWidth, 25, 7).fill(colors.greenSoft);
      doc.fillColor(colors.green).font("Helvetica-Bold").fontSize(9.2)
        .text(title, left + 10, y + 8, { width: contentWidth - 20, ellipsis: true });
      y += 30;
    }

    function itemRow(line) {
      const productWidth = 244;
      const quantityWidth = 59;
      const unitWidth = 72;
      const noteWidth = contentWidth - productWidth - quantityWidth - unitWidth - 28;
      doc.font("Helvetica-Bold").fontSize(8.7);
      const productHeight = Math.max(18, doc.heightOfString(line.itemTitle, { width: productWidth - 12 }));
      doc.font("Helvetica").fontSize(8.2);
      const noteHeight = Math.max(18, doc.heightOfString(line.note || "-", { width: noteWidth - 10 }));
      const rowHeight = Math.max(36, productHeight + 16, noteHeight + 16);
      ensureSpace(rowHeight + 7);
      doc.roundedRect(left, y, contentWidth, rowHeight, 7).fill(colors.row);
      doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(8.7)
        .text(line.itemTitle, left + 7, y + 9, { width: productWidth - 12, height: rowHeight - 14, ellipsis: true });
      doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(8.5)
        .text(formatQuantity(line.quantity), left + productWidth, y + 9, { width: quantityWidth - 8, align: "right" });
      doc.fillColor(colors.muted).font("Helvetica").fontSize(8.1)
        .text(line.unit, left + productWidth + quantityWidth, y + 9, { width: unitWidth - 8, ellipsis: true });
      doc.fillColor(colors.muted).font("Helvetica").fontSize(8.1)
        .text(line.note || "-", left + productWidth + quantityWidth + unitWidth, y + 9, {
          width: noteWidth - 8,
          height: rowHeight - 14,
          ellipsis: true,
        });
      y += rowHeight + 7;
    }

    startPage();
    doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(13).text("Bestellte Positionen", left, y);
    y += 24;
    let currentGroup = "";
    for (const line of spec.lines) {
      if (line.groupTitle !== currentGroup) {
        currentGroup = line.groupTitle;
        groupHeading(currentGroup);
      }
      itemRow(line);
    }
    ensureSpace(38);
    doc.fillColor(colors.muted).font("Helvetica").fontSize(8)
      .text(`Erfasst über Filialkonto: ${spec.submittedByLogin || "-"}`, left, y + 7, { width: contentWidth });
    footer();
    doc.end();
  });
}

function branchOrderPdfSha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

module.exports = {
  BranchOrderPdfError,
  MAX_BRANCH_ORDER_PDF_BYTES,
  branchOrderPdfSha256,
  buildBranchOrderPdfFilename,
  renderBranchOrderPdf,
};
