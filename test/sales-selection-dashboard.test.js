'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {normalizeSalesAnalysisSelection}=require('../lib/sales-analysis-selection');
const dashboard=require('../public/sales-dashboard-metrics');
const selection={version:1,reportId:'1'.repeat(64),locationFilter:'18',dateFrom:'2026-01-01',dateTo:'2026-08-31',horizon:'period',chartType:'pareto',chartMetric:'grossMargin'};
test('saved analysis selection keeps the report and filters; revoked margin access falls back safely',()=>{
  assert.deepEqual(normalizeSalesAnalysisSelection(selection,{grossMargin:true}),selection);
  assert.equal(normalizeSalesAnalysisSelection(selection).chartMetric,'netRevenue');
  for(const patch of [{reportId:'x'.repeat(129)},{dateFrom:'2026-02-30'},{dateTo:'2025-12-31'},{version:2},{chartMetric:'invented'},{employeeNumber:'other-account'}])assert.throws(()=>normalizeSalesAnalysisSelection({...selection,...patch}));
});
const group=(id,revenue,margin,count,average)=>({externalProductGroupId:id,label:'Group '+id,horizons:{period:{netRevenue:{current:revenue},grossMargin:{current:margin},customerCount:{current:count},revenuePerCustomer:{current:average}}}});
test('dashboard rankings switch between amount, margin rate, customers and PDF average',()=>{
  const detail={rights:{grossMargin:true},productGroups:[group('A',100,10,20,5),group('B',40,20,4,10),group('C',0,5,0,null)]};
  assert.equal(dashboard.ranking(detail,'netRevenue').rows[0].group.externalProductGroupId,'A');
  assert.equal(dashboard.ranking(detail,'grossMargin').rows[0].amount,20);
  const rate=dashboard.ranking(detail,'grossMarginPercent');assert.equal(rate.rows[0].group.externalProductGroupId,'B');assert.equal(rate.rows[0].amount,50);assert.equal(rate.rows.length,2);
  assert.equal(dashboard.ranking(detail,'customerCount').rows[0].amount,20);
  const average=dashboard.ranking(detail,'revenuePerCustomer');assert.equal(average.metric.label,'Ø €/Kunde');assert.equal(average.rows[0].amount,10);assert.equal(average.rows.length,2);
});
test('dashboard neither reveals protected margin nor treats absent values as zero',()=>{
  const detail={rights:{grossMargin:false},productGroups:[group('A',100,20,3,null),group('B',null,99,null,undefined)]};
  assert.ok(dashboard.definitions(detail).every(metric=>!metric.protected));
  assert.equal(dashboard.ranking(detail,'grossMarginPercent').metric.id,'netRevenue');
  assert.equal(dashboard.ranking(detail,'grossMarginPercent').rows.length,1);
  assert.equal(dashboard.ranking(detail,'revenuePerCustomer').rows.length,0);
});
const source=fs.readFileSync(require.resolve('../public/app.js'),'utf8').replace(/\r\n/g,'\n');
function extract(name){const pattern=new RegExp('(?:async )?function '+name+'\\(');const start=source.search(pattern),end=source.indexOf('\n}\n',start);assert.ok(start>=0&&end>start,name);return source.slice(start,end+3);}
function fixture(){
  const calls=[],errors=[],session={user:{employeeNumber:'A'}};
  const state={portalSession:session,salesAnalytics:{actorKey:'A',loaded:true,selectionLoaded:false,selectedReportId:'',locationFilter:'',dateFrom:'',dateTo:'',horizon:'year_to_date',chartType:'ranking',chartMetric:'netRevenue'}};
  const f=vm.createContext({state,api:(url,options)=>new Promise((resolve,reject)=>calls.push({url,options,resolve,reject})),showToast:message=>errors.push(message),
    currentSalesAnalyticsActorKey:()=>state.portalSession.user.employeeNumber,salesReportDateRangeInvalid:()=>false});
  vm.runInContext('let salesAnalysisSelectionRevision=0;let salesAnalysisSelectionSave=null;\n'+['salesAnalyticsActorIsCurrent','loadSalesAnalyticsSelection','saveSalesAnalyticsSelection'].map(extract).join('\n'),f);
  return {f,state,calls,errors};
}
test('reopening PDF analyses restores the saved older report, filters and chart',async()=>{
  const {f,state,calls}=fixture();const pending=f.loadSalesAnalyticsSelection();calls[0].resolve({selection});await pending;
  assert.equal(state.salesAnalytics.selectedReportId,selection.reportId);assert.equal(state.salesAnalytics.dateTo,'2026-08-31');assert.equal(state.salesAnalytics.chartType,'pareto');
  await f.loadSalesAnalyticsSelection();assert.equal(calls.length,1);
});
test('a previous account response cannot replace the current account selection',async()=>{
  const {f,state,calls}=fixture();const pending=f.loadSalesAnalyticsSelection();state.portalSession={user:{employeeNumber:'B'}};state.salesAnalytics.actorKey='B';
  calls[0].resolve({selection});await pending;assert.equal(state.salesAnalytics.selectedReportId,'');assert.equal(state.salesAnalytics.selectionLoaded,false);
});
test('rapid changes save in order with the newest choice last, without applying save responses',async()=>{
  const {f,state,calls}=fixture();state.salesAnalytics.selectionLoaded=true;
  state.salesAnalytics.selectedReportId='first';const first=f.saveSalesAnalyticsSelection();await Promise.resolve();await Promise.resolve();
  assert.equal(calls.length,1);
  state.salesAnalytics.selectedReportId='second';const second=f.saveSalesAnalyticsSelection();
  state.salesAnalytics.selectedReportId='third';const third=f.saveSalesAnalyticsSelection();
  calls[0].resolve({selection:{reportId:'first'}});await first;await second;await Promise.resolve();
  assert.equal(calls.length,2);assert.equal(JSON.parse(calls[1].options.body).reportId,'third');
  calls[1].resolve({selection:{reportId:'first'}});await third;assert.equal(state.salesAnalytics.selectedReportId,'third');
});

test('pending report details preserve the selected margin metric; an actual rights denial resets it',()=>{
  const ctx={state:{salesAnalytics:{chartMetric:'grossMargin'}},elements:{},salesAnalyticsMetricDefinitions:allowed=>[{id:'netRevenue'},...(allowed?[{id:'grossMargin'}]:[])]};
  vm.runInNewContext(extract('renderSalesAnalyticsMetricOptions'),ctx);
  ctx.renderSalesAnalyticsMetricOptions(false,{pending:true});assert.equal(ctx.state.salesAnalytics.chartMetric,'grossMargin');
  ctx.renderSalesAnalyticsMetricOptions(true);assert.equal(ctx.state.salesAnalytics.chartMetric,'grossMargin');
  ctx.renderSalesAnalyticsMetricOptions(false);assert.equal(ctx.state.salesAnalytics.chartMetric,'netRevenue');
});

test('a saved report outside the first archive page is fetched with rights checks; a newer user choice wins',async()=>{
  for(const chooseNewer of [false,true]){
    const {f,state,calls}=fixture();state.salesAnalytics.selectionLoaded=true;state.salesAnalytics.selectedReportId='old';state.salesAnalytics.archiveSelection=[];
    const viewed=[];
    Object.assign(f,{canAccessSalesAnalytics:()=>true,canManageSalesReportImports:()=>false,renderSalesAnalytics:()=>{},loadSalesAnalyticsPreferences:async()=>{},loadSalesReportDetail:async()=>viewed.push(state.salesAnalytics.selectedReportId)});
    vm.runInContext(extract('loadSalesAnalytics'),f);
    const load=f.loadSalesAnalytics();calls[0].resolve({reports:[{id:'new'}]});
    for(let n=0;n<5&&!calls[1];n++)await Promise.resolve();
    assert.equal(calls[1].url,'/api/sales-analytics/reports/old');
    if(chooseNewer){state.salesAnalytics.selectedReportId='new';vm.runInContext('salesAnalysisSelectionRevision++',f);}
    calls[1].resolve({report:{id:'old'}});await load;
    assert.deepEqual(viewed,[chooseNewer?'new':'old']);assert.ok(state.salesAnalytics.reports.some(report=>report.id==='old'));
  }
});
