"use strict";

// Execute the application's actual, pure PDF functions without booting the
// server or opening either productive database. No renderer is reimplemented.
const fs = require("node:fs");
const vm = require("node:vm");
const PDFDocument = require("pdfkit");
const source = fs.readFileSync(require.resolve("../server"), "utf8");

function productionFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}", start);
  if (start < 0 || end < start) throw new Error(`Missing production PDF function: ${name}`);
  return source.slice(start, end + 2);
}

const names = [
  "isIsoDate", "isTime", "addDays", "easterSunday", "austrianPublicHolidays", "publicHolidayName",
  "settingEnabled", "normalizeScheduleMatrixFontSize", "normalizeScheduleMatrixHeaderText",
  "isTeamMeetingGroupId", "isTeamWideMeetingOption", "optionIsAllDay",
  "formatDateGerman", "formatPdfTimestamp", "optionLabel", "hexToRgb", "contrastColor",
  "brandingFromSettings", "pdfFooterContact", "collapsedScheduleWeekOptions",
  "schedulePdfAssignmentOptionAlreadyPresent", "schedulePdfRemoveBranchCoverage", "schedulePdfAssignmentCoversShift",
  "schedulePlanningEmployeeOnDate", "schedulePdfPlanningRows", "schedulePdfWeekOptions", "scheduleForPdf",
  "drawScheduleMatrixPdf",
  ...Array.from(source.matchAll(/^function ((?:scheduleMatrix|drawScheduleMatrix)\w+)\(/gm), match => match[1]),
];
const version = require("../package.json").version;
const context = vm.createContext({
  PDFDocument,
  ...require("../lib/schedule-matrix-layout"),
  ...require("../lib/schedule-pdf-day-status"),
  ...require("../public/schedule-duty"),
  scheduleNoteRichText: require("../lib/schedule-note-rich-text"),
  austrianHolidayCache: new Map(),
  APP_NAME: "Grabenplaner", APP_VERSION_LABEL: `v${version.replace(/-beta$/, " Beta")}`,
  defaultBranding: { app_name: "Grabenplaner", company_name: "", logo_url: "", icon_url: "", logo_alt: "", admin_email: "" },
});
const constants = ["SCHEDULE_MATRIX_TIME_FONT_SIZES", "SCHEDULE_MATRIX_DETAIL_FONT_SIZES", "TEAM_MEETING_GROUP_PREFIX"]
  .map(name => {
    const match = source.match(new RegExp(`^const ${name} = .+;$`, "m"));
    if (!match) throw new Error(`Missing production PDF constant: ${name}`);
    return match[0];
  });
vm.runInContext([...constants, ...new Set(names.map(productionFunction))].join("\n"), context,
  { filename: "production-schedule-pdf-functions.js" });

module.exports = {
  drawMatrix(schedule, output, createdAt = new Date()) {
    return context.drawScheduleMatrixPdf(context.scheduleForPdf(schedule), output, createdAt);
  },
  measureRows(schedule) {
    const projected = context.scheduleForPdf(schedule), doc = new PDFDocument({ autoFirstPage: false });
    const time = Number(schedule.settings.pdf_schedule_matrix_time_font_size || 14.5);
    const detail = Number(schedule.settings.pdf_schedule_matrix_detail_font_size || 6);
    try {
      return schedule.employees.map(employee => ({ employee: employee.nickname,
        content: context.scheduleMatrixContentRowHeight(projected, employee, 6, time, detail, doc, (797.89 - 148) / 6),
        minimum: context.scheduleMatrixMinimumRowHeight(time, detail) }));
    } finally { doc.end(); }
  },
};
