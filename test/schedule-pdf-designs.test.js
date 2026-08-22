"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_SCHEDULE_PDF_DESIGN_IDS,
  MAX_SCHEDULE_PDF_DESIGN_NAME_LENGTH,
  MAX_ACTIVE_SCHEDULE_PDF_DESIGNS,
  MIN_SCHEDULE_PDF_DESIGN_NAME_LENGTH,
  SchedulePdfDesignValidationError,
  normalizeSchedulePdfDesignIds,
  normalizeSchedulePdfDesignNames,
  resolveSchedulePdfDesign,
  schedulePdfDesignCatalogPayload,
} = require("../lib/schedule-pdf-designs");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("Dienstplan-PDF-Designkatalog liefert die freigegebenen Designs 1 und 2", () => {
  assert.deepEqual(DEFAULT_SCHEDULE_PDF_DESIGN_IDS, ["timeline"]);
  assert.equal(MAX_ACTIVE_SCHEDULE_PDF_DESIGNS, 5);
  assert.equal(MIN_SCHEDULE_PDF_DESIGN_NAME_LENGTH, 3);
  assert.equal(MAX_SCHEDULE_PDF_DESIGN_NAME_LENGTH, 60);
  assert.deepEqual(schedulePdfDesignCatalogPayload().map(({ id }) => id), ["timeline", "matrix"]);
  assert.equal(schedulePdfDesignCatalogPayload()[0].defaultLabel, "Design 1 · Zeitachse");
});

test("gespeicherte Rangfolge wird eindeutig normalisiert und fällt sicher auf Design 1 zurück", () => {
  assert.deepEqual(normalizeSchedulePdfDesignIds('["matrix","timeline"]'), ["matrix", "timeline"]);
  assert.deepEqual(normalizeSchedulePdfDesignIds('["matrix","matrix","unbekannt"]'), ["matrix"]);
  assert.deepEqual(normalizeSchedulePdfDesignIds("kein-json"), ["timeline"]);
  assert.deepEqual(normalizeSchedulePdfDesignIds([]), ["timeline"]);
});

test("Einstellungsänderungen erfordern ein bis fünf eindeutige, freigegebene Designs", () => {
  for (const invalid of [[], ["unbekannt"], ["timeline", "timeline"]]) {
    assert.throws(
      () => normalizeSchedulePdfDesignIds(invalid, { strict: true }),
      SchedulePdfDesignValidationError,
    );
  }
  assert.deepEqual(
    normalizeSchedulePdfDesignIds(["matrix", "timeline"], { strict: true }),
    ["matrix", "timeline"],
  );
});

test("Export akzeptiert nur ein aktiviertes Design und verwendet sonst Rang 1", () => {
  assert.equal(resolveSchedulePdfDesign(["matrix", "timeline"], ""), "matrix");
  assert.equal(resolveSchedulePdfDesign(["matrix", "timeline"], "timeline"), "timeline");
  assert.throws(
    () => resolveSchedulePdfDesign(["matrix"], "timeline"),
    SchedulePdfDesignValidationError,
  );
});

test("bearbeitbare Designnamen werden normalisiert, eindeutig geprüft und getrennt von IDs geführt", () => {
  assert.deepEqual(normalizeSchedulePdfDesignNames({
    timeline: "  Klarer   Wochenplan  ",
    matrix: "Kompakte Matrix",
  }, { strict: true }), {
    timeline: "Klarer Wochenplan",
    matrix: "Kompakte Matrix",
  });
  assert.deepEqual(normalizeSchedulePdfDesignNames('{"timeline":"Klarer Wochenplan"}'), {
    timeline: "Klarer Wochenplan",
  });
  assert.equal(
    schedulePdfDesignCatalogPayload({ timeline: "Klarer Wochenplan" })[0].label,
    "Klarer Wochenplan",
  );
  assert.equal(
    schedulePdfDesignCatalogPayload({ timeline: "Klarer Wochenplan" })[0].id,
    "timeline",
  );
});

test("ungültige, mehrzeilige, unbekannte oder doppelte Designnamen werden abgewiesen", () => {
  for (const invalid of [
    { timeline: "ab" },
    { timeline: "Zeile 1\nZeile 2" },
    { unbekannt: "Unbekanntes Design" },
    { timeline: "Gleicher Name", matrix: "gleicher name" },
  ]) {
    assert.throws(
      () => normalizeSchedulePdfDesignNames(invalid, { strict: true }),
      (error) => error instanceof SchedulePdfDesignValidationError
        && error.code === "INVALID_SCHEDULE_PDF_DESIGN_NAMES",
    );
  }
  assert.deepEqual(normalizeSchedulePdfDesignNames({ timeline: "ab" }), {});
});

test("Einstellungen und Dienstplanung verdrahten Rangfolge, Direkt-Export und Auswahlmenü", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");
  const server = read("server.js");
  assert.match(html, /id="schedulePdfDesignSettings"/);
  assert.match(html, /class="settings-accordion schedule-pdf-design-settings"/);
  assert.match(html, /class="settings-accordion-chevron" aria-hidden="true">›<\/span>/);
  assert.match(html, /id="schedulePdfDesignSettingsList"/);
  assert.match(html, /id="schedulePdfPreviewDesign"/);
  assert.match(html, /id="schedulePdfDesignMenu" role="menu"/);
  assert.match(app, /schedulePdfDesignIdsFromSettings\(\)\.length <= 1/);
  assert.match(app, /data-schedule-pdf-design-export/);
  assert.match(app, /schedulePdfDesignIds:\s*\[\.\.\.state\.schedulePdfDesignSelection\]/);
  assert.match(app, /data-schedule-pdf-design-name=/);
  assert.match(app, /data-reset-schedule-pdf-design-name=/);
  assert.match(app, /schedulePdfDesignNames,/);
  assert.match(server, /pdf_schedule_design_names:\s*JSON\.stringify\(schedulePdfDesignNames\)/);
  assert.match(server, /schedulePdfDesignForRequest\(schedule, request\.query\.design\)/);
  assert.match(server, /designId === "matrix"/);
  assert.match(server, /async function drawScheduleTimelinePdf/);
  assert.match(server, /function drawScheduleMatrixPdf/);
});

test("Developer-252-Testmodus ist persönlich, serverseitig begrenzt und auditierbar", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");
  const server = read("server.js");
  assert.match(html, /id="birthdayPresentationDeveloperPreviewSection"/);
  assert.match(html, /id="birthdayPresentationDeveloperPreviewDesign"/);
  assert.match(app, /developerPreview\.available !== true/);
  assert.match(app, /birthday-presentation-settings\/developer-preview/);
  assert.match(server, /PORTAL_BIRTHDAY_PREVIEW_EMPLOYEE_NUMBER = "252"/);
  assert.match(server, /portalBirthdayPresentationPreviewAvailable\(actor\)/);
  assert.match(server, /portal\.birthday-presentation\.developer-preview\.update/);
});
