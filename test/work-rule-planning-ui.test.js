"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

test("Dienstplan-Skript bleibt nach Einbau der Regelprüfung syntaktisch ausführbar", () => {
  assert.doesNotThrow(() => new vm.Script(script, { filename: "public/app.js" }));
});

function functionSource(name, nextName) {
  const start = script.indexOf(`function ${name}`);
  const end = script.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0, `${name} fehlt`);
  assert.ok(end > start, `${nextName} fehlt nach ${name}`);
  return script.slice(start, end);
}

test("Arbeitszeit-Regelprüfung liegt kompakt zwischen Wochenübersicht und Kalender", () => {
  const summary = html.indexOf('class="summary-grid"');
  const assessment = html.indexOf('id="workRuleAssessmentPanel"');
  const schedule = html.indexOf('class="schedule-panel"');
  assert.ok(summary >= 0 && assessment > summary && schedule > assessment);
  assert.match(html, /<details class="work-rule-assessment" id="workRuleAssessmentPanel">/);
  assert.match(html, /Monitorbetrieb – Planprüfung, keine Rechtsfreigabe/);
  assert.match(html, /id="workRuleAssessmentBody" aria-live="polite"/);
});

test("Wochenprüfung gruppiert Findings und verlinkt ausschließlich sichere Webquellen", () => {
  const sourceLinks = functionSource("safeWorkRuleSourceUrl", "workRuleSourceLinks");
  const renderer = functionSource("renderWorkRuleAssessment", "renderTimeline");
  assert.match(sourceLinks, /\["http:", "https:"\]\.includes\(url\.protocol\)/);
  assert.match(script, /rel="noreferrer noopener"/);
  assert.match(renderer, /employeeName \|\| "Teammitglied"/);
  assert.match(renderer, /work-rule-finding-group/);
  assert.match(renderer, /assessment\.profiles/);
  assert.match(renderer, /ersetzt keine rechtliche oder kollektivvertragliche Einzelfallprüfung/);
  assert.doesNotMatch(renderer, /rechtskonform/i);
});

test("Schichtdialog zeigt vorhandene MA-Hinweise und aktualisiert die Vorschau entprellt", () => {
  assert.match(html, /id="shiftRulePreview" aria-live="polite"/);
  const matcher = functionSource("shiftRuleFindingsForCandidate", "renderShiftRulePreview");
  const scheduler = functionSource("scheduleShiftRulePreview", "calculateShiftPreview");
  assert.match(matcher, /employeeNumber/);
  assert.match(matcher, /periodFrom/);
  assert.match(matcher, /periodTo/);
  assert.match(scheduler, /setTimeout\(async \(\) =>/);
  assert.match(scheduler, /"\/api\/work-rules\/evaluate"/);
  assert.match(scheduler, /candidateShift/);
  assert.match(scheduler, /preview: true/);
  assert.match(scheduler, /catch \{/);
  assert.match(scheduler, /state\.data\?\.workRuleAssessment/);
});

test("Regelprüfung bleibt in Hell, Dunkel und auf kleinen Bildschirmen lesbar", () => {
  assert.match(styles, /\.work-rule-assessment\s*\{/);
  assert.match(styles, /\.work-rule-finding-group > div\s*\{[^}]*grid-template-columns:repeat\(auto-fit,minmax\(270px,1fr\)\)/);
  assert.match(styles, /data-active-page-theme="dark"\] #planningView \.work-rule-assessment/);
  assert.match(styles, /data-active-page-theme="dark"\] \.modal \.shift-rule-preview/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*\.work-rule-finding-group > div/);
});
