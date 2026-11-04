"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { BASELINE, legacyPath, sourceRoot, linkFrozenDependencies } = require("./legacy-baseline");
const cases = Object.freeze({
  "test/portal-foundation.test.js": {
    pattern: "^(?:HTTPS-Serverfundament erzwingt Proxy-Sicherheit|LAN-Bereichsrechte trennen Filial- und Abteilungsdaten|produktiver Start bleibt auf Loopback und blockiert externe Bindung)",
    minimumPass: 3,
  },
  "test/v058-personnel-rights-encryption.test.js": {
    pattern: "^(?:v0\\.58: bestehende Klartext-Personalaktfelder|v0\\.58: Admin darf keine Datenbank|v0\\.87: unlesbarer DB-Import|v0\\.58: DB-Import|v0\\.70 Block 2: DB-Import|Personalmodul: DB-Import)",
    minimumPass: 7,
  },
  "test/cross-location-schedule-view-api.test.js": { pattern: "^Block 12: (fünf gleichzeitige|verifizierter Sicherungspunkt)", minimumPass: 2 },
  "test/sales-analytics-production-hardening.test.js": { pattern: "^Verkaufsanalysen: Sicherung und Wiederherstellung", minimumPass: 1 },
  "test/v081-work-rule-safety-regressions.test.js": { pattern: "^Regression: Legacy-Prüfbelege werden vor Aktivierung", minimumPass: 1 },
  "test/v082-immutable-trigger-migration.test.js": { minimumPass: 1 },
  "test/v087-block5-loan-photo-migration.test.js": { minimumPass: 1 },
  "test/v087-block8-cost-center-migration.test.js": { minimumPass: 1 },
  "test/v087-block7-settings-appearance.test.js": { pattern: "Legacy-Schriftwerte und Betriebsmodus-Reste", minimumPass: 1 },
  "test/v072-production-bootstrap.test.js": { pattern: "^bootstrap fixture waits", minimumPass: 1 },
  "test/portal-permission-defaults.test.js": { minimumPass: 9 },
  "test/v063-import-payroll.test.js": { pattern: "^v0.63: vollständig freigeschaltete Altinstallationen", minimumPass: 1 },
  "test/v071-cost-centers-personnel.test.js": { minimumPass: 1, required: "Eine echte Alt-Datenbank wird deterministisch und ohne Waisen migriert" },
  "test/v071-shift-locations.test.js": { minimumPass: 1, required: "eine bestehende Datenbank wird deterministisch auf Einsatzfilialen migriert" },
  "test/v085-loan-foundation.test.js": {
    pattern: "^F18-Direktfixture migriert zentral und rollt spaete Artikelfehler atomar zurueck$",
    minimumPass: 1,
    required: "F18-Direktfixture migriert zentral und rollt spaete Artikelfehler atomar zurueck",
    sourceSha256: "bcb93cbe4d521c63a4a06d8cefaa1c25a5c8e678bbd64ecfe459aff672b877e9",
  },
});

function runHistoricalServerTest(relative) {
  const definition = cases[relative];
  if (!definition) throw new Error("HISTORICAL_SERVER_TEST_NOT_REGISTERED");
  assert.equal(BASELINE, "b2ba03cdc0b738d44766857de052e090db557807");
  if (definition.sourceSha256) {
    assert.equal(require("node:crypto").createHash("sha256")
      .update(require("node:fs").readFileSync(legacyPath(relative))).digest("hex"), definition.sourceSha256);
  }
  linkFrozenDependencies();
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot,
    LANG: "C.UTF-8", NODE_ENV: "test", GP_PG_API_FIXTURE_BRIDGE: "0" };
  const arguments_ = ["--no-global-search-paths", "--test", "--test-reporter=tap"];
  if (definition.pattern) arguments_.push("--test-name-pattern=" + definition.pattern);
  arguments_.push(legacyPath(relative));
  // The current PostgreSQL test bridge adapts spawn/spawnSync to propagate its
  // owned fixture. Historical code must instead execute with only this explicit
  // environment, without connection URLs, owner markers or NODE_OPTIONS.
  let output;
  try {
    output = execFileSync(process.execPath, arguments_, {
      cwd: sourceRoot(), env: environment, encoding: "utf8", timeout: 180000,
      maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
  } catch (error) {
    assert.fail(String(error.stdout || "").slice(-24000) + "\n" + String(error.stderr || error.message).slice(-4000));
  }
  const diagnostic = output.slice(-24000);
  const pass = Number(/^# pass (\d+)$/m.exec(output)?.[1] || 0);
  assert.ok(pass >= definition.minimumPass, diagnostic);
  assert.match(output, /^# fail 0$/m, diagnostic);
  if (definition.required) assert.ok(output.includes("ok ") && output.includes(definition.required), diagnostic);
  return { baseline: BASELINE, relative, pass, historicalCompatibilityOnly: true };
}

module.exports = { runHistoricalServerTest };
