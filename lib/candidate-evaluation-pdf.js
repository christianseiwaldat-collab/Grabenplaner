"use strict";

const fs = require("node:fs");

const PDFDocument = require("pdfkit");
const sharp = require("sharp");

const BASE_COLORS = Object.freeze({
  ink: "#172331",
  muted: "#66736e",
  line: "#d9e2de",
  white: "#ffffff",
  surface: "#f6f8f7",
  chip: "#e8edeb",
});
const DEFAULT_PRIMARY = "#235f4d";
const SCORE_STYLES = Object.freeze([
  null,
  Object.freeze({ fill: "#f4d4d0", ink: "#8b3028" }),
  Object.freeze({ fill: "#f6dec2", ink: "#91501c" }),
  Object.freeze({ fill: "#f4e7b6", ink: "#74600f" }),
  Object.freeze({ fill: "#dcebc9", ink: "#3e612b" }),
  Object.freeze({ fill: "#cce5d8", ink: "#205a45" }),
]);
const SUPPORTED_LOGO_FORMATS = new Set(["svg", "png", "jpeg", "webp"]);
const MAX_LOGO_BYTES = 15 * 1024 * 1024;

class CandidateEvaluationPdfError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CandidateEvaluationPdfError";
    this.code = code;
  }
}

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

function scoreNumber(value) {
  const normalized = score(value);
  return normalized === null
    ? null
    : normalized.toLocaleString("de-AT", { maximumFractionDigits: 2 });
}

function scoreQuality(value) {
  const normalized = score(value);
  if (normalized === null) return "Noch nicht bewertet";
  if (normalized < 1.5) return "Unzureichend";
  if (normalized < 2.5) return "Ausbaufähig";
  if (normalized < 3.5) return "Solide";
  if (normalized < 4.5) return "Gut";
  return "Sehr gut";
}

function scoreLabel(value) {
  const formatted = scoreNumber(value);
  return formatted === null
    ? "Noch nicht bewertet"
    : `${formatted}/5 · ${scoreQuality(value)}`;
}

function scoreCompact(value) {
  const formatted = scoreNumber(value);
  return formatted === null ? "-" : `${formatted}/5`;
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

function hexColor(value, fallback = DEFAULT_PRIMARY) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : fallback;
}

function rgbColor(value) {
  if (!Array.isArray(value) || value.length !== 3
    || value.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    return DEFAULT_PRIMARY;
  }
  return `#${value.map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`;
}

function colorChannels(value) {
  const normalized = hexColor(value);
  return normalized.slice(1).match(/.{2}/g).map((entry) => Number.parseInt(entry, 16));
}

function mixColor(left, right, rightRatio) {
  const first = colorChannels(left);
  const second = colorChannels(right);
  const ratio = Math.max(0, Math.min(1, Number(rightRatio)));
  return `#${first.map((channel, index) => (
    Math.round(channel * (1 - ratio) + second[index] * ratio).toString(16).padStart(2, "0")
  )).join("")}`;
}

function contrastColor(background) {
  const [red, green, blue] = colorChannels(background);
  const brightness = (red * 299 + green * 587 + blue * 114) / 1000;
  return brightness >= 155 ? BASE_COLORS.ink : BASE_COLORS.white;
}

function defaultExportOptions() {
  return {
    pageMode: "two",
    orientation: "landscape",
    colorRgb: [35, 95, 77],
    applyBranding: false,
    includeLogo: false,
    showOverallSummary: true,
    showCriteriaRatings: true,
    showFlComments: true,
    showEmployeeComments: true,
    showReviewerNames: true,
    showRoleTitle: true,
    showGeneratedAt: true,
  };
}

function normalizeExportOptions(value = {}) {
  const fallback = defaultExportOptions();
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const boolean = (key) => typeof source[key] === "boolean" ? source[key] : fallback[key];
  const colorRgb = Array.isArray(source.colorRgb) && source.colorRgb.length === 3
    && source.colorRgb.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)
    ? source.colorRgb.map(Number)
    : [...fallback.colorRgb];
  return {
    pageMode: source.pageMode === "single" ? "single" : "two",
    orientation: source.orientation === "portrait" ? "portrait" : "landscape",
    colorRgb,
    applyBranding: boolean("applyBranding"),
    includeLogo: boolean("includeLogo"),
    showOverallSummary: boolean("showOverallSummary"),
    showCriteriaRatings: boolean("showCriteriaRatings"),
    showFlComments: boolean("showFlComments"),
    showEmployeeComments: boolean("showEmployeeComments"),
    showReviewerNames: boolean("showReviewerNames"),
    showRoleTitle: boolean("showRoleTitle"),
    showGeneratedAt: boolean("showGeneratedAt"),
  };
}

function normalizedBranding(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const colors = source.colors && typeof source.colors === "object" ? source.colors : {};
  return {
    companyName: text(source.companyName || source.company_name, "Grabenplaner").slice(0, 120),
    logo: source.logoBuffer || source.logoPath || source.logo || null,
    primary: hexColor(
      source.primaryColor || source.primary_color || colors.primary,
      DEFAULT_PRIMARY,
    ),
  };
}

function themeFor(options, branding) {
  const primary = options.applyBranding ? branding.primary : rgbColor(options.colorRgb);
  const headerInk = contrastColor(primary);
  return {
    ...BASE_COLORS,
    primary,
    primarySoft: mixColor(primary, BASE_COLORS.white, 0.89),
    primaryFaint: mixColor(primary, BASE_COLORS.white, 0.95),
    headerInk,
    headerMuted: mixColor(primary, headerInk, 0.76),
  };
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
  const options = normalizeExportOptions(input.exportOptions || input.pdfOptions);
  const branding = normalizedBranding(input.branding);
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
    options,
    branding,
    theme: themeFor(options, branding),
  };
}

function layoutForPage(doc, orientation) {
  return {
    orientation,
    margin: orientation === "portrait" ? 28 : 32,
    width: doc.page.width,
    height: doc.page.height,
  };
}

function drawRatingScale(doc, value, x, y, theme, options = {}) {
  const chipWidth = Number(options.chipWidth || 20);
  const chipHeight = Number(options.chipHeight || 18);
  const gap = Number(options.gap || 4);
  const fontSize = Number(options.fontSize || 7);
  const selected = score(value) === null ? null : Math.round(Number(value));
  for (let rating = 1; rating <= 5; rating += 1) {
    const chipX = x + (rating - 1) * (chipWidth + gap);
    const active = selected === rating;
    const style = active ? SCORE_STYLES[rating] : null;
    doc.roundedRect(chipX, y, chipWidth, chipHeight, Math.min(6, chipHeight / 3))
      .fill(style?.fill || theme.chip);
    doc.font("Helvetica-Bold").fontSize(fontSize).fillColor(style?.ink || theme.muted)
      .text(String(rating), chipX, y + Math.max(2, (chipHeight - fontSize) / 2 - 0.5), {
        width: chipWidth,
        align: "center",
        lineBreak: false,
      });
  }
}

function drawPageHeader(doc, model, title, subtitle, preparedLogo) {
  const { orientation } = model.options;
  doc.addPage({ size: "A4", layout: orientation, margin: 0 });
  const layout = layoutForPage(doc, orientation);
  const { theme } = model;
  const logoWidth = preparedLogo ? (orientation === "portrait" ? 82 : 105) : 0;
  const logoX = layout.width - layout.margin - logoWidth;
  const metaWidth = preparedLogo ? (orientation === "portrait" ? 126 : 170) : 205;
  const metaX = layout.width - layout.margin - logoWidth - (preparedLogo ? 8 : 0) - metaWidth;
  const titleWidth = Math.max(210, metaX - layout.margin - 12);
  doc.rect(0, 0, layout.width, 60).fill(theme.primary);
  doc.font("Helvetica-Bold").fontSize(orientation === "portrait" ? 14.5 : 18).fillColor(theme.headerInk)
    .text(title, layout.margin, 14, { width: titleWidth, height: 22, ellipsis: true, lineBreak: false });
  doc.font("Helvetica").fontSize(orientation === "portrait" ? 6.5 : 7.2).fillColor(theme.headerMuted)
    .text(subtitle, layout.margin, 38, { width: titleWidth, height: 10, ellipsis: true, lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(orientation === "portrait" ? 5.3 : 6.4).fillColor(theme.headerInk)
    .text("VERTRAULICHE PERSONALAUSWERTUNG", metaX, 16, {
      width: metaWidth,
      align: "right",
      lineBreak: false,
    });
  if (model.options.showGeneratedAt) {
    doc.font("Helvetica").fontSize(orientation === "portrait" ? 5.2 : 6).fillColor(theme.headerMuted)
      .text(`Erstellt: ${formattedTimestamp(model.generatedAt)}`, metaX, 36, {
        width: metaWidth,
        align: "right",
        lineBreak: false,
      });
  }
  if (preparedLogo) {
    doc.roundedRect(logoX, 10, logoWidth, 40, 6).fill(theme.white);
    doc.image(preparedLogo, logoX + 6, 15, {
      fit: [logoWidth - 12, 30],
      align: "center",
      valign: "center",
    });
  }
  return layout;
}

function drawSummaryCard(doc, model, x, y, width, height, title, value, caption) {
  const { orientation } = model.options;
  const { theme } = model;
  doc.roundedRect(x, y, width, height, 7).fill(theme.primarySoft);
  doc.font("Helvetica-Bold").fontSize(orientation === "portrait" ? 6.4 : 7).fillColor(theme.primary)
    .text(title.toUpperCase(), x + 9, y + 7, { width: width - 18, lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(orientation === "portrait" ? 9.1 : 11.2).fillColor(theme.ink)
    .text(scoreLabel(value), x + 9, y + 21, { width: width - 18, lineBreak: false });
  const chipWidth = orientation === "portrait" ? 17 : 19;
  const gap = orientation === "portrait" ? 2.5 : 3;
  drawRatingScale(doc, value, x + 9, y + 36, theme, {
    chipWidth,
    chipHeight: 16,
    gap,
    fontSize: 6,
  });
  doc.font("Helvetica").fontSize(orientation === "portrait" ? 4.7 : 5.5).fillColor(theme.muted)
    .text(caption, x + 9 + chipWidth * 5 + gap * 4 + 8, y + 38, {
      width: Math.max(30, width - (chipWidth * 5 + gap * 4) - 35),
      height: 14,
      ellipsis: true,
    });
}

function drawSummaries(doc, model, layout, top = 69) {
  if (!model.options.showOverallSummary) return top - 5;
  const width = layout.width - layout.margin * 2;
  const gap = layout.orientation === "portrait" ? 7 : 10;
  const cardWidth = (width - gap * 2) / 3;
  const height = 61;
  drawSummaryCard(doc, model, layout.margin, top, cardWidth, height, "FL-Bewertung", model.flOverall, "Eigenständige Bewertung der Filialleitung");
  drawSummaryCard(doc, model, layout.margin + cardWidth + gap, top, cardWidth, height, "MA-Bewertung", model.employeeOverall, `${model.completedCount} von ${model.assignedCount} Rückmeldungen`);
  drawSummaryCard(doc, model, layout.margin + (cardWidth + gap) * 2, top, cardWidth, height, "MA + FL", model.combinedOverall, "Gruppen gleich gewichtet");
  return top + height;
}

function overviewValue(criterion) {
  if (criterion.combinedAverage !== null) return criterion.combinedAverage;
  if (criterion.flRating !== null) return criterion.flRating;
  return criterion.employeeAverage;
}

function drawOverviewItem(doc, model, criterion, x, y, width, height, compact, alternate = false) {
  const { theme } = model;
  const padding = compact ? 7 : 10;
  const chipWidth = compact ? 13 : 20;
  const chipHeight = compact ? 12 : 20;
  const chipGap = compact ? 2 : 4;
  const scaleWidth = chipWidth * 5 + chipGap * 4;
  const scoreTextWidth = compact ? 58 : 86;
  const value = overviewValue(criterion);
  doc.roundedRect(x, y, width, height, compact ? 5 : 7)
    .fill(alternate ? theme.white : theme.surface);
  doc.roundedRect(x, y, width, height, compact ? 5 : 7)
    .lineWidth(0.4).strokeColor(theme.line).stroke();
  const labelWidth = Math.max(56, width - padding * 2 - scaleWidth - scoreTextWidth - 10);
  doc.font("Helvetica-Bold").fontSize(compact ? 5.8 : 7.7).fillColor(theme.ink)
    .text(criterion.label, x + padding, y + (compact ? 5 : 7), {
      width: labelWidth,
      height: compact ? 15 : 21,
      ellipsis: true,
    });
  if (!compact) {
    doc.font("Helvetica").fontSize(5.5).fillColor(theme.muted)
      .text(`FL ${scoreCompact(criterion.flRating)}  |  MA ${scoreCompact(criterion.employeeAverage)}  |  Gemeinsam ${scoreCompact(criterion.combinedAverage)}`, x + padding, y + 27, {
        width: labelWidth,
        lineBreak: false,
      });
  }
  doc.font("Helvetica-Bold").fontSize(compact ? 5.4 : 7.5).fillColor(theme.ink)
    .text(scoreLabel(value), x + padding + labelWidth + 4, y + Math.max(4, (height - 7) / 2), {
      width: scoreTextWidth,
      align: "right",
      lineBreak: false,
    });
  drawRatingScale(doc, value, x + width - padding - scaleWidth, y + (height - chipHeight) / 2, theme, {
    chipWidth,
    chipHeight,
    gap: chipGap,
    fontSize: compact ? 5 : 6.8,
  });
}

function drawOverviewHeading(doc, model, layout, top, compact) {
  const contentWidth = layout.width - layout.margin * 2;
  doc.font("Helvetica-Bold").fontSize(compact ? 7.5 : 8.5).fillColor(model.theme.ink)
    .text("Vollständige Kriterienübersicht", layout.margin, top + 10, { width: 220, lineBreak: false });
  doc.font("Helvetica").fontSize(compact ? 5.1 : 6).fillColor(model.theme.muted)
    .text("Der gemeinsame Wert wird auf der farbigen Skala von 1 bis 5 markiert.", layout.margin + 210, top + 11, {
      width: contentWidth - 210,
      align: "right",
      lineBreak: false,
    });
  return top + 27;
}

function drawCompactOverview(doc, model, layout, top) {
  if (!model.options.showCriteriaRatings) return top;
  const y = drawOverviewHeading(doc, model, layout, top, true);
  if (!model.criteria.length) {
    doc.roundedRect(layout.margin, y, layout.width - layout.margin * 2, 34, 6).fill(model.theme.surface);
    doc.font("Helvetica").fontSize(6).fillColor(model.theme.muted)
      .text("Noch keine Bewertungskriterien vorhanden.", layout.margin + 10, y + 12, { lineBreak: false });
    return y + 34;
  }
  const columns = layout.orientation === "portrait" ? 2 : 3;
  const rows = Math.ceil(model.criteria.length / columns);
  const gapX = 8;
  const gapY = 3;
  const itemWidth = (layout.width - layout.margin * 2 - gapX * (columns - 1)) / columns;
  const itemHeight = layout.orientation === "portrait" ? 30 : 29;
  model.criteria.forEach((criterion, index) => {
    const column = Math.floor(index / rows);
    const row = index % rows;
    drawOverviewItem(doc, model, criterion, layout.margin + column * (itemWidth + gapX), y + row * (itemHeight + gapY), itemWidth, itemHeight, true, row % 2 === 1);
  });
  return y + rows * itemHeight + Math.max(0, rows - 1) * gapY;
}

function drawFullOverview(doc, model, layout, top) {
  if (!model.options.showCriteriaRatings) return top;
  const y = drawOverviewHeading(doc, model, layout, top, false);
  const contentWidth = layout.width - layout.margin * 2;
  if (!model.criteria.length) {
    doc.roundedRect(layout.margin, y, contentWidth, 42, 7).fill(model.theme.surface);
    doc.font("Helvetica").fontSize(8).fillColor(model.theme.muted)
      .text("Noch keine Bewertungskriterien vorhanden.", layout.margin + 12, y + 16, { lineBreak: false });
    return y + 42;
  }
  const columnCount = model.criteria.length > 12 ? 2 : 1;
  const columnGap = 12;
  const columnWidth = (contentWidth - columnGap * (columnCount - 1)) / columnCount;
  const rowsPerColumn = Math.ceil(model.criteria.length / columnCount);
  const bottom = layout.height - 34;
  const availableHeight = bottom - y;
  const rowGap = columnCount === 1 ? (layout.orientation === "portrait" ? 7 : 5) : 3;
  const rowHeight = Math.min(layout.orientation === "portrait" ? 56 : 38, (availableHeight - rowGap * Math.max(0, rowsPerColumn - 1)) / rowsPerColumn);
  if (rowHeight < 12) {
    throw new CandidateEvaluationPdfError("Die Kriterienübersicht ist für dieses Seitenformat zu umfangreich.", "CANDIDATE_EVALUATION_PDF_LAYOUT_OVERFLOW");
  }
  const compact = rowHeight < 28;
  model.criteria.forEach((criterion, index) => {
    const column = Math.floor(index / rowsPerColumn);
    const row = index % rowsPerColumn;
    drawOverviewItem(doc, model, criterion, layout.margin + column * (columnWidth + columnGap), y + row * (rowHeight + rowGap), columnWidth, rowHeight, compact, row % 2 === 1);
  });
  return y + rowsPerColumn * rowHeight + Math.max(0, rowsPerColumn - 1) * rowGap;
}

function wrappedLines(doc, value, width, font = "Helvetica", fontSize = 6.2) {
  const paragraphs = text(value).split(/\r?\n/);
  const lines = [];
  doc.font(font).fontSize(fontSize);
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (!current || doc.widthOfString(candidate) <= width) {
        current = candidate;
        continue;
      }
      lines.push(current);
      if (doc.widthOfString(word) <= width) {
        current = word;
        continue;
      }
      let fragment = "";
      for (const character of word) {
        const fragmentCandidate = `${fragment}${character}`;
        if (fragment && doc.widthOfString(fragmentCandidate) > width) {
          lines.push(fragment);
          fragment = character;
        } else {
          fragment = fragmentCandidate;
        }
      }
      current = fragment;
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [""];
}

function detailEntries(model, criterion) {
  const entries = [];
  if (model.options.showFlComments && criterion.flComment) {
    entries.push({ label: "FL-Kommentar", rating: criterion.flRating, body: criterion.flComment });
  }
  if (model.options.showEmployeeComments) {
    for (const rating of criterion.reviewerRatings) {
      if (!rating.comment) continue;
      entries.push({
        label: model.options.showReviewerNames
          ? `${reviewerName(model.reviewerNames, rating.employeeNumber)} · MA-Kommentar`
          : "MA-Kommentar",
        rating: rating.rating,
        body: rating.comment,
      });
    }
  }
  return entries;
}

function detailScoreText(model, criterion) {
  if (!model.options.showCriteriaRatings) return "";
  return `FL ${scoreNumber(criterion.flRating) || "-"}  ·  MA ${scoreNumber(criterion.employeeAverage) || "-"}  ·  MA+FL ${scoreNumber(criterion.combinedAverage) || "-"}`;
}

function requiredCompactDetailHeight(doc, model, criterion, width) {
  const entries = detailEntries(model, criterion);
  let required = 26;
  if (!entries.length) return required + 12;
  for (const entry of entries) {
    doc.font("Helvetica").fontSize(5.1);
    required += 7 + doc.heightOfString(entry.body, { width: width - 14, lineGap: 1.1 }) + 4;
  }
  return required + 3;
}

function drawCompactDetailCard(doc, model, criterion, x, y, width, height) {
  const { theme } = model;
  if (requiredCompactDetailHeight(doc, model, criterion, width) > height) {
    throw new CandidateEvaluationPdfError("Die ausgewählten Kommentare passen nicht vollständig auf eine Seite. Bitte zwei Seiten wählen oder Inhalte abwählen.", "CANDIDATE_EVALUATION_PDF_SINGLE_PAGE_OVERFLOW");
  }
  doc.roundedRect(x, y, width, height, 5).fill(theme.white);
  doc.roundedRect(x, y, width, height, 5).lineWidth(0.45).strokeColor(theme.line).stroke();
  doc.roundedRect(x, y, width, 19, 5).fill(theme.primarySoft);
  doc.rect(x, y + 13, width, 6).fill(theme.primarySoft);
  const scores = detailScoreText(model, criterion);
  doc.font("Helvetica-Bold").fontSize(5.8).fillColor(theme.ink)
    .text(criterion.label, x + 7, y + 5, { width: scores ? width * 0.58 : width - 14, height: 9, ellipsis: true, lineBreak: false });
  if (scores) {
    doc.font("Helvetica-Bold").fontSize(4.7).fillColor(theme.primary)
      .text(scores, x + width * 0.52, y + 6, { width: width * 0.45 - 7, align: "right", lineBreak: false });
  }
  let bodyY = y + 23;
  const entries = detailEntries(model, criterion);
  if (!entries.length) {
    doc.font("Helvetica-Oblique").fontSize(5.1).fillColor(theme.muted)
      .text("Keine ausgewählten Kommentare hinterlegt.", x + 7, bodyY, { width: width - 14 });
    return;
  }
  for (const entry of entries) {
    const rating = model.options.showCriteriaRatings ? ` · ${scoreCompact(entry.rating)}` : "";
    doc.font("Helvetica-Bold").fontSize(4.9).fillColor(theme.primary)
      .text(`${entry.label}${rating}`, x + 7, bodyY, { width: width - 14, lineBreak: false });
    bodyY += 7;
    doc.font("Helvetica").fontSize(5.1).fillColor(theme.ink)
      .text(entry.body, x + 7, bodyY, { width: width - 14, lineGap: 1.1 });
    bodyY = doc.y + 4;
  }
}

function drawCompactDetails(doc, model, layout, top) {
  const commentsSelected = model.options.showFlComments || model.options.showEmployeeComments;
  if (!commentsSelected) return top;
  const contentWidth = layout.width - layout.margin * 2;
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(model.theme.ink)
    .text("Bewertungen und Kommentare im Detail", layout.margin, top, { width: contentWidth, lineBreak: false });
  const y = top + 15;
  const bottom = layout.height - 34;
  if (!model.criteria.length) {
    doc.font("Helvetica").fontSize(6).fillColor(model.theme.muted)
      .text("Noch keine Kommentare vorhanden.", layout.margin, y, { lineBreak: false });
    return y + 12;
  }
  const columns = layout.orientation === "portrait" ? 2 : 3;
  const rows = Math.ceil(model.criteria.length / columns);
  const gapX = 8;
  const gapY = 5;
  const cardWidth = (contentWidth - gapX * (columns - 1)) / columns;
  const cardHeight = (bottom - y - gapY * Math.max(0, rows - 1)) / rows;
  if (cardHeight < 40) {
    throw new CandidateEvaluationPdfError("Die ausgewählten Inhalte passen nicht vollständig auf eine Seite. Bitte zwei Seiten wählen oder Inhalte abwählen.", "CANDIDATE_EVALUATION_PDF_SINGLE_PAGE_OVERFLOW");
  }
  model.criteria.forEach((criterion, index) => {
    const column = Math.floor(index / rows);
    const row = index % rows;
    drawCompactDetailCard(doc, model, criterion, layout.margin + column * (cardWidth + gapX), y + row * (cardHeight + gapY), cardWidth, cardHeight);
  });
  return bottom;
}

function drawDetailCriterionHeader(doc, model, criterion, x, y, width, continued = false) {
  const scores = detailScoreText(model, criterion);
  const scoreWidth = scores ? Math.min(172, width * 0.46) : 0;
  doc.roundedRect(x, y, width, 20, 5).fill(model.theme.primarySoft);
  doc.font("Helvetica-Bold").fontSize(7).fillColor(model.theme.ink)
    .text(`${criterion.label}${continued ? " (Fortsetzung)" : ""}`, x + 8, y + 6, { width: width - scoreWidth - 16, height: 9, ellipsis: true, lineBreak: false });
  if (scores) {
    doc.font("Helvetica-Bold").fontSize(5.4).fillColor(model.theme.primary)
      .text(scores, x + width - scoreWidth - 7, y + 7, { width: scoreWidth, align: "right", lineBreak: false });
  }
}

function balancedDetailSplit(doc, model, columnWidth, lineHeight, availableHeight) {
  if (model.criteria.length < 2) return null;
  const heights = model.criteria.map((criterion) => {
    const entries = detailEntries(model, criterion);
    const entryHeight = entries.length
      ? entries.reduce((sum, entry) => (
        sum + 8.5 + wrappedLines(doc, entry.body, columnWidth - 14, "Helvetica", 6.2).length * lineHeight + 3
      ), 0)
      : 13;
    return 25 + entryHeight + 4;
  });
  let best = null;
  for (let split = 1; split < heights.length; split += 1) {
    const left = heights.slice(0, split).reduce((sum, height) => sum + height, 0)
      + Math.max(0, split - 1) * 5;
    const rightCount = heights.length - split;
    const right = heights.slice(split).reduce((sum, height) => sum + height, 0)
      + Math.max(0, rightCount - 1) * 5;
    if (left > availableHeight || right > availableHeight) continue;
    const difference = Math.abs(left - right);
    if (!best || difference < best.difference) best = { split, difference };
  }
  return best?.split ?? null;
}

function drawDetailPages(doc, model, preparedLogo) {
  const subtitle = model.options.showRoleTitle ? `${model.candidateName} · ${model.desiredRoleTitle}` : model.candidateName;
  let layout = drawPageHeader(doc, model, "Bewertungen und Kommentare im Detail", subtitle, preparedLogo);
  const columnGap = layout.orientation === "portrait" ? 12 : 18;
  const bodyTop = 76;
  const bodyBottom = layout.height - 34;
  const contentWidth = layout.width - layout.margin * 2;
  const columnWidth = (contentWidth - columnGap) / 2;
  const lineHeight = layout.orientation === "portrait" ? 7.7 : 7.4;
  const balancedSplit = balancedDetailSplit(
    doc,
    model,
    columnWidth,
    lineHeight,
    bodyBottom - bodyTop,
  );
  let column = 0;
  let y = bodyTop;
  const addDetailPage = () => {
    layout = drawPageHeader(doc, model, "Bewertungen und Kommentare im Detail", subtitle, preparedLogo);
    column = 0;
    y = bodyTop;
  };
  const columnX = () => layout.margin + column * (columnWidth + columnGap);
  const advanceColumn = () => {
    if (column === 0) {
      column = 1;
      y = bodyTop;
      return;
    }
    addDetailPage();
  };
  const ensureSpace = (height) => {
    if (y + height > bodyBottom) advanceColumn();
  };
  const criterionHeader = (criterion, continued = false) => {
    ensureSpace(25);
    drawDetailCriterionHeader(doc, model, criterion, columnX(), y, columnWidth, continued);
    y += 25;
  };
  if (!model.criteria.length) {
    doc.font("Helvetica").fontSize(8).fillColor(model.theme.muted)
      .text("Noch keine Bewertungen oder Kommentare vorhanden.", layout.margin, bodyTop, { width: contentWidth, lineBreak: false });
    return;
  }
  for (const [criterionIndex, criterion] of model.criteria.entries()) {
    if (balancedSplit !== null && criterionIndex === balancedSplit && column === 0) {
      column = 1;
      y = bodyTop;
    }
    if (y > bodyTop) y += 5;
    criterionHeader(criterion);
    const entries = detailEntries(model, criterion);
    if (!entries.length) {
      ensureSpace(13);
      doc.font("Helvetica-Oblique").fontSize(6.1).fillColor(model.theme.muted)
        .text(model.options.showFlComments || model.options.showEmployeeComments ? "Keine ausgewählten Kommentare hinterlegt." : "Kommentare sind für diesen Export ausgeblendet.", columnX() + 7, y, { width: columnWidth - 14, lineBreak: false });
      y += 13;
    }
    for (const entry of entries) {
      let lines = wrappedLines(doc, entry.body, columnWidth - 14, "Helvetica", 6.2);
      let continuation = false;
      while (lines.length) {
        if (y + 9 + lineHeight > bodyBottom) {
          advanceColumn();
          criterionHeader(criterion, true);
          continuation = true;
        }
        const rating = model.options.showCriteriaRatings ? ` · ${scoreCompact(entry.rating)}` : "";
        doc.font("Helvetica-Bold").fontSize(6).fillColor(model.theme.primary)
          .text(`${entry.label}${rating}${continuation ? " (Fortsetzung)" : ""}`, columnX() + 7, y, { width: columnWidth - 14, lineBreak: false });
        y += 8.5;
        const availableLines = Math.max(1, Math.floor((bodyBottom - y - 2) / lineHeight));
        const chunk = lines.slice(0, availableLines);
        lines = lines.slice(chunk.length);
        doc.font("Helvetica").fontSize(6.2).fillColor(model.theme.ink);
        chunk.forEach((line) => {
          doc.text(line || " ", columnX() + 7, y, { width: columnWidth - 14, lineBreak: false });
          y += lineHeight;
        });
        if (lines.length) {
          advanceColumn();
          criterionHeader(criterion, true);
          continuation = true;
        }
      }
      y += 3;
    }
    doc.moveTo(columnX(), y + 1).lineTo(columnX() + columnWidth, y + 1).lineWidth(0.4).strokeColor(model.theme.line).stroke();
    y += 4;
  }
}

function drawFooters(doc, model) {
  const range = doc.bufferedPageRange();
  for (let pageIndex = range.start; pageIndex < range.start + range.count; pageIndex += 1) {
    doc.switchToPage(pageIndex);
    const orientation = doc.page.width < doc.page.height ? "portrait" : "landscape";
    const layout = layoutForPage(doc, orientation);
    const footerY = layout.height - 20;
    const product = model.options.applyBranding ? clipped(model.branding.companyName, 48) : "Grabenplaner";
    doc.moveTo(layout.margin, footerY - 5).lineTo(layout.width - layout.margin, footerY - 5).lineWidth(0.4).strokeColor(model.theme.line).stroke();
    doc.font("Helvetica").fontSize(5.4).fillColor(model.theme.muted)
      .text("Vertrauliche Bewerbungsbewertung · FL- und MA-Bewertungen bleiben getrennt nachvollziehbar.", layout.margin, footerY, { width: layout.width - layout.margin * 2 - 135, lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(5.4).fillColor(model.theme.primary)
      .text(`${product} · Seite ${pageIndex - range.start + 1}/${range.count}`, layout.width - layout.margin - 130, footerY, { width: 130, align: "right", lineBreak: false });
  }
  doc.switchToPage(range.start + range.count - 1);
  return range.count;
}

function drawCandidateEvaluationPdf(doc, input, preparedLogo = null) {
  const model = normalizedModel(input);
  const subtitle = model.options.showRoleTitle ? `${model.candidateName} · ${model.desiredRoleTitle}` : model.candidateName;
  const layout = drawPageHeader(doc, model, "Bewerbungsbewertung", subtitle, preparedLogo);
  const summaryBottom = drawSummaries(doc, model, layout);
  if (model.options.pageMode === "single") {
    const overviewBottom = drawCompactOverview(doc, model, layout, summaryBottom + 2);
    drawCompactDetails(doc, model, layout, overviewBottom + 10);
  } else {
    const overviewBottom = drawFullOverview(doc, model, layout, summaryBottom + 2);
    if (!model.options.showCriteriaRatings && model.options.showOverallSummary) {
      doc.roundedRect(layout.margin, overviewBottom + 20, layout.width - layout.margin * 2, 48, 7).fill(model.theme.primaryFaint);
      doc.font("Helvetica").fontSize(7).fillColor(model.theme.muted)
        .text("Die Kriterienübersicht ist für diesen Export ausgeblendet. Bewertungen und ausgewählte Kommentare folgen auf der Detailseite.", layout.margin + 12, overviewBottom + 37, { width: layout.width - layout.margin * 2 - 24, align: "center" });
    }
    drawDetailPages(doc, model, preparedLogo);
  }
  const pageCount = drawFooters(doc, model);
  return { model, pageCount };
}

function logoError(message) {
  return new CandidateEvaluationPdfError(message, "CANDIDATE_EVALUATION_PDF_LOGO_INVALID");
}

async function readLogoInput(input) {
  if (!input) return null;
  if (Buffer.isBuffer(input)) return Buffer.from(input);
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input !== "string" || /^(?:https?:|data:|file:)/i.test(input.trim())) throw logoError("Das Bereichslogo muss als lokale Bilddatei vorliegen.");
  try {
    return await fs.promises.readFile(input);
  } catch {
    throw logoError("Das Bereichslogo konnte nicht gelesen werden.");
  }
}

function assertSafeSvg(buffer) {
  const source = buffer.toString("utf8");
  if (!/<svg\b/i.test(source)) return;
  const unsafeReference = [...source.matchAll(/\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gi)]
    .some((match) => !String(match[2] || "").trim().startsWith("#"));
  const unsafeCssUrl = [...source.matchAll(/\burl\s*\(([^)]*)\)/gi)]
    .some((match) => !String(match[1] || "").trim().replace(/^["']|["']$/g, "").startsWith("#"));
  if (/<!doctype|<!entity|<(?:[A-Za-z_][\w.-]*:)?(?:script|foreignObject|image|iframe)\b|\bon[a-z]+\s*=|@import\b/i.test(source) || unsafeReference || unsafeCssUrl) {
    throw logoError("Das Bereichslogo enthält nicht erlaubte aktive oder externe SVG-Inhalte.");
  }
}

async function prepareLogoBuffer(input) {
  const source = await readLogoInput(input);
  if (!source) throw logoError("Im gewählten Bewerbungsbereich ist kein Logo hinterlegt.");
  if (!source.length || source.length > MAX_LOGO_BYTES) throw logoError("Das Bereichslogo ist leer oder größer als 15 MB.");
  assertSafeSvg(source);
  try {
    const image = sharp(source, { failOn: "warning", limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!SUPPORTED_LOGO_FORMATS.has(metadata.format)) throw logoError("Das Bereichslogo muss SVG, PNG, JPG oder WebP sein.");
    return await image.rotate().resize({ width: 1000, height: 300, fit: "inside", withoutEnlargement: true }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  } catch (error) {
    if (error instanceof CandidateEvaluationPdfError) throw error;
    throw logoError("Das Bereichslogo konnte nicht sicher für die PDF aufbereitet werden.");
  }
}

async function createCandidateEvaluationPdfArtifact(input) {
  const model = normalizedModel(input);
  const preparedLogo = model.options.includeLogo ? await prepareLogoBuffer(model.branding.logo) : null;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let pageCount = 0;
    const doc = new PDFDocument({
      autoFirstPage: false,
      bufferPages: true,
      compress: true,
      info: {
        Title: `Bewerbungsbewertung ${model.candidateName}`,
        Subject: "Strukturierte Bewerbungsbewertung",
        Creator: model.options.applyBranding ? model.branding.companyName : "Grabenplaner",
      },
    });
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.once("error", reject);
    doc.once("end", () => resolve({ buffer: Buffer.concat(chunks), pageCount }));
    try {
      pageCount = drawCandidateEvaluationPdf(doc, input, preparedLogo).pageCount;
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

async function createCandidateEvaluationPdf(input) {
  return (await createCandidateEvaluationPdfArtifact(input)).buffer;
}

module.exports = {
  CandidateEvaluationPdfError,
  createCandidateEvaluationPdf,
  createCandidateEvaluationPdfArtifact,
  drawCandidateEvaluationPdf,
  normalizeCandidateEvaluationPdfOptions: normalizeExportOptions,
  normalizedCandidateEvaluationPdfModel: normalizedModel,
};
