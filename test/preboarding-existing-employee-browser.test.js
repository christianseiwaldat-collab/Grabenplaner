"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, ".."), enabled = process.env.GP_WINDOW_BROWSER_TEST === "1";
const source = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const functions = source.slice(source.indexOf("function renderPersonnelCandidateExistingEmployeeForm("), source.indexOf("function renderPersonnelCandidateApplication("));
let browser;
test.before(async () => {
  if (!enabled) return;
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) });
});
test.after(async () => { await browser?.close(); });

async function fixture() {
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="de"><meta charset="utf-8"><main><h1>Preboarding · ausschließlich Beispieldaten</h1><div id="panel"></div><div id="result"></div></main></html>' }));
  await page.goto("https://synthetic.invalid/");
  await page.addStyleTag({ path: path.join(root, "public/styles.css") });
  await page.evaluate(() => {
    window.state = { personnelCandidateCapabilities: { canConvert: true }, selectedPersonnelCandidateId: "candidate-example",
      selectedPersonnelCandidate: { id: "candidate-example", state: "active", revision: 3, applications: [{ id: "application-example", revision: 4, status: "talent_pool" }] }, personnelCandidateMutationPending: "" };
    window.personnelCandidateApplications = candidate => candidate?.applications || [];
    window.escapeHtml = window.escapeHtmlAttribute = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    window.captureGpContext = (canUse, source) => ({ canUse, source, captured: source() });
    window.gpContextCurrent = ticket => ticket.canUse() && ticket.source() === ticket.captured;
    window.csrfHeader = () => ({ "X-CSRF-Token": "synthetic-csrf" });
    window.calls = []; window.loadPersonnelCandidates = window.loadPersonnelCandidateDetail = async () => {};
    window.showToast = text => { document.getElementById("result").textContent = text; };
    window.clearPersonnelLifecycleCandidateState = () => { state.personnelCandidateMutationPending = ""; document.getElementById("panel").textContent = "Zugriff beendet"; };
    window.api = async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === "POST") return { replayed: false };
      return { employee: { personnelNumber: "EX-434", fullName: "Alex Beispiel <Test>", snapshotSha256: "a".repeat(64) } };
    };
  });
  await page.addScriptTag({ content: functions });
  await page.evaluate(() => {
    document.getElementById("panel").innerHTML = renderPersonnelCandidateExistingEmployeeForm("candidate-example", state.selectedPersonnelCandidate.applications[0]);
    document.getElementById("panel").addEventListener("submit", event => {
      event.preventDefault(); savePersonnelCandidateExistingEmployee(event.target, event.submitter?.value || "lookup");
    });
  });
  await page.getByText("Bereits eingestellt", { exact: true }).click();
  return { page, errors };
}

test("Vorhandener Mitarbeiter: Zielperson wird geprüft, bestätigt und mit derselben Identität gespeichert", { skip: !enabled }, async () => {
  const { page, errors } = await fixture();
  try {
    await page.getByLabel("Vorhandene Personalnummer").fill("EX-434");
    await page.getByRole("button", { name: "Mitarbeiter prüfen" }).click();
    await page.getByText("Alex Beispiel <Test> · MA EX-434", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Als eingestellt vermerken" }).click();
    assert.equal(await page.evaluate(() => calls.filter(call => call.options.method === "POST").length), 0);
    await page.getByRole("checkbox").check();
    await page.getByRole("heading").click();
    if (process.env.GP_PREBOARDING_SCREENSHOT) await page.screenshot({ path: process.env.GP_PREBOARDING_SCREENSHOT, fullPage: true });
    await page.getByRole("button", { name: "Als eingestellt vermerken" }).click();
    await page.getByText("Die Einstellung wurde mit dem vorhandenen Mitarbeiter verknüpft.", { exact: true }).waitFor();
    const calls = await page.evaluate(() => window.calls);
    assert.equal(calls.length, 2);
    const input = JSON.parse(calls[1].options.body);
    assert.equal(input.employeeNumber, "EX-434"); assert.equal(input.employeeSnapshotSha256, "a".repeat(64));
    assert.equal(input.candidateRevision, 3); assert.equal(input.applicationRevision, 4); assert.equal(input.confirmed, true);
    assert.match(input.operationId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("Vorhandener Mitarbeiter: andere Nummer braucht neue Vorschau, ein erneuter Prüfklick bleibt ohne Bestätigung möglich", { skip: !enabled }, async () => {
  const { page, errors } = await fixture();
  try {
    await page.getByLabel("Vorhandene Personalnummer").fill("EX-434");
    await page.getByRole("button", { name: "Mitarbeiter prüfen" }).click();
    await page.getByRole("checkbox").check();
    await page.getByLabel("Vorhandene Personalnummer").fill("EX-435");
    await page.getByRole("button", { name: "Als eingestellt vermerken" }).click();
    await page.getByText("Bitte den Mitarbeiter zuerst erneut prüfen und bestätigen.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => calls.filter(call => call.options.method === "POST").length), 0);
    await page.getByRole("checkbox").uncheck();
    await page.getByLabel("Vorhandene Personalnummer").fill("EX-434");
    await page.getByRole("button", { name: "Mitarbeiter prüfen" }).click();
    await page.getByText("Bitte die Zuordnung bestätigen.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("checkbox").isChecked(), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("Vorhandener Mitarbeiter: fehlendes Recht und abgeschlossene Kandidaten bekommen kein Zuordnungsformular", { skip: !enabled }, async () => {
  const { page } = await fixture();
  try {
    assert.equal(await page.evaluate(() => { state.personnelCandidateCapabilities.canConvert = false; return renderPersonnelCandidateExistingEmployeeForm("candidate-example", state.selectedPersonnelCandidate.applications[0]); }), "");
    assert.equal(await page.evaluate(() => { state.personnelCandidateCapabilities.canConvert = true; state.selectedPersonnelCandidate.state = "archived"; return renderPersonnelCandidateExistingEmployeeForm("candidate-example", state.selectedPersonnelCandidate.applications[0]); }), "");
  } finally { await page.close(); }
});
