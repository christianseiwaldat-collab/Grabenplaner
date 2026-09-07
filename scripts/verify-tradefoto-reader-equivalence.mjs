// Counts and keyed whole-projection/ordinal comparisons for both full sources.
// No source values or digest keys are written; no GP database is opened.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WORKER_MAX_OLD_MB } = require('../lib/tradefoto-full-import-reader');
if (process.argv.length !== 4) throw new Error('Usage: verify-tradefoto-reader-equivalence.mjs TRADE.accdb CASH.accdb');
const key = crypto.randomBytes(32), results = [], started = Date.now();
const inputs = process.argv.slice(2).map((file, i) => ({ file: fs.realpathSync(file), kind: i ? 'cash' : 'trade',
  sha256: i ? '6a7e9f3cb8404299da54aef8c5ab661d7d66e1791003ebcd62c10d60a6a4e395' : '42a40cb19d867fcc5d6e6f3429065ba0ff77f65a7b9b7fcfaae3d0b61f8154f3' }));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function run(input, mode) {
  const bytes = fs.readFileSync(input.file); assert.equal(hash(bytes), input.sha256, 'SOURCE_HASH_CHANGED');
  console.log(JSON.stringify({ phase: 'reader-comparison', source: input.kind, mode }));
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.resolve(import.meta.dirname, '../test-support/tradefoto-reader-equivalence-worker.js'), {
      workerData: { bytes: bytes.buffer, key, kind: input.kind, mode }, transferList: [bytes.buffer],
      resourceLimits: { maxOldGenerationSizeMb: mode === 'paged' ? WORKER_MAX_OLD_MB : 2048, maxYoungGenerationSizeMb: mode === 'paged' ? 32 : 64 },
    });
    let reply;
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('READER_COMPARISON_TIMEOUT')); }, 1500000);
    worker.on('message', message => { reply = message; });
    worker.on('error', () => { clearTimeout(timer); reject(new Error('READER_COMPARISON_FAILED')); });
    worker.on('exit', code => { clearTimeout(timer); if (code || !reply || reply.error) reject(new Error(reply?.error || 'READER_COMPARISON_FAILED')); else resolve(reply); });
  });
}
const report = { format: 'grabenplaner.tradefoto.reader-equivalence.v1', productionWrites: false, sourceWrites: false,
  pagedWorkerMaxOldGenerationMb: WORKER_MAX_OLD_MB, sources: results };
try {
  for (const input of inputs) {
    const before = fs.statSync(input.file).mtimeMs;
    const reference = await run(input, 'full-reference'), paged = await run(input, 'paged');
    assert.deepEqual(paged.tables, reference.tables, 'SOURCE_PROJECTION_OR_ORDER_CHANGED');
    assert.equal(hash(fs.readFileSync(input.file)), input.sha256, 'SOURCE_CHANGED'); assert.equal(fs.statSync(input.file).mtimeMs, before);
    results.push({ kind: input.kind, fileSha256: input.sha256, rows: paged.tables.reduce((n, table) => n + table.rows, 0), tables: paged.tables.length,
      allAllowedFieldsAndOrdinalsEqual: true, sourceUnchanged: true,
      countDifferences: paged.tables.filter(t => t.declared !== t.expected).map(({ name, declared, expected }) => ({ name, declared, read: expected })),
      reference: { durationMs: reference.durationMs, peakRssBytes: reference.peakRssBytes }, paged: { durationMs: paged.durationMs, peakRssBytes: paged.peakRssBytes } });
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = /^[A-Z_]+$/.test(error.message) ? error.message : 'READER_COMPARISON_FAILED'; process.exitCode = 1; }
finally {
  key.fill(0); report.durationMs = Date.now() - started;
  const root = path.resolve(import.meta.dirname, '../tmp'); fs.mkdirSync(root, { recursive: true });
  const filename = path.join(root, 'tradefoto-reader-equivalence-' + crypto.randomUUID() + '.json');
  fs.writeFileSync(filename, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ reportPath: filename, ...report }));
}
