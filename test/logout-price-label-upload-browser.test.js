"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { functionSource } = require("../test-support/learning-workspace-ui");
const root = path.resolve(__dirname, "..");
const enabled = process.env.GP_SALES_PRICE_LABEL_EDITOR_BROWSER_TEST === "1";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lF8AAAAASUVORK5CYII=", "base64");

async function launch() {
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  return chromium.launch({ headless: true,
    ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}),
    args: ["--no-first-run"] });
}

test("an upload-state render failure before HTTP starts releases the image-upload state", {
  skip: !enabled, timeout: 30000,
}, async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://logout-upload.test/**", route => route.fulfill({ contentType: "text/html",
      body: '<!doctype html><div id="preview"></div><div id="toolbar"></div><div id="images"></div><div id="live"></div>' }));
    await page.goto("https://logout-upload.test/");
    for (const name of ["sales-price-label-fonts.js", "sales-price-label-design.js", "sales-price-label-editor.js", "sales-price-labels.js"])
      await page.addScriptTag({ path: path.join(root, "public", name) });
    await page.evaluate(() => {
      window.uploadStates = [];
      window.uploadCalls = 0;
      const value = GrabenplanerSalesPriceLabels.normalizeOptions({});
      window.editor = GrabenplanerPriceLabelEditor.mount({
        preview: document.getElementById("preview"), toolbar: document.getElementById("toolbar"),
        images: document.getElementById("images"), live: document.getElementById("live"),
        read: () => value, write() {}, canEdit: () => true, context: () => "synthetic-a",
        upload: async () => { uploadCalls++; throw new Error("HTTP must not start after the render failure"); },
        onUploadState: state => {
          uploadStates.push(state);
          if (state) throw new Error("Synthetic upload-state render failure");
        },
      });
      editor.render({ value, article: { articleNumber: "107506", description: "Synthetic camera" }, price: "129,00", editable: true });
    });
    await page.locator("[data-pl-image-input]").setInputFiles({ name: "Synthetic.png", mimeType: "image/png", buffer: png });
    // The listener has no pending network work: the next browser task observes
    // both the callback and its finally, rather than waiting for a timeout.
    const observed = await page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      return { states: uploadStates, calls: uploadCalls,
        disabled: document.querySelector("[data-pl-image-input]").disabled,
        status: document.querySelector("[data-pl-image-status]").textContent };
    });
    assert.deepEqual(observed.states, [true, false], "A failed render cannot leave an upload flag without an upload request");
    assert.equal(observed.calls, 0);
    assert.equal(observed.disabled, false);
    assert.match(observed.status, /Synthetic upload-state render failure/);
    assert.deepEqual(errors, [], "The failure must reach the existing error presentation instead of an unhandled rejection");
  } finally { await browser.close(); }
});

const workspaceAssets = ["gp-window-preferences.js", "gp-window.js", "sales-article-report-pdf-preview.js", "gp-print-window.js",
  "gp-existing-pdf-window.js", "gp-price-label-pdf.js", "sales-price-label-fonts.js", "sales-price-label-layout.js",
  "sales-price-label-design.js", "sales-price-label-editor.js", "sales-price-label-project.js",
  "sales-price-label-working-draft.js", "sales-price-labels.js", "session-lifecycle.js"];

// Reuse the real-workspace fixture shape from sales-price-label-workspace-browser:
// actual DOM/form/editor/DraftStore, synthetic articles and HTTP boundaries only.
async function mountWorkspace(browser, mode) {
  const context = await browser.newContext();
  const page = await context.newPage({ viewport: { width: 1600, height: 1100 } });
  const pageErrors = [], calls = { images: 0, logout: 0, puts: 0, failures: 0 };
  let releaseImage, draftFailure = "";
  const imageGate = new Promise(resolve => { releaseImage = resolve; });
  const drafts = new Map();
  const currentDraft = actor => {
    if (!drafts.has(actor)) drafts.set(actor, { revision: 0, draft: null, lastMutationId: null });
    return drafts.get(actor);
  };
  page.on("pageerror", error => pageErrors.push(error.message));
  const fulfill = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("https://logout-upload.test/**", async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div><button id="logout">Abmelden</button><p id="logout-status"></p><input id="login-password"><input id="login-personnel">' });
    if (pathname.startsWith("/fonts/price-labels/")) return route.fulfill({ contentType: "font/ttf", body: fs.readFileSync(path.join(root, "public", pathname)) });
    if (pathname.startsWith("/api/sales/price-labels/images/")) return route.fulfill({ contentType: "image/png", body: png });
    if (pathname === "/api/sales/price-labels/images" && request.method() === "POST") {
      calls.images++;
      assert.match(request.headers()["content-type"], /^multipart\/form-data; boundary=/);
      assert.match(request.postDataBuffer().toString("latin1"), /filename="Synthetic.png"/);
      await imageGate;
      try {
        if (mode === "network" || mode === "account-abort") return await route.abort("failed");
        if (mode === "http") return await fulfill(route, { error: "Synthetic image rejection" }, 503);
        if (mode === "json") return await route.fulfill({ contentType: "application/json", body: "{not-json" });
        return await fulfill(route, { image: { assetId: "11111111-1111-4111-8111-111111111111", width: 200, height: 100, mime: "image/png" } });
      } catch (error) {
        if (mode !== "account-abort" || !/closed|aborted|cancelled|handled/i.test(error.message)) throw error;
      }
      return;
    }
    if (pathname === "/api/portal/v1/auth/logout") { calls.logout++; return fulfill(route, {}); }
    if (pathname === "/api/sales/price-labels/draft") {
      const actor = request.headers()["x-synthetic-actor"] || "synthetic-a", saved = currentDraft(actor);
      if (request.method() === "PUT") {
        calls.puts++;
        if (draftFailure) {
          calls.failures++;
          if (draftFailure === "network") return route.abort("failed");
          return fulfill(route, { error: "Synthetic persistent draft storage failure", code: "PERSISTENCE_TIMEOUT" }, 503);
        }
        const body = request.postDataJSON();
        assert.equal(body.revision, saved.revision);
        Object.assign(saved, { revision: saved.revision + 1, draft: body.draft, lastMutationId: body.mutationId });
      }
      return fulfill(route, saved);
    }
    if (pathname === "/api/sales/price-labels/templates") return fulfill(route, { options: require("../public/sales-price-labels").normalizeOptions({}), filenameOptions: { stamp: "none", position: "before", separator: "-", suffix: "" }, hasSavedDefaults: false });
    if (pathname === "/api/sales/price-labels/branding") return fulfill(route, { kits: [] });
    if (pathname === "/api/sales/price-labels/library") return fulfill(route, { templates: [], capabilities: { create: true, ownBranch: false }, recipients: [] });
    if (pathname === "/api/sales/price-labels/projects") return fulfill(route, { projects: [] });
    if (pathname === "/api/sales/price-labels/images") return fulfill(route, { images: [] });
    if (pathname === "/api/sales/price-labels/articles") return fulfill(route, { items: request.postDataJSON().articleNumbers.map(articleNumber => ({ articleNumber, description: "Synthetic camera", priceGross: "129.00", brand: "Synthetic", taxRate: "20", ean: "123" })), updatedAt: new Date().toISOString() });
    return route.fulfill({ status: 404, body: "Unexpected synthetic endpoint" });
  });
  await page.goto("https://logout-upload.test/");
  for (const name of ["gp-window.css", "gp-print-window.css", "sales-price-labels.css", "sales-price-label-editor.css"])
    await page.addStyleTag({ path: path.join(root, "public", name) });
  for (const name of workspaceAssets) await page.addScriptTag({ path: path.join(root, "public", name) });
  await page.evaluate(() => {
    window.actor = "synthetic-a";
    window.uploadRequests = 0;
    window.uploadAborted = false;
    window.rawApi = async (url, options = {}) => {
      if (url === "/api/sales/price-labels/images" && options.method === "POST") {
        uploadRequests++;
        options.signal.addEventListener("abort", () => { uploadAborted = true; }, { once: true });
      }
      const response = await fetch(url, { ...options, headers: { ...options.headers, "X-Synthetic-Actor": actor } });
      if (!response.ok) {
        const body = await response.json();
        throw Object.assign(new Error(body.error || "Synthetic HTTP failure"), { code: body.code, status: response.status });
      }
      return response;
    };
    window.api = async (url, options) => (await rawApi(url, options)).json();
    window.workspace = GrabenplanerSalesPriceLabels.mount(document.getElementById("root"), { accessKey: () => actor, api, rawApi });
  });
  await page.evaluate(() => workspace.load());
  await page.locator("[name=articleNumbers]").fill("107506");
  await page.locator("[data-pl=refresh]").click();
  await page.waitForSelector("[data-pl-element=description]");
  await page.evaluate(() => workspace.flush());
  const logoutSource = [functionSource("processTaskActorFingerprint", "portal.js"),
    "let logoutInProgress = null;", functionSource("syncPortalLogoutControls", "portal.js"), functionSource("logout", "portal.js")].join("\n");
  await page.evaluate(source => {
    window.portalState = { session: { authenticated: true, user: { employeeNumber: actor, role: "employee" } }, processTasksOwnerFingerprint: actor };
    window.portalUser = () => portalState.session?.user;
    window.branchPriceLabelsWorkspace = workspace;
    window.el = { logoutButton: document.getElementById("logout"), portalLogoutStatus: document.getElementById("logout-status"), loginPassword: document.getElementById("login-password"), loginPersonnelNumber: document.getElementById("login-personnel") };
    window.message = (node, value, error) => { node.textContent = value; node.dataset.error = String(Boolean(error)); };
    window.loginShown = 0;
    window.showLogin = () => { loginShown++; };
    for (const name of ["neutralizeBirthdayPresentationTheme", "refreshBirthdayPresentationTheme", "syncPortalWindows", "stopBranchOrderAutosave", "clearProcessTaskState", "clearRememberedPortalTab"]) window[name] = () => {};
    window.portalVoiceAssistant = null;
    window.privatePortalWorkspaces = { synchronize() {} };
    (0, eval)(source + "\nwindow.runLogout = logout;");
  }, logoutSource);
  return { page, calls, pageErrors, close: () => context.close(), releaseImage,
    setDraftFailure: value => { draftFailure = value; } };
}

test("actual workspace and portal logout distinguish drafts from real image requests and clear completed or failed uploads", {
  skip: !enabled, timeout: 120000,
}, async t => {
  const browser = await launch();
  try {
    for (const mode of ["no-file", "draft-storage", "draft-network", "success", "http", "network", "json", "account-abort", "navigation"])
      await t.test(mode, async () => {
        const fixture = await mountWorkspace(browser, mode), { page, calls } = fixture;
        try {
          assert.equal(await page.evaluate(() => workspace.hasPendingUpload), false);
          if (mode === "no-file") {
            await page.locator("[data-pl-image-input]").dispatchEvent("change");
            await page.locator("[name=headline]").fill("Changed immediately before logout");
          } else if (mode.startsWith("draft-")) {
            fixture.setDraftFailure(mode.slice(6));
            await page.locator("[name=headline]").fill("Keep this unsaved draft");
            await page.evaluate(() => runLogout());
            assert.equal(calls.logout, 0);
            assert.ok(calls.failures >= 1);
            assert.equal(await page.evaluate(() => workspace.hasPendingUpload), false);
            assert.match(await page.locator("#logout-status").textContent(), /Entwurf|entwurf/);
            assert.doesNotMatch(await page.locator("#logout-status").textContent(), /Preisschildbild|Bild wird|Bild-Upload/);
            assert.equal(await page.locator("[name=headline]").inputValue(), "Keep this unsaved draft");
            fixture.setDraftFailure("");
          } else {
            await page.locator("[data-pl-image-input]").setInputFiles({ name: "Synthetic.png", mimeType: "image/png", buffer: png });
            await page.waitForFunction(() => uploadRequests === 1 && workspace.hasPendingUpload);
            await page.evaluate(() => runLogout());
            assert.equal(calls.images, 1, "The upload hint must correspond to an actual multipart POST");
            assert.equal(calls.logout, 0);
            assert.match(await page.locator("#logout-status").textContent(), /Preisschildbild wird noch geladen/);
            assert.equal(await page.evaluate(() => Boolean(portalState.session)), true);
            if (mode === "account-abort") {
              await page.evaluate(async () => {
                actor = "synthetic-b";
                portalState.session = { authenticated: true, user: { employeeNumber: actor, role: "employee" } };
                await workspace.load();
              });
              await page.waitForFunction(() => uploadAborted && !workspace.hasPendingUpload);
            } else if (mode === "navigation") {
              await page.evaluate(() => { workspace.suspend(); document.getElementById("root").hidden = true; });
              assert.equal(await page.evaluate(() => workspace.hasPendingUpload), true, "Navigation must keep protecting the HTTP request until it finishes");
              assert.equal(await page.evaluate(() => uploadAborted), false);
            }
            fixture.releaseImage();
            await page.waitForFunction(() => !workspace.hasPendingUpload);
            if (mode === "navigation") await page.evaluate(async () => { document.getElementById("root").hidden = false; await workspace.load(); });
          }
          await page.evaluate(() => runLogout());
          assert.equal(calls.logout, 1);
          assert.equal(await page.evaluate(() => loginShown), 1);
          assert.equal(await page.evaluate(() => portalState.session), null);
          assert.equal(await page.evaluate(() => workspace.hasPendingUpload), false);
          assert.doesNotMatch(await page.locator("#logout-status").textContent(), /Preisschildbild|Bild wird|Bild-Upload/);
          assert.deepEqual(fixture.pageErrors, []);
          if (mode === "no-file" || mode.startsWith("draft-")) assert.equal(calls.images, 0);
        } finally {
          fixture.releaseImage();
          await fixture.close();
        }
      });
  } finally { await browser.close(); }
});
