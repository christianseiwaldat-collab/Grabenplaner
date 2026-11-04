"use strict";

const ROUNDING_TOLERANCE_MINUTES = 7;

class XoffiWeekReconciliationError extends Error {
  constructor() {
    super("XOFFI_WEEK_VALUES_INVALID");
    this.name = "XoffiWeekReconciliationError";
    this.code = "XOFFI_WEEK_VALUES_INVALID";
  }
}

function integer(value, maximum) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new XoffiWeekReconciliationError();
  }
  return value;
}

// A source can report holiday credits only in its weekly summary. Preserve
// that credit at week level; a matching daily total must never receive it twice.
function reconcileXoffiWeek(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new XoffiWeekReconciliationError();
  const { days, weeklyValuedMinutes, weeklySurchargeMinutes, weeklyHolidayMinutes = null } = options;
  if (!Array.isArray(days) || days.length !== 7) throw new XoffiWeekReconciliationError();
  integer(weeklyValuedMinutes, 20160);
  integer(weeklySurchargeMinutes, 10080);
  if (weeklyHolidayMinutes !== null) {
    integer(weeklyHolidayMinutes, 10080);
    if (weeklyHolidayMinutes > weeklyValuedMinutes + ROUNDING_TOLERANCE_MINUTES) {
      throw new XoffiWeekReconciliationError();
    }
  }
  let dailyValuedMinutes = 0, dailySurchargeMinutes = 0;
  for (const day of days) {
    dailyValuedMinutes += integer(day?.valuedMinutes, 2880);
    dailySurchargeMinutes += integer(day?.surchargeMinutes, 1440);
  }
  if (Math.abs(dailySurchargeMinutes - weeklySurchargeMinutes) > ROUNDING_TOLERANCE_MINUTES) {
    throw new XoffiWeekReconciliationError();
  }
  const difference = weeklyValuedMinutes - dailyValuedMinutes;
  let status = "daily", unallocatedHolidayMinutes = 0;
  // Keep the established tolerance for decimal source hours rounded per day.
  // When days already explain the week, the holiday label is informational.
  if (Math.abs(difference) > ROUNDING_TOLERANCE_MINUTES) {
    if (!(weeklyHolidayMinutes > 0) || difference <= 0
      || Math.abs(difference - weeklyHolidayMinutes) > ROUNDING_TOLERANCE_MINUTES) {
      throw new XoffiWeekReconciliationError();
    }
    status = "weekly_holiday";
    unallocatedHolidayMinutes = weeklyHolidayMinutes;
  }
  return {
    version: 1, status, dailyValuedMinutes, unallocatedHolidayMinutes,
    roundingDifferenceMinutes: difference - unallocatedHolidayMinutes,
  };
}

function sourceHolidayCredit(snapshot) {
  const proof = snapshot?.valuationReconciliation;
  if (snapshot?.kind !== "mhtml" || proof?.version !== 1 || proof.status !== "weekly_holiday") return null;
  integer(snapshot.weeklyHolidayMinutes, 10080);
  integer(snapshot.sourceWeeklyValuedMinutes, 20160);
  integer(proof.dailyValuedMinutes, 20160);
  if (snapshot.weeklyHolidayMinutes <= 0 || proof.unallocatedHolidayMinutes !== snapshot.weeklyHolidayMinutes
    || !Number.isInteger(proof.roundingDifferenceMinutes)
    || Math.abs(proof.roundingDifferenceMinutes) > ROUNDING_TOLERANCE_MINUTES
    || snapshot.sourceWeeklyValuedMinutes - proof.dailyValuedMinutes - snapshot.weeklyHolidayMinutes !== proof.roundingDifferenceMinutes) {
    throw new XoffiWeekReconciliationError();
  }
  return snapshot.weeklyHolidayMinutes;
}

function createReviewedXoffiSnapshot(snapshot, reviewed) {
  if (snapshot?.kind !== "mhtml" || !reviewed || !Array.isArray(reviewed.days)) throw new XoffiWeekReconciliationError();
  const valuationReconciliation = reconcileXoffiWeek({ ...reviewed, weeklyHolidayMinutes: sourceHolidayCredit(snapshot) });
  const weeklyActualMinutes = integer(reviewed.weeklyActualMinutes, 10080);
  const actual = reviewed.days.reduce((sum, day) => sum + integer(day.actualMinutes, 1440), 0);
  if (Math.abs(actual - weeklyActualMinutes) > ROUNDING_TOLERANCE_MINUTES) throw new XoffiWeekReconciliationError();
  return { ...snapshot, reviewedWeek: {
    version: 1, weeklyActualMinutes, weeklyValuedMinutes: reviewed.weeklyValuedMinutes,
    weeklySurchargeMinutes: reviewed.weeklySurchargeMinutes, valuationReconciliation,
  } };
}

function verifyReviewedXoffiWeek(snapshot, reviewed) {
  if (snapshot?.reviewedWeek?.version !== 1) return null;
  try {
    const expected = createReviewedXoffiSnapshot(snapshot, reviewed).reviewedWeek, stored = snapshot.reviewedWeek;
    if (["weeklyActualMinutes", "weeklyValuedMinutes", "weeklySurchargeMinutes"].some(key => stored[key] !== expected[key])
      || ["version", "status", "dailyValuedMinutes", "unallocatedHolidayMinutes", "roundingDifferenceMinutes"]
        .some(key => stored.valuationReconciliation?.[key] !== expected.valuationReconciliation[key])) return null;
    return expected;
  } catch { return null; }
}

module.exports = { reconcileXoffiWeek, createReviewedXoffiSnapshot, verifyReviewedXoffiWeek,
  XoffiWeekReconciliationError, ROUNDING_TOLERANCE_MINUTES };
