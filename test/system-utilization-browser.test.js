"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, ".."), enabled = process.env.GP_WINDOW_BROWSER_TEST === "1";
const screenshotDirectory = process.env.GP_UTILIZATION_SCREENSHOT_DIR && path.resolve(process.env.GP_UTILIZATION_SCREENSHOT_DIR);
const evidenceSlug = process.env.GP_UTILIZATION_EVIDENCE_SLUG || "local";
const now = Date.parse("2031-04-07T12:00:00.000Z");
const appSource = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
let browser;

function appFunction(name) {
  const start = appSource.search(new RegExp("^function " + name + "\\(", "m")), end = appSource.indexOf("\n}", start);
  assert(start >= 0 && end > start, name); return appSource.slice(start, end + 2);
}

function history(hours = 24) {
  const step = hours * 3600000 / 40, from = now - hours * 3600000;
  const points = Array.from({ length: 40 }, (_, index) => {
    const cpu = index === 3 ? 0 : 16 + index % 7 * 6, memory = 39 + index % 5;
    const empty = index === 16, cpuMissing = index === 19;
    return { at: new Date(from + index * step).toISOString(), until: new Date(from + (index + 1) * step).toISOString(),
      sampleCount: empty ? 0 : 1, hasGap: empty || cpuMissing,
      cpu: empty || cpuMissing ? { avg: null, min: null, max: null, count: 0 } : { avg: cpu, min: Math.max(0, cpu - 7), max: Math.min(100, cpu + 13), count: 1 },
      memory: empty ? { avg: null, min: null, max: null, count: 0 } : { avg: memory, min: memory - 2, max: memory + 4, count: 1 } };
  });
  return { schemaVersion: 1, generatedAt: new Date(now).toISOString(), from: new Date(from).toISOString(), to: new Date(now).toISOString(), hours,
    intervalSeconds: 10, resolutionSeconds: step / 1000, retentionDays: 180, scope: "host", status: "ready", integrityVerified: true,
    persistence: { available: true, writeFailed: false }, points,
    current: { measuredAt: new Date(now).toISOString(), cpu: { usedPercent: 24.7, logicalProcessors: 6, measuredAt: new Date(now).toISOString(), sampleDurationMs: 10000, status: "ready", measurement: "host_cpu_times" },
      memory: { usedPercent: 46, totalBytes: 24 * 1024 ** 3, availableBytes: 12.96 * 1024 ** 3, measuredAt: new Date(now).toISOString(), status: "ready" } } };
}

test.before(async () => {
  if (!enabled) return;
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) });
});
test.after(async () => { if (browser) await browser.close(); });

async function capture(page, name) {
  if (!screenshotDirectory) return;
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  const target = path.join(screenshotDirectory, `system-utilization-${name}-${evidenceSlug}.png`);
  assert.equal(fs.existsSync(target), false, "An existing visual receipt must not be overwritten");
  await page.screenshot({ path: target, fullPage: true });
}

async function setup({ viewport = { width: 1440, height: 1000 }, dark = false, response = history(), start = true } = {}) {
  const page = await browser.newPage({ viewport, colorScheme: dark ? "dark" : "light" }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: new Date(now) });
  await page.route("**/*", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body:
    `<!doctype html><html lang="de" data-active-page-theme="${dark ? "dark" : "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="settingsView" class="view active" data-page-theme="${dark ? "dark" : "light"}" style="max-width:1440px;margin:0 auto;padding:18px"><div class="settings-system-center"><div id="resource-cards"></div><div id="instrument" hidden></div></div></main></body></html>` }));
  await page.goto("http://127.0.0.1/system-utilization-fixture");
  for (const file of ["styles.css", "system-utilization.css"]) await page.addStyleTag({ path: path.join(root, "public", file) });
  await page.addScriptTag({ path: path.join(root, "public/system-utilization.js") });
  await page.addScriptTag({ content: ["systemCenterByteLabel", "systemCenterUptimeLabel", "systemCenterResourceCards", "systemUtilizationAllowed", "systemUtilizationActive", "updateSystemUtilizationSnapshot"].map(appFunction).join("\n") });
  await page.evaluate(({ response, start }) => {
    window.fixtureResponse = response; window.fixtureActive = true; window.fixtureActor = "BEISPIEL-admin";
    window.fixtureHidden = false; window.calls = []; window.waits = []; window.snapshots = []; window.fail = false; window.hold = false;
    window.escapeHtml = value => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    window.elements = { systemCenterContent: document.getElementById("resource-cards"), systemCenterPanel: { classList: { contains: () => true } } };
    window.state = { currentView: "settings", portalStatus: { portalEnabled: true }, portalSession: { authenticated: true, user: { permissions: ["system:diagnostics:technical"] } },
      systemCenter: { resources: { uptimeSeconds: 16740, cpu: { usedPercent: null, status: "warming-up", loadAverageOneMinute: .9 }, memory: { usedPercent: 0, availableBytes: 13 * 1024 ** 3 }, storage: { freeBytes: 200 * 1024 ** 3, databaseBytes: 20 * 1024 ** 3 } } } };
    elements.systemCenterContent.innerHTML = systemCenterResourceCards(state.systemCenter.resources);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => fixtureHidden ? "hidden" : "visible" });
    window.instrument = GpSystemUtilization.mount(document.getElementById("instrument"), {
      isActive: () => fixtureActive,
      onSnapshot: value => { snapshots.push(structuredClone(value)); updateSystemUtilizationSnapshot(value); },
      api: async (url, options = {}) => {
        calls.push({ url, method: options.method || "GET", signal: options.signal });
        if (hold) await new Promise(resolve => waits.push(resolve));
        if (fail) throw Object.assign(new Error("BEISPIEL Messdienst nicht erreichbar"), { status: window.failStatus || 503 });
        const value = structuredClone(fixtureResponse), hours = Number(new URL(url, location.origin).searchParams.get("hours"));
        const previousFrom = Date.parse(value.from), until = Date.parse(value.to), ratio = hours / value.hours, from = until - hours * 3600000;
        value.points = value.points.map(point => ({ ...point, at: new Date(from + (Date.parse(point.at) - previousFrom) * ratio).toISOString(), until: new Date(from + (Date.parse(point.until) - previousFrom) * ratio).toISOString() }));
        value.from = new Date(from).toISOString(); value.hours = hours; value.resolutionSeconds *= ratio; return value;
      },
    });
    window.synchronize = (active = fixtureActive, actorKey = fixtureActor) => instrument.synchronize({ active, actorKey });
    if (start) synchronize();
  }, { response, start });
  if (start) await page.waitForFunction(() => snapshots.length === 1);
  return { page, errors, async close() { await page.evaluate(() => instrument.destroy()); await page.close(); } };
}

for (const [name, viewport, dark] of [["desktop", { width: 1440, height: 1000 }, false], ["mobile", { width: 390, height: 844 }, false], ["dark-desktop", { width: 1440, height: 1000 }, true], ["dark-mobile", { width: 390, height: 844 }, true]]) {
  test(`actual instrument has a responsive paper chart, distinct legend and working controls on ${name}`, { skip: !enabled }, async () => {
    const fixture = await setup({ viewport, dark }); try {
      const page = fixture.page;
      assert.equal(await page.locator("#instrument").isVisible(), true);
      assert.equal(await page.locator('[data-system-utilization-resource="cpu"] strong').textContent(), "24,7 %");
      assert.equal(await page.locator('[data-system-utilization-resource="memory"] strong').textContent(), "46 % belegt");
      assert.equal(await page.getByRole("heading", { name: "CPU und Arbeitsspeicher im Verlauf" }).count(), 1);
      assert.match(await page.locator(".gp-utilization-legend").textContent(), /CPU.*RAM.*Minimum–Maximum.*Lücken bleiben offen/s);
      assert.equal(await page.locator('.gp-utilization-choices button[aria-pressed="true"]').getAttribute("data-utilization-hours"), "24");
      assert.match(await page.locator(".gp-utilization-console").textContent(), /Alle 10 Sekunden.*auch wenn das System-Center geschlossen ist/s);
      assert.equal(await page.locator(".gp-utilization-fixed-dial").getAttribute("aria-hidden"), "true");
      const chart = page.getByRole("img"); assert.match(await chart.getAttribute("aria-describedby"), /summary/);
      const stroke = await page.locator('.gp-utilization-mean[data-series="memory"]').first().evaluate(node => getComputedStyle(node).strokeDasharray);
      assert.notEqual(stroke, "none", "RAM remains distinguishable without relying on colour");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      for (const item of await page.locator(".gp-utilization-choices button,.gp-utilization-dial,.gp-utilization-refresh").all()) {
        const bounds = await item.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1);
      }
      if (dark) {
        const background = await page.locator(".gp-utilization-paper").evaluate(node => getComputedStyle(node).backgroundColor);
        assert(Number(background.match(/\d+/)[0]) < 80, background);
      }
      await capture(page, name); assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });
}

test("real missing measurements split traces, retain min/max bands and distinguish missing from genuine zero", { skip: !enabled }, async () => {
  const fixture = await setup(); try {
    const page = fixture.page;
    assert.equal(await page.locator('.gp-utilization-mean[data-series="cpu"]').count(), 3);
    assert.equal(await page.locator('.gp-utilization-mean[data-series="memory"]').count(), 4);
    assert.equal(await page.locator('.gp-utilization-spread[data-series="cpu"]').count(), 3);
    const paths = await page.locator('.gp-utilization-mean[data-series="cpu"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("d")).join(" "));
    assert.match(paths, / 244(?:L|\s|$)/, "The real zero reaches the zero axis");
    assert.doesNotMatch(paths, /NaN|Infinity/);
    const point = page.locator("[data-utilization-point]");
    const select = index => point.evaluate((node, value) => { node.value = String(value); node.dispatchEvent(new Event("input", { bubbles: true })); }, index);
    await select(3); assert.match(await page.locator(".gp-utilization-inspection").textContent(), /CPU[^·]*0\s*%/);
    await select(16);
    assert.match(await page.locator(".gp-utilization-inspection").textContent(), /CPU[^·]*keine Messung.*RAM[^·]*keine Messung/s);
    await select(19);
    const partial = await page.locator(".gp-utilization-inspection").textContent(); assert.match(partial, /CPU[^·]*keine Messung/); assert.match(partial, /RAM[^·]*43\s*%/);
    assert.equal(await page.evaluate(() => calls.every(call => call.method === "GET")), true); assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test("the lightweight snapshot updates only CPU and RAM cards while their technical panel is active", { skip: !enabled }, async () => {
  const fixture = await setup({ start: false }); try {
    const page = fixture.page;
    assert.equal(await page.locator('[data-system-utilization-resource="cpu"] strong').textContent(), "Messung läuft");
    const otherCards = await page.locator('.system-center-resources article:not([data-system-utilization-resource])').allTextContents();
    await page.evaluate(() => synchronize()); await page.waitForFunction(() => snapshots.length === 1);
    assert.equal(await page.locator('[data-system-utilization-resource="cpu"] strong').textContent(), "24,7 %");
    assert.equal(await page.locator('[data-system-utilization-resource="memory"] strong').textContent(), "46 % belegt");
    assert.deepEqual(await page.locator('.system-center-resources article:not([data-system-utilization-resource])').allTextContents(), otherCards);
    await page.evaluate(() => { state.currentView = "schedule"; updateSystemUtilizationSnapshot({ current: { cpu: { usedPercent: 99 }, memory: { usedPercent: 99 } } }); });
    assert.equal(await page.locator('[data-system-utilization-resource="cpu"] strong').textContent(), "24,7 %");
    assert.equal(await page.evaluate(() => calls.length), 1); assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test("keyboard time dial, range buttons and native measurement slider expose real values", { skip: !enabled }, async () => {
  const fixture = await setup(); try {
    const page = fixture.page, dial = page.locator(".gp-utilization-dial");
    await dial.focus(); await dial.press("Home"); await page.waitForFunction(() => calls.at(-1).url.endsWith("hours=1") && snapshots.length === 2);
    assert.equal(await dial.getAttribute("aria-valuetext"), "1 Stunde");
    await dial.press("End"); await page.waitForFunction(() => calls.at(-1).url.endsWith("hours=4320") && snapshots.length === 3);
    assert.equal(await dial.getAttribute("aria-valuetext"), "180 Tage");
    await dial.press("ArrowLeft"); await page.waitForFunction(() => calls.at(-1).url.endsWith("hours=2160") && snapshots.length === 4);
    await page.getByRole("button", { name: "1 Tag", exact: true }).click(); await page.waitForFunction(() => snapshots.length === 5);
    assert.equal(await dial.getAttribute("aria-valuenow"), "2");
    const point = page.locator("[data-utilization-point]"); await point.focus(); await point.press("Home");
    assert.equal(await point.inputValue(), "0"); const first = await page.locator(".gp-utilization-inspection").textContent();
    await point.press("End"); assert.equal(await point.inputValue(), "39"); assert.notEqual(await page.locator(".gp-utilization-inspection").textContent(), first);
    assert.match(await point.getAttribute("aria-valuetext"), /CPU.*RAM/); assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test("history is polled only while permitted view and document are visible, without repeating heavyweight diagnostics", { skip: !enabled }, async () => {
  const fixture = await setup({ start: false }); try {
    const page = fixture.page; assert.equal(await page.evaluate(() => calls.length), 0);
    await page.evaluate(() => synchronize()); await page.waitForFunction(() => snapshots.length === 1);
    await page.clock.runFor(10050); await page.waitForFunction(() => snapshots.length === 2);
    assert.equal(await page.evaluate(() => calls.length), 2);
    await page.evaluate(() => { fixtureHidden = true; document.dispatchEvent(new Event("visibilitychange")); });
    await page.clock.runFor(30000); assert.equal(await page.evaluate(() => calls.length), 2);
    await page.evaluate(() => { fixtureHidden = false; document.dispatchEvent(new Event("visibilitychange")); }); await page.waitForFunction(() => snapshots.length === 3);
    await page.evaluate(() => { fixtureActive = false; synchronize(); }); await page.clock.runFor(30000);
    assert.equal(await page.evaluate(() => calls.length), 3); assert.equal(await page.locator("#instrument").isVisible(), false);
    assert.deepEqual(await page.evaluate(() => [...new Set(calls.map(call => call.url))]), ["/api/portal/v1/system-center/utilization?hours=24"]);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test("a superseded time window aborts its request, discards its late response and reads the newest selection once", { skip: !enabled }, async () => {
  const fixture = await setup(); try {
    const page = fixture.page;
    await page.evaluate(() => { hold = true; instrument.refresh(); }); await page.waitForFunction(() => waits.length === 1);
    await page.locator('[data-utilization-hours="1"]').click();
    assert.equal(await page.evaluate(() => calls[1].signal.aborted), true);
    await page.locator('[data-utilization-hours="6"]').click();
    await page.evaluate(() => { hold = false; waits.splice(0).forEach(resolve => resolve()); });
    await page.waitForFunction(() => snapshots.length === 2 && calls.at(-1).url.endsWith("hours=6"));
    assert.equal(await page.evaluate(() => calls.filter(call => call.url.endsWith("hours=6")).length), 1);
    assert.equal(await page.evaluate(() => calls.slice(1).filter(call => !call.signal.aborted).length), 1, "all superseded requests are aborted");
    assert.deepEqual(await page.evaluate(() => snapshots.map(value => value.hours)), [24, 6]); assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test("rights withdrawal or logout clears graph data immediately and cannot be undone by a late response", { skip: !enabled }, async () => {
  const fixture = await setup(); try {
    const page = fixture.page;
    await page.evaluate(() => { hold = true; instrument.refresh(); }); await page.waitForFunction(() => waits.length === 1);
    await page.evaluate(() => { fixtureActive = false; fixtureActor = ""; synchronize(); });
    assert.equal(await page.evaluate(() => calls.at(-1).signal.aborted), true);
    assert.equal(await page.locator("#instrument").isVisible(), false); assert.equal(await page.locator(".gp-utilization-mean").count(), 0);
    await page.evaluate(() => { hold = false; waits.splice(0).forEach(resolve => resolve()); });
    assert.equal(await page.evaluate(() => snapshots.length), 1); assert.equal(await page.locator(".gp-utilization-mean").count(), 0);
    await page.evaluate(() => { fixtureActor = "BEISPIEL-other-admin"; fixtureActive = true; synchronize(); }); await page.waitForFunction(() => snapshots.length === 2);
    assert.equal(await page.locator("#instrument").isVisible(), true); assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test("an unavailable refresh keeps its last timestamp visible as stale and invalid history never becomes a zero chart", { skip: !enabled }, async () => {
  const fixture = await setup(); try {
    const page = fixture.page, before = await page.locator('.gp-utilization-mean[data-series="cpu"]').first().getAttribute("d");
    await page.evaluate(() => { fail = true; instrument.refresh(); }); await page.waitForFunction(() => document.querySelector(".gp-utilization").dataset.state === "stale");
    assert.match(await page.locator(".gp-utilization-status").textContent(), /nicht aktualisiert.*letzter erfolgreicher Stand/s);
    assert.equal(await page.locator('.gp-utilization-mean[data-series="cpu"]').first().getAttribute("d"), before);
    assert.equal(await page.evaluate(() => snapshots.length), 1); assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
  const invalid = history(); invalid.integrityVerified = false;
  const rejected = await setup({ response: invalid, start: false }); try {
    await rejected.page.evaluate(() => synchronize()); await rejected.page.waitForFunction(() => document.querySelector(".gp-utilization").dataset.state === "stale");
    assert.equal(await rejected.page.locator(".gp-utilization-mean").count(), 0);
    assert.match(await rejected.page.locator(".gp-utilization-inspection").textContent(), /Sobald Messwerte vorliegen/);
    assert.deepEqual(rejected.errors, []);
  } finally { await rejected.close(); }
});

test("a real HTTP 403 clears prior technical data and stops polling until a new allowed synchronization", { skip: !enabled }, async () => {
  const fixture = await setup(); try {
    const page = fixture.page;
    await page.evaluate(() => { fail = true; failStatus = 403; instrument.refresh(); });
    await page.waitForFunction(() => document.getElementById("instrument").hidden);
    assert.equal(await page.locator(".gp-utilization-mean").count(), 0);
    assert.equal(await page.locator("[data-utilization-point]").isEnabled(), false);
    const deniedCalls = await page.evaluate(() => calls.length); await page.clock.runFor(30000);
    assert.equal(await page.evaluate(() => calls.length), deniedCalls);
    assert.equal(await page.evaluate(() => snapshots.length), 1);
    await page.evaluate(() => { fail = false; synchronize(); }); await page.waitForFunction(() => snapshots.length === 2);
    assert.equal(await page.locator("#instrument").isVisible(), true); assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test("a stalled reader is bounded, aborted and labelled stale; a late timed-out answer cannot replace data", { skip: !enabled }, async () => {
  const fixture = await setup(); try {
    const page = fixture.page;
    await page.evaluate(() => { hold = true; instrument.refresh(); }); await page.waitForFunction(() => waits.length === 1);
    await page.clock.runFor(9100);
    assert.equal(await page.evaluate(() => calls[1].signal.aborted), true);
    assert.equal(await page.locator(".gp-utilization").getAttribute("aria-busy"), "false");
    assert.equal(await page.locator(".gp-utilization").getAttribute("data-state"), "stale");
    assert.equal(await page.evaluate(() => snapshots.length), 1);
    await page.evaluate(() => { hold = false; waits.splice(0).forEach(resolve => resolve()); });
    assert.equal(await page.evaluate(() => snapshots.length), 1);
    await page.getByRole("button", { name: "Neu ablesen", exact: true }).click(); await page.waitForFunction(() => snapshots.length === 2);
    assert.equal(await page.locator(".gp-utilization").getAttribute("data-state"), "ready"); assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});
