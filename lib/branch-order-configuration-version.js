"use strict";

const { fingerprint } = require("./data-import-contract");

// Hash the complete settings snapshot, including stable IDs and ordered groups.
// Object key order does not matter; all business values and array order do.
function configurationVersion(configuration) {
  return fingerprint({ version: 1, configuration });
}

function validateExpectedVersion(value) {
  // Existing clients may omit the token. A supplied malformed token never opts out.
  if (value === undefined) return value;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    const error = new Error("Die Version der Bestellkonfiguration ist ungültig.");
    error.code = "BRANCH_ORDER_CONFIGURATION_VERSION_INVALID";
    error.status = 400;
    throw error;
  }
  return value;
}

module.exports = { configurationVersion, validateExpectedVersion };
