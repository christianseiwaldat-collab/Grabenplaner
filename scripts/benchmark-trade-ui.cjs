'use strict';

// Synthetic CPU-only comparison. This does not measure network, database or browser layout time.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '..');
const baseline = process.argv[2] || '45dbf13';
if (!/^[a-f0-9]{7,40}$/.test(baseline)) throw new Error('Expected a baseline commit hash.');
const file = 'public/trade-insight-results.js';
function readModel(source) {
  let constructors = 0;
  const context = { module: { exports: {} }, Intl: {
    Collator: Intl.Collator,
    NumberFormat: function (...args) { constructors++; return new Intl.NumberFormat(...args); },
  } };
  vm.runInNewContext(source, context);
  return { model: context.module.exports, constructors: () => constructors };
}
const before = readModel(execFileSync('git', ['show', baseline + ':' + file], { cwd: root, encoding: 'utf8' }));
const after = readModel(fs.readFileSync(path.join(root, file), 'utf8'));
function median(run) {
  run();
  const times = [];
  for (let i = 0; i < 5; i++) { const start = performance.now(); run(); times.push(performance.now() - start); }
  return Number(times.sort((a, b) => a - b)[2].toFixed(3));
}
const values = Array.from({ length: 20000 }, (_, i) => String((i - 5000) / 7));
function formatAll(model) { return values.map((value, i) => model.format(value, i % 2 ? 'money' : 'number')); }
const expected = formatAll(before.model), actual = formatAll(after.model);
if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Formatted values changed.');
const initialBefore = before.constructors(), initialAfter = after.constructors();
const formatBefore = median(() => formatAll(before.model)), formatAfter = median(() => formatAll(after.model));
const rows = Array.from({ length: 20000 }, (_, i) => ({ articleNumber: String(i), label: 'Synthetic article ' + i }));
const oldRelated = input => input.filter((r, i, a) => a.findIndex(x => x.articleNumber === r.articleNumber) === i).slice(0, 12);
if (JSON.stringify(oldRelated(rows)) !== JSON.stringify(after.model.relatedArticles(rows))) throw new Error('Related articles changed.');
console.log(JSON.stringify({
  baseline,
  environment: { node: process.version, platform: process.platform, rows: rows.length, runs: 5, statistic: 'median-ms' },
  formattedCells: { beforeMs: formatBefore, afterMs: formatAfter, identical: true,
    beforeConstructorsPerPass: (before.constructors() - initialBefore) / 6,
    afterConstructorsPerPass: (after.constructors() - initialAfter) / 6 },
  relatedArticleLinks: { beforeMs: median(() => oldRelated(rows)), afterMs: median(() => after.model.relatedArticles(rows)), identical: true },
  limitation: 'Synthetic JavaScript CPU benchmark; no claim about production end-to-end latency.',
}, null, 2));
