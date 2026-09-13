'use strict';
const q=value=>'"'+value.replace(/"/g,'""')+'"';
async function materializeDefaultPrivileges(client,schemas){
  const functions=(await client.query(`SELECT p.oid::regprocedure::text AS name FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ANY($1::text[])
    AND p.prokind='f' AND p.proacl IS NULL`,[schemas])).rows;
  for(const row of functions)await client.query('GRANT EXECUTE ON FUNCTION '+row.name+' TO PUBLIC');
  const relations=(await client.query(`SELECT n.nspname,c.relname,pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','v') AND c.relacl IS NULL`,[schemas])).rows;
  for(const row of relations)await client.query('GRANT ALL PRIVILEGES ON TABLE '+q(row.nspname)+'.'+q(row.relname)+' TO '+q(row.owner));
  return {functions:functions.length,relations:relations.length};
}
module.exports={materializeDefaultPrivileges};
