"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SALES_ARTICLE_PRICE_QUALITY_STATUSES,
  SALES_ARTICLE_PRICE_TYPES,
  SalesArticleCatalogError,
  hasValidGtinChecksum,
  normalizeDecimal12,
  normalizeSalesArticleIdentifier,
  normalizeSalesArticleImportRow,
  normalizeSalesArticleImportSnapshot,
  salesArticleImportContentSha256,
} = require("../lib/sales-article-catalog");

function price(overrides = {}) {
  return {
    priceType: "sales",
    amount: "13.67144267874",
    currency: "EUR",
    priceBasis: "gross",
    qualityStatus: "confirmed",
    sourceField: "Verkaufspreis",
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    sourceArticleKey: "0000000093757",
    articleNumber: "093757",
    description: "Synthetischer Testartikel",
    active: true,
    sourceUpdatedAt: null,
    identifiers: [],
    prices: [price()],
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  const value = {
    sourceSystem: "tradefoto",
    sourceProfileVersion: "tradefoto-article-v1",
    sourceSchemaSha256: "a".repeat(64),
    sourceFileSha256: "f".repeat(64),
    snapshotAt: "2026-09-03T08:00:00.000Z",
    articles: [row()],
    ...overrides,
  };
  return {
    ...value,
    contentSha256: Object.hasOwn(overrides, "contentSha256")
      ? overrides.contentSha256
      : salesArticleImportContentSha256(value.articles),
  };
}

test("Sales-Artikelpreise bleiben verlustfrei als kanonische decimal12-Zeichenfolgen", () => {
  assert.equal(normalizeDecimal12("13.67144267874"), "13.671442678740");
  assert.equal(normalizeDecimal12("+00013.6"), "13.600000000000");
  assert.equal(normalizeDecimal12("0"), "0.000000000000");
  assert.equal(normalizeDecimal12("-0.000"), "0.000000000000");
  assert.equal(normalizeDecimal12(null), null);

  for (const invalid of [13.67144267874, "1.1234567890123", "1e3", "", undefined]) {
    assert.throws(
      () => normalizeDecimal12(invalid),
      (error) => error instanceof SalesArticleCatalogError && error.code === "PRICE_INVALID",
    );
  }
  assert.throws(
    () => normalizeDecimal12("1234567890123456789.0"),
    (error) => error instanceof SalesArticleCatalogError && error.code === "PRICE_INVALID",
  );
});

test("Preistypen und Qualitätsstatus decken den providerneutralen TradeFoto-Kern ab", () => {
  assert.deepEqual(SALES_ARTICLE_PRICE_QUALITY_STATUSES, [
    "confirmed", "inferred", "quarantined", "unresolved",
  ]);
  for (const priceType of [
    "upe", "average_purchase", "list_purchase", "invoice_purchase", "sales",
    "net_net_purchase", "wholesale", "special", "internet_1", "internet_2",
    "internet_3", "internet_4", "internet_5", "zdek", "dek_a", "future_upe",
    "order_purchase", "future_purchase", "calculation", "deposit", "other",
  ]) {
    assert.ok(SALES_ARTICLE_PRICE_TYPES.includes(priceType), `Preisart fehlt: ${priceType}`);
  }
  assert.equal(SALES_ARTICLE_PRICE_TYPES.includes("cash_on_delivery"), false);

  const normalized = normalizeSalesArticleImportRow(row({
    prices: [
      price({ priceType: "internet_2", sourceField: "InternetVK2" }),
      price({
        priceType: "internet_2",
        amount: null,
        priceBasis: "net",
        qualityStatus: "unresolved",
        sourceField: "InternetVKN2",
      }),
      price({
        priceType: "internet_5",
        amount: "-1.25",
        qualityStatus: "quarantined",
        sourceField: "InternetVK5",
      }),
    ],
  }));
  assert.equal(normalized.prices[0].amount, "13.671442678740");
  assert.equal(normalized.prices[1].amount, null);
  assert.equal(normalized.prices[2].amount, "-1.250000000000");

  assert.throws(
    () => normalizeSalesArticleImportRow(row({
      prices: [price({ amount: "-1", qualityStatus: "confirmed" })],
    })),
    (error) => error.code === "PRICE_QUALITY_STATUS_INVALID",
  );
  assert.throws(
    () => normalizeSalesArticleImportRow(row({
      prices: [price(), price({ amount: "14" })],
    })),
    /doppelte oder widersprüchliche Werte/,
  );
});

test("Bis zu 128 Quellpreisfelder sind erlaubt und nur das fachliche Tupel ist eindeutig", () => {
  const manyPrices = Array.from({ length: 128 }, (_, index) => price({
    priceType: "other",
    priceBasis: index % 2 === 0 ? "gross" : "net",
    sourceField: `Quellpreis_${index + 1}`,
  }));
  assert.equal(normalizeSalesArticleImportRow(row({ prices: manyPrices })).prices.length, 128);
  assert.throws(
    () => normalizeSalesArticleImportRow(row({
      prices: [...manyPrices, price({ priceType: "other", sourceField: "Quellpreis_129" })],
    })),
    /Identifier oder Preise/,
  );
});

test("Nur echte checksum-geprüfte GTIN/EAN werden als Identifier angenommen", () => {
  assert.equal(hasValidGtinChecksum("4006381333931"), true);
  assert.equal(hasValidGtinChecksum("4006381333932"), false);
  assert.deepEqual(normalizeSalesArticleIdentifier({
    identifierValue: "4006381333931",
    isPrimary: true,
    sourceField: "EAN",
  }), {
    identifierType: "ean13",
    identifierValue: "4006381333931",
    canonicalGtin14: "04006381333931",
    isPrimary: true,
    sourceField: "EAN",
    sourceRank: null,
  });
  assert.throws(
    () => normalizeSalesArticleIdentifier({
      identifierValue: "0000000093757",
      sourceField: "Artikelnummer",
    }),
    (error) => error.code === "IDENTIFIER_INVALID",
  );
});

test("Äquivalente UPC-, EAN- und GTIN-Darstellungen teilen denselben Vergleichswert", () => {
  const identifiers = [
    ["036000291452", "00036000291452"],
    ["0036000291452", "00036000291452"],
    ["00036000291452", "00036000291452"],
  ].map(([identifierValue, canonicalValue]) => {
    const normalized = normalizeSalesArticleIdentifier({
      identifierValue,
      sourceField: "EAN",
    });
    assert.equal(normalized.canonicalGtin14, canonicalValue);
    return normalized;
  });
  assert.equal(new Set(identifiers.map(({ canonicalGtin14: value }) => value)).size, 1);

  const article = normalizeSalesArticleImportRow(row({ identifiers }));
  assert.equal(article.identifiers.length, 1);
  assert.equal(article.identifiers[0].canonicalGtin14, "00036000291452");
  assert.deepEqual(
    new Set(article.identifiers[0].equivalentIdentifiers.map((entry) => entry.identifierValue)),
    new Set(["036000291452", "0036000291452", "00036000291452"]),
  );
});

test("Import-Snapshots bewahren führende Nullen und machen Quellschlüssel nicht zu EAN", () => {
  const normalized = normalizeSalesArticleImportSnapshot(snapshot());
  assert.equal(normalized.articles[0].sourceArticleKey, "0000000093757");
  assert.equal(normalized.articles[0].articleNumber, "093757");
  assert.deepEqual(normalized.articles[0].identifiers, []);
  assert.equal(normalized.articleCount, 1);
  assert.equal(normalized.identifierCount, 0);
  assert.equal(normalized.priceCount, 1);
  assert.equal(normalized.sourceProfileVersion, "tradefoto-article-v1");
  assert.equal(normalized.sourceFileSha256, "f".repeat(64));
  assert.equal(normalized.contentSha256, salesArticleImportContentSha256(snapshot().articles));
  assert.match(normalized.id, /^[a-f0-9]{64}$/);
  assert.match(normalized.idempotencyKey, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.articles), true);

  const replay = normalizeSalesArticleImportSnapshot(snapshot());
  assert.equal(replay.id, normalized.id);
  assert.equal(replay.idempotencyKey, normalized.idempotencyKey);

  const otherFile = normalizeSalesArticleImportSnapshot(snapshot({
    sourceFileSha256: "e".repeat(64),
  }));
  assert.notEqual(otherFile.idempotencyKey, normalized.idempotencyKey);
  const otherSchema = normalizeSalesArticleImportSnapshot(snapshot({
    sourceSchemaSha256: "c".repeat(64),
  }));
  assert.notEqual(otherSchema.idempotencyKey, normalized.idempotencyKey);
});

test("Inhalts-Fingerprints werden aus kanonischen Artikeldaten berechnet und fail-closed geprüft", () => {
  const articles = [
    row({
      identifiers: [{ identifierValue: "4006381333931", sourceField: "EAN" }],
      prices: [
        price(),
        price({ priceType: "upe", sourceField: "UPE" }),
      ],
    }),
    row({
      sourceArticleKey: "0000000000001",
      articleNumber: "000001",
      description: "Zweiter synthetischer Artikel",
      prices: [],
    }),
  ];
  const reversed = [...articles].reverse().map((article) => ({
    ...article,
    identifiers: [...article.identifiers].reverse(),
    prices: [...article.prices].reverse(),
  }));
  assert.equal(
    salesArticleImportContentSha256(articles),
    salesArticleImportContentSha256(reversed),
  );

  const valid = snapshot({ articles });
  assert.equal(normalizeSalesArticleImportSnapshot(valid).contentSha256, valid.contentSha256);
  assert.throws(
    () => normalizeSalesArticleImportSnapshot(snapshot({
      articles: [{ ...row(), description: "Manipulierter Inhalt" }],
      contentSha256: valid.contentSha256,
    })),
    (error) => error.code === "CONTENT_FINGERPRINT_MISMATCH",
  );
});
