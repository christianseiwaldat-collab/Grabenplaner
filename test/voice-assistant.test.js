"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createVoiceAssistant } = require("../lib/voice-assistant");
const { configFromEnv, createOpenAiVoiceProvider } = require("../lib/voice-assistant-openai");

function fixture() {
  const value = { actor: { id: "session-A", employeeNumber: "BEISPIEL-A", isEmployee: true, role: "admin",
    permissions: ["own_vacation:read", "own_vacation:request", "own_time:read", "own_time:write", "own_schedule:read"] },
    settings: { enabled: true, adminOnly: true, apiKey: "synthetic-key", maxSessionSeconds: 600, maxConversations: 8 },
    intent: { action: "draft", kind: "vacation", dateText: "19. bis 23. Oktober", startTime: "", endTime: "", question: "" },
    facts: { check: { submissionAllowed: true, trafficLight: "green", reason: "BEISPIEL Prüfung" }, days: 5, warnings: [] },
    writes: [], audits: [], timestamp: Date.parse("2026-10-12T12:00:00Z") };
  value.service = createVoiceAssistant({ config: () => value.settings, today: () => "2026-10-12", now: () => value.timestamp,
    authorize: async () => value.actor, provider: { createLive: async () => ({}), interpret: async () => { if (value.failure) throw value.failure; return value.intent; } },
    balances: async actor => ({ vacation: { year: 2026, remainingDays: 20 }, owner: actor.employeeNumber }),
    schedule: async actor => ({ shifts: [], options: [], owner: actor.employeeNumber }), requests: async () => [],
    preview: async () => { if (value.hold) await value.hold; return structuredClone(value.facts); },
    submit: async (actor, kind, parameters) => { value.writes.push({ actor: actor.employeeNumber, kind, parameters }); return { id: 1, status: "pending" }; },
    audit: async (actor, action, id, details) => value.audits.push({ action, id, details }),
  });
  value.start = async () => { value.id = (await value.service.start({})).conversationId; return value.id; };
  value.message = (text = "Ich möchte vom 19. bis 23. Oktober Urlaub nehmen.", operationId = crypto.randomUUID()) => value.service.message({}, value.id, { text, operationId });
  value.confirm = draft => value.service.confirm({}, value.id, { draftId: draft.id, confirmationToken: draft.confirmationToken, confirmation: "submit" });
  return value;
}

test("default is disabled and admin-only; no key in configuration responses", async () => {
  const defaults = configFromEnv({}); assert.equal(defaults.enabled, false); assert.equal(defaults.adminOnly, true); assert.equal(defaults.backendModel, "gpt-6-luna");
  const f = fixture(); assert(!JSON.stringify(await f.service.status({})).includes(f.settings.apiKey));
  f.settings.enabled = false; await assert.rejects(f.start(), { code: "ASSISTANT_DISABLED" });
});
test("pilot role, personal account, password and per-tool permissions all fail closed", async () => {
  const f = fixture(); f.actor.role = "employee"; await assert.rejects(f.start(), { code: "ASSISTANT_DISABLED" });
  f.actor.role = "admin"; f.actor.isEmployee = false; await assert.rejects(f.start(), { code: "ASSISTANT_DISABLED" });
  f.actor.isEmployee = true; f.actor.mustChangePassword = true; await assert.rejects(f.start(), { code: "PORTAL_PASSWORD_CHANGE_REQUIRED" });
  f.actor.mustChangePassword = false; await f.start(); f.actor.permissions = [];
  await assert.rejects(f.message(), { code: "PORTAL_PERMISSION_DENIED" }); assert.equal(f.writes.length, 0);
});
test("personal pilot list applies to status, active conversations and draft confirmation after revocation", async () => {
  const f = fixture(); f.settings.pilotEmployeeNumbers = [f.actor.employeeNumber];
  await f.start(); const draft = (await f.message()).draft;
  f.settings.pilotEmployeeNumbers = ["BEISPIEL-B"];
  assert.equal((await f.service.status({})).enabled, false);
  await assert.rejects(f.message(), { code: "ASSISTANT_DISABLED" });
  await assert.rejects(f.confirm(draft), { code: "ASSISTANT_DISABLED" });
  await assert.rejects(f.start(), { code: "ASSISTANT_DISABLED" });
  assert.equal(f.writes.length, 0);
  f.settings.pilotEmployeeNumbers = [f.actor.employeeNumber];
  f.settings.environmentPilotEmployeeNumbers = ["BEISPIEL-B"];
  await assert.rejects(f.start(), { code: "ASSISTANT_DISABLED" });
  f.settings.environmentPilotEmployeeNumbers = null;
  await assert.rejects(f.start(), { code: "ASSISTANT_DISABLED" });
});

test("a conversation and confirmation cannot be used by another employee or another login", async () => {
  const f = fixture(); await f.start(); const draft = (await f.message()).draft;
  for (const change of [{ employeeNumber: "BEISPIEL-B" }, { id: "session-B" }]) {
    const saved = f.actor; f.actor = { ...saved, ...change };
    await assert.rejects(f.confirm(draft), { code: "ASSISTANT_CONVERSATION_NOT_FOUND" }); f.actor = saved;
  }
  assert.equal(f.writes.length, 0);
});
test("draft and a spoken yes never call submit; an explicit button confirmation calls the existing submit once", async () => {
  const f = fixture(); await f.start(); const draft = (await f.message()).draft;
  assert.equal(draft.state, "draft"); assert.equal(f.writes.length, 0);
  await assert.rejects(f.service.confirm({}, f.id, { draftId: draft.id, confirmationToken: draft.confirmationToken, confirmation: "yes" }), { code: "ASSISTANT_CONFIRMATION_REQUIRED" });
  const first = await f.confirm(draft), second = await f.confirm(draft);
  assert.deepEqual(first, second); assert.equal(f.writes.length, 1); assert.equal(first.request.status, "pending");
  assert.equal(f.writes[0].actor, "BEISPIEL-A"); assert.equal(f.writes[0].parameters.dateFrom, "2026-10-19");
});
test("model cannot invoke a submit or approval tool, inject a subject, or invent a date", async () => {
  const f = fixture(); await f.start();
  f.intent.action = "confirm"; await assert.rejects(f.message(), { code: "ASSISTANT_INTENT_INVALID" });
  f.intent.action = "draft"; f.intent.employeeNumber = "BEISPIEL-B"; await assert.rejects(f.message(), { code: "ASSISTANT_INTENT_INVALID" }); delete f.intent.employeeNumber;
  f.intent.dateText = "2026-11-01"; await assert.rejects(f.message(), { code: "ASSISTANT_DATE_UNCLEAR" });
  assert.equal(f.writes.length, 0);
});
test("a spoken yes refreshes the preview and still requires the employee's separate button confirmation", async () => {
  const f = fixture(); await f.start(); const original = (await f.message()).draft;
  f.intent.action = "help";
  const acknowledgement = await f.message("Ja, bitte absenden.");
  assert.equal(f.writes.length, 0); assert(acknowledgement.draft.confirmationToken);
  assert.notEqual(acknowledgement.draft.confirmationToken, original.confirmationToken);
  await assert.rejects(f.confirm(original), { code: "ASSISTANT_CONFIRMATION_REQUIRED" });
  await f.confirm(acknowledgement.draft); assert.equal(f.writes.length, 1);
});
test("a correction, including an unparseable correction or API failure, invalidates the old draft token", async () => {
  const f = fixture(); await f.start(); const draft = (await f.message()).draft;
  f.failure = Object.assign(new Error("BEISPIEL API failure"), { status: 503 });
  await assert.rejects(f.message("Donnerstag statt Freitag"));
  await assert.rejects(f.confirm(draft), { code: "ASSISTANT_CONFIRMATION_REQUIRED" }); assert.equal(f.writes.length, 0);
});
test("expiry, revoked rights and current GP eligibility are checked before submit", async () => {
  const f = fixture(); await f.start(); let draft = (await f.message()).draft;
  f.timestamp += 600001; await assert.rejects(f.confirm(draft), { code: "ASSISTANT_DRAFT_EXPIRED" });
  draft = (await f.message()).draft; f.actor.permissions = ["own_vacation:read"];
  await assert.rejects(f.confirm(draft), { code: "PORTAL_PERMISSION_DENIED" });
  f.actor.permissions.push("own_vacation:request"); f.facts.check.submissionAllowed = false;
  let next; try { await f.confirm(draft); } catch (error) { assert.equal(error.code, "ASSISTANT_PREVIEW_CHANGED"); next = error.draft; }
  assert(next); await assert.rejects(f.confirm(next)); assert.equal(f.writes.length, 0);
});
test("changed balances and hours require the new preview's own confirmation", async () => {
  const f = fixture(); await f.start(); const original = (await f.message()).draft;
  f.facts.days = 4;
  let updated; try { await f.confirm(original); } catch (error) { assert.equal(error.code, "ASSISTANT_PREVIEW_CHANGED"); updated = error.draft; }
  assert.equal(f.writes.length, 0); assert.equal(updated.days, 4);
  await assert.rejects(f.confirm(original), { code: "ASSISTANT_CONFIRMATION_REQUIRED" }); await f.confirm(updated); assert.equal(f.writes.length, 1);
});
test("parallel confirmations and replayed message operations cannot duplicate a request", async () => {
  const f = fixture(); await f.start(); const operation = crypto.randomUUID();
  const result = await f.message(undefined, operation); assert.deepEqual(await f.message(undefined, operation), result);
  let release; f.hold = new Promise(resolve => { release = resolve; }); const first = f.confirm(result.draft);
  await assert.rejects(f.confirm(result.draft), { code: "ASSISTANT_BUSY" }); release(); await first; assert.equal(f.writes.length, 1);
});
test("closed, disabled and changed actors cannot receive late results or submit", async () => {
  const f = fixture(); await f.start(); const draft = (await f.message()).draft;
  f.settings.enabled = false; await assert.rejects(f.confirm(draft), { code: "ASSISTANT_DISABLED" });
  await f.service.close({}, f.id); f.settings.enabled = true; await assert.rejects(f.confirm(draft), { code: "ASSISTANT_CONVERSATION_NOT_FOUND" });
  assert.equal(f.writes.length, 0); assert(!JSON.stringify(f.audits).includes("Ich möchte"));
});
test("revoked read permissions also block an idempotent cached response", async () => {
  const f = fixture(); await f.start(); f.intent.action = "balances";
  const operationId = crypto.randomUUID(); await f.message("Wie viele Urlaubstage habe ich?", operationId);
  f.actor.permissions = [];
  await assert.rejects(f.message("Wie viele Urlaubstage habe ich?", operationId), { code: "PORTAL_PERMISSION_DENIED" });
});
test("OpenAI transport uses official Live JSON, client delegation, no storage and server key only", async () => {
  const calls = [], config = () => ({ apiKey: "SYNTHETIC-SECRET", backendModel: "gpt-6-luna" });
  const provider = createOpenAiVoiceProvider({ config, fetchImpl: async (url, request) => {
    calls.push({ url, request, body: JSON.parse(request.body) });
    return { ok: true, json: async () => url.endsWith("live/sessions") ? { session: { id: "live-test" }, transport: { type: "webrtc", sdp: "answer" }, secret: "NEVER-FORWARD" }
      : { output: [{ content: [{ type: "output_text", text: JSON.stringify({ action: "help" }) }] }] } };
  } });
  const live = await provider.createLive("v=0\r\n");
  assert.equal(calls[0].url, "https://api.openai.com/v1/live/sessions"); assert.equal(calls[0].body.session.model, "gpt-live-1");
  assert.equal(calls[0].body.session.store, false); assert.equal(calls[0].body.session.delegation.type, "client");
  assert(!JSON.stringify(live).includes("SECRET")); assert(!JSON.stringify(live).includes("NEVER-FORWARD"));
  await provider.interpret({ text: "Hilfe", history: [{ role: "assistant", text: "private GP saldo" }], draft: null, today: "2026-10-12" });
  assert.equal(calls[1].body.store, false); assert(!calls[1].body.input.includes("private GP saldo")); assert(!calls[1].body.tools);
});
test("provider failure is sanitized; no retries or accidental plaintext key exposure", async () => {
  let calls = 0;
  const provider = createOpenAiVoiceProvider({ config: () => ({ apiKey: "SYNTHETIC-SECRET" }), fetchImpl: async () => { calls++; throw new Error("SYNTHETIC-SECRET personal speech"); } });
  await assert.rejects(provider.createLive("offer"), error => error.code === "ASSISTANT_PROVIDER_UNAVAILABLE" && !error.message.includes("SYNTHETIC")); assert.equal(calls, 1);
});
