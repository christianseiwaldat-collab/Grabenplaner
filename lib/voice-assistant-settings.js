"use strict";

const crypto = require("node:crypto");
const { configFromEnv, LIVE_MODEL } = require("./voice-assistant-openai");
const SETTINGS_KEY = "voice_assistants";
const fail = message => { throw Object.assign(new Error(message), { status: 400, code: "VOICE_SETTINGS_INVALID" }); };
function exact(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(value, key))) fail("Bitte vollständige, gültige Sprachassistenten-Einstellungen übermitteln.");
}
function validateSettings(value) {
  exact(value, ["enabled", "maxSessionSeconds", "maxConversations", "portal"]);
  exact(value.portal, ["enabled", "adminOnly"]);
  if ([value.enabled, value.portal.enabled, value.portal.adminOnly].some(flag => typeof flag !== "boolean")) fail("Die Freigaben müssen ausdrücklich gesetzt sein.");
  if (!Number.isInteger(value.maxSessionSeconds) || value.maxSessionSeconds < 60 || value.maxSessionSeconds > 1800) fail("Die Gesprächsdauer muss zwischen 60 und 1800 Sekunden liegen.");
  if (!Number.isInteger(value.maxConversations) || value.maxConversations < 1 || value.maxConversations > 50) fail("Bitte zwischen 1 und 50 gleichzeitige Gespräche erlauben.");
  return { enabled: value.enabled, maxSessionSeconds: value.maxSessionSeconds, maxConversations: value.maxConversations,
    portal: { enabled: value.portal.enabled, adminOnly: value.portal.adminOnly } };
}
function storedSettings(settings = {}, env = process.env) {
  const fallback = configFromEnv(env);
  if (Object.hasOwn(settings, SETTINGS_KEY)) {
    try { return validateSettings(JSON.parse(settings[SETTINGS_KEY])); }
    catch { return { enabled: false, maxSessionSeconds: 600, maxConversations: 8, portal: { enabled: false, adminOnly: true } }; }
  }
  return { enabled: fallback.enabled, maxSessionSeconds: fallback.maxSessionSeconds,
    maxConversations: fallback.maxConversations, portal: { enabled: true, adminOnly: fallback.adminOnly } };
}
function revision(settings = {}) {
  return crypto.createHash("sha256").update(String(settings[SETTINGS_KEY] ?? "")).digest("hex");
}
function runtimeConfig(settings = {}, env = process.env) {
  const base = configFromEnv(env), stored = storedSettings(settings, env);
  return { ...base, enabled: env.GRABENPLANER_VOICE_ASSISTANT_ENABLED !== "0" && stored.enabled && stored.portal.enabled,
    adminOnly: stored.portal.adminOnly, maxSessionSeconds: stored.maxSessionSeconds, maxConversations: stored.maxConversations };
}
function settingsPayload(settings = {}, env = process.env) {
  const runtime = runtimeConfig(settings, env);
  return { revision: revision(settings), settings: storedSettings(settings, env), runtime: {
    enabled: runtime.enabled, apiKeyConfigured: Boolean(runtime.apiKey), environmentDisabled: env.GRABENPLANER_VOICE_ASSISTANT_ENABLED === "0",
    liveModel: LIVE_MODEL, backendModel: runtime.backendModel, timeZone: "Europe/Vienna", audioStored: false,
  } };
}
module.exports = { SETTINGS_KEY, validateSettings, storedSettings, revision, runtimeConfig, settingsPayload };
