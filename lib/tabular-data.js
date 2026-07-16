"use strict";

const crypto = require("node:crypto");
const ExcelJS = require("exceljs");

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ROWS = 5000;
const MAX_IMPORT_COLUMNS = 100;
const MAX_IMPORT_SHEETS = 20;
const MAX_CELL_CHARACTERS = 2000;
const MAX_XLSX_ARCHIVE_ENTRIES = 512;
const MAX_XLSX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_XLSX_ENTRY_BYTES = 32 * 1024 * 1024;

class TabularDataError extends Error {
  constructor(message, code = "TABULAR_DATA_INVALID", status = 400) {
    super(message);
    this.name = "TabularDataError";
    this.code = code;
    this.status = status;
  }
}

function cleanCellText(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, MAX_CELL_CHARACTERS);
}

function decodeCsvBuffer(buffer, requestedEncoding = "auto") {
  const allowed = new Set(["auto", "utf8", "windows1252"]);
  const encoding = allowed.has(String(requestedEncoding || "").toLowerCase())
    ? String(requestedEncoding || "").toLowerCase()
    : "auto";
  if (encoding === "utf8") {
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "utf8" };
    } catch {
      throw new TabularDataError("Die CSV-Datei ist nicht g\u00fcltig als UTF-8 codiert.", "CSV_ENCODING_INVALID");
    }
  }
  if (encoding === "windows1252") {
    return { text: new TextDecoder("windows-1252").decode(buffer), encoding: "windows1252" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "utf8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(buffer), encoding: "windows1252" };
  }
}

function delimiterScore(text, delimiter) {
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim()).slice(0, 20);
  const counts = lines.map((line) => {
    let quoted = false;
    let count = 0;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"') {
        if (quoted && line[index + 1] === '"') index += 1;
        else quoted = !quoted;
      } else if (!quoted && character === delimiter) count += 1;
    }
    return count;
  }).filter((count) => count > 0);
  if (!counts.length) return 0;
  const first = counts[0];
  const consistent = counts.filter((count) => count === first).length;
  return first * 100 + consistent;
}

function detectDelimiter(text, requestedDelimiter = "auto") {
  const aliases = { semicolon: ";", comma: ",", tab: "\t" };
  const requested = aliases[requestedDelimiter] || requestedDelimiter;
  if ([";", ",", "\t"].includes(requested)) return requested;
  const ranked = [";", ",", "\t"]
    .map((delimiter) => ({ delimiter, score: delimiterScore(text, delimiter) }))
    .sort((left, right) => right.score - left.score);
  if (!ranked[0].score) {
    throw new TabularDataError("In der CSV-Datei wurde keine Spaltentrennung erkannt.", "CSV_DELIMITER_NOT_FOUND");
  }
  return ranked[0].delimiter;
}

function parseCsvRows(text, delimiter, limits = {}) {
  const maxRows = limits.maxRows || MAX_IMPORT_ROWS + 1;
  const maxColumns = limits.maxColumns || MAX_IMPORT_COLUMNS;
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  const pushCell = () => {
    row.push({ text: cleanCellText(cell), formula: false, error: false });
    cell = "";
    if (row.length > maxColumns) {
      throw new TabularDataError(`Importdateien d\u00fcrfen h\u00f6chstens ${maxColumns} Spalten enthalten.`, "IMPORT_COLUMN_LIMIT");
    }
  };
  const pushRow = () => {
    pushCell();
    if (row.some((entry) => entry.text !== "")) rows.push(row);
    row = [];
    if (rows.length > maxRows) {
      throw new TabularDataError(`Importdateien d\u00fcrfen h\u00f6chstens ${maxRows - 1} Datenzeilen enthalten.`, "IMPORT_ROW_LIMIT", 413);
    }
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"' && cell === "") quoted = true;
    else if (character === delimiter) pushCell();
    else if (character === "\n") pushRow();
    else if (character !== "\r") cell += character;
  }
  if (quoted) throw new TabularDataError("Die CSV-Datei enth\u00e4lt ein nicht geschlossenes Anf\u00fchrungszeichen.", "CSV_QUOTE_INVALID");
  if (cell !== "" || row.length) pushRow();
  return rows;
}

function formatFromInput(buffer, fileName = "", contentType = "") {
  const lowerName = String(fileName || "").toLowerCase();
  const lowerType = String(contentType || "").toLowerCase();
  if (lowerName.endsWith(".xlsx") || lowerType.includes("spreadsheetml")) return "xlsx";
  if (/\.(xls|xlsm|xlsb)$/i.test(lowerName)) {
    throw new TabularDataError("Bitte eine XLSX-Datei verwenden. XLS, XLSM und XLSB werden aus Sicherheitsgr\u00fcnden nicht verarbeitet.", "EXCEL_FORMAT_UNSUPPORTED");
  }
  if (lowerName.endsWith(".csv") || lowerName.endsWith(".tsv") || lowerType.includes("csv") || lowerType.includes("tab-separated")) return "csv";
  if (buffer?.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) return "xlsx";
  return "csv";
}

function recommendedHeaderRow(rows) {
  let best = { rowNumber: 1, score: -1 };
  rows.slice(0, 20).forEach((row, index) => {
    const values = row.map((cell) => cell.text).filter(Boolean);
    const unique = new Set(values.map((value) => value.toLocaleLowerCase("de-AT")));
    const score = values.length * 2 + unique.size - row.filter((cell) => /^[-+]?\d+(?:[.,]\d+)?$/.test(cell.text)).length;
    if (score > best.score) best = { rowNumber: index + 1, score };
  });
  return best.rowNumber;
}

function sheetClientSummary(sheet) {
  const headerRow = recommendedHeaderRow(sheet.rows);
  const headers = (sheet.rows[headerRow - 1] || []).map((cell, columnIndex) => ({
    columnIndex,
    label: cell.text || `Spalte ${columnIndex + 1}`,
  }));
  return {
    name: sheet.name,
    rowCount: Math.max(0, sheet.rows.length - headerRow),
    columnCount: Math.max(0, ...sheet.rows.map((row) => row.length)),
    suggestedHeaderRow: headerRow,
    headers,
    topRows: sheet.rows.slice(0, 20).map((row) => row.map((cell) => cell.text)),
    sampleRows: sheet.rows.slice(headerRow, headerRow + 8).map((row) => row.map((cell) => cell.text)),
    formulaCellCount: sheet.rows.reduce((sum, row) => sum + row.filter((cell) => cell.formula).length, 0),
    errorCellCount: sheet.rows.reduce((sum, row) => sum + row.filter((cell) => cell.error).length, 0),
  };
}

function validateXlsxArchive(buffer) {
  const minimumEocdOffset = Math.max(0, buffer.length - 65_557);
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocdOffset = offset; break; }
  }
  if (eocdOffset < 0) throw new TabularDataError("Die XLSX-Datei besitzt kein gültiges ZIP-Verzeichnis.", "XLSX_ARCHIVE_INVALID");
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const directorySize = buffer.readUInt32LE(eocdOffset + 12);
  const directoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new TabularDataError("ZIP64-XLSX-Dateien werden für den Personalimport nicht unterstützt.", "XLSX_ARCHIVE_UNSUPPORTED");
  }
  if (!entryCount || entryCount > MAX_XLSX_ARCHIVE_ENTRIES || directoryOffset + directorySize > buffer.length) {
    throw new TabularDataError("Die XLSX-Datei überschreitet die zulässige Archivstruktur.", "XLSX_ARCHIVE_LIMIT", 413);
  }
  let cursor = directoryOffset;
  let uncompressedTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new TabularDataError("Das ZIP-Verzeichnis der XLSX-Datei ist beschädigt.", "XLSX_ARCHIVE_INVALID");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const next = cursor + 46 + fileNameLength + extraLength + commentLength;
    if (next > buffer.length || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || (flags & 0x0001)) {
      throw new TabularDataError("Die XLSX-Datei verwendet eine nicht unterstützte oder verschlüsselte Archivstruktur.", "XLSX_ARCHIVE_UNSUPPORTED");
    }
    const fileName = buffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString("utf8").replaceAll("\\", "/");
    if (fileName.startsWith("/") || fileName.split("/").includes("..")) {
      throw new TabularDataError("Die XLSX-Datei enthält einen unsicheren Archivpfad.", "XLSX_ARCHIVE_PATH_INVALID");
    }
    uncompressedTotal += uncompressedSize;
    if (uncompressedSize > MAX_XLSX_ENTRY_BYTES || uncompressedTotal > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new TabularDataError("Die entpackten XLSX-Daten sind für einen sicheren Import zu groß.", "XLSX_UNCOMPRESSED_LIMIT", 413);
    }
    cursor = next;
  }
  if (cursor > directoryOffset + directorySize) {
    throw new TabularDataError("Das ZIP-Verzeichnis der XLSX-Datei ist widersprüchlich.", "XLSX_ARCHIVE_INVALID");
  }
  return { entryCount, uncompressedTotal };
}

async function parseXlsxBuffer(buffer) {
  validateXlsxArchive(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer, {
      ignoreNodes: ["dataValidations", "extLst", "hyperlinks", "drawing", "picture", "oleObject", "webPublishItems"],
    });
  } catch {
    throw new TabularDataError("Die XLSX-Datei konnte nicht sicher gelesen werden.", "XLSX_INVALID");
  }
  if (!workbook.worksheets.length) throw new TabularDataError("Die XLSX-Datei enth\u00e4lt kein Tabellenblatt.", "XLSX_EMPTY");
  if (workbook.worksheets.length > MAX_IMPORT_SHEETS) {
    throw new TabularDataError(`XLSX-Dateien d\u00fcrfen h\u00f6chstens ${MAX_IMPORT_SHEETS} Tabellenbl\u00e4tter enthalten.`, "IMPORT_SHEET_LIMIT", 413);
  }
  const sheets = workbook.worksheets.map((worksheet) => {
    if (worksheet.actualColumnCount > MAX_IMPORT_COLUMNS || worksheet.columnCount > MAX_IMPORT_COLUMNS) {
      throw new TabularDataError(`Importdateien d\u00fcrfen h\u00f6chstens ${MAX_IMPORT_COLUMNS} Spalten enthalten.`, "IMPORT_COLUMN_LIMIT", 413);
    }
    if (worksheet.actualRowCount > MAX_IMPORT_ROWS + 1 || worksheet.rowCount > MAX_IMPORT_ROWS + 1) {
      throw new TabularDataError(`Importdateien d\u00fcrfen h\u00f6chstens ${MAX_IMPORT_ROWS} Datenzeilen enthalten.`, "IMPORT_ROW_LIMIT", 413);
    }
    const rows = [];
    const finalRow = Math.min(worksheet.rowCount, MAX_IMPORT_ROWS + 1);
    const finalColumn = Math.min(Math.max(worksheet.columnCount, worksheet.actualColumnCount), MAX_IMPORT_COLUMNS);
    for (let rowNumber = 1; rowNumber <= finalRow; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const values = [];
      for (let columnNumber = 1; columnNumber <= finalColumn; columnNumber += 1) {
        const cell = row.getCell(columnNumber);
        const value = cell.value;
        const formula = Boolean(value && typeof value === "object" && ("formula" in value || "sharedFormula" in value));
        const error = Boolean(value && typeof value === "object" && "error" in value);
        values.push({ text: cleanCellText(cell.text), formula, error });
      }
      while (values.length && !values.at(-1).text && !values.at(-1).formula && !values.at(-1).error) values.pop();
      if (values.some((entry) => entry.text || entry.formula || entry.error)) rows.push(values);
    }
    return { name: cleanCellText(worksheet.name).slice(0, 80) || "Tabelle", rows };
  });
  return { format: "xlsx", encoding: null, delimiter: null, sheets };
}

async function inspectTabularBuffer(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new TabularDataError("Bitte eine CSV- oder XLSX-Datei ausw\u00e4hlen.", "IMPORT_FILE_REQUIRED");
  if (buffer.length > MAX_IMPORT_BYTES) {
    throw new TabularDataError("Die Importdatei darf h\u00f6chstens 5 MB gro\u00df sein.", "IMPORT_FILE_LIMIT", 413);
  }
  const format = formatFromInput(buffer, options.fileName, options.contentType);
  let parsed;
  if (format === "xlsx") parsed = await parseXlsxBuffer(buffer);
  else {
    const decoded = decodeCsvBuffer(buffer, options.encoding);
    const delimiter = detectDelimiter(decoded.text, options.delimiter || (String(options.fileName || "").toLowerCase().endsWith(".tsv") ? "\t" : "auto"));
    parsed = {
      format: "csv",
      encoding: decoded.encoding,
      delimiter,
      sheets: [{ name: "CSV", rows: parseCsvRows(decoded.text, delimiter) }],
    };
  }
  if (!parsed.sheets.some((sheet) => sheet.rows.length)) throw new TabularDataError("Die Importdatei enth\u00e4lt keine Daten.", "IMPORT_FILE_EMPTY");
  return {
    ...parsed,
    byteSize: buffer.length,
    contentSha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    summaries: parsed.sheets.map(sheetClientSummary),
  };
}

function headerFingerprint(cells) {
  const normalized = (cells || []).map((cell, index) => `${index}:${cleanCellText(cell?.text ?? cell).toLocaleLowerCase("de-AT")}`);
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function spreadsheetSafeText(value) {
  const text = String(value ?? "");
  return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvValue(value, type = "text", delimiter = ";") {
  let text = value === null || value === undefined ? "" : String(value);
  if (type === "text" || type === "identifier") text = spreadsheetSafeText(text);
  if (/["\r\n]/.test(text) || text.includes(delimiter)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

function createCsvBuffer(columns, rows, options = {}) {
  const delimiter = [";", ",", "\t"].includes(options.delimiter) ? options.delimiter : ";";
  const lines = [];
  if (options.notice) lines.push(`# ${String(options.notice).replace(/[\r\n]+/g, " ")}`);
  lines.push(columns.map((column) => csvValue(column.label, "text", delimiter)).join(delimiter));
  for (const row of rows) {
    lines.push(columns.map((column) => csvValue(row[column.id], column.type, delimiter)).join(delimiter));
  }
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

async function createXlsxBuffer(columns, rows, options = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Grabenplaner";
  workbook.created = new Date();
  if (options.notice) {
    const noticeSheet = workbook.addWorksheet("ENTWURF-HINWEIS");
    noticeSheet.getCell("A1").value = "ENTWURF – NICHT FÜR DIE ENDGÜLTIGE LOHNVERRECHNUNG";
    noticeSheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFB42318" } };
    noticeSheet.getCell("A3").value = String(options.notice);
    noticeSheet.getColumn(1).width = 72;
    noticeSheet.getRow(3).alignment = { wrapText: true, vertical: "top" };
  }
  const worksheet = workbook.addWorksheet(String(options.sheetName || "Export").slice(0, 31));
  worksheet.columns = columns.map((column) => ({
    key: column.id,
    header: column.label,
    width: Math.min(42, Math.max(12, Number(column.width || column.label.length + 3))),
    style: column.type === "identifier" ? { numFmt: "@" } : undefined,
  }));
  const header = worksheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D5A4D" } };
  header.alignment = { vertical: "middle" };
  header.height = 24;
  for (const source of rows) {
    const row = {};
    for (const column of columns) {
      const value = source[column.id];
      if (column.type === "number" && value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value))) row[column.id] = Number(value);
      else row[column.id] = spreadsheetSafeText(value ?? "");
    }
    worksheet.addRow(row);
  }
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, columns.length) } };
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1 && rowNumber % 2 === 0) {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F7F5" } };
    }
    row.alignment = { vertical: "top", wrapText: true };
  });
  const output = await workbook.xlsx.writeBuffer();
  return Buffer.from(output);
}

module.exports = {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_SHEETS,
  TabularDataError,
  cleanCellText,
  decodeCsvBuffer,
  detectDelimiter,
  parseCsvRows,
  validateXlsxArchive,
  inspectTabularBuffer,
  headerFingerprint,
  spreadsheetSafeText,
  createCsvBuffer,
  createXlsxBuffer,
};
