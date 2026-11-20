'use strict';

const { duration } = require('../public/data-import-progress');
const num = new Intl.NumberFormat('de-AT');
const date = new Intl.DateTimeFormat('de-AT', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Vienna' });
const formatDate = value => value ? date.format(new Date(value)) : 'Nicht erfasst';
const formatDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('.') : 'Nicht ermittelt';
const formatDuration = value => value === null ? 'Nicht erfasst' : duration(value);
const title = 'Import-Abschlussbericht';

function reportSections(report) {
  const { counts, previous } = report;
  const comparison = (value, earlier) => {
    if (value === null || earlier == null) return '-';
    const delta = value - earlier;
    return delta === 0 ? 'Gleich' : (delta < 0 ? '- ' : '+ ') + duration(Math.abs(delta));
  };
  const table = (title, headers, rows) => ({ title, headers, rows });
  const facts = [
    ['Quelle', report.label], ['Datei', report.fileName],
    ['Datenstand dieser Übernahme', formatDay(report.contentDate)],
    ['Hochgeladen', formatDate(report.uploadedAt)], ['Übernahme abgeschlossen', formatDate(report.finishedAt)],
    ...(report.cashActive === null ? [] : [['Kassenstand', report.cashActive ? 'Aktiv' : 'Frühere Veröffentlichung']]),
  ];
  const totals = [
    ['Eingelesene Importzeilen', num.format(counts.received)],
    ['Geprüfte Zeilen', num.format(counts.checked)],
    ['Übernommen oder unverändert bestätigt', num.format(counts.confirmed)],
    ['Ungültige Zeilen', num.format(counts.invalid)], ['Konflikte', num.format(counts.conflict)],
    ['Zurückgestellte Bestandszeilen', num.format(counts.deferredRows)],
  ];
  const phases = [['read','Einlesen'],['review','Prüfung'],['apply','Übernahme']].map(([id,label]) => {
    const value = report.durations[id], earlier = previous?.durations[id];
    return previous ? [label, formatDuration(value), formatDuration(earlier), comparison(value, earlier)]
      : [label, formatDuration(value)];
  });
  return {
    facts, totals,
    comparison: previous
      ? 'Vergleich mit ' + previous.fileName + ' (' + formatDate(previous.finishedAt) + ', ' + num.format(previous.received) + ' eingelesene Zeilen)'
      : 'Im verfügbaren Verlauf liegt kein früherer belegter Vergleichsimport vor.',
    tables: [
      table('Laufzeiten', previous ? ['Phase','Dieser Import','Vergleichsimport','Differenz'] : ['Phase','Dieser Import'], phases),
      table('Tabellen', ['Tabelle','Quellzähler','Eingelesen','Geprüft','Bestätigt'], report.tables.map(row =>
        [row.name, num.format(row.declared), num.format(row.received), num.format(row.checked), num.format(row.confirmed)])),
    ],
  };
}

const escapeHtml = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const escapeMarkdown = text => escapeHtml(text).replace(/[\\|*_[\x60\]]/g, '\\$&').replace(/[\r\n]+/g, ' ');

function toMarkdown(report) {
  const { facts, totals, comparison, tables } = reportSections(report);
  const bullets = rows => rows.map(([name,value]) => '- **' + name + '** ' + escapeMarkdown(value)).join('\n');
  const mdTable = ({ title, headers, rows }) => {
    const line = row => '| ' + row.map(escapeMarkdown).join(' | ') + ' |';
    return ['## ' + title, '', line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
  };
  return ['# ' + title, '', bullets(facts), '', '## Ergebnis', '', bullets(totals), '',
    escapeMarkdown(comparison), '', ...tables.flatMap(value => [mdTable(value), ''])].join('\n');
}

function toHtml(report) {
  const { facts, totals, comparison, tables } = reportSections(report);
  const list = rows => '<dl>' + rows.map(([name,value]) => '<dt>' + escapeHtml(name) + '</dt><dd>' + escapeHtml(value) + '</dd>').join('') + '</dl>';
  const section = ({ title, headers, rows }) => '<section><h2>' + title + '</h2><div class="table"><table><thead><tr>' +
    headers.map(header => '<th scope="col">' + escapeHtml(header) + '</th>').join('') +
    '</tr></thead><tbody>' + rows.map(row => '<tr><th scope="row">' + escapeHtml(row[0]) + '</th>' +
      row.slice(1).map(value => '<td>' + escapeHtml(value) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></section>';
  return '<!doctype html><html lang="de-AT"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title><style>html{font:16px/1.5 Roboto,system-ui,sans-serif;color:#182b27;background:#f2f6f4}' +
    'body{margin:0}main{max-width:54rem;margin:2rem auto;padding:2rem;background:white}h1{font-size:1.8rem;margin-top:0;color:#174739}' +
    'h2{font-size:1.1rem;margin:1.4rem 0 .35rem}dl{display:grid;grid-template-columns:minmax(10rem,2fr) 3fr;gap:.35rem 1rem}' +
    'dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}.table{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}' +
    'th,td{padding:.4rem .55rem;border-bottom:1px solid #d8e4df;text-align:right}th:first-child{text-align:left}thead{background:#e9f2ef}' +
    'p{margin:1.1rem 0 .2rem}tbody th{overflow-wrap:anywhere}@media(max-width:38rem){main{margin:0;padding:1rem}dl{grid-template-columns:1fr;gap:.15rem}dd{margin-bottom:.4rem}}' +
    '@media print{html{background:white}main{padding:0;margin:0}thead{display:table-header-group}tr{break-inside:avoid}}</style></head>' +
    '<body><main><h1>' + title + '</h1>' + list(facts) + '<h2>Ergebnis</h2>' + list(totals) +
    '<p>' + escapeHtml(comparison) + '</p>' + tables.map(section).join('') + '</main></body></html>';
}

const formats = Object.freeze({
  html: { type: 'text/html; charset=utf-8', render: toHtml },
  md: { type: 'text/markdown; charset=utf-8', render: toMarkdown },
  pdf: { type: 'application/pdf', render: report => require('./data-import-completion-pdf').toPdf(reportSections(report)) },
});
module.exports = { title, reportSections, formats };
