"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { BASELINE, legacyPath, sourceRoot } = require("./legacy-baseline");
const repository = path.resolve(__dirname, "..");
const cases = Object.freeze({
  "test/portal-foundation.test.js": {
    pattern: "^(?:HTTPS-Serverfundament erzwingt Proxy-Sicherheit|LAN-Bereichsrechte trennen Filial- und Abteilungsdaten)",
    minimumPass: 2,
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
});

function runHistoricalServerTest(relative) {
  const definition = cases[relative];
  if (!definition) throw new Error("HISTORICAL_SERVER_TEST_NOT_REGISTERED");
  assert.equal(BASELINE, "b2ba03cdc0b738d44766857de052e090db557807");
  const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")).digest("hex");
  assert.equal(digest(legacyPath("pnpm-lock.yaml")), digest(path.join(repository, "pnpm-lock.yaml")), "historical test dependencies must remain identical");
  const dependencies = fs.realpathSync(path.join(repository, "node_modules"));
  const link = legacyPath("node_modules");
  if (!fs.existsSync(link)) fs.symlinkSync(dependencies, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(fs.realpathSync(link), dependencies);
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot,
    LANG: "C.UTF-8", NODE_ENV: "test", NODE_PATH: dependencies };
  const arguments_ = ["--test", "--test-reporter=tap"];
  if (definition.pattern) arguments_.push("--test-name-pattern=" + definition.pattern);
  arguments_.push(legacyPath(relative));
  const result = spawnSync(process.execPath, arguments_, {
    cwd: sourceRoot(), env: environment, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024,
  });
  const diagnostic = (result.stdout || "").slice(-24000) + "\n" + (result.stderr || "").slice(-4000);
  assert.equal(result.status, 0, diagnostic);
  const pass = Number(/^# pass (\d+)$/m.exec(result.stdout)?.[1] || 0);
  assert.ok(pass >= definition.minimumPass, diagnostic);
  assert.match(result.stdout, /^# fail 0$/m, diagnostic);
  if (definition.required) assert.ok(result.stdout.includes("ok ") && result.stdout.includes(definition.required), diagnostic);
  return { baseline: BASELINE, relative, pass, historicalCompatibilityOnly: true };
}

module.exports = { runHistoricalServerTest };
