"use strict";
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const presentation=require('../public/gp-xoffi-import');
function functionSource(name){const source=fs.readFileSync(require.resolve('../public/app.js'),'utf8').replace(/\r\n/g,'\n'),prefix=source.includes('async function '+name+'(')?'async function ':'function ',start=source.indexOf(prefix+name+'('),end=source.indexOf('\n}\n',start);assert.ok(start>=0&&end>start,name);return source.slice(start,end+3);}
function importSource(){const source=fs.readFileSync(require.resolve('../public/app.js'),'utf8').replace(/\r\n/g,'\n');return source.slice(source.indexOf('function xoffiHoursInput('),source.indexOf('\nasync function saveMobilePortalLocationDisplay('));}
const classList=()=>({add(){},remove(){},toggle(){}});
const input=(value='')=>({value,checked:false,disabled:false,files:[],setAttribute(){},focus(){}});
function rowNode(source,index){
 const fields={employee:input(source.reviewStatus==='invalid'?'':source.employeeNumber),
  'week-actual':input((source.weeklyActualMinutes/60).toFixed(2)),'week-valued':input((source.weeklyValuedMinutes/60).toFixed(2)),
  'week-surcharge':input((source.weeklySurchargeMinutes/60).toFixed(2)),balance:input('')};
 const days=(source.days||[]).map((day,dayIndex)=>{const fields={intervals:input(day.intervals.join(', ')),
  'day-actual':input((day.actualMinutes/60).toFixed(2)),'day-valued':input((day.valuedMinutes/60).toFixed(2)),
  'day-surcharge':input((day.surchargeMinutes/60).toFixed(2))};return{fields,dataset:{xoffiDay:String(dayIndex),workDate:day.workDate,confidence:day.confidence},querySelector(selector){return fields[selector.slice(12,-1)];}};});
 return{fields,days,classList:classList(),dataset:{sourceName:source.sourceName,xoffiRow:String(index),reviewStatus:source.reviewStatus,matchConfidence:source.matchConfidence},
  querySelector(selector){return fields[selector.slice(12,-1)];},querySelectorAll(selector){return selector==='[data-xoffi-day]'?days:Object.values(fields).filter(field=>field!==fields.employee);}};
}
function harness(){
 const state={locationId:'18',departmentId:'7',weekStart:'2026-09-07',data:{weekStart:'2026-09-07',context:{locationId:'18',departmentId:7}},
  portalStatus:{portalEnabled:true,installationFeatures:{timeTracking:true}},portalSession:{authenticated:true,user:{employeeNumber:'E1',accountId:'account-E1',sessionKind:'employee',isEmployee:true,active:true,role:'manager',permissions:['xoffi_time_import:manage'],scopes:[{locationId:'18',departmentId:7}]}},xoffiImportPreview:null};
 const elements={xoffiImportDialog:{open:false,show(){this.open=true;},close(){this.open=false;}},xoffiImportPreview:{rows:[],html:'',classList:classList(),querySelectorAll(){return this.rows;},querySelector(){return this.blocker;},blocker:{hidden:true,querySelector(){return this.message;},message:{textContent:''}}},
  xoffiImportConfirmation:{classList:classList()},xoffiScreenshotWeekConfirmation:{classList:classList()},xoffiImportStatus:{textContent:'',focus(){}},xoffiScreenshotWeekConfirmationText:{},xoffiScreenshotWeekConfirmationLabel:{}};
 for(const name of ['xoffiImportFile','xoffiImportConfirmed','xoffiScreenshotWeekConfirmed','xoffiUseAsActual','xoffiInspectButton','xoffiApplyButton'])elements[name]=input();
 Object.defineProperty(elements.xoffiImportPreview,'innerHTML',{get(){return this.html;},set(value){this.html=value;this.rows=value?(state.xoffiImportPreview?.employees||[]).map(rowNode):[];}});
 const controls=()=>[elements.xoffiImportFile,elements.xoffiImportConfirmed,elements.xoffiScreenshotWeekConfirmed,elements.xoffiUseAsActual,...elements.xoffiImportPreview.rows.flatMap(row=>[...Object.values(row.fields),...row.days.flatMap(day=>Object.values(day.fields))])];
 elements.xoffiImportForm={reset(){for(const element of controls()){element.checked=false;}elements.xoffiImportFile.files=[];},querySelectorAll:controls};
 const calls=[],toasts=[];
 let raw=()=>Promise.reject(new Error('test raw API not configured')),api=()=>Promise.reject(new Error('test API not configured'));
 const context=vm.createContext({state,elements,window:{GpXoffiImport:presentation},URLSearchParams,AbortController,
  isLocalStartDashboardWorkspace:()=>false,canImportXoffiTime:()=>state.portalSession?.user?.permissions?.includes('xoffi_time_import:manage')===true,
  syncGpWindows(){context.syncXoffiImport();},rawApi:(url,options)=>{calls.push({kind:'inspect',url,options});return raw(url,options);},
  api:(url,options)=>{calls.push({kind:'apply',url,options});return api(url,options);},showToast:(message,error=false)=>toasts.push({message,error}),
  applyLoadedSchedule(schedule){state.data=schedule;state.weekStart=schedule.weekStart;state.locationId=schedule.context.locationId;state.departmentId=String(schedule.context.departmentId||'');},
  render(){calls.push({kind:'render'});context.syncXoffiImport();},getIsoWeek:()=>37,formatDate:value=>value,
  addDays:(value,count)=>{const d=new Date(value+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+count);return d.toISOString().slice(0,10);}});
 vm.runInContext(functionSource('startDashboardWorkspaceActorKey')+'\n'+importSource(),context);
 return{state,elements,context,calls,toasts,controls,setRaw(fn){raw=fn;},setApi(fn){api=fn;},open(){context.openXoffiImport();elements.xoffiImportFile.files=[{name:'BEISPIEL.mhtml',type:'application/octet-stream'}];},load(preview){state.xoffiImportPreview=structuredClone(preview);context.renderXoffiImportPreview();elements.xoffiImportConfirmed.checked=true;context.updateXoffiApplyAvailability();}};
}
module.exports={functionSource,importSource,harness};
