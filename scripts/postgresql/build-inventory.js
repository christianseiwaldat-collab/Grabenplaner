'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SQLITE_APPLICATION_CATALOG } = require('../../lib/persistence/sqlite/application-catalog');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const words = sql => new Set((sql.replace(/'(?:[^']|'')*'/g, "''").match(/[a-z_][a-z_0-9]*/gi) || []).map(s => s.toLowerCase()));
function destination(name) {
  if (/^cash_/.test(name)) return ['sales', 'kassa'];
  if (/^sales_article/.test(name)) return ['sales', 'trade'];
  if (/^sales_/.test(name)) return ['sales', 'reporting'];
  if (/^import_master_/.test(name)) return ['sales', 'trade'];
  if (/^import_history_/.test(name)) return ['sales', 'integration'];
  if (/^data_import_/.test(name) && !['data_import_runtime_keys', 'data_import_sources'].includes(name)) return ['sales', 'integration'];
  return ['core', 'gp'];
}
function buildInventory(source, baseline, files) {
  if (source.schemaSha256 !== baseline.schemaSha256) throw new Error('Live/backup schema drift; reconcile explicitly');
  const reviewed=require('../../test-support/postgresql-migration/source-schema-v09237.json');
  if(source.schemaSha256!==reviewed.schemaSha256)throw new Error('New source schema requires explicit database routing review');
  const tables = source.tables.map(table => {
    const [database, schema] = destination(table.name);
    const measured = baseline.tables.find(t => t.name === table.name);
    const owned = new Set([table.name, ...table.indexes.map(i => i.name)]);
    return { name: table.name, database, schema, rowCount: measured.rowCount,
      bytesIncludingIndexes: baseline.pageSizes.filter(s => owned.has(s.name)).reduce((n, s) => n + s.bytes, 0),
      primaryKey: table.columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name),
      copy: 'preserve-all-rows-and-identities', verification: 'canonical-content-and-relationships',
      foreignKeys: table.foreignKeys.map(f => ({ ...f, targetDatabase: destination(f.table)[0] })) };
  });
  const byName = new Map(tables.map(t => [t.name, t]));
  const objects = source.objects.map(o => {
    const owner = byName.get(o.table_name);
    const references = [...words(o.sql || '')].filter(w => byName.has(w));
    return { name: o.name, type: o.type, table: o.table_name,
      database: owner?.database || 'core', schema: owner?.schema || 'gp',
      sourceSha256: sha(o.sql || ''), references,
      treatment: o.type === 'trigger' ? 'port-and-test-business-rule' : o.type === 'index' ? 'equivalent-query-and-constraint-contract' : 'preserve-contract' };
  });
  const statements = SQLITE_APPLICATION_CATALOG.map(e => {
    const identifiers = words(e.sql);
    const references = tables.filter(t => identifiers.has(t.name));
    const databases = [...new Set(references.map(t => t.database))].sort();
    return { id: e.statement.id, operation: e.statement.operation, references: references.map(t => t.name),
      databases, boundary: databases.length > 1 ? 'core-sales-contract-block-7' : databases[0] || 'inspect-runtime-context',
      sourceSha256: sha(e.sql) };
  });
  return { version: 1, sourceCommit: 'c6b8a112e79514f39bbd0ce9906c54f052e45e40',
    schemaSha256: source.schemaSha256, backupFileName: baseline.fileName,
    dataLayout: 'two-databases', databaseNames: {core:'grabenplaner_core', sales:'grabenplaner_sales'},
    summary: { objects: source.objectCounts, tablesByDatabase: Object.fromEntries(['core', 'sales'].map(d => [d, tables.filter(t => t.database === d).length])),
      bytesByDatabase: Object.fromEntries(['core', 'sales'].map(d => [d, tables.filter(t => t.database === d).reduce((n,t) => n+t.bytesIncludingIndexes,0)])),
      statements: statements.length, crossDatabaseStatements: statements.filter(s => s.databases.length > 1).length },
    tables, objects, statements, files };
}
if (require.main === module) {
  const [live, backup, files, output] = process.argv.slice(2);
  if (![live,backup,files,output].every(Boolean)) throw new Error('live backup files output required');
  const result = buildInventory(read(live), read(backup), read(files));
  fs.mkdirSync(path.dirname(output), {recursive:true});
  fs.writeFileSync(output, JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result.summary,null,2));
}
module.exports = { buildInventory };
