"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {mobileScheduleFocus}=require('../lib/mobile-schedule-focus');
const {employmentProjection}=require('../lib/schedule-employment');
const {functionSource}=require('../test-support/learning-workspace-ui');
const shift=(date,endTime='18:00')=>({date,startTime:'09:00',endTime});
const focus=(overrides={})=>mobileScheduleFocus({today:'2026-10-13',time:'17:59',shifts:[shift('2026-10-13'),shift('2026-10-14')],opening:async()=>({start:'09:00',end:'18:00'}),isClosed:()=>false,...overrides});
test('branch schedule stays on today until branch and last duty have ended',async()=>{
 assert.equal(await focus(),'2026-10-13');assert.equal(await focus({time:'18:00'}),'2026-10-14');
 assert.equal(await focus({time:'18:30',shifts:[shift('2026-10-13','19:00'),shift('2026-10-14')]}),'2026-10-13');
 assert.equal(await focus({time:'17:00',shifts:[shift('2026-10-13','16:00'),shift('2026-10-14')]}),'2026-10-13');
});
test('next open scheduled day skips past dates, weekends, holidays, blocks and unscheduled days',async()=>{
 assert.equal(await focus({today:'2026-10-23',time:'18:00',shifts:['2026-10-22','2026-10-23','2026-10-24','2026-10-25','2026-10-26','2026-10-27','2026-10-29'].map(d=>shift(d)),isClosed:d=>['2026-10-26','2026-10-27'].includes(d),opening:d=>['2026-10-24','2026-10-25'].includes(d)?null:{end:'18:00'}}),'2026-10-29');
 assert.equal(await focus({today:'2026-12-31',time:'18:01',shifts:[shift('2026-12-31'),shift('2027-01-04')]}),'2027-01-04');
 assert.equal(await focus({shifts:[]}),null);
});
test('focus route keeps organization and location permission checks before every query; ordinary week requests stay ordinary',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const a=source.indexOf('app.get("/api/portal/v1/location-dashboard/schedule",'),b=source.indexOf('\napp.get(',a+1);
 const calls=[],context={app:{get:(url,handler)=>context.route=handler},ORGANIZATION_SCHEDULE_PERMISSION:'branch_schedule:read',
 requirePortalSession:()=>({sessionKind:'organization',homeLocationId:'BEISPIEL'}),assertSessionContextScope:(s,c)=>{if(c.locationId!=='BEISPIEL')throw Error('FORBIDDEN');},normalizeLocationId:String,httpError:(s,m)=>Error(m),
 validateLocationExists:async id=>({id,name:'BEISPIEL'}),getMonday:d=>d,currentWeekStart:()=> '2026-10-12',isIsoDate:()=>true,addDays:(d,n)=>n===35?'2026-11-17':'2026-10-18',getIsoWeek:()=>42,
 viennaTodayIso:()=> '2026-10-13',viennaNowLocal:()=> '2026-10-13T18:01',settingsForLocation:async()=>({}),operatingHours:async()=>({end:'18:00'}),publicHolidayName:()=>'',getGlobalDayBlockForDate:()=>null,
 projectScheduleEmployment:async(rows,from,to)=>employmentProjection(rows,from,to,new Map()),
 planningSettingsRepository:{listScheduleEmployees:async()=>[{personnel_number:'synthetic'}],listScheduleShifts:async query=>{calls.push(query);return [shift('2026-10-13'),shift('2026-10-14')].map(s=>({employee_number:'synthetic',shift_date:s.date,start_time:s.startTime,end_time:s.endTime}));}},branchOrderOperations:{branchPortalSettingsSnapshot:async()=>({})},require:()=>({mobileScheduleFocus})};
 vm.runInNewContext(source.slice(a,b),context);let result;const response={json:v=>result=v};
 await context.route({query:{week:'2026-10-12'}},response);assert.equal(calls.length,1);assert.equal(Object.hasOwn(result,'focusDate'),false);
 await context.route({query:{focus:'current'}},response);assert.equal(calls.length,3);assert.equal(result.focusDate,'2026-10-14');assert.equal(calls[1].locationId,'BEISPIEL');assert.equal(calls[1].weekEnd,'2026-11-17');
 await assert.rejects(()=>context.route({query:{focus:'current',locationId:'FOREIGN'}},response),/FORBIDDEN/);assert.equal(calls.length,3);
 context.requirePortalSession=()=>({sessionKind:'employee'});await assert.rejects(()=>context.route({query:{focus:'current'}},response));assert.equal(calls.length,3);
});

test('late schedule responses cannot replace a newer week or a changed account',async()=>{
 const pending=[],renders=[],frames=[],state={session:{id:'BEISPIEL'},weekStart:'2026-10-12',activeTab:'schedule'};
 const context={portalState:state,isOrganizationAccount:()=>true,isBranchMobileAccount:()=>true,
 api:url=>new Promise(resolve=>pending.push({url,resolve})),renderSchedule:d=>renders.push(d),requestAnimationFrame:fn=>frames.push(fn),el:{scheduleHeading:{},scheduleGrid:{querySelectorAll:()=>[]}}};
 vm.runInNewContext('let scheduleRequestGeneration=0;'+functionSource('loadSchedule','portal.js'),context);
 const old=context.loadSchedule({focus:true});state.weekStart='2026-10-19';const next=context.loadSchedule();
 pending[1].resolve({weekStart:'2026-10-19'});await next;pending[0].resolve({weekStart:'2026-10-12',focusDate:'2026-10-13'});await old;
 assert.deepEqual(renders,[{weekStart:'2026-10-19'}]);assert.equal(frames.length,0);assert(pending[0].url.includes('focus=current'));assert(!pending[1].url.includes('focus='));
 const changing=context.loadSchedule();state.session={id:'ANOTHER'};pending[2].resolve({weekStart:'2026-10-26'});await changing;assert.equal(renders.length,1);
});
