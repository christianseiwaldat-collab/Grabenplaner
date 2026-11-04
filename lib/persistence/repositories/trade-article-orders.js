'use strict';
const C=require('../../data-import-contract');
const {ARTICLE_BRANCH_ORDER_STATEMENTS:S}=require('../statements/sales-article-branch-orders');
const {IMPORT_HISTORY_STATEMENTS:I}=require('../statements/import-history');
const B=require('../../sales-article-reader-batch'),packets=require('./trade-history-prefetch');
const O=require('./trade-orders'),{supplyState}=require('../../tradefoto-bestell/purchasing');
const text=value=>value==null?'':String(value);
async function articleOrdersPage(env,input={}) {
  if(!env.p.purchasing||!require('../../sales-article-catalog-access').buildSalesArticleCatalogProjection(env.session).read)C.fail('IMPORT_FORBIDDEN',403);
  C.exact(input,['articleNumber','cursor']);
  const number=C.text(input.articleNumber,120),selection=await require('./trade-movements').articleKeys(env,number);
  const all=await O.sources(env),binding=['article-orders',number,selection.identity,selection.catalog?.currentRevision,Object.values(all).map(run=>run?.id||null)];
  const cursor=O.cursorFor(env,binding,input.cursor);
  if(!all.header||!all.positions)return {...O.unavailable(),sources:O.sourceInfo(all),articleIdentity:selection.identity.basis};
  if(selection.identity.basis!=='catalog_source_link'||!selection.masters.length)return {
    available:true,rows:[],next:null,scanned:0,coverage:{...O.coverage(true),state:'article_link_unconfirmed'},sources:O.sourceInfo(all),articleIdentity:selection.identity.basis,
    note:'Für diesen Artikel fehlt eine bestätigte Verknüpfung zu den gespeicherten Bestellpositionen.'};
  const refs=await env.tx.queryAll(S.page,{scopeId:env.scopeId,after:cursor.state.after,limit:101,
    ...Object.fromEntries(Array.from({length:14},(_,i)=>['master'+(i+1),selection.masters[i]||'']))});
  const chosen=refs.slice(0,100),records=await B.prefetch(env.tx,I.get,chosen.map(row=>({scopeId:env.scopeId,id:row.id})));
  if(records.some((row,i)=>!row||row.revision!==chosen[i].revision))C.fail('IMPORT_HISTORY_INTEGRITY');
  const packet=await packets.prefetchHistory({tx:env.tx,records}),documents=[];
  for(const record of records) {
    const value=await env.document(record,packet);
    if(!['BESTELLDETAILS','BestellVerteilung'].includes(value.table)||!selection.keys.includes(value.fields.EAN)
      ||!value.references.some(ref=>ref.role==='article'&&selection.masters.includes(ref.recordId)))C.fail('IMPORT_HISTORY_INTEGRITY');
    documents.push(value);
  }
  await env.prefetchByKeys(documents.filter(row=>row.table==='BestellVerteilung').map(row=>({table:'BESTELLDETAILS',key:[text(row.fields.BestellId)]})));
  const candidates=[];
  for(const row of documents) {
    const detail=row.table==='BESTELLDETAILS'?row:await env.byKey('BESTELLDETAILS',[text(row.fields.BestellId)]);
    if(!detail||detail.fields.EAN!==row.fields.EAN||text(detail.fields.BestellNr)!==text(row.fields.BestellNr))continue;
    candidates.push({row,detail});
  }
  await env.prefetchByKeys(candidates.map(({detail})=>({table:'BESTELLUNGEN',key:[text(detail.fields.BestellNr)]})));
  const rows=[];let inspected=0;
  for(const {row,detail}of candidates) {
    const f=row.fields,h=await env.byKey('BESTELLUNGEN',[text(detail.fields.BestellNr)]);
    const head=h&&await O.header(env,h);
    if(!head||row.table==='BestellVerteilung'&&!await env.visible(f.FilialID))continue;
    inspected++;
    const distribution=row.table==='BestellVerteilung',ordered=distribution?f.Menge:detail.fields.BMenge,delivered=distribution?f.GelMenge:detail.fields.gMenge;
    rows.push({id:row.id,revision:row.revision,orderId:head.id,orderRevision:head.revision,orderNumber:head.orderNumber,
      articleNumber:number,sourceArticleKey:f.EAN,positionId:text(detail.fields.BestellId),supplier:head.supplier,date:head.date,
      status:head.fields.erledigt===true?'Erledigt (Quelle)':head.fields.erledigt===false?'Nicht erledigt (Quelle)':'Nicht belegt',
      ordered:ordered??null,delivered:delivered??null,...supplyState(ordered??null,delivered??null),
      locationId:distribution?await env.location(f.FilialID):head.locationId,sourceLocation:text(distribution?f.FilialID:h.fields.LFilialID),
      kind:distribution?'Filialzuweisung':'Bestellposition',sourceDate:row.provenance.snapshotAt,headerSourceDate:head.sourceDate,
      articleIdentity:'confirmed_master_reference'});
  }
  const state={...cursor.state,after:chosen.at(-1)?.id||cursor.state.after,scanned:cursor.state.scanned+inspected,matched:cursor.state.matched+rows.length};
  const next=refs.length>100?cursor.next(state):null;
  return {available:true,rows,next,scanned:inspected,coverage:O.coverage(true,!next,state.scanned,state.matched),sources:O.sourceInfo(all),articleIdentity:selection.identity.basis,
    note:'Bestellpositionen und Filialzuweisungen zum bestätigten Artikelbezug. Mengen dieser zwei Zeilenarten werden nicht addiert. '+O.NOTE};
}
module.exports={articleOrdersPage};
