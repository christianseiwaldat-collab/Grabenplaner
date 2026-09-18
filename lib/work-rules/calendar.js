"use strict";

const DAY_MS = 86_400_000;

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function isoDateFromUtc(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return isoDateFromUtc(value);
}

function dayOfWeek(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function mondayOfWeek(date) {
  const weekday = dayOfWeek(date);
  return addDays(date, -((weekday + 6) % 7));
}

function daysBetween(start, end) {
  return Math.round((new Date(`${end}T12:00:00Z`) - new Date(`${start}T12:00:00Z`)) / DAY_MS);
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function austrianNationalHolidays(year) {
  const easter = easterSunday(year);
  return new Set([
    `${year}-01-01`,
    `${year}-01-06`,
    addDays(easter, 1),
    addDays(easter, 39),
    addDays(easter, 50),
    addDays(easter, 60),
    `${year}-08-15`,
    `${year}-10-26`,
    `${year}-11-01`,
    `${year}-12-08`,
    `${year}-12-25`,
    `${year}-12-26`,
  ]);
}

const timePartFormatters = new Map();
function timePartsAt(epoch, timeZone) {
  let formatter = timePartFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    // The formatter contains only locale rules, never employee or shift data.
    // A week evaluates the same time zone thousands of times.
    if (timePartFormatters.size >= 16) timePartFormatters.delete(timePartFormatters.keys().next().value);
    timePartFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(epoch))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return parts;
}

function localDateTimeToEpoch(date, time, timeZone = "Europe/Vienna") {
  if (!isIsoDate(date) || !/^\d{2}:\d{2}$/.test(String(time || ""))) return NaN;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (hour > 23 || minute > 59) return NaN;
  const intendedAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = intendedAsUtc;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = timePartsAt(guess, timeZone);
    const observedAsUtc = Date.UTC(
      observed.year, observed.month - 1, observed.day,
      observed.hour, observed.minute, observed.second,
    );
    const adjustment = intendedAsUtc - observedAsUtc;
    guess += adjustment;
    if (adjustment === 0) break;
  }
  const result = timePartsAt(guess, timeZone);
  if (
    result.year !== year || result.month !== month || result.day !== day
    || result.hour !== hour || result.minute !== minute
  ) return NaN;
  return guess;
}

module.exports = {
  DAY_MS,
  addDays,
  austrianNationalHolidays,
  dayOfWeek,
  daysBetween,
  isIsoDate,
  localDateTimeToEpoch,
  mondayOfWeek,
};
