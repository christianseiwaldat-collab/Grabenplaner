"use strict";
// Explicitly opt-in: makes paid OpenAI requests, with synthetic people only.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { parseEnv } = require("node:util");
assert.equal(process.env.GP_VOICE_LIVE_TEST, "1", "Set GP_VOICE_LIVE_TEST=1 to authorize the paid synthetic integration test");
const scenario = process.env.GP_VOICE_TEST_SCENARIO || "balances";
assert(["balances", "schedule", "vacation", "time_off"].includes(scenario));
const audio = path.resolve(process.env.GP_VOICE_TEST_AUDIO || ""); assert(fs.statSync(audio).isFile(), "A synthetic spoken WAV file is required");
let key = process.env.GRABENPLANER_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
if (!key && process.env.GP_VOICE_TEST_KEY_FILE) {
  const values = parseEnv(fs.readFileSync(process.env.GP_VOICE_TEST_KEY_FILE, "utf8")); key = values.GRABENPLANER_OPENAI_API_KEY || values.OPENAI_API_KEY;
}
assert(key, "Provide a server-side key or an authorized local key-file path");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-live-verification-"));
Object.assign(process.env, { DB_PATH: path.join(directory, "test.db"), BACKUP_DIR: path.join(directory, "backups"), GRABENPLANER_DATA_DIR: path.join(directory, "data"),
  GRABENPLANER_HOST: "127.0.0.1", GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1", GRABENPLANER_TEST_TODAY: "2031-04-01",
  NODE_ENV: "test", TZ: "Europe/Vienna", DB_PROVIDER: "sqlite", DATABASE_URL: "", GRABENPLANER_VOICE_ASSISTANT_ENABLED: "1",
  GRABENPLANER_VOICE_ASSISTANT_ADMIN_ONLY: "1", GRABENPLANER_VOICE_MAX_SECONDS: "90", GRABENPLANER_OPENAI_API_KEY: key });
key = undefined;
const provider = [], originalFetch = global.fetch;
global.fetch = async (url, options) => {
  const response = await originalFetch(url, options);
  if (String(url).startsWith("https://api.openai.com/")) {
    const item = { route: new URL(url).pathname, status: response.status }; provider.push(item);
    // Only diagnostic field names/codes; no credentials, SDP or provider bodies.
    if (!response.ok) { const error = await response.clone().json().catch(() => ({})); item.code = error.error?.code; item.param = error.error?.param; }
  }
  return response;
};
const { app, db, releaseInstanceLockForTests } = require("../server");
const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
const A = "live-example-A", B = "live-example-B", LOCATION = "live-example-branch";
const token = crypto.randomBytes(24).toString("hex"), csrf = crypto.randomBytes(24).toString("hex");
let server, browser, page, origin;
const receipt = { scenario, synthetic: true, verifiedAt: new Date().toISOString(), provider, passed: false };
async function api(route, options = {}) {
  const r = await originalFetch(origin + route, { ...options, headers: { Cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, "X-CSRF-Token": csrf, "Content-Type": "application/json" } });
  const data = r.status === 204 ? null : await r.json(); assert(r.ok, JSON.stringify({ route, status: r.status, code: data?.code, error: data?.error })); return data;
}
(async () => {
  try {
    db.prepare("INSERT INTO cost_centers(id,code,name,type,cost_center_type_id,active) VALUES(?,?,'BEISPIEL Sprachtest','branch','branch',1)").run(LOCATION, LOCATION);
    const days = JSON.stringify(Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map(day => [day, { open: true, start: "09:00", end: "18:00", minStaff: 0, minFrom: "09:00", minTo: "18:00", lunchEnabled: false }])));
    db.prepare("INSERT INTO locations(id,name,cost_center_id,min_staff,day_settings_json,active) VALUES(?,'BEISPIEL Sprachtest',?,0,?,1)").run(LOCATION, LOCATION, days);
    for (const id of [A, B]) {
      db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,cost_center_id,position_id,active) VALUES(?,?,?,?,?,'verkaufsmitarbeiter',1)").run(id, "BEISPIEL " + id, id, LOCATION, LOCATION);
      db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,role_locked,active,must_change_password,password_changed_at) VALUES(?,'test','admin',1,1,0,CURRENT_TIMESTAMP)").run(id);
    }
    db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES(?,?,?,'2099-01-01T00:00:00Z')").run(crypto.randomUUID(), A, crypto.createHash("sha256").update(token).digest("hex"));
    db.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time) VALUES(?,?,'2031-04-04','09:00','17:00')").run(A, LOCATION);
    db.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time) VALUES(?,?,'2031-04-11','09:00','17:00')").run(A, LOCATION);
    db.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time) VALUES(?,?,'2031-04-04','10:00','14:00')").run(B, LOCATION);
    db.prepare("INSERT INTO xoffi_time_imports(id,location_id,week_start,week_end,source_sha256,ocr_engine_version,imported_by) VALUES('live-balance',?,'2031-03-24','2031-03-30',?,'test',?)").run(LOCATION, "a".repeat(64), A);
    db.prepare("INSERT INTO xoffi_time_employee_rows(import_id,employee_number,source_name,closing_balance_minutes) VALUES('live-balance',?,'BEISPIEL',720)").run(A);
    await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); }); origin = `http://127.0.0.1:${server.address().port}`;
    await api("/api/vacation-entitlements", { method: "PUT", body: JSON.stringify({ year: 2031, entries: [{ employeeNumber: A, days: 25 }, { employeeNumber: B, days: 7 }] }) });
    browser = await chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}),
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${audio}%noloop`, "--autoplay-policy=no-user-gesture-required"] });
    const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 960 } });
    await context.addCookies([{ name: "grabenplaner_session", value: token, url: origin }, { name: "grabenplaner_csrf", value: csrf, url: origin }]);
    page = await context.newPage();
    await page.addInitScript(() => {
      window.liveProbe = { events: [], sent: [], peers: [], outputText: "", commentaryOffset: null };
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        constructor(...args) { super(...args); liveProbe.peers.push(this); }
        createDataChannel(...args) {
          const channel = super.createDataChannel(...args), send = channel.send.bind(channel);
          channel.addEventListener("message", e => { try { const data = JSON.parse(e.data); liveProbe.events.push({ type: data.type, ...(data.type === "error" ? { code: data.error?.code } : {}) }); if (data.type === "session.output_transcript.delta") liveProbe.outputText += data.delta; } catch {} });
          channel.send = value => { try { const event = JSON.parse(value); liveProbe.sent.push(event.type); if (event.type === "session.commentary.append" && liveProbe.commentaryOffset === null) liveProbe.commentaryOffset = liveProbe.outputText.length; } catch {} return send(value); }; return channel;
        }
      };
    });
    const results = [];
    page.on("response", async response => {
      if (/\/assistant\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname)) {
        results.push({ status: response.status(), data: await response.json().catch(() => ({})) });
      }
    });
    await page.goto(origin + "/portal.html");
    await page.locator("#voiceAssistantLaunch:not(.hidden)").waitFor({ timeout: 20000 }); await page.locator("#voiceAssistantLaunch").click();
    await page.locator("#voiceAssistantMic").click();
    await page.waitForFunction(() => liveProbe.events.some(e => e.type === "session.started"), null, { timeout: 35000 });
    const deadline = Date.now() + 45000;
    while (!results.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    assert(results.length, "No actual microphone delegation reached the GP backend");
    const result = results.find(r => r.status === 200 && (scenario === "vacation" || scenario === "time_off" ? r.data.draft : r.data.data));
    assert(result, "The spoken request did not produce the expected GP result: " + JSON.stringify(results));
    assert(!JSON.stringify(result.data).includes(B), "A foreign person leaked into the own-data response");
    if (scenario === "balances") assert.equal(result.data.data.vacation.remainingDays, 25);
    if (scenario === "schedule") {
      const existing = await api("/api/portal/v1/me/schedule?week=2031-04-07");
      assert.equal(result.data.data.shifts[0].date, existing.shifts[0].shift_date); assert.equal(result.data.data.shifts[0].startTime, existing.shifts[0].start_time);
    }
    if (["vacation", "time_off"].includes(scenario)) {
      assert.equal(result.data.draft.kind, scenario); assert.equal(result.data.draft.dateFrom, scenario === "vacation" ? "2031-04-14" : "2031-04-04");
      const table = scenario === "vacation" ? "vacation_requests" : "time_off_requests";
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE employee_number=?`).get(A).n, 0, "An unconfirmed draft was submitted");
      await page.waitForFunction(kind => new RegExp(kind === "vacation" ? "14\\.|vierzehnt" : "4\\.|viert", "i").test(liveProbe.outputText.slice(liveProbe.commentaryOffset || 0)), scenario);
      receipt.draftDatesSpoken = true;
      await page.locator("#voiceAssistantConfirm:not([disabled])").waitFor();
      await page.locator("#voiceAssistantConfirm").click();
      await page.waitForFunction(() => document.getElementById("voiceAssistantStatus").textContent.includes("Antrag eingereicht"));
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE employee_number=?`).get(A).n, 1);
      const storedStatus = db.prepare(`SELECT status FROM ${table} WHERE employee_number=?`).get(A).status;
      assert(["pending", "pending_local"].includes(storedStatus), "The request must remain in the existing approval workflow");
      receipt.confirmedRequest = { pending: true, status: storedStatus, unconfirmedCount: 0, confirmedCount: 1 };
    }
    await page.waitForFunction(() => liveProbe.commentaryOffset !== null && liveProbe.outputText.length > liveProbe.commentaryOffset + 15);
    if (scenario === "balances") await page.waitForFunction(() => /25|fünfundzwanzig/i.test(liveProbe.outputText.slice(liveProbe.commentaryOffset)));
    receipt.gpAnswerSpoken = true;
    receipt.media = await page.evaluate(async () => {
      const pc = liveProbe.peers.at(-1), values = [...(await pc.getStats()).values()];
      return { state: pc.connectionState, incomingAudioBytes: values.filter(v => v.type === "inbound-rtp" && v.kind === "audio").reduce((n, v) => n + (v.bytesReceived || 0), 0),
        outgoingAudioBytes: values.filter(v => v.type === "outbound-rtp" && v.kind === "audio").reduce((n, v) => n + (v.bytesSent || 0), 0), events: [...new Set(liveProbe.events.map(e => e.type))] };
    });
    assert(receipt.media.incomingAudioBytes > 0 && receipt.media.outgoingAudioBytes > 0); assert.equal(receipt.media.state, "connected");
    receipt.passed = true;
  } catch (error) {
    receipt.error = error.message;
    if (page) receipt.browser = await page.evaluate(() => ({ path: location.pathname, title: document.title, status: document.getElementById("voiceAssistantStatus")?.textContent,
      events: window.liveProbe?.events, syntheticOutput: window.liveProbe?.outputText, commentaryOffset: window.liveProbe?.commentaryOffset })).catch(() => null);
    process.exitCode = 1;
  } finally {
    if (page) {
      await page.locator("#voiceAssistantEnd").click({ timeout: 2000 }).catch(() => {});
      await page.waitForFunction(() => liveProbe.peers.every(p => p.connectionState === "closed"), null, { timeout: 6000 }).catch(() => {});
      receipt.microphoneStopped = await page.evaluate(() => liveProbe.peers.every(p => p.getSenders().every(s => !s.track || s.track.readyState === "ended"))).catch(() => false);
    }
    if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve));
    db.close(); releaseInstanceLockForTests(); global.fetch = originalFetch; delete process.env.GRABENPLANER_OPENAI_API_KEY;
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert(path.basename(directory).startsWith("gp-live-verification-"));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    const out = path.resolve(process.env.GP_ASSISTANT_LIVE_RECEIPTS || "output/planning-assistant-live"); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `live-${scenario}.json`), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2));
  }
})();
