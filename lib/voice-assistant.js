"use strict";

const crypto = require("node:crypto");
const { resolvePeriod, monday, addDays } = require("./voice-assistant-dates");
const { INTENT_SCHEMA } = require("./voice-assistant-openai");
const ADMIN_ROLES = new Set(["admin", "it_admin", "developer"]);
const DRAFT_TTL_MS = 10 * 60000;

function assistantError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}
function requirePermission(actor, permission) {
  if (!actor.permissions?.includes(permission)) throw assistantError(403, "Für diese eigenen Daten oder diesen Antrag fehlt die Berechtigung.", "PORTAL_PERMISSION_DENIED");
}
function owner(actor) { return JSON.stringify([actor.id, actor.employeeNumber]); }
function fingerprint(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function dayText(date) { return new Intl.DateTimeFormat("de-AT", { timeZone: "Europe/Vienna", dateStyle: "long" }).format(new Date(date + "T12:00:00Z")); }
function amount(value) { return new Intl.NumberFormat("de-AT", { maximumFractionDigits: 2 }).format(value); }
function intentPermission(intent) {
  if (intent.action === "schedule") return ["own_schedule:read"];
  if (["balances", "requests"].includes(intent.action)) return [
    ...(intent.kind !== "time_off" ? ["own_vacation:read"] : []),
    ...(intent.kind !== "vacation" ? ["own_time:read"] : []),
  ];
  if (intent.action === "draft") return intent.kind === "vacation"
    ? ["own_vacation:request", "own_vacation:read"] : ["own_time:write", "own_time:read"];
  return [];
}

function validateIntent(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)
    || Object.keys(intent).some(key => !INTENT_SCHEMA.required.includes(key))
    || INTENT_SCHEMA.required.some(key => typeof intent[key] !== "string")
    || !INTENT_SCHEMA.properties.action.enum.includes(intent.action)
    || !INTENT_SCHEMA.properties.kind.enum.includes(intent.kind)
    || intent.dateText.length > 240 || intent.question.length > 400
    || [intent.startTime, intent.endTime].some(time => time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
    || (intent.action === "draft" && intent.kind === "both")) {
    throw assistantError(422, "Die Sprache konnte nicht eindeutig verstanden werden. Bitte formuliere die Frage oder den Zeitraum erneut.", "ASSISTANT_INTENT_INVALID");
  }
  return intent;
}

// This module has no database, staff records, approval logic or schedule writer.
// All reads, eligibility checks and submissions are supplied by existing GP services.
function createVoiceAssistant({ config, provider, today, authorize, balances, schedule, requests,
  preview, submit, audit = async () => {}, now = () => Date.now() }) {
  const conversations = new Map(), starts = new Map();
  function allowed(actor) {
    const settings = config();
    if (!actor || actor.sessionKind === "organization" || actor.isEmployee === false || !actor.employeeNumber) return false;
    return settings.enabled && (!settings.adminOnly || ADMIN_ROLES.has(actor.role));
  }
  async function actorFor(request) {
    const actor = await authorize(request);
    if (!allowed(actor)) throw assistantError(403, "Der GP-Assistent ist deaktiviert oder nur für den Administrator-Testbetrieb freigegeben.", "ASSISTANT_DISABLED");
    if (actor.mustChangePassword) throw assistantError(428, "Bitte zuerst das persönliche Startpasswort ändern.", "PORTAL_PASSWORD_CHANGE_REQUIRED");
    return actor;
  }
  function sweep() {
    const timestamp = now();
    for (const [id, conversation] of conversations) if ((conversation.closed || conversation.expiresAt <= timestamp) && !conversation.busy) conversations.delete(id);
    for (const [key, item] of starts) if (item.since + 3600000 <= timestamp) starts.delete(key);
  }
  function find(id, actor) {
    sweep();
    const conversation = conversations.get(id);
    if (!conversation || conversation.owner !== owner(actor) || conversation.closed) throw assistantError(404, "Dieses Gespräch ist beendet oder gehört nicht zu deiner Anmeldung. Bitte neu starten.", "ASSISTANT_CONVERSATION_NOT_FOUND");
    return conversation;
  }
  function publicDraft(draft) {
    return draft ? { id: draft.id, kind: draft.kind, ...draft.parameters, ...draft.preview,
      assumptions: draft.assumptions, confirmationToken: draft.token, expiresAt: new Date(draft.expiresAt).toISOString(),
      state: draft.result ? "submitted" : "draft" } : null;
  }
  function draftSummary(draft) {
    const p = draft.parameters, facts = draft.preview;
    const quantity = draft.kind === "vacation" && Number.isFinite(facts.days) ? `, ${amount(facts.days)} Urlaubstage nach GP-Regeln`
      : Number.isFinite(facts.minutes) ? `, voraussichtlich ${amount(facts.minutes / 60)} Stunden` : ", Stunden werden im bestehenden Freigabeprozess geprüft";
    return `${draft.kind === "vacation" ? "Urlaubsentwurf" : "ZA-Entwurf"}: ${dayText(p.dateFrom)} bis ${dayText(p.dateTo)}${p.allDay ? ", ganztägig" : `, ${p.startTime} bis ${p.endTime} Uhr`}${quantity}. ${facts.check.reason || ""} ${(facts.warnings || []).join(" ")} ${draft.assumptions.join(" ")} Noch nicht eingereicht. ${facts.check.submissionAllowed ? "Bitte prüfe die Vorschau und bestätige mit „Antrag verbindlich absenden“." : "Dieser Entwurf kann nach den GP-Regeln derzeit nicht eingereicht werden."}`;
  }
  async function newDraft(conversation, actor, intent) {
    const period = resolvePeriod(intent.dateText, { today: today() });
    const allDay = intent.kind === "vacation" || (!intent.startTime && !intent.endTime);
    if (!allDay && (!intent.startTime || !intent.endTime || intent.endTime <= intent.startTime || period.dateFrom !== period.dateTo)) {
      throw assistantError(422, "Bitte für einen stundenweisen ZA genau einen Tag sowie Beginn und Ende nennen.", "ASSISTANT_TIMES_UNCLEAR");
    }
    const parameters = { dateFrom: period.dateFrom, dateTo: period.dateTo, allDay,
      ...(allDay ? {} : { startTime: intent.startTime, endTime: intent.endTime }), approvalType: "local" };
    const facts = await preview(actor, intent.kind, parameters);
    const draft = { id: crypto.randomUUID(), kind: intent.kind, parameters, assumptions: period.assumptions,
      preview: facts, fingerprint: fingerprint(facts), token: crypto.randomBytes(32).toString("base64url"),
      expiresAt: now() + DRAFT_TTL_MS, result: null, submitting: false };
    conversation.draft = draft;
    await audit(actor, "assistant.draft.prepare", draft.id, { kind: draft.kind, dateFrom: parameters.dateFrom, dateTo: parameters.dateTo });
    return { text: draftSummary(draft), draft: publicDraft(draft) };
  }
  const help = "Im GP findest du deinen eigenen Dienstplan unter „Mein Dienstplan“, Urlaub und ZA unter „Anträge“ und den Verlauf bei deinen Anträgen. Ich kann Salden und Dienstplan abfragen sowie einen Urlaubs- oder ZA-Entwurf vorbereiten. Verbindlich eingereicht wird erst mit „Antrag verbindlich absenden“ nach Prüfung der Vorschau. Die zuständige Leitung genehmigt weiterhin im GP.";

  return {
    async status(request) {
      const actor = await authorize(request), settings = config();
      return { enabled: allowed(actor) && !actor.mustChangePassword, configured: Boolean(settings.apiKey),
        adminOnly: settings.adminOnly, model: "gpt-live-1", timeZone: "Europe/Vienna", maxSessionSeconds: settings.maxSessionSeconds };
    },
    async start(request, { sdp } = {}) {
      const actor = await actorFor(request), settings = config();
      if (!settings.apiKey) throw assistantError(503, "Der serverseitige OpenAI-API-Schlüssel fehlt.", "ASSISTANT_KEY_MISSING");
      sweep();
      const key = owner(actor), recent = starts.get(key) || { since: now(), count: 0 };
      if (recent.count >= 12) throw assistantError(429, "Zu viele Gesprächsstarts. Bitte später erneut versuchen.", "ASSISTANT_START_LIMIT");
      for (const [id, c] of conversations) if (c.owner === key && !c.busy) conversations.delete(id);
      if (conversations.size >= settings.maxConversations) throw assistantError(429, "Der GP-Assistent ist derzeit ausgelastet.", "ASSISTANT_SESSION_LIMIT");
      starts.set(key, { ...recent, count: recent.count + 1 });
      const conversation = { id: crypto.randomUUID(), owner: key, expiresAt: now() + (settings.maxSessionSeconds + 120) * 1000,
        history: [], operations: new Map(), draft: null, busy: false, closed: false, live: null, count: 0, window: now() };
      conversations.set(conversation.id, conversation);
      try {
        if (sdp !== undefined) {
          if (typeof sdp !== "string" || !sdp.startsWith("v=0") || sdp.length > 65536) throw assistantError(400, "Das Mikrofon konnte keine gültige WebRTC-Verbindung vorbereiten.", "ASSISTANT_SDP_INVALID");
          conversation.busy = true;
          conversation.live = await provider.createLive(sdp);
          const current = await actorFor(request);
          if (owner(current) !== key || conversation.closed) throw assistantError(403, "Die Anmeldung hat sich geändert. Bitte erneut starten.", "ASSISTANT_ACTOR_CHANGED");
        }
        await audit(actor, "assistant.conversation.start", conversation.id, { transport: sdp ? "webrtc" : "text" });
        return { conversationId: conversation.id, ...(conversation.live || {}), maxSessionSeconds: settings.maxSessionSeconds };
      } catch (error) { conversations.delete(conversation.id); throw error; }
      finally { conversation.busy = false; }
    },
    async message(request, id, { text, operationId }) {
      const actor = await actorFor(request), c = find(id, actor);
      if (typeof text !== "string" || !text.trim() || text.length > 1600 || !/^[a-z0-9-]{16,64}$/i.test(operationId || "")) throw assistantError(400, "Bitte eine kurze Frage eingeben.", "ASSISTANT_MESSAGE_INVALID");
      if (c.operations.has(operationId)) {
        const cached = c.operations.get(operationId);
        cached.permissions.forEach(permission => requirePermission(actor, permission));
        return cached.result;
      }
      if (c.busy) throw assistantError(409, "Die vorige Frage wird noch verarbeitet.", "ASSISTANT_BUSY");
      if (now() - c.window >= 60000) { c.window = now(); c.count = 0; }
      if (++c.count > 20 || c.operations.size >= 80) throw assistantError(429, "Bitte kurz warten oder ein neues Gespräch starten.", "ASSISTANT_MESSAGE_LIMIT");
      c.busy = true;
      try {
        // Any new utterance invalidates the previous confirmation capability,
        // including a correction that cannot yet be resolved or an API failure.
        if (c.draft && !c.draft.result) c.draft.token = "";
        const intent = validateIntent(await provider.interpret({ text: text.trim(), history: c.history, draft: c.draft ? { kind: c.draft.kind, ...c.draft.parameters } : null, today: today() }));
        const current = await actorFor(request);
        if (owner(current) !== c.owner || c.closed) throw assistantError(403, "Das Gespräch gehört nicht mehr zur aktuellen Anmeldung.", "ASSISTANT_ACTOR_CHANGED");
        intentPermission(intent).forEach(permission => requirePermission(current, permission));
        let result;
        if (intent.action === "draft") {
          // Dates must originate in employee speech/text, never model invention.
          const userTexts = [text, ...c.history.filter(item => item.role === "user").map(item => item.text)];
          if (!intent.dateText || !userTexts.some(value => value.toLowerCase().includes(intent.dateText.toLowerCase()))) throw assistantError(422, "Bitte Datum oder Zeitraum noch einmal ausdrücklich nennen.", "ASSISTANT_DATE_UNCLEAR");
          result = await newDraft(c, current, intent);
        } else if (intent.action === "balances") {
          const data = await balances(current, intent.kind, Number(today().slice(0, 4)));
          const parts = [];
          if (intent.kind !== "time_off") parts.push(data.vacation ? `Nach aktueller Urlaubsplanung sind ${amount(data.vacation.remainingDays)} Urlaubstage für ${data.vacation.year} verfügbar.` : "Es ist noch kein Urlaubskonto für dieses Jahr hinterlegt.");
          if (intent.kind !== "vacation") parts.push(data.timeOff ? `Der letzte hinterlegte ZA-Saldo beträgt ${amount(data.timeOff.minutes / 60)} Stunden, Stand der Woche ab ${dayText(data.timeOff.weekStart)}. Das ist ein importierter Stand und kein laufend aktualisiertes Zeitkonto.` : "Es ist kein bestätigter ZA-Saldo hinterlegt; eine Wochendifferenz ist kein ZA-Saldo.");
          result = { text: parts.join(" "), data };
          await audit(current, "assistant.balances.read", c.id, { kind: intent.kind });
        } else if (intent.action === "schedule") {
          const period = resolvePeriod(intent.dateText || "diese Woche", { today: today(), mode: "schedule" });
          const first = monday(period.dateFrom), last = monday(period.dateTo);
          if (last !== first) throw assistantError(422, "Bitte den eigenen Dienstplan für jeweils eine Woche abfragen.", "ASSISTANT_SCHEDULE_RANGE");
          const data = await schedule(current, first, addDays(first, 6));
          result = { text: data.shifts.length ? data.shifts.map(item => `${dayText(item.date)}: ${item.startTime} bis ${item.endTime} Uhr${item.location ? `, ${item.location}` : ""}`).join(". ") : `Für die Woche ab ${dayText(first)} sind keine eigenen Dienste eingetragen.`, data };
          if (data.options.length) result.text += ". Eingetragene eigene Abwesenheiten: " + data.options.map(item => `${item.kind} ${dayText(item.dateFrom)} bis ${dayText(item.dateTo)}`).join("; ");
          await audit(current, "assistant.schedule.read", c.id, { weekStart: first });
        } else if (intent.action === "requests") {
          const data = await requests(current, intent.kind);
          result = { text: data.length ? data.slice(0, 12).map(item => `${item.kind === "vacation" ? "Urlaub" : "ZA"} ${dayText(item.dateFrom)} bis ${dayText(item.dateTo)}: ${item.statusLabel}`).join(". ") : "Es sind keine eigenen Anträge im sichtbaren Verlauf vorhanden.", data };
          await audit(current, "assistant.requests.read", c.id, { kind: intent.kind });
        } else if (intent.action === "cancel") {
          c.draft = null;
          result = { text: "Der Assistentenentwurf wurde verworfen. Bereits eingereichte Anträge bleiben im bestehenden GP-Antragsverlauf.", draft: null };
        } else result = { text: intent.action === "help" ? help : "Bitte nenne deine Frage zu eigenen Salden, Dienstplan oder Anträgen und für einen neuen Antrag Art und Zeitraum. Fremde Personaldaten sind hier nicht verfügbar." };
        // Read-only follow-ups or a spoken acknowledgement can keep the draft
        // visible. They still require a newly validated preview and a new button
        // confirmation; the interpretation model never receives a submit tool.
        if (c.draft && !c.draft.result && now() < c.draft.expiresAt
          && ["help", "balances", "schedule", "requests"].includes(intent.action)) {
          intentPermission({ action: "draft", kind: c.draft.kind }).forEach(permission => requirePermission(current, permission));
          const facts = await preview(current, c.draft.kind, c.draft.parameters);
          c.draft.preview = facts; c.draft.fingerprint = fingerprint(facts);
          c.draft.token = crypto.randomBytes(32).toString("base64url");
          result.draft = publicDraft(c.draft);
        }
        const finalActor = await actorFor(request);
        if (owner(finalActor) !== c.owner || c.closed) throw assistantError(403, "Die Anmeldung hat sich geändert.", "ASSISTANT_ACTOR_CHANGED");
        intentPermission(intent).forEach(permission => requirePermission(finalActor, permission));
        const draftPermissions = result.draft ? intentPermission({ action: "draft", kind: result.draft.kind }) : [];
        draftPermissions.forEach(permission => requirePermission(finalActor, permission));
        c.history.push({ role: "user", text: text.trim() }, { role: "assistant", text: result.text.slice(0, 1200) });
        c.history = c.history.slice(-12);
        // No transcript, recording, free-text reason or model reasoning is audited.
        c.operations.set(operationId, { result, permissions: [...new Set([...intentPermission(intent), ...draftPermissions])] });
        return result;
      } finally { c.busy = false; }
    },
    async confirm(request, id, { draftId, confirmationToken, confirmation }) {
      const actor = await actorFor(request), c = find(id, actor), d = c.draft;
      if (!d || d.id !== draftId || !confirmationToken || confirmationToken !== d.token || confirmation !== "submit") throw assistantError(409, "Der aktuelle Entwurf muss ausdrücklich über die Bestätigungsschaltfläche bestätigt werden.", "ASSISTANT_CONFIRMATION_REQUIRED");
      intentPermission({ action: "draft", kind: d.kind }).forEach(permission => requirePermission(actor, permission));
      if (d.result) return d.result;
      if (now() >= d.expiresAt) throw assistantError(409, "Der Entwurf ist abgelaufen. Bitte erneut vorbereiten.", "ASSISTANT_DRAFT_EXPIRED");
      if (c.busy || d.submitting) throw assistantError(409, "Der Antrag wird bereits verarbeitet.", "ASSISTANT_BUSY");
      c.busy = d.submitting = true;
      try {
        const facts = await preview(actor, d.kind, d.parameters);
        const current = await actorFor(request);
        if (owner(current) !== c.owner || c.closed) throw assistantError(403, "Die Anmeldung hat sich geändert.", "ASSISTANT_ACTOR_CHANGED");
        intentPermission({ action: "draft", kind: d.kind }).forEach(permission => requirePermission(current, permission));
        if (fingerprint(facts) !== d.fingerprint) {
          d.preview = facts; d.fingerprint = fingerprint(facts); d.token = crypto.randomBytes(32).toString("base64url");
          const error = assistantError(409, "Saldo, Dienstplan oder Vorprüfung haben sich geändert. Bitte die neue Vorschau erneut prüfen und bestätigen.", "ASSISTANT_PREVIEW_CHANGED");
          error.draft = publicDraft(d); throw error;
        }
        if (!facts.check.submissionAllowed) throw assistantError(409, facts.check.reason, facts.check.code || "ASSISTANT_REQUEST_BLOCKED");
        // These existing GP methods revalidate eligibility and own-subject access
        // and write decisions, reviewer notifications and audits transactionally.
        const submitted = await submit(current, d.kind, d.parameters);
        d.result = { text: `Der ${d.kind === "vacation" ? "Urlaubsantrag" : "ZA-Antrag"} für ${dayText(d.parameters.dateFrom)} bis ${dayText(d.parameters.dateTo)} wurde eingereicht und wartet auf die bestehende GP-Freigabe.`, request: { id: submitted.id, status: submitted.status, kind: d.kind }, draft: null };
        c.history.push({ role: "assistant", text: d.result.text });
        return d.result;
      } finally { c.busy = d.submitting = false; }
    },
    async currentDraft(request, id) {
      const actor = await actorFor(request), c = find(id, actor);
      if (c.draft) intentPermission({ action: "draft", kind: c.draft.kind }).forEach(permission => requirePermission(actor, permission));
      return { draft: c.draft?.result ? null : publicDraft(c.draft) };
    },
    async discardDraft(request, id) {
      const actor = await actorFor(request), c = find(id, actor);
      if (c.busy) throw assistantError(409, "Die vorige Aktion wird noch verarbeitet.", "ASSISTANT_BUSY");
      c.draft = null;
    },
    async close(request, id) {
      // Closing remains possible after an administrator switches the feature off.
      const actor = await authorize(request), c = conversations.get(id);
      if (!c || c.owner !== owner(actor)) return;
      c.closed = true; c.history = []; c.operations.clear(); c.draft = null;
      if (!c.busy) conversations.delete(id);
      await audit(actor, "assistant.conversation.end", id, {});
    },
  };
}

module.exports = { createVoiceAssistant, validateIntent, requirePermission, assistantError };
