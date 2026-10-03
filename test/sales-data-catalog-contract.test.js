"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const integrations = fs.readFileSync(path.join(root, "INTEGRATIONEN.md"), "utf8");
const policy = fs.readFileSync(path.join(root, ".github", "GITHUB-DOKUMENTATION.md"), "utf8");

test("Öffentliche Dokumentation beschreibt kontrollierte Importe ohne interne Quellsnapshots", () => {
  assert.match(integrations, /Access-DB-Importe verwenden eine kontrollierte Vorschau/);
  assert.match(integrations, /Dateifingerabdruck, Profil und Tabellenplan/);
  assert.match(policy, /Interne Planungen, Analysen, Designs, Messungen und Auslieferungsbelege werden lokal aufbewahrt/);
  assert.match(policy, /Reale Daten, kundenspezifische Namen, Branding, Zugangsdaten, private Pfade und unbereinigte Logs werden nicht veröffentlicht/);
  assert.match(policy, /Quellcodebezeichner und Git-Historie werden nicht nachträglich umgeschrieben/);
});
