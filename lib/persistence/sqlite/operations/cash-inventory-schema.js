'use strict';
const { CASH_SNAPSHOT_TABLES: TABLES } = require('../../statements/cash-snapshots');

// The one-time baseline belongs to the schema migration, never to a request or
// restart. Missing evidence is not silently recreated. Every subsequent row
// mutation advances its generation in the same transaction as the source row.
function migrate(database, name, schema, baseline) {
  database.exec('SAVEPOINT cash_inventory_migration');
  try {
    const existing = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    database.exec(schema);
    if (!existing) database.exec(baseline);
    database.exec('RELEASE cash_inventory_migration');
  } catch (error) {
    database.exec('ROLLBACK TO cash_inventory_migration');
    database.exec('RELEASE cash_inventory_migration');
    throw error;
  }
}

function ensureSqliteCashSnapshotInventory(database) {
  const update = (index, ref, delta) => `UPDATE cash_snapshot_inventory SET row_count=row_count${delta},generation=generation+1
    WHERE dataset_slot=${ref}.dataset_slot AND table_index=${index};`;
  migrate(database, 'cash_snapshot_inventory', `
    CREATE TABLE IF NOT EXISTS cash_snapshot_inventory (
      dataset_slot INTEGER NOT NULL REFERENCES cash_snapshot_datasets(slot), table_index INTEGER NOT NULL CHECK(table_index>=0 AND table_index<${TABLES.length}),
      row_count INTEGER NOT NULL CHECK(row_count>=0), generation INTEGER NOT NULL CHECK(generation>=0),
      PRIMARY KEY(dataset_slot,table_index)
    ) WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS cash_snapshot_inventory_dataset_insert AFTER INSERT ON cash_snapshot_datasets BEGIN
      ${TABLES.map((_, i) => `INSERT INTO cash_snapshot_inventory VALUES(NEW.slot,${i},0,0);`).join('\n')}
    END;
    ${TABLES.map((t, i) => `
      CREATE TRIGGER IF NOT EXISTS ${t.sqlName}_inventory_insert AFTER INSERT ON ${t.sqlName} BEGIN ${update(i, 'NEW', '+1')} END;
      CREATE TRIGGER IF NOT EXISTS ${t.sqlName}_inventory_delete AFTER DELETE ON ${t.sqlName} BEGIN ${update(i, 'OLD', '-1')} END;
      CREATE TRIGGER IF NOT EXISTS ${t.sqlName}_inventory_update AFTER UPDATE ON ${t.sqlName} BEGIN
        ${update(i, 'OLD', '-1')} ${update(i, 'NEW', '+1')}
      END;`).join('\n')}
  `, TABLES.map((t, i) => `INSERT INTO cash_snapshot_inventory
    SELECT d.slot,${i},COUNT(r.source_row),0 FROM cash_snapshot_datasets d
    LEFT JOIN ${t.sqlName} r ON r.dataset_slot=d.slot GROUP BY d.slot;`).join('\n'));
}

function ensureSqliteCashBindingInventory(database) {
  const update = (ref, delta) => `UPDATE cash_binding_inventory SET row_count=row_count${delta},generation=generation+1 WHERE publication_id=${ref}.publication_id;`;
  migrate(database, 'cash_binding_inventory', `
    CREATE TABLE IF NOT EXISTS cash_binding_inventory (
      publication_id TEXT PRIMARY KEY REFERENCES cash_publications(id),
      row_count INTEGER NOT NULL CHECK(row_count>=0), generation INTEGER NOT NULL CHECK(generation>=0)
    ) WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS cash_binding_inventory_publication_insert AFTER INSERT ON cash_publications BEGIN
      INSERT INTO cash_binding_inventory VALUES(NEW.id,0,0);
    END;
    CREATE TRIGGER IF NOT EXISTS cash_binding_inventory_insert AFTER INSERT ON cash_publication_bindings BEGIN ${update('NEW', '+1')} END;
    CREATE TRIGGER IF NOT EXISTS cash_binding_inventory_delete AFTER DELETE ON cash_publication_bindings BEGIN ${update('OLD', '-1')} END;
    CREATE TRIGGER IF NOT EXISTS cash_binding_inventory_update AFTER UPDATE ON cash_publication_bindings BEGIN
      ${update('OLD', '-1')} ${update('NEW', '+1')}
    END;
  `, `INSERT INTO cash_binding_inventory SELECT p.id,COUNT(b.source_key),0 FROM cash_publications p
      LEFT JOIN cash_publication_bindings b ON b.publication_id=p.id GROUP BY p.id;`);
}

module.exports = { ensureSqliteCashSnapshotInventory, ensureSqliteCashBindingInventory };
