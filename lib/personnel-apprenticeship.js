"use strict";

const { isIsoDate } = require("./work-rules/calendar");
const KEYS = Object.freeze([
  "apprenticeshipStatus", "apprenticeshipConfirmed", "apprenticeshipValidFrom",
  "apprenticeshipValidTo", "apprenticeshipSourceReference",
]);
const STATUSES = new Set(["unknown", "active", "completed", "not_apprentice"]);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400, code: "PERSONNEL_APPRENTICESHIP_INVALID" });
}

function normalizeApprenticeshipFields(input = {}, current = {}) {
  const next = {
    apprenticeshipStatus: current.apprenticeshipStatus || "unknown",
    apprenticeshipConfirmed: current.apprenticeshipConfirmed === true,
    apprenticeshipValidFrom: current.apprenticeshipValidFrom || "",
    apprenticeshipValidTo: current.apprenticeshipValidTo || "",
    apprenticeshipSourceReference: current.apprenticeshipSourceReference || "",
  };
  for (const key of KEYS) {
    if (!own(input, key)) continue;
    if (key === "apprenticeshipConfirmed") {
      if (typeof input[key] !== "boolean") invalid("Die Bestätigung des Lehrlingsstatus muss ausdrücklich angegeben werden.");
      next[key] = input[key];
    } else {
      if (typeof input[key] !== "string" || input[key].includes("\0")) invalid("Bitte gültige Angaben zum Lehrlingsstatus eingeben.");
      next[key] = input[key].trim();
    }
  }
  const basisChanged = KEYS.some((key) => key !== "apprenticeshipConfirmed"
    && own(input, key) && next[key] !== (current[key] || (key === "apprenticeshipStatus" ? "unknown" : "")));
  if (basisChanged && input.apprenticeshipConfirmed !== true) next.apprenticeshipConfirmed = false;
  if (!STATUSES.has(next.apprenticeshipStatus)) invalid("Bitte einen gültigen Lehrlingsstatus auswählen.");
  for (const key of ["apprenticeshipValidFrom", "apprenticeshipValidTo"]) {
    if (next[key]) {
      const parsed = new Date(next[key] + "T12:00:00Z");
      if (!isIsoDate(next[key]) || !Number.isFinite(parsed.getTime())
          || parsed.toISOString().slice(0, 10) !== next[key]) {
        invalid("Bitte ein gültiges Datum für den Lehrlingsstatus eingeben.");
      }
    }
  }
  if (next.apprenticeshipValidFrom && next.apprenticeshipValidTo
      && next.apprenticeshipValidTo < next.apprenticeshipValidFrom) {
    invalid("Das Ende des Lehrlingsstatus darf nicht vor seinem Beginn liegen.");
  }
  if (next.apprenticeshipSourceReference.length > 240) invalid("Die Grundlage des Lehrlingsstatus darf höchstens 240 Zeichen enthalten.");
  if (next.apprenticeshipConfirmed) {
    if (next.apprenticeshipStatus === "unknown" || !next.apprenticeshipValidFrom
        || !next.apprenticeshipSourceReference) {
      invalid("Für einen bestätigten Lehrlingsstatus bitte Status, Gültigkeitsbeginn und Grundlage ergänzen.");
    }
    if (next.apprenticeshipStatus === "completed" && !next.apprenticeshipValidTo) {
      invalid("Bei einer bestätigten abgeschlossenen Lehre bitte das Abschlussdatum ergänzen.");
    }
  }
  return next;
}

module.exports = { APPRENTICESHIP_FIELD_KEYS: KEYS, normalizeApprenticeshipFields };
