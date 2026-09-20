'use strict';
const {SCHEMAS}=require('../sales/layout');
const {schemaFingerprint}=require('../core/fingerprint');
const {phaseTimer}=require('./phase-timing');
const quote=value=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(value))throw new Error('PG_PAIR_CHECKPOINT_IDENTIFIER');return '"'+value+'"';};

// Called inside the two locked backup snapshots. Counts cover technical tables
// as well as business data; sequences are captured after writers have drained.
async function captureCheckpoint(client,domain,{onTiming}={}){
 const measure=phaseTimer(onTiming);
 if(!['core','sales'].includes(domain))throw new Error('PG_PAIR_CHECKPOINT_DOMAIN');
 const schemas=domain==='core'?['gp']:SCHEMAS;
 await client.query('SET LOCAL search_path='+(domain==='core'?'pg_catalog,gp':'pg_catalog,gp,kassa,integration,trade,reporting'));
 const tables=(await client.query('SELECT schemaname,tablename FROM pg_tables WHERE schemaname=ANY($1::text[]) ORDER BY schemaname,tablename',[schemas])).rows;
 const counts=[];
 await measure('row-counts',async()=>{for(const t of tables){const name=quote(t.schemaname)+'.'+quote(t.tablename);counts.push({schema:t.schemaname,table:t.tablename,rows:(await client.query('SELECT count(*)::text AS n FROM '+name)).rows[0].n});}});
 const names=(await client.query("SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname=ANY($1::text[]) ORDER BY 1,2",[schemas])).rows;
 const sequences=[];for(const s of names)sequences.push({...s,...(await client.query('SELECT last_value::text AS value,is_called AS called FROM '+quote(s.schema)+'.'+quote(s.name))).rows[0]});
 return {schemaSha256:await measure('schema-fingerprint',()=>schemaFingerprint(client,schemas)),tables:counts,sequences};
}
async function verifyCheckpoint(client,domain,expected){
 if(!expected||!Array.isArray(expected.tables)||!expected.tables.length||!Array.isArray(expected.sequences))throw new Error('PG_PAIR_CHECKPOINT_REQUIRED');
 const actual=await captureCheckpoint(client,domain);
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('PG_PAIR_RESTORE_CHECKPOINT_MISMATCH');
 return {tables:actual.tables.length,rows:actual.tables.reduce((n,t)=>n+BigInt(t.rows),0n).toString(),sequences:actual.sequences.length,schemaSha256:actual.schemaSha256};
}
module.exports={captureCheckpoint,verifyCheckpoint};
