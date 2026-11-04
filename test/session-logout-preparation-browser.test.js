"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

test("real browser: logout preparation holds Web Locks and IndexedDB without invalidating pending saves", {
  skip: process.env.GP_SECURITY_AUTH_BROWSER_TEST !== "1", timeout: 60000,
}, async t => {
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  const source = fs.readFileSync(path.join(__dirname, "../public/session-lifecycle.js"), "utf8");
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Synthetic logout preparation</title>");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) });
    for (const mode of ["web-locks", "indexeddb"]) for (const saved of [true, false]) {
      await t.test(`${mode}: ${saved ? "saved" : "cancelled"}`, async () => {
        const context = await browser.newContext();
        try {
          if (mode === "indexeddb") await context.addInitScript(() => Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }));
          const a = await context.newPage(), b = await context.newPage();
          for (const page of [a, b]) {
            await page.goto(origin);
            await page.addScriptTag({ content: source });
          }
          assert.equal(await a.evaluate(() => Boolean(navigator.locks?.request)), mode === "web-locks");
          await context.addCookies([{ name: "grabenplaner_csrf", value: "synthetic-a", url: origin }]);
          await a.evaluate(saved => {
            window.authCalls = 0;
            window.pendingLogout = GrabenplanerSessionLifecycle.credentials(() => { authCalls++; }, {
              prepare: async () => {
                window.saveGeneration = GrabenplanerSessionLifecycle.generation;
                await new Promise(resolve => { window.finishSave = resolve; });
                if (GrabenplanerSessionLifecycle.generation !== saveGeneration) throw new Error("Autosave acknowledgement invalidated");
                return saved;
              },
            });
          }, saved);
          await a.waitForFunction(() => typeof finishSave === "function");
          assert.deepEqual(await a.evaluate(() => ({ generation: GrabenplanerSessionLifecycle.generation, auth: authCalls })), { generation: 0, auth: 0 });
          await b.evaluate(() => {
            window.loginCalled = false;
            window.queuedLogin = GrabenplanerSessionLifecycle.credentials(() => { loginCalled = true; }, { allowAccountChange: true });
          });
          await b.waitForTimeout(100);
          assert.equal(await b.evaluate(() => loginCalled), false, "A competing tab must wait through draft preparation");
          await a.evaluate(() => finishSave());
          await a.evaluate(() => pendingLogout);
          await b.evaluate(() => queuedLogin);
          assert.equal(await b.evaluate(() => loginCalled), true);
          assert.deepEqual(await a.evaluate(() => ({ generation: GrabenplanerSessionLifecycle.generation, auth: authCalls })),
            { generation: saved ? 1 : 0, auth: saved ? 1 : 0 });
        } finally { await context.close(); }
      });
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});
