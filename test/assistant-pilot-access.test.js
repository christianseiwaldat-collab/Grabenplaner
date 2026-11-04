"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const pilot = require("../lib/assistant-pilot-access");
const settings = require("../lib/voice-assistant-settings");

test("pilot lists preserve exact identities and invalid configuration never opens access", () => {
  const actor = { employeeNumber: "252", role: "developer", isEmployee: true };
  assert.deepEqual(pilot.fromEnv("252, 0252"), ["0252", "252"]);
  assert(pilot.allows(actor, ["252"]));
  assert(!pilot.allows(actor, ["0252"]));
  assert(!pilot.allows({ ...actor, sessionKind: "organization" }, ["252"]));
  assert(!pilot.allows(null, ["252"]));
  for (const value of [",", " ", "252,", "252,252", "252 *", "*"]) {
    const numbers = pilot.fromEnv(value); assert.equal(numbers, null); assert(!pilot.allows(actor, numbers));
  }
});

test("legacy settings migrate on read; invalid lists disable voice; stale writes cannot clear a restriction", () => {
  const legacy = { enabled: true, maxSessionSeconds: 600, maxConversations: 8, portal: { enabled: true, adminOnly: true } };
  const store = value => ({ voice_assistants: JSON.stringify(value) });
  assert.deepEqual(settings.storedSettings(store(legacy), {}).portal.pilotEmployeeNumbers, []);
  assert.throws(() => settings.validateSettings(legacy), { code: "VOICE_SETTINGS_INVALID" });
  const valid = { ...legacy, portal: { ...legacy.portal, pilotEmployeeNumbers: ["252"] } };
  assert.deepEqual(settings.runtimeConfig(store(valid), { GRABENPLANER_VOICE_ASSISTANT_PILOT_EMPLOYEES: "253" }).environmentPilotEmployeeNumbers, ["253"]);
  for (const bad of [null, "252", [252], ["252", "252"], [""], ["*"]]) {
    const value = { ...valid, portal: { ...valid.portal, pilotEmployeeNumbers: bad } };
    assert.throws(() => settings.validateSettings(value), { code: "VOICE_SETTINGS_INVALID" });
    assert.equal(settings.runtimeConfig(store(value), {}).enabled, false);
  }
  assert.equal(settings.runtimeConfig(store(valid), { GRABENPLANER_VOICE_ASSISTANT_PILOT_EMPLOYEES: "," }).enabled, false);
});
