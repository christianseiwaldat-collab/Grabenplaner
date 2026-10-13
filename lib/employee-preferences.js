"use strict";

const PREFERRED_DAY_KEYS = Object.freeze(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);
const RETAIL_POSITION_IDS = new Set(["verkaufsmitarbeiter", "abteilungsleitung", "fl-stellvertretung", "teamleitung", "filialleitung", "lehrling"]);

// The existing nullable text column stores an ordered comma-separated list.
// Existing single-day records need no migration; their day remains priority 1.
function preferredDaysOff(value) {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value.preferredDaysOff ?? value.preferred_days_off ?? value.preferredDayOff ?? value.preferred_day_off
    : value;
  const days = Array.isArray(input) ? input : String(input || "").split(",");
  return [...new Set(days.map(day => String(day || "").trim()).filter(day => PREFERRED_DAY_KEYS.includes(day)))].slice(0, 4);
}

function preferredDaysLimit({ isBranch, positionId }) {
  return isBranch && RETAIL_POSITION_IDS.has(String(positionId || "")) ? 4 : 1;
}

function validatePreferredDays(value, limit = 4) {
  const input = value == null || value === "" ? [] : Array.isArray(value) ? value : String(value).split(",");
  if (input.length > limit || input.some(day => typeof day !== "string" || !PREFERRED_DAY_KEYS.includes(day.trim()))
    || new Set(input.map(day => day.trim())).size !== input.length) {
    throw Object.assign(new Error(`Bitte höchstens ${limit} unterschiedliche bevorzugte freie Tage auswählen.`), {
      status: 400, code: "EMPLOYEE_PREFERRED_DAYS_INVALID",
    });
  }
  return input.map(day => day.trim());
}

function preferredDayCost(employee, day) {
  const rank = preferredDaysOff(employee).indexOf(day);
  // Quarter-step units: the solver normalizes by 4 to preserve legacy weights.
  // A larger cost protects the higher priority, while all wishes stay soft.
  return rank < 0 ? 0 : 4 - rank;
}

function protectedPersonnelName(profile) {
  const identity = profile?.identity || profile?.sensitive?.identity || {};
  const firstName = String(identity.firstName || "").trim();
  const lastName = String(identity.lastName || "").trim();
  // Do not replace a complete public name with a partially entered identity.
  return firstName && lastName ? `${firstName} ${lastName}` : "";
}

module.exports = { PREFERRED_DAY_KEYS, preferredDaysOff, preferredDaysLimit, validatePreferredDays, preferredDayCost, protectedPersonnelName };
