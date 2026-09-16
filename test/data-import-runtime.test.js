"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const C=require('../lib/data-import-contract');
const M=require('../lib/tradefoto-master-profiles'),H=require('../lib/tradefoto-history-profiles');
const {openSqliteApplicationPersistence}=require('../lib/persistence/sqlite/provider');
const {SQLITE_APPLICATION_CATALOG}=require('../lib/persistence/sqlite/application-catalog');
const {ensureSqliteDataImportRuntimeSchema,DATA_IMPORT_RUNTIME_SCHEMA_SQL}=require('../lib/persistence/sqlite/operations/data-import-runtime-schema');
const {SQLITE_DATA_IMPORT_RUNTIME_CATALOG}=require('../lib/persistence/sqlite/data-import-runtime-catalog');
const {compilePostgresqlDialectEntry}=require('../lib/persistence/postgresql/dialect-compiler');
const {createIntegrationSecretVault}=require('../lib/integration-secret-vault');
const {loadManagedDataImportProtection}=require('../lib/data-import-managed-protection');
const {createDataImportRuntime}=require('../lib/persistence/repositories/data-import-runtime');
const {createDataImportMappingRuntime}=require('../lib/persistence/repositories/data-import-mapping-runtime');
const {createManagedSalesHistoryRuntime}=require('../lib/persistence/repositories/sales-history-runtime');
const {buildDataImportMappingProjection}=require('../lib/data-import-mapping-access');
const {ensureSqliteCrmSchema}=require('../lib/persistence/sqlite/operations/crm-schema');
const {readTradeFotoFullSource,definitions,READ_PAGE_ROWS}=require('../lib/tradefoto-full-import-source');
const {DATA_IMPORT_PERMISSIONS:P,buildDataImportProjection,dataImportPermissionDependencies}=require('../lib/data-import-access');
const TIME='2026-09-05T12:00:00.000Z',code=wanted=>e=>e?.code===wanted;
const sourceBuffer=()=>{const b=Buffer.alloc(4096);b.write('Standard ACE DB',4);b[0x14]=3;return b;};
const base=()=>({employeeNumber:'synthetic-1',accountId:'personal-1',isEmployee:true,role:'developer',permissions:[...Object.values(P),'sales:analytics:access','sales:analytics:company:read']});
const vault=()=>createIntegrationSecretVault({activeKeyId:'synthetic',keys:{synthetic:Buffer.alloc(32,7)}});
function readerFactory(kind,values={},counts={}) {
  const defs=definitions(kind);
  return ()=>({getTableNames:()=>defs.map(d=>d.name),getTable:name=>{
    const def=defs.find(d=>d.name===name),rows=values[name]||[];
    return {rowCount:counts[name]??rows.length,getColumnNames:()=>def.columns.map(c=>c.name),getColumns:()=>def.columns.map(c=>({name:c.name,type:c.type})),
      getData:({columns,rowOffset=0,rowLimit=Infinity})=>rows.slice(rowOffset,rowOffset+rowLimit).map(row=>Object.fromEntries(columns.map(key=>[key,row[key]??null])))};
  }});
}
const rawMaster=(name,extra)=>({...Object.fromEntries(M.tableFor(name).columns.map(c=>[c.name,null])),...extra});
const rawHistory=(name,extra)=>({...Object.fromEntries(H.tableFor('cash',name).columns.map(c=>[c.name,null])),...extra});
async function fixture(t,{kind='trade',values={},counts={},allowApply=true}={}) {
  const app=openSqliteApplicationPersistence({databasePath:':memory:',catalog:SQLITE_APPLICATION_CATALOG});
  ensureSqliteDataImportRuntimeSchema(app.database);ensureSqliteDataImportRuntimeSchema(app.database);
  const state={session:base(),failAfter:0,messages:0},getSession=async()=>state.session,keyVault=vault();
  const readSource=options=>readTradeFotoFullSource({...options,send:async message=>{
    state.messages++;state.beforeMessage?.(message);if(state.failAfter&&state.messages===state.failAfter)throw new C.DataImportError('IMPORT_SOURCE_INTERRUPTED',409);
    const result=await options.onMessage(message);
    await state.afterMessage?.(message);
    if(message.type==='complete'&&state.failAfterComplete)throw new C.DataImportError('IMPORT_SOURCE_INTERRUPTED',409);
    return result;
  },readerFactory:readerFactory(kind,values,counts)});
  const options={access:app.provider,vault:keyVault,allowApply,readSource,clock:()=>TIME};
  let runtime=createDataImportRuntime(options);
  const upload=(buffer=sourceBuffer())=>runtime.upload(getSession,{buffer,kind});
  const reload=()=>{runtime=createDataImportRuntime(options);return runtime;};
  async function finish(source,action) {let n=0;do {source=await runtime.sourceOperation(getSession,source.id,action,{expectedRevision:source.revision});
    if(++n>700)throw new Error('Synthetic loop did not terminate');}while(source.status===({review:'reviewing',apply:'applying',undo:'reverting'}[action]));return source;}
  t.after(async()=>{await app.provider.close();app.database.close();});
  return {...app,state,getSession,keyVault,options,upload,reload,finish,get runtime(){return runtime;}};
}

test('original upload names remain encrypted and survive reservation, background reading and reconstruction for all three databases',async t=>{
  for(const kind of ['trade','cash','bestell']) {
    const f=await fixture(t,{kind});
    f.options.compactCash=true;f.reload();
    const fileName=`Original_${kind}_Ü.accdb`;
    const reserved=await f.runtime.reserve(f.getSession,{buffer:sourceBuffer(),kind,fileName});
    assert.equal(reserved.fileName,fileName);
    assert.ok(f.database.prepare('SELECT payload FROM data_import_sources').all().every(row=>!row.payload.includes(fileName)));
    const completed=await f.upload();assert.equal(completed.fileName,fileName);
    const runtime=f.reload();assert.equal((await runtime.list(f.getSession)).items[0].fileName,fileName);
    const repeated=await runtime.upload(f.getSession,{buffer:sourceBuffer(),kind,fileName:'Renamed.accdb'});
    assert.equal(repeated.id,completed.id);assert.equal(repeated.fileName,fileName);
  }
});

test('Bestell: full staged source, exact values, replay, changed snapshot and undo preserve the prior version',async t=>{
  const B=require('../lib/tradefoto-bestell/profiles');
  const {createImportHistoryService}=require('../lib/persistence/repositories/import-history');
  const raw={...Object.fromEntries(B.tableFor('Reparatur').columns.map(c=>[c.name,null])),
    ReparaturNr:17,FilialId:'018',Anlegedatum:new Date('2026-01-03T09:15:00Z'),
    AName:'Synthetic camera',Fehler:'Private synthetic memo\u0001'.repeat(200),EK_Netto:123.456789,erledigt:false};
  const values={Reparatur:[raw]};
  const f=await fixture(t,{kind:'bestell',values});
  f.options.sharedPayloads=true;f.reload();
  let source=await f.upload();
  assert.equal(source.kind,'bestell');assert.equal(source.tables.length,21);
  assert.equal(f.database.prepare('SELECT count(*) n FROM import_history_records').get().n,0);
  source=await f.finish(source,'review');assert.equal(source.status,'ready');
  source=await f.finish(source,'apply');assert.equal(source.status,'applied');
  const record=f.database.prepare('SELECT * FROM import_history_records').get();
  assert.equal(record.source_instance,'tradefoto-bestell');assert.equal(record.source,'trade');
  assert.equal(f.database.prepare("SELECT count(*) n FROM import_history_records WHERE source='cash'").get().n,0);
  const protection=await loadManagedDataImportProtection({access:f.provider,vault:f.keyVault});
  t.after(()=>protection.destroy());
  const service=createImportHistoryService({access:f.provider,protection,getActor:()=>({scopeId:'grabenplaner-main',ownerId:'synthetic-1'}),authorize:()=>true});
  const before=await service.detail(record.id);
  assert.equal(before.fields.FilialId,'018');assert.equal(before.fields.EK_Netto,'123.456789');
  assert.equal(before.fields.Anlegedatum,'2026-01-03T09:15:00.000');assert.equal(before.fields.Fehler,raw.Fehler);
  assert.ok(f.database.prepare('SELECT count(*) n FROM data_import_payload_blocks').get().n>0);
  assert.ok(f.database.prepare('SELECT payload FROM import_history_segments').all().every(r=>!r.payload.includes('Private synthetic')));
  f.reload();assert.equal((await f.upload()).id,source.id);
  assert.equal((await service.detail(record.id)).revision,1);
  const changed=sourceBuffer();changed[4095]=1;raw.erledigt=true;
  let next=await f.upload(changed);assert.notEqual(next.id,source.id);
  next=await f.finish(next,'review');next=await f.finish(next,'apply');
  assert.equal((await service.detail(record.id)).fields.erledigt,true);
  next=await f.finish(next,'undo');assert.equal(next.status,'reverted');
  assert.deepEqual((await service.detail(record.id)).fields,before.fields);
});

test('Bestell: excluded tables are never opened and an incomplete source cannot be activated',async t=>{
  const {EXCLUDED_TABLES}=require('../lib/tradefoto-full-import-source');
  const defs=definitions('bestell'),opened=[];
  const reader=readerFactory('bestell')();
  await readTradeFotoFullSource({buffer:sourceBuffer(),kind:'bestell',send:()=>{},readerFactory:()=>({
    getTableNames:()=>[...defs.map(d=>d.name),...EXCLUDED_TABLES.bestell],
    getTable:name=>{opened.push(name);return reader.getTable(name);}})});
  assert.deepEqual(opened.filter(name=>EXCLUDED_TABLES.bestell.includes(name)),[]);
  assert.ok(EXCLUDED_TABLES.bestell.includes('Kasse_Zeiterfassung'));
  const f=await fixture(t,{kind:'bestell',counts:{BESTELLUNGEN:1}});
  let source=await f.upload();source=await f.finish(source,'review');
  assert.equal(source.status,'needs_review');
  await assert.rejects(f.runtime.sourceOperation(f.getSession,source.id,'apply',{expectedRevision:source.revision}),code('IMPORT_DECISION_GATE'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM import_history_records').get().n,0);
});

test('Bestell: repairs missing from later exports remain readable and reappear under the same branch-specific identity',async t=>{
  const B=require('../lib/tradefoto-bestell/profiles');
  const {createImportHistoryService}=require('../lib/persistence/repositories/import-history');
  const raw=(branch,extra={})=>({...Object.fromEntries(B.tableFor('Reparatur').columns.map(c=>[c.name,null])),
    ReparaturNr:17,FilialId:branch,Anlegedatum:new Date('2026-01-03T09:15:00Z'),
    AName:'Synthetic camera',erledigt:true,...extra});
  const repair18=raw('018'),repair05=raw('005',{erledigt:false});
  const values={Reparatur:[repair18,repair05]},f=await fixture(t,{kind:'bestell',values});
  f.options.sharedPayloads=true;f.reload();
  async function importVersion(marker) {
    const bytes=sourceBuffer();bytes[4095]=marker;
    let source=await f.upload(bytes);source=await f.finish(source,'review');
    assert.equal(source.status,'ready');source=await f.finish(source,'apply');
    assert.equal(source.status,'applied');return source;
  }
  await importVersion(1);
  const protection=await loadManagedDataImportProtection({access:f.provider,vault:f.keyVault});
  t.after(()=>protection.destroy());
  const service=createImportHistoryService({access:f.provider,protection,
    getActor:()=>({scopeId:'grabenplaner-main',ownerId:'synthetic-1'}),authorize:()=>true});
  const list=()=>service.list({source:'trade',table:'Reparatur',sourceInstance:'tradefoto-bestell'});
  const original=(await list()).items;
  assert.equal(original.length,2);assert.notEqual(original[0].id,original[1].id);
  const before18=original.find(r=>r.fields.FilialId==='018'),before05=original.find(r=>r.fields.FilialId==='005');

  values.Reparatur=[repair05];await importVersion(2);f.reload();
  assert.equal((await list()).items.length,2);
  assert.deepEqual(await service.detail(before18.id),before18);
  // Even an otherwise valid export with an empty repair table is not deletion
  // authority. The archived case retains its own original source provenance.
  values.Reparatur=[];await importVersion(3);
  assert.equal((await list()).items.length,2);
  assert.deepEqual(await service.detail(before18.id),before18);
  assert.deepEqual(await service.detail(before05.id),before05);

  values.Reparatur=[{...repair18,Fehler:'Synthetic later source correction'}];
  await importVersion(4);
  const after=await service.detail(before18.id);
  assert.equal(after.id,before18.id);assert.equal(after.revision,2);
  assert.equal(after.fields.Fehler,'Synthetic later source correction');
  assert.equal(after.fields.erledigt,true);
  // TradeRepair's flag never invents collection or payment dates in the GP.
  for(const field of ['AbzuholenDatum','AbgeholtDatum','Bezahlt_Datum'])assert.equal(after.fields[field],null);
  assert.deepEqual((await service.detail(before18.id,{revision:1})).fields,before18.fields);
  assert.deepEqual(await service.detail(before05.id),before05);
  assert.equal((await list()).items.length,2);
});
test('Q01: managed source persists accepted counts and audit across restart without activating closed targets',async t=>{
  const f=await fixture(t,{allowApply:false,values:{KUNDEN:[rawMaster('KUNDEN',{KUND_NR:'test-customer'})]},counts:{KUNDEN:2}});
  const profile=M.profileFor('KUNDEN');
  const proof=require('../lib/data-import-source-tolerance').defineDataImportSourceTolerance({id:'synthetic-runtime-count-approval',recordedAt:TIME,
    approvalReference:'synthetic-test-only',reason:'Synthetic mismatch fixture',evidenceReference:'synthetic-evidence',sourceSystem:profile.sourceSystem,
    sourceTable:profile.sourceTable,profileHash:profile.fingerprint,sourceInstance:'tradefoto-trade',schemaSha256:profile.schemaSha256,
    fileSha256:crypto.createHash('sha256').update(sourceBuffer()).digest('hex'),declaredRows:2,expectedRows:1});
  f.options.sourceTolerances=[proof];f.reload();
  let source=await f.upload();source=await f.finish(source,'review');
  const table=source.tables.find(t=>t.name==='KUNDEN');
  assert.deepEqual(table.run.gates,[]);assert.deepEqual(table.run.acceptedDeviations,[proof]);assert.equal(table.declaredRows,2);
  f.reload();assert.equal((await f.upload()).id,source.id);
  const events=await f.runtime.sourceOperation(f.getSession,source.id,'events',{runId:table.run.id});
  assert.equal(events.filter(e=>e.action==='import.source-tolerance.accepted').length,1);
  await assert.rejects(f.runtime.sourceOperation(f.getSession,source.id,'apply',{expectedRevision:source.revision}),code('IMPORT_NOT_ACTIVATED'));
  f.options.allowApply=true;f.reload();source=await f.finish(source,'apply');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM import_master_records').get().n,1);
  source=await f.finish(source,'undo');assert.equal(source.status,'reverted');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM import_master_records').get().n,0);
});

test('Productive Block 1: rights are cumulative, personal and not granted by a role name',()=>{
  assert.equal(buildDataImportProjection(base()).prepare,true);
  for(const change of [{permissions:[]},{employeeNumber:null},{isEmployee:false},{mustChangePassword:true},{sessionKind:'organization'},
    {permissions:[...Object.values(P),'sales:analytics:access']}])assert.equal(buildDataImportProjection({...base(),...change}).read,false);
  assert.equal(dataImportPermissionDependencies(base().permissions).valid,true);
  assert.equal(dataImportPermissionDependencies([P.APPLY]).valid,false);
});
test('Productive Block 1: empty schema is idempotent and all runtime statements compile for PostgreSQL',async t=>{
  const f=await fixture(t);assert.equal(f.database.prepare('SELECT COUNT(*) n FROM data_import_runtime_keys').get().n,0);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM data_import_sources').get().n,0);
  assert.equal((await f.runtime.context(f.getSession)).available,true);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM data_import_runtime_keys').get().n,0);
  for(const entry of SQLITE_DATA_IMPORT_RUNTIME_CATALOG)assert.ok(compilePostgresqlDialectEntry(entry));
  assert.doesNotMatch(DATA_IMPORT_RUNTIME_SCHEMA_SQL,/rowid|AUTOINCREMENT|json_extract/i);
});

test('Shared evidence: managed runtime opt-in preserves recovery, keys and closed activation',async t=>{
  const note='Synthetic private note. '.repeat(100);
  const f=await fixture(t,{allowApply:false,values:{KUNDEN:[rawMaster('KUNDEN',{KUND_NR:'shared-customer',NACHNAME:note})]}});
  assert.throws(()=>createDataImportRuntime({...f.options,sharedPayloads:'true'}),code('IMPORT_COMPOSITION_INVALID'));
  f.options.sharedPayloads=true; f.reload();
  let source=await f.upload(); source=await f.finish(source,'review');
  assert.ok(f.database.prepare('SELECT COUNT(*) n FROM data_import_payload_blocks').get().n>0);
  assert.ok(f.database.prepare('SELECT COUNT(*) n FROM data_import_row_payload_refs').get().n>0);
  const keys=f.database.prepare('SELECT * FROM data_import_runtime_keys').all();
  assert.equal(keys.length,1);
  await assert.rejects(f.runtime.sourceOperation(f.getSession,source.id,'apply',{expectedRevision:source.revision}),code('IMPORT_NOT_ACTIVATED'));
  // A restart with the default legacy writer still understands existing roots.
  f.options.sharedPayloads=false; f.options.allowApply=true; f.reload();
  source=await f.finish(source,'apply'); assert.equal(source.status,'applied');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM import_master_records').get().n,1);
  source=await f.finish(source,'undo'); assert.equal(source.status,'reverted');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM import_master_records').get().n,0);
  assert.deepEqual(f.database.prepare('SELECT * FROM data_import_runtime_keys').all(),keys);
});

test('Productive Block 2: mapping rights require personal import and separate business capabilities',()=>{
  const s=base(); assert.equal(buildDataImportMappingProjection(s).read,false);
  s.permissions.push('crm:access','crm:customers:read'); let p=buildDataImportMappingProjection(s);
  assert.deepEqual(p.tables,[{table:'KUNDEN',label:'Kunden / CRM',write:false,undo:false}]);
  s.permissions.push('crm:customers:write'); assert.equal(buildDataImportMappingProjection(s).tables[0].write,true);
  s.permissions.push('employees:read','employees:write'); assert.equal(buildDataImportMappingProjection(s).tables.length,1);
  s.permissions.push('personnel:central:read','personnel:central:write'); assert.equal(buildDataImportMappingProjection(s).tables.find(t=>t.table==='MITARBEITER').write,true);
  s.sessionKind='organization';assert.equal(buildDataImportMappingProjection(s).read,false);
});

test('Productive Block 2: managed mapping previews keep activation closed and deliberate create/undo is audited',async t=>{
  const f=await fixture(t,{values:{KUNDEN:[rawMaster('KUNDEN',{KUND_NR:'000419',VORNAME:'Synthetic',NACHNAME:'Mapping'})]}});
  f.database.exec('CREATE TABLE audit_log(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity_type TEXT,entity_id TEXT,detail TEXT,created_at TEXT);');
  ensureSqliteCrmSchema(f.database);
  f.state.session.permissions.push('crm:access','crm:customers:read','crm:customers:write');
  const config={access:f.provider,vault:f.keyVault}, closed=createDataImportMappingRuntime(config);
  assert.equal((await closed.operation(f.getSession,'context')).activationEnabled,false);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM data_import_runtime_keys').get().n,0);
  let source=await f.upload();source=await f.finish(source,'review');await f.finish(source,'apply');
  const list=await closed.operation(f.getSession,'search',{table:'KUNDEN',key:'000419'});
  assert.equal(list.items.length,1);const row=list.items[0];
  assert.doesNotMatch(JSON.stringify(row),/payload|Kennwort|Konto|Passwort/);
  const input={table:'KUNDEN',request:{recordId:row.id,expectedSourceRevision:1,decision:{customerType:'private'}}};
  const preview=await closed.operation(f.getSession,'preview',input);
  await assert.rejects(closed.operation(f.getSession,'apply',{...input,planHash:preview.planHash}),code('IMPORT_NOT_ACTIVATED'));
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM crm_customers').get().n,0);
  const active=createDataImportMappingRuntime({...config,allowMapping:true});
  const saved=await active.operation(f.getSession,'apply',{...input,planHash:preview.planHash});
  assert.equal(f.database.prepare('SELECT account_number FROM crm_customers').get().account_number,'000419');
  assert.equal(f.database.prepare('SELECT customer_number FROM crm_customers').get().customer_number,null);
  await assert.rejects(active.operation(f.getSession,'apply',{...input,planHash:preview.planHash}),code('IMPORT_PREVIEW_CHANGED'));
  await assert.rejects(active.operation(f.getSession,'search',{table:'MITARBEITER'}),code('IMPORT_FORBIDDEN'));
  await assert.rejects(active.operation(f.getSession,'search',{table:'KUNDEN',sourceInstance:'foreign'}),code('IMPORT_SHAPE_INVALID'));
  await active.operation(f.getSession,'undo',{table:'KUNDEN',eventId:saved.eventId});
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM crm_customers').get().n,0);
  assert.ok(f.database.prepare('SELECT COUNT(*) n FROM audit_log').get().n>=2);
});

test('Productive Block 2: a rights change before a mapping write rejects the old preview',async t=>{
  const f=await fixture(t);f.state.session.permissions.push('crm:access','crm:customers:read','crm:customers:write');
  const mapping=createDataImportMappingRuntime({access:f.provider,vault:f.keyVault,allowMapping:true});
  await loadManagedDataImportProtection({access:f.provider,vault:f.keyVault,create:true}).then(p=>p.destroy());
  let calls=0;const get=async()=>{calls++;if(calls===2)f.state.session.permissions=f.state.session.permissions.filter(p=>p!=='crm:customers:write');return f.state.session;};
  await assert.rejects(mapping.operation(get,'apply',{table:'KUNDEN',request:{},planHash:'a'.repeat(64)}),code('IMPORT_FORBIDDEN'));
});

test('Productive Block 2: managed sales composition cannot activate itself or provision keys',async t=>{
  const f=await fixture(t);f.state.session.permissions.push('sales:history:read');
  const runtime=createManagedSalesHistoryRuntime({access:f.provider,vault:f.keyVault});
  assert.equal(await runtime.run(f.getSession,workspace=>workspace),null);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM data_import_runtime_keys').get().n,0);
  const empty=createManagedSalesHistoryRuntime({access:f.provider,vault:f.keyVault,enabled:true});
  assert.equal(await empty.run(f.getSession,workspace=>workspace),null);
  f.state.session.mustChangePassword=true;await assert.rejects(runtime.run(f.getSession,()=>null),code('IMPORT_FORBIDDEN'));
});

test('Productive Block 2: managed sales continuation reopens keys safely and never bypasses missing receipt proof',async t=>{
  const h=rawHistory('Umsatz_KASSE',{Bonnr:'1',Filialid:'18',Kassenid:'18',Bondatum:'2026-09-04T00:00:00.000',RechnungsBetrag:'201'});
  const lines=Array.from({length:201},(_,i)=>rawHistory('Umsatz_Kasse_Details',{Bonnr:'1',Filialid:'18',Kassenid:'18',Bondatum:h.Bondatum,
    RepID:'00000000-0000-0000-0000-'+String(i+1).padStart(12,'0'),EAN:'000050',VKMenge:'1',VK_Preis:'1'}));
  const f=await fixture(t,{kind:'cash',values:{Umsatz_KASSE:[h],Umsatz_Kasse_Details:lines}});
  let source=await f.upload();source=await f.finish(source,'review');await f.finish(source,'apply');
  f.state.session.permissions.push('sales:history:read','sales:history:unassigned:read');
  const runtime=createManagedSalesHistoryRuntime({access:f.provider,vault:f.keyVault,enabled:true,today:()=> '2026-09-05',sources:[{
    id:'cash',label:'Synthetische Kasse',scopeId:'grabenplaner-main',sourceInstance:'tradefoto-cash',locations:[],snapshots:[],coverageLabel:'Nur synthetische Daten'}]});
  const query={sourceId:'cash'},result=await runtime.run(f.getSession,w=>w.search(query));
  assert.equal(result.coverage.counts.records,200);assert.ok(result.analysis.cursor);assert.equal(result.totals,null);
  const done=await runtime.run(f.getSession,w=>w.analyze({query,cursor:result.analysis.cursor}));
  assert.equal(done.coverage.complete,true);assert.equal(done.coverage.counts.records,201);assert.equal(done.totals,null);
  assert.ok(done.coverage.issues.includes('RECEIPT_SOURCE_COVERAGE_UNCONFIRMED'));
  f.state.session.permissions=[];await assert.rejects(runtime.run(f.getSession,w=>w.search(query)),code('IMPORT_FORBIDDEN'));
});
test('Productive Block 1: managed keys survive a new vault instance and fail closed with the wrong backup key',async t=>{
  const f=await fixture(t);
  assert.equal(await loadManagedDataImportProtection({access:f.provider,vault:f.keyVault}),null);
  const p=await loadManagedDataImportProtection({access:f.provider,vault:f.keyVault,create:true,clock:()=>TIME});
  const sealed=p.seal({note:'synthetic private'},['test']),digest=p.digest(['stable']);p.destroy();
  const restored=await loadManagedDataImportProtection({access:f.provider,vault:vault()});
  assert.equal(restored.digest(['stable']),digest);assert.equal(restored.open(sealed,['test']).note,'synthetic private');restored.destroy();
  const before=f.database.prepare('SELECT payload FROM data_import_runtime_keys').get().payload;
  const wrong=createIntegrationSecretVault({activeKeyId:'synthetic',keys:{synthetic:Buffer.alloc(32,8)}});
  await assert.rejects(loadManagedDataImportProtection({access:f.provider,vault:wrong,create:true}),code('IMPORT_VAULT_UNAVAILABLE'));
  const unavailable=createDataImportRuntime({...f.options,vault:wrong});assert.equal((await unavailable.context(f.getSession)).available,false);
  assert.equal(f.database.prepare('SELECT payload FROM data_import_runtime_keys').get().payload,before);
});
test('Productive Block 1: synthetic source preview persists encrypted rows and does not write business targets',async t=>{
  const values={FILIALEN:[rawMaster('FILIALEN',{Nummer:1})]};
  // Choose a valid identifier from the pinned source profile, not a GP target.
  const key=M.profileFor('FILIALEN').keyFields[0];values.FILIALEN[0][key]=1;
  const f=await fixture(t,{values,allowApply:false});let source=await f.upload();
  assert.equal(source.complete,true);assert.equal(source.tables.length,definitions('trade').length);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM import_master_records').get().n,0);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM import_history_records').get().n,0);
  source=await f.finish(source,'review');assert.equal(source.status,'ready');
  const strings=f.database.prepare('SELECT payload FROM data_import_rows').all();assert.ok(strings.every(row=>/^gp-import-v[12]:/.test(row.payload)));
  await assert.rejects(f.runtime.sourceOperation(f.getSession,source.id,'apply',{expectedRevision:source.revision}),code('IMPORT_NOT_ACTIVATED'));
  const sourceBytes=sourceBuffer();await f.runtime.upload(f.getSession,{buffer:sourceBytes,kind:'trade'});assert.ok(sourceBytes.every(b=>b===0));
});
test('Productive Block 1: interrupted staging resumes the same source across runtime restart without duplicate rows',async t=>{
  const key=M.profileFor('FILIALEN').keyFields[0],f=await fixture(t,{values:{FILIALEN:[rawMaster('FILIALEN',{[key]:1})]}});
  f.state.failAfter=8;await assert.rejects(f.upload(),code('IMPORT_SOURCE_INTERRUPTED'));
  let list=await f.runtime.list(f.getSession),id=list.items[0].id;assert.equal(list.items[0].status,'interrupted');
  f.state.failAfter=0;f.reload();const source=await f.upload();assert.equal(source.id,id);assert.equal(source.complete,true);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM data_import_rows').get().n,1);
  const count=f.database.prepare('SELECT COUNT(*) n FROM data_import_runs').get().n;
  await f.upload();assert.equal(f.database.prepare('SELECT COUNT(*) n FROM data_import_runs').get().n,count);
});
test('maintenance persists an interrupted import, drains it, and resumes at the committed offset without duplicates',async t=>{
  const {createDataImportLifecycle}=require('../lib/data-import-lifecycle');
  const values={FILIALEN:Array.from({length:401},(_,i)=>rawMaster('FILIALEN',{FilialID:String(i+1)}))};
  const f=await fixture(t,{values});f.options.lifecycle=createDataImportLifecycle();f.reload();
  let release,started;const pending=new Promise(r=>release=r),entered=new Promise(r=>started=r);
  f.state.afterMessage=async m=>{if(m.type==='rows'){started();await pending;}};
  const rejected=assert.rejects(f.upload(),code('IMPORT_SOURCE_INTERRUPTED'));await entered;
  const stopping=f.runtime.stop();let drained=false;void stopping.then(()=>{drained=true;});
  await new Promise(r=>setImmediate(r));assert.equal(drained,false);
  release();await rejected;await stopping;
  let source=(await f.runtime.list(f.getSession)).items[0];
  assert.equal(source.status,'interrupted');assert.equal(source.complete,false);
  const first=source.tables.find(t=>t.name==='FILIALEN');assert.equal(first.run.receivedRows,200);
  await assert.rejects(f.upload(),code('IMPORT_MAINTENANCE'));
  f.state.afterMessage=null;const offsets=[];f.state.beforeMessage=m=>{if(m.type==='rows')offsets.push(m.startRow);};
  f.options.lifecycle=createDataImportLifecycle();f.reload();source=await f.upload();
  assert.equal(source.complete,true);assert.deepEqual(offsets,[201,401]);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM data_import_rows').get().n,401);
});

test('Productive Block 1: changed owners cannot list/read/advance another account source and revoked rights stop staging',async t=>{
  const f=await fixture(t);const source=await f.upload();f.state.session={...base(),employeeNumber:'synthetic-2',accountId:'personal-2'};
  assert.equal((await f.runtime.list(f.getSession)).items.length,0);
  await assert.rejects(f.runtime.sourceOperation(f.getSession,source.id,'read'),code('IMPORT_SOURCE_NOT_FOUND'));
  f.state.session={...base(),permissions:[]};await assert.rejects(f.runtime.list(f.getSession),code('IMPORT_FORBIDDEN'));
});
test('Productive Block 1: a reader failure after its last packet does not falsely seal the entire file',async t=>{
  const f=await fixture(t);f.state.failAfterComplete=true;
  await assert.rejects(f.upload(),code('IMPORT_SOURCE_INTERRUPTED'));
  let source=(await f.runtime.list(f.getSession)).items[0];assert.equal(source.complete,false);assert.equal(source.status,'interrupted');
  await assert.rejects(f.runtime.sourceOperation(f.getSession,source.id,'review',{expectedRevision:source.revision}),code('IMPORT_SOURCE_INCOMPLETE'));
  f.state.failAfterComplete=false;source=await f.upload();assert.equal(source.complete,true);
});
test('Productive Block 1: declared/read mismatch remains a blocking gate; caller cannot submit source gates',async t=>{
  const f=await fixture(t,{counts:{ARTIKEL_STAMM:1}});let source=await f.upload();source=await f.finish(source,'review');
  assert.equal(source.status,'needs_review');assert.ok(source.tables.find(t=>t.name==='ARTIKEL_STAMM').run.gates.includes('SOURCE_ROW_COUNT_MISMATCH'));
  await assert.rejects(f.runtime.sourceOperation(f.getSession,source.id,'apply',{expectedRevision:source.revision}),code('IMPORT_DECISION_GATE'));
  await assert.rejects(f.runtime.sourceOperation(f.getSession,source.id,'review',{expectedRevision:source.revision,gates:[]}),code('IMPORT_SHAPE_INVALID'));
});
test('Productive Block 1: revoking prepare during a file read stops at the next batch and can be resumed after reauthorization',async t=>{
  const key=M.profileFor('FILIALEN').keyFields[0],f=await fixture(t,{values:{FILIALEN:[rawMaster('FILIALEN',{[key]:1})]}});
  f.state.beforeMessage=message=>{if(message.type==='rows')f.state.session.permissions=f.state.session.permissions.filter(p=>p!==P.PREPARE);};
  await assert.rejects(f.upload(),code('IMPORT_FORBIDDEN'));assert.equal(f.database.prepare('SELECT COUNT(*) n FROM data_import_rows').get().n,0);
  f.state.beforeMessage=null;f.state.session=base();const source=await f.upload();assert.equal(source.complete,true);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM data_import_rows').get().n,1);
});
test('Productive Block 1: cash parents are applied before details and undo reverses dependencies, with replay protection',async t=>{
  const values={Umsatz_KASSE:[rawHistory('Umsatz_KASSE',{Bonnr:1,Filialid:1,Kassenid:1,Bondatum:new Date('2026-09-04T00:00:00Z'),RechnungsBetrag:0})],
    Umsatz_Kasse_Details:[rawHistory('Umsatz_Kasse_Details',{RepID:'00000000-0000-0000-0000-000000000001',Bonnr:1,Filialid:1,Kassenid:1,Bondatum:new Date('2026-09-04T00:00:00Z'),VKMenge:1,VK_Preis:12})]};
  const f=await fixture(t,{kind:'cash',values});let source=await f.upload();source=await f.finish(source,'review');
  assert.equal(source.status,'needs_review');source=await f.finish(source,'apply');assert.equal(source.status,'applied');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM import_history_records').get().n,2);
  const detail=source.tables.find(t=>t.name==='Umsatz_Kasse_Details');
  const preview=await f.runtime.sourceOperation(f.getSession,source.id,'undo-preview',{runId:detail.run.id});assert.equal(preview.rows[0].canUndo,true);
  source=await f.finish(source,'undo');assert.equal(source.status,'reverted');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM import_history_records').get().n,0);
});
test('Productive Block 3: source pages preserve every ordinal, count mismatch and excluded fields with bounded reads',async()=>{
  const name='FILIALEN',length=READ_PAGE_ROWS*2+1,rows=Array.from({length},(_,i)=>rawMaster(name,{FilialID:String(i+1)}));
  const factory=readerFactory('trade',{[name]:rows},{[name]:length+4}),reads=[],messages=[];
  const wrapped=()=>{const reader=factory();return {...reader,getTable(table){const original=reader.getTable(table);return {...original,getData(options){
    if(table===name)reads.push({...options});return original.getData(options);
  }};}};};
  let received=0,busy=false;
  await readTradeFotoFullSource({buffer:sourceBuffer(),kind:'trade',readerFactory:wrapped,send:async message=>{
    assert.equal(busy,false);busy=true;await Promise.resolve();
    if(message.type==='table'&&message.name===name)messages.push(message);
    if(message.type==='rows'&&message.name===name){assert.equal(message.startRow,received+1);assert.ok(message.rows.length<=200);
      for(const row of message.rows){received++;assert.equal(row.FilialID,String(received));}}
    busy=false;
  }});
  assert.equal(received,length);assert.equal(messages[0].expectedRows,length);assert.equal(messages[0].declaredRows,length+4);
  assert.deepEqual(reads.map(r=>[r.rowOffset,r.rowLimit]),[[0,C.LIMITS.rows+1],[0,READ_PAGE_ROWS],[READ_PAGE_ROWS,READ_PAGE_ROWS],[READ_PAGE_ROWS*2,1]]);
  assert.deepEqual(reads[0].columns,[]);assert.ok(reads.slice(1).every(r=>r.columns.length>0));
});

test('Productive Block 3: a short decoded page cannot finish a source after its count pass',async()=>{
  const name='FILIALEN',factory=readerFactory('trade',{[name]:[rawMaster(name,{FilialID:'18'})]}),messages=[];
  const wrapped=()=>{const reader=factory();return {...reader,getTable(table){const original=reader.getTable(table);return {...original,
    getData:options=>table===name&&options.columns.length?[]:original.getData(options)};}};};
  await assert.rejects(readTradeFotoFullSource({buffer:sourceBuffer(),kind:'trade',readerFactory:wrapped,send:async m=>messages.push(m.type)}),code('IMPORT_SOURCE_READ_COUNT_CHANGED'));
  assert.ok(!messages.includes('complete'));
});

test('Productive Block 1: reader rejects unexpected schema and file type and awaits each staging acknowledgement',async()=>{
  const events=[];let inFlight=0;
  await readTradeFotoFullSource({buffer:sourceBuffer(),kind:'cash',readerFactory:readerFactory('cash'),send:async msg=>{
    assert.equal(inFlight++,0);await new Promise(r=>setImmediate(r));events.push(msg.type);inFlight--;
  }});assert.equal(events[0],'manifest');assert.equal(events.at(-1),'complete');
  await assert.rejects(readTradeFotoFullSource({buffer:Buffer.alloc(4096),kind:'cash',send:()=>{}}),code('IMPORT_SOURCE_FORMAT_INVALID'));
  const factory=readerFactory('cash'),reader=factory();reader.getTableNames=()=>[];
  await assert.rejects(readTradeFotoFullSource({buffer:sourceBuffer(),kind:'cash',readerFactory:()=>reader,send:()=>{}}),code('IMPORT_SOURCE_TABLE_MISSING'));
  reader.getTableNames=()=>[...definitions('cash').map(d=>d.name),'UnreviewedBusinessTable'];
  await assert.rejects(readTradeFotoFullSource({buffer:sourceBuffer(),kind:'cash',readerFactory:()=>reader,send:()=>{}}),code('IMPORT_SOURCE_TABLE_UNCLASSIFIED'));
});
test('Productive Block 1: a lost source checkpoint after apply is recovered from the committed run without duplicate writes',async t=>{
  const f=await fixture(t,{kind:'cash',values:{Umsatz_KASSE:[rawHistory('Umsatz_KASSE',{Bonnr:1,Filialid:1,Kassenid:1,Bondatum:new Date('2026-09-04T00:00:00Z')})]}});
  let source=await f.upload();source=await f.finish(source,'review');
  let checkpoint;
  for(let n=0;n<30;n++) {
    checkpoint=f.database.prepare('SELECT revision,updated_at,payload FROM data_import_sources WHERE id=?').get(source.id);
    source=await f.runtime.sourceOperation(f.getSession,source.id,'apply',{expectedRevision:source.revision});
    if(f.database.prepare('SELECT COUNT(*) n FROM import_history_records').get().n)break;
  }
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM import_history_records').get().n,1);
  // Synthetic crash: target/run transaction committed but its source checkpoint did not.
  f.database.prepare('UPDATE data_import_sources SET revision=?,updated_at=?,payload=? WHERE id=?').run(checkpoint.revision,checkpoint.updated_at,checkpoint.payload,source.id);
  f.reload();source=await f.runtime.sourceOperation(f.getSession,source.id,'read');source=await f.finish(source,'apply');
  assert.equal(source.status,'applied');assert.equal(f.database.prepare('SELECT COUNT(*) n FROM import_history_records').get().n,1);
  await assert.rejects(f.runtime.sourceOperation(f.getSession,source.id,'review',{expectedRevision:source.revision}),code('IMPORT_STATE_CONFLICT'));
  source=await f.finish(source,'undo');assert.equal(source.status,'reverted');
});
