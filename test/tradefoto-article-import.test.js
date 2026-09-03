"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  TRADEFOTO_ARTICLE_ALIAS_ROW_FIELDS,
  TRADEFOTO_ARTICLE_IMPORT_FORMAT,
  TRADEFOTO_ARTICLE_ROW_FIELDS,
  TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION,
  TRADEFOTO_ARTICLE_SOURCE_SCHEMA_SHA256,
  TRADEFOTO_ARTICLE_SOURCE_SYSTEM,
  TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS,
  TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS,
} = require("../lib/tradefoto-article-source-profile");
const {
  TRADEFOTO_ARTICLE_IMPORT_MAX_BYTES,
  TRADEFOTO_ARTICLE_IMPORT_MAX_ROWS,
  TRADEFOTO_ARTICLE_IMPORT_MAX_WORK_UNITS,
  TRADEFOTO_ARTICLE_IMPORT_MIME_TYPE,
  TradeFotoArticleImportError,
  grossNetGateIssues,
  inspectTradeFotoArticleImportBuffer,
  sanitizedTradeFotoImportFilename,
} = require("../lib/tradefoto-article-import");

function sourceRow(sourceArticleKey = "0000000093757", overrides = {}) {
  const row = {
    EAN: sourceArticleKey,
    Artikelbezeichnung: "Synthetischer TradeFoto-Artikel",
    MWST: 1,
  };
  for (const { sourceField } of TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS) {
    row[sourceField] = null;
  }
  for (const { sourceField } of TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS) {
    row[sourceField] = null;
  }
  return { ...row, ...overrides };
}

function payload(articles = [{ articleRow: sourceRow(), aliasRows: [] }], overrides = {}) {
  return {
    format: TRADEFOTO_ARTICLE_IMPORT_FORMAT,
    sourceSystem: TRADEFOTO_ARTICLE_SOURCE_SYSTEM,
    sourceProfileVersion: TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION,
    sourceSchemaSha256: TRADEFOTO_ARTICLE_SOURCE_SCHEMA_SHA256,
    snapshotAt: "2026-09-03T13:00:00.000Z",
    currency: "EUR",
    articles,
    ...overrides,
  };
}

function inspect(value, options = {}) {
  return inspectTradeFotoArticleImportBuffer(
    Buffer.from(JSON.stringify(value), "utf8"),
    { fileName: options.fileName || "TradeFoto-Artikel.json" },
  );
}

function importCode(code, status = 422) {
  return (error) => error instanceof TradeFotoArticleImportError
    && error.code === code
    && error.status === status;
}

function grossNetRow(overrides = {}) {
  const row = { MWST: 1 };
  for (const [gross, net] of [
    ["Verkaufspreis", "eNvk"],
    ["Internet_VK", "Invk"],
    ["InternetVK2", "InternetVKN2"],
    ["InternetVK3", "InternetVKN3"],
    ["InternetVK4", "InternetVKN4"],
    ["InternetVK5", "InternetVKN5"],
  ]) {
    row[gross] = null;
    row[net] = null;
  }
  return { ...row, ...overrides };
}

test("TradeFoto-Dateivertrag ist versioniert, reproduzierbar und hart begrenzt", () => {
  assert.equal(TRADEFOTO_ARTICLE_IMPORT_MIME_TYPE, "application/vnd.grabenplaner.tradefoto-articles+json");
  assert.equal(TRADEFOTO_ARTICLE_IMPORT_MAX_BYTES, 64 * 1024 * 1024);
  assert.equal(TRADEFOTO_ARTICLE_IMPORT_MAX_ROWS, 25000);
  assert.equal(TRADEFOTO_ARTICLE_IMPORT_MAX_WORK_UNITS, 750000);
  assert.equal(TRADEFOTO_ARTICLE_IMPORT_FORMAT, "grabenplaner.tradefoto.article-catalog.v1");
  assert.equal(TRADEFOTO_ARTICLE_SOURCE_SYSTEM, "tradefoto.artikel_stamm");
  assert.equal(TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION, "tradefoto-article-v1");
  assert.match(TRADEFOTO_ARTICLE_SOURCE_SCHEMA_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(TRADEFOTO_ARTICLE_ROW_FIELDS.length, 46);
  assert.deepEqual(TRADEFOTO_ARTICLE_ALIAS_ROW_FIELDS, ["EAN", "ZweitEAN", "Rang"]);
  assert.equal(new Set(TRADEFOTO_ARTICLE_ROW_FIELDS).size, TRADEFOTO_ARTICLE_ROW_FIELDS.length);
});

test("Dateinamen verlieren lokale Pfade und ungültige Namen scheitern geschlossen", () => {
  assert.equal(
    sanitizedTradeFotoImportFilename("C:\\Users\\privat\\TradeFoto-Artikel.json"),
    "TradeFoto-Artikel.json",
  );
  assert.equal(
    sanitizedTradeFotoImportFilename("/srv/private/TradeFoto-Artikel.JSON"),
    "TradeFoto-Artikel.JSON",
  );
  for (const invalid of ["ohne-endung", "datei.csv", "steuer\u0000.json", `${"a".repeat(157)}.json`]) {
    assert.throws(
      () => sanitizedTradeFotoImportFilename(invalid),
      (error) => error instanceof TradeFotoArticleImportError,
    );
  }
});

test("Parser akzeptiert nur exaktes UTF-8, exaktes Schema und höchstens 25.000 Zeilen", () => {
  assert.throws(
    () => inspectTradeFotoArticleImportBuffer(Buffer.from([0xc3, 0x28]), { fileName: "invalid.json" }),
    importCode("SALES_ARTICLE_IMPORT_JSON_INVALID"),
  );
  assert.throws(
    () => inspect({ ...payload(), unbekannt: true }),
    importCode("SALES_ARTICLE_IMPORT_SCHEMA_MISMATCH"),
  );
  assert.throws(
    () => inspect(payload(undefined, { sourceSchemaSha256: "0".repeat(64) })),
    importCode("SALES_ARTICLE_IMPORT_SCHEMA_MISMATCH"),
  );
  assert.throws(
    () => inspect(payload([{ articleRow: { ...sourceRow(), Fremdfeld: "Drift" }, aliasRows: [] }])),
    importCode("SALES_ARTICLE_IMPORT_SCHEMA_MISMATCH"),
  );
  assert.throws(
    () => inspect(payload([{ articleRow: sourceRow(), aliasRows: [{ EAN: "1", ZweitEAN: "2", Rang: 1, Drift: true }] }])),
    importCode("SALES_ARTICLE_IMPORT_SCHEMA_MISMATCH"),
  );
  assert.throws(
    () => inspect(payload(Array.from({ length: 25001 }, () => ({})))),
    importCode("SALES_ARTICLE_IMPORT_ROW_LIMIT", 413),
  );
});

test("Brutto-Netto-Gate rechnet alle analysierten MWST-Codes centgenau und quarantänisiert unbekannte Codes", () => {
  for (const [MWST, gross] of [
    [0, "100"],
    [1, "120.000000000000"],
    [2, "110.0"],
    [3, "119"],
    [4, "107.000000000000"],
  ]) {
    assert.deepEqual(grossNetGateIssues(grossNetRow({
      MWST,
      Verkaufspreis: gross,
      eNvk: "100.0",
    })), [], `MWST-Code ${MWST}`);
  }
  for (const [MWST, wrongGross] of [
    [0, "100.02"],
    [1, "120.02"],
    [2, "110.02"],
    [3, "119.02"],
    [4, "107.02"],
  ]) {
    assert.deepEqual(grossNetGateIssues(grossNetRow({
      MWST,
      Verkaufspreis: wrongGross,
      eNvk: "100",
    })), [{ code: "gross_net_mismatch", pair: "Verkaufspreis/eNvk" }], `MWST-Code ${MWST}`);
  }
  assert.deepEqual(grossNetGateIssues(grossNetRow({
    Verkaufspreis: "120.010000000000",
    eNvk: "100.000000000000",
  })), []);
  assert.deepEqual(grossNetGateIssues(grossNetRow({
    Verkaufspreis: "120.020000000000",
    eNvk: "100.000000000000",
  })), [{ code: "gross_net_mismatch", pair: "Verkaufspreis/eNvk" }]);
  assert.deepEqual(grossNetGateIssues(grossNetRow({
    Verkaufspreis: "1.210000000000",
    eNvk: "1.004170000000",
  })), []);
  for (const MWST of [null, 5, -1, "1"]) {
    assert.deepEqual(grossNetGateIssues(grossNetRow({ MWST })), [
      { code: "tax_code_unknown", pair: null },
    ]);
  }
  assert.deepEqual(grossNetGateIssues(grossNetRow({
    Verkaufspreis: "120.000000000000",
  })), [{ code: "gross_net_pair_incomplete", pair: "Verkaufspreis/eNvk" }]);
  assert.deepEqual(grossNetGateIssues(grossNetRow({
    eNvk: "100.000000000000",
  })), [{ code: "gross_net_pair_incomplete", pair: "Verkaufspreis/eNvk" }]);
  assert.deepEqual(grossNetGateIssues(grossNetRow({
    Verkaufspreis: "121",
    eNvk: "100.0",
  })), [{ code: "gross_net_mismatch", pair: "Verkaufspreis/eNvk" }]);
  assert.deepEqual(grossNetGateIssues(grossNetRow({
    Verkaufspreis: "120",
  })), [{ code: "gross_net_pair_incomplete", pair: "Verkaufspreis/eNvk" }]);
});

test("Inspektion trennt sichere und blockierte Zeilen ohne Rohwerte in Findings", () => {
  const secretAmount = "9876.543210123456";
  const result = inspect(payload([
    {
      articleRow: sourceRow("0000000093757", { DurchschnittEK: secretAmount }),
      aliasRows: [{ EAN: "0000000093757", ZweitEAN: "4006381333931", Rang: 1 }],
    },
    {
      articleRow: sourceRow("0000000093758", { DurchschnittEK: "-100" }),
      aliasRows: [],
    },
  ]), { fileName: "C:\\private\\TradeFoto.json" });

  assert.equal(result.source.fileName, "TradeFoto.json");
  assert.match(result.source.fileSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.source.articleCount, 2);
  assert.equal(result.normalizedArticles.length, 1);
  assert.equal(result.normalizedArticles[0].articleNumber, "093757");
  assert.equal(result.normalizedArticles[0].active, true);
  assert.deepEqual(result.rows.map(({ action }) => action), ["ready", "blocked"]);
  assert.deepEqual(result.rows[1].issueCodes, ["negative_price"]);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(Object.keys(result.findings[0]).sort(), [
    "articleNumber", "code", "detailSha256", "rowNumber",
  ]);
  const publicInspectionEvidence = JSON.stringify({
    source: result.source,
    rows: result.rows,
    findings: result.findings,
  });
  assert.equal(publicInspectionEvidence.includes(secretAmount), false);
  assert.equal(publicInspectionEvidence.includes("-100"), false);
  assert.equal(publicInspectionEvidence.includes("private"), false);
});

test("Dateiinterne Quell-, Nummern- und GTIN-Duplikate blockieren alle Beteiligten, aber nicht die sichere Teilmenge", () => {
  const sharedGtin = "4006381333931";
  const result = inspect(payload([
    { articleRow: sourceRow("0000000093800"), aliasRows: [] },
    { articleRow: sourceRow("0000000093800"), aliasRows: [] },
    {
      articleRow: sourceRow("0000000093801"),
      aliasRows: [{ EAN: "0000000093801", ZweitEAN: sharedGtin, Rang: 1 }],
    },
    {
      articleRow: sourceRow("0000000093802"),
      aliasRows: [{ EAN: "0000000093802", ZweitEAN: sharedGtin, Rang: 1 }],
    },
    {
      articleRow: sourceRow("0000000093803", { DurchschnittEK: "-100" }),
      aliasRows: [{ EAN: "0000000093803", ZweitEAN: "9780306406157", Rang: 1 }],
    },
    {
      articleRow: sourceRow("0000000093804"),
      aliasRows: [{ EAN: "0000000093804", ZweitEAN: "9780306406157", Rang: 1 }],
    },
    { articleRow: sourceRow("0000000093805"), aliasRows: [] },
  ]));

  assert.deepEqual(result.rows.map(({ action }) => action), [
    "blocked", "blocked", "blocked", "blocked", "blocked", "blocked", "ready",
  ]);
  for (const row of result.rows.slice(0, 2)) {
    assert.deepEqual(row.issueCodes, ["duplicate_article_number", "duplicate_source_key"]);
  }
  for (const row of result.rows.slice(2, 4)) {
    assert.deepEqual(row.issueCodes, ["duplicate_gtin"]);
  }
  assert.deepEqual(result.rows[4].issueCodes, ["duplicate_gtin", "negative_price"]);
  assert.deepEqual(result.rows[5].issueCodes, ["duplicate_gtin"]);
  assert.deepEqual(result.normalizedArticles.map(({ articleNumber }) => articleNumber), ["093805"]);
  assert.equal(result.findings.length, 9);
});

test("Dateiinterne Identitätskonflikte bleiben auch bei einem vollständigen Adapterfehler symmetrisch blockiert", () => {
  const sharedGtin = "9780306406157";
  const result = inspect(payload([
    {
      articleRow: sourceRow("0000000093810", { DurchschnittEK: "kein-preis" }),
      aliasRows: [],
    },
    { articleRow: sourceRow("0000000093810"), aliasRows: [] },
    {
      articleRow: sourceRow("0000000093811", { DurchschnittEK: "kein-preis" }),
      aliasRows: [{ EAN: "0000000093811", ZweitEAN: sharedGtin, Rang: 1 }],
    },
    {
      articleRow: sourceRow("0000000093812"),
      aliasRows: [{ EAN: "0000000093812", ZweitEAN: sharedGtin, Rang: 1 }],
    },
    { articleRow: sourceRow("0000000093813"), aliasRows: [] },
  ]));

  assert.deepEqual(result.rows.map(({ action }) => action), [
    "blocked", "blocked", "blocked", "blocked", "ready",
  ]);
  assert.deepEqual(result.rows[0].issueCodes, [
    "duplicate_article_number", "duplicate_source_key", "invalid_price",
  ]);
  assert.deepEqual(result.rows[1].issueCodes, ["duplicate_article_number", "duplicate_source_key"]);
  assert.deepEqual(result.rows[2].issueCodes, ["duplicate_gtin", "invalid_price"]);
  assert.deepEqual(result.rows[3].issueCodes, ["duplicate_gtin"]);
  assert.deepEqual(result.normalizedArticles.map(({ articleNumber }) => articleNumber), ["093813"]);
  assert.equal(result.findings.length, 8);
});

test("Mehrfach vorkommende äquivalente Aliase derselben Zeile bleiben ein einzelner Eigentümer", () => {
  const sharedGtin = "4006381333931";
  const result = inspect(payload([{
    articleRow: sourceRow("0000000093820"),
    aliasRows: [
      { EAN: "0000000093820", ZweitEAN: sharedGtin, Rang: 1 },
      { EAN: "0000000093820", ZweitEAN: sharedGtin, Rang: 2 },
      { EAN: "0000000093820", ZweitEAN: `0${sharedGtin}`, Rang: 3 },
    ],
  }]));

  assert.equal(result.rows[0].action, "ready");
  assert.equal(result.rows[0].issueCodes.includes("duplicate_gtin"), false);
  assert.equal(result.normalizedArticles.length, 1);
  assert.equal(result.normalizedArticles[0].identifiers.length, 1);
  assert.ok(result.findings.some(({ code }) => code === "ignored_alias"));
  assert.equal(result.findings.some(({ code }) => code === "duplicate_gtin"), false);
});
