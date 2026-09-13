'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const {Pool}=require('pg');
const {configuration,verifyEnvironment}=require('../core/environment');
const {verifyCoreSchema}=require('../boundary/migrate');
const SQL=require('../core/sql');

function compileOperation(sql){
 if(typeof sql!=='string'||sql.length>32768)throw new Error('PG_CORE_OPERATION_SQL');
 const tokens=SQL.tokens(sql);let parameters=0;
 for(let i=0;i<tokens.length;i++){
  if(tokens[i]==='?')tokens[i]='$'+(++parameters);
  // Preserve the public names returned by the original SELECT projections.
  if(tokens[i].toUpperCase()==='AS'&&/^[a-z_][a-z_0-9]*[A-Z][a-zA-Z_0-9]*$/.test(tokens[i+1]||''))tokens[i+1]='"'+tokens[i+1]+'"';
 }
 let compiled=SQL.insertIgnore(SQL.text(tokens));
 if(!/^(SELECT|INSERT|UPDATE|DELETE)\b/i.test(compiled)||SQL.tokens(compiled).includes(';'))throw new Error('PG_CORE_OPERATION_KIND');
 compiled=compiled.replace(/(\$\d+) IS (NOT )?NULL/g,'($1::text) IS $2NULL');
 return {sql:compiled,parameters,write:!/^SELECT\b/i.test(compiled)};
}
function decodeRows(result){
 const integers=new Set(result.fields.filter(f=>f.dataTypeID===20).map(f=>f.name));
 return result.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>{
  if(value!==null&&integers.has(key)){const number=Number(value);if(!Number.isSafeInteger(number))throw new Error('PG_CORE_OPERATION_INTEGER_RANGE');return [key,number];}
  return [key,value];
 })));
}

async function openCoreOperations(options,{pool:suppliedPool}={}){
 const config=configuration(options),pool=suppliedPool||new Pool({...config,max:1}),context=new AsyncLocalStorage(),initialized=new WeakSet();let savepoint=0;
 async function connect(){
  const client=await pool.connect();
  try{if(!initialized.has(client)){await verifyEnvironment(client,{purpose:options.purpose||'app',binding:options.binding});await client.query('SET search_path=pg_catalog,gp');await verifyCoreSchema(client);initialized.add(client);}return client;}catch(error){client.release(true);throw error;}
 }
 async function transaction(work,{readOnly=false}={}){
  const outer=context.getStore();
  if(outer){
   if(outer.readOnly&&!readOnly)throw new Error('PG_CORE_OPERATION_READ_ONLY');
   const name='operation_'+(++savepoint);await outer.client.query('SAVEPOINT '+name);
   try{const result=await work();await outer.client.query('RELEASE SAVEPOINT '+name);return result;}catch(error){await outer.client.query('ROLLBACK TO SAVEPOINT '+name);await outer.client.query('RELEASE SAVEPOINT '+name);throw error;}
  }
  const client=await connect();let locked=false;
  try{
   if(!readOnly){await client.query("SET lock_timeout='3s'");await client.query('SELECT pg_advisory_lock(9261207)');locked=true;}
   await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'+(readOnly?' READ ONLY':''));
   await client.query("SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='10s';SET LOCAL idle_in_transaction_session_timeout='30s'");
   const result=await context.run({client,readOnly},work);
   if(!readOnly&&options.authorize&&!await options.authorize())throw new Error('PG_CORE_OPERATION_AUTHORIZATION_CHANGED');
   await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{try{if(locked)await client.query('SELECT pg_advisory_unlock(9261207)');client.release();}catch(error){client.release(true);throw error;}}
 }
 function prepare(sql){
  const entry=compileOperation(sql);
  async function run(method,args){
   if(args.length!==entry.parameters)throw new Error('PG_CORE_OPERATION_PARAMETERS');
   if(entry.write!== (method==='run'))throw new Error('PG_CORE_OPERATION_METHOD');
   const execute=async()=>{
    const state=context.getStore();if(entry.write&&state.readOnly)throw new Error('PG_CORE_OPERATION_READ_ONLY');
    const result=await state.client.query(entry.sql,args);
    if(method==='run')return {changes:result.rowCount};
    const rows=decodeRows(result);return method==='get'?rows[0]:rows;
   };
   try{return context.getStore()?await execute():await transaction(execute,{readOnly:!entry.write});}
   catch(error){
    if(error.code==='23503')error.message='FOREIGN KEY constraint failed: '+error.message;
    throw error;
   }
  }
  return Object.freeze({get:(...args)=>run('get',args),all:(...args)=>run('all',args),run:(...args)=>run('run',args)});
 }
 try{const client=await connect();client.release();}catch(error){await pool.end();throw error;}
 return Object.freeze({prepare,transaction,close:()=>pool.end()});
}
module.exports={compileOperation,decodeRows,openCoreOperations};
