"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { extractAumDates, parseDateParts } = require("../public/amu-ocr-parser");

const REFERENCE_DATE = "2026-07-14T12:00:00Z";

function extract(text) {
  return extractAumDates(text, { referenceDate: REFERENCE_DATE });
}

test("erkennt einen klar beschrifteten AUM-Zeitraum in einer Zeile", () => {
  const result = extract("Arbeitsunfähig von 10.07.2026 bis 17.07.2026");
  assert.equal(result.dateFrom, "2026-07-10");
  assert.equal(result.dateTo, "2026-07-17");
  assert.equal(result.complete, true);
  assert.equal(result.autoFill, true);
  assert.equal(result.requiresConfirmation, true);
});

test("erkennt getrennte Beschriftungen und typische OCR-Ziffernverwechslungen", () => {
  const result = extract([
    "Beginn der Arbeitsunfähigkeit",
    "I2.O7.2O26",
    "Voraussichtlich bis",
    "2I.O7.2O26",
  ].join("\n"));
  assert.equal(result.dateFrom, "2026-07-12");
  assert.equal(result.dateTo, "2026-07-21");
  assert.equal(result.autoFill, true);
});

test("toleriert leichte OCR-Fehler in langen deutschen Feldbezeichnungen", () => {
  const result = extract([
    "Beginn der Arbeitsunfahigkelt: 08.07.2026",
    "Letzter Tag der Arbeitsunfählgkeit: 11.07.2026",
  ].join("\n"));
  assert.equal(result.dateFrom, "2026-07-08");
  assert.equal(result.dateTo, "2026-07-11");
  assert.equal(result.complete, true);
});

test("toleriert ein als Sonderzeichen fehlgelesenes Umlautzeichen", () => {
  const result = extract([
    "Arbeitsunf?hig von 10.07.2026",
    "Voraussichtlich bis 17.07.2026",
  ].join("\n"));
  assert.equal(result.dateFrom, "2026-07-10");
  assert.equal(result.dateTo, "2026-07-17");
  assert.equal(result.autoFill, true);
});

test("gewichtet AUM-Felder höher als Geburts- und Ausstellungsdaten", () => {
  const result = extract([
    "Geburtsdatum 03.02.1988",
    "Ausgestellt am 13.07.2026",
    "Arbeitsunfähig seit 12.07.2026",
    "Voraussichtlich bis 18.07.2026",
  ].join("\n"));
  assert.equal(result.dateFrom, "2026-07-12");
  assert.equal(result.dateTo, "2026-07-18");
  assert.equal(result.autoFill, true);
});

test("akzeptiert zwei explizite gleiche Daten für eine eintägige AUM", () => {
  const result = extract("Arbeitsunfähig von 14.07.2026 bis 14.07.2026");
  assert.equal(result.dateFrom, "2026-07-14");
  assert.equal(result.dateTo, "2026-07-14");
  assert.equal(result.complete, true);
});

test("übernimmt einen sicher erkannten Beginn auch dann, wenn das AUM-Ende offen ist", () => {
  const result = extract("Beginn der Arbeitsunfähigkeit: 14.07.2026\nVoraussichtlich bis: offen");
  assert.equal(result.dateFrom, "2026-07-14");
  assert.equal(result.dateTo, "");
  assert.equal(result.complete, false);
  assert.equal(result.autoFill, false);
  assert.deepEqual(result.autoFillFields, { dateFrom: true, dateTo: false });
  assert.deepEqual(result.warnings, ["period_incomplete"]);
});

test("lehnt unmögliche Kalenderdaten ab und erfindet keinen Zeitraum", () => {
  const result = extract("Arbeitsunfähig von 31.02.2026 bis 34.02.2026");
  assert.equal(result.dateFrom, "");
  assert.equal(result.dateTo, "");
  assert.equal(result.complete, false);
  assert.deepEqual(result.warnings, ["no_date_detected"]);
});

test("liefert bei chronologisch widersprüchlichen Angaben keinen vollständigen Zeitraum", () => {
  const result = extract("Arbeitsunfähig von 20.07.2026 bis 10.07.2026");
  assert.equal(result.complete, false);
  assert.equal(result.autoFill, false);
  assert.deepEqual(result.warnings, ["chronology_invalid"]);
});

test("ergänzt zweistellige Jahre relativ zum Referenzdatum", () => {
  const result = extract("Arbeitsunfähig von 10.07.26 bis 17.07.26");
  assert.equal(result.dateFrom, "2026-07-10");
  assert.equal(result.dateTo, "2026-07-17");
  assert.equal(parseDateParts("1", "1", "99", 2026), "1999-01-01");
});

test("gibt weder OCR-Rohtext noch medizinische Freitexte zurück", () => {
  const sensitive = [
    "Name: Erika Musterfrau",
    "Diagnose: streng vertraulicher medizinischer Freitext",
    "Arbeitsunfähig von 10.07.2026 bis 17.07.2026",
  ].join("\n");
  const serialized = JSON.stringify(extract(sensitive));
  assert.doesNotMatch(serialized, /Erika|Diagnose|vertraulich|Arbeitsunf/i);
});

test("akzeptiert auch das Textfeld eines Tesseract-Ergebnisobjekts", () => {
  const result = extractAumDates({ text: "Krankenstand ab 09.07.2026\nVoraussichtlich bis 12.07.2026" }, { referenceDate: REFERENCE_DATE });
  assert.equal(result.dateFrom, "2026-07-09");
  assert.equal(result.dateTo, "2026-07-12");
});
