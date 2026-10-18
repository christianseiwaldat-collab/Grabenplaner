"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs");
const UI = require("../test-support/cost-centers-workspace-ui");
const options = { skip: process.env.GP_WINDOW_BROWSER_TEST !== "1", timeout: 60000 };
async function browser() { const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright"); return chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) }); }
const cardCount = page => page.locator("#costCenterList .cost-center-card").count();
async function geometry(page, scope = "#costCenterSection") {
  return page.evaluate(selector => {
    const root = document.querySelector(selector), bounds = root.getBoundingClientRect();
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, root: { left: bounds.left, right: bounds.right }, overflowing: [...root.querySelectorAll("*")].filter(node => node.getClientRects().length && getComputedStyle(node).overflowX === "visible" && node.scrollWidth > node.clientWidth + 2 && node.clientWidth > 0).map(node => ({ tag: node.tagName, id: node.id, class: node.className, parentClass: node.parentElement.className, text: node.textContent.trim().slice(0, 100), width: node.clientWidth, content: node.scrollWidth })) };
  }, scope);
}
async function textContrast(page, selector) {
  return page.locator(selector).evaluateAll(labels => {
    const rgb = color => (color.match(/[\d.]+/g) || []).map(Number);
    const luminance = values => values.slice(0, 3).map(value => { value /= 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    return labels.map(label => {
      let parent = label, background;
      while (parent) { const color = rgb(getComputedStyle(parent).backgroundColor); if (color.length === 3 || color[3] === 1) { background = color; break; } parent = parent.parentElement; }
      const foreground = rgb(getComputedStyle(label).color), first = luminance(foreground), second = luminance(background || [255, 255, 255]);
      return { text: label.textContent, foreground, background, ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05) };
    });
  });
}

test("Kostenstellen: echte Suche, Typ, Status, Reset, leere Ergebnisse und Schreibrechte", options, async () => {
  const b = await browser(); try {
    const page = await b.newPage({ viewport: { width: 1440, height: 1000 } }); const { errors, requests } = await UI.prepare(page);
    assert.equal(await cardCount(page), 6);
    assert.deepEqual(await page.locator(".cost-center-overview dd").allTextContents(), ["4", "2", "4"]);
    await page.getByLabel("Kostenstelle suchen", { exact: true }).fill("  BERATUNG innenstadt  ");
    assert.equal(await cardCount(page), 1); assert.match(await page.locator("#costCenterList").textContent(), /Beispiel Innenstadt/);
    await page.locator("#costCenterSearch").fill("19"); assert.equal(await cardCount(page), 1);
    await page.locator("#costCenterSearch").fill(""); assert.equal(await cardCount(page), 6);
    await page.locator("#costCenterFilterType").selectOption("SYN-B");
    await page.locator("#costCenterFilterStatus").selectOption("active"); assert.equal(await cardCount(page), 2);
    await page.locator("#costCenterFilterStatus").selectOption("inactive"); assert.equal(await cardCount(page), 1);
    await page.locator("#costCenterSearch").fill("nicht-vorhanden");
    assert.equal(await cardCount(page), 0); assert.match(await page.locator("#costCenterList").textContent(), /Keine passende Kostenstelle/);
    assert.equal(await page.locator("#costCenterResultCount").textContent(), "0 von 6 Kostenstellen");
    await page.getByRole("button", { name: "Zurücksetzen", exact: true }).click();
    assert.equal(await cardCount(page), 6);
    assert.deepEqual(await page.evaluate(() => [costCenterSearch.value, costCenterFilterType.value, costCenterFilterStatus.value, document.activeElement.id]), ["", "", "", "costCenterSearch"]);
    assert.deepEqual(await page.locator(".cost-center-overview dd").allTextContents(), ["4", "2", "4"]);
    await page.locator(".cost-center-types-panel > summary").click();
    assert.equal(await page.locator("[data-edit-cost-center-type]").count(), 5);
    await page.evaluate(() => { state.portalSession.user.permissions = ["cost_centers:read"]; refreshCostCenterAccess(); });
    assert.equal(await page.locator("[data-edit-cost-center],[data-edit-cost-center-type]").count(), 0);
    assert.equal(await page.locator("#addCostCenterButton").isVisible(), false); assert.equal(await page.locator("#addCostCenterTypeButton").isVisible(), false);
    await page.evaluate(() => { openCostCenterModal(state.costCenters[0]); openCostCenterTypeModal(state.costCenterTypes[0]); });
    assert.equal(await page.locator("dialog[open]").count(), 0);
    await page.evaluate(() => { state.costCenters = []; renderCostCenters(); });
    assert.match(await page.locator("#costCenterList").textContent(), /Noch keine Kostenstellen/);
    assert.equal(await page.locator("#costCenterResultCount").textContent(), "0 von 0 Kostenstellen");
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  } finally { await b.close(); }
});

for (const width of [1440, 390]) for (const zoom of [1, 1.25]) for (const dark of [false, true]) {
  test(`Kostenstellen actual layout ${width}px / ${zoom * 100}% CSS zoom / ${dark ? "dark" : "light"}: lange Inhalte, echte Dialoge und Mausrad`, options, async () => {
    const b = await browser(); try {
      const page = await b.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } }); const { errors, requests } = await UI.prepare(page, { dark, zoom });
      await page.locator(".cost-center-types-panel > summary").click();
      const pageGeometry = await geometry(page);
      const labelContrasts = await textContrast(page, "#costCenterFilterForm .field > span");
      const name = `cost-centers-${width}-${Math.round(zoom * 100)}-${dark ? "dark" : "light"}`;
      await page.screenshot({ path: path.join(UI.screenshotDirectory(), name + ".png"), fullPage: true });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: path.join(UI.screenshotDirectory(), name + "-viewport.png") });
      const dialogResults = [];
      for (const [id, button, expectedName] of [["costCenterModal", "[data-edit-cost-center='SYN-18']", "Kostenstelle bearbeiten"], ["costCenterTypeModal", "[data-edit-cost-center-type='SYN-B']", "Kostenstellentyp bearbeiten"]]) {
        await page.locator(button).click();
        await page.getByRole("dialog", { name: expectedName, exact: true }).waitFor({ state: "visible" });
        assert.equal(await page.locator("#" + id).evaluate(node => node.matches(":modal")), false, "workspace mode");
        // Constrain the real managed window, exercising its central scroll body.
        await page.evaluate(id => { GpWindow.prepare(document.getElementById(id)).set({ x: 18, y: 18, width: Math.min(700, innerWidth / salesArticleSearchWindowScale() - 36), height: 440, minimized: false }); }, id);
        const body = page.locator("#" + id + " > .gp-dialog-body");
        await body.evaluate(node => { node.scrollTop = 0; });
        const bounds = await body.boundingBox(); assert.ok(bounds);
        await page.mouse.move(bounds.x + Math.min(25, bounds.width / 2), bounds.y + Math.min(120, bounds.height / 2));
        await page.mouse.wheel(0, 460);
        await page.waitForFunction(id => document.querySelector("#" + id + " > .gp-dialog-body").scrollTop > 0, id);
        const scroll = await body.evaluate(node => ({ top: node.scrollTop, height: node.clientHeight, contentHeight: node.scrollHeight, width: node.clientWidth, contentWidth: node.scrollWidth }));
        const dialogGeometry = await geometry(page, "#" + id);
        const titleContrasts = await textContrast(page, "#" + id + " .gp-window-title-text");
        dialogResults.push({ id, scroll, geometry: dialogGeometry, titleContrasts });
        await page.screenshot({ path: path.join(UI.screenshotDirectory(), name + "-" + id + ".png") });
        if (id === "costCenterModal") {
          assert.equal(await page.locator("#costCenterCode").inputValue(), "18"); assert.equal(await page.locator("#costCenterCode").isDisabled(), true);
          await page.locator("#costCenterName").fill("Synthetischer ungespeicherter Entwurf");
          await page.locator("#" + id + " [data-gp-window-toggle]").click(); await page.locator("#" + id + " [data-gp-window-toggle]").click();
          assert.equal(await page.locator("#costCenterName").inputValue(), "Synthetischer ungespeicherter Entwurf");
        } else {
          assert.equal(await page.locator("#costCenterTypePositionOptions input").count(), 26);
          await page.locator("#costCenterTypePositionSearch").fill("Filialleitung"); assert.equal(await page.locator("#costCenterTypePositionOptions input").count(), 1);
          await page.locator("#costCenterTypePositionOptions input").uncheck(); assert.equal(await page.locator("#costCenterTypePositionCount").textContent(), "25 ausgewählt");
        }
        await page.locator("#" + id + " [data-gp-window-close]").click();
      }
      fs.writeFileSync(path.join(UI.screenshotDirectory(), name + ".json"), JSON.stringify({ syntheticOnly: true, actualMarkupFunctionsAndBindings: true, width, cssZoom: zoom, dark, pageGeometry, labelContrasts, dialogs: dialogResults, pageErrors: errors, networkRequests: requests }, null, 2) + "\n");
      assert.ok(pageGeometry.documentWidth <= width, JSON.stringify(pageGeometry));
      assert.deepEqual(pageGeometry.overflowing, [], JSON.stringify(pageGeometry));
      assert.equal(labelContrasts.length, 3);
      assert.ok(labelContrasts.every(label => label.ratio >= 4.5), JSON.stringify(labelContrasts));
      for (const result of dialogResults) {
        assert.ok(result.scroll.contentWidth <= result.scroll.width + 2, JSON.stringify(result));
        assert.ok(result.geometry.root.left >= 0 && result.geometry.root.right <= width + 1, JSON.stringify(result));
        assert.equal(result.titleContrasts.length, 1);
        assert.ok(result.titleContrasts.every(title => title.ratio >= 4.5), JSON.stringify(result.titleContrasts));
      }
      assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    } finally { await b.close(); }
  });
}
