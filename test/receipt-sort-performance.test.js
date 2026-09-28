'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { compareRows } = require('../lib/receipt-search');

test('receipt text ordering retains German numeric, missing and tie behavior while reusing its collator', t => {
  const values = ['Bon 2', 'Bon 10', 'Bon 001', 'Bon 1', 'ÄÖÜ', 'AOU', 'Straße', 'Strasse', '€ 10', '東京', '', null, undefined];
  function previous(a, b, key, direction) {
    const l = a[key], r = b[key], missing = value => value === undefined || value === null || value === '';
    if (missing(l) !== missing(r)) return missing(l) ? 1 : -1;
    return String(l ?? '').localeCompare(String(r ?? ''), 'de-AT', { numeric: true }) * (direction === 'asc' ? 1 : -1) || a.id.localeCompare(b.id);
  }
  for (const direction of ['asc', 'desc']) for (const l of values) for (const r of values) {
    const a = { id: 'a', receipt: l }, b = { id: 'b', receipt: r };
    assert.equal(Math.sign(compareRows(a, b, 'receipt', direction)), Math.sign(previous(a, b, 'receipt', direction)));
  }
  // The existing result cache permits at most 10,000 rows. Exercise that real
  // bound with numeric receipt ordering and a deterministic unsorted sequence.
  const rows = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), receipt: 'Bon ' + ((i * 7919) % 10000) }));
  const measurements = [];
  for (let run = 0; run < 3; run++) {
    let start = performance.now(); const before = [...rows].sort((a, b) => previous(a, b, 'receipt', 'asc')); const beforeMs = performance.now() - start;
    start = performance.now(); const after = [...rows].sort((a, b) => compareRows(a, b, 'receipt', 'asc')); const afterMs = performance.now() - start;
    assert.deepEqual(after, before);
    measurements.push({ beforeMs: +beforeMs.toFixed(3), afterMs: +afterMs.toFixed(3) });
  }
  t.diagnostic('RECEIPT_SORT_PERFORMANCE ' + JSON.stringify({ synthetic: true, rows: rows.length, measurements }));
});
