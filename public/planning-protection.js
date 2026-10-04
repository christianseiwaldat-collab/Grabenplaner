(function initializePlanningProtection(global) {
  "use strict";

  const FIELD_KEY = "employment.protectionStatus";
  const PHASES = Object.freeze({
    unknown: "Ungeklärt", pregnancy: "Schwangerschaft", postpartum: "Nach der Entbindung",
    breastfeeding: "Stillzeit", not_applicable: "Nicht anwendbar", employment_prohibition: "Beschäftigungsverbot",
  });
  const PERIOD_FIELDS = Object.freeze(["id", "phase", "confirmed", "validFrom", "validTo", "referenceId", "normalDailyMinutes"]);

  function accessMode(access = {}, role = "") {
    if (!["hr", "admin", "developer"].includes(role)) return "hidden";
    const mode = access.fieldAccess?.[FIELD_KEY];
    return ["read", "write"].includes(mode) ? mode : "hidden";
  }

  function copyStatus(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.periods)) return null;
    return {
      version: 1, planningEnabled: value.planningEnabled === true,
      periods: value.periods.map((period) => Object.fromEntries(PERIOD_FIELDS.map((key) => [key, period?.[key]]))),
    };
  }

  function strictDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function statusError(value) {
    if (value === null) return "";
    if (!value || value.version !== 1 || typeof value.planningEnabled !== "boolean" || !Array.isArray(value.periods) || value.periods.length > 32) {
      return "Bitte höchstens 32 gültige Schutzzeiträume angeben.";
    }
    const ids = new Set();
    for (const period of value.periods) {
      if (!period || typeof period.id !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(period.id) || ids.has(period.id)) return "Die Zeitraumkennung ist ungültig oder doppelt.";
      ids.add(period.id);
      if (!Object.hasOwn(PHASES, period.phase) || typeof period.confirmed !== "boolean") return "Bitte Status und ausdrückliche Bestätigung prüfen.";
      if (!strictDate(period.validFrom) || (period.validTo !== "" && !strictDate(period.validTo)) || (period.validTo && period.validTo < period.validFrom)) {
        return "Jeder Zeitraum benötigt ein gültiges Anfangsdatum; das Ende darf nicht davor liegen.";
      }
      if (typeof period.referenceId !== "string" || (period.referenceId !== "" && !/^[A-Za-z0-9._:/-]{1,80}$/.test(period.referenceId))) {
        return "Die Belegkennung darf höchstens 80 Zeichen ohne Leerzeichen enthalten. Erlaubt sind Buchstaben, Zahlen sowie . _ : / - .";
      }
      if (period.confirmed && (period.phase === "unknown" || !period.referenceId)) return "Für die fachliche Bestätigung sind ein geklärter Status und eine interne Belegkennung erforderlich.";
      if (period.normalDailyMinutes !== null && (!Number.isInteger(period.normalDailyMinutes) || period.normalDailyMinutes < 1 || period.normalDailyMinutes > 540)) {
        return "Die reguläre tägliche Arbeitszeit muss zwischen 1 und 540 ganzen Minuten liegen; leer bleibt ungeklärt.";
      }
    }
    return "";
  }

  function statusHint(value) {
    const error = statusError(value);
    if (error) return error;
    if (!value) return "Kein Schutzstatus erfasst. Es erfolgt keine automatische Zuordnung.";
    if (!value.planningEnabled) return "Für die Planung nicht freigegeben. Die vertraulichen Angaben bleiben im Personalakt.";
    if (!value.periods.length || value.periods.some((period) => !period.confirmed || period.phase === "unknown")) {
      return "Monitor freigegeben; ungeklärte Angaben benötigen eine fachliche Prüfung. Planer sehen ausschließlich neutrale Auflagen.";
    }
    return "Fachliche Angaben bestätigt; für die Planung gelten ausschließlich abgeleitete Auflagen im Monitor. Dies ersetzt keine Planfreigabe.";
  }

  function createPeriod(id) {
    return { id, phase: "unknown", confirmed: false, validFrom: "", validTo: "", referenceId: "", normalDailyMinutes: null };
  }

  function sameStatus(left, right) {
    return JSON.stringify(copyStatus(left)) === JSON.stringify(copyStatus(right));
  }

  const api = Object.freeze({ FIELD_KEY, PHASES, accessMode, copyStatus, strictDate, statusError, statusHint, createPeriod, sameStatus });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (global) global.GPPlanningProtection = api;
})(typeof window === "undefined" ? null : window);
