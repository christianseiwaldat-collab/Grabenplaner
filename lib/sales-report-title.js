'use strict';
const C = require('./data-import-contract');
function expandReportTitle(title, query) {
  const date = new Date(query.dateFrom + 'T12:00:00Z');
  const month = new Intl.DateTimeFormat('de-AT', { month: 'long', timeZone: 'UTC' }).format(date);
  return C.text(title.replace(/\(Monat\)/gi, month).replace(/\(Jahr\)/gi, query.dateFrom.slice(0, 4)), 160);
}
module.exports = { expandReportTitle };
