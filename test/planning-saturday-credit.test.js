"use strict";
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const planningSaturdayCredit = require('../lib/planning-saturday-credit');
const { allocateSaturdayMinutes, plannedWorkSegments } = require('../lib/work-rules/saturday-credit-time');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { SQLITE_SATURDAY_CREDIT_CATALOG } = require('../lib/persistence/sqlite/saturday-credit-catalog');
const { ensureSqliteSaturdayCreditSchema } = require('../lib/persistence/sqlite/operations/saturday-credit-schema');
const { createSaturdayCreditService } = require('../lib/persistence/repositories/saturday-credit');
const source = fs.readFileSync(require.resolve('../server'), 'utf8');
function fn(name) { const a = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm')), b = source.indexOf('\n}', a); assert(a >= 0 && b > a, name); return source.slice(a, b + 2); }
const time = value => { const [h,m] = value.split(':').map(Number); return h*60+m; };
const settings = { break_after_minutes:'360', break_duration_minutes:'30', break_rule_enabled:'1', saturday_bonus_enabled:'1', saturday_bonus_from:'13:00', saturday_bonus_factor:'1.5', planning_saturday_worst_case:'1' };
const shift = (overrides={}) => ({ id:1, employee_number:'434', shift_date:'2026-11-07', start_time:'10:00', end_time:'17:00', location_id:'18', ...overrides });
async function fixture(t) {
  const db = openSqliteApplicationPersistence({ databasePath:':memory:', catalog:SQLITE_SATURDAY_CREDIT_CATALOG }); ensureSqliteSaturdayCreditSchema(db.database);
  const service = createSaturdayCreditService({ access:db.provider, today:()=> '2026-11-07' });
  t.after(async()=>{ await db.provider.close(); db.database.close(); });
  await service.initialize({ effectiveDate:'2026-09-07', legacySettings:{'*':{enabled:true,from:'13:00',factor:1.5}} });
  await service.assign({ employeeNumber:'434', activity:'retail_sales', effectiveDate:'2026-09-07', reason:'Synthetic sales' }, async()=> 'test');
  await service.assign({ employeeNumber:'435', activity:'other', effectiveDate:'2026-09-07', reason:'Synthetic other activity' }, async()=> 'test');
  let peers=[], locations={}, evaluations=0;
  const context = vm.createContext({ planningSaturdayCredit, allocateSaturdayMinutes, plannedWorkSegments, Date, Math, Number, String,
    defaultSettings:settings, timeToMinutes:time, finiteNumberInRange:(v,d,min,max)=>Number.isFinite(Number(v))?Math.min(max,Math.max(min,Number(v))):d,
    settingEnabled:(s,k)=>s[k]==='1', saturdayBonusSettings:()=>({from:'13:00',factor:1.5}), isIsoDate:v=>/^\d{4}-\d{2}-\d{2}$/.test(v), isTime:v=>/^\d{2}:\d{2}$/.test(v||''),
    overlapMinutes:(a,b,c,d)=>Math.max(0,Math.min(b,d)-Math.max(a,c)), isVacationHoliday:()=>false,
    dayConfiguration:async(date,s)=>({lunchEnabled:Boolean(s.lunch),lunchStart:s.lunch?.[0],lunchEnd:s.lunch?.[1]}),
    settingsForLocation:async id=>locations[id]||settings,
    timeTrackingRepository:{listPlannedDayShifts:async()=>peers},
    saturdayCreditService:{cutover:()=>service.cutover(),evaluate:input=>{evaluations++;return service.evaluate(input);}},
  });
  vm.runInContext(fn('plannedShiftBreaks')+'\n'+fn('shiftMetrics')+'\nthis.metrics=shiftMetrics;',context);
  return { metrics:context.metrics, peers:value=>{peers=value;}, locations:value=>{locations=value;}, evaluations:()=>evaluations, service };
}
test('planning values the example week 32h net / 34h worst case for every employee and never evaluates actual credit', async t=>{
  const f=await fixture(t);
  for(const employee_number of ['434','435']) {
    const shifts=['02','03','05'].map(d=>shift({employee_number,shift_date:'2026-11-'+d,start_time:'09:00',end_time:'18:00'})).concat(shift({employee_number}));
    const result=await Promise.all(shifts.map(s=>f.metrics(s,settings,{planning:true})));
    assert.equal(result.reduce((n,r)=>n+r.raw_minutes-r.break_minutes,0),1920);
    assert.equal(result.reduce((n,r)=>n+r.counted_minutes,0),2040);
    assert.equal(result[3].bonus_minutes,120); assert.equal(result[3].saturday_credit_receipt,undefined);
  }
  const during=await f.metrics(shift(),{...settings,lunch:['13:15','13:45']},{planning:true});
  const before=await f.metrics(shift(),{...settings,lunch:['12:00','12:30']},{planning:true});
  assert.equal(during.counted_minutes,510); assert.equal(before.counted_minutes,510); assert.equal(f.evaluations(),0);
});
test('actual-time and exact planned comparisons retain employee eligibility and pause rules',async t=>{
  const f=await fixture(t);
  const exact=await f.metrics(shift(),{...settings,lunch:['13:15','13:45']});
  assert.equal(exact.bonus_minutes,105); assert.equal(exact.counted_minutes,495);
  const unresolved=await f.metrics(shift(),settings); assert.equal(unresolved.bonus_minutes,0); assert.equal(unresolved.saturday_credit_status,'review_required');
  const other=await f.metrics(shift({employee_number:'435'}),{...settings,lunch:['13:15','13:45']}); assert.equal(other.bonus_minutes,0);
  const input={employeeNumber:'434',workDate:'2026-11-07',source:'actual',segments:[{startMinute:780,endMinute:1020,workClassification:'normal'}],dayComplete:true,breaksResolved:true,publicHoliday:false,persist:true,legacy:{workedMinutes:240,saturdayBonusMinutes:120,valuedMinutes:360}};
  const saved=await f.service.evaluate(input); await f.metrics(shift(),settings,{planning:true}); assert.deepEqual(await f.service.evaluate(input),saved);
});
test('planning rounds once across split locations, honors each location switch and stops at Saturday midnight',async t=>{
  const f=await fixture(t), a=shift({id:1,start_time:'13:00',end_time:'13:15'}), b=shift({id:2,location_id:'05',start_time:'13:15',end_time:'13:30'});
  f.peers([a,b]); assert.equal((await f.metrics(a,settings,{planning:true})).bonus_minutes,8); assert.equal((await f.metrics(b,settings,{planning:true})).bonus_minutes,7);
  f.locations({'05':{...settings,planning_saturday_worst_case:'0'}});
  assert.equal((await f.metrics(a,settings,{planning:true})).bonus_minutes,8); assert.equal((await f.metrics(b,{...settings,planning_saturday_worst_case:'0'},{planning:true})).bonus_minutes,0);
  f.peers([]);
  assert.equal((await f.metrics(shift({start_time:'10:00',end_time:'12:00'}),settings,{planning:true})).bonus_minutes,0);
  assert.equal((await f.metrics(shift({start_time:'22:00',end_time:'02:00'}),settings,{planning:true})).bonus_minutes,60);
  assert.equal(planningSaturdayCredit.enabled({},'18'),true); assert.equal(planningSaturdayCredit.enabled({[planningSaturdayCredit.settingKey('18')]:'0'},'18'),false);
});
