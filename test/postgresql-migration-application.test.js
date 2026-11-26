'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {withCoreFixture}=require('../test-support/postgresql-migration/core-fixture');
const {createCoreCatalog,assertCoreCatalogLock}=require('../lib/persistence/postgresql/core/catalog');
const {PERSISTENCE_ERROR_CODES}=require('../lib/persistence/contract');
const live={skip:!process.env.GP_PG_MIGRATION_LIVE};
test('Core catalog covers the complete reviewed domain and keeps Sales unavailable',()=>{
  const catalog=createCoreCatalog();assert.equal(catalog.entries.length,1125);assert.equal(catalog.productActivation,false);
  assert.equal(new Set(catalog.entries.map(e=>e.statement.id)).size,1125);
  assert.ok(catalog.entries.every(e=>!e.statement.id.startsWith('cash-')));
  const lock=structuredClone(require('../test-support/postgresql-migration-doc-fixtures/block-4-catalog.json'));
  lock.entries[0].sqlSha256='0'.repeat(64);
  assert.throws(()=>assertCoreCatalogLock(catalog.entries.map((providerEntry,i)=>({providerEntry,provenance:catalog.provenance[i]})),lock),/qualification/);
});
test('Live Core composition reads real repository projections with identical field contracts',live,async()=>withCoreFixture(async f=>{
  const {planningSettings,organizationPersonnel,portalAccess}=f.postgresRepositories;
  assert.ok((await planningSettings.listSettings()).some(setting=>setting.key==='migration-test-owner'));
  const employees=await planningSettings.listScheduleEmployees({weekStart:'2026-09-07',weekEnd:'2026-09-13',locationId:'18',departmentId:null});
  assert.deepEqual(employees.map(employee=>employee.personnel_number).sort(),['00001','00002','00003']);
  const users=await organizationPersonnel.listPortalUsersForAdmin();
  assert.deepEqual(users.map(user=>user.personnel_number).sort(),['00001','00002','00003']);
  const principal=await portalAccess.getReportPrincipal({employeeNumber:'00002',businessDate:'2026-09-12'});
  assert.equal(principal.employee_number,'00002');
  assert.equal(principal.role,'employee');
  const developer=await organizationPersonnel.getPortalRoleProjection('developer','verkaufsmitarbeiter');
  assert.deepEqual(JSON.parse(developer.permissions),['*']);
  const {CASH_SNAPSHOT_STATEMENTS}=require('../lib/persistence/statements/cash-snapshots');
  await assert.rejects(f.postgres.queryOne(CASH_SNAPSHOT_STATEMENTS.nextSlot,{}),
    error=>[PERSISTENCE_ERROR_CODES.STATEMENT_INVALID,PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION].includes(error.code));
}));

test('Live notification cursors retain insertion order and page correctly across idempotent duplicates',live,async()=>withCoreFixture(async f=>{
  const repos=f.postgresRepositories;
  const portal=repos.portalAccess,absence=repos.absenceManagement;
  const notification={id:'message-z',employeeNumber:'00002',eventType:'synthetic.test',title:'Erster Hinweis',message:'Nur Migrationstest',target:'/?view=home',entityType:'synthetic',entityId:'test',dedupeKey:'unique-first'};
  assert.equal((await portal.insertNotification(notification)).rowsAffected,1);
  assert.equal((await portal.insertNotification(notification)).rowsAffected,0);
  assert.equal((await portal.insertNotification({...notification,id:'message-a',title:'Zweiter Hinweis',dedupeKey:'unique-second'})).rowsAffected,1);
  const first=await absence.mobileNotifications({employeeNumber:'00002',cursor:1000000,limit:1});
  assert.equal(first[0].id,'message-a');
  const second=await absence.mobileNotifications({employeeNumber:'00002',cursor:first[0].cursor_rowid,limit:1});
  assert.equal(second[0].id,'message-z');assert.ok(second[0].cursor_rowid<first[0].cursor_rowid);
  await absence.markNotificationRead({id:second[0].id,employeeNumber:'00002'});
  assert.deepEqual((await absence.mobileNotifications({employeeNumber:'00002',cursor:1000000,limit:20},true)).map(n=>n.id),['message-a']);
}));

test('Live absence approval transitions keep the same business state',live,async()=>withCoreFixture(async f=>{
  const repos=f.postgresRepositories;
  const absence=repos.absenceManagement;
  const created=await absence.insertVacationRequest({employeeNumber:'00002',locationId:'18',dateFrom:'2026-10-05',dateTo:'2026-10-09',note:'Synthetischer Antrag'});
  const id=created.rows[0].id;
  assert.equal((await absence.requestByIdVacation(id)).status,'pending_local');
  await absence.transitionVacationPendingHr({id,note:'Lokal geprüft',actor:'00003'});
  assert.equal((await absence.requestByIdVacation(id)).status,'pending_hr');
  await absence.transitionVacationHrApproved({id,note:'Freigegeben',actor:'00001'});
  const approved=await absence.requestByIdVacation(id);
  assert.deepEqual({id:approved.id,employee:approved.employee_number,status:approved.status,stage:approved.approval_stage,localBy:approved.local_approved_by,hrBy:approved.hr_approved_by},
    {id,employee:'00002',status:'approved',stage:'complete',localBy:'00003',hrBy:'00001'});
}));

test('Live concurrent Core writes respect optimistic revisions and recover after a row lock timeout',live,async()=>withCoreFixture(async f=>{
  const org=f.postgresRepositories.organizationPersonnel;
  const revision=(await org.listPermissionDefaults()).find(d=>d.kind==='role'&&d.id==='employee').revision;
  const edits=await Promise.all([
    org.updateRolePermissionDefaults({id:'employee',permissions:'["own_time:read"]',revision,customized:true}),
    org.updateRolePermissionDefaults({id:'employee',permissions:'["schedule:read"]',revision,customized:true}),
  ]);
  assert.deepEqual(edits.map(e=>e.rowsAffected).sort(),[0,1]);
  await f.migrator.query('BEGIN');await f.migrator.query('SET LOCAL ROLE gp_core_owner');
  await f.migrator.query("UPDATE gp.settings SET value=value WHERE key='migration-test-owner'");
  try {
    await assert.rejects(f.postgresRepositories.planningSettings.upsertSetting({key:'migration-test-owner',value:'blocked-write'}),{code:PERSISTENCE_ERROR_CODES.BUSY});
    assert.ok((await org.listPortalUsersForAdmin()).length===3,'Another Core read remains available');
  }finally{await f.migrator.query('ROLLBACK');}
  await f.postgresRepositories.planningSettings.upsertSetting({key:'after-lock',value:'usable'});
  assert.ok((await f.postgresRepositories.planningSettings.listSettings()).some(s=>s.key==='after-lock'&&s.value==='usable'));
}));

test('Live planning writes preserve booleans, nullable departments, week-spanning absences and rollback',live,async()=>withCoreFixture(async f=>{
  const repos=f.postgresRepositories;
  const planning=repos.planningSettings,organization=repos.organizationPersonnel;
  await planning.upsertSetting({key:'migration-display-probe',value:'kompakt'});
  await planning.upsertSetting({key:'migration-display-probe',value:'vollständig'});
  await organization.upsertScheduleNote({locationId:'18',departmentKey:'1',weekStart:'2026-09-07',noteText:'Änderung mit Umlaut',noteHtml:'<p>Änderung</p>',fontSize:'14',bold:true,italic:false,underline:true});
  const option=await planning.insertWeekOption({employeeNumber:'00002',groupId:'historical-span',weekStart:'2026-09-07',dateFrom:'2026-09-11',dateTo:'2026-09-16',optionType:'vacation',note:'Über die Wochengrenze',creditedMinutesPerDay:450,allDay:1,startTime:null,endTime:null});
  const id=option.rows[0].id;
  assert.ok((await planning.listSettings()).some(setting=>setting.key==='migration-display-probe'&&setting.value==='vollständig'));
  const note=await organization.getScheduleNote('18','1','2026-09-07');
  assert.equal(note.note_text,'Änderung mit Umlaut');
  assert.deepEqual([Number(note.bold),Number(note.italic),Number(note.underline)],[1,0,1]);
  assert.ok(Number.isFinite(Date.parse(note.updated_at)));
  const saved=await planning.getWeekOptionById({id});
  assert.deepEqual([saved.employee_number,saved.date_from,saved.date_to,saved.start_time,saved.end_time],
    ['00002','2026-09-11','2026-09-16',null,null]);
  assert.equal(Number(saved.all_day),1);
  await assert.rejects(planning.transaction(async tx=>{await tx.upsertSetting({key:'must-rollback',value:'x'});throw new Error('synthetic rollback');}),/synthetic rollback/);
  assert.ok(!(await planning.listSettings()).some(s=>s.key==='must-rollback'));
}));

test('Live role and position defaults, grants and denials retain Developer full access',live,async()=>withCoreFixture(async f=>{
  const repos=f.postgresRepositories;
  const organization=repos.organizationPersonnel;
  const defaults=await organization.listPermissionDefaults();
  const revision=defaults.find(d=>d.kind==='role'&&d.id==='employee').revision;
  assert.equal((await organization.updateRolePermissionDefaults({id:'employee',permissions:'["own_time:read","schedule:read"]',customized:true,revision})).rowsAffected,1);
  assert.equal((await organization.updateRolePermissionDefaults({id:'employee',permissions:'[]',customized:true,revision})).rowsAffected,0);
  assert.equal((await organization.updateRolePermissionDefaults({id:'developer',permissions:'[]',customized:true,revision:defaults.find(d=>d.kind==='role'&&d.id==='developer').revision})).rowsAffected,0);
  await organization.updatePositionPermissionDefaults({id:'verkaufsmitarbeiter',permissions:'["own_time:read"]',revision:0,actor:'00001'});
  await organization.insertPermissionGrant('00002','schedule:write','00001');
  await organization.insertPermissionDenial('00002','own_time:read','00001');
  const employee=await repos.portalAccess.getReportPrincipal({employeeNumber:'00002',businessDate:'2026-09-12'});
  assert.deepEqual(employee.granted_permissions,['schedule:write']);assert.deepEqual(employee.denied_permissions,['own_time:read']);
  const developer=await repos.portalAccess.getReportPrincipal({employeeNumber:'00001',businessDate:'2026-09-12'});
  assert.deepEqual(JSON.parse(developer.permissions),['*']);
  const updatedRole=(await organization.listPermissionDefaults()).find(item=>item.kind==='role'&&item.id==='employee');
  assert.equal(updatedRole.revision,revision+1);
  await organization.deletePermissionGrant('00002','schedule:write');
  await organization.deletePermissionDenial('00002','own_time:read');
  const removed=await repos.portalAccess.getReportPrincipal({employeeNumber:'00002',businessDate:'2026-09-12'});
  assert.deepEqual(removed.granted_permissions,[]);assert.deepEqual(removed.denied_permissions,[]);
}));

test('Live time entry transactions are atomic and duplicate request IDs cannot create another booking',live,async()=>withCoreFixture(async f=>{
  const input={employeeNumber:'00002',locationId:'18',departmentId:null,workDate:'2026-09-07',entryType:'clock_in',entryTimestamp:'2026-09-07T06:00:00.000Z',source:'mobile',createdBy:'00002',clientRequestId:'booking-unique',mobileSessionId:'synthetic-session'};
  const repos=f.postgresRepositories;
  const time=repos.timeTracking;
  const inserted=await time.transaction(async tx=>{const result=await tx.insertTimeEntry(input);await tx.invalidateDayReview(input);return result;});
  assert.ok(inserted.inserted.id>0);
  assert.deepEqual(await time.getClientRequestEntry(input),{id:inserted.inserted.id,entry_type:'clock_in'});
  await assert.rejects(time.insertTimeEntry(input),{code:PERSISTENCE_ERROR_CODES.UNIQUE_VIOLATION});
  const rolled={...input,clientRequestId:'must-rollback'};
  await assert.rejects(time.transaction(async tx=>{await tx.insertTimeEntry(rolled);throw new Error('rollback time');}),/rollback time/);
  assert.equal(await time.getClientRequestEntry(rolled),null);
}));

async function createProcessRun(repository,suffix){
  const processId='process-'+suffix,stepId='step-'+suffix,runId='run-'+suffix;
  await repository.insertProcess({id:processId,title:'Synthetischer Ablauf',symbol:'P',description:'Migrationstest',category:'other',scopeType:'company',locationId:null,departmentId:null,triggerType:'manual',triggerMinimumShortfall:1,status:'active',actor:'00001'});
  await repository.insertProcessStep({id:stepId,processId,sortOrder:1,type:'actor',title:'Aufgabe erledigen',description:'',responsibilityType:'employee',responsibilityReference:'00002',responsibilityLabel:'Testperson 2',conditionType:'always',conditionText:'',notificationChannels:'["internal"]'});
  await repository.insertProcessRevision({processId,revision:1,snapshotJson:JSON.stringify({id:processId,revision:1}),actor:'00001'});
  await repository.insertRun({id:runId,processId,processRevision:1,triggerType:'manual',triggerKey:'manual:'+suffix,locationId:null,departmentId:null,triggeredBy:'00001'});
  const first=await repository.insertRunStep({runId,stepId,sortOrder:1});
  const second=await repository.insertRunStep({runId,stepId,sortOrder:1});
  assert.equal(first.rowsAffected,1);assert.equal(second.rowsAffected,0);
  return {processId,runId};
}
test('Live workflows preserve revisions, idempotent steps and multi-table rollback',live,async()=>withCoreFixture(async f=>{
  const repos=f.postgresRepositories;
  const process=repos.customProcessManagement;
  await assert.rejects(process.transaction(async tx=>{await createProcessRun(tx,'rollback');throw new Error('rollback process');}),/rollback process/);
  assert.equal(await process.processById({id:'process-rollback',includeArchived:1}),null);
  const ids=await process.transaction(tx=>createProcessRun(tx,'committed'));
  const added=await process.processById({id:ids.processId,includeArchived:0});
  assert.equal(added.id,ids.processId);
  assert.equal((await process.listProcessSteps({processId:ids.processId})).length,1);
  assert.equal((await process.openRunById({id:ids.runId})).id,ids.runId);
}));

test('Live CRM preserves customer numbers, Unicode/wildcard search and optimistic revisions',live,async()=>withCoreFixture(async f=>{
  const repos=f.postgresRepositories;
  const crm=repos.crmCustomers;
  const customer={customerNumber:'000042',customerType:'private',firstName:'MÜLLER',lastName:'100%_Foto\\West',companyName:'',street:'Testgasse 1',postalCode:'6020',city:'Innsbruck',country:'Österreich',customFields:[]};
  const created=await crm.create({customer,actor:'00001',timestamp:'2020-02-29T10:00:00.000Z'});
  assert.equal(created.customerNumber,'000042');assert.equal(created.revision,1);
  for(const query of ['muller','100%_Foto','West']){const found=await crm.search({query,limit:10,offset:0});assert.equal(found.total,1,query);assert.equal(found.items[0].id,created.id);}
  const updated=await crm.update({id:created.id,customer:{firstName:'Änderung'},expectedRevision:1,actor:'00001',timestamp:'2020-03-01T10:00:00.000Z'});
  assert.equal(updated.revision,2);
  await assert.rejects(crm.update({id:created.id,customer:{firstName:'Veralteter Stand'},expectedRevision:1,actor:'00001',timestamp:'2020-03-01T11:00:00.000Z'}),{code:PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION});
  const final=await crm.get(created.id);
  assert.equal(final.firstName,'Änderung');
  assert.equal(final.customerNumber,'000042');
  assert.equal(final.revision,2);
}));
