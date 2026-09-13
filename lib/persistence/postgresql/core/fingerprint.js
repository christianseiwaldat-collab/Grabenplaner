'use strict';
const {createHash}=require('node:crypto');
// No row values, sequence positions or OIDs enter this schema contract. Object
// definitions, ownership and grants do: a matching ledger alone is insufficient.
// Callers use the canonical search_path pg_catalog,gp before introspection;
// PostgreSQL deparses visible object names differently under another search_path.
async function schemaObjects(client, schemas=['gp']) {
  if(!Array.isArray(schemas)||!schemas.length||schemas.some(s=>!['gp','kassa','integration','trade','reporting'].includes(s)))throw new Error('Unreviewed fingerprint scope');
  const result=await client.query(`
    SELECT kind,name,definition FROM (
      SELECT 'relation' kind,c.relname::text name,
        jsonb_build_array(c.relkind,c.relrowsecurity,c.relforcerowsecurity,
          pg_get_userbyid(c.relowner),c.relacl::text)::text definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','v','S')
      UNION ALL
      SELECT 'column',c.relname||'.'||a.attnum,
        jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
          a.attidentity,a.attgenerated,a.attacl::text,co.collname,pg_get_expr(d.adbin,d.adrelid))::text
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      LEFT JOIN pg_collation co ON co.oid=a.attcollation
      WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','v') AND a.attnum>0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'constraint',c.relname||'.'||con.conname,pg_get_constraintdef(con.oid,true)
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[])
      UNION ALL
      SELECT 'index',indexname,indexdef FROM pg_indexes WHERE schemaname=ANY($1::text[])
      UNION ALL
      SELECT 'trigger',c.relname||'.'||t.tgname,jsonb_build_array(t.tgenabled,pg_get_triggerdef(t.oid,true))::text
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND NOT t.tgisinternal
      UNION ALL
      SELECT 'view',viewname,definition FROM pg_views WHERE schemaname=ANY($1::text[])
      UNION ALL
      SELECT 'function',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
        jsonb_build_array(pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.proacl::text)::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ANY($1::text[]) AND p.prokind='f'
      UNION ALL
      SELECT 'schema',nspname,jsonb_build_array(pg_get_userbyid(nspowner),nspacl::text)::text FROM pg_namespace WHERE nspname=ANY($1::text[])
      UNION ALL
      SELECT 'default-grant',pg_get_userbyid(d.defaclrole)||'.'||d.defaclobjtype::text,
        d.defaclacl::text FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname=ANY($1::text[])
    ) objects ORDER BY kind COLLATE "C",name COLLATE "C"
  `,[schemas]);
  return result.rows;
}
async function schemaFingerprint(client,schemas=['gp']) {
  return createHash('sha256').update(JSON.stringify(await schemaObjects(client,schemas))).digest('hex');
}
module.exports={schemaObjects,schemaFingerprint};
