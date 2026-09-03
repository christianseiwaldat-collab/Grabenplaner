"use strict";

const {
  normalizeDecimal12,
  normalizeSalesArticleIdentifier,
  normalizeSalesArticleImportRow,
} = require("./sales-article-catalog");

const TRADEFOTO_ARTICLE_SOURCE_SYSTEM = "tradefoto.artikel_stamm";
const TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION = "tradefoto-article-v1";
const TRADEFOTO_ARTICLE_SOURCE_KEY_FIELD = "ARTIKEL_STAMM.EAN";
const TRADEFOTO_ARTICLE_ALIAS_FIELD = "ARTIKEL_ZWEITEAN.ZweitEAN";

function frozenMapping(sourceField, priceType, priceBasis, qualityStatus) {
  return Object.freeze({ sourceField, priceType, priceBasis, qualityStatus });
}

// Access DOUBLE values must be extracted as decimal text before entering this adapter.
// Mappings marked unresolved deliberately do not infer semantics from historic field names.
const TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS = Object.freeze([
  frozenMapping("UPE", "upe", "gross", "inferred"),
  frozenMapping("Verkaufspreis", "sales", "gross", "inferred"),
  frozenMapping("Großhandelspreis", "wholesale", "unknown", "unresolved"),
  frozenMapping("Internet_VK", "internet_1", "gross", "inferred"),
  frozenMapping("ZukunftsUVP", "future_upe", "gross", "inferred"),
  frozenMapping("InternetVK2", "internet_2", "gross", "inferred"),
  frozenMapping("InternetVKN2", "internet_2", "net", "inferred"),
  frozenMapping("InternetVK3", "internet_3", "gross", "inferred"),
  frozenMapping("InternetVKN3", "internet_3", "net", "inferred"),
  frozenMapping("InternetVK4", "internet_4", "gross", "inferred"),
  frozenMapping("InternetVKN4", "internet_4", "net", "inferred"),
  frozenMapping("InternetVK5", "internet_5", "gross", "inferred"),
  frozenMapping("InternetVKN5", "internet_5", "net", "inferred"),
  frozenMapping("eNvk", "sales", "net", "inferred"),
  frozenMapping("Invk", "internet_1", "net", "inferred"),
  frozenMapping("GNVK", "wholesale", "unknown", "unresolved"),
  frozenMapping("DurchschnittEK", "average_purchase", "unknown", "unresolved"),
  frozenMapping("Listeneckpreis", "list_purchase", "unknown", "unresolved"),
  frozenMapping("Rechnungspreis", "invoice_purchase", "unknown", "unresolved"),
  frozenMapping("NNPreis", "net_net_purchase", "unknown", "unresolved"),
  frozenMapping("SonderPreis", "special", "unknown", "unresolved"),
  frozenMapping("EKBestell", "order_purchase", "unknown", "unresolved"),
  frozenMapping("ListeneckpreisZu", "future_purchase", "unknown", "unresolved"),
  frozenMapping("RechnungspreisZu", "future_purchase", "unknown", "unresolved"),
  frozenMapping("NNPreisZu", "future_purchase", "unknown", "unresolved"),
  frozenMapping("SonderPreisZu", "future_purchase", "unknown", "unresolved"),
  frozenMapping("ZDEK", "zdek", "unknown", "unresolved"),
  frozenMapping("DEK_A", "dek_a", "unknown", "unresolved"),
  frozenMapping("Pfand", "deposit", "unknown", "unresolved"),
  frozenMapping("EuroEk", "average_purchase", "unknown", "unresolved"),
  frozenMapping("EuroVK", "sales", "unknown", "unresolved"),
  frozenMapping("VertragsVK", "sales", "unknown", "unresolved"),
  frozenMapping("RVK", "other", "unknown", "unresolved"),
  frozenMapping("REVK", "other", "unknown", "unresolved"),
  frozenMapping("VWien", "other", "unknown", "unresolved"),
]);

const TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS = Object.freeze([
  "Provision",
  "SOnderRoh",
  "WKZ",
  "PVers",
  "GVKKosten",
  "IVKKosten",
  "VKKostenP",
  "VAufschlag",
].map((sourceField) => Object.freeze({
  sourceField,
  disposition: "excluded_non_monetary_rate_or_calculation",
  reason: "Kein qualitätsgesicherter Währungsbetrag im TradeFoto-Quellmodell.",
})));
const TRADEFOTO_ARTICLE_ROW_FIELDS = Object.freeze([
  "EAN",
  "Artikelbezeichnung",
  ...TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.map(({ sourceField }) => sourceField),
  ...TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS.map(({ sourceField }) => sourceField),
]);

class TradeFotoArticleSourceProfileError extends Error {
  constructor(message, code = "TRADEFOTO_ARTICLE_SOURCE_INVALID", cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = "TradeFotoArticleSourceProfileError";
    this.code = code;
  }
}

function profileError(message, code, cause) {
  return new TradeFotoArticleSourceProfileError(message, code, cause);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertOnlyKeys(value, allowed, label) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw profileError(`${label} enthält unbekannte oder ungültige Felder.`);
  }
}

function normalizeTradeFotoSourceArticleKey(value) {
  if (typeof value !== "string" || !/^\d{13}$/.test(value)) {
    throw profileError(
      `${TRADEFOTO_ARTICLE_SOURCE_KEY_FIELD} muss als exakte 13-stellige Zeichenfolge vorliegen.`,
      "TRADEFOTO_SOURCE_KEY_INVALID",
    );
  }
  const numericValue = BigInt(value);
  if (numericValue < 1n || numericValue > 999999n) {
    throw profileError(
      `${TRADEFOTO_ARTICLE_SOURCE_KEY_FIELD} liegt außerhalb 1 bis 999999.`,
      "TRADEFOTO_SOURCE_KEY_INVALID",
    );
  }
  return Object.freeze({
    sourceArticleKey: value,
    articleNumber: numericValue.toString().padStart(6, "0"),
  });
}

function normalizeExplicitCurrency(value) {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
    throw profileError(
      "Die Importwährung muss ausdrücklich als dreistelliger Großbuchstaben-Code angegeben werden.",
      "TRADEFOTO_CURRENCY_REQUIRED",
    );
  }
  return value;
}

function sourceValueForAudit(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return Object.prototype.toString.call(value);
}

function quarantineIdentifier(aliasIndex, code, identifierValue, sourceArticleKey = null) {
  return Object.freeze({
    aliasIndex,
    code,
    sourceArticleKey: sourceValueForAudit(sourceArticleKey),
    identifierValue: sourceValueForAudit(identifierValue),
  });
}

function adaptIdentifiers(sourceArticleKey, aliasRows) {
  if (!Array.isArray(aliasRows) || aliasRows.length > 256) {
    throw profileError(
      "Die TradeFoto-Zweit-EAN-Liste ist ungültig oder zu groß.",
      "TRADEFOTO_ALIASES_INVALID",
    );
  }
  const candidates = [];
  const identifiers = [];
  const quarantined = [];
  const ignored = [];

  aliasRows.forEach((aliasRow, aliasIndex) => {
    if (!isPlainRecord(aliasRow)) {
      quarantined.push(quarantineIdentifier(aliasIndex, "alias_row_invalid", aliasRow));
      return;
    }
    assertOnlyKeys(
      aliasRow,
      ["EAN", "ZweitEAN", "Rang"],
      "Der TradeFoto-Zweit-EAN-Satz",
    );
    const parentSourceKey = aliasRow.EAN;
    const identifierValue = aliasRow.ZweitEAN;
    if (!hasOwn(aliasRow, "EAN") || !hasOwn(aliasRow, "ZweitEAN")) {
      quarantined.push(quarantineIdentifier(
        aliasIndex,
        "alias_fields_missing",
        identifierValue,
        parentSourceKey,
      ));
      return;
    }
    if (parentSourceKey !== sourceArticleKey) {
      quarantined.push(quarantineIdentifier(
        aliasIndex,
        "alias_source_key_mismatch",
        identifierValue,
        parentSourceKey,
      ));
      return;
    }
    if (identifierValue === sourceArticleKey) {
      ignored.push(Object.freeze({
        aliasIndex,
        code: "source_key_self_alias",
        identifierValue,
      }));
      return;
    }
    if (typeof identifierValue !== "string") {
      quarantined.push(quarantineIdentifier(
        aliasIndex,
        "alias_not_exact_text",
        identifierValue,
        parentSourceKey,
      ));
      return;
    }
    if (!/^\d+$/.test(identifierValue) || ![8, 12, 13, 14].includes(identifierValue.length)) {
      quarantined.push(quarantineIdentifier(
        aliasIndex,
        "alias_not_supported_gtin_shape",
        identifierValue,
        parentSourceKey,
      ));
      return;
    }
    if (!Number.isSafeInteger(aliasRow.Rang) || aliasRow.Rang < 0 || aliasRow.Rang > 255) {
      quarantined.push(quarantineIdentifier(
        aliasIndex,
        "alias_rank_invalid",
        identifierValue,
        parentSourceKey,
      ));
      return;
    }
    let identifier;
    try {
      identifier = normalizeSalesArticleIdentifier({
        identifierValue,
        isPrimary: false,
        sourceField: TRADEFOTO_ARTICLE_ALIAS_FIELD,
        sourceRank: aliasRow.Rang,
      });
    } catch {
      quarantined.push(quarantineIdentifier(
        aliasIndex,
        "alias_gtin_checksum_invalid",
        identifierValue,
        parentSourceKey,
      ));
      return;
    }
    candidates.push(Object.freeze({ aliasIndex, identifier }));
  });

  candidates.sort((left, right) => (
    left.identifier.sourceRank - right.identifier.sourceRank
      || left.identifier.canonicalGtin14.localeCompare(right.identifier.canonicalGtin14)
      || left.identifier.identifierValue.localeCompare(right.identifier.identifierValue)
      || left.aliasIndex - right.aliasIndex
  ));
  const seenCanonical = new Set();
  candidates.forEach(({ aliasIndex, identifier }) => {
    if (seenCanonical.has(identifier.canonicalGtin14)) {
      ignored.push(Object.freeze({
        aliasIndex,
        code: "duplicate_canonical_identifier_within_article",
        identifierValue: identifier.identifierValue,
        canonicalGtin14: identifier.canonicalGtin14,
      }));
      return;
    }
    seenCanonical.add(identifier.canonicalGtin14);
    identifiers.push(normalizeSalesArticleIdentifier({
      ...identifier,
      isPrimary: identifiers.length === 0,
    }));
  });

  return Object.freeze({
    identifiers: Object.freeze(identifiers),
    quarantined: Object.freeze(quarantined),
    ignored: Object.freeze(ignored),
  });
}

function assertExactDecimalSourceValue(sourceField, value) {
  if (value !== null && typeof value !== "string") {
    throw profileError(
      `${sourceField} muss vor dem Mapping als exakte Dezimalzeichenfolge oder null vorliegen.`,
      "TRADEFOTO_PRICE_VALUE_INVALID",
    );
  }
  if (typeof value === "string" && value !== value.trim()) {
    throw profileError(
      `${sourceField} enthält nicht erlaubte Rand-Leerzeichen.`,
      "TRADEFOTO_PRICE_VALUE_INVALID",
    );
  }
}

function adaptPrices(articleRow, currency) {
  const prices = [];
  const quarantined = [];
  for (const mapping of TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS) {
    if (!hasOwn(articleRow, mapping.sourceField)) {
      throw profileError(
        `Das erforderliche Preisfeld ${mapping.sourceField} fehlt im TradeFoto-Quellsatz.`,
        "TRADEFOTO_PRICE_FIELD_MISSING",
      );
    }
    const sourceValue = articleRow[mapping.sourceField];
    assertExactDecimalSourceValue(mapping.sourceField, sourceValue);
    let amount;
    try {
      amount = normalizeDecimal12(sourceValue);
    } catch (cause) {
      throw profileError(
        `${mapping.sourceField} kann nicht verlustfrei als decimal12 übernommen werden.`,
        "TRADEFOTO_PRICE_VALUE_INVALID",
        cause,
      );
    }
    const isNegative = typeof amount === "string" && amount.startsWith("-");
    const qualityStatus = isNegative ? "quarantined" : mapping.qualityStatus;
    const price = Object.freeze({
      priceType: mapping.priceType,
      amount,
      currency,
      priceBasis: mapping.priceBasis,
      qualityStatus,
      sourceField: mapping.sourceField,
    });
    prices.push(price);
    if (isNegative) {
      quarantined.push(Object.freeze({
        code: "negative_price_requires_review",
        sourceField: mapping.sourceField,
        amount,
        currency,
      }));
    }
  }
  return Object.freeze({
    prices: Object.freeze(prices),
    quarantined: Object.freeze(quarantined),
  });
}

function excludedFieldAudit(articleRow) {
  return Object.freeze(TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS.map((definition) => {
    const present = hasOwn(articleRow, definition.sourceField);
    const sourceValue = present ? articleRow[definition.sourceField] : null;
    if (present) assertExactDecimalSourceValue(definition.sourceField, sourceValue);
    return Object.freeze({
      ...definition,
      present,
      sourceValue,
    });
  }));
}

function adaptTradeFotoArticleSourceRow(value) {
  assertOnlyKeys(value, ["articleRow", "aliasRows", "currency"], "Der TradeFoto-Adapteraufruf");
  const { articleRow } = value;
  if (!isPlainRecord(articleRow)) {
    throw profileError("Der TradeFoto-Artikelsatz ist ungültig.");
  }
  assertOnlyKeys(articleRow, TRADEFOTO_ARTICLE_ROW_FIELDS, "Der TradeFoto-Artikelsatz");
  if (!hasOwn(articleRow, "EAN") || !hasOwn(articleRow, "Artikelbezeichnung")) {
    throw profileError("EAN oder Artikelbezeichnung fehlt im TradeFoto-Artikelsatz.");
  }
  if (typeof articleRow.Artikelbezeichnung !== "string") {
    throw profileError("Die TradeFoto-Artikelbezeichnung muss Text sein.");
  }

  const currency = normalizeExplicitCurrency(value.currency);
  const key = normalizeTradeFotoSourceArticleKey(articleRow.EAN);
  const identifierResult = adaptIdentifiers(
    key.sourceArticleKey,
    value.aliasRows === undefined ? [] : value.aliasRows,
  );
  const priceResult = adaptPrices(articleRow, currency);
  const importRow = normalizeSalesArticleImportRow({
    sourceArticleKey: key.sourceArticleKey,
    articleNumber: key.articleNumber,
    description: articleRow.Artikelbezeichnung,
    // Lifecycle semantics in the legacy source are not yet safe enough for automatic activation.
    active: false,
    sourceUpdatedAt: null,
    identifiers: identifierResult.identifiers,
    prices: priceResult.prices,
  });

  return Object.freeze({
    sourceSystem: TRADEFOTO_ARTICLE_SOURCE_SYSTEM,
    sourceProfileVersion: TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION,
    importRow,
    quarantine: Object.freeze({
      identifiers: identifierResult.quarantined,
      prices: priceResult.quarantined,
    }),
    ignoredAliases: identifierResult.ignored,
    excludedFields: excludedFieldAudit(articleRow),
  });
}

module.exports = {
  TRADEFOTO_ARTICLE_ALIAS_FIELD,
  TRADEFOTO_ARTICLE_ROW_FIELDS,
  TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION,
  TRADEFOTO_ARTICLE_SOURCE_KEY_FIELD,
  TRADEFOTO_ARTICLE_SOURCE_SYSTEM,
  TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS,
  TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS,
  TradeFotoArticleSourceProfileError,
  adaptTradeFotoArticleSourceRow,
  normalizeTradeFotoSourceArticleKey,
};
