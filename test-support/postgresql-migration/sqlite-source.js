'use strict';
const { openSqliteLegacyDatabase } = require('../../lib/persistence/sqlite/provider');
const source = require('./source-schema-v09237.json');
function createSqliteSource() {
  const database = openSqliteLegacyDatabase(':memory:');
  try {
    for (const type of ['table','index','view','trigger']) {
      for (const object of source.objects.filter(o => o.type === type)) database.exec(object.sql);
    }
    return database;
  } catch (error) { database.close(); throw error; }
}
function seedCoreFixture(db, employees = 200) {
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO cost_center_types(id,code,name,is_branch) VALUES (?,?,?,1)').run('branch','branch','Filiale');
    db.prepare('INSERT INTO cost_centers(id,code,name,type,cost_center_type_id) VALUES (?,?,?,?,?)').run('cc18','18','Synthetische Filiale','branch','branch');
    db.prepare('INSERT INTO locations(id,name,cost_center_id) VALUES (?,?,?)').run('18','Synthetische Filiale','cc18');
    db.prepare('INSERT INTO positions(id,name) VALUES (?,?)').run('verkaufsmitarbeiter','Verkauf');
    db.prepare('INSERT INTO cost_center_type_positions(cost_center_type_id,position_id) VALUES (?,?)').run('branch','verkaufsmitarbeiter');
    db.prepare('INSERT INTO departments(id,location_id,name) VALUES (?,?,?)').run(1,'18','Verkauf');
    const insert = db.prepare('INSERT INTO employees(personnel_number,full_name,nickname,home_location_id) VALUES (?,?,?,?)');
    for (let i=1;i<=employees;i++) insert.run(String(i).padStart(5,'0'),`Testperson ${i}`,`Test ${i}`,'18');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
module.exports = { createSqliteSource, seedCoreFixture };
