"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  TRADEFOTO_ARTICLE_ALIAS_FIELD,
  TRADEFOTO_ARTICLE_ROW_FIELDS,
  TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION,
  TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS,
  TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS,
  TradeFotoArticleSourceProfileError,
  adaptTradeFotoArticleSourceRow,
  normalizeTradeFotoSourceArticleKey,
} = require("../lib/tradefoto-article-source-profile");

function completeSourceRow(overrides = {}) {
  return {
    EAN: "0000000093757",
    Artikelbezeichnung: "Testobjektiv 50 mm",
    MWST: 1,
    ...Object.fromEntries(TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.map(({ sourceField }) => (
      [sourceField, null]
    ))),
    ...Object.fromEntries(TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS.map(({ sourceField }) => (
      [sourceField, null]
    ))),
    ...overrides,
  };
}

test("TradeFoto-Quellschlüssel bleibt exakt und erzeugt eine sechsstellige Artikelnummer", () => {
  assert.deepEqual(normalizeTradeFotoSourceArticleKey("0000000093757"), {
    sourceArticleKey: "0000000093757",
    articleNumber: "093757",
  });
  assert.deepEqual(normalizeTradeFotoSourceArticleKey("0000000000001"), {
    sourceArticleKey: "0000000000001",
    articleNumber: "000001",
  });

  for (const invalid of [
    "0000000000000",
    "0000001000000",
    "93757",
    "000000009375X",
    93757,
    null,
  ]) {
    assert.throws(
      () => normalizeTradeFotoSourceArticleKey(invalid),
      (error) => error instanceof TradeFotoArticleSourceProfileError
        && error.code === "TRADEFOTO_SOURCE_KEY_INVALID",
    );
  }
});

test("TradeFoto-EAN wird nie zum Barcode; nur valide reale Aliase werden dedupliziert", () => {
  const articleRow = completeSourceRow();
  const result = adaptTradeFotoArticleSourceRow({
    articleRow,
    currency: "EUR",
    aliasRows: [
      { EAN: articleRow.EAN, ZweitEAN: articleRow.EAN, Rang: 1 },
      { EAN: articleRow.EAN, ZweitEAN: "4006381333931", Rang: 2 },
      { EAN: articleRow.EAN, ZweitEAN: "96385074", Rang: 3 },
      { EAN: articleRow.EAN, ZweitEAN: "036000291452", Rang: 4 },
      { EAN: articleRow.EAN, ZweitEAN: "0036000291452", Rang: 5 },
      { EAN: articleRow.EAN, ZweitEAN: "10012345000017", Rang: 6 },
      { EAN: articleRow.EAN, ZweitEAN: "4006381333931", Rang: 7 },
      { EAN: articleRow.EAN, ZweitEAN: "4006381333932", Rang: 8 },
      { EAN: articleRow.EAN, ZweitEAN: "ABC", Rang: 9 },
      { EAN: "0000000000001", ZweitEAN: "036000291452", Rang: 10 },
      { EAN: articleRow.EAN, ZweitEAN: 4006381333931, Rang: 11 },
    ],
  });

  assert.equal(result.importRow.sourceArticleKey, "0000000093757");
  assert.equal(result.importRow.articleNumber, "093757");
  assert.equal(result.sourceProfileVersion, TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION);
  assert.equal(result.importRow.active, false);
  assert.deepEqual(
    result.importRow.identifiers.map(({ identifierType, identifierValue }) => (
      [identifierType, identifierValue]
    )),
    [
      ["ean13", "4006381333931"],
      ["ean8", "96385074"],
      ["upca", "036000291452"],
      ["gtin14", "10012345000017"],
    ],
  );
  assert.equal(
    result.importRow.identifiers.some(({ identifierValue }) => identifierValue === articleRow.EAN),
    false,
  );
  assert.deepEqual(
    result.importRow.identifiers.map(({ canonicalGtin14, isPrimary, sourceRank }) => (
      [canonicalGtin14, isPrimary, sourceRank]
    )),
    [
      ["04006381333931", true, 2],
      ["00000096385074", false, 3],
      ["00036000291452", false, 4],
      ["10012345000017", false, 6],
    ],
  );
  assert.deepEqual(
    result.ignoredAliases.map(({ code }) => code),
    [
      "source_key_self_alias",
      "duplicate_canonical_identifier_within_article",
      "duplicate_canonical_identifier_within_article",
    ],
  );
  assert.deepEqual(
    result.quarantine.identifiers.map(({ code }) => code),
    [
      "alias_gtin_checksum_invalid",
      "alias_not_supported_gtin_shape",
      "alias_source_key_mismatch",
      "alias_not_exact_text",
    ],
  );
});

test("TradeFoto-Preise bleiben decimal12, null bleibt null und Negative werden quarantänisiert", () => {
  const result = adaptTradeFotoArticleSourceRow({
    articleRow: completeSourceRow({
      UPE: "1299.9",
      Verkaufspreis: "0",
      InternetVK5: "-100",
      eNvk: "1083.250000000001",
      Provision: "12.5",
    }),
    aliasRows: [],
    currency: "EUR",
  });

  assert.equal(result.importRow.prices.length, TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.length);
  const byField = Object.fromEntries(result.importRow.prices.map((price) => [price.sourceField, price]));
  assert.deepEqual(byField.UPE, {
    priceType: "upe",
    amount: "1299.900000000000",
    currency: "EUR",
    priceBasis: "gross",
    qualityStatus: "inferred",
    sourceField: "UPE",
  });
  assert.equal(byField.Verkaufspreis.amount, "0.000000000000");
  assert.equal(byField.Großhandelspreis.amount, null);
  assert.equal(byField.Großhandelspreis.priceBasis, "unknown");
  assert.equal(byField.Großhandelspreis.qualityStatus, "unresolved");
  assert.equal(byField.InternetVK5.qualityStatus, "quarantined");
  assert.deepEqual(result.quarantine.prices, [{
    code: "negative_price_requires_review",
    sourceField: "InternetVK5",
    amount: "-100.000000000000",
    currency: "EUR",
  }]);
  assert.equal(byField.eNvk.amount, "1083.250000000001");
  assert.equal(result.excludedFields.find(({ sourceField }) => sourceField === "Provision").sourceValue, "12.5");
  assert.equal(byField.Provision, undefined);
});

test("TradeFoto-Adapter verlangt explizite Währung, vollständige Felder und exakte Preisstrings", () => {
  const base = { articleRow: completeSourceRow(), aliasRows: [] };
  for (const currency of [undefined, "", "eur", "EURO", null]) {
    assert.throws(
      () => adaptTradeFotoArticleSourceRow({ ...base, currency }),
      (error) => error instanceof TradeFotoArticleSourceProfileError
        && error.code === "TRADEFOTO_CURRENCY_REQUIRED",
    );
  }

  const missing = completeSourceRow();
  delete missing.UPE;
  assert.throws(
    () => adaptTradeFotoArticleSourceRow({ articleRow: missing, aliasRows: [], currency: "EUR" }),
    (error) => error.code === "TRADEFOTO_PRICE_FIELD_MISSING",
  );
  for (const invalidValue of [12.5, " 12.5", "1e3", "1.1234567890123", undefined]) {
    assert.throws(
      () => adaptTradeFotoArticleSourceRow({
        articleRow: completeSourceRow({ UPE: invalidValue }),
        aliasRows: [],
        currency: "EUR",
      }),
      (error) => error instanceof TradeFotoArticleSourceProfileError
        && error.code === "TRADEFOTO_PRICE_VALUE_INVALID",
    );
  }
  assert.throws(
    () => adaptTradeFotoArticleSourceRow({
      articleRow: completeSourceRow({ NeueUngeprüfteSpalte: "Drift" }),
      aliasRows: [],
      currency: "EUR",
    }),
    (error) => error instanceof TradeFotoArticleSourceProfileError
      && error.code === "TRADEFOTO_ARTICLE_SOURCE_INVALID",
  );
  assert.throws(
    () => adaptTradeFotoArticleSourceRow({
      articleRow: completeSourceRow(),
      aliasRows: [{
        EAN: "0000000093757",
        ZweitEAN: "4006381333931",
        Rang: 1,
        NeueUngeprüfteSpalte: "Drift",
      }],
      currency: "EUR",
    }),
    (error) => error instanceof TradeFotoArticleSourceProfileError
      && error.code === "TRADEFOTO_ARTICLE_SOURCE_INVALID",
  );
});

test("nicht-monetäre TradeFoto-Felder sind explizit dokumentiert und nie Preiszeilen", () => {
  assert.equal(TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION, "tradefoto-article-v1");
  assert.equal(TRADEFOTO_ARTICLE_ROW_FIELDS.length, 46);
  assert.equal(new Set(TRADEFOTO_ARTICLE_ROW_FIELDS).size, TRADEFOTO_ARTICLE_ROW_FIELDS.length);
  assert.deepEqual(
    TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS.map(({ sourceField }) => sourceField),
    [
      "Provision", "SOnderRoh", "WKZ", "PVers", "GVKKosten", "IVKKosten", "VKKostenP",
      "VAufschlag",
    ],
  );
  assert.equal(new Set(TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.map(({ sourceField }) => sourceField)).size, 35);
  assert.equal(
    TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.some(({ sourceField }) => (
      TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS.some((excluded) => excluded.sourceField === sourceField)
    )),
    false,
  );
});
