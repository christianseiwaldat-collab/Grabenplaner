'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const defaults=require('../lib/personnel-document-category-defaults');
const {createPostgresqlStartupOperations}=require('../lib/persistence/postgresql/application-operations/startup');
const personnelColumns='id,code,label,default_visibility,retention_disposition,default_retention_days,active,builtin,sort_order';
const candidateColumns='id,code,label,default_visibility,retention_disposition,default_retention_days,transfer_eligible,active,builtin,sort_order';
function expectedPersonnel(){return defaults.PERSONNEL_DOCUMENT_CATEGORIES.map(([id,code,label,sort_order])=>({id,code,label,default_visibility:'hr_confidential',retention_disposition:'manual_review',default_retention_days:null,active:1,builtin:1,sort_order})).sort((a,b)=>a.id.localeCompare(b.id));}
function expectedCandidates(){return defaults.CANDIDATE_DOCUMENT_CATEGORIES.map(([id,code,label,default_visibility,transfer_eligible,sort_order])=>({id,code,label,default_visibility,retention_disposition:'manual_review',default_retention_days:null,transfer_eligible,active:1,builtin:1,sort_order})).sort((a,b)=>a.id.localeCompare(b.id));}
test('PostgreSQL category defaults preserve the exact qualified b2 category identities and policies',()=>{
 const {legacyRequire}=require('../test-support/legacy-baseline');
 const db=legacyRequire('lib/persistence/sqlite/provider').openSqliteLegacyDatabase(':memory:');
 try{
  legacyRequire('lib/persistence/sqlite/operations/application-schema').ensureSqliteApplicationSchema(db);
  assert.deepEqual(db.prepare('SELECT '+personnelColumns+' FROM personnel_document_categories ORDER BY id').all().map(row=>({...row})),expectedPersonnel());
  assert.deepEqual(db.prepare('SELECT '+candidateColumns+' FROM candidate_document_categories ORDER BY id').all().map(row=>({...row})),expectedCandidates());
 }finally{db.close();}
});
test('real PostgreSQL startup fills both category sets idempotently and preserves customized existing categories',{
 skip:!process.env.GP_CORE_MIGRATOR_URL,
},async()=>{
 const {withCoreFixture}=require('../test-support/postgresql-migration/core-fixture');
 const {openCoreOperations}=require('../lib/persistence/postgresql/application-operations/access');
 await withCoreFixture(async()=>{
  const db=await openCoreOperations({profile:'core-migration-development',databaseUrl:process.env.GP_CORE_APP_URL,tlsMode:'disable-local-only'});
  try{
   const startup=createPostgresqlStartupOperations(db,{}),seed=()=>startup.seedDefaults({defaultSettings:{},builtinPortalRoles:[]});
   await seed();
   assert.deepEqual(await db.prepare('SELECT '+personnelColumns+' FROM personnel_document_categories ORDER BY id').all(),expectedPersonnel());
   assert.deepEqual(await db.prepare('SELECT '+candidateColumns+' FROM candidate_document_categories ORDER BY id').all(),expectedCandidates());
   await db.prepare("UPDATE personnel_document_categories SET label='Custom contract',active=0,default_visibility='employee_private',default_retention_days=123 WHERE id='contract'").run();
   await db.prepare("UPDATE candidate_document_categories SET label='Custom resume',active=0,transfer_eligible=0,default_visibility='hr_confidential',default_retention_days=234 WHERE id='resume'").run();
   const before=[await db.prepare('SELECT '+personnelColumns+' FROM personnel_document_categories ORDER BY id').all(),await db.prepare('SELECT '+candidateColumns+' FROM candidate_document_categories ORDER BY id').all()];
   await seed();await seed();
   assert.deepEqual([await db.prepare('SELECT '+personnelColumns+' FROM personnel_document_categories ORDER BY id').all(),await db.prepare('SELECT '+candidateColumns+' FROM candidate_document_categories ORDER BY id').all()],before);
  }finally{await db.close();}
 });
});
