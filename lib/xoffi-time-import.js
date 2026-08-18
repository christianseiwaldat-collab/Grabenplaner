"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const sharp = require("sharp");
const germanData = require("@tesseract.js-data/deu");
const { createWorker, OEM, PSM } = require("tesseract.js");

const XOFFI_OCR_ENGINE_VERSION = "local-tesseract-v7-deu-xoffi-3";
const XOFFI_IMAGE_MAX_BYTES = 18 * 1024 * 1024;
const XOFFI_IMAGE_MAX_PIXELS = 48 * 1000 * 1000;
const XOFFI_OCR_TIMEOUT_MS = 60_000;
const XOFFI_OCR_MAX_QUEUED_JOBS = 2;

let queuedJobs = 0;
let ocrQueue = Promise.resolve();

class XoffiTimeImportError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "XoffiTimeImportError";
    this.code = code;
    this.details = details;
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function finiteBox(value) {
  if (!value || typeof value !== "object") return null;
  const box = {
    x0: Number(value.x0),
    y0: Number(value.y0),
    x1: Number(value.x1),
    y1: Number(value.y1),
  };
  return Object.values(box).every(Number.isFinite) && box.x1 > box.x0 && box.y1 > box.y0 ? box : null;
}

function recognitionLines(blocks = []) {
  const result = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    for (const paragraph of Array.isArray(block?.paragraphs) ? block.paragraphs : []) {
      for (const line of Array.isArray(paragraph?.lines) ? paragraph.lines : []) {
        const words = (Array.isArray(line?.words) ? line.words : [])
          .map((word) => ({ text: cleanText(word?.text), box: finiteBox(word?.bbox), confidence: Number(word?.confidence) }))
          .filter((word) => word.text && word.box);
        if (!words.length) continue;
        const box = finiteBox(line?.bbox) || {
          x0: Math.min(...words.map((word) => word.box.x0)),
          y0: Math.min(...words.map((word) => word.box.y0)),
          x1: Math.max(...words.map((word) => word.box.x1)),
          y1: Math.max(...words.map((word) => word.box.y1)),
        };
        result.push({
          text: cleanText(words.sort((left, right) => left.box.x0 - right.box.x0).map((word) => word.text).join(" ")),
          box,
          x: (box.x0 + box.x1) / 2,
          y: (box.y0 + box.y1) / 2,
          confidence: Math.min(...words.map((word) => Number.isFinite(word.confidence) ? word.confidence : 0)),
        });
      }
    }
  }
  return result.sort((left, right) => left.y - right.y || left.x - right.x);
}

function isoDate(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
  if (Number.isNaN(date.getTime())) return "";
  const value = date.toISOString().slice(0, 10);
  return value === `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` ? value : "";
}

function addDays(dateValue, count) {
  const date = new Date(`${dateValue}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function mondayFor(dateValue) {
  const date = new Date(`${dateValue}T12:00:00Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return date.toISOString().slice(0, 10);
}

function datesFromText(text) {
  return [...cleanText(text).matchAll(/(\d{1,2})[.\/]\s*(\d{1,2})[.\/]\s*(20\d{2})/g)]
    .map((match) => isoDate(match[3], match[2], match[1]))
    .filter(Boolean);
}

function validIsoDate(value) {
  const match = String(value || "").match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  return Boolean(match && isoDate(match[1], match[2], match[3]) === value);
}

function indexedWeekFromHeaderDates(dates, minimumMatches = 6) {
  if (!Array.isArray(dates) || dates.length !== 7) return null;
  const candidates = new Map();
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    if (!validIsoDate(date)) continue;
    const weekStart = addDays(date, -index);
    if (mondayFor(weekStart) !== weekStart) continue;
    const candidate = candidates.get(weekStart) || { weekStart, matches: 0 };
    candidate.matches += 1;
    candidates.set(weekStart, candidate);
  }
  const ordered = [...candidates.values()].sort((left, right) => right.matches - left.matches || left.weekStart.localeCompare(right.weekStart));
  if (!ordered[0] || ordered[0].matches < minimumMatches || ordered[0].matches === ordered[1]?.matches) return null;
  return {
    weekStart: ordered[0].weekStart,
    weekEnd: addDays(ordered[0].weekStart, 6),
    matchedDateColumns: ordered[0].matches,
  };
}

function resolveXoffiScreenshotWeek({ headerDates = [], selectedWeekStart = "" } = {}) {
  const selected = String(selectedWeekStart || "");
  if (selected && (!validIsoDate(selected) || mondayFor(selected) !== selected)) {
    throw new XoffiTimeImportError("XOFFI_WEEK_SELECTION_INVALID");
  }
  const detected = indexedWeekFromHeaderDates(headerDates);
  if (!selected && (!detected || detected.matchedDateColumns !== 7)) {
    throw new XoffiTimeImportError("XOFFI_WEEK_NOT_DETECTED");
  }
  const effectiveWeekStart = selected || detected.weekStart;
  const status = !selected ? "detected"
    : !detected ? "unrecognized"
      : detected.weekStart !== selected ? "conflict"
        : detected.matchedDateColumns === 7 ? "matched" : "uncertain";
  return {
    weekStart: effectiveWeekStart,
    weekEnd: addDays(effectiveWeekStart, 6),
    resolution: {
      status,
      source: detected ? "header_date_columns" : "none",
      selectedWeekStart: selected || effectiveWeekStart,
      selectedWeekEnd: addDays(selected || effectiveWeekStart, 6),
      detectedWeekStart: detected?.weekStart || "",
      detectedWeekEnd: detected?.weekEnd || "",
      matchedDateColumns: Number(detected?.matchedDateColumns || 0),
      confirmationRequired: ["uncertain", "unrecognized", "conflict"].includes(status),
    },
  };
}

function normalizeName(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function nameScore(source, employee) {
  const sourceTokens = new Set(normalizeName(source).split(" ").filter((token) => token.length > 1));
  const candidates = [employee.full_name, employee.fullName, employee.nickname]
    .map(normalizeName)
    .filter(Boolean);
  let score = 0;
  for (const candidate of candidates) {
    if (candidate === normalizeName(source)) score = Math.max(score, 1);
    const tokens = candidate.split(" ").filter((token) => token.length > 1);
    if (tokens.length) score = Math.max(score, tokens.filter((token) => sourceTokens.has(token)).length / Math.max(tokens.length, sourceTokens.size));
  }
  return score;
}

function matchEmployee(sourceName, employees = []) {
  const scored = employees.map((employee) => ({ employee, score: nameScore(sourceName, employee) }))
    .sort((left, right) => right.score - left.score);
  if (!scored.length || scored[0].score < 0.45 || (scored[1] && scored[0].score - scored[1].score < 0.08)) {
    return { employeeNumber: "", confidence: scored[0]?.score || 0 };
  }
  return {
    employeeNumber: String(scored[0].employee.personnel_number || scored[0].employee.employeeNumber || ""),
    confidence: scored[0].score,
  };
}

function decimalNumber(value) {
  const normalized = String(value || "").replace(/\s/g, "").replace(",", ".").replace(/[Oo]/g, "0");
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) ? number : null;
}

function minutesFromDecimal(value) {
  const number = decimalNumber(value);
  return number === null ? null : Math.round(number * 60);
}

function normalizedClock(hour, minute) {
  const h = Number(hour);
  const m = Number(minute);
  return Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
    : "";
}

function intervalsFromText(value) {
  if (/nachtrag/i.test(value)) return [];
  const result = [];
  for (const match of String(value || "").matchAll(/(\d{1,2})[.:](\d{2})\s*[-]\s*(\d{1,2})[.:](\d{2})/g)) {
    const start = normalizedClock(match[1], match[2]);
    const end = normalizedClock(match[3], match[4]);
    if (start && end && end > start) result.push(`${start}-${end}`);
  }
  return [...new Set(result)];
}

function intervalMinutes(intervals = []) {
  return intervals.reduce((sum, interval) => {
    const match = String(interval).match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
    if (!match) return sum;
    return sum + (Number(match[3]) * 60 + Number(match[4])) - (Number(match[1]) * 60 + Number(match[2]));
  }, 0);
}

function summaryMetric(lines, label) {
  const expression = new RegExp(`${label}[^+\\-0-9]*([+\\-]?\\d+(?:[.,]\\d+)?)`, "i");
  for (const line of lines) {
    const match = cleanText(line.text).match(expression);
    if (match) return minutesFromDecimal(match[1]);
  }
  const labelExpression = new RegExp(label, "i");
  for (const labelLine of lines.filter((line) => labelExpression.test(cleanText(line.text)))) {
    const valueLine = lines
      .filter((line) => line !== labelLine && line.x > labelLine.x && Math.abs(line.y - labelLine.y) <= 8)
      .map((line) => ({ line, match: cleanText(line.text).match(/([+\-]?\d+(?:[.,]\d+)?)/) }))
      .filter((candidate) => candidate.match)
      .sort((left, right) => right.line.x - left.line.x)[0];
    if (valueLine) return minutesFromDecimal(valueLine.match[1]);
  }
  return null;
}

function detectedLocation(text) {
  const match = cleanText(text).match(/Abteilung\s*[:.]?\s*[[(]?\s*(?:Kst\.?\s*)?([0-9]{1,4})\s+([A-Za-z\u00c4\u00d6\u00dc\u00e4\u00f6\u00fc\u00df -]{2,50}?)(?=\s+MA\s*[:.]|$)/i);
  return match ? { locationCode: match[1], locationName: cleanText(match[2]) } : { locationCode: "", locationName: "" };
}

function detectedDayCenters(lines, pageWidth) {
  const summaryBoundary = pageWidth * 0.925;
  const clusters = [];
  for (const line of lines.filter((item) => /\bgesamt\s*[:.]?/i.test(item.text) && item.x > pageWidth * 0.07 && item.x < summaryBoundary)) {
    let cluster = clusters.find((candidate) => Math.abs(candidate.average - line.x) < pageWidth * 0.025);
    if (!cluster) {
      cluster = { values: [], average: line.x };
      clusters.push(cluster);
    }
    cluster.values.push(line.x);
    cluster.average = cluster.values.reduce((sum, value) => sum + value, 0) / cluster.values.length;
  }
  return clusters
    .filter((cluster) => cluster.values.length >= 2)
    .sort((left, right) => left.average - right.average)
    .slice(0, 7)
    .map((cluster) => cluster.average);
}

function parseXoffiRecognition({ text = "", blocks = [], width, height, headerDates = [], selectedWeekStart = "", employees = [] } = {}) {
  const pageWidth = Number(width);
  const pageHeight = Number(height);
  if (!Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth < 600 || pageHeight < 300) {
    throw new XoffiTimeImportError("XOFFI_IMAGE_LAYOUT_INVALID");
  }
  const lines = recognitionLines(blocks);
  const completeText = cleanText(`${text}\n${lines.map((line) => line.text).join("\n")}`);
  const week = resolveXoffiScreenshotWeek({ headerDates, selectedWeekStart });
  const summaryBoundary = pageWidth * 0.925;
  const dayCenters = detectedDayCenters(lines, pageWidth);
  if (dayCenters.length !== 7) throw new XoffiTimeImportError("XOFFI_DAY_COLUMNS_NOT_DETECTED");
  const leftBoundary = Math.max(pageWidth * 0.05, dayCenters[0] - (dayCenters[1] - dayCenters[0]) / 2);
  const nameLines = lines
    .filter((line) => line.box.x0 < leftBoundary && line.y > pageHeight * 0.07)
    .map((line) => ({ ...line, match: line.text.match(/^\s*\d+\s+(.{3,80})$/) }))
    .filter((line) => line.match && /[A-Za-zÄÖÜäöüß]/.test(line.match[1]));
  if (!nameLines.length) throw new XoffiTimeImportError("XOFFI_EMPLOYEES_NOT_DETECTED");

  const employeeRows = nameLines.map((line, index) => {
    const previousY = nameLines[index - 1]?.y;
    const nextY = nameLines[index + 1]?.y;
    const top = previousY === undefined ? Math.max(pageHeight * 0.07, line.y - (nextY - line.y) / 2) : (previousY + line.y) / 2;
    const bottom = nextY === undefined ? Math.min(pageHeight, line.y + (line.y - previousY) / 2) : (line.y + nextY) / 2;
    const rowLines = lines.filter((item) => item.y >= top && item.y < bottom);
    const days = Array.from({ length: 7 }, (_unused, dayIndex) => {
      const dayLines = rowLines.filter((item) => {
        if (item.x < leftBoundary || item.x >= summaryBoundary) return false;
        const nearestIndex = dayCenters.reduce((bestIndex, center, centerIndex) => (
          Math.abs(center - item.x) < Math.abs(dayCenters[bestIndex] - item.x) ? centerIndex : bestIndex
        ), 0);
        return nearestIndex === dayIndex;
      });
      const detectedIntervals = [...new Set(dayLines.flatMap((item) => intervalsFromText(item.text)))];
      const totalLine = dayLines.find((item) => /gesamt\s*[:.]?/i.test(item.text));
      const totalMatch = totalLine?.text.match(/gesamt\s*[:.]?\s*([0-9Oo]+(?:[.,][0-9]+)?)/i);
      const detectedValuedMinutes = totalMatch ? minutesFromDecimal(totalMatch[1]) : null;
      const sicknessDetected = dayLines.some((item) => /\bkrank\b/i.test(item.text));
      const vacationIgnored = dayLines.some((item) => /\burlaub\b/i.test(item.text))
        || (!sicknessDetected && detectedIntervals.length === 0 && Number(detectedValuedMinutes) > 0);
      const intervals = vacationIgnored ? [] : detectedIntervals;
      const actualMinutes = vacationIgnored ? 0 : intervalMinutes(intervals);
      const valuedMinutes = vacationIgnored ? 0 : (detectedValuedMinutes ?? actualMinutes);
      const absence = !vacationIgnored && sicknessDetected ? "sick" : "";
      return {
        workDate: addDays(week.weekStart, dayIndex),
        intervals,
        actualMinutes,
        valuedMinutes,
        surchargeMinutes: Math.max(0, valuedMinutes - actualMinutes),
        absence,
        vacationIgnored,
        confidence: dayLines.length ? Math.max(0, Math.min(100, Math.round(Math.min(...dayLines.map((item) => item.confidence))))) : 0,
      };
    });
    const summaryLines = rowLines.filter((item) => item.x >= summaryBoundary);
    const sourceName = cleanText(line.match[1]).replace(/\s+[.-]$/, "");
    const matched = matchEmployee(sourceName, employees);
    const summedActual = days.reduce((sum, day) => sum + day.actualMinutes, 0);
    const summedValued = days.reduce((sum, day) => sum + day.valuedMinutes, 0);
    return {
      sourceName,
      employeeNumber: matched.employeeNumber,
      matchConfidence: Math.round(matched.confidence * 100),
      weeklyActualMinutes: summaryMetric(summaryLines, "Anwesend") ?? summedActual,
      weeklyValuedMinutes: summaryMetric(summaryLines, "Stunden\\s+inklusive") ?? summedValued,
      weeklySurchargeMinutes: Math.max(
        0,
        (summaryMetric(summaryLines, "Stunden\\s+inklusive") ?? summedValued)
          - (summaryMetric(summaryLines, "Anwesend") ?? summedActual),
      ),
      closingBalanceMinutes: summaryMetric(summaryLines, "Mehrstunden"),
      days,
      warnings: [
        ...(matched.employeeNumber ? [] : ["Teammitglied muss zugeordnet werden."]),
        ...(summaryLines.length ? [] : ["Wochenwerte wurden nicht sicher erkannt."]),
        ...(days.some((day) => day.vacationIgnored) ? ["Urlaubstage und Urlaubsguthaben werden nicht importiert."] : []),
      ],
    };
  });
  const location = detectedLocation(completeText);
  return {
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
    weekResolution: week.resolution,
    ...location,
    engineVersion: XOFFI_OCR_ENGINE_VERSION,
    employees: employeeRows,
    warnings: employeeRows.some((row) => !row.employeeNumber)
      ? ["Mindestens ein Name muss vor dem Import zugeordnet werden."]
      : [],
  };
}

async function recognizeHeaderDates(worker, prepared, blocks) {
  try {
    const lines = recognitionLines(blocks);
    const dayCenters = detectedDayCenters(lines, prepared.info.width);
    if (dayCenters.length !== 7) return [];
    const totalLines = lines.filter((line) => (
      /\bgesamt\s*[:.]?/i.test(line.text)
      && line.x > prepared.info.width * 0.07
      && line.x < prepared.info.width * 0.925
    ));
    const firstTotalY = Math.min(...totalLines.map((line) => line.y));
    if (!Number.isFinite(firstTotalY)) return [];
    const gaps = dayCenters.slice(1).map((center, index) => center - dayCenters[index]).sort((left, right) => left - right);
    const middle = Math.floor(gaps.length / 2);
    const spacing = gaps.length % 2 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2;
    if (!Number.isFinite(spacing) || spacing < prepared.info.width * 0.05) return [];
    const cropTop = Math.max(0, Math.round(firstTotalY - prepared.info.height * 0.05));
    const cropHeight = Math.max(24, Math.round(prepared.info.height * 0.025));
    if (cropTop + cropHeight > prepared.info.height) return [];
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      tessedit_char_whitelist: "0123456789./",
      preserve_interword_spaces: "1",
    });
    const headerDates = [];
    for (let index = 0; index < dayCenters.length; index += 1) {
      const lastGap = dayCenters[6] - dayCenters[5];
      const leftValue = index === 6 && lastGap > spacing * 1.35
        ? dayCenters[5] + spacing / 2
        : dayCenters[index] - spacing / 2;
      const cropLeft = Math.max(0, Math.min(
        prepared.info.width - Math.round(spacing),
        Math.round(leftValue),
      ));
      const cropWidth = Math.min(Math.round(spacing), prepared.info.width - cropLeft);
      const crop = await sharp(prepared.data)
        .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
        .resize({ width: cropWidth * 3, height: cropHeight * 3, fit: "fill" })
        .threshold(170)
        .png({ compressionLevel: 6 })
        .toBuffer();
      const recognition = await withTimeout(
        worker.recognize(crop, { rotateAuto: false }, { text: true }),
        8_000,
      );
      const recognizedDates = datesFromText(recognition.data?.text || "");
      headerDates.push(recognizedDates.length === 1 ? recognizedDates[0] : "");
    }
    return headerDates;
  } catch {
    return [];
  }
}

async function withTimeout(promise, timeoutMs = XOFFI_OCR_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new XoffiTimeImportError("XOFFI_OCR_TIMEOUT", { timeoutMs })), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function serializedOcr(work) {
  if (queuedJobs >= XOFFI_OCR_MAX_QUEUED_JOBS) throw new XoffiTimeImportError("XOFFI_OCR_BUSY");
  queuedJobs += 1;
  const run = ocrQueue.then(work);
  ocrQueue = run.catch(() => {});
  try { return await run; } finally { queuedJobs -= 1; }
}

async function inspectXoffiImageBuffer(buffer, { fileName = "xoffi.png", selectedWeekStart = "", employees = [] } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32 || buffer.length > XOFFI_IMAGE_MAX_BYTES) {
    throw new XoffiTimeImportError("XOFFI_IMAGE_SIZE_INVALID", { maximumBytes: XOFFI_IMAGE_MAX_BYTES });
  }
  const sourceSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  let prepared;
  let metadata;
  try {
    const image = sharp(buffer, { failOn: "error", limitInputPixels: XOFFI_IMAGE_MAX_PIXELS, sequentialRead: true }).rotate().flatten({ background: "#ffffff" });
    metadata = await image.metadata();
    if (!["jpeg", "png", "webp"].includes(String(metadata.format || ""))) throw new Error("format");
    prepared = await image
      .resize({ width: 2600, height: 2600, fit: "inside", withoutEnlargement: false })
      .grayscale()
      .normalize()
      .sharpen()
      .png({ compressionLevel: 6 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new XoffiTimeImportError("XOFFI_IMAGE_INVALID");
  }
  const parsed = await serializedOcr(async () => {
    const worker = await createWorker(germanData.code, OEM.LSTM_ONLY, {
      langPath: path.resolve(germanData.langPath),
      gzip: germanData.gzip !== false,
      cacheMethod: "none",
      logger: () => {},
    });
    try {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: "1" });
      const recognition = await withTimeout(worker.recognize(prepared.data, { rotateAuto: false }, { text: true, blocks: true }));
      const headerDates = await recognizeHeaderDates(worker, prepared, recognition.data?.blocks || []);
      return parseXoffiRecognition({
        text: recognition.data?.text || "",
        blocks: recognition.data?.blocks || [],
        width: prepared.info.width,
        height: prepared.info.height,
        headerDates,
        selectedWeekStart,
        employees,
      });
    } finally {
      try { await worker.terminate(); } catch {}
    }
  });
  return {
    ...parsed,
    sourceSha256,
    sourceFileName: path.basename(String(fileName || "xoffi.png")).replace(/[^A-Za-z0-9ÄÖÜäöüß._ -]/g, "_").slice(0, 120),
    originalFormat: metadata.format,
  };
}

module.exports = {
  XOFFI_IMAGE_MAX_BYTES,
  XOFFI_OCR_ENGINE_VERSION,
  XoffiTimeImportError,
  indexedWeekFromHeaderDates,
  inspectXoffiImageBuffer,
  parseXoffiRecognition,
  resolveXoffiScreenshotWeek,
};
