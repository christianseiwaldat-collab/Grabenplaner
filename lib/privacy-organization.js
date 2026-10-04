"use strict";

// Process metadata only. This module never reads personnel facts or sends notifications.
const { randomUUID: cryptoRandomUUID } = require("node:crypto");
const { canonicalSha256, canonicalJson } = require("./work-rules/receipt");

const MAX_RECORDS = 256;
const MAX_EVENTS = 4000;
const MAX_RECORD_REVISIONS = 128;
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const STATUSES = ["draft", "submitted", "approved", "returned", "closed", "archived"];
const ACTIONS = ["create", "update", "submit", "approve", "return", "close", "archive", "record_notification"];
const PRIVACY_ROLES = new Set(["hr", "admin", "developer"]);

class PrivacyOrganizationError extends Error {
  constructor(code, message, statusCode = 400, details = undefined) {
    super(message);
    this.name = "PrivacyOrganizationError";
    this.code = code;
    this.statusCode = statusCode;
    if (details !== undefined) this.details = details;
  }
}
function fail(code, message, status = 400, details) { throw new PrivacyOrganizationError(code, message, status, details); }
function plain(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("INVALID_OBJECT", `${name}: Objekt erforderlich.`);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (!Object.hasOwn(descriptor, "value")) fail("INVALID_OBJECT", `${name}: Accessoren sind nicht zulässig.`);
}
function strictKeys(value, allowed, name) {
  plain(value, name);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key))) fail("UNKNOWN_FIELD", `${name}: Nicht unterstütztes Feld.`);
}
function jsonValue(value, depth = 0) {
  if (depth > 32) fail("INVALID_JSON", "Zu tief verschachtelte Daten.");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { if (value.length > 4000) fail("INVALID_JSON", "Zu viele Listeneinträge."); for (const item of value) jsonValue(item, depth + 1); return; }
  plain(value, "JSON");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) fail("INVALID_JSON", "Ungültiger JSON-Schlüssel.");
    jsonValue(value[key], depth + 1);
  }
}
function clone(value) { jsonValue(value); return JSON.parse(JSON.stringify(value)); }
function text(value, max, name, optional = true) {
  if (typeof value !== "string") fail("INVALID_FIELD", `${name}: Text erforderlich.`);
  const result = value.replace(/\r\n?/g, "\n").trim();
  if (result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result) || (!optional && !result)) fail("INVALID_FIELD", `${name}: Ungültiger Text.`);
  return result;
}
function reference(value, name, optional = true) {
  const result = text(value, 160, name, optional);
  if (/[\n\t,;<>{}]/.test(result)) fail("INVALID_REFERENCE", `${name}: Nur eine interne Belegreferenz verwenden.`);
  return result;
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && value.slice(0, 4) !== "0000";
}
function instant(value, name, optional = true) {
  if ((value === "" || value === null) && optional) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !validDate(value.slice(0, 10))) fail("INVALID_INSTANT", `${name}: Zeitpunkt mit Sekunden und eindeutigem Zeitzonenoffset erforderlich.`);
  const match = value.match(/T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3]) > 59 || (match[4] !== "Z" && (Number(match[6]) > 14 || Number(match[7]) > 59 || (Number(match[6]) === 14 && Number(match[7]) !== 0)))) fail("INVALID_INSTANT", `${name}: Ungültiger Zeitpunkt.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail("INVALID_INSTANT", `${name}: Ungültiger Zeitpunkt.`);
  return new Date(milliseconds).toISOString();
}
function freeze(value) { if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
function localDate(now) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now)); }
function field(key, label, type = "text", extra = {}) { return { key, label, type, help: "Nur Prozessmetadaten; keine Personenlisten, Diagnosen, Zugangsdaten oder Rohdaten.", requiredOnReview: false, ...extra }; }
function enumField(key, label, values, extra = {}) { return field(key, label, "enum", { default: "unknown", options: values.map(([value, optionLabel]) => ({ value, label: optionLabel })), ...extra }); }
const UNKNOWN = ["unknown", "Noch offen"];
const YES_NO = [UNKNOWN, ["yes", "Ja"], ["no", "Nein"]];
const REVIEW = { requiredOnReview: true };
const KIND_DEFINITIONS = [
  { id: "organization", label: "Organisation und Zuständigkeiten", fields: [
    field("controllerName", "Verantwortliche Organisation", "text", REVIEW), field("controllerContact", "Kontakt der verantwortlichen Organisation", "textarea", REVIEW),
    enumField("controllerRole", "Datenschutzrolle", [UNKNOWN, ["controller", "Verantwortlicher"], ["processor", "Auftragsverarbeiter"], ["both", "Beide Rollen, je Verarbeitung prüfen"]], REVIEW),
    field("dpoName", "Datenschutzbeauftragter"), field("dpoContact", "Kontakt Datenschutzbeauftragter"), field("dpoEmployeeNumber", "Persönliches GP-Konto des Datenschutzbeauftragten", "text", { help: "Optional: eine tatsächlich vorhandene Kontokennung. Die Namensangabe erzeugt kein Konto und keine Freigabe." }),
    enumField("worksCouncil", "Betriebsrat", [UNKNOWN, ["present", "Eingerichtet"], ["absent", "Kein Betriebsrat eingerichtet"]], REVIEW),
    field("privacyOwnerEmployeeNumber", "Verantwortliche Person: Kontokennung", "text", REVIEW), field("responseContact", "Erreichbare Anlaufstelle für Vorfälle", "text", REVIEW), field("reviewOn", "Nächste Organisationsprüfung", "date", REVIEW), field("notes", "Organisatorische Hinweise", "textarea"),
  ] },
  { id: "activity", label: "Datenlandkarte und VVT", fields: [
    field("title", "Verarbeitungstätigkeit", "text", REVIEW), field("ownerEmployeeNumber", "Prozessverantwortliche Person: Kontokennung", "text", REVIEW),
    field("purpose", "Zwecke", "textarea", REVIEW), field("systemScope", "Systeme und Verarbeitungsschritte", "textarea", REVIEW), field("dataSubjects", "Kategorien betroffener Personen", "textarea", REVIEW), field("dataCategories", "Datenkategorien", "textarea", REVIEW),
    field("recipients", "Empfängerkategorien; auch ausdrücklich keine", "textarea", REVIEW), field("processors", "Auftragsverarbeiter und Vertragsbelege; auch ausdrücklich keine", "textarea", REVIEW), field("storageLocations", "Speicherorte und Sicherungskopien", "textarea", REVIEW),
    enumField("transfers", "Drittlandübermittlungen", [UNKNOWN, ["none", "Keine, fachlich bestätigt"], ["documented", "Vorhanden und dokumentiert"]], REVIEW), field("transferDetails", "Drittland, Garantien und Belegreferenz", "textarea"),
    field("retention", "Löschfristen je Kategorie und Umgang mit Backups", "textarea", REVIEW), field("toms", "Technische und organisatorische Maßnahmen", "textarea", REVIEW), field("legalBasis", "Rechtsgrundlagen und Zweckzuordnung", "textarea", REVIEW),
    enumField("specialCategories", "Besondere Datenkategorien / Art. 9 oder 10", YES_NO, REVIEW), field("specialLegalBasis", "Zusätzliche Voraussetzungen für Art. 9 oder 10", "textarea"), field("sourceRefs", "Quellen- und Belegkennungen", "listrefs"), field("reviewOn", "Nächste VVT-Prüfung", "date", REVIEW),
  ] },
  { id: "dpia", label: "DSFA und Vorprüfung", fields: [
    field("title", "Prüfung", "text", REVIEW), field("activityId", "VVT-Datensatz-ID", "text", REVIEW), field("activitySha256", "Geprüfte VVT-Inhaltsprüfsumme", "text", { ...REVIEW, maxLength: 64 }),
    enumField("screening", "DSFA-Vorprüfung", [UNKNOWN, ["required", "DSFA erforderlich"], ["not_required", "Begründet nicht erforderlich"]], REVIEW),
    field("screeningReasons", "Einzelfallprüfung: Art. 35, DSFA-V und DSFA-AV", "textarea", REVIEW), field("screeningSourceRefs", "Geprüfte Rechtsquellenkennungen", "listrefs", { ...REVIEW, help: "Mindestens eine katalogisierte Rechtsquelle: gdpr-2016-679, at-dsfa-v oder at-dsfa-av. Keine automatische Ausnahme für Personalverwaltung." }),
    field("assessmentSummary", "Systematische Beschreibung der Verarbeitung", "textarea"), field("necessity", "Notwendigkeit und Verhältnismäßigkeit", "textarea"), field("risks", "Risiken für Rechte und Freiheiten", "textarea"), field("mitigations", "Maßnahmen und Wirksamkeitsbelege", "textarea"),
    enumField("residualRisk", "Verbleibendes Risiko", [UNKNOWN, ["low", "Niedrig"], ["medium", "Mittel"], ["high", "Hoch"]]), field("dpoAdvice", "Beratung des benannten Datenschutzbeauftragten / Beleg", "textarea", REVIEW),
    enumField("consultation", "Vorherige Behördenkonsultation", [UNKNOWN, ["not_required", "Begründet nicht erforderlich"], ["required", "Erforderlich"], ["pending", "Eingereicht, Ergebnis offen"], ["completed", "Abgeschlossen, Ergebnis dokumentiert"]]),
    field("consultationReference", "Konsultationsbeleg / Begründung", "text"), enumField("consultationOutcome", "Fachlich geprüftes Konsultationsergebnis", [UNKNOWN, ["conditions_satisfied", "Ergebnis geprüft, Auflagen erfüllt"], ["blocked", "Verarbeitung darf so nicht beginnen"]]), field("reviewOn", "Nächste DSFA-Prüfung", "date", REVIEW),
  ] },
  { id: "breach", label: "Datenpannen und Ablauf", fields: [
    field("title", "Vorfallbezeichnung ohne Personendaten", "text", REVIEW), field("ownerEmployeeNumber", "Vorfallverantwortliche Person: Kontokennung", "text", REVIEW),
    enumField("roleInIncident", "Rolle in diesem Vorfall", [UNKNOWN, ["controller", "Verantwortlicher"], ["processor", "Auftragsverarbeiter"]], REVIEW), field("discoveredAt", "Erkennung des Vorfalls", "instant", REVIEW), field("controllerAwareAt", "Kenntnis des Verantwortlichen", "instant", { help: "Hinreichende Gewissheit einer personenbezogenen Datenverletzung; ab hier laufen 72 absolute Stunden. Untersuchung oder GP-Freigabe verschieben den Beginn nicht." }), field("processorAwareAt", "Kenntnis des Auftragsverarbeiters", "instant"),
    enumField("breachConfirmed", "Verletzung personenbezogener Daten", YES_NO, REVIEW), field("classificationReason", "Begründung der Einordnung", "textarea", REVIEW), field("breachTypes", "Verletzungsarten: confidentiality, integrity, availability", "listrefs", { allowedValues: ["confidentiality", "integrity", "availability"] }),
    field("dataCategories", "Betroffene Datenkategorien", "textarea"), field("affectedGroups", "Betroffene Personenkategorien", "textarea"), field("approxPeople", "Ungefähre Anzahl Personen; leer bedeutet unbekannt", "number"), field("approxRecords", "Ungefähre Anzahl Datensätze; leer bedeutet unbekannt", "number"),
    field("consequences", "Wahrscheinliche Folgen", "textarea"), field("containment", "Sofortmaßnahmen", "textarea"), field("remediation", "Abhilfe und Maßnahmen", "textarea"), field("riskAssessment", "Konkrete Risikobeurteilung", "textarea"), enumField("risk", "Risiko für betroffene Personen", [UNKNOWN, ["none", "Voraussichtlich kein Risiko, begründet"], ["risk", "Risiko"], ["high", "Hohes Risiko"]]),
    enumField("authorityDecision", "Art. 33: Behördenmeldung", [UNKNOWN, ["notify", "Meldung erforderlich"], ["not_required", "Begründet nicht erforderlich"]]), field("authorityReason", "Begründung zur Behördenmeldung", "textarea"),
    enumField("subjectDecision", "Art. 34: Betroffeneninformation", [UNKNOWN, ["notify", "Unverzüglich informieren"], ["not_required", "Kein hohes Risiko, begründet"], ["exemption", "Konkrete Ausnahme geprüft"]]), field("subjectReason", "Begründung zur Betroffeneninformation", "textarea"), enumField("subjectException", "Art. 34-Ausnahme", [UNKNOWN, ["encryption", "Wirksame Unzugänglichkeit / Verschlüsselung"], ["risk_removed", "Hohes Risiko durch Maßnahmen beseitigt"], ["public_notice", "Unverhältnismäßiger Aufwand: öffentliche Information"]]),
    field("contact", "Anlaufstelle für weitere Informationen", "text"), field("lateReason", "Begründung einer Verzögerung", "textarea"), enumField("followUpStatus", "Nachmeldung / Untersuchung", [UNKNOWN, ["pending", "Weitere Informationen oder Nachmeldung offen"], ["completed", "Nachmeldung und Untersuchung abgeschlossen"], ["none_needed", "Keine weitere Nachmeldung nötig, begründet"]]), field("followUpReason", "Nachverfolgung und Abschlussbelege", "textarea"), field("remediationComplete", "Abhilfe abgeschlossen und Wirksamkeit geprüft", "boolean"), field("evidenceRefs", "Interne Belegkennungen ohne Rohdaten", "listrefs"),
  ] },
  { id: "works_agreement", label: "Betriebsvereinbarung und individuelle Zustimmung", fields: [
    field("title", "Regelungsgegenstand", "text", REVIEW), field("activityId", "VVT-Datensatz-ID", "text", REVIEW), field("activitySha256", "Geprüfte VVT-Inhaltsprüfsumme", "text", { ...REVIEW, maxLength: 64 }), field("scope", "Funktionsumfang und betroffener Betriebsteil", "textarea", REVIEW),
    enumField("worksCouncil", "Betriebsrat für diesen Geltungsbereich", [UNKNOWN, ["present", "Eingerichtet"], ["absent", "Kein Betriebsrat eingerichtet"]], REVIEW), enumField("assessment", "Arbeitsrechtliche Einordnung", [UNKNOWN, ["not_required", "Keine Zustimmungspflicht, begründet"], ["arbvg96", "ArbVG § 96"], ["arbvg96a", "ArbVG § 96a"], ["avrag10", "AVRAG § 10, ohne Betriebsrat"], ["not_permitted", "Maßnahme so nicht zulässig"]], REVIEW),
    field("assessmentReason", "Konkrete arbeitsrechtliche Prüfung", "textarea", REVIEW), field("gdprBasis", "Davon getrennte DSGVO-Rechtsgrundlage", "textarea", REVIEW), enumField("agreementStatus", "Stand des Rechtsinstruments", [UNKNOWN, ["draft", "In Vorbereitung"], ["effective", "Wirksam und geprüft"], ["terminated", "Beendet / gekündigt"], ["not_required", "Begründet nicht erforderlich"]], REVIEW),
    enumField("legalInstrument", "Tatsächliches Rechtsinstrument", [UNKNOWN, ["bv", "Betriebsvereinbarung"], ["conciliation", "Entscheidung der Schlichtungsstelle"], ["individual_consents", "Individuelle Zustimmungen gemäß AVRAG § 10"], ["not_required", "Begründet nicht erforderlich"]], REVIEW), field("instrumentReference", "Unterzeichneter Beleg / Entscheidungsbeleg", "text"), field("validFrom", "Wirksam ab", "date"), field("validTo", "Wirksam bis; leer bedeutet unbefristet", "date"),
    field("signatoriesConfirmed", "Zuständige Parteien / Unterzeichnungen geprüft", "boolean"), enumField("consentCoverage", "Abdeckung individueller Zustimmungen", [UNKNOWN, ["documented_complete", "Tatsächliche aktuelle Abdeckung belegt"], ["incomplete", "Abdeckung unvollständig"], ["not_required", "Nicht erforderlich, begründet"]]), field("consentEvidenceReference", "Geschützter Abdeckungsbeleg, keine Personenliste", "text"), field("withdrawalProcess", "Dauer, Kündigung und Umgang mit Wegfall der Zustimmung", "textarea"), field("reviewOn", "Nächste arbeitsrechtliche Prüfung", "date", REVIEW),
  ] },
];
const SOURCE_INPUTS = [
  { id: "gdpr-2016-679", title: "DSGVO, insbesondere Art. 30 und 33–36", url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj/deu", verifiedUrl: "https://cnpd.public.lu/de/legislation/droit-europ/union-europeenne/rgpd/chapitre-4.html", version: "Verordnung (EU) 2016/679, behördlicher Wortlaut geprüft", summary: "VVT, dokumentierte Datenschutzverletzungen, risikobezogene Meldung und Betroffeneninformation, vorherige DSFA und gegebenenfalls Konsultation." },
  { id: "at-dsb-breach", title: "Österreichische Datenschutzbehörde: Data Breach", url: "https://dsb.gv.at/eingabe-an-die-dsb/-meldung-data-breach", version: "Behördliche Hinweise, Abrufstand 2026-10-03", summary: "Meldung unverzüglich und möglichst binnen 72 Stunden ab Kenntnis; Ausnahme bei voraussichtlich keinem Risiko; Informationen können nachgemeldet werden." },
  { id: "edpb-breach-9-2022", title: "EDPB-Leitlinien 9/2022", url: "https://www.edpb.europa.eu/system/files/2023-04/edpb_guidelines_202209_personal_data_breach_notification_v2.0_en.pdf", version: "Version 2.0, angenommen 2023-03-28", summary: "Kenntnis bei hinreichender Gewissheit einer Datenverletzung; zügige Erstuntersuchung, Vertraulichkeit, Integrität und Verfügbarkeit getrennt betrachten." },
  { id: "at-dsfa-v", title: "Österreichische DSFA-V § 2", url: "https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40209192/NOR40209192.html", version: "BGBl. II Nr. 278/2018, § 2, Abrufstand 2026-10-03", summary: "Ein Kriterium aus Abs. 2 oder mindestens zwei Kriterien aus Abs. 3; DSFA-AV und allgemeine Art.-35-Prüfung getrennt beachten." },
  { id: "at-dsfa-av", title: "Österreichische DSFA-AV", url: "https://ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=20010206", version: "BGBl. II Nr. 108/2018, Fassung 2026-10-03", summary: "Ausnahmen nur bei tatsächlich erfasster Verarbeitung; Personalverwaltungszwecke sind begrenzt, besondere Kategorien erfordern die dort geregelten Voraussetzungen." },
  { id: "at-arbvg96", title: "ArbVG § 96", url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008329&Paragraf=96", version: "Tagesaktuelle Fassung, Abruf 2026-10-03", summary: "Zustimmung des Betriebsrats unter anderem für Kontrollmaßnahmen, welche die Menschenwürde berühren." },
  { id: "at-arbvg96a", title: "ArbVG § 96a", url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008329&Paragraf=96a", version: "Tagesaktuelle Fassung, Abruf 2026-10-03", summary: "Gesonderte Prüfung von Personal- und Beurteilungssystemen einschließlich notwendiger Verpflichtungserfüllung; ersetzbare Zustimmung lässt § 96 unberührt." },
  { id: "at-avrag10", title: "AVRAG § 10", url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008872&Paragraf=10", version: "Tagesaktuelle Fassung, Abruf 2026-10-03", summary: "Ohne Betriebsrat bedürfen einschlägige Kontrollmaßnahmen individueller Arbeitnehmerzustimmung; Dauer und mögliche schriftliche Kündigung beachten." },
];
const SOURCES = SOURCE_INPUTS.map((source) => {
  const ownSummary = { ...source, retrievedOn: "2026-10-03" };
  return { ...ownSummary, ownSummarySha256: canonicalSha256(ownSummary), hashKind: "application_summary_not_external_document" };
});
const TEMPLATE_SPECS = [
  ["hr", "Personalverwaltung", "Beschäftigtenstammdaten und geschützte Personalakte"], ["planning", "Dienstplanung", "Schichten, Einsatzorte und Planungskonflikte"], ["youth", "Jugend und Berufsschule", "Alters- und Lehrlingsstatus sowie Ausbildungszeiten"], ["protection", "Planungsschutz", "Datensparsame Schutzmerkmale und abgeleitete Einschränkungen"], ["time", "Zeiterfassung und WLAN", "Arbeitszeitereignisse, Netzwerkbezug und Verifikationsprozesse"], ["absence", "Abwesenheitsverwaltung", "Urlaubs- und Abwesenheitsprozesse"], ["portal", "Beschäftigtenportal", "Persönliche Ansichten und Antragsprozesse"], ["crm", "Kundenverwaltung", "Kundenkontakte und Geschäftsvorgänge"], ["cash-stock", "Kassen- und Lagerprozesse", "Kassenimporte, Artikel- und Warenbewegungen"], ["rental-orders", "Leihe und Bestellungen", "Leihvorgänge, Bestellungen und zugehörige Geschäftskontakte"], ["audit", "Zugriffsverwaltung und Audit", "Konten, Berechtigungen und Nachvollziehbarkeit"], ["backup", "Sicherung und Wiederherstellung", "Datensicherungen, Wiederherstellung und technische Aufbewahrung"],
];
const PRIVACY_ORGANIZATION_CATALOG = freeze({
  schemaVersion: 1, version: "at-eu-privacy-organization.2026-10-03.1", kinds: KIND_DEFINITIONS, sources: SOURCES,
  guides: [
    { id: "vvt", title: "Datenlandkarte → VVT", steps: ["Tatsächliche Prozesse, Systeme und Datenflüsse erheben.", "Verantwortliche, Zwecke, Rechtsgrundlagen, Empfänger, Aufbewahrung und TOMs dokumentieren.", "Fachlich unabhängig prüfen; Entwürfe und freigegebene Fassungen unterscheiden."] },
    { id: "dpia", title: "DSFA → gegebenenfalls vorherige Konsultation", steps: ["Jede Verarbeitung einzeln nach Art. 35, DSFA-V und DSFA-AV beurteilen.", "Erforderliche DSFA an die konkrete VVT-Fassung binden und den Datenschutzbeauftragten beraten lassen.", "Hohes Restrisiko und offene Konsultationsauflagen dürfen keine Freigabe erzeugen."] },
    { id: "breach", title: "Datenpanne: sofort reagieren", steps: ["Vorfall sichern und eindämmen; keine Rohdaten in dieses Register kopieren.", "Kenntniszeitpunkt und Folgen erheben, Datenschutzverantwortliche sofort einbinden.", "Behördenmeldung unverzüglich, möglichst binnen 72 Stunden; unbekanntes Risiko ist keine Entwarnung.", "Betroffeneninformation separat prüfen; Informationen bei Bedarf schrittweise nachmelden.", "Tatsächlich versandte Meldungen mit Zeitpunkt und Beleg dokumentieren; GP versendet nichts."] },
    { id: "works-agreement", title: "Betriebsvereinbarung / ohne Betriebsrat", steps: ["Funktionsumfang und arbeitsrechtliche Einordnung konkret prüfen.", "Bei fehlendem Betriebsrat einschlägige AVRAG-10-Zustimmungen und aktuelle Abdeckung belegen.", "GP-Freigabe, arbeitsrechtliches Rechtsinstrument und DSGVO-Rechtsgrundlage getrennt halten."] },
  ],
  activityTemplates: TEMPLATE_SPECS.map(([id, title, systemScope]) => ({ id, title, kind: "activity", factsStatus: "unconfirmed", payload: { title, systemScope }, note: "Arbeitsvorlage aus dem Funktionsbestand. Tatsächliche Verarbeitung und sämtliche rechtlichen Angaben sind betrieblich zu prüfen." })),
  limits: { records: MAX_RECORDS, events: MAX_EVENTS, recordRevisions: MAX_RECORD_REVISIONS, ledgerBytes: MAX_LEDGER_BYTES },
});
function kindDefinition(kind) { const definition = KIND_DEFINITIONS.find((item) => item.id === kind); if (!definition) fail("INVALID_KIND", "Unbekannte Datenschutz-Datensatzart."); return definition; }
function normalizePayload(kind, raw, previous = null) {
  const definition = kindDefinition(kind);
  strictKeys(raw, definition.fields.map((item) => item.key), "Prozessdaten");
  const result = {};
  for (const item of definition.fields) {
    const value = Object.hasOwn(raw, item.key) ? raw[item.key] : previous ? previous[item.key] : Object.hasOwn(item, "default") ? item.default : item.type === "boolean" ? false : ["number", "instant"].includes(item.type) ? null : item.type === "listrefs" ? [] : "";
    if (item.type === "enum") { if (!item.options.some((option) => option.value === value)) fail("INVALID_FIELD", `${item.label}: Ungültige Auswahl.`); result[item.key] = value; }
    else if (item.type === "boolean") { if (typeof value !== "boolean") fail("INVALID_FIELD", `${item.label}: Boolescher Wert erforderlich.`); result[item.key] = value; }
    else if (item.type === "number") { if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 1000000000)) fail("INVALID_FIELD", `${item.label}: Ganze Anzahl von 0 bis 1.000.000.000 oder null erforderlich.`); result[item.key] = value; }
    else if (item.type === "date") { if (value !== "" && !validDate(value)) fail("INVALID_DATE", `${item.label}: Gültiges Datum erforderlich.`); result[item.key] = value; }
    else if (item.type === "instant") result[item.key] = instant(value, item.label);
    else if (item.type === "listrefs") {
      if (!Array.isArray(value) || value.length > 32) fail("INVALID_FIELD", `${item.label}: Maximal 32 Belegkennungen.`);
      result[item.key] = value.map((entry) => reference(entry, item.label, false));
      if (new Set(result[item.key]).size !== result[item.key].length || (item.allowedValues && result[item.key].some((entry) => !item.allowedValues.includes(entry)))) fail("INVALID_FIELD", `${item.label}: Ungültige oder doppelte Kennung.`);
    } else result[item.key] = text(value, item.maxLength || (item.type === "textarea" ? 4000 : 240), item.label);
  }
  for (const key of ["activitySha256"]) if (Object.hasOwn(result, key) && result[key] && !HASH.test(result[key])) fail("INVALID_HASH", "VVT-Prüfsumme muss ein SHA-256-Wert sein.");
  for (const [from, to] of [["validFrom", "validTo"]]) if (result[from] && result[to] && result[to] < result[from]) fail("INVALID_DATE", "Gültigkeitsende liegt vor dem Beginn.");
  if (Buffer.byteLength(canonicalJson(result), "utf8") > 65536) fail("PAYLOAD_LIMIT", "Prozessdatensatz ist zu groß.", 413);
  return result;
}
function snapshotBase(record, at, actor, previousSnapshotSha256) {
  return { id: record.id, kind: record.kind, revision: record.revision, status: record.status, payload: record.payload, contentSha256: record.contentSha256,
    lastAuthor: record.lastAuthor, submittedBy: record.submittedBy, approvedBy: record.approvedBy, approvedAt: record.approvedAt, decision: record.decision, notifications: record.notifications,
    at, actor, previousSnapshotSha256 };
}
function sealRecord(record, at, actor) {
  const history = record.history || [];
  if (history.length >= MAX_RECORD_REVISIONS) fail("REVISION_LIMIT", "Datensatz-Revisionslimit erreicht.", 409);
  record.contentSha256 = canonicalSha256({ kind: record.kind, payload: record.payload });
  const base = snapshotBase(record, at, actor, history.at(-1)?.snapshotSha256 || null);
  record.history = [...history, { ...clone(base), snapshotSha256: canonicalSha256(base) }];
  record.updatedAt = at;
  return record;
}
function emptyRecord(id, kind, payload, author = "") { return { id, kind, revision: 0, status: "draft", payload, contentSha256: "", lastAuthor: author, submittedBy: "", approvedBy: "", approvedAt: null, decision: null, notifications: [], updatedAt: null, history: [] }; }
function createPrivacyLedger({ initialOrganization = {} } = {}) {
  const record = sealRecord(emptyRecord("organization", "organization", normalizePayload("organization", initialOrganization)), null, null);
  const genesisSha256 = canonicalSha256({ schemaVersion: 1, initialOrganization: record.history[0] });
  return { schemaVersion: 1, revision: 0, records: [record], events: [], genesisSha256, receiptSha256: genesisSha256 };
}
function verifyPrivacyLedger(ledger) {
  strictKeys(ledger, ["schemaVersion", "revision", "records", "events", "genesisSha256", "receiptSha256"], "Datenschutzregister");
  jsonValue(ledger);
  if (Buffer.byteLength(canonicalJson(ledger), "utf8") > MAX_LEDGER_BYTES) fail("LEDGER_LIMIT", "Datenschutzregister ist zu groß.", 413);
  if (ledger.schemaVersion !== 1 || !Number.isSafeInteger(ledger.revision) || ledger.revision < 0 || !Array.isArray(ledger.records) || ledger.records.length < 1 || ledger.records.length > MAX_RECORDS || !Array.isArray(ledger.events) || ledger.events.length > MAX_EVENTS || ledger.revision !== ledger.events.length || !HASH.test(ledger.genesisSha256) || !HASH.test(ledger.receiptSha256)) fail("INVALID_LEDGER", "Ungültiges Datenschutzregister.");
  const snapshots = new Map(); const ids = new Set();
  for (const record of ledger.records) {
    strictKeys(record, ["id", "kind", "revision", "status", "payload", "contentSha256", "lastAuthor", "submittedBy", "approvedBy", "approvedAt", "decision", "notifications", "updatedAt", "history"], "Datensatz");
    if (!ID.test(record.id) || ids.has(record.id) || !Number.isSafeInteger(record.revision) || !STATUSES.includes(record.status) || !Array.isArray(record.history) || !record.history.length || record.history.length > MAX_RECORD_REVISIONS) fail("INVALID_LEDGER", "Ungültiger Datensatz.");
    ids.add(record.id); kindDefinition(record.kind);
    if (canonicalJson(normalizePayload(record.kind, record.payload)) !== canonicalJson(record.payload)) fail("INVALID_LEDGER", "Nicht kanonische Prozessdaten.");
    let previousHash = null; let expectedRevision = record.id === "organization" ? 0 : 1;
    for (const snapshot of record.history) {
      strictKeys(snapshot, ["id", "kind", "revision", "status", "payload", "contentSha256", "lastAuthor", "submittedBy", "approvedBy", "approvedAt", "decision", "notifications", "at", "actor", "previousSnapshotSha256", "snapshotSha256"], "Revisionsbeleg");
      const { snapshotSha256, ...base } = snapshot;
      if (snapshot.id !== record.id || snapshot.kind !== record.kind || snapshot.revision !== expectedRevision++ || snapshot.previousSnapshotSha256 !== previousHash || canonicalSha256(base) !== snapshotSha256 || canonicalSha256({ kind: record.kind, payload: snapshot.payload }) !== snapshot.contentSha256 || !STATUSES.includes(snapshot.status)) fail("INTEGRITY_FAILURE", "Revisionsbeleg ist beschädigt.", 409);
      if (canonicalJson(normalizePayload(record.kind, snapshot.payload)) !== canonicalJson(snapshot.payload)) fail("INTEGRITY_FAILURE", "Revisionsdaten sind beschädigt.", 409);
      if (snapshot.at !== null) instant(snapshot.at, "Revisionszeit", false);
      if (snapshot.approvedAt !== null) instant(snapshot.approvedAt, "Freigabezeit", false);
      if (!Array.isArray(snapshot.notifications) || snapshot.notifications.length > 32) fail("INTEGRITY_FAILURE", "Meldebelege sind beschädigt.", 409);
      if (snapshot.approvedBy && (snapshot.approvedBy === snapshot.lastAuthor || snapshot.approvedBy === snapshot.submittedBy)) fail("INTEGRITY_FAILURE", "Freigabe ist nicht unabhängig.", 409);
      snapshots.set(`${snapshot.id}@${snapshot.revision}`, snapshot);
      previousHash = snapshotSha256;
    }
    const current = record.history.at(-1);
    const { snapshotSha256: ignoredSnapshotHash, ...currentBase } = current;
    if (canonicalJson(snapshotBase(record, record.updatedAt, current.actor, current.previousSnapshotSha256)) !== canonicalJson(currentBase)) fail("INTEGRITY_FAILURE", "Aktueller Datensatz entspricht keinem Revisionsbeleg.", 409);
  }
  const organization = ledger.records.find((record) => record.id === "organization");
  if (!organization || organization.kind !== "organization" || ledger.records.some((record) => record.kind === "organization" && record.id !== "organization") || canonicalSha256({ schemaVersion: 1, initialOrganization: organization.history[0] }) !== ledger.genesisSha256) fail("INTEGRITY_FAILURE", "Organisationsbeleg ist beschädigt.", 409);
  let previousHash = ledger.genesisSha256; const consumed = new Set();
  for (let index = 0; index < ledger.events.length; index++) {
    const event = ledger.events[index];
    strictKeys(event, ["revision", "action", "recordId", "kind", "recordRevision", "actor", "at", "previousSha256", "snapshotSha256", "sha256"], "Änderungsbeleg");
    const { sha256, ...base } = event; const key = `${event.recordId}@${event.recordRevision}`; const snapshot = snapshots.get(key);
    if (event.revision !== index + 1 || !ACTIONS.includes(event.action) || event.previousSha256 !== previousHash || canonicalSha256(base) !== sha256 || !snapshot || consumed.has(key) || snapshot.snapshotSha256 !== event.snapshotSha256 || snapshot.kind !== event.kind || snapshot.at !== event.at || canonicalJson(snapshot.actor) !== canonicalJson(event.actor)) fail("INTEGRITY_FAILURE", "Änderungskette ist beschädigt.", 409);
    strictKeys(event.actor, ["employeeNumber", "role", "permissionUsed"], "Akteurbeleg");
    if (!ID.test(event.actor.employeeNumber) || !["privacy_organization:manage", "privacy_organization:approve"].includes(event.actor.permissionUsed) || typeof event.actor.role !== "string") fail("INTEGRITY_FAILURE", "Akteurbeleg ist beschädigt.", 409);
    if (event.action === "approve" && (snapshot.status !== "approved" || snapshot.approvedBy !== event.actor.employeeNumber || event.actor.permissionUsed !== "privacy_organization:approve")) fail("INTEGRITY_FAILURE", "Freigabebeleg ist beschädigt.", 409);
    consumed.add(key); previousHash = sha256;
  }
  if (consumed.size !== snapshots.size - 1 || previousHash !== ledger.receiptSha256) fail("INTEGRITY_FAILURE", "Änderungskette ist unvollständig.", 409);
  return { valid: true, revision: ledger.revision, receiptSha256: ledger.receiptSha256 };
}
function issue(issues, code, fieldKey, message) { issues.push({ code, field: fieldKey, message }); }
function organizationReady(ledger, now) {
  const org = ledger.records.find((record) => record.id === "organization");
  return org && org.status === "approved" && kindDefinition("organization").fields.filter((entry) => entry.requiredOnReview).every((entry) => meaningful(org.payload[entry.key])) && (!org.payload.dpoName || !!org.payload.dpoContact) && (!now || org.payload.reviewOn >= localDate(now));
}
function meaningful(value) { return value !== null && value !== "" && value !== "unknown" && (!Array.isArray(value) || value.length > 0); }
function linkedActivity(ledger, payload, issues, now) {
  const linked = ledger.records.find((record) => record.id === payload.activityId && record.kind === "activity");
  if (!linked || linked.status !== "approved") issue(issues, "VVT_NOT_APPROVED", "activityId", "Eine aktuell fachlich freigegebene VVT-Fassung ist erforderlich.");
  else if (!readinessFor(ledger, linked, now).releaseReady) issue(issues, "VVT_REVIEW_NOT_CURRENT", "activityId", "Die verknüpfte VVT-Fassung benötigt eine aktuelle vollständige fachliche Prüfung.");
  if (!linked || linked.contentSha256 !== payload.activitySha256) issue(issues, "STALE_VVT", "activitySha256", "Die VVT-Verknüpfung fehlt oder bezieht sich auf eine andere Inhaltsfassung.");
  return linked;
}
function readinessFor(ledger, record, now) {
  const issues = []; const warnings = []; const p = record.payload; const today = localDate(now);
  for (const entry of kindDefinition(record.kind).fields) if (entry.requiredOnReview && !meaningful(p[entry.key])) issue(issues, "REQUIRED", entry.key, `${entry.label}: Fachlich bestätigen oder vervollständigen.`);
  if (record.kind === "organization") {
    if (p.dpoName && !p.dpoContact) issue(issues, "DPO_CONTACT_MISSING", "dpoContact", "Kontakt des benannten Datenschutzbeauftragten fehlt.");
    if (p.dpoName && !p.dpoEmployeeNumber) warnings.push({ code: "DPO_NO_GP_ACCOUNT", field: "dpoEmployeeNumber", message: "Der benannte Datenschutzbeauftragte hat hier noch kein verknüpftes persönliches GP-Konto. Beratung kann mit externem Beleg dokumentiert werden." });
  } else if (record.kind !== "breach" && !organizationReady(ledger, now)) issue(issues, "ORGANIZATION_NOT_APPROVED", "organization", "Verantwortliche Organisation und Zuständigkeiten zuerst vervollständigen und unabhängig freigeben.");
  if (p.reviewOn && p.reviewOn < today) issue(issues, "REVIEW_OVERDUE", "reviewOn", "Die vorgesehene fachliche Prüfung ist fällig.");
  if (record.kind === "activity") {
    if (p.transfers === "documented" && !p.transferDetails) issue(issues, "TRANSFER_DETAILS_MISSING", "transferDetails", "Drittland und Transfergarantien dokumentieren.");
    if (p.specialCategories === "yes" && !p.specialLegalBasis) issue(issues, "SPECIAL_BASIS_MISSING", "specialLegalBasis", "Zusätzliche Voraussetzungen für besondere Datenkategorien fehlen.");
  }
  if (record.kind === "dpia") {
    linkedActivity(ledger, p, issues, now);
    if (!p.screeningSourceRefs.some((id) => ["gdpr-2016-679", "at-dsfa-v", "at-dsfa-av"].includes(id))) issue(issues, "SCREENING_SOURCES_MISSING", "screeningSourceRefs", "Art. 35 und die tatsächliche österreichische Listeneinordnung belegen.");
    if (p.screening === "required") {
      for (const key of ["assessmentSummary", "necessity", "risks", "mitigations", "residualRisk", "consultation"]) if (!meaningful(p[key])) issue(issues, "DSFA_INCOMPLETE", key, "Die erforderliche DSFA ist noch nicht vollständig.");
      if (p.residualRisk === "high" && (p.consultation !== "completed" || p.consultationOutcome !== "conditions_satisfied" || !p.consultationReference)) issue(issues, "CONSULTATION_OPEN", "consultation", "Hohes Restrisiko: vorherige Konsultation, Ergebnis und erfüllte Auflagen dokumentieren.");
      if (["required", "pending"].includes(p.consultation) || p.consultationOutcome === "blocked") issue(issues, "CONSULTATION_OPEN", "consultation", "Konsultation oder entgegenstehendes Ergebnis ist noch offen.");
      if (p.consultation === "completed" && (!p.consultationReference || p.consultationOutcome !== "conditions_satisfied")) issue(issues, "CONSULTATION_OUTCOME_MISSING", "consultationOutcome", "Abgeschlossenes Konsultationsergebnis und erfüllte Bedingungen belegen.");
      if (p.consultation === "not_required" && !p.consultationReference) issue(issues, "CONSULTATION_REASON_MISSING", "consultationReference", "Nicht erforderliche Konsultation begründen.");
    }
    if (p.screening === "not_required" && (p.residualRisk === "high" || ["required", "pending"].includes(p.consultation))) issue(issues, "SCREENING_CONTRADICTION", "screening", "Begründete Nichtpflicht widerspricht den erfassten Hochrisiko-/Konsultationsangaben.");
  }
  if (record.kind === "breach") {
    for (const key of ["discoveredAt", "controllerAwareAt", "processorAwareAt"]) if (p[key] && Date.parse(p[key]) > Date.parse(now)) issue(issues, "FUTURE_INCIDENT_TIME", key, "Vorfallzeitpunkt liegt in der Zukunft.");
    if (p.breachConfirmed === "yes") {
      const awareness = p.roleInIncident === "processor" ? "processorAwareAt" : "controllerAwareAt";
      if (!p[awareness]) issue(issues, "AWARENESS_MISSING", awareness, "Kenntniszeitpunkt fehlt; Meldepflicht und Frist sind offen.");
      for (const key of ["breachTypes", "dataCategories", "affectedGroups", "consequences", "containment", "remediation", "riskAssessment", "risk", "contact"]) if (!meaningful(p[key])) issue(issues, "BREACH_INCOMPLETE", key, "Einordnung, Folgen, Maßnahmen oder Risikobeurteilung vervollständigen.");
      if (p.roleInIncident === "controller") {
        if (p.authorityDecision === "unknown") issue(issues, "AUTHORITY_DECISION_OPEN", "authorityDecision", "Behördenmeldung fachlich entscheiden; die Frist läuft unabhängig von der GP-Freigabe.");
        if (p.authorityDecision === "not_required" && (p.risk !== "none" || !p.authorityReason)) issue(issues, "NO_REPORT_UNJUSTIFIED", "authorityReason", "Nichtmeldung verlangt voraussichtlich kein Risiko und eine konkrete Begründung.");
        if (["risk", "high"].includes(p.risk) && p.authorityDecision !== "notify") issue(issues, "REPORT_REQUIRED", "authorityDecision", "Bei Risiko ist die Behördenmeldung erforderlich.");
        if (p.subjectDecision === "unknown") issue(issues, "SUBJECT_DECISION_OPEN", "subjectDecision", "Betroffeneninformation separat beurteilen.");
        if (p.risk === "high" && !["notify", "exemption"].includes(p.subjectDecision)) issue(issues, "SUBJECTS_REQUIRED", "subjectDecision", "Hohes Risiko erfordert unverzügliche Information oder konkrete Ausnahmenprüfung.");
        if (["not_required", "exemption"].includes(p.subjectDecision) && !p.subjectReason) issue(issues, "SUBJECT_REASON_MISSING", "subjectReason", "Entscheidung zur Betroffeneninformation begründen.");
        if (p.subjectDecision === "exemption" && (p.risk !== "high" || !meaningful(p.subjectException))) issue(issues, "SUBJECT_EXCEPTION_MISSING", "subjectException", "Die konkrete Art.-34-Ausnahme prüfen und belegen.");
      }
    }
    if (p.approxPeople === null || p.approxRecords === null) warnings.push({ code: "COUNTS_UNCONFIRMED", field: "approxPeople", message: "Unbekannte ungefähre Anzahlen sind nachzuerheben; sie verhindern keine rechtzeitige erste Meldung." });
  }
  if (record.kind === "works_agreement") {
    linkedActivity(ledger, p, issues, now);
    const org = ledger.records.find((item) => item.id === "organization");
    if (org && org.payload.worksCouncil !== "unknown" && p.worksCouncil !== org.payload.worksCouncil) issue(issues, "WORKS_COUNCIL_CONFLICT", "worksCouncil", "Betriebsratsstatus widerspricht der Organisationsgrundlage; Geltungsbereich fachlich klären.");
    if (p.assessment === "not_permitted") issue(issues, "MEASURE_NOT_PERMITTED", "assessment", "Die Maßnahme ist in dieser Fassung nicht freigabefähig.");
    if (p.assessment === "not_required") {
      if (p.agreementStatus !== "not_required" || p.legalInstrument !== "not_required") issue(issues, "INSTRUMENT_CONTRADICTION", "legalInstrument", "Nicht erforderliches Rechtsinstrument ausdrücklich und konsistent begründen.");
    } else if (p.assessment !== "unknown") {
      if (p.agreementStatus !== "effective" || !p.instrumentReference || !p.signatoriesConfirmed || !p.validFrom) issue(issues, "INSTRUMENT_NOT_EFFECTIVE", "instrumentReference", "Tatsächlich wirksames, unterzeichnetes Rechtsinstrument belegen.");
      if (p.validFrom && p.validFrom > today) issue(issues, "INSTRUMENT_FUTURE", "validFrom", "Rechtsinstrument ist noch nicht wirksam.");
      if (p.validTo && p.validTo < today) issue(issues, "INSTRUMENT_EXPIRED", "validTo", "Rechtsinstrument ist nicht mehr wirksam.");
      if (p.worksCouncil === "absent" && (p.assessment !== "avrag10" || p.legalInstrument !== "individual_consents" || p.consentCoverage !== "documented_complete" || !p.consentEvidenceReference || !p.withdrawalProcess)) issue(issues, "INDIVIDUAL_CONSENTS_MISSING", "consentCoverage", "Ohne Betriebsrat sind einschlägige tatsächliche AVRAG-10-Zustimmungen, Abdeckung und Kündigungsprozess gesondert zu belegen.");
      if (p.worksCouncil === "present" && p.assessment === "avrag10") issue(issues, "WRONG_INSTRUMENT", "assessment", "AVRAG-10-Einzelzustimmungen ersetzen bei eingerichtetem Betriebsrat keine erforderliche Betriebsvereinbarung.");
      if (p.worksCouncil === "present" && p.assessment === "arbvg96" && p.legalInstrument !== "bv") issue(issues, "ARbVG96_NOT_SUBSTITUTABLE", "legalInstrument", "Eine Schlichtungsentscheidung ersetzt die erforderliche §-96-Zustimmung nicht.");
      if (p.worksCouncil === "present" && p.assessment === "arbvg96a" && !["bv", "conciliation"].includes(p.legalInstrument)) issue(issues, "WRONG_INSTRUMENT", "legalInstrument", "§ 96a erfordert das konkret passende Rechtsinstrument; § 96 bleibt gesondert zu prüfen.");
    }
  }
  const operationalComplete = record.kind !== "breach" || breachObligationsComplete(record, now);
  if (record.kind === "breach" && !operationalComplete) warnings.push({ code: "BREACH_ACTIONS_OPEN", field: "followUpStatus", message: "Erforderliche tatsächliche Meldungen, Nachverfolgung oder Abhilfe sind noch offen. Eine fachliche GP-Freigabe erledigt diese Schritte nicht." });
  return { ready: issues.length === 0, issues, warnings, ...(record.kind === "breach" ? { operationalComplete } : {}), releaseReady: record.status === "approved" && issues.length === 0 && operationalComplete };
}
function breachDeadlines(record, now) {
  const p = record.payload; const notifications = record.notifications; const epoch = Date.parse(now);
  const initial = (channel) => notifications.filter((entry) => entry.channel === channel && entry.phase !== "follow_up").sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt))[0];
  // An edit or an internal review must never restart an already recorded statutory clock.
  const awarenessCandidates = [p, ...record.history.map((entry) => entry.payload)]
    .filter((entry) => entry.roleInIncident === "controller" && entry.breachConfirmed === "yes" && entry.controllerAwareAt)
    .map((entry) => entry.controllerAwareAt).sort((a, b) => Date.parse(a) - Date.parse(b));
  const effectiveControllerAwareAt = awarenessCandidates[0] || null;
  const due = p.roleInIncident === "controller" && p.breachConfirmed === "yes" && effectiveControllerAwareAt ? new Date(Date.parse(effectiveControllerAwareAt) + 72 * 3600000).toISOString() : null;
  const authority = initial("authority");
  let authorityState = "unknown";
  if (p.roleInIncident === "processor") authorityState = "controller_responsibility";
  else if (p.breachConfirmed === "no") authorityState = "not_required";
  else if (p.authorityDecision === "not_required" && p.risk === "none" && p.authorityReason) authorityState = "not_required";
  else if (authority) authorityState = due && Date.parse(authority.sentAt) > Date.parse(due) ? "recorded_late" : "recorded";
  else if (due) authorityState = epoch > Date.parse(due) ? "overdue" : epoch === Date.parse(due) ? "due" : "pending";
  let subjectsState = "unknown";
  if (p.roleInIncident === "processor") subjectsState = "controller_responsibility";
  else if (p.breachConfirmed === "no") subjectsState = "not_required";
  else if (p.subjectDecision === "notify") subjectsState = initial("subjects") ? "recorded" : "pending_immediate";
  else if (p.subjectDecision === "not_required" && ["none", "risk"].includes(p.risk) && p.subjectReason) subjectsState = "not_required";
  else if (p.subjectDecision === "exemption" && p.risk === "high" && p.subjectReason && meaningful(p.subjectException)) subjectsState = p.subjectException === "public_notice" ? notifications.some((entry) => entry.channel === "subjects" && entry.phase === "public_notice") ? "recorded_public_notice" : "pending_public_notice" : "documented_exemption";
  const processorState = p.roleInIncident === "processor" && p.breachConfirmed === "yes" ? initial("controller") ? "recorded" : "pending_immediate" : "not_applicable";
  return { effectiveControllerAwareAt, authorityDueAt: due, authorityState, hoursRemaining: due ? (Date.parse(due) - epoch) / 3600000 : null, processorState, subjectsState };
}
function breachObligationsComplete(record, now) {
  if (record.payload.breachConfirmed === "no") return true;
  if (record.payload.breachConfirmed !== "yes") return false;
  const deadlines = breachDeadlines(record, now);
  return !["unknown", "pending", "due", "overdue"].includes(deadlines.authorityState)
    && !["unknown", "pending_immediate", "pending_public_notice"].includes(deadlines.subjectsState)
    && deadlines.processorState !== "pending_immediate"
    && ["completed", "none_needed"].includes(record.payload.followUpStatus)
    && !!record.payload.followUpReason && record.payload.remediationComplete;
}
function projectPrivacyLedger(ledger, { now = new Date().toISOString() } = {}) {
  verifyPrivacyLedger(ledger); now = instant(now, "Auswertungszeit", false);
  const records = ledger.records.map((record) => ({ ...clone(record), readiness: readinessFor(ledger, record, now), ...(record.kind === "breach" ? { deadlines: breachDeadlines(record, now) } : {}) }));
  const organization = records.find((record) => record.id === "organization");
  return { schemaVersion: 1, revision: ledger.revision, receiptSha256: ledger.receiptSha256, evaluatedAt: now, organization, records,
    summary: { total: records.length, drafts: records.filter((record) => ["draft", "returned"].includes(record.status)).length, awaitingApproval: records.filter((record) => record.status === "submitted").length, approved: records.filter((record) => record.status === "approved").length, reviewNeeded: records.filter((record) => record.status === "approved" && !record.readiness.ready).length, openIncidents: records.filter((record) => record.kind === "breach" && !["closed", "archived"].includes(record.status)).length, overdueIncidents: records.filter((record) => record.deadlines?.authorityState === "overdue").length, releaseReady: organizationReady(ledger, now) && records.filter((record) => !["closed", "archived"].includes(record.status)).every((record) => record.readiness.releaseReady) } };
}
function trustedActor(context, action) {
  plain(context, "Berechtigungskontext"); plain(context.actor, "Persönlicher Akteur");
  const actor = context.actor; const permission = action === "approve" ? "privacy_organization:approve" : "privacy_organization:manage";
  if (actor.personal !== true || typeof actor.employeeNumber !== "string" || !ID.test(actor.employeeNumber) || !PRIVACY_ROLES.has(actor.role) || !Array.isArray(actor.permissions) || !actor.permissions.includes(permission)) fail("FORBIDDEN", "Persönliches berechtigtes Konto erforderlich.", 403);
  return { employeeNumber: actor.employeeNumber, role: actor.role, permissionUsed: permission };
}
function decisionReason(decision, optional = false) {
  if (decision === undefined && optional) return null;
  strictKeys(decision, ["reason", "evidenceReference"], "Fachentscheidung");
  const reason = text(decision.reason, 4000, "Begründung", false);
  return { reason, evidenceReference: decision.evidenceReference === undefined ? "" : reference(decision.evidenceReference, "Entscheidungsbeleg") };
}
function recordNotification(record, decision, now) {
  if (record.kind !== "breach") fail("INVALID_ACTION", "Meldebelege gehören ausschließlich zu Datenpannen.");
  strictKeys(decision, ["channel", "sentAt", "evidenceReference", "phase", "details", "lateReason"], "Meldebeleg");
  if (!["authority", "subjects", "controller"].includes(decision.channel) || !["initial", "follow_up", "public_notice"].includes(decision.phase)) fail("INVALID_NOTIFICATION", "Ungültiger Meldekanal oder Meldungsstand.");
  const sentAt = instant(decision.sentAt, "Tatsächlicher Versandzeitpunkt", false);
  if (Date.parse(sentAt) > Date.parse(now)) fail("INVALID_NOTIFICATION", "Versandzeitpunkt liegt in der Zukunft.");
  if (decision.phase === "public_notice" && decision.channel !== "subjects") fail("INVALID_NOTIFICATION", "Öffentliche Information gehört zur Betroffeneninformation.");
  if (decision.phase === "follow_up" && !record.notifications.some((entry) => entry.channel === decision.channel && entry.phase !== "follow_up")) fail("INVALID_NOTIFICATION", "Nachmeldung benötigt einen ersten Versandbeleg.");
  if (decision.phase === "follow_up" && !record.notifications.some((entry) => entry.channel === decision.channel && entry.phase !== "follow_up" && Date.parse(entry.sentAt) <= Date.parse(sentAt))) fail("INVALID_NOTIFICATION", "Nachmeldung kann nicht vor der ersten Meldung versandt worden sein.");
  if (record.payload.roleInIncident === "processor" && decision.channel !== "controller") fail("INVALID_NOTIFICATION", "Auftragsverarbeiter dokumentieren hier ihre Benachrichtigung an den Verantwortlichen.");
  if (record.payload.roleInIncident !== "processor" && decision.channel === "controller") fail("INVALID_NOTIFICATION", "Benachrichtigung an Verantwortliche ist für den Auftragsverarbeiterprozess bestimmt.");
  if (record.payload.breachConfirmed !== "yes") fail("INVALID_NOTIFICATION", "Personenbezogene Datenverletzung zuerst konkret einordnen.");
  const due = breachDeadlines(record, now).authorityDueAt;
  const lateReason = decision.lateReason === undefined ? record.payload.lateReason : text(decision.lateReason, 4000, "Verzögerungsbegründung");
  if (decision.channel === "authority" && decision.phase === "initial" && due && Date.parse(sentAt) > Date.parse(due) && !lateReason) fail("LATE_REASON_REQUIRED", "Verspätete Erstmeldung benötigt eine Verzögerungsbegründung.");
  if (record.notifications.length >= 32) fail("NOTIFICATION_LIMIT", "Meldebeleglimit erreicht.", 409);
  const result = { channel: decision.channel, sentAt, evidenceReference: reference(decision.evidenceReference, "Tatsächlicher Versandbeleg", false), phase: decision.phase,
    details: decision.details === undefined ? "" : text(decision.details, 2000, "Meldezusammenfassung"), lateReason: lateReason || "" };
  if (record.notifications.some((entry) => entry.channel === result.channel && entry.sentAt === result.sentAt && entry.evidenceReference === result.evidenceReference && entry.phase === result.phase)) fail("DUPLICATE_NOTIFICATION", "Dieser Versandbeleg ist bereits erfasst.", 409);
  record.notifications = [...record.notifications, result];
}
function applyPrivacyCommand(ledger, command, context) {
  verifyPrivacyLedger(ledger);
  strictKeys(command, ["action", "kind", "id", "expectedRevision", "payload", "decision"], "Datenschutzaktion");
  if (!ACTIONS.includes(command.action)) fail("INVALID_ACTION", "Nicht unterstützte Datenschutzaktion.");
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== ledger.revision) fail("STALE_REVISION", "Datenschutzregister wurde zwischenzeitlich geändert. Neu laden.", 409);
  const actor = trustedActor(context, command.action); const now = instant(context.now, "Aktionszeit", false);
  if (ledger.events.length >= MAX_EVENTS) fail("EVENT_LIMIT", "Register-Änderungslimit erreicht.", 409);
  const next = clone(ledger); let record;
  if (command.action === "create") {
    const kind = kindDefinition(command.kind).id;
    if (kind === "organization") fail("INVALID_ACTION", "Die Organisation besteht bereits.");
    if (next.records.length >= MAX_RECORDS) fail("RECORD_LIMIT", "Datensatzlimit erreicht.", 409);
    const id = command.id === undefined ? (context.randomUUID || cryptoRandomUUID)() : command.id;
    if (typeof id !== "string" || !ID.test(id) || next.records.some((item) => item.id === id)) fail("INVALID_ID", "Ungültige oder bereits verwendete Datensatz-ID.", 409);
    record = emptyRecord(id, kind, normalizePayload(kind, command.payload === undefined ? {} : command.payload), actor.employeeNumber); next.records.push(record);
  } else {
    if (typeof command.id !== "string" || !ID.test(command.id)) fail("INVALID_ID", "Gültige Datensatz-ID erforderlich.");
    record = next.records.find((item) => item.id === command.id);
    if (!record) fail("NOT_FOUND", "Datenschutz-Datensatz nicht gefunden.", 404);
    if (command.kind !== undefined && command.kind !== record.kind) fail("INVALID_KIND", "Datensatzart stimmt nicht überein.");
    if (record.status === "archived" || (record.status === "closed" && command.action !== "archive")) fail("INVALID_STATE", "Abgeschlossene oder archivierte Fassungen sind unveränderlich.", 409);
    if (command.action === "update") {
      if (!command.payload) fail("INVALID_FIELD", "Prozessdaten fehlen.");
      record.payload = normalizePayload(record.kind, command.payload, record.payload); record.status = "draft"; record.lastAuthor = actor.employeeNumber; record.submittedBy = ""; record.approvedBy = ""; record.approvedAt = null; record.decision = null;
    } else if (command.action === "submit") {
      if (!["draft", "returned"].includes(record.status)) fail("INVALID_STATE", "Nur Entwürfe können eingereicht werden.", 409);
      const readiness = readinessFor(next, record, now);
      if (!readiness.ready) fail("REVIEW_INCOMPLETE", "Fachliche Grundlagen sind noch unvollständig.", 409, readiness.issues);
      record.status = "submitted"; record.submittedBy = actor.employeeNumber; record.decision = null;
    } else if (command.action === "approve") {
      if (record.status !== "submitted") fail("INVALID_STATE", "Nur eingereichte Fassungen können freigegeben werden.", 409);
      if ([record.lastAuthor, record.submittedBy].includes(actor.employeeNumber)) fail("SELF_APPROVAL", "Freigabe muss von einer anderen persönlichen Person erfolgen.", 403);
      const readiness = readinessFor(next, record, now);
      if (!readiness.ready) fail("REVIEW_INCOMPLETE", "Grundlagen wurden geändert oder sind unvollständig.", 409, readiness.issues);
      record.decision = decisionReason(command.decision); record.status = "approved"; record.approvedBy = actor.employeeNumber; record.approvedAt = now;
    } else if (command.action === "return") {
      if (record.status !== "submitted") fail("INVALID_STATE", "Nur eingereichte Fassungen können zurückgegeben werden.", 409);
      record.decision = decisionReason(command.decision); record.status = "returned"; record.approvedBy = ""; record.approvedAt = null;
    } else if (command.action === "record_notification") recordNotification(record, command.decision, now);
    else if (command.action === "close" || command.action === "archive") {
      if (record.kind === "organization") fail("INVALID_ACTION", "Organisationsgrundlage kann nicht geschlossen oder archiviert werden.");
      record.decision = decisionReason(command.decision);
      if (command.action === "close") {
        if (record.status !== "approved" || !readinessFor(next, record, now).ready) fail("CLOSE_INCOMPLETE", "Abschluss benötigt eine aktuelle fachliche Freigabe.", 409);
        if (record.kind === "breach" && record.payload.breachConfirmed === "yes") {
          if (!breachObligationsComplete(record, now)) fail("CLOSE_INCOMPLETE", "Meldeentscheidungen, tatsächliche Versandbelege, Nachverfolgung oder Abhilfe sind noch offen.", 409);
        }
        record.status = "closed";
      } else {
        if (record.kind === "breach" && record.status !== "closed" && record.payload.breachConfirmed !== "no") fail("ARCHIVE_OPEN_INCIDENT", "Bestätigte oder ungeklärte Datenpannen zuerst fachlich abschließen.", 409);
        record.status = "archived";
      }
    }
  }
  if (command.action !== "create" && command.payload !== undefined && command.action !== "update") fail("INVALID_ACTION", "Prozessdaten dürfen nur mit create/update geändert werden.");
  if (!["approve", "return", "close", "archive", "record_notification"].includes(command.action) && command.decision !== undefined) fail("INVALID_ACTION", "Diese Aktion verarbeitet keine Fachentscheidung.");
  record.revision += 1; sealRecord(record, now, actor);
  const event = { revision: next.revision + 1, action: command.action, recordId: record.id, kind: record.kind, recordRevision: record.revision, actor, at: now, previousSha256: next.receiptSha256, snapshotSha256: record.history.at(-1).snapshotSha256 };
  event.sha256 = canonicalSha256(event); next.events.push(event); next.revision += 1; next.receiptSha256 = event.sha256;
  verifyPrivacyLedger(next); return next;
}

module.exports = { PRIVACY_ORGANIZATION_CATALOG, createPrivacyLedger, verifyPrivacyLedger, applyPrivacyCommand, projectPrivacyLedger, PrivacyOrganizationError };
