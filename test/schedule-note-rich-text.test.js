"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const PDFDocument = require("pdfkit");
const rich = require("../lib/schedule-note-rich-text");
const { schedulePdfDayStatus } = require("../lib/schedule-pdf-day-status");
const fs = require("node:fs"), vm = require("node:vm");

test("schedule note point sizes preserve the complete 4–72pt range and legacy meanings", () => {
  for (let tenth = 40; tenth <= 720; tenth++) assert.equal(rich.pointSize(String(tenth / 10)), tenth / 10);
  assert.equal(rich.pointSize("small"), 5.7); assert.equal(rich.pointSize("normal"), 6.4); assert.equal(rich.pointSize("large"), 7.2);
  for (const invalid of [null, "", "3.9", "72.1", "100", "12.55", "calc(12pt)", "Infinity", "12pt; color:red"])
    assert.equal(rich.pointSize(invalid), null);
});

test("Quill point classes on every inline/block tag retain their point size through safe canonical HTML", () => {
  for (const tag of ["b", "strong", "i", "em", "u", "p", "div", "span"])
    for (const attribute of ['class="ql-size-12_5pt"', 'data-size="12.5"', 'style="font-size:12.5pt"']) {
      const html = rich.sanitizedHtml(`<${tag} ${attribute}>ÄÖÜ &amp; ß</${tag}>`);
      const segments = rich.richSegments({ note_html: html });
      assert.equal(segments[0].size, 12.5, tag + " " + attribute);
      assert.equal(segments[0].text, "ÄÖÜ & ß");
      assert.equal(segments[0].bold, ["b", "strong"].includes(tag));
      assert.equal(segments[0].italic, ["i", "em"].includes(tag));
      assert.equal(segments[0].underline, tag === "u");
      assert.equal(rich.sanitizedHtml(html), html, "Canonical storage must be idempotent");
    }
});

test("mixed nested formats, decimal points and intentional blank lines survive save/read/PDF parsing", () => {
  const html = '<div>Normal <strong data-size="24">Fett <em><u>alles</u></em></strong> wieder.</div><div><br></div><div><span class="ql-size-4pt">Klein</span> <span data-size="72">Groß</span></div>';
  const sanitized = rich.sanitizedHtml(html), segments = rich.richSegments({ note_html: sanitized });
  assert.equal(rich.plainText(sanitized), "Normal Fett alles wieder.\n\nKlein Groß");
  const nested = segments.find(item => item.text === "alles");
  assert.deepEqual(nested, { text: "alles", bold: true, italic: true, underline: true, size: 24 });
  assert.equal(segments.find(item => item.text.includes("Klein")).size, 4);
  assert.equal(segments.find(item => item.text === "Groß").size, 72);
  assert.equal(segments.find(item => item.text.includes("wieder.")).bold, false);
  assert.equal(rich.plainText('<div>\n<br><br></div><p>A &#x26; B &lt;C&gt;</p>'), "A & B <C>");
});

test("sanitization removes executable markup and all non-whitelisted attributes without interpreting literal text as markup", () => {
  const html = '<script>alert(1)</script><style>p{display:none}</style><svg><script>alert(2)</script></svg><img src=x onerror=alert(3)><a href="javascript:alert(4)"><b onclick="alert(5)" style="font-size:16pt;color:red">Sicher</b></a><span class="ql-cursor">x</span>&lt;img onerror=x&gt;';
  const sanitized = rich.sanitizedHtml(html);
  assert.equal(sanitized, '<b><span data-size="16">Sicher</span></b>&lt;img onerror=x&gt;');
  assert.equal(rich.plainText(sanitized), 'Sicher<img onerror=x>');
  assert.equal(rich.sanitizedHtml(sanitized), sanitized);
  for (const size of ["3", "73", "12; background:url(x)", "12.345"])
    assert.equal(rich.sanitizedHtml(`<span data-size="${size}" onclick=x>Text</span>`), "Text");
});

test("format limits reject the whole edit; malformed stored markup falls back to its complete bounded plain text", async () => {
  const oversized = "<span>" + " ".repeat(128 * 1024) + "</span>";
  const deep = "<b>".repeat(103) + "Ende" + "</b>".repeat(103);
  for (const source of [oversized, deep]) {
    assert.throws(() => rich.sanitizedHtml(source), rich.ScheduleNoteValidationError);
    assert.equal(rich.storedHtml({ note_html: source, note_text: "Vollständiger alter Hinweis <sicher>" }), "Vollständiger alter Hinweis &lt;sicher&gt;");
    assert.throws(() => rich.storedHtml({ note_html: source, note_text: "x".repeat(901) }), rich.ScheduleNoteValidationError);
  }
  const source = fs.readFileSync(require.resolve("../server"), "utf8"), calls = [];
  const context = vm.createContext({ scheduleNoteRichText: rich, scheduleNoteMaxLength: 900,
    getMonday: value => value, isIsoDate: () => true, resolvePlanningContext: async () => ({ locationId: "synthetic" }),
    settingsForLocation: async () => ({}), assertWeekEditable: async (...args) => { calls.push(args); },
    sanitizeScheduleNoteHtml: rich.sanitizedHtml, textFromScheduleNoteHtml: rich.plainText, stripEmoji: String,
    httpError: (status, message, code) => Object.assign(new Error(message), { status, code }) });
  const start = source.indexOf("async function validateScheduleNote("), end = source.indexOf("function createVacationGroupId(", start);
  vm.runInContext(source.slice(start, end), context);
  for (const noteHtml of [oversized, deep])
    await assert.rejects(context.validateScheduleNote({ weekStart: "2026-10-26", noteHtml }, "synthetic-actor"), error => error.status === 400 && error.code === "SCHEDULE_NOTE_FORMAT_INVALID");
  await assert.rejects(context.validateScheduleNote({ weekStart: "2026-10-26", noteHtml: "A" + "<br>".repeat(901) + "B" }), error => error.status === 400);
  const plain = await context.validateScheduleNote({ weekStart: "2026-10-26", noteText: '<img src=x onerror="bad">' });
  assert.equal(plain.noteHtml, '&lt;img src=x onerror=&quot;bad&quot;&gt;');
  const emptyHtml = await context.validateScheduleNote({ weekStart: "2026-10-26", noteHtml: "<div><br></div>", noteText: "Vollständiger Text" });
  assert.equal(emptyHtml.noteHtml, "Vollständiger Text", "Empty editable markup must not hide the retained plain-text fallback in PDF");
  assert.equal(rich.storedHtml({ note_html: "<div><br></div>", note_text: "Alter vollständiger Text" }), "Alter vollständiger Text");
  const formatted = await context.validateScheduleNote({ weekStart: "2026-10-26", noteHtml: '<strong class="ql-size-12_5pt">Text</strong>' });
  assert.equal(formatted.noteHtml, '<b><span data-size="12.5">Text</span></b>');
  assert.ok(calls.length >= 5, "Existing week/context authorization precedes every edit validation");
});

test("rich PDF layout wraps long words, aligns mixed sizes on a baseline and paginates every line without loss", () => {
  const doc = new PDFDocument({ autoFirstPage: false });
  const note = { note_html: '<div><b data-size="72">GROSS</b> <u data-size="4">klein</u></div><div><span data-size="12.5">' + "LangerTextOhneLeerzeichen".repeat(10) + '</span></div>' };
  const result = rich.layout(doc, note, 250);
  assert.ok(result.lines.length > 5);
  assert.ok(result.lines.every(line => line.width <= 250 + .001));
  assert.equal(result.lines.flatMap(line => line.runs).map(run => run.text).join("").replace(/\s/g, ""), rich.richSegments(note).map(run => run.text).join("").replace(/\s/g, ""));
  const pages = rich.paginate(result.lines, 30, 458);
  assert.deepEqual(pages[0], [], "A 72pt first line belongs whole on a continuation page");
  assert.deepEqual(pages.flat(), result.lines);
  assert.ok(pages.slice(1).every(page => page.reduce((height, line) => height + line.height, 0) <= 458));
  const mixed = rich.layout(doc, { note_html: '<b data-size="24">A</b><i data-size="4">b</i>' }, 500).lines[0];
  assert.ok(mixed.height > 24); assert.equal(mixed.runs.length, 2); assert.ok(mixed.ascent >= mixed.runs[0].ascent);
  assert.ok(mixed.ascent - mixed.runs[1].ascent > 0, "Small glyph tops move down to the large baseline");
  const accented = rich.layout(doc, { note_html: '<b data-size="72">ÄÖÜ</b><i data-size="4">äöü</i>' }, 500).lines[0];
  assert.ok(accented.runs[0].ascent > accented.runs[0].baselineOffset, "Accented glyph bounds exceed Helvetica's nominal text ascender");
  assert.ok(accented.height > 72);
  for (const run of accented.runs) {
    const textTop = accented.ascent - run.baselineOffset;
    const glyphTop = textTop + run.baselineOffset - run.ascent;
    const glyphBottom = textTop + run.baselineOffset + run.descent;
    assert.ok(glyphTop >= 0 && glyphBottom <= accented.height, "Every accent and descender stays inside its measured line");
  }
  doc.end();
});

test("drawing actual PDFKit runs keeps the selected point sizes and underline without adding unplanned pages", async () => {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 0, compress: false });
  const chunks = []; doc.on("data", chunk => chunks.push(chunk)); let pages = 1; doc.on("pageAdded", () => pages++);
  const done = new Promise((resolve, reject) => { doc.on("end", resolve); doc.on("error", reject); });
  const note = { note_html: '<div><b data-size="72">GROSS</b><i data-size="12.5">Mittel</i><u data-size="4">klein</u></div>' };
  const layout = rich.layout(doc, note, 760); const bottom = rich.draw(doc, layout.lines, 30, 50);
  assert.ok(bottom < 550); doc.end(); await done;
  const source = Buffer.concat(chunks).toString("latin1");
  assert.match(source, /\/F\d+ 72 Tf/); assert.match(source, /\/F\d+ 12\.5 Tf/); assert.match(source, /\/F\d+ 4 Tf/);
  assert.equal(pages, 1); assert.ok(source.includes("/BaseFont /Helvetica-Bold")); assert.ok(source.includes("/BaseFont /Helvetica-Oblique"));
});

test("week matrix day status uses the planning calendar and keeps manual closures distinct", () => {
  const calendar = date => date === "2026-10-26" ? "Nationalfeiertag" : "";
  const schedule = { globalDayBlocks: [{ block_date: "2026-10-26", is_public_holiday: true, reason: "Feiertag" },
    { block_date: "2026-10-27", is_public_holiday: false, reason: "Umbau" },
    { block_date: "2026-10-28", is_public_holiday: true, reason: "Regionaler Feiertag" }] };
  assert.deepEqual(schedulePdfDayStatus(schedule, "2026-10-26", calendar), { type: "holiday", label: "Feiertag", name: "Nationalfeiertag" });
  assert.deepEqual(schedulePdfDayStatus({ globalDayBlocks: [] }, "2026-10-26", calendar), { type: "holiday", label: "Feiertag", name: "Nationalfeiertag" });
  assert.deepEqual(schedulePdfDayStatus(schedule, "2026-10-27", calendar), { type: "closed", label: "Tag gesperrt", name: "Umbau" });
  assert.equal(schedulePdfDayStatus(schedule, "2026-10-28", calendar).name, "Regionaler Feiertag");
  assert.equal(schedulePdfDayStatus(schedule, "2026-10-29", calendar), null);
});
