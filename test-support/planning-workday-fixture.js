"use strict";

const { addDays, austrianNationalHolidays, dayOfWeek } = require("../lib/work-rules/calendar");

// Fixtures that expect ordinary Mon–Fri sickness credit must use a real
// workday. Keeping the reference date explicit also covers holiday boundaries
// without changing the application's clock or holiday rules.
function previousRegularWorkdays(referenceDate, count) {
  const dates = [];
  for (let date = addDays(referenceDate, -1); dates.length < count; date = addDays(date, -1)) {
    const weekday = dayOfWeek(date);
    if (weekday >= 1 && weekday <= 5 && !austrianNationalHolidays(Number(date.slice(0, 4))).has(date)) {
      dates.push(date);
    }
  }
  return dates;
}

module.exports = { previousRegularWorkdays };
