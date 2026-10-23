"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, ".."), enabled = process.env.GP_WINDOW_BROWSER_TEST === "1";
const html = fs.readFileSync(path.join(root, "public/portal.html"), "utf8");
const start = html.indexOf('<div class="portal-app'), end = html.indexOf("      <main>", start);
const markup = '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'
  + html.slice(start, end).replace('class="portal-app hidden"', 'class="portal-app"') + "</div></body></html>";
let browser;
test.before(async () => {
  if (!enabled) return;
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) });
});
test.after(async () => { if (browser) await browser.close(); });

async function setup({ viewport = { width: 1366, height: 900 }, dark = false } = {}) {
  const page = await browser.newPage({ viewport, colorScheme: dark ? "dark" : "light" }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).pathname === "/assets/grabenplaner-logo.svg") return route.fulfill({ status: 200, contentType: "image/svg+xml", body: fs.readFileSync(path.join(root, "public/assets/grabenplaner-logo.svg")) });
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: markup });
  });
  await page.goto("http://127.0.0.1/voice-fixture");
  await page.addStyleTag({ path: path.join(root, "public/portal.css") });
  await page.addStyleTag({ path: path.join(root, "public/voice-assistant.css") });
  await page.addScriptTag({ path: path.join(root, "public/voice-assistant.js") });
  await page.evaluate(() => {
    window.exampleSession = { authenticated: true, user: { employeeNumber: "BEISPIEL-A", isEmployee: true, role: "admin" } };
    document.getElementById("portalUserName").textContent = "Alexandra Beispiel";
    document.getElementById("portalUserRole").textContent = "Administratorin";
    window.exampleCalls = []; window.exampleWrites = 0; window.exampleStarts = 0; window.exampleMediaStops = 0;
    window.exampleDraft = { id: "example-draft", kind: "vacation", dateFrom: "2026-10-19", dateTo: "2026-10-23", allDay: true,
      days: 5, minutes: null, check: { submissionAllowed: true, reason: "Die bestehende GP-Vorprüfung lässt einen Antrag zur Genehmigung zu." },
      warnings: ["BEISPIEL Hinweis: Der ausgewiesene Saldo wird bei der verbindlichen Einreichung erneut geprüft."],
      assumptions: ["Ohne Jahresangabe wurde 2026 in Europe/Vienna gewählt. Bitte Zeitraum prüfen."], workDates: ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"],
      confirmationToken: "example-capability", expiresAt: "2026-10-12T14:30:00Z" };
    class ExampleChannel extends EventTarget {
      readyState = "open"; sent = [];
      emit(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
      send(value) { this.sent.push(JSON.parse(value)); }
      close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
    }
    class ExamplePeer extends EventTarget {
      iceGatheringState = "complete"; connectionState = "connected"; localDescription = null;
      constructor() { super(); window.examplePeer = this; }
      createDataChannel(label) { window.exampleChannelLabel = label; this.events = new ExampleChannel(); return this.events; }
      addTrack() {} async createOffer() { return { type: "offer", sdp: "v=0\r\nBEISPIEL-offer" }; }
      async setLocalDescription(value) { this.localDescription = value; }
      async setRemoteDescription() { this.events.emit({ type: "session.started", session: { id: "live-example" } }); }
      close() { this.connectionState = "closed"; }
    }
    window.RTCPeerConnection = ExamplePeer;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => {
      if (window.exampleMediaDenied) throw new DOMException("BEISPIEL denied", "NotAllowedError");
      if (window.exampleHoldMedia) await new Promise(resolve => { window.exampleReleaseMedia = resolve; });
      const track = { stop() { exampleMediaStops++; } }; return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } });
    window.exampleApi = async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      exampleCalls.push({ url, method: options.method || "GET", body });
      if (url.endsWith("/status")) return { enabled: true, configured: true, adminOnly: true };
      if (url.endsWith("/conversations")) return { conversationId: "example-conversation-" + (++exampleStarts), maxSessionSeconds: 600,
        ...(body.sdp ? { session: { id: "live-example" }, transport: { type: "webrtc", sdp: "v=0\r\nBEISPIEL-answer" } } : {}) };
      if (url.endsWith("/messages")) {
        const value = { text: "Urlaubsentwurf vom 19. bis 23. Oktober 2026, fünf Urlaubstage. Noch nicht eingereicht.", draft: structuredClone(exampleDraft) };
        if (window.exampleHoldMessage) await new Promise(resolve => { window.exampleReleaseMessage = resolve; });
        return value;
      }
      if (url.endsWith("/confirm")) {
        if (window.exampleChanged) { exampleDraft.days = 4; exampleDraft.confirmationToken = "new-capability"; exampleChanged = false; throw Object.assign(new Error("BEISPIEL geänderte Vorschau"), { status: 409, code: "ASSISTANT_PREVIEW_CHANGED" }); }
        if (!exampleWrites) exampleWrites++;
        if (window.exampleLostReply) { exampleLostReply = false; throw new Error("BEISPIEL Antwort verloren"); }
        return { text: "Der Antrag wurde eingereicht und wartet auf Freigabe.", request: { id: 1, status: "pending" }, draft: null };
      }
      if (url.endsWith("/draft")) return options.method === "DELETE" ? null : { draft: structuredClone(exampleDraft) };
      return null;
    };
    window.exampleModule = GpVoiceAssistant.mount({ api: exampleApi, getSession: () => exampleSession });
    void exampleModule.synchronize();
  });
  await page.locator("#voiceAssistantLaunch:not(.hidden)").waitFor(); await page.locator("#voiceAssistantLaunch").click();
  return { page, errors, async close() { await page.evaluate(() => exampleModule.reset()); await page.close(); } };
}
async function prepare(page) {
  await page.locator("#voiceAssistantInput").fill("Ich möchte vom 19. bis 23. Oktober Urlaub nehmen.");
  await page.locator("#voiceAssistantSend").click();
  await page.waitForFunction(() => !document.getElementById("voiceAssistantConfirm").disabled);
}

for (const [label, viewport, dark] of [["desktop", { width: 1366, height: 900 }, false], ["smartphone", { width: 390, height: 844 }, false], ["smartphone dark", { width: 390, height: 844 }, true]]) {
  test("actual portal assistant " + label + ": draft, accessible controls and explicit submit", { skip: !enabled }, async () => {
    const f = await setup({ viewport, dark });
    try {
      await prepare(f.page);
      assert.equal(await f.page.evaluate(() => exampleWrites), 0);
      assert.match(await f.page.locator("#voiceAssistantDraft").innerText(), /noch nicht eingereicht/);
      const layout = await f.page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
        confirm: document.getElementById("voiceAssistantConfirm").getBoundingClientRect().height }));
      assert.equal(layout.overflow, false); assert(layout.confirm >= 44);
      if (process.env.GP_VOICE_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.GP_VOICE_SCREENSHOT_DIR, { recursive: true });
        await f.page.evaluate(() => scrollTo(0, 0));
        await f.page.screenshot({ fullPage: true, path: path.join(process.env.GP_VOICE_SCREENSHOT_DIR, label.replaceAll(" ", "-") + ".png") });
      }
      await f.page.locator("#voiceAssistantConfirm").click(); await f.page.waitForFunction(() => document.getElementById("voiceAssistantDraft").classList.contains("hidden"));
      assert.equal(await f.page.evaluate(() => exampleWrites), 1); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
test("lost submit response retries the same confirmation; a changed preview is fetched and shown", { skip: !enabled }, async () => {
  const f = await setup(); try {
    await prepare(f.page); await f.page.evaluate(() => { exampleChanged = true; });
    await f.page.locator("#voiceAssistantConfirm").click(); await f.page.waitForFunction(() => document.getElementById("voiceAssistantDraftSummary").textContent.includes("4 Urlaubstage") && !document.getElementById("voiceAssistantConfirm").disabled);
    assert.equal(await f.page.evaluate(() => exampleWrites), 0);
    await f.page.evaluate(() => { exampleLostReply = true; }); await f.page.locator("#voiceAssistantConfirm").click();
    await f.page.waitForFunction(() => document.getElementById("voiceAssistantStatus").textContent.includes("Antwort verloren") && !document.getElementById("voiceAssistantConfirm").disabled);
    await f.page.locator("#voiceAssistantConfirm").click(); await f.page.waitForFunction(() => document.getElementById("voiceAssistantDraft").classList.contains("hidden"));
    const calls = await f.page.evaluate(() => exampleCalls.filter(call => call.url.endsWith("/confirm")).map(call => call.body.confirmationToken));
    assert.deepEqual(calls, ["example-capability", "new-capability", "new-capability"]); assert.equal(await f.page.evaluate(() => exampleWrites), 1);
  } finally { await f.close(); }
});
test("logout neutralizes a late response, transcript and confirmation capability", { skip: !enabled }, async () => {
  const f = await setup(); try {
    await f.page.evaluate(() => { exampleHoldMessage = true; });
    await f.page.locator("#voiceAssistantInput").fill("Urlaub 19. bis 23. Oktober"); await f.page.locator("#voiceAssistantSend").click();
    await f.page.waitForFunction(() => Boolean(window.exampleReleaseMessage));
    await f.page.evaluate(() => { exampleSession = null; exampleModule.reset(); exampleReleaseMessage(); });
    await f.page.waitForFunction(() => document.getElementById("voiceAssistantLog").childElementCount === 0);
    assert.equal(await f.page.locator("#voiceAssistantPanel").isVisible(), false); assert.equal(await f.page.evaluate(() => exampleWrites), 0);
  } finally { await f.close(); }
});
test("WebRTC events wait for transcript fragments, deduplicate delegation, and never submit speech", { skip: !enabled }, async () => {
  const f = await setup(); try {
    await f.page.locator("#voiceAssistantMic").click(); await f.page.waitForFunction(() => document.getElementById("voiceAssistantStatus").textContent === "Zuhören");
    await f.page.evaluate(() => {
      examplePeer.events.emit({ type: "session.input_transcript.delta", delta: "Ich möchte vom ", start_ms: 0, end_ms: 400 });
      examplePeer.events.emit({ type: "session.delegation.created", offset_ms: 500, delegation: { id: "example-delegation", target: "client" } });
      examplePeer.events.emit({ type: "session.input_transcript.delta", delta: "19. bis 23. Oktober Urlaub nehmen.", start_ms: 400, end_ms: 1500 });
      examplePeer.events.emit({ type: "session.delegation.created", offset_ms: 500, delegation: { id: "example-delegation", target: "client" } });
    });
    await f.page.waitForFunction(() => !document.getElementById("voiceAssistantConfirm").disabled);
    const state = await f.page.evaluate(() => ({ messages: exampleCalls.filter(call => call.url.endsWith("/messages")), sent: examplePeer.events.sent, label: exampleChannelLabel, writes: exampleWrites }));
    assert.equal(state.messages.length, 1); assert.match(state.messages[0].body.text, /19\. bis 23\. Oktober/); assert.equal(state.writes, 0); assert.equal(state.label, "oai-events");
    assert(state.sent.some(event => event.type === "session.commentary.append" && event.delegation_id === "example-delegation")); assert(!state.sent.some(event => event.type === "session.start"));
    assert(state.sent.filter(event => event.type === "session.commentary.append").every(event => Buffer.byteLength(event.content, "utf8") <= 400));
    await f.page.evaluate(() => examplePeer.events.emit({ type: "session.input_transcript.delta", delta: "Ja", start_ms: 2000, end_ms: 2200 }));
    assert.equal(await f.page.locator("#voiceAssistantConfirm").isDisabled(), true); assert.equal(await f.page.evaluate(() => exampleWrites), 0);
    await f.page.locator("#voiceAssistantEnd").click(); assert(await f.page.evaluate(() => exampleMediaStops > 0));
    await f.page.evaluate(() => examplePeer.events.emit({ type: "session.closed" })); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test("microphone denial permits text; cancellation before getUserMedia resolves releases late tracks", { skip: !enabled }, async () => {
  const f = await setup(); try {
    await f.page.evaluate(() => { exampleMediaDenied = true; }); await f.page.locator("#voiceAssistantMic").click();
    await f.page.waitForFunction(() => document.getElementById("voiceAssistantStatus").textContent.includes("nicht erlaubt"));
    assert.equal(await f.page.locator("#voiceAssistantSend").isDisabled(), false);
    await f.page.evaluate(() => { exampleMediaDenied = false; exampleHoldMedia = true; }); await f.page.locator("#voiceAssistantMic").click();
    await f.page.waitForFunction(() => Boolean(window.exampleReleaseMedia)); await f.page.locator("#voiceAssistantEnd").click();
    await f.page.evaluate(() => exampleReleaseMedia()); await f.page.waitForFunction(() => exampleMediaStops > 0);
    assert.equal(await f.page.evaluate(() => exampleCalls.filter(call => call.body?.sdp).length), 0); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test("discard is a GP operation that needs no AI call", { skip: !enabled }, async () => {
  const f = await setup(); try {
    await prepare(f.page); const before = await f.page.evaluate(() => exampleCalls.filter(call => call.url.endsWith("/messages")).length);
    await f.page.locator("#voiceAssistantDiscard").click(); await f.page.waitForFunction(() => document.getElementById("voiceAssistantDraft").classList.contains("hidden"));
    assert.equal(await f.page.evaluate(() => exampleCalls.filter(call => call.url.endsWith("/messages")).length), before); assert.equal(await f.page.evaluate(() => exampleWrites), 0);
  } finally { await f.close(); }
});
