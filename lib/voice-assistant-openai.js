"use strict";
const pilotAccess = require("./assistant-pilot-access");

const LIVE_MODEL = "gpt-live-1";
const LIVE_INSTRUCTIONS = `Du bist der deutschsprachige KI-Assistent im Grabenplaner-Mitarbeiterportal. Sprich ruhig und kurz. Sage zu Beginn, dass du eine KI bist.
Backchannel policy: Kurze zurückhaltende Hörsignale.
Interruption policy: Bei Unterbrechungen zuhören und die Antwort beenden.
Delegation policy: Delegiere persönliche Urlaubssalden, ZA-Salden, den eigenen Dienstplan, eigene Anträge, Antragsentwürfe, Korrekturen und GP-Bedienfragen immer an das GP-Backend. Erfinde keine Daten, Stunden, Tage oder erfolgreiche Aktionen. Es gibt nur Zugriff auf eigene Daten. Genehmigungen und Dienstplanänderungen sind ausgeschlossen. Ein Entwurf ist noch kein Antrag. Lies den bestätigungspflichtigen Zeitraum samt Tagen/Stunden und Warnungen vor. Zum verbindlichen Absenden muss der Mitarbeiter den angezeigten Antrag mit der Schaltfläche „Antrag verbindlich absenden“ bestätigen. Auch ein gesprochenes Ja reicht dafür nicht. Anträge bleiben im bestehenden Freigabeprozess. Verweise bei unklarer Sprache auf Rückfrage oder Texteingabe.`;

const INTENT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["balances", "schedule", "requests", "draft", "cancel", "help", "clarify"] },
    kind: { type: "string", enum: ["vacation", "time_off", "both"] },
    dateText: { type: "string" }, startTime: { type: "string" }, endTime: { type: "string" },
    question: { type: "string" },
  }, required: ["action", "kind", "dateText", "startTime", "endTime", "question"],
};

function configFromEnv(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name]);
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
  };
  return {
    enabled: env.GRABENPLANER_VOICE_ASSISTANT_ENABLED === "1",
    adminOnly: env.GRABENPLANER_VOICE_ASSISTANT_ADMIN_ONLY !== "0",
    pilotEmployeeNumbers: pilotAccess.fromEnv(env.GRABENPLANER_VOICE_ASSISTANT_PILOT_EMPLOYEES),
    apiKey: String(env.GRABENPLANER_OPENAI_API_KEY || env.OPENAI_API_KEY || "").trim(),
    backendModel: String(env.GRABENPLANER_VOICE_BACKEND_MODEL || "gpt-6-luna").trim(),
    maxSessionSeconds: integer("GRABENPLANER_VOICE_MAX_SECONDS", 600, 60, 1800),
    maxConversations: integer("GRABENPLANER_VOICE_MAX_CONVERSATIONS", 8, 1, 50),
  };
}

function providerError(code = "ASSISTANT_PROVIDER_UNAVAILABLE") {
  return Object.assign(new Error("OpenAI ist vorübergehend nicht erreichbar oder für dieses Projekt nicht freigeschaltet. Bitte später erneut versuchen."), { status: 503, code });
}

function createOpenAiVoiceProvider({ config = () => configFromEnv(), fetchImpl = (...args) => fetch(...args) } = {}) {
  async function post(route, body) {
    const settings = config();
    if (!settings.apiKey) throw Object.assign(new Error("Der serverseitige OpenAI-API-Schlüssel fehlt."), { status: 503, code: "ASSISTANT_KEY_MISSING" });
    try {
      const response = await fetchImpl("https://api.openai.com/v1/" + route, {
        method: "POST", headers: { Authorization: "Bearer " + settings.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw providerError(response.status === 429 ? "ASSISTANT_PROVIDER_LIMIT" : undefined);
      return await response.json();
    } catch (error) {
      if (error.code?.startsWith("ASSISTANT_")) throw error;
      // Never retain provider errors, bodies, transcripts or Authorization headers.
      throw providerError();
    }
  }
  return {
    async createLive(sdp) {
      const result = await post("live/sessions", {
        session: { model: LIVE_MODEL, instructions: LIVE_INSTRUCTIONS, store: false,
          delegation: { type: "client" }, audio: { output: { voice: "marin" } },
          client: { data_channel: { allowed_client_events: ["session.close", "session.commentary.append", "session.thinking.append"], allowed_server_events: "all" } } },
        transport: { type: "webrtc", sdp },
      });
      if (typeof result.session?.id !== "string" || result.transport?.type !== "webrtc" || typeof result.transport.sdp !== "string") throw providerError();
      return { session: { id: result.session.id }, transport: { type: "webrtc", sdp: result.transport.sdp } };
    },
    async interpret({ text, history, draft, today }) {
      const result = await post("responses", {
        model: config().backendModel, store: false, reasoning: { effort: "none" }, max_output_tokens: 600,
        instructions: `Klassifiziere ausschließlich GP-Portalabsichten. Keine Tools, SQL, Genehmigungen, Änderungen oder Absendeaktionen. Fremde Personaldaten sind verboten: clarify. Nur Urlaub/ZA als draft. Anträge erstellen bedeutet immer Entwurf. Eine Bestätigung bedeutet help und Verweis auf die Bestätigungsschaltfläche. dateText ist ein wörtliches, zusammenhängendes Datum/Zeitintervall aus der letzten Benutzernachricht oder der Benutzerhistorie, ohne Uhrzeiten, niemals ein erfundenes ISO-Datum. Beispiele: nächsten Freitag; nächste Woche; 19. bis 23. Oktober; 19.10.2026 bis 23.10.2026. Korrekturen ersetzen den bisherigen Entwurf und erfordern neue Bestätigung. Bei fehlendem Datum clarify. Wenn die Frage allgemein zum eigenen Dienstplan ist, dateText=\"diese Woche\". startTime/endTime nur ausdrücklich genannte Uhrzeiten im Format HH:mm, sonst leer; ein ganzer ZA-Tag hat beide leer. question nur kurze Rückfrage, keine Behauptungen über GP-Daten. Heute ${today}, Zeitzone Europe/Vienna. kind=both nur bei Salden/Antragsabfragen. GP-Bedienfragen -> help; sonst clarify.`,
        input: JSON.stringify({ history: history.filter(item => item.role === "user").slice(-4), draft: draft ? { kind: draft.kind, dateFrom: draft.dateFrom, dateTo: draft.dateTo } : null, message: text }),
        text: { format: { type: "json_schema", name: "gp_portal_intent", strict: true, schema: INTENT_SCHEMA } },
      });
      const output = result.output?.flatMap(item => item.content || []).filter(item => item.type === "output_text").map(item => item.text).join("");
      try { return JSON.parse(output); } catch { throw providerError("ASSISTANT_RESPONSE_INVALID"); }
    },
  };
}

module.exports = { LIVE_MODEL, LIVE_INSTRUCTIONS, INTENT_SCHEMA, configFromEnv, createOpenAiVoiceProvider };
