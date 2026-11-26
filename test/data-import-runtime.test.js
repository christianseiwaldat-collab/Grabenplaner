"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const C=require('../lib/data-import-contract');
const M=require('../lib/tradefoto-master-profiles'),H=require('../lib/tradefoto-history-profiles');
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
async function removeSource(f,source){
 f.database.exec('CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity_type TEXT,entity_id TEXT,detail TEXT,created_at TEXT)');
 let result={revision:source.revision};
 for(let n=0;n<200&&!result.deleted;n++)result=await f.runtime.sourceOperation(f.getSession,source.id,'delete',{expectedRevision:result.revision});
 assert.equal(result.deleted,true);return result;
}

test('content dates exclude scheduled dates, time-only values, invalid dates and far-future outliers',()=>{
 const dates=require('../lib/data-import-content-date'),profile=M.profileFor('ARTIKEL_STAMM'),result=dates.empty();
 dates.accumulate(result,profile,[{'Änderungsdatum':'2026-02-30T10:00:00.000'}, {'Änderungsdatum':'1899-12-30T12:00:00.000'},
  {'Änderungsdatum':'2099-01-01T00:00:00.000'}, {'ZukunftsUVPab':'2026-09-05T23:59:00.000'},
  {'Änderungsdatum':'2026-09-03T23:58:00'}],TIME);
 assert.equal(result.value,'2026-09-03T23:58:00.000');
 assert.deepEqual(result.evidence,{table:'ARTIKEL_STAMM',field:'Änderungsdatum'});
 assert.equal(dates.civil('2026-09-03T23:58:00.000Z'),null);
});

function runtimeCountProof(name,declaredRows,expectedRows,extra={}) {
  const profile=definitions('trade').find(table=>table.name===name).profile;
  return require('../lib/data-import-source-tolerance').defineDataImportSourceTolerance({id:'synthetic-late-runtime-'+name.toLowerCase(),recordedAt:TIME,
    approvalReference:'synthetic-explicit-approval',reason:'Independent synthetic source verification',evidenceReference:'synthetic-evidence',sourceSystem:profile.sourceSystem,
    sourceTable:name,profileHash:profile.fingerprint,sourceInstance:'tradefoto-trade',schemaSha256:profile.schemaSha256,
    fileSha256:crypto.createHash('sha256').update(sourceBuffer()).digest('hex'),declaredRows,expectedRows,...extra});
}

test('catalog continuation quarantines an alias whose parent article was held back',async()=>{
 const article=rawMaster('ARTIKEL_STAMM',{EAN:'0000000000042',Artikelbezeichnung:'Synthetic accepted article',MWST:1,'Änderungsdatum':'2026-09-03T13:00:00.000',Verkaufspreis:'12',eNvk:'10'});
 const alias=rawMaster('ARTIKEL_ZWEITEAN',{EAN:'0000000000099',ZweitEAN:'4006381333931',Rang:1});
 const sync=require('../lib/data-import-article-sync').createDataImportArticleSync();
 const prepared=await sync.prepareSource({id:'a'.repeat(64),fileSha256:'b'.repeat(64),createdAt:TIME,tables:[{name:'ARTIKEL_STAMM',run:{id:'article-run'}},{name:'ARTIKEL_ZWEITEAN',run:{id:'alias-run'}}]},
  async table=>({rows:table==='ARTIKEL_STAMM'?[article]:[alias],after:1,complete:true}),async()=>{});
 assert.equal(prepared.quarantinedAliases,1);assert.equal(prepared.normalizedArticles.length,1,JSON.stringify(prepared.rows));
 assert.equal(prepared.normalizedArticles[0].description,'Synthetic accepted article');
});


test('Productive Block 1: rights are cumulative, personal and not granted by a role name',()=>{
  assert.equal(buildDataImportProjection(base()).prepare,true);
  for(const change of [{permissions:[]},{employeeNumber:null},{isEmployee:false},{mustChangePassword:true},{sessionKind:'organization'},
    {permissions:[...Object.values(P),'sales:analytics:access']}])assert.equal(buildDataImportProjection({...base(),...change}).read,false);
  assert.equal(dataImportPermissionDependencies(base().permissions).valid,true);
  assert.equal(dataImportPermissionDependencies([P.APPLY]).valid,false);
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
