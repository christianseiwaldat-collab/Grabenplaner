"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const TRADEFOTO_REPORT_CONTRACT_VERSION = 2;
const TRADEFOTO_REPORT_PARSER_VERSION = 2;
const TRADEFOTO_REPORT_ADAPTER_ID = "tradefoto_product_group_net_report";
const TRADEFOTO_REPORT_SOURCE_SYSTEM = "tradefoto_report";
const TRADEFOTO_REPORT_MAX_BYTES = 15 * 1024 * 1024;
const TRADEFOTO_REPORT_MAX_PAGES = 120;
const TRADEFOTO_REPORT_MAX_TEXT_ITEMS_PER_PAGE = 25_000;
const TRADEFOTO_REPORT_MAX_TEXT_ITEMS = 300_000;
const TRADEFOTO_REPORT_MAX_TEXT_ITEM_CHARACTERS = 4_096;
const TRADEFOTO_REPORT_MAX_TEXT_CHARACTERS = 16 * 1024 * 1024;
const TRADEFOTO_REPORT_MAX_PRODUCT_GROUPS = 2_000;
const TRADEFOTO_REPORT_PREVIEWS = new WeakSet();
const TRADEFOTO_REPORT_EXTRACTIONS = Object.freeze({
  TEXT: "pdf_text_coordinates",
  OCR: "local_ocr_coordinates",
});

const GROUP_COLUMN_RIGHT_EDGES = Object.freeze({
  quantityCurrent: 178.3,
  quantityComparison: 226.9,
  netRevenueCurrent: 350.8,
  netRevenueComparison: 406.1,
  grossMarginCurrent: 519.6,
  grossMarginComparison: 568.3,
  customerCountCurrent: 676.9,
  customerCountComparison: 720.0,
  revenuePerCustomerCurrent: 766.2,
  revenuePerCustomerComparison: 808.6,
});

const TOTAL_COLUMN_RIGHT_EDGES = Object.freeze({
  quantityCurrent: 186.6,
  quantityComparison: 234.1,
  netRevenueCurrent: 356.9,
  netRevenueComparison: 414.1,
  grossMarginCurrent: 525.7,
  grossMarginComparison: 574.6,
  customerCountCurrent: 678.6,
  customerCountComparison: 723.5,
  revenuePerCustomerCurrent: 767.8,
  revenuePerCustomerComparison: 811.2,
});

class TradeFotoReportError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "TradeFotoReportError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function reportError(code, details = {}) {
  return new TradeFotoReportError(code, details);
}

function deepFreeze(value, visited = new Set()) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  if (visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) deepFreeze(child, visited);
  return Object.freeze(value);
}

function cleanText(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeFileName(value) {
  const name = cleanText(path.basename(String(value || "TradeFoto-Statistik.pdf")));
  return (name || "TradeFoto-Statistik.pdf").slice(0, 160);
}

function isoDateFromDmy(value) {
  const match = String(value || "").match(/^(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/);
  if (!match) throw reportError("TRADEFOTO_REPORT_DATE_INVALID", { value: String(value || "") });
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const month = Number(match[2]);
  const day = Number(match[1]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day) {
    throw reportError("TRADEFOTO_REPORT_DATE_INVALID", { value: String(value || "") });
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function shiftIsoYear(value, amount) {
  const [year, month, day] = String(value).split("-").map(Number);
  const shifted = new Date(Date.UTC(year + amount, month - 1, day));
  if (shifted.getUTCMonth() !== month - 1 || shifted.getUTCDate() !== day) {
    shifted.setUTCDate(0);
  }
  return shifted.toISOString().slice(0, 10);
}

function canonicalDecimal4(value) {
  const normalized = String(value ?? "")
    .replace(/[\u00a0\s]/g, "")
    .trim();
  if (!/^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,4})?$/.test(normalized)) return null;
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integerPart, decimalPart = ""] = unsigned.split(",");
  const digits = integerPart.replace(/\./g, "");
  const canonicalInteger = digits.replace(/^0+(?=\d)/, "") || "0";
  if (canonicalInteger.length > 20) return null;
  const canonicalFraction = decimalPart.padEnd(4, "0");
  const isZero = /^0+$/.test(canonicalInteger) && /^0+$/.test(canonicalFraction);
  return `${negative && !isZero ? "-" : ""}${canonicalInteger}.${canonicalFraction}`;
}

function lineGroups(items, tolerance = 0.8) {
  const groups = [];
  for (const item of [...items].sort((left, right) => right.y - left.y || left.x - right.x)) {
    let group = groups[groups.length - 1];
    if (group && Math.abs(group.y - item.y) > tolerance) group = null;
    if (!group) {
      group = { y: item.y, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  for (const group of groups) group.items.sort((left, right) => left.x - right.x);
  return groups.sort((left, right) => right.y - left.y);
}

function rowItemsAt(items, y, tolerance = 0.8) {
  return items.filter((item) => Math.abs(item.y - y) <= tolerance && cleanText(item.text));
}

function itemAtRightEdge(items, edge, tolerance = 4.8) {
  let selected = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const candidateDistance = Math.abs(item.right - edge);
    if (candidateDistance <= tolerance && candidateDistance < distance) {
      selected = item;
      distance = candidateDistance;
    }
  }
  return selected;
}

function metricValue(items, edge, { zeroWhenMissing = false, tolerance = 4.8 } = {}) {
  const item = itemAtRightEdge(items, edge, tolerance);
  if (!item) return zeroWhenMissing ? "0.0000" : null;
  return canonicalDecimal4(item.text);
}

function metricPair(items, edges, tolerance = 4.8) {
  return Object.freeze({
    current: Object.freeze({
      quantity: metricValue(items, edges.quantityCurrent, { zeroWhenMissing: true, tolerance }),
      netRevenue: metricValue(items, edges.netRevenueCurrent, { tolerance }),
      grossMargin: metricValue(items, edges.grossMarginCurrent, { tolerance }),
      customerCount: metricValue(items, edges.customerCountCurrent, { zeroWhenMissing: true, tolerance }),
      revenuePerCustomer: metricValue(items, edges.revenuePerCustomerCurrent, { tolerance }),
    }),
    comparison: Object.freeze({
      quantity: metricValue(items, edges.quantityComparison, { zeroWhenMissing: true, tolerance }),
      netRevenue: metricValue(items, edges.netRevenueComparison, { tolerance }),
      grossMargin: metricValue(items, edges.grossMarginComparison, { tolerance }),
      customerCount: metricValue(items, edges.customerCountComparison, { zeroWhenMissing: true, tolerance }),
      revenuePerCustomer: metricValue(items, edges.revenuePerCustomerComparison, { tolerance }),
    }),
  });
}

function requiredMetricIssues(pair, context) {
  const issues = [];
  for (const side of ["current", "comparison"]) {
    for (const metric of ["netRevenue", "grossMargin"]) {
      if (pair?.[side]?.[metric] === null) {
        issues.push(Object.freeze({
          code: "required_metric_missing",
          severity: "error",
          ...context,
          side,
          metric,
        }));
      }
    }
  }
  return issues;
}

function pageHeader(page) {
  const pageText = page.items.map((item) => item.text).join(" ");
  const titleMatch = pageText.match(
    /Warengruppenvergleich\s+netto\s+Filiale\s*[:;]?\s*([A-Za-z0-9._:-]+)/i,
  );
  // OCR may split the printed "*GsJahr" marker between G and s or merge
  // "Jahr ab". The marker and date remain mandatory so unrelated PDFs stay
  // fail-closed.
  const yearStartMatch = pageText.match(
    /\*?\s*G\s*sJahr\s*ab\s*[:;]?\s*(\d{2}\.\d{2}\.(?:\d{2}|\d{4}))/i,
  );
  if (!titleMatch || !yearStartMatch) return null;

  const dateLines = lineGroups(page.items.filter((item) => item.y > page.height - 125))
    .map((line) => ({
      ...line,
      dates: line.items
        .map((item) => {
          const match = cleanText(item.text).match(/^(\d{2}\.\d{2}\.(?:\d{2}|\d{4}))-?$/);
          return match ? { value: match[1], x: item.x } : null;
        })
        .filter(Boolean),
    }))
    .filter((line) => line.dates.length >= 2);

  // TextContent repeats the two date columns for every metric. The left-most
  // pair is stable and avoids depending on the extraction stream order.
  const orderedDateLines = dateLines
    .map((line) => ({ ...line, dates: line.dates.sort((left, right) => left.x - right.x) }))
    .sort((left, right) => right.y - left.y);
  if (orderedDateLines.length < 2) return null;
  const startLine = orderedDateLines[0];
  const endLine = orderedDateLines[1];

  return Object.freeze({
    externalBranchId: cleanText(titleMatch[1]),
    yearToDateStart: isoDateFromDmy(yearStartMatch[1]),
    periodStart: isoDateFromDmy(startLine.dates[0].value),
    comparisonStart: isoDateFromDmy(startLine.dates[1].value),
    periodEnd: isoDateFromDmy(endLine.dates[0].value),
    comparisonEnd: isoDateFromDmy(endLine.dates[1].value),
  });
}

function parseProductGroups(pages, issues, { ocr = false } = {}) {
  const groups = [];
  const rowTolerance = ocr ? 1.6 : 0.8;
  const metricTolerance = ocr ? 10.5 : 4.8;
  for (const page of pages) {
    const candidates = page.items
      .filter((item) => item.x >= 20 && item.x <= 45 && item.y > 70 && item.y < page.height - 90)
      .filter((item) => /^\d{3,4}$/.test(cleanText(item.text)))
      .sort((left, right) => right.y - left.y);
    for (const codeItem of candidates) {
      const row = rowItemsAt(page.items, codeItem.y, rowTolerance);
      const label = cleanText(row
        .filter((item) => item.x >= 45 && item.x < 155)
        .map((item) => item.text)
        .join(" "));
      if (!label) continue;
      const period = metricPair(row, GROUP_COLUMN_RIGHT_EDGES, metricTolerance);
      const expectedYearToDateY = codeItem.y - 22.55;
      const yearToDateLine = lineGroups(
        page.items.filter((item) => item.y < codeItem.y - 12 && item.y > codeItem.y - 34),
        rowTolerance,
      ).sort((left, right) => (
        Math.abs(left.y - expectedYearToDateY) - Math.abs(right.y - expectedYearToDateY)
      ))[0];
      const yearToDate = metricPair(
        yearToDateLine?.items || [],
        GROUP_COLUMN_RIGHT_EDGES,
        metricTolerance,
      );
      const context = { externalProductGroupId: cleanText(codeItem.text), page: page.number };
      issues.push(...requiredMetricIssues(period, { ...context, horizon: "period" }));
      issues.push(...requiredMetricIssues(yearToDate, { ...context, horizon: "year_to_date" }));
      if (groups.length >= TRADEFOTO_REPORT_MAX_PRODUCT_GROUPS) {
        throw reportError("TRADEFOTO_REPORT_COMPLEXITY_LIMIT", {
          reason: "product_groups",
          limit: TRADEFOTO_REPORT_MAX_PRODUCT_GROUPS,
        });
      }
      groups.push(Object.freeze({
        externalProductGroupId: context.externalProductGroupId,
        label,
        source: Object.freeze({
          page: page.number,
          ordinate: canonicalDecimal4(String(codeItem.y.toFixed(4)).replace(".", ",")),
          confidence: ocr && Number.isFinite(codeItem.confidence)
            ? Math.max(0, Math.min(100, Math.round(codeItem.confidence)))
            : null,
        }),
        horizons: Object.freeze({ period, yearToDate }),
      }));
    }
  }
  return groups;
}

function parseTotals(pages, issues, { ocr = false } = {}) {
  const page = pages[pages.length - 1];
  const codeItems = page.items
    .filter((item) => item.x >= 20 && item.x <= 50 && /^\d{3,4}$/.test(cleanText(item.text)));
  if (!codeItems.length) {
    issues.push(Object.freeze({ code: "report_totals_missing", severity: "error", page: page.number }));
    return null;
  }
  const lastGroupY = Math.min(...codeItems.map((item) => item.y));
  const candidates = lineGroups(page.items)
    .filter((line) => line.y < lastGroupY - 30 && line.y > 70)
    .filter((line) => !line.items.some((item) => /%|#Typ!/i.test(cleanText(item.text))))
    .filter((line) => line.items.filter((item) => canonicalDecimal4(item.text) !== null).length >= 8)
    .sort((left, right) => right.y - left.y)
    .slice(0, 2);
  if (candidates.length !== 2) {
    issues.push(Object.freeze({ code: "report_totals_missing", severity: "error", page: page.number }));
    return null;
  }
  const period = metricPair(candidates[0].items, TOTAL_COLUMN_RIGHT_EDGES, ocr ? 12 : 6.5);
  const yearToDate = metricPair(candidates[1].items, TOTAL_COLUMN_RIGHT_EDGES, ocr ? 12 : 6.5);
  issues.push(...requiredMetricIssues(period, { horizon: "period", aggregate: "report_total", page: page.number }));
  issues.push(...requiredMetricIssues(yearToDate, { horizon: "year_to_date", aggregate: "report_total", page: page.number }));
  return Object.freeze({
    source: Object.freeze({ page: page.number }),
    horizons: Object.freeze({ period, yearToDate }),
  });
}

function decimalUnits(value) {
  if (value === null) return null;
  const match = String(value).match(/^(-?)(\d+)\.(\d{4})$/);
  if (!match) return null;
  return BigInt(`${match[1]}${match[2]}${match[3]}`);
}

function unitsToDecimal4(value) {
  const negative = value < 0n;
  const digits = String(negative ? -value : value).padStart(5, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

function reconcile(groups, totals, issues) {
  if (!totals) return Object.freeze({ status: "incomplete", checks: Object.freeze([]) });
  const checks = [];
  for (const [horizonKey, horizon] of [["period", "period"], ["year_to_date", "yearToDate"]]) {
    for (const side of ["current", "comparison"]) {
      for (const metric of ["quantity", "netRevenue", "grossMargin"]) {
        const values = groups.map((group) => decimalUnits(group.horizons[horizon][side][metric]));
        const reported = decimalUnits(totals.horizons[horizon][side][metric]);
        const complete = reported !== null && values.every((value) => value !== null);
        const calculated = complete ? values.reduce((sum, value) => sum + value, 0n) : null;
        const difference = complete ? calculated - reported : null;
        // Printed group values are rounded to two decimals while the report total
        // can originate from unrounded source values. One quantity unit is kept
        // as an explicit, reviewable tolerance for known TradeFoto report drift.
        const tolerance = metric === "quantity"
          ? 10000n
          : BigInt(Math.max(1, groups.length)) * 50n;
        const absoluteDifference = difference === null
          ? null
          : difference < 0n ? -difference : difference;
        const exact = complete && difference === 0n;
        const withinTolerance = complete && absoluteDifference <= tolerance;
        const check = Object.freeze({
          horizon: horizonKey,
          side,
          metric,
          status: !complete
            ? "incomplete"
            : exact
              ? "match"
              : withinTolerance
                ? "within_tolerance"
                : "mismatch",
          reported: reported === null ? null : unitsToDecimal4(reported),
          calculated: calculated === null ? null : unitsToDecimal4(calculated),
          difference: difference === null ? null : unitsToDecimal4(difference),
        });
        checks.push(check);
        if (check.status === "mismatch") {
          issues.push(Object.freeze({
            code: "report_total_mismatch",
            severity: "error",
            horizon: horizonKey,
            side,
            metric,
            difference: check.difference,
          }));
        } else if (check.status === "within_tolerance") {
          issues.push(Object.freeze({
            code: "report_total_within_tolerance",
            severity: "warning",
            horizon: horizonKey,
            side,
            metric,
            difference: check.difference,
          }));
        }
      }
    }
  }
  const status = checks.some((check) => check.status === "mismatch")
    ? "mismatch"
    : checks.some((check) => check.status === "incomplete")
      ? "incomplete"
      : checks.some((check) => check.status === "within_tolerance")
        ? "within_tolerance"
        : "match";
  return Object.freeze({ status, checks: Object.freeze(checks) });
}

function normalizedPages(value) {
  if (!Array.isArray(value) || !value.length || value.length > TRADEFOTO_REPORT_MAX_PAGES) {
    throw reportError("TRADEFOTO_REPORT_PAGE_COUNT_INVALID");
  }
  let totalItems = 0;
  let totalTextCharacters = 0;
  return value.map((page, pageIndex) => {
    if (!page || !Array.isArray(page.items) || !Number.isFinite(page.height)) {
      throw reportError("TRADEFOTO_REPORT_TEXT_LAYOUT_INVALID");
    }
    if (page.items.length > TRADEFOTO_REPORT_MAX_TEXT_ITEMS_PER_PAGE) {
      throw reportError("TRADEFOTO_REPORT_COMPLEXITY_LIMIT", {
        reason: "text_items_per_page",
        page: pageIndex + 1,
        limit: TRADEFOTO_REPORT_MAX_TEXT_ITEMS_PER_PAGE,
      });
    }
    totalItems += page.items.length;
    if (totalItems > TRADEFOTO_REPORT_MAX_TEXT_ITEMS) {
      throw reportError("TRADEFOTO_REPORT_COMPLEXITY_LIMIT", {
        reason: "text_items",
        limit: TRADEFOTO_REPORT_MAX_TEXT_ITEMS,
      });
    }
    return Object.freeze({
      number: pageIndex + 1,
      height: Number(page.height),
      width: Number(page.width || 0),
      items: Object.freeze(page.items.map((item) => {
        const text = String(item?.text ?? item?.str ?? "");
        if (text.length > TRADEFOTO_REPORT_MAX_TEXT_ITEM_CHARACTERS) {
          throw reportError("TRADEFOTO_REPORT_COMPLEXITY_LIMIT", {
            reason: "text_item_characters",
            page: pageIndex + 1,
            limit: TRADEFOTO_REPORT_MAX_TEXT_ITEM_CHARACTERS,
          });
        }
        totalTextCharacters += text.length;
        if (totalTextCharacters > TRADEFOTO_REPORT_MAX_TEXT_CHARACTERS) {
          throw reportError("TRADEFOTO_REPORT_COMPLEXITY_LIMIT", {
            reason: "text_characters",
            limit: TRADEFOTO_REPORT_MAX_TEXT_CHARACTERS,
          });
        }
        const x = Number(item?.x ?? item?.transform?.[4]);
        const y = Number(item?.y ?? item?.transform?.[5]);
        const width = Number(item?.width || 0);
        const confidence = item?.confidence === null || item?.confidence === undefined
          ? null
          : Number(item.confidence);
        if (![x, y, width].every(Number.isFinite)) {
          throw reportError("TRADEFOTO_REPORT_TEXT_LAYOUT_INVALID");
        }
        if (confidence !== null && !Number.isFinite(confidence)) {
          throw reportError("TRADEFOTO_REPORT_TEXT_LAYOUT_INVALID");
        }
        return Object.freeze({
          text,
          x,
          y,
          width,
          right: x + width,
          confidence: confidence === null ? null : Math.max(0, Math.min(100, confidence)),
        });
      })),
    });
  });
}

function parseTradeFotoReportPages(pageInput, source = {}) {
  const pages = normalizedPages(pageInput);
  const extraction = source.extraction === TRADEFOTO_REPORT_EXTRACTIONS.OCR
    ? TRADEFOTO_REPORT_EXTRACTIONS.OCR
    : TRADEFOTO_REPORT_EXTRACTIONS.TEXT;
  const ocr = extraction === TRADEFOTO_REPORT_EXTRACTIONS.OCR;
  const firstHeader = pageHeader(pages[0]);
  const textItemCount = pages.reduce(
    (count, page) => count + page.items.filter((item) => cleanText(item.text)).length,
    0,
  );
  if (!firstHeader || textItemCount < pages.length * 20) {
    throw reportError("TRADEFOTO_REPORT_TEXT_LAYER_REQUIRED", {
      ocrFallbackAvailable: true,
      textItemCount,
    });
  }
  for (const page of pages) {
    const header = pageHeader(page);
    if (!header || header.externalBranchId !== firstHeader.externalBranchId
      || header.periodStart !== firstHeader.periodStart
      || header.periodEnd !== firstHeader.periodEnd
      || header.comparisonStart !== firstHeader.comparisonStart
      || header.comparisonEnd !== firstHeader.comparisonEnd) {
      throw reportError("TRADEFOTO_REPORT_PAGE_HEADER_MISMATCH", { page: page.number });
    }
  }

  const issues = [];
  if (ocr) {
    issues.push(Object.freeze({
      code: "local_ocr_review_required",
      severity: "warning",
      averageConfidence: Number.isFinite(Number(source.ocrAverageConfidence))
        ? Math.max(0, Math.min(100, Math.round(Number(source.ocrAverageConfidence))))
        : null,
      lowConfidenceWordCount: Number.isSafeInteger(source.ocrLowConfidenceWordCount)
        ? Math.max(0, source.ocrLowConfidenceWordCount)
        : null,
    }));
  }
  const formulaErrorPages = pages
    .filter((page) => page.items.some((item) => /#Typ!/i.test(cleanText(item.text))))
    .map((page) => page.number);
  if (formulaErrorPages.length) {
    issues.push(Object.freeze({
      code: "source_formula_error",
      severity: "warning",
      pages: Object.freeze(formulaErrorPages),
    }));
  }
  const productGroups = parseProductGroups(pages, issues, { ocr });
  if (!productGroups.length) throw reportError("TRADEFOTO_REPORT_PRODUCT_GROUPS_MISSING");
  const duplicateGroupIds = productGroups
    .map((group) => group.externalProductGroupId)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateGroupIds.length) {
    throw reportError("TRADEFOTO_REPORT_PRODUCT_GROUP_DUPLICATE", {
      externalProductGroupIds: [...new Set(duplicateGroupIds)],
    });
  }
  const totals = parseTotals(pages, issues, { ocr });
  const reconciliation = reconcile(productGroups, totals, issues);
  const generatedOnItem = pages[pages.length - 1].items
    .filter((item) => item.y < 70)
    .map((item) => cleanText(item.text).match(/^(\d{2}\.\d{2}\.(?:\d{2}|\d{4}))$/))
    .find(Boolean);
  const yearToDateComparisonStart = shiftIsoYear(firstHeader.yearToDateStart, -1);
  const preview = {
    contractVersion: TRADEFOTO_REPORT_CONTRACT_VERSION,
    parserVersion: TRADEFOTO_REPORT_PARSER_VERSION,
    adapterId: TRADEFOTO_REPORT_ADAPTER_ID,
    sourceSystem: TRADEFOTO_REPORT_SOURCE_SYSTEM,
    source: {
      fileName: safeFileName(source.fileName),
      contentSha256: String(source.contentSha256 || "").toLowerCase(),
      byteLength: Number(source.byteLength || 0),
      mediaType: "application/pdf",
      pageCount: pages.length,
      originalRetained: false,
      extraction,
      ocrAverageConfidence: ocr && Number.isFinite(Number(source.ocrAverageConfidence))
        ? Math.max(0, Math.min(100, Math.round(Number(source.ocrAverageConfidence))))
        : null,
      ocrLowConfidenceWordCount: ocr && Number.isSafeInteger(source.ocrLowConfidenceWordCount)
        ? Math.max(0, source.ocrLowConfidenceWordCount)
        : null,
      ocrReviewed: false,
    },
    report: {
      kind: "product_group_net_comparison",
      title: "Warengruppenvergleich netto",
      externalBranchId: firstHeader.externalBranchId,
      generatedOn: generatedOnItem ? isoDateFromDmy(generatedOnItem[1]) : null,
      periods: {
        period: { start: firstHeader.periodStart, end: firstHeader.periodEnd },
        comparison: { start: firstHeader.comparisonStart, end: firstHeader.comparisonEnd },
        yearToDate: { start: firstHeader.yearToDateStart, end: firstHeader.periodEnd },
        yearToDateComparison: { start: yearToDateComparisonStart, end: firstHeader.comparisonEnd },
      },
      currency: null,
      currencyConfirmationRequired: true,
    },
    productGroups,
    totals,
    reconciliation,
    issues,
    confirmation: {
      required: true,
      confirmsSourceReport: true,
      confirmsLocationMapping: true,
      confirmsCurrency: true,
      ocrReviewRequired: ocr,
      ocrReviewed: false,
    },
  };
  return deepFreeze(preview);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, reason) {
  if (!isPlainRecord(value)) throw reportError("TRADEFOTO_REPORT_OCR_REVIEW_INVALID", { reason });
  const allowed = new Set(expected);
  if (Object.keys(value).length !== allowed.size
    || Object.keys(value).some((key) => !allowed.has(key))) {
    throw reportError("TRADEFOTO_REPORT_OCR_REVIEW_INVALID", { reason });
  }
}

function reviewedText(value, { maximumLength, pattern = null, reason }) {
  const normalized = cleanText(value);
  if (!normalized || normalized.length > maximumLength || (pattern && !pattern.test(normalized))) {
    throw reportError("TRADEFOTO_REPORT_OCR_REVIEW_INVALID", { reason });
  }
  return normalized;
}

function reviewedIsoDate(value, reason, { nullable = false } = {}) {
  if (nullable && (value === null || value === "")) return null;
  const normalized = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw reportError("TRADEFOTO_REPORT_OCR_REVIEW_INVALID", { reason });
  }
  const [year, month, day] = normalized.split("-").map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day) {
    throw reportError("TRADEFOTO_REPORT_OCR_REVIEW_INVALID", { reason });
  }
  return normalized;
}

function reviewedDecimal(value, reason, { nullable = false } = {}) {
  if (nullable && (value === null || String(value).trim() === "")) return null;
  const input = String(value ?? "").trim();
  let normalized = /^-?\d{1,20}\.\d{4}$/.test(input) ? input : canonicalDecimal4(input);
  if (!normalized || !/^-?\d{1,20}\.\d{4}$/.test(normalized)) {
    throw reportError("TRADEFOTO_REPORT_OCR_REVIEW_INVALID", { reason });
  }
  const [integer, fraction] = normalized.split(".");
  const negative = integer.startsWith("-");
  const digits = (negative ? integer.slice(1) : integer).replace(/^0+(?=\d)/, "") || "0";
  const zero = /^0+$/.test(digits) && /^0+$/.test(fraction);
  normalized = `${negative && !zero ? "-" : ""}${digits}.${fraction}`;
  return normalized;
}

function reviewedMetricPair(value, reason) {
  assertExactKeys(value, ["current", "comparison"], `${reason}_pair`);
  const side = (sideValue, sideName) => {
    assertExactKeys(sideValue, [
      "quantity",
      "netRevenue",
      "grossMargin",
      "customerCount",
      "revenuePerCustomer",
    ], `${reason}_${sideName}`);
    return Object.freeze({
      quantity: reviewedDecimal(sideValue.quantity, `${reason}_${sideName}_quantity`),
      netRevenue: reviewedDecimal(sideValue.netRevenue, `${reason}_${sideName}_net_revenue`),
      grossMargin: reviewedDecimal(sideValue.grossMargin, `${reason}_${sideName}_gross_margin`),
      customerCount: reviewedDecimal(sideValue.customerCount, `${reason}_${sideName}_customer_count`),
      revenuePerCustomer: reviewedDecimal(
        sideValue.revenuePerCustomer,
        `${reason}_${sideName}_revenue_per_customer`,
        { nullable: true },
      ),
    });
  };
  return Object.freeze({
    current: side(value.current, "current"),
    comparison: side(value.comparison, "comparison"),
  });
}

function reviewedHorizons(value, reason) {
  assertExactKeys(value, ["period", "yearToDate"], `${reason}_horizons`);
  return Object.freeze({
    period: reviewedMetricPair(value.period, `${reason}_period`),
    yearToDate: reviewedMetricPair(value.yearToDate, `${reason}_year_to_date`),
  });
}

function reviewTradeFotoOcrPreview(value, review) {
  const preview = assertTradeFotoReportPreview(value);
  if (preview.source.extraction !== TRADEFOTO_REPORT_EXTRACTIONS.OCR) {
    throw reportError("TRADEFOTO_REPORT_OCR_REVIEW_INVALID", { reason: "not_ocr_preview" });
  }
  assertExactKeys(review, ["report", "productGroups", "totals"], "review_shape");
  assertExactKeys(review.report, ["externalBranchId", "generatedOn", "periods"], "report_shape");
  assertExactKeys(review.report.periods, [
    "period",
    "comparison",
    "yearToDate",
    "yearToDateComparison",
  ], "periods_shape");

  const period = (input, reason) => {
    assertExactKeys(input, ["start", "end"], `${reason}_shape`);
    const start = reviewedIsoDate(input.start, `${reason}_start`);
    const end = reviewedIsoDate(input.end, `${reason}_end`);
    if (start > end) throw reportError("TRADEFOTO_REPORT_OCR_REVIEW_INVALID", { reason: `${reason}_chronology` });
    return Object.freeze({ start, end });
  };
  const periods = Object.freeze({
    period: period(review.report.periods.period, "period"),
    comparison: period(review.report.periods.comparison, "comparison"),
    yearToDate: period(review.report.periods.yearToDate, "year_to_date"),
    yearToDateComparison: period(
      review.report.periods.yearToDateComparison,
      "year_to_date_comparison",
    ),
  });
  if (periods.yearToDate.end !== periods.period.end
    || periods.yearToDateComparison.end !== periods.comparison.end) {
    throw reportError("TRADEFOTO_REPORT_OCR_REVIEW_INVALID", { reason: "period_end_alignment" });
  }

  if (!Array.isArray(review.productGroups)
    || review.productGroups.length !== preview.productGroups.length) {
    throw reportError("TRADEFOTO_REPORT_OCR_REVIEW_INVALID", { reason: "product_group_count" });
  }
  const productGroups = review.productGroups.map((group, index) => {
    assertExactKeys(group, ["externalProductGroupId", "label", "horizons"], "product_group_shape");
    return Object.freeze({
      externalProductGroupId: reviewedText(group.externalProductGroupId, {
        maximumLength: 4,
        pattern: /^\d{3,4}$/,
        reason: "product_group_id",
      }),
      label: reviewedText(group.label, { maximumLength: 240, reason: "product_group_label" }),
      source: preview.productGroups[index].source,
      horizons: reviewedHorizons(group.horizons, `product_group_${index + 1}`),
    });
  });
  const duplicateGroupIds = productGroups
    .map((group) => group.externalProductGroupId)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateGroupIds.length) {
    throw reportError("TRADEFOTO_REPORT_OCR_REVIEW_INVALID", { reason: "product_group_duplicate" });
  }

  assertExactKeys(review.totals, ["horizons"], "totals_shape");
  const totals = Object.freeze({
    source: preview.totals?.source || Object.freeze({ page: preview.source.pageCount }),
    horizons: reviewedHorizons(review.totals.horizons, "totals"),
  });
  const issues = preview.issues
    .filter((issue) => issue.code === "source_formula_error")
    .map((issue) => issue);
  issues.push(Object.freeze({
    code: "local_ocr_human_reviewed",
    severity: "warning",
  }));
  for (const group of productGroups) {
    const context = {
      externalProductGroupId: group.externalProductGroupId,
      page: group.source.page,
    };
    issues.push(...requiredMetricIssues(group.horizons.period, { ...context, horizon: "period" }));
    issues.push(...requiredMetricIssues(group.horizons.yearToDate, { ...context, horizon: "year_to_date" }));
  }
  issues.push(...requiredMetricIssues(totals.horizons.period, {
    horizon: "period",
    aggregate: "report_total",
    page: totals.source.page,
  }));
  issues.push(...requiredMetricIssues(totals.horizons.yearToDate, {
    horizon: "year_to_date",
    aggregate: "report_total",
    page: totals.source.page,
  }));
  const reconciliation = reconcile(productGroups, totals, issues);
  if (!["match", "within_tolerance"].includes(reconciliation.status)
    || issues.some((issue) => issue.severity === "error")) {
    throw reportError("TRADEFOTO_REPORT_OCR_REVIEW_INVALID", {
      reason: "reconciliation",
      reconciliationStatus: reconciliation.status,
      errorCount: issues.filter((issue) => issue.severity === "error").length,
    });
  }

  const reviewedPreview = deepFreeze({
    ...preview,
    source: {
      ...preview.source,
      ocrReviewed: true,
    },
    report: {
      ...preview.report,
      externalBranchId: reviewedText(review.report.externalBranchId, {
        maximumLength: 80,
        pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
        reason: "external_branch_id",
      }),
      generatedOn: reviewedIsoDate(review.report.generatedOn, "generated_on", { nullable: true }),
      periods,
    },
    productGroups,
    totals,
    reconciliation,
    issues,
    confirmation: {
      ...preview.confirmation,
      ocrReviewed: true,
    },
  });
  TRADEFOTO_REPORT_PREVIEWS.add(reviewedPreview);
  return reviewedPreview;
}

function trustTradeFotoReportPages(pageInput, source) {
  const preview = parseTradeFotoReportPages(pageInput, source);
  TRADEFOTO_REPORT_PREVIEWS.add(preview);
  return preview;
}

async function inspectTradeFotoReportBuffer(buffer, { fileName = "TradeFoto-Statistik.pdf" } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5 || buffer.length > TRADEFOTO_REPORT_MAX_BYTES) {
    throw reportError("TRADEFOTO_REPORT_FILE_SIZE_INVALID", {
      maximumBytes: TRADEFOTO_REPORT_MAX_BYTES,
    });
  }
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw reportError("TRADEFOTO_REPORT_PDF_INVALID");
  }
  const contentSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  let loadingTask;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: true,
    });
    const document = await loadingTask.promise;
    if (!Number.isSafeInteger(document.numPages)
      || document.numPages < 1
      || document.numPages > TRADEFOTO_REPORT_MAX_PAGES) {
      throw reportError("TRADEFOTO_REPORT_PAGE_COUNT_INVALID", {
        maximumPages: TRADEFOTO_REPORT_MAX_PAGES,
      });
    }
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ disableNormalization: false });
      pages.push({
        width: viewport.width,
        height: viewport.height,
        items: content.items.map((item) => ({
          text: item.str,
          x: item.transform?.[4],
          y: item.transform?.[5],
          width: item.width,
        })),
      });
      page.cleanup();
    }
    const preview = trustTradeFotoReportPages(pages, {
      fileName,
      contentSha256,
      byteLength: buffer.length,
    });
    return preview;
  } catch (error) {
    if (error instanceof TradeFotoReportError) throw error;
    if (String(error?.name || "").includes("Password")) {
      throw reportError("TRADEFOTO_REPORT_PASSWORD_PROTECTED");
    }
    throw reportError("TRADEFOTO_REPORT_PDF_INVALID", {
      parserCode: cleanText(error?.name || error?.code || "PDF_ERROR").slice(0, 80),
    });
  } finally {
    try { await loadingTask?.destroy(); } catch {}
  }
}

function assertTradeFotoReportPreview(value) {
  if (!TRADEFOTO_REPORT_PREVIEWS.has(value)) {
    throw reportError("TRADEFOTO_REPORT_PREVIEW_UNTRUSTED");
  }
  return value;
}

module.exports = {
  TRADEFOTO_REPORT_ADAPTER_ID,
  TRADEFOTO_REPORT_CONTRACT_VERSION,
  TRADEFOTO_REPORT_EXTRACTIONS,
  TRADEFOTO_REPORT_MAX_BYTES,
  TRADEFOTO_REPORT_MAX_PAGES,
  TRADEFOTO_REPORT_MAX_PRODUCT_GROUPS,
  TRADEFOTO_REPORT_MAX_TEXT_CHARACTERS,
  TRADEFOTO_REPORT_MAX_TEXT_ITEM_CHARACTERS,
  TRADEFOTO_REPORT_MAX_TEXT_ITEMS,
  TRADEFOTO_REPORT_MAX_TEXT_ITEMS_PER_PAGE,
  TRADEFOTO_REPORT_PARSER_VERSION,
  TRADEFOTO_REPORT_SOURCE_SYSTEM,
  TradeFotoReportError,
  assertTradeFotoReportPreview,
  inspectTradeFotoReportBuffer,
  parseTradeFotoReportPages,
  reviewTradeFotoOcrPreview,
  trustTradeFotoReportPages,
};
