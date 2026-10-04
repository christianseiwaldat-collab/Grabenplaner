"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const model = require("../lib/sales-article-search-window-preferences");

test("Suchfensterpräferenzen haben ein eigenes Schema und unabhängige Defaults", () => {
  assert.equal(model.PREFERENCE_KEY, "sales_article_search_window_v1");
  const initial = model.defaultSalesArticleSearchWindowPreferences();
  assert.deepEqual(initial, { version: 1, x: 0, y: 0, width: 560, height: 620, minimized: false });
  initial.width = 1000;
  assert.equal(model.defaultSalesArticleSearchWindowPreferences().width, 560);
  const preferred = { version: 1, x: 16384, y: 16384, width: 4096, height: 4096, minimized: true };
  assert.deepEqual(model.normalizeSalesArticleSearchWindowPreferences(preferred), preferred);
  assert.deepEqual(model.normalizeSalesArticleSearchWindowPreferences({ ...preferred, x: 0, y: 0, width: 280, height: 200 }),
    { ...preferred, x: 0, y: 0, width: 280, height: 200 });
});

test("Suchfensterpräferenzen lehnen unvollständige, fremde und falsch typisierte Werte ab", () => {
  const defaults = model.defaultSalesArticleSearchWindowPreferences();
  for (const invalid of [null, [], "window", {}, { ...defaults, configured: true }, { ...defaults, employeeNumber: "other" },
    { ...defaults, version: 2 }, { ...defaults, version: "1" }, { ...defaults, minimized: "false" }]) {
    assert.throws(() => model.normalizeSalesArticleSearchWindowPreferences(invalid), TypeError);
  }
  for (const field of Object.keys(defaults)) {
    const incomplete = { ...defaults };
    delete incomplete[field];
    assert.throws(() => model.normalizeSalesArticleSearchWindowPreferences(incomplete), TypeError, field);
  }
  for (const [field, limits] of Object.entries(model.GEOMETRY_LIMITS)) {
    for (const invalid of [limits.min - 1, limits.max + 1, limits.min + 0.5, String(limits.min), null, false, NaN, Infinity]) {
      assert.throws(() => model.normalizeSalesArticleSearchWindowPreferences({ ...defaults, [field]: invalid }), TypeError,
        `${field}: ${String(invalid)}`);
    }
  }
});
