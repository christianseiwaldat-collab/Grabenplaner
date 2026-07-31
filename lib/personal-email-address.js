"use strict";

const PERSONAL_EMAIL_ADDRESS_MAX_LENGTH = 320;

function stripPersonalEmailEmoji(value) {
  return String(value || "")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/[\u2600-\u27BF]/gu, "")
    .replace(/\uFEFF/g, "");
}

function normalizePersonalEmailAddress(value) {
  const raw = stripPersonalEmailEmoji(String(value || "").trim());
  if (!raw || raw.length > PERSONAL_EMAIL_ADDRESS_MAX_LENGTH || /[\r\n\s]/.test(raw)
    || !/^[^@]+@[^@]+\.[^@]+$/.test(raw)) {
    return null;
  }
  const separator = raw.lastIndexOf("@");
  return `${raw.slice(0, separator)}@${raw.slice(separator + 1).toLowerCase()}`;
}

module.exports = {
  PERSONAL_EMAIL_ADDRESS_MAX_LENGTH,
  normalizePersonalEmailAddress,
};
