"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_PORTAL_GREETING_SETTINGS,
  resolvePortalGreeting,
  validatePortalGreetingSettings,
} = require("../lib/portal-greetings");

function assertPublicShape(result) {
  assert.deepEqual(Object.keys(result), ["id", "text", "kind", "validUntil", "enabled"]);
}

test("Portal-Begrüßung: Defaults werden normalisiert und ungültige Werte abgelehnt", () => {
  const defaults = validatePortalGreetingSettings();
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.vacationMinimumCalendarDays, 14);
  assert.equal(defaults.vacationReturnWorkdays, 3);
  assert.equal(defaults.sicknessReturnWorkdays, 2);
  assert.deepEqual(defaults.templates.morning, [...DEFAULT_PORTAL_GREETING_SETTINGS.templates.morning]);

  const normalized = validatePortalGreetingSettings({
    enabled: "false",
    vacationMinimumCalendarDays: "21",
    vacationReturnWorkdays: "2",
    sicknessReturnWorkdays: 1,
  });
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.vacationMinimumCalendarDays, 21);

  assert.throws(
    () => validatePortalGreetingSettings({ vacationMinimumCalendarDays: 0 }),
    { code: "PORTAL_GREETING_NUMBER_INVALID" },
  );
  assert.throws(
    () => validatePortalGreetingSettings({ templates: { morning: ["Hallo {diagnosis}"] } }),
    { code: "PORTAL_GREETING_TEMPLATE_PLACEHOLDER_INVALID" },
  );
});

test("Portal-Begrüßung: deaktivierter Zustand liefert ausschließlich einen neutralen Vertrag", () => {
  const result = resolvePortalGreeting({
    at: "2026-07-15T08:00:00+02:00",
    settings: { enabled: false },
    sickness: { active: true, diagnosis: "darf nicht erscheinen" },
  });
  assertPublicShape(result);
  assert.deepEqual(result, {
    id: "disabled",
    text: "",
    kind: "disabled",
    validUntil: null,
    enabled: false,
  });
});

test("Portal-Begrüßung: allgemeine Tagesgrüße wechseln deterministisch und sprechen persönlich an", () => {
  const settings = { enabled: true };
  const first = resolvePortalGreeting({ at: "2026-07-15T08:00:00+02:00", stableKey: "employee-7", name: "Chris", settings });
  const repeated = resolvePortalGreeting({ at: "2026-07-15T08:00:00+02:00", stableKey: "employee-7", name: "Chris", settings });
  const nextDay = resolvePortalGreeting({ at: "2026-07-16T08:00:00+02:00", stableKey: "employee-7", name: "Chris", settings });
  const daytime = resolvePortalGreeting({ at: "2026-07-15T13:00:00+02:00", stableKey: "employee-7", name: "Chris", settings });
  const evening = resolvePortalGreeting({ at: "2026-07-15T18:00:00+02:00", stableKey: "employee-7", name: "Chris", settings });

  assert.deepEqual(first, repeated);
  assert.notEqual(first.id, nextDay.id);
  assert.equal(first.kind, "general");
  assert.match(first.text, /Morgen/);
  assert.match(first.text, /Chris/);
  assert.equal(daytime.kind, "general");
  assert.equal(evening.kind, "general");
  assert.match(evening.text, /Abend|weiteren Arbeitstag/);
  for (const result of [first, nextDay, daytime, evening]) assertPublicShape(result);
});

test("Portal-Begrüßung: Urlaubsrückkehr greift ab 14 Kalendertagen nur im konfigurierten Arbeitsfenster", () => {
  const common = {
    stableKey: "employee-252",
    settings: { enabled: true },
    vacation: {
      startedOn: "2026-07-01",
      endedOn: "2026-07-14",
      returnWorkdays: ["2026-07-15", "2026-07-16", "2026-07-17", "2026-07-20"],
    },
  };
  const first = resolvePortalGreeting({ ...common, at: "2026-07-15" });
  const third = resolvePortalGreeting({ ...common, at: "2026-07-17" });
  const fourth = resolvePortalGreeting({ ...common, at: "2026-07-20" });
  assert.equal(first.kind, "welcome_back");
  assert.equal(third.kind, "welcome_back");
  assert.equal(first.validUntil, "2026-07-15");
  assert.equal(fourth.kind, "general");

  const tooShort = resolvePortalGreeting({
    at: "2026-07-15",
    settings: { enabled: true },
    vacation: {
      startedOn: "2026-07-02",
      endedOn: "2026-07-14",
      returnWorkdays: ["2026-07-15", "2026-07-16", "2026-07-17"],
    },
  });
  assert.equal(tooShort.kind, "general");
});

test("Portal-Begrüßung: aktiver Krankenstand erzeugt nur einen freundlichen allgemeinen Gruß", () => {
  const result = resolvePortalGreeting({
    at: "2026-07-15T09:00:00+02:00",
    stableKey: "employee-419",
    settings: { enabled: true },
    sickness: {
      active: true,
      diagnosis: "vertrauliche Diagnose",
      reason: "vertraulicher Grund",
      startedOn: "2026-07-14",
    },
  });
  assertPublicShape(result);
  assert.equal(result.kind, "encouragement");
  assert.equal(result.validUntil, "2026-07-15");
  assert.equal(JSON.stringify(result).includes("vertraulich"), false);
  assert.equal(Object.hasOwn(result, "diagnosis"), false);
  assert.equal(Object.hasOwn(result, "reason"), false);
});

test("Portal-Begrüßung: nach Genesung bleibt der Rückkehrgruß neutral und zeitlich begrenzt", () => {
  const sickness = {
    active: false,
    endedOn: "2026-07-14",
    returnWorkdays: ["2026-07-15", "2026-07-16", "2026-07-17"],
    diagnosis: "darf nicht erscheinen",
  };
  const settings = { enabled: true };
  const first = resolvePortalGreeting({ at: "2026-07-15", stableKey: "employee-430", sickness, settings });
  const second = resolvePortalGreeting({ at: "2026-07-16", stableKey: "employee-430", sickness, settings });
  const third = resolvePortalGreeting({ at: "2026-07-17", stableKey: "employee-430", sickness, settings });

  assert.equal(first.kind, "welcome_back");
  assert.equal(second.kind, "welcome_back");
  assert.equal(first.validUntil, "2026-07-15");
  assert.equal(third.kind, "general");
  assert.equal(/Diagnose|Krankenstand|krank/i.test(first.text), false);
  assert.equal(JSON.stringify(first).includes("darf nicht erscheinen"), false);
  assertPublicShape(first);
});

test("Portal-Begrüßung: Ereignis- und Arbeitstagsdaten werden streng validiert", () => {
  assert.throws(
    () => resolvePortalGreeting({
      at: "2026-07-15",
      settings: { enabled: true },
      vacation: {
        startedOn: "2026-07-01",
        endedOn: "2026-07-14",
        returnWorkdays: ["2026-07-14"],
      },
    }),
    { code: "PORTAL_GREETING_WORKDAYS_INVALID" },
  );
  assert.throws(
    () => resolvePortalGreeting({ at: "kein Datum", settings: { enabled: true } }),
    { code: "PORTAL_GREETING_TIMESTAMP_INVALID" },
  );
});
