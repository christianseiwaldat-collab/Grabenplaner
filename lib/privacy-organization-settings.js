"use strict";

const PRIVACY_ORGANIZATION_SETTING_PREFIX = "privacy_organization_";
const PRIVACY_ORGANIZATION_SETTING_KEY = `${PRIVACY_ORGANIZATION_SETTING_PREFIX}ledger_v1`;

function isPrivacyOrganizationSettingKey(key) {
  return typeof key === "string" && key.startsWith(PRIVACY_ORGANIZATION_SETTING_PREFIX);
}

// Private governance state must never enter the ordinary planning/settings model.
// Preserve the original public rows and their order without mutating the caller.
function publicSettingsRows(rows = []) {
  if (!Array.isArray(rows)) throw new TypeError("Einstellungszeilen müssen ein Array sein.");
  return rows.filter(row => !isPrivacyOrganizationSettingKey(row?.key));
}

function publicSettingsObject(settings = {}) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new TypeError("Einstellungen müssen ein Objekt sein.");
  }
  return Object.fromEntries(Object.entries(settings)
    .filter(([key]) => !isPrivacyOrganizationSettingKey(key)));
}

module.exports = {
  PRIVACY_ORGANIZATION_SETTING_PREFIX,
  PRIVACY_ORGANIZATION_SETTING_KEY,
  isPrivacyOrganizationSettingKey,
  publicSettingsRows,
  publicSettingsObject,
};
