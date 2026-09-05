"use strict";
const C = require('./data-import-contract');
const metadata = C.freeze(require('./tradefoto-history-metadata.json'));
const tables = new Map(metadata.tables.map(table => [table.source + ':' + table.name, table]));
const profiles = new Map();
const snapshotFields = [
  { source: '_source_snapshot_sha256', target: 'snapshot', type: 'identifier', nullable: false },
  { source: '_source_row', target: 'ordinal', type: 'integer', nullable: false },
];
const identifier = /^(?:EAN|PEAN|SETEAN|Bonnr|Filialid|Filiale|Filialid2|Anfilialid|Bestandsfilialid|Kassenid|Kasse_ID|KUND_NR|Verkäufer_?ID|weverkaeuferid|Vorgang|KontoNr|Konto|Beleg|ZBon|Werkstatt_Id|MWST|MWST_Satz)$/iu;
function tableFor(source, name) { const table = tables.get(source + ':' + name); if (!table) C.fail('IMPORT_HISTORY_TABLE_UNKNOWN'); return table; }
for (const table of metadata.tables) {
  const entity = 'trade-history.' + C.fingerprint([table.source, table.name]).slice(0, 20);
  const fields = table.columns.map((column, index) => {
    let type;
    if (column.type === 'datetime') type = 'civil_datetime';
    else if (['repid', 'guid'].includes(column.type)) type = 'guid';
    else if ((table.keys || []).includes(column.name) || identifier.test(column.name)) type = 'identifier';
    else if (column.type === 'memo') type = 'source_text';
    else if (column.type === 'text') type = 'text';
    else if (['long', 'integer', 'byte'].includes(column.type)) type = 'integer';
    else if (column.type === 'currency') type = 'decimal';
    else if (['float', 'double'].includes(column.type)) type = 'source_decimal';
    else if (column.type === 'boolean') type = 'boolean';
    else C.fail('IMPORT_HISTORY_TYPE_UNREVIEWED');
    return { source: column.name, target: 'f' + index, type, nullable: true, ...(type === 'decimal' ? { scale: 12 } : {}) };
  });
  profiles.set(table.source + ':' + table.name, C.defineDataImportProfile({ id: entity, entity, version: 1,
    sourceSystem: table.sourceSystem, schemaSha256: table.schemaSha256, sourceTable: table.name,
    fields: [...fields, ...(table.keys ? [] : snapshotFields)], keyFields: table.keys || snapshotFields.map(f => f.source),
    dataClasses: [...new Set(table.columns.map(c => c.dataClass))] }));
}
function profileFor(source, name) { tableFor(source, name); return profiles.get(source + ':' + name); }
function expandDecimal(value) {
  const string = String(value), match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/u.exec(string);
  if (!match) return string;
  const [, sign, whole, fraction = '', exponent] = match, digits = whole + fraction, position = whole.length + Number(exponent);
  if (Math.abs(position) > 400) C.fail('IMPORT_DECIMAL_INVALID');
  return sign + (position <= 0 ? '0.' + '0'.repeat(-position) + digits : position >= digits.length ? digits + '0'.repeat(position - digits.length) : digits.slice(0, position) + '.' + digits.slice(position));
}
function prepareTradeFotoHistoryRow(source, name, raw, { fileSha256, rowNumber } = {}) {
  const table = tableFor(source, name), profile = profileFor(source, name); C.exact(raw, table.columns.map(c => c.name));
  const row = {};
  for (const field of profile.fields.filter(f => !f.source.startsWith('_source_'))) {
    if (!Object.hasOwn(raw, field.source)) C.fail('IMPORT_FIELD_MISSING');
    let value = raw[field.source];
    if (field.type === 'identifier' && typeof value === 'number') { if (!Number.isSafeInteger(value)) C.fail('IMPORT_IDENTIFIER_PRECISION'); value = String(value); }
    if (['decimal', 'source_decimal'].includes(field.type) && typeof value === 'number') { if (!Number.isFinite(value)) C.fail('IMPORT_DECIMAL_INVALID'); value = expandDecimal(value); }
    // mdb-reader Date UTC components represent Access local civil values, including time-only 1899 dates.
    if (field.type === 'civil_datetime' && value instanceof Date) { if (!Number.isFinite(value.getTime())) C.fail('IMPORT_CIVIL_DATETIME_INVALID'); value = value.toISOString().slice(0, -1); }
    row[field.source] = value;
  }
  if (!table.keys) { row._source_snapshot_sha256 = C.sha(fileSha256); row._source_row = C.integer(rowNumber, 1); }
  return row;
}
function historySource(source, name, data) { return Object.fromEntries(profileFor(source, name).fields.map(f => [f.source, data[f.target]])); }
function historyKey(source, name, data) { const row = historySource(source, name, data); return profileFor(source, name).keyFields.map(f => row[f]); }
function historyIdentity(protection, context, source, name, key) { return protection.digest(['history-source', context.scopeId, context.sourceInstance, source, name, key]); }
function historySegments(source, name, data) {
  const table = tableFor(source, name), groups = new Map();
  for (const field of profileFor(source, name).fields) {
    const dataClass = table.columns.find(c => c.name === field.source)?.dataClass || 'internal_business';
    if (!groups.has(dataClass)) groups.set(dataClass, {});
    groups.get(dataClass)[field.target] = data[field.target];
  }
  return [...groups].map(([dataClass, values]) => ({ dataClass, data: values }));
}
// Source roles remain separate; the GP employee number is never inferred from a seller ID.
function historyReferenceRequests(source, name, data) {
  const row = historySource(source, name, data), requests = [];
  for (const [field, value] of Object.entries(row)) {
    let table, role, dataClass = 'internal_business';
    if (/^KUND_NR$/iu.test(field)) { table = 'KUNDEN'; role = 'customer'; dataClass = 'customer_restricted'; }
    else if (/^(?:Verkäufer_?ID|weverkaeuferid)$/iu.test(field)) { table = 'MITARBEITER'; role = name === 'Umsatz_KASSE' ? 'header_seller' : name === 'Umsatz_Kasse_Details' ? 'line_seller' : 'seller'; dataClass = 'personnel_restricted'; }
    else if (/^(?:EAN|PEAN|SETEAN)$/u.test(field)) { table = 'ARTIKEL_STAMM'; role = field === 'SETEAN' ? 'set_article' : 'article'; }
    else if (/^(?:Filialid|Filiale|Filialid2|Anfilialid|Bestandsfilialid)$/iu.test(field)) { table = 'FILIALEN'; role = 'location.' + field.toLowerCase(); }
    if (table) requests.push({ table, role, key: value === null || value === '' ? null : [String(value)], dataClass });
  }
  return requests;
}
function historyParentRequest(source, name, data) {
  const row = historySource(source, name, data);
  if (source === 'cash' && name === 'Umsatz_Kasse_Details') return { name: 'Umsatz_KASSE', key: ['Bonnr', 'Filialid', 'Kassenid', 'Bondatum'].map(f => row[f]) };
  if (source === 'cash' && name === 'KassenJournal_Details') return { name: 'KassenJournal', key: [row.Vorgang] };
  return null;
}
module.exports = { TRADEFOTO_HISTORY_METADATA: metadata, TRADEFOTO_HISTORY_PROFILES: Object.freeze([...profiles.values()]),
  tableFor, profileFor, prepareTradeFotoHistoryRow, historySource, historyKey, historyIdentity, historySegments, historyReferenceRequests, historyParentRequest };
