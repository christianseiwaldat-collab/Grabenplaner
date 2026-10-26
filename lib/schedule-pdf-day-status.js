"use strict";

// The caller supplies the same calendar resolver used by planning. A scoped
// schedule's manual closure is not silently promoted to a public holiday.
function schedulePdfDayStatus(schedule, date, publicHolidayName = () => "") {
  const block = (schedule.globalDayBlocks || []).find(item => item.block_date === date);
  const official = String(publicHolidayName(date) || "").trim();
  if (official || block?.is_public_holiday) return {
    type: "holiday", label: "Feiertag", name: official || String(block.holiday_name || block.reason || "Feiertag").trim(),
  };
  if (block) return { type: "closed", label: "Tag gesperrt", name: String(block.reason || "Filiale geschlossen").trim() };
  return null;
}

module.exports = { schedulePdfDayStatus };
