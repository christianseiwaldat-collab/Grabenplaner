"use strict";

const CATALOG_VERSION = "at-work-rules-2026.1";
const CATALOG_EFFECTIVE_FROM = "2026-01-01";

const SOURCE_CATALOG = Object.freeze({
  "ris.azg.3": Object.freeze({
    id: "ris.azg.3",
    jurisdiction: "AT",
    title: "Arbeitszeitgesetz (AZG) § 3 – Normalarbeitszeit",
    url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=3",
    retrievedOn: "2026-07-23",
  }),
  "ris.azg.4": Object.freeze({
    id: "ris.azg.4",
    jurisdiction: "AT",
    title: "Arbeitszeitgesetz (AZG) § 4 – Andere Verteilung der Normalarbeitszeit",
    url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=4",
    retrievedOn: "2026-07-23",
  }),
  "ris.azg.7": Object.freeze({
    id: "ris.azg.7",
    jurisdiction: "AT",
    title: "Arbeitszeitgesetz (AZG) § 7 – Verlängerung bei erhöhtem Arbeitsbedarf",
    url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=7",
    retrievedOn: "2026-07-23",
  }),
  "ris.azg.9": Object.freeze({
    id: "ris.azg.9",
    jurisdiction: "AT",
    title: "Arbeitszeitgesetz (AZG) § 9 – Höchstgrenzen der Arbeitszeit",
    url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=9",
    retrievedOn: "2026-07-23",
  }),
  "ris.azg.11": Object.freeze({
    id: "ris.azg.11",
    jurisdiction: "AT",
    title: "Arbeitszeitgesetz (AZG) § 11 – Ruhepausen",
    url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=11",
    retrievedOn: "2026-07-23",
  }),
  "ris.azg.12": Object.freeze({
    id: "ris.azg.12",
    jurisdiction: "AT",
    title: "Arbeitszeitgesetz (AZG) § 12 – Ruhezeiten",
    url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=12",
    retrievedOn: "2026-07-23",
  }),
  "ris.arg.3": Object.freeze({
    id: "ris.arg.3",
    jurisdiction: "AT",
    title: "Arbeitsruhegesetz (ARG) § 3 – Wochenendruhe",
    url: "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008541",
    retrievedOn: "2026-07-23",
  }),
  "ris.arg.4": Object.freeze({
    id: "ris.arg.4",
    jurisdiction: "AT",
    title: "Arbeitsruhegesetz (ARG) § 4 – Wochenruhe",
    url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008541&Paragraf=4",
    retrievedOn: "2026-07-23",
  }),
  "ris.arg.7": Object.freeze({
    id: "ris.arg.7",
    jurisdiction: "AT",
    title: "Arbeitsruhegesetz (ARG) § 7 – Feiertagsruhe",
    url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008541&Paragraf=7",
    retrievedOn: "2026-07-23",
  }),
  "ris.arg.22f": Object.freeze({
    id: "ris.arg.22f",
    jurisdiction: "AT",
    title: "Arbeitsruhegesetz (ARG) § 22f – Sonderregelung für Verkaufstätigkeiten",
    url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008541&Paragraf=22f",
    retrievedOn: "2026-07-23",
  }),
  "ris.oeffzg.4": Object.freeze({
    id: "ris.oeffzg.4",
    jurisdiction: "AT",
    title: "Öffnungszeitengesetz 2003 § 4 – Allgemeine Offenhaltezeiten",
    url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=20002816&Paragraf=4",
    retrievedOn: "2026-07-23",
  }),
  "wko.kv.handel.2026": Object.freeze({
    id: "wko.kv.handel.2026",
    jurisdiction: "AT",
    title: "Kollektivvertrag für Angestellte und Lehrlinge in Handelsbetrieben 2026",
    url: "https://www.wko.at/kollektivvertrag/kollektivvertrag-handel-angestellte-2026.pdf",
    retrievedOn: "2026-07-23",
    applicabilityNote: "Die Anwendbarkeit muss je Arbeitgeber und Beschäftigtengruppe fachlich bestätigt werden.",
  }),
});

const RULE_DEFINITIONS = Object.freeze({
  "at.system.profile-boundary": Object.freeze({
    id: "at.system.profile-boundary",
    title: "Regelprofilwechsel im Prüfzeitraum",
    severity: "warning",
    enforcement: "manual_review",
    sourceRefs: Object.freeze([]),
  }),
  "at.applicability.adult": Object.freeze({
    id: "at.applicability.adult",
    title: "Anwendbarkeit des Erwachsenenprofils",
    severity: "warning",
    enforcement: "manual_review",
    sourceRefs: Object.freeze(["ris.azg.3"]),
  }),
  "at.azg.normal.daily": Object.freeze({
    id: "at.azg.normal.daily",
    title: "Tägliche Normalarbeitszeit",
    severity: "warning",
    enforcement: "advisory",
    sourceRefs: Object.freeze(["ris.azg.3"]),
  }),
  "at.azg.normal.weekly": Object.freeze({
    id: "at.azg.normal.weekly",
    title: "Wöchentliche Normalarbeitszeit",
    severity: "warning",
    enforcement: "advisory",
    sourceRefs: Object.freeze(["ris.azg.3"]),
  }),
  "at.azg.trade.average.4weeks": Object.freeze({
    id: "at.azg.trade.average.4weeks",
    title: "Vierwöchiger Schnitt der Normalarbeitszeit im Handel",
    severity: "warning",
    enforcement: "manual_review",
    sourceRefs: Object.freeze(["ris.azg.4"]),
  }),
  "at.azg.consent.daily": Object.freeze({
    id: "at.azg.consent.daily",
    title: "Hinweis auf Ablehnungsrecht nach mehr als zehn Stunden",
    severity: "warning",
    enforcement: "acknowledge",
    sourceRefs: Object.freeze(["ris.azg.7"]),
  }),
  "at.azg.consent.weekly": Object.freeze({
    id: "at.azg.consent.weekly",
    title: "Hinweis auf Ablehnungsrecht nach mehr als fünfzig Stunden",
    severity: "warning",
    enforcement: "acknowledge",
    sourceRefs: Object.freeze(["ris.azg.7"]),
  }),
  "at.azg.maximum.daily": Object.freeze({
    id: "at.azg.maximum.daily",
    title: "Tägliche Höchstarbeitszeit",
    severity: "critical",
    enforcement: "block",
    sourceRefs: Object.freeze(["ris.azg.9"]),
  }),
  "at.azg.maximum.weekly": Object.freeze({
    id: "at.azg.maximum.weekly",
    title: "Wöchentliche Höchstarbeitszeit",
    severity: "critical",
    enforcement: "block",
    sourceRefs: Object.freeze(["ris.azg.9"]),
  }),
  "at.azg.average.17weeks": Object.freeze({
    id: "at.azg.average.17weeks",
    title: "Durchschnittliche Wochenarbeitszeit über 17 Wochen",
    severity: "error",
    enforcement: "block",
    sourceRefs: Object.freeze(["ris.azg.9"]),
  }),
  "at.azg.break.after-six": Object.freeze({
    id: "at.azg.break.after-six",
    title: "Ruhepause bei mehr als sechs Stunden",
    severity: "error",
    enforcement: "exception_required",
    sourceRefs: Object.freeze(["ris.azg.11"]),
  }),
  "at.azg.daily-rest": Object.freeze({
    id: "at.azg.daily-rest",
    title: "Tägliche Ruhezeit",
    severity: "error",
    enforcement: "exception_required",
    sourceRefs: Object.freeze(["ris.azg.12"]),
  }),
  "at.arg.weekly-rest": Object.freeze({
    id: "at.arg.weekly-rest",
    title: "Wöchentliche Ruhezeit",
    severity: "error",
    enforcement: "exception_required",
    sourceRefs: Object.freeze(["ris.arg.3", "ris.arg.4"]),
  }),
  "at.arg.sunday-work": Object.freeze({
    id: "at.arg.sunday-work",
    title: "Beschäftigung am Sonntag",
    severity: "error",
    enforcement: "exception_required",
    sourceRefs: Object.freeze(["ris.arg.3", "ris.arg.4"]),
  }),
  "at.arg.holiday-work": Object.freeze({
    id: "at.arg.holiday-work",
    title: "Beschäftigung am Feiertag",
    severity: "error",
    enforcement: "exception_required",
    sourceRefs: Object.freeze(["ris.arg.7"]),
  }),
  "at.trade.saturday-after-18": Object.freeze({
    id: "at.trade.saturday-after-18",
    title: "Verkaufstätigkeit am Samstag nach 18 Uhr",
    severity: "error",
    enforcement: "exception_required",
    sourceRefs: Object.freeze(["ris.arg.22f", "ris.oeffzg.4"]),
  }),
});

const COMMON_LIMITS = Object.freeze({
  consentDailyMinutes: 10 * 60,
  consentWeeklyMinutes: 50 * 60,
  maximumDailyMinutes: 12 * 60,
  maximumWeeklyMinutes: 60 * 60,
  average17WeeksMinutes: 48 * 60,
  breakTriggerMinutes: 6 * 60,
  breakRequiredMinutes: 30,
  dailyRestMinutes: 11 * 60,
  weeklyRestMinutes: 36 * 60,
});

const PROFILE_CATALOG = Object.freeze({
  "at-general-adult": Object.freeze({
    id: "at-general-adult",
    version: "2026.1",
    catalogVersion: CATALOG_VERSION,
    title: "Österreich – allgemeines Erwachsenenprofil",
    status: "active",
    assignable: true,
    validFrom: CATALOG_EFFECTIVE_FROM,
    validTo: null,
    applicability: Object.freeze({
      jurisdiction: "AT",
      minimumAge: 18,
      confirmationRequired: true,
      note: "Das Profil bewertet ausschließlich geplante Arbeitszeit. Seine Anwendbarkeit muss für die Beschäftigung bestätigt sein.",
    }),
    defaultEnforcementMode: "enforced",
    limits: Object.freeze({
      ...COMMON_LIMITS,
      normalDailyMinutes: 8 * 60,
      normalWeeklyMinutes: 40 * 60,
      average4WeeksMinutes: null,
      saturdaySalesEndMinute: null,
    }),
    ruleIds: Object.freeze(Object.keys(RULE_DEFINITIONS).filter((id) => (
      !id.startsWith("at.system.")
      && id !== "at.azg.trade.average.4weeks"
      && id !== "at.trade.saturday-after-18"
    ))),
    sourceRefs: Object.freeze([
      "ris.azg.3", "ris.azg.7", "ris.azg.9", "ris.azg.11", "ris.azg.12",
      "ris.arg.3", "ris.arg.4", "ris.arg.7",
    ]),
  }),
  "at-retail-adult-monitor": Object.freeze({
    id: "at-retail-adult-monitor",
    version: "2026.1",
    catalogVersion: CATALOG_VERSION,
    title: "Österreich – Handel, Monitorprofil für Erwachsene",
    status: "active",
    assignable: true,
    validFrom: CATALOG_EFFECTIVE_FROM,
    validTo: null,
    applicability: Object.freeze({
      jurisdiction: "AT",
      sector: "retail",
      minimumAge: 18,
      confirmationRequired: true,
      note: "Handelszugehörigkeit und anwendbare Ausnahmen müssen fachlich bestätigt werden.",
    }),
    defaultEnforcementMode: "monitor",
    limits: Object.freeze({
      ...COMMON_LIMITS,
      normalDailyMinutes: 9 * 60,
      normalWeeklyMinutes: 44 * 60,
      average4WeeksMinutes: 40 * 60,
      saturdaySalesEndMinute: 18 * 60,
    }),
    ruleIds: Object.freeze(Object.keys(RULE_DEFINITIONS).filter((id) => !id.startsWith("at.system."))),
    sourceRefs: Object.freeze([
      "ris.azg.4", "ris.azg.7", "ris.azg.9", "ris.azg.11", "ris.azg.12",
      "ris.arg.3", "ris.arg.4", "ris.arg.7", "ris.arg.22f", "ris.oeffzg.4",
    ]),
  }),
  "at-retail-kv-2026-draft": Object.freeze({
    id: "at-retail-kv-2026-draft",
    version: "2026.1-draft",
    catalogVersion: CATALOG_VERSION,
    title: "Österreich – Kollektivvertrag Handel 2026 (Entwurf)",
    status: "draft",
    assignable: false,
    validFrom: CATALOG_EFFECTIVE_FROM,
    validTo: "2026-12-31",
    applicability: Object.freeze({
      jurisdiction: "AT",
      sector: "retail",
      minimumAge: 18,
      confirmationRequired: true,
      note: "Nicht zuweisen: kollektivvertragliche Anwendbarkeit und Regelmodell sind noch fachlich zu bestätigen.",
    }),
    defaultEnforcementMode: "monitor",
    limits: PROFILE_PLACEHOLDER_LIMITS(),
    ruleIds: Object.freeze([]),
    sourceRefs: Object.freeze(["wko.kv.handel.2026"]),
  }),
});

function PROFILE_PLACEHOLDER_LIMITS() {
  return Object.freeze({ ...COMMON_LIMITS });
}

const BUILTIN_WORK_RULE_PROFILES = Object.freeze(Object.fromEntries(
  Object.values(PROFILE_CATALOG).map((profile) => [profile.id, Object.freeze({
    ...profile,
    profile,
    rules: Object.freeze(profile.ruleIds.map((ruleId) => RULE_DEFINITIONS[ruleId]).filter(Boolean)),
    sources: Object.freeze(profile.sourceRefs.map((sourceId) => SOURCE_CATALOG[sourceId]).filter(Boolean)),
  })]),
));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getRuleCatalog() {
  return clone({
    version: CATALOG_VERSION,
    effectiveFrom: CATALOG_EFFECTIVE_FROM,
    legalNotice: "Planprüfungen sind technische Hinweise und keine Rechtsberatung oder Rechtskonformitätsbestätigung.",
    timeBasis: "planned_schedule",
    timeZone: "Europe/Vienna",
    sources: SOURCE_CATALOG,
    rules: RULE_DEFINITIONS,
    profiles: PROFILE_CATALOG,
  });
}

function getProfile(profileId) {
  const profile = PROFILE_CATALOG[String(profileId || "")];
  return profile ? clone(profile) : null;
}

module.exports = {
  BUILTIN_WORK_RULE_PROFILES,
  CATALOG_EFFECTIVE_FROM,
  CATALOG_VERSION,
  PROFILE_CATALOG,
  RULE_DEFINITIONS,
  SOURCE_CATALOG,
  getProfile,
  getRuleCatalog,
};
