"use strict";

const PHASES = Object.freeze({
  "oauth-policy": "Google-OAuth-Richtlinie", backup: "Sicherung und Upload",
  "repository-check": "Repository-Prüfung", "restore-test": "Isolierter Daten-Restore",
  "application-smoke": "Isolierter App-Start",
});
const STATUS = Object.freeze({ passed: "Bestätigt", failed: "Fehlgeschlagen", pending: "Nicht ausgeführt", not_run: "Nicht ausgeführt", running: "Läuft" });
const ERRORS = Object.freeze({
  PREPARE_FAILED: "Die lokale Vorbereitung der Sicherung ist fehlgeschlagen. Der Upload und die nachfolgenden Prüfungen wurden nicht erreicht. Der Fehlercode allein belegt keinen Uploadfehler und kein Zeitlimit.",
  UPLOAD_FAILED: "Die Übertragung der vorbereiteten Sicherung ist fehlgeschlagen.",
  FULL_CHECK_FAILED: "Die vollständige Repository-Prüfung ist fehlgeschlagen.",
  RESTORE_TEST_FAILED: "Der isolierte Wiederherstellungstest ist fehlgeschlagen.",
  APPLICATION_SMOKE_FAILED: "Der isolierte Anwendungsstart nach der Wiederherstellung ist fehlgeschlagen.",
  MONITOR_CHECK_FAILED: "Die abschließende Serverprüfung ist fehlgeschlagen.",
});
function phaseLabel(id) { return PHASES[String(id).replace(/-(passed|failed|not-run)$/, "")] || "Prüfschritt"; }
function reportLines(run, checkedAt) {
  return [
    ["title", "Recovery-Assurance-Prüfbericht"],
    ["text", `Lauf: ${run.runIdPrefix || "Unbekannt"}`],
    ["text", `Ergebnis: ${STATUS[run.status] || "Unbekannt"}`],
    ["text", `Auslöser: ${run.trigger}`],
    ["text", `Beginn (UTC): ${run.startedAt}`],
    ["text", `Ende (UTC): ${run.completedAt || "Noch offen"}`],
    ["text", `Dauer: ${run.durationSeconds === null ? "Noch offen" : `${Math.floor(run.durationSeconds / 60)} Min. ${run.durationSeconds % 60} Sek.`}`],
    ["heading", "Prüfschritte"],
    ...(run.phases || []).map(p => ["text", `${phaseLabel(p.id)}: ${STATUS[p.status] || "Unbekannt"}${p.occurredAt ? ` · ${p.occurredAt}` : ""}`]),
    ...(run.errorCode ? [["heading", `Fehler: ${run.errorCode}`], ["text", ERRORS[run.errorCode] || "Die technische Prüfung ist fehlgeschlagen."]] : []),
    ["heading", "Nachweis"],
    ["text", `Signaturkette vollständig geprüft am ${checkedAt} (UTC).`],
    ["text", `App-Version: ${run.appVersion || "Nicht hinterlegt"}`],
    ["text", `Snapshot-Präfix: ${run.snapshotIdPrefix || "Nicht erreicht"}`],
    ["text", `Restore-Quittung (SHA-256-Präfix): ${run.receiptSha256Prefix || "Nicht erreicht"}`],
    ["text", "Dieser Bericht ist eine lesbare Ableitung der geprüften signierten Ereignisse. Er verändert den ursprünglichen Lauf nicht. Nicht ausgeführte Schritte sind keine bestandenen Prüfungen. Aus dem Fehlercode allein lässt sich die genaue technische Ursache nicht ableiten; dafür sind die Serverprotokolle zum angegebenen Zeitraum erforderlich."],
  ];
}
function markdownReport(run, checkedAt) {
  return reportLines(run, checkedAt).map(([type, text]) => `${type === "title" ? "# " : type === "heading" ? "## " : ""}${text}`).join("\n\n") + "\n";
}
function pdfReport(run, checkedAt, output) {
  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: "Recovery-Assurance-Prüfbericht", Author: "Grabenplaner" } });
  doc.pipe(output);
  for (const [type, text] of reportLines(run, checkedAt)) {
    if (type === "heading" && doc.y > 690) doc.addPage();
    doc.font(type === "text" ? "Helvetica" : "Helvetica-Bold")
      .fontSize(type === "title" ? 20 : type === "heading" ? 12 : 10)
      .fillColor(type === "text" ? "#253D39" : "#165D4C").text(text, { lineGap: 3 });
    doc.moveDown(type === "title" ? 0.9 : 0.55);
  }
  doc.end();
  return doc;
}
module.exports = { markdownReport, pdfReport, phaseLabel };
