"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createAmuOcrClient, mergeAumOcrResults, DEFAULT_ASSET_PATHS } = require("../public/amu-ocr-client");

function fixture(recognizedText = "Arbeitsunfähig von 10.07.2026 bis 17.07.2026\nDiagnose vertraulich") {
  const calls = { create: [], parameters: [], recognize: [], terminate: 0 };
  const worker = {
    async setParameters(parameters) { calls.parameters.push(parameters); },
    async recognize(image, options, output) {
      calls.recognize.push({ image, options, output });
      return { data: { text: recognizedText } };
    },
    async terminate() { calls.terminate += 1; },
  };
  const tesseract = {
    OEM: { LSTM_ONLY: 1 },
    PSM: { AUTO: "3" },
    async createWorker(...args) { calls.create.push(args); return worker; },
  };
  return { calls, tesseract };
}

test("verwendet ausschließlich lokale, gleichursprüngliche OCR-Assets", async () => {
  const { calls, tesseract } = fixture();
  const client = createAmuOcrClient({ tesseract, idleMs: 0 });
  await client.recognize(Buffer.from("image"), { referenceDate: "2026-07-14T12:00:00Z" });
  const [language, engine, options] = calls.create[0];
  assert.equal(language, "deu");
  assert.equal(engine, 1);
  assert.equal(options.workerPath, DEFAULT_ASSET_PATHS.workerPath);
  assert.equal(options.corePath, DEFAULT_ASSET_PATHS.corePath);
  assert.equal(options.langPath, DEFAULT_ASSET_PATHS.langPath);
  assert.equal(options.workerBlobURL, false);
  assert.equal(options.gzip, true);
  assert.ok(Object.values(DEFAULT_ASSET_PATHS).every((value) => value.startsWith("/") && !value.startsWith("//")));
  await client.dispose();
});

test("initialisiert genau einen Worker, serialisiert Aufträge und gibt nur abgeleitete Daten zurück", async () => {
  const { calls, tesseract } = fixture();
  const client = createAmuOcrClient({ tesseract, idleMs: 0 });
  const [first, second] = await Promise.all([
    client.recognize("first", { referenceDate: "2026-07-14T12:00:00Z" }),
    client.recognize("second", { referenceDate: "2026-07-14T12:00:00Z" }),
  ]);
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.recognize.map((entry) => entry.image), ["first", "second"]);
  assert.equal(first.dateFrom, "2026-07-10");
  assert.equal(second.dateTo, "2026-07-17");
  assert.doesNotMatch(JSON.stringify(first), /Diagnose|vertraulich|Arbeitsunf/i);
  await client.dispose();
  assert.equal(calls.terminate, 1);
});

test("Progress-Ereignisse enthalten keinen OCR- oder Dokumenttext", async () => {
  const { calls, tesseract } = fixture();
  const progress = [];
  const client = createAmuOcrClient({ tesseract, idleMs: 0, onProgress: (entry) => progress.push(entry) });
  const pending = client.recognize("image", { referenceDate: "2026-07-14T12:00:00Z" });
  await Promise.resolve();
  const workerOptions = calls.create[0][2];
  workerOptions.logger({ status: "recognizing text", progress: 0.5, text: "nicht weitergeben" });
  await pending;
  assert.deepEqual(progress, [{ status: "recognizing text", progress: 0.5 }]);
  await client.dispose();
});

test("kombiniert ausschließlich abgeleitete Datumswerte mehrerer lokal erkannter Seiten", () => {
  const result = mergeAumOcrResults([
    {
      dateFrom: "2026-07-10", dateTo: "", complete: false,
      fieldConfidence: { dateFrom: 0.92, dateTo: 0 },
      autoFillFields: { dateFrom: true, dateTo: false },
    },
    {
      dateFrom: "", dateTo: "2026-07-17", complete: false,
      fieldConfidence: { dateFrom: 0, dateTo: 0.88 },
      autoFillFields: { dateFrom: false, dateTo: true },
    },
  ]);
  assert.equal(result.dateFrom, "2026-07-10");
  assert.equal(result.dateTo, "2026-07-17");
  assert.equal(result.autoFill, true);
  assert.doesNotMatch(JSON.stringify(result), /seite|ocr|text/i);
});

test("gibt aus dem OCR-Text nur die abgeleitete SV-Nummer und keine Rohtexte zurück", async () => {
  const { tesseract } = fixture([
    "Name: Erika Musterfrau",
    "Versicherungsnummer: 1000 010190",
    "Diagnose: vertraulich",
    "Arbeitsunfähig von 10.07.2026 bis 17.07.2026",
  ].join("\n"));
  const client = createAmuOcrClient({ tesseract, idleMs: 0 });
  const result = await client.recognize("image", { referenceDate: "2026-07-14T12:00:00Z" });

  assert.equal(result.socialSecurityNumber, "1000010190");
  assert.equal(result.socialSecurityStatus, "detected");
  assert.equal(result.socialSecurityConfidence, 0.98);
  assert.doesNotMatch(JSON.stringify(result), /Erika|Diagnose|vertraulich|Versicherungsnummer/i);
  await client.dispose();
});

test("führt identische SV-Treffer zusammen und verwirft widersprüchliche Treffer als mehrdeutig", () => {
  const common = {
    dateFrom: "2026-07-10",
    dateTo: "2026-07-17",
    complete: true,
    autoFill: true,
    fieldConfidence: { dateFrom: 0.9, dateTo: 0.9 },
    socialSecurityStatus: "detected",
  };
  const same = mergeAumOcrResults([
    { ...common, socialSecurityNumber: "1000010190", socialSecurityConfidence: 0.86, text: "nicht behalten" },
    { ...common, socialSecurityNumber: "1000010190", socialSecurityConfidence: 0.98, diagnosis: "vertraulich" },
  ]);
  assert.equal(same.socialSecurityNumber, "1000010190");
  assert.equal(same.socialSecurityConfidence, 0.98);
  assert.equal(same.socialSecurityStatus, "detected");
  assert.doesNotMatch(JSON.stringify(same), /nicht behalten|diagnosis|vertraulich|text/i);

  const ambiguous = mergeAumOcrResults([
    { ...common, socialSecurityNumber: "1000010190", socialSecurityConfidence: 0.98 },
    { ...common, socialSecurityNumber: "1009311299", socialSecurityConfidence: 0.98 },
  ]);
  assert.equal(ambiguous.socialSecurityNumber, "");
  assert.equal(ambiguous.socialSecurityConfidence, 0);
  assert.equal(ambiguous.socialSecurityStatus, "ambiguous");
});
