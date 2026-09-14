'use strict';
const C=require('../../data-import-contract'),H=require('../../tradefoto-history-profiles'),Search=require('../../flexible-search');
const {IMPORT_HISTORY_STATEMENTS:S}=require('../statements/import-history');
const {historyPage}=require('./history-page'),{annotations}=require('./trade-annotations');
const configurations={
 Reparatur:{kind:'repair',customer:'KUND_NR',branch:'FilialId',number:'ReparaturNr',date:'Anlegedatum'},
 Rechnung_Z:{kind:'invoice',customer:'KUND_NR',branch:'Filialid',number:'Rechnungsnr',date:'Anlegedatum'},
 ANGEBOTE:{kind:'offer',customer:'Kund_Nr',branch:'Filialid',number:'AngebotNr',date:'AngebotDatum'},
 Auftrag:{kind:'order',customer:'KUND_NR',branch:'FilialId',number:'Id',date:'Anlegedatum'},
 Teilzahlungen:{kind:'payment',customer:'Kund_Nr',number:'Rechnungsnr',date:'Zahlungsdatum'},
 Rechnungsdetails_Z:{kind:'device',number:'Rechnungsnr',branch:'Filialid',date:'Lieferscheindatum'},
};
const str=v=>v==null?'':String(v),customerKey=v=>/^\d+$/.test(str(v))?str(v).replace(/^0+(?=\d)/,''):str(v);
function sourceState(fields){return fields.erledigt===true?'ready':'in_progress';}
async function repairRow(env,value){
 const f=value.fields,saved=await annotations(env).read(env.tx,'repair',[value.id]);
 return {id:value.id,kind:'repair',documentNumber:str(f.ReparaturNr),sourceLocation:str(f.FilialId),customerNumber:customerKey(f.KUND_NR),
  date:f.Anlegedatum,label:f.AName||'',serialNumber:f.ANr||'',workshop:f.WerkstattName||'',sourceStatus:sourceState(f),
  gpStatus:saved.value?.state||'unassigned',gpChangedAt:saved.value?.changedAt||null,revision:saved.revision,sourceDate:value.provenance.snapshotAt,
  paidInferred:false,identityConfirmed:false};
}
async function repairDocument(env,id){
 C.id(id);const record=await env.tx.queryOne(S.get,{id,scopeId:env.scopeId});if(!record||record.sourceInstance!=='tradefoto-bestell'||record.sourceTable!=='Reparatur')C.fail('IMPORT_HISTORY_NOT_FOUND',404);
 const value=await env.document(record);if(!await env.visible(value.fields.FilialId))C.fail('IMPORT_FORBIDDEN',403);return value;
}
async function cashCustomerPage(env,cash,q,after){
 if(!cash)return {rows:[],after:0,scanned:0};
 const {publication:pub,publications,backend}=cash,{CASH}=require('../statements/trade-insights'),{CASH_SNAPSHOT_TABLES:tables}=require('../statements/cash-snapshots');
 const table=tables.find(t=>t.name==='Umsatz_KASSE'),rows=[],sourceRows=await env.tx.queryAll(CASH.customer,{datasetSlot:pub.dataset.row.slot,...require('./trade-stock').cashKeys(publications,'KUNDEN',q.customer),dateFrom:q.dateFrom||'1900-01-01',dateTo:q.dateTo||env.today(),after:Number(after||0),limit:26});
 const allowed=ref=>ref?.targetId&&['linked','historical_mapping'].includes(ref.status)?env.p.company||env.p.locationIds.includes(ref.targetId):env.p.company&&env.p.unassigned;
 const read=backend.service(env.tx,v=>v.action==='history.scope'?allowed(v.locations.find(l=>l.role==='location.filialid')):v.action==='history.reference'?v.targetKind!=='employee':v.dataClasses.every(c=>['internal_business','customer_restricted'].includes(c)||c==='catalog_costs'&&env.p.costs||c==='restricted_finance'&&env.p.finance));
 for(const row of sourceRows.slice(0,25)){
  const f=pub.reader.decode(pub.dataset,table,row).normalized.source,ref=await publications.reference(env.tx,pub.row.id,'FILIALEN',f.Filialid);
  if(!allowed(ref)||q.locationId&&q.locationId!==ref.targetId||require('../../sales-report-locations').isOnlineSource(f.Filialid)&&!env.p.online)continue;
  if(customerKey(f.KUND_NR)!==q.customer)C.fail('IMPORT_HISTORY_INTEGRITY');
  if(!Search.matches([f.Bonnr,f.RechnungsNr],q.query))continue;
  const id='c'+tables.indexOf(table)+'-'+pub.row.id+'-'+String(row.sourceRow).padStart(10,'0'),checked=await read.receipt(id);
  rows.push({id,kind:'cash',documentNumber:str(f.Bonnr),date:row.businessDate,sourceLocation:str(f.Filialid),customerNumber:customerKey(f.KUND_NR),label:'Kassenbeleg',serialNumber:'',sourceDate:pub.dataset.row.createdAt,amount:checked.canAggregate?checked.totals.gross:null,verified:checked.canAggregate,relatedInvoiceNumber:f.RechnungsNr==='0'?null:f.RechnungsNr,revenueContribution:null});
 }
 return {rows,after:sourceRows.length>25?sourceRows[24].sourceRow:0,scanned:Math.min(25,sourceRows.length)};
}
async function customerOperation(env,operation,input){
 const {p,tx,protection,scopeId,session}=env;if(!p.customers)C.fail('IMPORT_FORBIDDEN',403);
 if(operation.startsWith('repair')&&!p.repairs)C.fail('IMPORT_FORBIDDEN',403);
 if(operation==='repair-detail'||operation==='repair-save'){
  C.exact(input,['id','state','expectedRevision']);if(operation==='repair-save'&&!p.repairWrite)C.fail('IMPORT_FORBIDDEN',403);
  const value=await repairDocument(env,input.id);
  if(operation==='repair-save'){
   if(!['unassigned','ready','collected'].includes(input.state))C.fail('IMPORT_BESTELL_REPAIR_STATE');await env.fresh(tx);
   await annotations(env).write(tx,'repair',[value.id],{state:input.state,changedAt:new Date().toISOString(),actor:String(session.employeeNumber)},input.expectedRevision,String(session.employeeNumber));
   await env.fresh(tx);
  }
  return {...await repairRow(env,value),description:value.fields.Fehler||'',work:value.fields.AArbeit||'',note:value.fields.Bemerkung||'',
   sourceDates:{created:value.fields.Anlegedatum,estimate:value.fields.KVDatum,ordered:value.fields.RepAuftragDatum},
   ...(p.finance?{sourcePayment:{date:value.fields.Bezahlt_Datum,amount:value.fields.Rechnungsbetrag}}:{}),
   noteStatus:'TradeRepair „erledigt“ bedeutet abholbereit. GP-Abholung und Zahlung werden getrennt geführt. Bei abgelehnter Reparatur bleibt die KVA-Pauschale beim Betrieb.'};
 }
 C.exact(input,['query','customer','serial','locationId','dateFrom','dateTo','cursor']);
 const q={query:input.query||'',customer:customerKey(input.customer||''),serial:input.serial||'',locationId:input.locationId||'',dateFrom:input.dateFrom||'',dateTo:input.dateTo||''};
 for(const k of ['query','customer','serial','locationId'])if(q[k])C.text(q[k],150);
 if(operation==='customer-history'&&(!q.customer||q.customer==='0'))C.fail('IMPORT_BESTELL_CUSTOMER_UNASSIGNED');
 if(operation==='device-history'&&!q.serial)C.fail('IMPORT_BESTELL_DEVICE_KEY');
 for(const k of ['dateFrom','dateTo'])if(q[k])require('../../sales-history-query').normalizeSalesHistoryQuery({sourceId:'x',dateFrom:q[k],dateTo:q[k]},{today:env.today(),projection:{read:true,company:true}});
 if(q.dateFrom&&q.dateTo&&q.dateFrom>q.dateTo)C.fail('IMPORT_HISTORY_DATE_RANGE');
 if(q.locationId&&!p.company&&!p.locationIds.includes(q.locationId))C.fail('IMPORT_FORBIDDEN',403);
 const tables=operation==='repairs'?['Reparatur']:operation==='device-history'?[...(p.repairs?['Reparatur']:[]),'Rechnungsdetails_Z']:['CASH','Rechnung_Z','ANGEBOTE','Auftrag',...(p.repairs?['Reparatur']:[]),...(p.finance?['Teilzahlungen']:[])];
 const cash=operation==='customer-history'?await require('./trade-stock').cashContext(env):null;
 const sources=[];for(const table of tables)sources.push(table==='CASH'?(cash?{id:cash.publication.row.id,manifest:{snapshotAt:cash.publication.dataset.row.createdAt}}:null):await env.source(table));
 const signature=protection.digest([p,env.epoch,env.annotationEpoch,operation,q,sources.map(v=>v?.id||null)]),ctx=['trade-customer-cursor',scopeId,String(session.employeeNumber)];
 let pageIndex=0,after='';if(input.cursor){C.text(input.cursor,3000);let cursor;try{cursor=protection.open(input.cursor,ctx);}catch{C.fail('IMPORT_BESTELL_CURSOR',409);}if(cursor.signature!==signature||cursor.expires<Date.now())C.fail('IMPORT_BESTELL_CURSOR',409);pageIndex=C.integer(cursor.pageIndex,0,tables.length-1);after=cursor.after?C.id(cursor.after):'';}
 while(pageIndex<tables.length&&!sources[pageIndex])pageIndex++;
 if(pageIndex===tables.length)return {available:sources.some(Boolean),rows:[],next:null,scanned:0};
 const table=tables[pageIndex],conf=configurations[table],source=sources[pageIndex];
 if(table==='CASH'){const data=await cashCustomerPage(env,cash,q,after);const index=data.after?pageIndex:pageIndex+1;return {available:true,rows:data.rows,scanned:data.scanned,next:index<tables.length?protection.seal({signature,pageIndex:index,after:data.after?String(data.after):'',expires:Date.now()+900000},ctx):null,sourceDate:source.manifest.snapshotAt,note:'Kassenbelege werden separat von Rechnungen, Aufträgen und Zahlungen geführt.'};}
 const prefetch=await historyPage(tx,{scopeId,source:'trade',sourceInstance:'tradefoto-bestell',sourceTable:table,after,limit:26,snapshot:H.tableFor('trade',table).keys?null:source.manifest.fileSha256});
 const records=[...prefetch.records.values()],rows=[];
 for(const record of records.slice(0,25)){
  const value=await env.document(record,prefetch),f=value.fields;let sourceLocation=f[conf.branch],date=f[conf.date],customer=f[conf.customer],head=null;
  if(['Teilzahlungen','Rechnungsdetails_Z'].includes(table)){
   head=await env.byKey('Rechnung_Z',[str(f.Rechnungsnr)]);if(!head)continue;
   if(!await env.visible(head.fields.Filialid,q.locationId))continue;
   sourceLocation=table==='Teilzahlungen'?head.fields.Filialid:sourceLocation;date=date||head.fields.Anlegedatum;customer=table==='Teilzahlungen'?customer:head.fields.KUND_NR;
   if(table==='Teilzahlungen'&&customerKey(customer)!==customerKey(head.fields.KUND_NR))continue;
  }
  if(!await env.visible(sourceLocation,q.locationId))continue;
  if(q.customer&&q.customer!==customerKey(customer))continue;
  const serial=table==='Reparatur'?str(f.ANr):table==='Rechnungsdetails_Z'?str(f.KameraNr):'';
  if(q.serial&&serial!==q.serial)continue;
  const day=str(date).slice(0,10);if(q.dateFrom&&(!day||day<q.dateFrom)||q.dateTo&&(!day||day>q.dateTo))continue;
  const label=table==='Reparatur'?f.AName:table==='Rechnungsdetails_Z'?f.Artikelbezeichnung:'';
  if(!Search.matches([f[conf.number],label,serial,f.WerkstattName],q.query))continue;
  const row=table==='Reparatur'?await repairRow(env,value):{id:value.id,kind:conf.kind,documentNumber:str(f[conf.number]),date,sourceLocation:str(sourceLocation),customerNumber:customerKey(customer),label:label||'',serialNumber:serial,
   sourceDate:value.provenance.snapshotAt,identityConfirmed:false,revenueContribution:null,
   ...(p.finance&&table==='Rechnung_Z'?{amount:f.Rechnungsbetrag??null,sourcePaymentDate:f.Zahldatum||null,internalBranchInvoice:f.FilRe===true}:{}),
   ...(p.finance&&table==='Teilzahlungen'?{amount:f.Zahlbetrag??null}:{}),...(table==='Rechnungsdetails_Z'?{articleNumber:f.Ean,quantity:f.menge}:{} )};
  rows.push({...row,olderSource:value.provenance.fileSha256!==source.manifest.fileSha256});
 }
 const hasMore=records.length>25;if(!hasMore){pageIndex++;after='';}else after=records[24].id;
 const next=pageIndex<tables.length?protection.seal({signature,pageIndex,after,expires:Date.now()+900000},ctx):null;
 // The blank page boundary is encoded separately from record IDs.
 return {available:true,rows,next,scanned:Math.min(25,records.length),sourceDate:source.manifest.snapshotAt,
  note:operation==='repairs'?'Reparaturen bleiben auch aus früheren Importen erhalten. „Erledigt“ in TradeRepair bedeutet abholbereit, nicht abgeholt oder bezahlt.':operation==='device-history'?'Exakter Vergleich der gespeicherten Seriennummer. Gleiche Seriennummern bestätigen noch keine eindeutige Geräteidentität.':'Quellkundennummern werden exakt zugeordnet. Rechnungen, Aufträge und Zahlungen sind keine zusätzlichen Kassenumsätze.'};
}
module.exports={customerOperation,repairRow,sourceState,customerKey};
