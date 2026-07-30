"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  BRANDING_SNAPSHOT_STATEMENTS,
} = require("../statements/branding-snapshot");

function invalidInput() {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, {
    operation: "brandingSnapshot",
  });
}

function normalizedKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) throw invalidInput();
  const normalized = keys.map((key) => {
    if (typeof key !== "string" || !key || key.length > 255 || key.includes("\0")) {
      throw invalidInput();
    }
    return key;
  });
  if (new Set(normalized).size !== normalized.length) throw invalidInput();
  return new Set(normalized);
}

function createBrandingSnapshotRepository(access) {
  assertPersistenceAccess(access);
  return Object.freeze({
    async read(keys) {
      const allowedKeys = normalizedKeys(keys);
      const [settings, pdfSettings, locationBranding] = await Promise.all([
        access.queryAll(BRANDING_SNAPSHOT_STATEMENTS.listSettings),
        access.queryAll(BRANDING_SNAPSHOT_STATEMENTS.listPdfSettings),
        access.queryAll(BRANDING_SNAPSHOT_STATEMENTS.listLocationBranding),
      ]);
      return Object.freeze({
        settings: Object.freeze(settings.filter((row) => allowedKeys.has(row.key))),
        pdfSettings: Object.freeze(pdfSettings.filter((row) => allowedKeys.has(row.key))),
        locationBranding,
      });
    },
  });
}

module.exports = {
  createBrandingSnapshotRepository,
};
