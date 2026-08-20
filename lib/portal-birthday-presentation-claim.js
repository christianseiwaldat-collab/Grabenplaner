"use strict";

const crypto = require("node:crypto");

const PORTAL_BIRTHDAY_TIME_ZONE = "Europe/Vienna";
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function viennaCalendarDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Ein gültiger Zeitpunkt wird benötigt.");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: PORTAL_BIRTHDAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).filter(({ type }) => type !== "literal")
    .map(({ type, value: part }) => [type, part]));
  return Object.freeze({
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  });
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parsedIsoCalendarDate(value) {
  const match = String(value || "").match(ISO_DATE_PATTERN);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day) return null;
  return Object.freeze({ year, month, day });
}

function calendarOrdinal({ year, month, day }) {
  return year * 10000 + month * 100 + day;
}

function nextCalendarDate({ year, month, day }) {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return Object.freeze({
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  });
}

function observedBirthdayDate(birthDate, eventYear) {
  const nonLeapFebruaryBirthday = birthDate.month === 2
    && birthDate.day === 29
    && !isLeapYear(eventYear);
  return Object.freeze({
    year: eventYear,
    month: birthDate.month,
    day: nonLeapFebruaryBirthday ? 28 : birthDate.day,
  });
}

function birthdayEventForVienna(birthDate, value = new Date()) {
  const parsed = parsedIsoCalendarDate(birthDate);
  if (!parsed) return null;
  const today = viennaCalendarDate(value);
  if (calendarOrdinal(parsed) >= calendarOrdinal(today)) return null;
  const observed = observedBirthdayDate(parsed, today.year);
  if (calendarOrdinal(today) !== calendarOrdinal(observed)) return null;
  return Object.freeze({ eventYear: today.year });
}

function birthdayThemeEventForVienna(birthDate, value = new Date()) {
  const parsed = parsedIsoCalendarDate(birthDate);
  if (!parsed) return null;
  const today = viennaCalendarDate(value);
  if (calendarOrdinal(parsed) >= calendarOrdinal(today)) return null;

  for (const eventYear of [today.year, today.year - 1]) {
    if (eventYear <= parsed.year) continue;
    const observed = observedBirthdayDate(parsed, eventYear);
    const following = nextCalendarDate(observed);
    const todayOrdinal = calendarOrdinal(today);
    if (todayOrdinal === calendarOrdinal(observed)
      || todayOrdinal === calendarOrdinal(following)) {
      return Object.freeze({ eventYear });
    }
  }
  return null;
}

function birthdayClaimReceipt(secret, {
  employeeNumber,
  eventYear,
  presentationId,
  policyRevision,
  assignmentRevision,
} = {}) {
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret || ""), "utf8");
  const employee = String(employeeNumber || "");
  const presentation = String(presentationId || "");
  if (!key.length
    || !employee.trim()
    || employee !== employee.trim()
    || employee.length > 120
    || employee.includes("\0")
    || !Number.isSafeInteger(eventYear)
    || eventYear < 2000
    || eventYear > 9999
    || !["standard", "elegant", "farbenfroh", "fotowelt", "technik"].includes(presentation)
    || !Number.isSafeInteger(policyRevision) || policyRevision < 1
    || !Number.isSafeInteger(assignmentRevision) || assignmentRevision < 1) {
    throw new TypeError("Der Geburtstagsereignis-Fingerprint kann nicht sicher gebildet werden.");
  }
  return crypto.createHmac("sha256", key)
    .update(
      `grabenplaner-portal-birthday-claim-receipt-v1\0${employee}\0${eventYear}`
        + `\0${presentation}\0${policyRevision}\0${assignmentRevision}`,
    )
    .digest("hex");
}

module.exports = {
  PORTAL_BIRTHDAY_TIME_ZONE,
  birthdayClaimReceipt,
  birthdayEventForVienna,
  birthdayThemeEventForVienna,
  isLeapYear,
  viennaCalendarDate,
};
