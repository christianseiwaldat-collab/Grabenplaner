"use strict";

const PDFDocument = require("pdfkit");

const COLORS = Object.freeze({
  ink: "#172331",
  muted: "#66736e",
  line: "#d9e2de",
  green: "#235f4d",
  greenSoft: "#e8f1ed",
  surface: "#f6f8f7",
  white: "#ffffff",
});

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function score(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 1 && normalized <= 5
    ? normalized
    : null;
}

function scoreLabel(value) {
  const normalized = score(value);
  return normalized === null
    ? "Noch nicht bewertet"
    : `${normalized.toLocaleString("de-AT", { minimumFractionDigits: 1, maximumFractionDigits: 2 })} / 5`;
}

function formattedTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return new Intl.DateTimeFormat("de-AT", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Vienna",
  }).format(date);
}

function clipped(value, maximum = 180) {
  const normalized = text(value).replace(/\s+/g, " ");
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

function fillCard(doc, x, y, width, height, title, value, caption) {
  doc.roundedRect(x, y, width, height, 8).fill(COLORS.greenSoft);
  doc.font("Helvetica-Bold").fontSize(7).fillColor(COLORS.green)
    .text(title.toUpperCase(), x + 12, y + 10, { width: width - 24, lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(17).fillColor(COLORS.ink)
    .text(scoreLabel(value), x + 12, y + 22, { width: width - 24, lineBreak: false });
  doc.font("Helvetica").fontSize(6.8).fillColor(COLORS.muted)
    .text(caption, x + 12, y + 43, { width: width - 24, lineBreak: false });
}

function reviewerName(reviewerNames, employeeNumber) {
  if (reviewerNames instanceof Map) {
    return text(reviewerNames.get(String(employeeNumber)), String(employeeNumber || "Teammitglied"));
  }
  return text(reviewerNames?.[String(employeeNumber)], String(employeeNumber || "Teammitglied"));
}

function normalizedModel(input = {}) {
  const summary = input.evaluationSummary && typeof input.evaluationSummary === "object"
    ? input.evaluationSummary
    : {};
  const criteria = (Array.isArray(summary.criteria) ? summary.criteria : []).map((criterion) => ({
    id: text(criterion?.id),
    label: text(criterion?.label, "Kriterium"),
    flRating: score(criterion?.flRating),
    employeeAverage: score(criterion?.employeeAverage),
    combinedAverage: score(criterion?.combinedAverage),
    flComment: text(criterion?.flComment),
    reviewerRatings: (Array.isArray(criterion?.reviewerRatings) ? criterion.reviewerRatings : [])
      .map((rating) => ({
        employeeNumber: text(rating?.employeeNumber, "Teammitglied"),
        rating: score(rating?.rating),
        comment: text(rating?.comment),
      })),
  }));
  return {
    candidateName: text(input.candidateName, "Bewerbung"),
    desiredRoleTitle: text(input.desiredRoleTitle, "Tätigkeit nicht angegeben"),
    generatedAt: input.generatedAt || new Date(),
    flOverall: score(summary.flOverall),
    employeeOverall: score(summary.employeeOverall),
    combinedOverall: score(summary.combinedOverall),
    assignedCount: Math.max(0, Number(summary.assignedCount || 0)),
    completedCount: Math.max(0, Number(summary.completedCount || 0)),
    criteria,
    reviewerNames: input.reviewerNames || {},
  };
}

function drawCriteriaTable(doc, model, x, y, width, height) {
  const source = model.criteria;
  const maximumRows = 14;
  const rows = source.slice(0, maximumRows);
  const hiddenRows = Math.max(0, source.length - rows.length);
  const headerHeight = 20;
  const noteHeight = hiddenRows ? 12 : 0;
  const available = Math.max(1, height - headerHeight - noteHeight);
  const rowHeight = rows.length
    ? Math.max(14, Math.min(24, available / rows.length))
    : 24;
  const labelWidth = width - 222;
  const scoreWidth = 74;
  const columns = [
    { label: "Kriterium", x, width: labelWidth, align: "left" },
    { label: "FL", x: x + labelWidth, width: scoreWidth, align: "center" },
    { label: "MA", x: x + labelWidth + scoreWidth, width: scoreWidth, align: "center" },
    { label: "MA + FL", x: x + labelWidth + scoreWidth * 2, width: scoreWidth, align: "center" },
  ];
  doc.roundedRect(x, y, width, headerHeight + rowHeight * Math.max(1, rows.length), 7)
    .fill(COLORS.surface);
  doc.roundedRect(x, y, width, headerHeight, 7).fill(COLORS.green);
  for (const column of columns) {
    doc.font("Helvetica-Bold").fontSize(7).fillColor(COLORS.white)
      .text(column.label, column.x + 8, y + 7, {
        width: column.width - 16,
        align: column.align,
        lineBreak: false,
      });
  }
  if (!rows.length) {
    doc.font("Helvetica").fontSize(8).fillColor(COLORS.muted)
      .text("Noch keine Bewertungskriterien vorhanden.", x + 10, y + headerHeight + 8, {
        width: width - 20,
        lineBreak: false,
      });
    return y + headerHeight + rowHeight;
  }
  rows.forEach((criterion, index) => {
    const rowY = y + headerHeight + index * rowHeight;
    if (index % 2 === 1) doc.rect(x, rowY, width, rowHeight).fill(COLORS.white);
    doc.moveTo(x, rowY).lineTo(x + width, rowY).lineWidth(0.45).strokeColor(COLORS.line).stroke();
    doc.font("Helvetica-Bold").fontSize(rowHeight < 18 ? 6.2 : 7.2).fillColor(COLORS.ink)
      .text(clipped(criterion.label, 80), x + 8, rowY + Math.max(4, (rowHeight - 8) / 2), {
        width: labelWidth - 16,
        height: Math.max(8, rowHeight - 4),
        ellipsis: true,
        lineBreak: false,
      });
    [criterion.flRating, criterion.employeeAverage, criterion.combinedAverage]
      .forEach((value, scoreIndex) => {
        doc.font("Helvetica-Bold").fontSize(rowHeight < 18 ? 6.2 : 7.2)
          .fillColor(value === null ? COLORS.muted : COLORS.green)
          .text(value === null ? "–" : scoreLabel(value), x + labelWidth + scoreWidth * scoreIndex, rowY + Math.max(4, (rowHeight - 8) / 2), {
            width: scoreWidth,
            align: "center",
            lineBreak: false,
          });
      });
  });
  const bottom = y + headerHeight + rowHeight * rows.length;
  if (hiddenRows) {
    doc.font("Helvetica-Oblique").fontSize(6.5).fillColor(COLORS.muted)
      .text(`Weitere ${hiddenRows} Kriterien sind im Grabenplaner im Detail einsehbar.`, x + 4, bottom + 3, {
        width: width - 8,
        lineBreak: false,
      });
  }
  return bottom + noteHeight;
}

function evaluationComments(model) {
  const fl = [];
  const employees = [];
  for (const criterion of model.criteria) {
    if (criterion.flComment) {
      fl.push({ title: criterion.label, body: criterion.flComment });
    }
    for (const rating of criterion.reviewerRatings) {
      if (!rating.comment) continue;
      employees.push({
        title: `${criterion.label} · ${reviewerName(model.reviewerNames, rating.employeeNumber)}`,
        body: rating.comment,
      });
    }
  }
  return { fl, employees };
}

function drawCommentColumn(doc, entries, x, y, width, height, emptyText) {
  if (!entries.length) {
    doc.font("Helvetica").fontSize(7).fillColor(COLORS.muted)
      .text(emptyText, x, y, { width, height, ellipsis: true });
    return;
  }
  const rowHeight = 29;
  const maximum = Math.max(1, Math.floor(height / rowHeight));
  entries.slice(0, maximum).forEach((entry, index) => {
    const rowY = y + index * rowHeight;
    doc.font("Helvetica-Bold").fontSize(6.7).fillColor(COLORS.ink)
      .text(clipped(entry.title, 68), x, rowY, { width, height: 8, ellipsis: true, lineBreak: false });
    doc.font("Helvetica").fontSize(6.4).fillColor(COLORS.muted)
      .text(clipped(entry.body, 170), x, rowY + 9, { width, height: 16, ellipsis: true, lineBreak: false });
  });
  if (entries.length > maximum) {
    doc.font("Helvetica-Oblique").fontSize(6.2).fillColor(COLORS.muted)
      .text(`+ ${entries.length - maximum} weitere Kommentare im Grabenplaner`, x, y + maximum * rowHeight - 2, {
        width,
        lineBreak: false,
      });
  }
}

function drawCandidateEvaluationPdf(doc, input) {
  const model = normalizedModel(input);
  doc.addPage({ size: "A4", layout: "landscape", margin: 0 });
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const margin = 32;
  const contentWidth = pageWidth - margin * 2;

  doc.rect(0, 0, pageWidth, 78).fill(COLORS.green);
  doc.font("Helvetica-Bold").fontSize(19).fillColor(COLORS.white)
    .text("Bewerbungsbewertung", margin, 25, { width: 310, lineBreak: false });
  doc.font("Helvetica").fontSize(8).fillColor("#dceae4")
    .text(`${model.candidateName} · ${model.desiredRoleTitle}`, margin, 51, {
      width: 520,
      height: 11,
      ellipsis: true,
      lineBreak: false,
    });
  doc.font("Helvetica-Bold").fontSize(7).fillColor(COLORS.white)
    .text("VERTRAULICHE PERSONALAUSWERTUNG", pageWidth - margin - 205, 29, {
      width: 205,
      align: "right",
      lineBreak: false,
    });
  doc.font("Helvetica").fontSize(6.8).fillColor("#dceae4")
    .text(`Erstellt: ${formattedTimestamp(model.generatedAt)}`, pageWidth - margin - 205, 45, {
      width: 205,
      align: "right",
      lineBreak: false,
    });

  const cardGap = 10;
  const cardWidth = (contentWidth - cardGap * 2) / 3;
  fillCard(doc, margin, 91, cardWidth, 57, "FL-Bewertung", model.flOverall, "Eigenständige Bewertung der Filialleitung");
  fillCard(doc, margin + cardWidth + cardGap, 91, cardWidth, 57, "MA-Bewertung", model.employeeOverall, `${model.completedCount} von ${model.assignedCount} Rückmeldungen abgegeben`);
  fillCard(doc, margin + (cardWidth + cardGap) * 2, 91, cardWidth, 57, "MA + FL", model.combinedOverall, "Gruppen gleich gewichtet zusammengeführt");

  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COLORS.ink)
    .text("Bewertung nach Kriterien", margin, 163, { width: contentWidth, lineBreak: false });
  const tableBottom = drawCriteriaTable(doc, model, margin, 177, contentWidth, 230);

  const commentsTop = tableBottom + 13;
  const footerY = pageHeight - 27;
  const commentsHeight = Math.max(34, footerY - commentsTop - 18);
  const comments = evaluationComments(model);
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.ink)
    .text("FL-Kommentare", margin, commentsTop, { width: (contentWidth - 18) / 2, lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.ink)
    .text("MA-Kommentare", margin + (contentWidth + 18) / 2, commentsTop, {
      width: (contentWidth - 18) / 2,
      lineBreak: false,
    });
  drawCommentColumn(
    doc,
    comments.fl,
    margin,
    commentsTop + 13,
    (contentWidth - 18) / 2,
    commentsHeight - 13,
    "Keine FL-Kommentare hinterlegt.",
  );
  drawCommentColumn(
    doc,
    comments.employees,
    margin + (contentWidth + 18) / 2,
    commentsTop + 13,
    (contentWidth - 18) / 2,
    commentsHeight - 13,
    "Noch keine MA-Kommentare abgegeben.",
  );

  doc.moveTo(margin, footerY - 5).lineTo(pageWidth - margin, footerY - 5)
    .lineWidth(0.5).strokeColor(COLORS.line).stroke();
  doc.font("Helvetica").fontSize(6.2).fillColor(COLORS.muted)
    .text("Die FL-Bewertung bleibt eigenständig erhalten. Die kombinierte Bewertung gewichtet FL und MA-Gruppe je Kriterium gleich.", margin, footerY, {
      width: contentWidth - 150,
      lineBreak: false,
    });
  doc.font("Helvetica-Bold").fontSize(6.2).fillColor(COLORS.green)
    .text("Grabenplaner", pageWidth - margin - 120, footerY, { width: 120, align: "right", lineBreak: false });
  return model;
}

function createCandidateEvaluationPdf(input) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      autoFirstPage: false,
      bufferPages: true,
      compress: true,
      info: {
        Title: `Bewerbungsbewertung ${text(input?.candidateName, "Bewerbung")}`,
        Subject: "Strukturierte Bewerbungsbewertung",
        Creator: "Grabenplaner",
      },
    });
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.once("error", reject);
    doc.once("end", () => resolve(Buffer.concat(chunks)));
    try {
      drawCandidateEvaluationPdf(doc, input);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = {
  createCandidateEvaluationPdf,
  drawCandidateEvaluationPdf,
  normalizedCandidateEvaluationPdfModel: normalizedModel,
};
