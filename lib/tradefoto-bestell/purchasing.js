'use strict';
const D=require('./decimal');const {key,branchReference,reference,supplierReference}=require('./links');
function supplyState(ordered,delivered) {
  if(ordered===null||delivered===null)return {state:'quantity_missing',remaining:null,rawDifference:null};
  const rawDifference=D.subtract(ordered,delivered);
  if(D.compare(ordered,'0')<0||D.compare(delivered,'0')<0)return {state:'correction_or_return',remaining:null,rawDifference};
  if(D.compare(delivered,ordered)>0)return {state:'overdelivered_quantity',remaining:'0',rawDifference};
  if(D.compare(ordered,'0')===0)return {state:'zero_order',remaining:'0',rawDifference};
  return {state:D.compare(delivered,ordered)===0?'quantity_fulfilled':D.compare(delivered,'0')>0?'partial_quantity':'undelivered_quantity',remaining:rawDifference,rawDifference};
}
function purchasePosition(row,{orders,articles,suppliers,branches}) {
  const order=orders.get(key(row.BestellNr)),article=reference(row.EAN,articles),supplier=supplierReference(order?.Suchname??null,suppliers);
  return {id:key(row.BestellId),orderNumber:key(row.BestellNr),orderDate:order?.Bestelldatum??null,articleNumber:key(row.EAN),
    label:row.BArtikelbezeichnung||article.target?.label||'',articleState:article.state,supplierState:supplier.state,supplierKey:supplier.targetKey??supplier.sourceKey,supplierSourceKey:supplier.sourceKey,supplierMapping:supplier.mapping,
    location:branchReference(order?.LFilialID??null,branches),ordered:row.BMenge,deliveredCumulative:row.gMenge,...supplyState(row.BMenge,row.gMenge),
    orderState:order?'linked':'unmapped',receiptEventsAvailable:false};
}
function branchRequest(row,branches) {
  const sourceStatus=typeof row.Status==='string'?row.Status.trim():'',completed=row.erledigt===true;
  const state=sourceStatus==='Umlagerung'?(completed?'transfer_processed':'transfer_requested'):sourceStatus==='Bestellt'?'ordering_processed':
    sourceStatus==='Abgelehnt'?'request_declined':sourceStatus==='Anforderung'?'request_pending':'status_unknown';
  return {key:[key(row.KorbID),key(row.KEAN)],articleNumber:row.KEAN,label:row.KArtikelbezeichnung||'',quantity:row.KMenge,
    from:branchReference(row.UmlagerungvonFil,branches),to:branchReference(row.Filiale,branches),state,sourceStatus,completed,
    requestedAt:row.KDatum,processedAt:row.ErledigtDatum,dispatchDocumentAt:row.Lieferscheindruck,physicalReceiptConfirmed:false};
}
function summarizeSupply(positions) {
  const states={},suppliers=new Map();let unmappedArticles=0,withoutSupplier=0;
  for(const p of positions){states[p.state]=(states[p.state]||0)+1;if(p.articleState!=='linked')unmappedArticles++;if(p.supplierState!=='linked')withoutSupplier++;
    const id=p.supplierKey??'unassigned';if(!suppliers.has(id))suppliers.set(id,{supplierKey:id,positions:0,positionsWithRemaining:0});const s=suppliers.get(id);s.positions++;
    if(p.remaining!==null&&D.compare(p.remaining,'0')>0)s.positionsWithRemaining++;}
  return {positions:positions.length,states,unmappedArticles,withoutSupplier,suppliers:[...suppliers.values()],
    unitsAcrossDifferentArticles:null,note:'Mengen werden je Artikel/Einheit ausgewertet; kumulierter Lieferstand ist kein Wareneingangsereignis.'};
}
module.exports={supplyState,purchasePosition,branchRequest,summarizeSupply};
