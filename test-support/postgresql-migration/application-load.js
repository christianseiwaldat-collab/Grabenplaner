'use strict';
const assert=require('node:assert/strict');
async function qualifyLoad({request,subject,endpoints}){
 const timing=()=>Math.max(...endpoints.slice(-1).map(e=>e.milliseconds));
 const receipts=[];
 for(const year of ['2025','2026'])for(let repeat=0;repeat<3;repeat++){
  const response=await request('/api/receipt-search/search',{method:'POST',body:{sourceId:'compact-cash',kind:'receipts',dateFrom:year+'-01-23',dateTo:year+'-01-23',locationId:'18',limit:20,query:'Sony'}});
  assert.ok(response);receipts.push({year,repeat,milliseconds:timing()});
 }
 const queries=[
  {label:'all-locations-month',dateFrom:'2026-01-01',dateTo:'2026-01-31'},
  {label:'full-year-with-prior-year',dateFrom:'2025-01-01',dateTo:'2025-12-31',locationIds:['18']},
 ];
 const reports=[],concurrent=[];
 for(const {label,...period} of queries){
  const start=performance.now(),job=await request('/api/sales-report-jobs',{method:'POST',body:{title:'PostgreSQL Lastprobe '+label,query:{sourceId:'compact-cash',reportVersion:3,kind:'sales',...period,groupBy:['manufacturer'],metrics:['netRevenue','grossMargin','quantity','receiptCount'],orientation:'landscape',chartType:'bars'}}});
  let report,ticks=0;
  try{
   for(;ticks<350;ticks++){
    const running=subject.runSalesReportQueueForTests();
    if(ticks<8){
     const first=endpoints.length;
     await Promise.all([
      request('/api/locations'),request('/api/sales/articles?query=Sony&limit=20'),
      request('/api/receipt-search/search',{method:'POST',body:{sourceId:'compact-cash',kind:'receipts',dateFrom:'2026-01-23',dateTo:'2026-01-23',locationId:'18',limit:20,query:'Sony'}}),
     ]);
     concurrent.push(...endpoints.slice(first).map(e=>({...e,report:label,tick:ticks})));
    }
    await running;
    report=(await request('/api/sales-report-jobs')).find(r=>r.id===job.id);assert.ok(report);assert.notEqual(report.status,'failed',report.error);
    if(report.status==='completed')break;
   }
   assert.equal(report.status,'completed',label);assert.ok(report.processed>2239,label);
   const pdf=await request('/api/sales-report-jobs/'+job.id+'/download');assert.ok(Buffer.isBuffer(pdf)&&pdf.subarray(0,5).toString()==='%PDF-');
   reports.push({label,milliseconds:Math.round(performance.now()-start),ticks:ticks+1,processed:report.processed,pdfBytes:pdf.length});
  }finally{
   if(!['completed','failed','cancelled'].includes(report?.status))await request('/api/sales-report-jobs/'+job.id+'/cancel',{method:'POST',body:{}});
   await request('/api/sales-report-jobs/'+job.id,{method:'DELETE'});
  }
 }
 const samples=concurrent.map(e=>e.milliseconds).sort((a,b)=>a-b),p95=samples[Math.ceil(samples.length*0.95)-1];
 return {passed:true,provider:'postgresql-pair',historical:true,receipts,reports,concurrent,p95Milliseconds:p95,maximumMilliseconds:samples.at(-1),endpointErrors:0,privateSingleCpu:true};
}
module.exports={qualifyLoad};
