"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const catalog = fs.readFileSync(
  path.join(root, "docs", "VERKAUFSANALYSEN-DATENKATALOG-v0.1.md"),
  "utf8",
);
const foundation = fs.readFileSync(
  path.join(root, "docs", "VERKAUFSVERWALTUNG-FUNDAMENT-v0.1.md"),
  "utf8",
);

test("Datenkatalog ist als reiner Block 2 versioniert und mit dem Fundament verknüpft", () => {
  assert.match(catalog, /^# Verkaufsanalysen · Datenkatalog v0\.1/m);
  assert.match(catalog, /\| Block \| 2 · Datenkatalog \|/);
  assert.match(catalog, /keine produktiven Tabellen, Migrationen, API-Endpunkte, Importprogramme/);
  assert.match(catalog, /keine automatische Umsetzungsfreigabe/);
  assert.match(foundation, /VERKAUFSANALYSEN-DATENKATALOG-v0\.1\.md/);
});

test("Quellsnapshots sind reproduzierbar beschrieben, ohne Quelldatensätze zu übernehmen", () => {
  assert.match(catalog, /Kassen_Umsätze\.accdb/);
  assert.match(catalog, /390818D10567DB5D9EE8C262D8E98798C9A69B219FE0F72CC59B184DFCC02D7C/);
  assert.match(catalog, /Trade_Daten\.accdb/);
  assert.match(catalog, /B6FFD5D7FD439835CC52961709AA89E772894C3ABD12569C5AD6A6486AC3FD9D/);
  assert.match(catalog, /Zugangsdaten und einzelne Quelldatensätze werden nicht dokumentiert/);
  assert.match(catalog, /Quelldumps werden nicht im Grabenplaner, nicht im Repository/);
});

test("Allowlist bleibt fail-closed und trennt dauerhafte Daten von Prüfwerten", () => {
  assert.match(catalog, /`KERN-ALLOWLIST`/);
  assert.match(catalog, /`STAGING\/PRÜFUNG`/);
  assert.match(catalog, /`FACHLICH ZU KLÄREN`/);
  assert.match(catalog, /Nicht ausdrücklich in der `KERN-ALLOWLIST` genannte Tabellen und Felder gelten als `AUSSCHLUSS`/);
  assert.match(catalog, /Direkte Schreibvorgänge aus der Quelldatei in produktive Analysetabellen sind ausgeschlossen/);
});

test("Kunden-, Mitarbeiter- und Zugangsdaten sind ausdrücklich ausgeschlossen", () => {
  assert.match(catalog, /`KUND_NR`, `KPLZ` \| `AUSSCHLUSS`/);
  assert.match(catalog, /`VerkäuferID`, `Personalkennziffer` \| `AUSSCHLUSS`/);
  assert.match(catalog, /`Provision_dm`, `Prov`, `Provision`, `Verkäuferid`, `Beratung` \| `AUSSCHLUSS`/);
  assert.match(catalog, /`MITARBEITER`, `Benutzer`, `Zugang`, `Zugang_Mitarbeiter`/);
  assert.match(catalog, /keine Kundenprofile und keine personenbezogene Mitarbeiterleistung/);
});

test("Kassenhistorie, Warenwirtschafts-Snapshot und Shopware-Zuordnung bleiben fachlich getrennt", () => {
  assert.match(catalog, /Historische Verkäufe bis Juni 2020 und Warenwirtschafts-Snapshots aus 2026 bleiben deshalb getrennte Datensichten/);
  assert.match(catalog, /5\.388 direkt mit einer aktuellen primären EAN/);
  assert.match(catalog, /36,77 Prozent/);
  assert.match(catalog, /9\.265 EANs bleiben ohne sichere aktuelle Zuordnung/);
  assert.match(catalog, /weder ein Onlineverkauf noch ein Shopumsatz/);
  assert.match(catalog, /Shopware-Bestellungen, falls Onlineshop-Umsatz tatsächlich analysiert werden soll/);
});

test("Kritische Umwandlungsregeln und offene Fachentscheidungen sind festgehalten", () => {
  assert.match(catalog, /Access-`Currency` wird als exakt skalierte Dezimalzahl/);
  assert.match(catalog, /Kassenwerte erscheinen als tatsächliche Prozentwerte `0`, `10` und `20`/);
  assert.match(catalog, /Sonderwerte wie `0` und `99`/);
  assert.match(catalog, /14\.427 negativen Mengen/);
  assert.match(catalog, /Bedeutung der historisch benannten `_DM`-Felder/);
});
