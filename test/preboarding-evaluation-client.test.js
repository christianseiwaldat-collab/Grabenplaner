"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "public", "candidate-evaluation.js"), "utf8");

function row(id, rating = null, comment = "") {
  const inputs = [1, 2, 3, 4, 5].map((value) => ({ value: String(value), checked: value === rating }));
  const textarea = { value: comment };
  return {
    dataset: { criterionId: id }, inputs, textarea,
    querySelectorAll: () => inputs,
    querySelector: (selector) => selector === "textarea" ? textarea : inputs.find((input) => input.checked),
  };
}

function runtime() {
  const context = {
    state: { active: { id: "own-evaluation", applicationRevision: 2 }, submitting: false },
    rows: [row("one", 4, "Sachliche Beobachtung"), row("two", 3, "Zweiter Hinweis")],
    status: { textContent: "", classList: { add() {}, remove() {} } },
    document: { querySelectorAll: () => context.rows },
    api: async () => { throw Object.assign(new Error("Concurrent update"), { status: 409 }); },
    loadEvaluations: async () => {
      context.state.active = { id: "own-evaluation", applicationRevision: 3 };
      context.rows = [row("two"), row("one")];
    },
    setTimeout() {},
  };
  const submittedRows = context.rows;
  const button = { isConnected: true, disabled: false, textContent: "" };
  const event = { preventDefault() {}, currentTarget: {
    reportValidity: () => true,
    querySelectorAll: () => submittedRows,
    querySelector: () => button,
  } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("function restoreEvaluationDraft("), source.indexOf("async function initialize(")), context);
  return { context, event, button };
}

test("Ein Versionskonflikt erhält die eigenen Sterne und Kommentare nach Kriteriums-ID", async () => {
  const { context, event } = runtime();
  let submissions = 0;
  context.api = async () => { submissions += 1; throw Object.assign(new Error("Concurrent update"), { status: 409 }); };
  await context.submitEvaluation(event);
  assert.equal(submissions, 1, "Kein automatisches erneutes Absenden");
  assert.equal(context.state.active.applicationRevision, 3);
  assert.equal(context.rows.find((entry) => entry.dataset.criterionId === "one").inputs.find((input) => input.checked).value, "4");
  assert.equal(context.rows.find((entry) => entry.dataset.criterionId === "one").textarea.value, "Sachliche Beobachtung");
  assert.equal(context.rows.find((entry) => entry.dataset.criterionId === "two").textarea.value, "Zweiter Hinweis");
  assert.match(context.status.textContent, /erhalten geblieben.*erneut absenden/);
  assert.equal(context.state.submitting, false);
});

test("Ein Entwurf wird nie in eine andere anschließend geladene Bewertung übernommen", async () => {
  const { context, event } = runtime();
  context.loadEvaluations = async () => {
    context.state.active = { id: "another-evaluation" };
    context.rows = [row("one"), row("two")];
  };
  await context.submitEvaluation(event);
  assert.ok(context.rows.every((entry) => !entry.inputs.some((input) => input.checked)));
  assert.ok(context.rows.every((entry) => entry.textarea.value === ""));
});

test("Ein Fehler beim Konflikt-Neuladen wird angezeigt und lässt die aktuelle Eingabe bedienbar", async () => {
  const { context, event, button } = runtime();
  context.loadEvaluations = async () => { throw Object.assign(new Error("Kurzzeitig nicht erreichbar"), { status: 503 }); };
  await context.submitEvaluation(event);
  assert.equal(context.status.textContent, "Kurzzeitig nicht erreichbar");
  assert.equal(context.rows[0].textarea.value, "Sachliche Beobachtung");
  assert.equal(button.disabled, false);
  assert.equal(context.state.submitting, false);
});

test("Nur eine tatsächlich erfolgreiche Abgabe darf die Übermittlungsbestätigung auslösen", async () => {
  const { context, event } = runtime();
  context.api = async () => ({ evaluation: { submittedAt: "2026-09-08T12:00:00Z" } });
  let options;
  context.loadEvaluations = async (value) => { options = value; };
  await context.submitEvaluation(event);
  assert.equal(options.submitted, true);

  context.content = { innerHTML: "" };
  vm.runInContext(source.slice(source.indexOf("function renderComplete("), source.indexOf("function renderEvaluation(")), context);
  context.renderComplete();
  assert.match(context.status.textContent, /keine offene Bewerbungsbewertung/);
  assert.doesNotMatch(context.status.textContent, /übermittelt/);
  context.renderComplete(true);
  assert.match(context.status.textContent, /vollständig.*übermittelt/);
});
