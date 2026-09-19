'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
async function qualifyHttp({root,config,rehearsal='application-11',connectionPort=55487,scenario='full',extraScenario,managed=false}){
 if(managed&&(process.platform!=='linux'||require('node:os').userInfo().username!=='grabenplaner'||root!=='/run/gp-postgresql-activation-qualification'||Object.values(require('node:os').networkInterfaces()).flat().some(address=>!address.internal)))throw new Error('PG_MANAGED_QUALIFICATION_SCOPE');
 const progress=phase=>fs.appendFileSync(root+'/http-progress.jsonl',JSON.stringify({phase,at:new Date().toISOString(),heap:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss})+'\n',{mode:0o600});
 progress('preparing');
 const runtime=managed?'/var/lib/grabenplaner':root+'/runtime';fs.mkdirSync(runtime,{recursive:true,mode:0o700});
 for(const name of ['private','branding-kits'])if(fs.existsSync(root+'/'+name)&&!fs.existsSync(runtime+'/'+name))fs.cpSync(root+'/'+name,runtime+'/'+name,{recursive:true,errorOnExist:true,force:false});
 for(const name of ['data','backups','logs','home'])fs.mkdirSync(runtime+'/'+name,{recursive:true,mode:0o700});
 for(const line of fs.readFileSync(root+'/source-encryption.env','utf8').split(/\r?\n/)){
  const match=line.match(/^(GRABENPLANER_(?:AMU|INTEGRATION)_(?:KEY|KEY_ID|KEYS))=(.*)$/);if(match)process.env[match[1]]=match[2];
 }
 for(const key of ['DB_PATH','DATABASE_URL','GRABENPLANER_SEED_DEMO','GRABENPLANER_FORCE_PORTAL'])delete process.env[key];
 Object.assign(process.env,{NODE_ENV:'test',DB_PROVIDER:'postgresql',GRABENPLANER_POSTGRESQL_REHEARSAL:rehearsal,GRABENPLANER_RESTORE_ROOT:root,
  GRABENPLANER_DEPLOYMENT_KIND:'recovery-smoke',GRABENPLANER_OPERATION_MODE:'server',GRABENPLANER_DATA_DIR:runtime,
  GRABENPLANER_HOST:'127.0.0.1',GRABENPLANER_TRUST_PROXY:'loopback',GRABENPLANER_PUBLIC_URL:'https://rehearsal.invalid',
  GRABENPLANER_SERVICE_CONTROL_TOKEN:crypto.randomBytes(48).toString('base64url'),GRABENPLANER_WIFI_WEBHOOK_SECRET:crypto.randomBytes(48).toString('base64url'),
  GRABENPLANER_TEST_AMU_SCANNER:'clean',GRABENPLANER_OFFSITE_CONFIGURED:'0',GRABENPLANER_MONITOR_CONFIGURED:'0',GRABENPLANER_HOST_SECURITY_CONFIGURED:'0',
  PORT:'55488',BACKUP_DIR:runtime+'/backups',GRABENPLANER_LOG_DIR:runtime+'/logs',HOME:runtime+'/home',TZ:'Europe/Vienna'});
 if(managed){
  delete process.env.GRABENPLANER_POSTGRESQL_REHEARSAL;delete process.env.GRABENPLANER_TEST_AMU_SCANNER;
  Object.assign(process.env,{NODE_ENV:'production',GRABENPLANER_DEPLOYMENT_KIND:'production',DB_PATH:'/var/lib/grabenplaner/data/postgresql-pair.json',GRABENPLANER_POSTGRESQL_APPLICATION_CONFIG:'/etc/grabenplaner/postgresql-application.json'});
 }
 progress('requiring-server');
 const subject=require('../../../../server');let server,fixtureAccess;
 progress('server-required');
 const sampling=setInterval(()=>progress('initialization-wait'),2000);sampling.unref();
 try{
  // The native recovery supervisor observes this whole process (including
  // worker CPU/I/O): startup has its idle lease, not an HTTP request deadline.
  progress('initializing-application');
  try{await subject.initializeApplicationPersistence();}
  catch(error){progress('initialization-failed');throw error;}
  finally{clearInterval(sampling);}
  progress('application-initialized');
  progress('starting-listener');
  server=managed?await subject.startServer():await new Promise((resolve,reject)=>{const s=subject.app.listen(55488,'127.0.0.1',()=>resolve(s));s.once('error',reject);});
  progress('listener-ready');
  const endpoints=[];
  for(const route of ['/api/health/live','/api/health/ready']){
   progress(route);
   const started=performance.now(),response=await fetch('http://127.0.0.1:55488'+route,{signal:AbortSignal.timeout(180000)}),body=await response.json();
   fs.writeFileSync(root+'/http-last-response-private.json',JSON.stringify({route,status:response.status,body}),{mode:0o600});
   if(managed&&response.status!==200)fs.writeFileSync(root+'/diagnostics-private.json',JSON.stringify(await subject.serverDiagnostics()),{mode:0o600});
   assert.equal(response.status,200,route);assert.equal(body.ok??body.ready??body.status==='ok',true,route);
   endpoints.push({route,status:response.status,milliseconds:Math.round(performance.now()-started)});
  }
  const url=new URL('postgresql://127.0.0.1:'+connectionPort+'/'+(config.binding?'grabenplaner_core':'gp_migration_core'));url.username='gp_core_app';url.password=config.recoveryAccounts.gp_core_app;
  fixtureAccess=await require('../../../../lib/persistence/postgresql/application-operations/access').openCoreOperations({profile:config.binding?.profile||'core-migration-development',binding:config.binding,databaseUrl:url.href,tlsMode:'disable-local-only'});
  const interrupted=scenario==='resume-report'?JSON.parse(fs.readFileSync(root+'/interrupted-report.json','utf8')):null;
  const identity=interrupted?.identity||'b11-'+crypto.randomUUID(),password=interrupted?.password||crypto.randomBytes(30).toString('base64url');
  const location=await fixtureAccess.prepare('SELECT id FROM locations WHERE active=1 ORDER BY id LIMIT 1').get();assert.ok(location);
  if(!interrupted)await fixtureAccess.transaction(async()=>{
   await fixtureAccess.prepare("INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,position_id) VALUES(?,?,?,?,'verkaufsmitarbeiter')").run(identity,'PostgreSQL Generalprobe','Generalprobe',location.id);
   await fixtureAccess.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_changed_at) VALUES(?,?,'developer',1,0,CURRENT_TIMESTAMP)").run(identity,await subject.hashPortalPassword(password));
  });
  const cookies=new Map();
  async function request(route,{method='GET',body,expected=200,anonymous=false,contentType='application/json',stream=false}={}){
   progress(route);const at=performance.now();
   const response=await fetch('http://127.0.0.1:55488'+route,{method,signal:AbortSignal.timeout(stream?600000:180000),headers:{Host:'rehearsal.invalid','X-Forwarded-Proto':'https',Origin:'https://rehearsal.invalid','Content-Type':contentType,...(!anonymous?{Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),'X-CSRF-Token':cookies.get('grabenplaner_csrf')||''}:{})},...(body?{body:JSON.stringify(body)}:{})});
   for(const value of response.headers.getSetCookie()){const pair=value.split(';')[0],at=pair.indexOf('=');cookies.set(pair.slice(0,at),pair.slice(at+1));}
   let streamed;
   if(stream&&response.status===expected){const hash=crypto.createHash('sha256');let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;hash.update(chunk);}streamed={bytes,sha256:hash.digest('hex'),contentType:response.headers.get('content-type')};}
   const value=streamed|| (response.status===204?null:response.headers.get('content-type')?.includes('application/pdf')?Buffer.from(await response.arrayBuffer()):await response.json());
   fs.writeFileSync(root+'/http-last-response-private.json',JSON.stringify({route,status:response.status,body:Buffer.isBuffer(value)?{pdfBytes:value.length}:value}),{mode:0o600});
   assert.equal(response.status,expected,route);endpoints.push({route:route.split('?')[0],status:response.status,milliseconds:Math.round(performance.now()-at)});return value;
  }
  try{
   await request('/api/portal/v1/auth/login',{method:'POST',body:{employeeNumber:identity,password},anonymous:true});
   if(extraScenario)return await extraScenario({request,subject,endpoints,identity,password});
   if(scenario!=='full'){
    const job=interrupted||await request('/api/sales-report-jobs',{method:'POST',body:{title:'PostgreSQL Wiederanlaufprobe',query:{sourceId:'compact-cash',reportVersion:3,kind:'sales',dateFrom:'2026-01-01',dateTo:'2026-01-31',locationIds:['18'],groupBy:['manufacturer'],metrics:['netRevenue','grossMargin','quantity','receiptCount'],orientation:'landscape',chartType:'bars'}}});
    if(scenario==='interrupt-report'){
     await subject.runSalesReportQueueForTests();await subject.runSalesReportQueueForTests();
     const partial=(await request('/api/sales-report-jobs')).find(r=>r.id===job.id);assert.equal(partial.status,'running');
     const fd=fs.openSync(root+'/interrupted-report.json','wx',0o600);
     try{fs.writeFileSync(fd,JSON.stringify({id:job.id,identity,password,processed:partial.processed,interruptedAt:Date.now()}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
     process.kill(process.pid,'SIGKILL');await new Promise(()=>{});
    }
    assert.equal(scenario,'resume-report');
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,interrupted.interruptedAt+31000-Date.now())));
    let report;for(let i=0;i<50;i++){
     await subject.runSalesReportQueueForTests();report=(await request('/api/sales-report-jobs')).find(r=>r.id===job.id);
     assert.ok(report);assert.notEqual(report.status,'failed',report.error);if(report.status==='completed')break;
    }
    assert.equal(report.status,'completed');assert.equal(report.restarts,1);assert.equal(report.processed,2239);
    const pdf=await request('/api/sales-report-jobs/'+job.id+'/download');assert.ok(Buffer.isBuffer(pdf)&&pdf.subarray(0,5).toString()==='%PDF-');
    await request('/api/sales-report-jobs/'+job.id,{method:'DELETE'});
    return {passed:true,provider:'postgresql-pair',http:true,forcedProcessTermination:'SIGKILL',restartCount:report.restarts,processed:report.processed,pdfBytes:pdf.length,endpoints};
   }
   await request('/api/locations');
   await request('/api/system-info');
   const articles=await request('/api/sales/articles?query=Sony&limit=20');
   assert.ok((articles.items||articles.articles||articles.rows||[]).length>0,'Historical Sony articles');
   await request('/api/schedule?week=2026-09-07&locationId='+encodeURIComponent(location.id));
   const pdf=await request('/api/schedule.pdf?week=2026-09-07&locationId='+encodeURIComponent(location.id));assert.ok(Buffer.isBuffer(pdf)&&pdf.subarray(0,5).toString()==='%PDF-');
   const receipts=await request('/api/receipt-search/context');assert.equal(receipts.available,true);
   const context=await request('/api/sales-report-jobs/context');assert.ok(context);
   // More simultaneous reads than Core has business connections. Authorization
   // must retain its own connection and reject a revoked session after the load.
   await Promise.all(Array.from({length:8},()=>request('/api/locations')));
   const importCatalog=await request('/api/sales/articles/import/catalog');
   const profile=require('../../../../lib/tradefoto-article-source-profile');
   const articleNumber=String(crypto.randomInt(900000,999999));
   const existingArticle=await request('/api/sales/articles?query='+articleNumber);assert.equal(existingArticle.items.length,0,'Fixture never overwrites an existing article');
   const articleRow={EAN:articleNumber.padStart(13,'0'),Artikelbezeichnung:'PostgreSQL Importprobe',MWST:1};
   for(const entry of [...profile.TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS,...profile.TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS])articleRow[entry.sourceField]=null;
   const exchange={format:importCatalog.format,sourceSystem:importCatalog.sourceSystem,sourceProfileVersion:importCatalog.sourceProfileVersion,sourceSchemaSha256:importCatalog.sourceSchemaSha256,snapshotAt:new Date().toISOString(),currency:'EUR',articles:[{articleRow,aliasRows:[]}]};
   const preview=await request('/api/sales/articles/import/preview',{method:'POST',body:exchange,contentType:importCatalog.mimeType,expected:201});
   assert.equal(preview.summary.create,1,'Synthetic import must contain one valid new article');
   await request('/api/sales/articles/import/apply',{method:'POST',body:{previewId:preview.previewId,confirmationFingerprint:'0'.repeat(64)},expected:409});
   const imported=await request('/api/sales/articles/import/apply',{method:'POST',body:{previewId:preview.previewId,confirmationFingerprint:preview.confirmationFingerprint},expected:201});
   assert.ok(imported.personalActionId,'Import has a durable Core action receipt');
   const importSearch=await request('/api/sales/articles?query='+articleNumber);assert.equal(importSearch.items.length,1);
   await request('/api/portal/v1/me/actions/'+encodeURIComponent(imported.personalActionId)+'/undo',{method:'POST',body:{}});
   const replayUndo=await request('/api/portal/v1/me/actions/'+encodeURIComponent(imported.personalActionId)+'/undo',{method:'POST',body:{}});assert.equal(replayUndo.alreadyUndone,true);
   const workRuleReceipts=await subject.ensureWorkRuleEvaluationReceiptIntegrity({deep:true});assert.ok(Number.isSafeInteger(workRuleReceipts));
   const receiptResult=await request('/api/receipt-search/search',{method:'POST',body:{sourceId:'compact-cash',kind:'receipts',dateFrom:'2026-01-23',dateTo:'2026-01-23',locationId:'18',limit:20,query:'Sony'}});assert.ok(receiptResult);
   const job=await request('/api/sales-report-jobs',{method:'POST',body:{title:'PostgreSQL Generalprobe Januar',query:{sourceId:'compact-cash',reportVersion:3,kind:'sales',dateFrom:'2026-01-01',dateTo:'2026-01-31',locationIds:['18'],groupBy:['manufacturer'],metrics:['netRevenue','grossMargin','quantity','receiptCount'],orientation:'landscape',chartType:'bars'}}});
   let report;
   for(let step=0;step<50;step++){
    if(managed)await new Promise(resolve=>setTimeout(resolve,3000));else await subject.runSalesReportQueueForTests();
    report=(await request('/api/sales-report-jobs')).find(row=>row.id===job.id);assert.ok(report);assert.notEqual(report.status,'failed',report.error);
    if(report.status==='completed')break;
   }
   assert.equal(report.status,'completed');assert.ok(report.processed>0);
   const salesPdf=await request('/api/sales-report-jobs/'+job.id+'/download');assert.ok(Buffer.isBuffer(salesPdf)&&salesPdf.subarray(0,5).toString()==='%PDF-');
   await request('/api/sales-report-jobs/'+job.id,{method:'DELETE'});
   await fixtureAccess.prepare('UPDATE portal_users SET active=0 WHERE employee_number=?').run(identity);
   await request('/api/sales-report-jobs',{expected:401});
   return {passed:true,provider:'postgresql-pair',http:true,fullApplicationSmoke:true,workRuleReceipts,endpoints,authenticatedLogin:true,historicalArticleSearch:true,concurrentAuthorizedReads:8,importConfirmed:true,importConflictRejected:true,importUndo:true,schedulePdfBytes:pdf.length,salesPdfBytes:salesPdf.length,salesPositions:report.processed,revokedSessionRejected:true};
  }finally{
   await fixtureAccess.prepare('UPDATE portal_users SET active=0 WHERE employee_number=?').run(identity);
   await fixtureAccess.prepare('UPDATE employees SET active=0 WHERE personnel_number=?').run(identity);
  }
 }finally{
  clearInterval(sampling);await fixtureAccess?.close();
  if(managed){
   if(server)await fetch('http://127.0.0.1:55488/api/service/stop',{method:'POST',headers:{'X-Grabenplaner-Service-Token':process.env.GRABENPLANER_SERVICE_CONTROL_TOKEN}}).catch(()=>{});
  }else{if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await subject.closePersistenceForTests();}
 }
}
module.exports={qualifyHttp};
