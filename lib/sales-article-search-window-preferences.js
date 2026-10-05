"use strict";

// Retain the account key: the client upgrades content-relative V1 coordinates
// to viewport-relative V2 and saves them through the existing private route.
const PREFERENCE_KEY = "sales_article_search_window_v1";
const DEFAULT_PREFERENCES = Object.freeze({
  version: 2,
  x: 0,
  y: 0,
  width: 560,
  height: 620,
  minimized: false,
});
const PREFERENCE_FIELDS = Object.freeze(Object.keys(DEFAULT_PREFERENCES));
const GEOMETRY_LIMITS = Object.freeze({
  x: Object.freeze({ min: 0, max: 16384 }),
  y: Object.freeze({ min: 0, max: 16384 }),
  width: Object.freeze({ min: 280, max: 4096 }),
  height: Object.freeze({ min: 200, max: 4096 }),
});

function defaultSalesArticleSearchWindowPreferences() {
  return { ...DEFAULT_PREFERENCES };
}

function normalizeSalesArticleSearchWindowPreferences(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !PREFERENCE_FIELDS.includes(key))
    || PREFERENCE_FIELDS.some((key) => !Object.hasOwn(input, key))
    || ![1, 2].includes(input.version) || typeof input.minimized !== "boolean") {
    throw new TypeError("Die Artikeleinstellungen für das Suchfenster sind ungültig.");
  }
  for (const [field, limits] of Object.entries(GEOMETRY_LIMITS)) {
    if (!Number.isInteger(input[field]) || input[field] < limits.min || input[field] > limits.max) {
      throw new TypeError("Die Artikeleinstellungen für das Suchfenster sind ungültig.");
    }
  }
  return {
    version: input.version,
    x: input.x === 0 ? 0 : input.x,
    y: input.y === 0 ? 0 : input.y,
    width: input.width,
    height: input.height,
    minimized: input.minimized,
  };
}

module.exports = {
  PREFERENCE_KEY,
  DEFAULT_PREFERENCES,
  GEOMETRY_LIMITS,
  defaultSalesArticleSearchWindowPreferences,
  normalizeSalesArticleSearchWindowPreferences,
};
