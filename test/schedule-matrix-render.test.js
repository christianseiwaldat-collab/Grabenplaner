"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const { finished } = require("node:stream/promises");
const { syntheticSchedule, compactSixSchedule, compactTeamSchedule } = require("../test-support/render-schedule-matrix-preview");
const { drawMatrix } = require("../test-support/schedule-pdf-render-fixture");

async function render(schedule) {
  const chunks = [];
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } });
  const completion = finished(output);
  drawMatrix(schedule, output, new Date("2026-09-06T14:00:00Z"));
  await completion;
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({ data: Uint8Array.from(Buffer.concat(chunks)), disableWorker: true,
    isEvalSupported: false, useSystemFonts: true });
  const pdf = await loading.promise;
  try {
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.filter(item => item.str?.trim());
      for (const item of items) {
        assert.ok(item.transform[4] >= 0 && item.transform[4] + item.width <= viewport.width + 1,
          `Text exceeds horizontal page bounds: ${item.str}`);
        assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height, `Text exceeds vertical bounds: ${item.str}`);
      }
      pages.push({ text: items.map(item => item.str).join(" "), items, width: viewport.width, height: viewport.height });
      page.cleanup();
    }
    return pages;
  } finally { await loading.destroy(); }
}

test("echte Wochenmatrix enthält sechs Personen, Dienstbuttons und normale Bemerkungen auf einer Seite", async () => {
  const schedule = syntheticSchedule();
  const pages = await render(schedule);
  assert.equal(pages.length, 1, "Six employees plus ordinary notes should not need extra pages");
  const { text, items } = pages[0];
  for (const employee of schedule.employees) assert.ok(text.includes(employee.nickname));
  for (const value of ["FL", "Filialaufsicht", "HW", "Hardware", "FO", "Fotowelt", "A · Filiale Süd", "09:00-13:00", "14:00-18:00", "fix ZA; Behördengang", "Urlaubsabbau - verfügbar", "Bemerkungen", "Samstag: Offene Reservierungen"]) assert.ok(text.includes(value), value);
  assert.doesNotMatch(text, /Diagnose: vertraulich/);
  assert.ok(items.filter(item => item.str === "09:00-13:00").length >= 2, "local split shifts stay visible");
  const zaReasonItems = items.filter((item) => /fix ZA|Behördengang/u.test(item.str));
  assert.ok(zaReasonItems.length >= 1, "ZA reason remains visible");
  const reasonX = zaReasonItems[0].transform[4];
  const zaDetailItems = [
    ...items.filter((item) => item.str === "ganztägig" && Math.abs(item.transform[4] - reasonX) < 3),
    ...zaReasonItems,
  ];
  const distinctBaselines = [...new Set(zaDetailItems.map((item) => Number(item.transform[5].toFixed(2))))]
    .sort((left, right) => left - right);
  assert.ok(distinctBaselines.length >= 2, "ZA time and reason use distinct baselines");
  for (let index = 1; index < distinctBaselines.length; index += 1) {
    assert.ok(distinctBaselines[index] - distinctBaselines[index - 1] >= 6.5,
      "ZA time and wrapped reason do not overlap vertically");
  }
  assert.doesNotMatch(text, /\bBesetzung\b|Fortsetzung/);
  assert.match(text, /5MA, 1BS/);
  assert.equal(items.filter(item => item.str === "BS").length, 1);
  assert.equal(items.filter(item => item.str === "Berufsschule").length, 1);
  const heading = items.find(item => item.str === "Bemerkungen");
  const firstNote = items.find(item => item.str.startsWith("Montag: Warenübernahme"));
  assert.ok(heading.transform[5] > firstNote.transform[5], "Remarks heading is above the text field");
  assert.ok(Math.abs(firstNote.height - 10) < .01, "Ordinary notes retain their actual 10pt size");
  for (const paragraph of schedule.scheduleNote.note_text.split("\n\n"))
    assert.ok(text.replace(/\s+/g, " ").includes(paragraph), "Every ordinary paragraph remains complete on the first page");
});

test("72pt Matrixbemerkungen bleiben vollständig auf Fortsetzungsseiten ohne Skalierung", async () => {
  const schedule = syntheticSchedule(), lines = Array.from({ length: 22 }, (_, index) => `Zeile ${index + 1} vollständig`);
  schedule.scheduleNote = { note_text: ["GROSS ÄÖÜ", ...lines].join("\n"),
    note_html: '<b data-size="72">GROSS ÄÖÜ</b><br>' + lines.map(line => `<span data-size="24">${line}</span>`).join("<br>") };
  const pages = await render(schedule), text = pages.map(page => page.text).join(" ").replace(/\s+/g, " ");
  assert.ok(pages.length > 1);
  assert.ok(pages[0].items.some(item => item.str.includes("GROSS") && Math.abs(item.height - 72) < .01));
  for (const line of lines) assert.equal(text.split(line).length - 1, 1, line);
  assert.ok(pages.every(page => Math.round(page.width) === 842 && Math.round(page.height) === 595));
});

test("Feiertagskopf und normale Matrixbemerkungen behalten Mindestzeilen und vollständigen Text", async () => {
  const schedule = syntheticSchedule();
  schedule.globalDayBlocks = [{ block_date: schedule.weekStart, is_public_holiday: 1, holiday_name: "Prüf-Feiertag" }];
  const pages = await render(schedule), text = pages.map(page => page.text).join(" ").replace(/\s+/g, " ");
  assert.ok(pages[0].text.includes("Prüf-Feiertag"));
  for (const employee of schedule.employees) assert.ok(pages[0].text.includes(employee.nickname));
  for (const paragraph of schedule.scheduleNote.note_text.split("\n\n")) assert.ok(text.includes(paragraph));
});

test("sechs Personen mit großen Uhrzeiten und Teamsitzung passen ohne verkleinerte PDF-Seite", async () => {
  const schedule = compactSixSchedule();
  const pages = await render(schedule);
  assert.equal(pages.length,1);assert.equal(Math.round(pages[0].width),842);assert.equal(Math.round(pages[0].height),595);
  for(const employee of schedule.employees)assert.ok(pages[0].text.includes(employee.nickname));
  assert.ok(pages[0].text.includes('18:00-18:30'));assert.ok(pages[0].text.includes('Samstag: Übergabe'));
  assert.ok(pages[0].items.filter(item=>item.str==='09:00-18:00').every(item=>item.height>=11),'Time typography remains legible rather than scaling down the entire PDF');
});

test("sieben Personen mit 18pt-Zeiteinstellung und Teamsitzung passen auf eine lesbare A4-Seite", async () => {
  for (const note of ["", "Samstag: Übergabe der offenen Reservierungen."]) {
    const schedule = compactTeamSchedule({ timeFontSize: "18" });
    schedule.scheduleNote.note_text = note;
    const pages = await render(schedule);
    assert.equal(pages.length, 1);
    for (const employee of schedule.employees) assert.ok(pages[0].text.includes(employee.nickname));
    assert.equal(pages[0].items.filter(item => item.str === "09:00-18:00").length, 42);
    assert.equal(pages[0].items.filter(item => item.str === "TS · 18:00-18:30").length, 7);
    assert.ok(pages[0].items.filter(item => item.str === "09:00-18:00").every(item => item.height >= 11));
    if (note) assert.ok(pages[0].text.includes(note));
    assert.equal(Math.round(pages[0].width), 842); assert.equal(Math.round(pages[0].height), 595);
  }
});

test("sieben Personen einschließlich Teamsitzung, Teil-ZA und Außentermin bleiben vollständig auf einer Seite", async () => {
  const schedule = compactTeamSchedule({ mixedEntries: true });
  const pages = await render(schedule);
  assert.equal(pages.length, 1);
  const page = pages[0], text = page.text.replace(/\s+/g, " ");
  for (const employee of schedule.employees) assert.ok(text.includes(employee.nickname));
  for (const value of ["09:00-16:30", "16:30-18:00", "10:00-11:30", "11:30-18:00", "Außer-Haus-Termin", "Fototermin", "Musterfiliale", "Teamsitzung (TS)", "Samstag: Übergabe"])
    assert.ok(text.includes(value), value);
  assert.equal(page.items.filter(item => item.str === "TS · 18:00-18:30").length, 7);
  assert.ok(page.items.some(item => item.str === "ZA"));
  const heading = page.items.find(item => item.str === "Bemerkungen");
  const note = page.items.find(item => item.str.startsWith("Samstag: Übergabe"));
  assert.ok(heading.transform[5] > note.transform[5]);
  assert.ok(note.transform[5] > 39, "The complete note remains above the footer");
  assert.ok(Math.abs(note.height - 10) < .01, "Note text keeps its configured size");
});

test("bei sechs und sieben Personen wechselt die Teamsitzung nur bei Platzbedarf ins rechte Feld", async () => {
  for (const count of [6, 7]) {
    const regular = compactTeamSchedule();
    regular.employees = regular.employees.slice(0, count);
    const standardPages = await render(regular);
    assert.equal(standardPages.length, 1, `${count}: standard layout fits`);
    const standard = standardPages[0].items;
    const banner = standard.find(item => item.str.startsWith("Teamsitzung (TS) · 16.09."));
    const standardRemarks = standard.find(item => item.str === "Bemerkungen");
    assert.ok(banner && banner.transform[4] < 50 && banner.transform[5] > standardRemarks.transform[5]);

    const tight = compactTeamSchedule({ timeFontSize: "18", mixedEntries: count === 6 });
    tight.employees = tight.employees.slice(0, count);
    Object.assign(tight.shifts.find(shift => shift.employee_number === "903" && shift.shift_date === "2026-09-16"),
      { duty_code: "department", department_id: 1, department_name: "Hardware" });
    const pages = await render(tight);
    assert.equal(pages.length, 1, `${count}: side field saves a page`);
    const [page] = pages, items = page.items;
    for (const employee of tight.employees) assert.ok(page.text.includes(employee.nickname));
    const notesHeading = items.find(item => item.str === "Bemerkungen");
    const meetingHeading = items.find(item => item.str === "Teamsitzung (TS)");
    assert.ok(meetingHeading && meetingHeading.transform[4] > page.width * .55);
    assert.ok(Math.abs(notesHeading.transform[5] - meetingHeading.transform[5]) < .01);
    const summary = items.find(item => item.str.includes("16.09.") && item.str.includes("18:00-18:30"));
    assert.ok(summary && summary.transform[4] > meetingHeading.transform[4]);
    assert.ok(summary.transform[5] < meetingHeading.transform[5]);
    const hw = items.find(item => item.str === "HW");
    const participation = items.find(item => item.str === "TS · 18:00-18:30" && Math.abs(item.transform[4] - hw.transform[4]) < 5
      && item.transform[5] < hw.transform[5] && hw.transform[5] - item.transform[5] < 30);
    assert.ok(participation);
    assert.ok(hw.transform[5] - participation.transform[5] >= 13.4, "HW badge and TS text retain visible separation");
  }
});

test("lange Teamsitzungsnotizen fließen vollständig auf eigene Fortsetzungsseiten", async () => {
  const schedule = compactTeamSchedule();
  const notes = Array.from({ length: 30 }, (_, index) => `TOP${index + 1}: Vollständiger Tagesordnungspunkt mit Zusatzinformation.`);
  for (const option of schedule.weekOptions) option.note = notes.join(" ");
  const pages = await render(schedule), text = pages.map(page => page.text).join(" ").replace(/\s+/g, " ");
  assert.ok(pages.length > 1);
  assert.ok(text.includes("Teamsitzungen · Fortsetzung"));
  for (let index = 1; index <= 30; index++) assert.equal(text.split(`TOP${index}:`).length - 1, 1, `TOP ${index} remains complete and appears once`);
  assert.ok(pages[0].items.some(item => item.str === "Bemerkungen"));
});

test("Dienstbezeichnungen sind standardmäßig verborgen und lassen sich rechts neben dem Button einblenden", async () => {
  const [hidden] = await render(syntheticSchedule());
  const [shown] = await render(syntheticSchedule({ showDutyLabels: true }));
  for (const label of ["Filialaufsicht", "Hardware", "Fotowelt"]) {
    assert.equal(hidden.items.filter(item => item.str === label).length, 0);
    const text = shown.items.find(item => item.str === label);
    assert.ok(text, label);
    const code = { Filialaufsicht: "FL", Hardware: "HW", Fotowelt: "FO" }[label];
    assert.ok(shown.items.some(item => item.str === code && item.transform[4] < text.transform[4]
      && Math.abs(item.transform[5] - text.transform[5]) < 4), "Label sits beside its badge");
  }
  assert.ok(hidden.items.filter(item => item.str === "09:00-18:00").every(item => item.transform[0] >= 11));
  assert.equal(hidden.items.find(item => item.str === "Alex").transform[5], shown.items.find(item => item.str === "Alex").transform[5]);
});

test("mehrtägige Felder werden inhaltshoch mit K/S-Mindestmaß und wachsen bei mehr Text", async () => {
  const schedule = syntheticSchedule();
  const [short] = await render(schedule);
  const bs = short.items.find(item => item.str === "BS");
  const sickness = short.items.find(item => item.str === "K");
  const school = short.items.find(item => item.str === "S");
  // The renderer derives the code's cap size from the actual card height.
  assert.ok(bs.transform[0] >= Math.max(sickness.transform[0], school.transform[0]));
  assert.ok(bs.transform[0] < 14, "The short multi-day card no longer fills the employee row");
  schedule.weekOptions.find(option => option.id === "vocational").note = "Längerer Schulhinweis. ".repeat(45);
  const [long] = await render(schedule);
  assert.ok(long.items.find(item => item.str === "BS").transform[0] > bs.transform[0]);
  assert.ok(long.text.includes("Längerer Schulhinweis."));
});

test("geteilte Dienste und Filialwechsel passen ohne größere Mitarbeiterzeile und ohne großen A-Kasten", async () => {
  for (const sevenDays of [false, true]) {
    const schedule = syntheticSchedule({ sevenDays });
    const [{ items }] = await render(schedule);
    const ordinary = syntheticSchedule({ sevenDays });
    ordinary.shifts = ordinary.shifts.filter(shift => !(shift.employee_number === "901"
      && shift.shift_date === "2026-09-15" && shift.start_time === "14:00"));
    ordinary.staffAssignments = [];
    ordinary.pdfStaffAssignmentShifts = [];
    const [baseline] = await render(ordinary);
    for (const name of ["Alex", "Robin", "Dana", "Sam", "Kim", "Toni"]) {
      assert.equal(items.find(item => item.str === name).transform[5],
        baseline.items.find(item => item.str === name).transform[5], `${name}: unchanged row placement`);
    }
    assert.equal(items.filter(item => item.str === "A").length, 0, "No large A card for the partial branch assignment");
    const parts = items.filter(item => item.str === "14:00-18:00");
    assert.equal(parts.length, 2);
    for (const part of parts) {
      const badge = items.find(item => item.str === "FO" && item.transform[4] < part.transform[4]
        && part.transform[4] - item.transform[4] < 25 && Math.abs(item.transform[5] - part.transform[5]) < 4);
      assert.ok(badge, "Time and duty badge share one compact row");
      assert.ok(badge.transform[4] + badge.width + 2 < part.transform[4], "Left-hand badge does not collide with the time");
      const normalBadge = items.find(item => item.str === "FL" && Math.abs(item.transform[4] - badge.transform[4]) < 2);
      assert.ok(normalBadge, "Compact badge aligns with the normal duty badges in the same day column");
    }
  }
});

test("sieben Tage und lange Bemerkungen bleiben bei mehreren Matrixseiten vollständig", async () => {
  const pages = await render(syntheticSchedule({ sevenDays: true, longNotes: true, manyEmployees: true }));
  assert.ok(pages.length > 2);
  const text = pages.map(page => page.text).join(" ");
  assert.ok(text.includes("Sonntag"));
  assert.ok(text.includes("Team 17"));
  for (let index = 1; index <= 45; index++) {
    assert.equal(text.split(`Zusatz ${index}:`).length - 1, 1, `Remark ${index} must occur once, without truncation or duplication`);
  }
  assert.ok(text.includes("Keine Bemerkung darf abgeschnitten werden."));
  for (const page of pages) assert.ok(page.width > page.height);
});

test("mehrtägige Teilabwesenheiten lassen verbleibende Dienste und ihre Zeiten sichtbar", async () => {
  const schedule = syntheticSchedule();
  schedule.weekOptions.push({ id: "partial-school", employee_number: "903", option_type: "school",
    date_from: "2026-09-17", date_to: "2026-09-18", all_day: 0, start_time: "09:00", end_time: "12:00", note: "" });
  for (const shift of schedule.shifts.filter(row => row.employee_number === "903" && ["2026-09-17", "2026-09-18"].includes(row.shift_date))) {
    shift.start_time = "13:00"; shift.end_time = "18:00";
  }
  const pages = await render(schedule);
  const text = pages.map(page => page.text).join(" ");
  const items = pages.flatMap(page => page.items);
  assert.equal(items.filter(item => item.str === "S").length, 2);
  assert.equal(text.split("Schulung").length - 1 >= 2, true);
  assert.equal(text.split("09:00-12:00").length - 1, 1);
  assert.equal(text.split("13:00-18:00").length - 1, 2);
});

test("Sonntag wird bei vorhandenen Diensten unabhängig von der Sichtbarkeitseinstellung ausgegeben", async () => {
  const schedule = syntheticSchedule();
  schedule.settings.show_sunday = "0";
  schedule.shifts.push({ ...schedule.shifts[0], id: 9999, shift_date: schedule.weekEnd,
    start_time: "10:00", end_time: "14:00" });
  const pages = await render(schedule);
  assert.ok(pages[0].text.includes("Sonntag"));
  assert.ok(pages[0].text.includes("10:00-14:00"));
});
