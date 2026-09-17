'use strict';
const fields=['version','reportId','locationFilter','dateFrom','dateTo','horizon','chartType','chartMetric'];
const chartTypes=['ranking','change','absolute_change','share','pareto'];
const metrics=['netRevenue','grossMargin','quantity','customerCount','revenuePerCustomer'];
function normalizeSalesAnalysisSelection(value,{grossMargin=false}={}) {
  if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(key=>!fields.includes(key))
    ||value.version!==1)throw new Error('SALES_ANALYSIS_SELECTION_INVALID');
  const text=(key,max)=>{const s=value[key]??'';if(typeof s!=='string'||s.length>max||/[\x00-\x1f]/.test(s))throw new Error('SALES_ANALYSIS_SELECTION_INVALID');return s;};
  const date=key=>{const s=text(key,10);if(s&&(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s))throw new Error('SALES_ANALYSIS_SELECTION_INVALID');return s;};
  const reportId=text('reportId',128),locationFilter=text('locationFilter',80),dateFrom=date('dateFrom'),dateTo=date('dateTo');
  if(reportId&&!/^[a-f0-9]{64}$/.test(reportId))throw new Error('SALES_ANALYSIS_SELECTION_INVALID');
  if(dateFrom&&dateTo&&dateFrom>dateTo)throw new Error('SALES_ANALYSIS_SELECTION_INVALID');
  if(!['period','year_to_date'].includes(value.horizon)||!chartTypes.includes(value.chartType)||!metrics.includes(value.chartMetric))throw new Error('SALES_ANALYSIS_SELECTION_INVALID');
  return {version:1,reportId,locationFilter,dateFrom,dateTo,horizon:value.horizon,chartType:value.chartType,
    chartMetric:value.chartMetric==='grossMargin'&&!grossMargin?'netRevenue':value.chartMetric};
}
module.exports={normalizeSalesAnalysisSelection};
