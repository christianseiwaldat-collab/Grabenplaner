"use strict";

const TIME_ZONE = "Europe/Vienna";
const MONTHS = ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"];
const WEEKDAYS = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"];

function dateError(message = "Bitte nenne ein eindeutiges Datum oder einen Zeitraum mit Tag und Monat.") {
  return Object.assign(new Error(message), { status: 422, code: "ASSISTANT_DATE_UNCLEAR" });
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(value + "T12:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function viennaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type).value).join("-");
}

function addDays(date, days) {
  const value = new Date(date + "T12:00:00Z");
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function monday(date) {
  return addDays(date, -((new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7));
}

function calendarDate(day, month, year) {
  const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!validDate(value)) throw dateError("Dieses Kalenderdatum existiert nicht. Bitte prüfe Tag, Monat und Jahr.");
  return value;
}

// Only calendar interpretation lives here. Eligibility, holidays, credited days
// and absence accounting remain in the existing GP services.
function resolvePeriod(expression, { today = viennaDate(), mode = "request" } = {}) {
  if (!validDate(today)) throw dateError();
  let text = String(expression || "").toLowerCase().trim().replace(/maerz/g, "märz").replace(/jänner/g, "januar");
  if (text.length > 240) throw dateError();
  const assumptions = [];
  let dateFrom, dateTo;
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  if (iso) {
    if (iso.length > 2 || iso.some(date => !validDate(date))) throw dateError();
    [dateFrom, dateTo = iso[0]] = iso;
  } else if (/^(?:diese|nächste|naechste|kommende)\s+woche$/.test(text)) {
    dateFrom = addDays(monday(today), /^(nächste|naechste|kommende)/.test(text) ? 7 : 0);
    dateTo = addDays(dateFrom, 6);
  } else if (/^(heute|morgen|übermorgen|uebermorgen)$/.test(text)) {
    dateFrom = dateTo = addDays(today, text === "heute" ? 0 : text === "morgen" ? 1 : 2);
  } else {
    const weekday = WEEKDAYS.findIndex(day => new RegExp(`\\b${day}\\b`).test(text));
    if (weekday >= 0 && !/\d/.test(text)) {
      const offset = (weekday + 6) % 7;
      if (/nächste[nr]?\s+woche|naechste[nr]?\s+woche|kommende[nr]?\s+woche/.test(text)) {
        dateFrom = addDays(monday(today), 7 + offset);
      } else if (/diese[nrms]?|diese\s+woche/.test(text)) {
        dateFrom = addDays(monday(today), offset);
      } else {
        const current = new Date(today + "T12:00:00Z").getUTCDay();
        let distance = (weekday - current + 7) % 7;
        if (/nächste|naechste|kommende/.test(text) && distance === 0) distance = 7;
        dateFrom = addDays(today, distance);
        assumptions.push(`„${expression}“ bedeutet hier den nächsten ${WEEKDAYS[weekday]} am ${dateFrom}. Bitte Datum prüfen.`);
      }
      dateTo = dateFrom;
    } else {
      // Common spoken ordinals, including "neunzehnten bis dreiundzwanzigsten Oktober".
      const ordinals = ["ersten", "zweiten", "dritten", "vierten", "fünften", "sechsten", "siebten", "achten", "neunten", "zehnten", "elften", "zwölften", "dreizehnten", "vierzehnten", "fünfzehnten", "sechzehnten", "siebzehnten", "achtzehnten", "neunzehnten", "zwanzigsten", "einundzwanzigsten", "zweiundzwanzigsten", "dreiundzwanzigsten", "vierundzwanzigsten", "fünfundzwanzigsten", "sechsundzwanzigsten", "siebenundzwanzigsten", "achtundzwanzigsten", "neunundzwanzigsten", "dreißigsten", "einunddreißigsten"];
      ordinals.forEach((word, index) => { text = text.replace(new RegExp(`\\b${word}\\b`, "g"), String(index + 1) + "."); });
      const monthPattern = MONTHS.join("|");
      const named = text.match(new RegExp(`^(?:vom?\\s+|am\\s+|den\\s+)?(\\d{1,2})\\.?\\s*(?:bis(?:\\s+zum)?\\s+(\\d{1,2})\\.?\\s*)?(${monthPattern})(?:\\s+(\\d{4}))?\\.?$`));
      const numeric = text.match(/^(?:vom?\s+|am\s+|den\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})?\s*(?:bis\s+(\d{1,2})\.(\d{1,2})\.(\d{4})?)?$/);
      if (!named && !numeric) throw dateError();
      const fromDay = Number(named ? named[1] : numeric[1]);
      const fromMonth = named ? MONTHS.indexOf(named[3]) + 1 : Number(numeric[2]);
      const explicitYear = named ? named[4] : numeric[3];
      let year = Number(explicitYear || today.slice(0, 4));
      dateFrom = calendarDate(fromDay, fromMonth, year);
      if (!explicitYear && mode === "request" && dateFrom < today) {
        year++;
        dateFrom = calendarDate(fromDay, fromMonth, year);
      }
      if (!explicitYear) assumptions.push(`Ohne Jahresangabe wurde ${year} in Europe/Vienna gewählt. Bitte Zeitraum prüfen.`);
      const toDay = Number(named ? named[2] || named[1] : numeric[4] || numeric[1]);
      const toMonth = named ? fromMonth : Number(numeric[5] || numeric[2]);
      const toYear = Number(numeric?.[6] || (toMonth < fromMonth ? year + 1 : year));
      dateTo = calendarDate(toDay, toMonth, toYear);
    }
  }
  if (dateTo < dateFrom || (new Date(dateTo + "T12:00:00Z") - new Date(dateFrom + "T12:00:00Z")) / 86400000 > 365) throw dateError("Bitte einen gültigen Zeitraum von höchstens 366 Kalendertagen nennen.");
  return { dateFrom, dateTo, assumptions, timeZone: TIME_ZONE };
}

module.exports = { TIME_ZONE, validDate, viennaDate, addDays, monday, resolvePeriod };
