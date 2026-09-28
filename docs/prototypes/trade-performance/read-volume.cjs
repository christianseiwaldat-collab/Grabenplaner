'use strict';
// Read-only scaling check of the existing private local reporting fixture.
// Never seeds, migrates, imports, writes results into the fixture, or prints business rows.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {openSqliteLegacyDatabase,createSqlitePersistenceProvider}=require('../../../lib/persistence/sqlite/provider');
const root=path.resolve(__dirname,'../../..'),tmp=path.join(root,'tmp');
const round=value=>Math.round(value*100)/100;
const baseline=process.argv.includes('--baseline-head');
function installBaselineLoader() {
  if(!baseline)return ()=>{};
  const Module=require('node:module'),{spawnSync}=require('node:child_process');
  const names=['trade-article-history','trade-insights','trade-movements','trade-stocktakes','trade-supplier-invoices'];
  const originals=new Map();
  for(const name of names) {
    const relative='lib/persistence/repositories/'+name+'.js',filename=path.join(root,relative);
    if(require.cache[filename])throw new Error('BASELINE_MODULE_ALREADY_LOADED');
    const result=spawnSync('git',['show','45dbf13:'+relative],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
    if(result.status!==0 || !result.stdout)throw new Error('BASELINE_SOURCE_UNAVAILABLE');
    originals.set(path.normalize(filename),result.stdout);
  }
  const previous=Module._extensions['.js'];
  Module._extensions['.js']=(module,filename)=>{
    const source=originals.get(path.normalize(filename));
    if(source!==undefined)return module._compile(source,filename);
    return previous(module,filename);
  };
  return ()=>{Module._extensions['.js']=previous;};
}
async function main() {
  const pointer=JSON.parse(fs.readFileSync(path.join(tmp,'trade-volume-state.json'),'utf8'));
  const directory=fs.realpathSync(pointer.directory);
  if(path.dirname(directory)!==tmp || !path.basename(directory).startsWith('trade-volume-'))throw new Error('FIXTURE_PATH_INVALID');
  const filename=path.join(directory,'reporting.db'),before=fs.statSync(filename);
  // The registered facade opens node:sqlite with {readOnly:true}; the application
  // provider deliberately rejects an unregistered raw DatabaseSync instance.
  const database=openSqliteLegacyDatabase(filename,{readOnly:true,initializeConnection:false});
  database.exec('PRAGMA query_only=ON');
  let access;
  const key=fs.readFileSync(path.join(directory,'vault-key.bin'));
  try {
    access=createSqlitePersistenceProvider({database,
      catalog:require('../../../lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG,
      closeDatabase:false,initializeConnection:false});
    const vault=require('../../../lib/integration-secret-vault').createIntegrationSecretVault({activeKeyId:'synthetic',keys:{synthetic:key}});
    const permissions=[...Object.values(require('../../../lib/sales-analytics-access').SALES_ANALYTICS_PERMISSIONS),
      ...Object.values(require('../../../lib/sales-history-access').SALES_HISTORY_PERMISSIONS),
      ...Object.values(require('../../../lib/tradefoto-bestell/access').BESTELL_PERMISSIONS),
      'sales:articles:access','sales:articles:read'];
    const session={id:'read-only-volume-check',employeeNumber:'synthetic-owner',sessionKind:'employee',isEmployee:true,permissions,scopes:[]};
    const runtime=require('../../../lib/persistence/repositories/trade-insights').createTradeInsightRuntime({access,vault,today:()=> '2026-09-28'});
    async function query(label,kind,input,onRows) {
      let cursor=null,rows=0,scanned=0,pages=0,maxPageMs=0;
      const digest=crypto.createHash('sha256'),canonical=require('../../../lib/data-import-contract').canonical;
      const start=performance.now();
      do {
        const pageStart=performance.now(),result=await runtime.run(async()=>session,kind,{...input,...(cursor?{cursor}:{})});
        maxPageMs=Math.max(maxPageMs,performance.now()-pageStart);
        rows+=result.rows.length;scanned+=result.scanned||0;pages++;cursor=result.next;
        for(const row of result.rows)digest.update(canonical(row)+'\n');
        if(onRows)onRows(result.rows);
        if(pages>10000)throw new Error('READ_PAGE_LIMIT');
      } while(cursor);
      const metric={operation:label,complete:true,rows,scanned,pages,milliseconds:round(performance.now()-start),maxPageMs:round(maxPageMs),rowSha256:digest.digest('hex')};
      console.log(JSON.stringify(metric));return metric;
    }
    console.log(JSON.stringify({check:'read-only-scaling',mode:baseline?'baseline-45dbf13':'current-working-tree',readOnly:true}));
    const headers=[];
    await query('inventory-overview','stocktakes',{},rows=>headers.push(...rows));
    // Choose by actual imported detail count, not by business quantities.
    const counts=database.prepare("SELECT v.parent_id AS id,COUNT(*) AS count FROM import_history_records r JOIN import_history_versions v ON v.record_id=r.id AND v.revision=r.revision WHERE r.scope_id='grabenplaner-main' AND r.source_instance='tradefoto-inventur' AND r.source='trade' AND r.source_table='Inventurdetails' AND v.file_sha256=? GROUP BY v.parent_id");
    const byId=new Map(headers.map(header=>[header.id,header]));
    const candidates=headers.length ? counts.all(headers[0].sourceHash).filter(row=>byId.has(row.id)).sort((a,b)=>Number(b.count)-Number(a.count)) : [];
    if(candidates.length) {
      const largest=byId.get(candidates[0].id);
      await query('largest-inventory-details','stocktakes',{stocktakeId:largest.id,stocktakeVersion:String(largest.revision),stocktakeSource:largest.sourceHash});
    } else console.log(JSON.stringify({operation:'largest-inventory-details',complete:true,rows:0,pages:0,milliseconds:0}));
    await query('movements-2026-09-01-through-18','movements',{dateFrom:'2026-09-01',dateTo:'2026-09-18'});
    const after=fs.statSync(filename);
    if(before.size!==after.size || before.mtimeMs!==after.mtimeMs)throw new Error('FIXTURE_CHANGED_DURING_READ');
    console.log(JSON.stringify({check:'complete',readOnly:true,databaseSizeAndMtimeUnchanged:true}));
  } finally { key.fill(0);if(access)await access.close();database.close(); }
}
let restoreLoader=()=>{};
try {
  restoreLoader=installBaselineLoader();
  main().catch(error=>{console.error(JSON.stringify({check:'stopped',code:error.code||error.message||error.name}));process.exitCode=1;}).finally(restoreLoader);
} catch(error) {
  restoreLoader();console.error(JSON.stringify({check:'stopped',code:error.code||error.message||error.name}));process.exitCode=1;
}
