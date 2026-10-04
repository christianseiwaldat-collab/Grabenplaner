(function initializeVocationalSchool(global) {
  "use strict";

  const KINDS = Object.freeze({ regular: "Regulär", block: "Blockunterricht", seasonal: "Saisonunterricht" });
  const SPECIAL_CASES = Object.freeze({
    none: "Kein Spezialfall", cancelled_lessons: "Unterrichtsausfall", elective: "Freifach",
    school_event: "Schulveranstaltung", support_course: "Förderkurs",
  });
  const APPRENTICESHIP_STATUSES = Object.freeze({
    unknown: "Ungeklärt", active: "Aktive Lehre", completed: "Lehre abgeschlossen", not_apprentice: "Kein Lehrverhältnis",
  });

  function nullableMinutes(value) {
    return value === null || value === undefined || String(value).trim() === "" ? null : Number(value);
  }

  function readDetails(option = {}) {
    let value = option.vocationalSchool ?? option.school_details_json;
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { return null; }
    }
    return value && typeof value === "object" && !Array.isArray(value) && value.version === 1 ? value : null;
  }

  function createDetails(input = {}) {
    const startTime = String(input.startTime || "").trim();
    const endTime = String(input.endTime || "").trim();
    const lunchMinutes = nullableMinutes(input.lunchMinutes);
    const travelMinutes = nullableMinutes(input.travelMinutes);
    const sourceReference = String(input.sourceReference || "").trim();
    const kind = input.kind || "regular";
    const specialCase = input.specialCase || "none";
    const confirmed = input.confirmed === true;
    if (!startTime && !endTime && lunchMinutes === null && travelMinutes === null && !sourceReference
      && !confirmed && kind === "regular" && specialCase === "none") return null;
    return { version: 1, kind, startTime, endTime, lunchMinutes, travelMinutes, confirmed, sourceReference, specialCase };
  }

  function timeMinutes(value) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""))) return null;
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  }

  function detailError(details) {
    if (!details) return "";
    if (!Object.hasOwn(KINDS, details.kind) || !Object.hasOwn(SPECIAL_CASES, details.specialCase)) {
      return "Bitte Unterrichtsform und Spezialfall auswählen.";
    }
    const start = timeMinutes(details.startTime), end = timeMinutes(details.endTime);
    if ((details.startTime && start === null) || (details.endTime && end === null) || (start !== null && end !== null && end <= start)) {
      return "Bitte gültige Unterrichtszeiten mit Ende nach Beginn eintragen.";
    }
    for (const value of [details.lunchMinutes, details.travelMinutes]) {
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 1440)) return "Minuten müssen ganze Zahlen zwischen 0 und 1440 sein; leer bedeutet ungeklärt.";
    }
    if (start !== null && end !== null && details.lunchMinutes !== null && details.lunchMinutes >= end - start) {
      return "Die Mittagspause muss kürzer als der Unterrichtszeitraum sein.";
    }
    if (details.confirmed && (start === null || end === null || details.lunchMinutes === null || !details.sourceReference)) {
      return "Für bestätigte Berufsschulangaben sind Unterrichtszeiten, Mittagspause und Quelle erforderlich.";
    }
    return "";
  }

  function detailHint(details) {
    const error = detailError(details);
    if (error) return error;
    if (!details?.confirmed) return "Berufsschulangaben ungeklärt. Ohne bestätigte Zeiten, Mittagspause und Quelle bleibt die Jugendprüfung offen.";
    const minutes = timeMinutes(details.endTime) - timeMinutes(details.startTime) - details.lunchMinutes;
    return `${KINDS[details.kind]} · ${minutes} Zeitminuten ohne Mittagspause; Kurzpausen zählen mit.${minutes >= 480 ? " Ab 480 Zeitminuten ist ein zusätzlicher betrieblicher Dienst gesondert zu prüfen." : ""}${details.travelMinutes === null ? " Wegezeit ungeklärt." : ` Wegezeit Schule–Betrieb: ${details.travelMinutes} Minuten.`}${details.specialCase !== "none" ? " Spezialfall benötigt eine eigene fachliche Prüfung." : ""}`;
  }

  function apprenticeshipHint(status = "unknown", confirmed = false, details = {}) {
    if (status === "unknown" || !Object.hasOwn(APPRENTICESHIP_STATUSES, status)) return "Lehrlingsstatus ungeklärt; die Position allein bestätigt kein Lehrverhältnis.";
    if (details.confirmationRestricted === true) return `${APPRENTICESHIP_STATUSES[status]} · Die fachliche Bestätigung ist in dieser Ansicht nicht freigegeben.`;
    if (confirmed && details.basisRestricted === true) return `${APPRENTICESHIP_STATUSES[status]} · fachlich bestätigt. Die Grundlage ist in dieser Ansicht nicht vollständig freigegeben.`;
    if (confirmed && (!details.validFrom || !String(details.sourceReference || "").trim() || (status === "completed" && !details.validTo))) {
      return `${APPRENTICESHIP_STATUSES[status]} · Bestätigung unvollständig: ${status === "not_apprentice" ? "gültig ab" : "belegten Lehrbeginn"} und Grundlage${status === "completed" ? " sowie letzten Lehrtag (einschließlich)" : ""} angeben.`;
    }
    return `${APPRENTICESHIP_STATUSES[status]} · ${confirmed === true ? "fachlich bestätigt" : "fachlich ungeklärt"}.${status === "completed" ? " Der letzte Lehrtag zählt einschließlich zur Lehre; für die Bestätigung wird das Abschlussdatum benötigt." : ""}`;
  }

  const api = Object.freeze({ KINDS, SPECIAL_CASES, APPRENTICESHIP_STATUSES, nullableMinutes, readDetails, createDetails, detailError, detailHint, apprenticeshipHint });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (global) global.GPVocationalSchool = api;
})(typeof window === "undefined" ? null : window);
