// Offline source-manifest diagnostic. Does not open an application DB or import source rows.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { inspectTradeFotoImportInventory } = require('../lib/tradefoto-import-preflight');
const [catalogFile, tradeFile, cashFile, outputFile] = process.argv.slice(2);
if (!catalogFile || !tradeFile || !cashFile) throw new Error('Usage: check-tradefoto-import-foundation.mjs catalog.json TRADE.accdb CASH.accdb [report.json]');
const inventory = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
const preflight = inspectTradeFotoImportInventory(inventory);
async function sourceCheck(id, file) {
  const before = fs.statSync(file), hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  const after = fs.statSync(file), digest = hash.digest('hex');
  const expected = preflight.sources.find(source => source.id === id);
  return { id, matchesCatalog: expected.fileSha256 === digest && expected.bytes === after.size,
    stableDuringRead: before.size === after.size && before.mtimeMs === after.mtimeMs, sha256: digest, bytes: after.size };
}
const checks = await Promise.all([sourceCheck('trade', tradeFile), sourceCheck('cash', cashFile)]);
if (checks.some(check => !check.matchesCatalog || !check.stableDuringRead)) preflight.gates.push('SOURCE_BYTES_CHANGED');
const report = { format: 'grabenplaner.tradefoto.block2-preflight.v1', createdAt: new Date().toISOString(), checks, ...preflight,
  independentAccessCount: { status: 'not_performed_by_this_tool', outcome: 'An inventory hash comparison does not independently establish source row completeness.' },
  privacy: 'Metadata, fingerprints and counts only; no source rows or credentials.', applicationWrites: false };
if (outputFile) {
  const output = path.resolve(outputFile);
  if ([catalogFile, tradeFile, cashFile].some(file => path.resolve(file).toLowerCase() === output.toLowerCase())) throw new Error('Report must not replace an input file.');
  if (fs.existsSync(output) && JSON.parse(fs.readFileSync(output, 'utf8')).format !== report.format) throw new Error('Refusing to replace unrelated output.');
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ sourceChecks: checks, coverage: report.coverage, gates: report.gates, canImport: false, applicationWrites: false }));
