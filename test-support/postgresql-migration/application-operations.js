'use strict';
const assert=require('node:assert/strict');
const {createSqliteSource}=require('./sqlite-source');
const {createSqliteBranchOrderOperations}=require('../../lib/persistence/sqlite/operations/branch-orders');
const {createSqliteEmployeeLocationLendingOperations}=require('../../lib/persistence/sqlite/operations/employee-location-lendings');
const {createPostgresqlBranchOrderOperations}=require('../../lib/persistence/postgresql/application-operations/branch-orders');
const {createPostgresqlEmployeeLocationLendingOperations}=require('../../lib/persistence/postgresql/application-operations/employee-location-lendings');
const marker='block11-synthetic';
async function exercise(db,branch,lending){
 await db.prepare('INSERT INTO cost_center_types(id,code,name,is_branch) VALUES(?,?,?,1)').run(marker,marker,marker);
 await db.prepare('INSERT INTO positions(id,name) VALUES(?,?)').run(marker,marker);
 await db.prepare('INSERT INTO cost_center_type_positions(cost_center_type_id,position_id) VALUES(?,?)').run(marker,marker);
 for(const id of ['b11-a','b11-b']){
  assert.equal(await db.prepare('SELECT id FROM locations WHERE id=?').get(id),undefined);
  await db.prepare('INSERT INTO cost_centers(id,code,name,type,cost_center_type_id) VALUES(?,?,?,?,?)').run(id,id,marker,'branch',marker);
  await db.prepare('INSERT INTO locations(id,name,cost_center_id) VALUES(?,?,?)').run(id,marker+' '+id,id);
 }
 await db.prepare('INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,position_id) VALUES(?,?,?,?,?)').run(marker,marker,'B11','b11-a',marker);
 const input={id:marker,employeeNumber:marker,destinationLocationId:'b11-b',dateFrom:'2039-02-02',dateTo:'2039-02-02',allDay:false,startTime:'09:00',endTime:'12:00',actor:marker,timestamp:'2039-01-01T12:00:00.000Z'};
 const created=await lending.create(input);assert.equal(created.revision,1);
 const failures=[];
 async function rejected(work,code){await assert.rejects(async()=>work(),error=>{assert.equal(error.code,code);failures.push(code);return true;});}
 await rejected(()=>lending.create({...input,id:marker+'-overlap'}),'EMPLOYEE_LENDING_OVERLAP');
 const updated=await lending.update(input.id,{...input,revision:1,note:'Changed'});assert.equal(updated.revision,2);
 await rejected(()=>lending.update(input.id,{...input,revision:1,note:'Stale'}),'EMPLOYEE_LENDING_REVISION_CONFLICT');
 assert.equal((await lending.get(input.id)).note,'Changed');
 const cancelled=await lending.cancel(input.id,{revision:2,actor:marker,timestamp:input.timestamp});assert.equal(cancelled.status,'cancelled');
 const settings=await branch.settingsSnapshot('b11-a');
 assert.ok(settings.items.length>0);
 const catalog=await branch.catalogSnapshot('b11-a');
 const item=catalog.groups.flatMap(group=>group.items)[0];assert.ok(item);
 const draft={ownerKind:'employee',ownerAccountId:marker,updatedByLogin:marker,selectedEmployeeNumber:marker,weekStartAtSave:'2039-01-31',expectedRevision:0,items:[{itemId:item.id,quantity:2,note:'Synthetic'}]};
 const saved=await branch.saveDraft('b11-a',draft);assert.equal(saved.revision,1);
 await rejected(()=>branch.saveDraft('b11-a',draft),'BRANCH_ORDER_DRAFT_REVISION_CONFLICT');
 const read=await branch.draftSnapshot('b11-a',draft);assert.equal(read.items[0].quantity,2);
 await rejected(()=>branch.deleteDraft('b11-a',{...draft,expectedRevision:0}),'BRANCH_ORDER_DRAFT_REVISION_CONFLICT');
 await branch.deleteDraft('b11-a',{...draft,expectedRevision:1});
 assert.equal(await branch.draftSnapshot('b11-a',draft),null);
 const history=await branch.history('b11-a',10,{selectedEmployeeNumber:marker});assert.deepEqual(history,[]);
 return {created,updated,cancelled,failures,catalog:catalog.groups.map(group=>({title:group.title,items:group.items.map(x=>({title:x.title,unit:x.unit}))})),draftItem:read.items.map(x=>({quantity:x.quantity,note:x.note,itemTitle:x.itemTitle,unit:x.unit}))};
}
async function qualifyOperations(access){
 const sqlite=createSqliteSource();let expected;
 try{expected=await exercise(sqlite,createSqliteBranchOrderOperations(sqlite),createSqliteEmployeeLocationLendingOperations(sqlite));}finally{sqlite.close();}
 const abort=new Error('ROLLBACK_SYNTHETIC_11');let actual;
 try{await access.transaction(async()=>{actual=await exercise(access,createPostgresqlBranchOrderOperations(access),createPostgresqlEmployeeLocationLendingOperations(access));throw abort;});}catch(error){if(error!==abort)throw error;}
 assert.deepEqual(actual,expected);
 assert.equal(await access.prepare('SELECT id FROM locations WHERE id=?').get('b11-a'),undefined);
 return {passed:true,businessOperations:['lending-create','lending-overlap','lending-update','lending-stale-revision','lending-cancel','branch-catalog','branch-draft-save','branch-draft-stale-save','branch-draft-read','branch-draft-stale-delete','branch-draft-delete','branch-history-scope'],syntheticChangesRolledBack:true,sqliteParity:true};
}
module.exports={qualifyOperations};
