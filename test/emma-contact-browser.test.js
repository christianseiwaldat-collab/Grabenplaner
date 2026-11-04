"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const enabled = process.env.GP_WINDOW_BROWSER_TEST === "1", root = path.resolve(__dirname, "..");
const markup = fs.readFileSync(path.join(root, "public/portal.html"), "utf8").match(/<a class="emma-contact"[\s\S]*?<\/a>/)[0];
let browser;
test.before(async () => { if (enabled) browser = await require(process.env.GP_BROWSER_TEST_MODULE || "playwright").chromium.launch({ headless: true, chromiumSandbox: process.platform === "linux", ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) }); });
test.after(async () => { await browser?.close(); });
async function setup(width = 390) {
  const page = await browser.newPage({ viewport: { width, height: 844 } }), errors = [], external = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.context().route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.host !== "127.0.0.1") { external.push(url.href); return route.fulfill({ body: "Synthetic navigation intercepted" }); }
    if (url.pathname === "/assets/emma-whatsapp.png") return route.fulfill({ contentType: "image/png", body: fs.readFileSync(path.join(root, "public/assets/emma-whatsapp.png")) });
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="de" data-ui-mode="${width <= 720 ? "mobile" : "desktop"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><header style="padding:16px"><strong>Grabenplaner · Mitarbeiterkonto</strong></header>${markup}<section id="settings" class="settings-card emma-contact-settings" hidden><h2>Emma auf WhatsApp</h2><p>Profilbild ändern; die Telefonnummer stammt aus Emmas Personalakt.</p></section></body></html>` });
  });
  await page.goto("http://127.0.0.1/emma-contact-fixture");
  for (const file of ["styles.css", "emma-contact.css"]) await page.addStyleTag({ path: path.join(root, "public", file) });
  await page.addScriptTag({ path: path.join(root, "public/emma-contact.js") });
  await page.evaluate(() => {
    window.session = { authenticated: true, user: { employeeNumber: "synthetic", role: "employee", isEmployee: true, permissions: [] } };
    window.calls = []; window.waits = [];
    window.value = { settings: { enabled: true, avatar: "" }, phone: "436601234567", revision: "one" };
    window.api = async (url, options = {}) => {
      calls.push({ url, ...options });
      const result = url.endsWith("/settings") ? structuredClone(value) : { contact: value.settings.enabled ? { href: "https://wa.me/436601234567", avatar: "/assets/emma-whatsapp.png" } : null };
      if (window.pending) await new Promise(resolve => waits.push(resolve));
      if (window.fail) throw new Error("Synthetic failure");
      if (options.method === "PUT") { value = { ...JSON.parse(options.body), phone: value.phone, revision: "two" }; return structuredClone(value); }
      return result;
    };
    window.shortcut = GpEmmaContact.shortcut(document.getElementById("emmaWhatsappContact"), { api, session: () => session });
    window.editor = GpEmmaContact.mountSettings(document.getElementById("settings"), { api, session: () => session });
  });
  return { page, errors, external, async close() { await page.context().close(); } };
}
for (const width of [360, 390, 1280]) test(`Emma shortcut: visible only on mobile, supplied portrait and safe explicit navigation at ${width}px`, { skip: !enabled }, async () => {
  const f = await setup(width); try {
    await f.page.evaluate(() => shortcut.load());
    const link = f.page.locator("#emmaWhatsappContact");
    assert.equal(await link.isVisible(), width <= 720);
    assert.equal(await link.getAttribute("href"), "https://wa.me/436601234567");
    assert.equal(await link.getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
    if (width <= 720) {
      await f.page.waitForFunction(() => document.querySelector("#emmaWhatsappContact img").naturalWidth > 0);
      assert((await link.boundingBox()).height >= 44);
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (process.env.GP_EMMA_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.GP_EMMA_SCREENSHOT_DIR, { recursive: true });
        await f.page.screenshot({ path: path.join(process.env.GP_EMMA_SCREENSHOT_DIR, `emma-mobile-${width}.png`) });
      }
      assert.equal(f.external.length, 0);
      const popup = f.page.waitForEvent("popup"); await link.click(); const opened = await popup;
      await opened.waitForLoadState(); assert.deepEqual(f.external, ["https://wa.me/436601234567"]); await opened.close();
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test("Emma shortcut: disabled, failed, branch and expired sessions stay hidden; old replies cannot restore it", { skip: !enabled }, async () => {
  const f = await setup(); try {
    await f.page.evaluate(() => { value.settings.enabled = false; return shortcut.load(); });
    assert.equal(await f.page.locator("#emmaWhatsappContact").isVisible(), false);
    await f.page.evaluate(() => { value.settings.enabled = true; fail = true; return shortcut.load(); });
    assert.equal(await f.page.locator("#emmaWhatsappContact").getAttribute("href"), null);
    for (const user of [{ isEmployee: false, accountType: "branch" }, { isEmployee: true, mustChangePassword: true }]) {
      const count = await f.page.evaluate(user => { session = { authenticated: true, user }; return calls.length; }, user);
      await f.page.evaluate(() => shortcut.load()); assert.equal(await f.page.evaluate(() => calls.length), count);
    }
    await f.page.evaluate(() => { session = { authenticated: true, user: { isEmployee: true } }; fail = false; pending = true; void shortcut.load(); });
    await f.page.waitForFunction(() => waits.length === 1);
    await f.page.evaluate(() => { session = null; shortcut.reset(); waits.splice(0).forEach(resolve => resolve()); });
    assert.equal(await f.page.locator("#emmaWhatsappContact").getAttribute("href"), null);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test("Emma settings: developer edits, uploads portrait, saves, resets and discards stale responses on account switch", { skip: !enabled }, async () => {
  const f = await setup(1000); try {
    await f.page.evaluate(() => editor.load()); assert.equal(await f.page.locator("#settings").isVisible(), false);
    await f.page.evaluate(() => { session = { authenticated: true, user: { isEmployee: true, role: "developer", permissions: ["settings:write"] } }; return editor.load(); });
    assert.equal(await f.page.getByLabel("Emmas WhatsApp-Nummer", { exact: true }).inputValue(), "+436601234567");
    assert.equal(await f.page.getByLabel("Emmas WhatsApp-Nummer", { exact: true }).getAttribute("readonly"), "");
    await f.page.getByRole("checkbox").uncheck();
    // Reopening the settings section must preserve an unsaved edit.
    await f.page.evaluate(() => editor.load());
    assert.equal(await f.page.getByRole("checkbox").isChecked(), false);
    await f.page.getByLabel("Emmas Profilbild auswählen").setInputFiles(path.join(root, "public/assets/emma-whatsapp.png"));
    await f.page.getByText("Profilbild ausgewählt. Bitte speichern.").waitFor();
    await f.page.getByRole("button", { name: "Emma-Kontakt speichern", exact: true }).click();
    await f.page.getByText("Emma-Kontakt gespeichert.", { exact: true }).waitFor();
    const write = await f.page.evaluate(() => JSON.parse(calls.find(c => c.method === "PUT").body));
    assert.equal(write.revision, "one"); assert.equal(Object.hasOwn(write.settings, "phone"), false); assert.equal(write.settings.enabled, false); assert.match(write.settings.avatar, /^data:image\/png;base64,/);
    await f.page.getByRole("button", { name: "Emmas Standardbild verwenden" }).click();
    assert.equal(await f.page.locator("#settings img").getAttribute("src"), "/assets/emma-whatsapp.png");
    if (process.env.GP_EMMA_SCREENSHOT_DIR) await f.page.screenshot({ path: path.join(process.env.GP_EMMA_SCREENSHOT_DIR, "emma-settings.png"), fullPage: true });
    await f.page.evaluate(() => { pending = true; void editor.load(true); });
    await f.page.waitForFunction(() => waits.length === 1);
    await f.page.evaluate(() => { session = null; editor.synchronize(); waits.splice(0).forEach(resolve => resolve()); });
    assert.equal(await f.page.locator("#settings").isVisible(), false);
    assert.equal(await f.page.getByLabel("Emmas WhatsApp-Nummer", { exact: true }).inputValue(), "");
    assert.deepEqual(f.errors, []); assert.deepEqual(f.external, []);
  } finally { await f.close(); }
});
