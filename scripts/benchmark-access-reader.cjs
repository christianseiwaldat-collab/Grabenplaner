'use strict';

// Read-only measurement of the existing ACCDB reader. Business field values
// never enter the report. Use protected local copies of the source files.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { readTradeFotoFullSource } = require('../lib/tradefoto-full-import-source');

async function measure(file, kind) {
  const started = performance.now(), cpu = process.cpuUsage();
  const buffer = await fs.readFile(file);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const tables = [];
  let rows = 0, batches = 0, last = performance.now(), manifest;
  try {
    await readTradeFotoFullSource({ buffer, kind, send: async message => {
      if (message.type === 'manifest') manifest = message;
      else if (message.type === 'table') {
        tables.push({ name: message.name, rows: message.expectedRows, declaredRows: message.declaredRows,
          countMs: Math.round(performance.now() - last), readMs: 0 });
        last = performance.now();
      } else if (message.type === 'rows') { rows += message.rows.length; batches++; }
      else if (message.type === 'table-complete') {
        tables.at(-1).readMs = Math.round(performance.now() - last); last = performance.now();
      }
    } });
    const usage = process.cpuUsage(cpu);
    const wallMs = Math.round(performance.now() - started);
    const peakRssKiB = process.resourceUsage().maxRSS;
    // mdb-reader decrypts parts of its in-memory buffer. Check the source file,
    // not that disposable working buffer, and exclude this check from timing.
    const verified = await fs.readFile(file);
    try {
      if (crypto.createHash('sha256').update(verified).digest('hex') !== sha256) throw new Error('Source file changed');
    } finally { verified.fill(0); }
    return { kind, filename: path.basename(file), sha256, bytes: buffer.length, rows, batches,
      wallMs, cpuMs: Math.round((usage.user + usage.system) / 1000), sourceFileUnchanged: true,
      peakRssKiB, excludedTables: manifest.excludedTableNames, tables };
  } finally { buffer.fill(0); }
}

async function main() {
  const [kind, file] = process.argv.slice(2);
  if (!['trade', 'bestell', 'cash'].includes(kind) || !file) throw new Error('Usage: node scripts/benchmark-access-reader.cjs trade|bestell|cash <local.accdb>');
  const result = await measure(path.resolve(file), kind);
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
    measurement: 'source-reading-only-no-database-writes', ...result }, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.code || error.name, error.message); process.exitCode = 1; });
module.exports = { measure };
