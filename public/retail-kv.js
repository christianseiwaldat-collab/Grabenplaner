(function initializeRetailKv(global) {
  "use strict";
  const FIELD_KEY = "employment.retailKv";
  const SOURCE_VERSION = "wko.kv.handel.angestellte.2026.20261003";
  const SOURCE_SHA256 = "ea214b34db934d18a4c0b25c0ae6dd3b62dceb5255851e91ac25908cee876e90";
  const GROUPS = Object.freeze({ unknown: "Noch ungeklärt", salaried: "Handelsangestellte", apprentice: "Lehrling im Angestellten-KV", not_applicable: "Nicht anwendbar" });
  const MODELS = Object.freeze({ unknown: "Noch ungeklärt", standard: "Reguläre Wochenplanung", durchrechnung26Weeks: "Vereinbarte Durchrechnung bis 26 Wochen", agreement_other: "Anderes Modell · gesonderte Prüfung" });
  const AGREEMENTS = Object.freeze({ unknown: "Noch zu klären", none_confirmed: "Keine abweichende Vereinbarung · bestätigt", documented: "Vereinbarung belegt" });
  const WORKPLACES = Object.freeze({ unknown: "Noch ungeklärt", retail_sales: "Einzelhandel · Verkauf", retail_other: "Einzelhandel · andere Tätigkeit", wholesale_sales: "Großhandel · Verkauf", wholesale_other: "Großhandel · andere Tätigkeit" });
  const EXCEPTIONS = Object.freeze({ unknown: "Noch zu klären", none_confirmed: "Keine Sonderregelung · bestätigt", unsupported: "Sonderregelung · gesonderte Prüfung" });
  const PERIOD_FIELDS = Object.freeze(["id", "group", "confirmed", "validFrom", "validTo", "sourceReference", "collectiveAgreementVersionId", "approvedAssignmentId", "sourceVersion", "sourceSha256", "contractWeeklyMinutes", "normalWorkModel", "agreementStatus", "agreementReference", "agreementValidFrom", "agreementValidTo", "agreementConfirmedBy", "workplaceKind", "workplaceConfirmed", "exceptionModel", "averagingPeriod"]);
  function copyStatus(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.periods)) return null;
    return { version: 1, planningEnabled: value.planningEnabled === true, periods: value.periods.map(period => Object.fromEntries(PERIOD_FIELDS.map(key => [key, key === "averagingPeriod" ? (period[key] ? { ...period[key] } : null) : period[key]]))) };
  }
  function createPeriod(id) {
    return { id, group: "unknown", confirmed: false, validFrom: "", validTo: "", sourceReference: "", collectiveAgreementVersionId: "", approvedAssignmentId: "", sourceVersion: SOURCE_VERSION, sourceSha256: SOURCE_SHA256, contractWeeklyMinutes: null, normalWorkModel: "unknown", agreementStatus: "unknown", agreementReference: "", agreementValidFrom: "", agreementValidTo: "", agreementConfirmedBy: "", workplaceKind: "unknown", workplaceConfirmed: false, exceptionModel: "unknown", averagingPeriod: null };
  }
  function accessMode(access, user = {}) {
    if (!["hr", "admin"].includes(user.role) || user.localSystem === true || user.sessionKind === "local" || String(user.employeeNumber || "").toLowerCase() === "local") return "hidden";
    return ["read", "write"].includes(access?.fieldAccess?.[FIELD_KEY]) ? access.fieldAccess[FIELD_KEY] : "hidden";
  }
  function statusHint(value) {
    if (!value?.planningEnabled) return "Die KV-Planprüfung ist für diese Person ausgeschaltet.";
    if (!value.periods?.length || value.periods.some(period => !period.confirmed || period.group === "unknown" || !period.approvedAssignmentId || period.agreementStatus === "unknown")) return "Monitor vorbereitet; fehlende Angaben und Freigaben werden als ungeklärt angezeigt.";
    return "Die Dienstplanung prüft die freigegebene Zuordnung und den geltenden Quellenstand erneut. Diese Angaben ersetzen keine unabhängige KV-Freigabe.";
  }
  function confirmationResets(key) {
    const result = [];
    if (!["confirmed", "planningEnabled"].includes(key)) result.push("confirmed");
    if (["workplaceKind", "exceptionModel", "group", "validFrom", "validTo", "sourceReference", "collectiveAgreementVersionId", "approvedAssignmentId"].includes(key)) result.push("workplaceConfirmed");
    if (["averagingStart", "averagingEnd", "averagingCarry", "normalWorkModel", "contractWeeklyMinutes", "agreementStatus", "agreementReference", "agreementValidFrom", "agreementValidTo", "agreementConfirmedBy", "sourceReference", "collectiveAgreementVersionId", "approvedAssignmentId", "validFrom", "validTo", "group", "workplaceKind", "exceptionModel"].includes(key)) result.push("averagingConfirmed");
    return result;
  }
  const api = Object.freeze({ FIELD_KEY, SOURCE_VERSION, SOURCE_SHA256, GROUPS, MODELS, AGREEMENTS, WORKPLACES, EXCEPTIONS, PERIOD_FIELDS, copyStatus, createPeriod, accessMode, statusHint, confirmationResets });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (global) global.GPRetailKv = api;
})(typeof window === "undefined" ? null : window);
