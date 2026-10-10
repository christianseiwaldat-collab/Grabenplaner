'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Q = require('../public/gp-data-quality');
const now = Date.parse('2026-10-10T10:00:00Z');
test('data quality keeps missing, invalid and future evidence unknown while retaining true zero counts', () => {
  for (const timestamp of [null, undefined, '', 0, 'not-a-date', '2026-02-30T00:00:00Z', '2026-10-10T24:00:00Z', '2026-10-11T10:00:00Z']) {
    const result = Q.normalize({ source: { kind: 'upload', timestamp } }, { now }); assert.equal(result.source, null);
    assert.match(Q.render({ source: { kind: 'upload', timestamp } }, { now }), /Datum und Alter nicht bekannt/);
  }
  const values = [0, null, undefined, '0', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
  assert.deepEqual(Q.normalize({ issues: values.map((count, i) => ({ label: 'Prüfung ' + i, count })) }).issues.map(item => item.count), [0, null, null, null, null, null, null, null, null]);
  assert.equal(Q.normalize(null).source, null);
});
test('civil snapshot dates retain their day and use the GP calendar at the midnight boundary', () => {
  const viennaMidnight = Date.parse('2026-10-09T22:30:00Z');
  const current = Q.normalize({ source: { kind: 'snapshot', timestamp: '2026-10-10' } }, { now: viennaMidnight });
  assert.equal(current.source.value, '2026-10-10'); assert.equal(current.source.ageDays, 0); assert.match(current.source.label, /10\.10\.2026/);
  assert.equal(Q.normalize({ source: { kind: 'snapshot', timestamp: '2026-10-11' } }, { now: viennaMidnight }).source, null);
  assert.equal(Q.normalize({ source: { kind: 'upload', timestamp: '2026-10-10' } }, { now }).source, null);
  assert.equal(Q.normalize({ source: { kind: 'snapshot', timestamp: '2026-10-08' } }, { now: viennaMidnight }).source.ageDays, 2);
});
test('named source evidence and issue labels are escaped without turning processing into calendar proof', () => {
  const markup = Q.render({ title: '<img src=x>', source: { kind: 'snapshot', timestamp: '2026-10-01T10:00:00Z' }, complete: true, calendarUnknown: true,
    issues: [{ label: '<script>alert(1)</script>', count: 2 }, { label: 'Zweite Kategorie', count: 3 }], overlap: true, coverage: 'A & B', note: '"Hinweis"' }, { now });
  assert.doesNotMatch(markup, /<img|<script/); assert.match(markup, /&lt;script&gt;/); assert.match(markup, /A &amp; B/);
  assert.match(markup, /Auswahl vollständig verarbeitet/); assert.match(markup, /Vollständigkeit des Kalenderzeitraums ist nicht nachgewiesen/);
  assert.match(markup, /<details[^>]*><summary>Prüfpunkte anzeigen · 2 Kategorien/); assert.match(markup, /nicht zu einer Gesamtzahl addiert/); assert.doesNotMatch(markup, /5 Prüffälle/);
  assert.match(markup, /Quellstand:/); assert.doesNotMatch(markup, /Hochgeladen am:/);
  assert.match(Q.render({ source: Q.sourceInfo({ uploadedAt: '2026-10-01T10:00:00Z' }) }, { now }), /Hochgeladen am:/);
});
test('stock quality exposes cost exceptions only with the cost grant and distinguishes missing from actual zero', () => {
  const result = { complete: true, sourceDate: '2026-09-15T10:00:00Z', totals: { positions: 5, missingArticle: 0, missingQuantity: 2, missingCost: 1, zeroCost: 3 } };
  const authorized = Q.render(Q.stock(result, { costs: true }), { now }); assert.match(authorized, /Ohne gültigen Einkaufspreis/); assert.match(authorized, /Einkaufspreis gleich 0/);
  const denied = Q.render(Q.stock(result, { costs: false }), { now }); assert.doesNotMatch(denied, /Einkaufspreis|gültigen/); assert.match(denied, /Ohne Bestandsmenge/);
  const legacy = Q.render(Q.stock({ ...result, totals: { positions: 0, missingArticle: 0 } }, { costs: true }), { now }); assert.doesNotMatch(legacy, /Einkaufspreis/); assert.match(legacy, /Quellpositionen<\/dt><dd>0/);
  assert.equal(Q.normalize(Q.stock(result), { now }).source.ageDays, 25); assert.equal(Q.normalize(Q.stock(result), { now }).complete, true);
});
test('history and ABC preserve unknown period coverage and their saved upload metadata', () => {
  const quality = { sourceId: 'compact-cash', uploadedAt: '2026-09-01T10:00:00Z' };
  const history = Q.render(Q.history({ sourceQuality: quality, coverage: { complete: true, counts: { records: 4, checked: 3, review: 1 }, unresolved: { article: 1 } } }), { now });
  assert.match(history, /Hochgeladen am:/); assert.match(history, /vor 39 Tagen/); assert.match(history, /Artikelzuordnung offen/); assert.match(history, /Kalenderzeitraums ist nicht nachgewiesen/);
  const abc = Q.render(Q.abc({ sourceAt: '2026-10-09T10:00:00Z', sourceQuality: quality,
    coverage: { basis: 'verified-import', periodCompleteness: 'not-established', label: 'Geprüfte importierte Kassenpositionen; die Vollständigkeit des Kalenderzeitraums ist nicht nachgewiesen.' },
    buckets: [{ id: 'unidentified-article', positions: 2 }] }), { now });
  assert.match(abc, /vor 39 Tagen/); assert.doesNotMatch(abc, /vor 1 Tag</); assert.match(abc, /Artikelzuordnung offen/);
  assert.equal(abc.match(/Kalenderzeitraums ist nicht nachgewiesen/g).length, 1);
});
