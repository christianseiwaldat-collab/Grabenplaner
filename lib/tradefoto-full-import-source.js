"use strict";
const crypto = require('node:crypto');
const C = require('./data-import-contract');
const M = require('./tradefoto-master-profiles');
const H = require('./tradefoto-history-profiles');
const MAX_BYTES = 512 * 1024 * 1024;
const READ_PAGE_ROWS = 10000;
// Reviewed technical/access tables, deliberately NOT opened or imported.
const EXCLUDED_TABLES = Object.freeze({
  trade:Object.freeze(['ARTIKEL_Etiketten','Artikel_Preisschild','Benutzer','Berichtstexte','Defaultaktualisieren','DefaultMail','dummy','Einfügefehler',
    'Feiertage','Feiertage-Standard','Grundeinstellungen','Mitarbeiter_Menue','Plugins','Shopware_Protokoll_TradeDaten','Stamm','Stamm_Artikel',
    'Standardwerte','TblErrorLog','Textbausteine','TMP_UNR','USysApplicationLog','Zugang','Zugang_Mitarbeiter','Default_Lieferanten','Protokoll','Switchboard Items']),
  cash:Object.freeze(['ARTIKEL_STAMM']), // linked table: never follow its path
});
function definitions(kind) {
  if (!['trade', 'cash'].includes(kind)) C.fail('IMPORT_SOURCE_KIND_INVALID');
  const masters = kind === 'trade' ? M.TRADEFOTO_MASTER_METADATA.tables.map(t => ({ ...t, master: true, profile: M.profileFor(t.name) })) : [];
  const priority = name => ['Umsatz_KASSE', 'KassenJournal'].includes(name) ? 0 : 1;
  const history = H.TRADEFOTO_HISTORY_METADATA.tables.filter(t => t.source === kind)
    .map(t => ({ ...t, master: false, profile: H.profileFor(kind, t.name) }))
    .sort((a,b) => priority(a.name) - priority(b.name) || a.name.localeCompare(b.name, 'en'));
  return [...masters, ...history];
}
function assertSourceBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4096 || buffer.length > MAX_BYTES) C.fail('IMPORT_SOURCE_SIZE_INVALID', 413);
  if (buffer[0] !== 0 || buffer.subarray(4,19).toString('ascii') !== 'Standard ACE DB' || ![2,3,4,5,6].includes(buffer[0x14])) C.fail('IMPORT_SOURCE_FORMAT_INVALID');
}
// Source files never reach disk or an application table. Only the allowlisted,
// credential-free field projection is sent to encrypted staging, with backpressure.
async function readTradeFotoFullSource({ buffer, kind, password = '', send, readerFactory }) {
  assertSourceBytes(buffer);
  if (typeof password !== 'string' || Buffer.byteLength(password) > 256) C.fail('IMPORT_SOURCE_PASSWORD_INVALID');
  const fileSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const defs = definitions(kind);
  const factory = readerFactory || (async (bytes, secret) => new (await import('mdb-reader')).default(bytes, { password: secret }));
  const reader = await factory(buffer, password);
  const names = reader.getTableNames();
  if(names.some(name=>!defs.some(def=>def.name===name)&&!EXCLUDED_TABLES[kind].includes(name))) C.fail('IMPORT_SOURCE_TABLE_UNCLASSIFIED');
  const plan = defs.map(def => {
    if (!names.includes(def.name)) C.fail('IMPORT_SOURCE_TABLE_MISSING');
    const table = reader.getTable(def.name);
    if (!C.equal(table.getColumnNames(), def.columns.map(c=>c.name))) C.fail('IMPORT_SOURCE_SCHEMA_CHANGED');
    const actual = table.getColumns();
    if (actual.some((c,i)=>c.type !== def.columns[i]?.type)) C.fail('IMPORT_SOURCE_SCHEMA_CHANGED');
    C.integer(table.rowCount);
    return { name: def.name, profileHash: def.profile.fingerprint, declaredRows: table.rowCount };
  });
  if (plan.reduce((n,t)=>n+t.declaredRows,0) > C.LIMITS.rows) C.fail('IMPORT_SOURCE_ROWS_LIMIT', 413);
  await send({ type: 'manifest', kind, fileSha256, bytes: buffer.length, tables: plan,
    excludedTableNames: names.filter(n=>!defs.some(d=>d.name===n)).sort() });
  let total = 0;
  for (const def of defs) {
    const table = reader.getTable(def.name);
    // Count physical active records without decoding/storing field contents.
    // This is a separate pass in the SAME parser, not independent Access-engine
    // confirmation. Keep both values so mismatch gates remain authoritative.
    const expectedRows = table.getData({ columns: [], rowOffset: 0, rowLimit: C.LIMITS.rows + 1 }).length;
    total += expectedRows;
    if (total > C.LIMITS.rows) C.fail('IMPORT_SOURCE_ROWS_LIMIT', 413);
    await send({ type: 'table', name: def.name, expectedRows, declaredRows: table.rowCount });
    // The pinned reader supports offsets/limits but not a streaming cursor.
    // Bounded 10k pages trade some repeated page-index traversal for predictable
    // memory, rather than retaining hundreds of thousands of wide source rows.
    for (let pageOffset=0; pageOffset<expectedRows; pageOffset+=READ_PAGE_ROWS) {
      const size = Math.min(READ_PAGE_ROWS, expectedRows-pageOffset);
      const rows = table.getData({ columns: def.columns.filter(c=>!c.excluded).map(c=>c.name), rowOffset: pageOffset, rowLimit: size });
      if (rows.length !== size) C.fail('IMPORT_SOURCE_READ_COUNT_CHANGED');
      for (let offset=0; offset<rows.length; offset+=C.LIMITS.batch) {
        const batch = rows.slice(offset,offset+C.LIMITS.batch).map((row,i) => def.master
          ? M.prepareTradeFotoMasterRow(def.name, row, { fileSha256, rowNumber: pageOffset+offset+i+1 })
          : H.prepareTradeFotoHistoryRow(kind, def.name, row, { fileSha256, rowNumber: pageOffset+offset+i+1 }));
        await send({ type: 'rows', name: def.name, startRow: pageOffset+offset+1, rows: batch });
      }
    }
    await send({ type: 'table-complete', name: def.name });
  }
  await send({ type: 'complete', tables: defs.length, rows: total });
}
module.exports = { MAX_BYTES, READ_PAGE_ROWS, EXCLUDED_TABLES, definitions, assertSourceBytes, readTradeFotoFullSource };
