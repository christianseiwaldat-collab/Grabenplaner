"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, ".."), enabled = process.env.GP_WINDOW_BROWSER_TEST === "1";
let browser;
test.before(async () => { if (!enabled) return; const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright"); browser = await chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) }); });
test.after(async () => { await browser?.close(); });
async function setup(viewport = { width: 1366, height: 900 }, dark = false) {
  const page = await browser.newPage({ viewport, colorScheme: dark ? "dark" : "light" }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body data-active-page-theme="${dark ? "dark" : "light"}"><main style="padding:16px;max-width:1200px;margin:auto"><h1>Planungsassistent</h1><section id="optimizer" class="planning-assistant"></section></main></body></html>` }));
  await page.goto("http://127.0.0.1/planning-optimizer-fixture");
  for (const file of ["styles.css", "assistant-management.css"]) await page.addStyleTag({ path: path.join(root, "public", file) });
  await page.addScriptTag({ path: path.join(root, "public/planning-optimizer.js") });
  await page.evaluate(() => {
    window.calls = []; window.applied = 0; window.waits = [];
    window.report = { canOptimize: true, optimizer: { available: true }, choices: { employees: [{ id: "A", label: "Alexandra Beispiel" }, { id: "B", label: "Max Beispiel" }] } };
    window.data = { weekStart: "2031-04-07", context: { locationId: "97", departmentId: null } };
    const a = { employeeId: "A", employeeName: "Alexandra Beispiel", date: "2031-04-07", startTime: "09:00", endTime: "17:00" }, b = { ...a, employeeId: "B", employeeName: "Max Beispiel", startTime: "10:00", endTime: "18:00" };
    window.proposal = { id: "proposal", confirmationToken: "capability", scenarios: ["stable", "balanced", "wishes"].map((profile, i) => ({ id: "scenario-" + i, profile, status: i ? "FEASIBLE" : "OPTIMAL",
      metrics: { targetDeviationMinutes: 30, preferencePenalty: i, saturdaySpread: 1 }, shifts: [a, b], changes: [{ ...a, kind: "remove" }, { ...b, kind: "add" }],
      review: { findings: [{ title: "GP-Prüfung", message: "Die bestehende Einstellung erfordert eine fachliche Prüfung.", severity: "unknown" }] } })), discarded: [] };
    window.api = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (window.hold) await new Promise(resolve => waits.push(resolve));
      if (window.failure) throw Object.assign(new Error("Die Planungsgrundlage wurde geändert. Bitte neue Vorschläge berechnen."), { code: window.failure });
      return url.endsWith("/apply") ? { applied: true, changedShifts: 2 } : structuredClone(proposal);
    };
    window.optimizer = GpPlanningOptimizer.mount(document.getElementById("optimizer"), { api, onApplied: async () => { applied++; } });
    optimizer.synchronize(report, data);
  });
  await page.locator("#optimizer>details>summary").click();
  return { page, errors, async close() { await page.evaluate(() => optimizer.reset()); await page.close(); } };
}
async function calculate(page) { await page.getByRole("button", { name: "Vorschläge berechnen", exact: true }).click(); await page.locator(".planning-optimizer-scenario").first().waitFor(); }
for (const [name, viewport, dark] of [["desktop", { width: 1366, height: 900 }, false], ["phone", { width: 390, height: 844 }, false], ["phone-dark", { width: 390, height: 844 }, true]]) {
  test(`comparison and explicit confirmation on ${name}`, { skip: !enabled }, async () => {
    const f = await setup(viewport, dark); try {
      const { page } = f; await calculate(page);
      assert.equal(await page.locator(".planning-optimizer-scenario").count(), 3);
      assert.equal(await page.evaluate(() => calls.some(c => c.url.endsWith("/apply"))), false);
      const card = page.locator(".planning-optimizer-scenario").nth(1), apply = card.getByRole("button");
      assert.equal(await apply.isDisabled(), true); await card.getByRole("checkbox").check(); assert.equal(await apply.isDisabled(), false);
      if (process.env.GP_ASSISTANT_SCREENSHOT_DIR) { fs.mkdirSync(process.env.GP_ASSISTANT_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ fullPage: true, path: path.join(process.env.GP_ASSISTANT_SCREENSHOT_DIR, `optimizer-${name}.png`) }); }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert((await apply.boundingBox()).height >= 44);
      await apply.click(); await page.waitForFunction(() => applied === 1);
      const calls = await page.evaluate(() => window.calls); assert.equal(calls.filter(c => c.url.endsWith("/apply")).length, 1);
      assert.deepEqual(calls.at(-1).body, { proposalId: "proposal", scenarioId: "scenario-1", confirmationToken: "capability", confirmed: true });
      assert.equal(await page.locator(".planning-optimizer-scenario").count(), 0); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
test("replacement uses only the selected in-scope employee and discard never sends a write", { skip: !enabled }, async () => {
  const f = await setup(); try {
    await f.page.getByLabel("Art des Planvorschlags").selectOption("replacement"); await f.page.getByLabel("Ausfallende Person").selectOption("B");
    await calculate(f.page); assert.equal(await f.page.evaluate(() => calls[0].body.absentEmployeeNumber), "B");
    await f.page.getByRole("button", { name: "Vorschläge verwerfen" }).click(); assert.equal(await f.page.locator(".planning-optimizer-scenario").count(), 0);
    assert.equal(await f.page.evaluate(() => calls.length), 1);
  } finally { await f.close(); }
});
test("scope and rights changes discard late calculations and old confirmation controls", { skip: !enabled }, async () => {
  const f = await setup(); try {
    await f.page.evaluate(() => { hold = true; }); await f.page.getByRole("button", { name: "Vorschläge berechnen" }).click();
    await f.page.waitForFunction(() => waits.length === 1);
    await f.page.evaluate(() => { optimizer.synchronize({ ...report, canOptimize: false }, data); hold = false; waits.shift()(); });
    await f.page.waitForFunction(() => document.querySelector("#optimizer form").hidden);
    assert.equal(await f.page.locator(".planning-optimizer-scenario").count(), 0);
  } finally { await f.close(); }
});
test("changed sources block stale confirmation and a failed apply never retries automatically", { skip: !enabled }, async () => {
  const f = await setup(); try {
    await calculate(f.page); await f.page.locator(".planning-optimizer-scenario").first().getByRole("checkbox").check();
    await f.page.evaluate(() => { failure = "OPTIMIZER_PLAN_CHANGED"; }); await f.page.locator(".planning-optimizer-scenario").first().getByRole("button").click();
    await f.page.waitForFunction(() => document.querySelectorAll(".planning-optimizer-scenario").length === 0);
    assert.match(await f.page.getByRole("status").textContent(), /geändert/);
    assert.equal(await f.page.evaluate(() => calls.filter(c => c.url.endsWith("/apply")).length), 1);
  } finally { await f.close(); }
});
test("infeasible scenarios show their explanation and never expose an apply button", { skip: !enabled }, async () => {
  const f = await setup(); try {
    await f.page.evaluate(() => { proposal.scenarios = []; proposal.discarded = [{ reasons: ["Mindestbesetzung · Montag 09:00–10:00"] }]; });
    await f.page.getByRole("button", { name: "Vorschläge berechnen" }).click();
    await f.page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("Kein durch den GP"));
    assert.match(await f.page.locator("#optimizer").textContent(), /Mindestbesetzung/); assert.equal(await f.page.getByRole("checkbox").count(), 0);
  } finally { await f.close(); }
});
