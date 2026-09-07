"use strict";
// Offline equivalence verifier only. Returns keyed digests, never source values.
const { parentPort, workerData } = require('node:worker_threads');
const crypto = require('node:crypto');
const C = require('../lib/data-import-contract');
const { readTradeFotoFullSource } = require('../lib/tradefoto-full-import-source');
async function main() {
  const buffer = Buffer.from(workerData.bytes), key = Buffer.from(workerData.key), started = Date.now();
  let peakRssBytes = 0, current, digest, cached = null;
  const tables = [];
  try {
    const { default: Reader } = await import('mdb-reader');
    const readerFactory = async bytes => {
      const reader = new Reader(bytes);
      if (workerData.mode === 'paged') return reader;
      return { getTableNames: () => reader.getTableNames(), getTable(name) {
        const table = reader.getTable(name);
        return { rowCount: table.rowCount, getColumnNames: () => table.getColumnNames(), getColumns: () => table.getColumns(), getData(options) {
          if (!options.columns.length) return table.getData(options);
          // Reference: decode the ENTIRE projected table with the old public API,
          // then split its array. Never reuse the implementation's offset reads.
          if (cached?.name !== name) {
            cached = { name, rows: table.getData({ columns: options.columns }) };
            if (cached.rows.length !== current.expected) throw new Error('SOURCE_COUNT_CHANGED');
          }
          return cached.rows.slice(options.rowOffset, options.rowOffset + options.rowLimit);
        } };
      } };
    };
    await readTradeFotoFullSource({ buffer, kind: workerData.kind, readerFactory, send: async message => {
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      if (message.type === 'table') {
        current = { name: message.name, expected: message.expectedRows, declared: message.declaredRows, rows: 0 };
        digest = crypto.createHmac('sha256', key);
      }
      if (message.type === 'rows') {
        if (message.startRow !== current.rows + 1) throw new Error('SOURCE_SEQUENCE_CHANGED');
        digest.update(C.canonical([message.startRow, message.rows])); current.rows += message.rows.length;
      }
      if (message.type === 'table-complete') {
        if (current.rows !== current.expected) throw new Error('SOURCE_COUNT_CHANGED');
        tables.push({ ...current, digest: digest.digest('hex') }); cached = null;
      }
    } });
    parentPort.postMessage({ tables, durationMs: Date.now() - started, peakRssBytes });
  } catch (error) { parentPort.postMessage({ error: error instanceof C.DataImportError ? error.code : 'READER_EQUIVALENCE_FAILED' }); }
  finally { buffer.fill(0); key.fill(0); }
}
void main();
