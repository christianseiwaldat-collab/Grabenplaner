"use strict";

function isoDayNumber(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value || ""));
  if (!match) return null;
  const date = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(date) ? Math.floor(date / 86400000) : null;
}

function optionSignature(option) {
  return JSON.stringify([
    String(option.option_type || ""),
    Number(option.all_day ?? 1) === 1,
    String(option.start_time || ""),
    String(option.end_time || ""),
    String(option.note || ""),
    String(option.pdf_time_kind || ""),
    String(option.pdf_destination_label || ""),
    String(option.pdf_duty_code || ""),
  ]);
}

function underlyingOptionKey(option, index) {
  const stableId = option.id ?? option.group_id;
  return stableId === null || stableId === undefined || String(stableId) === ""
    ? `isolated:${index}` : `stored:${String(stableId)}`;
}

function buildScheduleMatrixOptionSpans({ options = [], employeeNumber, weekStart, dayCount = 6 } = {}) {
  const weekDay = isoDayNumber(weekStart);
  if (weekDay === null || !Number.isInteger(dayCount) || dayCount < 1 || dayCount > 7) return [];
  const grouped = new Map();
  options.forEach((option, index) => {
    if (!option || String(option.employee_number || "") !== String(employeeNumber || "")
      || option.option_type === "team_meeting") return;
    const from = isoDayNumber(option.date_from);
    const to = isoDayNumber(option.date_to);
    if (from === null || to === null || to < from) return;
    const startDay = Math.max(0, from - weekDay);
    const endDay = Math.min(dayCount - 1, to - weekDay);
    if (endDay - startDay < 1) return;
    const key = `${underlyingOptionKey(option, index)}|${optionSignature(option)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ startDay, endDay, option });
  });

  const spans = [];
  for (const segments of grouped.values()) {
    segments.sort((left, right) => left.startDay - right.startDay || left.endDay - right.endDay);
    for (const segment of segments) {
      const previous = spans.at(-1);
      if (previous && previous.key === segments && segment.startDay <= previous.endDay + 1) {
        previous.endDay = Math.max(previous.endDay, segment.endDay);
        previous.options.push(segment.option);
      } else {
        spans.push({ key: segments, startDay: segment.startDay, endDay: segment.endDay,
          option: segment.option, options: [segment.option], lane: 0 });
      }
    }
  }
  spans.sort((left, right) => left.startDay - right.startDay || left.endDay - right.endDay);
  const laneEnds = [];
  for (const span of spans) {
    let lane = laneEnds.findIndex(endDay => endDay < span.startDay);
    if (lane < 0) lane = laneEnds.length;
    span.lane = lane;
    laneEnds[lane] = span.endDay;
    delete span.key;
  }
  return spans;
}

function buildScheduleMatrixSicknessSegments({ credits = [], options = [], employeeNumbers = [], weekStart, weekEnd } = {}) {
  const startDay = isoDayNumber(weekStart);
  const endDay = isoDayNumber(weekEnd);
  if (startDay === null || endDay === null || endDay < startDay) return [];
  const visibleEmployees = new Set(employeeNumbers.map((value) => String(value || "")));
  const coveredDates = new Set();
  for (const option of options) {
    if (!option || option.option_type !== "sick") continue;
    const employeeNumber = String(option.employee_number || "");
    const from = isoDayNumber(option.date_from);
    const to = isoDayNumber(option.date_to);
    if (!visibleEmployees.has(employeeNumber) || from === null || to === null) continue;
    for (let day = Math.max(startDay, from); day <= Math.min(endDay, to); day += 1) {
      coveredDates.add(`${employeeNumber}|${day}`);
    }
  }

  const groups = new Map();
  for (const credit of credits) {
    const employeeNumber = String(credit?.employee_number || "");
    const caseId = String(credit?.caseId ?? credit?.case_id ?? "").trim();
    const day = isoDayNumber(credit?.date);
    if (!visibleEmployees.has(employeeNumber) || !caseId || day === null
      || day < startDay || day > endDay || coveredDates.has(`${employeeNumber}|${day}`)) continue;
    const key = `${employeeNumber}|${caseId}`;
    if (!groups.has(key)) groups.set(key, { employeeNumber, caseId, days: new Set() });
    groups.get(key).days.add(day);
  }

  const segments = [];
  for (const group of groups.values()) {
    const days = [...group.days].sort((left, right) => left - right);
    let segmentStart = null;
    let segmentEnd = null;
    for (const day of days) {
      if (segmentStart === null || day !== segmentEnd + 1) {
        if (segmentStart !== null) segments.push({ ...group, startDay: segmentStart, endDay: segmentEnd });
        segmentStart = day;
      }
      segmentEnd = day;
    }
    if (segmentStart !== null) segments.push({ ...group, startDay: segmentStart, endDay: segmentEnd });
  }
  return segments.sort((left, right) => left.startDay - right.startDay
    || left.employeeNumber.localeCompare(right.employeeNumber)
    || left.caseId.localeCompare(right.caseId));
}

function splitLongToken(token, widthOf, maxWidth) {
  const parts = [];
  let part = "";
  for (const character of token) {
    if (part && widthOf(part + character) > maxWidth) {
      parts.push(part);
      part = character;
    } else part += character;
  }
  if (part) parts.push(part);
  return parts;
}

function wrapScheduleMatrixNote(text, widthOf, maxWidth) {
  if (typeof widthOf !== "function" || !Number.isFinite(maxWidth) || maxWidth <= 0) return [];
  const lines = [];
  const paragraphs = String(text || "").replace(/\r\n?/gu, "\n").split("\n");
  paragraphs.forEach((paragraph, paragraphIndex) => {
    if (paragraphIndex > 0 && lines.length && lines.at(-1) !== "") lines.push("");
    const tokens = paragraph.trim().split(/\s+/u).filter(Boolean)
      .flatMap(token => widthOf(token) > maxWidth ? splitLongToken(token, widthOf, maxWidth) : [token]);
    let line = "";
    for (const token of tokens) {
      const candidate = line ? `${line} ${token}` : token;
      if (line && widthOf(candidate) > maxWidth) {
        lines.push(line);
        line = token;
      } else line = candidate;
    }
    if (line) lines.push(line);
  });
  return lines;
}

function paginateScheduleMatrixNote(lines, { columns = 3, linesPerColumn = 6 } = {}) {
  const safeColumns = Math.max(1, Math.floor(columns));
  const safeLines = Math.max(1, Math.floor(linesPerColumn));
  const source = Array.isArray(lines) ? lines : [];
  const paragraphs = [];
  let paragraph = [];
  for (const line of source) {
    if (line === "") {
      if (paragraph.length) paragraphs.push(paragraph);
      paragraph = [];
    } else paragraph.push(line);
  }
  if (paragraph.length) paragraphs.push(paragraph);
  const pages = [];
  let page = Array.from({ length: safeColumns }, () => []);
  let column = 0;
  const publishPage = () => {
    pages.push(page);
    page = Array.from({ length: safeColumns }, () => []);
    column = 0;
  };
  const nextColumn = () => {
    column += 1;
    if (column >= safeColumns) publishPage();
  };
  for (const completeParagraph of paragraphs) {
    let remaining = [...completeParagraph];
    while (remaining.length) {
      const target = page[column];
      const separator = target.length ? 1 : 0;
      const available = safeLines - target.length - separator;
      if (remaining.length <= available) {
        if (separator) target.push("");
        target.push(...remaining);
        remaining = [];
      } else if (target.length) {
        if (target.length < safeLines) target.push("");
        nextColumn();
      } else {
        target.push(...remaining.splice(0, safeLines));
        if (remaining.length) nextColumn();
      }
    }
  }
  if (page.some((columnLines) => columnLines.length) || !pages.length) pages.push(page);
  return pages.length ? pages : [Array.from({ length: safeColumns }, () => [])];
}

module.exports = {
  buildScheduleMatrixOptionSpans,
  buildScheduleMatrixSicknessSegments,
  paginateScheduleMatrixNote,
  wrapScheduleMatrixNote,
};
