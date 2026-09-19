'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {withCoreFixture}=require('../test-support/postgresql-migration/core-fixture');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');

test('native PostgreSQL: complete weeks keep parity, fresh writes and rights with bounded read work',
  {skip:!process.env.GP_PG_MIGRATION_LIVE,timeout:process.env.GP_SCHEDULE_BROWSER_QA?600000:180000},async()=>withCoreFixture(async core=>withSalesFixture(8,async()=>{
    // This test runs only against the existing guarded, empty development pair.
    // The fixture owns its synthetic rows; productive activation is untouched.
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-schedule-native-'));
    const configuration=require('../lib/persistence/configuration');
    const originalConfiguration=configuration.resolvePersistenceConfiguration;
    const application=require('../lib/persistence/postgresql/application');
    const originalOpen=application.openDeferredPostgresqlApplication;
    let optimized=true,queries=[],authorizations=0,subject,httpServer,revokeBeforeCommit=false,applicationAccess;
    const environment={NODE_ENV:'test',DB_PROVIDER:'postgresql',GRABENPLANER_DATA_DIR:root,
      DB_PATH:path.join(root,'core.postgresql'),BACKUP_DIR:path.join(root,'backups'),
      GRABENPLANER_HOST:'127.0.0.1',GRABENPLANER_FORCE_PORTAL:'1',GRABENPLANER_TEST_TODAY:'2026-09-14',TZ:'Europe/Vienna',
      GRABENPLANER_AMU_KEY:Buffer.alloc(32,42).toString('base64'),GRABENPLANER_AMU_KEY_ID:'synthetic-schedule'};
    const previous=Object.fromEntries(Object.keys(environment).map(k=>[k,process.env[k]]));
    Object.assign(process.env,environment);
    configuration.resolvePersistenceConfiguration=()=>({providerId:'postgresql',databasePath:environment.DB_PATH,
      coreUrl:process.env.GP_CORE_APP_URL,salesUrl:process.env.GP_SALES_APP_URL,
      readers:{coreUrl:process.env.GP_CORE_READER_URL,salesUrl:process.env.GP_SALES_READER_URL},rehearsal:true});
    application.openDeferredPostgresqlApplication=options=>{
      const app=originalOpen({...options,onOperation:id=>queries.push(id),authorize:async input=>{
        authorizations++;
        if(revokeBeforeCommit&&input.readOnly&&input.statementIds.includes('planning-settings.schedule.shifts')){
          revokeBeforeCommit=false;
          await core.migrator.query('BEGIN');await core.migrator.query('SET LOCAL ROLE gp_core_owner');
          await core.migrator.query("UPDATE gp.portal_users SET active=0 WHERE employee_number='00001'");await core.migrator.query('COMMIT');
        }
        return options.authorize(input);
      }});
      applicationAccess=app.provider;
      return Object.freeze({...app,readSnapshot:work=>optimized?app.readSnapshot(work):work()});
    };
    try {
      await core.migrator.query('BEGIN');await core.migrator.query('SET LOCAL ROLE gp_core_owner');
      await core.migrator.query("INSERT INTO gp.cost_centers(id,code,name,type,cost_center_type_id) VALUES('cc05','05','Synthetic second branch','branch','branch')");
      await core.migrator.query("INSERT INTO gp.locations(id,name,cost_center_id) VALUES('05','Synthetic second branch','cc05')");
      await core.migrator.query(`INSERT INTO gp.employees(personnel_number,full_name,nickname,home_location_id)
        SELECT 'vac-05-'||n,'Synthetic Vacation '||n,'Vacation '||n,'05' FROM generate_series(1,18) n`);
      await core.migrator.query(`INSERT INTO gp.employees(personnel_number,full_name,nickname,home_location_id,position_id,contracted_hours)
        SELECT 'perf-'||n,'Synthetic '||n,'Test '||n,'18','verkaufsmitarbeiter',38.5 FROM generate_series(1,18) n`);
      await core.migrator.query(`INSERT INTO gp.shifts(employee_number,location_id,department_id,shift_date,start_time,end_time,area,note)
        SELECT 'perf-'||n,'18',1,to_char(d,'YYYY-MM-DD'),'09:00','17:00','Test','Synthetic performance fixture'
        FROM generate_series(1,18) n CROSS JOIN generate_series('2026-08-31'::date,'2026-09-26'::date,'1 day'::interval) d
        WHERE extract(isodow FROM d)<=6`);
      await core.migrator.query(`INSERT INTO gp.week_options(employee_number,week_start,date_from,date_to,option_type,group_id)
        SELECT personnel_number,to_char(d,'YYYY-MM-DD'),to_char(d,'YYYY-MM-DD'),to_char(d+'4 days'::interval,'YYYY-MM-DD'),'vacation',personnel_number||to_char(d,'YYYY-MM-DD')
        FROM gp.employees CROSS JOIN generate_series('2026-06-01'::date,'2026-06-22'::date,'7 days'::interval) d`);
      let token=crypto.randomBytes(32).toString('hex');
      await core.migrator.query(`UPDATE gp.portal_users SET must_change_password=0 WHERE employee_number='00001'`);
      await core.migrator.query(`INSERT INTO gp.portal_sessions(id,employee_number,token_hash,expires_at) VALUES($1,'00001',$2,'2099-01-01T00:00:00.000Z')`,[crypto.randomUUID(),crypto.createHash('sha256').update(token).digest('hex')]);
      await core.migrator.query('COMMIT');
      subject=require('../server');await subject.initializeApplicationPersistence();
      const protection=require('../lib/amu-storage').createAmuStorage({rootDirectory:path.join(root,'synthetic-protection'),
        encryptionKeys:{'synthetic-schedule':Buffer.alloc(32,42)},activeKeyId:'synthetic-schedule'});
      const lookup=(kind,value)=>crypto.createHmac('sha256',Buffer.alloc(32,42)).update(`grabenplaner-sickness-index-v1\0${kind}\0${value}`).digest('hex');
      for(let n=1;n<=5;n++){
        const employeeNumber='perf-'+n,employeeLookup=lookup('employee',employeeNumber);
        const sickness=subject.sicknessAmuManagementRepository;
        const inserted=await sickness.insertSicknessCase({employeeLookup,statusLookup:lookup('status','reported'),protectedPayload:'',purgeAfter:'2099-01-01'});
        const id=inserted.returnedRows[0].data.id;
        await sickness.updateSicknessCasePayloadInitial({id,protectedPayload:protection.protectRecord(JSON.stringify({employeeNumber,locationId:'18',departmentId:1,
          startDate:'2026-09-14',expectedEnd:'2026-09-15',status:'reported',note:'Synthetic',reportedAt:'2026-09-14T08:00:00Z'}),
          {namespace:'sickness-case',recordId:String(id),field:'payload',employeeNumber:employeeLookup})});
        const report=await sickness.insertAmuReport({sicknessCaseId:id,employeeNumber,locationId:'18',departmentId:1,status:'submitted'});
        const reportId=report.returnedRows[0].data.id;
        await sickness.updateAmuReportPayload({id:reportId,protectedPayload:protection.protectRecord(JSON.stringify({incapacityFrom:'2026-09-14',incapacityTo:'2026-09-15'}),
          {namespace:'personnel-record',recordId:String(reportId),field:'payload',employeeNumber})});
        await core.postgresRepositories.absenceManagement.insertVacationRequest({employeeNumber,locationId:'18',dateFrom:'2026-10-05',dateTo:'2026-10-09',note:'Synthetic'});
      }
      await subject.saturdayCreditService.initialize({effectiveDate:'2026-09-07',legacySettings:{'*':{enabled:true,from:'13:00',factor:1.5}},
        existingEmployees:async()=>Array.from({length:18},(_,i)=>'perf-'+(i+1))});
      httpServer=await new Promise(resolve=>{const server=subject.app.listen(0,'127.0.0.1',()=>resolve(server));});
      const url='http://127.0.0.1:'+httpServer.address().port;
      async function request(route,expected=200){
        const at=performance.now(),response=await fetch(url+route,{headers:{Cookie:'grabenplaner_session='+token},signal:AbortSignal.timeout(45000)});
        const body=await response.json();assert.equal(response.status,expected,JSON.stringify({route,body}));
        return {body,milliseconds:Math.round(performance.now()-at)};
      }
      const route='/api/schedule?location=18&week=2026-09-14';
      await request(route); // Warm connections; benchmark the normal week switch.
      const evidence=[];let baseline;
      for(const enabled of [false,true]){
        optimized=enabled;queries=[];authorizations=0;
        const result=await request(route);
        if(!enabled)baseline=result.body;else assert.deepEqual(result.body,baseline);
        evidence.push({optimized:enabled,milliseconds:result.milliseconds,queries:queries.length,authorizations,
          topQueries:Object.entries(queries.reduce((m,id)=>(m[id]=(m[id]||0)+1,m),{})).sort((a,b)=>b[1]-a[1]).slice(0,8)});
      }
      assert.ok(evidence[1].authorizations<evidence[0].authorizations/4,JSON.stringify(evidence));
      assert.ok(evidence[1].queries<evidence[0].queries/2,JSON.stringify(evidence));
      for(const week of ['2026-09-07','2026-09-21','2026-09-14']){
        const result=await request('/api/schedule?location=18&week='+week);
        assert.equal(result.body.weekStart,week);assert.equal(result.body.shifts.length,108+(week==='2026-09-07'?1:0));
        evidence.push({week,milliseconds:result.milliseconds});
      }
      await core.migrator.query('BEGIN');await core.migrator.query('SET LOCAL ROLE gp_core_owner');
      await core.migrator.query("UPDATE gp.shifts SET end_time='16:00' WHERE employee_number='perf-1' AND shift_date='2026-09-14'");await core.migrator.query('COMMIT');
      assert.equal((await request(route)).body.shifts.find(s=>s.employee_number==='perf-1'&&s.shift_date==='2026-09-14').end_time,'16:00');
      const concurrent=await Promise.all([request(route),request('/api/portal/v1/absence-requests'),request('/api/portal/v1/amu-reports'),request('/api/portal/v1/sickness-cases')]);
      assert.equal(concurrent[1].body.requests.length,5);assert.equal(concurrent[2].body.reports.length,5);assert.equal(concurrent[3].body.cases.length,5);
      evidence.push({concurrentMilliseconds:concurrent.map(r=>r.milliseconds)});
      const vacationEvidence=[];let vacationBaseline;
      for(const enabled of [false,true]){
        optimized=enabled;queries=[];authorizations=0;
        const result=await request('/api/vacations?year=2026&location=18');
        if(!enabled)vacationBaseline=result.body;else assert.deepEqual(result.body,vacationBaseline);
        assert.equal(result.body.employees.length,21);assert.equal(result.body.vacations.length,84);
        vacationEvidence.push({optimized:enabled,milliseconds:result.milliseconds,queries:queries.length,authorizations});
      }
      for(const location of ['05','18','05']){
        const result=await request('/api/vacations?year=2026&location='+location);
        assert.equal(result.body.context.locationId,location);
        assert.equal(result.body.vacations.length,location==='05'?72:84);
        assert.ok(result.body.employees.every(e=>e.home_location_id===location));
        vacationEvidence.push({location,milliseconds:result.milliseconds});
      }
      console.log('vacation-read-model-evidence '+JSON.stringify(vacationEvidence));
      const employeeEvidence=[];let employeeBaseline;
      for(const enabled of [false,true]){
        optimized=enabled;queries=[];authorizations=0;
        const result=await request('/api/employees');
        if(!enabled)employeeBaseline=result.body;else assert.deepEqual(result.body,employeeBaseline);
        employeeEvidence.push({optimized:enabled,milliseconds:result.milliseconds,queries:queries.length,authorizations});
      }
      assert.ok(employeeEvidence[1].authorizations<employeeEvidence[0].authorizations/4,JSON.stringify(employeeEvidence));
      console.log('employee-read-model-evidence '+JSON.stringify(employeeEvidence));
      const repository=require('../lib/persistence/repositories/sales-analytics').createSalesAnalyticsPersistenceRepository(applicationAccess);
      const reports=[];
      for(const month of [7,8]) reports.push(await repository.recordConfirmedTradeFotoReport({preview:require('../test-support/postgresql-migration/aggregate-fixture').aggregatePreview({month}),locationId:'18',currency:'EUR',confirmed:true,actor:'00001',timestamp:'2026-09-17T12:00:00.000Z'}));
      const selection={version:1,reportId:reports[0].report.id,locationFilter:'18',dateFrom:'2026-01-01',dateTo:'2026-12-31',horizon:'period',chartType:'pareto',chartMetric:'grossMargin'};
      const csrf=crypto.randomBytes(24).toString('hex');
      const saveSelection=await fetch(url+'/api/sales-analytics/selection',{method:'PUT',headers:{Cookie:'grabenplaner_session='+token+'; grabenplaner_csrf='+csrf,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify(selection)});
      assert.equal(saveSelection.status,200,await saveSelection.text());
      assert.deepEqual((await request('/api/sales-analytics/selection')).body.selection,selection);
      const noCsrf=await fetch(url+'/api/sales-analytics/selection',{method:'PUT',headers:{Cookie:'grabenplaner_session='+token,'Content-Type':'application/json'},body:JSON.stringify(selection)});
      assert.equal(noCsrf.status,403);
      const otherToken=crypto.randomBytes(32).toString('hex');
      await core.migrator.query('BEGIN');await core.migrator.query('SET LOCAL ROLE gp_core_owner');
      await core.migrator.query("UPDATE gp.portal_users SET role='developer',must_change_password=0 WHERE employee_number='00003'");
      await core.migrator.query(`INSERT INTO gp.portal_sessions(id,employee_number,token_hash,expires_at) VALUES($1,'00003',$2,'2099-01-01T00:00:00.000Z')`,[crypto.randomUUID(),crypto.createHash('sha256').update(otherToken).digest('hex')]);
      await core.migrator.query('COMMIT');
      const otherSelection=await fetch(url+'/api/sales-analytics/selection',{headers:{Cookie:'grabenplaner_session='+otherToken}});
      assert.equal(otherSelection.status,200);assert.equal((await otherSelection.json()).selection,null);
      if(process.env.GP_SCHEDULE_BROWSER_QA){
        const qa=path.resolve(process.env.GP_SCHEDULE_BROWSER_QA),temporaryRoot=path.resolve(__dirname,'../tmp');
        assert.ok(qa.startsWith(temporaryRoot+path.sep),'Browser evidence stays in the local test workspace');
        fs.mkdirSync(qa,{recursive:true});
        const password='Synthetic-Speed-QA-2026!';
        await core.migrator.query('BEGIN');await core.migrator.query('SET LOCAL ROLE gp_core_owner');
        await core.migrator.query("UPDATE gp.portal_users SET password_hash=$1 WHERE employee_number='00001'",[await subject.hashPortalPassword(password)]);
        await core.migrator.query('COMMIT');
        fs.writeFileSync(path.join(qa,'ready.json'),JSON.stringify({url,employeeNumber:'00001',password,synthetic:true,evidence}));
        const deadline=Date.now()+300000;
        while(!fs.existsSync(path.join(qa,'finished'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,500));
        // A normal browser login revokes the earlier fixture session. Start a
        // fresh synthetic session so the next check reaches mid-read revocation.
        token=crypto.randomBytes(32).toString('hex');
        await core.migrator.query('BEGIN');await core.migrator.query('SET LOCAL ROLE gp_core_owner');
        await core.migrator.query(`INSERT INTO gp.portal_sessions(id,employee_number,token_hash,expires_at) VALUES($1,'00001',$2,'2099-01-01T00:00:00.000Z')`,[crypto.randomUUID(),crypto.createHash('sha256').update(token).digest('hex')]);
        await core.migrator.query('COMMIT');
        await request(route);
      }
      revokeBeforeCommit=true;
      const revoked=await request(route,500);assert.equal(revokeBeforeCommit,false);assert.equal(revoked.body.employees,undefined);
      await request(route,401);
      console.log('schedule-read-model-evidence '+JSON.stringify(evidence));
    } finally {
      if(httpServer){httpServer.closeAllConnections();await new Promise(resolve=>httpServer.close(resolve));}
      await subject?.closePersistenceForTests();
      configuration.resolvePersistenceConfiguration=originalConfiguration;application.openDeferredPostgresqlApplication=originalOpen;
      for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
      // Only this freshly created fixture directory is eligible for removal.
      assert.equal(fs.realpathSync(root),root);assert.ok(path.basename(root).startsWith('gp-schedule-native-'));
      fs.rmSync(root,{recursive:true,force:true});
    }
  })));
