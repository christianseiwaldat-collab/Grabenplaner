"use strict";

// Synthetic, local-only preview through the application's actual PDF renderer.
const fs = require("node:fs");
const path = require("node:path");
const { finished } = require("node:stream/promises");

function syntheticSchedule({ sevenDays = false, longNotes = false, manyEmployees = false, showDutyLabels = false } = {}) {
  const names = ["Alex", "Robin", "Dana", "Sam", "Kim", "Toni"];
  const positions = ["teamleitung", "fl-stellvertretung", "verkaufsmitarbeiter", "abteilungsleitung", "lehrling", "verkaufsmitarbeiter"];
  const colors = ["#39d6a0", "#493cac", "#08a4a7", "#e640b2", "#edce33", "#64ad60"];
  const employees = names.map((name, index) => ({ personnel_number: String(901 + index),
    nickname: name, full_name: `${name} Beispiel`, position_id: positions[index],
    position_name: positions[index], home_location_id: "demo-home", color: colors[index] }));
  const date = day => `2026-09-${14 + day}`;
  const shifts = [];
  function shift(employee, day, duty, start = "09:00", end = "18:00") {
    shifts.push({ id: shifts.length + 1, employee_number: employees[employee].personnel_number,
      location_id: "demo-home", shift_date: date(day), start_time: start, end_time: end,
      duty_code: duty === "FL" ? "branch_supervision" : "department",
      department_id: duty === "FL" ? null : duty === "FO" ? 2 : 1,
      department_name: duty === "FL" ? "" : duty === "FO" ? "Fotowelt" : "Hardware" });
  }
  for (const day of [0, 2, 4, 5]) shift(0, day, day === 5 ? "HW" : "FL", day === 0 ? "12:00" : "09:00", day === 5 ? "17:00" : "18:00");
  shift(0, 1, "HW", "09:00", "13:00");
  shift(0, 1, "FO", "14:00", "18:00");
  for (const day of [0, 1, 2, 3]) shift(1, day, day === 0 ? "FO" : "FL");
  for (const day of [0, 1, 2, 3, 4, 5]) shift(2, day, "HW", day === 2 ? "12:00" : "09:00", day === 4 ? "15:00" : "18:00");
  for (const day of [0, 1, 2]) shift(3, day, "FO");
  shift(5, 0, "HW");
  shift(5, 1, "HW", "09:00", "13:00");
  function option(id, employee, type, from, to, overrides = {}) {
    return { id, employee_number: employees[employee].personnel_number, nickname: names[employee],
      option_type: type, date_from: date(from), date_to: date(to), all_day: 1,
      start_time: null, end_time: null, note: "", ...overrides };
  }
  const weekOptions = [
    option("school", 1, "school", 4, 4), option("za-robin", 1, "time_off", 5, 5),
    option("vacation-sam", 3, "vacation", 3, 5, { note: "Urlaubsabbau - verfügbar" }),
    option("vocational", 4, "vocational_school", 0, sevenDays ? 6 : 5),
    option("vacation-toni", 5, "vacation", 3, 4), option("za-toni", 5, "time_off", 5, 5),
    option("sick-alex", 0, "sick", 3, 3, { note: "Diagnose: vertraulich" }),
  ];
  weekOptions.find((entry) => entry.id === "za-robin").note = "fix ZA; Behördengang";
  const staffAssignments = [{ id: "demo-away", employee_number: "906", home_location_id: "demo-home",
    destination_location_id: "demo-target", destination_location_name: "Filiale Süd", destination_department_id: 2,
    destination_department_name: "Fotowelt", date_from: date(1), date_to: date(1), all_day: 0,
    start_time: "14:00", end_time: "18:00" }];
  const pdfStaffAssignmentShifts = [1].map(day => ({ employee_number: "906", shift_date: date(day),
    location_id: "demo-target", location_name: "Filiale Süd", department_id: 2, department_name: "Fotowelt",
    duty_code: "department", start_time: "14:00", end_time: "18:00" }));
  const paragraphs = [
    "Montag: Warenübernahme ab 12 Uhr. Die Zuständigkeit für Filialaufsicht ist direkt beim jeweiligen Dienst angegeben.",
    "Dienstag: Alex arbeitet von 9 bis 13 Uhr in der Hardware und von 14 bis 18 Uhr in der Fotowelt. Übergaben bitte vor Dienstende abstimmen.",
    "Filiale Süd: Toni arbeitet am Dienstag von 9 bis 13 Uhr in der Stammfiliale Hardware und von 14 bis 18 Uhr in der Filiale Süd Fotowelt.",
    "Freitag: Rückfragen zur Schulung gesammelt weitergeben. Die Berufsschule ist als zusammenhängender Zeitraum sichtbar.",
    "Samstag: Offene Reservierungen und vereinbarte Abholungen bei der Übergabe berücksichtigen.",
  ];
  if (longNotes) for (let index = 1; index <= 45; index++) paragraphs.push(`Zusatz ${index}: Vollständiger synthetischer Hinweis für die Prüfung des mehrspaltigen Textflusses und der Fortsetzungsseiten. Keine Bemerkung darf abgeschnitten werden.`);
  if (manyEmployees) {
    for (let index = 0; index < 17; index++) employees.push({ ...employees[2], personnel_number: String(950 + index), nickname: `Team ${index + 1}`, full_name: `Synthetisches Teammitglied ${index + 1}` });
  }
  return { employees, shifts, weekOptions, staffAssignments, pdfStaffAssignmentShifts, sicknessCredits: [],
    departments: [{ id: 1, name: "Hardware" }, { id: 2, name: "Fotowelt" }],
    context: { locationId: "demo-home", locationName: "Musterfiliale", location: { name: "Musterfiliale" }, departmentId: null },
    weekStart: "2026-09-14", weekEnd: "2026-09-20", calendarWeek: 38, globalDayBlocks: [],
    scheduleNote: { note_text: paragraphs.join("\n\n") },
    settings: { pdf_title: "Dienstplan · Musterfiliale", show_sunday: sevenDays ? "1" : "0",
      pdf_schedule_matrix_time_font_size: "14.5", pdf_schedule_matrix_detail_font_size: "8",
      pdf_schedule_matrix_show_duty_label: showDutyLabels ? "1" : "0",
      pdf_schedule_matrix_time_font_bold: "1", pdf_schedule_matrix_time_employee_color: "1",
      pdf_schedule_matrix_show_position: "0", pdf_schedule_matrix_header_text: "Wochenmatrix · Muster",
      schedule_duty_colors: JSON.stringify({ FL: "#285366", HW: "#426D5B", FO: "#426D5B", AG: "#52636B" }),
      admin_email: "", company_name: "Musterbetrieb", pdf_footer_contact: "Synthetische Vorschau" } };
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const output = path.resolve(root, process.argv[2] || "output/pdf/Wochenmatrix-Muster.pdf");
  if (!output.startsWith(root + path.sep) || !/\.pdf$/iu.test(output)) throw new Error("Preview output must be a PDF inside this repository.");
  const scratch = path.join(root, "tmp", "pdfs");
  fs.mkdirSync(scratch, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(scratch, "schedule-preview-"));
  Object.assign(process.env, { DB_PATH: path.join(fixture, "fixture.db"), BACKUP_DIR: path.join(fixture, "backups"),
    GRABENPLANER_DATA_DIR: path.join(fixture, "data"), GRABENPLANER_HOST: "127.0.0.1",
    GRABENPLANER_SEED_DEMO: "0", GRABENPLANER_TEST_AMU_SCANNER: "clean", NODE_ENV: "test", TZ: "Europe/Vienna" });
  const subject = require("../server");
  try {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const stream = fs.createWriteStream(output);
    const completion = finished(stream);
    await subject.drawSchedulePdfForTests(syntheticSchedule({ sevenDays: process.argv.includes("--seven-days"),
      longNotes: process.argv.includes("--long-notes"), manyEmployees: process.argv.includes("--many-employees"),
      showDutyLabels: process.argv.includes("--duty-labels") }),
    stream, new Date("2026-09-06T14:00:00Z"), "matrix");
    await completion;
    process.stdout.write(`${JSON.stringify({ output, bytes: fs.statSync(output).size })}\n`);
  } finally {
    await subject.closePersistenceForTests();
    subject.releaseInstanceLockForTests();
  }
}

module.exports = { syntheticSchedule };
if (require.main === module) main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
