"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "public", "portal.js"), "utf8");
const functions = source.slice(source.indexOf("function clearCandidateEvaluationState("), source.indexOf("async function initialize("));

function runtime(user = { employeeNumber: "TEST-MA", isEmployee: true }) {
  const redirects = [];
  const requests = [];
  const notice = { hidden: true, classList: { toggle(_name, hidden) { notice.hidden = hidden; } } };
  const link = { removeAttribute(name) { delete this[name]; } };
  const context = {
    portalState: { session: { user }, candidateEvaluations: [], candidateEvaluationsLoadPromise: null, candidateEvaluationsRequestGeneration: 0 },
    el: { pendingCandidateEvaluationNotice: notice, pendingCandidateEvaluationSummary: { textContent: "" }, pendingCandidateEvaluationLink: link },
    portalUser: () => context.portalState.session?.user || null,
    isOrganizationAccount: (entry) => entry?.isEmployee === false || ["branch", "terminal"].includes(entry?.accountType),
    api: async (url) => { requests.push(url); return { evaluations: [] }; },
    window: { location: { replace: (url) => redirects.push(url) } },
  };
  vm.createContext(context);
  vm.runInContext(functions, context);
  return { context, notice, link, redirects, requests };
}

test("Später zugewiesene Bewertungen werden ohne Seitenwechsel sichtbar und nach Erledigung entfernt", async () => {
  const { context, notice, link, redirects } = runtime();
  await context.loadPendingCandidateEvaluations();
  assert.equal(notice.hidden, true);
  context.api = async () => ({ evaluations: [{ id: "own/evaluation", candidateName: "Nur auf der Bewertungsseite" }, { id: "second" }] });
  await context.loadPendingCandidateEvaluations();
  assert.equal(notice.hidden, false);
  assert.match(context.el.pendingCandidateEvaluationSummary.textContent, /^2 offene/);
  assert.equal(link.href, "/candidate-evaluation.html?id=own%2Fevaluation");
  assert.doesNotMatch(JSON.stringify(context.portalState.candidateEvaluations), /candidateName|Nur auf/);
  assert.deepEqual(redirects, []);
  context.api = async () => ({ evaluations: [] });
  await context.loadPendingCandidateEvaluations();
  assert.equal(notice.hidden, true);
  assert.equal(link.href, undefined);
});

test("Beim persönlichen Einstieg öffnet sich weiterhin direkt die eigene Bewertung", async () => {
  const { context, redirects } = runtime();
  context.api = async () => ({ evaluations: [{ id: "personal" }] });
  assert.equal(await context.redirectToPendingCandidateEvaluation(), true);
  assert.deepEqual(redirects, ["/candidate-evaluation.html?id=personal"]);
});

test("Filialkonten, Terminals und noch nicht geänderte Startpasswörter laden keine Bewertungen", async () => {
  for (const user of [null, { isEmployee: false }, { accountType: "branch" }, { accountType: "terminal" }, { isEmployee: true, mustChangePassword: true }]) {
    const { context, notice, requests, redirects } = runtime(user);
    await context.loadPendingCandidateEvaluations();
    assert.equal(await context.redirectToPendingCandidateEvaluation(), false);
    assert.equal(notice.hidden, true);
    assert.deepEqual(requests, []);
    assert.deepEqual(redirects, []);
  }
});

test("Sichtbarwerden und periodischer Abruf teilen einen laufenden Request", async () => {
  const { context, notice } = runtime();
  let resolve, calls = 0;
  context.api = () => { calls += 1; return new Promise((done) => { resolve = done; }); };
  const first = context.loadPendingCandidateEvaluations();
  const second = context.loadPendingCandidateEvaluations();
  assert.equal(calls, 1);
  resolve({ evaluations: [{ id: "once" }] });
  await Promise.all([first, second]);
  assert.equal(notice.hidden, false);
  assert.equal(context.portalState.candidateEvaluationsLoadPromise, null);
});

test("Verspätete Antworten dürfen nach Konto- oder Sitzungswechsel weder erscheinen noch umleiten", async () => {
  for (const nextNumber of ["TEST-MA", "ANOTHER-MA"]) {
    const { context, notice, redirects } = runtime();
    let resolve;
    context.api = () => new Promise((done) => { resolve = done; });
    const first = context.redirectToPendingCandidateEvaluation();
    context.portalState.session = { user: { employeeNumber: nextNumber, isEmployee: true } };
    context.clearCandidateEvaluationState();
    context.api = async () => ({ evaluations: [{ id: "new-session" }] });
    await context.loadPendingCandidateEvaluations();
    resolve({ evaluations: [{ id: "old-session" }] });
    assert.equal(await first, false);
    assert.equal(notice.hidden, false);
    assert.equal(context.el.pendingCandidateEvaluationLink.href, "/candidate-evaluation.html?id=new-session");
    assert.deepEqual(redirects, []);
  }
});

test("Ein Entzug oder Passwortwechselbedarf entfernt einen bereits angezeigten Bewertungszugang", async () => {
  for (const status of [401, 403, 404, 428]) {
    const { context, notice, link } = runtime();
    context.api = async () => ({ evaluations: [{ id: "previous" }] });
    await context.loadPendingCandidateEvaluations();
    context.api = async () => { throw Object.assign(new Error("Unavailable"), { status }); };
    await assert.rejects(context.loadPendingCandidateEvaluations(), { status });
    assert.equal(notice.hidden, true);
    assert.equal(link.href, undefined);
  }
});

test("Ein vorübergehender Verbindungsfehler verliert keinen bereits bekannten offenen Zugang", async () => {
  const { context, notice } = runtime();
  context.api = async () => ({ evaluations: [{ id: "pending" }] });
  await context.loadPendingCandidateEvaluations();
  context.api = async () => { throw Object.assign(new Error("Temporary"), { status: 503 }); };
  await assert.rejects(context.loadPendingCandidateEvaluations(), { status: 503 });
  assert.equal(notice.hidden, false);
  assert.equal(context.portalState.candidateEvaluationsLoadPromise, null);
});

test("Der Aktualisierungsweg bleibt an Sichtbarkeit und den bestehenden 45-Sekunden-Takt gekoppelt", () => {
  const listeners = source.slice(source.indexOf('document.addEventListener("visibilitychange"'));
  assert.match(listeners, /!document\.hidden && portalState\.session/);
  assert.equal((listeners.match(/loadPendingCandidateEvaluations\(\)/g) || []).length, 2);
  assert.match(listeners, /loadPendingCandidateEvaluations\(\)[\s\S]*?45000/);
});
