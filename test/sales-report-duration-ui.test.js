"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../public/sales-report-jobs.js"), "utf8")
  .replace(/\r\n/g, "\n");

function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end + 3);
}

test("Berichtsdauer wird im verlangten Minuten-Sekunden-Format ausgegeben", () => {
  const context = vm.createContext({});
  vm.runInContext(extract("formatSalesReportDuration"), context);
  assert.equal(context.formatSalesReportDuration(263), "4min 23sek");
  assert.equal(context.formatSalesReportDuration(8), "0min 8sek");
  assert.match(source, /Dauer: \$\{formatSalesReportDuration\(row\.durationSeconds\)\}/);
});
