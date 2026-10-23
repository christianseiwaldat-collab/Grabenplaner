"use strict";

// Select a view anchor from the existing schedule and opening calendar. This
// does not change shifts, absences, staffing rules or opening hours.
async function mobileScheduleFocus({ today, time, shifts, opening, isClosed }) {
  const dates = [...new Set(shifts.map(s => s.date || s.shift_date))]
    .filter(date => date >= today).sort();
  for (const date of dates) {
    if (await isClosed(date)) continue;
    const hours = await opening(date);
    if (!hours) continue;
    if (date === today) {
      const ends = shifts.filter(s => (s.date || s.shift_date) === date)
        .map(s => s.endTime || s.end_time).filter(Boolean).sort();
      // Stay on today while either the branch or a scheduled duty is active.
      const end = [hours.end, ends.at(-1)].filter(Boolean).sort().at(-1);
      if (end && time >= end) continue;
    }
    return date;
  }
  return null;
}
module.exports = { mobileScheduleFocus };
