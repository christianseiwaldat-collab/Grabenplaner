'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../server.js'),'utf8').replace(/\r\n/g,'\n');
function extract(text,name){
 const marker='function '+name+'(',point=text.indexOf(marker),start=text.slice(point-6,point)==='async '?point-6:point,end=text.indexOf('\n}\n',point);
 assert.ok(point>=0&&end>point);return text.slice(start,end+3);
}
const context={locationId:'18',departmentId:7};
function fixture(initial){
 let shifts=initial;const calls=[];
 const sandbox=vm.createContext({Date,Intl,process:{env:{}},httpError:(status,message,code)=>Object.assign(new Error(message),{status,code}),
  planningSettingsRepository:{async listScheduleShifts(query){calls.push(JSON.parse(JSON.stringify(query)));return shifts;}}});
 vm.runInContext(['isIsoDate','isTime','addDays','getMonday','viennaTodayIso','viennaNowLocal','viennaLocalDateTime','assertCompletedXoffiWeek'].map(name=>extract(source,name)).join('\n'),sandbox);
 return {check:(instant,week='2026-09-14')=>sandbox.assertCompletedXoffiWeek(week,context,new Date(instant)),calls,set:value=>{shifts=value;}};
}
const saturday={shift_date:'2026-09-19',start_time:'09:00',end_time:'17:00'};
test('KW38 opens exactly Saturday 17:00 Vienna, including on a UTC server',async()=>{
 const f=fixture([saturday]);
 await assert.rejects(f.check('2026-09-19T14:59:59Z'),e=>e.code==='XOFFI_WEEK_NOT_PAST'&&e.message.includes('17:00'));
 assert.equal(await f.check('2026-09-19T15:00:00Z'),'2026-09-14');
 assert.equal(await f.check('2026-09-20T08:00:00Z'),'2026-09-14');
 assert.deepEqual(f.calls[0],{locationId:'18',departmentId:7,weekStart:'2026-09-14',weekEnd:'2026-09-20'});
});
test('a later Sunday shift and a changed plan delay the final apply check',async()=>{
 const f=fixture([saturday]);assert.equal(await f.check('2026-09-19T16:00:00Z'),'2026-09-14');
 f.set([saturday,{shift_date:'2026-09-20',start_time:'09:00',end_time:'13:00'}]);
 await assert.rejects(f.check('2026-09-19T16:00:00Z'),{code:'XOFFI_WEEK_NOT_PAST'});
 assert.equal(await f.check('2026-09-20T11:00:00Z'),'2026-09-14');
});
test('overnight duty only finishes the following day',async()=>{
 const f=fixture([{...saturday,start_time:'22:00',end_time:'02:00'}]);
 await assert.rejects(f.check('2026-09-19T23:59:59Z'),{code:'XOFFI_WEEK_NOT_PAST'});
 assert.equal(await f.check('2026-09-20T00:00:00Z'),'2026-09-14');
});
test('future, empty and invalid current plans stay blocked; past weeks remain importable',async()=>{
 const f=fixture([]);
 await assert.rejects(f.check('2026-09-19T16:00:00Z'),/kein letzter Dienst/);
 await assert.rejects(f.check('2026-09-19T16:00:00Z','2026-09-21'),{code:'XOFFI_WEEK_NOT_PAST'});
 assert.equal(await f.check('2026-09-19T16:00:00Z','2026-09-07'),'2026-09-07');
 await assert.rejects(f.check('2026-09-19T16:00:00Z','2026-09-15'),{code:'XOFFI_WEEK_INVALID'});
 f.set([{...saturday,end_time:''}]);await assert.rejects(f.check('2026-09-19T16:00:00Z'),/nicht eindeutig/);
});
test('winter time uses Vienna UTC+1 and not the summer offset',async()=>{
 const f=fixture([{shift_date:'2026-12-19',start_time:'09:00',end_time:'17:00'}]);
 await assert.rejects(f.check('2026-12-19T15:59:59Z','2026-12-14'),{code:'XOFFI_WEEK_NOT_PAST'});
 assert.equal(await f.check('2026-12-19T16:00:00Z','2026-12-14'),'2026-12-14');
});
test('inspect and apply both await current service completion after resolving authorized context',()=>{
 assert.match(source,/await assertCompletedXoffiWeek\(inspected\.weekStart, context\)/);
 assert.match(source,/await assertCompletedXoffiWeek\(preview\.weekStart, context\)/);
 const route=source.slice(source.indexOf('app.post("/api/portal/v1/xoffi-time-import/apply"'));
 assert.ok(route.indexOf('await xoffiTimeImportContext')<route.indexOf('await assertCompletedXoffiWeek'));
});
test('an accepted current-week import displays its imported badge',()=>{
 const app=fs.readFileSync(require.resolve('../public/app.js'),'utf8').replace(/\r\n/g,'\n');
 const sandbox=vm.createContext({state:{data:{isPastWeek:false,calendarWeek:38,xoffiTime:{weekByEmployee:{'1':{useAsActual:true,days:Array(7).fill({})}}}}},escapeHtmlAttribute:x=>x});
 vm.runInContext(extract(app,'xoffiImportedBadge'),sandbox);
 assert.match(sandbox.xoffiImportedBadge('1'),/xoffi-Stunden für KW 38 übernommen/);
 assert.equal(sandbox.xoffiImportedBadge('2'),'');
});
