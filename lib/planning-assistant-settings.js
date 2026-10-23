"use strict";
const crypto = require("node:crypto");
const DEFAULTS = Object.freeze({ weeklyToleranceMinutes: 0, requiredPositions: [], keyPersonNumbers: [] });
const fail = message => { throw Object.assign(new Error(message), { status: 400, code: "PLANNING_ASSISTANT_SETTINGS_INVALID" }); };
function validateSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["weeklyToleranceMinutes", "requiredPositions", "keyPersonNumbers"].includes(key))) fail("Ungültige Prüfeinstellungen.");
  if (!Number.isInteger(value.weeklyToleranceMinutes) || value.weeklyToleranceMinutes < 0 || value.weeklyToleranceMinutes > 600) fail("Die Sollstunden-Toleranz muss zwischen 0 und 600 Minuten liegen.");
  if (!Array.isArray(value.requiredPositions) || value.requiredPositions.length > 20 || !Array.isArray(value.keyPersonNumbers) || value.keyPersonNumbers.length > 50) fail("Zu viele oder ungültige Besetzungsvorgaben.");
  const requiredPositions = value.requiredPositions.map(item => {
    if (!item || Object.keys(item).some(key => !["positionId", "count"].includes(key))
      || typeof item.positionId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.positionId)
      || !Number.isInteger(item.count) || item.count < 1 || item.count > 99) fail("Bitte eine vorhandene Position und eine Mindestanzahl von 1 bis 99 wählen.");
    return { positionId: item.positionId, count: item.count };
  }).sort((a, b) => a.positionId.localeCompare(b.positionId));
  const keyPersonNumbers = value.keyPersonNumbers.map(id => {
    if (typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 80 || /[\u0000-\u001f]/.test(id)) fail("Ungültige Schlüsselperson.");
    return id;
  }).sort();
  if (new Set(keyPersonNumbers).size !== keyPersonNumbers.length || new Set(requiredPositions.map(item => item.positionId)).size !== requiredPositions.length) fail("Besetzungsvorgaben dürfen nicht doppelt vorkommen.");
  return { weeklyToleranceMinutes: value.weeklyToleranceMinutes, requiredPositions, keyPersonNumbers };
}
function key(context) { return "planning_assistant:" + JSON.stringify([String(context.locationId), Number(context.departmentId || 0)]); }
function read(settings, context) {
  const raw = String(settings[key(context)] || "");
  let configuration, valid = true;
  try { configuration = raw ? validateSettings(JSON.parse(raw)) : structuredClone(DEFAULTS); }
  catch { configuration = structuredClone(DEFAULTS); valid = false; }
  return { configuration, valid, revision: crypto.createHash("sha256").update(raw).digest("hex") };
}
module.exports = { DEFAULTS, validateSettings, key, read };
