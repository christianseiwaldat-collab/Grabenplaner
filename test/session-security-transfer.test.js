'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const security=require('../lib/persistence/postgresql/transfer/session-security');
const history=require('../lib/persistence/postgresql/transfer/history');
const iso='2026-10-18T12:00:00.123Z';
const preserved={ledger:{version:1},marker:{id:'session-security-v1',app_version:'0.92.90-beta',applied_at:'2026-10-18 11:00:00'}};
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
test('legacy column mapping accepts only reviewed types, defaults and collations',()=>{
 const policy={name:'password_policy_version',type:'int4',generated:'',notNull:true,defaultExpression:'0',collation:null};
 assert.deepEqual(security.extraColumns({database:'core',name:'portal_users'},[policy]),[{name:policy.name,kind:'integer',source:'legacy-zero'}]);
 for(const change of [{type:'int8'},{notNull:false},{defaultExpression:'1'},{generated:'s'}])assert.throws(()=>security.extraColumns({database:'core',name:'portal_users'},[{...policy,...change}]),/CONTRACT/);
 const origin={name:'authenticated_at',type:'text',generated:'',notNull:false,defaultExpression:null,collation:'C'};
 for(const change of [{type:'timestamptz'},{notNull:true},{defaultExpression:'now()'},{collation:'default'},{generated:'s'}])assert.throws(()=>security.extraColumns({database:'core',name:'portal_sessions'},[{...origin,...change}]),/CONTRACT/);
 assert.deepEqual(security.extraColumns({database:'sales',name:'portal_users'},[policy]),[]);
});
test('transfer policy classification grants no driver imports or unrelated helper exception',()=>{
 const {architectureBoundaryViolationsForText:inspect}=require('../scripts/audit-persistence-coupling');
 for(const file of ['lib/persistence/postgresql/transfer/session-security.js','lib/persistence/postgresql/transfer/session-security-other.js']){
  for(const driver of ['pg','node:'+'sqlite'])assert.ok(inspect(file,"const driver=require('"+driver+"');").some(e=>e.kind===(driver==='pg'?'postgresql-driver-import':'sqlite-driver-import-outside-boundary')),file);
 }
});
