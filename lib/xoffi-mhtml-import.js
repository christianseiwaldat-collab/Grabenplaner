"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { parseDocument } = require("htmlparser2");
const { XoffiTimeImportError, XOFFI_IMAGE_MAX_BYTES } = require("./xoffi-time-import");

const ENGINE = "xoffi-mhtml-v1";
const fail = (code) => { throw new XoffiTimeImportError(code); };
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const addDays = (value, count) => {
  const date = new Date(value + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};
function isoWeek(value) {
  const date = new Date(value + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  return Math.ceil((((date - Date.UTC(date.getUTCFullYear(), 0, 1, 12)) / 86400000) + 1) / 7);
}

// MHTML is a MIME archive. Read only embedded HTML; never follow locations,
// execute scripts, or retain the archive (which can contain session URLs).
function embeddedHtml(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32 || buffer.length > XOFFI_IMAGE_MAX_BYTES) fail("XOFFI_IMAGE_SIZE_INVALID");
  const html = [];
  let count = 0, decodedBytes = 0;
  function read(raw, depth = 0) {
    if (++count > 256 || depth > 5) fail("XOFFI_MHTML_INVALID");
    const split = /\r?\n\r?\n/.exec(raw);
    if (!split || split.index > 32768) fail("XOFFI_MHTML_INVALID");
    const headers = raw.slice(0, split.index).replace(/\r?\n[ \t]+/g, " ");
    const header = (name) => new RegExp("^" + name + ":\\s*(.*)$", "im").exec(headers)?.[1]?.trim() || "";
    const type = header("Content-Type");
    const body = raw.slice(split.index + split[0].length);
    if (/^multipart\//i.test(type)) {
      const boundary = /\bboundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(type);
      const value = boundary?.[1] || boundary?.[2];
      if (!value || value.length > 200) fail("XOFFI_MHTML_INVALID");
      const delimiters = [...body.matchAll(new RegExp("(?:^|\\r?\\n)--" + escape(value) + "(--)?[ \\t]*(?:\\r?\\n|$)", "g"))];
      if (delimiters.length < 2 || !delimiters.at(-1)[1]) fail("XOFFI_MHTML_INVALID");
      for (let index = 0; index < delimiters.length - 1; index++) {
        if (delimiters[index][1]) fail("XOFFI_MHTML_INVALID");
        read(body.slice(delimiters[index].index + delimiters[index][0].length, delimiters[index + 1].index), depth + 1);
      }
      return;
    }
    if (!/^text\/html(?:\s*;|$)/i.test(type)) return;
    const encoding = header("Content-Transfer-Encoding").toLowerCase();
    let data;
    if (encoding === "base64") {
      const value = body.replace(/\s/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail("XOFFI_MHTML_INVALID");
      data = Buffer.from(value, "base64");
    } else if (encoding === "quoted-printable") {
      if (/=(?![\da-f]{2}|\r?\n)/i.test(body)) fail("XOFFI_MHTML_INVALID");
      data = Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1");
    } else if (["", "7bit", "8bit", "binary"].includes(encoding)) data = Buffer.from(body, "latin1");
    else fail("XOFFI_MHTML_INVALID");
    decodedBytes += data.length;
    if (decodedBytes > 8 * 1024 * 1024) fail("XOFFI_MHTML_INVALID");
    const charset = /\bcharset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(type);
    try { html.push(new TextDecoder(charset?.[1] || charset?.[2] || "utf-8", { fatal: true }).decode(data)); }
    catch { fail("XOFFI_MHTML_ENCODING_INVALID"); }
  }
  read(buffer.toString("latin1"));
  if (!html.length) fail("XOFFI_MHTML_DATA_MISSING");
  return html;
}

function nodeText(node) {
  if (["script", "style", "iframe", "object", "noscript"].includes(node.name)) return "";
  if (node.type === "text") return node.data;
  const text = (node.children || []).map(nodeText).join("");
  return ["td", "th", "tr", "br", "div", "p", "table"].includes(node.name) ? "\n" + text + "\n" : text;
}
function lines(node) { return nodeText(node).split(/\n/).map(clean).filter(Boolean); }
function cells(node) { return (node.children || []).filter((child) => ["td", "th"].includes(child.name)); }
function number(value, { minimum = -10000, maximum = 10000 } = {}) {
  const text = clean(value).replace(",", ".");
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(text)) fail("XOFFI_MHTML_VALUES_INVALID");
  const result = Number(text);
  if (result < minimum || result > maximum) fail("XOFFI_MHTML_VALUES_INVALID");
  return result;
}
const minutes = (value, options) => Math.round(number(value, options) * 60);
function metric(values, label, required = true) {
  const index = values.findIndex((value) => label.test(value));
  if (index < 0 && !required) return null;
  if (index < 0 || index + 1 >= values.length) fail("XOFFI_MHTML_VALUES_INVALID");
  return values[index + 1];
}
function matchEmployee(sourceName, employees) {
  const normalized = (value) => clean(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/ß/g, "ss").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).sort().join(" ");
  const target = normalized(sourceName);
  const matches = employees.filter((employee) => normalized(employee.full_name || employee.fullName) === target);
  if (matches.length) return matches.length === 1 ? String(matches[0].personnel_number || matches[0].employeeNumber || "") : "";
  // Xoffi may include an additional given name. Only suggest a GP name when
  // all its words occur in the source and exactly one candidate qualifies.
  const words = new Set(target.split(" "));
  const suggestions = employees.filter((employee) => {
    const candidate = normalized(employee.full_name || employee.fullName).split(" ");
    return candidate.length >= 2 && candidate.every(word => words.has(word));
  });
  return suggestions.length === 1 ? String(suggestions[0].personnel_number || suggestions[0].employeeNumber || "") : "";
}

function parseDay(cell, workDate) {
  const values = lines(cell);
  const total = values.find((value) => /^Gesamt\s*:/i.test(value))?.replace(/^Gesamt\s*:\s*/i, "");
  if (total === undefined) fail("XOFFI_MHTML_VALUES_INVALID");
  const valuedMinutes = minutes(total, { minimum: 0, maximum: 48 });
  let section = "", surchargeHours = 0, sick = false, vacation = false;
  const intervals = [];
  for (const value of values) {
    if (/^Anwesend\b/i.test(value)) section = "present";
    else if (/^Krank\b/i.test(value)) { section = "sick"; sick = true; }
    else if (/^Urlaub\b/i.test(value)) { section = "vacation"; vacation = true; }
    else if (/^Zuschl(?:ä|a|�)ge$/i.test(value)) section = "surcharge";
    else if (/^Nachtrag\b/i.test(value)) section = "annotation";
    else if (/^Neuer Eintrag/i.test(value)) section = "";
    else if (section === "present" && /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(value)) {
      const clocks = value.split(/\s*-\s*/).map((clock) => clock.padStart(5, "0"));
      if (clocks.some((clock) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock)) || clocks[0] >= clocks[1]) fail("XOFFI_MHTML_VALUES_INVALID");
      intervals.push(clocks.join("-"));
    } else if (section === "surcharge") {
      const match = /^\(([\d.,]+)\s*St\.?\)$/i.exec(value);
      if (match) surchargeHours += number(match[1], { minimum: 0, maximum: 24 });
    }
  }
  intervals.sort();
  if (intervals.length > 12 || intervals.some((value, index) => index > 0 && value.slice(0, 5) < intervals[index - 1].slice(6))) fail("XOFFI_MHTML_VALUES_INVALID");
  const clockMinutes = (clock) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
  const actualMinutes = intervals.reduce((sum, value) => sum + clockMinutes(value.slice(6)) - clockMinutes(value.slice(0, 5)), 0);
  const surchargeMinutes = Math.round(surchargeHours * 60);
  if (actualMinutes > 1440 || surchargeMinutes > 1440 || actualMinutes + surchargeMinutes > valuedMinutes + 2) fail("XOFFI_MHTML_VALUES_INVALID");
  return { workDate, intervals, actualMinutes, valuedMinutes, surchargeMinutes,
    absence: sick ? "sick" : vacation ? "vacation" : "", confidence: 100 };
}

function parseEmployeeRow(row, employees) {
  const columns = cells(row), identity = lines(columns[0]);
  const sourceName = clean(identity.join(" ").split(/Eintritt\s*:|Wa\s*:|\bKW\s*\d/i)[0]).replace(/^\d+\s+/, "");
  const kw = /\bKW\s*(\d{1,2})\b/.exec(identity.join(" "));
  const summary = lines(columns[8]);
  const dateText = metric(summary, /^Vorgaben\s*\/\s*Stand\s*:/i);
  const date = /^\.?(\d{1,2})\.(\d{1,2})\.(20\d{2})$/.exec(dateText);
  if (!kw || !date || !sourceName || sourceName.length > 120) fail("XOFFI_MHTML_WEEK_INVALID");
  const balanceDate = `${date[3]}-${date[2].padStart(2, "0")}-${date[1].padStart(2, "0")}`;
  const parsed = new Date(balanceDate + "T12:00:00Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== balanceDate || parsed.getUTCDay() !== 0) fail("XOFFI_MHTML_WEEK_INVALID");
  const weekStart = addDays(balanceDate, 1);
  if (isoWeek(weekStart) !== Number(kw[1])) fail("XOFFI_MHTML_WEEK_INVALID");
  const split = summary.findIndex((value) => /^Wochenstunden$/i.test(value));
  if (split < 0) fail("XOFFI_MHTML_VALUES_INVALID");
  const opening = summary.slice(0, split), weekly = summary.slice(split + 1);
  const contract = /^(\d)\s*\/\s*([\d.,]+)$/.exec(metric(opening, /^Wo\.?\s*Tage\s*\/\s*Std$/i));
  if (!contract || Number(contract[1]) < 1 || Number(contract[1]) > 7) fail("XOFFI_MHTML_VALUES_INVALID");
  const days = columns.slice(1, 8).map((cell, index) => parseDay(cell, addDays(weekStart, index)));
  const weeklyValuedMinutes = minutes(metric(weekly, /^Stunden inklusive Zuschl(?:ä|a|�)ge$/i), { minimum: 0, maximum: 336 });
  const optionalMinutes = (label) => {
    const value = metric(weekly, label, false);
    return value === null ? 0 : minutes(value, { minimum: 0, maximum: 168 });
  };
  const weeklySurchargeMinutes = optionalMinutes(/^Zuschl(?:ä|a|�)ge$/i);
  const snapshot = {
    version: 1, kind: "mhtml", balanceDate,
    openingBalanceMinutes: minutes(metric(opening, /^Mehrstunden$/i)),
    remainingVacationDays: number(metric(opening, /^Rest Url\.?\s*\(Tage\)$/i)),
    workdaysPerWeek: Number(contract[1]), dailyTargetMinutes: minutes(contract[2], { minimum: 0, maximum: 24 }),
    weeklyBalanceDeltaMinutes: minutes(metric(weekly, /^Mehrstunden$/i)),
    weeklySickMinutes: optionalMinutes(/^Krank\s*\(Std\)$/i),
    weeklyVacationMinutes: optionalMinutes(/^Urlaub\s*\(Std\)$/i),
    sourceAttendanceMinutes: minutes(metric(weekly, /^Anwesend$/i), { minimum: 0, maximum: 168 }),
  };
  const sum = (key) => days.reduce((total, day) => total + day[key], 0);
  // Decimal hours in the source are rounded per day; allow at most one minute
  // per day between the seven rounded daily values and the rounded weekly sum.
  if (Math.abs(sum("valuedMinutes") - weeklyValuedMinutes) > 7 || Math.abs(sum("surchargeMinutes") - weeklySurchargeMinutes) > 7) fail("XOFFI_MHTML_VALUES_INVALID");
  const employeeNumber = matchEmployee(sourceName, employees);
  return { weekStart, sourceName, employeeNumber, matchConfidence: employeeNumber ? 100 : 0,
    weeklyActualMinutes: sum("actualMinutes"), weeklyValuedMinutes, weeklySurchargeMinutes,
    closingBalanceMinutes: null, snapshot, days,
    warnings: employeeNumber ? [] : ["Kein eindeutiger vollständiger Namensabgleich. Bitte Teammitglied zuordnen."] };
}

function inspectXoffiMhtmlBuffer(buffer, { fileName = "xoffi.mhtml", employees = [] } = {}) {
  const found = [];
  for (const html of embeddedHtml(buffer)) {
    const document = parseDocument(html);
    const stack = [{ node: document, depth: 0 }];
    let nodeCount = 0;
    while (stack.length) {
      const { node, depth } = stack.pop();
      if (++nodeCount > 200000 || depth > 120) fail("XOFFI_MHTML_INVALID");
      // Bound the tree before recursive text traversal below.
      for (const child of node.children || []) stack.push({ node: child, depth: depth + 1 });
    }
    const rows = [], queue = [document];
    while (queue.length) {
      const node = queue.pop();
      if (node.name === "tr" && cells(node).length === 9 && /\bKW\s*\d/.test(nodeText(cells(node)[0]))
        && /Vorgaben\s*\/\s*Stand/.test(nodeText(cells(node)[8]))) rows.push(node);
      queue.push(...(node.children || []));
    }
    if (rows.length) found.push(rows.reverse().map((row) => parseEmployeeRow(row, employees)));
  }
  if (found.length !== 1 || found[0].length > 250) fail("XOFFI_MHTML_DATA_MISSING");
  const rows = found[0], weekStart = rows[0].weekStart, weekEnd = addDays(weekStart, 6);
  if (rows.some((row) => row.weekStart !== weekStart)) fail("XOFFI_MHTML_WEEK_INVALID");
  const duplicateNames = new Set();
  for (const row of rows) {
    if (duplicateNames.has(row.sourceName)) fail("XOFFI_MHTML_VALUES_INVALID");
    duplicateNames.add(row.sourceName);
  }
  return { weekStart, weekEnd, sourceKind: "mhtml", engineVersion: ENGINE,
    weekResolution: { status: "matched", source: "mhtml_kw_snapshot", selectedWeekStart: weekStart,
      selectedWeekEnd: weekEnd, detectedWeekStart: weekStart, detectedWeekEnd: weekEnd,
      matchedDateColumns: 7, confirmationRequired: false },
    sourceSha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    sourceFileName: path.basename(String(fileName)).replace(/[^A-Za-z0-9ÄÖÜäöüß._ -]/g, "_").slice(0, 120),
    originalFormat: "mhtml", locationCode: "", locationName: "", employees: rows, warnings: [] };
}

module.exports = { inspectXoffiMhtmlBuffer, embeddedHtml, matchEmployee };
