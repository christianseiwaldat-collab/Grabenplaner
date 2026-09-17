(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GrabenplanerSalesDashboardMetrics=api;})(globalThis,function(){
  'use strict';
  const all=Object.freeze([
    {id:'netRevenue',label:'Umsatz netto',currency:true},
    {id:'grossMargin',label:'RE absolut',currency:true,protected:true},
    {id:'grossMarginPercent',label:'RE %',percent:true,protected:true},
    {id:'customerCount',label:'Kundenanzahl'},
    // Confirmed by the user for TradeFoto PDF statistics: customers = receipts.
    {id:'revenuePerCustomer',label:'Ø €/Kunde',currency:true},
    {id:'quantity',label:'Menge'},
  ]);
  const definitions=detail=>all.filter(metric=>!metric.protected||detail?.rights?.grossMargin===true);
  function value(group,id){
    const data=group?.horizons?.period;
    const number=key=>{const n=data?.[key]?.current;return n===null||n===undefined||n===''||!Number.isFinite(Number(n))?null:Number(n);};
    if(id!=='grossMarginPercent')return number(id);
    const margin=number('grossMargin'),revenue=number('netRevenue');
    return margin!==null&&revenue!==null&&revenue>0?100*margin/revenue:null;
  }
  function ranking(detail,id){
    const metric=definitions(detail).find(item=>item.id===id)||all[0];
    return {metric,rows:(detail?.productGroups||[]).map(group=>({group,amount:value(group,metric.id)}))
      .filter(row=>row.amount!==null).sort((a,b)=>b.amount-a.amount||String(a.group.externalProductGroupId).localeCompare(String(b.group.externalProductGroupId),'de',{numeric:true})).slice(0,5)};
  }
  return Object.freeze({definitions,ranking});
});
