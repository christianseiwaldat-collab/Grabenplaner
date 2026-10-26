"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const path = require("node:path"), os = require("node:os"), { Module } = require("node:module");
const { spawnSync } = require("node:child_process");
const { readPolicy } = require("../lib/passkey-schema-policy");

test("the installed schema prerequisite comes from package bytes even with conflicting environment flags", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-schema-policy-"));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root,"lib"));
  fs.copyFileSync(path.join(__dirname,"../lib/passkey-schema-policy.js"),path.join(root,"lib/policy.js"));
  for (const policy of ["compatible","required","unqualified"]) {
    fs.writeFileSync(path.join(root,"package.json"),JSON.stringify({grabenplaner:{passkeysSchemaPolicy:policy}}));
    const result=spawnSync(process.execPath,["-e","process.stdout.write(require('./lib/policy').installedPolicy())"],{cwd:root,encoding:"utf8",timeout:10000,
      env:{...process.env,GRABENPLANER_PASSKEYS_SCHEMA_POLICY:policy==="required"?"compatible":"required"}});
    if(policy==="unqualified"){assert.notEqual(result.status,0);assert.match(result.stderr,/PG_PASSKEYS_RELEASE_POLICY/);}
    else{assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,policy);}
  }
});

// Actual connection-opening function bodies; SQL/environment/pool adapters are
// synthetic. The separate native matrix proves real old/new schema behavior.
for (const slice of ["core/application","application-operations/access"]) {
  for (const policy of ["compatible","required"]) for (const present of [false,true]) {
    test(`application connection enforces package policy: ${slice}, ${policy}, schema ${present?"present":"absent"}`,async()=>{
      const file=path.resolve(__dirname,"../lib/persistence/postgresql/"+slice+".js"),events=[];
      const stop=new Error("SYNTHETIC_PROVIDER_BOUNDARY");
      const client={async query(){return{rows:[],fields:[]};},release(){events.push("release");}};
      const pool={async connect(){return client;},async end(){events.push("end");}};
      const instance=new Module(file,module);instance.filename=file;instance.paths=Module._nodeModulePaths(path.dirname(file));
      const original=instance.require.bind(instance);
      instance.require=id=>{
        if(id==="pg")return{Pool:function(){return pool;}};
        if(id==="./environment"||id==="../core/environment")return{configuration:()=>({max:1}),verifyEnvironment:async()=>{events.push("environment");}};
        if(id==="../../../passkey-schema-policy")return{installedPolicy:()=>readPolicy({grabenplaner:{passkeysSchemaPolicy:policy}})};
        if(id==="../boundary/migrate")return{verifyCoreSchema:async(c,options)=>{assert.equal(c,client);assert.equal(options.requirePasskeys,policy==="required");events.push("schema");if(options.requirePasskeys&&!present)throw Error("PG_PASSKEYS_MIGRATION_REQUIRED");return{boundary:true};}};
        if(id==="../provider")return{createPostgresqlPersistenceProvider:()=>{events.push("provider");throw stop;}};
        return original(id);
      };
      instance._compile(fs.readFileSync(file,"utf8"),file);
      const run=async()=>{
        if(slice==="core/application")await instance.exports.openCoreDevelopmentApplication({boundary:true});
        else{const access=await instance.exports.openCoreOperations({},{pool});await access.prepare("SELECT 1").get();}
      };
      if(policy==="required"&&!present){await assert.rejects(run,/PG_PASSKEYS_MIGRATION_REQUIRED/);assert(!events.includes("provider"));}
      else if(slice==="core/application")await assert.rejects(run,error=>error===stop);
      else await run();
      assert(events.includes("environment"));assert(events.includes("schema"));assert(events.includes("release"));
    });
  }
}
