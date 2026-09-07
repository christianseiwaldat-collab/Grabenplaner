"use strict";

const { createHash } = require("node:crypto");

const SALES_ARTICLE_PRICE_TYPES = Object.freeze([
  "average_purchase",
  "calculation",
  "dek_a",
  "deposit",
  "future_purchase",
  "future_upe",
  "internet_1",
  "internet_2",
  "internet_3",
  "internet_4",
  "internet_5",
  "invoice_purchase",
  "list_purchase",
  "net_net_purchase",
  "order_purchase",
  "other",
  "sales",
  "special",
  "upe",
  "wholesale",
  "zdek",
]);
const SALES_ARTICLE_PRICE_BASES = Object.freeze(["gross", "net", "unknown"]);
const SALES_ARTICLE_PRICE_QUALITY_STATUSES = Object.freeze([
  "confirmed",
  "inferred",
  "quarantined",
  "unresolved",
]);
const SALES_ARTICLE_IDENTIFIER_TYPES = Object.freeze(["ean8", "upca", "ean13", "gtin14"]);
const IDENTIFIER_LENGTH_BY_TYPE = Object.freeze({
  ean8: 8,
  upca: 12,
  ean13: 13,
  gtin14: 14,
});
const PRICE_TYPE_SET = new Set(SALES_ARTICLE_PRICE_TYPES);
const PRICE_BASIS_SET = new Set(SALES_ARTICLE_PRICE_BASES);
const PRICE_QUALITY_STATUS_SET = new Set(SALES_ARTICLE_PRICE_QUALITY_STATUSES);
const IDENTIFIER_TYPE_SET = new Set(SALES_ARTICLE_IDENTIFIER_TYPES);
const SALES_ARTICLE_SEARCH_SORT_KEYS = Object.freeze([
  "articleNumber",
  "description",
  "primaryIdentifier",
  "status",
  "sourceSystem",
]);
const SALES_ARTICLE_SEARCH_STATUSES = Object.freeze(["active", "inactive", "all"]);
const SALES_ARTICLE_SEARCH_DIRECTIONS = Object.freeze(["asc", "desc"]);
const SALES_ARTICLE_SEARCH_DEFAULT_LIMIT = 50;
const SALES_ARTICLE_SEARCH_MAX_LIMIT = 100;
const SALES_ARTICLE_SEARCH_MAX_OFFSET = 1000000;

class SalesArticleCatalogError extends Error {
  constructor(message, code = "SALES_ARTICLE_CATALOG_INVALID") {
    super(message);
    this.name = "SalesArticleCatalogError";
    this.code = code;
  }
}

function catalogError(message, code) {
  return new SalesArticleCatalogError(message, code);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw catalogError(`${label} enthält unbekannte oder ungültige Felder.`);
  }
}

function normalizedText(value, label, maximumLength, { minimumLength = 1 } = {}) {
  if (typeof value !== "string") throw catalogError(`${label} muss Text sein.`);
  const result = value.trim();
  if (result.length < minimumLength
    || result.length > maximumLength
    || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw catalogError(`${label} ist ungültig.`);
  }
  return result;
}

function normalizeSalesArticleNumber(value) {
  return normalizedText(value, "Die Artikelnummer", 80);
}

function optionalSearchText(value, label, maximumLength) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw catalogError(`${label} muss Text sein.`);
  const result = value.trim();
  if (result.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw catalogError(`${label} ist ungültig.`, "SALES_ARTICLE_SEARCH_INVALID");
  }
  return result;
}

function integerSearchValue(value, label, fallback, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > maximum) {
    throw catalogError(`${label} ist ungültig.`, "SALES_ARTICLE_SEARCH_INVALID");
  }
  return normalized;
}

function escapedLikePattern(value) {
  return `%${value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
}

function normalizeSalesArticleSearch(value = {}) {
  exactKeys(
    value,
    ["query", "identifier", "status", "sourceSystem", "sort", "direction", "limit", "offset"],
    "Die Artikelstammsuche",
  );
  const query = optionalSearchText(value.query, "Der Suchbegriff", 160);
  try { require("./flexible-search").terms(query); } catch (error) { throw catalogError(error.message, "SALES_ARTICLE_SEARCH_INVALID"); }
  const identifier = optionalSearchText(value.identifier, "Der EAN-/GTIN-Suchwert", 14);
  if (identifier && !/^\d+$/.test(identifier)) {
    throw catalogError(
      "Der EAN-/GTIN-Suchwert darf nur Ziffern enthalten.",
      "SALES_ARTICLE_SEARCH_INVALID",
    );
  }
  const status = String(value.status || "active").trim().toLowerCase();
  const sort = String(value.sort || "articleNumber").trim();
  const direction = String(value.direction || "asc").trim().toLowerCase();
  if (!SALES_ARTICLE_SEARCH_STATUSES.includes(status)
    || !SALES_ARTICLE_SEARCH_SORT_KEYS.includes(sort)
    || !SALES_ARTICLE_SEARCH_DIRECTIONS.includes(direction)) {
    throw catalogError(
      "Status oder Sortierung der Artikelstammsuche ist ungültig.",
      "SALES_ARTICLE_SEARCH_INVALID",
    );
  }
  const sourceSystemInput = optionalSearchText(value.sourceSystem, "Das Quellsystem", 80);
  const sourceSystem = sourceSystemInput
    ? normalizeSalesArticleSourceSystem(sourceSystemInput)
    : null;
  const limit = integerSearchValue(
    value.limit,
    "Das Ergebnislimit",
    SALES_ARTICLE_SEARCH_DEFAULT_LIMIT,
    SALES_ARTICLE_SEARCH_MAX_LIMIT,
  );
  if (limit < 1) {
    throw catalogError("Das Ergebnislimit ist ungültig.", "SALES_ARTICLE_SEARCH_INVALID");
  }
  const offset = integerSearchValue(
    value.offset,
    "Der Ergebnisversatz",
    0,
    SALES_ARTICLE_SEARCH_MAX_OFFSET,
  );
  return Object.freeze({
    query,
    likeQuery: escapedLikePattern(query.toLowerCase()),
    identifier,
    identifierLike: escapedLikePattern(identifier),
    status,
    active: status === "all" ? null : status === "active",
    sourceSystem,
    sort,
    direction,
    limit,
    offset,
  });
}

function normalizeSalesArticleSourceSystem(value) {
  const result = normalizedText(value, "Das Quellsystem", 80).toLowerCase();
  if (!/^[a-z][a-z0-9._-]*$/.test(result)) {
    throw catalogError("Das Quellsystem ist ungültig.");
  }
  return result;
}

function normalizeSalesArticleSourceProfileVersion(value) {
  const result = normalizedText(value, "Die Quellprofilversion", 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(result)) {
    throw catalogError("Die Quellprofilversion ist ungültig.");
  }
  return result;
}

function normalizeSalesArticleSourceKey(value) {
  return normalizedText(value, "Der Quellschlüssel", 160);
}

function normalizeSalesArticleActor(value) {
  return normalizedText(value, "Der Akteur", 120);
}

function normalizeSalesArticleSha256(value, label = "Der SHA-256-Wert") {
  const result = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw catalogError(`${label} ist ungültig.`);
  return result;
}

function normalizeSalesArticleTimestamp(value, { nullable = false, label = "Der Zeitpunkt" } = {}) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw catalogError(`${label} ist ungültig.`);
  }
  try {
    if (new Date(value).toISOString() !== value) throw new Error("invalid");
  } catch {
    throw catalogError(`${label} ist ungültig.`);
  }
  return value;
}

function normalizeDecimal12(value) {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw catalogError("Ein Preis muss als exakte Dezimalzeichenfolge oder null vorliegen.", "PRICE_INVALID");
  }
  const match = value.trim().match(/^([+-]?)(\d+)(?:\.(\d{1,12}))?$/);
  if (!match) {
    throw catalogError("Ein Preis muss eine Dezimalzahl mit höchstens zwölf Nachkommastellen sein.", "PRICE_INVALID");
  }
  const integer = match[2].replace(/^0+(?=\d)/, "");
  if (integer.length > 18) {
    throw catalogError("Der Preis überschreitet NUMERIC(30,12).", "PRICE_INVALID");
  }
  const fraction = String(match[3] || "").padEnd(12, "0");
  const sign = match[1] === "-" && (integer !== "0" || /[1-9]/.test(fraction)) ? "-" : "";
  return `${sign}${integer}.${fraction}`;
}

function hasValidGtinChecksum(value) {
  const digits = String(value || "");
  if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) return false;
  const checkDigit = Number(digits.at(-1));
  let sum = 0;
  for (let index = digits.length - 2, position = 0; index >= 0; index -= 1, position += 1) {
    sum += Number(digits[index]) * (position % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === checkDigit;
}

function inferredIdentifierType(value) {
  const match = Object.entries(IDENTIFIER_LENGTH_BY_TYPE)
    .find(([, length]) => length === value.length);
  return match?.[0] || null;
}

function canonicalGtin14(value) {
  const identifierValue = normalizedText(value, "Der EAN-/GTIN-Wert", 14);
  if (!hasValidGtinChecksum(identifierValue)) {
    throw catalogError("Der EAN-/GTIN-Identifier ist nicht qualitätsgesichert.", "IDENTIFIER_INVALID");
  }
  return identifierValue.padStart(14, "0");
}

function normalizeIdentifierSourceRank(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw catalogError("Der Quellrang des Identifiers ist ungültig.", "IDENTIFIER_INVALID");
  }
  return value;
}

function optionalSourceText(value, label, maximum) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    throw catalogError(`${label} ist ungültig.`, "SOURCE_METADATA_INVALID");
  }
  return value;
}

function normalizeSalesArticleSourceMetadata(value) {
  if (value === undefined || value === null) return null;
  exactKeys(
    value,
    [
      "provider", "productNumber", "url", "fetchedAt", "createdBy", "updatedBy",
      "createdAt", "updatedAt",
    ],
    "Die Artikel-Quellmetadaten",
  );
  return Object.freeze({
    provider: optionalSourceText(value.provider, "Der ursprüngliche Quellanbieter", 80) ?? "",
    productNumber: optionalSourceText(
      value.productNumber,
      "Die ursprüngliche Quellproduktnummer",
      1000,
    ) ?? "",
    url: optionalSourceText(value.url, "Die ursprüngliche Quelladresse", 4000) ?? "",
    fetchedAt: optionalSourceText(value.fetchedAt, "Der ursprüngliche Abrufzeitpunkt", 80),
    createdBy: optionalSourceText(value.createdBy, "Der ursprüngliche Anlageakteur", 120) ?? "",
    updatedBy: optionalSourceText(value.updatedBy, "Der ursprüngliche Änderungsakteur", 120) ?? "",
    createdAt: optionalSourceText(value.createdAt, "Der ursprüngliche Anlagezeitpunkt", 80),
    updatedAt: optionalSourceText(value.updatedAt, "Der ursprüngliche Änderungszeitpunkt", 80),
  });
}

function normalizeSalesArticleIdentifier(value) {
  exactKeys(
    value,
    [
      "identifierType", "identifierValue", "canonicalGtin14", "isPrimary", "sourceField",
      "sourceRank", "sourceProvider", "verifiedAt", "createdBy", "updatedBy", "createdAt",
      "updatedAt",
    ],
    "Der Artikel-Identifier",
  );
  const identifierValue = normalizedText(value.identifierValue, "Der EAN-/GTIN-Wert", 14);
  const inferredType = inferredIdentifierType(identifierValue);
  const identifierType = value.identifierType === undefined
    ? inferredType
    : String(value.identifierType || "").trim();
  if (!IDENTIFIER_TYPE_SET.has(identifierType)
    || identifierType !== inferredType
    || !hasValidGtinChecksum(identifierValue)) {
    throw catalogError("Der EAN-/GTIN-Identifier ist nicht qualitätsgesichert.", "IDENTIFIER_INVALID");
  }
  if (value.isPrimary !== undefined && typeof value.isPrimary !== "boolean") {
    throw catalogError("Die Primärkennzeichnung des Identifiers ist ungültig.", "IDENTIFIER_INVALID");
  }
  const canonicalValue = canonicalGtin14(identifierValue);
  if (value.canonicalGtin14 !== undefined && value.canonicalGtin14 !== canonicalValue) {
    throw catalogError("Der kanonische GTIN-Vergleichswert ist ungültig.", "IDENTIFIER_INVALID");
  }
  const result = {
    identifierType,
    identifierValue,
    canonicalGtin14: canonicalValue,
    isPrimary: value.isPrimary === true,
    sourceField: normalizedText(value.sourceField, "Das Identifier-Quellfeld", 80),
    sourceRank: normalizeIdentifierSourceRank(value.sourceRank),
  };
  for (const [key, label, maximum] of [
    ["sourceProvider", "Der ursprüngliche Identifier-Anbieter", 80],
    ["createdBy", "Der ursprüngliche Identifier-Anlageakteur", 120],
    ["updatedBy", "Der ursprüngliche Identifier-Änderungsakteur", 120],
  ]) {
    const normalized = optionalSourceText(value[key], label, maximum);
    if (normalized !== null) result[key] = normalized;
  }
  for (const [key, label] of [
    ["verifiedAt", "Der ursprüngliche Identifier-Prüfzeitpunkt"],
    ["createdAt", "Der ursprüngliche Identifier-Anlagezeitpunkt"],
    ["updatedAt", "Der ursprüngliche Identifier-Änderungszeitpunkt"],
  ]) {
    if (value[key] !== undefined && value[key] !== null) {
      result[key] = normalizeSalesArticleTimestamp(value[key], { label });
    }
  }
  return Object.freeze(result);
}

function identifierObservation(identifier) {
  return Object.freeze({ ...identifier });
}

function identifierPreferenceKey(identifier) {
  return [
    identifier.isPrimary ? "0" : "1",
    String(identifier.sourceRank ?? 999).padStart(3, "0"),
    identifier.identifierType,
    identifier.identifierValue,
    identifier.sourceField,
    identifier.sourceProvider || "",
  ].join("\0");
}

function collapseEquivalentIdentifiers(identifiers) {
  const groups = new Map();
  for (const identifier of identifiers) {
    if (!groups.has(identifier.canonicalGtin14)) groups.set(identifier.canonicalGtin14, []);
    groups.get(identifier.canonicalGtin14).push(identifier);
  }
  return [...groups.values()].map((group) => {
    const ordered = [...group].sort((left, right) => (
      compareText(identifierPreferenceKey(left), identifierPreferenceKey(right))
    ));
    const representative = ordered[0];
    if (ordered.length === 1) return representative;
    return Object.freeze({
      ...representative,
      equivalentIdentifiers: Object.freeze(ordered.map(identifierObservation)),
    });
  });
}

function normalizeSalesArticlePrice(value) {
  exactKeys(
    value,
    ["priceType", "amount", "currency", "priceBasis", "qualityStatus", "sourceField"],
    "Der Artikelpreis",
  );
  const priceType = String(value.priceType || "").trim().toLowerCase();
  const priceBasis = String(value.priceBasis || "").trim().toLowerCase();
  const qualityStatus = String(value.qualityStatus || "").trim().toLowerCase();
  const currency = String(value.currency || "").trim().toUpperCase();
  if (!PRICE_TYPE_SET.has(priceType)) throw catalogError("Die Preisart ist nicht freigegeben.", "PRICE_TYPE_INVALID");
  if (!PRICE_BASIS_SET.has(priceBasis)) throw catalogError("Die Preisbasis ist ungültig.", "PRICE_BASIS_INVALID");
  if (!PRICE_QUALITY_STATUS_SET.has(qualityStatus)) {
    throw catalogError("Der Qualitätsstatus des Preises ist ungültig.", "PRICE_QUALITY_STATUS_INVALID");
  }
  if (!/^[A-Z]{3}$/.test(currency)) throw catalogError("Die Währung ist ungültig.", "CURRENCY_INVALID");
  const amount = normalizeDecimal12(value.amount);
  if (amount?.startsWith("-") && qualityStatus !== "quarantined") {
    throw catalogError("Negative Preise müssen quarantänisiert sein.", "PRICE_QUALITY_STATUS_INVALID");
  }
  return Object.freeze({
    priceType,
    amount,
    currency,
    priceBasis,
    qualityStatus,
    sourceField: normalizedText(value.sourceField, "Das Preis-Quellfeld", 80),
  });
}

function normalizeSalesArticleImportRow(value) {
  exactKeys(
    value,
    [
      "sourceArticleKey", "articleNumber", "description", "active", "sourceUpdatedAt",
      "identifiers", "prices", "sourceMetadata",
    ],
    "Der Importartikel",
  );
  if (value.active !== undefined && typeof value.active !== "boolean") {
    throw catalogError("Der Aktivstatus des Artikels ist ungültig.");
  }
  const identifiers = value.identifiers === undefined ? [] : value.identifiers;
  const prices = value.prices === undefined ? [] : value.prices;
  if (!Array.isArray(identifiers) || identifiers.length > 32
    || !Array.isArray(prices) || prices.length > 128) {
    throw catalogError("Identifier oder Preise des Importartikels sind ungültig.");
  }
  const identifierObservations = identifiers.map(normalizeSalesArticleIdentifier);
  const normalizedPrices = prices.map(normalizeSalesArticlePrice);
  if (identifierObservations.filter(({ isPrimary }) => isPrimary).length > 1
    || new Set(identifierObservations.map((identifier) => (
      [identifier.identifierType, identifier.identifierValue, identifier.sourceField].join("\0")
    ))).size !== identifierObservations.length
    || new Set(normalizedPrices.map(({ priceType, priceBasis, sourceField }) => (
      `${priceType}\0${priceBasis}\0${sourceField}`
    ))).size !== normalizedPrices.length) {
    throw catalogError("Der Importartikel enthält doppelte oder widersprüchliche Werte.");
  }
  return Object.freeze({
    sourceArticleKey: normalizeSalesArticleSourceKey(value.sourceArticleKey),
    articleNumber: normalizeSalesArticleNumber(value.articleNumber),
    description: normalizedText(value.description, "Die Artikelbezeichnung", 300),
    active: value.active !== false,
    sourceUpdatedAt: normalizeSalesArticleTimestamp(value.sourceUpdatedAt, {
      nullable: true,
      label: "Der Quelländerungszeitpunkt",
    }),
    identifiers: Object.freeze(collapseEquivalentIdentifiers(identifierObservations)),
    prices: Object.freeze(normalizedPrices),
    sourceMetadata: normalizeSalesArticleSourceMetadata(value.sourceMetadata),
  });
}

function normalizeSalesArticleExpectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw catalogError(
      "Die erwartete Artikelrevision ist ungültig.",
      "SALES_ARTICLE_REVISION_INVALID",
    );
  }
  return value;
}

function normalizeSalesArticleManualIdentifier(value, index) {
  exactKeys(value, ["identifierValue", "isPrimary"], "Der manuelle Artikel-Identifier");
  return normalizeSalesArticleIdentifier({
    identifierValue: value.identifierValue,
    isPrimary: value.isPrimary === true,
    sourceField: "manual.ean_gtin",
    sourceRank: index,
    sourceProvider: "manual",
  });
}

function normalizeSalesArticleManualPrice(value) {
  exactKeys(
    value,
    ["priceType", "amount", "currency", "priceBasis"],
    "Der manuelle Artikelpreis",
  );
  const normalized = normalizeSalesArticlePrice({
    priceType: value.priceType,
    amount: value.amount,
    currency: value.currency === undefined ? "EUR" : value.currency,
    priceBasis: value.priceBasis === undefined ? "unknown" : value.priceBasis,
    qualityStatus: "confirmed",
    sourceField: `manual.${String(value.priceType || "").trim().toLowerCase()}`,
  });
  if (normalized.amount === null || normalized.amount.startsWith("-")) {
    throw catalogError(
      "Manuell gepflegte Preise müssen nichtnegative Dezimalwerte sein.",
      "PRICE_INVALID",
    );
  }
  return normalized;
}

function normalizeSalesArticleManualPrices(value) {
  if (value === undefined) return undefined;
  exactKeys(value, ["sales", "costs"], "Die manuellen Artikelpreise");
  const result = {};
  for (const group of ["sales", "costs"]) {
    if (!Object.hasOwn(value, group)) continue;
    if (!Array.isArray(value[group])) {
      throw catalogError("Eine Preisgruppe muss eine Liste sein.", "PRICE_INVALID");
    }
    result[group] = Object.freeze(value[group].map(normalizeSalesArticleManualPrice));
    if (new Set(result[group].map((price) => price.priceType)).size !== result[group].length) {
      throw catalogError(
        "Eine manuelle Preisgruppe enthält doppelte Preisarten.",
        "PRICE_INVALID",
      );
    }
  }
  if ([...(result.sales || []), ...(result.costs || [])].length > 128) {
    throw catalogError("Der Artikel enthält zu viele Preise.", "PRICE_INVALID");
  }
  return Object.freeze(result);
}

function normalizeSalesArticleManualIdentifiers(value, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value) || value.length > 32) {
    throw catalogError("Die EAN-/GTIN-Liste des Artikels ist ungültig.", "IDENTIFIER_INVALID");
  }
  const identifiers = value.map(normalizeSalesArticleManualIdentifier);
  if (identifiers.filter((identifier) => identifier.isPrimary).length > 1
    || new Set(identifiers.map((identifier) => identifier.canonicalGtin14)).size
      !== identifiers.length) {
    throw catalogError(
      "Die EAN-/GTIN-Liste enthält doppelte oder widersprüchliche Werte.",
      "IDENTIFIER_INVALID",
    );
  }
  if (identifiers.length && !identifiers.some((identifier) => identifier.isPrimary)) {
    identifiers[0] = Object.freeze({ ...identifiers[0], isPrimary: true });
  }
  return Object.freeze(identifiers);
}

function normalizeSalesArticleManualCreate(value) {
  exactKeys(
    value,
    ["articleNumber", "description", "identifiers", "prices"],
    "Die manuelle Artikelanlage",
  );
  return Object.freeze({
    articleNumber: normalizeSalesArticleNumber(value.articleNumber),
    description: normalizedText(value.description, "Die Artikelbezeichnung", 300),
    identifiers: normalizeSalesArticleManualIdentifiers(value.identifiers),
    prices: normalizeSalesArticleManualPrices(value.prices),
  });
}

function normalizeSalesArticleManualUpdate(value) {
  exactKeys(
    value,
    [
      "currentArticleNumber", "expectedRevision", "articleNumber", "description",
      "identifiers", "prices",
    ],
    "Die manuelle Artikeländerung",
  );
  return Object.freeze({
    ...normalizeSalesArticleManualCreate({
      articleNumber: value.articleNumber,
      description: value.description,
      identifiers: value.identifiers,
      ...(Object.hasOwn(value, "prices") ? { prices: value.prices } : {}),
    }),
    currentArticleNumber: normalizeSalesArticleNumber(value.currentArticleNumber),
    expectedRevision: normalizeSalesArticleExpectedRevision(value.expectedRevision),
  });
}

function normalizeSalesArticleManualCopy(value) {
  exactKeys(
    value,
    [
      "sourceArticleNumber", "expectedRevision", "articleNumber", "description",
      "identifiers", "prices",
    ],
    "Die manuelle Artikelkopie",
  );
  return Object.freeze({
    sourceArticleNumber: normalizeSalesArticleNumber(value.sourceArticleNumber),
    expectedRevision: normalizeSalesArticleExpectedRevision(value.expectedRevision),
    articleNumber: normalizeSalesArticleNumber(value.articleNumber),
    description: value.description === undefined
      ? null
      : normalizedText(value.description, "Die Artikelbezeichnung", 300),
    identifiers: normalizeSalesArticleManualIdentifiers(value.identifiers, { optional: true }),
    prices: normalizeSalesArticleManualPrices(value.prices),
  });
}

function normalizeSalesArticleManualArchive(value) {
  exactKeys(value, ["articleNumber", "expectedRevision"], "Die Artikelarchivierung");
  return Object.freeze({
    articleNumber: normalizeSalesArticleNumber(value.articleNumber),
    expectedRevision: normalizeSalesArticleExpectedRevision(value.expectedRevision),
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function contentRecordForNormalizedArticle(article) {
  return {
    sourceArticleKey: article.sourceArticleKey,
    articleNumber: article.articleNumber,
    description: article.description,
    active: article.active,
    sourceUpdatedAt: article.sourceUpdatedAt,
    identifiers: [...article.identifiers]
      .sort((left, right) => compareText(
        [
          left.canonicalGtin14,
          left.identifierValue,
          left.sourceField,
          String(left.sourceRank ?? ""),
        ].join("\0"),
        [
          right.canonicalGtin14,
          right.identifierValue,
          right.sourceField,
          String(right.sourceRank ?? ""),
        ].join("\0"),
      ))
      .map((identifier) => ({
        identifierType: identifier.identifierType,
        identifierValue: identifier.identifierValue,
        canonicalGtin14: identifier.canonicalGtin14,
        isPrimary: identifier.isPrimary,
        sourceField: identifier.sourceField,
        sourceRank: identifier.sourceRank,
        equivalentIdentifiers: identifier.equivalentIdentifiers || null,
        sourceProvider: identifier.sourceProvider ?? null,
        verifiedAt: identifier.verifiedAt ?? null,
        createdBy: identifier.createdBy ?? null,
        updatedBy: identifier.updatedBy ?? null,
        createdAt: identifier.createdAt ?? null,
        updatedAt: identifier.updatedAt ?? null,
      })),
    sourceMetadata: article.sourceMetadata,
    prices: [...article.prices]
      .sort((left, right) => compareText(
        [left.priceType, left.priceBasis, left.sourceField].join("\0"),
        [right.priceType, right.priceBasis, right.sourceField].join("\0"),
      ))
      .map((price) => ({
        priceType: price.priceType,
        amount: price.amount,
        currency: price.currency,
        priceBasis: price.priceBasis,
        qualityStatus: price.qualityStatus,
        sourceField: price.sourceField,
      })),
  };
}

function contentSha256ForNormalizedArticles(articles) {
  const canonicalArticles = [...articles]
    .sort((left, right) => compareText(
      `${left.sourceArticleKey}\0${left.articleNumber}`,
      `${right.sourceArticleKey}\0${right.articleNumber}`,
    ))
    .map(contentRecordForNormalizedArticle);
  return sha256(JSON.stringify(canonicalArticles));
}

function salesArticleImportContentSha256(articles) {
  if (!Array.isArray(articles) || articles.length > 100000) {
    throw catalogError("Der Artikelimport darf höchstens 100.000 Artikel enthalten.");
  }
  return contentSha256ForNormalizedArticles(articles.map(normalizeSalesArticleImportRow));
}

function normalizeSalesArticleImportSnapshot(value) {
  exactKeys(
    value,
    [
      "sourceSystem", "sourceProfileVersion", "sourceSchemaSha256", "sourceFileSha256",
      "contentSha256", "snapshotAt", "articles",
    ],
    "Der Artikelimport-Snapshot",
  );
  if (!Array.isArray(value.articles) || value.articles.length > 100000) {
    throw catalogError("Der Artikelimport darf höchstens 100.000 Artikel enthalten.");
  }
  const sourceSystem = normalizeSalesArticleSourceSystem(value.sourceSystem);
  const sourceProfileVersion = normalizeSalesArticleSourceProfileVersion(
    value.sourceProfileVersion,
  );
  const sourceSchemaSha256 = normalizeSalesArticleSha256(
    value.sourceSchemaSha256,
    "Der Quellschema-Fingerprint",
  );
  const sourceFileSha256 = normalizeSalesArticleSha256(
    value.sourceFileSha256,
    "Der Quelldatei-Fingerprint",
  );
  const suppliedContentSha256 = normalizeSalesArticleSha256(
    value.contentSha256,
    "Der Inhalts-Fingerprint",
  );
  const snapshotAt = normalizeSalesArticleTimestamp(value.snapshotAt, { label: "Der Snapshot-Zeitpunkt" });
  const articles = value.articles.map(normalizeSalesArticleImportRow);
  const sourceKeys = new Set();
  const articleNumbers = new Set();
  const canonicalIdentifierOwners = new Map();
  for (const article of articles) {
    if (sourceKeys.has(article.sourceArticleKey) || articleNumbers.has(article.articleNumber)) {
      throw catalogError("Der Snapshot enthält doppelte Quellschlüssel oder Artikelnummern.");
    }
    sourceKeys.add(article.sourceArticleKey);
    articleNumbers.add(article.articleNumber);
    for (const identifier of article.identifiers) {
      const owner = canonicalIdentifierOwners.get(identifier.canonicalGtin14);
      if (owner && owner !== article.articleNumber) {
        throw catalogError("Ein EAN-/GTIN-Identifier gehört im Snapshot zu mehr als einem Artikel.");
      }
      canonicalIdentifierOwners.set(identifier.canonicalGtin14, article.articleNumber);
    }
  }
  const contentSha256 = contentSha256ForNormalizedArticles(articles);
  if (contentSha256 !== suppliedContentSha256) {
    throw catalogError(
      "Der Inhalts-Fingerprint stimmt nicht mit dem normalisierten Artikelinhalt überein.",
      "CONTENT_FINGERPRINT_MISMATCH",
    );
  }
  const idempotencyKey = sha256([
    "sales-article-import",
    sourceSystem,
    sourceProfileVersion,
    sourceSchemaSha256,
    sourceFileSha256,
    contentSha256,
  ].join("\0"));
  return Object.freeze({
    id: sha256(`sales-article-snapshot-v1\0${idempotencyKey}`),
    idempotencyKey,
    sourceSystem,
    sourceProfileVersion,
    sourceSchemaSha256,
    sourceFileSha256,
    contentSha256,
    snapshotAt,
    articleCount: articles.length,
    identifierCount: articles.reduce((sum, article) => sum + article.identifiers.length, 0),
    priceCount: articles.reduce((sum, article) => sum + article.prices.length, 0),
    articles: Object.freeze(articles),
  });
}

module.exports = {
  SALES_ARTICLE_IDENTIFIER_TYPES,
  SALES_ARTICLE_PRICE_BASES,
  SALES_ARTICLE_PRICE_QUALITY_STATUSES,
  SALES_ARTICLE_PRICE_TYPES,
  SalesArticleCatalogError,
  canonicalGtin14,
  hasValidGtinChecksum,
  normalizeDecimal12,
  normalizeSalesArticleActor,
  normalizeSalesArticleIdentifier,
  normalizeSalesArticleManualArchive,
  normalizeSalesArticleManualCopy,
  normalizeSalesArticleManualCreate,
  normalizeSalesArticleManualUpdate,
  normalizeSalesArticleExpectedRevision,
  normalizeSalesArticleImportRow,
  normalizeSalesArticleImportSnapshot,
  normalizeSalesArticleNumber,
  normalizeSalesArticleSearch,
  normalizeSalesArticleSha256,
  normalizeSalesArticleSourceKey,
  normalizeSalesArticleSourceMetadata,
  normalizeSalesArticleSourceProfileVersion,
  normalizeSalesArticleSourceSystem,
  normalizeSalesArticleTimestamp,
  SALES_ARTICLE_SEARCH_DEFAULT_LIMIT,
  SALES_ARTICLE_SEARCH_DIRECTIONS,
  SALES_ARTICLE_SEARCH_MAX_LIMIT,
  SALES_ARTICLE_SEARCH_MAX_OFFSET,
  SALES_ARTICLE_SEARCH_SORT_KEYS,
  SALES_ARTICLE_SEARCH_STATUSES,
  salesArticleImportContentSha256,
};
