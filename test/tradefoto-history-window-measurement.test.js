'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = import('../scripts/measure-tradefoto-history-window.mjs');
test('24 month window uses the supplied snapshot and includes its whole civil day', async () => {
  const { historyWindow, classifyCivilDate } = await helpers;
  const w = historyWindow('2026-09-04');
  assert.equal(w.fromInclusive, '2024-09-04'); assert.equal(w.toExclusive, '2026-09-05');
  assert.equal(w.clockDrivenExpiry, false);
  for (const [date, expected] of [['2024-09-03T23:59:59.999Z', 'older'], ['2024-09-04T00:00:00.000Z', 'within'],
    ['2026-09-04T23:59:59.999Z', 'within'], ['2026-09-05T00:00:00.000Z', 'future']]) {
    assert.equal(classifyCivilDate(new Date(date), w), expected);
  }
});
test('month subtraction clamps leap days and rejects invalid snapshot days', async () => {
  const { historyWindow } = await helpers;
  assert.equal(historyWindow('2024-02-29').fromInclusive, '2022-02-28');
  assert.throws(() => historyWindow('2026-02-29'));
  assert.throws(() => historyWindow('2026-09-04', 0));
});
test('missing, invalid and Access time-only values cannot qualify as old business events', async () => {
  const { historyWindow, classifyCivilDate } = await helpers; const w = historyWindow('2026-09-04');
  for (const value of [null, undefined, '2026-09-04', new Date(NaN), new Date('1899-12-30T13:00:00Z')]) {
    assert.equal(classifyCivilDate(value, w), 'unknown');
  }
});
test('recent journal lines preserve an older or undated parent and complete old lines', async () => {
  const { journalSelection } = await helpers;
  const lines = { within: 1, older: 4, unknown: 0, future: 0 };
  assert.equal(journalSelection('older', lines), 'within');
  assert.equal(journalSelection('unknown', lines), 'within');
  assert.equal(journalSelection('within', { ...lines, within: 0 }), 'within');
});
test('only fully dated old journal groups qualify for removal from an import candidate', async () => {
  const { journalSelection } = await helpers;
  const lines = { within: 0, older: 2, unknown: 0, future: 0 };
  assert.equal(journalSelection('older', lines), 'older');
  assert.equal(journalSelection('unknown', lines), 'review');
  assert.equal(journalSelection('future', lines), 'review');
  assert.equal(journalSelection('older', { ...lines, unknown: 1 }), 'review');
  assert.equal(journalSelection('older', { ...lines, future: 1 }), 'review');
});
