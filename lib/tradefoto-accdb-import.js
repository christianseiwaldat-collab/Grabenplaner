"use strict";

const { createHash } = require("node:crypto");
const path = require("node:path");
const { deserialize } = require("node:v8");
const { Worker } = require("node:worker_threads");

const {
  TRADEFOTO_ARTICLE_IMPORT_MAX_ROWS,
  TRADEFOTO_ARTICLE_IMPORT_MAX_WORK_UNITS,
  TRADEFOTO_ARTICLE_IMPORT_WORK_UNITS_PER_ROW,
  TradeFotoArticleImportError,
  inspectTradeFotoArticleImportPayload,
} = require("./tradefoto-article-import");
const {
  TRADEFOTO_ARTICLE_ALIAS_ROW_FIELDS,
  TRADEFOTO_ARTICLE_IMPORT_FORMAT,
  TRADEFOTO_ARTICLE_ROW_FIELDS,
  TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION,
  TRADEFOTO_ARTICLE_SOURCE_SCHEMA_SHA256,
  TRADEFOTO_ARTICLE_SOURCE_SYSTEM,
  TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS,
  TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS,
} = require("./tradefoto-article-source-profile");

const TRADEFOTO_ACCDB_IMPORT_MIME_TYPE = "application/vnd.grabenplaner.tradefoto-articles+accdb";
const TRADEFOTO_ACCDB_IMPORT_MAX_BYTES = 256 * 1024 * 1024;
const TRADEFOTO_ACCDB_IMPORT_MIN_BYTES = 4096;
const TRADEFOTO_ACCDB_PASSWORD_MAX_BYTES = 256;
const TRADEFOTO_ACCDB_WORKER_TIMEOUT_MS = 180_000;
const TRADEFOTO_ACCDB_ARTICLE_TABLE = "ARTIKEL_STAMM";
const TRADEFOTO_ACCDB_ALIAS_TABLE = "ARTIKEL_ZWEITEAN";
const TRADEFOTO_ACCDB_UPDATED_AT_FIELD = "Änderungsdatum";
const TRADEFOTO_ACCDB_ENGINE_SIGNATURE = "Standard ACE DB";
const TRADEFOTO_ACCDB_SUPPORTED_VERSION_BYTES = new Set([0x02, 0x03, 0x04, 0x05, 0x06]);
const TRADEFOTO_ACCDB_DECIMAL_FIELDS = Object.freeze([
  ...TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.map(({ sourceField }) => sourceField),
  ...TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS.map(({ sourceField }) => sourceField),
]);

class TradeFotoAccdbImportError extends TradeFotoArticleImportError {
  constructor(message, code = "SALES_ARTICLE_ACCDB_PASSWORD_OR_FILE_INVALID", status = 422) {
    super(message, code, status);
    this.name = "TradeFotoAccdbImportError";
  }
}

function accdbError(message, code, status = 422) {
  return new TradeFotoAccdbImportError(message, code, status);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizedTradeFotoAccdbFilename(value) {
  const leaf = String(value || "Trade_Daten.accdb")
    .split(/[\\/]/u)
    .pop()
    .trim();
  if (!leaf || leaf.length > 160 || /[\u0000-\u001f\u007f]/u.test(leaf)
    || !/\.accdb$/iu.test(leaf)) {
    throw accdbError(
      "Bitte eine gültige TradeFoto-ACCDB-Datei auswählen.",
      "SALES_ARTICLE_ACCDB_FILENAME_INVALID",
      400,
    );
  }
  return leaf;
}

function normalizeTradeFotoAccdbPassword(value) {
  if (typeof value !== "string" || !value.length) {
    throw accdbError(
      "Für die verschlüsselte TradeFoto-Datenbank ist das Datenbank-Passwort erforderlich.",
      "SALES_ARTICLE_ACCDB_PASSWORD_REQUIRED",
      400,
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > TRADEFOTO_ACCDB_PASSWORD_MAX_BYTES) {
    throw accdbError(
      "Das TradeFoto-Datenbank-Passwort hat ein ungültiges Format.",
      "SALES_ARTICLE_ACCDB_PASSWORD_INVALID",
      400,
    );
  }
  return value;
}

function assertTradeFotoAccdbBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)
    || buffer.length < TRADEFOTO_ACCDB_IMPORT_MIN_BYTES
    || buffer.length > TRADEFOTO_ACCDB_IMPORT_MAX_BYTES) {
    throw accdbError(
      "Die TradeFoto-Datenbank ist leer, unvollständig oder größer als 256 MiB.",
      "SALES_ARTICLE_ACCDB_FILE_SIZE_INVALID",
      413,
    );
  }
  const engine = buffer.subarray(4, 4 + TRADEFOTO_ACCDB_ENGINE_SIGNATURE.length)
    .toString("ascii");
  if (buffer[0] !== 0
    || engine !== TRADEFOTO_ACCDB_ENGINE_SIGNATURE
    || !TRADEFOTO_ACCDB_SUPPORTED_VERSION_BYTES.has(buffer[0x14])) {
    throw accdbError(
      "Die Datei ist keine unterstützte TradeFoto-ACCDB-Datenbank.",
      "SALES_ARTICLE_ACCDB_PASSWORD_OR_FILE_INVALID",
    );
  }
}

function accdbDecimalText(value, fieldName) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) >= 1e18) {
    throw accdbError(
      `Das TradeFoto-Feld ${fieldName} enthält keinen sicher lesbaren Dezimalwert.`,
      "SALES_ARTICLE_ACCDB_ROW_INVALID",
    );
  }
  if (Object.is(value, -0) || value === 0) return "0";
  const direct = String(value);
  if (!/[eE]/u.test(direct)) {
    const fraction = direct.split(".")[1] || "";
    if (fraction.length <= 12) return direct;
  }
  const rounded = value.toFixed(12).replace(/(?:\.0+|(?<=[0-9])0+)$/u, "").replace(/\.$/u, "");
  if (!/^-?\d+(?:\.\d{1,12})?$/u.test(rounded)) {
    throw accdbError(
      `Das TradeFoto-Feld ${fieldName} überschreitet die sichere Dezimaldarstellung.`,
      "SALES_ARTICLE_ACCDB_ROW_INVALID",
    );
  }
  return rounded;
}

function columnByName(table, fieldName) {
  return table.getColumns().find(({ name }) => name === fieldName) || null;
}

function assertAccdbColumn(table, fieldName, expectedType, expectedTextLengths = []) {
  const column = columnByName(table, fieldName);
  const allowedSizes = expectedTextLengths.flatMap((length) => [length, length * 2]);
  if (!column || column.type !== expectedType
    || (allowedSizes.length && !allowedSizes.includes(column.size))) {
    throw accdbError(
      `Das Feld ${table.name}.${fieldName} fehlt oder weicht vom freigegebenen Quellschema ab.`,
      "SALES_ARTICLE_ACCDB_SCHEMA_MISMATCH",
    );
  }
}

function assertTradeFotoAccdbSchema(reader) {
  const tableNames = reader.getTableNames();
  if (!Array.isArray(tableNames)
    || !tableNames.includes(TRADEFOTO_ACCDB_ARTICLE_TABLE)
    || !tableNames.includes(TRADEFOTO_ACCDB_ALIAS_TABLE)) {
    throw accdbError(
      "Die benötigten TradeFoto-Artikeltabellen fehlen.",
      "SALES_ARTICLE_ACCDB_SCHEMA_MISMATCH",
    );
  }
  const articleTable = reader.getTable(TRADEFOTO_ACCDB_ARTICLE_TABLE);
  const aliasTable = reader.getTable(TRADEFOTO_ACCDB_ALIAS_TABLE);
  assertAccdbColumn(articleTable, "EAN", "text", [13]);
  assertAccdbColumn(articleTable, "Artikelbezeichnung", "text", [50]);
  assertAccdbColumn(articleTable, "MWST", "byte");
  assertAccdbColumn(articleTable, TRADEFOTO_ACCDB_UPDATED_AT_FIELD, "datetime");
  for (const fieldName of TRADEFOTO_ACCDB_DECIMAL_FIELDS) {
    assertAccdbColumn(articleTable, fieldName, "double");
  }
  assertAccdbColumn(aliasTable, "EAN", "text", [13]);
  assertAccdbColumn(aliasTable, "ZweitEAN", "text", [13]);
  assertAccdbColumn(aliasTable, "Rang", "byte");
  return { articleTable, aliasTable };
}

function safeTableRowCount(table, maximum, code) {
  const count = Number(table?.rowCount);
  if (!Number.isSafeInteger(count) || count < 0 || count > maximum) {
    throw accdbError(
      "Die TradeFoto-Datenbank überschreitet die freigegebenen Importgrenzen.",
      code,
      413,
    );
  }
  return count;
}

function readTradeFotoAccdbRows(articleTable, aliasTable) {
  const declaredArticleCount = safeTableRowCount(
    articleTable,
    TRADEFOTO_ARTICLE_IMPORT_MAX_ROWS,
    "SALES_ARTICLE_IMPORT_ROW_LIMIT",
  );
  if (declaredArticleCount < 1) {
    throw accdbError(
      "Die TradeFoto-Datenbank enthält keine Artikel.",
      "SALES_ARTICLE_IMPORT_ROW_LIMIT",
    );
  }
  const remainingAliasBudget = TRADEFOTO_ARTICLE_IMPORT_MAX_WORK_UNITS
    - (declaredArticleCount * TRADEFOTO_ARTICLE_IMPORT_WORK_UNITS_PER_ROW);
  if (remainingAliasBudget < 0) {
    throw accdbError(
      "Die TradeFoto-Datenbank überschreitet das sichere Arbeitsbudget.",
      "SALES_ARTICLE_IMPORT_WORK_BUDGET_EXCEEDED",
      413,
    );
  }
  safeTableRowCount(
    aliasTable,
    remainingAliasBudget,
    "SALES_ARTICLE_IMPORT_WORK_BUDGET_EXCEEDED",
  );
  const articleRows = articleTable.getData({
    columns: [...TRADEFOTO_ARTICLE_ROW_FIELDS, TRADEFOTO_ACCDB_UPDATED_AT_FIELD],
    rowLimit: TRADEFOTO_ARTICLE_IMPORT_MAX_ROWS + 1,
  });
  if (!Array.isArray(articleRows)
    || articleRows.length < 1
    || articleRows.length > TRADEFOTO_ARTICLE_IMPORT_MAX_ROWS) {
    throw accdbError(
      "Die TradeFoto-Datenbank enthält eine ungültige Anzahl Artikel.",
      "SALES_ARTICLE_IMPORT_ROW_LIMIT",
      articleRows?.length > TRADEFOTO_ARTICLE_IMPORT_MAX_ROWS ? 413 : 422,
    );
  }
  const actualAliasBudget = TRADEFOTO_ARTICLE_IMPORT_MAX_WORK_UNITS
    - (articleRows.length * TRADEFOTO_ARTICLE_IMPORT_WORK_UNITS_PER_ROW);
  const aliasRows = aliasTable.getData({
    columns: TRADEFOTO_ARTICLE_ALIAS_ROW_FIELDS,
    rowLimit: actualAliasBudget + 1,
  });
  if (!Array.isArray(aliasRows) || aliasRows.length > actualAliasBudget) {
    throw accdbError(
      "Die TradeFoto-Datenbank überschreitet das sichere Arbeitsbudget.",
      "SALES_ARTICLE_IMPORT_WORK_BUDGET_EXCEEDED",
      413,
    );
  }
  return { articleRows, aliasRows };
}

function tradeFotoAccdbSnapshotAt(articleRows, reader) {
  let latest = null;
  for (const row of articleRows) {
    const value = row?.[TRADEFOTO_ACCDB_UPDATED_AT_FIELD];
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw accdbError(
        "Der TradeFoto-Änderungszeitpunkt ist nicht vollständig lesbar.",
        "SALES_ARTICLE_ACCDB_SCHEMA_MISMATCH",
      );
    }
    if (!latest || value.getTime() > latest.getTime()) latest = value;
  }
  if (!latest) {
    const creationDate = reader.getCreationDate?.();
    if (!(creationDate instanceof Date) || !Number.isFinite(creationDate.getTime())) {
      throw accdbError(
        "Die TradeFoto-Datenbank enthält keinen reproduzierbaren Snapshot-Zeitpunkt.",
        "SALES_ARTICLE_ACCDB_SCHEMA_MISMATCH",
      );
    }
    latest = creationDate;
  }
  return latest.toISOString();
}

function buildTradeFotoAccdbPayload(reader, articleRows, aliasRows) {
  const articleSourceKeys = new Set(articleRows.map((row) => row?.EAN));
  const aliasesBySourceKey = new Map();
  for (const alias of aliasRows) {
    const sourceKey = alias?.EAN;
    if (!articleSourceKeys.has(sourceKey)) {
      throw accdbError(
        "Die TradeFoto-Zweit-EAN-Tabelle enthält einen verwaisten Artikelbezug.",
        "SALES_ARTICLE_ACCDB_RELATION_INVALID",
      );
    }
    if (!aliasesBySourceKey.has(sourceKey)) aliasesBySourceKey.set(sourceKey, []);
    const target = aliasesBySourceKey.get(sourceKey);
    target.push({ EAN: alias.EAN, ZweitEAN: alias.ZweitEAN, Rang: alias.Rang });
    if (target.length > 256) {
      throw accdbError(
        "Ein TradeFoto-Artikel enthält mehr als 256 Zweit-EAN-Zuordnungen.",
        "SALES_ARTICLE_ACCDB_RELATION_INVALID",
      );
    }
  }
  const articles = articleRows.map((sourceRow) => {
    const articleRow = {};
    for (const fieldName of TRADEFOTO_ARTICLE_ROW_FIELDS) {
      const value = sourceRow[fieldName];
      articleRow[fieldName] = TRADEFOTO_ACCDB_DECIMAL_FIELDS.includes(fieldName)
        ? accdbDecimalText(value, fieldName)
        : value;
    }
    return {
      articleRow,
      aliasRows: aliasesBySourceKey.get(sourceRow.EAN) || [],
    };
  });
  return {
    format: TRADEFOTO_ARTICLE_IMPORT_FORMAT,
    sourceSystem: TRADEFOTO_ARTICLE_SOURCE_SYSTEM,
    sourceProfileVersion: TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION,
    sourceSchemaSha256: TRADEFOTO_ARTICLE_SOURCE_SCHEMA_SHA256,
    snapshotAt: tradeFotoAccdbSnapshotAt(articleRows, reader),
    currency: "EUR",
    articles,
  };
}

async function createMdbReader(buffer, password) {
  const module = await import("mdb-reader");
  return new module.default(buffer, { password });
}

async function inspectTradeFotoAccdbBuffer(buffer, {
  fileName,
  password,
  createReader = createMdbReader,
} = {}) {
  const safeFileName = sanitizedTradeFotoAccdbFilename(fileName);
  const safePassword = normalizeTradeFotoAccdbPassword(password);
  assertTradeFotoAccdbBuffer(buffer);
  const sourceFileSha256 = sha256(buffer);
  let reader;
  try {
    reader = await createReader(buffer, safePassword);
  } catch {
    throw accdbError(
      "Die TradeFoto-Datenbank konnte mit diesem Passwort nicht sicher geöffnet werden.",
      "SALES_ARTICLE_ACCDB_PASSWORD_OR_FILE_INVALID",
    );
  }
  try {
    const { articleTable, aliasTable } = assertTradeFotoAccdbSchema(reader);
    const { articleRows, aliasRows } = readTradeFotoAccdbRows(articleTable, aliasTable);
    const payload = buildTradeFotoAccdbPayload(reader, articleRows, aliasRows);
    if (sha256(buffer) !== sourceFileSha256) {
      throw accdbError(
        "Die TradeFoto-Datei wurde während der Prüfung verändert.",
        "SALES_ARTICLE_ACCDB_FILE_CHANGED",
        409,
      );
    }
    return inspectTradeFotoArticleImportPayload({ sourceFileSha256, safeFileName, payload });
  } catch (error) {
    if (error instanceof TradeFotoArticleImportError) throw error;
    throw accdbError(
      "Die TradeFoto-Datenbank konnte nicht vollständig und konsistent gelesen werden.",
      "SALES_ARTICLE_ACCDB_PASSWORD_OR_FILE_INVALID",
    );
  }
}

function workerError(value = {}) {
  const allowedCodes = new Set([
    "SALES_ARTICLE_ACCDB_FILE_CHANGED",
    "SALES_ARTICLE_ACCDB_FILE_SIZE_INVALID",
    "SALES_ARTICLE_ACCDB_FILENAME_INVALID",
    "SALES_ARTICLE_ACCDB_PASSWORD_INVALID",
    "SALES_ARTICLE_ACCDB_PASSWORD_OR_FILE_INVALID",
    "SALES_ARTICLE_ACCDB_PASSWORD_REQUIRED",
    "SALES_ARTICLE_ACCDB_RELATION_INVALID",
    "SALES_ARTICLE_ACCDB_ROW_INVALID",
    "SALES_ARTICLE_ACCDB_SCHEMA_MISMATCH",
    "SALES_ARTICLE_IMPORT_FINDING_LIMIT",
    "SALES_ARTICLE_IMPORT_ROW_LIMIT",
    "SALES_ARTICLE_IMPORT_SCHEMA_MISMATCH",
    "SALES_ARTICLE_IMPORT_WORK_BUDGET_EXCEEDED",
  ]);
  const code = allowedCodes.has(value.code)
    ? value.code
    : "SALES_ARTICLE_ACCDB_PASSWORD_OR_FILE_INVALID";
  const status = Number.isInteger(value.status) && value.status >= 400 && value.status <= 499
    ? value.status
    : 422;
  const messages = {
    SALES_ARTICLE_ACCDB_FILE_CHANGED: "Die TradeFoto-Datei wurde während der Prüfung verändert.",
    SALES_ARTICLE_ACCDB_FILE_SIZE_INVALID: "Die TradeFoto-Datenbank ist leer, unvollständig oder größer als 256 MiB.",
    SALES_ARTICLE_ACCDB_FILENAME_INVALID: "Bitte eine gültige TradeFoto-ACCDB-Datei auswählen.",
    SALES_ARTICLE_ACCDB_PASSWORD_INVALID: "Das TradeFoto-Datenbank-Passwort hat ein ungültiges Format.",
    SALES_ARTICLE_ACCDB_PASSWORD_OR_FILE_INVALID: "Die TradeFoto-Datenbank konnte mit diesem Passwort nicht sicher geöffnet werden.",
    SALES_ARTICLE_ACCDB_PASSWORD_REQUIRED: "Für die verschlüsselte TradeFoto-Datenbank ist das Datenbank-Passwort erforderlich.",
    SALES_ARTICLE_ACCDB_RELATION_INVALID: "Die TradeFoto-Datenbank enthält widersprüchliche Artikelbezüge.",
    SALES_ARTICLE_ACCDB_ROW_INVALID: "Mindestens ein TradeFoto-Feld konnte nicht sicher gelesen werden.",
    SALES_ARTICLE_ACCDB_SCHEMA_MISMATCH: "Die TradeFoto-Datenbank weicht vom freigegebenen Quellschema ab.",
    SALES_ARTICLE_IMPORT_FINDING_LIMIT: "Die Importdatei erzeugt zu viele einzelne Prüfhinweise.",
    SALES_ARTICLE_IMPORT_ROW_LIMIT: "Die TradeFoto-Datenbank enthält eine ungültige Anzahl Artikel.",
    SALES_ARTICLE_IMPORT_SCHEMA_MISMATCH: "Die extrahierten TradeFoto-Daten weichen vom freigegebenen Schema ab.",
    SALES_ARTICLE_IMPORT_WORK_BUDGET_EXCEEDED: "Die TradeFoto-Datenbank überschreitet das sichere Arbeitsbudget.",
  };
  return accdbError(messages[code], code, status);
}

function inspectTradeFotoAccdbBufferInWorker(buffer, options = {}) {
  const safeFileName = sanitizedTradeFotoAccdbFilename(options.fileName);
  let safePassword = normalizeTradeFotoAccdbPassword(options.password);
  assertTradeFotoAccdbBuffer(buffer);
  const transfersOriginalBuffer = buffer.byteOffset === 0
    && buffer.byteLength === buffer.buffer.byteLength;
  const transferable = transfersOriginalBuffer
    ? buffer.buffer
    : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const workerPath = path.join(__dirname, "tradefoto-accdb-worker.js");
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let worker;
    try {
      worker = new Worker(workerPath, {
        workerData: { databaseBytes: transferable, fileName: safeFileName, password: safePassword },
        transferList: [transferable],
        resourceLimits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 64 },
        name: "tradefoto-accdb-preview",
      });
    } catch {
      safePassword = "";
      if (buffer.byteLength) buffer.fill(0);
      reject(workerError());
      return;
    }
    if (!transfersOriginalBuffer) buffer.fill(0);
    safePassword = "";
    const abortInspection = () => {
      void worker.terminate();
      finish(() => reject(accdbError(
        "Die Prüfung der TradeFoto-Datenbank wurde abgebrochen.",
        "SALES_ARTICLE_ACCDB_REQUEST_ABORTED",
        408,
      )));
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener?.("abort", abortInspection);
      callback();
    };
    timer = setTimeout(() => {
      void worker.terminate();
      finish(() => reject(accdbError(
        "Die TradeFoto-Datenbank konnte nicht innerhalb des Zeitlimits geprüft werden.",
        "SALES_ARTICLE_ACCDB_TIMEOUT",
        408,
      )));
    }, TRADEFOTO_ACCDB_WORKER_TIMEOUT_MS);
    timer.unref?.();
    if (options.signal?.aborted) {
      abortInspection();
      return;
    }
    options.signal?.addEventListener?.("abort", abortInspection, { once: true });
    worker.once("message", (message) => {
      finish(() => {
        if (!message?.ok || !(message.serialized instanceof ArrayBuffer)) {
          reject(workerError(message?.error));
          return;
        }
        try {
          resolve(deserialize(Buffer.from(message.serialized)));
        } catch {
          reject(workerError());
        }
      });
    });
    worker.once("error", () => finish(() => reject(workerError())));
    worker.once("exit", (code) => {
      if (code !== 0) finish(() => reject(workerError()));
    });
  });
}

module.exports = {
  TRADEFOTO_ACCDB_ALIAS_TABLE,
  TRADEFOTO_ACCDB_ARTICLE_TABLE,
  TRADEFOTO_ACCDB_IMPORT_MAX_BYTES,
  TRADEFOTO_ACCDB_IMPORT_MIME_TYPE,
  TRADEFOTO_ACCDB_PASSWORD_MAX_BYTES,
  TRADEFOTO_ACCDB_UPDATED_AT_FIELD,
  TRADEFOTO_ACCDB_WORKER_TIMEOUT_MS,
  TradeFotoAccdbImportError,
  accdbDecimalText,
  assertTradeFotoAccdbBuffer,
  assertTradeFotoAccdbSchema,
  buildTradeFotoAccdbPayload,
  inspectTradeFotoAccdbBuffer,
  inspectTradeFotoAccdbBufferInWorker,
  normalizeTradeFotoAccdbPassword,
  readTradeFotoAccdbRows,
  sanitizedTradeFotoAccdbFilename,
};
