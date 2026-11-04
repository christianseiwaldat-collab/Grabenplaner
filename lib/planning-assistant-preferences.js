"use strict";

const KEYS = Object.freeze({
  enabled: "planning_assistant_enabled",
  autoCheck: "planning_assistant_auto_check",
  showInformational: "planning_assistant_show_informational",
});
const DEFAULT_SETTINGS = Object.freeze(Object.fromEntries(Object.values(KEYS).map(key => [key, "1"])));

function read(settings = {}) {
  return Object.fromEntries(Object.entries(KEYS).map(([name, key]) => [name,
    settings[key] === undefined || settings[key] === "1",
  ]));
}

function values(settings = {}) {
  const preferences = read(settings);
  return Object.fromEntries(Object.entries(KEYS).map(([name, key]) => [key, preferences[name] ? "1" : "0"]));
}

function validate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== Object.keys(KEYS).length
    || Object.keys(value).some(key => !Object.hasOwn(KEYS, key))
    || Object.keys(KEYS).some(key => typeof value[key] !== "boolean")) {
    throw Object.assign(new Error("Bitte alle Schalter des Planungsassistenten gültig übermitteln."), {
      status: 400, code: "PLANNING_ASSISTANT_PREFERENCES_INVALID",
    });
  }
  return Object.fromEntries(Object.entries(KEYS).map(([name, key]) => [key, value[name] ? "1" : "0"]));
}

function assertEnabled(settings) {
  if (!read(settings).enabled) {
    throw Object.assign(new Error("Der Planungsassistent ist in den Einstellungen deaktiviert."), {
      status: 409, code: "PLANNING_ASSISTANT_DISABLED",
    });
  }
}

module.exports = { KEYS, DEFAULT_SETTINGS, read, values, validate, assertEnabled };
