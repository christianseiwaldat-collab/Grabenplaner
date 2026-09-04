"use strict";

const { createHash } = require("node:crypto");
const { TextDecoder } = require("node:util");
const {
  normalizeDecimal12,
  normalizeSalesArticleIdentifier,
  normalizeSalesArticleImportRow,
  normalizeSalesArticleTimestamp,
} = require("./sales-article-catalog");
const {
  TRADEFOTO_ARTICLE_ALIAS_ROW_FIELDS,
  TRADEFOTO_ARTICLE_IMPORT_FORMAT,
  TRADEFOTO_ARTICLE_ROW_FIELDS,
  TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION,
  TRADEFOTO_ARTICLE_SOURCE_SCHEMA_SHA256,
  TRADEFOTO_ARTICLE_SOURCE_SYSTEM,
  TradeFotoArticleSourceProfileError,
  adaptTradeFotoArticleSourceRow,
} = require("./tradefoto-article-source-profile");

const TRADEFOTO_ARTICLE_IMPORT_MIME_TYPE = "application/vnd.grabenplaner.tradefoto-articles+json";
const TRADEFOTO_ARTICLE_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
const TRADEFOTO_ARTICLE_IMPORT_MAX_ROWS = 25_000;
const TRADEFOTO_ARTICLE_IMPORT_MAX_ALIASES_PER_ROW = 256;
const TRADEFOTO_ARTICLE_IMPORT_MAX_FINDINGS = 100_000;
const TRADEFOTO_ARTICLE_IMPORT_WORK_UNITS_PER_ROW = 36;
const TRADEFOTO_ARTICLE_IMPORT_MAX_WORK_UNITS = 750_000;
const TRADEFOTO_GROSS_NET_PAIRS = Object.freeze([
  Object.freeze(["Verkaufspreis", "eNvk"]),
  Object.freeze(["Internet_VK", "Invk"]),
  Object.freeze(["InternetVK2", "InternetVKN2"]),
  Object.freeze(["InternetVK3", "InternetVKN3"]),
  Object.freeze(["InternetVK4", "InternetVKN4"]),
  Object.freeze(["InternetVK5", "InternetVKN5"]),
]);
const DECIMAL_SCALE_TO_CENTS = 10_000_000_000n;
const VAT_RATE_PERCENT_BY_CODE = new Map([
  [0, 0n],
  [1, 20n],
  [2, 10n],
  [3, 19n],
  [4, 7n],
]);
const VAT_DENOMINATOR = 100n;
const GROSS_NET_TOLERANCE_CENTS = 1n;

class TradeFotoArticleImportError extends Error {
  constructor(message, code = "SALES_ARTICLE_IMPORT_ROW_INVALID", status = 422) {
    super(message);
    this.name = "TradeFotoArticleImportError";
    this.code = code;
    this.status = status;
  }
}

function importError(message, code, status = 422) {
  return new TradeFotoArticleImportError(message, code, status);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function sanitizedTradeFotoImportFilename(value) {
  const leaf = String(value || "tradefoto-artikel.json")
    .split(/[\\/]/u)
    .pop()
    .trim();
  if (!leaf || leaf.length > 160 || /[\u0000-\u001f\u007f]/u.test(leaf)
    || !/\.json$/iu.test(leaf)) {
    throw importError(
      "Bitte einen gültigen TradeFoto-JSON-Export auswählen.",
      "SALES_ARTICLE_IMPORT_FILENAME_INVALID",
      400,
    );
  }
  return leaf;
}

function decodeUtf8Json(buffer) {
  if (!Buffer.isBuffer(buffer)
    || buffer.length < 2
    || buffer.length > TRADEFOTO_ARTICLE_IMPORT_MAX_BYTES) {
    throw importError(
      "Die Importdatei ist leer oder größer als 64 MiB.",
      "SALES_ARTICLE_IMPORT_FILE_SIZE_INVALID",
      413,
    );
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw importError(
      "Die Importdatei muss unverändert als UTF-8 vorliegen.",
      "SALES_ARTICLE_IMPORT_JSON_INVALID",
    );
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch {
    throw importError(
      "Die Importdatei enthält kein gültiges JSON.",
      "SALES_ARTICLE_IMPORT_JSON_INVALID",
    );
  }
}

function assertImportEnvelope(payload) {
  if (!hasExactKeys(payload, [
    "format",
    "sourceSystem",
    "sourceProfileVersion",
    "sourceSchemaSha256",
    "snapshotAt",
    "currency",
    "articles",
  ])) {
    throw importError(
      "Der TradeFoto-Dateivertrag ist unvollständig oder enthält unbekannte Felder.",
      "SALES_ARTICLE_IMPORT_SCHEMA_MISMATCH",
    );
  }
  if (payload.format !== TRADEFOTO_ARTICLE_IMPORT_FORMAT
    || payload.sourceSystem !== TRADEFOTO_ARTICLE_SOURCE_SYSTEM
    || payload.sourceProfileVersion !== TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION
    || payload.sourceSchemaSha256 !== TRADEFOTO_ARTICLE_SOURCE_SCHEMA_SHA256
    || payload.currency !== "EUR") {
    throw importError(
      "Format, Profil, Schema oder Währung passen nicht zum freigegebenen TradeFoto-Import.",
      "SALES_ARTICLE_IMPORT_SCHEMA_MISMATCH",
    );
  }
  if (!Array.isArray(payload.articles)
    || payload.articles.length < 1
    || payload.articles.length > TRADEFOTO_ARTICLE_IMPORT_MAX_ROWS) {
    throw importError(
      "Der TradeFoto-Import muss zwischen einem und 25.000 Artikeln enthalten.",
      "SALES_ARTICLE_IMPORT_ROW_LIMIT",
      payload.articles?.length > TRADEFOTO_ARTICLE_IMPORT_MAX_ROWS ? 413 : 422,
    );
  }
  try {
    normalizeSalesArticleTimestamp(payload.snapshotAt, {
      label: "Der TradeFoto-Snapshot-Zeitpunkt",
    });
  } catch {
    throw importError(
      "Der Snapshot-Zeitpunkt ist ungültig.",
      "SALES_ARTICLE_IMPORT_SCHEMA_MISMATCH",
    );
  }
}

function assertSourceRowSchema(entry, rowNumber) {
  if (!hasExactKeys(entry, ["articleRow", "aliasRows"])
    || !hasExactKeys(entry.articleRow, TRADEFOTO_ARTICLE_ROW_FIELDS)
    || !Array.isArray(entry.aliasRows)
    || entry.aliasRows.length > TRADEFOTO_ARTICLE_IMPORT_MAX_ALIASES_PER_ROW
    || entry.aliasRows.some((alias) => !hasExactKeys(alias, TRADEFOTO_ARTICLE_ALIAS_ROW_FIELDS))) {
    throw importError(
      `Zeile ${rowNumber} weicht vom freigegebenen TradeFoto-Schema ab.`,
      "SALES_ARTICLE_IMPORT_SCHEMA_MISMATCH",
    );
  }
}

function decimal12Scaled(value) {
  if (value === null) return null;
  let normalized;
  try {
    normalized = normalizeDecimal12(value);
  } catch {
    return null;
  }
  if (normalized === null) return null;
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integer, fraction] = unsigned.split(".");
  const scaled = BigInt(integer) * 1_000_000_000_000n + BigInt(fraction);
  return negative ? -scaled : scaled;
}

function divideRoundHalfUp(numerator, denominator) {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = absolute / denominator
    + (((absolute % denominator) * 2n >= denominator) ? 1n : 0n);
  return negative ? -rounded : rounded;
}

function roundedCentsFromScaled(scaled) {
  return divideRoundHalfUp(scaled, DECIMAL_SCALE_TO_CENTS);
}

function grossNetGateIssues(articleRow) {
  const issues = [];
  const vatRatePercent = VAT_RATE_PERCENT_BY_CODE.get(articleRow.MWST);
  if (vatRatePercent === undefined) {
    issues.push(Object.freeze({ code: "tax_code_unknown", pair: null }));
    return Object.freeze(issues);
  }
  for (const [grossField, netField] of TRADEFOTO_GROSS_NET_PAIRS) {
    const gross = decimal12Scaled(articleRow[grossField]);
    const net = decimal12Scaled(articleRow[netField]);
    if (gross === null && net === null) continue;
    if (gross === null || net === null) {
      issues.push(Object.freeze({
        code: "gross_net_pair_incomplete",
        pair: `${grossField}/${netField}`,
      }));
      continue;
    }
    const actualGrossCents = roundedCentsFromScaled(gross);
    const expectedGrossCents = divideRoundHalfUp(
      net * (VAT_DENOMINATOR + vatRatePercent),
      VAT_DENOMINATOR * DECIMAL_SCALE_TO_CENTS,
    );
    const difference = actualGrossCents >= expectedGrossCents
      ? actualGrossCents - expectedGrossCents
      : expectedGrossCents - actualGrossCents;
    if (difference > GROSS_NET_TOLERANCE_CENTS) {
      issues.push(Object.freeze({
        code: "gross_net_mismatch",
        pair: `${grossField}/${netField}`,
      }));
    }
  }
  return Object.freeze(issues);
}

function sourceProfileIssueCode(error) {
  if (!(error instanceof TradeFotoArticleSourceProfileError)) return "row_invalid";
  if (error.code === "TRADEFOTO_SOURCE_KEY_INVALID") return "invalid_source_key";
  if (error.code === "TRADEFOTO_PRICE_VALUE_INVALID") return "invalid_price";
  if (error.code === "TRADEFOTO_ALIASES_INVALID") return "invalid_identifier";
  return "row_invalid";
}

function finding(rowNumber, articleNumber, code, detail = "") {
  return Object.freeze({
    rowNumber,
    articleNumber: articleNumber || null,
    code,
    detailSha256: sha256(JSON.stringify({ rowNumber, articleNumber: articleNumber || null, code, detail })),
  });
}

function appendFinding(findings, value) {
  if (findings.length >= TRADEFOTO_ARTICLE_IMPORT_MAX_FINDINGS) {
    throw importError(
      "Die Importdatei erzeugt mehr als 100.000 einzelne Prüfhinweise.",
      "SALES_ARTICLE_IMPORT_FINDING_LIMIT",
      413,
    );
  }
  findings.push(value);
}

function activeArticle(importRow) {
  return normalizeSalesArticleImportRow({
    ...importRow,
    active: true,
  });
}

function decodeTradeFotoArticleImportBuffer(buffer, { fileName } = {}) {
  const sourceFileSha256 = sha256(buffer);
  const safeFileName = sanitizedTradeFotoImportFilename(fileName);
  const payload = decodeUtf8Json(buffer);
  assertImportEnvelope(payload);
  return { sourceFileSha256, safeFileName, payload };
}

function inspectTradeFotoArticleImportPayload(decoded) {
  const { sourceFileSha256, safeFileName, payload } = decoded;
  let workUnits = payload.articles.length * TRADEFOTO_ARTICLE_IMPORT_WORK_UNITS_PER_ROW;
  for (let index = 0; index < payload.articles.length; index += 1) {
    const sourceEntry = payload.articles[index];
    assertSourceRowSchema(sourceEntry, index + 1);
    workUnits += sourceEntry.aliasRows.length;
    if (workUnits > TRADEFOTO_ARTICLE_IMPORT_MAX_WORK_UNITS) {
      throw importError(
        "Der Import überschreitet das sichere Arbeitsbudget von 750.000 Prüfeinheiten.",
        "SALES_ARTICLE_IMPORT_WORK_BUDGET_EXCEEDED",
        413,
      );
    }
  }
  const adaptedArticles = [];
  const identityRows = [];
  const aliasIdentityRows = [];
  const rows = [];
  const findings = [];
  let identifierCount = 0;
  let priceCount = 0;

  for (let index = 0; index < payload.articles.length; index += 1) {
    const rowNumber = index + 1;
    const sourceEntry = payload.articles[index];
    const rawSourceKey = sourceEntry.articleRow.EAN;
    if (typeof rawSourceKey === "string" && /^\d{13}$/u.test(rawSourceKey)) {
      const numericSourceKey = BigInt(rawSourceKey);
      if (numericSourceKey >= 1n && numericSourceKey <= 999999n) {
        identityRows.push(Object.freeze({
          rowNumber,
          sourceArticleKey: rawSourceKey,
          articleNumber: numericSourceKey.toString().padStart(6, "0"),
        }));
      }
    }
    for (const alias of sourceEntry.aliasRows) {
      if (alias.EAN !== rawSourceKey
        || alias.ZweitEAN === rawSourceKey
        || typeof alias.ZweitEAN !== "string"
        || !Number.isSafeInteger(alias.Rang)
        || alias.Rang < 0
        || alias.Rang > 255) continue;
      try {
        const identifier = normalizeSalesArticleIdentifier({
          identifierValue: alias.ZweitEAN,
          isPrimary: false,
          sourceField: "ZweitEAN.ZweitEAN",
          sourceRank: alias.Rang,
        });
        aliasIdentityRows.push(Object.freeze({
          rowNumber,
          canonicalGtin14: identifier.canonicalGtin14,
        }));
      } catch {}
    }
    let adapted;
    try {
      adapted = adaptTradeFotoArticleSourceRow({
        articleRow: sourceEntry.articleRow,
        aliasRows: sourceEntry.aliasRows,
        currency: payload.currency,
      });
    } catch (error) {
      const code = sourceProfileIssueCode(error);
      const sourceKey = typeof sourceEntry.articleRow?.EAN === "string"
        && /^\d{13}$/u.test(sourceEntry.articleRow.EAN)
        ? sourceEntry.articleRow.EAN : "";
      const articleNumber = sourceKey ? BigInt(sourceKey).toString().padStart(6, "0") : null;
      appendFinding(findings, finding(rowNumber, articleNumber, code));
      rows.push(Object.freeze({
        rowNumber,
        articleNumber,
        description: typeof sourceEntry.articleRow?.Artikelbezeichnung === "string"
          ? sourceEntry.articleRow.Artikelbezeichnung.trim().slice(0, 300) : "",
        action: "blocked",
        issueCodes: Object.freeze([code]),
        identifierCount: 0,
        priceCount: 0,
      }));
      payload.articles[index] = null;
      continue;
    }

    const article = activeArticle(adapted.importRow);
    const rowIssues = [
      ...adapted.quarantine.identifiers.map(() => ({ code: "invalid_identifier", pair: null })),
      ...adapted.quarantine.prices.map(() => ({ code: "negative_price", pair: null })),
      ...grossNetGateIssues(sourceEntry.articleRow),
    ];
    if (adapted.ignoredAliases.length) {
      appendFinding(findings, finding(
        rowNumber,
        article.articleNumber,
        "ignored_alias",
        [...new Set(adapted.ignoredAliases.map(({ code }) => String(code || "ignored")))]
          .sort().join(","),
      ));
    }
    const issueCodes = [...new Set(rowIssues.map(({ code }) => code))];
    for (const code of issueCodes) {
      appendFinding(findings, finding(
        rowNumber,
        article.articleNumber,
        code,
        [...new Set(rowIssues.filter((issue) => issue.code === code)
          .map((issue) => issue.pair || ""))].sort().join(","),
      ));
    }
    identifierCount += article.identifiers.length;
    priceCount += article.prices.length;
    rows.push(Object.freeze({
      rowNumber,
      articleNumber: article.articleNumber,
      description: article.description,
      action: issueCodes.length ? "blocked" : "ready",
      issueCodes: Object.freeze(issueCodes),
      identifierCount: article.identifiers.length,
      priceCount: article.prices.length,
    }));
    adaptedArticles.push(Object.freeze({
      rowNumber,
      article,
      hasRowIssues: issueCodes.length > 0,
    }));
    payload.articles[index] = null;
  }

  const duplicateCodesByRow = new Map();
  const addDuplicateCode = (rowNumber, code) => {
    if (!duplicateCodesByRow.has(rowNumber)) duplicateCodesByRow.set(rowNumber, new Set());
    duplicateCodesByRow.get(rowNumber).add(code);
  };
  const quarantineDuplicateOwners = (groups, code) => {
    for (const rowNumbers of groups.values()) {
      const distinctRows = [...new Set(rowNumbers)];
      if (distinctRows.length < 2) continue;
      for (const rowNumber of distinctRows) addDuplicateCode(rowNumber, code);
    }
  };
  const sourceOwners = new Map();
  const numberOwners = new Map();
  const identifierOwners = new Map();
  const registerOwner = (groups, value, rowNumber) => {
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(rowNumber);
  };
  for (const identity of identityRows) {
    registerOwner(sourceOwners, identity.sourceArticleKey, identity.rowNumber);
    registerOwner(numberOwners, identity.articleNumber, identity.rowNumber);
  }
  for (const identity of aliasIdentityRows) {
    registerOwner(identifierOwners, identity.canonicalGtin14, identity.rowNumber);
  }
  quarantineDuplicateOwners(sourceOwners, "duplicate_source_key");
  quarantineDuplicateOwners(numberOwners, "duplicate_article_number");
  quarantineDuplicateOwners(identifierOwners, "duplicate_gtin");

  for (const [rowNumber, codes] of duplicateCodesByRow) {
    const candidate = rows[rowNumber - 1];
    for (const code of [...codes].sort()) {
      appendFinding(findings, finding(rowNumber, candidate?.articleNumber, code));
    }
  }

  const finalRows = rows.map((row) => {
    const duplicateCodes = duplicateCodesByRow.get(row.rowNumber);
    if (!duplicateCodes?.size) return row;
    const issueCodes = [...new Set([...row.issueCodes, ...duplicateCodes])].sort();
    return Object.freeze({
      ...row,
      action: "blocked",
      issueCodes: Object.freeze(issueCodes),
    });
  });
  const normalizedArticles = adaptedArticles
    .filter(({ rowNumber, hasRowIssues }) => (
      !hasRowIssues && !duplicateCodesByRow.has(rowNumber)
    ))
    .map(({ article }) => article);
  identifierCount = normalizedArticles.reduce(
    (sum, article) => sum + article.identifiers.length,
    0,
  );
  priceCount = normalizedArticles.reduce((sum, article) => sum + article.prices.length, 0);

  return Object.freeze({
    source: Object.freeze({
      fileName: safeFileName,
      fileSha256: sourceFileSha256,
      snapshotAt: payload.snapshotAt,
      articleCount: finalRows.length,
    }),
    sourceSystem: payload.sourceSystem,
    sourceProfileVersion: payload.sourceProfileVersion,
    sourceSchemaSha256: payload.sourceSchemaSha256,
    currency: payload.currency,
    normalizedArticles: Object.freeze(normalizedArticles),
    rows: Object.freeze(finalRows),
    findings: Object.freeze(findings),
    counts: Object.freeze({ identifierCount, priceCount }),
  });
}

function inspectTradeFotoArticleImportBuffer(buffer, options = {}) {
  return inspectTradeFotoArticleImportPayload(
    decodeTradeFotoArticleImportBuffer(buffer, options),
  );
}

module.exports = {
  GROSS_NET_TOLERANCE_CENTS,
  TRADEFOTO_ARTICLE_IMPORT_MAX_BYTES,
  TRADEFOTO_ARTICLE_IMPORT_MAX_FINDINGS,
  TRADEFOTO_ARTICLE_IMPORT_MAX_ROWS,
  TRADEFOTO_ARTICLE_IMPORT_MAX_WORK_UNITS,
  TRADEFOTO_ARTICLE_IMPORT_WORK_UNITS_PER_ROW,
  TRADEFOTO_ARTICLE_IMPORT_MIME_TYPE,
  TRADEFOTO_ARTICLE_IMPORT_FORMAT,
  TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION,
  TRADEFOTO_ARTICLE_SOURCE_SCHEMA_SHA256,
  TRADEFOTO_ARTICLE_SOURCE_SYSTEM,
  TRADEFOTO_GROSS_NET_PAIRS,
  TradeFotoArticleImportError,
  decodeTradeFotoArticleImportBuffer,
  grossNetGateIssues,
  inspectTradeFotoArticleImportBuffer,
  inspectTradeFotoArticleImportPayload,
  sanitizedTradeFotoImportFilename,
};
