"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const preferences = require("../lib/planning-assistant-preferences");
const { createPlanningAssistantReader } = require("../lib/planning-assistant-gp");

test("existing installations keep enabled automatic checks and informational findings by default", () => {
  assert.deepEqual(preferences.read({}), { enabled: true, autoCheck: true, showInformational: true });
  assert.deepEqual(preferences.values({ unrelated: "keep" }), preferences.DEFAULT_SETTINGS);
});

test("every planning preference requires an explicit boolean and unknown fields are rejected", () => {
  const valid = { enabled: false, autoCheck: false, showInformational: true };
  assert.deepEqual(preferences.validate(valid), {
    planning_assistant_enabled: "0", planning_assistant_auto_check: "0", planning_assistant_show_informational: "1",
  });
  for (const value of [null, [], {}, { ...valid, enabled: "false" }, { ...valid, autoCheck: 0 },
    { ...valid, showInformational: undefined }, { ...valid, foreign: true }]) {
    assert.throws(() => preferences.validate(value), { code: "PLANNING_ASSISTANT_PREFERENCES_INVALID", status: 400 });
  }
});

test("disabled or corrupted enablement never starts the planning data reader", async () => {
  for (const enabled of ["0", "false", "broken", "", null]) {
    const read = createPlanningAssistantReader({ settings: () => ({ planning_assistant_enabled: enabled }),
      getSchedule: () => assert.fail("disabled assistant must not read planning facts") });
    await assert.rejects(read("2031-04-07", {}, {}), { status: 409, code: "PLANNING_ASSISTANT_DISABLED" });
  }
});

test("manual-check and information-display preferences never disable server assessments", () => {
  assert.doesNotThrow(() => preferences.assertEnabled({ planning_assistant_auto_check: "0", planning_assistant_show_informational: "0" }));
});
