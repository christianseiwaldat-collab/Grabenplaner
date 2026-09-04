"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  TRADEFOTO_ACCDB_IMPORT_MAX_BYTES,
  accdbDecimalText,
  assertTradeFotoAccdbBuffer,
  inspectTradeFotoAccdbBuffer,
  normalizeTradeFotoAccdbPassword,
  sanitizedTradeFotoAccdbFilename,
} = require("../lib/tradefoto-accdb-import");
const {
  TRADEFOTO_ARTICLE_ALIAS_ROW_FIELDS,
  TRADEFOTO_ARTICLE_ROW_FIELDS,
  TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS,
  TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS,
} = require("../lib/tradefoto-article-source-profile");

const DECIMAL_FIELDS = new Set([
  ...TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.map(({ sourceField }) => sourceField),
  ...TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS.map(({ sourceField }) => sourceField),
]);

function accessBuffer(size = 4096) {
  const buffer = Buffer.alloc(size);
  buffer[0] = 0;
  buffer.write("Standard ACE DB", 4, "ascii");
  buffer[0x14] = 0x03;
  return buffer;
}

function validArticleRow(overrides = {}) {
  const row = Object.fromEntries(TRADEFOTO_ARTICLE_ROW_FIELDS.map((fieldName) => [
    fieldName,
    DECIMAL_FIELDS.has(fieldName) ? null : undefined,
  ]));
  return {
    ...row,
    EAN: "0000000000152",
    Artikelbezeichnung: "Direkt gelesener Artikel",
    MWST: 1,
    Verkaufspreis: 12.5,
    eNvk: 10.416666666667,
    Änderungsdatum: new Date("2026-06-29T10:36:53.000Z"),
    ...overrides,
  };
}

function articleColumns() {
  return [
    ...TRADEFOTO_ARTICLE_ROW_FIELDS.map((name) => {
      if (name === "EAN") return { name, type: "text", size: 26 };
      if (name === "Artikelbezeichnung") return { name, type: "text", size: 100 };
      if (name === "MWST") return { name, type: "byte", size: 1 };
      return { name, type: "double", size: 8 };
    }),
    { name: "Änderungsdatum", type: "datetime", size: 8 },
  ];
}

function aliasColumns() {
  return TRADEFOTO_ARTICLE_ALIAS_ROW_FIELDS.map((name) => (
    name === "Rang"
      ? { name, type: "byte", size: 1 }
      : { name, type: "text", size: 26 }
  ));
}

class FakeTable {
  constructor(name, rows, columns, rowCount = rows.length) {
    this.name = name;
    this.rows = rows;
    this.columns = columns;
    this.rowCount = rowCount;
  }

  getColumns() {
    return this.columns;
  }

  getData({ columns, rowOffset = 0, rowLimit = Infinity } = {}) {
    return this.rows.slice(rowOffset, rowOffset + rowLimit).map((row) => Object.fromEntries(
      (columns || Object.keys(row)).map((fieldName) => [fieldName, row[fieldName]]),
    ));
  }
}

function fakeReader({
  articles = [validArticleRow()],
  aliases = [{ EAN: "0000000000152", ZweitEAN: "4006381333931", Rang: 1 }],
  articleColumnValues = articleColumns(),
  aliasColumnValues = aliasColumns(),
  articleRowCount = articles.length,
  aliasRowCount = aliases.length,
} = {}) {
  const tables = new Map([
    ["ARTIKEL_STAMM", new FakeTable(
      "ARTIKEL_STAMM",
      articles,
      articleColumnValues,
      articleRowCount,
    )],
    ["ARTIKEL_ZWEITEAN", new FakeTable(
      "ARTIKEL_ZWEITEAN",
      aliases,
      aliasColumnValues,
      aliasRowCount,
    )],
  ]);
  return {
    getTableNames: () => [...tables.keys()],
    getTable: (name) => tables.get(name),
    getCreationDate: () => new Date("2014-05-14T00:00:00.000Z"),
  };
}

test("ACCDB-Extraktion liest nur das freigegebene Schema und nutzt dieselbe Importprüfung", async () => {
  const buffer = accessBuffer();
  const before = Buffer.from(buffer);
  let receivedPassword = null;
  const prepared = await inspectTradeFotoAccdbBuffer(buffer, {
    fileName: "Trade_Daten.accdb",
    password: "nur-im-speicher",
    createReader: async (_databaseBuffer, password) => {
      receivedPassword = password;
      return fakeReader();
    },
  });

  assert.equal(receivedPassword, "nur-im-speicher");
  assert.deepEqual(buffer, before);
  assert.equal(prepared.source.fileName, "Trade_Daten.accdb");
  assert.equal(
    prepared.source.fileSha256,
    crypto.createHash("sha256").update(before).digest("hex"),
  );
  assert.equal(prepared.source.snapshotAt, "2026-06-29T10:36:53.000Z");
  assert.equal(prepared.source.articleCount, 1);
  assert.equal(prepared.rows[0].action, "ready");
  assert.equal(prepared.normalizedArticles[0].articleNumber, "000152");
  assert.equal(prepared.normalizedArticles[0].sourceArticleKey, "0000000000152");
  assert.equal(prepared.normalizedArticles[0].identifiers[0].identifierValue, "4006381333931");
  assert.equal(prepared.normalizedArticles[0].prices.find(({ priceType }) => priceType === "sales").amount, "12.500000000000");
});

test("ACCDB-Dezimalwerte werden deterministisch auf den decimal12-Vertrag abgebildet", () => {
  assert.equal(accdbDecimalText(null, "Wert"), null);
  assert.equal(accdbDecimalText(-0, "Wert"), "0");
  assert.equal(accdbDecimalText(19540.833333333332, "Wert"), "19540.833333333332");
  assert.equal(accdbDecimalText(1e-7, "Wert"), "0.0000001");
  assert.equal(accdbDecimalText(1.230000000000001, "Wert"), "1.23");
  assert.throws(
    () => accdbDecimalText(Number.POSITIVE_INFINITY, "Wert"),
    { code: "SALES_ARTICLE_ACCDB_ROW_INVALID" },
  );
});

test("ACCDB-Datei-, Dateiname- und Passwortgrenzen schließen ungültige Eingaben früh", () => {
  assert.equal(sanitizedTradeFotoAccdbFilename("C:\\Ablage\\Trade_Daten.accdb"), "Trade_Daten.accdb");
  assert.equal(normalizeTradeFotoAccdbPassword("streng geheim"), "streng geheim");
  assert.throws(
    () => sanitizedTradeFotoAccdbFilename("Trade_Daten.mdb"),
    { code: "SALES_ARTICLE_ACCDB_FILENAME_INVALID" },
  );
  assert.throws(
    () => normalizeTradeFotoAccdbPassword(""),
    { code: "SALES_ARTICLE_ACCDB_PASSWORD_REQUIRED" },
  );
  assert.throws(
    () => normalizeTradeFotoAccdbPassword("ä".repeat(129)),
    { code: "SALES_ARTICLE_ACCDB_PASSWORD_INVALID" },
  );
  assert.throws(
    () => assertTradeFotoAccdbBuffer(Buffer.alloc(4096)),
    { code: "SALES_ARTICLE_ACCDB_PASSWORD_OR_FILE_INVALID" },
  );
  assert.equal(TRADEFOTO_ACCDB_IMPORT_MAX_BYTES, 256 * 1024 * 1024);
  assert.throws(
    () => assertTradeFotoAccdbBuffer(Buffer.alloc(4095)),
    { code: "SALES_ARTICLE_ACCDB_FILE_SIZE_INVALID", status: 413 },
  );
});

test("Falsches Passwort, Schemadrift und verwaiste Zweit-EAN werden ohne Rohfehler abgewiesen", async () => {
  await assert.rejects(
    inspectTradeFotoAccdbBuffer(accessBuffer(), {
      fileName: "Trade_Daten.accdb",
      password: "falsch",
      createReader: async () => { throw new Error("sensitive low-level parser detail"); },
    }),
    (error) => error.code === "SALES_ARTICLE_ACCDB_PASSWORD_OR_FILE_INVALID"
      && !error.message.includes("sensitive"),
  );

  const columnsWithoutVat = articleColumns().filter(({ name }) => name !== "MWST");
  await assert.rejects(
    inspectTradeFotoAccdbBuffer(accessBuffer(), {
      fileName: "Trade_Daten.accdb",
      password: "richtig",
      createReader: async () => fakeReader({ articleColumnValues: columnsWithoutVat }),
    }),
    { code: "SALES_ARTICLE_ACCDB_SCHEMA_MISMATCH" },
  );

  await assert.rejects(
    inspectTradeFotoAccdbBuffer(accessBuffer(), {
      fileName: "Trade_Daten.accdb",
      password: "richtig",
      createReader: async () => fakeReader({
        aliases: [{ EAN: "0000000000999", ZweitEAN: "4006381333931", Rang: 1 }],
      }),
    }),
    { code: "SALES_ARTICLE_ACCDB_RELATION_INVALID" },
  );
});

test("Deklarierte ACCDB-Zeilenzahlen werden vor dem Tabellenlesen begrenzt", async () => {
  await assert.rejects(
    inspectTradeFotoAccdbBuffer(accessBuffer(), {
      fileName: "Trade_Daten.accdb",
      password: "richtig",
      createReader: async () => fakeReader({ articleRowCount: 25_001 }),
    }),
    { code: "SALES_ARTICLE_IMPORT_ROW_LIMIT", status: 413 },
  );
  await assert.rejects(
    inspectTradeFotoAccdbBuffer(accessBuffer(), {
      fileName: "Trade_Daten.accdb",
      password: "richtig",
      createReader: async () => fakeReader({ aliasRowCount: 750_000 }),
    }),
    { code: "SALES_ARTICLE_IMPORT_WORK_BUDGET_EXCEEDED", status: 413 },
  );
});
